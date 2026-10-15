'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { startServer, signIn } = require('./helpers');

test('song library', async t => {
  const server = await startServer();
  t.after(() => server.stop());
  const { cookie } = await signIn(server);

  const song = {
    title: 'Test Song',
    artist: 'Test Artist',
    author: 'Test Author',
    copyright: '© 2026 Test',
    ccli: '1234567',
    tags: ['hymn'],
    sections: [
      { id: 'v1', label: 'Verse 1', text: 'line one\nline two\nline three\nline four\nline five' },
      { id: 'c1', label: 'Chorus', text: 'chorus one\nchorus two' }
    ]
  };

  let songId;
  await t.test('create', async () => {
    const res = await server.api('/songs', { method: 'POST', body: song }, cookie);
    assert.equal(res.status, 201);
    assert.equal(res.body.song.sections.length, 2);
    songId = res.body.song.id;
  });

  await t.test('edit', async () => {
    const res = await server.api('/songs/' + songId, { method: 'PUT', body: { ...song, title: 'Renamed Song' } }, cookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.song.title, 'Renamed Song');
  });

  await t.test('title is required', async () => {
    const res = await server.api('/songs', { method: 'POST', body: { title: '' } }, cookie);
    assert.equal(res.status, 400);
  });

  await t.test('generate slides respects the line count and keeps section labels', async () => {
    const res = await server.api('/songs/' + songId + '/generate', { method: 'POST', body: { lines_per_slide: 2 } }, cookie);
    assert.equal(res.status, 200);
    // Verse 1 has 5 lines -> 3 slides; Chorus has 2 lines -> 1 slide.
    assert.equal(res.body.slides.length, 4);
    assert.match(res.body.slides[0].text, /Verse 1/);
    assert.equal(res.body.slides[0].section, 'Verse 1');
  });

  await t.test('sections can be repeated through a custom order', async () => {
    const res = await server.api('/songs/' + songId + '/generate', {
      method: 'POST',
      body: { lines_per_slide: 4, order: ['v1', 'c1', 'v1', 'c1'] }
    }, cookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.slides.length, 6);
  });

  await t.test('deleting a song does not remove presentations built from it', async () => {
    const gen = await server.api('/songs/' + songId + '/generate', { method: 'POST', body: { lines_per_slide: 4 } }, cookie);
    const pres = await server.api('/presentations', { method: 'POST', body: { title: gen.body.title, slides: gen.body.slides } }, cookie);
    assert.equal(pres.status, 201);

    const del = await server.api('/songs/' + songId, { method: 'DELETE' }, cookie);
    assert.equal(del.status, 204);

    const list = await server.api('/presentations', {}, cookie);
    assert.equal(list.body.presentations.length, 1);
    assert.ok(list.body.presentations[0].slides.length > 0);
  });

  await t.test('another account cannot edit my song', async () => {
    const created = await server.api('/songs', { method: 'POST', body: song }, cookie);
    const other = await signIn(server, { email: 'other@example.com' });
    const res = await server.api('/songs/' + created.body.song.id, { method: 'PUT', body: { title: 'stolen' } }, other.cookie);
    assert.equal(res.status, 404);
  });
});

test('presentations and service plans', async t => {
  const server = await startServer();
  t.after(() => server.stop());
  const { cookie } = await signIn(server);

  await t.test('create and edit a presentation', async () => {
    const created = await server.api('/presentations', { method: 'POST', body: { title: 'Sunday', slides: ['one', 'two'] } }, cookie);
    assert.equal(created.status, 201);
    assert.equal(created.body.slides.length, 2);

    const updated = await server.api('/presentations/' + created.body.id, { method: 'PUT', body: { title: 'Sunday service', slides: ['one', 'two', 'three'] } }, cookie);
    assert.equal(updated.status, 200);

    const list = await server.api('/presentations', {}, cookie);
    assert.equal(list.body.presentations[0].title, 'Sunday service');
    assert.equal(list.body.presentations[0].slides.length, 3);
  });

  await t.test('slides keep rich objects such as backgrounds and images', async () => {
    const created = await server.api('/presentations', {
      method: 'POST',
      body: {
        title: 'Rich',
        slides: [{
          text: 'hello',
          background: 'url(x)',
          footer: { text: 'Small print', style: { size: 12, color: '#eeeeee' } }
        }, 'plain']
      }
    }, cookie);
    const list = await server.api('/presentations', {}, cookie);
    const found = list.body.presentations.find(p => p.id === created.body.id);
    assert.equal(typeof found.slides[0], 'object');
    assert.equal(found.slides[0].background, 'url(x)');
    assert.deepEqual(found.slides[0].footer, { text: 'Small print', style: { size: 12, color: '#eeeeee' } });
    assert.equal(found.slides[1], 'plain');
  });

  await t.test('duplicate copies slides into a new presentation', async () => {
    const created = await server.api('/presentations', { method: 'POST', body: { title: 'Dup', slides: ['a'] } }, cookie);
    const copy = await server.api('/presentations/' + created.body.id + '/duplicate', { method: 'POST' }, cookie);
    assert.equal(copy.status, 201);
    assert.equal(copy.body.title, 'Dup copy');
    assert.deepEqual(copy.body.slides, ['a']);
  });

  await t.test('service plans hold presentation ids and can be duplicated', async () => {
    const pres = await server.api('/presentations', { method: 'POST', body: { title: 'Item', slides: ['a'] } }, cookie);
    const plan = await server.api('/programs', { method: 'POST', body: { title: 'Sunday', date: '2026-10-11', presentation_ids: [pres.body.id] } }, cookie);
    assert.equal(plan.status, 201);
    assert.equal(plan.body.program.presentation_ids.length, 1);

    const copy = await server.api('/programs/' + plan.body.program.id + '/duplicate', { method: 'POST' }, cookie);
    assert.equal(copy.status, 201);
    assert.equal(copy.body.program.presentation_ids.length, 1);

    // Deleting the plan keeps the presentation.
    await server.api('/programs/' + plan.body.program.id, { method: 'DELETE' }, cookie);
    const list = await server.api('/presentations', {}, cookie);
    assert.equal(list.body.presentations.length >= 1, true);
  });

  await t.test('stored slide text is returned verbatim, not executed', async () => {
    const payload = '<img src=x onerror="alert(1)">';
    const created = await server.api('/presentations', { method: 'POST', body: { title: 'XSS probe', slides: [payload] } }, cookie);
    assert.equal(created.body.slides[0], payload);
  });
});

test('slide animations and animated backgrounds survive a save and reload', async t => {
  const server = await startServer();
  t.after(() => server.stop());
  const { cookie } = await signIn(server);

  const slides = [
    {
      text: 'Amazing grace', name: 'Verse 1',
      style: { animation: 'words', font: 'Manrope', weight: 700, color: '#ffffff', align: 'center', valign: 'center', size: 42, lineHeight: 1.12 },
      video: { id: 'vid-1', name: 'Leaves.mp4', url: '/api/media/vid-1/file', fit: 'cover', speed: 0.5, overlay: 0.3 }
    },
    {
      text: 'How sweet the sound', name: 'Verse 2',
      style: { animation: 'rise', font: 'Oswald', weight: 400, color: '#111111', align: 'left', valign: 'top', size: 30 }
    }
  ];
  const bg = { kind: 'video', name: 'Ocean Sunset.mp4', url: '/api/media/bg-1/file', fit: 'cover', speed: 1, overlay: 0.2 };

  const created = await server.api('/presentations', {
    method: 'POST', body: { title: 'Animated', slides, bg }
  }, cookie);
  assert.equal(created.status, 201);

  // Read it back from the library, exactly as the editor does after a reload.
  const list = await server.api('/presentations', {}, cookie);
  const deck = list.body.presentations.find(p => p.id === created.body.id);
  assert.ok(deck, 'presentation is in the library');

  assert.equal(deck.slides[0].style.animation, 'words');
  assert.equal(deck.slides[0].style.valign, 'center');
  assert.deepEqual(deck.slides[0].video, slides[0].video);
  assert.equal(deck.slides[1].style.animation, 'rise');
  assert.deepEqual(deck.bg, bg);

  // An edit must not drop what it does not touch.
  const edited = await server.api('/presentations/' + deck.id, {
    method: 'PUT', body: { slides: deck.slides.map((s, i) => (i === 0 ? { ...s, text: 'Amazing grace!' } : s)) }
  }, cookie);
  assert.equal(edited.status, 200);
  assert.equal(edited.body.slides[0].style.animation, 'words');
  assert.deepEqual(edited.body.slides[0].video, slides[0].video);
  assert.deepEqual(edited.body.bg, bg);

  // And a fresh read of the library agrees.
  const reread = await server.api('/presentations', {}, cookie);
  const afterReload = reread.body.presentations.find(p => p.id === deck.id);
  assert.equal(afterReload.slides[0].style.animation, 'words');
  assert.deepEqual(afterReload.slides[0].video, slides[0].video);
  assert.deepEqual(afterReload.bg, bg);
});
