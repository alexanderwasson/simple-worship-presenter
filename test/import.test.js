'use strict';
const test = require('node:test');
const assert = require('node:assert');
const AdmZip = require('adm-zip');
const { startServer, signIn } = require('./helpers');

// Builds a multipart/form-data body so the package endpoint can be exercised
// exactly as the browser sends it.
function multipart(filename, buffer, contentType = 'application/octet-stream') {
  const boundary = '----swptest' + Math.random().toString(16).slice(2);
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`, 'utf8');
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return {
    body: Buffer.concat([head, buffer, tail]),
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }
  };
}

function sampleManifest() {
  return {
    meta: { source: 'SSP Backup.test.sspbck', converter: 'sspbck2swp 1.0.0' },
    songs: [
      {
        title: 'Abide', artist: '', author: 'Dwell Songs',
        sections: [{ id: 's1', label: 'Verse 1', text: 'For my waking breath\nFor my daily bread' }]
      },
      {
        title: 'Amazing Grace', artist: '', author: 'John Newton',
        sections: [{ id: 's1', label: 'Verse 1', text: 'Amazing grace how sweet the sound' }]
      }
    ],
    presentations: [
      {
        title: 'Welcome to WUBC',
        slides: [
          { text: 'Welcome', name: 'Title' },
          { text: 'So glad you are here', name: 'Greeting' }
        ],
        bg: { kind: 'video', name: 'Ocean Sunset.mp4', fit: 'cover', speed: 1, overlay: 0.2 }
      },
      { title: 'JESUS IS THE ROCK', slides: [{ text: 'Jesus is the rock' }] }
    ],
    programs: [
      {
        title: 'Program - 2016-07-24',
        date: '2016-07-24',
        notes: 'Converted from SongShow Plus.',
        presentation_titles: ['Welcome to WUBC', 'JESUS IS THE ROCK']
      },
      {
        title: 'Program with a miss',
        date: '2016-07-25',
        notes: '',
        presentation_titles: ['Welcome to WUBC', 'A TITLE THAT WAS NEVER IMPORTED']
      }
    ],
    media: [
      { path: 'Imported/Leaves.mp4', file: 'Leaves.mp4', bytes: 2048, kind: 'video' },
      { path: 'Imported/Not Here.mp4', file: 'Not Here.mp4', bytes: 4096, kind: 'video' }
    ]
  };
}

test('a manifest imports songs, presentations and service plans', async () => {
  const server = await startServer();
  try {
    const { cookie } = await signIn(server);
    const payload = multipart('swp-import.json', Buffer.from(JSON.stringify(sampleManifest()), 'utf8'), 'application/json');
    const res = await server.api('/import/package', { method: 'POST', headers: payload.headers, body: payload.body }, cookie);

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(
      { songs: res.body.summary.songs, presentations: res.body.summary.presentations, programs: res.body.summary.programs },
      { songs: 2, presentations: 2, programs: 2 });

    // The library must actually contain them, not just claim it does.
    const songs = await server.api('/songs', {}, cookie);
    const decks = await server.api('/presentations', {}, cookie);
    const programs = await server.api('/programs', {}, cookie);
    assert.strictEqual(songs.body.songs.length, 2);
    assert.strictEqual(decks.body.presentations.length, 2);
    assert.strictEqual(programs.body.programs.length, 2);
  } finally {
    await server.stop();
  }
});

test('service plans link to the presentations that were imported', async () => {
  const server = await startServer();
  try {
    const { cookie } = await signIn(server);
    const payload = multipart('swp-import.json', Buffer.from(JSON.stringify(sampleManifest()), 'utf8'), 'application/json');
    await server.api('/import/package', { method: 'POST', headers: payload.headers, body: payload.body }, cookie);

    const decks = await server.api('/presentations', {}, cookie);
    const byTitle = new Map(decks.body.presentations.map(p => [p.title, p.id]));
    const programs = await server.api('/programs', {}, cookie);

    const linked = programs.body.programs.find(p => p.title === 'Program - 2016-07-24');
    assert.strictEqual(linked.presentation_ids.length, 2);
    assert.ok(linked.presentation_ids.includes(byTitle.get('Welcome to WUBC')));
    assert.ok(linked.presentation_ids.includes(byTitle.get('JESUS IS THE ROCK')));

    // Every link must resolve to a real presentation.
    for (const plan of programs.body.programs) {
      for (const id of plan.presentation_ids) {
        assert.ok(byTitle.has([...byTitle.entries()].find(([, v]) => v === id)?.[0]), 'link resolves to an imported presentation');
      }
    }
  } finally {
    await server.stop();
  }
});

test('an unmatched service plan title is reported instead of silently dropped', async () => {
  const server = await startServer();
  try {
    const { cookie } = await signIn(server);
    const payload = multipart('swp-import.json', Buffer.from(JSON.stringify(sampleManifest()), 'utf8'), 'application/json');
    const res = await server.api('/import/package', { method: 'POST', headers: payload.headers, body: payload.body }, cookie);

    assert.ok(Array.isArray(res.body.summary.warnings));
    assert.ok(
      res.body.summary.warnings.some(w => /A TITLE THAT WAS NEVER IMPORTED/.test(w)),
      'expected a warning naming the unmatched title, got: ' + JSON.stringify(res.body.summary.warnings));

    // The plan is still created; only the broken link is omitted.
    const programs = await server.api('/programs', {}, cookie);
    const plan = programs.body.programs.find(p => p.title === 'Program with a miss');
    assert.strictEqual(plan.presentation_ids.length, 1);
  } finally {
    await server.stop();
  }
});

test('media that is not bundled is reported and never fails the import', async () => {
  const server = await startServer();
  try {
    const { cookie } = await signIn(server);
    const payload = multipart('swp-import.json', Buffer.from(JSON.stringify(sampleManifest()), 'utf8'), 'application/json');
    const res = await server.api('/import/package', { method: 'POST', headers: payload.headers, body: payload.body }, cookie);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.summary.media, 0);
    const names = res.body.summary.skipped.map(s => s.name);
    assert.ok(names.includes('Imported/Leaves.mp4'));
    assert.ok(names.includes('Imported/Not Here.mp4'));
  } finally {
    await server.stop();
  }
});

test('a zip package imports its manifest and extracts bundled media', async () => {
  const server = await startServer();
  try {
    const { cookie } = await signIn(server);
    const manifest = sampleManifest();
    const zip = new AdmZip();
    zip.addFile('swp-import.json', Buffer.from(JSON.stringify(manifest), 'utf8'));
    // A tiny but real payload: enough to prove bytes land and a media record is made.
    zip.addFile('media/Imported/Leaves.mp4', Buffer.alloc(2048, 7));
    const payload = multipart('backup.zip', zip.toBuffer(), 'application/zip');

    const res = await server.api('/import/package', { method: 'POST', headers: payload.headers, body: payload.body }, cookie);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.summary.media, 1, 'bundled media should be imported');
    assert.strictEqual(res.body.summary.presentations, 2);
  } finally {
    await server.stop();
  }
});

test('a package with no songs, presentations or plans is rejected', async () => {
  const server = await startServer();
  try {
    const { cookie } = await signIn(server);
    const payload = multipart('swp-import.json', Buffer.from(JSON.stringify({ media: [] }), 'utf8'), 'application/json');
    const res = await server.api('/import/package', { method: 'POST', headers: payload.headers, body: payload.body }, cookie);
    assert.ok(res.status >= 400, 'should not accept an empty package');
  } finally {
    await server.stop();
  }
});

test('a non-package file is rejected', async () => {
  const server = await startServer();
  try {
    const { cookie } = await signIn(server);
    const payload = multipart('notes.txt', Buffer.from('just some text', 'utf8'), 'text/plain');
    const res = await server.api('/import/package', { method: 'POST', headers: payload.headers, body: payload.body }, cookie);
    assert.ok(res.status >= 400, 'should reject a file that is neither a manifest nor a zip');
  } finally {
    await server.stop();
  }
});

test('the import endpoint requires a signed-in user', async () => {
  const server = await startServer();
  try {
    const payload = multipart('swp-import.json', Buffer.from(JSON.stringify(sampleManifest()), 'utf8'), 'application/json');
    const res = await server.api('/import/package', { method: 'POST', headers: payload.headers, body: payload.body });
    assert.strictEqual(res.status, 401);
  } finally {
    await server.stop();
  }
});
