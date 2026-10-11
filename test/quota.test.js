'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { startServer, signIn } = require('./helpers');

test('storage quotas', async t => {
  const server = await startServer({ DEFAULT_QUOTA_BYTES: '2048', MAX_UPLOAD_BYTES: '4096' });
  t.after(() => server.stop());

  // A minimal valid PNG header so the content sniffer accepts the upload.
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(400, 1)]);
  const { cookie, user } = await signIn(server);

  const multipart = (filename, content) => {
    const boundary = '----swptest' + Math.random().toString(16).slice(2);
    const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const tail = `\r\n--${boundary}--\r\n`;
    return {
      body: Buffer.concat([Buffer.from(head), content, Buffer.from(tail)]),
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary }
    };
  };

  await t.test('new accounts receive the configured quota', async () => {
    assert.equal(user.quota_bytes, 2048);
    assert.equal(user.used_bytes, 0);
  });

  await t.test('an upload within quota succeeds and is accounted', async () => {
    const form = multipart('ok.png', png);
    const res = await server.api('/media', { method: 'POST', headers: form.headers, body: form.body }, cookie);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.media.size, png.length);
    assert.equal(res.body.media.mime, 'image/png');

    const settings = await server.api('/settings', {}, cookie);
    assert.equal(settings.body.used_bytes, png.length);
  });

  await t.test('uploads over quota are rejected and not accounted', async () => {
    const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2000, 2)]);
    const form = multipart('too-big.png', big);
    const res = await server.api('/media', { method: 'POST', headers: form.headers, body: form.body }, cookie);
    assert.equal(res.status, 413);
    assert.match(res.body.error, /quota/i);

    const settings = await server.api('/settings', {}, cookie);
    assert.equal(settings.body.used_bytes, png.length);
  });

  await t.test('unsupported content is rejected regardless of extension', async () => {
    const fake = Buffer.from('MZ this is definitely not an image');
    const form = multipart('not-an-image.png', fake);
    const res = await server.api('/media', { method: 'POST', headers: form.headers, body: form.body }, cookie);
    assert.equal(res.status, 415);
    assert.match(res.body.error, /unsupported/i);
  });

  await t.test('deleting media releases the storage', async () => {
    const list = await server.api('/media', {}, cookie);
    const id = list.body.media[0].id;
    const del = await server.api('/media/' + id, { method: 'DELETE' }, cookie);
    assert.equal(del.status, 204);

    const settings = await server.api('/settings', {}, cookie);
    assert.equal(settings.body.used_bytes, 0);
    assert.equal(settings.body.quota_bytes, 2048);
  });

  await t.test('other accounts cannot read or delete my media', async () => {
    const form = multipart('mine.png', png);
    const uploaded = await server.api('/media', { method: 'POST', headers: form.headers, body: form.body }, cookie);
    const other = await signIn(server, { email: 'other@example.com' });

    const read = await server.api('/media/' + uploaded.body.media.id + '/file', {}, other.cookie);
    assert.equal(read.status, 404);

    const del = await server.api('/media/' + uploaded.body.media.id, { method: 'DELETE' }, other.cookie);
    assert.equal(del.status, 404);
  });
});

test('upload size limits return a clear error', async t => {
  const server = await startServer({ DEFAULT_QUOTA_BYTES: '10485760', MAX_UPLOAD_BYTES: '1024' });
  t.after(() => server.stop());
  const { cookie } = await signIn(server);

  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4000, 1)]);
  const boundary = '----swptestbig';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.png"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    png,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  const res = await server.api('/media', {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
    body
  }, cookie);
  assert.equal(res.status, 413);
  assert.match(res.body.error, /too large|maximum/i);
});
