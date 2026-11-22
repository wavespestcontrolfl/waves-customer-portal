const { v4: uuidv4 } = require('uuid');
const db = require('../../models/db');
const logger = require('../../services/logger');
const { etDateString, addETDays } = require('../../utils/datetime-et');
const { hasCredentials, errorText } = require('./google-ads-config');

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
// `conversions` here is ALWAYS its number of leads Google charged and did not
// credit back (local_services_lead), never Google's conversions number. That
// number is kept beside it in ad_performance_daily.metadata, with the day's
// lead mix (metadata.lsa_leads).
//
// It only reads Google and writes these two tables. It creates no lead, changes
// no call attribution and messages no one. Budget and status stay with Google:
// the budget loop only acts on platform 'google_ads'.
//
// A row this sync owns carries metadata.lsa_customer_id = the account it came
// from. The sync writes the mark only on a row it inserts, and generic campaign
// writes can neither set nor erase it (routes/admin-ads.js
// RESERVED_METADATA_KEYS), so a row's owner never changes. Every read and write
// below is scoped to the mark: a campaign entered by hand is never taken over,
// even when it carries the same Google campaign id, and a row from an account
// the sync no longer reads is left as it is.
// ---------------------------------------------------------------------------

const PLATFORM = 'google_lsa';
const CAMPAIGN_TYPE = 'google_lsa';
// The Waves Local Services account. An account id is not a secret; the env var
// can point the sync at another account, and a value that is not an account id
// (GOOGLE_LSA_CUSTOMER_ID=off, or empty) turns the sync off.
const DEFAULT_CUSTOMER_ID = '7636809139';
const DEFAULT_DAYS = 30;
// How far back a late credit can move the start of the rebuild. It equals the
// window the 6:25 AM cost allocation recomputes (scheduler.js: today - 90 days),
// so no day this sync changes is outside the months that job spreads again.
const MAX_LOOKBACK_DAYS = 90;
const ACCOUNT_KEY = 'lsa_customer_id'; // also reserved in routes/admin-ads.js RESERVED_METADATA_KEYS

// The WHOLE value must be an account id, plain or dashed: "off-1234567890" is
// off, not account 1234567890.
function customerId() {
  const raw = process.env.GOOGLE_LSA_CUSTOMER_ID;
  const value = String(raw === undefined ? DEFAULT_CUSTOMER_ID : raw).trim();
  return /^\d{3}-?\d{3}-?\d{4}$/.test(value) ? value.replace(/-/g, '') : null;
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
function leadDay(lead) {
  const day = String(lead.creation_date_time || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

function tallyLeadsByDay(leadRows) {
  const byDay = new Map();
  for (const row of leadRows) {
    const lead = row.local_services_lead;
    const day = leadDay(lead);
    if (!day) continue;
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

// One ad_performance_daily row for a campaign-day. `leads` is the account's
// tally for the day on the row that carries the day's leads (leadCarrier), and
// an empty tally on every other row.
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
    conversions: leads.charged,
    conversion_value: conversionValue,
    ctr: Math.round(Number(m.ctr || 0) * 10000) / 100, // fraction -> percentage
    avg_cpc: Number(m.average_cpc || 0) / 1_000_000,
    roas: Math.round(roas * 100) / 100,
    metadata: JSON.stringify({ google_conversions: googleConversions, lsa_leads: leads }),
    updated_at: new Date(),
  };
}

// The window's edges are Eastern calendar days. Each day inside it is keyed by
// Google's own account-local date (segments.date, the lead's creation day), so
// an account in another time zone would move only the edges, never a day's data.
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
    // Only a row this sync inserted (it carries the mark) is ever updated. A
    // row entered by hand with the same Google id is not this sync's: it stays
    // untouched, and the campaign gets its own marked row.
    const existing = await accountCampaigns(account)
      .where({ platform_campaign_id: data.platform_campaign_id })
      .first();
    if (existing) {
      await db('ad_campaigns').where({ id: existing.id }).update(data);
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
// ad_performance_daily. Each run rebuilds a whole window of days, so a day is
// always the result of the newest read: Google credits a disputed lead back
// days later, and the day's charged count and cost then change.
// ---------------------------------------------------------------------------

// The first day to rebuild: 30 days back, or earlier when Google changed the
// credit of an older lead inside those 30 days. The window then starts at that
// lead's creation day, so a late credit still reaches the day it belongs to,
// but never before `earliest` (MAX_LOOKBACK_DAYS).
async function windowStart(customer, since, earliest) {
  const rows = await customer.query(`
    SELECT local_services_lead.creation_date_time
    FROM local_services_lead
    WHERE local_services_lead.credit_details.credit_state_last_update_date_time >= '${since} 00:00:00'
  `);
  let start = since;
  for (const row of rows) {
    const day = leadDay(row.local_services_lead);
    if (day && day < start) start = day;
  }
  return start < earliest ? earliest : start;
}

// A lead names no campaign, and the account's leads of a day must be counted
// exactly once. The row that carries them is the campaign with a metrics row
// that day; with none, the campaign that is not removed; with none, any
// campaign of the account. So a removed campaign keeps the leads of the days it
// ran, and they never move to the campaign that replaced it. When a rule leaves
// more than one candidate, the first (lowest Google id) carries the leads and
// the tally says `shared: true`: the count is the account's for the day, not
// proven to be that campaign's. Pure. null = the account has no campaign row.
function leadCarrier(date, campaigns, metricIdsByDay) {
  const ran = metricIdsByDay.get(date);
  const withMetrics = campaigns.filter((c) => ran?.has(String(c.platform_campaign_id)));
  const live = campaigns.filter((c) => c.status !== 'removed');
  const candidates = [withMetrics, live, campaigns].find((list) => list.length);
  if (!candidates) return null;
  const first = candidates.reduce((a, c) => (Number(c.platform_campaign_id) < Number(a.platform_campaign_id) ? c : a));
  return { campaignId: first.id, shared: candidates.length > 1 };
}

// The days this sync already holds in the window: 'campaign id|YYYY-MM-DD' -> row id.
async function storedDays(campaignIds, since, until) {
  if (!campaignIds.length) return new Map();
  const rows = await db('ad_performance_daily')
    .whereIn('campaign_id', campaignIds)
    .where('date', '>=', since)
    .where('date', '<=', until)
    .select('id', 'campaign_id', db.raw("to_char(date, 'YYYY-MM-DD') AS day"));
  return new Map(rows.map((r) => [`${r.campaign_id}|${r.day}`, r.id]));
}

// Which campaign-days to write (pure), keyed 'campaign id|date':
// - each Google metrics row for a campaign the portal holds;
// - the row that carries a day's leads, also when Google has no metrics row
//   for it (Google leaves a zero-metric day out);
// - a day stored by an earlier run that neither of the above covers now. It is
//   written again as a zero day, so numbers Google no longer reports do not
//   stay behind.
// `uncounted` = leads that no row could carry (the account has no campaign row).
function planPerformanceDays({ metricRows, leadsByDay, campaigns, storedKeys }) {
  const localId = new Map(campaigns.map((c) => [String(c.platform_campaign_id), c.id]));
  const metricIdsByDay = new Map();
  const planned = new Map();
  for (const row of metricRows) {
    const platformId = String(row.campaign.id);
    const date = row.segments.date;
    if (!localId.has(platformId)) continue;
    planned.set(`${localId.get(platformId)}|${date}`, { campaignId: localId.get(platformId), date, metrics: row.metrics });
    metricIdsByDay.set(date, (metricIdsByDay.get(date) || new Set()).add(platformId));
  }
  const carried = new Map();
  let uncounted = 0;
  for (const [date, tally] of leadsByDay) {
    const carrier = leadCarrier(date, campaigns, metricIdsByDay);
    if (!carrier) {
      uncounted += tally.total;
      continue;
    }
    const key = `${carrier.campaignId}|${date}`;
    carried.set(key, carrier.shared ? { ...tally, shared: true } : tally);
    if (!planned.has(key)) planned.set(key, { campaignId: carrier.campaignId, date, metrics: null });
  }
  for (const key of storedKeys) {
    const [campaignId, date] = key.split('|');
    if (!planned.has(key)) planned.set(key, { campaignId, date, metrics: null });
  }
  const days = [...planned.entries()].map(([key, day]) => ({ key, ...day, leads: carried.get(key) || emptyLeadDay() }));
  return { days, uncounted };
}

async function syncDailyPerformance(customer, account, days = DEFAULT_DAYS) {
  logger.info(`[google-lsa] Syncing daily performance (last ${days} days)`);
  const { since: normalSince, until } = dateRange(days);
  const since = await windowStart(customer, normalSince, dateRange(MAX_LOOKBACK_DAYS).since);

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

  // Removed campaigns stay in the list: the metrics query has no status
  // filter, so a campaign removed since the last run still gets its last days
  // of cost and any later correction.
  const campaigns = await accountCampaigns(account).select('id', 'platform_campaign_id', 'status');
  const stored = await storedDays(campaigns.map((c) => c.id), since, until);
  const plan = planPerformanceDays({
    metricRows,
    leadsByDay: tallyLeadsByDay(leadRows),
    campaigns,
    storedKeys: [...stored.keys()],
  });
  if (plan.uncounted) {
    logger.warn(`[google-lsa] ${plan.uncounted} lead(s) not counted: the portal holds no campaign row for the account`);
  }

  const results = [];
  for (const { key, campaignId, date, metrics, leads } of plan.days) {
    const data = { campaign_id: campaignId, date, ...mapPerformanceRow(metrics, leads) };
    if (stored.has(key)) {
      await db('ad_performance_daily').where({ id: stored.get(key) }).update(data);
    } else {
      await db('ad_performance_daily').insert({ id: uuidv4(), ...data, created_at: new Date() });
    }
    results.push(data);
  }

  logger.info(`[google-lsa] Synced ${results.length} daily performance rows`);
  return results;
}

// ---------------------------------------------------------------------------
// The daily job body (the scheduler wraps it in runExclusive('google-lsa-sync')).
// The performance step runs only after the campaign step succeeded: it decides
// which row carries a day's leads from the campaign rows, so it must not run on
// a list that may miss a new campaign. A failure throws an Error with Google's
// reason, so job_health records it instead of a success.
// ---------------------------------------------------------------------------
async function runDailySync({ days = DEFAULT_DAYS } = {}) {
  const customer = getCustomer();
  if (!customer) return { configured: false, synced: {} };
  const account = customerId();
  const step = async (name, run) => {
    try {
      return (await run()).length;
    } catch (err) {
      const reason = errorText(err);
      logger.error(`[google-lsa] ${name} failed: ${reason}`);
      throw new Error(`${name}: ${reason}`);
    }
  };
  const campaigns = await step('syncCampaigns', () => syncCampaigns(customer, account));
  const performanceRows = await step('syncDailyPerformance', () => syncDailyPerformance(customer, account, days));
  return { configured: true, synced: { campaigns, performanceRows } };
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
    leadCarrier,
    windowStart,
    planPerformanceDays,
    dateRange,
    syncCampaigns,
    syncDailyPerformance,
    DEFAULT_CUSTOMER_ID,
  },
};
