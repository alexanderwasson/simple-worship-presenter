'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { startServer, signIn } = require('./helpers');

test('security surface', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  await t.test('source and data files are never served', async () => {
    const probes = [
      ['/server.js', 'require('],
      ['/src/db.js', 'lumenstage-data'],
      ['/data/lumenstage-data.json', 'password_hash'],
      ['/node_modules/express/package.json', '"name": "express"'],
      ['/package.json', '"dependencies"'],
      ['/.env', 'SESSION_SECRET='],
      ['/.env.example', 'SESSION_SECRET='],
      ['/Dockerfile', 'FROM node']
    ];
    for (const [path, marker] of probes) {
      const res = await server.request(path);
      assert.equal(res.raw.includes(marker), false, `${path} must not expose "${marker}"`);
    }
  });

  await t.test('the marketing site and the application are separate deployable units', async () => {
    // The application serves the workspace at the root of its own domain.
    const app = await server.request('/');
    assert.match(app.raw, /Workspace — Simple Worship Presenter/);
    assert.doesNotMatch(app.raw, /Present the words/);

    // The public site is a standalone folder, previewable under /site.
    const home = await server.request('/site/');
    assert.match(home.raw, /Present the words/);
    assert.equal(await (await server.request('/site/features')).status, 200);
    assert.equal(await (await server.request('/site/self-hosting')).status, 200);
    assert.equal(await (await server.request('/site/docs')).status, 200);
    assert.equal(await (await server.request('/site/privacy')).status, 200);
    assert.equal(await (await server.request('/site/terms')).status, 200);

    // The two units keep independent stylesheets and the site ships its own helper.
    const appCss = await server.request('/styles.css');
    const siteCss = await server.request('/site/styles.css');
    const siteJs = await server.request('/site/site.js');
    assert.match(appCss.raw, /slide-canvas/);
    assert.match(siteCss.raw, /brand-mark/);
    assert.match(siteJs.raw, /data-app-link/);
  });

  await t.test('unknown api routes return json, not html', async () => {
    const res = await server.request('/api/does-not-exist');
    assert.equal(res.status, 404);
    assert.equal(typeof res.body.error, 'string');
  });

  await t.test('auth endpoints are rate limited', async () => {
    const limited = await startServer({ RATE_LIMIT_MAX_AUTH: '3' });
    t.after(() => limited.stop());
    let last;
    for (let i = 0; i < 8; i++) {
      last = await limited.api('/auth/login', { method: 'POST', body: { email: 'nobody@example.com', password: 'a-valid-password-here' } });
      if (last.status === 429) break;
    }
    assert.equal(last.status, 429, 'expected a 429 after repeated sign-in attempts');
    assert.match(last.body.error, /too many/i);
    assert.ok(last.headers['retry-after']);
  });

  await t.test('health endpoint is public and describes the instance', async () => {
    const res = await server.request('/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.equal(typeof res.body.schema_version, 'number');
  });

  await t.test('settings are per account', async () => {
    const a = await signIn(server, { email: 'a@example.com' });
    const b = await signIn(server, { email: 'b@example.com' });

    await server.api('/settings', { method: 'PUT', body: { ccli_license: '1111111' } }, a.cookie);
    const mine = await server.api('/settings', {}, a.cookie);
    const theirs = await server.api('/settings', {}, b.cookie);
    assert.equal(mine.body.ccli_license, '1111111');
    assert.equal(theirs.body.ccli_license, '');
  });

  await t.test('the instance admin route requires the admin role', async () => {
    const user = await signIn(server, { email: 'regular@example.com' });
    const res = await server.api('/admin/instance', {}, user.cookie);
    assert.equal(res.status, 403);

    const setup = await server.api('/setup/status');
    if (setup.body.needsAdmin) {
      const admin = await server.api('/setup/admin', { method: 'POST', body: { name: 'Admin', email: 'admin@example.com', password: 'a-valid-password-here' } });
      assert.equal(admin.status, 200);
    }
  });

  await t.test('registration can be disabled by the operator', async () => {
    const closed = await startServer({ ALLOW_REGISTRATION: '0' });
    t.after(() => closed.stop());
    const res = await closed.api('/auth/register', { method: 'POST', body: { name: 'X', email: 'x@example.com', password: 'a-valid-password-here' } });
    assert.equal(res.status, 403);
  });

  await t.test('production refuses a default session secret', async () => {
    const { spawn } = require('child_process');
    const path = require('path');
    const child = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, NODE_ENV: 'production', PORT: '4999', SESSION_SECRET: 'development-only-change-me', LOG_LEVEL: 'error' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const code = await new Promise(resolve => child.on('exit', resolve));
    assert.notEqual(code, 0, 'a default secret must stop the server in production');
    child.kill();
  });
});
