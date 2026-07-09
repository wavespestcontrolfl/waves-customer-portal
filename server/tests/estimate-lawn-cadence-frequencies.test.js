const {
  lawnFrequenciesFromResultStats,
  lawnFrequenciesFromEngineResult,
  applySelectedLawnTierToEstimateData,
  recurringLawnRowAtRetiredCadence,
  buildRenderFlags,
  sectionTierEligibleFromKeys,
} = require('../routes/estimate-public');

// Lawn cost-floor tiers as the engine stores them in result.results.lawn
// (4/6/9/12 visits = Basic/Standard/Enhanced/Premium). The builder turns
// these into the customer-facing cadence options shown in the estimate
// frequency slider.
function lawnEstData({ recommendedVisits = 9 } = {}) {
  return {
    results: {
      lawn: [
        { name: 'Basic', v: 4, mo: 35, ann: 420, pa: 105, recommended: recommendedVisits === 4 },
        { name: 'Standard', v: 6, mo: 55.5, ann: 666, pa: 111, recommended: recommendedVisits === 6 },
        { name: 'Enhanced', v: 9, mo: 66.75, ann: 801, pa: 89, recommended: recommendedVisits === 9 },
        { name: 'Premium', v: 12, mo: 89, ann: 1068, pa: 89, recommended: recommendedVisits === 12 },
      ],
    },
  };
}

describe('lawnFrequenciesFromResultStats — customer-facing lawn cadences', () => {
  test('maps the sold tiers to Bi-monthly / 9 visits / yr / Monthly and drops the retired Quarterly cadence', () => {
    // basic/Quarterly is retired for new sales (owner directive 2026-07-09) —
    // stored rows still carry it, but it must never be re-offered.
    const freqs = lawnFrequenciesFromResultStats(lawnEstData());
    expect(freqs.map((f) => [f.key, f.label, f.visitsPerYear])).toEqual([
      ['standard', 'Bi-monthly', 6],
      ['enhanced', '9 visits / yr', 9],
      ['premium', 'Monthly', 12],
    ]);
  });

  test('emits a perServiceTreatments row so the price card shows the rich per-visit detail block', () => {
    const freqs = lawnFrequenciesFromResultStats(lawnEstData());
    for (const f of freqs) {
      expect(Array.isArray(f.perServiceTreatments)).toBe(true);
      expect(f.perServiceTreatments).toHaveLength(1);
      const row = f.perServiceTreatments[0];
      expect(row.service).toBe('lawn_care');
      expect(row.label).toBe('Lawn Care');
      expect(row.visitsPerYear).toBe(f.visitsPerYear);
      expect(row.displayPrice).toBe(f.perTreatment); // per-visit price drives "$X / application"
    }
  });

  test('carries the cost-floor prices through unchanged and tags lawn_care', () => {
    const freqs = lawnFrequenciesFromResultStats(lawnEstData());
    const enhanced = freqs.find((f) => f.key === 'enhanced');
    expect(enhanced).toMatchObject({
      serviceCategory: 'lawn_care',
      monthly: 66.75,
      annual: 801,
      perTreatment: 89,
      billingFrequencyKey: 'monthly',
    });
    // No manual discount in the fixture → prices equal the base.
    expect(enhanced.monthly).toBe(enhanced.monthlyBase);
  });

  test('the recommended cadence follows the engine row (default = enhanced / 9 visits)', () => {
    const freqs = lawnFrequenciesFromResultStats(lawnEstData({ recommendedVisits: 9 }));
    expect(freqs.filter((f) => f.recommended).map((f) => f.key)).toEqual(['enhanced']);
  });

  test('honors a different recommended tier when the rep selected one', () => {
    const freqs = lawnFrequenciesFromResultStats(lawnEstData({ recommendedVisits: 12 }));
    expect(freqs.filter((f) => f.recommended).map((f) => f.key)).toEqual(['premium']);
  });

  test('returns [] when there is no lawn result', () => {
    expect(lawnFrequenciesFromResultStats({ results: {} })).toEqual([]);
    expect(lawnFrequenciesFromResultStats({})).toEqual([]);
  });

  test('a leading Basic (4-visit) row neither aliases onto Standard nor survives the retirement filter', () => {
    // Basic listed BEFORE Standard — must NOT alias onto standard and drop the
    // real 6-visit Standard row; and being retired, it must not render at all.
    const freqs = lawnFrequenciesFromResultStats({
      results: {
        lawn: [
          { name: 'Basic', v: 4, mo: 35, ann: 420, pa: 105, recommended: false },
          { name: 'Standard', v: 6, mo: 55.5, ann: 666, pa: 111, recommended: false },
          { name: 'Enhanced', v: 9, mo: 66.75, ann: 801, pa: 89, recommended: true },
          { name: 'Premium', v: 12, mo: 89, ann: 1068, pa: 89, recommended: false },
        ],
      },
    });
    expect(freqs.map((f) => f.key)).toEqual(['standard', 'enhanced', 'premium']);
    const std = freqs.find((f) => f.key === 'standard');
    expect(std.label).toBe('Bi-monthly');
    expect(std.visitsPerYear).toBe(6);
    expect(std.monthly).toBe(55.5); // the real 6-visit price, not Basic's $35
  });

  test('each cadence lists the program + treatments as included', () => {
    const std = lawnFrequenciesFromResultStats(lawnEstData()).find((f) => f.key === 'standard');
    expect(std.included.map((i) => i.key)).toEqual(['lawn_care_standard', 'lawn_care_treatments']);
    expect(std.included[0].detail).toBe('6 visits per year');
  });

  test('clamps below-floor stored rows to the $50/mo program minimum (annual/per-app re-derived)', () => {
    // Old stored estimates carry pre-floor prices (e.g. the $38/mo bi-monthly
    // bottom cell). The re-rendered ladder — which is also what accept bills —
    // must clamp them.
    const freqs = lawnFrequenciesFromResultStats({
      results: {
        lawn: [
          { name: 'Standard', v: 6, mo: 38, ann: 456, pa: 76 },
          { name: 'Enhanced', v: 9, mo: 52, ann: 624, pa: 69.33, recommended: true },
          { name: 'Premium', v: 12, mo: 60, ann: 720, pa: 60 },
        ],
      },
    });
    const std = freqs.find((f) => f.key === 'standard');
    expect(std.monthly).toBe(50);
    expect(std.annual).toBe(600);
    expect(std.perTreatment).toBe(100);
    expect(std.monthlyBase).toBe(50); // anchor never sits below the net price
    // Above-floor rows keep their stored numbers exactly.
    const enhanced = freqs.find((f) => f.key === 'enhanced');
    expect(enhanced.monthly).toBe(52);
    expect(enhanced.annual).toBe(624);
  });

  test('a manual discount cannot pull a lawn cadence below the floor, and the shown savings shrink to match', () => {
    // $52/mo enhanced with a manual $10/mo-equivalent discount would land at
    // $42 — the floor holds at $50 and the surfaced discount must only claim
    // the $2/mo the floor actually let through (never savings the price
    // doesn't reflect).
    const freqs = lawnFrequenciesFromResultStats({
      manualDiscount: { type: 'FIXED', value: 120, amount: 120, scope: 'recurring_annual_after_waveguard' },
      results: {
        lawn: [
          { name: 'Enhanced', v: 9, mo: 52, ann: 624, pa: 69.33, recommended: true },
          { name: 'Premium', v: 12, mo: 89, ann: 1068, pa: 89 },
        ],
      },
    });
    const enhanced = freqs.find((f) => f.key === 'enhanced');
    expect(enhanced.monthly).toBe(50);
    expect(enhanced.annual).toBe(600);
    expect(enhanced.manualDiscount).toMatchObject({ capped: true, capReason: 'lawn_program_minimum' });
    expect(enhanced.manualDiscount.monthlyAmount).toBe(2);
    expect(enhanced.manualDiscount.amount).toBe(24);
    // A tier far above the floor keeps the full discount.
    const premium = freqs.find((f) => f.key === 'premium');
    expect(premium.monthly).toBe(79); // 89 − 120/12
    expect(premium.manualDiscount.capReason).not.toBe('lawn_program_minimum');
  });

  test('accept backstop: a recurring lawn row still at a retired cadence is detected (explicit data only)', () => {
    const withLawnRow = (svc) => ({
      result: { recurring: { services: [{ name: 'Pest Control', service: 'pest_control', mo: 50 }, svc] } },
    });
    // Explicit 4-visit / quarterly lawn rows are flagged — the converter
    // would schedule the retired program even though the price was floored.
    expect(recurringLawnRowAtRetiredCadence(withLawnRow(
      { name: 'Lawn Care', service: 'lawn_care', mo: 45, visitsPerYear: 4 },
    ))).toBe(true);
    expect(recurringLawnRowAtRetiredCadence(withLawnRow(
      { name: 'Quarterly Lawn Care Service', service: 'lawn_care', mo: 45, frequency: 'quarterly' },
    ))).toBe(true);
    // Sold cadences pass.
    expect(recurringLawnRowAtRetiredCadence(withLawnRow(
      { name: 'Lawn Care', service: 'lawn_care', mo: 45, visitsPerYear: 6 },
    ))).toBe(false);
    // A lawn row with NO cadence data stays unflagged — never inferred as
    // quarterly by default.
    expect(recurringLawnRowAtRetiredCadence(withLawnRow(
      { name: 'Lawn Care', service: 'lawn_care', mo: 45 },
    ))).toBe(false);
    // Pest quarterly alone never trips the lawn backstop.
    expect(recurringLawnRowAtRetiredCadence({
      result: { recurring: { services: [{ name: 'Pest Control', service: 'pest_control', mo: 50, frequency: 'quarterly' }] } },
    })).toBe(false);
    // A retired cadence encoded ONLY in the label/service key is flagged too —
    // the appointment seeder schedules from the label when fields are absent.
    expect(recurringLawnRowAtRetiredCadence(withLawnRow(
      { name: 'Quarterly Lawn Care Service', service: 'lawn_care', mo: 50 },
    ))).toBe(true);
    expect(recurringLawnRowAtRetiredCadence(withLawnRow(
      { name: 'Lawn Care', service: 'lawn_care', serviceKey: 'lawn_care_quarterly', mo: 50 },
    ))).toBe(true);
    // An explicit SOLD cadence field wins over a stale quarterly label.
    expect(recurringLawnRowAtRetiredCadence(withLawnRow(
      { name: 'Quarterly Lawn Care Service', service: 'lawn_care', mo: 50, visitsPerYear: 6 },
    ))).toBe(false);
  });

  test('a manual discount fully blocked by the floor is SUPPRESSED, not just dropped', () => {
    // $50/mo standard is exactly at the floor — a $10/mo manual discount has
    // zero room. The row must carry manualDiscountSuppressed so the
    // buildPricingBundle wrapper never back-fills the raw estimate discount
    // (which would display savings the price doesn't reflect).
    const freqs = lawnFrequenciesFromResultStats({
      manualDiscount: { type: 'FIXED', value: 120, amount: 120, scope: 'recurring_annual_after_waveguard' },
      results: {
        lawn: [
          { name: 'Standard', v: 6, mo: 50, ann: 600, pa: 100, recommended: true },
        ],
      },
    });
    const std = freqs.find((f) => f.key === 'standard');
    expect(std.monthly).toBe(50);
    expect(std.annual).toBe(600);
    expect(std.manualDiscount).toBeNull();
    expect(std.manualDiscountSuppressed).toBe(true);
  });
});

describe('lawnFrequenciesFromEngineResult — engine-invocation lawn-only ladder', () => {
  // Server-authoritative / IB estimates store engineInputs, not a precomputed
  // result.results.lawn. The lawn line item the engine emits carries its tier
  // ladder (4/6/9/12), which must expand into the same cadence options instead
  // of collapsing into one Quarterly entry.
  function lawnLineItem() {
    return {
      service: 'lawn_care',
      tier: 'enhanced',
      monthly: 62.25,
      annual: 747,
      tiers: [
        { tier: 'basic', label: '4x applications/yr', monthly: 35, annual: 420, perApp: 105, visits: 4, freq: 4, recommended: false },
        { tier: 'standard', label: '6x applications/yr', monthly: 55, annual: 660, perApp: 110, visits: 6, freq: 6, recommended: false },
        { tier: 'enhanced', label: '9x applications/yr', monthly: 62.25, annual: 747, perApp: 83, visits: 9, freq: 9, recommended: true },
        { tier: 'premium', label: '12x applications/yr', monthly: 84, annual: 1008, perApp: 84, visits: 12, freq: 12, recommended: false },
      ],
    };
  }

  test('expands the lawn line item tiers into the sold cadences, in order (Quarterly retired)', () => {
    const freqs = lawnFrequenciesFromEngineResult({ lineItems: [lawnLineItem()] });
    expect(freqs.map((f) => [f.key, f.label, f.visitsPerYear, f.monthly])).toEqual([
      ['standard', 'Bi-monthly', 6, 55],
      ['enhanced', '9 visits / yr', 9, 62.25],
      ['premium', 'Monthly', 12, 84],
    ]);
    expect(freqs.find((f) => f.key === 'enhanced').selected).toBe(true);
  });

  test('returns [] for mixed bundles so lawn keeps pricing inside the pest cadence', () => {
    const mixed = {
      lineItems: [
        { service: 'pest_control', perApp: 40, monthly: 55, annual: 660 },
        lawnLineItem(),
      ],
    };
    expect(lawnFrequenciesFromEngineResult(mixed)).toEqual([]);
  });

  test('returns [] when there is no lawn line item', () => {
    expect(lawnFrequenciesFromEngineResult({ lineItems: [{ service: 'mosquito', tiers: [] }] })).toEqual([]);
    expect(lawnFrequenciesFromEngineResult({})).toEqual([]);
  });

  test('still expands the ladder when a one-time add-on rides alongside recurring lawn', () => {
    // one_time_pest aliases to pest_control via recurringServiceKey — it must be
    // dropped before the lawn-only check so the ladder is not suppressed.
    const withOneTime = {
      lineItems: [
        lawnLineItem(),
        { service: 'one_time_pest', perApp: 250 },
        { service: 'one_time_mosquito', perApp: 120 },
      ],
    };
    expect(lawnFrequenciesFromEngineResult(withOneTime).map((f) => f.key))
      .toEqual(['standard', 'enhanced', 'premium']);
  });

  test('carries the WaveGuard membership discount into every tier price, clamped at the program minimum', () => {
    // Existing-customer reprice: the engine discounted the lawn line 15%
    // (annualBeforeDiscount → annualAfterDiscount). Each tier must reflect that,
    // since accept bills selectedFrequency.monthly/annual directly — but never
    // below the $45/mo program minimum (owner directive 2026-07-09).
    const discounted = lawnLineItem();
    discounted.annualBeforeDiscount = 747; // enhanced gross annual
    discounted.annualAfterDiscount = 634.95; // 15% off
    const freqs = lawnFrequenciesFromEngineResult({ lineItems: [discounted] });
    const enhanced = freqs.find((f) => f.key === 'enhanced');
    expect(enhanced.annual).toBe(634.95); // 747 * 0.85
    expect(enhanced.monthly).toBe(52.91); // 634.95 / 12
    const std = freqs.find((f) => f.key === 'standard');
    // 660 gross * 0.85 = 561 → $46.75/mo, below the floor → clamps to $50/$600.
    expect(std.monthly).toBe(50);
    expect(std.annual).toBe(600);
    expect(std.perTreatment).toBe(100);
  });

  test('applies a manual recurring discount surfaced on the live engine summary', () => {
    // engineInputs carry a 10% manual discount the stored blob doesn't record;
    // the engine summary surfaces it. Each tier must price after that discount.
    const engineResult = {
      lineItems: [lawnLineItem()],
      summary: { manualDiscount: { type: 'PERCENT', value: 10, amount: 74.7, scope: 'recurring_annual_after_waveguard' } },
    };
    const freqs = lawnFrequenciesFromEngineResult(engineResult, {});
    const enhanced = freqs.find((f) => f.key === 'enhanced');
    expect(enhanced.manualDiscount).toBeTruthy();
    expect(enhanced.monthly).toBe(56.02); // 62.25/mo base − 6.23 (10% of 747, /12)
  });

  test('honors the accepted tier from customerSelection over the engine default', () => {
    // Stored as Enhanced but accepted as Standard: the re-rendered ladder must
    // mark Standard selected, not the engine's resolved Enhanced tier.
    const freqs = lawnFrequenciesFromEngineResult(
      { lineItems: [lawnLineItem()] },
      { customerSelection: { serviceTierKey: 'standard' } },
    );
    expect(freqs.find((f) => f.selected)).toMatchObject({ key: 'standard' });
    expect(freqs.find((f) => f.key === 'enhanced').selected).toBe(false);
  });

  test('a floor-capped selected tier keeps the requested WaveGuard discount on above-floor tiers', () => {
    // Standard (540 gross) is at the floor: Silver 10% caps back to 540, so
    // annualAfter/annualBefore reads 1 and would strip the discount from the
    // other tiers. The ladder must use the engine's requested rate instead —
    // Enhanced/Premium keep their 10% off; Standard re-clamps at the floor.
    const line = lawnLineItem();
    line.tier = 'standard';
    line.annualBeforeDiscount = 660;
    line.annualAfterDiscount = 600; // program minimum capped the Silver 10%
    line.programMinimumGuardApplied = true;
    line.requestedDiscountPct = 0.10;
    const freqs = lawnFrequenciesFromEngineResult({ lineItems: [line] });
    const std = freqs.find((f) => f.key === 'standard');
    expect(std.monthly).toBe(50); // 660 * 0.9 = 594 → floor holds at $50/$600
    const enhanced = freqs.find((f) => f.key === 'enhanced');
    expect(enhanced.annual).toBe(672.3); // 747 * 0.9 — discount preserved
    expect(enhanced.monthly).toBe(56.03);
    const premium = freqs.find((f) => f.key === 'premium');
    expect(premium.annual).toBe(907.2); // 1008 * 0.9
  });

  test('a legacy accepted Basic selection no longer resolves to a selectable cadence', () => {
    // Quarterly is retired: an old estimate accepted at Basic re-renders the
    // ladder without it (and without any selected row — the view falls back to
    // its default), so the $30/mo cadence can never be re-accepted.
    const freqs = lawnFrequenciesFromEngineResult(
      { lineItems: [lawnLineItem()] },
      { customerSelection: { serviceTierKey: 'basic' } },
    );
    expect(freqs.map((f) => f.key)).toEqual(['standard', 'enhanced', 'premium']);
    expect(freqs.find((f) => f.selected)).toBeUndefined();
  });

  test('still expands the ladder beside a specialty one-time row (rodent_trapping)', () => {
    // rodent_trapping has no recurring monthly/annual and fuzzily maps to the
    // 'rodent' family — it must not count as a second recurring service.
    const withSpecialty = {
      lineItems: [
        lawnLineItem(),
        { service: 'rodent_trapping', name: 'Rodent Trapping', price: 450, finalPrice: 450 },
      ],
    };
    expect(lawnFrequenciesFromEngineResult(withSpecialty).map((f) => f.key))
      .toEqual(['standard', 'enhanced', 'premium']);
  });

  test('still returns [] for a genuine recurring bundle (lawn + rodent_bait)', () => {
    const bundle = {
      lineItems: [
        lawnLineItem(),
        { service: 'rodent_bait', monthly: 35, annual: 420 },
      ],
    };
    expect(lawnFrequenciesFromEngineResult(bundle)).toEqual([]);
  });
});

describe('applySelectedLawnTierToEstimateData — accept re-stamps the picked cadence', () => {
  function estDataWithRecurringLawn() {
    return {
      result: {
        recurring: {
          monthlyTotal: 66.75,
          services: [{ name: 'Lawn Care', service: 'lawn_care', mo: 66.75, ann: 801, v: 9, visitsPerYear: 9 }],
        },
        results: {
          lawn: [
            { name: 'Standard', v: 6, mo: 55.5, ann: 666, pa: 111, recommended: false },
            { name: 'Enhanced', v: 9, mo: 66.75, ann: 801, pa: 89, recommended: true },
            { name: 'Premium', v: 12, mo: 89, ann: 1068, pa: 89, recommended: false },
          ],
        },
      },
    };
  }

  test('selecting Bi-monthly rewrites the recurring lawn line to 6 visits + that price', () => {
    const freq = lawnFrequenciesFromResultStats({ results: estDataWithRecurringLawn().result.results })
      .find((f) => f.key === 'standard');
    const out = applySelectedLawnTierToEstimateData(estDataWithRecurringLawn(), freq);
    const svc = out.result.recurring.services[0];
    expect(svc.visitsPerYear).toBe(6);
    expect(svc.monthly).toBe(55.5);
    expect(svc.annual).toBe(666);
    expect(svc.cadence).toBe('bi_monthly');
    expect(out.result.recurring.monthlyTotal).toBe(55.5);
    // results.lawn marks standard as the selected row
    expect(out.result.results.lawn.filter((r) => r.selected).map((r) => r.name)).toEqual(['Standard']);
  });

  test('is a no-op for a non-lawn (e.g. pest) selection', () => {
    const pestFreq = { key: 'monthly', serviceCategory: 'pest_control', monthly: 99 };
    const input = estDataWithRecurringLawn();
    expect(applySelectedLawnTierToEstimateData(input, pestFreq)).toBe(input);
  });

  test('selecting Monthly schedules 12 visits', () => {
    const freq = lawnFrequenciesFromResultStats({ results: estDataWithRecurringLawn().result.results })
      .find((f) => f.key === 'premium');
    const out = applySelectedLawnTierToEstimateData(estDataWithRecurringLawn(), freq);
    expect(out.result.recurring.services[0].visitsPerYear).toBe(12);
    expect(out.result.recurring.services[0].cadence).toBe('monthly');
  });
});

// Build a section the way buildServiceSection does: waveGuardTierEligible is the
// per-section flag derived from the section's member service keys.
const sectionWith = (key, memberKeys = [key]) => ({
  isRecurring: true,
  isPest: key === 'pest_control',
  key,
  setupFee: null,
  waveGuardTierEligible: sectionTierEligibleFromKeys(true, memberKeys),
});

describe('buildRenderFlags — estimate-wide tier UI gate (derived from per-section)', () => {
  test.each(['lawn_care', 'tree_shrub', 'termite_bait', 'mosquito'])(
    'recurring %s turns the tier UI on',
    (key) => {
      expect(buildRenderFlags({}, [sectionWith(key)], { qualifyingCount: 1 }).showWaveGuardTierUi).toBe(true);
    },
  );

  test('the tier badge does NOT enable pest-only setup fee / perks / add-ons', () => {
    const flags = buildRenderFlags({}, [sectionWith('lawn_care')], { qualifyingCount: 1 });
    expect(flags.showWaveGuardSetupFee).toBe(false);
    expect(flags.showWaveGuardPerks).toBe(false);
    expect(flags.showPestRecurringAddOns).toBe(false);
  });

  test('palm-only and rodent-only estimates keep the tier UI off', () => {
    expect(buildRenderFlags({}, [sectionWith('palm_injection')], { qualifyingCount: 1 }).showWaveGuardTierUi).toBe(false);
    expect(buildRenderFlags({}, [sectionWith('rodent_bait')], { qualifyingCount: 1 }).showWaveGuardTierUi).toBe(false);
  });

  test('a bundle with an eligible service turns the tier UI on; an excluded-only bundle does not', () => {
    expect(buildRenderFlags({}, [sectionWith('bundle', ['tree_shrub', 'palm_injection'])], { qualifyingCount: 1 }).showWaveGuardTierUi).toBe(true);
    expect(buildRenderFlags({}, [sectionWith('bundle', ['palm_injection', 'rodent_bait'])], { qualifyingCount: 1 }).showWaveGuardTierUi).toBe(false);
  });
});

describe('sectionTierEligibleFromKeys — per-section badge (single source of truth)', () => {
  test.each(['pest_control', 'lawn_care', 'tree_shrub', 'termite_bait', 'mosquito'])(
    'a single %s section is badge-eligible',
    (key) => {
      expect(sectionTierEligibleFromKeys(true, [key])).toBe(true);
    },
  );

  test('palm / rodent single sections are NOT eligible (key not in allow-list)', () => {
    expect(sectionTierEligibleFromKeys(true, ['palm_injection'])).toBe(false);
    expect(sectionTierEligibleFromKeys(true, ['rodent_bait'])).toBe(false);
  });

  test('a bundle keeps the badge iff it contains an eligible service', () => {
    expect(sectionTierEligibleFromKeys(true, ['tree_shrub', 'palm_injection'])).toBe(true);   // T&S + Palm → badge (P2a/P2b)
    expect(sectionTierEligibleFromKeys(true, ['palm_injection', 'rodent_bait'])).toBe(false);  // excluded-only bundle → no badge (Codex round-5)
  });

  test('one-time (non-recurring) sections never badge', () => {
    expect(sectionTierEligibleFromKeys(false, ['lawn_care'])).toBe(false);
  });
});
