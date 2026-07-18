/**
 * Intelligence Bar — Meta Ads Ops Tools
 * server/services/intelligence-bar/meta-ads-ops-tools.js
 *
 * Read-only visibility into LIVE Meta (Facebook/Instagram) ads delivery —
 * the mirror of the Google Ads ops module. effective_status is Meta's
 * "why isn't this actually delivering" field, and issues_info carries the
 * disapproval detail; neither reaches the local ad_campaigns mirror.
 *
 * Reuses the meta-ads.js Graph client (same META_ADS_ACCESS_TOKEN the sync
 * uses). NO mutations — there is no exported write surface at all.
 */

const { isConfigured, graphGet } = require('../ads/meta-ads');
const logger = require('../logger');

const MAX_ISSUES_PER_AD = 5;
const MAX_ISSUE_MESSAGE_LENGTH = 200;

const META_ADS_OPS_TOOLS = [
  {
    name: 'get_meta_ads_delivery_status',
    description: `LIVE Meta Ads campaign delivery state: configured status vs effective_status (what is ACTUALLY happening — WITH_ISSUES, PAUSED by a parent, IN_PROCESS, disapproved) plus daily budget.
Use for: "are the Meta ads delivering?", "why isn't the Facebook campaign running?"`,
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_meta_ads_issues',
    description: `LIVE list of Meta ads whose effective_status is WITH_ISSUES or DISAPPROVED, with the error summaries. A flagged ad silently stops delivering — nothing local records it.
Use for: "any disapproved Meta ads?", "policy problems on Facebook/Instagram?"`,
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
];

const NOT_CONFIGURED_MESSAGE = 'Meta Ads access is not configured. META_ADS_ACCESS_TOKEN and META_ADS_ACCOUNT_ID must be set in the Railway dashboard.';

async function getDeliveryStatus() {
  const rows = await graphGet('campaigns', {
    fields: 'name,status,effective_status,daily_budget',
  });
  const campaigns = rows.map(row => ({
    id: row.id,
    name: row.name,
    status: row.status || null,
    effective_status: row.effective_status || null,
    // Meta budgets arrive as cent-strings
    daily_budget: row.daily_budget != null ? Number(row.daily_budget) / 100 : null,
  }));
  return {
    campaigns,
    total: campaigns.length,
    note: 'Live Meta state; daily_budget is dollars. effective_status is what is ACTUALLY happening (a campaign can be ACTIVE by configuration but not delivering). Changes happen in Ads Manager, never through this tool.',
  };
}

async function getIssues() {
  const rows = await graphGet('ads', {
    fields: 'name,effective_status,issues_info,campaign{name}',
    params: { filtering: [{ field: 'effective_status', operator: 'IN', value: ['WITH_ISSUES', 'DISAPPROVED'] }] },
  });
  const ads = rows.map(row => ({
    id: row.id,
    name: row.name,
    campaign: row.campaign?.name || null,
    effective_status: row.effective_status || null,
    issues: (row.issues_info || []).slice(0, MAX_ISSUES_PER_AD).map(issue => ({
      level: issue.level || null,
      summary: issue.error_summary ? String(issue.error_summary).slice(0, MAX_ISSUE_MESSAGE_LENGTH) : null,
      message: issue.error_message ? String(issue.error_message).slice(0, MAX_ISSUE_MESSAGE_LENGTH) : null,
    })),
  }));
  return {
    ads,
    total: ads.length,
    note: 'Ads whose effective_status is WITH_ISSUES or DISAPPROVED. Fixing them happens in Meta Ads Manager — you cannot edit or appeal from here.',
  };
}

async function executeMetaAdsOpsTool(toolName, input = {}) {
  // "Not configured" is the expected DARK state, not a failure — an
  // { error } result would count against the shared admin circuit breaker
  // (see ops-tools.js for the full rationale).
  if (!isConfigured()) {
    return { configured: false, message: NOT_CONFIGURED_MESSAGE };
  }
  try {
    switch (toolName) {
      case 'get_meta_ads_delivery_status': return await getDeliveryStatus();
      case 'get_meta_ads_issues': return await getIssues();
      default: return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:meta-ads-ops] Tool ${toolName} failed:`, err);
    return { error: err.message };
  }
}

module.exports = { META_ADS_OPS_TOOLS, executeMetaAdsOpsTool };
