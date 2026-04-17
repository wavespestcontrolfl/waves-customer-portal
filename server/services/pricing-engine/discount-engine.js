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
const { WAVEGUARD, PALM, RODENT, GLOBAL } = require('./constants');

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
        result.flatCredit = PALM.flatCreditPerPalm;
        result.appliedDiscounts.push({
          type: 'flat_credit',
          amount: PALM.flatCreditPerPalm,
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
  } else {
    // Recurring services get WaveGuard tier discount. No caps, no stacking.
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
  if (discountResult.flatCredit) price -= discountResult.flatCredit;
  price = Math.max(priceFloor, price);
  return Math.round(price * 100) / 100;
}

// ── Validate discount for a full estimate (margin floor check) ─
// Kept for Session 10 (COGS-based margin validation). Fires when
// item.costs.total is populated.
function validateEstimateDiscounts(lineItems, waveGuardTier) {
  const warnings = [];
  for (const item of lineItems) {
    if (item.discount && item.discount.effectiveDiscount > 0 && item.costs && item.costs.total) {
      const discountedPrice = item.price * (1 - item.discount.effectiveDiscount);
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
  validateEstimateDiscounts,
};
