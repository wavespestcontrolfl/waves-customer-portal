/**
 * Ad results report (owner 2026-11-23, plan v2: "track ad results: paid customers, one-time vs recurring").
 * READ ONLY. It writes nothing, texts no one and calls no ad platform. One row per (campaign, ET day), plus totals.
 * Counts and short customer-id lists, no ratios (no ROAS, no cost per lead): the owner reads the counts.
 *
 * Where each rule lives (rule 22: call the home, never write the rule again):
 *   - Spend and clicks: ad_performance_daily, the real cost of that campaign on that day. Never
 *     ad_service_attribution.ad_cost (that is the month's cost split evenly across leads).
 *   - Plan or one-time: isMembershipCustomerRow (server/services/waveguard-existing-services.js). It reads the
 *     customer's tier first and monthly_rate only as the legacy fallback. This file never reads monthly_rate alone.
 *   - Paid invoice revenue: NO shared "paid revenue" rule exists. billing-lane.js (completionInvoiceAmount, dues
 *     coverage, sibling coverage) predicts what a visit WILL bill. open-balance.js (applyOpenSelfPayPredicates) is
 *     what a customer still OWES. payer.js (resolveForInvoice) is who a new invoice bills. None of the three says what
 *     was collected, so paid90 is the one rule written here: invoices.total of status 'paid' invoices with a paid_at,
 *     counted by the customer who owns the invoice whoever settled it. A refunded or void invoice has another status
 *     and never counts.
 *   - Churn: the customer's CURRENT pipeline_stage = 'churned' (waves-db skill: never churned_at, which is sparse and
 *     survives a reactivation). customer-stages.js has no churn predicate to call; past_customer and dormant are
 *     archival labels, not churn (owner ruling 2026-08-07).
 *   - Dates: ET days through datetime-et.js; a pg DATE value through dateOnlyString (utils/date-only.js).
 *   - Rain day: system_settings 'ads.rain_mode.days', written by ads/rain-mode.js (read here, never imported: that
 *     module pulls in the Google Ads client).
 *
 * A customer is credited to ONE row: the row of their first lead in the window (earliest lead_date, then id). So the
 * paid, plan, cancel and paid90 numbers add up across rows and campaigns without counting a customer twice. Their
 * leads still count in every row they came in on.
 */
const db = require('../../models/db');
const { etDateString, addETDays, parseETDateTime } = require('../../utils/datetime-et');
const { dateOnlyString } = require('../../utils/date-only');
const { isMembershipCustomerRow } = require('../waveguard-existing-services');
const { isInternalTestContact } = require('../internal-test-customers');

const RAIN_DAYS_KEY = 'ads.rain_mode.days';
const PAID90_DAYS = 90;
const NO_CAMPAIGN = '(no campaign)';
// Drill-down list size per row; counts always cover every customer.
const LIST_MAX = 25;
const ID_CHUNK = 500;
const BOOKED_STAGES = ['booked', 'completed'];
const PAID_SOURCES = ['google_ads', 'google_lsa'];

const cents = (n) => Math.round((Number(n) || 0) * 100) / 100;

function parseJson(v, fallback) {
  if (v && typeof v === 'object') return v;
  if (typeof v !== 'string') return fallback;
  try { return JSON.parse(v) ?? fallback; } catch { return fallback; }
}

// The ET calendar day `n` days after `day` (YYYY-MM-DD), through the shared ET helpers.
function daysAfter(day, n) {
  return etDateString(addETDays(parseETDateTime(`${day}T12:00`), n));
}

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function rowFor(rows, { campaignId, campaign, platform, date }) {
  const key = `${campaignId || `none:${platform || ''}`}|${date}`;
  if (!rows.has(key)) {
    rows.set(key, {
      date,
      campaign_id: campaignId || null,
      campaign: campaign || NO_CAMPAIGN,
      platform: platform || null,
      spend: 0,
      clicks: 0,
      leads: 0,
      calls: 0,
      booked: 0,
      paid_customers: 0,
      plan_customers: 0,
      one_time_customers: 0,
      paid90: 0,
      cancels: 0,
      customers: [],
      rain_day: null,
    });
  }
  return rows.get(key);
}

async function loadSpend(conn, since, until) {
  return conn('ad_performance_daily as apd')
    .join('ad_campaigns as ac', 'ac.id', 'apd.campaign_id')
    .where('apd.date', '>=', since)
    .where('apd.date', '<=', until)
    .select('apd.campaign_id', 'apd.date', 'apd.cost', 'apd.clicks', 'ac.campaign_name', 'ac.platform');
}

// Paid leads in the window: any lead linked to a campaign, and unlinked leads of a paid source. Soft-deleted leads
// are left out (the same exclusion the dashboard's channel report uses).
async function loadLeads(conn, since, until) {
  return conn('ad_service_attribution as asa')
    .leftJoin('leads as l', 'l.id', 'asa.lead_id')
    .leftJoin('ad_campaigns as ac', 'ac.id', 'asa.campaign_id')
    .where('asa.lead_date', '>=', since)
    .where('asa.lead_date', '<=', until)
    .whereRaw('(asa.lead_id IS NULL OR l.deleted_at IS NULL)')
    .where((qb) => qb
      .whereNotNull('asa.campaign_id')
      .orWhereIn('asa.lead_source', PAID_SOURCES)
      .orWhere((fb) => fb.where('asa.lead_source', 'facebook').where((p) => p
        .where('asa.is_paid', true).orWhereNotNull('asa.fbclid').orWhereNotNull('asa.fbc'))))
    .select(
      'asa.id', 'asa.campaign_id', 'asa.customer_id', 'asa.lead_date', 'asa.lead_source', 'asa.funnel_stage',
      'asa.source_call_id', 'asa.created_at', 'ac.campaign_name', 'ac.platform', 'l.first_name as lead_first_name',
      'l.last_name as lead_last_name',
    );
}

async function loadCustomers(conn, ids) {
  const out = new Map();
  for (const part of chunks(ids, ID_CHUNK)) {
    const rows = await conn('customers').whereIn('id', part)
      .select('id', 'first_name', 'last_name', 'waveguard_tier', 'monthly_rate', 'pipeline_stage');
    for (const r of rows) out.set(String(r.id), r);
  }
  return out;
}

async function loadPaidInvoices(conn, ids, from) {
  const out = [];
  for (const part of chunks(ids, ID_CHUNK)) {
    const rows = await conn('invoices')
      .whereIn('customer_id', part)
      .where('status', 'paid')
      .whereNotNull('paid_at')
      .where('paid_at', '>=', from)
      .select('id', 'customer_id', 'total', 'paid_at', 'service_type', 'title', 'stripe_payment_intent_id');
    out.push(...rows);
  }
  return out;
}

// Refunds recorded on the payments of these invoices, by Stripe payment intent (payments has no invoice id). A
// partial refund leaves the invoice 'paid', so paid90 takes the refund off (the same net-of-refunds rule as
// customer-lifetime-revenue.js: amount minus refund_amount). A cash or check invoice has no intent and no refund row.
async function loadRefunds(conn, intentIds) {
  const wanted = new Set(intentIds.filter(Boolean).map(String));
  const out = new Map();
  for (const part of chunks([...wanted], ID_CHUNK)) {
    const rows = await conn('payments')
      .whereIn('stripe_payment_intent_id', part)
      .where('status', 'paid')
      .select('stripe_payment_intent_id', 'refund_amount');
    for (const r of rows) {
      const key = String(r.stripe_payment_intent_id);
      if (!wanted.has(key)) continue;
      out.set(key, (out.get(key) || 0) + (Number(r.refund_amount) || 0));
    }
  }
  return out;
}

async function loadRainDays(conn) {
  const row = await conn('system_settings').where({ key: RAIN_DAYS_KEY }).first();
  const days = parseJson(row?.value, {});
  return days && typeof days === 'object' && !Array.isArray(days) ? days : {};
}

function rainDayOf(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const score = entry.score && typeof entry.score === 'object' ? entry.score : null;
  return {
    call: entry.call || null,
    cutoff_call: entry.cutoff_call || null,
    scored: !!score,
    wet_day: score ? score.wet_day ?? null : null,
    hit: score ? score.hit ?? null : null,
    cutoff_hit: score ? score.cutoff_hit ?? null : null,
  };
}

function sumTotals(out) {
  return out.reduce((t, r) => ({
    spend: cents(t.spend + r.spend),
    clicks: t.clicks + r.clicks,
    leads: t.leads + r.leads,
    calls: t.calls + r.calls,
    booked: t.booked + r.booked,
    paid_customers: t.paid_customers + r.paid_customers,
    plan_customers: t.plan_customers + r.plan_customers,
    one_time_customers: t.one_time_customers + r.one_time_customers,
    paid90: cents(t.paid90 + r.paid90),
    cancels: t.cancels + r.cancels,
  }), {
    spend: 0, clicks: 0, leads: 0, calls: 0, booked: 0, paid_customers: 0, plan_customers: 0, one_time_customers: 0,
    paid90: 0, cancels: 0,
  });
}

/**
 * Credits each customer's paid invoices to their first-lead row: paid customer, plan or one-time, cancel and paid90.
 */
async function creditPaid(conn, rows, firstLead, customers) {
  const earliest = [...firstLead.values()].map((l) => dateOnlyString(l.lead_date)).sort()[0];
  const invoices = await loadPaidInvoices(conn, [...firstLead.keys()], parseETDateTime(`${earliest}T00:00`));
  const refunds = invoices.length ? await loadRefunds(conn, invoices.map((inv) => inv.stripe_payment_intent_id)) : new Map();
  const netOf = (inv) => Math.max((Number(inv.total) || 0)
    - (inv.stripe_payment_intent_id ? refunds.get(String(inv.stripe_payment_intent_id)) || 0 : 0), 0);
  const byCustomer = new Map();
  for (const inv of invoices) {
    const key = String(inv.customer_id);
    if (!byCustomer.has(key)) byCustomer.set(key, []);
    byCustomer.get(key).push({ ...inv, day: etDateString(new Date(inv.paid_at)) });
  }
  for (const [customerId, lead] of firstLead) {
    const leadDay = dateOnlyString(lead.lead_date);
    const paid = (byCustomer.get(customerId) || [])
      .filter((inv) => inv.day >= leadDay)
      .sort((a, b) => new Date(a.paid_at) - new Date(b.paid_at));
    if (!paid.length) continue;
    const row = rowFor(rows, {
      campaignId: lead.campaign_id,
      campaign: lead.campaign_name,
      platform: lead.campaign_id ? lead.platform : lead.lead_source,
      date: leadDay,
    });
    const customer = customers.get(customerId);
    const plan = isMembershipCustomerRow(customer || {});
    const churned = customer?.pipeline_stage === 'churned';
    const lastDay = daysAfter(leadDay, PAID90_DAYS);
    const paid90 = cents(paid.filter((inv) => inv.day <= lastDay).reduce((sum, inv) => sum + netOf(inv), 0));
    row.paid_customers += 1;
    if (plan) row.plan_customers += 1; else row.one_time_customers += 1;
    if (churned) row.cancels += 1;
    row.paid90 = cents(row.paid90 + paid90);
    row.customers.push({
      customer_id: customerId,
      first_paid_date: paid[0].day,
      service: paid[0].service_type || paid[0].title || null,
      plan,
      churned,
      paid90,
    });
  }

}

/**
 * The report. `since` and `until` are ET dates (YYYY-MM-DD), both inclusive. Returns
 * { since, until, rows, totals }; each row is described in rowFor.
 */
async function adResults({ since, until, conn = db } = {}) {
  const rows = new Map();

  for (const r of await loadSpend(conn, since, until)) {
    const row = rowFor(rows, { campaignId: r.campaign_id, campaign: r.campaign_name, platform: r.platform, date: dateOnlyString(r.date) });
    row.spend = cents(row.spend + Number(r.cost || 0));
    row.clicks += Number(r.clicks) || 0;
  }

  const leads = (await loadLeads(conn, since, until))
    .filter((l) => dateOnlyString(l.lead_date))
    // Same-day ties go to the earlier lead (created_at), as in ad-attribution-sync, then to id.
    .sort((a, b) => dateOnlyString(a.lead_date).localeCompare(dateOnlyString(b.lead_date))
      || (new Date(a.created_at || 0) - new Date(b.created_at || 0))
      || String(a.id).localeCompare(String(b.id)));
  const customerIds = [...new Set(leads.map((l) => l.customer_id).filter(Boolean).map(String))];
  const customers = await loadCustomers(conn, customerIds);
  // The owner's own test accounts never count (the same list the dashboard's channel report excludes).
  // Both the lead's name and the linked customer's name are checked, as the channel report does.
  const isTest = (lead) => {
    const c = lead.customer_id ? customers.get(String(lead.customer_id)) : null;
    if (isInternalTestContact({ customerId: lead.customer_id, firstName: lead.lead_first_name, lastName: lead.lead_last_name })) return true;
    return !!c && isInternalTestContact({ customerId: lead.customer_id, firstName: c.first_name, lastName: c.last_name });
  };

  const counted = leads.filter((l) => !isTest(l));
  // First-touch row per customer.
  const firstLead = new Map();
  for (const lead of counted) {
    const key = lead.customer_id && String(lead.customer_id);
    if (key && !firstLead.has(key)) firstLead.set(key, lead);
    const day = dateOnlyString(lead.lead_date);
    const row = rowFor(rows, {
      campaignId: lead.campaign_id,
      campaign: lead.campaign_name,
      platform: lead.campaign_id ? lead.platform : lead.lead_source,
      date: day,
    });
    row.leads += 1;
    if (lead.source_call_id) row.calls += 1;
    if (BOOKED_STAGES.includes(lead.funnel_stage)) row.booked += 1;
  }

  if (firstLead.size) await creditPaid(conn, rows, firstLead, customers);

  const rainDays = await loadRainDays(conn);
  const out = [...rows.values()].map((row) => ({
    ...row,
    customers: row.customers.slice(0, LIST_MAX),
    rain_day: rainDayOf(rainDays[row.date]),
  }));
  out.sort((a, b) => a.campaign.localeCompare(b.campaign) || b.date.localeCompare(a.date));

  const totals = sumTotals(out);

  return { since, until, rows: out, totals };
}

module.exports = { adResults, NO_CAMPAIGN, PAID90_DAYS, LIST_MAX };
