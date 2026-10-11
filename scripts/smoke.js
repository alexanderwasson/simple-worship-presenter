// Smoke test: boots the real server and checks the unauthenticated surface.
// No test framework dependency; uses node's built-in http and child_process.
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PORT = 3999;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swp-smoke-'));
const root = path.join(__dirname, '..');
const failures = [];

function get(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: pathname }, res => {
      let body = '';
      res.on('data', c => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    setTimeout(() => req.destroy(new Error('timeout')), 5000);
  });
}

function assert(name, condition, detail) {
  if (condition) {
    console.log('  ok - ' + name);
  } else {
    failures.push(name);
    console.error('  FAIL - ' + name + (detail ? ' :: ' + detail : ''));
  }
}

const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), DATA_DIR, SESSION_SECRET: 'smoke-test-secret' },
  stdio: ['ignore', 'pipe', 'pipe']
});

let started = false;
server.stdout.on('data', () => (started = true));
server.stderr.on('data', d => process.stderr.write(d));

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      await get('/api/health');
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  return false;
}

(async () => {
  const up = await waitForServer();
  assert('server starts', up);
  if (!up) {
    server.kill();
    process.exit(1);
  }

  console.log('smoke: health and static surface');
  const health = await get('/api/health');
  assert('/api/health returns 200', health.status === 200, 'got ' + health.status);
  assert('/api/health is json', (() => { try { return JSON.parse(health.body).status === 'ok'; } catch { return false; } })(), health.body.slice(0, 80));

  const index = await get('/');
  assert('GET / serves the application', index.status === 200 && index.body.includes('Simple Worship Presenter'), 'got ' + index.status);

  console.log('smoke: sensitive files are not exposed');
  const secretMarkers = [
    ['/server.js', 'express('],
    ['/data/lumenstage-data.json', 'password_hash'],
    ['/node_modules/express/package.json', '"name": "express"'],
    ['/.env', 'SESSION_SECRET='],
    ['/.env.example', 'SESSION_SECRET=']
  ];
  for (const [p, marker] of secretMarkers) {
    const r = await get(p);
    const leaked = r.body.includes(marker);
    assert('GET ' + p + ' does not leak source', !leaked, 'status ' + r.status + ' contains ' + marker);
  }

  console.log('smoke: api error shape');
  const missing = await get('/api/auth/me');
  assert('unauthenticated request is rejected', missing.status === 401, 'got ' + missing.status);
  assert('error responses use {error}', (() => { try { return typeof JSON.parse(missing.body).error === 'string'; } catch { return false; } })(), missing.body.slice(0, 80));

  console.log('smoke: registration creates a scoped account');
  const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/auth/register', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
    let body = '';
    res.on('data', c => (body += c));
    res.on('end', () => {
      assert('registration succeeds', res.statusCode === 200, 'got ' + res.statusCode + ' ' + body.slice(0, 120));
      assert('password hash is never returned', !body.includes('password_hash'), body.slice(0, 120));
      server.kill();
      fs.rmSync(DATA_DIR, { recursive: true, force: true });
      if (failures.length) {
        console.error(failures.length + ' failure(s)');
        process.exit(1);
      }
      console.log('all smoke tests passed');
    });
  });
  req.on('error', err => {
    assert('registration request completes', false, err.message);
    server.kill();
    process.exit(1);
  });
  req.end(JSON.stringify({ name: 'Smoke Test', email: 'smoke@example.com', password: 'a-long-smoke-password' }));
})().catch(err => {
  console.error(err);
  server.kill();
  process.exit(1);
});
