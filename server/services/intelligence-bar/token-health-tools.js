/**
 * Intelligence Bar — Integration Token Health Tools
 * server/services/intelligence-bar/token-health-tools.js
 *
 * One read over the persisted credential checks in token_credentials
 * (written by services/token-health.js on the daily scheduler + the admin
 * dashboard's manual check). Answers "is everything still connected?"
 * across every third-party integration — including ones like meta_ads that
 * have code but no completed OAuth yet, which show up here as broken or
 * unconfigured instead of being invisible.
 *
 * Read-only over ops metadata: platform names, statuses, env var NAMES,
 * timestamps, and check errors — never token values.
 */

const TokenHealthService = require('../token-health');
const logger = require('../logger');

// Sort unhealthy first so the answer leads with what needs attention.
const STATUS_RANK = { broken: 0, expired: 0, error: 0, expiring: 1, unknown: 2, unconfigured: 3, healthy: 4, valid: 4 };

const TOKEN_HEALTH_TOOLS = [
  {
    name: 'get_integration_token_health',
    description: `Health of every third-party API credential (Google Ads, GBP per location, Meta, Stripe, Twilio, SendGrid, DataForSEO, GitHub, AI providers, …) from the persisted daily checks: status, last verified time, expiry, and the last check error. The cross-integration "is everything still connected?" answer.
Use for: "are all integrations healthy?", "is anything disconnected or expiring?", "why is GBP posting failing?"`,
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
];

async function getIntegrationTokenHealth() {
  const rows = await TokenHealthService.getAll();
  const platforms = rows.map(r => ({
    platform: r.platform,
    token_type: r.token_type || null,
    status: r.status || 'unknown',
    last_verified_at: r.last_verified_at ? new Date(r.last_verified_at).toISOString() : null,
    expires_at: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    // Check errors name the failing platform/env var — never token values.
    last_error: r.last_error || null,
    env_var_name: r.env_var_name || null,
  }));
  platforms.sort((a, b) => {
    const rank = (STATUS_RANK[a.status] ?? 2) - (STATUS_RANK[b.status] ?? 2);
    return rank !== 0 ? rank : a.platform.localeCompare(b.platform);
  });
  const unhealthy = platforms.filter(p => (STATUS_RANK[p.status] ?? 2) < 2).length;
  return {
    platforms,
    total: platforms.length,
    unhealthy,
    note: 'Persisted results from the scheduled credential checks — last_verified_at shows staleness; the checks refresh daily and from the admin dashboard. Reconnecting an integration happens in /admin/settings, never through this tool.',
  };
}

async function executeTokenHealthTool(toolName) {
  try {
    switch (toolName) {
      case 'get_integration_token_health': return await getIntegrationTokenHealth();
      default: return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:token-health] Tool ${toolName} failed:`, err);
    return { error: err.message };
  }
}

module.exports = { TOKEN_HEALTH_TOOLS, executeTokenHealthTool };
