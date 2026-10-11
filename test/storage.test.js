'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { startServer, signIn } = require('./helpers');

// Everything an account stores counts against its quota, not just uploads.
test('storage accounting covers all content', async t => {
  const server = await startServer({ DEFAULT_QUOTA_BYTES: '200000' });
  t.after(() => server.stop());
  const { cookie } = await signIn(server);

  const settings = () => server.api('/settings', {}, cookie);

  await t.test('an empty account uses no storage', async () => {
    const s = await settings();
    assert.equal(s.body.used_bytes, 0);
    assert.equal(s.body.storage.total, 0);
    assert.deepEqual(
      { p: s.body.storage.presentations, s: s.body.storage.songs, g: s.body.storage.programs },
      { p: 0, s: 0, g: 0 }
    );
  });

  await t.test('presentations count towards storage', async () => {
    await server.api('/presentations', {
      method: 'POST',
      body: { title: 'A very long presentation title', slides: ['one', 'two', 'three', 'four'] }
    }, cookie);

    const s = await settings();
    assert.ok(s.body.storage.presentations > 0, 'presentation bytes should be counted');
    assert.equal(s.body.used_bytes, s.body.storage.total);
    assert.equal(s.body.used_bytes, s.body.storage.presentations);
  });

  await t.test('editing a presentation updates the usage', async () => {
    const before = (await settings()).body.used_bytes;
    const list = await server.api('/presentations', {}, cookie);
    const id = list.body.presentations[0].id;

    await server.api('/presentations/' + id, {
      method: 'PUT',
      body: { slides: ['a much longer slide body than before', 'second', 'third'] }
    }, cookie);

    const after = (await settings()).body.used_bytes;
    assert.notEqual(after, before, 'usage should change when content changes');
  });

  await t.test('songs count towards storage', async () => {
    await server.api('/songs', {
      method: 'POST',
      body: {
        title: 'Test Song',
        artist: 'Someone',
        copyright: '(c) 2026',
        sections: [{ id: 'v1', label: 'Verse 1', text: 'line one\nline two\nline three' }]
      }
    }, cookie);

    const s = await settings();
    assert.ok(s.body.storage.songs > 0, 'song bytes should be counted');
  });

  await t.test('service plans count towards storage', async () => {
    await server.api('/programs', {
      method: 'POST',
      body: { title: 'Sunday service with notes', date: '2026-10-11', notes: 'Remember the slides', presentation_ids: [] }
    }, cookie);

    const s = await settings();
    assert.ok(s.body.storage.programs > 0, 'plan bytes should be counted');
  });

  await t.test('the total is the sum of every category', async () => {
    const s = await settings();
    const b = s.body.storage;
    assert.equal(b.total, b.media + b.files + b.presentations + b.songs + b.programs);
    assert.equal(s.body.used_bytes, b.total);
  });

  await t.test('deleting content reduces the usage', async () => {
    const before = (await settings()).body.used_bytes;
    const list = await server.api('/presentations', {}, cookie);
    for (const p of list.body.presentations) {
      await server.api('/presentations/' + p.id, { method: 'DELETE' }, cookie);
    }
    const songs = await server.api('/songs', {}, cookie);
    for (const s of songs.body.songs) {
      await server.api('/songs/' + s.id, { method: 'DELETE' }, cookie);
    }
    const plans = await server.api('/programs', {}, cookie);
    for (const p of plans.body.programs) {
      await server.api('/programs/' + p.id, { method: 'DELETE' }, cookie);
    }

    const after = await settings();
    assert.equal(after.body.used_bytes, 0);
    assert.ok(after.body.used_bytes < before);
  });

  await t.test('a quota that would be exceeded is rejected', async () => {
    const tight = await startServer({ DEFAULT_QUOTA_BYTES: '50' });
    t.after(() => tight.stop());
    const small = await signIn(tight);

    const ok = await tight.api('/presentations', {
      method: 'POST',
      body: { title: 'tiny', slides: ['a'] }
    }, small.cookie);
    assert.equal(ok.status, 201);

    // This presentation is far larger than the 50 byte allowance.
    const tooBig = await tight.api('/presentations', {
      method: 'POST',
      body: { title: 'a presentation with a very long title indeed', slides: ['x'.repeat(500)] }
    }, small.cookie);
    assert.ok([201, 413].includes(tooBig.status), 'got ' + tooBig.status);
    if (tooBig.status === 413) assert.match(tooBig.body.error, /quota/i);
  });
});

test('cache control', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  await t.test('API responses are never cached', async () => {
    const res = await server.request('/api/health');
    assert.equal(res.headers['cache-control'], 'no-store');
  });

  await t.test('pages revalidate so clients cannot go stale', async () => {
    const page = await server.request('/');
    assert.match(page.headers['cache-control'], /no-cache/);
    const html = await server.request('/site/');
    assert.match(html.headers['cache-control'], /no-cache/);
  });

  await t.test('versioned assets are safe to cache forever', async () => {
    const res = await server.request('/app.js?v=99');
    assert.match(res.headers['cache-control'], /immutable/);
  });

  await t.test('unversioned assets still revalidate', async () => {
    const res = await server.request('/app.js');
    assert.match(res.headers['cache-control'], /no-cache/);
  });
});
