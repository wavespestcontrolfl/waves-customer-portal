const { v4: uuidv4 } = require('uuid');
const db = require('../../models/db');
const logger = require('../../services/logger');
const { etDateString, addETDays } = require('../../utils/datetime-et');
const { hasCredentials } = require('./google-ads-config');

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
// `conversions` here is its number of leads Google charged and did not credit
// back (local_services_lead), and the day's lead mix is kept in
// ad_performance_daily.metadata.lsa_leads. Google's own conversions number for
// the day is kept beside it.
//
// It only reads Google and writes these two tables. It creates no lead, changes
// no call attribution and messages no one. Budget and status stay with Google:
// the budget loop only acts on platform 'google_ads'.
//
// A row this sync owns carries metadata.lsa_customer_id = the account it came
// from. The mark scopes every read of "this account's campaigns" below and the
// status rule in routes/admin-ads.js, so a campaign entered by hand, or one
// from an account the sync no longer reads, is never treated as synced.
// ---------------------------------------------------------------------------

const PLATFORM = 'google_lsa';
const CAMPAIGN_TYPE = 'google_lsa';
// The Waves Local Services account. An account id is not a secret; the env var
// can point the sync at another account, and a value that is not a 10-digit id
// (GOOGLE_LSA_CUSTOMER_ID=off) turns the sync off.
const DEFAULT_CUSTOMER_ID = '7636809139';
const DEFAULT_DAYS = 30;
const ACCOUNT_KEY = 'lsa_customer_id'; // also reserved in routes/admin-ads.js RESERVED_METADATA_KEYS

function customerId() {
  const raw = process.env.GOOGLE_LSA_CUSTOMER_ID;
  const digits = String(raw === undefined ? DEFAULT_CUSTOMER_ID : raw).replace(/\D/g, '');
  return digits.length === 10 ? digits : null;
}

// The OAuth credentials are shared with the Search sync; the account id is this
// sync's own, so it does not need GOOGLE_ADS_CUSTOMER_ID.
function isConfigured() {
  return hasCredentials() && !!customerId();
}

// True for a campaign row this sync owns: it carries the mark of the account the
// sync reads now.
function ownsCampaign(campaign) {
  const account = customerId();
  if (!account || campaign?.platform !== PLATFORM) return false;
  let meta = campaign.metadata;
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta); } catch { meta = null; }
  }
  return String(meta?.[ACCOUNT_KEY] || '') === account;
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
// LocalServicesCreditState: Google gave the charge for the lead back.
const CREDITED = new Set([3, 'CREDITED']);

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
  return { total: 0, charged: 0, credited: 0, calls: 0, messages: 0, bookings: 0 };
}

// Leads per account-local day ('YYYY-MM-DD' = the first 10 characters of
// creation_date_time, which Google gives in the account's time zone, like
// segments.date). A lead with no readable date is left out. lead_charged stays
// true on a lead Google later credits back, so a credited lead counts in
// `credited` and `total`, not in `charged`.
function tallyLeadsByDay(leadRows) {
  const byDay = new Map();
  for (const row of leadRows) {
    const lead = row.local_services_lead;
    const day = String(lead.creation_date_time || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const t = byDay.get(day) || emptyLeadDay();
    t.total += 1;
    if (CREDITED.has(lead.credit_details?.credit_state)) t.credited += 1;
    else if (lead.lead_charged === true) t.charged += 1;
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
// syncCampaigns: upsert the account's Local Services campaigns into
// ad_campaigns, each marked with the account id.
//
// The query has no status filter: Google keeps answering a removed campaign
// with status REMOVED, so its row follows to 'removed' through the same upsert
// and no "not returned any more" pass is needed. The channel filter keeps any
// other campaign type in the account (Search, Display) out of google_lsa.
// ---------------------------------------------------------------------------
const CHANNEL_FILTER = "campaign.advertising_channel_type = 'LOCAL_SERVICES'";

// metadata with the mark merged in; a metadata value that is not an object is replaced.
const MERGE_MARK_SQL = "(CASE WHEN jsonb_typeof(metadata) = 'object' THEN metadata ELSE '{}'::jsonb END) || ?::jsonb";

// This account's campaign rows, removed ones included.
function accountCampaigns(account) {
  return db('ad_campaigns')
    .where({ platform: PLATFORM })
    .whereRaw(`metadata ->> '${ACCOUNT_KEY}' = ?`, [account]);
}

async function syncCampaigns(customer, account) {
  logger.info('[google-lsa] Syncing campaigns');
  const rows = await customer.query(`
    SELECT campaign.id, campaign.name, campaign.status, campaign_budget.amount_micros
    FROM campaign
    WHERE ${CHANNEL_FILTER}
  `);

  const mark = JSON.stringify({ [ACCOUNT_KEY]: account });
  const results = [];
  for (const row of rows) {
    const data = mapCampaign(row);
    const existing = await db('ad_campaigns')
      .where({ platform: PLATFORM, platform_campaign_id: data.platform_campaign_id })
      .first();
    if (existing) {
      // Merge the mark in SQL: every other metadata key stays, and a metadata
      // write that lands between the read and this update is not erased.
      await db('ad_campaigns').where({ id: existing.id })
        .update({ ...data, metadata: db.raw(MERGE_MARK_SQL, [mark]) });
      results.push({ ...existing, ...data });
    } else {
      const [inserted] = await db('ad_campaigns')
        .insert({ id: uuidv4(), ...data, metadata: mark, created_at: new Date() })
        .returning('*');
      results.push(inserted);
    }
  }

  logger.info(`[google-lsa] Synced ${results.length} campaigns`);
  return results;
}

// ---------------------------------------------------------------------------
// syncDailyPerformance: cost and leads per campaign-day into
// ad_performance_daily. The 30-day window is longer than the Google sync's 7:
// Google credits a disputed lead back days later, and the day's charged count
// and cost then change.
// ---------------------------------------------------------------------------

// A lead names no campaign. The leads in the window belong to a campaign only
// when it is the one campaign in play there: every campaign of the account that
// is not removed, plus every campaign with a metrics row in the window (a
// removed one included, so its earlier leads never move to the campaign that
// replaced it). Any other count = unknown = null. Pure.
function leadOwner(campaigns, metricRows) {
  const inPlay = new Set(campaigns.filter((c) => c.status !== 'removed').map((c) => String(c.platform_campaign_id)));
  for (const row of metricRows) inPlay.add(String(row.campaign.id));
  return inPlay.size === 1 ? [...inPlay][0] : null;
}

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

async function syncDailyPerformance(customer, account, days = DEFAULT_DAYS) {
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
      AND ${CHANNEL_FILTER}
  `);
  const leadRows = await customer.query(`
    SELECT
      local_services_lead.id,
      local_services_lead.lead_type,
      local_services_lead.creation_date_time,
      local_services_lead.lead_charged,
      local_services_lead.credit_details.credit_state
    FROM local_services_lead
    WHERE local_services_lead.creation_date_time >= '${since} 00:00:00'
  `);

  // Removed campaigns stay in the lookup: the metrics query has no status
  // filter, so a campaign removed since the last run still gets its last days
  // of cost and any later correction.
  const campaigns = await accountCampaigns(account).select('id', 'platform_campaign_id', 'status');
  const localId = new Map(campaigns.map((c) => [String(c.platform_campaign_id), c.id]));

  // With the owner unknown the lead counts are left out, and each row keeps
  // Google's own conversions number.
  const owner = leadOwner(campaigns, metricRows);
  const leadCampaign = owner && localId.has(owner) ? owner : null;
  if (!leadCampaign && leadRows.length) {
    logger.warn(`[google-lsa] ${leadRows.length} lead(s) not counted: no single campaign owns the leads in the window`);
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
  const account = customerId();
  const synced = { campaigns: 0, performanceRows: 0 };
  let firstErr = null;
  try {
    synced.campaigns = (await syncCampaigns(customer, account)).length;
  } catch (err) {
    logger.error(`[google-lsa] syncCampaigns failed: ${err.message}`);
    firstErr = err;
  }
  try {
    synced.performanceRows = (await syncDailyPerformance(customer, account, days)).length;
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
  ownsCampaign,
  runDailySync,
  _private: {
    customerId,
    mapStatus,
    mapCampaign,
    mapPerformanceRow,
    tallyLeadsByDay,
    leadOwner,
    planPerformanceDays,
    dateRange,
    syncCampaigns,
    syncDailyPerformance,
    DEFAULT_CUSTOMER_ID,
  },
};
