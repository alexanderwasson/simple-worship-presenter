'use strict';
/*
 * WebSocket transport for live presentation control.
 *
 * Two kinds of client connect to the same endpoint:
 *
 *   display  - the desktop workspace and the audience display, authenticated
 *              with the normal signed session cookie
 *   remote   - a paired phone, authenticated with the short-lived token issued
 *              when its pairing code was consumed
 *
 * The server owns the presentation state (see src/live.js). Clients send
 * commands; the server validates them, updates state, and broadcasts the result
 * to every client belonging to that user.
 */
const { WebSocketServer } = require('ws');
const url = require('url');
const auth = require('./auth');
const log = require('./log');
const live = require('./live');

const AUTH_TIMEOUT_MS = 5000;
const HEARTBEAT_MS = 30000;
const MAX_MESSAGE_BYTES = 8192;

// Controls a paired remote may be granted. Default is everything.
const ALL_ACTIONS = ['next', 'previous', 'goto', 'blank', 'unblank'];

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function send(socket, message) {
  if (socket.readyState !== 1) return;
  try {
    socket.send(JSON.stringify(message));
  } catch (err) {
    log.warn('websocket send failed', { error: String(err.message) });
  }
}

function attach(server, config) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  // Map userId -> Set<socket>
  const byUser = new Map();

  function addClient(userId, socket) {
    if (!byUser.has(userId)) byUser.set(userId, new Set());
    byUser.get(userId).add(socket);
  }

  function removeClient(userId, socket) {
    const set = byUser.get(userId);
    if (!set) return;
    set.delete(socket);
    if (!set.size) byUser.delete(userId);
  }

  function broadcastState(userId) {
    const session = live.getState(userId);
    const set = byUser.get(userId);
    if (!set) return;
    const message = {
      type: 'state',
      state: live.publicState(session),
      slide: live.slidePayload(session),
      // Tells a remote which buttons it is actually allowed to press.
      allowed: ALL_ACTIONS
    };
    for (const socket of set) send(socket, message);
  }

  // The desktop workspace publishes its authoritative view here.
  function handlePublish(socket, client, message) {
    if (client.kind !== 'display') {
      return send(socket, { type: 'error', error: 'Only the presenter can publish state' });
    }
    live.publish(client.userId, {
      slides: message.slides,
      title: message.title,
      footer: message.footer,
      blank_image: message.blank_image,
      presentation_id: message.presentation_id,
      index: message.index,
      blank: message.blank,
      bg: message.bg,
      plan: message.plan,
      plan_index: message.plan_index
    });
    broadcastState(client.userId);
    send(socket, { type: 'ack', kind: 'publish' });
  }

  function handleCommand(socket, client, message) {
    const action = message && typeof message.action === 'string' ? message.action : '';
    if (client.allowed && !client.allowed.includes(action)) {
      return send(socket, { type: 'error', error: 'That control is not available to this remote' });
    }
    const result = live.command(client.userId, { action, index: message.index }, client.kind);
    if (!result.ok) return send(socket, { type: 'error', error: result.error });
    broadcastState(client.userId);
    // The originating client also gets a direct ack carrying the revision, so a
    // retry can safely discard a duplicate.
    send(socket, { type: 'ack', kind: 'command', revision: result.revision });
  }

  function authenticate(socket, raw, upgradeReq) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return send(socket, { type: 'error', error: 'Malformed message' });
    }
    if (!message || message.type !== 'auth') {
      return send(socket, { type: 'error', error: 'Authenticate first' });
    }

    if (message.kind === 'display') {
      // The workspace and audience display prove identity with their cookie.
      const req = { cookies: parseCookies(upgradeReq.headers.cookie) };
      const user = auth.sessionUser(req);
      if (!user) {
        send(socket, { type: 'error', error: 'Sign in required' });
        return socket.close(4401, 'unauthorized');
      }
      socket.client = {
        kind: 'display',
        userId: user.id,
        allowed: ALL_ACTIONS
      };
      addClient(user.id, socket);
      const session = live.getState(user.id);
      send(socket, { type: 'authenticated', kind: 'display' });
      send(socket, {
        type: 'state',
        state: live.publicState(session),
        slide: live.slidePayload(session),
        allowed: ALL_ACTIONS
      });
      log.info('display connected', { user: user.id });
      return;
    }

    if (message.kind === 'remote') {
      const verified = live.verifyRemoteToken(message.token);
      if (!verified) {
        send(socket, { type: 'error', error: 'That remote is no longer authorised' });
        return socket.close(4401, 'unauthorized');
      }
      const allowed = (verified.remote.scope || ALL_ACTIONS).filter(a => ALL_ACTIONS.includes(a));
      socket.client = {
        kind: 'remote',
        userId: verified.user_id,
        remoteId: verified.remote.id,
        allowed
      };
      addClient(verified.user_id, socket);
      send(socket, { type: 'authenticated', kind: 'remote', allowed });
      send(socket, {
        type: 'state',
        state: live.publicState(verified.session),
        slide: live.slidePayload(verified.session),
        allowed
      });
      log.info('remote connected', { user: verified.user_id, remote: verified.remote.id });
      return;
    }

    send(socket, { type: 'error', error: 'Unknown client kind' });
    socket.close(4400, 'bad request');
  }

  wss.on('connection', (socket, upgradeReq) => {
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });

    const authTimer = setTimeout(() => {
      if (!socket.client) {
        try { socket.close(4408, 'auth timeout'); } catch { }
      }
    }, AUTH_TIMEOUT_MS);

    socket.on('message', raw => {
      const text = typeof raw === 'string' ? raw : raw.toString('utf8');
      if (text.length > MAX_MESSAGE_BYTES) {
        return send(socket, { type: 'error', error: 'Message too large' });
      }

      if (!socket.client) {
        clearTimeout(authTimer);
        return authenticate(socket, text, upgradeReq);
      }

      let message;
      try {
        message = JSON.parse(text);
      } catch {
        return send(socket, { type: 'error', error: 'Malformed message' });
      }

      switch (message.type) {
        case 'command':
          return handleCommand(socket, socket.client, message);
        case 'publish':
          return handlePublish(socket, socket.client, message);
        case 'ping':
          return send(socket, { type: 'pong' });
        default:
          return send(socket, { type: 'error', error: 'Unknown message type' });
      }
    });

    socket.on('close', () => {
      clearTimeout(authTimer);
      if (socket.client) removeClient(socket.client.userId, socket);
    });

    socket.on('error', err => log.warn('websocket error', { error: String(err.message) }));
  });

  // Drop connections that stop responding so a phone that walked away does not
  // hold a slot forever.
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.isAlive === false) {
        try { socket.terminate(); } catch { }
        continue;
      }
      socket.isAlive = false;
      try { socket.ping(); } catch { }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  server.on('upgrade', (req, socket, head) => {
    const pathname = url.parse(req.url).pathname;
    if (pathname !== '/api/remote/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit('connection', ws, req);
    });
  });

  return {
    wss,
    broadcastState,
    connectedCount(userId) {
      const set = byUser.get(userId);
      return set ? set.size : 0;
    },
    close() {
      clearInterval(heartbeat);
      for (const socket of wss.clients) {
        try { socket.close(1001, 'shutting down'); } catch { }
      }
    }
  };
}

module.exports = { attach, ALL_ACTIONS };
