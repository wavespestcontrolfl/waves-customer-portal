/**
 * Intelligence Bar — GA4 Analytics Snapshot Tools
 * server/services/intelligence-bar/ga4-ops-tools.js
 *
 * One live read over the GA4 Data API: site overview + conversion events
 * for a chosen window. The ga4-crons sync history into the local DB for
 * dashboards — this tool is for the direct "how is the site doing right
 * now?" question from any admin page, straight from Google.
 *
 * Reuses services/analytics/ga4.js (service-account auth). Read-only —
 * GA4 has no writable surface here at all.
 */

const ga4 = require('../analytics/ga4');
const logger = require('../logger');

const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;

const GA4_OPS_TOOLS = [
  {
    name: 'get_ga4_snapshot',
    description: `Live GA4 website snapshot: sessions, users, bounce rate, and conversion events (form submits, phone clicks, lead events) over the last N days (default ${DEFAULT_DAYS}, through yesterday — GA4 reporting lags ~1 day).
Use for: "how's site traffic this week?", "are form submits up?", "quick GA4 check"`,
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: `Window in days ending yesterday (default ${DEFAULT_DAYS}, max ${MAX_DAYS})` },
      },
    },
  },
];

const NOT_CONFIGURED_MESSAGE = 'GA4 access is not configured. GA4_PROPERTY_ID and GOOGLE_SERVICE_ACCOUNT_JSON must be set in the Railway dashboard.';

async function getGa4Snapshot(input) {
  const days = Math.min(Math.max(Math.round(Number(input.days) || DEFAULT_DAYS), 1), MAX_DAYS);
  const [overview, conversions] = await Promise.all([
    ga4.getOverview(days),
    ga4.getConversions(days),
  ]);
  if (overview.configured === false) {
    return { configured: false, message: NOT_CONFIGURED_MESSAGE };
  }
  return {
    window_days: days,
    overview: overview.data,
    conversions: conversions.configured === false ? null : conversions.data,
    note: 'Live GA4 Data API numbers through yesterday (GA4 reporting lags ~1 day). Deeper trend analysis lives on the dashboard, which reads the synced history.',
  };
}

async function executeGa4OpsTool(toolName, input = {}) {
  // "Not configured" is the expected DARK state, not a failure — an
  // { error } result would count against the shared admin circuit breaker
  // (see ops-tools.js for the full rationale).
  if (!process.env.GA4_PROPERTY_ID || !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return { configured: false, message: NOT_CONFIGURED_MESSAGE };
  }
  try {
    switch (toolName) {
      case 'get_ga4_snapshot': return await getGa4Snapshot(input);
      default: return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:ga4-ops] Tool ${toolName} failed:`, err);
    return { error: err.message };
  }
}

module.exports = { GA4_OPS_TOOLS, executeGa4OpsTool };
