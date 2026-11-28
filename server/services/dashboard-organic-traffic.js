'use strict';

/**
 * Organic Search & Website Traffic summary for the Admin Dashboard.
 * Read-only, $0 cost: aggregates already-synced rows in `gsc_performance_daily`
 * (device = 'all') and `ga4_daily_metrics` over two equal-length 30-day windows
 * anchored to each source's latest synced date (so GSC's 2–3 day reporting lag
 * never biases the period-over-period delta downward).
 */
const db = require('../models/db');
const logger = require('./logger');
const { etDateString, addETDays } = require('../utils/datetime-et');

const WINDOW_DAYS = 30;

function dateOnly(val) {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  return String(val).slice(0, 10);
}

function pctDelta(current, prior) {
  if (prior == null || current == null || prior <= 0) return null;
  return Math.round(((current - prior) / prior) * 1000) / 10;
}

function equalWindowBounds(latestDate, days = WINDOW_DAYS) {
  const anchor = new Date(`${latestDate}T12:00:00Z`);
  const curFrom = etDateString(addETDays(anchor, -(days - 1)));
  const prevTo = etDateString(addETDays(anchor, -days));
  const prevFrom = etDateString(addETDays(anchor, -(days * 2 - 1)));
  return { curFrom, curTo: latestDate, prevFrom, prevTo };
}

function summarizeGscRows(rows) {
  let clicks = 0;
  let impressions = 0;
  let nonbrandClicks = 0;
  let weightedPosSum = 0;
  let weightedPosImpr = 0;
  const domains = new Set();

  for (const r of rows) {
    const c = Number(r.clicks) || 0;
    const impr = Number(r.impressions) || 0;
    const pos = Number(r.avg_position);
    clicks += c;
    impressions += impr;
    nonbrandClicks += Number(r.nonbrand_clicks) || 0;
    if (impr > 0 && Number.isFinite(pos) && pos > 0) {
      weightedPosSum += pos * impr;
      weightedPosImpr += impr;
    }
    if (r.domain) domains.add(r.domain);
  }

  return {
    clicks,
    impressions,
    nonbrandClicks,
    ctr: impressions > 0 ? Math.round((clicks / impressions) * 1000) / 10 : null,
    avgPosition: weightedPosImpr > 0 ? Math.round((weightedPosSum / weightedPosImpr) * 10) / 10 : null,
    domainsCount: domains.size,
  };
}

function summarizeGa4Rows(rows) {
  let sessions = 0;
  let users = 0;
  let newUsers = 0;
  let pageviews = 0;
  let conversions = 0;

  for (const r of rows) {
    sessions += Number(r.sessions) || 0;
    users += Number(r.users) || 0;
    newUsers += Number(r.new_users) || 0;
    pageviews += Number(r.pageviews) || 0;
    conversions += Number(r.conversions) || 0;
  }

  return { sessions, users, newUsers, pageviews, conversions };
}

async function computeGscSummary(conn, today) {
  const latestRow = await conn('gsc_performance_daily')
    .where('device', 'all')
    .where('date', '<=', today)
    .max('date as latest')
    .first();
  const latestDate = dateOnly(latestRow?.latest);
  if (!latestDate) return { empty: true, latestDate: null, days: WINDOW_DAYS };

  const b = equalWindowBounds(latestDate);
  const [curRows, prevRows] = await Promise.all([
    conn('gsc_performance_daily')
      .where('device', 'all')
      .whereBetween('date', [b.curFrom, b.curTo])
      .select('clicks', 'impressions', 'avg_position', 'nonbrand_clicks', 'domain'),
    conn('gsc_performance_daily')
      .where('device', 'all')
      .whereBetween('date', [b.prevFrom, b.prevTo])
      .select('clicks', 'impressions', 'avg_position', 'nonbrand_clicks', 'domain'),
  ]);
  const cur = summarizeGscRows(curRows);
  const prev = summarizeGscRows(prevRows);
  return {
    ...cur,
    days: WINDOW_DAYS,
    latestDate,
    window: { from: b.curFrom, to: b.curTo },
    clicksDeltaPct: pctDelta(cur.clicks, prev.clicks),
    impressionsDeltaPct: pctDelta(cur.impressions, prev.impressions),
    priorClicks: prev.clicks,
    priorImpressions: prev.impressions,
  };
}

async function computeGa4Summary(conn, today) {
  const latestRow = await conn('ga4_daily_metrics')
    .where('date', '<=', today)
    .max('date as latest')
    .first();
  const latestDate = dateOnly(latestRow?.latest);
  if (!latestDate) return { empty: true, latestDate: null, days: WINDOW_DAYS };

  const b = equalWindowBounds(latestDate);
  const [curRows, prevRows] = await Promise.all([
    conn('ga4_daily_metrics')
      .whereBetween('date', [b.curFrom, b.curTo])
      .select('sessions', 'users', 'new_users', 'pageviews', 'conversions'),
    conn('ga4_daily_metrics')
      .whereBetween('date', [b.prevFrom, b.prevTo])
      .select('sessions', 'users', 'new_users', 'pageviews', 'conversions'),
  ]);
  const cur = summarizeGa4Rows(curRows);
  const prev = summarizeGa4Rows(prevRows);
  return {
    ...cur,
    days: WINDOW_DAYS,
    latestDate,
    window: { from: b.curFrom, to: b.curTo },
    sessionsDeltaPct: pctDelta(cur.sessions, prev.sessions),
    usersDeltaPct: pctDelta(cur.users, prev.users),
    priorSessions: prev.sessions,
    priorUsers: prev.users,
  };
}

async function computeOrganicTraffic(conn = db) {
  const today = etDateString();
  const [gsc, ga4] = await Promise.all([
    computeGscSummary(conn, today).catch((err) => {
      logger.error(`[dashboard-organic-traffic] gsc failed: ${err.message}`);
      return { error: 'unavailable' };
    }),
    computeGa4Summary(conn, today).catch((err) => {
      logger.error(`[dashboard-organic-traffic] ga4 failed: ${err.message}`);
      return { error: 'unavailable' };
    }),
  ]);
  return { days: WINDOW_DAYS, gsc, ga4 };
}

module.exports = {
  computeOrganicTraffic,
  equalWindowBounds,
  pctDelta,
  summarizeGscRows,
  summarizeGa4Rows,
};
