// Per-family plan-rate ledger (owner ruling 2026-08-06 — the "real fix"
// follow-up to #3241).
//
// customers.monthly_rate is a single scalar, so a multi-plan customer's
// same-family re-quote replaced the WHOLE rate with the new quote's slice
// (Pest $40 + Lawn $50 member re-quotes Lawn to $60 → rate $60, Pest
// portion silently stops billing). customer_plan_rates stores each plan
// family's monthly slice; the scalar STAYS the billed/read figure and is
// recomputed as the SUM of components, so every existing reader (billing
// cron chargeMonthly, MRR, membership predicates, UI) is untouched.
//
// Rollout contract:
// - Dual-write is ALWAYS on (fail-soft, savepoint-confined by callers):
//   accepts record their family slices so data accumulates before the flip,
//   and blind scalar writers (admin rate edit, offboarding) reset/clear the
//   ledger so a stale attribution can never outlive the scalar it described.
// - The BEHAVIOR (scalar = ledger sum, partial replacement on re-quotes) is
//   dark behind GATE_PLAN_RATE_LEDGER. Gate off, the accept scalar follows
//   the legacy #3241 semantics byte-for-byte and the ledger is advisory —
//   the Σ(components) == scalar invariant is only enforced from the flip
//   (plus the ops backfill) onward.
// - 'unattributed' is the sentinel family for legacy amounts that predate
//   the ledger and cannot be split. It participates in the sum like any
//   component; a same-family re-quote can never split it, which is exactly
//   the pre-ledger limitation degrading gracefully (and the review
//   notification tells the owner when that happened on a multi-plan
//   customer).

const { isEnabled } = require('../config/feature-gates');
const logger = require('./logger');

const UNATTRIBUTED = 'unattributed';

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function planRateLedgerEnabled() {
  return isEnabled('planRateLedger');
}

async function ledgerTableExists(database) {
  try {
    return await database.schema.hasTable('customer_plan_rates');
  } catch {
    return false;
  }
}

// Per-family monthly slices for an accepted estimate. Line preference is
// post-discount-first (manualFinalAnnual/12 → annualAfterDiscount/12 →
// monthly/mo), then every slice is PROPORTIONALLY normalized so the slices
// sum EXACTLY to the billed monthly (summary-level effects — manual
// discounts, floors, rounding — land pro-rata; the remainder cent goes to
// the largest slice). Unclassifiable lines pool under 'unattributed' so the
// sum never silently drops a line.
function estimateFamilySlices({ estimateData = {}, monthlyRate = 0 } = {}) {
  const billedMonthly = roundMoney(monthlyRate);
  if (!(billedMonthly > 0)) return {};
  // Lazy requires — estimate-public/estimate-converter require this module
  // (or each other) inline only; function-scope requires cannot cycle.
  const { serviceFamilyKeyForAdoption } = require('../routes/estimate-public');
  const {
    recurringServicesFromEstimateData,
    supplementalCompanionLines,
  } = require('./estimate-converter');
  const raw = {};
  const addLine = (line) => {
    const family = serviceFamilyKeyForAdoption(line) || UNATTRIBUTED;
    const manualFinal = Number(line?.manualFinalAnnual);
    const annualAfter = Number(line?.annualAfterDiscount);
    const monthly = Number.isFinite(manualFinal) && manualFinal >= 0
      ? manualFinal / 12
      : (Number.isFinite(annualAfter) && annualAfter >= 0
        ? annualAfter / 12
        : Number(line?.monthly ?? line?.mo));
    if (!Number.isFinite(monthly) || monthly <= 0) return null;
    raw[family] = (raw[family] || 0) + monthly;
    return family;
  };
  const recurringFamilies = new Set();
  for (const line of recurringServicesFromEstimateData(estimateData)) {
    const family = addLine(line);
    if (family) recurringFamilies.add(family);
  }
  // Supplemental companions dedupe by FAMILY against the recurring rows
  // (codex #3245 r1, mirroring combineRecurringServicesForScheduling's
  // companion resolution): legacy payloads can carry rodent bait BOTH as a
  // recurring line and as the rodentBaitMo scalar — counting it twice
  // distorts every proportionally-normalized sibling slice even though the
  // total still reconciles.
  for (const line of supplementalCompanionLines(estimateData)) {
    const family = serviceFamilyKeyForAdoption(line) || UNATTRIBUTED;
    if (recurringFamilies.has(family)) continue;
    addLine(line);
  }
  const families = Object.keys(raw);
  if (!families.length) return { [UNATTRIBUTED]: billedMonthly };
  const rawTotal = families.reduce((sum, f) => sum + raw[f], 0);
  if (!(rawTotal > 0)) return { [UNATTRIBUTED]: billedMonthly };
  const slices = {};
  for (const f of families) {
    slices[f] = roundMoney((raw[f] / rawTotal) * billedMonthly);
  }
  // Cent-exact: push the rounding residue onto the largest slice.
  const sliceTotal = roundMoney(Object.values(slices).reduce((s, v) => s + v, 0));
  const residue = roundMoney(billedMonthly - sliceTotal);
  if (residue !== 0) {
    const largest = families.reduce((a, b) => (slices[a] >= slices[b] ? a : b));
    slices[largest] = roundMoney(slices[largest] + residue);
  }
  return slices;
}

async function loadComponents(database, customerId) {
  if (!(await ledgerTableExists(database))) return [];
  return database('customer_plan_rates')
    .where({ customer_id: customerId })
    .select('family_key', 'monthly_rate');
}

async function upsertComponent(database, {
  customerId, familyKey, monthlyRate, estimateId = null, source = 'estimate_accept',
}) {
  await database('customer_plan_rates')
    .insert({
      customer_id: customerId,
      family_key: familyKey,
      monthly_rate: roundMoney(monthlyRate),
      source_estimate_id: estimateId,
      source,
      effective_at: new Date(),
      updated_at: new Date(),
    })
    .onConflict(['customer_id', 'family_key'])
    .merge({
      monthly_rate: roundMoney(monthlyRate),
      source_estimate_id: estimateId,
      source,
      effective_at: new Date(),
      updated_at: new Date(),
    });
}

// Apply an accepted estimate's family slices to the ledger and decide the
// customer's new scalar.
//
// Returns { scalar, components, reviewNeeded }:
// - scalar: the ledger-derived customers.monthly_rate (null means "keep the
//   caller's legacy scalar" — only when the ledger could not take
//   authority, which the caller treats as fall-through).
// - reviewNeeded: a legacy multi-plan customer's re-quote landed on the
//   un-splittable path — the owner should eyeball the rate (the pre-ledger
//   hand-fix case, now surfaced instead of silent).
//
// Cases (previousScalar = customer's rate before this accept; addOnBase =
// the #3241 disjoint-add-on base, 0 for same-family/doubt):
// 1. Ledger already seeded → upsert the accepted families' slices, keep
//    every other component, scalar = Σ components. THE FIX: a Lawn re-quote
//    touches only the lawn component.
// 2. Empty ledger + disjoint add-on → previous scalar parks as
//    'unattributed' beside the new slices; scalar = previous + new (same
//    outcome #3241 ships today, now attributed).
// 3. Empty ledger + same-family/doubt with a prior rate → the prior scalar
//    cannot be split; seed the ledger from this accept's slices and keep
//    the legacy replace scalar (Σ components == that scalar, consistent).
//    reviewNeeded=true when the customer shows OTHER live plan families
//    (the hand-fix case).
// 4. Empty ledger + no prior rate (new/re-signup) → components = slices,
//    scalar = Σ.
async function applyAcceptToLedger(database, {
  customerId, estimateId, slices = {}, previousScalar = 0, addOnBase = 0,
  hadOtherLiveFamilies = false,
} = {}) {
  const sliceFamilies = Object.keys(slices).filter((f) => roundMoney(slices[f]) > 0);
  if (!sliceFamilies.length) return { scalar: null, components: null, reviewNeeded: false };
  if (!(await ledgerTableExists(database))) {
    return { scalar: null, components: null, reviewNeeded: false };
  }
  const existing = await database('customer_plan_rates')
    .where({ customer_id: customerId })
    .select('family_key', 'monthly_rate');
  const components = new Map(existing.map((row) => [row.family_key, roundMoney(row.monthly_rate)]));
  const prior = roundMoney(previousScalar);
  let reviewNeeded = false;
  // An 'unattributed' component is a QUARANTINED blob, not a seeded ledger
  // (codex #3245 r1): it may CONTAIN the very family this accept re-prices
  // (backfill-parked multi-plan customers, admin resets). It is only safe
  // to keep it parked when this accept is proven NOT to touch its contents:
  // - a proven-disjoint add-on (addOnBase > 0 — the #3241 row evidence says
  //   none of the customer's live plans share the estimate's families), or
  // - a re-quote whose families are ALL already attributed components (the
  //   blob describes the customer's plans as of its parking; a family that
  //   was split out afterward is no longer inside it).
  // Anything else deletes the blob (legacy replace semantics — exactly what
  // the scalar did pre-ledger) and raises the review alert so the owner
  // re-verifies the total once.
  const attributedFamilies = new Set([...components.keys()].filter((f) => f !== UNATTRIBUTED));
  const unattributedAmount = components.get(UNATTRIBUTED) || 0;
  if (unattributedAmount > 0 && !(addOnBase > 0)
    && !sliceFamilies.every((f) => attributedFamilies.has(f))) {
    components.delete(UNATTRIBUTED);
    await database('customer_plan_rates')
      .where({ customer_id: customerId, family_key: UNATTRIBUTED })
      .del();
    reviewNeeded = true;
  }
  if (attributedFamilies.size === 0 && unattributedAmount === 0) {
    if (addOnBase > 0 && prior > 0) {
      // Case 2 — park the pre-ledger amount so the sum equals old + new.
      components.set(UNATTRIBUTED, prior);
      await upsertComponent(database, {
        customerId, familyKey: UNATTRIBUTED, monthlyRate: prior, estimateId: null, source: 'legacy_scalar',
      });
    } else if (prior > 0) {
      // Case 3 — un-splittable legacy scalar being replaced.
      reviewNeeded = hadOtherLiveFamilies === true;
    }
  }
  for (const family of sliceFamilies) {
    const amount = roundMoney(slices[family]);
    components.set(family, amount);
    await upsertComponent(database, {
      customerId, familyKey: family, monthlyRate: amount, estimateId, source: 'estimate_accept',
    });
  }
  const scalar = roundMoney([...components.values()].reduce((sum, v) => sum + v, 0));
  return { scalar, components: Object.fromEntries(components), reviewNeeded };
}

// Blind scalar writes (admin rate edit, plan-sync backfills) invalidate any
// finer attribution — reset to a single unattributed component matching the
// scalar, or clear entirely when the rate is cleared/zeroed.
async function resetLedgerToScalar(database, customerId, rate, { source = 'scalar_write' } = {}) {
  if (!(await ledgerTableExists(database))) return;
  await database('customer_plan_rates').where({ customer_id: customerId }).del();
  const amount = roundMoney(rate);
  if (amount > 0) {
    await database('customer_plan_rates').insert({
      customer_id: customerId,
      family_key: UNATTRIBUTED,
      monthly_rate: amount,
      source,
      effective_at: new Date(),
      updated_at: new Date(),
    });
  }
}

async function clearLedger(database, customerId, { source = 'offboarding' } = {}) {
  if (!(await ledgerTableExists(database))) return;
  await database('customer_plan_rates').where({ customer_id: customerId }).del();
  logger.info(`[plan-rate-ledger] cleared components for customer ${customerId} (${source})`);
}

module.exports = {
  UNATTRIBUTED,
  planRateLedgerEnabled,
  estimateFamilySlices,
  loadComponents,
  applyAcceptToLedger,
  resetLedgerToScalar,
  clearLedger,
};
