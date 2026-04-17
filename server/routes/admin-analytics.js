const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const GA4 = require('../services/analytics/google-analytics');
const logger = require('../services/logger');
const { etDateString, addETDays } = require('../utils/datetime-et');

router.use(adminAuthenticate, requireTechOrAdmin);

// ── Helper: parse date range from query params ──────────────────────
function parseDateRange(query) {
  let { startDate, endDate, period } = query;
  if (!startDate) {
    const days = parseInt(period || 30);
    const d = new Date();
    d.setDate(d.getDate() - days);
    startDate = d.toISOString().split('T')[0];
  }
  if (!endDate) {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    endDate = d.toISOString().split('T')[0];
  }
  return { startDate, endDate };
}

// GET /api/admin/analytics/overview
router.get('/overview', async (req, res, next) => {
  try {
    const { startDate, endDate } = parseDateRange(req.query);
    const data = await GA4.getTrafficOverview(startDate, endDate);
    res.json(data);
  } catch (err) { next(err); }
});

// GET /api/admin/analytics/sources
router.get('/sources', async (req, res, next) => {
  try {
    const { startDate, endDate } = parseDateRange(req.query);
    const data = await GA4.getTrafficBySource(startDate, endDate);
    res.json(data);
  } catch (err) { next(err); }
});

// GET /api/admin/analytics/pages
router.get('/pages', async (req, res, next) => {
  try {
    const { startDate, endDate } = parseDateRange(req.query);
    const limit = parseInt(req.query.limit || 20);
    const data = await GA4.getTopPages(startDate, endDate, limit);
    res.json(data);
  } catch (err) { next(err); }
});

// GET /api/admin/analytics/landing-pages
router.get('/landing-pages', async (req, res, next) => {
  try {
    const { startDate, endDate } = parseDateRange(req.query);
    const limit = parseInt(req.query.limit || 20);
    const data = await GA4.getTopLandingPages(startDate, endDate, limit);
    res.json(data);
  } catch (err) { next(err); }
});

// GET /api/admin/analytics/devices
router.get('/devices', async (req, res, next) => {
  try {
    const { startDate, endDate } = parseDateRange(req.query);
    const data = await GA4.getDeviceBreakdown(startDate, endDate);
    res.json(data);
  } catch (err) { next(err); }
});

// GET /api/admin/analytics/locations
router.get('/locations', async (req, res, next) => {
  try {
    const { startDate, endDate } = parseDateRange(req.query);
    const data = await GA4.getLocationBreakdown(startDate, endDate);
    res.json(data);
  } catch (err) { next(err); }
});

// GET /api/admin/analytics/conversions
router.get('/conversions', async (req, res, next) => {
  try {
    const { startDate, endDate } = parseDateRange(req.query);
    const data = await GA4.getConversions(startDate, endDate);
    res.json(data);
  } catch (err) { next(err); }
});

// GET /api/admin/analytics/trends — daily metrics from ga4_daily_metrics for charting
router.get('/trends', async (req, res, next) => {
  try {
    const period = parseInt(req.query.period || 30);
    const since = etDateString(addETDays(new Date(), -period));

    const rows = await db('ga4_daily_metrics')
      .where('date', '>=', since)
      .orderBy('date', 'asc');

    // Compute summary
    const totals = rows.reduce(
      (acc, r) => {
        acc.sessions += r.sessions || 0;
        acc.users += r.users || 0;
        acc.pageviews += r.pageviews || 0;
        acc.conversions += r.conversions || 0;
        return acc;
      },
      { sessions: 0, users: 0, pageviews: 0, conversions: 0 }
    );

    const avgBounce = rows.length > 0
      ? parseFloat((rows.reduce((s, r) => s + parseFloat(r.bounce_rate || 0), 0) / rows.length).toFixed(2))
      : 0;
    const avgDuration = rows.length > 0
      ? parseFloat((rows.reduce((s, r) => s + parseFloat(r.avg_session_duration || 0), 0) / rows.length).toFixed(2))
      : 0;

    res.json({
      daily: rows.map(r => ({
        date: typeof r.date === 'string' ? r.date.split('T')[0] : new Date(r.date).toISOString().split('T')[0],
        sessions: r.sessions,
        users: r.users,
        pageviews: r.pageviews,
        bounceRate: parseFloat(r.bounce_rate || 0),
        avgSessionDuration: parseFloat(r.avg_session_duration || 0),
        conversions: r.conversions,
        mobilePct: parseFloat(r.mobile_pct || 0),
        desktopPct: parseFloat(r.desktop_pct || 0),
      })),
      totals: { ...totals, bounceRate: avgBounce, avgSessionDuration: avgDuration },
      period: { days: period, since },
    });
  } catch (err) { next(err); }
});

// POST /api/admin/analytics/sync — trigger manual sync
router.post('/sync', async (req, res, next) => {
  try {
    const days = parseInt(req.body.days || 3);
    const result = await GA4.syncDailyData(days);
    res.json(result);
  } catch (err) { next(err); }
});

module.exports = router;
