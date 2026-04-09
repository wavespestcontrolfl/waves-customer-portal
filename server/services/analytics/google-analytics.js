/**
 * Google Analytics 4 (GA4) Data API Service
 *
 * Uses the googleapis npm package (same as GSC) to fetch website analytics.
 * Authenticates with the shared Google Service Account.
 *
 * ENV:
 *   GA4_PROPERTY_ID — numeric GA4 property ID (default 353979644)
 *   GOOGLE_SERVICE_ACCOUNT_JSON — JSON string of service account credentials
 */

// Lazy-load googleapis (~71MB) — only when GA4 methods are called
let _google;
function google() {
  if (!_google) { _google = require('googleapis').google; }
  return _google;
}
const db = require('../../models/db');
const logger = require('../logger');

const propertyId = process.env.GA4_PROPERTY_ID || '353979644';

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
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
    });

    analyticsClient = google.analyticsdata({ version: 'v1beta', auth });
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
      pageviews: parseInt(row.metricValues[2].value),
      bounceRate: parseFloat(parseFloat(row.metricValues[3].value).toFixed(4)),
      avgSessionDuration: parseFloat(parseFloat(row.metricValues[4].value).toFixed(2)),
    }));

    // Compute totals
    const totals = rows.reduce(
      (acc, r) => {
        acc.sessions += r.sessions;
        acc.users += r.users;
        acc.pageviews += r.pageviews;
        return acc;
      },
      { sessions: 0, users: 0, pageviews: 0 }
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
    const response = await client.properties.runReport({
      property: `properties/${propertyId}`,
      requestBody: {
        dateRanges: [range],
        dimensions: [
          { name: 'sessionSource' },
          { name: 'sessionMedium' },
        ],
        metrics: [
          { name: 'sessions' },
          { name: 'totalUsers' },
          { name: 'conversions' },
        ],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: 50,
      },
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
    const response = await client.properties.runReport({
      property: `properties/${propertyId}`,
      requestBody: {
        dateRanges: [range],
        dimensions: [{ name: 'landingPage' }],
        metrics: [
          { name: 'sessions' },
          { name: 'totalUsers' },
          { name: 'bounceRate' },
          { name: 'conversions' },
        ],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: parseInt(limit),
      },
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

    // 2. Get sources for top source/medium per day
    const sourcesResult = await getTrafficBySource(startStr, endStr);
    const topSource = sourcesResult.data && sourcesResult.data[0];

    // 3. Get device breakdown for mobile/desktop pct
    const devices = await getDeviceBreakdown(startStr, endStr);
    const deviceMap = {};
    if (devices.data) {
      for (const d of devices.data) {
        deviceMap[d.device.toLowerCase()] = d.pct || 0;
      }
    }

    // 4. Get top landing page
    const landingPages = await getTopLandingPages(startStr, endStr, 1);
    const topLanding = landingPages.data && landingPages.data[0];

    // 5. Get conversions total
    const conversions = await getConversions(startStr, endStr);
    const totalConversions = conversions.data
      ? conversions.data.reduce((s, r) => s + r.count, 0)
      : 0;

    // 6. Upsert daily rows
    if (overview.daily && overview.daily.length > 0) {
      for (const day of overview.daily) {
        const dateStr = day.date.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
        await db('ga4_daily_metrics')
          .insert({
            date: dateStr,
            sessions: day.sessions,
            users: day.users,
            new_users: 0,
            pageviews: day.pageviews,
            bounce_rate: parseFloat((day.bounceRate * 100).toFixed(2)),
            avg_session_duration: day.avgSessionDuration,
            conversions: totalConversions,
            top_source: topSource ? topSource.source : null,
            top_medium: topSource ? topSource.medium : null,
            top_landing_page: topLanding ? topLanding.landingPage : null,
            mobile_pct: deviceMap.mobile || 0,
            desktop_pct: deviceMap.desktop || 0,
          })
          .onConflict('date')
          .merge();
      }
    }

    // 7. Upsert traffic source rows
    if (sourcesResult.data && sourcesResult.data.length > 0) {
      for (const src of sourcesResult.data) {
        // Store aggregated sources with the end date
        await db('ga4_traffic_sources')
          .insert({
            date: endStr,
            source: (src.source || '').substring(0, 100),
            medium: (src.medium || '').substring(0, 100),
            sessions: src.sessions,
            users: src.users,
            conversions: src.conversions || 0,
          })
          .onConflict(db.raw('(date, source, medium)'))
          .merge();
      }
    }

    logger.info(`[GA4] Sync complete: ${overview.daily ? overview.daily.length : 0} daily rows`);
    return { synced: true, period: { start: startStr, end: endStr }, rows: overview.daily ? overview.daily.length : 0 };
  } catch (err) {
    logger.error(`[GA4] syncDailyData failed: ${err.message}`);
    return { synced: false, error: err.message };
  }
}

module.exports = {
  initialize,
  getTrafficOverview,
  getTrafficBySource,
  getTopPages,
  getTopLandingPages,
  getDeviceBreakdown,
  getLocationBreakdown,
  getConversions,
  syncDailyData,
};
