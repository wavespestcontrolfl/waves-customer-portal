const {
  lawnFrequenciesFromResultStats,
  lawnFrequenciesFromEngineResult,
  applySelectedLawnTierToEstimateData,
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
        { name: 'Standard', v: 6, mo: 45.5, ann: 546, pa: 91, recommended: recommendedVisits === 6 },
        { name: 'Enhanced', v: 9, mo: 66.75, ann: 801, pa: 89, recommended: recommendedVisits === 9 },
        { name: 'Premium', v: 12, mo: 89, ann: 1068, pa: 89, recommended: recommendedVisits === 12 },
      ],
    },
  };
}

describe('lawnFrequenciesFromResultStats — customer-facing lawn cadences', () => {
  test('maps the 4/6/9/12 tiers to Quarterly / Bi-monthly / Every 6 weeks / Monthly, in order', () => {
    const freqs = lawnFrequenciesFromResultStats(lawnEstData());
    expect(freqs.map((f) => [f.key, f.label, f.visitsPerYear])).toEqual([
      ['basic', 'Quarterly', 4],
      ['standard', 'Bi-monthly', 6],
      ['enhanced', 'Every 6 weeks', 9],
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

  test('the recommended cadence follows the engine row (default = Every 6 weeks / 9)', () => {
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

  test('keeps Basic (4-visit) distinct without stealing the Standard slot', () => {
    // Basic listed BEFORE Standard — must NOT alias onto standard and drop the
    // real 6-visit Standard row. Basic is sold separately at 4 visits.
    const freqs = lawnFrequenciesFromResultStats({
      results: {
        lawn: [
          { name: 'Basic', v: 4, mo: 35, ann: 420, pa: 105, recommended: false },
          { name: 'Standard', v: 6, mo: 45.5, ann: 546, pa: 91, recommended: false },
          { name: 'Enhanced', v: 9, mo: 66.75, ann: 801, pa: 89, recommended: true },
          { name: 'Premium', v: 12, mo: 89, ann: 1068, pa: 89, recommended: false },
        ],
      },
    });
    expect(freqs.map((f) => f.key)).toEqual(['basic', 'standard', 'enhanced', 'premium']);
    const basic = freqs.find((f) => f.key === 'basic');
    expect(basic.label).toBe('Quarterly');
    expect(basic.visitsPerYear).toBe(4);
    expect(basic.monthly).toBe(35);
    const std = freqs.find((f) => f.key === 'standard');
    expect(std.label).toBe('Bi-monthly');
    expect(std.visitsPerYear).toBe(6);
    expect(std.monthly).toBe(45.5); // the real 6-visit price, not Basic's $35
  });

  test('each cadence lists the program + treatments as included', () => {
    const std = lawnFrequenciesFromResultStats(lawnEstData()).find((f) => f.key === 'standard');
    expect(std.included.map((i) => i.key)).toEqual(['lawn_care_standard', 'lawn_care_treatments']);
    expect(std.included[0].detail).toBe('6 visits per year');
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
        { tier: 'standard', label: '6x applications/yr', monthly: 45, annual: 540, perApp: 90, visits: 6, freq: 6, recommended: false },
        { tier: 'enhanced', label: '9x applications/yr', monthly: 62.25, annual: 747, perApp: 83, visits: 9, freq: 9, recommended: true },
        { tier: 'premium', label: '12x applications/yr', monthly: 84, annual: 1008, perApp: 84, visits: 12, freq: 12, recommended: false },
      ],
    };
  }

  test('expands the lawn line item tiers into all four cadences, in order', () => {
    const freqs = lawnFrequenciesFromEngineResult({ lineItems: [lawnLineItem()] });
    expect(freqs.map((f) => [f.key, f.label, f.visitsPerYear, f.monthly])).toEqual([
      ['basic', 'Quarterly', 4, 35],
      ['standard', 'Bi-monthly', 6, 45],
      ['enhanced', 'Every 6 weeks', 9, 62.25],
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
      .toEqual(['basic', 'standard', 'enhanced', 'premium']);
  });

  test('carries the WaveGuard membership discount into every tier price', () => {
    // Existing-customer reprice: the engine discounted the lawn line 15%
    // (annualBeforeDiscount → annualAfterDiscount). Each tier must reflect that,
    // since accept bills selectedFrequency.monthly/annual directly.
    const discounted = lawnLineItem();
    discounted.annualBeforeDiscount = 747; // enhanced gross annual
    discounted.annualAfterDiscount = 634.95; // 15% off
    const freqs = lawnFrequenciesFromEngineResult({ lineItems: [discounted] });
    const enhanced = freqs.find((f) => f.key === 'enhanced');
    expect(enhanced.annual).toBe(634.95); // 747 * 0.85
    expect(enhanced.monthly).toBe(52.91); // 634.95 / 12
    const basic = freqs.find((f) => f.key === 'basic');
    expect(basic.monthly).toBe(29.75); // 420 gross * 0.85 / 12
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
    // Stored as Enhanced but accepted as Basic: the re-rendered ladder must mark
    // Basic selected, not the engine's resolved Enhanced tier.
    const freqs = lawnFrequenciesFromEngineResult(
      { lineItems: [lawnLineItem()] },
      { customerSelection: { serviceTierKey: 'basic' } },
    );
    expect(freqs.find((f) => f.selected)).toMatchObject({ key: 'basic' });
    expect(freqs.find((f) => f.key === 'enhanced').selected).toBe(false);
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
      .toEqual(['basic', 'standard', 'enhanced', 'premium']);
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
            { name: 'Standard', v: 6, mo: 45.5, ann: 546, pa: 91, recommended: false },
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
    expect(svc.monthly).toBe(45.5);
    expect(svc.annual).toBe(546);
    expect(svc.cadence).toBe('bi_monthly');
    expect(out.result.recurring.monthlyTotal).toBe(45.5);
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
