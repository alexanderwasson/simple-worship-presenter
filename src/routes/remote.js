'use strict';
/*
 * Mobile remote control API.
 *
 * Pairing codes are short lived and single use. They contain no credentials:
 * the code is exchanged here for a scoped remote token, which is what the phone
 * keeps. Ownership is derived from that token on every request — a client never
 * supplies a user or presentation id.
 */
const express = require('express');
const QRCode = require('qrcode');
const config = require('../config');
const log = require('../log');
const auth = require('../auth');
const live = require('../live');
const { limiter } = require('../rateLimit');

const router = express.Router();
const { ALL_ACTIONS } = require('../remote-ws');

function jsonError(res, status, message) {
  return res.status(status).json({ error: message });
}

// The mobile page identifies itself with the token issued at pairing time.
function requireRemote(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.body && req.body.token);
  const verified = live.verifyRemoteToken(token);
  if (!verified) return jsonError(res, 401, 'This remote is no longer authorised. Pair again.');
  req.remote = verified.remote;
  req.liveUser = verified.user_id;
  req.liveSession = verified.session;
  req.controlKind = 'remote';
  next();
}

// Controls may come from a paired phone (Bearer token) or from the presenter
// workspace (signed cookie). Ownership always comes from the credential, never
// from anything the client claims.
function requireControl(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.body && req.body.token);
  if (token) return requireRemote(req, res, next);
  auth.requireAuth(req, res, () => {
    req.liveUser = req.user.id;
    req.liveSession = live.getState(req.user.id);
    req.controlKind = 'presenter';
    next();
  });
}

// ---- presenter side ------------------------------------------------------

router.get('/state', auth.requireAuth, (req, res) => {
  const session = live.getState(req.user.id);
  res.json({
    state: live.publicState(session),
    slide: live.slidePayload(session),
    allowed: ALL_ACTIONS
  });
});

// The desktop workspace publishes the authoritative view of what it is showing.
router.post('/state', auth.requireAuth, (req, res) => {
  const session = live.publish(req.user.id, {
    slides: req.body.slides,
    title: req.body.title,
    footer: req.body.footer,
    presentation_id: req.body.presentation_id,
    index: req.body.index,
    blank: req.body.blank,
    plan: req.body.plan,
    plan_index: req.body.plan_index
  });
  req.app.get('liveHub')?.broadcastState(req.user.id);
  res.json({ state: live.publicState(session) });
});

router.post('/pairing', auth.requireAuth, limiter({ label: 'pairing', max: config.rateLimitMaxPairing }), async (req, res) => {
  const session = live.getState(req.user.id);
  const scope = Array.isArray(req.body.scope)
    ? req.body.scope.filter(a => ALL_ACTIONS.includes(a))
    : ALL_ACTIONS;
  const created = live.createPairing(req.user.id, session.id, { scope });

  if (!created.ok) {
    res.setHeader('Retry-After', String(created.retry_after_seconds || 1));
    return res.status(429).json({
      error: created.error,
      retry_after_seconds: created.retry_after_seconds || 1,
      cooldown_seconds: config.pairingCooldownSeconds
    });
  }

  let qr = '';
  const link = live.pairingUrl(created.code);
  try {
    qr = await QRCode.toDataURL(link, { width: 300, margin: 1, errorCorrectionLevel: 'M' });
  } catch (err) {
    log.warn('qr generation failed', { error: String(err.message) });
  }

  // The QR and link carry only the short-lived code, never a session token.
  res.status(201).json({
    code: created.code,
    link,
    qr,
    expires_at: new Date(created.expiresAt).toISOString(),
    expires_in_seconds: created.expires_in_seconds,
    cooldown_seconds: created.cooldown_seconds,
    scope
  });
});

router.get('/devices', auth.requireAuth, (req, res) => {
  res.json({ remotes: live.listRemotes(req.user.id) });
});

router.delete('/devices/:id', auth.requireAuth, (req, res) => {
  if (!live.revokeRemote(req.user.id, req.params.id)) return jsonError(res, 404, 'Device not found');
  req.app.get('liveHub')?.broadcastState(req.user.id);
  res.status(204).end();
});

router.delete('/devices', auth.requireAuth, (req, res) => {
  const n = live.revokeAllRemotes(req.user.id);
  req.app.get('liveHub')?.broadcastState(req.user.id);
  res.json({ revoked: n });
});

// ---- phone side ----------------------------------------------------------

// Exchanging a code is deliberately rate limited and the code is consumed
// before a token is issued, so a replay cannot pair twice.
router.post('/pair', limiter({ label: 'pairing-attempt', max: config.rateLimitMaxPairing }), (req, res) => {
  const code = req.body && req.body.code;
  if (typeof code !== 'string' || code.trim().length < 4 || code.trim().length > 32) {
    return jsonError(res, 400, 'Enter the code shown on the presenter screen');
  }
  const result = live.consumePairing(code);
  if (!result.ok) return jsonError(res, 400, result.error);
  res.json(result);
});

router.get('/me', requireRemote, (req, res) => {
  res.json({
    state: live.publicState(req.liveSession),
    slide: live.slidePayload(req.liveSession),
    allowed: (req.remote.scope || ALL_ACTIONS).filter(a => ALL_ACTIONS.includes(a))
  });
});

// Controls from a paired phone, or from the presenter workspace. The same
// validation applies either way, so there is one code path to reason about.
router.post('/command', requireControl, limiter({ label: 'remote-command', max: config.rateLimitMaxRemoteCommand }), (req, res) => {
  const action = req.body && req.body.action;
  // Unknown action is a bad request; a known action this remote does not hold
  // is an authorisation failure.
  if (!ALL_ACTIONS.includes(action)) {
    return jsonError(res, 400, 'Unknown action');
  }
  const allowed = (req.remote ? (req.remote.scope || ALL_ACTIONS) : ALL_ACTIONS).filter(a => ALL_ACTIONS.includes(a));
  if (!allowed.includes(action)) {
    return jsonError(res, 403, 'That control is not available to this remote');
  }
  const result = live.command(req.liveUser, req.body, req.controlKind);
  if (!result.ok) return jsonError(res, 400, result.error);
  req.app.get('liveHub')?.broadcastState(req.liveUser);
  res.json(result);
});

module.exports = router;
