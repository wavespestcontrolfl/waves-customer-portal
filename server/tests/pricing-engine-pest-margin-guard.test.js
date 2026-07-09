const {
  generateEstimate,
  priceOneTimePest,
  constants,
} = require('../services/pricing-engine');

// These tests exercise the pest-control margin guard, the post-discount
// program floor, and the one-time anchor. Several mutate `constants.PEST`
// knobs to force below-floor scenarios, so we snapshot and restore them
// around every test.
const ORIGINAL_PEST_BASE = constants.PEST.base;
const ORIGINAL_PEST_FLOOR = constants.PEST.floor;
const ORIGINAL_ENFORCE_FLOOR = constants.PEST.enforceFloorPostDiscount;
afterEach(() => {
  constants.PEST.base = ORIGINAL_PEST_BASE;
  constants.PEST.floor = ORIGINAL_PEST_FLOOR;
  constants.PEST.enforceFloorPostDiscount = ORIGINAL_ENFORCE_FLOOR;
});

function platinumBundle(extra = {}) {
  return {
    property: { footprint: 2000 },
    services: { pest: { frequency: 'monthly' }, lawn: true, mosquito: true, treeShrub: true },
    ...extra,
  };
}

describe('pest control margin guard (WaveGuard auto-discount)', () => {
  test('does not cap when the discounted margin stays at/above the 35% floor', () => {
    // Default base ($117) keeps pest margins well above 35% even at Platinum.
    const est = generateEstimate(platinumBundle());
    const pest = est.lineItems.find(i => i.service === 'pest_control');
    expect(est.waveGuard.tier).toBe('platinum');
    expect(pest.marginGuardApplied).toBe(false);
    expect(pest.discountCapped).toBe(false);
    expect(pest.annualAfterDiscount).toBeCloseTo(pest.annualBeforeDiscount * 0.8, 1);
  });

  test('caps the WaveGuard discount when it would push pest below the 35% floor', () => {
    constants.PEST.base = 89; // floor-level base → monthly + Platinum 20% breaches 35%
    const est = generateEstimate(platinumBundle());
    const pest = est.lineItems.find(i => i.service === 'pest_control');
    expect(pest.marginGuardApplied).toBe(true);
    expect(pest.discountCapped).toBe(true);
    expect(pest.requestedDiscountPct).toBeCloseTo(0.2, 3);
    expect(pest.actualDiscountPct).toBeLessThan(0.2);
    // Displayed margin is held at the floor, never below.
    expect(pest.finalMargin).toBeGreaterThanOrEqual(0.35 - 1e-9);
    // The program floor (floor × freqMult × visits) dominates the margin
    // minimum for pest at every cadence, so the collected price lands at the
    // program floor — which at a floor-level base equals the undiscounted
    // annual.
    expect(pest.programFloorApplied).toBe(true);
    expect(pest.annualAfterDiscount).toBe(pest.programFloorAnnual);
    expect(pest.annualAfterDiscount).toBe(pest.annualBeforeDiscount);
  });

  test('with the program floor disabled, the margin guard alone caps at the 35% minimum', () => {
    constants.PEST.base = 89;
    constants.PEST.enforceFloorPostDiscount = false;
    const est = generateEstimate(platinumBundle());
    const pest = est.lineItems.find(i => i.service === 'pest_control');
    expect(pest.marginGuardApplied).toBe(true);
    expect(pest.programFloorApplied).toBeFalsy();
    expect(pest.finalMargin).toBeGreaterThanOrEqual(0.35 - 1e-9);
    expect(pest.annualAfterDiscount).toBe(pest.minAnnualForMargin);
    // The margin minimum sits BELOW the program floor — this is exactly the
    // gap the program floor closes.
    expect(pest.annualAfterDiscount).toBeLessThan(pest.annualBeforeDiscount);
  });

  test('guard never lifts the price above the undiscounted annual', () => {
    constants.PEST.base = 89;
    const est = generateEstimate(platinumBundle());
    const pest = est.lineItems.find(i => i.service === 'pest_control');
    expect(pest.annualAfterDiscount).toBeLessThanOrEqual(pest.annualBeforeDiscount);
  });
});

describe('pest post-discount program floor (owner decision 2026-07-09)', () => {
  function bundleWithPestFrequency(frequency, extra = {}) {
    return {
      property: { footprint: 2000 },
      services: { pest: { frequency }, lawn: true, mosquito: true, treeShrub: true },
      ...extra,
    };
  }

  test('Platinum on a floor-priced quarterly collects the full program floor', () => {
    constants.PEST.base = 89; // basePrice clamps to the $89 floor at 2,000 sf
    const est = generateEstimate(bundleWithPestFrequency('quarterly'));
    const pest = est.lineItems.find(i => i.service === 'pest_control');
    expect(est.waveGuard.tier).toBe('platinum');
    // floor × 1.00 × 4 = $356 — the 20% discount is fully suppressed.
    expect(pest.annualBeforeDiscount).toBeCloseTo(356, 2);
    expect(pest.programFloorApplied).toBe(true);
    expect(pest.annualAfterDiscount).toBeCloseTo(356, 2);
    expect(pest.actualDiscountPct).toBe(0);
    expect(pest.discountCapped).toBe(true);
  });

  test('bimonthly floor scales by the cadence multiplier', () => {
    constants.PEST.base = 89;
    const est = generateEstimate(bundleWithPestFrequency('bimonthly'));
    const pest = est.lineItems.find(i => i.service === 'pest_control');
    // floor × 0.85 × 6 = $453.90 (v1 cadence curve is the engine default).
    expect(pest.annualBeforeDiscount).toBeCloseTo(453.90, 2);
    expect(pest.programFloorApplied).toBe(true);
    expect(pest.annualAfterDiscount).toBeCloseTo(453.90, 2);
  });

  test('cents-tuned DB floor: floor annual uses the rounded per-visit basis', () => {
    // pricePestControl rounds the per-app amount BEFORE annualizing, so the
    // floor must too: round(89.99 × 0.85) = 76.49 → $458.94/yr, exactly the
    // list annual. A single end-rounding (89.99 × 0.85 × 6 → $458.95) would
    // sit a cent ABOVE list, defeat the never-above-list cap, and mark the
    // floor applied at a collected price below it (codex P3).
    constants.PEST.base = 89.99;
    constants.PEST.floor = 89.99;
    const est = generateEstimate(bundleWithPestFrequency('bimonthly'));
    const pest = est.lineItems.find(i => i.service === 'pest_control');
    expect(pest.annualBeforeDiscount).toBeCloseTo(458.94, 2);
    expect(pest.programFloorAnnual).toBeCloseTo(458.94, 2);
    expect(pest.programFloorApplied).toBe(true);
    expect(pest.annualAfterDiscount).toBeCloseTo(458.94, 2);
    expect(pest.annualAfterDiscount).toBeGreaterThanOrEqual(pest.programFloorAnnual);
  });

  test('discounts above the floor are untouched — modal-priced quarterly keeps full Platinum 20%', () => {
    // Default base ($117): quarterly annual $468, Platinum collects $374.40,
    // still above the $356 program floor.
    const est = generateEstimate(bundleWithPestFrequency('quarterly'));
    const pest = est.lineItems.find(i => i.service === 'pest_control');
    expect(pest.programFloorApplied).toBe(false);
    expect(pest.annualAfterDiscount).toBeCloseTo(468 * 0.8, 2);
  });

  test('manual discount below the program floor stays warn-only with a distinct warning', () => {
    constants.PEST.base = 89;
    const est = generateEstimate(bundleWithPestFrequency('quarterly', {
      manualDiscount: { type: 'PERCENT', value: 10, source: 'test', eligibilityConfirmed: true },
    }));
    const pest = est.lineItems.find(i => i.service === 'pest_control');
    // Pest is already sitting exactly at the floor post-WaveGuard, so any
    // manual share cuts below it — warned, never capped.
    expect(pest.manualPestFloorWarning).toBe(true);
    const warning = est.marginWarnings.find(w => w.type === 'manual_discount_below_pest_program_floor');
    expect(warning).toBeTruthy();
    expect(warning.programFloorAnnual).toBeCloseTo(356, 2);
    expect(warning.finalAnnual).toBeLessThan(356);
    // The manual discount itself is NOT reduced (owner loss-leader override).
    expect(est.summary.manualDiscount.amount).toBeGreaterThan(0);
    expect(est.summary.manualDiscount.capped).toBe(false);
  });
});

describe('pest control manual discount (warn-only, not capped)', () => {
  test('manual discount below the floor is allowed but surfaces a margin warning', () => {
    constants.PEST.base = 89;
    const est = generateEstimate(platinumBundle({
      manualDiscount: { type: 'PERCENT', value: 30, source: 'test', eligibilityConfirmed: true },
    }));
    const pest = est.lineItems.find(i => i.service === 'pest_control');
    // Manual discount is NOT capped — the line carries a warning instead.
    expect(pest.manualMarginWarning).toBe(true);
    expect(pest.manualFinalMargin).toBeLessThan(0.35);
    const warning = est.marginWarnings.find(w => w.service === 'pest_control');
    expect(warning).toBeTruthy();
    expect(warning.type).toBe('manual_discount_below_margin_floor');
    expect(warning.margin).toBeLessThan(0.35);
    expect(warning.finalAnnual).toBeGreaterThan(0);
  });

  test('Tree & Shrub is also warned (manual warn covers all guarded services, not just pest)', () => {
    const est = generateEstimate({
      property: { footprint: 2000, bedArea: 3000 },
      services: { pest: { frequency: 'monthly' }, lawn: true, mosquito: true, treeShrub: { tier: 'standard' } },
      manualDiscount: { type: 'PERCENT', value: 90, source: 'test', eligibilityConfirmed: true },
    });
    const warnedServices = est.marginWarnings.map(w => w.service);
    expect(warnedServices).toContain('pest_control');
    expect(warnedServices).toContain('tree_shrub');
    const ts = est.lineItems.find(i => i.service === 'tree_shrub');
    expect(ts.manualMarginWarning).toBe(true);
  });

  test('no margin warning when the manual discount stays above the floor', () => {
    const est = generateEstimate(platinumBundle({
      manualDiscount: { type: 'PERCENT', value: 5, source: 'test', eligibilityConfirmed: true },
    }));
    const pest = est.lineItems.find(i => i.service === 'pest_control');
    expect(pest.manualMarginWarning).toBeUndefined();
    // Scoped to the margin-floor warning: the program-floor warning is a
    // separate (dollar-bound) check and can fire while margin is healthy —
    // e.g. this 5% manual cut lands $0.67 under the monthly program floor.
    expect(est.marginWarnings.find(w => w.type === 'manual_discount_below_margin_floor' && w.service === 'pest_control')).toBeUndefined();
  });
});

describe('one-time pest anchors on the quarterly rate', () => {
  test('one-time anchors on quarterly basePrice even when monthly recurring is selected', () => {
    const est = generateEstimate({
      property: { footprint: 2000 },
      services: { pest: { frequency: 'monthly' }, oneTimePest: {} },
    });
    const pest = est.lineItems.find(i => i.service === 'pest_control');
    const oneTime = est.lineItems.find(i => i.service === 'one_time_pest');
    // Monthly per-app is discounted (~0.70×) but the one-time anchor must be the
    // full quarterly rate (== basePrice), not the discounted monthly per-app.
    expect(pest.perApp).toBeLessThan(pest.basePrice);
    expect(oneTime.quarterlyPerApp).toBe(pest.basePrice);
    expect(oneTime.baseSource).toBe('recurringPestPerApp');
  });

  test('one-time is strictly more than recurring visit 1 (setup + quarterly rate)', () => {
    const oneTime = priceOneTimePest({ footprint: 2000 }, {});
    const recurringVisitOne = oneTime.quarterlyPerApp + constants.PEST.initialFee;
    expect(oneTime.price).toBeGreaterThan(recurringVisitOne);
    // Pure multiple off the quarterly rate.
    expect(oneTime.price).toBe(Math.max(constants.ONE_TIME.pest.floor, Math.round(oneTime.quarterlyPerApp * constants.ONE_TIME.pest.multiplier)));
  });

  test('loyalty perk never drops one-time below recurring visit 1 (small-home clamp)', () => {
    // 1,200 sf: the multiple sits near the floor, so the 15% recurring-customer
    // perk would otherwise undercut recurring visit-1 — the clamp prevents it.
    const small = { footprint: 1200 };
    const recurring = priceOneTimePest(small, { isRecurringCustomer: true });
    const visitOne = recurring.quarterlyPerApp + constants.PEST.initialFee;
    expect(recurring.recurringIncentiveClampApplied).toBe(true);
    // Strictly above recurring visit-1 (whole-dollar prices → +1 minimal margin).
    expect(recurring.price).toBe(visitOne + 1);
    expect(recurring.price).toBeGreaterThan(visitOne);

    // Non-recurring small home is unaffected (no perk to clamp).
    const nonRecurring = priceOneTimePest(small, { isRecurringCustomer: false });
    expect(nonRecurring.recurringIncentiveClampApplied).toBe(false);
    expect(nonRecurring.price).toBeGreaterThan(visitOne);

    // A typical home clears recurring visit-1 even with the perk — no clamp.
    const typical = priceOneTimePest({ footprint: 2000 }, { isRecurringCustomer: true });
    expect(typical.recurringIncentiveClampApplied).toBe(false);
    expect(typical.price).toBeGreaterThan(typical.quarterlyPerApp + constants.PEST.initialFee);
  });
});
