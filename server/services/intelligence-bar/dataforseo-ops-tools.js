/**
 * Intelligence Bar — DataForSEO Account Ops Tools
 * server/services/intelligence-bar/dataforseo-ops-tools.js
 *
 * One read: the prepaid account balance. DataForSEO powers rank tracking
 * and SERP audits across the spoke fleet; if the credits run dry the
 * pipelines fail silently until someone checks the dashboard.
 *
 * Auth: same DATAFORSEO_LOGIN/PASSWORD basic-auth the SEO pipeline uses.
 * This deliberately does NOT route through services/seo/dataforseo.js — the
 * seoIntelligence feature gate there governs SEO task spending, and an
 * account-balance read must work even when that gate is off.
 */

const logger = require('../logger');

const DATAFORSEO_API_BASE = process.env.DATAFORSEO_API_BASE || 'https://api.dataforseo.com';
const REQUEST_TIMEOUT_MS = 15000;

const DATAFORSEO_OPS_TOOLS = [
  {
    name: 'get_dataforseo_balance',
    description: `Current DataForSEO prepaid balance and usage counters. The account is prepaid — at $0 rank tracking and SERP audits stop silently.
Use for: "how many DataForSEO credits are left?", "is rank tracking about to run out of budget?"`,
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
];

const NOT_CONFIGURED_MESSAGE = 'DataForSEO access is not configured. DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD must be set in the Railway dashboard.';

async function getDataforseoBalance() {
  const auth = 'Basic ' + Buffer.from(`${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`).toString('base64');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${DATAFORSEO_API_BASE}/v3/appendix/user_data`, {
      headers: { Authorization: auth },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error('DataForSEO rejected the credentials — check DATAFORSEO_LOGIN/DATAFORSEO_PASSWORD.');
    }
    if (!res.ok) throw new Error(`DataForSEO API returned HTTP ${res.status}`);
    const json = await res.json();
    const result = json?.tasks?.[0]?.result?.[0];
    if (!result) throw new Error('DataForSEO returned no account data');
    const money = result.money || {};
    return {
      balance: typeof money.balance === 'number' ? money.balance : null,
      total_spent: typeof money.total === 'number' ? money.total : null,
      rates_limits: result.limits?.day || null,
      note: 'Balance is USD on a prepaid account — top-ups happen in the DataForSEO dashboard. Rank tracking and SERP audits stop silently at $0.',
    };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`DataForSEO API timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function executeDataforseoOpsTool(toolName) {
  // "Not configured" is the expected DARK state, not a failure — an
  // { error } result would count against the shared admin circuit breaker
  // (see ops-tools.js for the full rationale).
  if (!process.env.DATAFORSEO_LOGIN || !process.env.DATAFORSEO_PASSWORD) {
    return { configured: false, message: NOT_CONFIGURED_MESSAGE };
  }
  try {
    switch (toolName) {
      case 'get_dataforseo_balance': return await getDataforseoBalance();
      default: return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:dataforseo-ops] Tool ${toolName} failed:`, err);
    return { error: err.message };
  }
}

module.exports = { DATAFORSEO_OPS_TOOLS, executeDataforseoOpsTool };
