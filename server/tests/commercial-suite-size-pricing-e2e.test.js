/**
 * Commercial suite sizing, end to end on both paths:
 *  - the admin estimate tool's manual path: buildEnrichedProfile ->
 *    applyCommercialSuiteSize -> translateV2CallToV1Input -> generateEstimate
 *    (server/routes/property-lookup-v2.js, PR #4840's admin-only surface);
 *  - the estimator-engine path: buildEngineInput -> generateEstimate.
 * A commercial tenant in a multi-tenant building prices off the SUITE's
 * resolved size (never the building), and a type-default size prices LOW
 * confidence on every commercial line so the low-confidence delivery gates
 * apply. The admin-path suite exercises the REAL functions on both ends —
 * a regression here guards the ground-geometry gap a primary review caught
 * on commit d4d97a7500: correcting homeSqFt to the suite's own size was not
 * enough — buildEnrichedProfile's INDEPENDENT footprint/estimatedPerimeterLF/
 * estimatedAtticSqFt/estimatedSlabSqFt fields (all derived straight from
 * rc.squareFootage, the WHOLE BUILDING) still fed the termite/trenching
 * auto-fill AND priceCommercialPest's explicit-perimeter override, so a
 * 1,400 sqft suite still priced off the building's ~46,031 sqft footprint /
 * ~1,073 LF perimeter (~$546/mo instead of ~$103/mo).
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

  test('an operator-typed suite size clears the estimate flag (the default is no longer what prices)', async () => {
    resolveViaDbprLicense.mockResolvedValue(null);
    const profile = buildEnrichedProfile(plazaSuiteRecord(), null, 27.5, -82.45, null, null, SUITE_ADDRESS, { commercialSuiteSizing: true });
    await routePrivate.applyCommercialSuiteSize(profile);
    expect(profile.suiteSize.source).toBe('suite_type_default');
    // _homeSqFtManuallyEdited (buildTurfRequestProfile's client-side
    // provenance stamp) is what clears the flag now, not the priced value
    // differing from the default (primary review of PR #4840 r7 P2).
    const typed = { ...profile, homeSqFt: 2200, footprint: 2200, _homeSqFtManuallyEdited: true };
    const v1Input = translateV2CallToV1Input(typed, ['PEST'], { commercialRiskType: 'restaurant_food' });
    expect(v1Input.footprintSizeEstimated).toBeUndefined();
  });

  test('an operator-CONFIRMED size equal to the default still clears the estimate flag — provenance, not the number, decides (primary review PR #4840 r7 P2)', async () => {
    resolveViaDbprLicense.mockResolvedValue(null);
    const profile = buildEnrichedProfile(plazaSuiteRecord(), null, 27.5, -82.45, null, null, SUITE_ADDRESS, { commercialSuiteSizing: true });
    await routePrivate.applyCommercialSuiteSize(profile);
    expect(profile.suiteSize.source).toBe('suite_type_default');
    // The operator typed into the Home Sq Ft box and the number they
    // confirmed happens to equal the type default exactly — a value-based
    // check would (wrongly) keep this flagged as an estimate forever.
    const confirmed = { ...profile, _homeSqFtManuallyEdited: true };
    const v1Input = translateV2CallToV1Input(confirmed, ['PEST'], { commercialRiskType: 'restaurant_food' });
    expect(v1Input.footprintSizeEstimated).toBeUndefined();
  });

  test('an untouched default (no edit at all) still flags footprintSizeEstimated (control)', async () => {
    resolveViaDbprLicense.mockResolvedValue(null);
    const profile = buildEnrichedProfile(plazaSuiteRecord(), null, 27.5, -82.45, null, null, SUITE_ADDRESS, { commercialSuiteSizing: true });
    await routePrivate.applyCommercialSuiteSize(profile);
    expect(profile.suiteSize.source).toBe('suite_type_default');
    const v1Input = translateV2CallToV1Input(profile, ['PEST'], { commercialRiskType: 'restaurant_food' });
    expect(v1Input.footprintSizeEstimated).toBe(true);
  });

  // Codex P2 (PR #4840): the type-default resolver runs once, at lookup
  // time, off whatever commercialRiskType the ADMIN FORM had then (usually
  // none — commercialRiskType is null in applyCommercialSuiteSize's own
  // resolveCommercialSuiteSize call, so it falls back to the county subtype,
  // here 'office_retail' -> the generic 1,500 sq ft office default). It
  // never re-runs once the operator picks a real business type. These pin
  // that translateV2CallToV1Input — the generate-time chokepoint — recomputes
  // an UNTOUCHED default off whatever commercialRiskType/commercialSubtype
  // is current at generate, so the price always matches the selected type.
  describe('an untouched type-default recomputes off the CURRENT commercialRiskType/commercialSubtype at generate time (codex P2 #4840)', () => {
    test('resolves as the generic office default before any risk type is chosen (control)', async () => {
      resolveViaDbprLicense.mockResolvedValue(null);
      const profile = buildEnrichedProfile(plazaSuiteRecord(), null, 27.5, -82.45, null, null, SUITE_ADDRESS, { commercialSuiteSizing: true });
      await routePrivate.applyCommercialSuiteSize(profile);
      expect(profile.suiteSize.source).toBe('suite_type_default');
      expect(profile.homeSqFt).toBe(1500);
      const v1Input = translateV2CallToV1Input(profile, ['PEST'], {});
      expect(v1Input.homeSqFt).toBe(1500);
      expect(v1Input.footprintSqFt).toBe(1500);
    });

    test('operator then picks Restaurant: prices the 1,800 sq ft restaurant default, not the stale 1,500 office default', async () => {
      resolveViaDbprLicense.mockResolvedValue(null);
      const profile = buildEnrichedProfile(plazaSuiteRecord(), null, 27.5, -82.45, null, null, SUITE_ADDRESS, { commercialSuiteSizing: true });
      await routePrivate.applyCommercialSuiteSize(profile);
      expect(profile.suiteSize.source).toBe('suite_type_default');
      expect(profile.homeSqFt).toBe(1500); // still the stale office default — untouched by the pick below

      const v1Input = translateV2CallToV1Input(profile, ['PEST'], { commercialRiskType: 'restaurant_food' });
      expect(v1Input.homeSqFt).toBe(1800);
      expect(v1Input.footprintSqFt).toBe(1800);

      const result = generateEstimate(v1Input);
      const line = result.lineItems.find((l) => l.service === 'commercial_pest');
      expect(line.footprintUsed).toBe(1800);
    });

    test('operator then picks Healthcare: prices the 2,500 sq ft healthcare default', async () => {
      resolveViaDbprLicense.mockResolvedValue(null);
      const profile = buildEnrichedProfile(plazaSuiteRecord(), null, 27.5, -82.45, null, null, SUITE_ADDRESS, { commercialSuiteSizing: true });
      await routePrivate.applyCommercialSuiteSize(profile);
      expect(profile.suiteSize.source).toBe('suite_type_default');

      const v1Input = translateV2CallToV1Input(profile, ['PEST'], { commercialRiskType: 'healthcare_childcare' });
      expect(v1Input.homeSqFt).toBe(2500);
      expect(v1Input.footprintSqFt).toBe(2500);
    });

    test('a manually edited/confirmed Home Sq Ft box is never overwritten by the recompute', async () => {
      resolveViaDbprLicense.mockResolvedValue(null);
      const profile = buildEnrichedProfile(plazaSuiteRecord(), null, 27.5, -82.45, null, null, SUITE_ADDRESS, { commercialSuiteSizing: true });
      await routePrivate.applyCommercialSuiteSize(profile);
      expect(profile.suiteSize.source).toBe('suite_type_default');

      const typed = { ...profile, homeSqFt: 2200, footprint: 2200, _homeSqFtManuallyEdited: true };
      const v1Input = translateV2CallToV1Input(typed, ['PEST'], { commercialRiskType: 'restaurant_food' });
      expect(v1Input.homeSqFt).toBe(2200);
      expect(v1Input.footprintSqFt).toBe(2200);
    });

    test('license_seats / verified suite sizes are real measurements — never recomputed off risk type', async () => {
      resolveViaDbprLicense.mockResolvedValue({
        value: 1400, businessName: 'Test Taco Shop', seats: 25,
        evidence: [{ source: 'license_seats', detail: '25 seats -> 1,400 sq ft' }],
      });
      const profile = buildEnrichedProfile(plazaSuiteRecord(), null, 27.5, -82.45, null, null, SUITE_ADDRESS, { commercialSuiteSizing: true });
      await routePrivate.applyCommercialSuiteSize(profile);
      expect(profile.suiteSize.source).toBe('license_seats');

      // Even picking a risk type whose default (2,500) differs sharply from
      // the licensed 1,400 must not touch a real measurement.
      const v1Input = translateV2CallToV1Input(profile, ['PEST'], { commercialRiskType: 'healthcare_childcare' });
      expect(v1Input.homeSqFt).toBe(1400);
      expect(v1Input.footprintSqFt).toBe(1400);
    });
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

  test('a type-default suite\'s commercial termite-bait-only line also grades LOW and trips the gate — not just commercial_pest (primary review PR #4840 r5 P1)', async () => {
    resolveViaDbprLicense.mockResolvedValue(null);
    const profile = buildEnrichedProfile(plazaSuiteRecord(), null, 27.5, -82.45, null, null, SUITE_ADDRESS, { commercialSuiteSizing: true });
    await routePrivate.applyCommercialSuiteSize(profile);
    expect(profile.suiteSize.source).toBe('suite_type_default');

    const v1Input = translateV2CallToV1Input(profile, ['TERMITE_BAIT'], { commercialRiskType: 'retail_standard', termiteScope: 'monitoring_only' });
    expect(v1Input.footprintSizeEstimated).toBe(true);

    const result = generateEstimate(v1Input);
    const line = result.lineItems.find((l) => l.service === 'commercial_termite_bait');
    expect(line).toBeTruthy();
    expect(line.quoteRequired).not.toBe(true); // auto-priced, not a manual quote
    expect(line.pricingConfidence).toBe('LOW');
    expect(commercialLowConfidenceRange({ lineItems: result.lineItems }).hasLowConfidence).toBe(true);
  });

  test('a type-default suite\'s commercial rodent-bait-only line also grades LOW and trips the gate — not just commercial_pest (primary review PR #4840 r5 P1)', async () => {
    resolveViaDbprLicense.mockResolvedValue(null);
    const profile = buildEnrichedProfile(plazaSuiteRecord(), null, 27.5, -82.45, null, null, SUITE_ADDRESS, { commercialSuiteSizing: true });
    await routePrivate.applyCommercialSuiteSize(profile);
    expect(profile.suiteSize.source).toBe('suite_type_default');

    const v1Input = translateV2CallToV1Input(profile, ['RODENT_BAIT'], { commercialRiskType: 'retail_standard' });
    expect(v1Input.footprintSizeEstimated).toBe(true);

    const result = generateEstimate(v1Input);
    const line = result.lineItems.find((l) => l.service === 'commercial_rodent_bait');
    expect(line).toBeTruthy();
    expect(line.quoteRequired).not.toBe(true);
    expect(line.pricingConfidence).toBe('LOW');
    expect(commercialLowConfidenceRange({ lineItems: result.lineItems }).hasLowConfidence).toBe(true);
  });

  test('the license-sourced path keeps termite-bait and rodent-bait at MEDIUM (control)', async () => {
    resolveViaDbprLicense.mockResolvedValue({
      value: 1400, businessName: 'Test Taco Shop', seats: 25,
      evidence: [{ source: 'license_seats', detail: '25 seats -> 1,400 sq ft' }],
    });
    const profile = buildEnrichedProfile(plazaSuiteRecord(), null, 27.5, -82.45, null, null, SUITE_ADDRESS, { commercialSuiteSizing: true });
    await routePrivate.applyCommercialSuiteSize(profile);
    expect(profile.suiteSize.source).toBe('license_seats');

    const v1Input = translateV2CallToV1Input(profile, ['TERMITE_BAIT', 'RODENT_BAIT'], { commercialRiskType: 'restaurant_food', termiteScope: 'monitoring_only' });
    expect(v1Input.footprintSizeEstimated).toBeUndefined();

    const result = generateEstimate(v1Input);
    expect(result.lineItems.find((l) => l.service === 'commercial_termite_bait').pricingConfidence).toBe('MEDIUM');
    expect(result.lineItems.find((l) => l.service === 'commercial_rodent_bait').pricingConfidence).toBe('MEDIUM');
  });

  test('a suite\'s commercial lawn line never falls back to the plaza\'s lot — lot/turf were blanked, so it prices off the generic commercial default instead', async () => {
    resolveViaDbprLicense.mockResolvedValue({
      value: 1400, businessName: 'Test Taco Shop', seats: 25,
      evidence: [{ source: 'license_seats', detail: '25 seats -> 1,400 sq ft' }],
    });
    const record = plazaSuiteRecord({ lotSize: 93940 }); // the plaza's own lot — must never reach lawn pricing
    const profile = buildEnrichedProfile(record, null, 27.5, -82.45, null, null, SUITE_ADDRESS, { commercialSuiteSizing: true });
    await routePrivate.applyCommercialSuiteSize(profile);
    expect(profile.lotSqFt).toBe(0);

    const v1Input = translateV2CallToV1Input(profile, ['LAWN'], { commercialRiskType: 'restaurant_food' });
    expect(v1Input.lotSqFt).toBe(0);

    const result = generateEstimate(v1Input);
    const line = result.lineItems.find((l) => l.service === 'commercial_lawn');
    expect(line).toBeTruthy();
    // 45% of the plaza's 93,940 sq ft lot would be ~42,273 sq ft — nowhere
    // close to what a suite with no lot of its own should ever price.
    expect(line.turfBasis).not.toBe('commercialLotFallback');
    expect(line.turfSf).toBeLessThan(10000);
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

function suiteFacts(value, source, confidence = 'medium') {
  return {
    home: { value, source, confidence, rejected: [] },
    lot: { value: null, source: 'unresolved', confidence: 'none', rejected: [] },
  };
}

function commercialIntent(services, overrides = {}) {
  return { is_commercial: true, services, commercial_risk_type: 'restaurant_food', ...overrides };
}

describe('estimator engine path — buildEngineInput -> generateEstimate', () => {
  test('a license-sized suite prices off the suite footprint (no perimeter leak), MEDIUM confidence', () => {
    const engineInput = buildEngineInput({
      intent: commercialIntent({ pest: true }),
      propertyFacts: suiteFacts(1400, 'license_seats'),
      context: {},
    });
    // The engine path never carries a separate perimeter key for commercial
    // (draft-builder.js sets footprintSqFt only).
    expect(engineInput.perimeter).toBeUndefined();
    expect(engineInput.perimeterLF).toBeUndefined();
    expect(engineInput.footprintSqFt).toBe(1400);
    expect(engineInput.buildingSizeMeasured).toBe(true);
    expect(engineInput.footprintSizeEstimated).toBeUndefined();

    const result = generateEstimate(engineInput);
    const line = result.lineItems.find((l) => l.service === 'commercial_pest');
    expect(line).toBeTruthy();
    expect(line.footprintUsed).toBe(1400);
    expect(line.commercialPricingMode).toBe('auto_estimate');
    expect(line.pricingConfidence).toBe('MEDIUM');
    expect(line.monthly).toBeGreaterThan(EXPECTED_MONTHLY_MIN);
    expect(line.monthly).toBeLessThan(EXPECTED_MONTHLY_MAX);
  });

  test('a type-default suite still auto-prices, but every commercial line is LOW and the gate trips', () => {
    const engineInput = buildEngineInput({
      intent: commercialIntent({ pest: true }),
      propertyFacts: suiteFacts(1800, 'suite_type_default', 'low'),
      context: {},
    });
    expect(engineInput.footprintSizeEstimated).toBe(true);
    // Not a measured building — recurring pest is opted in separately.
    expect(engineInput.buildingSizeMeasured).toBe(false);

    const result = generateEstimate(engineInput);
    const line = result.lineItems.find((l) => l.service === 'commercial_pest');
    expect(line.commercialPricingMode).toBe('auto_estimate');
    expect(line.monthly).toBeGreaterThan(0);
    expect(line.pricingConfidence).toBe('LOW');
    expect(commercialLowConfidenceRange({ lineItems: result.lineItems }).hasLowConfidence).toBe(true);
  });

  // Codex #4872 r1 P1: a type default is NOT a measured building. Recurring
  // commercial pest is the only pricer opted in (footprintSizeEstimated);
  // every measured-only guard keeps its manual-quote posture.
  const typeDefaultInput = (services) => ({
    isCommercial: true,
    category: 'COMMERCIAL',
    propertyType: 'commercial',
    commercialRiskType: 'retail_standard',
    homeSqFt: 1500,
    footprintSqFt: 1500,
    buildingSizeMeasured: false,
    footprintSizeEstimated: true,
    stories: 1,
    services,
  });

  test('type default: recurring pest prices LOW; termite bait and rodent bait stay manual quotes', () => {
    const result = generateEstimate(typeDefaultInput({ pest: { frequency: 'monthly' }, termiteBait: {}, rodentBait: {} }));
    const pest = result.lineItems.find((l) => l.service === 'commercial_pest');
    expect(pest.commercialPricingMode).toBe('auto_estimate');
    expect(pest.pricingConfidence).toBe('LOW');
    for (const service of ['commercial_termite_bait', 'commercial_rodent_bait']) {
      const line = result.lineItems.find((l) => l.service === service);
      expect(line).toBeTruthy();
      expect(line.quoteRequired).toBe(true);
    }
  });

  test('type default: a hotel bed-bug job never gets an exact price off the guessed footprint', () => {
    const saved = process.env.GATE_COMMERCIAL_ONETIME_SCOPED;
    process.env.GATE_COMMERCIAL_ONETIME_SCOPED = 'true';
    try {
      const measured = generateEstimate({ ...typeDefaultInput({ bedBug: { method: 'CHEMICAL', rooms: 3, severity: 'light', prepStatus: 'ready', occupancyType: 'hotel' } }), buildingSizeMeasured: true, footprintSizeEstimated: undefined });
      const guessed = generateEstimate(typeDefaultInput({ bedBug: { method: 'CHEMICAL', rooms: 3, severity: 'light', prepStatus: 'ready', occupancyType: 'hotel' } }));
      // Off the guess, no priced bed-bug line exists — the request falls to
      // the commercial manual-quote row with no price.
      expect(guessed.lineItems.some((l) => l.service === 'bed_bug')).toBe(false);
      const manual = guessed.lineItems.find((l) => l.quoteRequired === true);
      expect(manual).toBeTruthy();
      expect(manual.commercialPricingMode).toBe('manual_quote');
      // Control: the same scoped job on a measured building does price.
      const priced = measured.lineItems.find((l) => l.service === 'bed_bug');
      expect(priced).toBeTruthy();
      expect(priced.quoteRequired).not.toBe(true);
    } finally {
      if (saved === undefined) delete process.env.GATE_COMMERCIAL_ONETIME_SCOPED;
      else process.env.GATE_COMMERCIAL_ONETIME_SCOPED = saved;
    }
  });
});

describe('aggregate parcel with unknown stories', () => {
  test('a resolved suite clears footprintUnknown so the suite footprint reaches pricing', async () => {
    const record = { ...plazaSuiteRecord(), stories: null, _parcel: { ...(plazaSuiteRecord()._parcel || {}), aggregated: true } };
    const profile = buildEnrichedProfile(record, null, 27.5, -82.45, null, null, SUITE_ADDRESS, { commercialSuiteSizing: true });
    await routePrivate.applyCommercialSuiteSize(profile);
    expect(profile.footprintUnknown).toBeUndefined();
    const v1Input = translateV2CallToV1Input(profile, ['PEST'], { commercialRiskType: 'restaurant_food' });
    expect(Number(v1Input.footprintSqFt)).toBe(profile.homeSqFt);
  });
});
