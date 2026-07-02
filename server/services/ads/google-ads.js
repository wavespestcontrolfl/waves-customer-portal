const { GoogleAdsApi, enums } = require('google-ads-api');
const { v4: uuidv4 } = require('uuid');
const db = require('../../models/db');
const logger = require('../../services/logger');

// ---------------------------------------------------------------------------
// Google Ads API integration — syncs campaigns, performance, search terms
// and supports remote budget / status changes.
// ---------------------------------------------------------------------------

let _client = null;
let _customer = null;

/**
 * Returns true when all required env vars are present.
 */
function isConfigured() {
  return !!(
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN &&
    process.env.GOOGLE_ADS_CLIENT_ID &&
    process.env.GOOGLE_ADS_CLIENT_SECRET &&
    process.env.GOOGLE_ADS_REFRESH_TOKEN &&
    process.env.GOOGLE_ADS_CUSTOMER_ID
  );
}

/**
 * Lazy-initialise the API client + customer handle.
 */
function getCustomer() {
  if (!isConfigured()) return null;

  if (!_client) {
    _client = new GoogleAdsApi({
      client_id: process.env.GOOGLE_ADS_CLIENT_ID,
      client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
      developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    });
  }

  if (!_customer) {
    const opts = {
      customer_id: process.env.GOOGLE_ADS_CUSTOMER_ID,
      refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
    };
    if (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) {
      opts.login_customer_id = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
    }
    _customer = _client.Customer(opts);
  }

  return _customer;
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------
const STATUS_MAP = {
  ENABLED: 'active',
  PAUSED: 'paused',
  REMOVED: 'removed',
};

function mapStatus(googleStatus) {
  const status = typeof googleStatus === 'number'
    ? enums.CampaignStatus[googleStatus]
    : googleStatus;
  return STATUS_MAP[status] || 'unknown';
}

// ---------------------------------------------------------------------------
// syncCampaigns — pull all campaigns, upsert into ad_campaigns
// ---------------------------------------------------------------------------
async function syncCampaigns() {
  const customer = getCustomer();
  if (!customer) return [];

  try {
    logger.info('[google-ads] Syncing campaigns');

    const campaigns = await customer.query(`
      SELECT
        campaign.id,
        campaign.name,
        campaign.status,
        campaign_budget.amount_micros,
        campaign.advertising_channel_type,
        metrics.impressions,
        metrics.clicks,
        metrics.cost_micros,
        metrics.conversions,
        metrics.conversions_value
      FROM campaign
      WHERE campaign.status != 'REMOVED'
    `);

    const results = [];

    for (const row of campaigns) {
      const platformId = String(row.campaign.id);
      const dailyBudget = row.campaign_budget?.amount_micros
        ? Number(row.campaign_budget.amount_micros) / 1_000_000
        : null;

      const data = {
        platform: 'google_ads',
        platform_campaign_id: platformId,
        campaign_name: row.campaign.name,
        status: mapStatus(row.campaign.status),
        campaign_type: row.campaign.advertising_channel_type || null,
        daily_budget_base: dailyBudget,
        daily_budget_current: dailyBudget,
        updated_at: new Date(),
      };

      // Upsert — match on platform + platform_campaign_id
      const existing = await db('ad_campaigns')
        .where({ platform: 'google_ads', platform_campaign_id: platformId })
        .first();

      if (existing) {
        await db('ad_campaigns').where({ id: existing.id }).update(data);
        results.push({ ...existing, ...data });
      } else {
        const [inserted] = await db('ad_campaigns')
          .insert({ id: uuidv4(), ...data, created_at: new Date() })
          .returning('*');
        results.push(inserted);
      }
    }

    logger.info(`[google-ads] Synced ${results.length} campaigns`);
    return results;
  } catch (err) {
    logger.error(`[google-ads] syncCampaigns failed: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// syncDailyPerformance — pull per-campaign metrics for the last N days
// ---------------------------------------------------------------------------
// GAQL date range for the trailing `days` window. Google Ads requires a FINITE
// range on segments.date (query_error 55 otherwise) AND 'YYYY-MM-DD' literals —
// the old code used an open-ended `>= 'YYYYMMDD'`, which threw on every run, so
// no performance/search-term rows were ever stored. Returns dashed start/end.
function gaqlDateRange(days, now = new Date()) {
  const fmt = (d) => d.toISOString().split('T')[0]; // YYYY-MM-DD
  const since = new Date(now.getTime() - days * 86400000);
  return { since: fmt(since), until: fmt(now) };
}

async function syncDailyPerformance(days = 7) {
  const customer = getCustomer();
  if (!customer) return [];

  try {
    logger.info(`[google-ads] Syncing daily performance (last ${days} days)`);

    const { since: sinceStr, until: untilStr } = gaqlDateRange(days);

    const rows = await customer.query(`
      SELECT
        campaign.id,
        segments.date,
        metrics.impressions,
        metrics.clicks,
        metrics.cost_micros,
        metrics.conversions,
        metrics.conversions_value,
        metrics.ctr,
        metrics.average_cpc
      FROM campaign
      WHERE segments.date BETWEEN '${sinceStr}' AND '${untilStr}'
        AND campaign.status != 'REMOVED'
    `);

    const results = [];

    for (const row of rows) {
      const platformId = String(row.campaign.id);
      const date = row.segments.date; // YYYY-MM-DD

      // Look up our local campaign id
      const campaign = await db('ad_campaigns')
        .where({ platform: 'google_ads', platform_campaign_id: platformId })
        .first();
      if (!campaign) continue;

      const costDollars = Number(row.metrics.cost_micros || 0) / 1_000_000;
      const conversions = Number(row.metrics.conversions || 0);
      const conversionValue = Number(row.metrics.conversions_value || 0);
      const clicks = Number(row.metrics.clicks || 0);
      const impressions = Number(row.metrics.impressions || 0);
      const avgCpc = Number(row.metrics.average_cpc || 0) / 1_000_000;
      const ctr = Number(row.metrics.ctr || 0);
      const roas = costDollars > 0 ? conversionValue / costDollars : 0;

      const data = {
        campaign_id: campaign.id,
        date,
        impressions,
        clicks,
        cost: costDollars,
        conversions,
        conversion_value: conversionValue,
        ctr: Math.round(ctr * 10000) / 100, // fraction → percentage
        avg_cpc: avgCpc,
        roas: Math.round(roas * 100) / 100,
        updated_at: new Date(),
      };

      const existing = await db('ad_performance_daily')
        .where({ campaign_id: campaign.id, date })
        .first();

      if (existing) {
        await db('ad_performance_daily').where({ id: existing.id }).update(data);
      } else {
        await db('ad_performance_daily')
          .insert({ id: uuidv4(), ...data, created_at: new Date() });
      }

      results.push(data);
    }

    logger.info(`[google-ads] Synced ${results.length} daily performance rows`);
    return results;
  } catch (err) {
    logger.error(`[google-ads] syncDailyPerformance failed: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// syncSearchTerms — pull search term report for last N days
// ---------------------------------------------------------------------------
async function syncSearchTerms(days = 30) {
  const customer = getCustomer();
  if (!customer) return [];

  try {
    logger.info(`[google-ads] Syncing search terms (last ${days} days)`);

    const { since: sinceStr, until: untilStr } = gaqlDateRange(days);

    const rows = await customer.query(`
      SELECT
        campaign.id,
        search_term_view.search_term,
        search_term_view.status,
        metrics.impressions,
        metrics.clicks,
        metrics.cost_micros,
        metrics.conversions,
        metrics.conversions_value
      FROM search_term_view
      WHERE segments.date BETWEEN '${sinceStr}' AND '${untilStr}'
        AND campaign.status != 'REMOVED'
    `);

    const results = [];

    for (const row of rows) {
      const platformId = String(row.campaign.id);
      const searchTerm = row.search_term_view.search_term;

      const campaign = await db('ad_campaigns')
        .where({ platform: 'google_ads', platform_campaign_id: platformId })
        .first();
      if (!campaign) continue;

      const costDollars = Number(row.metrics.cost_micros || 0) / 1_000_000;

      const data = {
        campaign_id: campaign.id,
        search_term: searchTerm,
        match_type: row.search_term_view.status || null,
        impressions: Number(row.metrics.impressions || 0),
        clicks: Number(row.metrics.clicks || 0),
        cost: costDollars,
        conversions: Number(row.metrics.conversions || 0),
        conversion_value: Number(row.metrics.conversions_value || 0),
        updated_at: new Date(),
      };

      // Upsert on campaign_id + search_term
      const existing = await db('ad_search_terms')
        .where({ campaign_id: campaign.id, search_term: searchTerm })
        .first();

      if (existing) {
        await db('ad_search_terms').where({ id: existing.id }).update(data);
      } else {
        await db('ad_search_terms')
          .insert({ id: uuidv4(), ...data, created_at: new Date() });
      }

      results.push(data);
    }

    logger.info(`[google-ads] Synced ${results.length} search terms`);
    return results;
  } catch (err) {
    logger.error(`[google-ads] syncSearchTerms failed: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// fetchCallViews - read Google Ads call reporting rows for attribution bridge
// ---------------------------------------------------------------------------
function buildCallViewQuery(days = 30, limit = 200) {
  const safeDays = Math.min(Math.max(parseInt(days, 10) || 30, 1), 90);
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 500);
  const since = new Date(Date.now() - safeDays * 86400000);
  const sinceStr = since.toISOString().split('T')[0];

  return `
    SELECT
      call_view.resource_name,
      call_view.caller_area_code,
      call_view.caller_country_code,
      call_view.call_duration_seconds,
      call_view.call_status,
      call_view.call_tracking_display_location,
      call_view.end_call_date_time,
      call_view.start_call_date_time,
      call_view.type,
      campaign.id,
      campaign.name,
      ad_group.id,
      ad_group.name
    FROM call_view
    WHERE call_view.start_call_date_time >= '${sinceStr}'
    ORDER BY call_view.start_call_date_time DESC
    LIMIT ${safeLimit}
  `;
}

async function fetchCallViews(days = 30, limit = 200, { strict = false } = {}) {
  const customer = getCustomer();
  if (!customer) return [];

  try {
    logger.info(`[google-ads] Fetching call view rows (last ${days} days)`);
    return await customer.query(buildCallViewQuery(days, limit));
  } catch (err) {
    logger.error(`[google-ads] fetchCallViews failed: ${err.message}`);
    // strict: the call bridge must be able to tell "no calls" apart from
    // "scan failed" — its unclaimed→organic fallback would otherwise declare
    // boundary-age paid calls organic off a blind scan during an API outage.
    if (strict) throw err;
    return [];
  }
}

// ---------------------------------------------------------------------------
// pauseCampaign — set campaign status to PAUSED via Google Ads API
// ---------------------------------------------------------------------------
async function pauseCampaign(platformCampaignId) {
  const customer = getCustomer();
  if (!customer) return null;

  try {
    logger.info(`[google-ads] Pausing campaign ${platformCampaignId}`);

    await customer.mutateResources([
      {
        entity: 'campaign',
        operation: 'update',
        resource: {
          resource_name: `customers/${process.env.GOOGLE_ADS_CUSTOMER_ID}/campaigns/${platformCampaignId}`,
          status: enums.CampaignStatus.PAUSED,
        },
      },
    ]);

    logger.info(`[google-ads] Campaign ${platformCampaignId} paused`);
    return { success: true, platformCampaignId, status: 'paused' };
  } catch (err) {
    logger.error(`[google-ads] pauseCampaign failed: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// enableCampaign — set campaign status to ENABLED via Google Ads API
// ---------------------------------------------------------------------------
async function enableCampaign(platformCampaignId) {
  const customer = getCustomer();
  if (!customer) return null;

  try {
    logger.info(`[google-ads] Enabling campaign ${platformCampaignId}`);

    await customer.mutateResources([
      {
        entity: 'campaign',
        operation: 'update',
        resource: {
          resource_name: `customers/${process.env.GOOGLE_ADS_CUSTOMER_ID}/campaigns/${platformCampaignId}`,
          status: enums.CampaignStatus.ENABLED,
        },
      },
    ]);

    logger.info(`[google-ads] Campaign ${platformCampaignId} enabled`);
    return { success: true, platformCampaignId, status: 'active' };
  } catch (err) {
    logger.error(`[google-ads] enableCampaign failed: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// updateBudget — change a campaign's daily budget via Google Ads API
// ---------------------------------------------------------------------------
async function updateBudget(platformCampaignId, dailyBudgetDollars) {
  const customer = getCustomer();
  if (!customer) return null;

  try {
    logger.info(`[google-ads] Updating budget for campaign ${platformCampaignId} to $${dailyBudgetDollars}/day`);

    // First, get the campaign's budget resource name
    const [campaignData] = await customer.query(`
      SELECT campaign.id, campaign.campaign_budget
      FROM campaign
      WHERE campaign.id = ${platformCampaignId}
    `);

    if (!campaignData || !campaignData.campaign.campaign_budget) {
      logger.error(`[google-ads] Campaign ${platformCampaignId} not found or has no budget`);
      return null;
    }

    const budgetResourceName = campaignData.campaign.campaign_budget;
    const amountMicros = Math.round(dailyBudgetDollars * 1_000_000);

    await customer.mutateResources([
      {
        entity: 'campaign_budget',
        operation: 'update',
        resource: {
          resource_name: budgetResourceName,
          amount_micros: amountMicros,
        },
      },
    ]);

    logger.info(`[google-ads] Budget updated for campaign ${platformCampaignId}: $${dailyBudgetDollars}/day`);
    return { success: true, platformCampaignId, dailyBudget: dailyBudgetDollars };
  } catch (err) {
    logger.error(`[google-ads] updateBudget failed: ${err.message}`);
    return null;
  }
}

module.exports = {
  isConfigured,
  syncCampaigns,
  syncDailyPerformance,
  syncSearchTerms,
  fetchCallViews,
  pauseCampaign,
  enableCampaign,
  updateBudget,
  _private: {
    buildCallViewQuery,
    gaqlDateRange,
  },
};
