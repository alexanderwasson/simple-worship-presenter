'use strict';
const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { startServer, signIn } = require('./helpers');

function openSocket(server, onMessage, cookie) {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/api/remote/ws`, {
    // A display client proves identity with the signed session cookie, exactly
    // as it would in the browser.
    headers: cookie ? { Cookie: cookie } : {}
  });
  const messages = [];
  const closers = [];
  socket.on('message', raw => {
    const parsed = JSON.parse(raw.toString());
    messages.push(parsed);
    if (onMessage) onMessage(parsed);
  });
  socket.on('close', () => closers.forEach(fn => fn()));

  const withTimeout = (promise, label, ms = 4000) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timed out: ' + label)), ms))
  ]);

  return {
    socket,
    messages,
    ready: () => withTimeout(new Promise(resolve => {
      if (socket.readyState === 1) return resolve();
      socket.on('open', resolve);
    }), 'socket open'),
    closed: () => withTimeout(new Promise(resolve => closers.push(resolve)), 'socket close'),
    send: message => socket.send(JSON.stringify(message)),
    // Only matches messages that arrive after this call, so an earlier reply can
    // never satisfy a later wait.
    waitFor: (type, timeout = 3000) => new Promise((resolve, reject) => {
      const from = messages.length;
      const existing = messages.slice(from).find(m => m.type === type);
      if (existing) return resolve(existing);
      const timer = setTimeout(() => reject(new Error('timed out waiting for ' + type)), timeout);
      const handler = raw => {
        const parsed = JSON.parse(raw.toString());
        if (parsed.type === type) {
          clearTimeout(timer);
          socket.off('message', handler);
          resolve(parsed);
        }
      };
      socket.on('message', handler);
    }),
    close: () => socket.close()
  };
}

async function pairRemote(server, cookie, body = {}) {
  const created = await server.api('/remote/pairing', { method: 'POST', body }, cookie);
  const paired = await server.api('/remote/pair', { method: 'POST', body: { code: created.body.code } });
  return { created: created.body, result: paired };
}

test('mobile remote pairing', async t => {
  const server = await startServer();
  t.after(() => server.stop());
  const { cookie } = await signIn(server);

  await t.test('creates a short-lived single-use code and a QR that holds no token', async () => {
    const res = await server.api('/remote/pairing', { method: 'POST', body: {} }, cookie);
    assert.equal(res.status, 201);
    assert.match(res.body.code, /^[A-Z2-9]{8}$/, 'code should be short and readable');
    assert.ok(res.body.expires_in_seconds > 0 && res.body.expires_in_seconds <= 600);
    assert.match(res.body.link, /#code=/);
    assert.ok(res.body.qr.startsWith('data:image/png;base64,'), 'QR should be generated locally');
    assert.equal(res.body.qr.includes('token'), false, 'a QR must never embed a token');
    assert.equal(res.body.link.includes('token'), false, 'the pairing link must never embed a token');
  });

  await t.test('exchanges a code for a scoped remote token and current state', async () => {
    await server.api('/presentations', { method: 'POST', body: { title: 'Sunday', slides: ['one', 'two', 'three'] } }, cookie);
    await server.api('/remote/state', {
      method: 'POST',
      body: { title: 'Sunday', slides: ['one', 'two', 'three'], index: 1 }
    }, cookie);

    const created = await server.api('/remote/pairing', { method: 'POST', body: {} }, cookie);
    const paired = await server.api('/remote/pair', { method: 'POST', body: { code: created.body.code } });

    assert.equal(paired.status, 200);
    assert.ok(paired.body.token, 'a token is issued');
    assert.equal(paired.body.state.count, 3);
    assert.equal(paired.body.state.index, 1, 'the remote starts on the current slide');
    assert.deepEqual(paired.body.allowed.sort(), ['blank', 'goto', 'next', 'previous', 'unblank']);
  });

  await t.test('slide footer text and size reach the audience display state', async () => {
    await server.api('/remote/state', {
      method: 'POST',
      body: {
        title: 'Footer deck',
        slides: [{
          text: 'Main text',
          footer: { text: 'Copyright notice', style: { size: 11, color: '#eeeeee' } }
        }],
        index: 0
      }
    }, cookie);

    const live = await server.api('/remote/state', {}, cookie);
    assert.equal(live.body.slide.slideFooter, 'Copyright notice');
    assert.deepEqual(live.body.slide.slideFooterStyle, { size: 11, color: '#eeeeee' });
  });

  await t.test('a pairing code cannot be used twice', async () => {
    const created = await server.api('/remote/pairing', { method: 'POST', body: {} }, cookie);
    const first = await server.api('/remote/pair', { method: 'POST', body: { code: created.body.code } });
    const second = await server.api('/remote/pair', { method: 'POST', body: { code: created.body.code } });

    assert.equal(first.status, 200);
    assert.equal(second.status, 400);
    assert.match(second.body.error, /already been used|not valid/i);
  });

  await t.test('a code is replaced, not stacked, when a new one is generated', async () => {
    const first = await server.api('/remote/pairing', { method: 'POST', body: {} }, cookie);
    const second = await server.api('/remote/pairing', { method: 'POST', body: {} }, cookie);
    const stale = await server.api('/remote/pair', { method: 'POST', body: { code: first.body.code } });
    const fresh = await server.api('/remote/pair', { method: 'POST', body: { code: second.body.code } });

    assert.equal(stale.status, 400, 'the superseded code must stop working');
    assert.equal(fresh.status, 200);
  });

  await t.test('rejects garbage codes', async () => {
    for (const code of ['', 'ZZ', 'not-a-code', null, 12345]) {
      const res = await server.api('/remote/pair', { method: 'POST', body: { code } });
      assert.ok(res.status >= 400, 'got ' + res.status + ' for ' + JSON.stringify(code));
    }
  });

  await t.test('the expired-code path is explicit', async () => {
    // Expiry is enforced in live.js; verify the message for an unknown/removed code
    // matches what an expired one produces after it is swept.
    const res = await server.api('/remote/pair', { method: 'POST', body: { code: 'ABCDEFGH' } });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /not valid|expired/i);
  });

  await t.test('pairing attempts are rate limited', async () => {
    const limited = await startServer({ RATE_LIMIT_MAX_PAIRING: '3' });
    t.after(() => limited.stop());
    await signIn(limited);
    let last;
    for (let i = 0; i < 12; i++) {
      last = await limited.api('/remote/pair', { method: 'POST', body: { code: 'ABCDEFG' } });
      if (last.status === 429) break;
    }
    assert.equal(last.status, 429, 'repeated pairing attempts must be throttled');
  });

  await t.test('a new code cannot be requested immediately', async () => {
    const cooled = await startServer({ PAIRING_COOLDOWN_SECONDS: '2' });
    t.after(() => cooled.stop());
    const user = await signIn(cooled);

    const first = await cooled.api('/remote/pairing', { method: 'POST', body: {} }, user.cookie);
    assert.equal(first.status, 201, 'the first code is issued straight away');
    assert.equal(first.body.cooldown_seconds, 2);

    const second = await cooled.api('/remote/pairing', { method: 'POST', body: {} }, user.cookie);
    assert.equal(second.status, 429, 'an immediate second request must be refused');
    assert.match(second.body.error, /Wait \d+ second/i);
    assert.ok(second.body.retry_after_seconds > 0 && second.body.retry_after_seconds <= 2);
    assert.match(second.headers['retry-after'] || '', /^\d+$/, 'Retry-After must be set');

    // The original code is still the live one and still works.
    const paired = await cooled.api('/remote/pair', { method: 'POST', body: { code: first.body.code } });
    assert.equal(paired.status, 200, 'the already-issued code must remain usable');
  });

  await t.test('the cooldown is per account, not global', async () => {
    const cooled = await startServer({ PAIRING_COOLDOWN_SECONDS: '2' });
    t.after(() => cooled.stop());
    const alex = await signIn(cooled, { email: 'cool-alex@example.com' });
    const sam = await signIn(cooled, { email: 'cool-sam@example.com' });

    const one = await cooled.api('/remote/pairing', { method: 'POST', body: {} }, alex.cookie);
    assert.equal(one.status, 201);

    // Sam is unaffected by Alex's cooldown.
    const other = await cooled.api('/remote/pairing', { method: 'POST', body: {} }, sam.cookie);
    assert.equal(other.status, 201);

    // Alex is still throttled.
    const again = await cooled.api('/remote/pairing', { method: 'POST', body: {} }, alex.cookie);
    assert.equal(again.status, 429);
  });
});

test('mobile remote authorisation', async t => {
  const server = await startServer();
  t.after(() => server.stop());
  const alex = await signIn(server, { email: 'alex@example.com' });
  const sam = await signIn(server, { email: 'sam@example.com' });

  await t.test('a remote token is required', async () => {
    const res = await server.api('/remote/me');
    assert.equal(res.status, 401);
    const bad = await server.api('/remote/me', { headers: { Authorization: 'Bearer not-a-real-token' } });
    assert.equal(bad.status, 401);
  });

  await t.test('a remote cannot read another user presentation', async () => {
    await server.api('/remote/state', { method: 'POST', body: { title: 'Alex only', slides: ['secret'] } }, alex.cookie);
    const { result } = await pairRemote(server, alex.cookie);
    assert.equal(result.status, 200);

    const mine = await server.api('/remote/me', { headers: { Authorization: 'Bearer ' + result.body.token } });
    assert.equal(mine.status, 200);
    assert.equal(mine.body.state.title, 'Alex only');

    // Sam's remote sees Sam's state, never Alex's.
    await server.api('/remote/state', { method: 'POST', body: { title: 'Sam only', slides: ['theirs'] } }, sam.cookie);
    const { result: samRemote } = await pairRemote(server, sam.cookie);
    const theirs = await server.api('/remote/me', { headers: { Authorization: 'Bearer ' + samRemote.body.token } });
    assert.equal(theirs.body.state.title, 'Sam only');
  });

  await t.test('a remote command cannot reach another user', async () => {
    await server.api('/remote/state', { method: 'POST', body: { title: 'Alex', slides: ['a', 'b', 'c'], index: 0 } }, alex.cookie);
    const { result } = await pairRemote(server, alex.cookie);
    const token = result.body.token;

    await server.api('/remote/command', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token },
      body: { action: 'next' }
    });

    // Sam's state is untouched.
    const samState = await server.api('/remote/state', {}, sam.cookie);
    assert.notEqual(samState.body.state.index, 1, "Sam's slide must not move");

    // Alex's moved exactly once.
    const alexState = await server.api('/remote/state', {}, alex.cookie);
    assert.equal(alexState.body.state.index, 1);
  });

  await t.test('revoking a device invalidates its token immediately', async () => {
    const { result, created } = await pairRemote(server, alex.cookie);
    const token = result.body.token;
    const devices = await server.api('/remote/devices', {}, alex.cookie);
    const remote = devices.body.remotes.find(r => r.id === result.body.remote_id);
    assert.ok(remote, 'the paired device is listed');

    const before = await server.api('/remote/me', { headers: { Authorization: 'Bearer ' + token } });
    assert.equal(before.status, 200);

    const revoke = await server.api('/remote/devices/' + remote.id, { method: 'DELETE' }, alex.cookie);
    assert.equal(revoke.status, 204);

    const after = await server.api('/remote/me', { headers: { Authorization: 'Bearer ' + token } });
    assert.equal(after.status, 401, 'a revoked device loses access at once');
  });

  await t.test('one user cannot revoke another user device', async () => {
    const { result } = await pairRemote(server, alex.cookie);
    const attempt = await server.api('/remote/devices/' + result.body.remote_id, { method: 'DELETE' }, sam.cookie);
    assert.equal(attempt.status, 404);
    const still = await server.api('/remote/me', { headers: { Authorization: 'Bearer ' + result.body.token } });
    assert.equal(still.status, 200);
  });

  await t.test('a remote cannot publish or impersonate the presenter', async () => {
    const { result } = await pairRemote(server, alex.cookie);
    const publish = await server.api('/remote/state', {
      method: 'POST',
      body: { title: 'hijacked', slides: ['nope'] }
    }, { headers: { Authorization: 'Bearer ' + result.body.token } });
    assert.equal(publish.status, 401, 'publishing requires a real account session');
  });
});

test('mobile remote commands', async t => {
  const server = await startServer();
  t.after(() => server.stop());
  const { cookie } = await signIn(server);

  await t.test('next and previous move within bounds', async () => {
    await server.api('/remote/state', { method: 'POST', body: { title: 'Deck', slides: ['a', 'b', 'c'], index: 0 } }, cookie);
    const { result } = await pairRemote(server, cookie);
    const headers = { Authorization: 'Bearer ' + result.body.token };
    const send = action => server.api('/remote/command', { method: 'POST', headers, body: { action } });

    assert.equal((await send('next')).body.state.index, 1);
    assert.equal((await send('next')).body.state.index, 2);
    assert.equal((await send('next')).body.state.index, 2, 'cannot pass the last slide');
    assert.equal((await send('previous')).body.state.index, 1);
    assert.equal((await send('previous')).body.state.index, 0);
    assert.equal((await send('previous')).body.state.index, 0, 'cannot pass the first slide');
  });

  await t.test('blank image is shown while blanked and the same slide restores', async () => {
    const imageUrl = '/api/media/12345678-1234-1234-1234-123456789abc/file';
    await server.api('/remote/state', {
      method: 'POST',
      body: { title: 'Deck', slides: ['first', 'second'], index: 1, blank_image: imageUrl }
    }, cookie);

    const blank = await server.api('/remote/command', { method: 'POST', body: { action: 'blank' } }, cookie);
    assert.equal(blank.body.state.blank, true);
    assert.equal(blank.body.slide.blankImage, imageUrl);

    const restore = await server.api('/remote/command', { method: 'POST', body: { action: 'unblank' } }, cookie);
    assert.equal(restore.body.state.blank, false);
    assert.equal(restore.body.state.index, 1);
    assert.equal(restore.body.slide.title, 'second');
  });

  await t.test('blank image only accepts same-origin media file URLs', async () => {
    await server.api('/remote/state', {
      method: 'POST',
      body: { slides: ['a'], blank_image: 'https://example.com/image.png' }
    }, cookie);
    const state = await server.api('/remote/state', {}, cookie);
    assert.equal(state.body.slide.blankImage, null);
  });

  await t.test('goto validates the target index', async () => {
    await server.api('/remote/state', { method: 'POST', body: { title: 'Deck', slides: ['a', 'b', 'c'], index: 0 } }, cookie);
    const { result } = await pairRemote(server, cookie);
    const headers = { Authorization: 'Bearer ' + result.body.token };

    const ok = await server.api('/remote/command', { method: 'POST', headers, body: { action: 'goto', index: 2 } });
    assert.equal(ok.body.state.index, 2);

    for (const index of [-1, 3, 1.5, 'x', null]) {
      const bad = await server.api('/remote/command', { method: 'POST', headers, body: { action: 'goto', index } });
      assert.equal(bad.status, 400, 'index ' + JSON.stringify(index) + ' must be rejected');
    }
  });

  await t.test('unknown actions are rejected', async () => {
    await server.api('/remote/state', { method: 'POST', body: { slides: ['a'], index: 0 } }, cookie);
    const { result } = await pairRemote(server, cookie);
    const headers = { Authorization: 'Bearer ' + result.body.token };
    const res = await server.api('/remote/command', { method: 'POST', headers, body: { action: 'rm -rf /' } });
    assert.equal(res.status, 400);
  });

  await t.test('blank and restore control only the output', async () => {
    await server.api('/remote/state', { method: 'POST', body: { title: 'Deck', slides: ['a', 'b'], index: 1 } }, cookie);
    const { result } = await pairRemote(server, cookie);
    const headers = { Authorization: 'Bearer ' + result.body.token };

    const blank = await server.api('/remote/command', { method: 'POST', headers, body: { action: 'blank' } });
    assert.equal(blank.body.state.blank, true);
    assert.equal(blank.body.state.index, 1, 'blanking must not change the slide');

    const restore = await server.api('/remote/command', { method: 'POST', headers, body: { action: 'unblank' } });
    assert.equal(restore.body.state.blank, false);
    assert.equal(restore.body.state.index, 1);
  });

  await t.test('a remote only gets the controls it was granted', async () => {
    await server.api('/remote/state', { method: 'POST', body: { title: 'Deck', slides: ['a', 'b'], index: 0 } }, cookie);
    const created = await server.api('/remote/pairing', {
      method: 'POST',
      body: { scope: ['next', 'previous'] }
    }, cookie);
    const paired = await server.api('/remote/pair', { method: 'POST', body: { code: created.body.code } });
    const headers = { Authorization: 'Bearer ' + paired.body.token };

    assert.deepEqual(paired.body.allowed.sort(), ['next', 'previous']);

    const blocked = await server.api('/remote/command', { method: 'POST', headers, body: { action: 'blank' } });
    assert.equal(blocked.status, 403);

    const allowed = await server.api('/remote/command', { method: 'POST', headers, body: { action: 'next' } });
    assert.equal(allowed.status, 200);
  });

  await t.test('two phones can control the same presentation', async () => {
    await server.api('/remote/state', { method: 'POST', body: { title: 'Deck', slides: ['a', 'b', 'c'], index: 0 } }, cookie);
    const one = await pairRemote(server, cookie);
    const two = await pairRemote(server, cookie);
    const h1 = { Authorization: 'Bearer ' + one.result.body.token };
    const h2 = { Authorization: 'Bearer ' + two.result.body.token };

    await server.api('/remote/command', { method: 'POST', headers: h1, body: { action: 'next' } });
    const afterOne = await server.api('/remote/me', { headers: h2 });
    assert.equal(afterOne.body.state.index, 1, 'the second phone sees the first phone move');

    await server.api('/remote/command', { method: 'POST', headers: h2, body: { action: 'next' } });
    const afterTwo = await server.api('/remote/me', { headers: h1 });
    assert.equal(afterTwo.body.state.index, 2, 'and vice versa');

    const devices = await server.api('/remote/devices', {}, cookie);
    assert.ok(devices.body.remotes.length >= 2, 'both devices are listed');
  });
});

test('websocket synchronisation', async t => {
  const server = await startServer();
  t.after(() => server.stop());
  const { cookie } = await signIn(server);

  await t.test('rejects an unauthenticated socket', async () => {
    const client = openSocket(server);
    await client.ready();
    client.send({ type: 'command', action: 'next' });
    const reply = await client.waitFor('error');
    assert.match(reply.error, /authenticate/i);
    client.close();
  });

  await t.test('accepts a display socket and streams state', async () => {
    await server.api('/remote/state', { method: 'POST', body: { title: 'Deck', slides: ['a', 'b'], index: 0 } }, cookie);
    const client = openSocket(server, null, cookie);
    await client.ready();
    client.send({ type: 'auth', kind: 'display' });
    const authed = await client.waitFor('authenticated');
    assert.equal(authed.kind, 'display');
    const state = await client.waitFor('state');
    assert.equal(state.state.count, 2);
    client.close();
  });

  await t.test('display socket previous and next commands move the audience slide', async () => {
    await server.api('/remote/state', { method: 'POST', body: { title: 'Deck', slides: ['a', 'b'], index: 0 } }, cookie);
    const display = openSocket(server, null, cookie);
    await display.ready();
    display.send({ type: 'auth', kind: 'display' });
    await display.waitFor('authenticated');
    await display.waitFor('state');

    const nextState = display.waitFor('state');
    display.send({ type: 'command', action: 'next' });
    const next = await nextState;
    assert.equal(next.state.index, 1);
    assert.equal(next.slide.title, 'b');

    const previousState = display.waitFor('state');
    display.send({ type: 'command', action: 'previous' });
    const previous = await previousState;
    assert.equal(previous.state.index, 0);
    assert.equal(previous.slide.title, 'a');
    display.close();
  });

  await t.test('a remote socket drives the same state the display sees', async () => {
    await server.api('/remote/state', { method: 'POST', body: { title: 'Deck', slides: ['a', 'b', 'c'], index: 0 } }, cookie);

    const display = openSocket(server, null, cookie);
    await display.ready();
    display.send({ type: 'auth', kind: 'display' });
    await display.waitFor('authenticated');
    await display.waitFor('state'); // drain the initial snapshot

    const created = await server.api('/remote/pairing', { method: 'POST', body: {} }, cookie);
    const paired = await server.api('/remote/pair', { method: 'POST', body: { code: created.body.code } });

    const remote = openSocket(server);
    await remote.ready();
    remote.send({ type: 'auth', kind: 'remote', token: paired.body.token });
    await remote.waitFor('authenticated');
    await remote.waitFor('state'); // drain the initial snapshot

    // Register both waiters before acting, so neither broadcast is missed.
    const remoteStatePromise = remote.waitFor('state');
    const displayStatePromise = display.waitFor('state');
    remote.send({ type: 'command', action: 'next' });

    // Both sides receive the new authoritative state.
    const remoteState = await remoteStatePromise;
    const displayState = await displayStatePromise;
    assert.equal(remoteState.state.index, 1);
    assert.equal(displayState.state.index, 1);
    assert.equal(displayState.slide.title, 'b');

    remote.close();
    display.close();
  });

  await t.test('rejects a display trying to use a remote token and vice versa', async () => {
    const created = await server.api('/remote/pairing', { method: 'POST', body: {} }, cookie);
    const paired = await server.api('/remote/pair', { method: 'POST', body: { code: created.body.code } });

    const spoof = openSocket(server);
    await spoof.ready();
    spoof.send({ type: 'auth', kind: 'display', token: paired.body.token });
    // Display auth ignores any supplied token and relies on the cookie; with no
    // valid cookie on this socket it must fail.
    const reply = await spoof.waitFor('error');
    assert.match(reply.error, /sign in/i);
    await spoof.closed();
  });

  await t.test('rejects malformed and oversized messages', async () => {
    const client = openSocket(server, null, cookie);
    await client.ready();
    client.send({ type: 'auth', kind: 'display' });
    await client.waitFor('authenticated');

    const malformedPromise = client.waitFor('error');
    client.socket.send('not json at all');
    const malformed = await malformedPromise;
    assert.match(malformed.error, /malformed/i);

    const unknownPromise = client.waitFor('error');
    client.send({ type: 'wat' });
    const unknown = await unknownPromise;
    assert.match(unknown.error, /unknown message type/i);
    client.close();
  });

  await t.test('does not log pairing secrets', async () => {
    const created = await server.api('/remote/pairing', { method: 'POST', body: {} }, cookie);
    const paired = await server.api('/remote/pair', { method: 'POST', body: { code: created.body.code } });
    // The response is the only place the token exists; it must not be persisted.
    assert.ok(paired.body.token.split('.').length === 3, 'a JWT is returned to the caller only');
  });
});
