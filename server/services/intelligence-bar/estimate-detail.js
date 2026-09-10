// get_estimate_detail — what an estimate actually priced.
//
// Before this reader the bar could see that estimate links went out
// (find_similar_estimates, the conversation thread) but not the amounts
// inside them: "what did we quote him per application?" ended with the
// operator being sent to the Estimates tab. The priced contents live in
// estimates.estimate_data (JSONB, engine-shaped). Amounts, containers,
// cadence ladders, and customer viewability are read through the
// repository's existing owners of those rules — the estimate converter
// (recurring amounts, visit vocabulary, one-time containers) and the
// public estimate route (the pricing bundle every cadence the customer can
// pick from is built by, and which links a customer can open) — never a
// parallel reading of the stored shapes. Amount precedence on every line
// follows the proposal generator: an operator-accepted net (manualFinal*)
// outranks engine figures, an explicit zero is comped scope, a negative
// amount is a credit; all three are reported, never dropped.
// Record scope: estimate_id resolves to its customer through the
// task-context RECORDS map, customer_id is the customer selector itself.
const db = require('../../models/db');
const { deriveTotals } = require('../estimator-engine/draft-builder');

const ESTIMATE_COLUMNS = [
  'id', 'customer_id', 'customer_name', 'address', 'status', 'category', 'service_interest',
  'waveguard_tier', 'monthly_total', 'annual_total', 'onetime_total', 'token',
  'sent_at', 'viewed_at', 'accepted_at', 'declined_at', 'expires_at', 'archived_at',
  'view_count', 'notes', 'pricing_version', 'bill_by_invoice', 'show_one_time_option',
  'accepted_service_mode', 'accepted_frequency_key',
  'disposition', 'disposition_note', 'decline_reason', 'created_at', 'updated_at', 'estimate_data',
];

const MAX_PER_CUSTOMER = 10;
const DEFAULT_PER_CUSTOMER = 3;
const PUBLIC_ESTIMATE_BASE = 'https://portal.wavespestcontrol.com/estimate/';

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

// The converter and the public route pull in the full estimate pipeline;
// estimate-public does the same lazy require of the converter for that
// reason, and the registry must not load either with the tool list.
const lazy = {
  converter: () => require('../estimate-converter'),
  publicRoute: () => require('../../routes/estimate-public'),
};

// Customer-facing name first: set_estimate_presentation relabels a service
// by writing displayName only, and every customer renderer prefers it.
function lineName(row, Converter) {
  return row.displayName || row.name || row.label || row.serviceName || row.service_name
    || row.description || Converter.recurringServiceKey(row) || 'Service';
}

function overrideAmount(value) {
  return value != null && Number.isFinite(Number(value)) ? money(value) : null;
}

// ── Recurring lines ──────────────────────────────────────────────────
// manualFinalAnnual (zero = fully comped) outranks the engine figures;
// otherwise the converter's alias-aware reader (annualAfterDiscount /
// annual / ann, or mo / monthly × 12).
function recurringLine(svc, Converter) {
  const override = overrideAmount(svc.manualFinalAnnual);
  const annual = override ?? money(Converter.recurringLineAnnualAmount(svc));
  const monthly = override != null
    ? money(annual / 12)
    : (money(svc.monthlyAfterDiscount ?? svc.mo ?? svc.monthly) ?? (annual > 0 ? money(annual / 12) : null));
  const visits = Converter.visitsPerYearForRecurringService(svc) || null;
  const priced = annual > 0 || override != null;
  const line = {
    service: lineName(svc, Converter),
    frequency: svc.frequency || svc.frequencyKey || svc.frequency_key || null,
    visits_per_year: visits,
    monthly: priced ? monthly : null,
    annual: priced ? annual : null,
    // The per-application figure the operator is usually asking for.
    per_visit: priced && visits ? money(annual / visits) : null,
  };
  if (override === 0) line.comped = true;
  if (svc.quoteRequired === true) line.quote_required = true;
  return line;
}

// ── One-time lines ───────────────────────────────────────────────────
// Amount precedence from the proposal generator's resolvers: operator-
// accepted net first, then the explicit one-time fields, then discounted,
// then gross. A negative gross (credit) keeps its sign unless a non-zero
// discounted figure replaces it.
function oneTimeAmount(item = {}) {
  const override = overrideAmount(item.manualFinalOneTime);
  if (override != null) return override;
  const raw = Number(item.oneTimePrice ?? item.onetime_price ?? item.oneTime ?? item.amount ?? item.price ?? item.total ?? item.installation?.price);
  const discounted = Number(item.priceAfterDiscount ?? item.totalAfterDiscount);
  const amount = Number.isFinite(raw) && raw < 0
    ? (Number.isFinite(discounted) && discounted !== 0 ? discounted : raw)
    : (Number.isFinite(discounted) ? discounted : raw);
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : null;
}

// Raw engine lines that are one-time work, by the proposal generator's
// rule: an explicit one-time cadence wins; otherwise only the explicit
// annual cadence fields or recurring dollars count as recurring evidence
// (a package `visits` count on a priced row is not). Rows a program already
// includes never bill again. A line qualifies when it carries a one-time
// amount (positive, a credit, or an accepted zero).
function rawOneTimeLines(data, Converter) {
  const lines = data.lineItems || data.result?.lineItems || data.engineResult?.lineItems || data.estimate?.lineItems || [];
  if (!Array.isArray(lines)) return [];
  return lines.filter((line) => {
    if (!line || typeof line !== 'object') return false;
    if (line.onProg === true || line.includedOnProgram === true) return false;
    const cadence = String(line.billingCadence || line.billing_cadence || line.frequency || line.cadence || '')
      .trim().toLowerCase().replace(/[\s-]+/g, '_');
    const explicitOneTime = cadence === 'one_time' || cadence === 'onetime';
    const annualCadence = Number(line.visitsPerYear) > 0 || Number(line.appsPerYear) > 0 || Number(line.treatmentsPerYear) > 0;
    if (!explicitOneTime && (annualCadence || Converter.recurringLineAnnualAmount(line) > 0)) return false;
    const amount = oneTimeAmount(line);
    return amount != null && (amount !== 0 || overrideAmount(line.manualFinalOneTime) === 0);
  });
}

function oneTimeKey(row) {
  return String(row.service || row.key || row.serviceKey || row.service_key || row.name || row.label || row.displayName || '').toLowerCase().trim();
}

// Mapped containers over both stored shapes (root and { result:
// engineResult }) plus the raw engine lines. A mapped item and its raw
// twin (same service) are ONE charge — the mapped row consumes the twin
// and an operator-accepted net on either side wins.
function oneTimeLines(data, Converter) {
  const list = (v) => (Array.isArray(v) ? v : []);
  const engineShaped = data.engineResult && typeof data.engineResult === 'object' ? { result: data.engineResult } : null;
  let mapped = [];
  try {
    mapped = [
      ...list(Converter.estimateOneTimeItemsFromData(data)),
      ...(engineShaped ? list(Converter.estimateOneTimeItemsFromData(engineShaped)) : []),
    ];
  } catch {
    mapped = [];
  }
  const raw = rawOneTimeLines(data, Converter).map((line) => ({ line, used: false }));
  const lines = [];
  const seen = new Set();
  const push = (item, twin) => {
    const override = overrideAmount(item.manualFinalOneTime) ?? (twin ? overrideAmount(twin.manualFinalOneTime) : null);
    const amount = override ?? oneTimeAmount(item);
    const line = { item: lineName(item, Converter), amount };
    if (override === 0) line.comped = true;
    if (amount != null && amount < 0) line.credit = true;
    const key = `${line.item.toLowerCase()}|${line.amount}`;
    if (seen.has(key)) return;
    seen.add(key);
    lines.push(line);
  };
  for (const item of mapped) {
    const key = oneTimeKey(item);
    const twin = key ? raw.find((entry) => !entry.used && oneTimeKey(entry.line) === key) : null;
    if (twin) twin.used = true;
    push(item, twin ? twin.line : null);
  }
  for (const entry of raw) {
    if (!entry.used) push(entry.line, null);
  }
  return lines;
}

// ── Offered cadences ─────────────────────────────────────────────────
// A residential pest estimate offers a ladder (quarterly / bi-monthly /
// monthly) the customer picks from on the public page; the stored
// recurring row is only the recommended one. The public route's pricing
// bundle is the canonical ladder, so "what did we quote for quarterly"
// answers from the same rows the customer saw.
async function offeredFrequencies(row) {
  try {
    const bundle = await lazy.publicRoute().buildPricingBundle(row);
    const frequencies = Array.isArray(bundle?.frequencies) ? bundle.frequencies : [];
    return frequencies.map((f) => ({
      key: f.key || null,
      label: f.label || null,
      monthly: money(f.monthly),
      annual: money(f.annual),
      per_visit: money(f.perVisit),
      one_time_total: money(f.oneTimeTotal),
    }));
  } catch {
    return null;
  }
}

// ── Links ────────────────────────────────────────────────────────────
// Only where the public route would serve them: the customer link when
// isEstimateCustomerViewable says so, the staff draft preview for an
// unpublished, unarchived row, nothing otherwise — a bare token URL for a
// draft, expired, send_failed, or archived estimate is a 404 in the
// customer's hands.
function estimateLinks(row) {
  if (!row.token) return { customer_link: null, staff_preview_link: null, link_state: 'no_token' };
  const publicRoute = lazy.publicRoute();
  if (publicRoute.isEstimateCustomerViewable(row)) {
    return { customer_link: `${PUBLIC_ESTIMATE_BASE}${row.token}`, staff_preview_link: null, link_state: 'customer_viewable' };
  }
  if (publicRoute.adminDraftPreviewEligible(row, '1')) {
    return { customer_link: null, staff_preview_link: `${PUBLIC_ESTIMATE_BASE}${row.token}?adminPreview=1`, link_state: 'staff_preview_only' };
  }
  return { customer_link: null, staff_preview_link: null, link_state: 'not_openable' };
}

async function shapeEstimate(row, deposits = []) {
  const Converter = lazy.converter();
  const data = parseStoredJson(row.estimate_data);
  let recurring = [];
  try {
    recurring = Converter.recurringServicesFromEstimateData(data) || [];
  } catch {
    // Malformed stored data: totals below still come from the columns.
  }
  // Same engine-result selection as the proposal generator: agent and
  // website rows persist { engineResult: { summary, lineItems } }.
  const result = data.result || data.engineResult || data;
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
    offered_frequencies: await offeredFrequencies(row),
    one_time_items: oneTimeLines(data, Converter),
    accepted: row.accepted_at ? { at: row.accepted_at, service_mode: row.accepted_service_mode || null, frequency: row.accepted_frequency_key || null } : null,
    deposits: deposits.map((d) => ({
      amount: money(d.amount), credited: money(d.credited_amount), refunded: money(d.refunded_amount), status: d.status, received_at: d.received_at,
    })),
    customer_notes: row.notes || null,
    ...estimateLinks(row),
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
  const estimates = [];
  for (const row of rows) estimates.push(await shapeEstimate(row, byEstimate.get(row.id) || []));
  return { count: rows.length, estimates };
}

const GET_ESTIMATE_DETAIL_TOOL = {
  name: 'get_estimate_detail',
  description: `Read what an estimate actually priced: every recurring service with its monthly, annual, and per-visit (per-application) amount, the offered cadence ladder (quarterly / bi-monthly / monthly as the customer sees it), one-time items including credits and comped work, totals, deposits, status, view/sent/accepted timestamps, and which link (customer or staff preview) can actually be opened. Pass estimate_id for one estimate or customer_id for that customer's latest estimates (newest first).
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
