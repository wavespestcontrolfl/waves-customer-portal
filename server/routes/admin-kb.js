const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const KBService = require('../services/knowledge-base');
const logger = require('../services/logger');

router.use(adminAuthenticate, requireTechOrAdmin);

// ═══════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════
router.get('/stats', async (req, res, next) => {
  try {
    const stats = await KBService.getStats();
    res.json(stats);
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════
// SEARCH
// ═══════════════════════════════════════════
router.get('/search', async (req, res, next) => {
  try {
    const { q, category, limit } = req.query;
    if (!q) return res.status(400).json({ error: 'q param required' });
    const results = await KBService.search(q, { category, limit: parseInt(limit) || 20 });
    res.json({ results, query: q });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════
// LIST
// ═══════════════════════════════════════════
router.get('/', async (req, res, next) => {
  try {
    const { category, status, confidence, limit = 50, page = 1, sort, order } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const { entries, total } = await KBService.list({
      category, status, confidence,
      limit: parseInt(limit), offset,
      sort: sort || 'updated_at', order: order || 'desc',
    });
    res.json({ entries, total, page: parseInt(page) });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════
// GET SINGLE
// ═══════════════════════════════════════════
router.get('/:id', async (req, res, next) => {
  try {
    const entry = await KBService.getById(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found' });
    const audits = await KBService.getAudits(req.params.id);
    res.json({ entry, audits });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════
// CREATE
// ═══════════════════════════════════════════
router.post('/', async (req, res, next) => {
  try {
    const { title, content, category, tags, source, confidence, metadata } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    const entry = await KBService.create({ title, content, category, tags, source, confidence, metadata });
    logger.info(`[kb] Created: ${entry.title} (${entry.slug})`);
    res.status(201).json(entry);
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════
// UPDATE
// ═══════════════════════════════════════════
router.put('/:id', async (req, res, next) => {
  try {
    const entry = await KBService.update(req.params.id, req.body);
    if (!entry) return res.status(404).json({ error: 'Not found' });
    logger.info(`[kb] Updated: ${entry.title}`);
    res.json(entry);
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════
// DELETE
// ═══════════════════════════════════════════
router.delete('/:id', async (req, res, next) => {
  try {
    await KBService.delete(req.params.id);
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════
// VERIFY (mark as reviewed / high-confidence)
// ═══════════════════════════════════════════
router.post('/:id/verify', async (req, res, next) => {
  try {
    const entry = await KBService.verify(req.params.id, req.body.verifiedBy || 'waves');
    res.json(entry);
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════
// FLAG
// ═══════════════════════════════════════════
router.post('/:id/flag', async (req, res, next) => {
  try {
    const entry = await KBService.flag(req.params.id, req.body.reason);
    res.json(entry);
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════
// AI AUDIT — run manually or from cron
// ═══════════════════════════════════════════
router.post('/audit/run', async (req, res, next) => {
  try {
    const { maxEntries, forceAll } = req.body;
    const result = await KBService.runAIAudit({ maxEntries: maxEntries || 10, forceAll: !!forceAll });
    res.json(result);
  } catch (err) { next(err); }
});

// POST /auto-sync — trigger auto-sync from live data sources
router.post('/auto-sync', async (req, res, next) => {
  try {
    const result = await KBService.autoSync();
    res.json(result);
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════
// TOKEN HEALTH
// ═══════════════════════════════════════════
router.get('/tokens/status', async (req, res, next) => {
  try {
    const tokens = await KBService.getTokenStatus();
    res.json({ tokens });
  } catch (err) { next(err); }
});

router.post('/tokens/check', async (req, res, next) => {
  try {
    const result = await KBService.checkTokenHealth();
    res.json(result);
  } catch (err) { next(err); }
});

module.exports = router;
