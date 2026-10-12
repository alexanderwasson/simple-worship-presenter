'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const log = require('./log');

const DB_FILE = path.join(config.dataDir, 'lumenstage-data.json');
const SCHEMA_VERSION = 4;

function blank() {
  return {
    schema_version: SCHEMA_VERSION,
    users: [],
    presentations: [],
    programs: [],
    songs: [],
    media: [],
    files: [],
    settings: {}
  };
}

// Migrations run in order and are additive. Existing user data is never deleted.
const migrations = [
  { version: 1, name: 'base collections', apply: d => { d.users ||= []; d.presentations ||= []; d.files ||= []; } },
  { version: 2, name: 'service plans', apply: d => { d.programs ||= []; } },
  { version: 3, name: 'song and media library', apply: d => { d.songs ||= []; d.media ||= []; } },
  { version: 4, name: 'instance settings', apply: d => { d.settings ||= {}; d.schema_version = 4; } }
];

function migrate(data) {
  const from = Number(data.schema_version || 0);
  let changed = false;
  for (const step of migrations) {
    if (step.version > from) {
      step.apply(data);
      data.schema_version = step.version;
      changed = true;
      log.info('migration applied', { version: step.version, name: step.name });
    }
  }
  return { data, changed };
}

function load() {
  if (!fs.existsSync(DB_FILE)) return migrate(blank());
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8').replace(/^\uFEFF/, ''));
    return migrate(parsed);
  } catch (err) {
    // Preserve the unreadable file instead of overwriting it.
    const backup = DB_FILE + '.corrupt-' + Date.now();
    fs.copyFileSync(DB_FILE, backup);
    log.error('data file was unreadable; preserved at backup path', { backup, error: String(err.message) });
    return migrate(blank());
  }
}

const loaded = load();
const data = loaded.data;
let writeQueue = Promise.resolve();

function persist() {
  writeQueue = writeQueue.then(() => {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, DB_FILE);
  }).catch(err => log.error('failed to persist data', { error: String(err.message) }));
  return writeQueue;
}

// Write the migrated schema back so the on-disk file matches the runtime shape.
if (loaded.changed) persist();

module.exports = {
  data,
  persist,
  file: DB_FILE,
  newId: () => crypto.randomUUID(),
  now: () => new Date().toISOString(),

  // ---- users ----
  findUserByEmail: email => data.users.find(u => u.email === String(email || '').trim().toLowerCase()),
  findUserById: id => data.users.find(u => u.id === id),
  addUser(user) { data.users.push(user); return persist().then(() => user); },
  removeUser(id) {
    data.users = data.users.filter(u => u.id !== id);
    data.presentations = data.presentations.filter(p => p.user_id !== id);
    data.programs = data.programs.filter(p => p.user_id !== id);
    data.songs = data.songs.filter(s => s.user_id !== id);
    data.media = data.media.filter(m => m.user_id !== id);
    data.files = data.files.filter(f => f.user_id !== id);
    return persist();
  },

  // ---- generic owner-scoped access ----
  owned(collection, userId, id) {
    return (data[collection] || []).find(row => row.id === id && row.user_id === userId);
  },
  allOwned(collection, userId) {
    return (data[collection] || []).filter(row => row.user_id === userId);
  },
  insert(collection, row) {
    data[collection].push(row);
    // Content counts against the owner's storage quota, so keep usage in step.
    if (row && row.user_id) module.exports.recomputeUsage(row.user_id);
    return persist();
  },
  remove(collection, userId, id) {
    data[collection] = (data[collection] || []).filter(r => !(r.id === id && r.user_id === userId));
    module.exports.recomputeUsage(userId);
    return persist();
  },

  // ---- settings ----
  getSetting(key, fallback) { return data.settings && key in data.settings ? data.settings[key] : fallback; },
  setSetting(key, value) { data.settings[key] = value; return persist(); },

  // ---- storage accounting ----
  // Usage is recomputed from what is actually stored rather than incremented,
  // so it cannot drift when content is edited or when older records predate a
  // change in accounting rules.
  storageBreakdown(userId) {
    const byteLength = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value ?? ''), 'utf8');
    let media = 0, presentations = 0, songs = 0, programs = 0, files = 0;
    for (const m of data.media) if (m.user_id === userId) media += Number(m.size) || 0;
    for (const f of data.files) if (f.user_id === userId) files += Number(f.size) || 0;
    for (const p of data.presentations) {
      if (p.user_id !== userId) continue;
      presentations += byteLength(p.title) + byteLength(p.slides_json || '');
    }
    for (const s of data.songs) {
      if (s.user_id !== userId) continue;
      songs += byteLength(s.title) + byteLength(s.author) + byteLength(s.artist) + byteLength(s.copyright) +
        byteLength(s.tags) + byteLength(s.sections) + byteLength(s.theme);
    }
    for (const p of data.programs) {
      if (p.user_id !== userId) continue;
      programs += byteLength(p.title) + byteLength(p.notes) + byteLength(p.presentation_ids);
    }
    return { media, files, presentations, songs, programs, total: media + files + presentations + songs + programs };
  },
  recomputeUsage(userId) {
    const u = module.exports.findUserById(userId);
    if (u) u.used_bytes = module.exports.storageBreakdown(userId).total;
    return persist();
  },
  addUsage(userId, bytes) {
    const u = module.exports.findUserById(userId);
    if (u) u.used_bytes = Math.max(0, (u.used_bytes || 0) + bytes);
    return persist();
  },
  async reclaimUsage(userId, bytes) {
    const u = module.exports.findUserById(userId);
    if (u) u.used_bytes = Math.max(0, (u.used_bytes || 0) - bytes);
    return persist();
  },
  stats() {
    return {
      users: data.users.length,
      presentations: data.presentations.length,
      programs: data.programs.length,
      songs: data.songs.length,
      media: data.media.length,
      bytes: (data.media || []).reduce((n, m) => n + (m.size || 0), 0),
      schema_version: data.schema_version || SCHEMA_VERSION
    };
  }
};
