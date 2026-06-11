// ============================================================
// estimate-membership-context.js
//
// Builds the customer-facing "WaveGuard membership" context for an estimate
// that is linked to an existing, active customer (estimates.customer_id set).
//
// computeMembershipContext() is run ONCE at estimate save/reprice time
// (admin-estimate-persistence.js) and the result is frozen onto the estimate as
// estimate_data.membershipSnapshot. buildEstimateMembershipContext() then just
// reads that snapshot at view time. This keeps the card tied to the saved
// pricing — it can never diverge from the charged total because of mutable
// scheduled_services changing between save and view, and legacy estimates with
// no snapshot render no card.
//
// The NEW-service member discount it shows is honored at the charged total
// because the same combined tier (from the same shared waveguard-existing-
// services loader) reprices the estimate at save. The existing-service
// per-application figures remain informational (crediting them against existing
// prepaid visits is a separate billing action).
//
// The snapshot captures:
//   1. The combined WaveGuard tier — existing qualifying services PLUS the
//      new service(s) in this estimate.
//   2. The tier-upgrade callout (e.g. Silver -> Gold).
//   3. The per-application savings on EXISTING recurring services from a tier
//      upgrade — per remaining visit, prepaid-aware.
//   4. The member discount on the NEW service in this estimate.
//
// Returns null for leads (no customer_id), inactive customers, or on ANY error
// so neither save nor the public estimate endpoints ever break (CLAUDE.md r6).
// ============================================================

const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');
const { determineWaveGuardTier } = require('./pricing-engine/discount-engine');
const { toQualifyingKey, loadExistingRecurringQualifyingRows } = require('./waveguard-existing-services');

const TIER_LABEL = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold', platinum: 'Platinum' };
const SERVICE_LABEL = {
  pest_control: 'Pest Control',
  lawn_care: 'Lawn Care',
  tree_shrub: 'Tree & Shrub',
  mosquito: 'Mosquito',
  termite_bait: 'Termite Bait',
};

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function parseEstimateData(estimate) {
  try {
    return typeof estimate.estimate_data === 'string'
      ? JSON.parse(estimate.estimate_data)
      : (estimate.estimate_data || {});
  } catch { return {}; }
}

// A row from estimate_data.lineItems / .services counts as a recurring service
// only if it carries recurring pricing (annual/monthly). One-time and specialty
// lines carry .price / .total and must NOT count toward the WaveGuard tier —
// one-time services never receive the tier discount and the charged price is
// unchanged, so advertising a tier upgrade off them would be wrong.
function isRecurringLineRow(c) {
  if (!c || typeof c !== 'object') return false;
  if (c.isOneTime === true || c.oneTime === true || c.one_time === true) return false;
  const hasAnnual = Number(c.annual ?? c.ann ?? c.annualBeforeDiscount) > 0;
  const hasMonthly = Number(c.monthly ?? c.mo ?? c.monthlyBeforeDiscount) > 0;
  if (hasAnnual || hasMonthly) return true;
  // price/total only (no recurring figure) → one-time / specialty.
  if (Number(c.price) > 0 || Number(c.total) > 0) return false;
  return c.recurring === true || c.isRecurring === true || !!c.frequency;
}

// Collect the candidate recurring-service rows across the several estimate_data
// shapes (v1 admin shape, engineResult, lineItems, services). The explicit
// recurring sections are trusted; the mixed lineItems / services arrays are
// filtered to recurring rows so one-time treatments don't inflate the tier.
function recurringCandidates(estData) {
  const out = [];
  const pushAll = (arr) => { if (Array.isArray(arr)) out.push(...arr); };
  pushAll(estData?.result?.recurring?.services);
  pushAll(estData?.engineResult?.recurring?.services);
  pushAll(estData?.recurring?.services);
  const mixed = [];
  if (Array.isArray(estData?.lineItems)) mixed.push(...estData.lineItems);
  if (Array.isArray(estData?.services)) mixed.push(...estData.services);
  for (const row of mixed) { if (isRecurringLineRow(row)) out.push(row); }
  return out;
}

function candidateName(c) {
  return c?.service || c?.key || c?.name || c?.label || c?.displayName || c?.service_type;
}

// Qualifying recurring service keys present in this estimate.
function estimateQualifyingKeys(estData) {
  const keys = new Set();
  for (const c of recurringCandidates(estData)) {
    const key = toQualifyingKey(candidateName(c));
    if (key) keys.add(key);
  }
  return [...keys];
}

// Best-effort monthly (pre-discount) price for a qualifying key from the
// estimate, if one is present. Used only to express the new-service member
// savings as a dollar figure — omitted when no price is found.
function estimateMonthlyFor(estData, key) {
  for (const c of recurringCandidates(estData)) {
    if (toQualifyingKey(candidateName(c)) !== key) continue;
    const monthly = c?.monthlyBeforeDiscount
      ?? c?.monthly
      ?? c?.mo
      ?? (Number(c?.annualBeforeDiscount) > 0 ? c.annualBeforeDiscount / 12 : null)
      ?? (Number(c?.annual) > 0 ? c.annual / 12 : null);
    if (Number(monthly) > 0) return round2(monthly);
  }
  return null;
}

// Visits/year for a qualifying key — explicit row fields first, then the
// engine's result-stats block (same precedence the public page uses for its
// per-application price cards).
function resultStatsRows(estData) {
  return estData?.result?.results || estData?.results || {};
}

function selectedStatsRow(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows.find((t) => t?.selected || t?.isSelected)
    || rows.find((t) => t?.recommended || t?.isRecommended)
    || rows[0];
}

function estimateVisitsFor(estData, key) {
  for (const c of recurringCandidates(estData)) {
    if (toQualifyingKey(candidateName(c)) !== key) continue;
    const explicit = Number(c?.visitsPerYear ?? c?.visits ?? c?.apps ?? c?.frequency);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
  }
  const stats = resultStatsRows(estData);
  if (key === 'pest_control') return Number(stats.pest?.apps) > 0 ? Number(stats.pest.apps) : null;
  if (key === 'lawn_care') {
    const sel = (Array.isArray(stats.lawn) && (stats.lawn.find((t) => t.recommended) || stats.lawn[0])) || null;
    return Number(sel?.v) > 0 ? Number(sel.v) : null;
  }
  if (key === 'mosquito') {
    const sel = selectedStatsRow(stats.mq);
    return Number(sel?.v) > 0 ? Number(sel.v) : null;
  }
  if (key === 'tree_shrub') {
    const sel = selectedStatsRow(stats.ts);
    return Number(sel?.v) > 0 ? Number(sel.v) : null;
  }
  if (key === 'termite_bait') return 4;
  return null;
}

// Pre-discount per-application price for a qualifying key — explicit per-app
// row fields first, else monthly*12/visits. Used to express the new-service
// member savings as a per-application dollar figure.
function estimatePerApplicationFor(estData, key) {
  for (const c of recurringCandidates(estData)) {
    if (toQualifyingKey(candidateName(c)) !== key) continue;
    const explicit = Number(c?.perTreatment ?? c?.perApp ?? c?.perVisit ?? c?.pa);
    if (Number.isFinite(explicit) && explicit > 0) return round2(explicit);
  }
  const monthly = estimateMonthlyFor(estData, key);
  const visits = estimateVisitsFor(estData, key);
  if (monthly > 0 && visits > 0) return round2((monthly * 12) / visits);
  return null;
}

// One-time membership/setup line items must not count toward the per-visit
// basis — the FIRST standard accept invoice can carry the $99 WaveGuard setup
// AND the first application on the same service-linked invoice, and reading
// its raw total would inflate the advertised per-visit savings.
function isSetupLineItem(line = {}) {
  return /waveguard|membership|setup fee/i.test(String(line.description || ''));
}

function invoiceLineItems(row = {}) {
  const raw = row.line_items;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  return [];
}

function lineItemAmount(line = {}) {
  const explicit = Number(line.amount);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const qty = Number(line.quantity) || 1;
  const unit = Number(line.unit_price);
  return Number.isFinite(unit) && unit > 0 ? unit * qty : 0;
}

// What the invoice charged for the SERVICE itself: the sum of its
// non-setup lines, falling back to the invoice total when there are no
// parseable line items.
function invoiceServiceAmount(row = {}) {
  const lines = invoiceLineItems(row);
  if (lines.length) {
    const serviceTotal = lines
      .filter((line) => !isSetupLineItem(line))
      .reduce((sum, line) => sum + lineItemAmount(line), 0);
    if (serviceTotal > 0) return round2(serviceTotal);
    // All lines were setup/membership — not a per-visit price.
    return null;
  }
  const total = Number(row.total);
  return Number.isFinite(total) && total > 0 ? round2(total) : null;
}

// What the customer actually LAST PAID per visit, by qualifying key — most
// recent paid invoice whose service_type maps to the key. Visit invoices
// minted from the schedule carry service_type; standalone setup/prepay
// invoices don't, so they never pollute this. Falls back to {} on any error
// so the snapshot still renders from scheduled_services.estimated_price.
async function loadLastPaidAmountsByKey(database, customerId) {
  const amounts = {};
  try {
    const rows = await database('invoices')
      .where({ customer_id: customerId, status: 'paid' })
      .whereNotNull('service_type')
      .orderBy('paid_at', 'desc')
      .limit(100)
      .select('service_type', 'total', 'line_items', 'paid_at');
    for (const row of rows) {
      const key = toQualifyingKey(row.service_type);
      if (!key || amounts[key] != null) continue;
      const amount = invoiceServiceAmount(row);
      if (amount != null) amounts[key] = amount;
    }
  } catch (err) {
    logger.warn(`[membership-context] last-paid lookup skipped for customer ${customerId}: ${err.message}`);
  }
  return amounts;
}

// The discount rate ACTUALLY applied to the estimate's recurring services,
// derived from the repriced aggregate (annualBeforeDiscount/After). For
// pest_control / tree_shrub the pricing engine's margin guard can cap the tier
// rate, so this can be lower than combinedTier.discount — using it keeps the
// card from advertising a larger member discount than the total includes.
// Falls back to the requested rate when the aggregate isn't available.
function appliedRecurringRate(estData, fallbackRate) {
  const rec = estData?.result?.recurring
    || estData?.engineResult?.recurring
    || estData?.recurring
    || {};
  const before = Number(rec.annualBeforeDiscount);
  const after = Number(rec.annualAfterDiscount);
  if (before > 0 && after >= 0 && after <= before) {
    return Math.max(0, Math.min(1, 1 - after / before));
  }
  const explicit = Number(rec.discount);
  if (explicit >= 0 && explicit <= 1) return explicit;
  return fallbackRate;
}

async function computeMembershipContext(database, { customerId, estData } = {}) {
  try {
    if (!customerId) return null;

    const customer = await database('customers').where({ id: customerId }).first();
    if (!customer || customer.active === false) return null;

    // ── Existing active recurring services on the account ──────
    // Shared loader — same source admin-estimate-persistence.js uses to reprice
    // the estimate, so the displayed tier matches the charged tier.
    const existingRows = await loadExistingRecurringQualifyingRows(database, customerId);

    const existingByKey = new Map();
    for (const row of existingRows) {
      const key = toQualifyingKey(row.service_type);
      if (!key) continue;
      if (!existingByKey.has(key)) existingByKey.set(key, []);
      existingByKey.get(key).push(row);
    }
    const existingKeys = [...existingByKey.keys()];

    // ── New qualifying services in this estimate ───────────────
    const newKeys = estimateQualifyingKeys(estData || {});
    const addedKeys = newKeys.filter((k) => !existingKeys.includes(k));

    // No membership story to tell if there are no qualifying services on
    // either side (e.g. a one-off rodent job for an existing customer).
    if (existingKeys.length === 0 && addedKeys.length === 0) return null;

    // ── Combine & recompute tier ───────────────────────────────
    const oldTier = determineWaveGuardTier(existingKeys);
    const combinedTier = determineWaveGuardTier([...existingKeys, ...addedKeys]);
    const upgraded = combinedTier.discount > oldTier.discount;
    const delta = combinedTier.discount - oldTier.discount;
    const deltaPct = Math.round(delta * 100);

    // ── Active prepaid term (drives prepaid-aware copy) ────────
    // Only a genuinely active term counts as prepaid. 'payment_pending' means
    // the customer selected annual prepay but hasn't paid yet, so it must not
    // render "remaining prepaid" savings (mirrors ACTIVE_STATUSES in
    // annual-prepay-renewals.js).
    let prepaidTerm = null;
    try {
      prepaidTerm = await database('annual_prepay_terms')
        .where({ customer_id: customerId })
        .whereIn('status', ['active', 'renewal_pending'])
        .andWhere('term_end', '>=', database.fn.now())
        .orderBy('term_end', 'desc')
        .first();
    } catch { prepaidTerm = null; }

    // Compare against today's date in the business timezone (ET). Using a UTC
    // ISO date would roll over after ~8pm ET and treat a visit still scheduled
    // for today as past, undercounting remaining per-visit savings.
    const today = etDateString();
    const isFuture = (d) => {
      if (!d) return false;
      const iso = typeof d === 'string'
        ? d.slice(0, 10)
        : (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);
      return iso >= today;
    };

    // ── Existing-service per-application savings from the tier delta ──
    // Only meaningful when the new service upgrades the tier. The per-visit
    // basis is what the customer actually LAST PAID for that service (most
    // recent paid visit invoice), falling back to the scheduled
    // estimated_price when there's no paid history yet.
    const lastPaidByKey = upgraded ? await loadLastPaidAmountsByKey(database, customerId) : {};
    const existingServices = [];
    if (upgraded) {
      for (const key of existingKeys) {
        const rows = existingByKey.get(key) || [];
        const priced = rows.find((r) => Number(r.estimated_price) > 0);
        const perVisitPrice = lastPaidByKey[key]
          ?? (priced ? round2(priced.estimated_price) : null);
        const perVisitSavings = perVisitPrice ? round2(perVisitPrice * delta) : null;
        const remainingVisits = rows.filter((r) => isFuture(r.scheduled_date)).length;
        existingServices.push({
          key,
          label: SERVICE_LABEL[key] || key,
          extraDiscountPct: deltaPct,
          perVisitSavings,
          remainingVisits,
          totalRemainingSavings: (perVisitSavings && remainingVisits)
            ? round2(perVisitSavings * remainingVisits)
            : null,
          prepaid: !!prepaidTerm,
        });
      }
    }

    // ── New-service member discount ────────────────────────────
    // Use the rate actually applied to the recurring total (margin-guard caps
    // included), never more than the combined tier rate, so the advertised
    // discount can't exceed what the charged total includes.
    const appliedRate = Math.min(combinedTier.discount, appliedRecurringRate(estData, combinedTier.discount));
    const newServices = addedKeys.map((key) => {
      const monthly = estimateMonthlyFor(estData, key);
      const perApplication = estimatePerApplicationFor(estData, key);
      return {
        key,
        label: SERVICE_LABEL[key] || key,
        discountPct: Math.round(appliedRate * 100),
        monthlySavings: monthly ? round2(monthly * appliedRate) : null,
        perApplicationSavings: perApplication ? round2(perApplication * appliedRate) : null,
      };
    });

    return {
      isExistingCustomer: true,
      firstName: customer.first_name || null,
      tier: combinedTier.tier,
      tierLabel: TIER_LABEL[combinedTier.tier] || 'Bronze',
      tierDiscountPct: Math.round(combinedTier.discount * 100),
      upgrade: upgraded
        ? {
            fromLabel: TIER_LABEL[oldTier.tier] || 'Bronze',
            toLabel: TIER_LABEL[combinedTier.tier] || 'Bronze',
            deltaPct,
            addedServiceLabels: addedKeys.map((k) => SERVICE_LABEL[k] || k),
          }
        : null,
      // Raw qualifying keys already on the account — lets the public page
      // pick a cross-sell the customer doesn't already have (existingServices
      // above is only populated on a tier upgrade).
      existingServiceKeys: existingKeys,
      existingServices,
      newServices,
    };
  } catch (err) {
    logger.warn(`[membership-context] compute skipped for customer ${customerId}: ${err.message}`);
    return null;
  }
}

// View-time accessor. Returns the membership snapshot that was frozen onto the
// estimate at save time (estimate_data.membershipSnapshot), so the card can
// NEVER diverge from the price saved/charged with the estimate. Estimates
// created before this snapshot existed (or that aren't customer-linked) simply
// have no snapshot and render no card — no risk of advertising an unapplied
// discount.
function buildEstimateMembershipContext(estimate) {
  try {
    const estData = parseEstimateData(estimate);
    const snapshot = estData && estData.membershipSnapshot;
    return snapshot && snapshot.isExistingCustomer ? snapshot : null;
  } catch {
    return null;
  }
}

module.exports = { buildEstimateMembershipContext, computeMembershipContext };
