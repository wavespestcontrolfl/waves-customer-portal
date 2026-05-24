const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireTechOrAdmin, requireAdmin } = require('../middleware/admin-auth');
const UrlIntelligence = require('../services/seo/url-intelligence');
const {
  claimPipelineRun,
} = require('../services/seo/seo-pipeline-runs');
const { runClaimedSeoPipeline } = require('../services/seo/seo-pipeline-runner');
const logger = require('../services/logger');

router.use(adminAuthenticate, requireTechOrAdmin);

// GET /dashboard — aggregate cards
router.get('/dashboard', async (req, res) => {
  try {
    const data = await UrlIntelligence.getDashboard(req.query.domain);
    res.json(data);
  } catch (err) {
    logger.error('[url-intelligence] dashboard error', err);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

// GET /inspect?url= — full single-URL intelligence
router.get('/inspect', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url parameter required' });
    const data = await UrlIntelligence.getUrlIntelligence(url);
    if (!data) return res.status(404).json({ error: 'URL not found in intelligence layer' });
    res.json(data);
  } catch (err) {
    logger.error('[url-intelligence] inspect error', err);
    res.status(500).json({ error: 'Failed to inspect URL' });
  }
});

// GET /scan?diagnosis=&domain=&status=&limit=&offset= — paginated URL list
router.get('/scan', async (req, res) => {
  try {
    const { diagnosis, domain, limit, offset } = req.query;
    const data = await UrlIntelligence.scanByDiagnosis(
      diagnosis || null,
      domain || null,
      { limit: parseInt(limit) || 50, offset: parseInt(offset) || 0 },
    );
    res.json(data);
  } catch (err) {
    logger.error('[url-intelligence] scan error', err);
    res.status(500).json({ error: 'Failed to scan URLs' });
  }
});

// GET /indexation-gap?domain= — submitted vs indexed breakdown
router.get('/indexation-gap', async (req, res) => {
  try {
    const data = await UrlIntelligence.getIndexationGap(req.query.domain);
    res.json(data);
  } catch (err) {
    logger.error('[url-intelligence] indexation-gap error', err);
    res.status(500).json({ error: 'Failed to compute indexation gap' });
  }
});

// GET /canonical-conflicts?domain= — conflict queue
router.get('/canonical-conflicts', async (req, res) => {
  try {
    const data = await UrlIntelligence.getCanonicalConflicts(req.query.domain);
    res.json(data);
  } catch (err) {
    logger.error('[url-intelligence] canonical-conflicts error', err);
    res.status(500).json({ error: 'Failed to load canonical conflicts' });
  }
});

// POST /refresh — trigger domain or single-URL refresh (admin only)
router.post('/refresh', requireAdmin, async (req, res) => {
  try {
    const { domain, url } = req.body;
    if (url) {
      const result = await UrlIntelligence.refreshUrl(url);
      return res.json({ refreshed: 1, url: result?.url });
    }
    if (domain) {
      const result = await UrlIntelligence.refreshDomain(domain);
      return res.json(result);
    }
    return res.status(400).json({ error: 'domain or url parameter required' });
  } catch (err) {
    logger.error('[url-intelligence] refresh error', err);
    res.status(500).json({ error: 'Refresh failed' });
  }
});

// POST /detect-conflicts — run canonical conflict detection (admin only)
router.post('/detect-conflicts', requireAdmin, async (req, res) => {
  try {
    const result = await UrlIntelligence.detectCanonicalConflicts();
    res.json(result);
  } catch (err) {
    logger.error('[url-intelligence] detect-conflicts error', err);
    res.status(500).json({ error: 'Conflict detection failed' });
  }
});

// GET /experiments?status=&limit= — experiment list
router.get('/experiments', async (req, res) => {
  try {
    const db = require('../models/db');
    let query = db('seo_url_experiments').orderBy('created_at', 'desc');
    if (req.query.status) query = query.where('status', req.query.status);
    const limit = parseInt(req.query.limit) || 20;
    const data = await query.limit(limit);
    res.json(data);
  } catch (err) {
    logger.error('[url-intelligence] experiments error', err);
    res.status(500).json({ error: 'Failed to load experiments' });
  }
});

// POST /sitemap-validate — validate sitemap URLs (admin only)
router.post('/sitemap-validate', requireAdmin, async (req, res) => {
  try {
    const SitemapValidator = require('../services/seo/sitemap-validator');
    const result = await SitemapValidator.validateDomain(req.body.domain || 'wavespestcontrol.com');
    res.json(result);
  } catch (err) {
    logger.error('[url-intelligence] sitemap-validate error', err);
    res.status(500).json({ error: 'Sitemap validation failed' });
  }
});

// GET /sitemap-issues?domain=&issueType=&status= — sitemap issue list
router.get('/sitemap-issues', async (req, res) => {
  try {
    const SitemapValidator = require('../services/seo/sitemap-validator');
    const summary = await SitemapValidator.getSummary(req.query.domain);
    const issues = await SitemapValidator.getIssues(req.query.domain, {
      issueType: req.query.issueType,
      status: req.query.status,
      limit: parseInt(req.query.limit) || 50,
      offset: parseInt(req.query.offset) || 0,
    });
    res.json({ ...summary, issues });
  } catch (err) {
    logger.error('[url-intelligence] sitemap-issues error', err);
    res.status(500).json({ error: 'Failed to load sitemap issues' });
  }
});

// POST /detect-duplicates — run body similarity detection (admin only)
router.post('/detect-duplicates', requireAdmin, async (req, res) => {
  try {
    const result = await UrlIntelligence.buildDuplicateClusters(req.body.domain || 'wavespestcontrol.com');
    res.json(result);
  } catch (err) {
    logger.error('[url-intelligence] detect-duplicates error', err);
    res.status(500).json({ error: 'Duplicate detection failed' });
  }
});

// GET /duplicate-clusters?domain= — duplicate URL clusters
router.get('/duplicate-clusters', async (req, res) => {
  try {
    const data = await UrlIntelligence.getDuplicateClusters(req.query.domain);
    res.json(data);
  } catch (err) {
    logger.error('[url-intelligence] duplicate-clusters error', err);
    res.status(500).json({ error: 'Failed to load duplicate clusters' });
  }
});

// POST /build-intent-map — build intent routing map (admin only)
router.post('/build-intent-map', requireAdmin, async (req, res) => {
  try {
    const result = await UrlIntelligence.buildIntentMap(req.body.domain || 'wavespestcontrol.com');
    res.json(result);
  } catch (err) {
    logger.error('[url-intelligence] build-intent-map error', err);
    res.status(500).json({ error: 'Intent map build failed' });
  }
});

// GET /intent-routes?domain=&misrouteType=&severity= — intent route list
router.get('/intent-routes', async (req, res) => {
  try {
    const data = await UrlIntelligence.getIntentRoutes(req.query.domain, {
      misrouteType: req.query.misrouteType,
      severity: req.query.severity,
      limit: parseInt(req.query.limit) || 50,
      offset: parseInt(req.query.offset) || 0,
    });
    res.json(data);
  } catch (err) {
    logger.error('[url-intelligence] intent-routes error', err);
    res.status(500).json({ error: 'Failed to load intent routes' });
  }
});

// POST /build-link-graph — build internal link graph (admin only)
router.post('/build-link-graph', requireAdmin, async (req, res) => {
  try {
    const result = await UrlIntelligence.buildInternalLinkGraph(req.body.domain || 'wavespestcontrol.com');
    res.json(result);
  } catch (err) {
    logger.error('[url-intelligence] build-link-graph error', err);
    res.status(500).json({ error: 'Link graph build failed' });
  }
});

// GET /orphan-pages?domain= — pages with < 2 inbound links
router.get('/orphan-pages', async (req, res) => {
  try {
    const data = await UrlIntelligence.getOrphanPages(req.query.domain);
    res.json(data);
  } catch (err) {
    logger.error('[url-intelligence] orphan-pages error', err);
    res.status(500).json({ error: 'Failed to load orphan pages' });
  }
});

// POST /run-pipeline — run the full SEO pipeline end-to-end (admin only)
// Chains: GSC sync → site audit → URL Intelligence refresh → detection engines
router.post('/run-pipeline', requireAdmin, async (req, res) => {
  const domain = req.body.domain || 'wavespestcontrol.com';
  const requestedDaysBack = parseInt(req.body.daysBack || 7, 10);
  const daysBack = Number.isFinite(requestedDaysBack) && requestedDaysBack > 0 ? requestedDaysBack : 7;
  const idempotencyKey = req.body.idempotencyKey
    || req.body.idempotency_key
    || `seo-pipeline:${domain}:${daysBack}:${Math.floor(Date.now() / 60000)}`;
  let pipelineRun = null;

  try {
    const claim = await claimPipelineRun({
      domain,
      idempotencyKey,
      requestedBy: req.technicianId || null,
    });
    if (claim.error) return res.status(400).json({ error: claim.error });
    if (!claim.claimed) {
      return res.status(claim.run.status === 'running' ? 202 : 200).json({
        status: claim.run.status,
        domain: claim.run.domain,
        idempotencyKey,
        deduped: true,
        started_at: claim.run.started_at,
        completed_at: claim.run.completed_at,
        result: claim.run.result || null,
      });
    }
    pipelineRun = claim.run;
  } catch (err) {
    logger.error('[pipeline] claim failed', err);
    return res.status(500).json({ error: 'Pipeline claim failed' });
  }

  // Return immediately with 202, run pipeline in background
  res.status(202).json({
    status: 'started',
    domain: pipelineRun.domain,
    idempotencyKey,
    run_id: pipelineRun.id,
    message: 'Pipeline running in background. Check /dashboard for results.',
  });

  runClaimedSeoPipeline({
    pipelineRun,
    domain: pipelineRun.domain,
    daysBack,
    logPrefix: 'pipeline',
  }).catch((err) => logger.error(`[pipeline] background runner failed: ${err.message}`, err));
});

module.exports = router;
