// get_estimate_detail — what an estimate actually priced.
//
// Before this reader the bar could see that estimate links went out
// (find_similar_estimates, the conversation thread) but not the amounts
// inside them: "what did we quote him per application?" ended with the
// operator being sent to the Estimates tab. The priced contents live in
// estimates.estimate_data (JSONB, engine-shaped); the converter owns the
// supported containers, so the rows come from its extractors rather than a
// re-listing of shapes here. Record scope: estimate_id resolves to its
// customer through the task-context RECORDS map, customer_id is the
// customer selector itself.
const db = require('../../models/db');
const { deriveTotals } = require('../estimator-engine/draft-builder');

const ESTIMATE_COLUMNS = [
  'id', 'customer_id', 'customer_name', 'address', 'status', 'category', 'service_interest',
  'waveguard_tier', 'monthly_total', 'annual_total', 'onetime_total', 'token',
  'sent_at', 'viewed_at', 'accepted_at', 'declined_at', 'expires_at', 'archived_at',
  'view_count', 'notes', 'pricing_version', 'bill_by_invoice',
  'accepted_service_mode', 'accepted_frequency_key',
  'disposition', 'disposition_note', 'decline_reason', 'created_at', 'updated_at', 'estimate_data',
];

const MAX_PER_CUSTOMER = 10;
const DEFAULT_PER_CUSTOMER = 3;

function money(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function parseStoredJson(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function lineName(row, Converter) {
  return row.name || row.label || row.displayName || row.serviceName || row.service_name
    || row.description || Converter.recurringServiceKey(row) || 'Service';
}

// Mirrors estimate-public's oneTimeItemAmount: a discounted figure wins
// when present, a negative raw amount (credit) keeps its sign.
function oneTimeAmount(item = {}) {
  const raw = Number(item.amount ?? item.price ?? item.total);
  const discounted = Number(item.priceAfterDiscount ?? item.totalAfterDiscount);
  const amount = Number.isFinite(raw) && raw < 0
    ? (Number.isFinite(discounted) && discounted !== 0 ? discounted : raw)
    : (Number.isFinite(discounted) ? discounted : raw);
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : null;
}

function recurringLine(svc, Converter) {
  const monthly = money(svc.monthlyAfterDiscount ?? svc.monthly);
  const annual = money(svc.annualAfterDiscount ?? svc.annual);
  const visits = Number(svc.visitsPerYear ?? svc.visits_per_year ?? svc.visits) || null;
  const yearly = annual ?? (monthly == null ? null : money(monthly * 12));
  const line = {
    service: lineName(svc, Converter),
    frequency: svc.frequency || svc.frequencyKey || svc.frequency_key || null,
    visits_per_year: visits,
    monthly,
    annual: yearly,
    // The per-application figure the operator is usually asking for.
    per_visit: visits && yearly != null ? money(yearly / visits) : null,
  };
  if (svc.quoteRequired === true) line.quote_required = true;
  return line;
}

function shapeEstimate(row, deposits = []) {
  // Lazy like estimate-public: the converter pulls in the full estimate
  // pipeline and must not load with the tool registry.
  const Converter = require('../estimate-converter');
  const data = parseStoredJson(row.estimate_data);
  let recurring = [];
  let oneTime = [];
  try {
    recurring = Converter.recurringServicesFromEstimateData(data) || [];
    oneTime = Converter.estimateOneTimeItemsFromData(data) || [];
  } catch {
    // Malformed stored data: totals below still come from the columns.
  }
  const result = data.result && typeof data.result === 'object' ? data.result : data;
  const derived = deriveTotals(result);
  const stored = { monthly: money(row.monthly_total), annual: money(row.annual_total), one_time: money(row.onetime_total) };
  return {
    id: row.id,
    customer_id: row.customer_id,
    customer: row.customer_name,
    address: row.address,
    status: row.status,
    disposition: row.disposition || null,
    disposition_note: row.disposition_note || null,
    decline_reason: row.decline_reason || null,
    category: row.category,
    service_interest: row.service_interest,
    tier: row.waveguard_tier,
    pricing_version: row.pricing_version || null,
    bill_by_invoice: row.bill_by_invoice === true,
    totals: {
      monthly: stored.monthly ?? derived.monthly,
      annual: stored.annual ?? derived.annual,
      one_time: stored.one_time ?? derived.oneTime,
    },
    recurring_services: recurring.map((svc) => recurringLine(svc, Converter)),
    one_time_items: oneTime.map((item) => ({ item: lineName(item, Converter), amount: oneTimeAmount(item) })),
    accepted: row.accepted_at ? { at: row.accepted_at, service_mode: row.accepted_service_mode || null, frequency: row.accepted_frequency_key || null } : null,
    deposits: deposits.map((d) => ({
      amount: money(d.amount), credited: money(d.credited_amount), refunded: money(d.refunded_amount), status: d.status, received_at: d.received_at,
    })),
    customer_notes: row.notes || null,
    link: row.token ? `https://portal.wavespestcontrol.com/estimate/${row.token}` : null,
    sent_at: row.sent_at,
    viewed_at: row.viewed_at,
    view_count: row.view_count || 0,
    declined_at: row.declined_at,
    expires_at: row.expires_at,
    archived_at: row.archived_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function getEstimateDetail({ estimate_id, customer_id, limit } = {}) {
  if (!estimate_id && !customer_id) return { error: 'Provide estimate_id or customer_id' };
  let query = db('estimates').select(ESTIMATE_COLUMNS).orderBy('created_at', 'desc');
  if (estimate_id) {
    query = query.where('id', estimate_id).limit(1);
  } else {
    const count = Math.max(1, Math.min(Math.trunc(Number(limit)) || DEFAULT_PER_CUSTOMER, MAX_PER_CUSTOMER));
    query = query.where('customer_id', customer_id).whereNull('archived_at').limit(count);
  }
  const rows = await query;
  if (!rows.length) {
    return {
      count: 0,
      estimates: [],
      error: estimate_id ? 'No estimate matches that id' : 'No estimates on file for that customer',
    };
  }
  const deposits = await db('estimate_deposits')
    .whereIn('estimate_id', rows.map((r) => r.id))
    .select('estimate_id', 'amount', 'credited_amount', 'refunded_amount', 'status', 'received_at')
    .orderBy('created_at', 'desc');
  const byEstimate = new Map();
  for (const d of deposits) {
    if (!byEstimate.has(d.estimate_id)) byEstimate.set(d.estimate_id, []);
    byEstimate.get(d.estimate_id).push(d);
  }
  return {
    count: rows.length,
    estimates: rows.map((row) => shapeEstimate(row, byEstimate.get(row.id) || [])),
  };
}

const GET_ESTIMATE_DETAIL_TOOL = {
  name: 'get_estimate_detail',
  description: `Read what an estimate actually priced: every recurring service with its monthly, annual, and per-visit (per-application) amount, one-time items, totals, deposits, status, view/sent/accepted timestamps, and the customer link. Pass estimate_id for one estimate or customer_id for that customer's latest estimates (newest first).
Use for: "what did we quote him for quarterly pest", "what is the per-application price on her estimate", "did the estimate include the one-time cleanup", "what did the 9/5 estimate say" — anything about the amounts inside a sent estimate. Prefer this over guessing from monthly_rate or from the SMS thread.`,
  input_schema: {
    type: 'object',
    properties: {
      estimate_id: { type: 'string', format: 'uuid', description: 'Estimate UUID — returns exactly that estimate' },
      customer_id: { type: 'string', format: 'uuid', description: 'Customer UUID — returns that customer\'s latest estimates when no estimate_id is given' },
      limit: { type: 'number', description: 'With customer_id: how many recent estimates to return (default 3, max 10)' },
    },
  },
};

module.exports = { GET_ESTIMATE_DETAIL_TOOL, getEstimateDetail, shapeEstimate, ESTIMATE_COLUMNS };
