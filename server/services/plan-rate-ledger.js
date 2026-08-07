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

const crypto = require('crypto');
const { isEnabled } = require('../config/feature-gates');
const logger = require('./logger');

const UNATTRIBUTED = 'unattributed';

// The classifier deliberately preserves unknown service names as unbounded
// slugs, but family_key is varchar(64) (codex #3245 r6) — an oversized key
// would fail the authoritative upsert AFTER the ledger was cleared and
// reintroduce whole-scalar replacement. Bound every key deterministically:
// short keys pass through untouched; long ones become a stable
// prefix + hash so the same service always maps to the same component and
// prefix-based grouping (termite riders) keeps working.
function boundedFamilyKey(family) {
  const key = String(family || '');
  if (key.length <= 64) return key;
  const digest = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  return `${key.slice(0, 47)}_${digest}`;
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function planRateLedgerEnabled() {
  return isEnabled('planRateLedger');
}

async function ledgerTableExists(database) {
  try {
    return await database.schema.hasTable('customer_plan_rates');
  } catch (probeErr) {
    // A transient probe FAILURE is not an absent table (codex #3245 r5):
    // while the ledger has scalar authority, swallowing it would return
    // the "no ledger" null path and commit a legacy scalar WITHOUT the
    // stale-component invalidation the converter's error path performs.
    // Authoritative → propagate (the caller's fail-closed machinery runs);
    // advisory → absent-equivalent is safe (nothing reads components).
    if (planRateLedgerEnabled()) throw probeErr;
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
// The canonical recurring billing lines of an accepted estimate — the SAME
// list the acceptance path prices from (recurringServicesWithSupplements:
// rows + engine lineItems + rodent/palm supplement reconstruction across
// every container shape, deduped by recurringServiceKey). Shared by the
// slicer AND the add-on classifier so they can never disagree.
function acceptedRecurringBillingLines(estimateData = {}) {
  const { recurringServicesWithSupplements } = require('../routes/estimate-public');
  const root = estimateData?.result && typeof estimateData.result === 'object'
    ? estimateData.result
    : (estimateData?.engineResult && typeof estimateData.engineResult === 'object'
      ? estimateData.engineResult
      : estimateData);
  return recurringServicesWithSupplements(root);
}

function estimateFamilySlices({ estimateData = {}, monthlyRate = 0 } = {}) {
  const billedMonthly = roundMoney(monthlyRate);
  // Lazy requires — estimate-public/estimate-converter require this module
  // (or each other) inline only; function-scope requires cannot cycle.
  const { serviceFamilyKeyForAdoption } = require('../routes/estimate-public');
  const { visitsPerYearForRecurringService } = require('./estimate-converter');
  const raw = {};
  // A family whose accepted price is EXPLICITLY zero (a comped line —
  // manualFinalAnnual/annualAfterDiscount stamped 0) must still appear in
  // the slices at 0 so applyAcceptToLedger replaces/deletes its existing
  // component (codex #3245 r2: a bundle comping Pest while keeping Lawn
  // must stop billing the Pest slice). Lines with NO price provenance at
  // all stay skipped — absence is not a zero.
  const zeroFamilies = new Set();
  // Same price-field ladder the converter's recurring resolution admits
  // (codex #3245 r5 — raw engine lineItems carry `annual` with no monthly
  // or annualAfterDiscount; rejecting them collapsed a classifiable
  // multi-family accept into one unattributed blob): post-discount stamps
  // first, then monthly, then the plain annual forms.
  // null/''/undefined are PLACEHOLDERS, never zeros (codex #3245 r15 —
  // the same coercion class as the r3 oneTimeAmount guard): Number(null)
  // is 0, which would read `manualFinalAnnual: null` as an explicit comp
  // and delete a family whose real price sits one field later.
  const priceValue = (value) => {
    if (value == null || value === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
  };
  // Every recurring price field the converter's own dollar-field inventory
  // recognizes (codex #3245 r16 — RECURRING_DOLLAR_FIELDS in
  // estimate-converter), post-discount forms first within each shape.
  const lineMonthly = (line) => {
    for (const value of [line?.manualFinalAnnual, line?.annualAfterDiscount, line?.annualAfterCredits]) {
      const annual = priceValue(value);
      if (annual != null) return annual / 12;
    }
    for (const value of [line?.monthlyAfterDiscount, line?.monthlyAfterCredits, line?.monthly, line?.mo,
      line?.monthlyTotal, line?.monthly_total, line?.monthlyBase]) {
      const monthly = priceValue(value);
      if (monthly != null) return monthly;
    }
    for (const value of [line?.annual, line?.ann, line?.annualTotal, line?.annual_total]) {
      const annual = priceValue(value);
      if (annual != null) return annual / 12;
    }
    // Per-application-only rows (codex #3245 r17/r18 — RECURRING_DOLLAR_
    // FIELDS admits them): annualize through the SHARED cadence resolver
    // (visitsPerYearForRecurringService — visitsPerYear/appsPerYear/visits/
    // apps/treatmentsPerYear). No classifiable visit count means no
    // derivable monthly — the row stays unpriced rather than inventing one.
    const visits = visitsPerYearForRecurringService(line || {});
    if (visits != null && visits > 0) {
      for (const value of [line?.perTreatment, line?.perVisit, line?.perApp, line?.pa, line?.price]) {
        const perApplication = priceValue(value);
        if (perApplication != null) return (perApplication * visits) / 12;
      }
    }
    return null;
  };
  const addLine = (line) => {
    const family = boundedFamilyKey(serviceFamilyKeyForAdoption(line) || UNATTRIBUTED);
    const monthly = lineMonthly(line);
    if (monthly == null || monthly < 0) return null;
    if (monthly === 0) {
      if (family !== UNATTRIBUTED) zeroFamilies.add(family);
      return null;
    }
    raw[family] = (raw[family] || 0) + monthly;
    return family;
  };
  // ONE line source (codex #3245 r18, ending the parallel-parser drift the
  // reviews kept finding one shape at a time): the acceptance path's own
  // recurringServicesWithSupplements — recurring rows, engine lineItems,
  // rodent AND palm supplement reconstruction, all container shapes,
  // deduped by recurringServiceKey. The same list feeds the add-on
  // classifier, so slicing and classification can never disagree about
  // which services an accept carries.
  for (const line of acceptedRecurringBillingLines(estimateData)) {
    addLine(line);
  }
  const families = Object.keys(raw);
  const withZeroFamilies = (slices) => {
    for (const family of zeroFamilies) {
      if (slices[family] === undefined) slices[family] = 0;
    }
    return slices;
  };
  // A ZERO billed monthly is a real accepted outcome, not an absence
  // (local codex P0 on #3245): a fully comped re-quote must emit ZERO
  // slices for every classifiable family it carries — priced or comped —
  // so applyAcceptToLedger deletes their components instead of leaving
  // them to be summed back into a later bill.
  if (!(billedMonthly > 0)) {
    const zeroed = {};
    for (const family of [...families, ...zeroFamilies]) {
      if (family !== UNATTRIBUTED) zeroed[family] = 0;
    }
    return zeroed;
  }
  if (!families.length) return withZeroFamilies({ [UNATTRIBUTED]: billedMonthly });
  const rawTotal = families.reduce((sum, f) => sum + raw[f], 0);
  if (!(rawTotal > 0)) return withZeroFamilies({ [UNATTRIBUTED]: billedMonthly });
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
  return withZeroFamilies(slices);
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
  hadOtherLiveFamilies = false, customerIsLive = true,
} = {}) {
  // Zero-valued slices are accepted families whose price was explicitly
  // comped — they participate as DELETES so the prior component stops
  // billing (codex #3245 r2). Families with no entry at all are untouched.
  const sliceFamilies = Object.keys(slices)
    .filter((f) => Number.isFinite(Number(slices[f])) && Number(slices[f]) >= 0);
  const positiveFamilies = sliceFamilies.filter((f) => roundMoney(slices[f]) > 0);
  const zeroSliceFamilies = sliceFamilies.filter((f) => roundMoney(slices[f]) === 0);
  if (!sliceFamilies.length) return { scalar: null, components: null, reviewNeeded: false };
  if (!(await ledgerTableExists(database))) {
    return { scalar: null, components: null, reviewNeeded: false };
  }
  // A churned/dormant customer's components describe CANCELLED coverage
  // (cancellation deliberately retains monthly_rate for churn analytics and
  // never clears the ledger — codex #3245 r5): on re-signup the legacy
  // replace path discarded that history, so the ledger must too. Wipe and
  // start empty; the accept's own slices become the fresh attribution.
  if (!customerIsLive) {
    await database('customer_plan_rates').where({ customer_id: customerId }).del();
  }
  const existing = customerIsLive
    ? await database('customer_plan_rates')
      .where({ customer_id: customerId })
      .select('family_key', 'monthly_rate')
    : [];
  const components = new Map(existing.map((row) => [row.family_key, roundMoney(row.monthly_rate)]));
  const prior = roundMoney(previousScalar);
  let reviewNeeded = false;
  // An accept whose OWN slices contain unattributed money is ambiguous
  // when classification could not prove a disjoint add-on (local codex P0
  // on #3245): the unclassifiable portion may BE a re-price of any
  // existing component, so stacking it on top of them ($40 Pest + $50 Lawn
  // + unclassifiable $60 = $150) overstates the bill. Fail closed to the
  // legacy replace semantics — wipe the existing components, apply this
  // accept's slices alone, and flag review.
  const incomingUnattributed = sliceFamilies.includes(UNATTRIBUTED)
    && roundMoney(slices[UNATTRIBUTED]) > 0;
  if (incomingUnattributed && !(addOnBase > 0) && components.size > 0) {
    components.clear();
    await database('customer_plan_rates').where({ customer_id: customerId }).del();
    reviewNeeded = true;
  }
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
      // Case 3 — un-splittable legacy scalar being replaced. OR-accumulate:
      // an earlier fail-closed wipe already demands review regardless of
      // the live-family evidence.
      reviewNeeded = reviewNeeded || hadOtherLiveFamilies === true;
    }
  }
  for (const family of positiveFamilies) {
    // A PARKED legacy blob that survived quarantine (proven-disjoint
    // add-on) and an accepted UNCLASSIFIABLE slice share the same key —
    // merge, never replace (codex #3245 r7): overwriting the parked $90
    // with a $10 slice would drop $90 from the ledger-derived bill.
    // (Cross-property same-family collisions cannot reach here: grouped
    // estimate accepts bypass this function entirely — codex r12 — and
    // ungrouped classification treats same-family as replace.)
    const parked = family === UNATTRIBUTED ? (components.get(UNATTRIBUTED) || 0) : 0;
    const amount = roundMoney(parked + roundMoney(slices[family]));
    components.set(family, amount);
    await upsertComponent(database, {
      customerId, familyKey: family, monthlyRate: amount, estimateId, source: 'estimate_accept',
    });
  }
  for (const family of zeroSliceFamilies) {
    if (components.has(family)) {
      components.delete(family);
      await database('customer_plan_rates')
        .where({ customer_id: customerId, family_key: family })
        .del();
    }
  }
  // Termite rider variants are mutually exclusive WITHIN their variant
  // group only (codex #3245 r4 + r7): bond terms supersede bond terms
  // (termite_bond_1yr → termite_bond_5yr) and station arrangements
  // supersede station arrangements (rental → purchased), but a bait-only
  // re-quote must NOT delete an independent active bond — a bond rides an
  // accepted quote only when that quote includes it. Superseded variants
  // are flagged for review.
  const termiteVariantGroup = (family) => {
    const key = String(family);
    if (!key.startsWith('termite')) return null;
    // Bond TERMS supersede each other but nothing else — a bond is
    // independent coverage that rides an accepted quote only when the
    // quote includes it (codex r7).
    if (key.startsWith('termite_bond')) return 'termite_bond';
    // Station arrangements (rental vs purchased) are variants OF the bait
    // program — a new bait plan supersedes them (codex r4).
    if (key.includes('station') || key.includes('rental') || key === 'termite_bait') {
      return 'termite_bait_program';
    }
    return key; // other base plans supersede via their own exact key upsert
  };
  // Never on a PROVEN add-on (codex #3245 r11): the classifier established
  // this accept replaces no live coverage — a different termite variant at
  // ANOTHER property (bond_1yr at B beside bond_5yr at A) is new coverage,
  // not supersession.
  const sliceVariantGroups = addOnBase > 0
    ? new Set()
    : new Set(sliceFamilies.map(termiteVariantGroup).filter(Boolean));
  if (sliceVariantGroups.size > 0) {
    for (const family of [...components.keys()]) {
      const group = termiteVariantGroup(family);
      if (group && sliceVariantGroups.has(group) && !sliceFamilies.includes(family)) {
        components.delete(family);
        await database('customer_plan_rates')
          .where({ customer_id: customerId, family_key: family })
          .del();
        reviewNeeded = true;
      }
    }
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

// Seed the ledger with KNOWN per-family components in one shot (the
// self-booking plan-sync rate backfill knows each detected plan's rate —
// codex #3245 r7: a rate minted AFTER the one-time backfill without
// components would hand the customer's first re-quote the empty-ledger
// whole-scalar replace). Replaces any existing rows; same gate-aware
// error policy as syncScalarWriteToLedger.
async function seedLedgerComponents(database, customerId, components = {}, { source = 'plan_sync' } = {}) {
  try {
    await database.transaction(async (sp) => {
      if (!(await ledgerTableExists(sp))) return;
      await sp('customer_plan_rates').where({ customer_id: customerId }).del();
      for (const [family, rate] of Object.entries(components)) {
        const amount = roundMoney(rate);
        if (amount > 0) {
          await sp('customer_plan_rates').insert({
            customer_id: customerId,
            family_key: boundedFamilyKey(family),
            monthly_rate: amount,
            source,
            effective_at: new Date(),
            updated_at: new Date(),
          });
        }
      }
    });
  } catch (seedErr) {
    if (planRateLedgerEnabled()) {
      logger.error(`[plan-rate-ledger] authoritative component seed failed for customer ${customerId} (${source}) — failing the write: ${seedErr.message}`);
      throw seedErr;
    }
    logger.warn(`[plan-rate-ledger] advisory component seed failed for customer ${customerId} (${source}): ${seedErr.message}`);
  }
}

// The ONE way for blind scalar writers (admin rate edits, IB customer
// tools, offboarding's rate clear) to keep the ledger consistent with the
// scalar they just wrote. Savepoint/transaction-confined, with the
// gate-aware error policy (codex #3245 r2): while the ledger is ADVISORY
// (gate off) a failure is swallowed with a warning — nothing reads the
// components; once the ledger has SCALAR AUTHORITY (gate on) a failed sync
// throws, failing the caller's write, because committing a new scalar over
// stale authoritative components lets the next accept resurrect the old
// sum. Pass rate null/0 to clear (offboarding).
async function syncScalarWriteToLedger(database, customerId, rate, { source = 'scalar_write' } = {}) {
  try {
    await database.transaction((sp) => resetLedgerToScalar(sp, customerId, rate, { source }));
  } catch (syncErr) {
    if (planRateLedgerEnabled()) {
      logger.error(`[plan-rate-ledger] authoritative sync failed for customer ${customerId} (${source}) — failing the write: ${syncErr.message}`);
      throw syncErr;
    }
    logger.warn(`[plan-rate-ledger] advisory sync failed for customer ${customerId} (${source}): ${syncErr.message}`);
  }
}

module.exports = {
  UNATTRIBUTED,
  planRateLedgerEnabled,
  boundedFamilyKey,
  acceptedRecurringBillingLines,
  estimateFamilySlices,
  loadComponents,
  applyAcceptToLedger,
  resetLedgerToScalar,
  clearLedger,
  syncScalarWriteToLedger,
  seedLedgerComponents,
};
