/**
 * Intelligence Bar — Apify Account Ops Tools
 * server/services/intelligence-bar/apify-ops-tools.js
 *
 * One read: account usage/credits plus the latest actor runs. Apify powers
 * the vendor price-scan scraping; the account is usage-billed, so exhausted
 * credits kill the scans silently — the same failure class as DataForSEO.
 *
 * Auth: the APIFY_API_TOKEN already configured. Read-only.
 */

const logger = require('../logger');

const APIFY_API_BASE = process.env.APIFY_API_BASE || 'https://api.apify.com';
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RUNS_SHOWN = 10;

const APIFY_OPS_TOOLS = [
  {
    name: 'get_apify_status',
    description: `Apify account state: current monthly usage vs plan limit and the most recent actor runs with their statuses. Apify powers the vendor price-scan scraping — exhausted credits or failing runs kill it silently.
Use for: "is the price scan still running?", "how much Apify credit is left this month?", "did the last scrape succeed?"`,
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
];

const NOT_CONFIGURED_MESSAGE = 'Apify access is not configured. APIFY_API_TOKEN must be set in the Railway dashboard.';

async function apifyGet(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${APIFY_API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${process.env.APIFY_API_TOKEN}` },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error('Apify rejected the token — check APIFY_API_TOKEN.');
    }
    if (!res.ok) throw new Error(`Apify API returned HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Apify API timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function getApifyStatus() {
  const [limitsJson, runsJson] = await Promise.all([
    apifyGet('/v2/users/me/limits'),
    apifyGet(`/v2/actor-runs?limit=${MAX_RUNS_SHOWN}&desc=true`),
  ]);
  const limits = limitsJson?.data || {};
  const current = limits.current || {};
  const max = limits.limits || {};
  const runs = (runsJson?.data?.items || []).map(run => ({
    actor_id: run.actId || null,
    status: run.status || null,
    started_at: run.startedAt || null,
    finished_at: run.finishedAt || null,
    usage_usd: run.usageTotalUsd != null ? Number(run.usageTotalUsd) : null,
  }));
  return {
    monthly_usage_usd: current.monthlyUsageUsd != null ? Number(current.monthlyUsageUsd) : null,
    monthly_usage_limit_usd: max.maxMonthlyUsageUsd != null ? Number(max.maxMonthlyUsageUsd) : null,
    recent_runs: runs,
    failed_recent: runs.filter(r => r.status && r.status !== 'SUCCEEDED' && r.status !== 'RUNNING' && r.status !== 'READY').length,
    note: 'Live Apify account state. Runs with status FAILED/ABORTED/TIMED-OUT mean a scrape did not complete; usage at the monthly limit stops all scraping silently. Changes happen in the Apify console, never through this tool.',
  };
}

async function executeApifyOpsTool(toolName) {
  // "Not configured" is the expected DARK state, not a failure — an
  // { error } result would count against the shared admin circuit breaker
  // (see ops-tools.js for the full rationale).
  if (!process.env.APIFY_API_TOKEN) {
    return { configured: false, message: NOT_CONFIGURED_MESSAGE };
  }
  try {
    switch (toolName) {
      case 'get_apify_status': return await getApifyStatus();
      default: return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:apify-ops] Tool ${toolName} failed:`, err);
    return { error: err.message };
  }
}

module.exports = { APIFY_OPS_TOOLS, executeApifyOpsTool };
