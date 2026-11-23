const { v4: uuidv4 } = require('uuid');
const db = require('../../models/db');
const logger = require('../../services/logger');
const { etDateString, addETDays } = require('../../utils/datetime-et');
const { dateOnlyString } = require('../../utils/date-only');
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
// ONE portal row stands for the account, not one row per Google campaign.
// Google buys and bills Local Services by the account: in the Google Ads API
// version the portal uses (v23) a lead names no campaign, and Google makes and
// replaces the campaign under the account by itself. With one row, the account's history stays in one place when Google
// replaces the campaign, a day's leads have exactly one row to be counted on,
// and the row is never 'removed' (the Ads page leaves removed rows out). No
// reader needs the Google campaigns apart: the Ads page, the spend reads and
// the cost allocation all add the channel up.
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
// The row carries metadata.lsa_customer_id = the account it mirrors. The sync
// finds its row by that mark only, writes the mark only on the row it inserts,
// and generic campaign writes can neither set nor erase it (routes/admin-ads.js
// RESERVED_METADATA_KEYS). So a campaign entered by hand is never taken over,
// and a row from an account the sync no longer reads is left as it is.
// ---------------------------------------------------------------------------

const PLATFORM = 'google_lsa';
const CAMPAIGN_TYPE = 'google_lsa';
// The Waves Local Services account. An account id is not a secret; the env var
// can point the sync at another account, and a value that is not an account id
// (GOOGLE_LSA_CUSTOMER_ID=off, or empty) turns the sync off.
const DEFAULT_CUSTOMER_ID = '7636809139';
// The 6:25 AM cost allocation spreads again every month from today - 90 days
// (scheduler.js), starting at the first of that month (allocateAdCosts).
const ALLOCATION_LOOKBACK_DAYS = 90;
const ACCOUNT_KEY = 'lsa_customer_id'; // also reserved in routes/admin-ads.js RESERVED_METADATA_KEYS

// The WHOLE value must be an account id, plain or dashed: "off-1234567890" is
// off, not account 1234567890. The Search sync's own account is off too: that
// sync already imports every campaign of its account, so reading the same
// account here would count its spend twice.
function customerId() {
  const raw = process.env.GOOGLE_LSA_CUSTOMER_ID;
  const value = String(raw === undefined ? DEFAULT_CUSTOMER_ID : raw).trim();
  if (!/^\d{3}-?\d{3}-?\d{4}$/.test(value)) return null;
  const id = value.replace(/-/g, '');
  const searchId = String(process.env.GOOGLE_ADS_CUSTOMER_ID || '').replace(/-/g, '').trim();
  return id === searchId ? null : id;
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
const ENABLED = new Set([2, 'ENABLED']);
const REMOVED = new Set([4, 'REMOVED']);
// AdvertisingChannelType.
const LOCAL_SERVICES = new Set([11, 'LOCAL_SERVICES']);
const PERFORMANCE_MAX = new Set([10, 'PERFORMANCE_MAX']);
// Google names the campaign it makes for a Local Services account
// "LocalServicesCampaign:SystemGenerated:<hex>". That name means nothing on the
// Ads page, so the row is named with the page's own label for the channel.
const DISPLAY_NAME = 'Local Service Ads';

const LEAD_TYPE = { 2: 'messages', 3: 'calls', 4: 'bookings', MESSAGE: 'messages', PHONE_CALL: 'calls', BOOKING: 'bookings' };
// LocalServicesCreditState: Google gave the charge for the lead back.
const CREDITED = new Set([3, 'CREDITED']);

// The account row's status and daily budget from the account's Local Services
// campaigns. Active while Google has one enabled; else paused, also when every
// campaign is removed, so the row and its history stay on the Ads page. The
// budget is what the enabled campaigns can spend; with none enabled, what the
// paused ones would. null = Google gave no budget to read.
function accountState(campaignRows) {
  const enabled = campaignRows.filter((r) => ENABLED.has(r.campaign?.status));
  const pool = enabled.length ? enabled : campaignRows.filter((r) => !REMOVED.has(r.campaign?.status));
  const micros = pool
    .map((r) => r.campaign_budget?.amount_micros)
    .filter((m) => m != null && m !== '' && Number.isFinite(Number(m)));
  const budget = micros.length ? micros.reduce((sum, m) => sum + Number(m), 0) / 1_000_000 : null;
  return {
    status: enabled.length ? 'active' : 'paused',
    daily_budget_base: budget,
    daily_budget_current: budget,
  };
}

function emptyMetricDay() {
  return { impressions: 0, clicks: 0, costMicros: 0, conversions: 0, conversionValue: 0 };
}

// Google answers one metrics row for each campaign and day. The portal keeps
// one row a day for the account, so a day's rows are added up.
function sumMetricsByDay(metricRows) {
  const byDay = new Map();
  for (const row of metricRows) {
    const day = row.segments?.date;
    if (!day) continue;
    const m = row.metrics || {};
    const t = byDay.get(day) || emptyMetricDay();
    t.impressions += Number(m.impressions || 0);
    t.clicks += Number(m.clicks || 0);
    t.costMicros += Number(m.cost_micros || 0);
    t.conversions += Number(m.conversions || 0);
    t.conversionValue += Number(m.conversions_value || 0);
    byDay.set(day, t);
  }
  return byDay;
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
  const createdAt = lead.creation_date_time;
  return typeof createdAt === 'string' ? dateOnlyString(createdAt) : null;
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

// One ad_performance_daily row for an account-day, from the day's added-up
// metrics and its lead tally.
function mapPerformanceRow(metricDay, leads) {
  const cost = metricDay.costMicros / 1_000_000;
  return {
    impressions: metricDay.impressions,
    clicks: metricDay.clicks,
    cost,
    conversions: leads.charged,
    conversion_value: metricDay.conversionValue,
    ctr: metricDay.impressions > 0 ? Math.round((metricDay.clicks / metricDay.impressions) * 10000) / 100 : 0, // percentage
    avg_cpc: metricDay.clicks > 0 ? cost / metricDay.clicks : 0,
    roas: cost > 0 ? Math.round((metricDay.conversionValue / cost) * 100) / 100 : 0,
    metadata: JSON.stringify({ google_conversions: metricDay.conversions, lsa_leads: leads }),
    updated_at: new Date(),
  };
}

// The days each run rebuilds: every month the cost allocation spreads again,
// from its first day through today. So that job never reads a month this sync
// holds only in part (a first run, a late credit), and a credit Google gives
// back weeks later still reaches the day it belongs to. The edges are Eastern
// calendar days. Each day inside is keyed by Google's own account-local date
// (segments.date, the lead's creation day), so an account in another time zone
// would move only the edges, never a day's data.
function rebuildWindow(now = new Date()) {
  const firstMonth = etDateString(addETDays(now, -ALLOCATION_LOOKBACK_DAYS)).slice(0, 7);
  return { since: `${firstMonth}-01`, until: etDateString(now) };
}

// ---------------------------------------------------------------------------
// The run reads everything from Google and checks it first. Then it writes the
// account row and its days in ONE transaction. So a run that Google or a check
// stops leaves the portal exactly as the last good run wrote it.
// ---------------------------------------------------------------------------

// Only the account's Local Services campaigns count: any other campaign type in
// the account (Search, Display) stays out of google_lsa. No query filters on
// status: a removed campaign must still be seen, so an account whose only
// campaign Google removed reads paused, and its last days of cost still come in.
const CHANNEL_FILTER = "campaign.advertising_channel_type = 'LOCAL_SERVICES'";

// Google can also run Local Services inside a Performance Max campaign. Its
// leads are in local_services_lead like any other, but API v23 has no field
// that tells such a campaign from a normal Performance Max one, so its cost
// cannot be read here. Leads of both kinds against the cost of one would show
// a cost per lead that is too low, so the run stops before it writes: in
// readCampaigns for a campaign that is not removed, and in readDays for a
// removed one that still has numbers inside the window.
const PERFORMANCE_MAX_REFUSAL = 'this sync reads standalone Local Services campaigns only, so nothing was written';

async function readCampaigns(customer) {
  const all = await customer.query(`
    SELECT customer.currency_code, campaign.id, campaign.status, campaign.advertising_channel_type, campaign_budget.amount_micros
    FROM campaign
  `);
  // The portal's ad numbers are US dollars. The cost and the budget of an
  // account in another currency would enter them at face value.
  const foreign = all.find((r) => r.customer?.currency_code !== 'USD');
  if (foreign) {
    throw new Error(`the account bills in ${foreign.customer?.currency_code || 'an unknown currency'}, not USD, so nothing was written`);
  }
  const performanceMax = all.filter((r) => PERFORMANCE_MAX.has(r.campaign?.advertising_channel_type) && !REMOVED.has(r.campaign?.status));
  if (performanceMax.length) {
    throw new Error(`the account has ${performanceMax.length} Performance Max campaign(s); ${PERFORMANCE_MAX_REFUSAL}`);
  }
  return all.filter((r) => LOCAL_SERVICES.has(r.campaign?.advertising_channel_type));
}

// The account's cost and leads per day inside the window.
async function readDays(customer, { since, until }) {
  // Google leaves out a campaign-day on which every selected metric is zero, so
  // any row here is a Performance Max campaign (removed ones included) that ran
  // inside the window. Impressions and clicks are selected too: a day that
  // served at no cost can still have brought a lead.
  const performanceMaxDays = await customer.query(`
    SELECT campaign.id, segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros
    FROM campaign
    WHERE segments.date BETWEEN '${since}' AND '${until}'
      AND campaign.advertising_channel_type = 'PERFORMANCE_MAX'
    LIMIT 1
  `);
  if (performanceMaxDays.length) {
    throw new Error(`a Performance Max campaign ran in the account between ${since} and ${until}; ${PERFORMANCE_MAX_REFUSAL}`);
  }

  const metricRows = await customer.query(`
    SELECT
      campaign.id,
      segments.date,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM campaign
    WHERE segments.date BETWEEN '${since}' AND '${until}'
      AND ${CHANNEL_FILTER}
  `);
  // Both edges, like the cost: a lead dated after `until` (an account whose
  // local day is ahead of Eastern time) would be a day the cost does not cover.
  const leadRows = await customer.query(`
    SELECT
      local_services_lead.id,
      local_services_lead.lead_type,
      local_services_lead.creation_date_time,
      local_services_lead.lead_charged,
      local_services_lead.credit_details.credit_state
    FROM local_services_lead
    WHERE local_services_lead.creation_date_time >= '${since} 00:00:00'
      AND local_services_lead.creation_date_time <= '${until} 23:59:59'
  `);
  return { metricsByDay: sumMetricsByDay(metricRows), leadsByDay: tallyLeadsByDay(leadRows) };
}

// The row this sync owns for the account: found by the mark only, never by a
// Google id, so a row entered by hand is never taken for it.
function accountRow(account) {
  return db('ad_campaigns')
    .where({ platform: PLATFORM })
    .whereRaw(`metadata ->> '${ACCOUNT_KEY}' = ?`, [account])
    .orderBy('created_at')
    .first();
}

// The account row and its days, in one transaction. Returns the number of day
// rows written.
async function writeRows(account, existing, campaigns, { metricsByDay, leadsByDay }, { since, until }) {
  // Google owns the status and the budget, and the sync owns the type (the Ads
  // page puts the row on the "Local Service Ads" card by it; a row edited
  // while another account was being read gets it back here). The name is
  // written once, at insert: PUT /campaigns/:id lets the office rename the row,
  // and a nightly overwrite would undo that.
  const state = { ...accountState(campaigns), campaign_type: CAMPAIGN_TYPE, updated_at: new Date() };
  let written = 0;
  await db.transaction(async (trx) => {
    let campaignId = existing?.id;
    if (existing) {
      await trx('ad_campaigns').where({ id: campaignId }).update(state);
    } else {
      campaignId = uuidv4();
      await trx('ad_campaigns').insert({
        id: campaignId,
        platform: PLATFORM,
        platform_campaign_id: account,
        campaign_name: DISPLAY_NAME,
        ...state,
        metadata: JSON.stringify({ [ACCOUNT_KEY]: account }),
        created_at: new Date(),
      });
    }

    // The days the row already holds in the window: 'YYYY-MM-DD' -> row id.
    const storedRows = await trx('ad_performance_daily')
      .where({ campaign_id: campaignId })
      .where('date', '>=', since)
      .where('date', '<=', until)
      .select('id', db.raw("to_char(date, 'YYYY-MM-DD') AS day"));
    const stored = new Map(storedRows.map((r) => [r.day, r.id]));

    // A day with cost, a day with only a lead (Google leaves a zero-metric day
    // out of the metrics), and a day an earlier run stored that Google no
    // longer reports. That last one is written again as a zero day, so numbers
    // Google took back do not stay behind.
    const dates = [...new Set([...metricsByDay.keys(), ...leadsByDay.keys(), ...stored.keys()])].sort();
    for (const date of dates) {
      const data = {
        campaign_id: campaignId,
        date,
        ...mapPerformanceRow(metricsByDay.get(date) || emptyMetricDay(), leadsByDay.get(date) || emptyLeadDay()),
      };
      if (stored.has(date)) {
        await trx('ad_performance_daily').where({ id: stored.get(date) }).update(data);
      } else {
        await trx('ad_performance_daily').insert({ id: uuidv4(), ...data, created_at: new Date() });
      }
      written += 1;
    }
  });
  return written;
}

// ---------------------------------------------------------------------------
// The daily job body (the scheduler wraps it in runExclusive('google-lsa-sync')).
// Each run rebuilds the whole window (rebuildWindow), so a day is always the
// result of the newest read: Google credits a disputed lead back days later,
// and the day's charged count and cost then change. A failure throws an Error
// with Google's reason, so job_health records it instead of a success.
// ---------------------------------------------------------------------------
async function runDailySync() {
  const customer = getCustomer();
  if (!customer) return { configured: false, synced: {} };
  const account = customerId();
  const window = rebuildWindow();
  const step = async (name, run) => {
    try {
      return await run();
    } catch (err) {
      const reason = errorText(err);
      logger.error(`[google-lsa] ${name} failed: ${reason}`);
      throw new Error(`${name}: ${reason}`);
    }
  };

  const read = await step('read', async () => {
    const campaigns = await readCampaigns(customer);
    const existing = await accountRow(account);
    // An account that never had a Local Services campaign has nothing to mirror.
    if (!campaigns.length && !existing) return null;
    return { campaigns, existing, days: await readDays(customer, window) };
  });
  if (!read) return { configured: true, synced: { campaigns: 0, performanceRows: 0 } };

  logger.info(`[google-lsa] Writing the account row and its days (${window.since} to ${window.until})`);
  const performanceRows = await step('write', () => writeRows(account, read.existing, read.campaigns, read.days, window));
  logger.info(`[google-lsa] Synced ${performanceRows} daily performance rows`);
  return { configured: true, synced: { campaigns: read.campaigns.length, performanceRows } };
}

module.exports = {
  PLATFORM,
  isConfigured,
  ownsCampaign,
  runDailySync,
  getCustomer, // the lead match (google-lsa-leads.js) reads through the same account
  _private: {
    customerId,
    accountState,
    sumMetricsByDay,
    tallyLeadsByDay,
    mapPerformanceRow,
    rebuildWindow,
    DEFAULT_CUSTOMER_ID,
  },
};
