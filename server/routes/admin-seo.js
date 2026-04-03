const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const SearchConsole = require('../services/seo/search-console');
const SEOAdvisor = require('../services/seo/seo-advisor');
const logger = require('../services/logger');

router.use(adminAuthenticate, requireTechOrAdmin);

// =========================================================================
// GSC DASHBOARD — sitewide metrics
// =========================================================================

// GET /api/admin/seo/dashboard?period=28
router.get('/dashboard', async (req, res, next) => {
  try {
    const periodDays = parseInt(req.query.period || 28);
    const summary = await SearchConsole.getPerformanceSummary(periodDays);
    res.json(summary);
  } catch (err) { next(err); }
});

// =========================================================================
// QUERIES
// =========================================================================

// GET /api/admin/seo/queries?period=28&branded=false&service=pest&city=bradenton
router.get('/queries', async (req, res, next) => {
  try {
    const { period = 28, branded, service, city, device, sort = 'clicks', limit = 100 } = req.query;
    const since = new Date(Date.now() - parseInt(period) * 86400000).toISOString().split('T')[0];

    let query = db('gsc_queries')
      .where('date', '>=', since)
      .select('query', 'is_branded', 'service_category', 'city_target', 'intent_type')
      .sum('clicks as clicks')
      .sum('impressions as impressions')
      .avg('position as avg_position')
      .groupBy('query', 'is_branded', 'service_category', 'city_target', 'intent_type');

    if (branded === 'true') query = query.where('is_branded', true);
    if (branded === 'false') query = query.where('is_branded', false);
    if (service) query = query.where('service_category', service);
    if (city) query = query.where('city_target', city);

    const rows = await query.orderBy(sort === 'position' ? 'avg_position' : sort, sort === 'position' ? 'asc' : 'desc').limit(parseInt(limit));

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
// PAGES
// =========================================================================

// GET /api/admin/seo/pages?period=28&type=city
router.get('/pages', async (req, res, next) => {
  try {
    const { period = 28, type, service, city, sort = 'clicks', limit = 50 } = req.query;
    const since = new Date(Date.now() - parseInt(period) * 86400000).toISOString().split('T')[0];

    let query = db('gsc_pages')
      .where('date', '>=', since)
      .select('page_url', 'page_type', 'service_category', 'city_target')
      .sum('clicks as clicks')
      .sum('impressions as impressions')
      .avg('position as avg_position')
      .groupBy('page_url', 'page_type', 'service_category', 'city_target');

    if (type) query = query.where('page_type', type);
    if (service) query = query.where('service_category', service);
    if (city) query = query.where('city_target', city);

    const rows = await query.orderBy(sort === 'position' ? 'avg_position' : sort, sort === 'position' ? 'asc' : 'desc').limit(parseInt(limit));

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
    const since = new Date(Date.now() - period * 86400000).toISOString().split('T')[0];

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
router.post('/advisor/generate', async (req, res, next) => {
  try {
    const report = await SEOAdvisor.generateWeeklyReport();
    res.json({ report });
  } catch (err) { next(err); }
});

// =========================================================================
// SYNC
// =========================================================================

// POST /api/admin/seo/sync — manually trigger GSC data sync
router.post('/sync', async (req, res, next) => {
  try {
    const result = await SearchConsole.syncDailyData(req.body.daysBack || 7);
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
    const since = new Date(Date.now() - period * 86400000).toISOString().split('T')[0];

    const rows = await db('gsc_queries')
      .where('date', '>=', since)
      .where('is_branded', false)
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

module.exports = router;
