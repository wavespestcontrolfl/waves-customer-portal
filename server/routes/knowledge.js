// server/routes/knowledge.js
const router = require('express').Router();
const WikiQA = require('../services/knowledge/wiki-qa');

let db;
function getDb() {
  if (!db) db = require('../models/db');
  return db;
}

// GET /api/knowledge — list all articles
router.get('/', async (req, res) => {
  try {
    const { category, search } = req.query;
    if (search) {
      const results = await WikiQA.search(search);
      return res.json(results);
    }
    if (category) {
      const results = await WikiQA.getCategory(category);
      return res.json(results);
    }
    const all = await WikiQA.listAll();
    res.json(all);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/knowledge/article?path=wiki/protocols/routing-rules.md
router.get('/article', async (req, res) => {
  try {
    const { path: articlePath } = req.query;
    if (!articlePath) return res.status(400).json({ error: 'path required' });
    const article = await getDb()('knowledge_base').where('path', articlePath).first();
    if (!article) return res.status(404).json({ error: 'Article not found' });
    res.json(article);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/knowledge/query
// Body: { question, context? }
router.post('/query', async (req, res) => {
  try {
    const { question, context } = req.body;
    if (!question) return res.status(400).json({ error: 'question required' });
    const result = await WikiQA.query(question, context || {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/knowledge/queries — recent query log
router.get('/queries', async (req, res) => {
  try {
    const queries = await getDb()('knowledge_queries').orderBy('created_at', 'desc').limit(50);
    res.json(queries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/knowledge/queries/:id/rate
router.post('/queries/:id/rate', async (req, res) => {
  try {
    const rating = parseInt(req.body?.rating, 10);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'rating must be an integer between 1 and 5' });
    }
    await getDb()('knowledge_queries').where('id', req.params.id).update({ response_quality: rating });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Markdown structural tokens that would let a user-supplied Q/A break out
// of the intended block (headings, fences, HTML tags). Strip/escape them
// before the text is appended to a published article.
function sanitizeMarkdown(input, max = 2000) {
  if (!input) return '';
  let s = String(input).slice(0, max);
  s = s.replace(/<[^>]*>/g, '');           // no raw HTML
  s = s.replace(/```+/g, '`\u200B`\u200B`'); // break code fences
  s = s.replace(/^(#{1,6})\s/gm, '$1\u200B '); // break headings
  s = s.replace(/\r/g, '');
  return s.trim();
}

// POST /api/knowledge/queries/:id/file-back
// Files a Q&A answer back into the wiki as enrichment
router.post('/queries/:id/file-back', async (req, res) => {
  try {
    const query = await getDb()('knowledge_queries').where('id', req.params.id).first();
    if (!query) return res.status(404).json({ error: 'Query not found' });

    const paths = query.articles_referenced || [];
    if (paths.length) {
      const first = await getDb()('knowledge_base').where('path', paths[0]).first();
      if (first) {
        const q = sanitizeMarkdown(query.query, 1000);
        const a = sanitizeMarkdown(query.answer, 4000);
        const appendText = `\n\n---\n## Q&A (filed ${new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' })})\n**Q:** ${q}\n\n**A:** ${a}`;
        // Cap word_count contribution so an oversized answer can't poison the column.
        const addedWords = Math.min(appendText.split(/\s+/).length, 1000);
        await getDb()('knowledge_base').where('id', first.id).update({
          content: first.content + appendText,
          word_count: (first.word_count || 0) + addedWords,
          updated_at: new Date(),
        });
      }
    }
    await getDb()('knowledge_queries').where('id', req.params.id).update({ filed_back: true });
    res.json({ ok: true, filedTo: paths[0] || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
