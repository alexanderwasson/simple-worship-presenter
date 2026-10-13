'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec, execSync } = require('child_process');
const express = require('express');
const multer = require('multer');
const config = require('../config');
const db = require('../db');
const log = require('../log');
const auth = require('../auth');
const { writeLimiter } = require('../rateLimit');

const router = express.Router();
const UPLOAD_DIR = path.join(config.dataDir, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function jsonError(res, status, message) {
  return res.status(status).json({ error: message });
}

function bytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

// ---- upload validation -------------------------------------------------
// Validate actual bytes, not only the extension or the declared content type.
const MAGIC = [
  { kind: 'image', mime: 'image/png', test: b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { kind: 'image', mime: 'image/jpeg', test: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { kind: 'image', mime: 'image/gif', test: b => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 },
  { kind: 'image', mime: 'image/webp', test: b => b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
  { kind: 'video', mime: 'video/mp4', test: b => b.toString('ascii', 4, 8) === 'ftyp' },
  { kind: 'audio', mime: 'audio/mpeg', test: b => (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) },
  { kind: 'audio', mime: 'audio/wav', test: b => b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE' },
  { kind: 'audio', mime: 'audio/ogg', test: b => b.toString('ascii', 0, 4) === 'OggS' }
];

function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  return MAGIC.find(m => {
    try { return m.test(buf); } catch { return false; }
  }) || null;
}

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: config.maxUploadBytes }
});

function safeName(name) {
  return String(name || 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 120);
}

// Quota is checked against what the account actually stores, and usage is
// recomputed after every mutation so it can never drift.
async function withinQuota(user, incomingBytes = 0) {
  return db.storageBreakdown(user.id).total + incomingBytes <= user.quota_bytes;
}

// ---- media --------------------------------------------------------------
router.get('/media', auth.requireAuth, (req, res) => {
  res.json({ media: db.allOwned('media', req.user.id).sort((a, b) => b.created_at.localeCompare(a.created_at)) });
});

router.post('/media', auth.requireAuth, writeLimiter(), upload.single('file'), async (req, res) => {
  if (!req.file) return jsonError(res, 400, 'No file uploaded');
  const buffer = fs.readFileSync(req.file.path).subarray(0, 32);
  const detected = sniff(buffer);
  if (!detected) {
    fs.unlinkSync(req.file.path);
    return jsonError(res, 415, 'Unsupported or unrecognised file type. Upload PNG, JPG, GIF, WebP, MP4, MP3, WAV or OGG.');
  }
  if (!(await withinQuota(req.user, req.file.size))) {
    fs.unlinkSync(req.file.path);
    return jsonError(res, 413, 'Storage quota exceeded');
  }
  const record = {
    id: db.newId(),
    user_id: req.user.id,
    original_name: safeName(req.file.originalname),
    stored_name: path.basename(req.file.path),
    mime: detected.mime,
    kind: detected.kind,
    size: req.file.size,
    created_at: db.now()
  };
  await db.insert('media', record);
  log.info('media uploaded', { user: req.user.id, kind: record.kind, bytes: record.size });
  res.status(201).json({ media: record });
});

router.get('/media/:id/file', auth.requireAuth, (req, res) => {
  const item = db.owned('media', req.user.id, req.params.id);
  if (!item) return jsonError(res, 404, 'Media not found');
  res.setHeader('Content-Type', item.mime);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.sendFile(path.join(UPLOAD_DIR, item.stored_name));
});

router.delete('/media/:id', auth.requireAuth, async (req, res) => {
  const item = db.owned('media', req.user.id, req.params.id);
  if (!item) return jsonError(res, 404, 'Media not found');
  try { fs.unlinkSync(path.join(UPLOAD_DIR, item.stored_name)); } catch { /* already gone */ }
  await db.remove('media', req.user.id, item.id);
  res.status(204).end();
});

// ---- songs --------------------------------------------------------------
router.get('/songs', auth.requireAuth, (req, res) => {
  res.json({ songs: db.allOwned('songs', req.user.id).sort((a, b) => b.updated_at.localeCompare(a.updated_at)) });
});

function normaliseSong(body) {
  const title = String(body.title || '').trim();
  if (!title) return { error: 'Song title is required' };
  const sections = Array.isArray(body.sections) ? body.sections.slice(0, 100) : [];
  return {
    song: {
      title: title.slice(0, 200),
      author: String(body.author || '').slice(0, 200),
      artist: String(body.artist || '').slice(0, 200),
      copyright: String(body.copyright || '').slice(0, 300),
      ccli: String(body.ccli || '').slice(0, 60),
      tags: Array.isArray(body.tags) ? body.tags.slice(0, 30).map(t => String(t).slice(0, 40)) : [],
      sections: sections.map((s, i) => ({
        id: String(s.id || db.newId()),
        label: String(s.label || `Section ${i + 1}`).slice(0, 60),
        text: String(s.text || '').slice(0, 4000)
      })),
      theme: body.theme && typeof body.theme === 'object' ? body.theme : {}
    }
  };
}

router.post('/songs', auth.requireAuth, writeLimiter(), async (req, res) => {
  const { song, error } = normaliseSong(req.body);
  if (error) return jsonError(res, 400, error);
  const now = db.now();
  const row = { id: db.newId(), user_id: req.user.id, ...song, created_at: now, updated_at: now };
  await db.insert('songs', row);
  res.status(201).json({ song: row });
});

router.put('/songs/:id', auth.requireAuth, writeLimiter(), async (req, res) => {
  const row = db.owned('songs', req.user.id, req.params.id);
  if (!row) return jsonError(res, 404, 'Song not found');
  const { song, error } = normaliseSong(req.body);
  if (error) return jsonError(res, 400, error);
  Object.assign(row, song, { updated_at: db.now() });
  await db.recomputeUsage(req.user.id);
  res.json({ song: row });
});

router.delete('/songs/:id', auth.requireAuth, async (req, res) => {
  const row = db.owned('songs', req.user.id, req.params.id);
  if (!row) return jsonError(res, 404, 'Song not found');
  await db.remove('songs', req.user.id, row.id);
  res.status(204).end();
});

// Generate slides from song lyrics. Repeats each section as requested so a
// service plan can use the same song more than once.
router.post('/songs/:id/generate', auth.requireAuth, (req, res) => {
  const song = db.owned('songs', req.user.id, req.params.id);
  if (!song) return jsonError(res, 404, 'Song not found');
  const linesPerSlide = Math.min(8, Math.max(1, Number(req.body.lines_per_slide) || 4));
  const order = Array.isArray(req.body.order) && req.body.order.length ? req.body.order : song.sections.map(s => s.id);
  const slides = [];
  for (const sectionId of order) {
    const section = song.sections.find(s => s.id === sectionId);
    if (!section) continue;
    const lines = String(section.text).split(/\r?\n/).filter(l => l.trim().length);
    const chunks = [];
    for (let i = 0; i < lines.length; i += linesPerSlide) chunks.push(lines.slice(i, i + linesPerSlide).join('\n'));
    if (!chunks.length) chunks.push('');
    chunks.forEach((text, i) => slides.push({
      text: i === 0 && chunks.length > 1 ? `${section.label}\n${text}` : text,
      section: section.label,
      background: song.theme?.background || ''
    }));
  }
  res.json({ slides, title: song.title });
});

// ---- presentations ------------------------------------------------------
router.get('/presentations', auth.requireAuth, (req, res) => {
  res.json({
    presentations: db.allOwned('presentations', req.user.id)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map(p => ({ ...p, slides: safeSlides(p.slides_json), bg: parseBg(p.bg_json) }))
  });
});

function safeSlides(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.slice(0, 500) : [];
  } catch {
    return [];
  }
}

// A presentation carries a default background that every slide inherits unless
// a slide sets its own. Stored separately from slides so switching presentation
// in a service plan switches the look with it.
function parseBg(raw) {
  try {
    const parsed = JSON.parse(raw || 'null');
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function normaliseSlides(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 500).map(s => {
    if (typeof s === 'string') return s.slice(0, 4000);
    if (s && typeof s === 'object') {
      const out = { text: String(s.text || '').slice(0, 4000) };
      if (s.image) out.image = String(s.image).slice(0, 2000000);
      if (s.background) out.background = String(s.background).slice(0, 2000000);
      if (s.name) out.name = String(s.name).slice(0, 200);
      // Typing, animation and animated backgrounds live on the slide and must
      // survive a save and reload.
      if (s.style && typeof s.style === 'object') out.style = s.style;
      if (s.video && typeof s.video === 'object') out.video = s.video;
      return out;
    }
    return '';
  });
}

router.post('/presentations', auth.requireAuth, writeLimiter(), async (req, res) => {
  const now = db.now();
  const row = {
    id: db.newId(),
    user_id: req.user.id,
    title: String(req.body.title || 'Untitled presentation').slice(0, 200),
    slides_json: JSON.stringify(normaliseSlides(req.body.slides)),
    bg_json: JSON.stringify(req.body.bg || null),
    created_at: now,
    updated_at: now
  };
  await db.insert('presentations', row);
  res.status(201).json({ id: row.id, title: row.title, slides: safeSlides(row.slides_json), bg: parseBg(row.bg_json) });
});

router.put('/presentations/:id', auth.requireAuth, writeLimiter(), async (req, res) => {
  const row = db.owned('presentations', req.user.id, req.params.id);
  if (!row) return jsonError(res, 404, 'Presentation not found');
  if (req.body.title !== undefined) row.title = String(req.body.title).slice(0, 200);
  if (req.body.slides !== undefined) row.slides_json = JSON.stringify(normaliseSlides(req.body.slides));
  if (req.body.bg !== undefined) row.bg_json = JSON.stringify(req.body.bg || null);
  row.updated_at = db.now();
  await db.recomputeUsage(req.user.id);
  // Return the saved deck so callers can verify what actually persisted.
  res.json({ id: row.id, title: row.title, slides: safeSlides(row.slides_json), bg: parseBg(row.bg_json) });
});

router.post('/presentations/:id/duplicate', auth.requireAuth, writeLimiter(), async (req, res) => {
  const row = db.owned('presentations', req.user.id, req.params.id);
  if (!row) return jsonError(res, 404, 'Presentation not found');
  const now = db.now();
  const copy = {
    id: db.newId(),
    user_id: req.user.id,
    title: (row.title + ' copy').slice(0, 200),
    slides_json: row.slides_json,
    bg_json: row.bg_json,
    created_at: now,
    updated_at: now
  };
  await db.insert('presentations', copy);
  res.status(201).json({ id: copy.id, title: copy.title, slides: safeSlides(copy.slides_json), bg: parseBg(copy.bg_json) });
});

router.delete('/presentations/:id', auth.requireAuth, async (req, res) => {
  const row = db.owned('presentations', req.user.id, req.params.id);
  if (!row) return jsonError(res, 404, 'Presentation not found');
  await db.remove('presentations', req.user.id, row.id);
  res.status(204).end();
});

// ---- service plans ("programs") -----------------------------------------
router.get('/programs', auth.requireAuth, (req, res) => {
  res.json({ programs: db.allOwned('programs', req.user.id) });
});

router.post('/programs', auth.requireAuth, writeLimiter(), async (req, res) => {
  const row = {
    id: db.newId(),
    user_id: req.user.id,
    title: String(req.body.title || 'Untitled program').slice(0, 200),
    date: String(req.body.date || db.now().slice(0, 10)).slice(0, 20),
    notes: String(req.body.notes || '').slice(0, 2000),
    presentation_ids: Array.isArray(req.body.presentation_ids) ? req.body.presentation_ids.slice(0, 200) : [],
    created_at: db.now()
  };
  await db.insert('programs', row);
  res.status(201).json({ program: row });
});

router.put('/programs/:id', auth.requireAuth, writeLimiter(), async (req, res) => {
  const row = db.owned('programs', req.user.id, req.params.id);
  if (!row) return jsonError(res, 404, 'Program not found');
  if (req.body.title !== undefined) row.title = String(req.body.title).slice(0, 200);
  if (req.body.date !== undefined) row.date = String(req.body.date).slice(0, 20);
  if (req.body.notes !== undefined) row.notes = String(req.body.notes).slice(0, 2000);
  if (Array.isArray(req.body.presentation_ids)) row.presentation_ids = req.body.presentation_ids.slice(0, 200);
  await db.recomputeUsage(req.user.id);
  res.json({ program: row });
});

router.post('/programs/:id/duplicate', auth.requireAuth, writeLimiter(), async (req, res) => {
  const row = db.owned('programs', req.user.id, req.params.id);
  if (!row) return jsonError(res, 404, 'Program not found');
  const copy = { ...row, id: db.newId(), title: (row.title + ' copy').slice(0, 200), created_at: db.now() };
  await db.insert('programs', copy);
  res.status(201).json({ program: copy });
});

router.delete('/programs/:id', auth.requireAuth, async (req, res) => {
  const row = db.owned('programs', req.user.id, req.params.id);
  if (!row) return jsonError(res, 404, 'Program not found');
  await db.remove('programs', req.user.id, row.id);
  res.status(204).end();
});

// ---- legacy import endpoint (kept for backward compatibility) ------------
router.post('/import', auth.requireAuth, writeLimiter(), upload.single('file'), async (req, res) => {
  if (!req.file) return jsonError(res, 400, 'No file uploaded');
  const buffer = fs.readFileSync(req.file.path).subarray(0, 32);
  const detected = sniff(buffer);
  const size = req.file.size;
  if (detected) {
    if (!(await withinQuota(req.user, size))) {
      fs.unlinkSync(req.file.path);
      return jsonError(res, 413, 'Storage quota exceeded');
    }
    const record = {
      id: db.newId(), user_id: req.user.id, original_name: safeName(req.file.originalname),
      stored_name: path.basename(req.file.path), mime: detected.mime, kind: detected.kind,
      size, created_at: db.now()
    };
    await db.insert('media', record);
    return res.json({ ok: true, media: record });
  }
  // Text/project imports are stored as text records, not media.
  const text = fs.readFileSync(req.file.path, 'utf8').slice(0, 2000000);
  fs.unlinkSync(req.file.path);
  if (/[\u0000-\u0008]/.test(text.slice(0, 1000))) {
    return jsonError(res, 415, 'This file is not readable text. Export it as text or XML first.');
  }
  if (!(await withinQuota(req.user, size))) return jsonError(res, 413, 'Storage quota exceeded');
  const record = {
    id: db.newId(), user_id: req.user.id, original_name: safeName(req.file.originalname),
    stored_name: null, mime: 'text/plain', kind: 'text', size, created_at: db.now()
  };
  await db.insert('files', record);
  res.json({ ok: true, file: record, text });
});

// ---- settings -----------------------------------------------------------
router.get('/settings', auth.requireAuth, (req, res) => {
  res.json({
    instance: config.instanceName,
    public_url: config.publicUrl,
    quota_bytes: req.user.quota_bytes,
    used_bytes: req.user.used_bytes,
    storage: db.storageBreakdown(req.user.id),
    allow_registration: config.allowRegistration,
    ccli_license: db.getSetting('ccli:' + req.user.id, '')
  });
});

router.put('/settings', auth.requireAuth, writeLimiter(), async (req, res) => {
  if (req.body.ccli_license !== undefined) {
    await db.setSetting('ccli:' + req.user.id, String(req.body.ccli_license).slice(0, 60));
  }
  res.json({ ok: true });
});

// ---- account management -------------------------------------------------
router.post('/account/password', auth.requireAuth, writeLimiter(), async (req, res) => {
  const problem = auth.validatePassword(req.body.new_password);
  if (problem) return jsonError(res, 400, problem);
  if (!(await auth.verifyPassword(req.user, req.body.current_password))) {
    return jsonError(res, 401, 'Current password is incorrect');
  }
  req.user.password_hash = await auth.hashPassword(req.body.new_password);
  await db.persist();
  res.json({ ok: true });
});

router.delete('/account', auth.requireAuth, writeLimiter(), async (req, res) => {
  if (!(await auth.verifyPassword(req.user, req.body.password))) {
    return jsonError(res, 401, 'Password is incorrect');
  }
  for (const m of db.allOwned('media', req.user.id)) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, m.stored_name)); } catch { /* already gone */ }
  }
  await db.removeUser(req.user.id);
  auth.clearSession(res);
  res.json({ ok: true });
});

// ---- admin: instance configuration --------------------------------------
router.get('/admin/instance', auth.requireAdmin, (req, res) => {
  res.json({
    instance: config.instanceName,
    default_quota_bytes: db.getSetting('default_quota_bytes', config.defaultQuotaBytes),
    stats: db.stats()
  });
});

router.put('/admin/instance', auth.requireAdmin, writeLimiter(), async (req, res) => {
  if (req.body.default_quota_bytes !== undefined) {
    const value = Number(req.body.default_quota_bytes);
    if (!Number.isFinite(value) || value < 0) return jsonError(res, 400, 'default_quota_bytes must be a positive number');
    await db.setSetting('default_quota_bytes', Math.floor(value));
  }
  res.json({ ok: true });
});

// ---- admin: user management ---------------------------------------------
// Quotas are editable per account. Nothing here touches another user's
// content directly: removing a user removes their own rows and files only.
const MAX_QUOTA = 1099511627776; // 1 TB, a sanity ceiling rather than a product limit

function parseQuota(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > MAX_QUOTA) return null;
  return Math.floor(n);
}

router.get('/admin/users', auth.requireAdmin, (req, res) => {
  res.json({
    default_quota_bytes: db.getSetting('default_quota_bytes', config.defaultQuotaBytes),
    users: db.data.users
      .map(auth.publicUser)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
  });
});

router.post('/admin/users', auth.requireAdmin, writeLimiter(), async (req, res) => {
  const nameProblem = auth.validateName(req.body.name);
  const emailProblem = auth.validateEmail(req.body.email);
  const passwordProblem = auth.validatePassword(req.body.password);
  const problem = nameProblem || emailProblem || passwordProblem;
  if (problem) return jsonError(res, 400, problem);

  const quota = req.body.quota_bytes === undefined
    ? db.getSetting('default_quota_bytes', config.defaultQuotaBytes)
    : parseQuota(req.body.quota_bytes);
  if (quota === null) return jsonError(res, 400, 'quota_bytes must be between 0 and 1 TB');

  const email = String(req.body.email).trim().toLowerCase();
  if (db.findUserByEmail(email)) return jsonError(res, 409, 'That email is already registered');

  const role = req.body.role === 'admin' ? 'admin' : 'user';
  const user = {
    id: db.newId(),
    name: String(req.body.name).trim().slice(0, 100),
    email,
    password_hash: await auth.hashPassword(req.body.password),
    role,
    quota_bytes: quota,
    used_bytes: 0,
    created_at: db.now()
  };
  await db.addUser(user);
  log.info('admin created user', { admin: req.user.id, user: user.id, role });
  res.status(201).json({ user: auth.publicUser(user) });
});

router.put('/admin/users/:id', auth.requireAdmin, writeLimiter(), async (req, res) => {
  const target = db.findUserById(req.params.id);
  if (!target) return jsonError(res, 404, 'User not found');

  if (req.body.name !== undefined) {
    const problem = auth.validateName(req.body.name);
    if (problem) return jsonError(res, 400, problem);
    target.name = String(req.body.name).trim().slice(0, 100);
  }
  if (req.body.quota_bytes !== undefined) {
    const quota = parseQuota(req.body.quota_bytes);
    if (quota === null) return jsonError(res, 400, 'quota_bytes must be between 0 and 1 TB');
    if (quota < target.used_bytes) {
      return jsonError(res, 400, `Quota cannot be below the ${bytes(target.used_bytes)} already stored by this account. Delete files first.`);
    }
    target.quota_bytes = quota;
  }
  if (req.body.role !== undefined) {
    if (req.body.role !== 'admin' && req.body.role !== 'user') return jsonError(res, 400, 'role must be "admin" or "user"');
    // Never let an administrator remove their own last foothold.
    if (target.id === req.user.id && req.body.role !== 'admin') {
      return jsonError(res, 400, 'You cannot remove your own administrator role');
    }
    target.role = req.body.role;
  }
  await db.persist();
  log.info('admin updated user', { admin: req.user.id, user: target.id });
  res.json({ user: auth.publicUser(target) });
});

router.delete('/admin/users/:id', auth.requireAdmin, writeLimiter(), async (req, res) => {
  const target = db.findUserById(req.params.id);
  if (!target) return jsonError(res, 404, 'User not found');
  if (target.id === req.user.id) {
    return jsonError(res, 400, 'You cannot delete your own account here. Use Settings → Delete account.');
  }
  for (const m of db.allOwned('media', target.id)) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, m.stored_name)); } catch { /* already gone */ }
  }
  await db.removeUser(target.id);
  log.info('admin deleted user', { admin: req.user.id, user: target.id });
  res.json({ ok: true });
});

// ---- admin: updates and backups -----------------------------------------
// Self-update is opt-in through UPDATE_COMMAND. Nothing runs unless the
// operator has explicitly configured it, and the command is never user input.
const { compareVersions, pickVersion } = require('../version');

const APP_ROOT = path.join(__dirname, '..', '..');
const pkg = require(path.join(APP_ROOT, 'package.json'));

// Self-update needs git and npm on PATH. Report what is actually available so
// a failed update can be diagnosed from the dashboard instead of guessed at.
function commandAvailable(cmd) {
  try {
    execSync(process.platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`, {
      stdio: 'ignore',
      timeout: 5000
    });
    return true;
  } catch {
    return false;
  }
}

const commandStatus = () => ({ git: commandAvailable('git'), npm: commandAvailable('npm') });

router.get('/admin/update', auth.requireAdmin, (req, res) => {
  res.json({
    current_version: pkg.version,
    node_version: process.version,
    schema_version: db.stats().schema_version,
    uptime_seconds: Math.round(process.uptime()),
    data_dir: config.dataDir,
    check_configured: Boolean(config.updateCheckUrl),
    command_configured: Boolean(config.updateCommand),
    check_url: config.updateCheckUrl || null,
    update_command: config.updateCommand || null,
    check_url_source: config.updateCheckUrlSource,
    update_command_source: config.updateCommandSource,
    commands: commandStatus(),
    auto_restart: process.env.pm_id !== undefined || process.env.NODE_APP_INSTANCE !== undefined,
    last_check: db.getSetting('update:last_check', null),
    last_run: db.getSetting('update:last_run', null),
    stats: db.stats()
  });
});

router.post('/admin/update/check', auth.requireAdmin, writeLimiter(), async (req, res) => {
  if (!config.updateCheckUrl) {
    return jsonError(res, 400, 'Update checks are not configured. Set UPDATE_CHECK_URL to a JSON endpoint returning { version, notes, url }.');
  }
  try {
    const response = await fetch(config.updateCheckUrl, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('update source returned HTTP ' + response.status);
    const info = await response.json();
    const latest = pickVersion(info);
    const result = {
      checked_at: db.now(),
      current_version: pkg.version,
      latest_version: latest || null,
      notes: String(info.notes || info.body || '').slice(0, 2000),
      url: String(info.url || info.html_url || '').slice(0, 500),
      update_available: Boolean(latest) && compareVersions(latest, pkg.version) > 0
    };
    await db.setSetting('update:last_check', result);
    res.json(result);
  } catch (err) {
    const failure = { checked_at: db.now(), current_version: pkg.version, error: String(err.message) };
    await db.setSetting('update:last_check', failure);
    jsonError(res, 502, 'Could not reach the update source: ' + err.message);
  }
});

router.post('/admin/update/run', auth.requireAdmin, async (req, res) => {
  if (!config.updateCommand) {
    return jsonError(res, 400, 'Self-update is not configured. Set UPDATE_COMMAND in .env to the command your deployment should run.');
  }
  if (req.body.confirm !== true) {
    return jsonError(res, 400, 'Send confirm: true to run the update command.');
  }
  log.info('admin started update', { admin: req.user.id });
  const result = await new Promise(resolve => {
    exec(config.updateCommand, {
      cwd: APP_ROOT,
      timeout: config.updateTimeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      env: process.env
    }, (err, stdout, stderr) => {
      resolve({
        ran_at: db.now(),
        ok: !err,
        exit_code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        signal: (err && err.signal) || null,
        stdout: String(stdout || '').slice(-8000),
        stderr: String(stderr || '').slice(-4000)
      });
    });
  });
  await db.setSetting('update:last_run', result);
  log.info('admin update finished', { ok: result.ok, exit_code: result.exit_code });
  if (!result.ok) return res.status(500).json({ error: 'Update command failed', run: result });

  // Restart only once the response is on the wire. Killing the process earlier
  // would lose the result the operator needs to see. Safe only when a process
  // manager is supervising us and will bring us back with the new code.
  const supervised = process.env.pm_id !== undefined || process.env.NODE_APP_INSTANCE !== undefined;
  if (supervised) {
    result.restarting = true;
    db.setSetting('update:last_run', result);
    setTimeout(() => {
      log.info('restarting to activate update');
      process.exit(0);
    }, 1500).unref?.();
  } else {
    result.restarting = false;
  }
  res.json({ run: result });
});

router.get('/admin/backup', auth.requireAdmin, (req, res) => {
  // The data file holds accounts, presentations, plans, songs and media
  // metadata. Uploaded files live alongside it in DATA_DIR/uploads.
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="swp-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.sendFile(db.file);
});

module.exports = router;
