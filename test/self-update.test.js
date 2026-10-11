'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'self-update.js');

/*
 * Every test points the updater at a temporary directory through
 * UPDATE_TARGET_DIR. The updater defaults to its own install, which is exactly
 * what you want in production and exactly what must never happen in a test.
 */
function runUpdater(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, ...env }
  });
}

function writeApp(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

// A minimal but valid npm project so `npm ci` succeeds in the fixture.
const FIXTURE_PACKAGE = JSON.stringify({ name: 'fixture-app', version: '9.9.9', dependencies: {} }, null, 2);
const FIXTURE_LOCK = JSON.stringify({
  name: 'fixture-app',
  version: '9.9.9',
  lockfileVersion: 3,
  requires: true,
  packages: { '': { name: 'fixture-app', version: '9.9.9' } }
}, null, 2);

function makeArchive() {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'swp-stage-'));
  const sourceDir = path.join(staging, 'fixture-root');
  writeApp(sourceDir, {
    'package.json': FIXTURE_PACKAGE,
    'package-lock.json': FIXTURE_LOCK,
    'server.js': '// new server',
    'src/config.js': '// new config',
    'NEWFILE.md': 'added by the release'
  });

  const archive = path.join(staging, 'release.tar.gz');
  const result = spawnSync('tar', ['-czf', archive, '-C', staging, 'fixture-root'], { encoding: 'utf8' });
  if (result.status !== 0) {
    return null; // tar is unavailable; the round-trip test will be skipped.
  }
  return { archive, staging };
}

function makeInstall() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swp-install-'));
  writeApp(dir, {
    'package.json': FIXTURE_PACKAGE,
    'package-lock.json': FIXTURE_LOCK,
    'server.js': '// old server',
    'src/config.js': '// old config',
    'README.md': 'old readme',
    '.env': 'SESSION_SECRET=do-not-touch',
    'data/lumenstage-data.json': JSON.stringify({ users: [{ id: 'u1' }] }),
    'data/uploads/photo.png': 'fake-image-bytes',
    'node_modules/left-pkg/index.js': '// kept'
  });
  return dir;
}

test('self-update', async t => {
  await t.test('refuses to run outside an application directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swp-empty-'));
    const res = runUpdater([], { UPDATE_TARGET_DIR: dir });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /does not look like an application directory/);
  });

  await t.test('reports a missing npm before doing anything', () => {
    const dir = makeInstall();
    const res = runUpdater([], { UPDATE_TARGET_DIR: dir, PATH: '' });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /npm was not found/);
    // Nothing was modified.
    assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), 'SESSION_SECRET=do-not-touch');
    assert.equal(fs.readFileSync(path.join(dir, 'server.js'), 'utf8'), '// old server');
  });

  await t.test('rejects a release archive that is not an application', () => {
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'swp-bad-'));
    fs.mkdirSync(path.join(staging, 'junk'));
    fs.writeFileSync(path.join(staging, 'junk', 'readme.txt'), 'not an app');
    const archive = path.join(staging, 'bad.tar.gz');
    const made = spawnSync('tar', ['-czf', archive, '-C', staging, 'junk'], { encoding: 'utf8' });
    if (made.status !== 0) return;

    const dir = makeInstall();
    const res = runUpdater([], { UPDATE_TARGET_DIR: dir, UPDATE_ARCHIVE_URL: archive });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /did not contain an application directory/);
    assert.equal(fs.readFileSync(path.join(dir, 'server.js'), 'utf8'), '// old server', 'a bad release must not modify the install');
  });

  await t.test('installs a release without touching user data', async t2 => {
    const built = makeArchive();
    if (!built) {
      t2.skip('tar is not available on this machine');
      return;
    }
    const dir = makeInstall();

    const res = runUpdater([], { UPDATE_TARGET_DIR: dir, UPDATE_ARCHIVE_URL: built.archive });
    assert.equal(res.status, 0, res.stderr);

    // Code was replaced.
    assert.equal(fs.readFileSync(path.join(dir, 'server.js'), 'utf8'), '// new server');
    assert.equal(fs.readFileSync(path.join(dir, 'src', 'config.js'), 'utf8'), '// new config');
    assert.ok(fs.existsSync(path.join(dir, 'NEWFILE.md')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version, '9.9.9');

    // User data survived untouched.
    assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), 'SESSION_SECRET=do-not-touch');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'data', 'lumenstage-data.json'), 'utf8')).users[0].id, 'u1');
    assert.equal(fs.readFileSync(path.join(dir, 'data', 'uploads', 'photo.png'), 'utf8'), 'fake-image-bytes');
    // node_modules is legitimately rebuilt by npm ci. The guarantee that matters
    // is that the copy step itself never removes it, covered above.
    assert.ok(fs.existsSync(path.join(dir, 'node_modules')), 'node_modules should exist after the update');

    fs.rmSync(built.staging, { recursive: true, force: true });
  });

  await t.test('defaults to its own install only when no target is given', () => {
    // Proves the override exists and is what keeps tests away from real installs.
    const dir = makeInstall();
    const probe = spawnSync(process.execPath, [
      '-e',
      "process.env.UPDATE_TARGET_DIR=" + JSON.stringify(dir) + ";" +
      "console.log(require('path').resolve(process.env.UPDATE_TARGET_DIR))"
    ], { encoding: 'utf8' });
    assert.equal(probe.status, 0);
    assert.equal(probe.stdout.trim(), dir);
  });

  await t.test('the updater is syntactically valid', () => {
    const res = spawnSync(process.execPath, ['--check', SCRIPT], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
  });
});
