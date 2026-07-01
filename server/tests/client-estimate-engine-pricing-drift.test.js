const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const { priceGermanRoach, priceTopDressing, priceDethatching } = require('../services/pricing-engine/service-pricing');
const { ONE_TIME } = require('../services/pricing-engine/constants');

const clientEstimatorPath = path.resolve(__dirname, '../../client/src/lib/estimateEngine.js');
const legacyAdminEstimatePagePath = path.resolve(__dirname, '../../client/src/pages/admin/EstimatePage.jsx');
const adminEstimateToolViewPath = path.resolve(__dirname, '../../client/src/pages/admin/EstimateToolViewV2.jsx');

const TOP_DRESSING_LAWN_SQFT_CASES = [3000, 5000, 7500, 10000, 15000, 20000];
const DETHATCHING_PARITY_CASES = [
  { name: 'default/no cleanup', lawnSqFt: 4500, options: { cleanupLevel: 'none', access: 'easy', grassType: 'bermuda', thatchDepthInches: 0.75 } },
  { name: 'light cleanup', lawnSqFt: 4500, options: { cleanupLevel: 'light', access: 'easy', grassType: 'bermuda', thatchDepthInches: 0.75 } },
  { name: 'debris checkbox maps to light cleanup', lawnSqFt: 4500, options: { cleanupLevel: 'none', debrisRemovalIncluded: true, access: 'easy', grassType: 'bermuda', thatchDepthInches: 0.75 } },
  { name: 'moderate cleanup', lawnSqFt: 4500, options: { cleanupLevel: 'moderate', access: 'easy', grassType: 'bermuda', thatchDepthInches: 0.75 } },
  { name: 'heavy cleanup', lawnSqFt: 4500, options: { cleanupLevel: 'heavy', access: 'easy', grassType: 'zoysia', thatchDepthInches: 0.75 } },
  { name: 'difficult access', lawnSqFt: 4500, options: { cleanupLevel: 'none', access: 'difficult', grassType: 'bermuda', thatchDepthInches: 0.75 } },
  { name: 'St. Augustine manager metadata', lawnSqFt: 4500, options: { cleanupLevel: 'moderate', access: 'easy', grassType: 'st_augustine', thatchDepthInches: 0.8 } },
];
const TOP_DRESSING_EXPECTED = {
  eighth: {
    standalone: {
      3000: 250,
      5000: 250,
      7500: 250,
      10000: 250,
      15000: 321,
      20000: 413,
    },
    recurring: {
      3000: 250,
      5000: 250,
      7500: 257,
      10000: 328,
      15000: 470,
      20000: 612,
    },
  },
  quarter: {
    standalone: {
      3000: 450,
      5000: 450,
      7500: 450,
      10000: 455,
      15000: 645,
      20000: 836,
    },
    recurring: {
      3000: 450,
      5000: 450,
      7500: 514,
      10000: 660,
      15000: 953,
      20000: 1245,
    },
  },
};

// The client engine is ESM and imports @waves/lawn-cost-floor, so it can't be
// eval'd raw. Bundle to CJS with esbuild (resolving the shared-module import);
// calculateEstimate/interpolate/fmt/fmtInt are already `export`ed, so they land
// on module.exports natively.
function loadClientEstimator(source) {
  const out = esbuild.buildSync({
    stdin: {
      contents: source,
      resolveDir: path.dirname(clientEstimatorPath),
      sourcefile: 'estimateEngine.js',
      loader: 'js',
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    logLevel: 'silent',
  });
  const module = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

function loadAdminPreviewOneTimeHelpers(source) {
  const start = source.indexOf('const INITIAL_ROACH_PREVIEW_RE');
  const end = source.indexOf('function firstVisitFeesForCustomerPreview');
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const helperSource = source.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function('serviceDetailText', 'fmtInt', `
    ${helperSource}
    return { oneTimePestChoiceRowsForCustomerPreview };
  `)(
    (item = {}) => item.detail || item.det || item.note || '',
    (value) => `$${Math.round(Number(value || 0)).toLocaleString('en-US')}`,
  );
}

function buildClientTopDressingEstimate(calculateEstimate, { lawnSqFt, hasRecurringLawn }) {
  const estimate = calculateEstimate({
    homeSqFt: 2000,
    stories: 1,
    lotSqFt: Math.max(lawnSqFt, 10000),
    propertyType: 'single_family',
    measuredTurfSf: lawnSqFt,
    svcTopdress: true,
    svcLawn: hasRecurringLawn,
    lawnFreq: 9,
    grassType: 'st_augustine',
    urgency: 'NONE',
    isAfterHours: false,
    isRecurringCustomer: false,
  });
  expect(estimate.error).toBeUndefined();
  expect(estimate.results.tdTiers).toHaveLength(2);
  return estimate;
}

function clientTopDressingPrice(calculateEstimate, { lawnSqFt, depth, hasRecurringLawn }) {
  const estimate = buildClientTopDressingEstimate(calculateEstimate, { lawnSqFt, hasRecurringLawn });
  const tierName = depth === 'eighth' ? '1/8" Depth' : '1/4" Depth';
  const tier = estimate.results.tdTiers.find(t => t.name === tierName);
  expect(tier).toBeDefined();
  if (depth === 'eighth') expect(estimate.results.td).toBe(tier.price);
  return tier.price;
}

function clientDethatchingLine(calculateEstimate, { lawnSqFt, options }) {
  const estimate = calculateEstimate({
    homeSqFt: 2000,
    stories: 1,
    lotSqFt: Math.max(lawnSqFt, 10000),
    propertyType: 'single_family',
    measuredTurfSf: lawnSqFt,
    svcDethatch: true,
    svcLawn: false,
    grassType: options.grassType,
    dethatchingCleanupLevel: options.cleanupLevel,
    dethatchingAccess: options.access,
    dethatchingDebrisRemovalIncluded: options.debrisRemovalIncluded ?? options.cleanupLevel !== 'none',
    thatchDepthInches: options.thatchDepthInches,
    urgency: 'NONE',
    isAfterHours: false,
    isRecurringCustomer: false,
  });
  expect(estimate.error).toBeUndefined();
  const line = estimate.oneTime.items.find(item => item.service === 'dethatching');
  expect(line).toBeDefined();
  return line;
}

describe('deprecated client estimator pricing drift guards', () => {
  let source;
  let legacyAdminSource;
  let adminToolViewSource;
  let calculateEstimate;

  beforeAll(() => {
    source = fs.readFileSync(clientEstimatorPath, 'utf8');
    legacyAdminSource = fs.readFileSync(legacyAdminEstimatePagePath, 'utf8');
    adminToolViewSource = fs.readFileSync(adminEstimateToolViewPath, 'utf8');
    calculateEstimate = loadClientEstimator(source).calculateEstimate;
  });

  test('mirrors conservative pest pool cage adjustments', () => {
    expect(source).toContain('const cageAdjBySize = { SMALL: 5, MEDIUM: 8, LARGE: 12, OVERSIZED: 18 };');
  });

  test('mirrors live server pest frequency discounts', () => {
    expect(source).toContain("{ f: 4, label: 'Quarterly', disc: 1.00");
    expect(source).toContain("{ f: 6, label: 'Bi-Monthly', disc: 0.85");
    expect(source).toContain("{ f: 12, label: 'Monthly', disc: 0.70");
    expect(source).not.toContain('disc: 0.92');
  });

  test('keeps recurring roach premium retired in the client display engine', () => {
    expect(source).toContain('const roachAddOn = 0;');
    expect(source).not.toMatch(/basePrice\s*\*\s*0\.15|pp\s*\*\s*0\.15|117\s*\*\s*0\.15/);
  });

  test('client fallback rejects palm injection without a positive treated-palm count', () => {
    const estimate = calculateEstimate({
      homeSqFt: 2200,
      stories: 1,
      lotSqFt: 9000,
      propertyType: 'single_family',
      svcInjection: true,
      urgency: 'NONE',
      isAfterHours: false,
    });

    expect(estimate).toEqual({
      error: 'Palm count is required for palm injection pricing.',
    });
  });

  test('client fallback quotes German Roach Cleanout as a no-discount total', () => {
    const baseInput = {
      homeSqFt: 2800,
      stories: 1,
      lotSqFt: 10000,
      propertyType: 'single_family',
      svcRoach: true,
      roachType: 'GERMAN',
      urgency: 'NONE',
      isAfterHours: false,
    };
    const standard = calculateEstimate({ ...baseInput, isRecurringCustomer: false });
    const recurringCustomer = calculateEstimate({ ...baseInput, isRecurringCustomer: true });
    const cleanout = standard.oneTime.specItems.find((line) => line.service === 'german_roach');
    const discountedCleanout = recurringCustomer.oneTime.specItems.find((line) => line.service === 'german_roach');

    expect(cleanout).toEqual(expect.objectContaining({
      name: 'German Roach Cleanout — 2 Visit Program',
      severity: 'light',
      price: 350,
      visits: 2,
      setupCharge: 0,
      total: cleanout.price,
      noRecurringDiscount: true,
    }));
    expect(standard.oneTime.total).toBe(cleanout.price);
    expect(discountedCleanout.price).toBe(cleanout.price);
    expect(recurringCustomer.oneTime.total).toBe(cleanout.price);
  });

  test('client fallback German Roach Cleanout matches server total across severity tiers', () => {
    [
      { roachSeverity: 'light', expected: 350 },
      { roachSeverity: 'medium', expected: 450 },
      { roachSeverity: 'heavy', expected: 550 },
    ].forEach(({ roachSeverity, expected }) => {
      const estimate = calculateEstimate({
        homeSqFt: 2800,
        stories: 1,
        lotSqFt: 10000,
        propertyType: 'single_family',
        svcRoach: true,
        roachType: 'GERMAN',
        roachSeverity,
        urgency: 'NONE',
        isAfterHours: false,
      });
      const cleanout = estimate.oneTime.specItems.find((line) => line.service === 'german_roach');
      const server = priceGermanRoach({ footprint: 2800 }, { severity: roachSeverity });

      expect(cleanout.price).toBe(expected);
      expect(cleanout.price).toBe(server.total);
      expect(cleanout.total).toBe(server.total);
      expect(estimate.oneTime.total).toBe(server.total);
    });
  });

  test('admin termite footprint override stays service-scoped', () => {
    expect(legacyAdminSource).toContain('termiteFootprintSqFt,');
    expect(adminToolViewSource).toContain('termiteFootprintSqFt,');
    expect(legacyAdminSource).not.toContain('profile.footprint = termiteFootprintSqFt');
    expect(adminToolViewSource).not.toContain('profile.footprint = termiteFootprintSqFt');
  });

  test('commercial termite scope rides in BOTH admin payloads (liability gate stays in sync)', () => {
    // Both admin surfaces must forward termiteScope to the server so the
    // bond/warranty/install → manual-quote gate can never fire on one form but
    // not the other.
    expect(legacyAdminSource).toContain('termiteScope: form.termiteScope');
    expect(adminToolViewSource).toContain('termiteScope: form.termiteScope');
    // And both must apply the same client-side manual-scope preview set.
    expect(legacyAdminSource).toContain('COMMERCIAL_TERMITE_MANUAL_SCOPES');
    expect(adminToolViewSource).toContain('COMMERCIAL_TERMITE_MANUAL_SCOPES');
  });

  test('client fallback quote-required trenching does not add renewal', () => {
    const estimate = calculateEstimate({
      homeSqFt: 2400,
      stories: 1,
      lotSqFt: 9000,
      propertyType: 'single_family',
      svcTrenching: true,
      urgency: 'NONE',
      isAfterHours: false,
    });

    expect(estimate.results.trench).toBeUndefined();
    expect(estimate.results.trenchQuoteRequired).toEqual(expect.objectContaining({
      quoteRequired: true,
      requiresMeasurement: true,
    }));
    expect(estimate.oneTime.items.find((item) => item.name === 'Trenching')).toEqual(expect.objectContaining({
      quoteRequired: true,
      price: null,
    }));
    expect(estimate.totals.year2).toBe(0);
  });

  test('client fallback quote-required trenching warranty block does not add renewal', () => {
    const estimate = calculateEstimate({
      homeSqFt: 2400,
      stories: 1,
      lotSqFt: 9000,
      propertyType: 'single_family',
      svcTrenching: true,
      trenchingPerimeterLF: 240,
      trenchingProductKey: 'bifen_it',
      trenchingWarrantyTier: 'five_year_repair_retreat',
      urgency: 'NONE',
      isAfterHours: false,
    });

    expect(estimate.results.trench).toBeUndefined();
    expect(estimate.results.trenchQuoteRequired).toEqual(expect.objectContaining({
      quoteRequired: true,
      productKey: 'bifen_it',
    }));
    expect(estimate.oneTime.items.find((item) => item.name === 'Trenching')).toEqual(expect.objectContaining({
      quoteRequired: true,
      price: null,
    }));
    expect(estimate.totals.year2).toBe(0);
  });

  test('client fallback allows Pre-Slab-only estimates without home or lot size', () => {
    const estimate = calculateEstimate({
      svcPreslab: true,
      preslabSqft: 1800,
      preslabWarranty: 'NONE',
      preslabLabelConfirmed: true,
      urgency: 'NONE',
      isAfterHours: false,
    });

    expect(estimate.error).toBeUndefined();
    const preSlab = estimate.oneTime.items.find((item) => item.name === 'Pre-Slab');
    expect(preSlab).toEqual(expect.objectContaining({
      warrantyTier: 'NONE',
      warrAdd: 0,
    }));
    expect(preSlab.price).toBe(preSlab.basePrice);
  });

  test('one-time pest mirrors the server: quarterly base × 2.2, floored at $199', () => {
    // Must match server/services/pricing-engine ONE_TIME.pest model (pure multiple).
    expect(source).toContain('const quarterlyBase = Math.max(89, 117 + pestBaseAdjustment(fpEff));');
    expect(source).toContain('let fp = Math.max(199, otP(Math.max(199, Math.round(quarterlyBase * 2.2))));');
    expect(source).toContain('if (fp <= quarterlyBase + 99) fp = quarterlyBase + 100;');
    expect(source).toContain("service: 'one_time_pest'");
    // The legacy 1.75× and the setup+premium forms must both be gone.
    expect(source).not.toContain('Math.round(bpp * 1.75)');
    expect(source).not.toContain('(quarterlyBase + 99) * 1.20');

    const estimate = calculateEstimate({
      homeSqFt: 2000,
      stories: 1,
      lotSqFt: 10000,
      propertyType: 'single_family',
      svcOnetimePest: true,
      urgency: 'NONE',
      isAfterHours: false,
      isRecurringCustomer: false,
    });
    const item = estimate.oneTime.items.find((row) => row.service === 'one_time_pest');
    expect(item).toEqual(expect.objectContaining({
      name: 'One-Time Pest Control',
      price: 257,
    }));
  });

  test('one-time mosquito mirrors the server SW-FL reprice band, not the retired 2x band', () => {
    // Server-authoritative band: server/services/pricing-engine/constants.js
    // ONE_TIME.mosquito (repriced 2026-06). The deprecated client fallback must
    // quote the same band + over-acre increment so the previewed price matches
    // what the server will actually charge.
    expect([
      ONE_TIME.mosquito.SMALL,
      ONE_TIME.mosquito.STANDARD,
      ONE_TIME.mosquito.LARGE,
      ONE_TIME.mosquito.XL,
      ONE_TIME.mosquito.ESTATE,
      ONE_TIME.mosquito.ACRE_CLASS,
    ]).toEqual([99, 129, 159, 199, 239, 269]);
    expect(ONE_TIME.mosquito.overAcreIncrementPrice).toBe(40);

    // Buckets must mirror the server ladder (server/services/pricing-engine
    // service-pricing.js getOneTimeMosquitoAreaBucket).
    expect(source).toContain('let p = 99;');
    expect(source).toContain('if (treatableSqFt > 43560) p = 269 + Math.ceil((treatableSqFt - 43560) / 10000) * 40;');
    expect(source).toContain('else if (treatableSqFt > 32000) p = 269;');
    expect(source).toContain('else if (treatableSqFt > 24000) p = 239;');
    expect(source).toContain('else if (treatableSqFt > 16000) p = 199;');
    expect(source).toContain('else if (treatableSqFt > 11000) p = 159;');
    expect(source).toContain('else if (treatableSqFt > 7500) p = 129;');
    // Retired 2x-market band must be gone.
    expect(source).not.toContain('let p = 225;');
    expect(source).not.toContain('p = 475');
    expect(source).not.toContain('p = 425');
    expect(source).not.toContain('p = 385');

    // Behavioral check: a small lot lands in the SMALL bucket and stacks the
    // same $75 station / $15 dunk add-ons as the server.
    const estimate = calculateEstimate({
      homeSqFt: 1400,
      stories: 1,
      lotSqFt: 7000,
      propertyType: 'single_family',
      svcOnetimeMosquito: true,
      mosquitoStationCount: 2,
      mosquitoDunkCount: 1,
      urgency: 'NONE',
      isAfterHours: false,
      isRecurringCustomer: false,
    });
    const line = estimate.oneTime.items.find((item) => item.name === 'OT Mosquito');
    expect(line).toBeDefined();
    expect(line.price).toBe(ONE_TIME.mosquito.SMALL + 2 * 75 + 1 * 15);
  });

  test('admin customer preview adds preserved pest specialty rows to one-time pest choice', () => {
    const { oneTimePestChoiceRowsForCustomerPreview } = loadAdminPreviewOneTimeHelpers(adminToolViewSource);
    const rows = oneTimePestChoiceRowsForCustomerPreview({
      oneTime: {
        total: 468,
        membershipFee: 99,
        items: [
          { service: 'pest_initial_roach', name: 'Initial Roach Knockdown', price: 119, detail: 'Heavy roach activity' },
          { service: 'stinging_insect', name: 'Stinging Insect', price: 175 },
          { service: 'native_cockroach', name: 'Native Cockroach Treatment', price: 145 },
          { service: 'hornet_treatment', name: 'Hornet Treatment', price: 155 },
          { service: 'pest_initial_cleanout', name: 'Initial Pest Cleanout', price: 199 },
          { service: 'waveguard_setup', name: 'WaveGuard setup', price: 99 },
          { service: 'one_time_pest', name: 'One-Time Pest', price: 250 },
          { service: 'one_time_adjustment', name: 'Other one-time services', price: 50 },
          { service: 'termite_bait_installation', name: 'Termite bait installation', price: 300 },
        ],
      },
    }, 202);

    expect(rows).toEqual([{
      service: 'one_time_pest',
      name: 'One-Time Pest Control',
      price: 202,
      detail: 'Single treatment',
    }, {
      service: 'pest_initial_roach',
      name: 'Initial Roach Knockdown',
      price: 119,
      detail: 'Heavy roach activity',
    }, {
      service: 'stinging_insect',
      name: 'Stinging Insect',
      price: 175,
      detail: '',
    }, {
      service: 'native_cockroach',
      name: 'Native Cockroach Treatment',
      price: 145,
      detail: '',
    }, {
      service: 'hornet_treatment',
      name: 'Hornet Treatment',
      price: 155,
      detail: '',
    }]);
    expect(rows.reduce((sum, row) => Math.round((sum + row.price) * 100) / 100, 0)).toBe(796);
  });

  test('bed bug fallback no longer treats invalid methods as quote-both', () => {
    expect(source).toContain('Invalid bedbugMethod. Use CHEMICAL, HEAT, or HYBRID.');
    expect(source).toContain('HYBRID bed bug pricing is server-only in the deprecated v1 estimator.');
    expect(source).toContain('Deprecated v1 bed bug pricing only supports light/ready/singleFamily; use server pricing endpoint.');
    expect(source).toContain('const bedBugP = (b) => Math.round(b * urgMult);');
    expect(source).toContain('price: bedBugP(cp)');
    expect(source).not.toContain("meth !== 'HEAT'");
    expect(source).not.toContain("meth !== 'CHEMICAL'");
  });

  test('legacy admin page blocks bed bug estimates from falling back to client pricing', () => {
    expect(legacyAdminSource).toContain('const canUseServerForBedBug =');
    expect(legacyAdminSource).toContain('const hasLawnPricedService =');
    expect(legacyAdminSource).toContain('form.svcBedbug && hasLawnPricedService && !enrichedProfile && !hasManualLawnDimensions');
    expect(legacyAdminSource).toContain('Enter lot size or run Property Lookup before generating a bed bug estimate with lawn services.');
    expect(legacyAdminSource).toContain('form.svcBedbug && !canUseServerForBedBug');
    expect(legacyAdminSource).toContain('Enter home sq ft or run Property Lookup before generating a mixed bed bug estimate.');
  });

  test('legacy admin page recognizes canonical one-time pest rows', () => {
    expect(legacyAdminSource).toContain('item.service === "one_time_pest" || item.name === "OT Pest"');
  });

  test('matches server Top Dressing pricing for supported depths and recurring lawn states', () => {
    for (const depth of ['eighth', 'quarter']) {
      for (const hasRecurringLawn of [false, true]) {
        const lawnState = hasRecurringLawn ? 'recurring' : 'standalone';
        for (const lawnSqFt of TOP_DRESSING_LAWN_SQFT_CASES) {
          const expected = TOP_DRESSING_EXPECTED[depth][lawnState][lawnSqFt];
          const server = priceTopDressing(lawnSqFt, depth, hasRecurringLawn);
          const clientPrice = clientTopDressingPrice(calculateEstimate, {
            lawnSqFt,
            depth,
            hasRecurringLawn,
          });

          expect(server.price).toBe(expected);
          expect(clientPrice).toBe(expected);
          expect(clientPrice).toBe(server.price);
        }
      }
    }
  });

  test('keeps Top Dressing tier labels stable for the admin estimate UI', () => {
    const estimate = buildClientTopDressingEstimate(calculateEstimate, {
      lawnSqFt: 7500,
      hasRecurringLawn: true,
    });
    expect(estimate.results.tdTiers.map(t => `${t.name} — ${t.detail}`)).toEqual([
      '1/8" Depth — St. Augustine standard',
      '1/4" Depth — Bermuda / leveling — 2x material',
    ]);
  });

  test('matches server Dethatching pricing and review metadata for modifier scenarios', () => {
    for (const testCase of DETHATCHING_PARITY_CASES) {
      const server = priceDethatching(testCase.lawnSqFt, testCase.options);
      const clientLine = clientDethatchingLine(calculateEstimate, testCase);

      expect(clientLine.price).toBe(server.price);
      expect(clientLine.cleanupLevel).toBe(server.cleanupLevel);
      expect(clientLine.access).toBe(server.access);
      expect(clientLine.timeMin).toBe(server.timeMin);
      expect(clientLine.manualReviewReasons || []).toEqual(server.manualReviewReasons || []);
      expect(!!clientLine.quoteRequired).toBe(!!server.quoteRequired);
      expect(!!clientLine.requiresCustomQuote).toBe(!!server.requiresCustomQuote);
      expect(!!clientLine.requiresManagerApproval).toBe(!!server.requiresManagerApproval);
      if (server.requiresManagerApproval) {
        expect(clientLine.managerApprovalReason).toBe('st_augustine_dethatching');
      }
    }
  });

  test('admin estimate pages expose dethatching hardening controls', () => {
    expect(legacyAdminSource).toContain('dethatchingCleanupLevel');
    expect(legacyAdminSource).toContain('DETHATCHING_ESTIMATE_RESET_FIELDS');
    expect(legacyAdminSource).toContain('Manager approval required. Dethatching St. Augustine / Floratam can damage stolons.');
    expect(adminToolViewSource).toContain('dethatchingCleanupLevel');
    expect(adminToolViewSource).toContain('DETHATCHING_ESTIMATE_RESET_FIELDS');
    expect(adminToolViewSource).toContain('Base price does not include bagging or debris hauling.');
    expect(adminToolViewSource).toContain('Manager approval required. Dethatching St. Augustine / Floratam can damage stolons.');
  });
});
