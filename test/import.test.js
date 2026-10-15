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

// A tiny valid 1x1 PNG used as an embedded image in .pptx fixtures.
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

// Builds a minimal .pptx package from a list of slide descriptors.
// Each descriptor can contain: text (string), backgroundColor (hex), backgroundImage (boolean),
// bulletItems (array of strings), bold, italic, fontSize (number), color (hex).
function buildPptx({ title = 'Test Presentation', slides = [] } = {}) {
  const zip = new AdmZip();
  const slideTypes = slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('');
  zip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  ${slideTypes}
</Types>`, 'utf8'));

  zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`, 'utf8'));

  zip.addFile('docProps/core.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title></cp:coreProperties>`, 'utf8'));

  const slideIds = slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('');
  zip.addFile('ppt/presentation.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldSz cx="9144000" cy="6858000" type="screen4x3"/>
  <p:sldIdLst>${slideIds}</p:sldIdLst>
</p:presentation>`, 'utf8'));

  const presRels = slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('');
  zip.addFile('ppt/_rels/presentation.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${presRels}</Relationships>`, 'utf8'));

  slides.forEach((slide, i) => {
    const idx = i + 1;
    let bgXml = '';
    let slideRels = '';
    if (slide.backgroundColor) {
      bgXml = `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${slide.backgroundColor.replace(/^#/, '')}"/></a:solidFill></p:bgPr></p:bg>`;
    } else if (slide.backgroundImage) {
      zip.addFile(`ppt/media/image${idx}.png`, TINY_PNG);
      bgXml = `<p:bg><p:bgPr><a:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></a:blipFill></p:bgPr></p:bg>`;
      slideRels = `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${idx}.png"/>`;
    }

    const textShape = buildTextShape(slide);
    zip.addFile(`ppt/slides/slide${idx}.xml`, Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld>${bgXml}<p:spTree>${textShape}</p:spTree></p:cSld>
</p:sld>`, 'utf8'));

    if (slide.backgroundImage && slide.unsupported) {
      slideRels += `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/chart${idx}.png"/>`;
    }
    zip.addFile(`ppt/slides/_rels/slide${idx}.xml.rels`, Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slideRels}</Relationships>`, 'utf8'));
  });

  return zip.toBuffer();
}

function buildTextShape(slide) {
  const paragraphs = [];
  if (slide.bulletItems && slide.bulletItems.length) {
    for (const item of slide.bulletItems) {
      paragraphs.push(`<a:p><a:pPr><a:buChar char="•"/></a:pPr><a:r>${runProps(slide)}<a:t>${escXml(item)}</a:t></a:r></a:p>`);
    }
  } else {
    const lines = String(slide.text || '').split('\n');
    for (const line of lines) {
      paragraphs.push(`<a:p><a:r>${runProps(slide)}<a:t>${escXml(line)}</a:t></a:r></a:p>`);
    }
  }
  return `<p:sp><p:nvSpPr><p:cNvPr name="TextShape"/></p:nvSpPr><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs.join('')}</p:txBody></p:sp>`;
}

function runProps(slide) {
  const attrs = [];
  if (slide.bold) attrs.push('b="1"');
  if (slide.italic) attrs.push('i="1"');
  if (slide.fontSize) attrs.push(`sz="${Math.round(slide.fontSize * 100)}"`);
  let fill = '';
  if (slide.color) fill = `<a:solidFill><a:srgbClr val="${slide.color.replace(/^#/, '')}"/></a:solidFill>`;
  if (!attrs.length && !fill) return '';
  return `<a:rPr ${attrs.join(' ')}>${fill}</a:rPr>`;
}

function escXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

// ---- PowerPoint (.pptx) import ------------------------------------------------

test('a .pptx with text slides imports as a presentation', async () => {
  const server = await startServer();
  try {
    const { cookie } = await signIn(server);
    const buffer = buildPptx({
      title: 'Text Deck',
      slides: [
        { text: 'Slide one' },
        { text: 'Slide two\nWith a second line' }
      ]
    });
    const payload = multipart('slides.pptx', buffer, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    const res = await server.api('/import/pptx', { method: 'POST', headers: payload.headers, body: payload.body }, cookie);

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.summary.presentations, 1);
    assert.strictEqual(res.body.summary.media, 0);
    assert.strictEqual(res.body.presentation.title, 'Text Deck');
    assert.strictEqual(res.body.presentation.slides.length, 2);
    assert.ok(res.body.presentation.slides[0].text.includes('Slide one'));
    assert.ok(res.body.presentation.slides[1].text.includes('Slide two'));
  } finally {
    await server.stop();
  }
});

test('a .pptx preserves formatting, bullets and background colour', async () => {
  const server = await startServer();
  try {
    const { cookie } = await signIn(server);
    const buffer = buildPptx({
      title: 'Styled Deck',
      slides: [
        { text: 'Title', bold: true, fontSize: 48, color: 'FF0000', backgroundColor: '#0000FF' },
        { bulletItems: ['Alpha', 'Bravo'] }
      ]
    });
    const payload = multipart('styled.pptx', buffer, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    const res = await server.api('/import/pptx', { method: 'POST', headers: payload.headers, body: payload.body }, cookie);

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const slides = res.body.presentation.slides;
    assert.strictEqual(slides[0].style.weight, 700);
    assert.strictEqual(slides[0].style.size, 48);
    assert.strictEqual(slides[0].style.color, '#FF0000');
    assert.strictEqual(slides[0].background, '#0000FF');
    assert.ok(slides[1].text.includes('• Alpha'));
    assert.ok(slides[1].text.includes('• Bravo'));
  } finally {
    await server.stop();
  }
});

test('a .pptx extracts and links embedded background images', async () => {
  const server = await startServer();
  try {
    const { cookie } = await signIn(server);
    const buffer = buildPptx({
      title: 'Image Deck',
      slides: [{ text: 'With background', backgroundImage: true }]
    });
    const payload = multipart('image.pptx', buffer, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    const res = await server.api('/import/pptx', { method: 'POST', headers: payload.headers, body: payload.body }, cookie);

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.summary.media, 1);
    assert.ok(res.body.presentation.slides[0].background.includes('/api/media/'));

    // The media record must exist and the file must be reachable.
    const media = await server.api('/media', {}, cookie);
    assert.strictEqual(media.body.media.length, 1);
    const file = await server.api('/media/' + media.body.media[0].id + '/file', {}, cookie);
    assert.strictEqual(file.status, 200);
  } finally {
    await server.stop();
  }
});

test('a .pptx reports unsupported features instead of silently dropping them', async () => {
  const server = await startServer();
  try {
    const { cookie } = await signIn(server);
    const zip = new AdmZip();
    zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>', 'utf8'));
    zip.addFile('ppt/presentation.xml', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldSz cx="9144000" cy="6858000"/><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>', 'utf8'));
    zip.addFile('ppt/_rels/presentation.xml.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>', 'utf8'));
    zip.addFile('ppt/slides/slide1.xml', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr name="Text"/></p:nvSpPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Before chart</a:t></a:r></a:p></p:txBody></p:sp><p:graphicFrame><p:nvGraphicFramePr><p:cNvPr name="Chart 1"/></p:nvGraphicFramePr><p:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"/></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>', 'utf8'));
    zip.addFile('ppt/slides/_rels/slide1.xml.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/></Relationships>', 'utf8'));

    const payload = multipart('chart.pptx', zip.toBuffer(), 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    const res = await server.api('/import/pptx', { method: 'POST', headers: payload.headers, body: payload.body }, cookie);

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.summary.warnings.some(w => /chart-or-smartart/i.test(w)), 'expected a chart warning');
    assert.ok(res.body.presentation.slides[0].text.includes('Before chart'));
  } finally {
    await server.stop();
  }
});

test('a .pptx separates small-print footer text from the main slide text', async () => {
  const server = await startServer();
  try {
    const { cookie } = await signIn(server);
    const zip = new AdmZip();
    zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>', 'utf8'));
    zip.addFile('ppt/presentation.xml', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldSz cx="9144000" cy="6858000"/><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>', 'utf8'));
    zip.addFile('ppt/_rels/presentation.xml.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>', 'utf8'));
    zip.addFile('ppt/slides/slide1.xml', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr name="Main"/></p:nvSpPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="4400"/><a:t>Main point</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr name="Footer"/></p:nvSpPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="1200"/><a:t>Small print</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>', 'utf8'));
    zip.addFile('ppt/slides/_rels/slide1.xml.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/></Relationships>', 'utf8'));

    const payload = multipart('footer.pptx', zip.toBuffer(), 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    const res = await server.api('/import/pptx', { method: 'POST', headers: payload.headers, body: payload.body }, cookie);

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const slide = res.body.presentation.slides[0];
    assert.strictEqual(slide.text, 'Main point');
    assert.strictEqual(slide.footer.text, 'Small print');
    assert.strictEqual(slide.footer.style.size, 12);
    assert.strictEqual(slide.style.size, 44);
  } finally {
    await server.stop();
  }
});

test('a .pptx decodes XML entities and special characters correctly', async () => {
  const server = await startServer();
  try {
    const { cookie } = await signIn(server);
    const buffer = buildPptx({
      title: 'Entity Deck',
      slides: [{ text: 'Tom & Jerry' }]
    });
    const payload = multipart('entity.pptx', buffer, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    const res = await server.api('/import/pptx', { method: 'POST', headers: payload.headers, body: payload.body }, cookie);

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.presentation.slides[0].text.includes('Tom & Jerry'), 'expected decoded ampersand, got: ' + res.body.presentation.slides[0].text);
    assert.ok(!res.body.presentation.slides[0].text.includes('&amp;'), 'expected no raw &amp; entity');
  } finally {
    await server.stop();
  }
});

test('the .pptx endpoint rejects non-pptx files', async () => {
  const server = await startServer();
  try {
    const { cookie } = await signIn(server);
    const payload = multipart('notes.txt', Buffer.from('just text', 'utf8'), 'text/plain');
    const res = await server.api('/import/pptx', { method: 'POST', headers: payload.headers, body: payload.body }, cookie);
    assert.ok(res.status >= 400, 'should reject non-pptx files');
  } finally {
    await server.stop();
  }
});

test('the .pptx endpoint rejects malformed archives', async () => {
  const server = await startServer();
  try {
    const { cookie } = await signIn(server);
    const payload = multipart('bad.pptx', Buffer.from('PK\x03\x04not a presentation', 'utf8'), 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    const res = await server.api('/import/pptx', { method: 'POST', headers: payload.headers, body: payload.body }, cookie);
    assert.ok(res.status >= 400, 'should reject malformed pptx');
  } finally {
    await server.stop();
  }
});

test('the .pptx endpoint enforces the storage quota for extracted media', async () => {
  const server = await startServer({ DEFAULT_QUOTA_BYTES: '50' });
  try {
    const { cookie } = await signIn(server);
    const buffer = buildPptx({
      title: 'Too Big',
      slides: [{ text: 'With background', backgroundImage: true }]
    });
    const payload = multipart('big.pptx', buffer, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    const res = await server.api('/import/pptx', { method: 'POST', headers: payload.headers, body: payload.body }, cookie);

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.summary.media, 0);
    assert.ok(res.body.summary.skipped.some(s => /quota/i.test(s.reason)), 'expected a quota skip');
    assert.ok(res.body.summary.warnings.some(w => /image1\.png could not be resolved/i.test(w)), 'expected unresolved background warning');
  } finally {
    await server.stop();
  }
});
