'use strict';
const path = require('path');
const fs = require('fs');

// Minimal .env loader so deployments can configure the app without an extra
// dependency. Real environment variables always take precedence.
(function loadEnv() {
  const file = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
})();

function num(name, fallback, { min = 0, integer = false } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || (integer && !Number.isInteger(value))) {
    console.error(`[config] invalid ${name}="${raw}"; expected a number >= ${min}`);
    process.exit(1);
  }
  return value;
}

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';
const defaultSecret = 'development-only-change-me';

// An unset variable falls back to the default; an explicitly empty one disables.
function envOr(name, fallback) {
  return process.env[name] === undefined ? fallback : process.env[name];
}

// Where to look for a newer release, and how to install one. Both are defaults:
// a self-hosted operator can point them elsewhere or turn them off entirely.
// The command deliberately updates code only: restarting the service from
// inside a request would terminate the process before the result is returned.
const DEFAULT_UPDATE_CHECK_URL = 'https://api.github.com/repos/alexanderwasson/simple-worship-presenter/releases/latest';
const DEFAULT_UPDATE_COMMAND = 'node scripts/self-update.js';

const config = {
  nodeEnv,
  isProduction,
  port: num('PORT', 3000, { min: 0, integer: true }),
  dataDir: path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data')),
  sessionSecret: process.env.SESSION_SECRET || (isProduction ? null : defaultSecret),
  trustProxy: process.env.TRUST_PROXY === '1',
  instanceName: process.env.INSTANCE_NAME || 'Simple Worship Presenter',
  publicUrl: process.env.PUBLIC_URL || '',
  allowRegistration: process.env.ALLOW_REGISTRATION !== '0',
  maxUploadBytes: num('MAX_UPLOAD_BYTES', 262144000, { min: 1024, integer: true }),
  defaultQuotaBytes: num('DEFAULT_QUOTA_BYTES', 262144000, { min: 0, integer: true }),
  maxRequestBytes: num('MAX_REQUEST_BYTES', 2097152, { min: 1024, integer: true }),
  rateLimitWindowMs: num('RATE_LIMIT_WINDOW_MS', 60000, { min: 1000, integer: true }),
  rateLimitMaxAuth: num('RATE_LIMIT_MAX_AUTH', 10, { min: 1, integer: true }),
  rateLimitMaxWrite: num('RATE_LIMIT_MAX_WRITE', 240, { min: 1, integer: true }),

  // Self-update is enabled by default against the official upstream release feed.
  // Both are read on demand: nothing is contacted and nothing runs until an
  // administrator asks for it. Set either variable to an empty string to turn
  // that part off on your instance.
  updateCheckUrl: envOr('UPDATE_CHECK_URL', DEFAULT_UPDATE_CHECK_URL),
  updateCommand: envOr('UPDATE_COMMAND', DEFAULT_UPDATE_COMMAND),
  updateTimeoutMs: num('UPDATE_TIMEOUT_MS', 600000, { min: 1000, integer: true })
};

if (!config.sessionSecret) {
  console.error('[config] SESSION_SECRET is required when NODE_ENV=production');
  process.exit(1);
}
if (config.isProduction && config.sessionSecret === defaultSecret) {
  console.error('[config] SESSION_SECRET must be changed from the development default in production');
  process.exit(1);
}
if (config.sessionSecret.length < 16 && !config.isProduction) {
  console.warn('[config] SESSION_SECRET is short; use a long random value for real deployments');
}

module.exports = config;
