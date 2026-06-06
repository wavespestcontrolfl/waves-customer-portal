// ============================================================
// estimate-membership-context.js
//
// Builds the customer-facing "WaveGuard membership" context for an estimate
// that is linked to an existing, active customer (estimates.customer_id set).
//
// This is a DISPLAY / transparency layer only — it does not change the price
// the customer is charged. It computes:
//   1. The combined WaveGuard tier — the customer's existing qualifying
//      recurring services PLUS the new service(s) in this estimate
//      ("combine & recompute" per product decision).
//   2. The tier-upgrade callout (e.g. Silver -> Gold) when adding the new
//      service bumps them into a higher tier.
//   3. The per-application discount on their EXISTING recurring services that
//      results from a tier upgrade — expressed per remaining visit, so a
//      customer who prepaid the year sees the going-forward benefit rather
//      than a retroactive re-price.
//   4. The member discount on the NEW service in this estimate.
//
// Returns null for leads (no customer_id), inactive customers, or on ANY error
// so the public estimate endpoints never break on this (CLAUDE.md rule 6).
// ============================================================

const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');
const { WAVEGUARD } = require('./pricing-engine/constants');
const { determineWaveGuardTier } = require('./pricing-engine/discount-engine');

const TIER_LABEL = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold', platinum: 'Platinum' };
const SERVICE_LABEL = {
  pest_control: 'Pest Control',
  lawn_care: 'Lawn Care',
  tree_shrub: 'Tree & Shrub',
  mosquito: 'Mosquito',
  termite_bait: 'Termite Bait',
};
// Statuses that mean a scheduled visit is no longer live coverage.
const TERMINAL_STATUSES = ['cancelled', 'completed', 'no_show', 'skipped'];

// Map a free-text service name (scheduled_services.service_type or an estimate
// line label) to a WaveGuard qualifying service key. Scoped to the five
// qualifiers — palm_injection and rodent_bait are explicitly NOT qualifiers.
function toQualifyingKey(raw) {
  const s = String(raw || '').toLowerCase();
  if (!s) return null;
  if (s.includes('rodent') || s.includes('palm')) return null;
  // One-time treatments (e.g. one_time_pest) never receive the WaveGuard tier
  // discount and must not count toward the tier.
  if (/one[\s_-]?time|onetime/.test(s)) return null;
  if (s.includes('pest')) return 'pest_control';
  if (s.includes('lawn') || s.includes('turf')) return 'lawn_care';
  if (s.includes('tree') || s.includes('shrub') || s.includes('ornamental')) return 'tree_shrub';
  if (s.includes('mosquito')) return 'mosquito';
  if (s.includes('termite') && s.includes('bait')) return 'termite_bait';
  return null;
}

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

async function buildEstimateMembershipContext(estimate) {
  try {
    if (!estimate || !estimate.customer_id) return null;

    const customer = await db('customers').where({ id: estimate.customer_id }).first();
    if (!customer || customer.active === false) return null;

    // ── Existing active recurring services on the account ──────
    const existingRows = await db('scheduled_services')
      .where({ customer_id: customer.id })
      .whereNotIn('status', TERMINAL_STATUSES)
      .select('id', 'service_type', 'estimated_price', 'annual_prepay_term_id', 'scheduled_date');

    const existingByKey = new Map();
    for (const row of existingRows) {
      const key = toQualifyingKey(row.service_type);
      if (!key) continue;
      if (!existingByKey.has(key)) existingByKey.set(key, []);
      existingByKey.get(key).push(row);
    }
    const existingKeys = [...existingByKey.keys()];

    // ── New qualifying services in this estimate ───────────────
    const estData = parseEstimateData(estimate);
    const newKeys = estimateQualifyingKeys(estData);
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
    let prepaidTerm = null;
    try {
      prepaidTerm = await db('annual_prepay_terms')
        .where({ customer_id: customer.id })
        .whereNotIn('status', ['cancelled', 'lapsed', 'refunded'])
        .andWhere('term_end', '>=', db.fn.now())
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
    // Only meaningful when the new service upgrades the tier.
    const existingServices = [];
    if (upgraded) {
      for (const key of existingKeys) {
        const rows = existingByKey.get(key) || [];
        const priced = rows.find((r) => Number(r.estimated_price) > 0);
        const perVisitPrice = priced ? round2(priced.estimated_price) : null;
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
    const newServices = addedKeys.map((key) => {
      const monthly = estimateMonthlyFor(estData, key);
      return {
        key,
        label: SERVICE_LABEL[key] || key,
        discountPct: Math.round(combinedTier.discount * 100),
        monthlySavings: monthly ? round2(monthly * combinedTier.discount) : null,
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
      existingServices,
      newServices,
    };
  } catch (err) {
    logger.warn(`[membership-context] skipped for estimate ${estimate?.id}: ${err.message}`);
    return null;
  }
}

module.exports = { buildEstimateMembershipContext };
