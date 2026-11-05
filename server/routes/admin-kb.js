const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireTechOrAdmin, requireAdmin } = require('../middleware/admin-auth');
const KBService = require('../services/knowledge-base');
const logger = require('../services/logger');
const {
  TECHNICIAN_KNOWLEDGE_CATEGORIES, knowledgeAudience, technicianKnowledgeRow, technicianKnowledgeRows,
} = require('../services/knowledge/technician-categories');

router.use(adminAuthenticate, requireTechOrAdmin);
// A technician reads the knowledge base; every write, verify, flag and paid
// job below is owner-only here too, not only behind GATE_STAFF_DEFAULT_DENY
// (KnowledgeBasePage hides them from technicians; operations audit OP-13).

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
    // A technician reads field categories only, vendor prices removed.
    const technician = Boolean(knowledgeAudience(req));
    const results = await KBService.search(q, {
      category, limit: parseInt(limit) || 20,
      ...(technician ? { categories: TECHNICIAN_KNOWLEDGE_CATEGORIES } : {}),
    });
    res.json({ results: technician ? technicianKnowledgeRows(results) : results, query: q });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════
// LIST
// ═══════════════════════════════════════════
router.get('/', async (req, res, next) => {
  try {
    const { category, status, confidence, limit = 50, page = 1, sort, order } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const technician = Boolean(knowledgeAudience(req));
    const { entries, total } = await KBService.list({
      category, status, confidence,
      limit: parseInt(limit), offset,
      sort: sort || 'updated_at', order: order || 'desc',
      ...(technician ? { categories: TECHNICIAN_KNOWLEDGE_CATEGORIES } : {}),
    });
    res.json({ entries: technician ? technicianKnowledgeRows(entries) : entries, total, page: parseInt(page) });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════
// GET SINGLE
// ═══════════════════════════════════════════
router.get('/:id', async (req, res, next) => {
  try {
    const entry = await KBService.getById(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found' });
    if (knowledgeAudience(req)) {
      // Audit findings quote the article, so a technician gets the field article alone.
      const fieldEntry = technicianKnowledgeRow(entry);
      if (!fieldEntry) return res.status(404).json({ error: 'Not found' });
      return res.json({ entry: fieldEntry, audits: [] });
    }
    const audits = await KBService.getAudits(req.params.id);
    res.json({ entry, audits });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════
// CREATE
// ═══════════════════════════════════════════
router.post('/', requireAdmin, async (req, res, next) => {
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
router.put('/:id', requireAdmin, async (req, res, next) => {
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
router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    await KBService.delete(req.params.id);
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════
// VERIFY (mark as reviewed / high-confidence)
// ═══════════════════════════════════════════
router.post('/:id/verify', requireAdmin, async (req, res, next) => {
  try {
    const entry = await KBService.verify(req.params.id, req.body.verifiedBy || 'waves');
    res.json(entry);
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════
// FLAG
// ═══════════════════════════════════════════
router.post('/:id/flag', requireAdmin, async (req, res, next) => {
  try {
    const entry = await KBService.flag(req.params.id, req.body.reason);
    res.json(entry);
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════
// AI AUDIT — run manually or from cron
// ═══════════════════════════════════════════
router.post('/audit/run', requireAdmin, async (req, res, next) => {
  try {
    const { maxEntries, forceAll, flaggedOnly } = req.body;
    const result = await KBService.runAIAudit({ maxEntries: maxEntries || 10, forceAll: !!forceAll, flaggedOnly: !!flaggedOnly });
    res.json(result);
  } catch (err) { next(err); }
});

// POST /auto-sync — trigger auto-sync from live data sources
router.post('/auto-sync', requireAdmin, async (req, res, next) => {
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

router.post('/tokens/check', requireAdmin, async (req, res, next) => {
  try {
    const result = await KBService.checkTokenHealth();
    res.json(result);
  } catch (err) { next(err); }
});

module.exports = router;
