/**
 * Admin Knowledge Bridge Routes
 *
 * Manage the bridge between Claudeopedia (knowledge_base) and
 * Agronomic Wiki (knowledge_entries). Unified search, auto-linking,
 * sync, and health dashboard.
 */

const express = require('express');
const router = express.Router();
const { adminAuthenticate } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const KnowledgeBridge = require('../services/knowledge-bridge');

router.use(adminAuthenticate);

// =========================================================================
// GET /stats — bridge health dashboard
// =========================================================================
router.get('/stats', async (req, res, next) => {
  try {
    const stats = await KnowledgeBridge.getStats();
    res.json(stats);
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /search?q=... — unified search across both knowledge systems
// =========================================================================
router.get('/search', async (req, res, next) => {
  try {
    const { q, limit } = req.query;
    if (!q?.trim()) return res.json({ claudeopedia: [], wiki: [], bridged: [], totalResults: 0 });
    const results = await KnowledgeBridge.unifiedSearch(q, { limit: limit ? parseInt(limit) : 20 });
    res.json(results);
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /links/:entryId — get all linked entries for a given entry
// =========================================================================
router.get('/links/:entryId', async (req, res, next) => {
  try {
    const { source } = req.query; // 'claudeopedia' | 'wiki' | 'auto'
    const linked = await KnowledgeBridge.getLinkedEntries(req.params.entryId, source || 'auto');
    res.json(linked);
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// POST /link — manually create a link between entries
// Body: { kbEntryId, wikiEntryId, linkType, relevanceScore, linkReason }
// =========================================================================
router.post('/link', async (req, res, next) => {
  try {
    const { kbEntryId, wikiEntryId, linkType, relevanceScore, linkReason } = req.body;

    if (!linkType) return res.status(400).json({ error: 'linkType is required' });
    if (!kbEntryId && !wikiEntryId) return res.status(400).json({ error: 'At least one entry ID is required' });

    const link = await KnowledgeBridge.createLink({
      kbEntryId,
      wikiEntryId,
      linkType,
      relevanceScore,
      linkReason,
      createdBy: 'manual',
    });

    res.json({ success: true, link });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// POST /auto-link — run automatic linking between the two systems
// =========================================================================
router.post('/auto-link', async (req, res, next) => {
  try {
    const stats = await KnowledgeBridge.autoLink();
    res.json({ success: true, ...stats });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// POST /sync — push wiki outcome summaries into Claudeopedia
// =========================================================================
router.post('/sync', async (req, res, next) => {
  try {
    const stats = await KnowledgeBridge.syncToClaudeopedia();
    res.json({ success: true, ...stats });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// POST /recommendations/:assessmentId — manually trigger AI recommendations
// =========================================================================
router.post('/recommendations/:assessmentId', async (req, res, next) => {
  try {
    const result = await KnowledgeBridge.generateAssessmentRecommendations(req.params.assessmentId);
    if (!result) {
      return res.status(400).json({ error: 'Could not generate recommendations' });
    }
    res.json({ success: true, recommendations: result });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /enrich/kb/:id — get wiki outcome enrichment for a KB entry
// =========================================================================
router.get('/enrich/kb/:id', async (req, res, next) => {
  try {
    const enrichment = await KnowledgeBridge.enrichKBEntryWithOutcomes(req.params.id);
    res.json({ enrichment: enrichment || null });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /enrich/wiki/:id — get Claudeopedia reference data for a wiki page
// =========================================================================
router.get('/enrich/wiki/:id', async (req, res, next) => {
  try {
    const enrichment = await KnowledgeBridge.enrichWikiPageWithKB(req.params.id);
    res.json({ enrichment: enrichment || null });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
