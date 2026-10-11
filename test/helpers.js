'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

async function startServer(extraEnv = {}) {
  const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swp-test-'));
  const port = 4000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR,
      SESSION_SECRET: 'test-secret-value-for-tests',
      NODE_ENV: 'development',
      LOG_LEVEL: 'error',
      // Tests create many accounts quickly; the dedicated rate-limit test
      // overrides these to prove the limiter works.
      RATE_LIMIT_MAX_AUTH: '10000',
      RATE_LIMIT_MAX_WRITE: '100000',
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderr = '';
  child.stderr.on('data', d => (stderr += d.toString()));

  const request = (pathname, options = {}) => new Promise((resolve, reject) => {
    const opts = {
      host: '127.0.0.1',
      port,
      path: pathname,
      method: options.method || 'GET',
      headers: { ...(options.headers || {}) }
    };
    const body = options.body;
    let payload;
    if (body) {
      payload = typeof body === 'string' || body instanceof Buffer ? body : JSON.stringify(body);
      if (typeof body !== 'string' && !(body instanceof Buffer)) opts.headers['Content-Type'] = 'application/json';
      // Always declare the length: some body parsers reject chunked request bodies.
      opts.headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    const req = http.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

  // Wait for the health endpoint.
  for (let i = 0; i < 60; i++) {
    try {
      const health = await request('/api/health');
      if (health.status === 200) break;
    } catch { }
    await new Promise(r => setTimeout(r, 50));
    if (i === 59) throw new Error('server did not start: ' + stderr);
  }

  const cookieFrom = res => {
    const raw = res.headers['set-cookie'] || [];
    return raw.map(c => c.split(';')[0]).join('; ');
  };

  const api = async (pathname, options = {}, cookies) => {
    const headers = { ...(options.headers || {}) };
    if (cookies) headers.Cookie = cookies;
    return request('/api' + pathname, { ...options, headers });
  };

  return {
    port,
    request,
    api,
    cookieFrom,
    async stop() {
      child.kill();
      await new Promise(r => setTimeout(r, 60));
      fs.rmSync(DATA_DIR, { recursive: true, force: true });
    },
    get stderr() { return stderr; }
  };
}

async function signIn(server, { name = 'Test User', email = 'test@example.com', password = 'a-valid-password-here' } = {}) {
  const res = await server.api('/auth/register', { method: 'POST', body: { name, email, password } });
  return { user: res.body.user, cookie: server.cookieFrom(res) };
}

module.exports = { startServer, signIn };
