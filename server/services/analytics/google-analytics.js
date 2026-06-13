/**
 * Google Analytics 4 (GA4) Data API Service
 *
 * Uses the googleapis npm package (same as GSC) to fetch website analytics.
 * Authenticates with the shared Google Service Account.
 *
 * ENV:
 *   GA4_PROPERTY_ID — numeric GA4 property ID (Waves production: 487785917)
 *   GOOGLE_SERVICE_ACCOUNT_JSON — JSON string of service account credentials
 */

// Lazy-load googleapis (~71MB) — only when GA4 methods are called
let _googleapis;
function getGoogle() {
  if (!_googleapis) { try { _googleapis = require('googleapis').google; } catch { _googleapis = null; } }
  return _googleapis;
}
const db = require('../../models/db');
const logger = require('../logger');

const propertyId = process.env.GA4_PROPERTY_ID || null;

let analyticsClient = null;
let initAttempted = false;

/**
 * Lazy-initialize the GA4 analyticsdata client.
 * Returns the client or null if not configured.
 */
async function initialize() {
  if (analyticsClient) return analyticsClient;
  if (initAttempted) return null;
  initAttempted = true;

  try {
    if (!propertyId) {
      logger.warn('[GA4] GA4_PROPERTY_ID not set — GA4 disabled');
      return null;
    }

    const saEnv = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!saEnv) {
      logger.warn('[GA4] GOOGLE_SERVICE_ACCOUNT_JSON not set — GA4 disabled');
      return null;
    }

    let jsonStr = saEnv.trim();
    if (jsonStr.startsWith('{') && !jsonStr.endsWith('}')) {
      jsonStr += '\n}';
      logger.info('[GA4] Fixed missing closing brace in GOOGLE_SERVICE_ACCOUNT_JSON');
    }

    const credentials = JSON.parse(jsonStr);
    const g = getGoogle();
    if (!g) { logger.error('[GA4] googleapis not installed'); return null; }
    const auth = new g.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
    });

    analyticsClient = g.analyticsdata({ version: 'v1beta', auth });
    logger.info(`[GA4] Initialized for property ${propertyId}`);
    return analyticsClient;
  } catch (err) {
    logger.error(`[GA4] Init failed: ${err.message}`);
    return null;
  }
}

// ── Helper: format date string ──────────────────────────────────────
function formatDate(d) {
  if (typeof d === 'string') return d;
  return d.toISOString().split('T')[0];
}

function defaultDateRange(startDate, endDate) {
  if (!startDate) {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    startDate = formatDate(d);
  }
  if (!endDate) {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    endDate = formatDate(d);
  }
  return { startDate: formatDate(startDate), endDate: formatDate(endDate) };
}

function normalizeGa4Date(value) {
  const raw = String(value || '');
  const match = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  return raw.slice(0, 10);
}

function metricNumber(row, index, fallback = 0) {
  const value = Number(row?.metricValues?.[index]?.value);
  return Number.isFinite(value) ? value : fallback;
}

function dimensionValue(row, index, fallback = '') {
  const value = row?.dimensionValues?.[index]?.value;
  return value == null ? fallback : String(value);
}

const KEY_EVENTS_METRIC = 'keyEvents';
const LEGACY_CONVERSIONS_METRIC = 'conversions';

function makeDateMap(rows, rowMapper) {
  const map = new Map();
  for (const row of rows || []) {
    const date = normalizeGa4Date(dimensionValue(row, 0));
    if (!date) continue;
    map.set(date, rowMapper(row, date));
  }
  return map;
}

function hasMetric(requestBody, metricName) {
  return (requestBody?.metrics || []).some((metric) => metric?.name === metricName);
}

function replaceMetric(requestBody, fromMetric, toMetric) {
  return {
    ...requestBody,
    metrics: (requestBody.metrics || []).map((metric) => (
      metric?.name === fromMetric ? { ...metric, name: toMetric } : metric
    )),
    orderBys: (requestBody.orderBys || []).map((orderBy) => {
      if (orderBy?.metric?.metricName !== fromMetric) return orderBy;
      return {
        ...orderBy,
        metric: { ...orderBy.metric, metricName: toMetric },
      };
    }),
  };
}

function isMetricCompatibilityError(err, metricName) {
  const msg = String(err?.message || err || '');
  return msg.includes(metricName) && /metric|field|invalid|unknown|unrecognized|not.*valid/i.test(msg);
}

async function runGa4Report(client, requestBody) {
  try {
    return await client.properties.runReport({
      property: `properties/${propertyId}`,
      requestBody,
    });
  } catch (err) {
    if (hasMetric(requestBody, KEY_EVENTS_METRIC) && isMetricCompatibilityError(err, KEY_EVENTS_METRIC)) {
      logger.warn('[GA4] keyEvents metric rejected; retrying report with legacy conversions metric');
      return client.properties.runReport({
        property: `properties/${propertyId}`,
        requestBody: replaceMetric(requestBody, KEY_EVENTS_METRIC, LEGACY_CONVERSIONS_METRIC),
      });
    }
    throw err;
  }
}

async function getDailyConversions(client, startDate, endDate) {
  const response = await runGa4Report(client, {
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: 'date' }],
    metrics: [{ name: KEY_EVENTS_METRIC }],
    orderBys: [{ dimension: { dimensionName: 'date' } }],
    limit: 10000,
  });

  return makeDateMap(response.data.rows, (row) => Math.round(metricNumber(row, 0)));
}

async function getDailyDevicePct(client, startDate, endDate) {
  const response = await runGa4Report(client, {
    dateRanges: [{ startDate, endDate }],
    dimensions: [
      { name: 'date' },
      { name: 'deviceCategory' },
    ],
    metrics: [{ name: 'sessions' }],
    orderBys: [
      { dimension: { dimensionName: 'date' } },
      { metric: { metricName: 'sessions' }, desc: true },
    ],
    limit: 10000,
  });

  const totals = new Map();
  const byDate = new Map();
  for (const row of response.data.rows || []) {
    const date = normalizeGa4Date(dimensionValue(row, 0));
    const device = dimensionValue(row, 1).toLowerCase();
    const sessions = metricNumber(row, 0);
    if (!date) continue;
    totals.set(date, (totals.get(date) || 0) + sessions);
    if (!byDate.has(date)) byDate.set(date, {});
    byDate.get(date)[device] = (byDate.get(date)[device] || 0) + sessions;
  }

  const map = new Map();
  for (const [date, devices] of byDate.entries()) {
    const total = totals.get(date) || 0;
    map.set(date, {
      mobile_pct: total > 0 ? parseFloat((((devices.mobile || 0) / total) * 100).toFixed(2)) : 0,
      desktop_pct: total > 0 ? parseFloat((((devices.desktop || 0) / total) * 100).toFixed(2)) : 0,
    });
  }
  return map;
}

async function getDailyTopLandingPages(client, startDate, endDate) {
  const response = await runGa4Report(client, {
    dateRanges: [{ startDate, endDate }],
    dimensions: [
      { name: 'date' },
      { name: 'landingPage' },
    ],
    metrics: [{ name: 'sessions' }],
    orderBys: [
      { dimension: { dimensionName: 'date' } },
      { metric: { metricName: 'sessions' }, desc: true },
    ],
    limit: 10000,
  });

  const topByDate = new Map();
  for (const row of response.data.rows || []) {
    const date = normalizeGa4Date(dimensionValue(row, 0));
    if (!date || topByDate.has(date)) continue;
    topByDate.set(date, dimensionValue(row, 1) || null);
  }
  return topByDate;
}

async function getDailyTrafficSources(client, startDate, endDate) {
  const response = await runGa4Report(client, {
    dateRanges: [{ startDate, endDate }],
    dimensions: [
      { name: 'date' },
      { name: 'sessionSource' },
      { name: 'sessionMedium' },
    ],
    metrics: [
      { name: 'sessions' },
      { name: 'totalUsers' },
      { name: KEY_EVENTS_METRIC },
    ],
    orderBys: [
      { dimension: { dimensionName: 'date' } },
      { metric: { metricName: 'sessions' }, desc: true },
    ],
    limit: 10000,
  });

  const rows = [];
  const topByDate = new Map();
  for (const row of response.data.rows || []) {
    const date = normalizeGa4Date(dimensionValue(row, 0));
    if (!date) continue;

    const source = dimensionValue(row, 1, '(not set)').substring(0, 100);
    const medium = dimensionValue(row, 2, '(not set)').substring(0, 100);
    const record = {
      date,
      source,
      medium,
      sessions: Math.round(metricNumber(row, 0)),
      users: Math.round(metricNumber(row, 1)),
      conversions: Math.round(metricNumber(row, 2)),
    };
    rows.push(record);

    const currentTop = topByDate.get(date);
    if (!currentTop || record.sessions > currentTop.sessions) topByDate.set(date, record);
  }

  return { rows, topByDate };
}

// ── 1. Traffic Overview ─────────────────────────────────────────────
async function getTrafficOverview(startDate, endDate) {
  try {
    const client = await initialize();
    if (!client) return { configured: false, data: [] };

    const range = defaultDateRange(startDate, endDate);
    const response = await client.properties.runReport({
      property: `properties/${propertyId}`,
      requestBody: {
        dateRanges: [range],
        dimensions: [{ name: 'date' }],
        metrics: [
          { name: 'sessions' },
          { name: 'totalUsers' },
          { name: 'newUsers' },
          { name: 'screenPageViews' },
          { name: 'bounceRate' },
          { name: 'averageSessionDuration' },
        ],
        orderBys: [{ dimension: { dimensionName: 'date' } }],
      },
    });

    const rows = (response.data.rows || []).map(row => ({
      date: row.dimensionValues[0].value,
      sessions: parseInt(row.metricValues[0].value),
      users: parseInt(row.metricValues[1].value),
      newUsers: parseInt(row.metricValues[2].value),
      pageviews: parseInt(row.metricValues[3].value),
      bounceRate: parseFloat(parseFloat(row.metricValues[4].value).toFixed(4)),
      avgSessionDuration: parseFloat(parseFloat(row.metricValues[5].value).toFixed(2)),
    }));

    // Compute totals
    const totals = rows.reduce(
      (acc, r) => {
        acc.sessions += r.sessions;
        acc.users += r.users;
        acc.newUsers += r.newUsers;
        acc.pageviews += r.pageviews;
        return acc;
      },
      { sessions: 0, users: 0, newUsers: 0, pageviews: 0 }
    );

    const avgBounce = rows.length > 0
      ? parseFloat((rows.reduce((s, r) => s + r.bounceRate, 0) / rows.length).toFixed(4))
      : 0;
    const avgDuration = rows.length > 0
      ? parseFloat((rows.reduce((s, r) => s + r.avgSessionDuration, 0) / rows.length).toFixed(2))
      : 0;

    return {
      configured: true,
      totals: { ...totals, bounceRate: avgBounce, avgSessionDuration: avgDuration },
      daily: rows,
      period: range,
    };
  } catch (err) {
    logger.error(`[GA4] getTrafficOverview failed: ${err.message}`);
    return { configured: true, totals: {}, daily: [], error: err.message };
  }
}

// ── 2. Traffic by Source ────────────────────────────────────────────
async function getTrafficBySource(startDate, endDate) {
  try {
    const client = await initialize();
    if (!client) return { configured: false, data: [] };

    const range = defaultDateRange(startDate, endDate);
    const response = await runGa4Report(client, {
      dateRanges: [range],
      dimensions: [
        { name: 'sessionSource' },
        { name: 'sessionMedium' },
      ],
      metrics: [
        { name: 'sessions' },
        { name: 'totalUsers' },
        { name: KEY_EVENTS_METRIC },
      ],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: 50,
    });

    const rows = (response.data.rows || []).map(row => ({
      source: row.dimensionValues[0].value,
      medium: row.dimensionValues[1].value,
      sessions: parseInt(row.metricValues[0].value),
      users: parseInt(row.metricValues[1].value),
      conversions: parseInt(row.metricValues[2].value),
    }));

    return { configured: true, data: rows, period: range };
  } catch (err) {
    logger.error(`[GA4] getTrafficBySource failed: ${err.message}`);
    return { configured: true, data: [], error: err.message };
  }
}

// ── 2b. GBP-tagged website traffic by profile ───────────────────────
async function getGbpUtmTraffic(startDate, endDate) {
  try {
    const client = await initialize();
    if (!client) return { configured: false, data: [] };

    const range = defaultDateRange(startDate, endDate);
    const response = await runGa4Report(client, {
      dateRanges: [range],
      dimensions: [
        { name: 'sessionManualSource' },
        { name: 'sessionManualMedium' },
        { name: 'sessionManualCampaignName' },
        { name: 'sessionManualAdContent' },
      ],
      metrics: [
        { name: 'sessions' },
        { name: 'totalUsers' },
        { name: KEY_EVENTS_METRIC },
      ],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: 10000,
    });

    const rows = (response.data.rows || []).map(row => ({
      source: dimensionValue(row, 0),
      medium: dimensionValue(row, 1),
      campaign: dimensionValue(row, 2),
      content: dimensionValue(row, 3),
      sessions: Math.round(metricNumber(row, 0)),
      users: Math.round(metricNumber(row, 1)),
      conversions: Math.round(metricNumber(row, 2)),
    }));

    return { configured: true, data: rows, period: range };
  } catch (err) {
    logger.error(`[GA4] getGbpUtmTraffic failed: ${err.message}`);
    return { configured: true, data: [], error: err.message };
  }
}

// ── 3. Top Pages ────────────────────────────────────────────────────
async function getTopPages(startDate, endDate, limit = 20) {
  try {
    const client = await initialize();
    if (!client) return { configured: false, data: [] };

    const range = defaultDateRange(startDate, endDate);
    const response = await client.properties.runReport({
      property: `properties/${propertyId}`,
      requestBody: {
        dateRanges: [range],
        dimensions: [
          { name: 'pagePath' },
          { name: 'pageTitle' },
        ],
        metrics: [
          { name: 'screenPageViews' },
          { name: 'averageSessionDuration' },
          { name: 'bounceRate' },
        ],
        orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
        limit: parseInt(limit),
      },
    });

    const rows = (response.data.rows || []).map(row => ({
      pagePath: row.dimensionValues[0].value,
      pageTitle: row.dimensionValues[1].value,
      pageviews: parseInt(row.metricValues[0].value),
      avgSessionDuration: parseFloat(parseFloat(row.metricValues[1].value).toFixed(2)),
      bounceRate: parseFloat(parseFloat(row.metricValues[2].value).toFixed(4)),
    }));

    return { configured: true, data: rows, period: range };
  } catch (err) {
    logger.error(`[GA4] getTopPages failed: ${err.message}`);
    return { configured: true, data: [], error: err.message };
  }
}

// ── 4. Top Landing Pages ────────────────────────────────────────────
async function getTopLandingPages(startDate, endDate, limit = 20) {
  try {
    const client = await initialize();
    if (!client) return { configured: false, data: [] };

    const range = defaultDateRange(startDate, endDate);
    const response = await runGa4Report(client, {
      dateRanges: [range],
      dimensions: [{ name: 'landingPage' }],
      metrics: [
        { name: 'sessions' },
        { name: 'totalUsers' },
        { name: 'bounceRate' },
        { name: KEY_EVENTS_METRIC },
      ],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: parseInt(limit),
    });

    const rows = (response.data.rows || []).map(row => ({
      landingPage: row.dimensionValues[0].value,
      sessions: parseInt(row.metricValues[0].value),
      users: parseInt(row.metricValues[1].value),
      bounceRate: parseFloat(parseFloat(row.metricValues[2].value).toFixed(4)),
      conversions: parseInt(row.metricValues[3].value),
    }));

    return { configured: true, data: rows, period: range };
  } catch (err) {
    logger.error(`[GA4] getTopLandingPages failed: ${err.message}`);
    return { configured: true, data: [], error: err.message };
  }
}

// ── 5. Device Breakdown ─────────────────────────────────────────────
async function getDeviceBreakdown(startDate, endDate) {
  try {
    const client = await initialize();
    if (!client) return { configured: false, data: [] };

    const range = defaultDateRange(startDate, endDate);
    const response = await client.properties.runReport({
      property: `properties/${propertyId}`,
      requestBody: {
        dateRanges: [range],
        dimensions: [{ name: 'deviceCategory' }],
        metrics: [
          { name: 'sessions' },
          { name: 'totalUsers' },
        ],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      },
    });

    const rows = (response.data.rows || []).map(row => ({
      device: row.dimensionValues[0].value,
      sessions: parseInt(row.metricValues[0].value),
      users: parseInt(row.metricValues[1].value),
    }));

    // Calculate percentages
    const totalSessions = rows.reduce((s, r) => s + r.sessions, 0);
    for (const row of rows) {
      row.pct = totalSessions > 0
        ? parseFloat(((row.sessions / totalSessions) * 100).toFixed(2))
        : 0;
    }

    return { configured: true, data: rows, period: range };
  } catch (err) {
    logger.error(`[GA4] getDeviceBreakdown failed: ${err.message}`);
    return { configured: true, data: [], error: err.message };
  }
}

// ── 6. Location Breakdown (Florida) ─────────────────────────────────
async function getLocationBreakdown(startDate, endDate) {
  try {
    const client = await initialize();
    if (!client) return { configured: false, data: [] };

    const range = defaultDateRange(startDate, endDate);
    const response = await client.properties.runReport({
      property: `properties/${propertyId}`,
      requestBody: {
        dateRanges: [range],
        dimensions: [
          { name: 'city' },
          { name: 'region' },
        ],
        metrics: [
          { name: 'sessions' },
          { name: 'totalUsers' },
        ],
        dimensionFilter: {
          filter: {
            fieldName: 'region',
            stringFilter: {
              matchType: 'EXACT',
              value: 'Florida',
            },
          },
        },
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: 50,
      },
    });

    const rows = (response.data.rows || []).map(row => ({
      city: row.dimensionValues[0].value,
      region: row.dimensionValues[1].value,
      sessions: parseInt(row.metricValues[0].value),
      users: parseInt(row.metricValues[1].value),
    }));

    return { configured: true, data: rows, period: range };
  } catch (err) {
    logger.error(`[GA4] getLocationBreakdown failed: ${err.message}`);
    return { configured: true, data: [], error: err.message };
  }
}

// ── 7. Conversions ──────────────────────────────────────────────────
async function getConversions(startDate, endDate) {
  try {
    const client = await initialize();
    if (!client) return { configured: false, data: [] };

    const range = defaultDateRange(startDate, endDate);
    const response = await client.properties.runReport({
      property: `properties/${propertyId}`,
      requestBody: {
        dateRanges: [range],
        dimensions: [{ name: 'eventName' }],
        metrics: [{ name: 'eventCount' }],
        dimensionFilter: {
          filter: {
            fieldName: 'eventName',
            inListFilter: {
              values: [
                'form_submit',
                'phone_click',
                'generate_lead',
                'purchase',
                'sign_up',
                'contact_form',
                'request_quote',
                'schedule_service',
                'click_to_call',
                'begin_checkout',
              ],
            },
          },
        },
        orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      },
    });

    const rows = (response.data.rows || []).map(row => ({
      event: row.dimensionValues[0].value,
      count: parseInt(row.metricValues[0].value),
    }));

    return { configured: true, data: rows, period: range };
  } catch (err) {
    logger.error(`[GA4] getConversions failed: ${err.message}`);
    return { configured: true, data: [], error: err.message };
  }
}

// ── 8. Sync Daily Data to DB ────────────────────────────────────────
async function syncDailyData(days = 3) {
  try {
    const client = await initialize();
    if (!client) {
      logger.info('[GA4] Not configured — skipping sync');
      return { synced: false };
    }

    const endDate = new Date();
    endDate.setDate(endDate.getDate() - 1); // yesterday
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const startStr = formatDate(startDate);
    const endStr = formatDate(endDate);
    logger.info(`[GA4] Syncing daily data: ${startStr} to ${endStr}`);

    // 1. Get daily overview
    const overview = await getTrafficOverview(startStr, endStr);

    // 2. Get per-day source/device/landing/conversion dimensions for DB trends.
    const [
      dailyConversions,
      dailyDevices,
      dailyLandingPages,
      dailySources,
    ] = await Promise.all([
      getDailyConversions(client, startStr, endStr),
      getDailyDevicePct(client, startStr, endStr),
      getDailyTopLandingPages(client, startStr, endStr),
      getDailyTrafficSources(client, startStr, endStr),
    ]);

    // 3. Upsert daily rows.
    if (overview.daily && overview.daily.length > 0) {
      for (const day of overview.daily) {
        const dateStr = normalizeGa4Date(day.date);
        const topSource = dailySources.topByDate.get(dateStr);
        const devicePct = dailyDevices.get(dateStr) || {};
        await db('ga4_daily_metrics')
          .insert({
            date: dateStr,
            sessions: day.sessions,
            users: day.users,
            new_users: day.newUsers || 0,
            pageviews: day.pageviews,
            bounce_rate: parseFloat((day.bounceRate * 100).toFixed(2)),
            avg_session_duration: day.avgSessionDuration,
            conversions: dailyConversions.get(dateStr) || 0,
            top_source: topSource ? topSource.source : null,
            top_medium: topSource ? topSource.medium : null,
            top_landing_page: dailyLandingPages.get(dateStr) || null,
            mobile_pct: devicePct.mobile_pct || 0,
            desktop_pct: devicePct.desktop_pct || 0,
          })
          .onConflict('date')
          .merge();
      }
    }

    // 4. Upsert traffic source rows by day.
    if (dailySources.rows.length > 0) {
      for (const src of dailySources.rows) {
        await db('ga4_traffic_sources')
          .insert(src)
          .onConflict(['date', 'source', 'medium'])
          .merge();
      }
    }

    logger.info(`[GA4] Sync complete: ${overview.daily ? overview.daily.length : 0} daily rows`);
    return {
      synced: true,
      period: { start: startStr, end: endStr },
      rows: overview.daily ? overview.daily.length : 0,
      sourceRows: dailySources.rows.length,
    };
  } catch (err) {
    logger.error(`[GA4] syncDailyData failed: ${err.message}`);
    return { synced: false, error: err.message };
  }
}

module.exports = {
  initialize,
  getTrafficOverview,
  getTrafficBySource,
  getGbpUtmTraffic,
  getTopPages,
  getTopLandingPages,
  getDeviceBreakdown,
  getLocationBreakdown,
  getConversions,
  syncDailyData,
};
