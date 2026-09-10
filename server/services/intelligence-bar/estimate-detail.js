// get_estimate_detail — what an estimate actually priced.
//
// Before this reader the bar could see that estimate links went out
// (find_similar_estimates, the conversation thread) but not the amounts
// inside them: "what did we quote him per application?" ended with the
// operator being sent to the Estimates tab. The priced contents live in
// estimates.estimate_data (JSONB, engine-shaped) and every reading here
// goes through the repository's existing owner of that rule:
//   recurring lines  → plan-rate-ledger acceptedRecurringBillingLines (the
//                      acceptance path's list: converter rows + raw engine
//                      lines + rodent/palm scalar supplements, every root)
//   review state     → draft-builder lineRequiresReview / lineHasHeuristicTurf
//                      + the proposal generator's LOW-confidence guard
//   one-time lines   → converter extractors (collapseMirrored: occurrence-
//                      aware) over both stored shapes + BOTH raw containers
//                      + installation charges on recurring rows, twins
//                      reconciled by service + exact amount first, as the
//                      proposal generator's resolver does; credits and
//                      accepted zeros are reported, never dropped
//   cadence ladders  → estimate-public buildPricingBundle (top-level plan
//                      totals, per-service ladders, cadence combos)
//   links            → estimate-public isEstimateCustomerViewable /
//                      adminDraftPreviewEligible + the durable call-side
//                      block (estimate-claim-sql), the same 404 checks the
//                      public page runs
// Record scope: estimate_id resolves to its customer through the
// task-context RECORDS map, customer_id is the customer selector itself.
const db = require('../../models/db');
const { deriveTotals, lineRequiresReview, lineHasHeuristicTurf } = require('../estimator-engine/draft-builder');

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

// The converter, the ledger, and the public route pull in the full
// estimate pipeline; estimate-public does the same lazy require of the
// converter for that reason, and the registry must not load them with
// the tool list.
const lazy = {
  converter: () => require('../estimate-converter'),
  ledger: () => require('../plan-rate-ledger'),
  publicRoute: () => require('../../routes/estimate-public'),
  claimSql: () => require('../../utils/estimate-claim-sql'),
};

const list = (v) => (Array.isArray(v) ? v : []);

// Customer-facing copy first (set_estimate_presentation writes displayName
// only; raw engine rows nest display.name), never the internal key when a
// label exists — the proposal generator's rawLineLabel order.
function lineName(row, Converter) {
  return row.displayName || row.label || row.display?.name || row.name || row.serviceName || row.service_name
    || row.description || Converter.recurringServiceKey(row) || row.service || 'Service';
}

function overrideAmount(value) {
  return value != null && Number.isFinite(Number(value)) ? money(value) : null;
}

// ── Recurring lines ──────────────────────────────────────────────────
// manualFinalAnnual (zero = fully comped) outranks the engine figures;
// otherwise the converter's alias-aware reader (annualAfterDiscount /
// annual / ann, or mo / monthly × 12). A row gated by ANY review marker
// (the estimator's complete predicate, heuristic turf, LOW confidence) is
// a field-verification price and says so beside its amount.
function reviewState(svc) {
  const reasons = [];
  let gated = false;
  try { gated = lineRequiresReview(svc); } catch { gated = false; }
  if (gated) reasons.push('requires_review');
  let turf = false;
  try { turf = lineHasHeuristicTurf(svc); } catch { turf = false; }
  if (turf) reasons.push('heuristic_turf');
  if (String(svc.pricingConfidence || '').toUpperCase() === 'LOW') reasons.push('low_confidence');
  for (const reason of list(svc.manualReviewReasons)) reasons.push(String(reason));
  return reasons;
}

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
    frequency: svc.frequency || svc.frequencyKey || svc.frequency_key || svc.cadence || null,
    visits_per_year: visits,
    monthly: priced ? monthly : null,
    annual: priced ? annual : null,
    // The per-application figure the operator is usually asking for.
    per_visit: priced && visits ? money(annual / visits) : null,
  };
  if (override === 0) line.comped = true;
  if (svc.quoteRequired === true) line.quote_required = true;
  const reasons = reviewState(svc);
  if (reasons.length) {
    line.review_required = true;
    line.review_reasons = [...new Set(reasons)];
  }
  return line;
}

function recurringLines(data, Converter) {
  try {
    return list(lazy.ledger().acceptedRecurringBillingLines(data)).map((svc) => recurringLine(svc, Converter));
  } catch {
    try {
      return list(Converter.recurringServicesFromEstimateData(data)).map((svc) => recurringLine(svc, Converter));
    } catch {
      return [];
    }
  }
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

function isExplicitOneTime(line) {
  const cadence = String(line.billingCadence || line.billing_cadence || line.frequency || line.cadence || '')
    .trim().toLowerCase().replace(/[\s-]+/g, '_');
  return cadence === 'one_time' || cadence === 'onetime';
}

function hasAnnualCadence(line) {
  return Number(line.visitsPerYear) > 0 || Number(line.appsPerYear) > 0 || Number(line.treatmentsPerYear) > 0;
}

// BOTH raw containers contribute (a truthy ancillary result must not hide
// engineResult.lineItems), object-deduped — the proposal generator's rule.
function rawContainers(data) {
  const result = data.result || data.engineResult || data;
  const containers = [
    list(result.lineItems),
    data.engineResult && data.engineResult !== result ? list(data.engineResult.lineItems) : [],
    list(data.lineItems),
    list(data.estimate?.lineItems),
  ];
  const seen = new Set();
  const rows = [];
  for (const container of containers) {
    for (const line of container) {
      if (!line || typeof line !== 'object' || seen.has(line)) continue;
      seen.add(line);
      rows.push(line);
    }
  }
  return rows;
}

// Raw engine lines that are one-time work: an explicit one-time cadence
// wins; otherwise only the explicit annual cadence fields or recurring
// dollars count as recurring evidence (a package `visits` count on a
// priced row is not). Rows a program already includes never bill again.
function rawOneTimeLines(rows, Converter) {
  return rows.filter((line) => {
    if (line.onProg === true || line.includedOnProgram === true) return false;
    if (!isExplicitOneTime(line) && (hasAnnualCadence(line) || Converter.recurringLineAnnualAmount(line) > 0)) return false;
    const amount = oneTimeAmount(line);
    return amount != null && (amount !== 0 || overrideAmount(line.manualFinalOneTime) === 0);
  });
}

// Recurring rows can CARRY a one-time installation charge
// (installation.price on termite-bait lines) — reported as its own line
// even though the row itself is recurring.
function installationLines(rows, Converter) {
  return rows
    .filter((line) => line.onProg !== true && line.includedOnProgram !== true
      && Number(line.installation?.price) > 0
      && (Converter.visitsPerYearForRecurringService(line) > 0 || Converter.recurringLineAnnualAmount(line) > 0))
    .map((line) => ({ item: `${lineName(line, Converter)} installation`, amount: money(line.installation.price) }));
}

function serviceIdOf(row) {
  return String(row.service || row.key || row.serviceKey || row.service_key || row.name || row.label || row.displayName || '').toLowerCase().trim();
}

// Mapped containers over both stored shapes (mirrors collapsed
// occurrence-aware by the converter, so two legitimate identical unit
// treatments survive) plus the raw engine lines. A mapped item and its raw
// twin are ONE charge: the exact-amount mirror is the twin first, then any
// same-service row; an operator-accepted net on either side wins; two
// accepted nets or two engine amounts that disagree are reported with a
// conflict flag rather than silently resolved by array order.
// One mapped item against the raw pool: the exact-amount mirror is the
// twin first, then any same-service row; an operator-accepted net on
// either side wins; two accepted nets or two engine amounts that disagree
// are reported with a conflict flag rather than resolved by array order.
function resolveMappedItem(item, pool) {
  const service = serviceIdOf(item);
  const itemAmount = oneTimeAmount(item);
  const itemManual = overrideAmount(item.manualFinalOneTime);
  const twinEntry = (service && pool.find((e) => !e.used && serviceIdOf(e.line) === service && oneTimeAmount(e.line) === itemAmount))
    || (service && pool.find((e) => !e.used && serviceIdOf(e.line) === service))
    || null;
  if (!twinEntry) return { amount: itemAmount, flags: itemManual === 0 ? { comped: true } : {} };
  twinEntry.used = true;
  const twin = twinEntry.line;
  const twinManual = overrideAmount(twin.manualFinalOneTime);
  if (twinManual === 0 || itemManual === 0) return { amount: 0, flags: { comped: true } };
  if (twinManual != null && itemManual != null && twinManual !== itemManual) {
    return { amount: itemManual, flags: { conflict: true, other_amount: twinManual } };
  }
  if (twinManual != null && itemManual == null) return { amount: twinManual, flags: {} };
  const twinAmount = oneTimeAmount(twin);
  if (twinManual == null && itemManual == null && twinAmount !== itemAmount) {
    return { amount: itemAmount, flags: { conflict: true, other_amount: twinAmount } };
  }
  return { amount: itemAmount, flags: {} };
}

function mappedOneTimeItems(data, Converter) {
  const engineShaped = data.engineResult && typeof data.engineResult === 'object' && data.engineResult !== data.result
    ? { result: data.engineResult } : null;
  try {
    const rootItems = list(Converter.estimateOneTimeItemsFromData(data, { collapseMirrored: true }));
    const engineItems = engineShaped ? list(Converter.estimateOneTimeItemsFromData(engineShaped, { collapseMirrored: true })) : [];
    const seen = new Set();
    const mapped = [];
    for (const item of [...rootItems, ...engineItems]) {
      if (!item || typeof item !== 'object' || seen.has(item)) continue;
      seen.add(item);
      mapped.push(item);
    }
    return mapped;
  } catch {
    return [];
  }
}

// Mapped containers over both stored shapes (mirrors collapsed
// occurrence-aware by the converter, so two legitimate identical unit
// treatments survive) plus the raw engine lines, twins reconciled above.
function oneTimeLines(data, Converter) {
  const rows = rawContainers(data);
  const pool = rawOneTimeLines(rows, Converter).map((line) => ({ line, used: false }));
  const lines = [];
  const emit = (row, amount, flags) => {
    const line = { item: lineName(row, Converter), amount };
    if (amount != null && amount < 0) line.credit = true;
    lines.push(Object.assign(line, flags));
  };
  for (const item of mappedOneTimeItems(data, Converter)) {
    const { amount, flags } = resolveMappedItem(item, pool);
    emit(item, amount, flags);
  }
  for (const entry of pool) {
    if (entry.used) continue;
    emit(entry.line, oneTimeAmount(entry.line), overrideAmount(entry.line.manualFinalOneTime) === 0 ? { comped: true } : {});
  }
  return [...lines, ...installationLines(rows, Converter)];
}

// ── Offered cadences ─────────────────────────────────────────────────
// The public route's pricing bundle is the ladder the customer picks from:
// top-level plan totals per cadence, per-service ladders (pest quarterly /
// bi-monthly / monthly, lawn standard / enhanced / premium) and the priced
// combinations on a mixed estimate. The stored recurring row is only the
// recommended pick.
function frequencyEntry(f) {
  const entry = {
    key: f.key || null,
    label: f.label || null,
    monthly: money(f.monthly),
    annual: money(f.annual),
    per_visit: money(f.perTreatment ?? f.perVisit),
    visits_per_year: Number(f.visitsPerYear) > 0 ? Number(f.visitsPerYear) : null,
  };
  if (f.oneTimeTotal != null) entry.one_time_total = money(f.oneTimeTotal);
  if (f.quoteRequired === true) entry.quote_required = true;
  return entry;
}

async function offeredPricing(row) {
  try {
    const bundle = await lazy.publicRoute().buildPricingBundle(row);
    if (!bundle || typeof bundle !== 'object') return null;
    return {
      plan_frequencies: list(bundle.frequencies).map(frequencyEntry),
      services: list(bundle.services).map((s) => ({
        key: s.key || null,
        label: s.label || null,
        default_frequency_key: s.defaultFrequencyKey || null,
        frequencies: list(s.frequencies).map(frequencyEntry),
      })),
      combos: list(bundle.serviceCadenceCombos).map((c) => ({ key: c.key || null, monthly: money(c.monthly), annual: money(c.annual) })),
    };
  } catch {
    return null;
  }
}

// ── Links ────────────────────────────────────────────────────────────
// Only where the public route would serve them: the durable call-side
// block and the customer-surface check first (both 404 on the public
// page), then the customer link when isEstimateCustomerViewable says so,
// the staff draft preview for an unpublished, unarchived row, nothing
// otherwise.
async function estimateLinks(row, data) {
  if (!row.token) return { customer_link: null, staff_preview_link: null, link_state: 'no_token' };
  let blocked = false;
  try {
    blocked = !!(await lazy.claimSql().callSideBlockForEstimateData(db, data));
  } catch {
    blocked = true; // fail closed: an unverifiable block is not a link
  }
  if (blocked) return { customer_link: null, staff_preview_link: null, link_state: 'blocked' };
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
    recurring_services: recurringLines(data, Converter),
    offered_pricing: await offeredPricing(row),
    one_time_items: oneTimeLines(data, Converter),
    accepted: row.accepted_at ? { at: row.accepted_at, service_mode: row.accepted_service_mode || null, frequency: row.accepted_frequency_key || null } : null,
    deposits: deposits.map((d) => ({
      amount: money(d.amount), credited: money(d.credited_amount), refunded: money(d.refunded_amount), status: d.status, received_at: d.received_at,
    })),
    customer_notes: row.notes || null,
    ...(await estimateLinks(row, data)),
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
  description: `Read what an estimate actually priced: every recurring service being billed (monthly, annual, per-visit / per-application, with review_required when the amount is still a field-verification price), the offered pricing the customer picks from (plan cadences, per-service ladders such as pest quarterly / bi-monthly / monthly and lawn tiers, priced combinations), one-time items including installation charges, credits and comped work, totals, deposits, status, view/sent/accepted timestamps, and which link (customer or staff preview) can actually be opened. Pass estimate_id for one estimate or customer_id for that customer's latest estimates (newest first).
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
