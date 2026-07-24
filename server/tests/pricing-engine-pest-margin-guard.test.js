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

  test('reports below-35% margin but never caps the discount (owner ruling 2026-07-17)', () => {
    constants.PEST.base = 89; // floor-level base → monthly + Platinum 20% dips below 35%
    // v1 replay: the v2 live-default monthly mult (0.78) keeps this fixture's
    // margin above 35% — the legacy curve still exercises the sub-35%
    // REPORTING path this test pins (never capping).
    const est = generateEstimate(platinumBundle({ services: { pest: { frequency: 'monthly', version: 'v1' }, lawn: true, mosquito: true, treeShrub: true } }));
    const pest = est.lineItems.find(i => i.service === 'pest_control');
    // The full Platinum 20% applies — no lift, no cap.
    expect(pest.marginGuardApplied).toBe(false);
    expect(pest.discountCapped).toBe(false);
    expect(pest.requestedDiscountPct).toBeCloseTo(0.2, 3);
    expect(pest.actualDiscountPct).toBeCloseTo(0.2, 3);
    expect(pest.annualAfterDiscount).toBeCloseTo(pest.annualBeforeDiscount * 0.8, 1);
    // Margins are SURFACED, never enforced: the line reports its real
    // sub-35% margin so the owner/estimator can decide to raise it.
    expect(pest.finalMargin).toBeLessThan(0.35);
    expect(pest.belowMarginFloor).toBe(true);
  });

  test('disarmed default still SURFACES the program-floor signal (reporting is unconditional)', () => {
    constants.PEST.base = 89; // monthly cadence lands at the per-visit floor
    const est = generateEstimate(platinumBundle());
    const pest = est.lineItems.find(i => i.service === 'pest_control');
    // Nothing moves the price while disarmed…
    expect(pest.marginGuardApplied).toBe(false);
    expect(pest.programFloorApplied).toBe(false);
    expect(pest.discountCapped).toBe(false);
    expect(pest.annualAfterDiscount).toBeCloseTo(pest.annualBeforeDiscount * 0.8, 1);
    // …but the comparison reports either way (codex P2 on #2827): the
    // reference floor and the below-floor flag ride the line item.
    expect(pest.belowProgramFloor).toBe(true);
    expect(pest.programFloorAnnual).toBeCloseTo(833.04, 2); // 69.42 × 12 (v2 monthly curve, live default)
    expect(pest.programFloorAnnual).toBeGreaterThan(pest.annualAfterDiscount);
  });

  test('re-arming the DB flag restores FULL enforcement at save (matches the accept clamp)', () => {
    constants.PEST.base = 89;
    constants.PEST.enforceFloorPostDiscount = true;
    const est = generateEstimate(platinumBundle());
    const pest = est.lineItems.find(i => i.service === 'pest_control');
    // The saved engine total lifts to the cadence floor — the same figure
    // estimate-public clamps the public/accept reprice to off the stamped
    // floor metadata, so save and accept agree end to end (codex P1).
    expect(pest.programFloorApplied).toBe(true);
    expect(pest.discountCapped).toBe(true);
    expect(pest.annualAfterDiscount).toBeCloseTo(833.04, 2); // floor == list at the bottom cell (v2 monthly)
    expect(pest.annualAfterDiscount).toBeLessThanOrEqual(pest.annualBeforeDiscount);
    expect(pest.belowProgramFloor).toBe(false); // lifted to the floor
    expect(pest.actualDiscountPct).toBeCloseTo(0, 3);
    // Margin-floor enforcement stays retired even when the pest flag is on.
    expect(pest.marginGuardApplied).toBe(false);
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

  test('Platinum on a floor-level quarterly keeps its full discount (floor disarmed)', () => {
    constants.PEST.base = 89; // basePrice clamps to the $89 list bottom at 2,000 sf
    const est = generateEstimate(bundleWithPestFrequency('quarterly'));
    const pest = est.lineItems.find(i => i.service === 'pest_control');
    expect(est.waveGuard.tier).toBe('platinum');
    // List: floor × 1.00 × 4 = $356; the 20% discount applies in full —
    // the old floor would have suppressed it entirely.
    expect(pest.annualBeforeDiscount).toBeCloseTo(356, 2);
    expect(pest.programFloorApplied).toBe(false);
    expect(pest.annualAfterDiscount).toBeCloseTo(284.80, 2);
    expect(pest.actualDiscountPct).toBeCloseTo(0.2, 3);
    expect(pest.discountCapped).toBe(false);
  });

  test('bimonthly at the list bottom also keeps its full discount', () => {
    constants.PEST.base = 89;
    const est = generateEstimate(bundleWithPestFrequency('bimonthly'));
    const pest = est.lineItems.find(i => i.service === 'pest_control');
    // List: floor × 0.88 × 6 = $469.92 (v2 cadence curve is the live engine
    // default); Platinum 20% collects $375.94 — nothing lifts it back.
    expect(pest.annualBeforeDiscount).toBeCloseTo(469.92, 2);
    expect(pest.programFloorApplied).toBe(false);
    expect(pest.annualAfterDiscount).toBeCloseTo(375.94, 2);
  });

  test('cents-tuned DB floor: the floor annual uses the rounded per-visit basis (disarmed report)', () => {
    // pricePestControl rounds the per-app amount BEFORE annualizing, so the
    // floor must too: round(89.99 × 0.88) = 79.19 → $475.14/yr, exactly the
    // list annual (codex P3 rounding contract). Disarmed: report-only.
    constants.PEST.base = 89.99;
    constants.PEST.floor = 89.99;
    const est = generateEstimate(bundleWithPestFrequency('bimonthly'));
    const pest = est.lineItems.find(i => i.service === 'pest_control');
    expect(pest.annualBeforeDiscount).toBeCloseTo(475.14, 2);
    expect(pest.programFloorAnnual).toBeCloseTo(475.14, 2);
    expect(pest.programFloorApplied).toBe(false);
    expect(pest.annualAfterDiscount).toBeCloseTo(380.11, 2);
    expect(pest.belowProgramFloor).toBe(true);
  });

  test('cents-tuned DB floor: re-armed enforcement lifts exactly to the list annual, never above', () => {
    // Same rounding contract under enforcement: the lift lands on 475.14
    // (floor == list at this cell), so Math.min(lifted, originalAnnual)
    // cannot report the floor as applied at a price below it.
    constants.PEST.base = 89.99;
    constants.PEST.floor = 89.99;
    constants.PEST.enforceFloorPostDiscount = true;
    const est = generateEstimate(bundleWithPestFrequency('bimonthly'));
    const pest = est.lineItems.find(i => i.service === 'pest_control');
    expect(pest.annualBeforeDiscount).toBeCloseTo(475.14, 2);
    expect(pest.programFloorAnnual).toBeCloseTo(475.14, 2);
    expect(pest.programFloorApplied).toBe(true);
    expect(pest.discountCapped).toBe(true);
    expect(pest.annualAfterDiscount).toBeCloseTo(475.14, 2);
    expect(pest.belowProgramFloor).toBe(false);
    expect(pest.actualDiscountPct).toBeCloseTo(0, 3);
  });

  test('discounts above the floor are untouched — modal-priced quarterly keeps full Platinum 20%', () => {
    // Default base ($117): quarterly annual $468, Platinum collects $374.40,
    // still above the $356 program floor.
    const est = generateEstimate(bundleWithPestFrequency('quarterly'));
    const pest = est.lineItems.find(i => i.service === 'pest_control');
    expect(pest.programFloorApplied).toBe(false);
    expect(pest.annualAfterDiscount).toBeCloseTo(468 * 0.8, 2);
  });

  test('pest-floor manual-discount warning reports in BOTH states and never caps', () => {
    constants.PEST.base = 89;
    const input = bundleWithPestFrequency('quarterly', {
      manualDiscount: { type: 'PERCENT', value: 10, source: 'test', eligibilityConfirmed: true },
    });
    // Disarmed default: the warn-only comparison reports anyway — signals
    // are independent of the enforcement kill switch (codex P2 on #2827).
    const disarmed = generateEstimate(input);
    const disarmedPest = disarmed.lineItems.find(i => i.service === 'pest_control');
    expect(disarmedPest.manualPestFloorWarning).toBe(true);
    const disarmedWarning = disarmed.marginWarnings.find(w => w.type === 'manual_discount_below_pest_program_floor');
    expect(disarmedWarning).toBeTruthy();
    expect(disarmedWarning.programFloorAnnual).toBeCloseTo(356, 2);
    expect(disarmedWarning.finalAnnual).toBeLessThan(356);
    // Nothing is capped while disarmed (the WaveGuard 20% + manual 10% stand).
    expect(disarmed.summary.manualDiscount.amount).toBeGreaterThan(0);
    expect(disarmed.summary.manualDiscount.capped).toBe(false);

    // Re-armed flag: WaveGuard enforcement lifts the pest line, but manual
    // owner discounts stay warn-only (deliberate loss-leader override) —
    // the warning still fires and the manual amount is not reduced.
    constants.PEST.enforceFloorPostDiscount = true;
    const est = generateEstimate(input);
    const pest = est.lineItems.find(i => i.service === 'pest_control');
    expect(pest.programFloorApplied).toBe(true); // WaveGuard lift back at the floor
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
