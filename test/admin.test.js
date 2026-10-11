'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { startServer, signIn } = require('./helpers');

// Create the first account so it becomes the administrator.
async function makeAdmin(server) {
  const res = await server.api('/setup/admin', {
    method: 'POST',
    body: { name: 'Site Admin', email: 'admin@example.com', password: 'a-valid-password-here' }
  });
  return { user: res.body.user, cookie: server.cookieFrom(res) };
}

test('administrator user management', async t => {
  const server = await startServer({ DEFAULT_QUOTA_BYTES: '10000' });
  t.after(() => server.stop());
  const admin = await makeAdmin(server);

  await t.test('the first account is the administrator', async () => {
    assert.equal(admin.user.role, 'admin');
    assert.equal(admin.user.quota_bytes, 10000);
  });

  await t.test('the setup form requires a name — the field is never optional', async () => {
    const fresh = await startServer();
    t.after(() => fresh.stop());
    const res = await fresh.api('/setup/admin', {
      method: 'POST',
      body: { name: '', email: 'x@example.com', password: 'a-valid-password-here' }
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /name/i);
  });

  await t.test('an admin can list users', async () => {
    const res = await server.api('/admin/users', {}, admin.cookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.users.length, 1);
    assert.equal(res.body.default_quota_bytes, 10000);
  });

  await t.test('a normal user cannot list users', async () => {
    const user = await signIn(server, { email: 'plain@example.com' });
    const res = await server.api('/admin/users', {}, user.cookie);
    assert.equal(res.status, 403);
  });

  await t.test('an admin can create an account with a chosen quota', async () => {
    const res = await server.api('/admin/users', {
      method: 'POST',
      body: { name: 'Made By Admin', email: 'made@example.com', password: 'a-valid-password-here', quota_bytes: 5000 }
    }, admin.cookie);
    assert.equal(res.status, 201);
    assert.equal(res.body.user.quota_bytes, 5000);
    assert.equal(res.body.user.role, 'user');
  });

  await t.test('the new account can sign in immediately', async () => {
    const res = await server.api('/auth/login', {
      method: 'POST',
      body: { email: 'made@example.com', password: 'a-valid-password-here' }
    });
    assert.equal(res.status, 200);
  });

  await t.test('an admin can change a quota', async () => {
    const list = await server.api('/admin/users', {}, admin.cookie);
    const target = list.body.users.find(u => u.email === 'made@example.com');
    const res = await server.api('/admin/users/' + target.id, {
      method: 'PUT',
      body: { quota_bytes: 250000 }
    }, admin.cookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.user.quota_bytes, 250000);
  });

  await t.test('quotas must be valid numbers', async () => {
    const list = await server.api('/admin/users', {}, admin.cookie);
    const target = list.body.users[0];
    const res = await server.api('/admin/users/' + target.id, {
      method: 'PUT',
      body: { quota_bytes: -1 }
    }, admin.cookie);
    assert.equal(res.status, 400);
  });

  await t.test('a quota cannot drop below what the account already stores', async () => {
    const user = await signIn(server, { email: 'hoarder@example.com' });
    // Occupy 400 bytes of the account's storage.
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(400, 7)]);
    const boundary = '----adminq';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);
    const up = await server.api('/media', {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
      body
    }, user.cookie);
    assert.equal(up.status, 201);

    const res = await server.api('/admin/users/' + user.user.id, {
      method: 'PUT',
      body: { quota_bytes: 100 }
    }, admin.cookie);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /already stored/i);
  });

  await t.test('an admin can promote and demote other users', async () => {
    const list = await server.api('/admin/users', {}, admin.cookie);
    const target = list.body.users.find(u => u.email === 'plain@example.com');
    const up = await server.api('/admin/users/' + target.id, { method: 'PUT', body: { role: 'admin' } }, admin.cookie);
    assert.equal(up.status, 200);
    assert.equal(up.body.user.role, 'admin');

    const down = await server.api('/admin/users/' + target.id, { method: 'PUT', body: { role: 'user' } }, admin.cookie);
    assert.equal(down.body.user.role, 'user');
  });

  await t.test('an admin cannot remove their own administrator role', async () => {
    const res = await server.api('/admin/users/' + admin.user.id, {
      method: 'PUT',
      body: { role: 'user' }
    }, admin.cookie);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /your own/i);
  });

  await t.test('an admin cannot delete their own account through the admin API', async () => {
    const res = await server.api('/admin/users/' + admin.user.id, { method: 'DELETE' }, admin.cookie);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /your own/i);
  });

  await t.test('deleting a user removes their content and frees the account', async () => {
    const list = await server.api('/admin/users', {}, admin.cookie);
    const target = list.body.users.find(u => u.email === 'hoarder@example.com');
    assert.ok(target.used_bytes > 0, 'account should be using storage before deletion');

    const res = await server.api('/admin/users/' + target.id, { method: 'DELETE' }, admin.cookie);
    assert.equal(res.status, 200);

    const after = await server.api('/admin/users', {}, admin.cookie);
    assert.equal(after.body.users.some(u => u.id === target.id), false);

    // The deleted account can no longer authenticate.
    const login = await server.api('/auth/login', {
      method: 'POST',
      body: { email: 'hoarder@example.com', password: 'a-valid-password-here' }
    });
    assert.equal(login.status, 401);
  });

  await t.test('a normal user cannot create or delete accounts', async () => {
    const user = await signIn(server, { email: 'nosy@example.com' });
    const create = await server.api('/admin/users', {
      method: 'POST',
      body: { name: 'X', email: 'x2@example.com', password: 'a-valid-password-here' }
    }, user.cookie);
    assert.equal(create.status, 403);

    const list = await server.api('/admin/users', {}, admin.cookie);
    const victim = list.body.users.find(u => u.email === 'nosy@example.com');
    const del = await server.api('/admin/users/' + victim.id, { method: 'DELETE' }, user.cookie);
    assert.equal(del.status, 403);
  });

  await t.test('the instance default quota is editable and applies to new accounts', async () => {
    const put = await server.api('/admin/instance', {
      method: 'PUT',
      body: { default_quota_bytes: 77777 }
    }, admin.cookie);
    assert.equal(put.status, 200);

    const res = await server.api('/admin/users', {
      method: 'POST',
      body: { name: 'Default Check', email: 'default@example.com', password: 'a-valid-password-here' }
    }, admin.cookie);
    assert.equal(res.body.user.quota_bytes, 77777);
  });
});
