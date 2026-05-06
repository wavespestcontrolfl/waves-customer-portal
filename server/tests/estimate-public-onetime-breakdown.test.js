const {
  buildPricingBundle,
  isStructuralOneTimeOnlyEstimate,
  normalizeOneTimeBreakdown,
  resolveAcceptOneTimeTotal,
} = require('../routes/estimate-public');

function savedAdminEstimateData() {
  return {
    result: {
      results: {
        pestTiers: [
          { label: 'Quarterly', mo: 50, ann: 600, pa: 150, apps: 4 },
        ],
      },
      recurring: {
        discount: 0,
        monthlyTotal: 50,
        annualAfterDiscount: 600,
        services: [{ name: 'Pest Control', mo: 50 }],
      },
      oneTime: {
        total: 2084,
        membershipFee: 99,
        tmInstall: 240,
        items: [
          { service: 'pest_initial_roach', name: 'Initial Roach Knockdown', price: 119 },
          { service: 'one_time_pest', name: 'One-Time Pest', price: 171, detail: 'Interior + exterior' },
        ],
      },
      specItems: [
        {
          service: 'rodent_sanitation',
          name: 'Rodent Sanitation',
          price: 1555,
          det: 'Heavy - 420 min | 1200 sf affected',
        },
        {
          service: 'rodent_bundle_discount',
          name: 'Rodent Bundle Discount',
          price: -100,
          det: 'Trap sanitation bundle savings',
        },
      ],
    },
  };
}

describe('public estimate one-time breakdown', () => {
  test('normalizes saved one-time and specialty rows including first-visit roach fees', () => {
    const breakdown = normalizeOneTimeBreakdown(savedAdminEstimateData());

    expect(breakdown.items).toEqual([
      expect.objectContaining({
        service: 'pest_initial_roach',
        label: 'Initial Roach Knockdown',
        amount: 119,
        kind: 'charge',
      }),
      expect.objectContaining({
        service: 'one_time_pest',
        label: 'One-Time Pest',
        amount: 171,
        kind: 'charge',
      }),
      expect.objectContaining({
        service: 'waveguard_setup',
        label: 'WaveGuard setup',
        amount: 99,
        kind: 'charge',
      }),
      expect.objectContaining({
        service: 'termite_bait_installation',
        label: 'Termite bait installation',
        amount: 240,
        kind: 'charge',
      }),
      expect.objectContaining({
        service: 'rodent_sanitation',
        label: 'Rodent Sanitation',
        amount: 1555,
        detail: 'Heavy - 420 min | 1200 sf affected',
      }),
      expect.objectContaining({
        service: 'rodent_bundle_discount',
        label: 'Rodent Bundle Discount',
        amount: -100,
        kind: 'discount',
      }),
    ]);
    expect(breakdown.total).toBe(2084);
  });

  test('reconciles explicit one-time totals when stored rows are incomplete', () => {
    const breakdown = normalizeOneTimeBreakdown({
      result: {
        oneTime: {
          total: 400,
          items: [{ service: 'one_time_pest', name: 'One-Time Pest', price: 250 }],
        },
      },
    });

    expect(breakdown.items).toContainEqual(expect.objectContaining({
      service: 'one_time_adjustment',
      label: 'Other one-time services',
      amount: 150,
    }));
    expect(breakdown.total).toBe(400);
  });

  test('does not duplicate termite installation already present in one-time rows', () => {
    const breakdown = normalizeOneTimeBreakdown({
      result: {
        oneTime: {
          total: 500,
          tmInstall: 500,
          items: [{ name: 'Trelona Installation', price: 500, detail: '20 stations' }],
        },
      },
    });

    expect(breakdown.items.filter((item) => item.amount === 500)).toHaveLength(1);
    expect(breakdown.items.some((item) => item.service === 'one_time_adjustment')).toBe(false);
    expect(breakdown.total).toBe(500);
  });

  test('infers roach service key for legacy name-only rows', () => {
    const breakdown = normalizeOneTimeBreakdown({
      result: {
        oneTime: {
          total: 119,
          items: [{ name: 'Initial Roach Knockdown', price: 119 }],
        },
      },
    });

    expect(breakdown.items).toContainEqual(expect.objectContaining({
      service: 'pest_initial_roach',
      label: 'Initial Roach Knockdown',
      amount: 119,
    }));
  });

  test('normalizes nested legacy result one-time rows', () => {
    const breakdown = normalizeOneTimeBreakdown({
      result: {
        results: {
          oneTime: {
            total: 325,
            items: [{ service: 'one_time_pest', name: 'One-Time Pest', price: 200 }],
            specItems: [{ service: 'stinging_insect', name: 'Stinging Insect', price: 125 }],
          },
        },
      },
    });

    expect(breakdown.items).toEqual([
      expect.objectContaining({ service: 'one_time_pest', amount: 200 }),
      expect.objectContaining({ service: 'stinging_insect', amount: 125 }),
    ]);
    expect(breakdown.total).toBe(325);
  });

  test('normalizes engineResult-only one-time line items', () => {
    const breakdown = normalizeOneTimeBreakdown({
      engineResult: {
        lineItems: [
          { service: 'pest_control', label: 'Pest Control', annual: 600 },
          { service: 'one_time_pest', label: 'One-Time Pest', priceAfterDiscount: 149 },
          { service: 'rodent_sanitation', label: 'Rodent Sanitation', totalAfterDiscount: 425 },
          {
            service: 'rodent_bundle_discount',
            label: 'Rodent Bundle Discount',
            price: -75,
            priceAfterDiscount: 0,
          },
        ],
      },
    });

    expect(breakdown.items).toEqual([
      expect.objectContaining({ service: 'one_time_pest', amount: 149 }),
      expect.objectContaining({ service: 'rodent_sanitation', amount: 425 }),
      expect.objectContaining({ service: 'rodent_bundle_discount', amount: -75, kind: 'discount' }),
    ]);
    expect(breakdown.total).toBe(499);
  });

  test('uses nonzero discounted negative line item amounts', () => {
    const breakdown = normalizeOneTimeBreakdown({
      engineResult: {
        lineItems: [
          {
            service: 'rodent_bundle_discount',
            label: 'Rodent Bundle Discount',
            price: -100,
            priceAfterDiscount: -85,
          },
        ],
      },
    });

    expect(breakdown.items).toContainEqual(expect.objectContaining({
      service: 'rodent_bundle_discount',
      amount: -85,
      kind: 'discount',
    }));
    expect(breakdown.total).toBe(-85);
  });

  test('filters specialty rows that are included on a recurring program', () => {
    const breakdown = normalizeOneTimeBreakdown({
      result: {
        oneTime: { total: 125 },
        specItems: [
          { service: 'stinging_insect', name: 'Wasp/Bee', price: 100, onProg: true },
          { service: 'flea_package', name: 'Flea Package', price: 125, onProg: false },
        ],
      },
    });

    expect(breakdown.items).toEqual([
      expect.objectContaining({ service: 'flea_package', amount: 125 }),
    ]);
    expect(breakdown.total).toBe(125);
  });

  test('normalizes engine line-item installation charges', () => {
    const breakdown = normalizeOneTimeBreakdown({
      engineResult: {
        lineItems: [
          {
            service: 'termite_bait',
            name: 'Termite Bait',
            annual: 420,
            installation: { price: 611 },
            stations: 22,
          },
        ],
      },
    });

    expect(breakdown.items).toContainEqual(expect.objectContaining({
      service: 'termite_bait_installation',
      label: 'Termite Bait installation',
      amount: 611,
      detail: '22 stations',
    }));
    expect(breakdown.total).toBe(611);
  });

  test('includes the breakdown in the public pricing bundle for saved admin estimates', async () => {
    const payload = await buildPricingBundle({
      id: 'estimate-public-onetime-breakdown-test',
      estimate_data: savedAdminEstimateData(),
      onetime_total: 2084,
      waveguard_tier: 'Bronze',
    });

    expect(payload.source).toBe('v1_engine_shape');
    expect(payload.anchorOneTimePrice).toBe(2084);
    expect(payload.firstVisitFees).toContainEqual(expect.objectContaining({
      service: 'pest_initial_roach',
      label: 'Initial Roach Knockdown',
      amount: 119,
      waivedWithPrepay: false,
    }));
    expect(payload.firstVisitFees).toContainEqual(expect.objectContaining({
      service: 'waveguard_setup',
      label: 'WaveGuard setup',
      amount: 99,
      waivedWithPrepay: true,
    }));
    expect(payload.oneTimeBreakdown.items).toContainEqual(expect.objectContaining({
      service: 'rodent_sanitation',
      label: 'Rodent Sanitation',
      amount: 1555,
    }));
    expect(payload.oneTimeBreakdown.items).toContainEqual(expect.objectContaining({
      service: 'pest_initial_roach',
      label: 'Initial Roach Knockdown',
      amount: 119,
    }));
  });

  test('builds breakdown from generated engine results when only engine inputs are saved', async () => {
    const payload = await buildPricingBundle({
      id: 'estimate-public-engine-generated-breakdown-test',
      estimate_data: {
        engineInputs: {
          propertyType: 'single_family',
          homeSqFt: 1800,
          lotSqFt: 7000,
          stories: 1,
          serviceZone: 'A',
          nearWater: 'NO',
          features: {},
          services: {
            oneTimePest: { urgency: 'NONE', afterHours: false },
          },
        },
      },
      onetime_total: 0,
      waveguard_tier: 'Bronze',
    });

    expect(payload.source).toBe('engine_invocation');
    expect(payload.anchorOneTimePrice).toBeGreaterThan(0);
    expect(payload.oneTimeBreakdown.items).toContainEqual(expect.objectContaining({
      service: 'one_time_pest',
      amount: payload.anchorOneTimePrice,
    }));
    expect(payload.oneTimeBreakdown.total).toBe(payload.anchorOneTimePrice);
  });

  test('detects nested legacy one-time-only estimates for acceptance flow', () => {
    const oneTimeOnly = {
      result: {
        results: {
          oneTime: {
            total: 200,
            items: [{ service: 'one_time_pest', name: 'One-Time Pest', price: 200 }],
          },
        },
      },
    };

    expect(isStructuralOneTimeOnlyEstimate(oneTimeOnly, { monthly_total: 0, annual_total: 0 })).toBe(true);
  });

  test('does not treat recurring estimates with first-visit fees as one-time-only', () => {
    expect(isStructuralOneTimeOnlyEstimate(savedAdminEstimateData(), {
      monthly_total: 50,
      annual_total: 600,
    })).toBe(false);
  });

  test('detects top-level specialty-only estimates as one-time-only', () => {
    const specialtyOnly = {
      result: {
        specItems: [{ service: 'rodent_sanitation', name: 'Rodent Sanitation', price: 650 }],
      },
    };

    expect(isStructuralOneTimeOnlyEstimate(specialtyOnly, { monthly_total: 0, annual_total: 0 })).toBe(true);
  });

  test('acceptance one-time total prefers live pricing over stale stored totals', () => {
    expect(resolveAcceptOneTimeTotal(
      { onetime_total: 0 },
      { anchorOneTimePrice: 249, oneTimeBreakdown: { total: 249 } },
    )).toBe(249);
  });

  test('acceptance one-time total falls back to breakdown and stored amount', () => {
    expect(resolveAcceptOneTimeTotal(
      { onetime_total: 199 },
      { anchorOneTimePrice: null, oneTimeBreakdown: { total: 275 } },
    )).toBe(275);

    expect(resolveAcceptOneTimeTotal(
      { onetime_total: 199 },
      { anchorOneTimePrice: null, oneTimeBreakdown: { total: 0 } },
    )).toBe(199);
  });
});
