const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { priceTopDressing } = require('../services/pricing-engine/service-pricing');

const clientEstimatorPath = path.resolve(__dirname, '../../client/src/lib/estimateEngine.js');
const legacyAdminEstimatePagePath = path.resolve(__dirname, '../../client/src/pages/admin/EstimatePage.jsx');

const TOP_DRESSING_LAWN_SQFT_CASES = [3000, 5000, 7500, 10000, 15000, 20000];
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

function loadClientEstimator(source) {
  const transformed = source.replace(/\bexport\s+function\s+/g, 'function ');
  const module = { exports: {} };
  const sandbox = {
    module,
    exports: module.exports,
    console,
  };
  vm.createContext(sandbox);
  const script = new vm.Script(
    `${transformed}\nmodule.exports = { calculateEstimate, interpolate, fmt, fmtInt };`,
    { filename: clientEstimatorPath }
  );
  script.runInContext(sandbox);
  return module.exports;
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

describe('deprecated client estimator pricing drift guards', () => {
  let source;
  let legacyAdminSource;
  let calculateEstimate;

  beforeAll(() => {
    source = fs.readFileSync(clientEstimatorPath, 'utf8');
    legacyAdminSource = fs.readFileSync(legacyAdminEstimatePagePath, 'utf8');
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
      name: 'German Roach Cleanout — 3 Visit Program',
      setupCharge: 100,
      total: cleanout.price,
      noRecurringDiscount: true,
    }));
    expect(standard.oneTime.total).toBe(cleanout.price);
    expect(discountedCleanout.price).toBe(cleanout.price);
    expect(recurringCustomer.oneTime.total).toBe(cleanout.price);
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

  test('keeps one-time pest floor as a final customer-facing floor', () => {
    expect(source).toContain('const fp = Math.max(199, otP(Math.max(199, Math.round(bpp * 1.75))));');
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
});
