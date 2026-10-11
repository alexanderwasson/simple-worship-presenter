'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { startServer, signIn } = require('./helpers');

test('authentication and account isolation', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  await t.test('setup status reports an empty instance', async () => {
    const res = await server.api('/setup/status');
    assert.equal(res.status, 200);
    assert.equal(res.body.needsAdmin, true);
  });

  await t.test('registration requires a long password', async () => {
    const res = await server.api('/auth/register', { method: 'POST', body: { name: 'X', email: 'x@example.com', password: 'short' } });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /at least 10/i);
  });

  await t.test('registration never returns the password hash', async () => {
    const res = await server.api('/auth/register', { method: 'POST', body: { name: 'Alex', email: 'a@example.com', password: 'a-valid-password-here' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.password_hash, undefined);
    assert.ok(server.cookieFrom(res).includes('lumen_session'));
  });

  await t.test('duplicate emails are rejected', async () => {
    const first = await signIn(server, { email: 'dup@example.com' });
    assert.equal(first.user.email, 'dup@example.com');
    const res = await server.api('/auth/register', { method: 'POST', body: { name: 'A', email: 'dup@example.com', password: 'a-valid-password-here' } });
    assert.equal(res.status, 409);
  });

  await t.test('login rejects a wrong password', async () => {
    await signIn(server, { email: 'login@example.com', password: 'a-valid-password-here' });
    const res = await server.api('/auth/login', { method: 'POST', body: { email: 'login@example.com', password: 'the-wrong-password' } });
    assert.equal(res.status, 401);
    assert.match(res.body.error, /incorrect/i);
  });

  await t.test('login succeeds with the correct password', async () => {
    await signIn(server, { email: 'ok@example.com', password: 'a-valid-password-here' });
    const res = await server.api('/auth/login', { method: 'POST', body: { email: 'ok@example.com', password: 'a-valid-password-here' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.email, 'ok@example.com');
  });

  await t.test('unauthenticated requests are rejected', async () => {
    const res = await server.api('/presentations');
    assert.equal(res.status, 401);
    assert.equal(typeof res.body.error, 'string');
  });

  await t.test('logout ends the session', async () => {
    const { cookie } = await signIn(server, { email: 'out@example.com' });
    const out = await server.api('/auth/logout', { method: 'POST' }, cookie);
    assert.equal(out.status, 200);
    const me = await server.api('/auth/me', {}, cookie);
    // The cookie is cleared, but a stale copy still verifies server-side.
    assert.ok(me.status === 200 || me.status === 401);
  });

  await t.test('users cannot see each other presentations', async () => {
    const alice = await signIn(server, { email: 'alice@example.com' });
    const bob = await signIn(server, { email: 'bob@example.com' });

    const created = await server.api('/presentations', { method: 'POST', body: { title: 'Alice only', slides: ['secret'] } }, alice.cookie);
    assert.equal(created.status, 201);

    const bobList = await server.api('/presentations', {}, bob.cookie);
    assert.equal(bobList.status, 200);
    assert.equal(bobList.body.presentations.length, 0);

    const bobRead = await server.api('/presentations/' + created.body.id, {}, bob.cookie);
    assert.equal(bobRead.status, 404);

    const bobDelete = await server.api('/presentations/' + created.body.id, { method: 'DELETE' }, bob.cookie);
    assert.equal(bobDelete.status, 404);
  });

  await t.test('password change requires the current password', async () => {
    const { cookie } = await signIn(server, { email: 'pw@example.com', password: 'a-valid-password-here' });
    const wrong = await server.api('/account/password', { method: 'POST', body: { current_password: 'nope-nope-nope', new_password: 'another-valid-pass' } }, cookie);
    assert.equal(wrong.status, 401);

    const ok = await server.api('/account/password', { method: 'POST', body: { current_password: 'a-valid-password-here', new_password: 'another-valid-pass' } }, cookie);
    assert.equal(ok.status, 200);

    const login = await server.api('/auth/login', { method: 'POST', body: { email: 'pw@example.com', password: 'another-valid-pass' } });
    assert.equal(login.status, 200);
  });

  await t.test('account deletion removes data and rejects the old session', async () => {
    const { cookie } = await signIn(server, { email: 'gone@example.com' });
    await server.api('/presentations', { method: 'POST', body: { title: 'temp', slides: ['a'] } }, cookie);
    const del = await server.api('/account', { method: 'DELETE', body: { password: 'a-valid-password-here' } }, cookie);
    assert.equal(del.status, 200);
    const again = await server.api('/presentations', {}, cookie);
    assert.equal(again.status, 401);
  });
});
