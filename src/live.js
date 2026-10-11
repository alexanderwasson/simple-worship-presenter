'use strict';
/*
 * Authoritative live presentation state.
 *
 * Everything that can appear on a projector — the desktop workspace, the
 * audience display and any number of mobile remotes — reads and writes the same
 * state here. Clients never decide what slide is showing; they ask, and this
 * module answers and broadcasts.
 *
 * In-memory by design: live state is ephemeral and is not user content. Pairing
 * codes and remote credentials are deliberately short lived and are never
 * written to disk.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('./config');
const log = require('./log');

const PAIRING_TTL_MS = 5 * 60 * 1000;      // a pairing code lives five minutes
const REMOTE_TOKEN_TTL_SECONDS = 12 * 60 * 60; // a paired phone stays paired for the service
const MAX_PAIRING_PER_USER = 5;
const MAX_REMOTES_PER_USER = 20;

const sessions = new Map();   // userId -> live state
const pairing = new Map();    // code   -> pairing record
const remotes = new Map();    // remoteId -> paired remote record

// The alphabet excludes look-alike characters so a code can be read aloud.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function newCode(length = 8) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

function now() { return Date.now(); }

function publicState(session) {
  return {
    session_id: session.id,
    presentation_id: session.presentationId || null,
    title: session.title || '',
    index: session.index,
    count: session.slides.length,
    // Text labels only: enough for a remote to show the rundown and previews
    // without shipping media to a phone.
    labels: session.slides.map(slideTextOf).map(s => s.slice(0, 200)),
    blank: session.blank,
    version: session.version,
    updated_at: session.updatedAt
  };
}

function slideTextOf(slide) {
  if (typeof slide === 'string') return slide;
  return (slide && (slide.text || slide.name)) || '';
}

// The slide payload matches what the editor already sends to the audience
// display, so one renderer serves desktop and phone.
function slidePayload(session) {
  const slide = session.slides[session.index] || '';
  const text = slideTextOf(slide);
  return {
    type: 'slide',
    index: session.index,
    title: text,
    image: (slide && typeof slide === 'object' ? slide.image : '') || '',
    count: session.slides.length,
    background: (slide && typeof slide === 'object' ? slide.background : '') || '',
    style: (slide && typeof slide === 'object' ? slide.style : null) || {},
    kicker: (session.title || '').toUpperCase(),
    footer: session.footer || ''
  };
}

function getState(userId) {
  let session = sessions.get(userId);
  if (!session) {
    session = {
      id: crypto.randomUUID(),
      userId,
      presentationId: null,
      title: '',
      footer: '',
      slides: [],
      index: 0,
      blank: false,
      version: 0,
      updatedAt: now(),
      revision: 0
    };
    sessions.set(userId, session);
  }
  return session;
}

// Called by the desktop workspace whenever it saves or selects a slide.
function publish(userId, input) {
  const session = getState(userId);
  if (!input || typeof input !== 'object') return session;

  if (Array.isArray(input.slides)) {
    session.slides = input.slides.slice(0, 500).map(s => {
      if (typeof s === 'string') return String(s).slice(0, 4000);
      if (s && typeof s === 'object') {
        return {
          text: String(s.text || '').slice(0, 4000),
          image: String(s.image || '').slice(0, 2000000),
          background: String(s.background || '').slice(0, 2000000),
          name: String(s.name || '').slice(0, 200),
          style: s.style && typeof s.style === 'object' ? s.style : undefined
        };
      }
      return '';
    });
    session.index = Math.max(0, Math.min(session.index, Math.max(0, session.slides.length - 1)));
  }
  if (typeof input.title === 'string') session.title = input.title.slice(0, 200);
  if (typeof input.footer === 'string') session.footer = input.footer.slice(0, 200);
  if (typeof input.presentation_id === 'string') session.presentationId = input.presentation_id.slice(0, 100);
  if (typeof input.index === 'number' && Number.isFinite(input.index)) {
    session.index = Math.max(0, Math.min(Math.floor(input.index), Math.max(0, session.slides.length - 1)));
  }
  if (typeof input.blank === 'boolean') session.blank = input.blank;

  session.version += 1;
  session.updatedAt = now();
  return session;
}

const ACTIONS = new Set(['next', 'previous', 'goto', 'blank', 'unblank']);

// Every command is validated here. Clients cannot set arbitrary state.
function command(userId, cmd, sourceLabel) {
  const session = getState(userId);
  const action = cmd && typeof cmd.action === 'string' ? cmd.action : '';

  if (!ACTIONS.has(action)) {
    return { ok: false, error: 'Unknown action' };
  }
  if (!session.slides.length && action !== 'blank' && action !== 'unblank') {
    return { ok: false, error: 'No presentation is loaded' };
  }

  const before = { index: session.index, blank: session.blank };
  switch (action) {
    case 'next':
      session.index = Math.min(session.index + 1, session.slides.length - 1);
      break;
    case 'previous':
      session.index = Math.max(session.index - 1, 0);
      break;
    case 'goto': {
      // A missing or non-numeric index must never silently mean "slide 0".
      if (typeof cmd.index !== 'number' || !Number.isInteger(cmd.index)) {
        return { ok: false, error: 'Slide index must be a whole number' };
      }
      const target = cmd.index;
      if (target < 0 || target >= session.slides.length) {
        return { ok: false, error: 'Slide index is out of range' };
      }
      session.index = target;
      break;
    }
    case 'blank':
      session.blank = true;
      break;
    case 'unblank':
      session.blank = false;
      break;
  }

  session.version += 1;
  session.updatedAt = now();
  session.revision += 1;
  log.info('live command', {
    user: userId,
    action,
    from: before.index,
    to: session.index,
    blank: session.blank,
    source: sourceLabel || 'unknown'
  });

  return {
    ok: true,
    state: publicState(session),
    slide: slidePayload(session),
    // Idempotency hint: a client that retries can discard a repeat.
    revision: session.revision
  };
}

// ---- pairing -------------------------------------------------------------

function createPairing(userId, sessionId, options = {}) {
  // Invalidate any earlier unused code so a screen is never cluttered with
  // codes that all still work.
  for (const [code, record] of pairing) {
    if (record.userId === userId && !record.consumed) pairing.delete(code);
  }

  const code = newCode(8);
  const record = {
    code,
    userId,
    sessionId: sessionId || getState(userId).id,
    scope: Array.isArray(options.scope) ? options.scope.slice(0, 10) : null,
    createdAt: now(),
    expiresAt: now() + PAIRING_TTL_MS,
    consumed: false
  };
  pairing.set(code, record);
  log.info('pairing code created', { user: userId });
  return { code, expiresAt: record.expiresAt, expires_in_seconds: Math.round(PAIRING_TTL_MS / 1000) };
}

function activePairingCount(userId) {
  let n = 0;
  for (const record of pairing.values()) if (record.userId === userId && !record.consumed && record.expiresAt > now()) n++;
  return n;
}

function consumePairing(code) {
  const key = String(code || '').trim().toUpperCase();
  const record = pairing.get(key);
  if (!record) return { ok: false, error: 'That pairing code is not valid' };
  if (record.consumed) {
    pairing.delete(key);
    return { ok: false, error: 'That pairing code has already been used' };
  }
  if (record.expiresAt <= now()) {
    pairing.delete(key);
    return { ok: false, error: 'That pairing code has expired' };
  }
  if (activePairingCount(record.userId) >= MAX_PAIRING_PER_USER) {
    return { ok: false, error: 'Too many pairing requests. Try again shortly.' };
  }

  // Single use: the code is gone before the token is issued.
  record.consumed = true;
  pairing.delete(key);

  const remoteId = crypto.randomUUID();
  const remote = {
    id: remoteId,
    userId: record.userId,
    sessionId: record.sessionId,
    scope: record.scope,
    createdAt: now(),
    lastSeen: now(),
    revoked: false
  };
  remotes.set(remoteId, remote);

  // Bound to one user and one live session, never a general account token.
  const token = jwt.sign(
    { typ: 'remote', uid: record.userId, sid: record.sessionId, rid: remoteId },
    config.sessionSecret,
    { expiresIn: REMOTE_TOKEN_TTL_SECONDS }
  );

  log.info('remote paired', { user: record.userId, remote: remoteId });
  const allowed = (remote.scope || ['next', 'previous', 'goto', 'blank', 'unblank']).filter(Boolean);
  return {
    ok: true,
    token,
    remote_id: remoteId,
    allowed,
    expires_in_seconds: REMOTE_TOKEN_TTL_SECONDS,
    state: publicState(getState(record.userId)),
    slide: slidePayload(getState(record.userId))
  };
}

// ---- remote credentials --------------------------------------------------

function verifyRemoteToken(token) {
  try {
    const payload = jwt.verify(String(token || ''), config.sessionSecret);
    if (payload.typ !== 'remote') return null;
    const remote = remotes.get(payload.rid);
    if (!remote || remote.revoked) return null;
    // The live session may have been replaced; follow the user, not the id.
    const session = getState(remote.userId);
    remote.lastSeen = now();
    return { remote, user_id: remote.userId, session };
  } catch {
    return null;
  }
}

function listRemotes(userId) {
  return [...remotes.values()]
    .filter(r => r.userId === userId)
    .map(r => ({
      id: r.id,
      created_at: new Date(r.createdAt).toISOString(),
      last_seen: new Date(r.lastSeen).toISOString(),
      revoked: r.revoked
    }))
    .sort((a, b) => b.last_seen.localeCompare(a.last_seen));
}

function revokeRemote(userId, remoteId) {
  const remote = remotes.get(remoteId);
  if (!remote || remote.userId !== userId) return false;
  remote.revoked = true;
  // Removing it also invalidates any token that references it.
  remotes.delete(remoteId);
  log.info('remote revoked', { user: userId, remote: remoteId });
  return true;
}

function revokeAllRemotes(userId) {
  let n = 0;
  for (const [id, remote] of remotes) {
    if (remote.userId === userId) { remotes.delete(id); n++; }
  }
  return n;
}

function pairingUrl(code) {
  // The URL contains only the short-lived code, never a session token.
  const base = config.publicUrl ? config.publicUrl.replace(/\/$/, '') : '';
  return base + '/remote#code=' + encodeURIComponent(code);
}

module.exports = {
  getState,
  publicState,
  slidePayload,
  publish,
  command,
  createPairing,
  consumePairing,
  verifyRemoteToken,
  listRemotes,
  revokeRemote,
  revokeAllRemotes,
  pairingUrl,
  PAIRING_TTL_MS
};
