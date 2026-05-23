const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireTechOrAdmin, requireAdmin } = require('../middleware/admin-auth');
const UrlIntelligence = require('../services/seo/url-intelligence');
const {
  claimPipelineRun,
  completePipelineRun,
  failPipelineRun,
} = require('../services/seo/seo-pipeline-runs');
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
  const daysBack = req.body.daysBack || 7;
  const idempotencyKey = req.body.idempotencyKey
    || req.body.idempotency_key
    || `seo-pipeline:${domain}:${daysBack}:${Math.floor(Date.now() / 60000)}`;
  let pipelineRun = null;
  const steps = [];
  const start = Date.now();

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
    domain,
    idempotencyKey,
    run_id: pipelineRun.id,
    message: 'Pipeline running in background. Check /dashboard for results.',
  });

  try {
    // Step 1: GSC sync (query + page + query-page map)
    logger.info(`[pipeline] Step 1/8: GSC sync for ${domain}`);
    try {
      const SearchConsole = require('../services/seo/search-console-v2');
      const gscResult = await SearchConsole.syncDailyData(daysBack, domain);
      steps.push({ step: 'gsc_sync', status: 'ok', detail: gscResult });
    } catch (err) {
      steps.push({ step: 'gsc_sync', status: 'failed', error: err.message });
      logger.warn(`[pipeline] GSC sync failed: ${err.message}`);
    }

    // Step 2: Site audit (fetches pages, computes body_text_5k + internal_link_targets)
    logger.info(`[pipeline] Step 2/8: Site audit for ${domain}`);
    try {
      const SiteAuditor = require('../services/seo/site-auditor');
      const auditResult = await SiteAuditor.runSiteAudit({ domain });
      steps.push({ step: 'site_audit', status: 'ok', pages: Number(auditResult?.pages || 0) });
    } catch (err) {
      steps.push({ step: 'site_audit', status: 'failed', error: err.message });
      logger.warn(`[pipeline] Site audit failed: ${err.message}`);
    }

    // Step 3: URL Intelligence refresh
    logger.info(`[pipeline] Step 3/8: URL Intelligence refresh for ${domain}`);
    try {
      const refreshResult = await UrlIntelligence.refreshDomain(domain);
      steps.push({ step: 'url_intelligence_refresh', status: 'ok', ...refreshResult });
    } catch (err) {
      steps.push({ step: 'url_intelligence_refresh', status: 'failed', error: err.message });
      logger.warn(`[pipeline] URL Intelligence refresh failed: ${err.message}`);
    }

    // Step 4: Sitemap validation
    logger.info(`[pipeline] Step 4/8: Sitemap validation for ${domain}`);
    try {
      const SitemapValidator = require('../services/seo/sitemap-validator');
      const sitemapResult = await SitemapValidator.validateDomain(domain);
      steps.push({ step: 'sitemap_validation', status: 'ok', ...sitemapResult });
    } catch (err) {
      steps.push({ step: 'sitemap_validation', status: 'failed', error: err.message });
      logger.warn(`[pipeline] Sitemap validation failed: ${err.message}`);
    }

    // Step 5: Duplicate cluster detection
    logger.info(`[pipeline] Step 5/8: Duplicate detection for ${domain}`);
    try {
      const dupResult = await UrlIntelligence.buildDuplicateClusters(domain);
      steps.push({ step: 'duplicate_detection', status: 'ok', ...dupResult });
    } catch (err) {
      steps.push({ step: 'duplicate_detection', status: 'failed', error: err.message });
      logger.warn(`[pipeline] Duplicate detection failed: ${err.message}`);
    }

    // Step 6: Intent routing map + internal link graph
    logger.info(`[pipeline] Step 6/8: Intent map + link graph for ${domain}`);
    try {
      const [intentResult, linkResult] = await Promise.allSettled([
        UrlIntelligence.buildIntentMap(domain),
        UrlIntelligence.buildInternalLinkGraph(domain),
      ]);
      steps.push({
        step: 'intent_map',
        status: intentResult.status === 'fulfilled' ? 'ok' : 'failed',
        ...(intentResult.status === 'fulfilled' ? intentResult.value : { error: intentResult.reason?.message }),
      });
      steps.push({
        step: 'link_graph',
        status: linkResult.status === 'fulfilled' ? 'ok' : 'failed',
        ...(linkResult.status === 'fulfilled' ? linkResult.value : { error: linkResult.reason?.message }),
      });
    } catch (err) {
      steps.push({ step: 'intent_map_and_link_graph', status: 'failed', error: err.message });
    }

    // Step 7: Cannibalization detection + canonical conflict detection
    logger.info(`[pipeline] Step 7/8: Cannibalization + canonical conflicts`);
    try {
      const Cannibalization = require('../services/seo/cannibalization');
      const [cannibalResult, conflictResult] = await Promise.allSettled([
        Cannibalization.detect(domain),
        UrlIntelligence.detectCanonicalConflicts(),
      ]);
      steps.push({
        step: 'cannibalization',
        status: cannibalResult.status === 'fulfilled' ? 'ok' : 'failed',
        ...(cannibalResult.status === 'fulfilled' ? cannibalResult.value : { error: cannibalResult.reason?.message }),
      });
      steps.push({
        step: 'canonical_conflicts',
        status: conflictResult.status === 'fulfilled' ? 'ok' : 'failed',
        ...(conflictResult.status === 'fulfilled' ? conflictResult.value : { error: conflictResult.reason?.message }),
      });
    } catch (err) {
      steps.push({ step: 'cannibalization_and_conflicts', status: 'failed', error: err.message });
    }

    // Step 8: Generate SEO actions from diagnoses + auto-approve
    logger.info(`[pipeline] Step 8/8: Generate actions for ${domain}`);
    try {
      const SeoActionGenerator = require('../services/seo/seo-action-generator');
      const diagnosisResult = await UrlIntelligence.refreshDiagnoses(domain);
      steps.push({ step: 'diagnosis_refresh', status: 'ok', ...diagnosisResult });
      const actionResult = await SeoActionGenerator.generateActionsFromDiagnosis(domain);
      steps.push({ step: 'action_generation', status: 'ok', ...actionResult });
      const autoResult = await SeoActionGenerator.autoApprove(domain);
      steps.push({ step: 'auto_approve', status: 'ok', ...autoResult });
    } catch (err) {
      steps.push({ step: 'action_generation', status: 'failed', error: err.message });
      logger.warn(`[pipeline] Action generation failed: ${err.message}`);
    }

    const duration = Date.now() - start;
    const succeeded = steps.filter((s) => s.status === 'ok').length;
    const failed = steps.filter((s) => s.status === 'failed').length;

    logger.info(`[pipeline] Complete: ${succeeded} succeeded, ${failed} failed, ${duration}ms`, { steps });
    await completePipelineRun(
      pipelineRun.id,
      { steps, duration_ms: duration, succeeded, failed },
      failed > 0 ? 'completed_with_errors' : 'completed',
    );
  } catch (err) {
    logger.error(`[pipeline] Fatal error: ${err.message}`, err);
    if (pipelineRun?.id) {
      await failPipelineRun(pipelineRun.id, err)
        .catch((persistErr) => logger.warn(`[pipeline] failed to persist fatal status: ${persistErr.message}`));
    }
  }
});

module.exports = router;
