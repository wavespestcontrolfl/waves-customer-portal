const {
  lawnFrequenciesFromResultStats,
  applySelectedLawnTierToEstimateData,
  buildRenderFlags,
} = require('../routes/estimate-public');

// Lawn cost-floor tiers as the engine stores them in result.results.lawn
// (6/9/12 visits = Standard/Enhanced/Premium). The builder turns these into
// the customer-facing cadence options shown in the estimate frequency slider.
function lawnEstData({ recommendedVisits = 9 } = {}) {
  return {
    results: {
      lawn: [
        { name: 'Standard', v: 6, mo: 45.5, ann: 546, pa: 91, recommended: recommendedVisits === 6 },
        { name: 'Enhanced', v: 9, mo: 66.75, ann: 801, pa: 89, recommended: recommendedVisits === 9 },
        { name: 'Premium', v: 12, mo: 89, ann: 1068, pa: 89, recommended: recommendedVisits === 12 },
      ],
    },
  };
}

describe('lawnFrequenciesFromResultStats — customer-facing lawn cadences', () => {
  test('maps the 6/9/12 tiers to Bi-monthly / Every 6 weeks / Monthly, in order', () => {
    const freqs = lawnFrequenciesFromResultStats(lawnEstData());
    expect(freqs.map((f) => [f.key, f.label, f.visitsPerYear])).toEqual([
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

  test('drops a hidden Basic (4-visit) row without stealing the Standard slot', () => {
    // Basic listed BEFORE Standard — must NOT alias onto standard and drop the
    // real 6-visit Standard row (Codex P2). Basic is excluded; Standard stays at 6.
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
    expect(freqs.map((f) => f.key)).toEqual(['standard', 'enhanced', 'premium']);
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

describe('buildRenderFlags — WaveGuard tier badge for recurring services', () => {
  const sectionFor = (category) => ({ isRecurring: true, isPest: false, category, setupFee: null, frequencies: [{ serviceCategory: category }] });

  test.each(['lawn_care', 'tree_shrub', 'termite_bait', 'mosquito'])(
    'recurring %s shows the WaveGuard tier badge (anchors at Bronze)',
    (category) => {
      const flags = buildRenderFlags({}, [sectionFor(category)], { qualifyingCount: 1 });
      expect(flags.showWaveGuardTierUi).toBe(true);
    },
  );

  test('the tier badge does NOT enable pest-only setup fee / perks / add-ons', () => {
    const flags = buildRenderFlags({}, [sectionFor('lawn_care')], { qualifyingCount: 1 });
    expect(flags.showWaveGuardSetupFee).toBe(false);
    expect(flags.showWaveGuardPerks).toBe(false);
    expect(flags.showPestRecurringAddOns).toBe(false);
  });

  test.each(['rodent_bait', 'palm_injection'])(
    'recurring %s stays excluded from the tier badge',
    (category) => {
      const flags = buildRenderFlags({}, [sectionFor(category)], { qualifyingCount: 1 });
      expect(flags.showWaveGuardTierUi).toBe(false);
    },
  );
});
