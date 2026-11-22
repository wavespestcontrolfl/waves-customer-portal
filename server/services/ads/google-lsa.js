const { v4: uuidv4 } = require('uuid');
const db = require('../../models/db');
const logger = require('../../services/logger');
const { etDateString, addETDays } = require('../../utils/datetime-et');
const { isConfigured: googleAdsConfigured } = require('./google-ads-config');

// ---------------------------------------------------------------------------
// Google Local Services Ads: read-only ingestion (owner 2026-11-21, "lead sync").
//
// Local Services Ads runs in its OWN Google Ads account. It is not under the
// manager account the Search campaigns use, so it signs in as itself with the
// same OAuth credentials. This module mirrors that account into the SAME
// ad_campaigns / ad_performance_daily tables as the Google and Meta syncs, with
// platform = 'google_lsa' and campaign_type = 'google_lsa' (the value the Ads
// page's "Local Service Ads" card filters on).
//
// Google charges Local Services by the lead, not by the click, so a day's
// `conversions` here is its number of CHARGED leads (local_services_lead),
// and the day's lead mix is kept in ad_performance_daily.metadata.lsa_leads.
// Google's own conversions number for the day is kept beside it.
//
// It only reads Google and writes these two tables. It creates no lead, changes
// no call attribution and messages no one. Budget and status stay with Google:
// the budget loop only acts on platform 'google_ads'.
// ---------------------------------------------------------------------------

const PLATFORM = 'google_lsa';
const CAMPAIGN_TYPE = 'google_lsa';
// The Waves Local Services account. An account id is not a secret; the env var
// can point the sync at another account, and a value that is not a 10-digit id
// (GOOGLE_LSA_CUSTOMER_ID=off) turns the sync off.
const DEFAULT_CUSTOMER_ID = '7636809139';
const DEFAULT_DAYS = 30;

function customerId() {
  const raw = process.env.GOOGLE_LSA_CUSTOMER_ID;
  const digits = String(raw === undefined ? DEFAULT_CUSTOMER_ID : raw).replace(/\D/g, '');
  return digits.length === 10 ? digits : null;
}

function isConfigured() {
  return googleAdsConfigured() && !!customerId();
}

let _customer = null;
let _customerKey = null;
// The Google Ads SDK is large: load it on the first sync, not when a route only
// asks isConfigured().
function getCustomer() {
  if (!isConfigured()) return null;
  const id = customerId();
  if (!_customer || _customerKey !== id) {
    const { GoogleAdsApi } = require('google-ads-api');
    const client = new GoogleAdsApi({
      client_id: process.env.GOOGLE_ADS_CLIENT_ID,
      client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
      developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    });
    _customer = client.Customer({
      customer_id: id,
      login_customer_id: id,
      refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
    });
    _customerKey = id;
  }
  return _customer;
}

// ---------------------------------------------------------------------------
// Pure mappers (exported for tests). The SDK answers enums as numbers; a string
// name is accepted too.
// ---------------------------------------------------------------------------
const CAMPAIGN_STATUS = { 2: 'active', 3: 'paused', 4: 'removed', ENABLED: 'active', PAUSED: 'paused', REMOVED: 'removed' };
function mapStatus(googleStatus) {
  return CAMPAIGN_STATUS[googleStatus] || 'unknown';
}

const LEAD_TYPE = { 2: 'messages', 3: 'calls', 4: 'bookings', MESSAGE: 'messages', PHONE_CALL: 'calls', BOOKING: 'bookings' };

// Google names the campaign it makes for a Local Services account
// "LocalServicesCampaign:SystemGenerated:<hex>". That name means nothing on the
// Ads page, so it is shown under the page's own label for the channel.
const DISPLAY_NAME = 'Local Service Ads';
function campaignName(googleName) {
  const name = String(googleName || '').trim();
  return !name || /^LocalServicesCampaign:/i.test(name) ? DISPLAY_NAME : name;
}

function mapCampaign(row) {
  const micros = row.campaign_budget?.amount_micros;
  const dailyBudget = micros != null && micros !== '' ? Number(micros) / 1_000_000 : null;
  const budget = Number.isFinite(dailyBudget) ? dailyBudget : null;
  return {
    platform: PLATFORM,
    platform_campaign_id: String(row.campaign.id),
    campaign_name: campaignName(row.campaign.name),
    status: mapStatus(row.campaign.status),
    campaign_type: CAMPAIGN_TYPE,
    daily_budget_base: budget,
    daily_budget_current: budget,
    updated_at: new Date(),
  };
}

function emptyLeadDay() {
  return { total: 0, charged: 0, calls: 0, messages: 0, bookings: 0 };
}

// Leads per account-local day ('YYYY-MM-DD' = the first 10 characters of
// creation_date_time, which Google gives in the account's time zone, like
// segments.date). A lead with no readable date is left out.
function tallyLeadsByDay(leadRows) {
  const byDay = new Map();
  for (const row of leadRows) {
    const lead = row.local_services_lead;
    const day = String(lead.creation_date_time || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const t = byDay.get(day) || emptyLeadDay();
    t.total += 1;
    if (lead.lead_charged === true) t.charged += 1;
    const kind = LEAD_TYPE[lead.lead_type];
    if (kind) t[kind] += 1;
    byDay.set(day, t);
  }
  return byDay;
}

// One ad_performance_daily row for a campaign-day. `leads` is that day's tally
// when the account's leads belong to this campaign, else null: the row then
// keeps Google's own conversions number.
function mapPerformanceRow(metrics, leads) {
  const m = metrics || {};
  const cost = Number(m.cost_micros || 0) / 1_000_000;
  const googleConversions = Number(m.conversions || 0);
  const conversionValue = Number(m.conversions_value || 0);
  const roas = cost > 0 ? conversionValue / cost : 0;
  return {
    impressions: Number(m.impressions || 0),
    clicks: Number(m.clicks || 0),
    cost,
    conversions: leads ? leads.charged : googleConversions,
    conversion_value: conversionValue,
    ctr: Math.round(Number(m.ctr || 0) * 10000) / 100, // fraction -> percentage
    avg_cpc: Number(m.average_cpc || 0) / 1_000_000,
    roas: Math.round(roas * 100) / 100,
    metadata: JSON.stringify({
      google_conversions: googleConversions,
      ...(leads ? { lsa_leads: leads } : {}),
    }),
    updated_at: new Date(),
  };
}

function dateRange(days, now = new Date()) {
  return { since: etDateString(addETDays(now, -days)), until: etDateString(now) };
}

// ---------------------------------------------------------------------------
// syncCampaigns: upsert the account's campaigns into ad_campaigns.
// ---------------------------------------------------------------------------
async function syncCampaigns(customer) {
  logger.info('[google-lsa] Syncing campaigns');
  // A row a local writer touches after this instant is fresher than this
  // snapshot: the removal pass leaves it for the next sync (the same fence as
  // the Google and Meta syncs).
  const fetchStartedAt = new Date();
  // No metrics selected, so this is the complete list: Google leaves a campaign
  // out of a metrics query when all its selected metrics are zero.
  const rows = await customer.query(`
    SELECT campaign.id, campaign.name, campaign.status, campaign_budget.amount_micros
    FROM campaign
    WHERE campaign.status != 'REMOVED'
  `);

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

  // A campaign removed in Google never comes back to be flipped by the upsert.
  // Rows entered by hand (NULL platform_campaign_id) are left alone; the
  // explicit whereNotNull matters because knex compiles an empty NOT IN list to
  // always-true.
  const removed = await db('ad_campaigns')
    .where({ platform: PLATFORM })
    .whereNotNull('platform_campaign_id')
    .whereNotIn('platform_campaign_id', results.map((r) => r.platform_campaign_id))
    .whereNot('status', 'removed')
    .where('updated_at', '<', fetchStartedAt)
    .update({ status: 'removed', updated_at: new Date() });
  if (Number(removed) > 0) logger.info(`[google-lsa] Marked ${removed} campaign(s) removed (no longer returned by Google)`);

  logger.info(`[google-lsa] Synced ${results.length} campaigns`);
  return results;
}

// ---------------------------------------------------------------------------
// syncDailyPerformance: cost and leads per campaign-day into
// ad_performance_daily. The 30-day window is longer than the Google sync's 7:
// Google credits a disputed lead back days later, and the day's charged count
// and cost then change.
// ---------------------------------------------------------------------------

// Which campaign-days to write (pure): each Google metrics row for a campaign
// the portal holds, plus a day in the window that has a lead and no metrics row
// (Google leaves a zero-metric day out). `leads` is the day's tally on the
// campaign the leads belong to, else null.
function planPerformanceDays({ metricRows, leadsByDay, leadCampaign, known, since, until }) {
  const planned = new Map();
  for (const row of metricRows) {
    const platformId = String(row.campaign.id);
    const date = row.segments.date;
    if (known.has(platformId)) planned.set(`${platformId}|${date}`, { platformId, date, metrics: row.metrics });
  }
  for (const date of leadsByDay.keys()) {
    const key = `${leadCampaign}|${date}`;
    if (date >= since && date <= until && !planned.has(key)) planned.set(key, { platformId: leadCampaign, date, metrics: null });
  }
  return [...planned.values()].map((day) => ({
    ...day,
    leads: day.platformId === leadCampaign ? (leadsByDay.get(day.date) || emptyLeadDay()) : null,
  }));
}

async function upsertPerformanceDay(data) {
  const existing = await db('ad_performance_daily').where({ campaign_id: data.campaign_id, date: data.date }).first();
  if (existing) {
    await db('ad_performance_daily').where({ id: existing.id }).update(data);
  } else {
    await db('ad_performance_daily').insert({ id: uuidv4(), ...data, created_at: new Date() });
  }
}

async function syncDailyPerformance(customer, days = DEFAULT_DAYS) {
  logger.info(`[google-lsa] Syncing daily performance (last ${days} days)`);
  const { since, until } = dateRange(days);

  const metricRows = await customer.query(`
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
    WHERE segments.date BETWEEN '${since}' AND '${until}'
      AND campaign.status != 'REMOVED'
  `);
  const leadRows = await customer.query(`
    SELECT
      local_services_lead.id,
      local_services_lead.lead_type,
      local_services_lead.creation_date_time,
      local_services_lead.lead_charged
    FROM local_services_lead
    WHERE local_services_lead.creation_date_time >= '${since} 00:00:00'
  `);

  const campaigns = await db('ad_campaigns')
    .where({ platform: PLATFORM })
    .whereNotNull('platform_campaign_id')
    .whereNot('status', 'removed')
    .select('id', 'platform_campaign_id');
  const localId = new Map(campaigns.map((c) => [String(c.platform_campaign_id), c.id]));

  // A lead names no campaign. With one live campaign in the account (the normal
  // Local Services setup) every lead is that campaign's. With more than one the
  // split is unknown, so the lead counts are left out and each row keeps
  // Google's own conversions number.
  const leadCampaign = campaigns.length === 1 ? String(campaigns[0].platform_campaign_id) : null;
  if (!leadCampaign && leadRows.length) {
    logger.warn(`[google-lsa] ${leadRows.length} lead(s) not counted: the account has ${campaigns.length} live campaigns, so a lead's campaign is unknown`);
  }

  const planned = planPerformanceDays({
    metricRows,
    leadsByDay: leadCampaign ? tallyLeadsByDay(leadRows) : new Map(),
    leadCampaign,
    known: localId,
    since,
    until,
  });
  const results = [];
  for (const { platformId, date, metrics, leads } of planned) {
    const data = { campaign_id: localId.get(platformId), date, ...mapPerformanceRow(metrics, leads) };
    await upsertPerformanceDay(data);
    results.push(data);
  }

  logger.info(`[google-lsa] Synced ${results.length} daily performance rows`);
  return results;
}

// ---------------------------------------------------------------------------
// The daily job body (the scheduler wraps it in runExclusive('google-lsa-sync')).
// Both steps run even if the first fails; then the run throws the first
// failure, so job_health records it instead of a success.
// ---------------------------------------------------------------------------
async function runDailySync({ days = DEFAULT_DAYS } = {}) {
  const customer = getCustomer();
  if (!customer) return { configured: false, synced: {} };
  const synced = { campaigns: 0, performanceRows: 0 };
  let firstErr = null;
  try {
    synced.campaigns = (await syncCampaigns(customer)).length;
  } catch (err) {
    logger.error(`[google-lsa] syncCampaigns failed: ${err.message}`);
    firstErr = err;
  }
  try {
    synced.performanceRows = (await syncDailyPerformance(customer, days)).length;
  } catch (err) {
    logger.error(`[google-lsa] syncDailyPerformance failed: ${err.message}`);
    firstErr = firstErr || err;
  }
  if (firstErr) throw firstErr;
  return { configured: true, synced };
}

module.exports = {
  PLATFORM,
  isConfigured,
  runDailySync,
  _private: {
    customerId,
    mapStatus,
    mapCampaign,
    mapPerformanceRow,
    tallyLeadsByDay,
    planPerformanceDays,
    dateRange,
    syncCampaigns,
    syncDailyPerformance,
    DEFAULT_CUSTOMER_ID,
  },
};
