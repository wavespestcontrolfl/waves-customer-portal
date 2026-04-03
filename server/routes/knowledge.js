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
    const { rating } = req.body; // 1-5
    await getDb()('knowledge_queries').where('id', req.params.id).update({ response_quality: rating });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
        const appendText = `\n\n---\n## Q&A (filed ${new Date().toLocaleDateString()})\n**Q:** ${query.query}\n\n**A:** ${query.answer}`;
        await getDb()('knowledge_base').where('id', first.id).update({
          content: first.content + appendText,
          word_count: (first.word_count || 0) + appendText.split(/\s+/).length,
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
