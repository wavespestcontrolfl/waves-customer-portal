// ============================================================
// discount-engine.js — Waves Discount Engine (v4.3 single-source)
//
// Two discount mechanics:
//   1. WaveGuard tier discount on qualifying recurring services.
//      Bronze 0%, Silver 10%, Gold 15%, Platinum 20%.
//      Qualifying services: pest, lawn, tree_shrub, mosquito, termite_bait.
//
//   2. Recurring customer one-time perk. Flat 15% off one-time services
//      when customer has active recurring services. Does NOT stack with
//      WaveGuard tier (one-time services never see tier discount; recurring
//      services never see the perk).
//
// Excluded services: rodent_bait, palm_injection, bed_bug*, bora_care,
//   pre_slab_termiticide/pre_slab_termidor. No % discount. Flat credits only where explicitly
//   allowed. Rodent bait receives no WaveGuard credit or tier benefit.
//
// Removed in v4.3 Session 6:
//   - Composite discount cap (was 0.25)
//   - Service-specific caps (lawn_care_enhanced/premium at Gold 15%)
//   - Promo code stacking
//   - Frequency discount tracking in the stack
//   - ACH discount plumbing (retired to 0% in an earlier session)
// ============================================================
const { WAVEGUARD, PALM, GLOBAL, TREE_SHRUB, PEST } = require('./constants');

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function ceilMoney(value) {
  return Math.ceil((Number(value) || 0) * 100) / 100;
}

function roundRatio(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000;
}

function roundCurrency(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

// Tier discount applies to qualifying recurring services. Lawn tier variants
// resolve to dedicated service keys but share lawn_care's WaveGuard policy.
const TIER_DISCOUNT_ELIGIBLE = new Set([
  ...WAVEGUARD.qualifyingServices,
  'lawn_care_enhanced',
  'lawn_care_premium',
]);

function isTierDiscountEligible(serviceKey) {
  return TIER_DISCOUNT_ELIGIBLE.has(serviceKey);
}

// ── Determine WaveGuard tier from active services ─────────────
function determineWaveGuardTier(activeServices = []) {
  const qualifying = activeServices.filter(svc =>
    WAVEGUARD.qualifyingServices.includes(svc)
  );
  const count = qualifying.length;

  if (count >= 4) return { tier: 'platinum', discount: WAVEGUARD.tiers.platinum.discount, qualifyingCount: count };
  if (count >= 3) return { tier: 'gold',     discount: WAVEGUARD.tiers.gold.discount,     qualifyingCount: count };
  if (count >= 2) return { tier: 'silver',   discount: WAVEGUARD.tiers.silver.discount,   qualifyingCount: count };
  return             { tier: 'bronze',       discount: WAVEGUARD.tiers.bronze.discount,   qualifyingCount: count };
}

// ── Get effective discount for a specific service line ─────────
function getEffectiveDiscount(serviceKey, waveGuardTier, options = {}) {
  const {
    isRecurringCustomer = false,
    isOneTimeService = false,
  } = options;

  const result = {
    serviceKey,
    waveGuardTier: waveGuardTier.tier,
    appliedDiscounts: [],
    effectiveDiscount: 0,
    totalDiscount: 0,
    discountable: true,
  };

  // ── Excluded from % discount entirely ──
  if (WAVEGUARD.excludedFromPercentDiscount[serviceKey]) {
    result.appliedDiscounts.push({ type: 'exclusion', reason: `${serviceKey} excluded from % discounts` });

    // Flat credits for eligible services
    if (serviceKey === 'palm_injection') {
      const tierRank = { bronze: 0, silver: 1, gold: 2, platinum: 3 };
      if (tierRank[waveGuardTier.tier] >= tierRank[PALM.flatCreditMinTier]) {
        const palmCount = Number.isInteger(options.palmCount) && options.palmCount > 0
          ? options.palmCount
          : null;
        if (!palmCount) {
          result.requiresMeasurement = true;
          result.warnings = ['missing_palm_count'];
          return result;
        }
        const annualCredit = roundCurrency(palmCount * PALM.flatCreditPerPalm);
        const annualBeforeCredits = Number.isFinite(options.annualBeforeCredits)
          ? options.annualBeforeCredits
          : null;
        const cappedAnnualCredit = annualBeforeCredits === null
          ? annualCredit
          : Math.min(annualCredit, annualBeforeCredits);

        result.palmCount = palmCount;
        result.flatCreditPerPalm = PALM.flatCreditPerPalm;
        result.flatCredit = cappedAnnualCredit;
        result.flatCreditAnnual = cappedAnnualCredit;
        result.flatCreditAnnualUncapped = annualCredit;
        if (annualBeforeCredits !== null) {
          result.annualBeforeCredits = annualBeforeCredits;
          result.annualAfterCredits = roundCurrency(Math.max(0, annualBeforeCredits - cappedAnnualCredit));
          result.monthlyAfterCredits = roundCurrency(result.annualAfterCredits / 12);
        }
        result.appliedDiscounts.push({
          type: 'flat_credit',
          amount: cappedAnnualCredit,
          perPalm: PALM.flatCreditPerPalm,
          palmCount,
          reason: `$${PALM.flatCreditPerPalm}/palm/yr Gold+ loyalty credit`,
        });
      }
    }
    // totalDiscount stays 0 — no % discount applies
    return result;
  }

  // ── Apply discount based on service kind ──
  if (isOneTimeService) {
    // One-time services never get WaveGuard tier discount.
    // Recurring customers get the flat 15% perk on one-time services.
    if (isRecurringCustomer) {
      result.effectiveDiscount = WAVEGUARD.recurringCustomerOneTimePerk;
      result.appliedDiscounts.push({
        type: 'recurring_customer_one_time_perk',
        amount: WAVEGUARD.recurringCustomerOneTimePerk,
      });
    }
  } else if (isTierDiscountEligible(serviceKey)) {
    // Tier discount applies only to the qualifying recurring services
    // (lawn_care, pest_control, tree_shrub, mosquito, termite_bait).
    // lawn_care_enhanced/lawn_care_premium are tier variants of lawn_care.
    if (waveGuardTier.discount > 0) {
      result.effectiveDiscount = waveGuardTier.discount;
      result.appliedDiscounts.push({
        type: 'waveguard',
        amount: waveGuardTier.discount,
        tier: waveGuardTier.tier,
      });
    }
  }

  result.totalDiscount = result.effectiveDiscount;
  result.appliedDiscountPercent = result.effectiveDiscount;
  result.requestedDiscountPercent = result.effectiveDiscount;
  return result;
}

// ── Apply discount to a price ─────────────────────────────────
function applyDiscount(basePrice, discountResult, priceFloor = 0) {
  let price = basePrice * (1 - discountResult.effectiveDiscount);
  const flatCredit = discountResult.flatCreditAnnual ?? discountResult.flatCredit;
  if (flatCredit) price -= flatCredit;
  price = Math.max(priceFloor, price);
  return roundCurrency(price);
}

// Post-discount margin REPORT (Tree & Shrub + Pest Control).
//
// Computes the same margin definition the engine displays to admin/customer:
//     margin = (annual - allInAnnualCost) / annual
// where allInAnnualCost is direct cost + admin overhead.
//
// MARGIN-FLOOR ENFORCEMENT REMOVED (owner ruling 2026-07-17: "forget all
// floors"). Historically this guard lifted WaveGuard-discounted totals back
// to the 35% margin floor. Since the ruling, discounted prices go out
// exactly as computed — margins are SURFACED (finalMargin here,
// belowMarginFloor/belowProgramFloor flags on quotes, the manual-discount
// warnings in estimate-engine) and the owner adjusts prices in the
// estimator; nothing moves a price automatically. The margin floor has NO
// re-arm key: it stays report-only.
//
// PEST PROGRAM FLOOR (PEST.floor × freqMult × visits, owner decision
// 2026-07-09) is DISARMED by default — migration 20260717120000 sets
// pest_base.enforce_floor_post_discount=false and the in-code default is
// false. The floor REFERENCE is always computed so the belowProgramFloor
// signal reports the comparison either way (reporting is independent of
// enforcement). When an operator re-arms the DB flag, ENFORCEMENT comes
// back in full and end to end: this guard lifts the saved engine totals,
// service-pricing stamps floorPa/floorAnn tier metadata, and
// estimate-public clamps the public/accept reprice to the same floor — so
// saved, viewed, and accepted amounts always agree (codex P1 on #2827).

// Program-floor amounts for a pest cadence. The per-visit basis is rounded
// FIRST — matching pricePestControl's perApp = round(basePrice × freqMult)
// before annualizing — so a cents-tuned DB floor can never produce a floor
// annual a cent above the actual list price for a quote sitting exactly at
// the floor (which would silently defeat the Math.min(lifted, originalAnnual)
// cap and report the floor as applied at a price below it).
// Optional floorPerVisit override: saved-estimate replays thread the floor
// the quote was priced with (pricingMetadata.pestProgramFloorPerVisit) so a
// live pest_base.floor change never re-prices a sent quote (pre-push codex
// P0, round 9 on #2827). Default: the live DB-synced PEST.floor.
function pestProgramFloorPerVisit(freqMult, floorPerVisit) {
  const fm = Number(freqMult);
  if (!Number.isFinite(fm) || fm <= 0) return null;
  const base = Number(floorPerVisit ?? PEST.floor);
  if (!Number.isFinite(base) || base <= 0) return null;
  return roundMoney(base * fm);
}

function pestProgramFloorAnnual(freqMult, visitsPerYear, floorPerVisit) {
  const perVisit = pestProgramFloorPerVisit(freqMult, floorPerVisit);
  const visits = Number(visitsPerYear);
  if (perVisit === null || !Number.isFinite(visits) || visits <= 0) return null;
  return roundMoney(perVisit * visits);
}

function applyMarginGuard(serviceQuote, finalAnnual, requestedDiscountPct = 0, floorContext = {}) {
  const service = serviceQuote?.service;
  let annualCostAllIn = null;
  let marginFloor = Number(GLOBAL.MARGIN_FLOOR);
  let programFloorAnnual = null;
  if (service === 'tree_shrub') {
    const directCost = Number(serviceQuote.costs?.directCost);
    const adminCost = Number(serviceQuote.costs?.adminCost ?? GLOBAL.ADMIN_ANNUAL);
    if (Number.isFinite(directCost)) annualCostAllIn = directCost + adminCost;
    marginFloor = Number(TREE_SHRUB.marginFloor || GLOBAL.MARGIN_FLOOR);
  } else if (service === 'pest_control') {
    const annualCost = Number(serviceQuote.costs?.annualCost);
    if (Number.isFinite(annualCost)) annualCostAllIn = annualCost;
    // Post-discount program floor REFERENCE: PEST.floor × cadence multiplier
    // × visits — the same per-visit floor the list price honors, scaled to
    // the quote's cadence. Computed UNCONDITIONALLY so the belowProgramFloor
    // signal reports the comparison even while enforcement is disarmed
    // (codex P2 on #2827); only the lift below is gated on the DB kill
    // switch (pricing_config pest_base.enforce_floor_post_discount).
    programFloorAnnual = pestProgramFloorAnnual(
      serviceQuote.freqMult,
      serviceQuote.visitsPerYear,
      floorContext.pestProgramFloorPerVisit,
    );
  } else {
    return {
      finalAnnual: roundMoney(finalAnnual),
      finalMargin: null,
      marginGuardApplied: false,
      discountCapped: false,
    };
  }

  const candidateAnnual = roundMoney(finalAnnual);
  const originalAnnual = Number(serviceQuote.annual);
  const hasOriginal = Number.isFinite(originalAnnual) && originalAnnual > 0;

  const hasCostBasis = annualCostAllIn !== null && annualCostAllIn >= 0;
  if ((!hasCostBasis && programFloorAnnual === null) || candidateAnnual <= 0) {
    return {
      finalAnnual: candidateAnnual,
      finalMargin: null,
      marginGuardApplied: false,
      discountCapped: false,
    };
  }

  const finalMargin = hasCostBasis
    ? (candidateAnnual - annualCostAllIn) / candidateAnnual
    : null;

  // Pest program floor — ENFORCED only when the DB flag is re-armed, so the
  // saved engine total matches what estimate-public clamps the public/accept
  // reprice to off the stamped floor metadata (never above the original
  // undiscounted price; a legacy below-floor base stays merely undiscounted).
  // Arm state resolves caller-first: saved-estimate replays thread the arm
  // state the quote was priced with (pre-push codex P0, round 9 on #2827).
  const pestFloorArmed = typeof floorContext.pestProgramFloorArmed === 'boolean'
    ? floorContext.pestProgramFloorArmed
    : PEST.enforceFloorPostDiscount === true;
  const needsFloorLift =
    pestFloorArmed &&
    programFloorAnnual !== null &&
    candidateAnnual < programFloorAnnual;

  if (needsFloorLift) {
    const lifted = Math.max(candidateAnnual, programFloorAnnual);
    const guardedAnnual = ceilMoney(hasOriginal ? Math.min(lifted, originalAnnual) : lifted);
    const guardedMargin = hasCostBasis
      ? (guardedAnnual - annualCostAllIn) / guardedAnnual
      : null;
    const actualDiscountPct = hasOriginal ? 1 - guardedAnnual / originalAnnual : 0;
    return {
      finalAnnual: guardedAnnual,
      finalMargin: guardedMargin === null ? null : roundRatio(guardedMargin),
      // Margin-floor lift stays retired (no re-arm key) — report-only.
      marginGuardApplied: false,
      programFloorApplied: guardedAnnual > candidateAnnual,
      discountCapped: actualDiscountPct < requestedDiscountPct,
      belowMarginFloor: hasCostBasis ? guardedMargin < marginFloor : false,
      belowProgramFloor: guardedAnnual < programFloorAnnual,
      requestedDiscountPct,
      actualDiscountPct: roundRatio(Math.max(0, actualDiscountPct)),
      programFloorAnnual,
    };
  }

  // Report-only since the 2026-07-17 owner ruling: the discounted price
  // stands as computed. belowMarginFloor / belowProgramFloor let callers
  // and the estimator surface "this looks low" without moving the number.
  return {
    finalAnnual: candidateAnnual,
    finalMargin: finalMargin === null ? null : roundRatio(finalMargin),
    marginGuardApplied: false,
    discountCapped: false,
    programFloorApplied: false,
    belowMarginFloor: hasCostBasis ? finalMargin < marginFloor : false,
    belowProgramFloor: programFloorAnnual !== null && candidateAnnual < programFloorAnnual,
    requestedDiscountPct,
    actualDiscountPct: hasOriginal
      ? roundRatio(Math.max(0, 1 - candidateAnnual / originalAnnual))
      : 0,
    ...(programFloorAnnual !== null ? { programFloorAnnual } : {}),
  };
}

// Discount margin validation is retired. Final prices are computed by each
// service pricer; discounts should not create margin warnings or blockers.
function validateEstimateDiscounts(lineItems, waveGuardTier) {
  return [];
}

module.exports = {
  determineWaveGuardTier,
  getEffectiveDiscount,
  applyDiscount,
  applyMarginGuard,
  pestProgramFloorPerVisit,
  pestProgramFloorAnnual,
  validateEstimateDiscounts,
};
