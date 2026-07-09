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

// Post-discount margin guard (Tree & Shrub + Pest Control).
//
// Protects the same margin definition the engine displays to admin/customer:
//     margin = (annual - allInAnnualCost) / annual
// where allInAnnualCost is direct cost + admin overhead.
//
// So the discounted annual must satisfy
//     annual >= allInAnnualCost / (1 - marginFloor)
//
// Guard policy (applies to AUTO discounts — WaveGuard tier):
//  - Cap the discount when it would push displayed margin below the floor.
//  - Never raise the discounted price above the original undiscounted annual:
//    if the undiscounted price itself doesn't clear the floor, the discount
//    engine just prevents *additional* discounting. Fixing under-priced base
//    quotes is the pricing engine's job, not the discount engine's.
//
// Cost-shape per service: Tree & Shrub exposes costs.directCost + costs.adminCost
// separately; Pest exposes a single costs.annualCost that already folds in admin.
// Pest additionally enforces a post-discount PROGRAM FLOOR (dollar bound, not
// margin bound): collected annual >= PEST.floor × freqMult × visitsPerYear.
// The margin guard alone let Platinum collect ~$23/mo on floor-priced
// quarterly quotes; the program floor holds every cadence at its own bottom
// cell (owner decision 2026-07-09). Kill switch: pest_base row
// enforce_floor_post_discount=false (DB, no deploy).
// Manual owner discounts are NOT capped here — they warn-only (see estimate-engine).
function applyMarginGuard(serviceQuote, finalAnnual, requestedDiscountPct = 0) {
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
    // Post-discount program floor: the collected pest annual may not drop
    // below PEST.floor × cadence multiplier × visits — the same per-visit
    // floor the list price honors, scaled to the quote's cadence. Both the
    // floor value and the kill switch (enforce_floor_post_discount: false)
    // are DB-tunable on the pricing_config pest_base row.
    if (PEST.enforceFloorPostDiscount) {
      const freqMult = Number(serviceQuote.freqMult);
      const visits = Number(serviceQuote.visitsPerYear);
      if (Number.isFinite(freqMult) && freqMult > 0 && Number.isFinite(visits) && visits > 0) {
        programFloorAnnual = roundMoney(Number(PEST.floor) * freqMult * visits);
      }
    }
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
  const needsMarginLift = hasCostBasis && finalMargin < marginFloor;
  const needsFloorLift = programFloorAnnual !== null && candidateAnnual < programFloorAnnual;

  if (!needsMarginLift && !needsFloorLift) {
    return {
      finalAnnual: candidateAnnual,
      finalMargin: finalMargin === null ? null : roundRatio(finalMargin),
      marginGuardApplied: false,
      discountCapped: false,
      programFloorApplied: false,
      requestedDiscountPct,
      actualDiscountPct: hasOriginal
        ? roundRatio(1 - candidateAnnual / originalAnnual)
        : 0,
    };
  }

  const minAnnualForMargin = hasCostBasis ? annualCostAllIn / (1 - marginFloor) : 0;
  // Raise the discounted price to the binding bound (margin floor and/or the
  // pest program floor), but never above the original undiscounted price —
  // see policy comment above.
  const lifted = Math.max(
    candidateAnnual,
    needsMarginLift ? minAnnualForMargin : 0,
    needsFloorLift ? programFloorAnnual : 0,
  );
  const guardedAnnual = ceilMoney(hasOriginal ? Math.min(lifted, originalAnnual) : lifted);
  const guardedMargin = hasCostBasis
    ? (guardedAnnual - annualCostAllIn) / guardedAnnual
    : null;
  const actualDiscountPct = hasOriginal ? 1 - guardedAnnual / originalAnnual : 0;

  return {
    finalAnnual: guardedAnnual,
    finalMargin: guardedMargin === null ? null : roundRatio(guardedMargin),
    marginGuardApplied: needsMarginLift,
    programFloorApplied: needsFloorLift && guardedAnnual > candidateAnnual,
    discountCapped: actualDiscountPct < requestedDiscountPct,
    requestedDiscountPct,
    actualDiscountPct: roundRatio(Math.max(0, actualDiscountPct)),
    ...(needsMarginLift ? { minAnnualForMargin: ceilMoney(minAnnualForMargin) } : {}),
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
  validateEstimateDiscounts,
};
