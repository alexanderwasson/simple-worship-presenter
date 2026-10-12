'use strict';
/*
 * Bible lookup, reference parsing, search and slide generation.
 *
 * The text lives in DATA_DIR/bible and is shared by every account. It is
 * installed data, not user content, so it never counts against a storage quota
 * and no Bible text is duplicated into anyone's account.
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');

const BIBLE_DIR = path.join(config.dataDir, 'bible');
const MANIFEST = path.join(BIBLE_DIR, 'translations.json');

// Names accepted when parsing a reference, keyed by canonical book id.
const NAME_INDEX = {
  GEN: ['genesis', 'gen', 'ge', 'gn'], EXO: ['exodus', 'exod', 'exo', 'ex'], LEV: ['leviticus', 'lev', 'le', 'lv'],
  NUM: ['numbers', 'num', 'nu', 'nm', 'nb'], DEU: ['deuteronomy', 'deut', 'deu', 'dt', 'de'],
  JOS: ['joshua', 'josh', 'jos', 'jsh'], JDG: ['judges', 'judg', 'jdg', 'judges'],
  RUT: ['ruth', 'ruth', 'ruth', 'ru', 'rth'], '1SA': ['1 samuel', '1samuel', '1 sam', '1sa', '1 sm', 'isamuel'],
  '2SA': ['2 samuel', '2samuel', '2 sam', '2sa', '2 sm', 'iisamuel'], '1KI': ['1 kings', '1kings', '1 ki', '1ki', '1kgs'],
  '2KI': ['2 kings', '2kings', '2 ki', '2ki', '2kgs'], '1CH': ['1 chronicles', '1chronicles', '1 ch', '1ch', '1chr'],
  '2CH': ['2 chronicles', '2chronicles', '2 ch', '2ch', '2chr'], EZR: ['ezra', 'ezr'], NEH: ['nehemiah', 'neh', 'ne'],
  EST: ['esther', 'est', 'esth', 'es'], JOB: ['job', 'job', 'jb'], PSA: ['psalm', 'psalms', 'psalm', 'psa', 'ps', 'psm'],
  PRO: ['proverbs', 'prov', 'pro', 'pr', 'prv'], ECC: ['ecclesiastes', 'eccl', 'ecc', 'ec', 'qoh'],
  SNG: ['song of solomon', 'song of songs', 'sos', 'songofsolomon', 'sng', 'sos', 'so', 'sg'],
  ISA: ['isaiah', 'isa', 'is'], JER: ['jeremiah', 'jer', 'je'], LAM: ['lamentations', 'lam', 'la'],
  EZK: ['ezekiel', 'ezek', 'eze', 'ezk', 'ez'], DAN: ['daniel', 'dan', 'da', 'dn'], HOS: ['hosea', 'hos', 'ho'],
  JOL: ['joel', 'jol', 'jl'], AMO: ['amos', 'amo', 'am'], OBA: ['obadiah', 'obad', 'oba', 'ob'],
  JON: ['jonah', 'jon', 'jnh'], MIC: ['micah', 'mic', 'mc'], NAM: ['nahum', 'nah', 'na', 'nh'],
  HAB: ['habakkuk', 'hab', 'hb'], ZEP: ['zephaniah', 'zeph', 'zep', 'zp'], HAG: ['haggai', 'hag', 'hg'],
  ZEC: ['zecharzech', 'zechariah', 'zech', 'zec', 'zc'], MAL: ['malachi', 'mal', 'ml'],
  MAT: ['matthew', 'matt', 'mat', 'mt'], MRK: ['mark', 'mar', 'mrk', 'mk'], LUK: ['luke', 'luk', 'lk'],
  JOH: ['john', 'joh', 'jn', 'jhn'], ACT: ['acts', 'act', 'ac'], ROM: ['romans', 'rom', 'ro', 'rm'],
  '1CO': ['1 corinthians', '1corinthians', '1 cor', '1co', '1cor'], '2CO': ['2 corinthians', '2corinthians', '2 cor', '2co', '2cor'],
  GAL: ['galatians', 'gal', 'ga'], EPH: ['ephesians', 'eph'], PHP: ['philippians', 'phil', 'php', 'philip'],
  COL: ['colossians', 'col', 'co'], '1TH': ['1 thessalonians', '1thessalonians', '1 thess', '1th', '1thes'],
  '2TH': ['2 thessalonians', '2thessalonians', '2 thess', '2th', '2thes'], '1TI': ['1 timothy', '1timothy', '1 tim', '1ti', '1tim'],
  '2TI': ['2 timothy', '2timothy', '2 tim', '2ti', '2tim'], TIT: ['titus', 'tit', 'ti'], PHM: ['philemon', 'phlm', 'phm', 'philem'],
  HEB: ['hebrews', 'heb'], JAS: ['james', 'jas', 'jm'], '1PE': ['1 peter', '1peter', '1 pet', '1pe', '1pet', '1pt'],
  '2PE': ['2 peter', '2peter', '2 pet', '2pe', '2pet', '2pt'], '1JO': ['1 john', '1john', '1 jn', '1jo', '1jn', '1joh'],
  '2JO': ['2 john', '2john', '2 jn', '2jo', '2jn', '2joh'], '3JO': ['3 john', '3john', '3 jn', '3jo', '3jn', '3joh'],
  JUD: ['jude', 'jud', 'jd'], REV: ['revelation', 'revelations', 'rev', 're', 'apocalypse']
};

const LOOKUP = (() => {
  const map = new Map();
  for (const [id, names] of Object.entries(NAME_INDEX)) {
    map.set(id.toLowerCase(), id);
    for (const n of names) map.set(n.replace(/\s+/g, ' ').trim().toLowerCase(), id);
    // Compact forms such as "1jn" and "1 jn".
    for (const n of names) map.set(n.replace(/\s+/g, '').toLowerCase(), id);
  }
  return map;
})();

function translations() {
  if (!fs.existsSync(MANIFEST)) return [];
  try {
    return JSON.parse(fs.readFileSync(MANIFEST, 'utf8').replace(/^\uFEFF/, '')).translations || [];
  } catch {
    return [];
  }
}

function translation(id) {
  return translations().find(t => t.id.toLowerCase() === String(id || '').toLowerCase()) || null;
}

function bookFile(translationId, bookId) {
  return path.join(BIBLE_DIR, translationId, bookId + '.json');
}

function loadBook(translationId, bookId) {
  const file = bookFile(translationId, bookId);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function books(translationId) {
  const t = translation(translationId) || translation('WEB');
  if (!t) return [];
  const dir = path.join(BIBLE_DIR, t.id);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const book = loadBook(t.id, file.replace(/\.json$/, ''));
    if (book && book.id) out.push(book);
  }
  return out.sort((a, b) => a.order - b.order).map(b => ({
    id: b.id,
    name: b.name,
    abbrev: b.abbrev,
    testament: b.testament,
    chapter_count: b.chapters.length
  }));
}

function chapter(translationId, bookId, number) {
  const book = loadBook(translationId, bookId);
  if (!book) return null;
  return book.chapters.find(c => c.chapter === Number(number)) || null;
}

/* ---- reference parsing -------------------------------------------------- */
// Accepts "John 3:16", "Jn 3:16-18", "1 Cor 13", "Psalm 23", "Genesis 1:1-2:3".
function parseReference(input) {
  const raw = String(input || '').trim();
  if (!raw) return { error: 'Enter a reference such as John 3:16' };

  const match = raw.match(/^([\d]?\s*[a-zA-Z .]+?)\s+(\d+)(?::(\d+)(?:\s*[-–—]\s*(?:(\d+)\s*:\s*)?(\d+))?)?$/);
  if (!match) {
    return { error: 'Could not read that reference. Try a form like John 3:16 or Psalm 23.' };
  }

  const bookKey = match[1].toLowerCase().replace(/[.]/g, '').replace(/\s+/g, ' ').trim();
  const compact = bookKey.replace(/\s+/g, '');
  const bookId = LOOKUP.get(bookKey) || LOOKUP.get(compact);
  if (!bookId) {
    return { error: `I don’t recognise “${match[1].trim()}”. Check the book name or try an abbreviation like Jn or Gen.` };
  }

  const startChapter = Number(match[2]);
  const startVerse = match[3] ? Number(match[3]) : null;
  const endChapter = match[4] ? Number(match[4]) : startChapter;
  const endVerse = match[5] ? Number(match[5]) : null;

  if (startVerse && endVerse && (endChapter < startChapter || (endChapter === startChapter && endVerse < startVerse))) {
    return { error: 'The end of that range comes before the start.' };
  }

  return {
    book: bookId,
    chapter: startChapter,
    verse: startVerse,
    end_chapter: endChapter,
    end_verse: endVerse,
    label: raw
  };
}

function referenceLabel(bookId, chapter, verse, endChapter, endVerse) {
  const book = loadBook('WEB', bookId) || { name: bookId };
  const name = book ? book.name : bookId;
  if (!verse) return `${name} ${chapter}`;
  if (endVerse && (endChapter > chapter || endVerse > verse)) {
    return endChapter > chapter
      ? `${name} ${chapter}:${verse}–${endChapter}:${endVerse}`
      : `${name} ${chapter}:${verse}–${endVerse}`;
  }
  return `${name} ${chapter}:${verse}`;
}

// Returns the verses of a passage, or an explanation of what is wrong.
function passage(translationId, ref) {
  const t = translation(translationId) || translation('WEB');
  if (!t) return { error: 'No Bible translation is installed on this server.' };
  const book = loadBook(t.id, ref.book);
  if (!book) return { error: `The book ${ref.book} is not available in ${t.name}.` };

  const verses = [];
  const from = ref.verse || 1;
  const toChapter = ref.end_chapter || ref.chapter;

  for (let c = ref.chapter; c <= toChapter; c++) {
    const ch = book.chapters.find(x => x.chapter === c);
    if (!ch) {
      return { error: `${book.name} has no chapter ${c}. It has ${book.chapters.length} chapters.` };
    }
    const last = c === toChapter ? (ref.end_verse || (ref.verse ? from : ch.verses.length)) : ch.verses.length;
    const first = c === ref.chapter ? from : 1;
    for (let v = first; v <= last; v++) {
      const verse = ch.verses.find(x => x.verse === v);
      if (!verse) {
        return { error: `${book.name} ${c} has no verse ${v}. It has ${ch.verses.length} verses.` };
      }
      verses.push({ book: ref.book, book_name: book.name, chapter: c, verse: v, text: verse.text });
    }
  }

  if (!verses.length) return { error: 'That reference contains no verses.' };
  return {
    translation: t.id,
    translation_name: t.name,
    reference: referenceLabel(ref.book, ref.chapter, ref.verse, ref.end_chapter, ref.end_verse),
    heading: chapter(t.id, ref.book, ref.chapter)?.heading || '',
    verses
  };
}

/* ---- search ------------------------------------------------------------- */
// Plain substring search over the stored text. Indexed per book so a query does
// not load the whole translation.
function search(translationId, query, limit = 50) {
  const t = translation(translationId) || translation('WEB');
  if (!t) return { error: 'No Bible translation is installed on this server.' };
  const needle = String(query || '').trim().toLowerCase();
  if (needle.length < 2) return { error: 'Enter at least two characters to search.' };

  const results = [];
  for (const [bookId] of Object.entries(NAME_INDEX)) {
    const book = loadBook(t.id, bookId);
    if (!book) continue;
    for (const ch of book.chapters) {
      for (const v of ch.verses) {
        if (v.text.toLowerCase().includes(needle)) {
          results.push({
            book: bookId,
            book_name: book.name,
            chapter: ch.chapter,
            verse: v.verse,
            reference: referenceLabel(bookId, ch.chapter, v.verse),
            text: v.text
          });
          if (results.length >= limit) return { translation: t.id, translation_name: t.name, query, results, truncated: true };
        }
      }
    }
  }
  return { translation: t.id, translation_name: t.name, query, results, truncated: false };
}

/* ---- slide generation --------------------------------------------------- */
// Options: lines_per_slide, max_chars, show_verse_numbers, show_reference,
// show_translation, keep_verses_together.
function generateSlides(passageData, options = {}) {
  const linesPerSlide = Math.max(1, Math.min(8, Number(options.lines_per_slide) || 4));
  const maxChars = Math.max(80, Number(options.max_chars) || 260);
  const showNumbers = options.show_verse_numbers !== false;
  const showReference = options.show_reference !== false;
  const showTranslation = options.show_translation !== false;

  const items = passageData.verses.map(v => ({
    number: v.verse,
    chapter: v.chapter,
    text: (showNumbers ? String(v.verse) + ' ' : '') + v.text
  }));

  const slides = [];
  let current = [];

  const flush = () => {
    if (!current.length) return;
    const body = current.map(i => i.text).join('\n');
    const head = [];
    if (showReference) head.push(passageData.reference);
    if (showTranslation) head.push(passageData.translation_name);
    slides.push({
      text: body,
      meta: head.join(' · '),
      reference: passageData.reference,
      translation: passageData.translation,
      verses: current.map(i => ({ chapter: i.chapter, verse: i.number }))
    });
    current = [];
  };

  for (const item of items) {
    const wouldBe = [...current, item];
    const size = wouldBe.map(i => i.text).join('\n').length;
    // Never split a verse across slides, and never overflow the slide.
    if (current.length && (wouldBe.length > linesPerSlide || size > maxChars)) flush();
    current.push(item);
  }
  flush();

  // The reference and translation belong to the passage, not to every slide.
  if (slides.length && !showReference && !showTranslation) {
    for (const s of slides) s.meta = '';
  }
  return slides;
}

module.exports = {
  BIBLE_DIR,
  translations,
  translation,
  books,
  loadBook,
  chapter,
  parseReference,
  referenceLabel,
  passage,
  search,
  generateSlides
};
