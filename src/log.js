'use strict';
const config = require('./config');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL] || LEVELS.info;

function write(level, message, meta) {
  if (LEVELS[level] < threshold) return;
  const entry = { ts: new Date().toISOString(), level, msg: message };
  if (meta && typeof meta === 'object') {
    for (const [k, v] of Object.entries(meta)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) entry[k] = v;
    }
  }
  const line = JSON.stringify(entry);
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

module.exports = {
  debug: (m, meta) => write('debug', m, meta),
  info: (m, meta) => write('info', m, meta),
  warn: (m, meta) => write('warn', m, meta),
  error: (m, meta) => write('error', m, meta),
  request(method, path, status, ms) {
    write(status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info', 'request', {
      method, path, status, ms, instance: config.instanceName
    });
  }
};
