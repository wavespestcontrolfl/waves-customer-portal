const {
  buildPricingBundle,
  pricingBundleHasStaleTermiteRow,
  pricingBundleMissingRequiredSetupFee,
} = require('../routes/estimate-public');

// A pest + mosquito + termite-bait bundle in the v1 (admin) shape — Gold tier
// (3 qualifying services → 15% off). Numbers mirror a real prod draft
// (identity swapped): pest quarterly $110/app, mosquito monthly12 $66/mo,
// termite Advance monitoring $35/mo flat.
//
// Termite bait monitoring has NO per-visit price — before this fix the split
// validator required displayPrice × visits on every row, so any bundle with a
// termite line collapsed into the single combined-price card: no per-service
// sections, no mosquito program selector, and the monitoring charge was in
// the total but rendered nowhere ("invisible line item").
function pestMosquitoTermiteEstimate() {
  return {
    id: `estimate-${Math.random().toString(36).slice(2)}`,
    status: 'draft',
    monthly_total: 117.02,
    annual_total: 1404.2,
    onetime_total: 738,
    waveguard_tier: 'Gold',
    estimate_data: {
      inputs: {
        svcPest: true, svcMosquito: true, svcTermiteBait: true,
        pestFreq: '4', mosquitoProgram: 'monthly12',
        homeSqFt: '1998', lotSqFt: '10017', stories: '1',
        isCommercial: 'NO', customerName: 'Termite Split',
        address: '123 Monitoring Way, Sarasota, FL 34235',
      },
      result: {
        hasRecurring: true,
        hasOneTime: true,
        manualDiscount: null,
        totals: { year1: 2142.2, year2: 1404.2, year2mo: 117.02, manualDiscount: null },
        oneTime: {
          items: [
            {
              name: 'Advance Installation', price: 639,
              detail: '23 stations · 223 linear ft perimeter',
              service: 'termite_bait_installation',
            },
          ],
          total: 738,
          membershipFee: 99,
        },
        recurring: {
          tier: 'Gold',
          waveGuardTier: 'Gold',
          discount: 0.15,
          serviceCount: 3,
          monthlyTotal: 117.02,
          grandTotal: 117.02,
          annualBeforeDiscount: 1652,
          annualAfterDiscount: 1404.2,
          services: [
            {
              name: 'Pest Control', service: 'pest_control', mo: 36.67, monthly: 36.67,
              perTreatment: 110, visitsPerYear: 4,
            },
            {
              name: 'Mosquito', service: 'mosquito', mo: 66, monthly: 66,
              displayName: 'Monthly Mosquito Program (12 visits)',
              perTreatment: 66, visitsPerYear: 12,
            },
            // Flat monthly monitoring — deliberately NO perTreatment/visits.
            {
              name: 'Termite Bait', service: 'termite_bait', mo: 35, monthly: 35,
            },
          ],
        },
        results: {
          pestTiers: [
            { label: 'Quarterly', mo: 36.67, pa: 110, ann: 440, apps: 4, init: 99, floorMo: 26.33, floorPa: 79, floorAnn: 316, recommended: true },
            { label: 'Bi-Monthly', mo: 46.75, pa: 93.5, ann: 561, apps: 6, init: 99, floorMo: 33.57, floorPa: 67.15, floorAnn: 402.9 },
            { label: 'Monthly', mo: 77, pa: 77, ann: 924, apps: 12, init: 99, floorMo: 55.3, floorPa: 55.3, floorAnn: 663.6 },
          ],
          mq: [
            { n: 'Seasonal Mosquito Program (9 visits)', v: 9, mo: 54.75, pv: 73, ann: 657, recommended: true, selected: false },
            { n: 'Monthly Mosquito Program (12 visits)', v: 12, mo: 66, pv: 66, ann: 792, recommended: false, selected: true },
          ],
          tmBait: {
            system: 'advance', selectedSystem: 'advance', ai: 639, bmo: 35, pmo: 65,
            sta: 23, perim: 223, monitoringTier: 'basic', quoteRequired: false,
            requiresMeasurement: false,
          },
        },
      },
    },
  };
}

describe('termite-bait bundles split into per-service sections (buildPricingBundle e2e)', () => {
  test('pest + mosquito + termite splits, with the monitoring charge as its own visible section', async () => {
    const bundle = await buildPricingBundle(pestMosquitoTermiteEstimate());
    const keys = bundle.services.map((s) => s.key);
    expect(keys).toContain('pest_control');
    expect(keys).toContain('mosquito');
    expect(keys).toContain('termite_bait');
    expect(bundle.services).toHaveLength(3);

    // Pest keeps its cadence ladder with NET per-application pricing
    // (110 → 93.50 at Gold 15%).
    const pest = bundle.services.find((s) => s.key === 'pest_control');
    expect(pest.frequencies.map((f) => f.key)).toEqual(['quarterly', 'bi_monthly', 'monthly']);
    expect(pest.frequencies[0].perTreatment).toBeCloseTo(93.5, 2);
    expect(pest.frequencies[0].perVisit).toBeCloseTo(110, 2);
    expect(pest.waveGuardTierEligible).toBe(true);
    // The $99 WaveGuard setup applies to solo pest / solo mosquito plans only
    // (owner directive 2026-07-10 evening) — this bundle carries NO setup fee.
    expect(pest.setupFee).toBeNull();

    // Mosquito gets its own program ladder (seasonal9 / monthly12), defaulting
    // to the stored selection, with net per-application prices (66 → 56.10).
    const mosquito = bundle.services.find((s) => s.key === 'mosquito');
    expect(mosquito.frequencies.map((f) => f.key)).toEqual(['seasonal9', 'monthly12']);
    expect(mosquito.defaultFrequencyKey).toBe('monthly12');
    const monthly12 = mosquito.frequencies.find((f) => f.key === 'monthly12');
    expect(monthly12.perTreatment).toBeCloseTo(56.1, 2);
    const seasonal9 = mosquito.frequencies.find((f) => f.key === 'seasonal9');
    expect(seasonal9.perTreatment).toBeCloseTo(62.05, 2);
    expect(mosquito.waveGuardTierEligible).toBe(true);
    expect(mosquito.setupFee).toBeNull();

    // Termite monitoring renders as a flat-monthly section: $35 base →
    // $29.75 net of the Gold 15%. Stations are checked quarterly (owner
    // directive 2026-07-10) so the entry carries per-check display pricing
    // (29.75×12/4 = $89.25/check, 4 checks/yr) while billing stays monthly.
    // It's part of the WaveGuard recurring plan → badge-eligible.
    const termite = bundle.services.find((s) => s.key === 'termite_bait');
    expect(termite.label).toBe('Termite Bait Monitoring');
    expect(termite.frequencies).toHaveLength(1);
    expect(termite.frequencies[0].monthly).toBeCloseTo(29.75, 2);
    expect(termite.frequencies[0].monthlyBase).toBeCloseTo(35, 2);
    expect(termite.frequencies[0].perTreatment).toBeCloseTo(89.25, 2);
    expect(termite.frequencies[0].visitsPerYear).toBe(4);
    expect(termite.waveGuardTierEligible).toBe(true);
    expect(termite.setupFee).toBeNull();
  });

  test('mosquito is a combo axis and the default combo reproduces the stored total', async () => {
    const bundle = await buildPricingBundle(pestMosquitoTermiteEstimate());
    // 3 pest cadences × 2 mosquito programs.
    expect(bundle.serviceCadenceCombos).toHaveLength(6);
    const defaultCombo = bundle.serviceCadenceCombos.find(
      (c) => c.key === 'mosquito:monthly12|pest_control:quarterly',
    );
    // 31.17 pest + 56.10 mosquito + 29.75 termite monitoring = 117.02
    expect(defaultCombo.monthly).toBeCloseTo(117.02, 2);
    // Swapping mosquito to seasonal re-prices through the same path:
    // 31.17 + 46.54 + 29.75 = 107.46.
    const seasonalCombo = bundle.serviceCadenceCombos.find(
      (c) => c.key === 'mosquito:seasonal9|pest_control:quarterly',
    );
    expect(seasonalCombo.monthly).toBeCloseTo(107.46, 2);
    // Every combo carries the termite monitoring monthly on its rows so the
    // split view can always account for the full charge.
    const termiteRow = (defaultCombo.perServiceTreatments || []).find((r) => r.service === 'termite_bait');
    expect(termiteRow).toBeTruthy();
    expect(termiteRow.monthly).toBeCloseTo(29.75, 2);
    expect(termiteRow.monthlyBase).toBeCloseTo(35, 2);
  });
});

describe('solo termite-bait estimates (no pest, no mosquito)', () => {
  // A monitoring-only estimate has no cadence ladder of its own, so the v1
  // build falls back to a pest-shaped quarterly entry. The section must
  // still render the flat-monthly plan as per-check pricing with monthly
  // billing — never "$105/quarter".
  function soloTermiteEstimate() {
    return {
      id: `estimate-${Math.random().toString(36).slice(2)}`,
      status: 'draft',
      monthly_total: 35,
      annual_total: 420,
      onetime_total: 639,
      waveguard_tier: 'Bronze',
      estimate_data: {
        inputs: {
          svcTermiteBait: true,
          homeSqFt: '1998', lotSqFt: '10017', stories: '1',
          isCommercial: 'NO', customerName: 'Solo Termite',
          address: '123 Monitoring Way, Sarasota, FL 34235',
        },
        result: {
          hasRecurring: true,
          hasOneTime: true,
          totals: { year1: 1059, year2: 420, year2mo: 35 },
          oneTime: {
            items: [{
              name: 'Advance Installation', price: 639,
              detail: '23 stations · 223 linear ft perimeter',
              service: 'termite_bait_installation',
            }],
            total: 639,
          },
          recurring: {
            tier: 'Bronze',
            discount: 0,
            serviceCount: 1,
            monthlyTotal: 35,
            grandTotal: 35,
            annualAfterDiscount: 420,
            services: [{ name: 'Termite Bait', service: 'termite_bait', mo: 35, monthly: 35 }],
          },
          results: {
            pestTiers: [],
            tmBait: {
              system: 'advance', selectedSystem: 'advance', ai: 639, bmo: 35, pmo: 65,
              sta: 23, perim: 223, monitoringTier: 'basic', quoteRequired: false,
              requiresMeasurement: false,
            },
          },
        },
      },
    };
  }

  test('renders per-check pricing with monthly billing, not a quarterly price', async () => {
    const bundle = await buildPricingBundle(soloTermiteEstimate());
    const termite = bundle.services.find((s) => s.key === 'termite_bait');
    expect(termite).toBeTruthy();
    const entry = termite.frequencies[0];
    expect(entry.key).toBe('recurring');
    expect(entry.monthly).toBeCloseTo(35, 2);
    // Per-check display pricing: $35/mo × 12 ÷ 4 checks = $105/check.
    expect(entry.perTreatment).toBeCloseTo(105, 2);
    expect(entry.visitsPerYear).toBe(4);
  });
});

describe('legacy no-engine fallback setup fee', () => {
  // Solo mosquito estimates with NO v1 shape and NO engine inputs fall back
  // to stored totals — the accept path still invoices the $99 setup, so the
  // fallback payload must show the fee card and lift the one-time anchor
  // (the stored totals were created before the fee rule).
  test('solo mosquito legacy estimate shows the fee card and lifted anchor', async () => {
    const bundle = await buildPricingBundle({
      id: `estimate-${Math.random().toString(36).slice(2)}`,
      status: 'sent',
      monthly_total: 66,
      annual_total: 792,
      onetime_total: 0,
      waveguard_tier: 'Bronze',
      // Root-level recurring, no result/engineResult wrapper and no engine
      // inputs — the shape that misses readV1Shape and the engine branch.
      estimate_data: {
        recurring: {
          services: [{ name: 'Mosquito', service: 'mosquito', mo: 66, monthly: 66 }],
        },
      },
    });
    expect(bundle.fallback).toBe('no_engine_inputs');
    const fee = (bundle.firstVisitFees || []).find((f) => f.service === 'waveguard_setup');
    expect(fee).toBeTruthy();
    expect(fee.amount).toBeCloseTo(99, 2);
    expect(fee.waivedWithPrepay).toBe(true);
  });

  test('a non-qualifying legacy mix gets no fee card', async () => {
    const bundle = await buildPricingBundle({
      id: `estimate-${Math.random().toString(36).slice(2)}`,
      status: 'sent',
      monthly_total: 120,
      annual_total: 1440,
      onetime_total: 0,
      waveguard_tier: 'Silver',
      estimate_data: {
        recurring: {
          services: [
            { name: 'Mosquito', service: 'mosquito', mo: 66, monthly: 66 },
            { name: 'Tree & Shrub', service: 'tree_shrub', mo: 54, monthly: 54 },
          ],
        },
      },
    });
    expect(bundle.fallback).toBe('no_engine_inputs');
    expect((bundle.firstVisitFees || []).find((f) => f.service === 'waveguard_setup')).toBeFalsy();
  });
});

describe('stale-snapshot bypass guards', () => {
  // Snapshots frozen before the split: the termite row has neither a
  // per-visit price nor `monthly`, so the fast path would keep serving the
  // legacy combined card with the monitoring charge invisible.
  test('a pre-split send snapshot recomputes instead of fast-pathing', async () => {
    const estimate = pestMosquitoTermiteEstimate();
    estimate.estimate_data.sendSnapshot = {
      pricingBundle: {
        source: 'send_snapshot',
        frequencies: [{
          key: 'recurring',
          monthly: 117.02,
          annual: 1404.2,
          perServiceTreatments: [
            { service: 'pest_control', displayPrice: 93.5, visitsPerYear: 4 },
            { service: 'mosquito', displayPrice: 56.1, visitsPerYear: 12 },
            // Pre-split shape: flat-monthly monitoring with NO monthly stamp.
            { service: 'termite_bait', name: 'Termite Bait' },
          ],
        }],
      },
    };
    const bundle = await buildPricingBundle(estimate);
    expect(bundle.snapshotHit).not.toBe(true);
    // The recompute splits into per-service sections with the monitoring
    // charge visible, exactly like a fresh build.
    expect(bundle.services.map((s) => s.key)).toContain('termite_bait');
    const termite = bundle.services.find((s) => s.key === 'termite_bait');
    expect(termite.frequencies[0].monthly).toBeCloseTo(29.75, 2);
  });

  test('pricingBundleHasStaleTermiteRow flags only monthly-less, visitless termite rows', () => {
    const stale = {
      frequencies: [{ perServiceTreatments: [{ service: 'termite_bait' }] }],
    };
    expect(pricingBundleHasStaleTermiteRow(stale)).toBe(true);
    const monthlyStamped = {
      frequencies: [{ perServiceTreatments: [{ service: 'termite_bait', monthly: 29.75 }] }],
    };
    expect(pricingBundleHasStaleTermiteRow(monthlyStamped)).toBe(false);
    const perVisitPriced = {
      frequencies: [{ perServiceTreatments: [{ service: 'termite_bait', displayPrice: 89.25, visitsPerYear: 4 }] }],
    };
    expect(pricingBundleHasStaleTermiteRow(perVisitPriced)).toBe(false);
    // Sections and combos are traversed too.
    const staleInService = {
      services: [{ frequencies: [{ perServiceTreatments: [{ service: 'termite_bait' }] }] }],
    };
    expect(pricingBundleHasStaleTermiteRow(staleInService)).toBe(true);
    expect(pricingBundleHasStaleTermiteRow({ frequencies: [] })).toBe(false);
  });

  // Solo pest / solo mosquito plans snapshotted before the 2026-07-10 fee
  // rule show no $99 WaveGuard setup but the accept path invoices it — the
  // guard forces those bundles off the fast paths so the page and the
  // invoice always agree.
  const soloMosquitoEstData = () => ({
    result: {
      recurring: {
        services: [{ name: 'Mosquito', service: 'mosquito', mo: 66, monthly: 66, perTreatment: 66, visitsPerYear: 12 }],
      },
    },
  });

  test('pricingBundleMissingRequiredSetupFee: qualifying snapshot without the fee recomputes', () => {
    const feeLess = { frequencies: [{ key: 'monthly12', monthly: 66 }] };
    expect(pricingBundleMissingRequiredSetupFee(feeLess, soloMosquitoEstData())).toBe(true);
  });

  test('pricingBundleMissingRequiredSetupFee: fee already present keeps the fast path', () => {
    const withFee = {
      frequencies: [{ key: 'monthly12', monthly: 66 }],
      firstVisitFees: [{ service: 'waveguard_setup', amount: 99, waivedWithPrepay: true }],
    };
    expect(pricingBundleMissingRequiredSetupFee(withFee, soloMosquitoEstData())).toBe(false);
    const withBreakdownRow = {
      frequencies: [{ key: 'monthly12', monthly: 66 }],
      oneTimeBreakdown: { items: [{ service: 'waveguard_setup', amount: 99 }], total: 99 },
    };
    expect(pricingBundleMissingRequiredSetupFee(withBreakdownRow, soloMosquitoEstData())).toBe(false);
  });

  test('pricingBundleMissingRequiredSetupFee: root-level recurring shapes are read too', () => {
    // Some estimates store recurring.services at the TOP level of
    // estimate_data (no result/engineResult wrapper) — the guard must see
    // that mix or a stale fee-less snapshot fast-paths while accept bills.
    const rootLevel = {
      recurring: {
        services: [{ name: 'Mosquito', service: 'mosquito', mo: 66, monthly: 66, perTreatment: 66, visitsPerYear: 12 }],
      },
    };
    const feeLess = { frequencies: [{ key: 'monthly12', monthly: 66 }] };
    expect(pricingBundleMissingRequiredSetupFee(feeLess, rootLevel)).toBe(true);
  });

  test('pricingBundleMissingRequiredSetupFee: quote state anywhere keeps the fast path', () => {
    // Bundle-level flag.
    expect(pricingBundleMissingRequiredSetupFee(
      { quoteRequired: true, frequencies: [{ key: 'monthly12', monthly: 66 }] },
      soloMosquitoEstData(),
    )).toBe(false);
    // Nested per-service frequency flag.
    expect(pricingBundleMissingRequiredSetupFee(
      {
        frequencies: [{ key: 'monthly12', monthly: 66 }],
        services: [{ key: 'mosquito', frequencies: [{ key: 'manual', kind: 'quote_required', monthly: null }] }],
      },
      soloMosquitoEstData(),
    )).toBe(false);
  });

  test('pricingBundleMissingRequiredSetupFee: existing-customer waiver and bundles never trip it', () => {
    const feeLess = { frequencies: [{ key: 'monthly12', monthly: 66 }] };
    const existingCustomer = {
      ...soloMosquitoEstData(),
      membershipSnapshot: { isExistingCustomer: true },
    };
    // Waived outright — no fee will be invoiced, snapshot is honest as-is.
    expect(pricingBundleMissingRequiredSetupFee(feeLess, existingCustomer)).toBe(false);
    // Multi-service bundles carry no setup fee under the 2026-07-10 rule.
    const bundleMix = pestMosquitoTermiteEstimate().estimate_data;
    expect(pricingBundleMissingRequiredSetupFee(feeLess, bundleMix)).toBe(false);
  });
});

describe('termite-bait rows with explicit per-application fields (billed per application, owner 2026-07-20)', () => {
  // New engine payloads persist the pricer's visitsPerYear/perApp on the
  // recurring row (perTreatment 105 = 35 x 12 / 4 pre-discount). The section
  // must lead with the NET per-application price, flag per-application
  // billing (no "Billed $X/mo" note), and the combined breakdown row must
  // carry displayPrice + visits so it renders "/ application", not "/ month".
  function perAppBundleEstimate() {
    const estimate = pestMosquitoTermiteEstimate();
    const services = estimate.estimate_data.result.recurring.services;
    const termiteIdx = services.findIndex((svc) => svc.service === 'termite_bait');
    services[termiteIdx] = {
      name: 'Termite Bait', service: 'termite_bait', mo: 35, monthly: 35,
      perTreatment: 105, visitsPerYear: 4,
    };
    return estimate;
  }

  test('split section: NET per-application price, billedPerApplication flagged, monthly figures intact', async () => {
    const bundle = await buildPricingBundle(perAppBundleEstimate());
    const termite = bundle.services.find((s) => s.key === 'termite_bait');
    expect(termite).toBeTruthy();
    // Codex #2911 r2: explicit per-app fields must NOT promote termite onto
    // the mirrored pest cadence ladder — its cadence is fixed, so the
    // section stays a single 'recurring' entry (no active selector).
    expect(termite.frequencies).toHaveLength(1);
    const entry = termite.frequencies[0];
    expect(entry.key).toBe('recurring');
    // 105 pre-discount -> 89.25 net of Gold 15%, same figure the legacy
    // derivation produced — the price is unchanged, only its authority moved
    // from a display-time derivation to the persisted row.
    expect(entry.perTreatment).toBeCloseTo(89.25, 2);
    expect(entry.visitsPerYear).toBe(4);
    expect(entry.billedPerApplication).toBe(true);
    expect(entry.monthly).toBeCloseTo(29.75, 2);
    expect(entry.monthlyBase).toBeCloseTo(35, 2);
  });

  test('combined combo row carries displayPrice + visits so the breakdown renders per application', async () => {
    const bundle = await buildPricingBundle(perAppBundleEstimate());
    const defaultCombo = bundle.serviceCadenceCombos.find(
      (c) => c.key === 'mosquito:monthly12|pest_control:quarterly',
    );
    const termiteRow = (defaultCombo.perServiceTreatments || []).find((r) => r.service === 'termite_bait');
    expect(termiteRow).toBeTruthy();
    expect(termiteRow.displayPrice).toBeCloseTo(89.25, 2);
    expect(termiteRow.visitsPerYear).toBe(4);
    expect(termiteRow.perTreatment).toBeCloseTo(105, 2);
    // Monthly figures still ride along for totals math.
    expect(termiteRow.monthly).toBeCloseTo(29.75, 2);
  });

  test('legacy rows (no explicit fields) keep the display-only derivation WITHOUT the billing flag', async () => {
    const bundle = await buildPricingBundle(pestMosquitoTermiteEstimate());
    const termite = bundle.services.find((s) => s.key === 'termite_bait');
    const entry = termite.frequencies[0];
    expect(entry.perTreatment).toBeCloseTo(89.25, 2);
    expect(entry.visitsPerYear).toBe(4);
    expect(entry.billedPerApplication).toBeUndefined();
  });

  test('lawn + T&S per-application rows carry billedPerApplication; mosquito seasonal spread does not (07-24 audit P1)', async () => {
    const estimate = pestMosquitoTermiteEstimate();
    estimate.estimate_data.result.recurring.services.push(
      { name: 'Lawn Care (Standard)', service: 'lawn_care', mo: 55.5, monthly: 55.5, perTreatment: 111, visitsPerYear: 6 },
      { name: 'Tree & Shrub (Enhanced)', service: 'tree_shrub', mo: 68.6, monthly: 68.6, perTreatment: 91.47, visitsPerYear: 9 },
    );
    const bundle = await buildPricingBundle(estimate);
    for (const key of ['lawn_care', 'tree_shrub']) {
      const section = bundle.services.find((s) => s.key === key);
      expect(section).toBeTruthy();
      for (const entry of section.frequencies) {
        // Converter bills new lawn/T&S signups per application — the card's
        // per-app headline IS the charge, so the "Billed $X/mo" note must
        // stay silent on every cadence entry (owner copy ruling 2026-07-23).
        expect(entry.billedPerApplication).toBe(true);
      }
    }
    const mosquito = bundle.services.find((s) => s.key === 'mosquito');
    if (mosquito) {
      for (const entry of mosquito.frequencies) {
        expect(entry.billedPerApplication).toBeUndefined();
      }
    }
  });
});
