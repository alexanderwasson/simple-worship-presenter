'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'promote-admin.js');

function run(args, dataDir) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DATA_DIR: dataDir, NODE_ENV: 'development', SESSION_SECRET: 'maintenance-test-secret' }
  });
}

function writeData(dir, users) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'lumenstage-data.json'), JSON.stringify({
    schema_version: 4,
    users,
    presentations: [],
    programs: [],
    songs: [],
    media: [],
    files: [],
    settings: {}
  }, null, 2));
}

function roles(dir) {
  const data = JSON.parse(fs.readFileSync(path.join(dir, 'lumenstage-data.json'), 'utf8'));
  return data.users.map(u => ({ email: u.email, role: u.role }));
}

test('promote-admin maintenance script', async t => {
  await t.test('lists accounts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swp-maint-'));
    writeData(dir, [
      { id: '1', name: 'Admin', email: 'admin@example.com', role: 'admin', quota_bytes: 1, used_bytes: 0 },
      { id: '2', name: 'Plain', email: 'plain@example.com', role: 'user', quota_bytes: 1, used_bytes: 0 }
    ]);
    const res = run(['--list'], dir);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /admin@example\.com/);
    assert.match(res.stdout, /plain@example\.com/);
  });

  await t.test('promotes a normal account to administrator', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swp-maint-'));
    writeData(dir, [{ id: '2', name: 'Plain', email: 'plain@example.com', role: 'user', quota_bytes: 1, used_bytes: 0 }]);

    const res = run(['plain@example.com'], dir);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /now an administrator/i);
    assert.deepEqual(roles(dir), [{ email: 'plain@example.com', role: 'admin' }]);
  });

  await t.test('matches the email case-insensitively and preserves everything else', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swp-maint-'));
    writeData(dir, [{
      id: 'u9', name: 'Keeper', email: 'keeper@example.com', role: 'user',
      quota_bytes: 262144000, used_bytes: 12345, created_at: '2026-01-01T00:00:00.000Z'
    }]);

    const res = run(['KEEPER@Example.com'], dir);
    assert.equal(res.status, 0, res.stderr);

    const data = JSON.parse(fs.readFileSync(path.join(dir, 'lumenstage-data.json'), 'utf8'));
    const user = data.users[0];
    assert.equal(user.role, 'admin');
    assert.equal(user.name, 'Keeper');
    assert.equal(user.quota_bytes, 262144000);
    assert.equal(user.used_bytes, 12345);
    assert.equal(user.created_at, '2026-01-01T00:00:00.000Z');
    assert.equal(data.presentations.length, 0);
  });

  await t.test('is a no-op when the account is already an administrator', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swp-maint-'));
    writeData(dir, [{ id: '1', name: 'Admin', email: 'admin@example.com', role: 'admin', quota_bytes: 1, used_bytes: 0 }]);
    const before = fs.readFileSync(path.join(dir, 'lumenstage-data.json'), 'utf8');

    const res = run(['admin@example.com'], dir);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /already an administrator/i);
    assert.equal(fs.readFileSync(path.join(dir, 'lumenstage-data.json'), 'utf8'), before);
  });

  await t.test('reports a missing account and lists what exists', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swp-maint-'));
    writeData(dir, [{ id: '1', name: 'Admin', email: 'admin@example.com', role: 'admin', quota_bytes: 1, used_bytes: 0 }]);

    const res = run(['nobody@example.com'], dir);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /No account with the email/i);
    assert.match(res.stderr + res.stdout, /admin@example\.com/);
  });

  await t.test('fails clearly when there is no data file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swp-maint-'));
    const res = run(['x@example.com'], dir);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /No data file found/i);
  });

  await t.test('leaves the data file valid JSON even when saving', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swp-maint-'));
    writeData(dir, [{ id: '1', name: 'A', email: 'a@example.com', role: 'user', quota_bytes: 1, used_bytes: 0 }]);
    run(['a@example.com'], dir);
    const raw = fs.readFileSync(path.join(dir, 'lumenstage-data.json'), 'utf8');
    assert.doesNotThrow(() => JSON.parse(raw));
    assert.equal(fs.existsSync(path.join(dir, 'lumenstage-data.json.tmp')), false, 'temporary file must not be left behind');
  });
});
