'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const config = require('./src/config');
const log = require('./src/log');
const db = require('./src/db');
const auth = require('./src/auth');
const { limiter, authLimiter, writeLimiter } = require('./src/rateLimit');
const contentRoutes = require('./src/routes/content');

const app = express();
if (config.trustProxy) app.set('trust proxy', 1);

app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'same-origin' }
}));
app.use(express.json({ limit: config.maxRequestBytes }));
app.use(cookieParser());

// Request logging and timing.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => log.request(req.method, req.path, res.statusCode, Date.now() - start));
  next();
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    name: config.instanceName,
    version: require('./package.json').version,
    schema_version: db.stats().schema_version,
    uptime: Math.round(process.uptime())
  });
});

// ---- setup and authentication -------------------------------------------
app.get('/api/setup/status', (req, res) => {
  res.json({ needsAdmin: db.data.users.length === 0, instance: config.instanceName });
});

app.post('/api/setup/admin', authLimiter(), async (req, res) => {
  if (db.data.users.length) return res.status(409).json({ error: 'Administrator already exists' });
  const nameProblem = auth.validateName(req.body.name);
  const emailProblem = auth.validateEmail(req.body.email);
  const passwordProblem = auth.validatePassword(req.body.password);
  const problem = nameProblem || emailProblem || passwordProblem;
  if (problem) return res.status(400).json({ error: problem });
  const user = {
    id: db.newId(),
    name: String(req.body.name).trim().slice(0, 100),
    email: String(req.body.email).trim().toLowerCase(),
    password_hash: await auth.hashPassword(req.body.password),
    role: 'admin',
    quota_bytes: db.getSetting('default_quota_bytes', config.defaultQuotaBytes),
    used_bytes: 0,
    created_at: db.now()
  };
  await db.addUser(user);
  auth.setSession(res, user);
  log.info('administrator created', { user: user.id });
  res.json({ user: auth.publicUser(user) });
});

app.post('/api/auth/register', authLimiter(), async (req, res) => {
  if (!config.allowRegistration) return res.status(403).json({ error: 'Registration is disabled on this instance' });
  const nameProblem = auth.validateName(req.body.name);
  const emailProblem = auth.validateEmail(req.body.email);
  const passwordProblem = auth.validatePassword(req.body.password);
  const problem = nameProblem || emailProblem || passwordProblem;
  if (problem) return res.status(400).json({ error: problem });
  const email = String(req.body.email).trim().toLowerCase();
  if (db.findUserByEmail(email)) return res.status(409).json({ error: 'That email is already registered' });
  const user = {
    id: db.newId(),
    name: String(req.body.name).trim().slice(0, 100),
    email,
    password_hash: await auth.hashPassword(req.body.password),
    role: 'user',
    quota_bytes: db.getSetting('default_quota_bytes', config.defaultQuotaBytes),
    used_bytes: 0,
    created_at: db.now()
  };
  await db.addUser(user);
  auth.setSession(res, user);
  res.json({ user: auth.publicUser(user) });
});

app.post('/api/auth/login', authLimiter(), async (req, res) => {
  const user = db.findUserByEmail(req.body.email);
  // Constant-ish work either way so timing does not reveal account existence.
  const ok = user ? await auth.verifyPassword(user, req.body.password) : await auth.verifyPassword({ password_hash: '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin' }, req.body.password);
  if (!user || !ok) return res.status(401).json({ error: 'Email or password is incorrect' });
  auth.setSession(res, user);
  res.json({ user: auth.publicUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  auth.clearSession(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', auth.requireAuth, (req, res) => {
  res.json({ user: auth.publicUser(req.user) });
});

// ---- application content ------------------------------------------------
app.use('/api', limiter({ label: 'api', max: config.rateLimitMaxWrite, message: 'Too many requests.' }), contentRoutes);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `File is too large. Maximum upload size is ${Math.floor(config.maxUploadBytes / 1048576)} MB.` });
  }
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({ error: 'Request body is too large.' });
  }
  if (err && (err.type === 'entity.parse.failed' || err.status === 400)) {
    return res.status(400).json({ error: 'Request body could not be read. Send valid JSON.' });
  }
  log.error('unhandled error', { path: req.path, error: String(err && err.message) });
  res.status(500).json({ error: 'Internal server error' });
});

// ---- static client ------------------------------------------------------
// Two independent deployable units:
//   app/     the authenticated application  -> app.simpleworshippresenter.com
//   website/ the public marketing site      -> simpleworshippresenter.com
// Only the listed files are ever served. server.js, src/, data/, uploads/,
// node_modules/ and environment files must never be reachable over HTTP.
const APP_DIR = path.join(__dirname, 'app');
const SITE_DIR = path.join(__dirname, 'website');

const APP_FILES = new Set(['index.html', 'presenter.html', 'styles.css', 'app.js', 'presenter.js', 'logo.svg']);
const SITE_FILES = new Set(['index.html', 'features.html', 'self-hosting.html', 'docs.html', 'privacy.html', 'terms.html', 'styles.css', 'site.js', 'logo.svg']);

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const name = req.path.slice(1);
  if (APP_FILES.has(name)) return res.sendFile(path.join(APP_DIR, name));
  next();
});

const appPages = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/app': 'index.html',
  '/app.html': 'index.html',
  '/presenter': 'presenter.html',
  '/presenter.html': 'presenter.html'
};
app.get(Object.keys(appPages), (req, res) => res.sendFile(path.join(APP_DIR, appPages[req.path])));

// The public site is also previewable under /site when running a single instance.
const sitePages = {
  '/site': 'index.html',
  '/site/': 'index.html',
  '/site/index.html': 'index.html',
  '/site/features': 'features.html',
  '/site/self-hosting': 'self-hosting.html',
  '/site/docs': 'docs.html',
  '/site/privacy': 'privacy.html',
  '/site/terms': 'terms.html'
};
app.get(Object.keys(sitePages), (req, res) => res.sendFile(path.join(SITE_DIR, sitePages[req.path])));
app.get('/site/*', (req, res) => {
  const name = req.path.slice('/site/'.length);
  if (SITE_FILES.has(name)) return res.sendFile(path.join(SITE_DIR, name));
  res.status(404).send('Not found');
});

app.get('*', (req, res) => res.sendFile(path.join(APP_DIR, 'index.html')));

const server = app.listen(config.port, () => {
  log.info('server started', {
    port: config.port,
    instance: config.instanceName,
    data_dir: config.dataDir,
    mode: config.nodeEnv
  });
});

function shutdown(signal) {
  log.info('shutting down', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
