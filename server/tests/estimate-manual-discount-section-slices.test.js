// Per-service manual-discount slices on split multi-service plans (owner
// ruling 2026-08-03, EST-2026-0609): a PERCENT credit scoped to the recurring
// annual renders INSIDE each service section — pct × that line's WaveGuard-net
// per-application price — instead of only as the figure-less plan-level card.
// FIXED credits and every capped/suppressed/mixed-scope shape keep the plan
// card (a static per-row slice of a FIXED amount would be a number no cadence
// honors — codex #3128 r4).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
// DARK feature (flip blocker: multi-service accept/invoice math must apply
// the same slices — owner decision). Tests exercise the gated-ON behavior.
process.env.GATE_ESTIMATE_SECTION_DISCOUNT_SLICES = 'true';

const {
  buildPricingBundle,
  stampPerServiceManualDiscountSlices,
  planCreditFirstVisitSlice,
} = require('../routes/estimate-public');

const round2 = (n) => Math.round(Number(n) * 100) / 100;

// Same prod-shaped Silver pest+lawn fixture family as
// estimate-referral-multiservice-split.test.js (numbers verbatim, identity
// synthetic).
function silverPestLawn({ discount } = {}) {
  const est = {
    id: `estimate-${Math.random().toString(36).slice(2)}`,
    status: 'draft',
    monthly_total: 84.08,
    annual_total: 1008.90,
    onetime_total: 99,
    waveguard_tier: 'Silver',
    estimate_data: {
      inputs: {
        svcPest: true, svcLawn: true, pestFreq: '4', lawnFreq: '9',
        grassType: 'st_augustine', homeSqFt: '2309', lotSqFt: '9423',
        stories: '1', isCommercial: 'NO', customerName: 'Section Slice',
        address: '123 Rounding Way, Parrish, FL 34219',
      },
      result: {
        hasRecurring: true,
        hasOneTime: true,
        manualDiscount: null,
        totals: { year1: 1107.9, year2: 1008.9, year2mo: 84.08, manualDiscount: null },
        oneTime: { items: [], total: 99, membershipFee: 99 },
        recurring: {
          tier: 'Silver', waveGuardTier: 'Silver', discount: 0.1, serviceCount: 2,
          monthlyTotal: 84.08, grandTotal: 84.08,
          annualBeforeDiscount: 1121, annualAfterDiscount: 1008.9,
          services: [
            {
              name: 'Lawn Care', service: 'lawn_care', mo: 57.75, monthly: 57.75,
              perTreatment: 77, visitsPerYear: 9, grassType: 'St. Augustine',
              discountable: true, discountEligible: true,
              waveGuardDiscountEligible: true, countsTowardWaveGuardTier: true,
            },
            {
              name: 'Pest Control', service: 'pest_control', mo: 35.67, monthly: 35.67,
              basePrice: 107, perTreatment: 107, visitsPerYear: 4,
            },
          ],
        },
        results: {
          pestTiers: [
            { label: 'Quarterly', mo: 35.67, pa: 107, ann: 428, apps: 4, init: 99, recommended: true },
            { label: 'Bi-Monthly', mo: 45.48, pa: 90.95, ann: 545.7, apps: 6, init: 99 },
            { label: 'Monthly', mo: 74.9, pa: 74.9, ann: 898.8, apps: 12, init: 99 },
          ],
          lawn: [
            { name: '6x applications/yr', v: 6, mo: 50, pa: 100, ann: 600, dimmed: true },
            { name: '9x applications/yr', v: 9, mo: 57.75, pa: 77, ann: 693, recommended: true },
            { name: '12x applications/yr', v: 12, mo: 79, pa: 79, ann: 948, dimmed: true },
          ],
        },
      },
    },
  };
  if (discount) {
    est.estimate_data.result.manualDiscount = discount;
    est.estimate_data.result.totals.manualDiscount = discount;
  }
  return est;
}

function percentCredit(overrides = {}) {
  return {
    source: 'custom', presetKey: 'custom_percent',
    catalogName: 'Custom Percentage Discount', label: 'Custom Percentage Discount',
    type: 'PERCENT', value: 5,
    // Engine-normalized amounts are recomputed by the payload build; these are
    // the stored draft's snapshot of the default combo.
    amount: 50.45, recurringAmount: 50.45, oneTimeAmount: 0,
    scope: 'recurring_annual_after_waveguard', stackingOrder: 'after_waveguard',
    ...overrides,
  };
}

function fixedReferral() {
  return {
    source: 'catalog_preset', presetKey: 'referral', catalogName: 'Referral Credit',
    label: 'Referral Credit', type: 'FIXED', value: 25,
    amount: 25, recurringAmount: 25, oneTimeAmount: 0,
    scope: 'recurring_annual_after_waveguard', stackingOrder: 'after_waveguard',
  };
}

describe('PERCENT plan credit itemizes into every split section (owner 2026-08-03)', () => {
  let bundle;
  beforeAll(async () => {
    bundle = await buildPricingBundle(silverPestLawn({ discount: percentCredit() }));
  });

  test('the plan still splits and the render flag tells the client to skip the plan card', () => {
    expect(bundle.services.map((s) => s.key)).toEqual(['pest_control', 'lawn_care']);
    expect(bundle.renderFlags.manualDiscountItemizedInSections).toBe(true);
  });

  test('every section frequency carries its own slice, netted into the row price', () => {
    for (const section of bundle.services) {
      for (const frequency of section.frequencies) {
        const md = frequency.manualDiscount;
        expect(md).toMatchObject({
          type: 'PERCENT',
          value: 5,
          label: 'Custom Percentage Discount',
          itemizedPerService: true,
        });
        expect(md.recurringAmount).toBeGreaterThan(0);
        expect(md.oneTimeAmount).toBe(0);
      }
    }
  });

  test('slices are exactly pct × the WaveGuard-net per-application price', async () => {
    const preCredit = await buildPricingBundle(silverPestLawn({ discount: null }));
    for (const section of bundle.services) {
      const before = preCredit.services.find((s) => s.key === section.key);
      for (const frequency of section.frequencies) {
        const beforeRow = before.frequencies.find((f) => f.key === frequency.key);
        const beforePerApp = Number(beforeRow.perServiceTreatments?.[0]?.displayPrice ?? beforeRow.perTreatment);
        const perAppSlice = round2(beforePerApp * 0.05);
        const netPerApp = Number(frequency.perServiceTreatments?.[0]?.displayPrice ?? frequency.perTreatment);
        expect(netPerApp).toBeCloseTo(round2(beforePerApp - perAppSlice), 2);
        // The slice annual is the per-application slice × that row's visits.
        const visits = Number(frequency.visitsPerYear)
          || Number(frequency.perServiceTreatments?.[0]?.visitsPerYear);
        expect(frequency.manualDiscount.recurringAmount).toBeCloseTo(round2(perAppSlice * visits), 2);
        // Anchors stay pre-discount so the card can still show the full story.
        expect(frequency.perVisit ?? null).toEqual(beforeRow.perVisit ?? null);
        expect(frequency.monthlyBase ?? null).toEqual(beforeRow.monthlyBase ?? null);
      }
    }
  });

  test('default-selection slices rebuild the combined plan credit (reconciliation)', () => {
    const combinedDefault = bundle.frequencies.find((f) => f.key === 'quarterly');
    const planCredit = Number(combinedDefault.manualDiscount.recurringAmount);
    let sliceSum = 0;
    let visitSum = 0;
    for (const section of bundle.services) {
      const def = section.frequencies.find((f) => f.key === section.defaultFrequencyKey)
        || section.frequencies[0];
      sliceSum += Number(def.manualDiscount.recurringAmount);
      visitSum += Number(def.visitsPerYear) || Number(def.perServiceTreatments?.[0]?.visitsPerYear) || 12;
    }
    // Same rounding budget as the stamper: each per-application slice
    // cent-rounds by ≤ $0.005, amplified by that row's visit count.
    expect(Math.abs(round2(sliceSum) - planCredit)).toBeLessThanOrEqual(0.005 * visitSum + 0.02);
  });

  test('combined (accept-facing) totals are untouched by the display stamping', async () => {
    const preCredit = await buildPricingBundle(silverPestLawn({ discount: null }));
    const withCredit = bundle.frequencies.find((f) => f.key === 'quarterly');
    const without = preCredit.frequencies.find((f) => f.key === 'quarterly');
    // The combined monthly already nets the credit once — stamping must not
    // change it (double-count) or the accept payload would drift.
    expect(withCredit.monthly).toBeLessThan(without.monthly);
    // Monthly round-trips through cent rounding (annual/12), so allow the
    // rebuilt annual a few cents of drift.
    expect(Math.abs(
      withCredit.manualDiscount.recurringAmount - round2((without.monthly - withCredit.monthly) * 12),
    )).toBeLessThanOrEqual(0.06);
  });
});

describe('shapes that cannot slice keep the plan-level card', () => {
  test('FIXED referral credit stays plan-level (codex #3128 r4 semantics preserved)', async () => {
    const bundle = await buildPricingBundle(silverPestLawn({ discount: fixedReferral() }));
    expect(bundle.renderFlags.manualDiscountItemizedInSections).toBeUndefined();
    const pest = bundle.services.find((s) => s.key === 'pest_control');
    expect(pest.frequencies.every((f) => !f.manualDiscount)).toBe(true);
  });

  test('no credit at all: no flag, no slices', async () => {
    const bundle = await buildPricingBundle(silverPestLawn({ discount: null }));
    expect(bundle.renderFlags.manualDiscountItemizedInSections).toBeUndefined();
    expect(bundle.services.every((s) => s.frequencies.every((f) => !f.manualDiscount))).toBe(true);
  });
});

describe('stampPerServiceManualDiscountSlices guards (direct)', () => {
  const baseMd = () => ({
    type: 'PERCENT', value: 5, label: 'Custom Percentage Discount',
    amount: 43.38, recurringAmount: 43.38, oneTimeAmount: 0,
    scope: 'recurring_annual_after_waveguard',
    eligibleServices: ['pest_control', 'lawn_care_enhanced'],
    excludedServices: [],
  });
  const sections = () => ([
    {
      key: 'pest_control', isRecurring: true, defaultFrequencyKey: 'quarterly',
      frequencies: [{ key: 'quarterly', perTreatment: 90, perVisit: 100, monthly: 30, annual: 360, visitsPerYear: 4, perServiceTreatments: [] }],
    },
    {
      key: 'lawn_care', isRecurring: true, defaultFrequencyKey: 'enhanced',
      frequencies: [{
        key: 'enhanced', monthly: 42.3, annual: 507.6, monthlyBase: 47,
        perServiceTreatments: [{ service: 'lawn_care', perTreatment: 56.4, displayPrice: 56.4, visitsPerYear: 9 }],
      }],
    },
  ]);
  // Combined cadence rows carry the per-row treatment composition the
  // accept-side slice bills from — the stamper requires it (display and
  // billing must slice the same shapes).
  const combinedTreatments = () => ([
    { service: 'pest_control', perTreatment: 100, displayPrice: 90, visitsPerYear: 4 },
    { service: 'lawn_care', perTreatment: 62.67, displayPrice: 56.4, visitsPerYear: 9 },
  ]);
  const payload = (md, extra = {}) => ({
    manualDiscount: md,
    frequencies: [{
      key: 'quarterly',
      manualDiscount: md ? { ...md } : null,
      perServiceTreatments: combinedTreatments(),
    }],
    ...extra,
  });

  test('gate off: never stamps, never mutates (dark until accept math aligns)', () => {
    const services = sections();
    const before = JSON.stringify(services);
    const prior = process.env.GATE_ESTIMATE_SECTION_DISCOUNT_SLICES;
    try {
      delete process.env.GATE_ESTIMATE_SECTION_DISCOUNT_SLICES;
      expect(stampPerServiceManualDiscountSlices(services, payload(baseMd()))).toBe(false);
      expect(JSON.stringify(services)).toBe(before);
    } finally {
      process.env.GATE_ESTIMATE_SECTION_DISCOUNT_SLICES = prior;
    }
  });

  test('stamps the EST-2026-0609 shape: 5% of $90 and $56.40', () => {
    const services = sections();
    expect(stampPerServiceManualDiscountSlices(services, payload(baseMd()))).toBe(true);
    expect(services[0].frequencies[0].perTreatment).toBe(85.5);
    expect(services[0].frequencies[0].manualDiscount.recurringAmount).toBe(18);
    expect(services[1].frequencies[0].perServiceTreatments[0].displayPrice).toBe(53.58);
    expect(services[1].frequencies[0].manualDiscount.recurringAmount).toBe(25.38);
    // Anchors untouched.
    expect(services[0].frequencies[0].perVisit).toBe(100);
    expect(services[1].frequencies[0].monthlyBase).toBe(47);
  });

  test.each([
    ['FIXED type', { type: 'FIXED' }],
    ['capped', { capped: true }],
    ['cap reason', { capReason: 'discountable_base' }],
    ['floor breach', { floorBreach: { acknowledged: true } }],
    ['one-time slice', { oneTimeAmount: 10, scope: 'recurring_and_one_time_after_waveguard' }],
  ])('bails without mutating on %s', (_label, override) => {
    const services = sections();
    const before = JSON.stringify(services);
    expect(stampPerServiceManualDiscountSlices(services, payload(baseMd(), { manualDiscount: { ...baseMd(), ...override } }))).toBe(false);
    expect(JSON.stringify(services)).toBe(before);
  });

  test.each([
    ['a cadence credit with a one-time portion', { oneTimeAmount: 12 }],
    ['a cadence credit with zero recurring amount', { amount: 0, recurringAmount: 0 }],
    ['a cadence with no credit at all', null],
  ])('bails without mutating when a combined cadence carries %s', (_label, rowOverride) => {
    const services = sections();
    const md = baseMd();
    const before = JSON.stringify(services);
    const p = {
      manualDiscount: md,
      frequencies: [
        { key: 'quarterly', manualDiscount: { ...md } },
        { key: 'monthly', manualDiscount: rowOverride ? { ...md, ...rowOverride } : null },
      ],
    };
    expect(stampPerServiceManualDiscountSlices(services, p)).toBe(false);
    expect(JSON.stringify(services)).toBe(before);
  });

  test('bails when a cadence suppresses or caps the credit', () => {
    const services = sections();
    const md = baseMd();
    const p = {
      manualDiscount: md,
      frequencies: [
        { key: 'quarterly', manualDiscount: { ...md } },
        { key: 'monthly', manualDiscountSuppressed: true },
      ],
    };
    expect(stampPerServiceManualDiscountSlices(services, p)).toBe(false);
    expect(services[0].frequencies[0].manualDiscount).toBeUndefined();
  });

  test('bails on a single-service plan (its ladder already nets the credit)', () => {
    const services = [sections()[0]];
    expect(stampPerServiceManualDiscountSlices(services, payload(baseMd()))).toBe(false);
  });

  test('bails when the default slices cannot rebuild the plan credit', () => {
    const services = sections();
    const md = { ...baseMd(), amount: 99, recurringAmount: 99 };
    expect(stampPerServiceManualDiscountSlices(services, payload(md))).toBe(false);
    expect(services[0].frequencies[0].manualDiscount).toBeUndefined();
  });

  test('an excluded service keeps its rows untouched while eligible ones slice', () => {
    const services = sections();
    const md = {
      ...baseMd(),
      // Only lawn eligible; pest excluded. Reconciliation must then expect
      // only lawn's slice.
      amount: 25.38, recurringAmount: 25.38,
      eligibleServices: ['lawn_care_enhanced'],
      excludedServices: ['pest_control'],
    };
    expect(stampPerServiceManualDiscountSlices(services, payload(md))).toBe(true);
    expect(services[0].frequencies[0].manualDiscount).toBeUndefined();
    expect(services[0].frequencies[0].perTreatment).toBe(90);
    expect(services[1].frequencies[0].manualDiscount.recurringAmount).toBe(25.38);
  });
});

describe('planCreditFirstVisitSlice — accept-side mirror (owner GO 2026-08-04)', () => {
  // The SELECTED combined cadence at accept, EST-2026-0609 shape: pest
  // quarterly $90 + lawn enhanced $56.40 per application (WaveGuard-net,
  // pre-credit rows), net annual carries the 5% credit.
  const acceptedFrequency = (overrides = {}) => ({
    key: 'quarterly',
    monthly: 68.68,
    annual: 824.16,
    manualDiscount: {
      type: 'PERCENT', value: 5, label: 'Custom Percentage Discount',
      amount: 43.38, recurringAmount: 43.38, oneTimeAmount: 0,
      scope: 'recurring_annual_after_waveguard',
      eligibleServices: ['pest_control', 'lawn_care_enhanced'],
      excludedServices: [],
    },
    perServiceTreatments: [
      { service: 'pest_control', perTreatment: 100, displayPrice: 90, visitsPerYear: 4 },
      { service: 'lawn_care', perTreatment: 62.67, displayPrice: 56.4, visitsPerYear: 9 },
    ],
    sameDayTreatmentTotal: 162.67,
    ...overrides,
  });

  test('slices the first visit exactly: 5% of $90 + 5% of $56.40 = $7.32', () => {
    const slice = planCreditFirstVisitSlice(acceptedFrequency());
    expect(slice).toEqual({ label: 'Custom Percentage Discount', firstVisitSlice: 7.32 });
  });

  test('gate-independent: billing honors the credit under either presentation (codex #3185 r6)', () => {
    // The gate flips the DISPLAY only. With it off the page shows the
    // plan-level card ("applied when you book") — netting the first invoice
    // delivers that promise, and a mid-flight kill-switch flip can never
    // move an accepted amount upward.
    const prior = process.env.GATE_ESTIMATE_SECTION_DISCOUNT_SLICES;
    try {
      delete process.env.GATE_ESTIMATE_SECTION_DISCOUNT_SLICES;
      expect(planCreditFirstVisitSlice(acceptedFrequency()))
        .toEqual({ label: 'Custom Percentage Discount', firstVisitSlice: 7.32 });
    } finally {
      process.env.GATE_ESTIMATE_SECTION_DISCOUNT_SLICES = prior;
    }
  });

  test.each([
    ['FIXED type', { manualDiscount: { type: 'FIXED', value: 25, amount: 25, recurringAmount: 25, label: 'Referral Credit' } }],
    ['capped credit', null],
    ['one-time slice', null],
    ['suppressed cadence', { manualDiscountSuppressed: true }],
  ])('bails on %s', (label, overrides) => {
    let frequency;
    if (label === 'capped credit') {
      frequency = acceptedFrequency();
      frequency.manualDiscount.capped = true;
    } else if (label === 'one-time slice') {
      frequency = acceptedFrequency();
      frequency.manualDiscount.oneTimeAmount = 10;
      frequency.manualDiscount.scope = 'recurring_and_one_time_after_waveguard';
    } else {
      frequency = acceptedFrequency(overrides);
    }
    expect(planCreditFirstVisitSlice(frequency)).toBeNull();
  });

  test("a combo's own persisted credit object is the authority (codex #3185 r7)", () => {
    // Combos carry their per-combo shapeFromV1 credit; the accept overlay
    // replaces the stale base object with it. Rows: pest 90×4 + lawn premium
    // 49.41×12 → slices 4.50×4 + 2.47×12 = 47.64 = the combo's own credit.
    const comboFrequency = (mdOverrides = {}) => acceptedFrequency({
      annual: 905.28,
      monthly: 75.44,
      manualDiscount: {
        type: 'PERCENT', value: 5, label: 'Custom Percentage Discount',
        amount: 47.64, recurringAmount: 47.64, oneTimeAmount: 0,
        scope: 'recurring_annual_after_waveguard',
        eligibleServices: ['pest_control', 'lawn_care_premium'],
        excludedServices: [],
        ...mdOverrides,
      },
      perServiceTreatments: [
        { service: 'pest_control', perTreatment: 100, displayPrice: 90, visitsPerYear: 4 },
        { service: 'lawn_care', perTreatment: 54.9, displayPrice: 49.41, visitsPerYear: 12 },
      ],
    });
    expect(planCreditFirstVisitSlice(comboFrequency()))
      .toEqual({ label: 'Custom Percentage Discount', firstVisitSlice: 6.97 });
    // A floor-capped combo credit differs by real dollars — refused exactly,
    // no tolerance to hide inside (r7 P0).
    expect(planCreditFirstVisitSlice(comboFrequency({ amount: 47.5, recurringAmount: 47.5, capped: true, capReason: 'lawn_program_minimum' })))
      .toBeNull();
    // Even uncapped, a granted amount that is not the full percentage slice
    // fails the exact reconciliation.
    expect(planCreditFirstVisitSlice(comboFrequency({ amount: 47.0, recurringAmount: 47.0 })))
      .toBeNull();
    // A legacy snapshot combo resolves manualDiscount to null at the accept
    // overlay — no credit object, no slice.
    expect(planCreditFirstVisitSlice({ ...comboFrequency(), manualDiscount: null })).toBeNull();
  });

  test('bails when neither the credit object nor the net-annual diff reconciles', () => {
    // Net annual pretends a much larger credit than 5% of the rows explains.
    const drifted = acceptedFrequency({ annual: 700 });
    drifted.manualDiscount.recurringAmount = 99;
    drifted.manualDiscount.amount = 99;
    expect(planCreditFirstVisitSlice(drifted)).toBeNull();
  });

  test('an excluded service bills full price — only eligible rows slice', () => {
    const frequency = acceptedFrequency();
    frequency.manualDiscount.eligibleServices = ['lawn_care_enhanced'];
    frequency.manualDiscount.excludedServices = ['pest_control'];
    frequency.manualDiscount.amount = 25.38;
    frequency.manualDiscount.recurringAmount = 25.38;
    const slice = planCreditFirstVisitSlice(frequency);
    expect(slice).toEqual({ label: 'Custom Percentage Discount', firstVisitSlice: 2.82 });
  });
});

describe('codex #3185 P1 regressions — preference bases and flat-monthly members', () => {
  const gateOnFrequency = () => ({
    key: 'quarterly',
    monthly: 68.68,
    annual: 824.16,
    manualDiscount: {
      type: 'PERCENT', value: 5, label: 'Custom Percentage Discount',
      amount: 43.38, recurringAmount: 43.38, oneTimeAmount: 0,
      scope: 'recurring_annual_after_waveguard',
      eligibleServices: ['pest_control', 'lawn_care_enhanced'],
      excludedServices: [],
    },
    perServiceTreatments: [
      { service: 'pest_control', perTreatment: 100, displayPrice: 90, visitsPerYear: 4 },
      { service: 'lawn_care', perTreatment: 62.67, displayPrice: 56.4, visitsPerYear: 9 },
    ],
  });

  test('an opt-out preference does not shrink the plan-credit slice (pre-preference base)', () => {
    // interior_spray off = a separate $10/visit preference credit; the 5%
    // plan credit was computed on the pre-preference base, so the slice is
    // still 5% of $90 + 5% of $56.40 = $7.32 and reconciliation holds.
    const slice = planCreditFirstVisitSlice(gateOnFrequency(), {
      preferences: { interior_spray: false },
    });
    expect(slice).toEqual({ label: 'Custom Percentage Discount', firstVisitSlice: 7.32 });
  });

  test('a flat-monthly member row bails BOTH surfaces: no accept slice…', () => {
    const frequency = gateOnFrequency();
    frequency.perServiceTreatments.push({ service: 'termite_bait', monthly: 35 });
    expect(planCreditFirstVisitSlice(frequency)).toBeNull();
  });

  test('…and no section stamping (the plan-level card stays)', () => {
    const services = [
      {
        key: 'pest_control', isRecurring: true, defaultFrequencyKey: 'quarterly',
        frequencies: [{ key: 'quarterly', perTreatment: 90, perVisit: 100, monthly: 30, annual: 360, visitsPerYear: 4, perServiceTreatments: [] }],
      },
      {
        key: 'termite_bait', isRecurring: true, defaultFrequencyKey: 'recurring',
        frequencies: [{ key: 'recurring', monthly: 35, annual: 420 }],
      },
    ];
    const md = {
      type: 'PERCENT', value: 5, label: 'Custom Percentage Discount',
      amount: 39, recurringAmount: 39, oneTimeAmount: 0,
      scope: 'recurring_annual_after_waveguard',
      eligibleServices: ['pest_control', 'termite_bait'], excludedServices: [],
    };
    const p = {
      manualDiscount: md,
      frequencies: [{
        key: 'quarterly',
        manualDiscount: { ...md },
        // The termite member row has no per-treatment price — the accept
        // slice cannot bill it per row, so the display must not slice either.
        perServiceTreatments: [
          { service: 'pest_control', perTreatment: 100, displayPrice: 90, visitsPerYear: 4 },
          { service: 'termite_bait', monthly: 35 },
        ],
      }],
    };
    const before = JSON.stringify(services);
    expect(stampPerServiceManualDiscountSlices(services, p)).toBe(false);
    expect(JSON.stringify(services)).toBe(before);
  });
});

describe('codex #3185 r2 regressions — combo+preference reconciliation and overshoot slices', () => {
  const comboWithStaleCredit = (annual) => ({
    key: 'quarterly',
    annual,
    manualDiscount: {
      type: 'PERCENT', value: 5, label: 'Custom Percentage Discount',
      // Stale BASE-combo credit object (combo overlays keep it).
      amount: 43.38, recurringAmount: 43.38, oneTimeAmount: 0,
      scope: 'recurring_annual_after_waveguard',
      eligibleServices: ['pest_control', 'lawn_care_premium'],
      excludedServices: [],
    },
    perServiceTreatments: [
      { service: 'pest_control', perTreatment: 100, displayPrice: 90, visitsPerYear: 4 },
      { service: 'lawn_care', perTreatment: 54.9, displayPrice: 49.41, visitsPerYear: 12 },
    ],
  });

  test('combo + preference opt-out: the pref-blind credit object still reconciles', () => {
    // The combo's own credit object and the pre-preference slice bases are
    // both preference-blind, so an opt-out changes neither side of the
    // reconciliation — the customer keeps the full slice on top of the
    // separate preference credit.
    const combo = comboWithStaleCredit(865.28);
    combo.manualDiscount = {
      ...combo.manualDiscount,
      amount: 47.64, recurringAmount: 47.64,
    };
    const slice = planCreditFirstVisitSlice(combo, {
      preferences: { interior_spray: false },
    });
    expect(slice).toEqual({ label: 'Custom Percentage Discount', firstVisitSlice: 6.97 });
  });

  test('a slice that fully comps the first visit is refused (zero net cannot thread the fallbacks)', () => {
    // A 100% comp credit nets the first visit to exactly $0 — a zero/negative
    // netted amount would persist into estimated_price and the
    // falsy-fallback consumers (visitEstimatedPrice, invoice-mode's amount
    // resolver) would then charge a POSITIVE cadence amount instead. Refuse
    // the slice; the accept keeps the pre-credit story.
    const frequency = {
      key: 'quarterly',
      annual: 0.01,
      manualDiscount: {
        type: 'PERCENT', value: 100, label: 'Full Comp',
        amount: 328, recurringAmount: 328, oneTimeAmount: 0,
        scope: 'recurring_annual_after_waveguard',
        eligibleServices: [], excludedServices: [],
      },
      perServiceTreatments: [
        { service: 'pest_control', perTreatment: 24, displayPrice: 22, visitsPerYear: 4 },
        { service: 'lawn_care', perTreatment: 22, displayPrice: 20, visitsPerYear: 12 },
      ],
    };
    expect(planCreditFirstVisitSlice(frequency)).toBeNull();
  });
});

describe('codex #3185 r3 — the display flag never authorizes an unsliceable combo', () => {
  test('one combo with an unpriceable member row keeps the whole plan on the plan card', () => {
    const services = [
      {
        key: 'pest_control', isRecurring: true, defaultFrequencyKey: 'quarterly',
        frequencies: [{ key: 'quarterly', perTreatment: 90, perVisit: 100, monthly: 30, annual: 360, visitsPerYear: 4, perServiceTreatments: [] }],
      },
      {
        key: 'lawn_care', isRecurring: true, defaultFrequencyKey: 'enhanced',
        frequencies: [{
          key: 'enhanced', monthly: 42.3, annual: 507.6, monthlyBase: 47,
          perServiceTreatments: [{ service: 'lawn_care', perTreatment: 56.4, displayPrice: 56.4, visitsPerYear: 9 }],
        }],
      },
    ];
    const md = {
      type: 'PERCENT', value: 5, label: 'Custom Percentage Discount',
      amount: 43.38, recurringAmount: 43.38, oneTimeAmount: 0,
      scope: 'recurring_annual_after_waveguard',
      eligibleServices: ['pest_control', 'lawn_care_enhanced'], excludedServices: [],
    };
    const rows = [
      { service: 'pest_control', perTreatment: 100, displayPrice: 90, visitsPerYear: 4 },
      { service: 'lawn_care', perTreatment: 62.67, displayPrice: 56.4, visitsPerYear: 9 },
    ];
    const p = {
      manualDiscount: md,
      frequencies: [{ key: 'quarterly', manualDiscount: { ...md }, perServiceTreatments: rows }],
      serviceCadenceCombos: [
        // Sliceable combo carrying its OWN credit object (r7): slices
        // 4.50×4 + 2.82×9 = 43.38 reconcile exactly.
        { key: 'lawn_care:enhanced|pest_control:quarterly', annual: 824.22, perServiceTreatments: rows, manualDiscount: { ...md } },
        // A selectable combo whose lawn row has no per-treatment price —
        // the accept slice would refuse it, so the flag must not be set.
        {
          key: 'lawn_care:legacy|pest_control:quarterly',
          perServiceTreatments: [
            { service: 'pest_control', perTreatment: 100, displayPrice: 90, visitsPerYear: 4 },
            { service: 'lawn_care', monthly: 40 },
          ],
        },
      ],
    };
    const before = JSON.stringify(services);
    expect(stampPerServiceManualDiscountSlices(services, p)).toBe(false);
    expect(JSON.stringify(services)).toBe(before);
    // Same payload with only sliceable combos stamps fine.
    const p2 = { ...p, serviceCadenceCombos: [p.serviceCadenceCombos[0]] };
    expect(stampPerServiceManualDiscountSlices(services, p2)).toBe(true);
  });
});

describe('codex #3185 r8 — combo credit state fully replaces the base row state', () => {
  test('a base-cadence suppression does not veto a combo that grants its own credit', () => {
    // Mirror of the accept overlay spread: base row floor-suppressed, combo
    // carries its own valid credit — the combo's state wins on BOTH fields.
    const base = {
      key: 'quarterly',
      annual: 1000,
      manualDiscount: null,
      manualDiscountSuppressed: true,
      perServiceTreatments: [],
    };
    const combo = {
      annual: 905.28,
      perServiceTreatments: [
        { service: 'pest_control', perTreatment: 100, displayPrice: 90, visitsPerYear: 4 },
        { service: 'lawn_care', perTreatment: 54.9, displayPrice: 49.41, visitsPerYear: 12 },
      ],
      manualDiscount: {
        type: 'PERCENT', value: 5, label: 'Custom Percentage Discount',
        amount: 47.64, recurringAmount: 47.64, oneTimeAmount: 0,
        scope: 'recurring_annual_after_waveguard',
        eligibleServices: [], excludedServices: [],
      },
    };
    const overlaid = {
      ...base,
      annual: combo.annual,
      perServiceTreatments: combo.perServiceTreatments,
      manualDiscount: combo.manualDiscount ?? null,
      manualDiscountSuppressed: combo.manualDiscountSuppressed === true,
    };
    expect(planCreditFirstVisitSlice(overlaid))
      .toEqual({ label: 'Custom Percentage Discount', firstVisitSlice: 6.97 });
    // And the inverse: a combo's own suppression blocks even with a live
    // base credit inherited nowhere.
    const suppressedOverlay = { ...overlaid, manualDiscountSuppressed: true };
    expect(planCreditFirstVisitSlice(suppressedOverlay)).toBeNull();
  });
});
