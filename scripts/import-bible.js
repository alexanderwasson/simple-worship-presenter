#!/usr/bin/env node
'use strict';
/*
 * Import the World English Bible into Simple Worship Presenter's Bible store.
 *
 *   node scripts/import-bible.js                 download and import the WEB
 *   node scripts/import-bible.js --from <file>   import a USFM zip you already have
 *   node scripts/import-bible.js --list          show what is installed
 *
 * Source: https://ebible.org/scriptures/eng-web_usfm.zip
 * License: public domain. "World English Bible" is a trademark of eBible.org,
 * and the text must not be labelled WEB if it is altered.
 *
 * The import is idempotent: running it again replaces the translation cleanly
 * rather than appending duplicates. Imported text is stored outside the user
 * account store, so it never counts against anyone's storage quota.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const DEFAULT_URL = process.env.BIBLE_SOURCE_URL || 'https://ebible.org/scriptures/eng-web_usfm.zip';

// The 66-book Protestant canon in canonical order. The WEB archive also ships
// the deuterocanon, which is deliberately excluded here.
const CANON = [
  ['GEN', 'Genesis', 'Ge', 'OT'], ['EXO', 'Exodus', 'Ex', 'OT'], ['LEV', 'Leviticus', 'Le', 'OT'],
  ['NUM', 'Numbers', 'Nu', 'OT'], ['DEU', 'Deuteronomy', 'Dt', 'OT'], ['JOS', 'Joshua', 'Jos', 'OT'],
  ['JDG', 'Judges', 'Jdg', 'OT'], ['RUT', 'Ruth', 'Ru', 'OT'], ['1SA', '1 Samuel', '1Sa', 'OT'],
  ['2SA', '2 Samuel', '2Sa', 'OT'], ['1KI', '1 Kings', '1Ki', 'OT'], ['2KI', '2 Kings', '2Ki', 'OT'],
  ['1CH', '1 Chronicles', '1Ch', 'OT'], ['2CH', '2 Chronicles', '2Ch', 'OT'], ['EZR', 'Ezra', 'Ezr', 'OT'],
  ['NEH', 'Nehemiah', 'Ne', 'OT'], ['EST', 'Esther', 'Est', 'OT'], ['JOB', 'Job', 'Job', 'OT'],
  ['PSA', 'Psalms', 'Ps', 'OT'], ['PRO', 'Proverbs', 'Pr', 'OT'], ['ECC', 'Ecclesiastes', 'Ec', 'OT'],
  ['SNG', 'Song of Solomon', 'So', 'OT'], ['ISA', 'Isaiah', 'Isa', 'OT'], ['JER', 'Jeremiah', 'Jer', 'OT'],
  ['LAM', 'Lamentations', 'La', 'OT'], ['EZK', 'Ezekiel', 'Eze', 'OT'], ['DAN', 'Daniel', 'Da', 'OT'],
  ['HOS', 'Hosea', 'Ho', 'OT'], ['JOL', 'Joel', 'Joe', 'OT'], ['AMO', 'Amos', 'Am', 'OT'],
  ['OBA', 'Obadiah', 'Ob', 'OT'], ['JON', 'Jonah', 'Jon', 'OT'], ['MIC', 'Micah', 'Mic', 'OT'],
  ['NAM', 'Nahum', 'Na', 'OT'], ['HAB', 'Habakkuk', 'Hab', 'OT'], ['ZEP', 'Zephaniah', 'Zep', 'OT'],
  ['HAG', 'Haggai', 'Hag', 'OT'], ['ZEC', 'Zechariah', 'Zec', 'OT'], ['MAL', 'Malachi', 'Mal', 'OT'],
  ['MAT', 'Matthew', 'Mt', 'NT'], ['MRK', 'Mark', 'Mk', 'NT'], ['LUK', 'Luke', 'Lk', 'NT'],
  ['JOH', 'John', 'Jn', 'NT'], ['ACT', 'Acts', 'Ac', 'NT'], ['ROM', 'Romans', 'Ro', 'NT'],
  ['1CO', '1 Corinthians', '1Co', 'NT'], ['2CO', '2 Corinthians', '2Co', 'NT'], ['GAL', 'Galatians', 'Ga', 'NT'],
  ['EPH', 'Ephesians', 'Eph', 'NT'], ['PHP', 'Philippians', 'Php', 'NT'], ['COL', 'Colossians', 'Col', 'NT'],
  ['1TH', '1 Thessalonians', '1Th', 'NT'], ['2TH', '2 Thessalonians', '2Th', 'NT'], ['1TI', '1 Timothy', '1Ti', 'NT'],
  ['2TI', '2 Timothy', '2Ti', 'NT'], ['TIT', 'Titus', 'Tit', 'NT'], ['PHM', 'Philemon', 'Phm', 'NT'],
  ['HEB', 'Hebrews', 'Heb', 'NT'], ['JAS', 'James', 'Jas', 'NT'], ['1PE', '1 Peter', '1Pe', 'NT'],
  ['2PE', '2 Peter', '2Pe', 'NT'], ['1JO', '1 John', '1Jo', 'NT'], ['2JO', '2 John', '2Jo', 'NT'],
  ['3JO', '3 John', '3Jo', 'NT'], ['JUD', 'Jude', 'Jud', 'NT'], ['REV', 'Revelation', 'Re', 'NT']
];
const CANON_IDS = new Set(CANON.map(b => b[0]));

// USFM book codes vary between schemes. Normalise before matching the canon.
const ID_ALIASES = {
  JHN: 'JOH', '1JN': '1JO', '2JN': '2JO', '3JN': '3JO',
  SNG: 'SNG', EZE: 'EZK', JAS: 'JAS', KJV: null
};
const normaliseId = raw => {
  const upper = String(raw || '').toUpperCase();
  if (CANON_IDS.has(upper)) return upper;
  return Object.prototype.hasOwnProperty.call(ID_ALIASES, upper) ? ID_ALIASES[upper] : upper;
};

function log(m) { process.stdout.write(m + '\n'); }
function fail(m) { process.stderr.write('\n  ' + m + '\n'); process.exit(1); }

const args = process.argv.slice(2);
const flag = name => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const BIBLE_DIR = path.join(DATA_DIR, 'bible');

// ---- USFM parsing --------------------------------------------------------
// Verse text must be preserved exactly. Only structural and styling markers are
// removed; wording, punctuation and capitalisation are never touched.
function stripInlineMarkers(text) {
  let out = String(text);

  // Footnotes, cross-references and figures are apparatus, not verse text.
  out = out.replace(/\\f\s[\s\S]*?\\f\*/g, ' ');
  out = out.replace(/\\x\s[\s\S]*?\\x\*/g, ' ');
  out = out.replace(/\\fig\s[\s\S]*?\\fig\*/g, ' ');

  // Word-level markup carries Strong's numbers and lemmas as attributes:
  //   \w Yahweh|strong="H3068"\w*   ->   Yahweh
  out = out.replace(/\\\+?w\s+([^|\\]+?)(?:\|[^\\]*?)?\\\+?w\*/g, '$1');

  // Remaining paired character markers keep their inner text. Levels such as
  // \q1 / \q2 carry trailing digits which must be stripped with the marker.
  for (let pass = 0; pass < 6; pass++) {
    const before = out;
    out = out.replace(/\\\+?[a-zA-Z]+\d*\s?([^\\]*?)\\\+?[a-zA-Z]+\d*\*/g, '$1');
    if (out === before) break;
  }

  // Any leftover attributes, then any remaining opening markers.
  out = out.replace(/\|[a-zA-Z_]+="[^"]*"/g, '');
  out = out.replace(/\\\+?[a-zA-Z]+\d*\*?/g, ' ');
  out = out.replace(/\{[^}]*\}/g, '');
  out = out.replace(/\s+/g, ' ').trim();
  return out;
}

function parseUsfm(text) {
  const books = [];
  let book = null;
  let chapter = null;
  let verse = null;

  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const idMatch = line.match(/^\\id\s+(\S+)/);
    if (idMatch) {
      const id = normaliseId(idMatch[1]);
      book = CANON_IDS.has(id) ? { id, chapters: [], name: '' } : null;
      if (book) books.push(book);
      chapter = null;
      verse = null;
      continue;
    }
    if (!book) continue;

    const heading = line.match(/^\\(?:h|toc1)\s+(.+)$/);
    if (heading && !book.name) { book.name = heading[1].trim(); continue; }

    const chapterMatch = line.match(/^\\c\s+(\d+)/);
    if (chapterMatch) {
      const num = Number(chapterMatch[1]);
      chapter = { chapter: num, heading: '', verses: [] };
      book.chapters.push(chapter);
      verse = null;
      continue;
    }

    // \d is a descriptive heading such as a Psalm superscription. It belongs to
    // the chapter, not to verse 1, so verse numbering stays faithful to the source.
    const descriptive = line.match(/^\\d\s+(.+)$/);
    if (descriptive && chapter) {
      const heading = stripInlineMarkers(descriptive[1]);
      chapter.heading = chapter.heading ? chapter.heading + ' ' + heading : heading;
      continue;
    }

    // \v may open a verse, or continue one onto a new line (\v 1a style is rare).
    const verseStart = line.match(/^\\v\s+(\d+[a-z]?)/i);
    if (verseStart && chapter) {
      const label = verseStart[1];
      const body = line.slice(verseStart[0].length);
      const text2 = stripInlineMarkers(body);
      verse = { verse: Number.parseInt(label, 10), label, text: text2 };
      chapter.verses.push(verse);
      continue;
    }

    // Continuation lines (poetry, paragraphs) append to the current verse.
    if (verse && chapter && line.startsWith('\\')) {
      const continuation = stripInlineMarkers(line);
      if (continuation) {
        verse.text = verse.text ? verse.text + ' ' + continuation : continuation;
      }
      continue;
    }
    if (verse && chapter && !line.startsWith('\\')) {
      const plain = stripInlineMarkers(line);
      if (plain) verse.text = verse.text ? verse.text + ' ' + plain : plain;
    }
  }
  return books;
}

// ---- download ------------------------------------------------------------
async function fetchArchive(target) {
  log('  downloading ' + DEFAULT_URL);
  const response = await fetch(DEFAULT_URL, { signal: AbortSignal.timeout(300000) });
  if (!response.ok) throw new Error('the source returned HTTP ' + response.status);
  fs.writeFileSync(target, Buffer.from(await response.arrayBuffer()));
  return fs.statSync(target).size;
}

// The source is a ZIP archive. Windows ships a tar that reads ZIP; Linux does
// not, so extract with a real ZIP reader rather than shelling out.
function extract(archive, into) {
  fs.mkdirSync(into, { recursive: true });
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(archive);
  zip.extractAllTo(into, true);
  return walk(into).filter(f => /\.(sfm|usfm|txt)$/i.test(f));
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

// ---- main ----------------------------------------------------------------
async function main() {
  log('');
  log('Simple Worship Presenter — Bible import');
  log('  data directory : ' + DATA_DIR);

  if (args.includes('--list')) {
    const manifest = path.join(BIBLE_DIR, 'translations.json');
    if (!fs.existsSync(manifest)) {
      log('  no translations installed');
      log('  run: node scripts/import-bible.js');
      process.exit(0);
    }
    const list = JSON.parse(fs.readFileSync(manifest, 'utf8').replace(/^\uFEFF/, ''));
    for (const t of list.translations) {
      log(`  ${t.id.padEnd(6)} ${t.name} — ${t.book_count} books, ${t.chapter_count} chapters, ${t.verse_count} verses`);
    }
    process.exit(0);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swp-bible-'));
  let files;

  const local = flag('--from');
  if (local) {
    if (!fs.existsSync(local)) fail('--from pointed at a file that does not exist: ' + local);
    log('  using local archive  : ' + local);
    try {
      files = extract(local, tmp);
    } catch (err) {
      fail('Could not unpack ' + local + ': ' + err.message);
    }
  } else {
    const archive = path.join(tmp, 'source.zip');
    const size = await fetchArchive(archive);
    log('  downloaded ' + (size / 1048576).toFixed(2) + ' MB');
    try {
      files = extract(archive, tmp);
    } catch (err) {
      fail('Could not unpack the archive: ' + err.message + '\n  Use --from with a local copy of the USFM zip.');
    }
  }

  if (!files.length) fail('No USFM files were found in the archive.');

  log('  found ' + files.length + ' source files');
  const byId = new Map();
  for (const file of files) {
    const parsed = parseUsfm(fs.readFileSync(file, 'utf8'));
    for (const book of parsed) {
      if (!byId.has(book.id)) byId.set(book.id, book);
    }
  }

  const missing = CANON.filter(([id]) => !byId.has(id));
  if (missing.length) {
    fail('The source is missing ' + missing.length + ' books: ' + missing.map(m => m[0]).join(', '));
  }

  // Write one file per book so a chapter lookup does not load the whole Bible.
  fs.mkdirSync(path.join(BIBLE_DIR, 'WEB'), { recursive: true });
  let chapterCount = 0;
  let verseCount = 0;

  for (const [id, name, abbrev, testament] of CANON) {
    const book = byId.get(id);
    book.name = book.name || name;
    const chapters = book.chapters.map(ch => ({
      chapter: ch.chapter,
      heading: ch.heading || '',
      verses: ch.verses.map(v => ({ verse: v.verse, text: v.text }))
    }));
    chapterCount += chapters.length;
    verseCount += chapters.reduce((n, ch) => n + ch.verses.length, 0);
    fs.writeFileSync(
      path.join(BIBLE_DIR, 'WEB', id + '.json'),
      JSON.stringify({ id, name, abbrev, testament, order: CANON.findIndex(c => c[0] === id), chapters })
    );
  }

  const manifest = {
    translations: [{
      id: 'WEB',
      name: 'World English Bible',
      abbreviation: 'WEB',
      language: 'English',
      direction: 'ltr',
      source_url: DEFAULT_URL,
      source_format: 'USFM',
      edition: '2020 stable text edition',
      imported_at: new Date().toISOString(),
      license: 'Public Domain',
      license_url: 'https://ebible.org/engwebp/copyright.htm',
      attribution: 'World English Bible is a trademark of eBible.org. This is the unmodified WEB text; if the text is altered it must not be called the World English Bible.',
      book_count: CANON.length,
      chapter_count: chapterCount,
      verse_count: verseCount
    }]
  };
  fs.mkdirSync(BIBLE_DIR, { recursive: true });
  fs.writeFileSync(path.join(BIBLE_DIR, 'translations.json'), JSON.stringify(manifest, null, 2));

  fs.rmSync(tmp, { recursive: true, force: true });

  log('');
  log('  Installed World English Bible (WEB)');
  log('    books    : ' + CANON.length);
  log('    chapters : ' + chapterCount);
  log('    verses   : ' + verseCount);
  log('');
  log('  Text is public domain. Do not label altered text as WEB.');
  log('');
}

main().catch(err => fail((err && err.message) || String(err)));
