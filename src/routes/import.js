'use strict';
/*
 * Portable package import.
 *
 * Accepts a ZIP containing a `swp-import.json` manifest and, optionally, a
 * `media/` folder. Converts songs, presentations and service plans into the
 * application's own records and copies any bundled media into the account's
 * library, counting it against the storage quota.
 *
 * The manifest format is documented in the export module and is versioned so
 * older and newer packages can be detected rather than silently mangled.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const config = require('../config');
const db = require('../db');
const log = require('../log');
const auth = require('../auth');
const { limiter } = require('../rateLimit');

const router = express.Router();
const UPLOAD_DIR = path.join(config.dataDir, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// A package can carry a whole church's media library, so this endpoint allows a// much larger payload than an ordinary upload. Individual files are still checked
// against the account quota during import.
const PACKAGE_MAX_BYTES = Number(process.env.IMPORT_MAX_BYTES || 2147483648);
const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: PACKAGE_MAX_BYTES } });

function jsonError(res, status, message, extra) {
  return res.status(status).json({ error: message, ...(extra || {}) });
}

function safeName(name) {
  return String(name || 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 120);
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
      if (s.style && typeof s.style === 'object') out.style = s.style;
      if (s.video && typeof s.video === 'object') out.video = s.video;
      return out;
    }
    return '';
  });
}

// Reads a manifest that may come from our own exporter or from a converter of
// another product. Unknown fields are ignored; missing fields are defaulted.
function readManifest(raw) {
  let parsed;
  try {
    parsed = JSON.parse(String(raw).replace(/^\uFEFF/, ''));
  } catch {
    return { error: 'The manifest is not valid JSON.' };
  }
  if (!parsed || typeof parsed !== 'object') return { error: 'The manifest is empty.' };

  const songs = Array.isArray(parsed.songs) ? parsed.songs : [];
  const presentations = Array.isArray(parsed.presentations) ? parsed.presentations : [];
  const programs = Array.isArray(parsed.programs) ? parsed.programs : [];
  const media = Array.isArray(parsed.media) ? parsed.media : [];

  if (!songs.length && !presentations.length && !programs.length) {
    return { error: 'This package contains no songs, presentations or service plans.' };
  }
  return {
    format: parsed.meta && parsed.meta.format ? String(parsed.meta.meta || parsed.meta.format) : 'swp-import',
    meta: parsed.meta || {},
    songs,
    presentations,
    programs,
    media
  };
}

// A package may reference media it cannot legally bundle. Report those instead
// of pretending the import is complete.
function mediaPath(record) {
  // Converters have used `path`, `file` and `name` for the same idea; the path
  // is the one that matches the layout inside a package.
  return String(record.path || record.file || record.name || '').replace(/\\/g, '/');
}

function missingMedia(manifest, entries) {
  const present = new Set(entries.map(e => e.replace(/\\/g, '/').toLowerCase()));
  return (manifest.media || [])
    .map(mediaPath)
    .filter(Boolean)
    .filter(p => !present.has(p.toLowerCase()) && !present.has(path.basename(p).toLowerCase()));
}

router.post('/import/package', auth.requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return jsonError(res, 400, 'No package file uploaded');
  const cleanup = () => { try { fs.unlinkSync(req.file.path); } catch { } };

  let manifestEntry = null;
  let entries = [];
  let zip = null;

  // The site sends either a converted manifest directly, or a ZIP that bundles
  // the manifest together with a media folder. Both are supported.
  const looksLikeZip = /\.(zip|ssbpck|swp)$/i.test(req.file.originalname || '') ||
    fs.readFileSync(req.file.path).subarray(0, 2).toString('latin1') === 'PK';

  if (looksLikeZip) {
    try {
      zip = new AdmZip(req.file.path);
    } catch {
      cleanup();
      return jsonError(res, 415, 'That file is not a readable ZIP package.');
    }
    entries = zip.getEntries().filter(e => !e.isDirectory);
    manifestEntry = entries.find(e => /(^|\/)swp-import\.json$/i.test(e.entryName));
    if (!manifestEntry) {
      cleanup();
      return jsonError(res, 415, 'The package has no swp-import.json manifest.');
    }
  } else {
    // Plain JSON manifest.
    manifestEntry = { getData: () => fs.readFileSync(req.file.path) };
    entries = [];
  }

  const manifest = readManifest(manifestEntry.getData().toString('utf8'));
  if (manifest.error) {
    cleanup();
    return jsonError(res, 415, manifest.error);
  }

  // Guard against archives that try to write outside the upload directory.
  for (const entry of entries) {
    const name = entry.entryName.replace(/\\/g, '/');
    if (name.includes('..') || path.isAbsolute(name)) {
      cleanup();
      return jsonError(res, 400, 'The package contains an unsafe file path.');
    }
  }

  const summary = {
    songs: 0,
    presentations: 0,
    programs: 0,
    media: 0,
    skipped: [],
    warnings: [],
    missing_media: missingMedia(manifest, entries.map(e => e.entryName))
  };

  // Media first so slides can reference it.
  const mediaIndex = new Map();
  for (const record of (manifest.media || [])) {
    const wanted = mediaPath(record);
    const entry = entries.find(e => e.entryName.replace(/\\/g, '/').toLowerCase() === wanted.toLowerCase())
      || entries.find(e => path.basename(e.entryName).toLowerCase() === path.basename(wanted).toLowerCase());
    if (!entry) {
      summary.skipped.push({ kind: 'media', name: wanted, reason: 'not bundled in the package' });
      continue;
    }
    const bytes = entry.header.size;
    if (req.user.used_bytes + bytes > req.user.quota_bytes) {
      summary.skipped.push({ kind: 'media', name: wanted, reason: 'storage quota exceeded' });
      continue;
    }
    const stored = crypto.randomUUID();
    const target = path.join(UPLOAD_DIR, stored);
    try {
      fs.writeFileSync(target, entry.getData());
    } catch (err) {
      summary.skipped.push({ kind: 'media', name: wanted, reason: 'could not be written: ' + err.message });
      continue;
    }
    const row = {
      id: db.newId(),
      user_id: req.user.id,
      original_name: safeName(path.basename(wanted)),
      stored_name: stored,
      mime: 'application/octet-stream',
      kind: record.kind === 'video' || record.kind === 'audio' ? record.kind : 'image',
      size: bytes,
      created_at: db.now()
    };
    await db.insert('media', row);
    mediaIndex.set(wanted.toLowerCase(), row);
    mediaIndex.set(path.basename(wanted).toLowerCase(), row);
    summary.media += 1;
  }

  // Songs.
  for (const raw of manifest.songs) {
    const title = String(raw.title || '').trim();
    if (!title) { summary.skipped.push({ kind: 'song', name: '(untitled)', reason: 'no title' }); continue; }
    const row = {
      id: db.newId(),
      user_id: req.user.id,
      title: title.slice(0, 200),
      artist: String(raw.artist || '').slice(0, 200),
      author: String(raw.author || '').slice(0, 200),
      copyright: String(raw.copyright || '').slice(0, 300),
      ccli: String(raw.ccli || '').slice(0, 60),
      tags: Array.isArray(raw.tags) ? raw.tags.slice(0, 30).map(t => String(t).slice(0, 40)) : [],
      theme: raw.theme && typeof raw.theme === 'object' ? raw.theme : {},
      sections: Array.isArray(raw.sections) ? raw.sections.slice(0, 100).map((s, i) => ({
        id: String(s.id || 'sec-' + i),
        label: String(s.label || `Section ${i + 1}`).slice(0, 60),
        text: String(s.text || '').slice(0, 4000)
      })) : [],
      created_at: db.now(),
      updated_at: db.now()
    };
    await db.insert('songs', row);
    summary.songs += 1;
  }

  // Presentations. Slides keep text and structure; bundled media resolves by name.
  const presentationIds = new Map();
  for (const raw of manifest.presentations) {
    const title = String(raw.title || 'Untitled presentation').trim().slice(0, 200);
    const slides = normaliseSlides(raw.slides).map(s => {
      if (s.video && s.video.name && mediaIndex.has(String(s.video.name).toLowerCase())) {
        const m = mediaIndex.get(String(s.video.name).toLowerCase());
        s.video = { ...s.video, id: m.id, url: '/api/media/' + m.id + '/file' };
      }
      return s;
    });
    const row = {
      id: db.newId(),
      user_id: req.user.id,
      title,
      slides_json: JSON.stringify(slides),
      bg_json: JSON.stringify(raw.bg && typeof raw.bg === 'object' ? raw.bg : null),
      created_at: db.now(),
      updated_at: db.now()
    };
    await db.insert('presentations', row);
    presentationIds.set(title.toLowerCase(), row.id);
    summary.presentations += 1;
  }

  // Service plans. Titles are matched because converters often cannot resolve
  // stable ids across products; anything unmatched is reported.
  for (const raw of manifest.programs) {
    const ids = [];
    for (const ref of Array.isArray(raw.presentation_ids) ? raw.presentation_ids : []) {
      if (presentationIds.has(String(ref).toLowerCase())) ids.push(presentationIds.get(String(ref).toLowerCase()));
    }
    for (const title of Array.isArray(raw.presentation_titles) ? raw.presentation_titles : []) {
      const id = presentationIds.get(String(title).toLowerCase());
      if (id) ids.push(id);
      else summary.warnings.push(`"${String(title)}" in "${raw.title}" did not match an imported presentation.`);
    }
    const row = {
      id: db.newId(),
      user_id: req.user.id,
      title: String(raw.title || 'Untitled program').slice(0, 200),
      date: String(raw.date || db.now().slice(0, 10)).slice(0, 20),
      notes: String(raw.notes || '').slice(0, 2000),
      presentation_ids: [...new Set(ids)].slice(0, 200),
      created_at: db.now()
    };
    await db.insert('programs', row);
    summary.programs += 1;
  }

  await db.recomputeUsage(req.user.id);
  cleanup();
  log.info('package imported', { user: req.user.id, ...summary });
  res.json({ ok: true, summary, meta: manifest.meta });
});

module.exports = router;
