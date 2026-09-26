/**
 * End-to-end regression for the ground-geometry gap a primary review caught
 * on commit d4d97a7500 (owner ruling 2026-09-25,
 * server/services/commercial-suite-size/): correcting homeSqFt to the
 * suite's own size was not enough — buildEnrichedProfile's INDEPENDENT
 * footprint/estimatedPerimeterLF/estimatedAtticSqFt/estimatedSlabSqFt
 * fields (all derived straight from rc.squareFootage, the WHOLE BUILDING)
 * still fed the termite/trenching auto-fill AND priceCommercialPest's
 * explicit-perimeter override, so a 1,400 sqft suite still priced off the
 * building's ~46,031 sqft footprint / ~1,073 LF perimeter (~$546/mo instead
 * of ~$103/mo). This exercises the REAL functions on both paths, not just
 * their inputs, so a reintroduced leak fails here.
 */

// Suite sizing ships dark behind GATE_COMMERCIAL_SUITE_SIZING; these tests exercise it ON.
process.env.GATE_COMMERCIAL_SUITE_SIZING = 'true';

jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/commercial-suite-size/dbpr-food-license');

const { resolveViaDbprLicense } = require('../services/commercial-suite-size/dbpr-food-license');
const { _private: routePrivate, buildEnrichedProfile, translateV2CallToV1Input } = require('../routes/property-lookup-v2');
const { generateEstimate } = require('../services/pricing-engine');
const { buildEngineInput } = require('../services/estimator-engine/draft-builder');
const { commercialLowConfidenceRange } = require('../services/estimate-delivery-options');

// Deterministic: a DBPR miss falls through to the web-search leg (business
// name only) before the type default — disabled here so the miss test below
// never makes a real network/LLM call.
process.env.COMMERCIAL_SUITE_WEB_SEARCH = 'false';

function plazaSuiteRecord(overrides = {}) {
  return {
    formattedAddress: '4400 Test Commons Pkwy E #102, Bradenton, FL 00000',
    propertyType: 'Commercial',
    squareFootage: 46031, // the whole plaza — must never reach pricing for one suite
    _parcel: { landUseDescription: 'Community Shopping Centers (1555)' },
    stories: 1,
    unitCount: 1,
    _source: 'county',
    _fieldEvidence: {
      propertyType: { value: 'Commercial', confidence: 'high', sourceType: 'county', fieldVerify: false, score: 100 },
    },
    ...overrides,
  };
}

const SUITE_ADDRESS = '4400 Test Commons Pkwy E #102, Bradenton, FL 00000';

// ~$103/mo target from the owner's own dry-run (commercialRiskType
// restaurant_food, footprintSqFt 1400, buildingSizeMeasured true ->
// auto_estimate, 12 visits). The pre-fix bug priced ~$546/mo — 5x higher —
// so a generous band still catches a regression without being brittle to
// small COMMERCIAL_PEST config tuning.
const EXPECTED_MONTHLY_MIN = 85;
const EXPECTED_MONTHLY_MAX = 130;
const BUILDING_OVERQUOTE_MONTHLY_FLOOR = 300; // the wrong-building price was ~$546/mo

describe('manual admin-tool path — buildEnrichedProfile -> applyCommercialSuiteSize -> translateV2CallToV1Input -> generateEstimate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('a 25-seat plaza restaurant suite prices off its OWN footprint, never the building', async () => {
    resolveViaDbprLicense.mockResolvedValue({
      value: 1400,
      businessName: 'Test Taco Shop',
      seats: 25,
      evidence: [{ source: 'license_seats', detail: '25 seats -> 1,400 sq ft' }],
    });

    const profile = buildEnrichedProfile(plazaSuiteRecord(), null, 27.5, -82.45, null, null, SUITE_ADDRESS, { commercialSuiteSizing: true });
    await routePrivate.applyCommercialSuiteSize(profile);

    // The bug this test guards: homeSqFt alone was corrected in the first
    // cut, but profile.footprint (a SEPARATE field, independently derived
    // from rc.squareFootage) was not.
    expect(profile.homeSqFt).toBe(1400);
    expect(profile.footprint).toBe(1400);
    expect(profile.suiteBuildingTotalSqFt).toBe(46031);
    // The building's ground-geometry boxes must be empty, not carried
    // forward — trenching/Bora-Care/preslab must never auto-fill off the
    // whole plaza either.
    expect(profile.estimatedPerimeterLF).toBeFalsy();
    expect(profile.estimatedAtticSqFt).toBeFalsy();
    expect(profile.estimatedSlabSqFt).toBeFalsy();

    // The exact translation the admin tool's /calculate-estimate route runs
    // (server/routes/property-lookup-v2.js router.post('/calculate-estimate')).
    const v1Input = translateV2CallToV1Input(profile, ['PEST'], { commercialRiskType: 'restaurant_food' });
    expect(v1Input.footprintSqFt).toBe(1400);
    // No explicit perimeter forwarded — priceCommercialPest must derive it
    // from the (correct, small) footprint, not inherit the building's
    // ~1,073 LF exterior wall.
    expect(v1Input.perimeterLF).toBeFalsy();

    const result = generateEstimate(v1Input);
    const line = result.lineItems.find((l) => l.service === 'commercial_pest');
    expect(line).toBeTruthy();
    expect(line.footprintUsed).toBe(1400);
    expect(line.commercialPricingMode).toBe('auto_estimate');
    expect(line.monthly).toBeGreaterThan(EXPECTED_MONTHLY_MIN);
    expect(line.monthly).toBeLessThan(EXPECTED_MONTHLY_MAX);
    // Explicitly NOT the building-footprint/perimeter price.
    expect(line.monthly).toBeLessThan(BUILDING_OVERQUOTE_MONTHLY_FLOOR);
    // A real state license is a real record — MEDIUM, not LOW (primary
    // review of PR #4840 r4 P1: only the type-default GUESS grades LOW).
    expect(line.pricingConfidence).toBe('MEDIUM');
    expect(commercialLowConfidenceRange({ lineItems: result.lineItems }).hasLowConfidence).toBe(false);
  });

  test('a DBPR miss (business-type default) prices LOW and trips the low-confidence delivery gate (primary review PR #4840 r4 P1)', async () => {
    resolveViaDbprLicense.mockResolvedValue(null);

    const profile = buildEnrichedProfile(plazaSuiteRecord(), null, 27.5, -82.45, null, null, SUITE_ADDRESS, { commercialSuiteSizing: true });
    await routePrivate.applyCommercialSuiteSize(profile);
    expect(profile.suiteSize.source).toBe('suite_type_default');
    // A guess still auto-prices (never a $0 manual quote)...
    expect(profile.homeSqFt).toBeGreaterThan(0);
    expect(profile.footprint).toBe(profile.homeSqFt);

    const v1Input = translateV2CallToV1Input(profile, ['PEST'], { commercialRiskType: 'restaurant_food' });
    // ...but is flagged as an ESTIMATE, never a measurement, all the way to
    // the pricer's options (mirrors buildingSizeMeasured's own plumbing).
    expect(v1Input.footprintSizeEstimated).toBe(true);

    const result = generateEstimate(v1Input);
    const line = result.lineItems.find((l) => l.service === 'commercial_pest');
    expect(line).toBeTruthy();
    expect(line.commercialPricingMode).toBe('auto_estimate'); // still auto-prices
    expect(line.pricingConfidence).toBe('LOW'); // ...but grades LOW, not MEDIUM
    // ...and the existing low-confidence delivery gate now sees it.
    const range = commercialLowConfidenceRange({ lineItems: result.lineItems });
    expect(range.hasLowConfidence).toBe(true);
  });

  test('control: the SAME building record with no suite signal still prices off the whole building (unaffected)', async () => {
    const buildingAddress = '4400 Test Commons Pkwy E, Bradenton, FL 00000';
    const profile = buildEnrichedProfile(plazaSuiteRecord(), null, 27.5, -82.45, null, null, buildingAddress, { commercialSuiteSizing: true });
    await routePrivate.applyCommercialSuiteSize(profile); // no candidate — no-op
    expect(resolveViaDbprLicense).not.toHaveBeenCalled();
    expect(profile.homeSqFt).toBe(46031);
    expect(profile.footprint).toBe(46031);

    const v1Input = translateV2CallToV1Input(profile, ['PEST'], { commercialRiskType: 'restaurant_food' });
    const result = generateEstimate(v1Input);
    const line = result.lineItems.find((l) => l.service === 'commercial_pest');
    // A genuine whole-building quote correctly prices the building — this
    // pins that the suite fix did not change behavior for a real
    // whole-building commercial tenant/owner.
    expect(line.footprintUsed).toBe(46031);
    expect(line.monthly).toBeGreaterThan(BUILDING_OVERQUOTE_MONTHLY_FLOOR);
  });
});

describe('estimator engine path — buildEngineInput -> generateEstimate', () => {
  test('a commercial_suite tenant prices off the resolved suite footprint (no perimeter leak)', () => {
    const intent = {
      is_commercial: true,
      services: { pest: true },
      commercial_risk_type: 'restaurant_food',
    };
    const propertyFacts = {
      home: { value: 1400, source: 'license_seats', confidence: 'medium', rejected: [] },
      lot: { value: null, source: 'unresolved', confidence: 'none', rejected: [] },
    };
    const engineInput = buildEngineInput({ intent, propertyFacts, context: {} });
    // The engine path never carries a separate perimeter/perimeterLF key
    // for commercial (draft-builder.js only ever sets footprintSqFt) —
    // pinned here so a future change can't quietly add one.
    expect(engineInput.perimeter).toBeUndefined();
    expect(engineInput.perimeterLF).toBeUndefined();
    expect(engineInput.footprintSqFt).toBe(1400);
    expect(engineInput.buildingSizeMeasured).toBe(true);

    const result = generateEstimate(engineInput);
    const line = result.lineItems.find((l) => l.service === 'commercial_pest');
    expect(line).toBeTruthy();
    expect(line.footprintUsed).toBe(1400);
    expect(line.commercialPricingMode).toBe('auto_estimate');
    expect(line.monthly).toBeGreaterThan(EXPECTED_MONTHLY_MIN);
    expect(line.monthly).toBeLessThan(EXPECTED_MONTHLY_MAX);
  });
});
