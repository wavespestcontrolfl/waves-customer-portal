const { v4: uuidv4 } = require('uuid');
const db = require('../../models/db');
const logger = require('../../services/logger');
const { runExclusive } = require('../../utils/cron-lock');

// ---------------------------------------------------------------------------
// Meta (Facebook/Instagram) Ads — Marketing API ingestion. Mirrors
// services/ads/google-ads.js: syncs campaigns + daily performance into the
// SAME ad_campaigns / ad_performance_daily tables with platform='facebook', so
// the existing (platform-agnostic) PPC dashboard surfaces Meta automatically.
//
// Read-only ingestion: pulls /act_<id>/campaigns and /act_<id>/insights via the
// Graph API. Remote budget/pause control is intentionally out of scope here
// (Google keeps that; Meta campaigns are managed in Ads Manager for now).
// ---------------------------------------------------------------------------

const GRAPH = 'https://graph.facebook.com';
const PLATFORM = 'facebook';
const PAGE_LIMIT = 200;
const MAX_PAGES = 25; // pagination backstop

function apiVersion() {
  // Meta deprecates Marketing API versions roughly yearly — keep META_ADS_API_VERSION
  // set to a currently-supported version (this default can go stale).
  return process.env.META_ADS_API_VERSION || 'v23.0';
}

/** Normalize META_ADS_ACCOUNT_ID to the `act_<digits>` form Graph expects. */
function accountId() {
  const raw = String(process.env.META_ADS_ACCOUNT_ID || '').trim();
  if (!raw) return null;
  return raw.startsWith('act_') ? raw : `act_${raw.replace(/\D/g, '')}`;
}

function isConfigured() {
  return !!(process.env.META_ADS_ACCESS_TOKEN && accountId());
}

// ---------------------------------------------------------------------------
// Graph API GET with cursor pagination. Returns the concatenated `data` rows.
// ---------------------------------------------------------------------------
async function graphGet(edge, { fields, params = {} } = {}) {
  const token = process.env.META_ADS_ACCESS_TOKEN;
  const acct = accountId();
  if (!token || !acct) return [];

  const first = new URL(`${GRAPH}/${apiVersion()}/${acct}/${edge}`);
  if (fields) first.searchParams.set('fields', fields);
  for (const [k, v] of Object.entries(params)) {
    first.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  first.searchParams.set('limit', String(PAGE_LIMIT));
  first.searchParams.set('access_token', token);

  const out = [];
  let next = first.toString();
  let pages = 0;
  while (next && pages < MAX_PAGES) {
    pages += 1;
    const resp = await fetch(next);
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || json.error) {
      throw new Error(`Meta API ${edge}: ${json.error?.message || `HTTP ${resp.status}`}`);
    }
    if (Array.isArray(json.data)) out.push(...json.data);
    next = json.paging?.next || null;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pure mappers (exported for tests)
// ---------------------------------------------------------------------------
const STATUS_MAP = {
  ACTIVE: 'active',
  PAUSED: 'paused',
  ARCHIVED: 'removed',
  DELETED: 'removed',
};
function mapStatus(metaStatus) {
  return STATUS_MAP[String(metaStatus || '').toUpperCase()] || 'unknown';
}

// Meta returns lead/result actions in an `actions` array of {action_type, value}.
// The roll-up types (`lead`, `omni_purchase`) ALREADY include their component
// events (onsite/offsite pixel variants), so summing the aggregate together with
// its components double-counts conversions (and, via action_values, doubles
// conversion_value → halves CAC / doubles ROAS). Group them and take the
// aggregate when Meta returns it, otherwise the sum of the components.
const CONVERSION_GROUPS = [
  { aggregate: 'lead', components: ['onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead'] },
  { aggregate: 'omni_purchase', components: ['purchase', 'offsite_conversion.fb_pixel_purchase'] },
  { aggregate: null, components: ['offsite_conversion.fb_pixel_complete_registration'] },
];

function sumActions(actions) {
  if (!Array.isArray(actions)) return 0;
  const byType = new Map();
  for (const a of actions) {
    if (!a || !a.action_type) continue;
    byType.set(a.action_type, (byType.get(a.action_type) || 0) + (Number(a.value) || 0));
  }
  let total = 0;
  for (const g of CONVERSION_GROUPS) {
    if (g.aggregate && byType.has(g.aggregate)) {
      total += byType.get(g.aggregate); // deduped roll-up already covers components
    } else {
      for (const c of g.components) total += byType.get(c) || 0;
    }
  }
  return total;
}

function mapCampaign(row) {
  // daily_budget is in the account's MINOR units (cents for USD).
  const dailyBudget = row.daily_budget != null && row.daily_budget !== ''
    ? Number(row.daily_budget) / 100
    : null;
  return {
    platform: PLATFORM,
    platform_campaign_id: String(row.id),
    campaign_name: row.name,
    status: mapStatus(row.effective_status || row.status),
    campaign_type: row.objective || null,
    daily_budget_base: Number.isFinite(dailyBudget) ? dailyBudget : null,
    daily_budget_current: Number.isFinite(dailyBudget) ? dailyBudget : null,
    updated_at: new Date(),
  };
}

function mapInsightRow(row) {
  // Meta `spend`/`cpc` are decimal strings in account-currency MAJOR units; `ctr`
  // is already a percentage. (Google stores ctr as a percentage too.)
  const cost = Number(row.spend || 0);
  const conversions = sumActions(row.actions);
  const conversionValue = sumActions(row.action_values);
  const roas = cost > 0 ? conversionValue / cost : 0;
  return {
    date: row.date_start, // time_increment=1 → date_start === the day
    impressions: Number(row.impressions || 0),
    clicks: Number(row.clicks || 0),
    cost,
    conversions,
    conversion_value: conversionValue,
    ctr: Math.round(Number(row.ctr || 0) * 100) / 100,
    avg_cpc: Number(row.cpc || 0),
    roas: Math.round(roas * 100) / 100,
    updated_at: new Date(),
  };
}

function dateStr(d) {
  return new Date(d).toISOString().split('T')[0];
}

// ---------------------------------------------------------------------------
// syncCampaigns — upsert into ad_campaigns (platform='facebook')
// ---------------------------------------------------------------------------
async function syncCampaigns() {
  if (!isConfigured()) return [];
  // Serialize across overlapping Railway instances / the admin /sync/meta
  // endpoint: ad_campaigns has no unique (platform, platform_campaign_id), so two
  // concurrent first-time syncs could both insert and duplicate a campaign.
  const out = await runExclusive('meta-ads-campaigns', () => syncCampaignsLocked());
  return Array.isArray(out) ? out : [];
}

async function syncCampaignsLocked() {
  try {
    logger.info('[meta-ads] Syncing campaigns');
    const rows = await graphGet('campaigns', {
      fields: 'id,name,status,effective_status,objective,daily_budget',
    });

    const results = [];
    for (const row of rows) {
      const data = mapCampaign(row);
      const existing = await db('ad_campaigns')
        .where({ platform: PLATFORM, platform_campaign_id: data.platform_campaign_id })
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
    logger.info(`[meta-ads] Synced ${results.length} campaigns`);
    return results;
  } catch (err) {
    logger.error(`[meta-ads] syncCampaigns failed: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// syncDailyPerformance — per-campaign daily insights into ad_performance_daily
// ---------------------------------------------------------------------------
async function syncDailyPerformance(days = 7) {
  if (!isConfigured()) return [];
  const out = await runExclusive('meta-ads-performance', () => syncDailyPerformanceLocked(days));
  return Array.isArray(out) ? out : [];
}

async function syncDailyPerformanceLocked(days = 7) {
  try {
    logger.info(`[meta-ads] Syncing daily performance (last ${days} days)`);
    const since = dateStr(Date.now() - days * 86400000);
    const until = dateStr(Date.now());

    const rows = await graphGet('insights', {
      fields: 'campaign_id,impressions,clicks,spend,ctr,cpc,actions,action_values,date_start',
      params: { level: 'campaign', time_increment: 1, time_range: { since, until } },
    });

    const results = [];
    for (const row of rows) {
      const platformId = String(row.campaign_id);
      const campaign = await db('ad_campaigns')
        .where({ platform: PLATFORM, platform_campaign_id: platformId })
        .first();
      if (!campaign) continue; // campaign sync must land first

      const mapped = mapInsightRow(row);
      const data = { campaign_id: campaign.id, ...mapped };

      const existing = await db('ad_performance_daily')
        .where({ campaign_id: campaign.id, date: data.date })
        .first();
      if (existing) {
        await db('ad_performance_daily').where({ id: existing.id }).update(data);
      } else {
        await db('ad_performance_daily').insert({ id: uuidv4(), ...data, created_at: new Date() });
      }
      results.push(data);
    }
    logger.info(`[meta-ads] Synced ${results.length} daily performance rows`);
    return results;
  } catch (err) {
    logger.error(`[meta-ads] syncDailyPerformance failed: ${err.message}`);
    return [];
  }
}

module.exports = {
  isConfigured,
  // Read-only Graph access for the Intelligence Bar ops tools — mutations
  // have no exported surface here at all.
  graphGet,
  syncCampaigns,
  syncDailyPerformance,
  _private: {
    apiVersion,
    accountId,
    mapStatus,
    mapCampaign,
    mapInsightRow,
    sumActions,
    CONVERSION_GROUPS,
  },
};
