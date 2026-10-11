'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { startServer } = require('./helpers');

test('data durability and migrations', async t => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  await t.test('a corrupt data file is preserved, not overwritten', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swp-mig-'));
    fs.writeFileSync(path.join(dir, 'lumenstage-data.json'), '{ this is not valid json');
    const server = await startServer({ DATA_DIR: dir });
    t.after(() => server.stop());

    const health = await server.request('/api/health');
    assert.equal(health.status, 200);

    const preserved = fs.readdirSync(dir).filter(f => f.includes('corrupt'));
    assert.equal(preserved.length, 1, 'the unreadable file must be preserved');
  });

  await t.test('an older data file is migrated forward without losing rows', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swp-old-'));
    // A v1-era file: no programs, no songs, no media, no settings.
    fs.writeFileSync(path.join(dir, 'lumenstage-data.json'), JSON.stringify({
      users: [{ id: 'u1', name: 'Old', email: 'old@example.com', password_hash: 'x', role: 'admin', quota_bytes: 1, used_bytes: 0, created_at: '2020-01-01T00:00:00.000Z' }],
      presentations: [{ id: 'p1', user_id: 'u1', title: 'Kept', slides_json: '["hello"]', created_at: '2020-01-01T00:00:00.000Z', updated_at: '2020-01-01T00:00:00.000Z' }],
      files: []
    }));

    const server = await startServer({ DATA_DIR: dir });
    t.after(() => server.stop());

    const health = await server.request('/api/health');
    assert.equal(health.body.schema_version, 4);

    const after = JSON.parse(fs.readFileSync(path.join(dir, 'lumenstage-data.json'), 'utf8'));
    assert.equal(after.users.length, 1);
    assert.equal(after.presentations.length, 1);
    assert.equal(after.presentations[0].title, 'Kept');
    assert.deepEqual(after.programs, []);
    assert.deepEqual(after.songs, []);
  });

  await t.test('user data survives a restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swp-restart-'));
    const first = await startServer({ DATA_DIR: dir });
    const { cookie } = await require('./helpers').signIn(first, { email: 'keep@example.com' });
    await first.api('/presentations', { method: 'POST', body: { title: 'Persistent', slides: ['still here'] } }, cookie);
    await first.stop();

    const second = await startServer({ DATA_DIR: dir });
    t.after(() => second.stop());
    const login = await second.api('/auth/login', { method: 'POST', body: { email: 'keep@example.com', password: 'a-valid-password-here' } });
    assert.equal(login.status, 200);
    const cookie2 = second.cookieFrom(login);
    const list = await second.api('/presentations', {}, cookie2);
    assert.equal(list.body.presentations.length, 1);
    assert.equal(list.body.presentations[0].title, 'Persistent');
  });
});
