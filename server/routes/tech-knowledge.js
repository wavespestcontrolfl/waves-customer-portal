const express = require('express');
const router = express.Router();
const WikiQA = require('../services/knowledge/wiki-qa');

// Tech field Q&A — simpler auth, mobile-optimized responses

// POST /api/tech/knowledge/query
router.post('/query', async (req, res, next) => {
  try {
    const { question } = req.body;
    if (!question) return res.status(400).json({ error: 'Question required' });

    const result = await WikiQA.query(question, { source: 'tech_field' });
    res.json({ answer: result.answer, sources: result.articleTitles || [] });
  } catch (err) { next(err); }
});

// GET /api/tech/knowledge/lookup?topic=celsius
router.get('/lookup', async (req, res, next) => {
  try {
    const content = await WikiQA.lookup(req.query.topic || '');
    if (!content) return res.json({ found: false, content: null });
    res.json({ found: true, content: content.substring(0, 3000) });
  } catch (err) { next(err); }
});

module.exports = router;
