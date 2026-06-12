const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin, requireAdmin } = require('../middleware/admin-auth');
const SearchConsole = require('../services/seo/search-console-v2');
const SEOAdvisor = require('../services/seo/seo-advisor');
const logger = require('../services/logger');
const { etDateString, addETDays } = require('../utils/datetime-et');

router.use(adminAuthenticate, requireTechOrAdmin);

function normalizeDomain(value) {
  if (!value) return null;
  return String(value)
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

function applyDomainFilter(query, domain) {
  const normalized = normalizeDomain(domain);
  return normalized ? query.where('domain', normalized) : query;
}

// =========================================================================
// GSC DASHBOARD — sitewide metrics
// =========================================================================

// GET /api/admin/seo/dashboard?period=28&domain=bradentonflpestcontrol.com
router.get('/dashboard', async (req, res, next) => {
  try {
    const periodDays = parseInt(req.query.period || 28);
    const domain = req.query.domain || null;
    const summary = await SearchConsole.getPerformanceSummary(periodDays, domain);
    res.json(summary);
  } catch (err) { next(err); }
});

// =========================================================================
// QUERIES
// =========================================================================

// GET /api/admin/seo/queries?period=28&branded=false&service=pest&city=bradenton
router.get('/queries', async (req, res, next) => {
  try {
    const { period = 28, branded, service, city, domain, sort = 'clicks', limit = 100 } = req.query;
    const since = etDateString(addETDays(new Date(), -parseInt(period)));

    let query = applyDomainFilter(db('gsc_queries')
      .where('date', '>=', since)
      .select('query', 'is_branded', 'service_category', 'city_target', 'intent_type')
      .sum('clicks as clicks')
      .sum('impressions as impressions')
      .avg('position as avg_position')
      .groupBy('query', 'is_branded', 'service_category', 'city_target', 'intent_type'), domain);

    if (branded === 'true') query = query.where('is_branded', true);
    if (branded === 'false') query = query.where('is_branded', false);
    if (service) query = query.where('service_category', service);
    if (city) query = query.where('city_target', city);

    const safeSort = ['clicks', 'impressions', 'position'].includes(sort) ? sort : 'clicks';
    const rows = await query.orderBy(safeSort === 'position' ? 'avg_position' : safeSort, safeSort === 'position' ? 'asc' : 'desc').limit(parseInt(limit));

    res.json({
      queries: rows.map(r => ({
        ...r,
        clicks: parseInt(r.clicks),
        impressions: parseInt(r.impressions),
        avg_position: parseFloat(parseFloat(r.avg_position).toFixed(1)),
        ctr: parseInt(r.impressions) > 0 ? Math.round((parseInt(r.clicks) / parseInt(r.impressions)) * 10000) / 100 : 0,
      })),
    });
  } catch (err) { next(err); }
});

// =========================================================================
// RANKINGS MONITOR — per-page position before/now + change annotations
// =========================================================================

// GET /api/admin/seo/rankings-monitor?period=90&domain=&type=&limit=200
//
// Current window (last `period` ET days) vs the equal prior window, per
// canonical page URL, with META/CONTENT/LINKS/SCHEMA chips joined from the
// content-engine and SEO-action history. Read-only.
router.get('/rankings-monitor', async (req, res, next) => {
  try {
    const RankingsMonitor = require('../services/seo/rankings-monitor');
    const period = Math.min(Math.max(parseInt(req.query.period, 10) || 90, 7), 180);
    const result = await RankingsMonitor.build({
      periodDays: period,
      domain: normalizeDomain(req.query.domain) || null,
      type: req.query.type || null,
      limit: req.query.limit,
    });
    res.json(result);
  } catch (err) { next(err); }
});

// =========================================================================
// PAGES
// =========================================================================

// GET /api/admin/seo/pages?period=28&type=city
router.get('/pages', async (req, res, next) => {
  try {
    const { period = 28, type, service, city, domain, sort = 'clicks', limit = 50 } = req.query;
    const since = etDateString(addETDays(new Date(), -parseInt(period)));

    let query = applyDomainFilter(db('gsc_pages')
      .where('date', '>=', since)
      .select('page_url', 'page_type', 'service_category', 'city_target')
      .sum('clicks as clicks')
      .sum('impressions as impressions')
      .avg('position as avg_position')
      .groupBy('page_url', 'page_type', 'service_category', 'city_target'), domain);

    if (type) query = query.where('page_type', type);
    if (service) query = query.where('service_category', service);
    if (city) query = query.where('city_target', city);

    const safeSort = ['clicks', 'impressions', 'position'].includes(sort) ? sort : 'clicks';
    const rows = await query.orderBy(safeSort === 'position' ? 'avg_position' : safeSort, safeSort === 'position' ? 'asc' : 'desc').limit(parseInt(limit));

    res.json({
      pages: rows.map(r => ({
        ...r,
        clicks: parseInt(r.clicks),
        impressions: parseInt(r.impressions),
        avg_position: parseFloat(parseFloat(r.avg_position).toFixed(1)),
        ctr: parseInt(r.impressions) > 0 ? Math.round((parseInt(r.clicks) / parseInt(r.impressions)) * 10000) / 100 : 0,
      })),
    });
  } catch (err) { next(err); }
});

// =========================================================================
// CORE WEB VITALS
// =========================================================================

// GET /api/admin/seo/cwv
router.get('/cwv', async (req, res, next) => {
  try {
    const cwv = await db('gsc_core_web_vitals')
      .orderBy('date', 'desc')
      .limit(20);

    // Summarize by device
    const byDevice = {};
    for (const c of cwv) {
      const d = c.device || 'unknown';
      if (!byDevice[d]) byDevice[d] = [];
      byDevice[d].push(c);
    }

    res.json({ cwv, byDevice });
  } catch (err) { next(err); }
});

// =========================================================================
// INDEXING ISSUES
// =========================================================================

// GET /api/admin/seo/indexing
router.get('/indexing', async (req, res, next) => {
  try {
    const issues = await db('gsc_indexing_issues')
      .orderBy('last_seen', 'desc');

    const active = issues.filter(i => i.status === 'active');
    const resolved = issues.filter(i => i.status === 'resolved');

    res.json({ active, resolved, totalActive: active.length });
  } catch (err) { next(err); }
});

// =========================================================================
// GBP PERFORMANCE
// =========================================================================

// GET /api/admin/seo/gbp?period=28
router.get('/gbp', async (req, res, next) => {
  try {
    const period = parseInt(req.query.period || 28);
    const since = etDateString(addETDays(new Date(), -period));

    const rows = await db('gbp_performance_daily').where('date', '>=', since);

    // By location
    const byLocation = {};
    for (const r of rows) {
      const loc = r.location_name || r.location_id;
      if (!byLocation[loc]) byLocation[loc] = { calls: 0, websiteClicks: 0, directionRequests: 0, bookings: 0, searchViews: 0, mapsViews: 0, photoViews: 0, days: 0 };
      byLocation[loc].calls += r.calls || 0;
      byLocation[loc].websiteClicks += r.website_clicks || 0;
      byLocation[loc].directionRequests += r.direction_requests || 0;
      byLocation[loc].bookings += r.bookings || 0;
      byLocation[loc].searchViews += r.search_views || 0;
      byLocation[loc].mapsViews += r.maps_views || 0;
      byLocation[loc].photoViews += r.photo_views || 0;
      byLocation[loc].days++;
    }

    // Daily trend
    const daily = {};
    for (const r of rows) {
      const d = typeof r.date === 'string' ? r.date.split('T')[0] : new Date(r.date).toISOString().split('T')[0];
      if (!daily[d]) daily[d] = { date: d, calls: 0, websiteClicks: 0, directionRequests: 0 };
      daily[d].calls += r.calls || 0;
      daily[d].websiteClicks += r.website_clicks || 0;
      daily[d].directionRequests += r.direction_requests || 0;
    }

    res.json({
      byLocation,
      daily: Object.values(daily).sort((a, b) => a.date.localeCompare(b.date)),
      totalDays: period,
    });
  } catch (err) { next(err); }
});

// =========================================================================
// SEO ADVISOR
// =========================================================================

// GET /api/admin/seo/sync-health — diagnostics for Advisor/GSC/GBP data.
router.get('/sync-health', async (req, res, next) => {
  try {
    let WAVES_LOCATIONS = [];
    try {
      ({ WAVES_LOCATIONS } = require('../config/locations'));
    } catch (err) {
      logger.warn(`[seo] Could not load locations for sync health: ${err.message}`);
    }

    const probe = async (table, dateCol = 'date') => {
      try {
        const [{ count }] = await db(table).count('* as count');
        const latest = await db(table).max(`${dateCol} as max`).first();
        return { ok: true, count: parseInt(count || 0, 10), lastDate: latest?.max || null };
      } catch (e) {
        return { ok: false, count: 0, lastDate: null, error: e.message };
      }
    };

    const gscDaily = await probe('gsc_performance_daily', 'date');
    const gscQueries = await probe('gsc_queries', 'date');
    const gbpDaily = await probe('gbp_performance_daily', 'date');

    const gbpLocations = await Promise.all(WAVES_LOCATIONS.map(async (loc) => {
      const envVar = loc.googleRefreshTokenEnv;
      const envSuffix = envVar?.replace(/^GBP_REFRESH_TOKEN_/, '');
      const configured = !!(
        envSuffix &&
        process.env[`GBP_CLIENT_ID_${envSuffix}`] &&
        process.env[`GBP_CLIENT_SECRET_${envSuffix}`] &&
        process.env[envVar]
      );
      let lastDate = null;
      let rowCount = 0;
      if (gbpDaily.ok) {
        try {
          const row = await db('gbp_performance_daily')
            .where({ location_id: loc.id })
            .max('date as max')
            .first();
          lastDate = row?.max || null;
          const [{ count }] = await db('gbp_performance_daily')
            .where({ location_id: loc.id })
            .count('* as count');
          rowCount = parseInt(count || 0, 10);
        } catch { /* keep default health values */ }
      }
      return {
        id: loc.id,
        name: loc.name,
        envVar,
        configured,
        rowCount,
        lastDate,
      };
    }));

    const staleDays = (dateStr) => {
      if (!dateStr) return null;
      const d = new Date(dateStr);
      if (Number.isNaN(d.getTime())) return null;
      return Math.floor((Date.now() - d.getTime()) / 86400000);
    };

    res.json({
      gsc: {
        configured: !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
        daily: gscDaily,
        queries: gscQueries,
        staleDays: staleDays(gscDaily.lastDate),
      },
      gbp: {
        daily: gbpDaily,
        locations: gbpLocations,
        anyConfigured: gbpLocations.some((l) => l.configured),
      },
      checkedAt: new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

// GET /api/admin/seo/advisor — latest report
router.get('/advisor', async (req, res, next) => {
  try {
    const report = await db('seo_advisor_reports').orderBy('date', 'desc').first();
    if (!report) return res.json({ report: null });
    res.json({
      report: {
        ...report,
        report_data: typeof report.report_data === 'string' ? JSON.parse(report.report_data) : report.report_data,
      },
    });
  } catch (err) { next(err); }
});

// GET /api/admin/seo/advisor/history
router.get('/advisor/history', async (req, res, next) => {
  try {
    const reports = await db('seo_advisor_reports')
      .orderBy('date', 'desc')
      .limit(12)
      .select('id', 'date', 'grade', 'recommendation_count', 'opportunity_count', 'alert_count', 'created_at');
    res.json({ reports });
  } catch (err) { next(err); }
});

// POST /api/admin/seo/advisor/generate — manually trigger
router.post('/advisor/generate', requireAdmin, async (req, res, next) => {
  try {
    const report = await SEOAdvisor.generateWeeklyReport();
    res.json({ report });
  } catch (err) { next(err); }
});

// =========================================================================
// SYNC
// =========================================================================

// POST /api/admin/seo/sync — manually trigger GSC data sync
router.post('/sync', requireAdmin, async (req, res, next) => {
  try {
    const domain = req.body.domain || null;
    const result = await SearchConsole.syncDailyData(req.body.daysBack || 7, domain);
    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/admin/seo/sync-gbp — manually trigger GBP performance sync
router.post('/sync-gbp', requireAdmin, async (req, res, next) => {
  try {
    const GoogleBusiness = require('../services/google-business');
    const result = await GoogleBusiness.syncPerformanceDaily(req.body.daysBack || 30);
    res.json(result);
  } catch (err) { next(err); }
});

// =========================================================================
// PAGE 2 OPPORTUNITIES — queries in positions 4–15
// =========================================================================

// GET /api/admin/seo/opportunities?period=28
router.get('/opportunities', async (req, res, next) => {
  try {
    const period = parseInt(req.query.period || 28);
    const domain = req.query.domain || null;
    const since = etDateString(addETDays(new Date(), -period));

    const rows = await applyDomainFilter(db('gsc_queries')
      .where('date', '>=', since)
      .where('is_branded', false), domain)
      .select('query', 'service_category', 'city_target')
      .sum('clicks as clicks')
      .sum('impressions as impressions')
      .avg('position as avg_position')
      .groupBy('query', 'service_category', 'city_target')
      .havingRaw('avg(position) >= 4 AND avg(position) <= 15')
      .orderBy('impressions', 'desc')
      .limit(30);

    res.json({
      opportunities: rows.map(r => ({
        query: r.query,
        clicks: parseInt(r.clicks),
        impressions: parseInt(r.impressions),
        position: parseFloat(parseFloat(r.avg_position).toFixed(1)),
        service: r.service_category,
        city: r.city_target,
        potentialClicks: Math.round(parseInt(r.impressions) * 0.08), // ~8% CTR if on page 1
      })),
    });
  } catch (err) { next(err); }
});

// =========================================================================
// SEO COMMAND CENTER — Rank Tracking, SERP, Backlinks, QA, Decay, Citations
// All gated behind GATE_SEO_INTELLIGENCE
// =========================================================================

const RankTracker = require('../services/seo/rank-tracker');
const SERPAnalyzer = require('../services/seo/serp-analyzer');
const BacklinkMonitor = require('../services/seo/backlink-monitor');
const AIOverviewTracker = require('../services/seo/ai-overview-tracker');
const ContentQA = require('../services/seo/content-qa');
const CannibalizationDetector = require('../services/seo/cannibalization');
const ContentDecayDetector = require('../services/seo/content-decay');
const CitationAuditor = require('../services/seo/citation-auditor');
const ConversionFunnel = require('../services/seo/conversion-funnel');
const SiteRollup = require('../services/seo/site-rollup');

// Auto-seed SEO keywords if table is empty
const CITIES = ['Bradenton', 'Sarasota', 'Lakewood Ranch', 'Venice', 'Parrish', 'North Port', 'Port Charlotte'];
const SERVICES_LIST = ['pest control', 'lawn care', 'mosquito control', 'termite inspection', 'termite treatment', 'fire ant treatment', 'rodent control', 'tree and shrub care', 'lawn fertilization', 'mosquito spraying', 'exterminator', 'weed control'];
const PRIORITY_1 = [
  'pest control bradenton', 'pest control sarasota', 'pest control lakewood ranch',
  'lawn care bradenton', 'lawn care sarasota', 'mosquito control bradenton',
  'mosquito control sarasota', 'termite inspection bradenton', 'termite treatment sarasota',
  'lawn care lakewood ranch', 'pest control near me', 'exterminator bradenton',
  'fire ant treatment bradenton', 'rat control sarasota', 'tree spraying sarasota',
  'mosquito spraying lakewood ranch', 'pest control parrish fl', 'lawn fertilization bradenton',
  'pest control north port', 'termite inspection venice fl',
];

let _seoSeeded = false;
async function ensureSeoKeywords() {
  if (_seoSeeded) return;
  _seoSeeded = true;
  try {
    if (!(await db.schema.hasTable('seo_target_keywords'))) return;
    const { count } = await db('seo_target_keywords').count('* as count').first();
    if (parseInt(count) > 0) return;

    console.log('[seo] Auto-seeding target keywords...');
    let seeded = 0;
    for (const city of CITIES) {
      for (const service of SERVICES_LIST) {
        const keyword = `${service} ${city.toLowerCase()}`;
        const isPriority1 = PRIORITY_1.some(p => keyword.includes(p.replace(/ fl$/, '')));
        await db('seo_target_keywords').insert({
          keyword, primary_city: city, service_category: service.replace(/\s+/g, '_'),
          priority: isPriority1 ? 1 : 2,
        }).catch(() => {});
        seeded++;
      }
    }
    const nearMe = ['pest control near me', 'exterminator near me', 'lawn care near me', 'mosquito control near me', 'termite inspection near me'];
    for (const kw of nearMe) {
      await db('seo_target_keywords').insert({
        keyword: kw, service_category: kw.split(' near')[0].replace(/\s+/g, '_'),
        priority: kw === 'pest control near me' ? 1 : 2,
      }).catch(() => {});
      seeded++;
    }

    // Seed competitors
    const COMPETITORS = [
      { name: 'Turner Pest Control', domain: 'turnerpest.com', market_area: 'SWFL' },
      { name: 'Hoskins Pest Control', domain: 'hoskinspest.com', market_area: 'SWFL' },
      { name: 'HomeTeam Pest Defense', domain: 'hometeampestdefense.com', market_area: 'National' },
      { name: 'Orkin', domain: 'orkin.com', market_area: 'National' },
      { name: 'Terminix', domain: 'terminix.com', market_area: 'National' },
      { name: 'Truly Nolen', domain: 'trulynolen.com', market_area: 'Regional' },
      { name: 'Nozzle Nolen', domain: 'nozzlenolen.com', market_area: 'Regional' },
      { name: 'ABC Home & Commercial', domain: 'abchomeandcommercial.com', market_area: 'Regional' },
    ];
    if (await db.schema.hasTable('seo_competitors')) {
      for (const comp of COMPETITORS) {
        await db('seo_competitors').insert(comp).catch(() => {});
      }
    }

    console.log(`[seo] Auto-seeded ${seeded} keywords + 8 competitors`);
  } catch (e) { console.error('[seo] Auto-seed error:', e.message); }
}

// Rankings
router.get('/rankings', async (req, res, next) => {
  try {
    await ensureSeoKeywords();
    const data = await RankTracker.getDashboard(parseInt(req.query.days || 7));
    res.json(data);
  } catch (err) { next(err); }
});

router.post('/rankings/track', requireAdmin, async (req, res, next) => {
  try {
    const result = await RankTracker.trackRanks(req.body.priority || null);
    res.json(result);
  } catch (err) { next(err); }
});

// SERP Analysis
router.get('/serp/:keywordId', async (req, res, next) => {
  try {
    const analysis = await db('seo_serp_analyses').where('keyword_id', req.params.keywordId).orderBy('analysis_date', 'desc').first();
    res.json({ analysis });
  } catch (err) { next(err); }
});

router.post('/serp/analyze', requireAdmin, async (req, res, next) => {
  try {
    const result = await SERPAnalyzer.analyzeKeyword(req.body.keywordId);
    res.json(result);
  } catch (err) { next(err); }
});

// Backlinks
router.get('/backlinks', async (req, res, next) => {
  try {
    const data = await BacklinkMonitor.getFullDashboard();
    res.json(data);
  } catch (err) { next(err); }
});

router.post('/backlinks/scan', requireAdmin, async (req, res, next) => {
  try {
    const result = await BacklinkMonitor.scan();
    await BacklinkMonitor.takeSnapshot();
    res.json(result);
  } catch (err) { next(err); }
});

router.post('/backlinks/disavow', requireAdmin, async (req, res, next) => {
  try {
    const result = await BacklinkMonitor.generateDisavow();
    res.json(result);
  } catch (err) { next(err); }
});

router.post('/backlinks/competitor-gaps', requireAdmin, async (req, res, next) => {
  try {
    const { domain } = req.body;
    if (!domain) return res.status(400).json({ error: 'Competitor domain required' });
    const result = await BacklinkMonitor.scanCompetitorGaps(domain);
    res.json(result);
  } catch (err) { next(err); }
});

router.post('/backlinks/llm-mentions', requireAdmin, async (req, res, next) => {
  try {
    const result = await BacklinkMonitor.checkLLMMentions();
    const mentions = await db('seo_llm_mentions').orderBy('check_date', 'desc').limit(20);
    res.json({ result, mentions });
  } catch (err) { next(err); }
});

// =========================================================================
// LLM MENTIONS — answer-engine visibility (AEO)
// =========================================================================

// GET /api/admin/seo/llm-mentions — share-of-voice dashboard
router.get('/llm-mentions', async (req, res, next) => {
  try {
    const prober = require('../services/seo/llm-mention-prober');
    res.json(await prober.getDashboard());
  } catch (err) { next(err); }
});

// POST /api/admin/seo/llm-mentions/scan — manually trigger a probe pass
router.post('/llm-mentions/scan', requireAdmin, async (req, res, next) => {
  try {
    const prober = require('../services/seo/llm-mention-prober');
    const result = await prober.runDaily();
    res.json({ success: true, result });
  } catch (err) { next(err); }
});

// GET /api/admin/seo/llm-mentions/queries — managed query list
router.get('/llm-mentions/queries', async (req, res, next) => {
  try {
    const queries = await db('seo_llm_mention_queries').orderBy('created_at', 'asc');
    res.json({ queries });
  } catch (err) { next(err); }
});

// POST /api/admin/seo/llm-mentions/queries — add a query to probe
router.post('/llm-mentions/queries', requireAdmin, async (req, res, next) => {
  try {
    const { query, city, service } = req.body || {};
    if (!query || !String(query).trim()) {
      return res.status(400).json({ error: 'query is required' });
    }
    const [row] = await db('seo_llm_mention_queries')
      .insert({ query: String(query).trim(), city: city || null, service: service || null, active: true })
      .onConflict('query').merge({ active: true, city: city || null, service: service || null })
      .returning('*');
    res.json({ query: row });
  } catch (err) { next(err); }
});

// PATCH /api/admin/seo/llm-mentions/queries/:id — toggle active / edit
router.patch('/llm-mentions/queries/:id', requireAdmin, async (req, res, next) => {
  try {
    const patch = {};
    if (typeof req.body?.active === 'boolean') patch.active = req.body.active;
    if (typeof req.body?.query === 'string' && req.body.query.trim()) patch.query = req.body.query.trim();
    if ('city' in (req.body || {})) patch.city = req.body.city || null;
    if ('service' in (req.body || {})) patch.service = req.body.service || null;
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing to update' });
    patch.updated_at = db.fn.now();
    const [row] = await db('seo_llm_mention_queries').where('id', req.params.id).update(patch).returning('*');
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json({ query: row });
  } catch (err) { next(err); }
});

// AI Overview
router.get('/ai-overview', async (req, res, next) => {
  try {
    await ensureSeoKeywords();
    const data = await AIOverviewTracker.getDashboard();
    res.json(data);
  } catch (err) { next(err); }
});

// POST /api/admin/seo/ai-overview/scan — manually trigger AI Overview scan
router.post('/ai-overview/scan', requireAdmin, async (req, res, next) => {
  try {
    await ensureSeoKeywords();
    const result = await AIOverviewTracker.trackDaily();
    res.json({ success: true, message: 'AI Overview scan completed', result });
  } catch (err) { next(err); }
});

// Content QA
router.get('/qa', async (req, res, next) => {
  try {
    const data = await ContentQA.getDashboard();
    res.json(data);
  } catch (err) { next(err); }
});

router.post('/qa/:blogPostId/score', requireAdmin, async (req, res, next) => {
  try {
    const result = await ContentQA.scoreContent(req.params.blogPostId);
    res.json(result);
  } catch (err) { next(err); }
});

router.post('/qa/batch', requireAdmin, async (req, res, next) => {
  try {
    const results = await ContentQA.batchScore(parseInt(req.body.limit || 50));
    res.json({ results });
  } catch (err) { next(err); }
});

// Cannibalization
router.get('/cannibalization', async (req, res, next) => {
  try {
    const data = await CannibalizationDetector.getDashboard();
    res.json(data);
  } catch (err) { next(err); }
});

// Content Decay
router.get('/decay', async (req, res, next) => {
  try {
    const data = await ContentDecayDetector.getDashboard();
    res.json(data);
  } catch (err) { next(err); }
});

// Citations
router.get('/citations', async (req, res, next) => {
  try {
    const data = await CitationAuditor.getDashboard();
    res.json(data);
  } catch (err) { next(err); }
});

router.put('/citations/:id', requireAdmin, async (req, res, next) => {
  try {
    await CitationAuditor.updateCitation(req.params.id, req.body);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// Conversion Funnel
router.get('/funnel', async (req, res, next) => {
  try {
    const data = await ConversionFunnel.getDashboard(parseInt(req.query.days || 30));
    res.json(data);
  } catch (err) { next(err); }
});

// Per-site rollup — inbound calls + leads by fleet domain
router.get('/site-rollup', async (req, res, next) => {
  try {
    res.json(await SiteRollup.getRollup(req.query.days));
  } catch (err) { next(err); }
});

// Competitors
router.get('/competitors', async (req, res, next) => {
  try {
    const competitors = await db('seo_competitors').where('active', true);
    res.json({ competitors });
  } catch (err) { next(err); }
});

// Keywords list
router.get('/keywords', async (req, res, next) => {
  try {
    const { priority, city, service } = req.query;
    let query = db('seo_target_keywords');
    if (priority) query = query.where('priority', parseInt(priority));
    if (city) query = query.where('primary_city', city);
    if (service) query = query.where('service_category', service);
    const keywords = await query.orderBy('priority').orderBy('keyword');
    res.json({ keywords, total: keywords.length });
  } catch (err) { next(err); }
});

// =========================================================================
// SITE AUDIT
// =========================================================================
const SiteAuditor = require('../services/seo/site-auditor');

router.get('/audit', async (req, res, next) => {
  try { res.json(await SiteAuditor.getDashboard(req.query.domain)); } catch (err) { next(err); }
});

router.get('/audit/history', async (req, res, next) => {
  try {
    const domain = normalizeDomain(req.query.domain) || 'wavespestcontrol.com';
    const runs = await db('seo_site_audit_runs').where('status', 'completed').where('domain', domain).orderBy('run_date', 'desc').limit(20);
    res.json({ runs });
  } catch (err) { next(err); }
});

router.get('/audit/pages', async (req, res, next) => {
  try {
    const domain = normalizeDomain(req.query.domain) || 'wavespestcontrol.com';
    const latest = await db('seo_site_audit_runs').where('status', 'completed').where('domain', domain).orderBy('run_date', 'desc').first();
    if (!latest) return res.json({ pages: [] });
    const date = etDateString(latest.run_date);
    const pages = await db('seo_page_audits').where('audit_date', date).where('domain', domain).orderBy('technical_health_score', 'asc');
    res.json({ pages, auditDate: date });
  } catch (err) { next(err); }
});

router.get('/audit/page-detail', async (req, res, next) => {
  try {
    const data = await SiteAuditor.getPageDetail(req.query.url, req.query.domain);
    res.json(data);
  } catch (err) { next(err); }
});

router.post('/audit/run', requireAdmin, async (req, res, next) => {
  try {
    const result = await SiteAuditor.runSiteAudit({ domain: req.body?.domain || req.query.domain });
    res.json(result);
  } catch (err) { next(err); }
});

// =========================================================================
// CONTENT QA DETAIL — deep analysis for a single blog post
// =========================================================================

// GET /api/admin/seo/qa/:blogPostId
router.get('/qa/:blogPostId', async (req, res, next) => {
  try {
    const post = await db('blog_posts').where('id', req.params.blogPostId).first();
    if (!post) return res.status(404).json({ error: 'Post not found' });

    const content = post.content || '';
    const html = post.content_html || content;
    const wordCount = post.word_count || content.split(/\s+/).filter(Boolean).length;
    const issues = [];

    // Word count checks
    if (wordCount < 300) {
      issues.push({ type: 'word_count', severity: 'critical', message: `Content is only ${wordCount} words (minimum 300)`, fix: 'Expand the article to at least 800 words with additional sections, examples, and local context' });
    } else if (wordCount < 500) {
      issues.push({ type: 'word_count', severity: 'warning', message: `Content is ${wordCount} words — thin content risk`, fix: 'Add 300+ more words: consider FAQ section, local tips, or seasonal notes' });
    }

    // Meta description
    const metaLen = (post.meta_description || '').length;
    if (!post.meta_description) {
      issues.push({ type: 'meta_description', severity: 'critical', message: 'No meta description set', fix: 'Write a 130-160 character meta description with the target keyword and a CTA' });
    } else if (metaLen < 130) {
      issues.push({ type: 'meta_description', severity: 'warning', message: `Meta description too short (${metaLen} chars, ideal 130-160)`, fix: 'Expand meta description to 130-160 characters' });
    } else if (metaLen > 160) {
      issues.push({ type: 'meta_description', severity: 'warning', message: `Meta description too long (${metaLen} chars, ideal 130-160)`, fix: 'Trim meta description to 160 characters to avoid truncation in SERPs' });
    }

    // Keyword
    if (!post.keyword) {
      issues.push({ type: 'keyword', severity: 'critical', message: 'No target keyword set', fix: 'Set a primary keyword for this post' });
    }

    // Heading structure
    const h2Count = (html.match(/<h2[\s>]/gi) || []).length;
    const h3Count = (html.match(/<h3[\s>]/gi) || []).length;
    if (h2Count === 0) {
      issues.push({ type: 'headings', severity: 'warning', message: 'No H2 headings found', fix: 'Add at least 2-3 H2 subheadings to structure the content' });
    }

    // Internal links
    const internalLinks = (html.match(/href=["']https?:\/\/(www\.)?wavespestcontrol\.com[^"']*/gi) || []);
    if (internalLinks.length === 0) {
      issues.push({ type: 'internal_links', severity: 'warning', message: 'No internal links to wavespestcontrol.com', fix: 'Add 2-3 internal links to relevant service or city pages' });
    }

    // External links
    const allLinks = (html.match(/href=["']https?:\/\/[^"']*/gi) || []);
    const externalLinks = allLinks.filter(l => !/wavespestcontrol\.com/i.test(l));

    // FAQ section
    const hasFAQ = /faq|frequently asked|common question/i.test(content);
    if (!hasFAQ) {
      issues.push({ type: 'faq', severity: 'warning', message: 'No FAQ section detected', fix: 'Add a FAQ section with 3-5 questions — helps win People Also Ask boxes' });
    }

    // Image alt text
    const images = html.match(/<img[^>]*>/gi) || [];
    const imagesWithoutAlt = images.filter(img => !(/alt=["'][^"']+["']/i.test(img)));
    if (imagesWithoutAlt.length > 0) {
      issues.push({ type: 'image_alt', severity: 'warning', message: `${imagesWithoutAlt.length} image(s) missing alt text`, fix: 'Add descriptive alt text to all images including the target keyword where natural' });
    }

    // Calculate score
    const maxIssues = 7; // total check categories
    const criticalCount = issues.filter(i => i.severity === 'critical').length;
    const warningCount = issues.filter(i => i.severity === 'warning').length;
    const deduction = (criticalCount * 20) + (warningCount * 8);
    const score = Math.max(0, Math.min(100, 100 - deduction));

    res.json({
      score,
      issues,
      post: {
        id: post.id,
        title: post.title,
        slug: post.slug,
        keyword: post.keyword,
        city: post.city,
        status: post.status,
        wordCount,
        metaDescriptionLength: metaLen,
        h2Count,
        h3Count,
        internalLinkCount: internalLinks.length,
        externalLinkCount: externalLinks.length,
        hasFAQ,
        imageCount: images.length,
        imagesWithoutAlt: imagesWithoutAlt.length,
      },
    });
  } catch (err) { next(err); }
});

// =========================================================================
// CORE WEB VITALS DETAIL — PageSpeed Insights for homepage + top pages
// =========================================================================

// GET /api/admin/seo/cwv/detail
router.get('/cwv/detail', async (req, res, next) => {
  try {
    const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
    if (!GOOGLE_API_KEY) {
      return res.status(500).json({ error: 'GOOGLE_API_KEY not configured' });
    }

    const homepage = 'https://www.wavespestcontrol.com';
    const topPages = [];

    // Get top 5 blog posts by SEO score or most recent published
    try {
      const blogs = await db('blog_posts')
        .where('status', 'published')
        .whereNotNull('slug')
        .orderByRaw('seo_score DESC NULLS LAST')
        .limit(5);
      for (const b of blogs) {
        topPages.push(`${homepage}/${b.slug}/`);
      }
    } catch (e) {
      logger.warn('Could not fetch blog pages for CWV detail:', e.message);
    }

    const urls = [homepage, ...topPages];
    const pages = [];

    for (const url of urls) {
      try {
        const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&key=${GOOGLE_API_KEY}&category=PERFORMANCE`;
        const response = await fetch(apiUrl);
        const data = await response.json();

        if (data.error) {
          pages.push({ url, error: data.error.message });
          continue;
        }

        const metrics = data.lighthouseResult?.audits || {};
        const categories = data.lighthouseResult?.categories || {};

        const lcp = metrics['largest-contentful-paint']?.numericValue || null;
        const fid = metrics['max-potential-fid']?.numericValue || null;
        const cls = metrics['cumulative-layout-shift']?.numericValue || null;
        const perfScore = categories.performance?.score != null ? Math.round(categories.performance.score * 100) : null;

        // Extract top opportunities
        const opportunities = [];
        const audits = data.lighthouseResult?.audits || {};
        for (const [key, audit] of Object.entries(audits)) {
          if (audit.details?.type === 'opportunity' && audit.details?.overallSavingsMs > 100) {
            opportunities.push({
              id: key,
              title: audit.title,
              savingsMs: Math.round(audit.details.overallSavingsMs),
              score: audit.score,
            });
          }
        }
        opportunities.sort((a, b) => b.savingsMs - a.savingsMs);

        pages.push({
          url,
          lcp: lcp != null ? Math.round(lcp) : null,
          fid: fid != null ? Math.round(fid) : null,
          cls: cls != null ? parseFloat(cls.toFixed(3)) : null,
          score: perfScore,
          opportunities: opportunities.slice(0, 5),
        });
      } catch (fetchErr) {
        pages.push({ url, error: fetchErr.message });
      }
    }

    res.json({ pages });
  } catch (err) { next(err); }
});

// =========================================================================
// OPPORTUNITIES — low-hanging fruit keywords + underperforming content
// =========================================================================

// Note: the basic /opportunities route already exists above (positions 4-15 from GSC).
// This enhanced version at /opportunities/detail also checks blog_posts with low seo_score.

router.get('/opportunities/detail', async (req, res, next) => {
  try {
    const opportunities = [];

    // 1) Try seo_rank_history for keywords in positions 4-20
    try {
      const rankData = await db('seo_rank_history as rh')
        .join('seo_target_keywords as kw', 'rh.keyword_id', 'kw.id')
        .whereBetween('rh.organic_position', [4, 20])
        .whereNotNull('rh.organic_position')
        .select(
          'kw.keyword', 'kw.target_url', 'kw.monthly_volume', 'kw.primary_city', 'kw.service_category',
          'rh.organic_position as position'
        )
        .orderBy('rh.organic_position', 'asc')
        .limit(30);

      for (const r of rankData) {
        let suggestedAction = 'Optimize content and build internal links';
        if (r.position <= 6) suggestedAction = 'Add FAQ schema + internal links — very close to top 3';
        else if (r.position <= 10) suggestedAction = 'Improve content depth and add supporting pages';
        else suggestedAction = 'Build topic cluster + get backlinks to push onto page 1';

        opportunities.push({
          keyword: r.keyword,
          position: r.position,
          url: r.target_url,
          searchVolume: r.monthly_volume,
          city: r.primary_city,
          service: r.service_category,
          difficulty: null,
          suggestedAction,
          source: 'rank_tracking',
        });
      }
    } catch (e) {
      logger.warn('Rank history query failed (table may not exist):', e.message);
    }

    // 2) Blog posts with keyword set but low seo_score
    try {
      const lowScorePosts = await db('blog_posts')
        .whereNotNull('keyword')
        .where(function () {
          this.where('seo_score', '<', 60).orWhereNull('seo_score');
        })
        .whereIn('status', ['published', 'draft'])
        .orderByRaw('seo_score ASC NULLS FIRST')
        .limit(20);

      for (const p of lowScorePosts) {
        opportunities.push({
          keyword: p.keyword,
          position: null,
          url: p.slug ? `https://wavespestcontrol.com/${p.slug}/` : null,
          searchVolume: null,
          difficulty: null,
          seoScore: p.seo_score,
          suggestedAction: !p.seo_score
            ? 'Run Content QA scoring — no SEO score yet'
            : p.seo_score < 30
              ? 'Major rewrite needed — thin content or missing key elements'
              : 'Improve: add FAQ, internal links, and local context',
          source: 'content_qa',
        });
      }
    } catch (e) {
      logger.warn('Blog posts opportunity query failed:', e.message);
    }

    res.json({ opportunities });
  } catch (err) { next(err); }
});

// =========================================================================
// KEYWORD MANAGEMENT — full CRUD for seo_target_keywords
// =========================================================================

// GET /api/admin/seo/keywords/manage — list all with status
router.get('/keywords/manage', async (req, res, next) => {
  try {
    const { status, priority, city, service } = req.query;
    let query = db('seo_target_keywords');
    if (status) query = query.where('status', status);
    if (priority) query = query.where('priority', parseInt(priority));
    if (city) query = query.where('primary_city', city);
    if (service) query = query.where('service_category', service);
    const keywords = await query.orderBy('priority').orderBy('keyword');

    // Enrich with latest rank data
    const enriched = [];
    for (const kw of keywords) {
      let latestRank = null;
      try {
        latestRank = await db('seo_rank_history')
          .where('keyword_id', kw.id)
          .orderBy('check_date', 'desc')
          .first();
      } catch (_) { /* rank table may not have data */ }

      enriched.push({
        ...kw,
        latestPosition: latestRank?.organic_position || kw.current_position || null,
        mapPackPosition: latestRank?.map_pack_position || null,
        lastChecked: latestRank?.check_date || null,
      });
    }

    res.json({ keywords: enriched, total: enriched.length });
  } catch (err) { next(err); }
});

// POST /api/admin/seo/keywords/manage — add new keyword
router.post('/keywords/manage', requireAdmin, async (req, res, next) => {
  try {
    const { keyword, city, service, priority = 2, search_volume, difficulty, notes } = req.body;
    if (!keyword) return res.status(400).json({ error: 'keyword is required' });

    const [created] = await db('seo_target_keywords').insert({
      keyword: keyword.trim(),
      primary_city: city || null,
      service_category: service || null,
      priority: Math.max(1, Math.min(3, parseInt(priority))),
      monthly_volume: search_volume || null,
      search_volume: search_volume || null,
      difficulty: difficulty != null ? Math.max(0, Math.min(100, parseInt(difficulty))) : null,
      status: 'new',
      has_content: false,
      notes: notes || null,
    }).returning('*');

    res.json({ keyword: created });
  } catch (err) { next(err); }
});

// PUT /api/admin/seo/keywords/manage/:id — update keyword
router.put('/keywords/manage/:id', requireAdmin, async (req, res, next) => {
  try {
    const { keyword, city, service, priority, search_volume, difficulty, status, notes, content_url, has_content, current_position, best_position, target_url } = req.body;

    const updates = {};
    if (keyword !== undefined) updates.keyword = keyword.trim();
    if (city !== undefined) updates.primary_city = city;
    if (service !== undefined) updates.service_category = service;
    if (priority !== undefined) updates.priority = Math.max(1, Math.min(3, parseInt(priority)));
    if (search_volume !== undefined) { updates.monthly_volume = search_volume; updates.search_volume = search_volume; }
    if (difficulty !== undefined) updates.difficulty = Math.max(0, Math.min(100, parseInt(difficulty)));
    if (status !== undefined) updates.status = status;
    if (notes !== undefined) updates.notes = notes;
    if (content_url !== undefined) updates.content_url = content_url;
    if (has_content !== undefined) updates.has_content = has_content;
    if (current_position !== undefined) updates.current_position = current_position;
    if (best_position !== undefined) updates.best_position = best_position;
    if (target_url !== undefined) updates.target_url = target_url;
    updates.updated_at = db.fn.now();

    const [updated] = await db('seo_target_keywords').where('id', req.params.id).update(updates).returning('*');
    if (!updated) return res.status(404).json({ error: 'Keyword not found' });

    res.json({ keyword: updated });
  } catch (err) { next(err); }
});

// DELETE /api/admin/seo/keywords/manage/:id — delete keyword
router.delete('/keywords/manage/:id', requireAdmin, async (req, res, next) => {
  try {
    const deleted = await db('seo_target_keywords').where('id', req.params.id).del();
    if (!deleted) return res.status(404).json({ error: 'Keyword not found' });
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
