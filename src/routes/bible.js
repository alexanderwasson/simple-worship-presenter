'use strict';
/*
 * Bible API. Read-only access to the installed translation(s).
 *
 * The text is shared instance data: it is not user content, it is not written
 * into any account, and it never counts against a storage quota. Passages become
 * a user's content only when they are turned into slides in a presentation.
 */
const express = require('express');
const bible = require('../bible');
const auth = require('../auth');
const { limiter, writeLimiter } = require('../rateLimit');

const router = express.Router();

function jsonError(res, status, message) {
  return res.status(status).json({ error: message });
}

// Installed translations and their licence/attribution metadata.
router.get('/translations', auth.requireAuth, (req, res) => {
  res.json({ translations: bible.translations() });
});

router.get('/books', auth.requireAuth, (req, res) => {
  const translation = req.query.translation || 'WEB';
  if (!bible.translation(translation)) return jsonError(res, 404, 'That translation is not installed');
  res.json({ translation, books: bible.books(translation) });
});

router.get('/chapter', auth.requireAuth, (req, res) => {
  const translation = req.query.translation || 'WEB';
  const book = String(req.query.book || '').toUpperCase();
  const number = Number(req.query.chapter);
  if (!bible.translation(translation)) return jsonError(res, 404, 'That translation is not installed');
  if (!book || !Number.isInteger(number) || number < 1) return jsonError(res, 400, 'Provide a book and a chapter number');

  const result = bible.chapter(translation, book, number);
  if (!result) return jsonError(res, 404, 'That chapter was not found');
  const meta = bible.loadBook(translation, book);
  res.json({
    translation,
    book,
    book_name: meta ? meta.name : book,
    chapter: number,
    heading: result.heading || '',
    verse_count: result.verses.length,
    verses: result.verses
  });
});

// "Give me John 3:16-18" — supports common abbreviations and ranges.
router.get('/passage', auth.requireAuth, limiter({ label: 'bible', max: 600 }), (req, res) => {
  const ref = bible.parseReference(req.query.ref || req.query.reference);
  if (ref.error) return jsonError(res, 400, ref.error);

  const result = bible.passage(req.query.translation || 'WEB', ref);
  if (result.error) return jsonError(res, 400, result.error);
  res.json(result);
});

router.get('/search', auth.requireAuth, limiter({ label: 'bible', max: 300 }), (req, res) => {
  const result = bible.search(req.query.translation || 'WEB', req.query.q, Math.min(100, Number(req.query.limit) || 50));
  if (result.error) return jsonError(res, 400, result.error);
  res.json(result);
});

// Turn a passage into slides using the same slide shape as the rest of the app.
router.post('/slides', auth.requireAuth, writeLimiter(), (req, res) => {
  const ref = bible.parseReference(req.body.ref || req.body.reference);
  if (ref.error) return jsonError(res, 400, ref.error);

  const result = bible.passage(req.body.translation || 'WEB', ref);
  if (result.error) return jsonError(res, 400, result.error);

  const slides = bible.generateSlides(result, req.body.options || {});
  if (!slides.length) return jsonError(res, 400, 'That passage produced no slides');

  res.json({
    reference: result.reference,
    translation: result.translation,
    translation_name: result.translation_name,
    verse_count: result.verses.length,
    slide_count: slides.length,
    slides
  });
});

module.exports = router;
