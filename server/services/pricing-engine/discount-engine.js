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
// ENFORCEMENT REMOVED (owner ruling 2026-07-17: "forget all floors").
// Historically this guard lifted WaveGuard-discounted totals back to the
// 35% margin floor, and pest additionally to its post-discount program
// floor (PEST.floor × freqMult × visits, owner decision 2026-07-09). Since
// the ruling, discounted prices go out exactly as computed — margins are
// SURFACED (finalMargin here, marginFloorOk flags on quotes, the manual-
// discount warning in estimate-engine) and the owner adjusts prices in the
// estimator; nothing moves a price automatically. The pest floor's DB kill
// switch (pest_base.enforce_floor_post_discount) is set false by migration
// 20260717120000 and PEST.enforceFloorPostDiscount defaults false.

// Program-floor amounts for a pest cadence. The per-visit basis is rounded
// FIRST — matching pricePestControl's perApp = round(basePrice × freqMult)
// before annualizing — so a cents-tuned DB floor can never produce a floor
// annual a cent above the actual list price for a quote sitting exactly at
// the floor (which would silently defeat the Math.min(lifted, originalAnnual)
// cap and report the floor as applied at a price below it).
function pestProgramFloorPerVisit(freqMult) {
  const fm = Number(freqMult);
  if (!Number.isFinite(fm) || fm <= 0) return null;
  return roundMoney(Number(PEST.floor) * fm);
}

function pestProgramFloorAnnual(freqMult, visitsPerYear) {
  const perVisit = pestProgramFloorPerVisit(freqMult);
  const visits = Number(visitsPerYear);
  if (perVisit === null || !Number.isFinite(visits) || visits <= 0) return null;
  return roundMoney(perVisit * visits);
}

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
      programFloorAnnual = pestProgramFloorAnnual(serviceQuote.freqMult, serviceQuote.visitsPerYear);
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
