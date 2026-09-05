const { generateEstimate } = require('../services/pricing-engine/estimate-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
const { SPECIALTY } = require('../services/pricing-engine/constants');
const { deriveModifiers } = require('../services/pricing-engine/modifiers');

const property = { homeSqFt: 2000, stories: 1, lotSqFt: 10000, lawnSqFt: 4500 };
const estimate = services => generateEstimate({ ...property, services });

describe('estimator rejects failed monetary calculations', () => {
  test.each([
    { plugging: { area: 'invalid', spacing: 12 } },
    { stinging: { tier: 2.5 } },
    { stinging: { tier: 'invalid' } },
    { rodentPlugging: { entryPoints: 'invalid' } },
    { termiteFoam: { applicationPoints: 'invalid' } },
    { stingingV2: { nestCount: 'invalid' } },
    { exclusionV2: { sqft: 'invalid' } },
  ])('invalid quantities cannot become a free or missing service: %j', services => {
    expect(() => estimate(services)).toThrow(expect.objectContaining({ code: 'PRICING_VALIDATION_ERROR', statusCode: 400 }));
  });

  test('invalid configured cost cannot become a free quote', () => {
    const saved = SPECIALTY.plugging.costPerPlug;
    try {
      SPECIALTY.plugging.costPerPlug = Infinity;
      expect(() => estimate({ plugging: { area: 1000, spacing: 12 } })).toThrow(/valid service price/);
    } finally { SPECIALTY.plugging.costPerPlug = saved; }
  });

  test.each([NaN, Infinity, -Infinity])('mapper rejects nonfinite prices even on independently supplied engine output', price => {
    const result = estimate({ plugging: { area: 1000, spacing: 12 } });
    result.lineItems[0].price = price;
    expect(() => mapV1ToLegacyShape(result)).toThrow(/valid service price/);
  });

  test('zero-price included work and null manual quotes remain valid', () => {
    expect(() => mapV1ToLegacyShape(estimate({ rodentTrappingFollowups: { count: 3 } }))).not.toThrow();
    const manual = generateEstimate({ isCommercial: true, propertyType: 'commercial', buildingSizeMeasured: false, services: { pest: {} } });
    expect(mapV1ToLegacyShape(manual).quoteRequired).toBe(true);
  });

  test('supported numeric input strings retain the valid price', () => {
    expect(estimate({ plugging: { area: '1000', spacing: '12' } }).lineItems[0].price).toBe(2443);
    expect(estimate({ stinging: { tier: '2' } }).lineItems[0].price).toBe(250);
  });

  test('one-time lawn rejects an unsupported treatment instead of taking the cheapest multiplier', () => {
    expect(() => estimate({ oneTimeLawn: { treatmentType: 'pest_control' } })).toThrow(/treatmentType/);
    expect(estimate({ oneTimeLawn: { treatmentType: 'pest' } }).lineItems[0].price).toBe(150);
    expect(estimate({ oneTimeLawn: { treatmentType: 'fertilization' } }).lineItems[0].price).toBe(115);
  });
});

describe('sanitation scope advisory survives estimator mapping', () => {
  test.each([[50, false], [51, true]])('%s cu ft debris carries review=%s', (debris, review) => {
    const raw = estimate({ sanitation: { tier: 'heavy', affectedSqFt: 750, insulationRemovalCuFt: debris } });
    const mapped = mapV1ToLegacyShape(raw);
    const item = mapped.oneTime.specItems.find(row => row.service === 'rodent_sanitation');
    expect(item.requiresManualReview).toBe(review);
    expect(item.quoteRequired).toBe(false); // Advisory; preserve the priced quote.
    if (review) {
      expect(item.manualReviewReasons).toContain('sanitation_debris_custom_quote_recommended');
      expect(item.warnings).toContain('Sanitation debris exceeds 50 cu ft; a custom quote is recommended.');
      expect(item.price).toBe(1305);
    }
  });
});

describe('pricing age modifiers use the Eastern calendar year', () => {
  afterEach(() => jest.useRealTimers());
  test('UTC midnight does not advance a house into the next age bracket early', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2030-01-01T02:00:00Z'));
    expect(deriveModifiers({ yearBuilt: 2010 })).toMatchObject({ pestAgeAdj: 0, wdoTimeMult: 1 });
    jest.setSystemTime(new Date('2030-01-01T05:00:00Z'));
    expect(deriveModifiers({ yearBuilt: 2010 })).toMatchObject({ pestAgeAdj: 2, wdoTimeMult: 1.1 });
  });
});

describe('palm annual cents and historical quote preservation', () => {
  const services = { palm: { treatmentType: 'treeAge', palmCount: 3, palmSize: 'medium', dbhInches: 12 } };
  const { savedFloorReplaySignals } = require('../services/estimate-floor-signal-replay');
  test('new TreeAge quote retains the exact annualized and event prices', () => {
    const raw = estimate(services);
    const mapped = mapV1ToLegacyShape(raw);
    expect(raw.lineItems[0]).toMatchObject({ perVisit: 255, annual: 127.5, annualRounding: 'cents' });
    expect(mapped.results.injection).toMatchObject({ perVisit: 255, ann: 127.5, annualRounding: 'cents' });
    expect(mapped.totals.year1).toBe(127.5);
    const replay = generateEstimate({ ...property, services, ...savedFloorReplaySignals({ result: mapped }) });
    expect(mapV1ToLegacyShape(replay).totals.year1).toBe(127.5);
  });

  test.each([
    { result: { results: { injection: { ann: 128, perVisit: 255 } } } },
    { engineResult: { lineItems: [{ service: 'palm_injection', annual: 128, perVisit: 255 }] } },
  ])('old quote retains whole-dollar annualization from saved output', stored => {
    const replay = generateEstimate({ ...property, services, ...savedFloorReplaySignals(stored) });
    expect(mapV1ToLegacyShape(replay).results.injection).toMatchObject({ ann: 128, perVisit: 255, annualRounding: 'whole' });
  });

  test('a claimed rounding mode without saved palm output does not establish replay evidence', () => {
    const replay = generateEstimate({ ...property, services, palmAnnualRounding: 'whole', ...savedFloorReplaySignals({ engineInputs: { palmAnnualRounding: 'whole' } }) });
    expect(replay.lineItems[0].annual).toBe(127.5);
  });
});

describe('rodent agreements and package scope surface for staff review', () => {
  test.each([['annual', 495], ['monthly', 248]])('retainer %s preserves its quoted charge and carries the unresolved scheduling review', (billing, price) => {
    const mapped = mapV1ToLegacyShape(estimate({ trapOnlyRetainer: { plan: 'standard', billing } }));
    expect(mapped.oneTime.specItems[0]).toMatchObject({
      price,
      requiresManualReview: true,
      manualReviewReasons: ['retainer_payment_and_monitoring_schedule_confirmation'],
      retainerBilling: billing,
    });
  });

  test('an above-allowance station count cannot look like confirmed priced scope', () => {
    const mapped = mapV1ToLegacyShape(estimate({ rodentGuaranteeCombo: { sqft: 2000, guaranteeTerm: 12, stationCount: 20 } }));
    expect(mapped.oneTime.specItems[0]).toMatchObject({
      price: 1095,
      requiresManualReview: true,
      manualReviewReasons: ['rodent_combo_station_allowance_exceeded'],
    });
  });
});
