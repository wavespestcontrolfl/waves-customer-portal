const {
  generateEstimate,
  priceOneTimePest,
  constants,
} = require('../services/pricing-engine');

// These tests exercise the pest-control margin guard and the one-time anchor.
// Several mutate `constants.PEST.base` to force a below-floor scenario, so we
// snapshot and restore it around every test.
const ORIGINAL_PEST_BASE = constants.PEST.base;
afterEach(() => {
  constants.PEST.base = ORIGINAL_PEST_BASE;
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
    expect(pest.annualAfterDiscount).toBe(pest.minAnnualForMargin);
  });

  test('guard never lifts the price above the undiscounted annual', () => {
    constants.PEST.base = 89;
    const est = generateEstimate(platinumBundle());
    const pest = est.lineItems.find(i => i.service === 'pest_control');
    expect(pest.annualAfterDiscount).toBeLessThanOrEqual(pest.annualBeforeDiscount);
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

  test('no margin warning when the manual discount stays above the floor', () => {
    const est = generateEstimate(platinumBundle({
      manualDiscount: { type: 'PERCENT', value: 5, source: 'test', eligibilityConfirmed: true },
    }));
    const pest = est.lineItems.find(i => i.service === 'pest_control');
    expect(pest.manualMarginWarning).toBeUndefined();
    expect(est.marginWarnings.find(w => w.service === 'pest_control')).toBeUndefined();
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
    expect(oneTime.recurringEntryCost).toBe(recurringVisitOne);
  });
});
