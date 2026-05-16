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
// Excluded services: rodent_bait, palm_injection, bed_bug_*, bora_care,
//   pre_slab_termidor. No % discount. Flat credits where applicable.
//
// Removed in v4.3 Session 6:
//   - Composite discount cap (was 0.25)
//   - Service-specific caps (lawn_care_enhanced/premium at Gold 15%)
//   - Promo code stacking
//   - Frequency discount tracking in the stack
//   - ACH discount plumbing (retired to 0% in an earlier session)
// ============================================================
const { WAVEGUARD, PALM, RODENT, GLOBAL, TREE_SHRUB } = require('./constants');

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

// Tier discount applies only to lawn, pest, tree & shrub, mosquito, and
// termite bait station. lawn_care_enhanced / lawn_care_premium are tier
// variants of lawn_care that resolveDiscountKey emits.
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
          : 1;
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
    if (serviceKey === 'rodent_bait') {
      result.setupCredit = RODENT.setupCredit;
      result.appliedDiscounts.push({
        type: 'setup_credit',
        amount: RODENT.setupCredit,
        reason: `One-time $${RODENT.setupCredit} WaveGuard member credit`,
      });
    }
    if (serviceKey === 'bed_bug_chemical' || serviceKey === 'bed_bug_heat') {
      const tierRank = { bronze: 0, silver: 1, gold: 2, platinum: 3 };
      if (tierRank[waveGuardTier.tier] >= tierRank.silver) {
        result.flatCredit = 50;
        result.appliedDiscounts.push({ type: 'flat_credit', amount: 50, reason: '$50 WaveGuard member credit' });
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

function applyMarginGuard(serviceQuote, finalAnnual, requestedDiscountPct = 0) {
  if (!serviceQuote || serviceQuote.service !== 'tree_shrub') {
    return {
      finalAnnual: roundMoney(finalAnnual),
      finalMargin: null,
      marginGuardApplied: false,
      discountCapped: false,
    };
  }

  const annualDirectCost = Number(serviceQuote.costs?.directCost);
  const adminCost = Number(serviceQuote.costs?.adminCost ?? GLOBAL.ADMIN_ANNUAL);
  const marginFloor = Number(TREE_SHRUB.marginFloor || GLOBAL.MARGIN_FLOOR);
  const candidateAnnual = roundMoney(finalAnnual);

  if (!Number.isFinite(annualDirectCost) || annualDirectCost < 0 || candidateAnnual <= 0) {
    return {
      finalAnnual: candidateAnnual,
      finalMargin: null,
      marginGuardApplied: false,
      discountCapped: false,
    };
  }

  const finalMargin = (candidateAnnual - annualDirectCost - adminCost) / candidateAnnual;
  if (finalMargin >= marginFloor) {
    return {
      finalAnnual: candidateAnnual,
      finalMargin: roundRatio(finalMargin),
      marginGuardApplied: false,
      discountCapped: false,
      requestedDiscountPct,
      actualDiscountPct: serviceQuote.annual > 0
        ? roundRatio(1 - candidateAnnual / serviceQuote.annual)
        : 0,
    };
  }

  const minAnnualForMargin = (annualDirectCost + adminCost) / (1 - marginFloor);
  const guardedAnnual = ceilMoney(Math.max(candidateAnnual, minAnnualForMargin));
  const guardedMargin = (guardedAnnual - annualDirectCost - adminCost) / guardedAnnual;
  const actualDiscountPct = serviceQuote.annual > 0 ? 1 - guardedAnnual / serviceQuote.annual : 0;

  return {
    finalAnnual: guardedAnnual,
    finalMargin: roundRatio(guardedMargin),
    marginGuardApplied: true,
    discountCapped: actualDiscountPct < requestedDiscountPct,
    requestedDiscountPct,
    actualDiscountPct: roundRatio(Math.max(0, actualDiscountPct)),
    minAnnualForMargin: ceilMoney(minAnnualForMargin),
  };
}

// ── Validate discount for a full estimate (margin floor check) ─
// Kept for Session 10 (COGS-based margin validation). Fires when
// item.costs.total is populated.
function validateEstimateDiscounts(lineItems, waveGuardTier) {
  const warnings = [];
  for (const item of lineItems) {
    if (item.discount && item.discount.effectiveDiscount > 0 && item.costs && item.costs.total) {
      const basePrice = item.price ?? item.annual;
      if (!Number.isFinite(basePrice) || basePrice <= 0) continue;
      const discountedPrice = item.annualAfterDiscount
        ?? item.priceAfterDiscount
        ?? item.totalAfterDiscount
        ?? (basePrice * (1 - item.discount.effectiveDiscount));
      const margin = (discountedPrice - item.costs.total) / discountedPrice;
      if (margin < GLOBAL.MARGIN_FLOOR) {
        warnings.push({
          service: item.service,
          margin: Math.round(margin * 1000) / 1000,
          discountedPrice: Math.round(discountedPrice),
          cost: item.costs.total,
          message: `${item.service} margin ${(margin * 100).toFixed(1)}% below ${(GLOBAL.MARGIN_FLOOR * 100).toFixed(0)}% floor after ${(item.discount.effectiveDiscount * 100).toFixed(0)}% discount`,
        });
      }
    }
  }
  return warnings;
}

module.exports = {
  determineWaveGuardTier,
  getEffectiveDiscount,
  applyDiscount,
  applyMarginGuard,
  validateEstimateDiscounts,
};
