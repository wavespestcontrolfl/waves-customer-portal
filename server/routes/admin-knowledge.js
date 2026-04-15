const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const WikiCompiler = require('../services/knowledge/wiki-compiler');
const WikiQA = require('../services/knowledge/wiki-qa');
const WikiLinter = require('../services/knowledge/wiki-linter');
const logger = require('../services/logger');

router.use(adminAuthenticate, requireTechOrAdmin);

// =========================================================================
// ARTICLES
// =========================================================================

// GET /api/admin/knowledge — list articles
router.get('/', async (req, res, next) => {
  try {
    const { category, search, active = 'true' } = req.query;

    let query = db('knowledge_base');
    if (active === 'true') query = query.where('active', true);
    if (category) query = query.where('category', category);
    if (search) {
      query = query.where(function () {
        this.where('title', 'ilike', `%${search}%`)
          .orWhere('summary', 'ilike', `%${search}%`)
          .orWhereRaw("tags::text ILIKE ?", [`%${search}%`]);
      });
    }

    const articles = await query
      .whereNot('path', 'like', 'wiki/_%')
      .orderBy('category')
      .orderBy('title')
      .select('id', 'path', 'title', 'category', 'summary', 'tags', 'word_count', 'last_compiled', 'last_verified', 'version');

    // Category counts
    const counts = await db('knowledge_base')
      .where('active', true)
      .whereNot('path', 'like', 'wiki/_%')
      .select('category')
      .count('* as count')
      .groupBy('category');

    const categoryCounts = {};
    counts.forEach(c => { categoryCounts[c.category] = parseInt(c.count); });

    res.json({ articles, categoryCounts, total: articles.length });
  } catch (err) { next(err); }
});

// GET /api/admin/knowledge/article/:id — single article
router.get('/article/:id', async (req, res, next) => {
  try {
    const article = await db('knowledge_base').where('id', req.params.id).first();
    if (!article) return res.status(404).json({ error: 'Article not found' });

    // Parse JSON fields
    if (typeof article.tags === 'string') article.tags = JSON.parse(article.tags);
    if (typeof article.backlinks === 'string') article.backlinks = JSON.parse(article.backlinks);
    if (typeof article.source_documents === 'string') article.source_documents = JSON.parse(article.source_documents);

    res.json({ article });
  } catch (err) { next(err); }
});

// PUT /api/admin/knowledge/article/:id — update article
router.put('/article/:id', async (req, res, next) => {
  try {
    const updates = { ...req.body, updated_at: new Date() };
    if (updates.content) {
      updates.word_count = updates.content.split(/\s+/).filter(Boolean).length;
    }
    if (updates.tags && Array.isArray(updates.tags)) {
      updates.tags = JSON.stringify(updates.tags);
    }
    const [article] = await db('knowledge_base').where('id', req.params.id).update(updates).returning('*');
    res.json({ article });
  } catch (err) { next(err); }
});

// POST /api/admin/knowledge/article/:id/verify — mark as human-verified
router.post('/article/:id/verify', async (req, res, next) => {
  try {
    await db('knowledge_base').where('id', req.params.id).update({ last_verified: new Date(), updated_at: new Date() });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// =========================================================================
// Q&A
// =========================================================================

// POST /api/admin/knowledge/query — ask a question
router.post('/query', async (req, res, next) => {
  try {
    const { question, source } = req.body;
    if (!question) return res.status(400).json({ error: 'Question required' });

    const result = await WikiQA.query(question, { source: source || 'admin_manual' });
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/admin/knowledge/queries — recent queries
router.get('/queries', async (req, res, next) => {
  try {
    const queries = await db('knowledge_queries')
      .orderBy('created_at', 'desc')
      .limit(30);
    res.json({ queries });
  } catch (err) { next(err); }
});

// POST /api/admin/knowledge/queries/:id/rate — rate a response
router.post('/queries/:id/rate', async (req, res, next) => {
  try {
    await db('knowledge_queries').where('id', req.params.id).update({ response_quality: req.body.rating });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/admin/knowledge/file-back — file a Q&A answer back into the wiki
router.post('/file-back', async (req, res, next) => {
  try {
    const result = await WikiQA.fileBack(req.body.queryId);
    res.json(result);
  } catch (err) { next(err); }
});

// =========================================================================
// SEARCH
// =========================================================================

// GET /api/admin/knowledge/search?q=term
router.get('/search', async (req, res, next) => {
  try {
    const results = await WikiQA.search(req.query.q || '', parseInt(req.query.limit || 20));
    res.json({ results });
  } catch (err) { next(err); }
});

// =========================================================================
// SOURCES
// =========================================================================

// GET /api/admin/knowledge/sources
router.get('/sources', async (req, res, next) => {
  try {
    const sources = await db('knowledge_sources').orderBy('created_at', 'desc');
    res.json({ sources });
  } catch (err) { next(err); }
});

// POST /api/admin/knowledge/sources — add a new source
router.post('/sources', async (req, res, next) => {
  try {
    const { filename, file_path, file_type, description } = req.body;
    const [source] = await db('knowledge_sources').insert({
      filename, file_path, file_type, description,
    }).returning('*');
    res.json({ source });
  } catch (err) { next(err); }
});

// =========================================================================
// COMPILE
// =========================================================================

// POST /api/admin/knowledge/compile — compile a specific source
router.post('/compile', async (req, res, next) => {
  try {
    const { sourceId } = req.body;
    const result = await WikiCompiler.compileSource(sourceId);
    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/admin/knowledge/compile-all — compile all unprocessed sources
router.post('/compile-all', async (req, res, next) => {
  try {
    const results = await WikiCompiler.compileAllUnprocessed();
    res.json({ results });
  } catch (err) { next(err); }
});

// POST /api/admin/knowledge/rebuild-index
router.post('/rebuild-index', async (req, res, next) => {
  try {
    await WikiCompiler.rebuildIndex();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/admin/knowledge/seed-wiki-folder
// Registers and compiles every .md file under /wiki at repo root.
router.post('/seed-wiki-folder', async (req, res, next) => {
  try {
    const result = await WikiCompiler.seedFromWikiFolder();
    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/admin/knowledge/import-blog-posts
// Body: { tagFilter?: string, limit?: number }
// Groups blog posts by tag and compiles each cluster into a set of KB articles.
router.post('/import-blog-posts', async (req, res, next) => {
  try {
    const { tagFilter, limit } = req.body || {};
    const result = await WikiCompiler.importBlogPosts({ tagFilter, limit: limit ? parseInt(limit) : undefined });
    res.json(result);
  } catch (err) { next(err); }
});

// =========================================================================
// HEALTH CHECK
// =========================================================================

// GET /api/admin/knowledge/health
router.get('/health', async (req, res, next) => {
  try {
    const result = await WikiLinter.runHealthCheck();
    res.json(result);
  } catch (err) { next(err); }
});

module.exports = router;
