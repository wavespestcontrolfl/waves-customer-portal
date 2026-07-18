/**
 * Intelligence Bar — Google Ads Ops Tools
 * server/services/intelligence-bar/google-ads-ops-tools.js
 *
 * Read-only visibility into LIVE Google Ads serving state — the failure
 * modes the budget automation cannot see. The ad_campaigns table mirrors
 * campaigns on a sync cadence and the budget cron reconciles spend targets,
 * but a policy disapproval, a limited-serving state, or a paused campaign is
 * invisible until someone opens the Ads UI. These tools ask Google directly.
 *
 * Reuses the google-ads.js client (same env credentials as the budget
 * automation). NO mutations here — pause/enable/budget changes stay behind
 * the budget-manager's own controls.
 */

const { enums } = require('google-ads-api');
const { isConfigured, getCustomer } = require('../ads/google-ads');
const logger = require('../logger');

const MAX_DISAPPROVALS_SHOWN = 50;
const MAX_POLICY_TOPICS_PER_AD = 10;

// The client can return enum fields as numbers (the campaign sync's
// mapStatus handles the same case) — resolve them to names so the operator
// reads "PAUSED", never an opaque 3.
function enumName(table, value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return table?.[value] ?? String(value);
  return value;
}

const GOOGLE_ADS_OPS_TOOLS = [
  {
    name: 'get_google_ads_serving_status',
    description: `LIVE Google Ads campaign serving state: status (enabled/paused), primary_status with reasons (why a campaign is NOT serving or is limited — e.g. policy issues, budget constraints, billing problems), and current daily budget. This is the processor-side truth the local ad_campaigns mirror and budget automation cannot see in real time.
Use for: "are the ads running?", "why isn't the Parrish campaign serving?", "is anything limited or paused?"`,
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_google_ads_disapprovals',
    description: `LIVE list of ads whose policy approval is not APPROVED (disapproved or approved-limited), with the policy topics involved. A disapproved ad silently stops serving — nothing local records it.
Use for: "any disapproved ads?", "policy problems in Google Ads?"`,
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
];

const NOT_CONFIGURED_MESSAGE = 'Google Ads access is not configured. GOOGLE_ADS_DEVELOPER_TOKEN / GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET / GOOGLE_ADS_REFRESH_TOKEN / GOOGLE_ADS_CUSTOMER_ID must be set in the Railway dashboard.';

async function getServingStatus() {
  const customer = getCustomer();
  const rows = await customer.query(`
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.primary_status,
      campaign.primary_status_reasons,
      campaign_budget.amount_micros
    FROM campaign
    WHERE campaign.status != 'REMOVED'
  `);
  const campaigns = rows.map(row => ({
    id: String(row.campaign.id),
    name: row.campaign.name,
    status: enumName(enums.CampaignStatus, row.campaign.status),
    primary_status: enumName(enums.CampaignPrimaryStatus, row.campaign.primary_status),
    primary_status_reasons: (row.campaign.primary_status_reasons || [])
      .map(reason => enumName(enums.CampaignPrimaryStatusReason, reason)),
    daily_budget: row.campaign_budget?.amount_micros != null
      ? Number(row.campaign_budget.amount_micros) / 1_000_000
      : null,
  }));
  return {
    campaigns,
    total: campaigns.length,
    note: 'Live Google Ads state; daily_budget is dollars. primary_status_reasons explain a campaign that is not serving or serving limited. Budget CHANGES go through /admin/ads, never through this tool.',
  };
}

async function getDisapprovals() {
  const customer = getCustomer();
  const rows = await customer.query(`
    SELECT
      campaign.name,
      ad_group.name,
      ad_group_ad.ad.id,
      ad_group_ad.status,
      ad_group_ad.policy_summary.approval_status,
      ad_group_ad.policy_summary.policy_topic_entries
    FROM ad_group_ad
    WHERE ad_group_ad.policy_summary.approval_status != 'APPROVED'
      AND ad_group_ad.status != 'REMOVED'
  `);
  const ads = rows.slice(0, MAX_DISAPPROVALS_SHOWN).map(row => ({
    campaign: row.campaign?.name || null,
    ad_group: row.ad_group?.name || null,
    ad_id: row.ad_group_ad?.ad?.id != null ? String(row.ad_group_ad.ad.id) : null,
    status: enumName(enums.AdGroupAdStatus, row.ad_group_ad?.status),
    approval_status: enumName(enums.PolicyApprovalStatus, row.ad_group_ad?.policy_summary?.approval_status),
    policy_topics: (row.ad_group_ad?.policy_summary?.policy_topic_entries || [])
      .slice(0, MAX_POLICY_TOPICS_PER_AD)
      .map(entry => ({ topic: entry.topic || null, type: enumName(enums.PolicyTopicEntryType, entry.type) })),
  }));
  return {
    ads,
    total: rows.length,
    truncated: rows.length > MAX_DISAPPROVALS_SHOWN,
    note: 'Ads with approval status other than APPROVED. Fixing a disapproval happens in the Google Ads UI — you cannot edit or appeal from here.',
  };
}

async function executeGoogleAdsOpsTool(toolName, input = {}) {
  // "Not configured" is the expected DARK state, not a failure — an
  // { error } result would count against the shared admin circuit breaker
  // (see ops-tools.js for the full rationale).
  if (!isConfigured()) {
    return { configured: false, message: NOT_CONFIGURED_MESSAGE };
  }
  try {
    switch (toolName) {
      case 'get_google_ads_serving_status': return await getServingStatus();
      case 'get_google_ads_disapprovals': return await getDisapprovals();
      default: return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:google-ads-ops] Tool ${toolName} failed:`, err);
    return { error: err.message };
  }
}

module.exports = { GOOGLE_ADS_OPS_TOOLS, executeGoogleAdsOpsTool };
