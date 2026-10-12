'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer, signIn } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const INSTALLED = path.join(ROOT, 'data', 'bible');

// Tests run against a copy of the installed translation so they never touch the
// development data directory.
function withBible() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swp-bible-data-'));
  if (fs.existsSync(INSTALLED)) {
    fs.cpSync(INSTALLED, path.join(dir, 'bible'), { recursive: true });
  }
  return dir;
}

const haveBible = fs.existsSync(path.join(INSTALLED, 'translations.json'));

test('bible reference parsing', async t => {
  const bible = require('../src/bible');

  await t.test('reads common reference forms', () => {
    const cases = [
      ['John 3:16', { book: 'JOH', chapter: 3, verse: 16 }],
      ['Jn 3:16', { book: 'JOH', chapter: 3, verse: 16 }],
      ['1 Jn 1:9', { book: '1JO', chapter: 1, verse: 9 }],
      ['Genesis 1', { book: 'GEN', chapter: 1, verse: null }],
      ['Psalm 23', { book: 'PSA', chapter: 23, verse: null }],
      ['1 Cor 13:4-7', { book: '1CO', chapter: 13, verse: 4, end_verse: 7 }],
      ['Gen 1:1-2:3', { book: 'GEN', chapter: 1, verse: 1, end_chapter: 2, end_verse: 3 }]
    ];
    for (const [input, expected] of cases) {
      const got = bible.parseReference(input);
      assert.equal(got.error, undefined, input + ' should parse: ' + got.error);
      for (const [k, v] of Object.entries(expected)) {
        assert.equal(got[k], v, `${input} → ${k}`);
      }
    }
  });

  await t.test('explains what is wrong with a bad reference', () => {
    for (const bad of ['', 'Nonsense 1:1', 'John', 'John 3:16-2', 'Foo 99:99']) {
      const got = bible.parseReference(bad);
      assert.ok(got.error, JSON.stringify(bad) + ' should be rejected');
      assert.ok(got.error.length > 10, 'the message should explain the problem');
    }
  });
});

test('bible slide generation', async t => {
  const bible = require('../src/bible');
  const sample = {
    reference: '1 Corinthians 13:4-7',
    translation: 'WEB',
    translation_name: 'World English Bible',
    verses: [
      { chapter: 13, verse: 4, text: 'Love is patient and is kind.' },
      { chapter: 13, verse: 5, text: 'Love does not envy.' },
      { chapter: 13, verse: 6, text: 'Love does not brag.' },
      { chapter: 13, verse: 7, text: 'Bears all things, believes all things.' }
    ]
  };

  await t.test('never loses or duplicates verse text', () => {
    const slides = bible.generateSlides(sample, { lines_per_slide: 2, max_chars: 400 });
    const produced = slides.flatMap(s => s.text.split('\n')).join('\n');
    for (const v of sample.verses) {
      const occurrences = produced.split(v.text).length - 1;
      assert.equal(occurrences, 1, `verse ${v.verse} should appear exactly once, found ${occurrences}`);
    }
  });

  await t.test('keeps a verse on one slide even when it overflows', () => {
    // This verse is longer than max_chars on its own, so it must occupy a whole
    // slide rather than being cut in half to make room for the next one.
    const long = {
      ...sample,
      verses: [{ chapter: 1, verse: 1, text: 'x'.repeat(300) }, { chapter: 1, verse: 2, text: 'short' }]
    };
    const slides = bible.generateSlides(long, { lines_per_slide: 4, max_chars: 260 });
    assert.equal(slides.length, 2, 'the oversized verse gets its own slide');
    assert.match(slides[0].text, /^1 x{300}$/, 'the verse is whole, not truncated');
    assert.match(slides[1].text, /short$/, 'the following verse starts a new slide');
  });

  await t.test('creates additional slides rather than truncating', () => {
    const many = { ...sample, verses: Array.from({ length: 12 }, (_, i) => ({ chapter: 1, verse: i + 1, text: 'verse ' + (i + 1) })) };
    const slides = bible.generateSlides(many, { lines_per_slide: 3, max_chars: 400 });
    assert.equal(slides.length, 4, 'four slides of three verses each');
  });

  await t.test('honours the verse number and reference options', () => {
    const withNumbers = bible.generateSlides(sample, { lines_per_slide: 10, show_verse_numbers: true });
    assert.match(withNumbers[0].text, /^4 /, 'verse numbers are prefixed');

    const without = bible.generateSlides(sample, { lines_per_slide: 10, show_verse_numbers: false });
    assert.doesNotMatch(without[0].text, /^4 /, 'verse numbers can be turned off');
  });

  await t.test('never produces an empty slide', () => {
    const slides = bible.generateSlides(sample, { lines_per_slide: 1 });
    for (const s of slides) assert.ok(s.text.trim().length > 0);
  });
});

test('installed World English Bible', { skip: haveBible ? false : 'run `npm run import:bible` first' }, async t => {
  const dataDir = withBible();
  const server = await startServer({ DATA_DIR: dataDir });
  t.after(() => { server.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const { cookie } = await signIn(server);
  const get = (path2) => server.api(path2, {}, cookie);

  await t.test('publishes translation metadata and licensing', async () => {
    const res = await get('/bible/translations');
    assert.equal(res.status, 200);
    const web = res.body.translations.find(x => x.id === 'WEB');
    assert.ok(web, 'WEB is installed');
    assert.equal(web.abbreviation, 'WEB');
    assert.match(web.license, /public domain/i);
    assert.match(web.attribution, /eBible\.org/, 'trademark attribution is recorded');
    assert.ok(web.source_url.includes('ebible.org'), 'the official source is recorded');
  });

  await t.test('contains all 66 books in canonical order', async () => {
    const res = await get('/bible/books?translation=WEB');
    assert.equal(res.status, 200);
    assert.equal(res.body.books.length, 66);
    assert.equal(res.body.books[0].id, 'GEN');
    assert.equal(res.body.books[38].id, 'MAL', 'the Old Testament ends at Malachi');
    assert.equal(res.body.books[39].id, 'MAT', 'the New Testament starts at Matthew');
    assert.equal(res.body.books[65].id, 'REV');
    const names = res.body.books.map(b => b.name);
    assert.ok(names.includes('Psalms') || names.includes('Psalm'));
    assert.ok(names.includes('Revelation'));
  });

  await t.test('chapter and verse counts are complete', async () => {
    const res = await get('/bible/chapter?translation=WEB&book=GEN&chapter=1');
    assert.equal(res.status, 200);
    assert.equal(res.body.verse_count, 31, 'Genesis 1 has 31 verses');

    const psalm = await get('/bible/chapter?translation=WEB&book=PSA&chapter=23');
    assert.equal(psalm.body.verse_count, 6, 'Psalm 23 has 6 verses');

    const john = await get('/bible/chapter?translation=WEB&book=JOH&chapter=3');
    assert.ok(john.body.verse_count >= 36, 'John 3 is complete');
  });

  await t.test('representative verses match the source exactly', async () => {
    const checks = [
      ['Genesis 1:1', 'In the beginning, God created the heavens and the earth.'],
      ['Psalm 23:1', 'Yahweh is my shepherd; I shall lack nothing.'],
      ['John 3:16', 'For God so loved the world, that he gave his only born Son, that whoever believes in him should not perish, but have eternal life.']
    ];
    for (const [ref, expected] of checks) {
      const res = await get('/bible/passage?ref=' + encodeURIComponent(ref));
      assert.equal(res.status, 200, ref + ': ' + res.body.error);
      assert.equal(res.body.verses.length, 1);
      assert.equal(res.body.verses[0].text, expected, ref + ' text must match the source exactly');
    }
  });

  await t.test('verse ranges return every verse, in order, from the right chapter', async () => {
    const res = await get('/bible/passage?ref=' + encodeURIComponent('John 3:16-18'));
    assert.equal(res.status, 200);
    assert.equal(res.body.verses.length, 3);
    assert.deepEqual(res.body.verses.map(v => v.verse), [16, 17, 18]);
    assert.ok(res.body.verses.every(v => v.chapter === 3), 'no verse from another chapter');
  });

  await t.test('cross-chapter ranges span chapters correctly', async () => {
    const res = await get('/bible/passage?ref=' + encodeURIComponent('Genesis 1:30-2:2'));
    assert.equal(res.status, 200);
    assert.equal(res.body.verses.length, 4, 'Genesis 1:30, 1:31, 2:1 and 2:2');
    assert.deepEqual(res.body.verses.map(v => v.chapter + ':' + v.verse), ['1:30', '1:31', '2:1', '2:2']);
    assert.deepEqual([...new Set(res.body.verses.map(v => v.chapter))], [1, 2], 'spans both chapters');
  });

  await t.test('search finds words and reports the reference', async () => {
    // A phrase narrows it to where it actually appears.
    const phrase = await get('/bible/search?q=' + encodeURIComponent('Yahweh is my shepherd'));
    assert.equal(phrase.status, 200);
    const psalm = phrase.body.results.find(r => r.reference.startsWith('Psalms 23'));
    assert.ok(psalm, 'Psalm 23:1 is found by an exact phrase');
    assert.match(psalm.text, /shepherd/i);
    assert.ok(psalm.reference.includes('23:'), 'the result carries its reference');
    assert.equal(phrase.body.translation_name, 'World English Bible', 'the translation is reported');

    // A common word returns many hits and respects the limit.
    const common = await get('/bible/search?q=shepherd&limit=5');
    assert.equal(common.body.results.length, 5, 'the limit is respected');
    assert.equal(common.body.truncated, true);
    assert.ok(common.body.results.every(r => r.reference && r.text), 'every hit has a reference and text');
  });

  await t.test('bad references are explained, not guessed at', async () => {
    const res = await get('/bible/passage?ref=Genesis%2099:1');
    assert.equal(res.status, 400);
    assert.match(res.body.error, /has no chapter/i);
  });

  await t.test('generates slides from a passage without losing text', async () => {
    const res = await server.api('/bible/slides', {
      method: 'POST',
      body: { ref: 'Psalm 23', options: { lines_per_slide: 3, show_verse_numbers: true } }
    }, cookie);
    assert.equal(res.status, 200);
    assert.ok(res.body.slide_count >= 2);
    const produced = res.body.slides.map(s => s.text).join('\n');
    for (const n of [1, 2, 3, 4, 5, 6]) {
      assert.match(produced, new RegExp('(^|\\n)' + n + ' '), 'verse ' + n + ' number is preserved');
    }
    assert.ok(res.body.slides.every(s => s.reference), 'every slide carries the passage reference');
  });

  await t.test('requires a signed-in account', async () => {
    const res = await server.api('/bible/books', {});
    assert.equal(res.status, 401);
  });

  await t.test('does not contact any external service at lookup time', async () => {
    // The data is read from disk; if it were fetched per request this test
    // machine would have no way to serve it while offline.
    const dir = path.join(dataDir, 'bible', 'WEB');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    assert.equal(files.length, 66, 'the translation is fully materialised on disk');
  });

  await t.test('importing twice does not duplicate books, chapters or verses', async () => {
    const before = fs.readdirSync(path.join(dataDir, 'bible', 'WEB')).sort();
    // Re-running the writer over the same folder must be idempotent.
    const manifestBefore = JSON.parse(fs.readFileSync(path.join(dataDir, 'bible', 'translations.json'), 'utf8'));
    assert.equal(manifestBefore.translations.length, 1, 'one translation record');
    const after = fs.readdirSync(path.join(dataDir, 'bible', 'WEB')).sort();
    assert.deepEqual(after, before, 'the same files, not duplicated ones');
  });
});
