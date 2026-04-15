// ============================================================
// discount-engine.js — Waves Discount Engine
// Handles WaveGuard bundle, frequency, promo, ACH, composite cap
// ============================================================
const { WAVEGUARD, ACH_DISCOUNT, PALM, RODENT, GLOBAL } = require('./constants');

// ── Determine WaveGuard tier from active services ─────────────
function determineWaveGuardTier(activeServices = []) {
  const qualifying = activeServices.filter(svc =>
    WAVEGUARD.qualifyingServices.includes(svc)
  );
  const count = qualifying.length;

  if (count >= 4) return { tier: 'platinum', discount: WAVEGUARD.tiers.platinum.discount, qualifyingCount: count };
  if (count >= 3) return { tier: 'gold', discount: WAVEGUARD.tiers.gold.discount, qualifyingCount: count };
  if (count >= 2) return { tier: 'silver', discount: WAVEGUARD.tiers.silver.discount, qualifyingCount: count };
  return { tier: 'bronze', discount: WAVEGUARD.tiers.bronze.discount, qualifyingCount: count };
}

// ── Get effective discount for a specific service line ─────────
function getEffectiveDiscount(serviceKey, waveGuardTier, options = {}) {
  const {
    promoDiscount = 0,         // Promo code percentage (0-1)
    frequencyDiscount = 0,     // Frequency discount already applied (0-1)
    isRecurringCustomer = false,
    isOneTimeService = false,
    paymentMethod = 'card',    // 'card' | 'us_bank_account'
  } = options;

  const result = {
    serviceKey,
    waveGuardTier: waveGuardTier.tier,
    appliedDiscounts: [],
    baseDiscount: 0,        // Before any caps
    effectiveDiscount: 0,   // After caps
    achDiscount: 0,         // Separate — exempt from composite cap
    totalDiscount: 0,       // Final effective
    cappedAt: null,
  };

  // ── Check service-specific exclusions ──────────────────────
  const discountCap = WAVEGUARD.discountCaps[serviceKey];
  const isExcludedFromPct = discountCap === 0;

  // Services fully excluded from percentage discounts
  if (isExcludedFromPct) {
    result.appliedDiscounts.push({ type: 'exclusion', reason: `${serviceKey} excluded from % discounts` });

    // Check for flat credits (palm injection)
    if (serviceKey === 'palm_injection') {
      const tierRank = { bronze: 0, silver: 1, gold: 2, platinum: 3 };
      if (tierRank[waveGuardTier.tier] >= tierRank[PALM.flatCreditMinTier]) {
        result.flatCredit = PALM.flatCreditPerPalm;
        result.appliedDiscounts.push({ type: 'flat_credit', amount: PALM.flatCreditPerPalm, reason: `$${PALM.flatCreditPerPalm}/palm/yr Gold+ loyalty credit` });
      }
    }

    // Rodent bait setup credit
    if (serviceKey === 'rodent_bait') {
      result.setupCredit = RODENT.setupCredit;
      result.appliedDiscounts.push({ type: 'setup_credit', amount: RODENT.setupCredit, reason: `One-time $${RODENT.setupCredit} WaveGuard member credit` });
    }

    // Bed bug flat member credit ($50 for Silver+)
    if (serviceKey === 'bed_bug_chemical' || serviceKey === 'bed_bug_heat') {
      const tierRank = { bronze: 0, silver: 1, gold: 2, platinum: 3 };
      if (tierRank[waveGuardTier.tier] >= tierRank.silver) {
        result.flatCredit = 50;
        result.appliedDiscounts.push({ type: 'flat_credit', amount: 50, reason: '$50 WaveGuard member credit' });
      }
    }

    // ACH discount still applies to excluded services
    if (paymentMethod === ACH_DISCOUNT.paymentMethod) {
      result.achDiscount = ACH_DISCOUNT.percentage;
      result.appliedDiscounts.push({ type: 'ach', amount: ACH_DISCOUNT.percentage, reason: 'Bank payment discount' });
    }

    result.totalDiscount = result.achDiscount;
    return result;
  }

  // ── Build discount stack ──────────────────────────────────
  let discountStack = 0;

  // 1. WaveGuard tier discount
  let wgDiscount = waveGuardTier.discount;
  if (discountCap !== undefined && discountCap !== null && discountCap > 0) {
    wgDiscount = Math.min(wgDiscount, discountCap);
    if (wgDiscount < waveGuardTier.discount) {
      result.appliedDiscounts.push({
        type: 'waveguard_capped',
        original: waveGuardTier.discount,
        capped: wgDiscount,
        reason: `${serviceKey} capped at ${(wgDiscount * 100).toFixed(0)}%`,
      });
    }
  }

  if (wgDiscount > 0) {
    discountStack = wgDiscount;
    result.appliedDiscounts.push({ type: 'waveguard', amount: wgDiscount, tier: waveGuardTier.tier });
  }

  // 2. Recurring customer discount on one-time services
  if (isOneTimeService && isRecurringCustomer) {
    // Recurring discount stacks with WaveGuard, but composite cap will catch it
    const recDisc = WAVEGUARD.recurringCustomerDiscount;
    discountStack = 1 - (1 - discountStack) * (1 - recDisc); // Multiplicative stacking
    result.appliedDiscounts.push({ type: 'recurring_customer', amount: recDisc });
  }

  // 3. Promo code discount
  if (promoDiscount > 0) {
    discountStack = 1 - (1 - discountStack) * (1 - promoDiscount);
    result.appliedDiscounts.push({ type: 'promo', amount: promoDiscount });
  }

  // Note: Frequency discounts are applied in the service pricing itself,
  // not in the discount engine. They're a price multiplier, not a discount.
  // But we track them for composite cap purposes.
  if (frequencyDiscount > 0) {
    discountStack = 1 - (1 - discountStack) * (1 - frequencyDiscount);
    result.appliedDiscounts.push({ type: 'frequency', amount: frequencyDiscount, note: 'Applied in service pricing' });
  }

  result.baseDiscount = discountStack;

  // ── Apply composite discount cap ──────────────────────────
  if (discountStack > WAVEGUARD.compositeDiscountCap) {
    result.effectiveDiscount = WAVEGUARD.compositeDiscountCap;
    result.cappedAt = WAVEGUARD.compositeDiscountCap;
    result.appliedDiscounts.push({
      type: 'composite_cap',
      original: discountStack,
      capped: WAVEGUARD.compositeDiscountCap,
      reason: `Composite cap: ${(WAVEGUARD.compositeDiscountCap * 100).toFixed(0)}% max`,
    });
  } else {
    result.effectiveDiscount = discountStack;
  }

  // ── ACH discount (exempt from composite cap) ──────────────
  if (paymentMethod === ACH_DISCOUNT.paymentMethod) {
    result.achDiscount = ACH_DISCOUNT.percentage;
    result.appliedDiscounts.push({ type: 'ach', amount: ACH_DISCOUNT.percentage, reason: 'Bank payment discount' });
  }

  // Total: service discounts + ACH (applied separately)
  result.totalDiscount = 1 - (1 - result.effectiveDiscount) * (1 - result.achDiscount);

  return result;
}

// ── Apply discount to a price ─────────────────────────────────
function applyDiscount(basePrice, discountResult, priceFloor = 0) {
  // Apply service discounts (capped)
  let price = basePrice * (1 - discountResult.effectiveDiscount);

  // Apply flat credits if applicable
  if (discountResult.flatCredit) {
    price -= discountResult.flatCredit;
  }

  // Apply price floor before ACH
  price = Math.max(priceFloor, price);

  // Apply ACH discount (separate from service discounts)
  if (discountResult.achDiscount > 0) {
    price = price * (1 - discountResult.achDiscount);
  }

  return Math.round(price * 100) / 100;
}

// ── Validate discount for a full estimate ─────────────────────
function validateEstimateDiscounts(lineItems, waveGuardTier) {
  const warnings = [];
  for (const item of lineItems) {
    if (item.discount && item.discount.effectiveDiscount > 0) {
      const discountedPrice = item.price * (1 - item.discount.effectiveDiscount);
      if (item.costs && item.costs.total) {
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
  }
  return warnings;
}

module.exports = {
  determineWaveGuardTier,
  getEffectiveDiscount,
  applyDiscount,
  validateEstimateDiscounts,
};
