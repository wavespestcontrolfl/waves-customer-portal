/**
 * Estimator Engine — unit tests for the deterministic halves: intent schema
 * validation, property-fact source arbitration, engine-input mapping, totals
 * derivation, and lane classification. All fixtures are fully synthetic
 * (public repo — no real customer names, addresses, or call content).
 */

const { validateIntent } = require('../services/estimator-engine/intent-schema');
const {
  SQFT_SOURCES,
  resolvePropertyFacts,
  _private: arb,
} = require('../services/estimator-engine/source-arbitration');
const {
  LANES,
  buildEngineInput,
  deriveTotals,
  classifyLane,
  _private: draftPriv,
} = require('../services/estimator-engine/draft-builder');

// ── Fixtures (synthetic) ──────────────────────────────────────
const baseIntent = () => ({
  decision: 'draft',
  skip_reason: null,
  customer_name: 'Test Caller',
  customer_phone: '+19410000000',
  customer_email: 'test@example.com',
  address: '123 Example St, Testville, FL 34200',
  category: 'RESIDENTIAL',
  is_commercial: false,
  commercial_risk_type: null,
  commercial_subtype: null,
  services: { pest: { frequency: 'quarterly' } },
  service_interest_label: 'Quarterly Pest Control',
  evidence: [{ decision: 'pest quarterly', quote: 'looking for quarterly pest control', speaker: 'caller' }],
  constraint_flags: [],
  uncertainties: [],
  confidence: 'high',
});

const tenantExtraction = () => ({
  caller: { relationship_to_property: 'tenant' },
  property: { approximate_living_sqft: 1600, approximate_lot_size_acres: null },
});

// Mirrors the real _parcel meta: identity + lot + land-use only — building
// sqft/yearBuilt live on the merged record, subdivision on _raw.
const countyParcel = (overrides = {}) => ({
  county: 'Manatee',
  parcelId: '0000000000',
  lotSqft: 9000,
  landUseDescription: 'Single Family',
  ...overrides,
});

// ── Intent schema ─────────────────────────────────────────────
describe('intent schema', () => {
  test('accepts a well-formed draft intent', () => {
    expect(validateIntent(baseIntent()).valid).toBe(true);
  });

  test('rejects unknown service keys (manual-scope services stay out)', () => {
    const intent = baseIntent();
    intent.services = { wdo: {} };
    expect(validateIntent(intent).valid).toBe(false);
  });

  test('rejects price fields anywhere in the intent', () => {
    const intent = baseIntent();
    intent.monthly_total = 99;
    expect(validateIntent(intent).valid).toBe(false);
  });

  test('rejects out-of-vocabulary option values', () => {
    const intent = baseIntent();
    intent.services = { pest: { frequency: 'weekly' } };
    expect(validateIntent(intent).valid).toBe(false);
  });

  test('requires evidence array and confidence', () => {
    const intent = baseIntent();
    delete intent.evidence;
    expect(validateIntent(intent).valid).toBe(false);
  });

  test('a draft with EMPTY evidence fails (operator-verification contract)', () => {
    const intent = baseIntent();
    intent.evidence = [];
    expect(validateIntent(intent).valid).toBe(false);
  });

  test('category and is_commercial must agree', () => {
    const contradictory = baseIntent();
    contradictory.is_commercial = true; // category stays RESIDENTIAL
    expect(validateIntent(contradictory).valid).toBe(false);
    const agreeing = baseIntent();
    agreeing.is_commercial = true;
    agreeing.category = 'COMMERCIAL';
    expect(validateIntent(agreeing).valid).toBe(true);
  });

  test('live bee relocation is not an autonomous removal option', () => {
    const intent = baseIntent();
    intent.services = { stinging: { species: 'HONEY_BEE', tier: 2, removal: 'RELOCATE' } };
    expect(validateIntent(intent).valid).toBe(false);
  });

  test('a skip with empty evidence is still valid', () => {
    const intent = baseIntent();
    intent.decision = 'skip';
    intent.skip_reason = 'not a quote request';
    intent.services = {};
    intent.evidence = [];
    expect(validateIntent(intent).valid).toBe(true);
  });
});

// ── Source arbitration ────────────────────────────────────────
describe('sqft source arbitration', () => {
  test('commercial tenant with NO stated unit size never inherits the county building sqft', () => {
    const facts = resolvePropertyFacts({
      extraction: { caller: { relationship_to_property: 'tenant' }, property: {} },
      propertyRecord: { squareFootage: 8000, yearBuilt: 1998, _parcel: countyParcel({ landUseDescription: 'Multiple Unit Stores' }) },
      customer: null,
      isCommercial: true,
      subdivisionMedian: null,
    });
    expect(facts.home.value).toBeNull();
    expect(facts.home.source).toBe(SQFT_SOURCES.NONE);
    expect(facts.home.rejected[0].reason).toMatch(/no stated unit size/);
  });

  test('commercial tenant: caller-stated unit size outranks county building sqft', () => {
    const facts = resolvePropertyFacts({
      extraction: tenantExtraction(),
      propertyRecord: { squareFootage: 14000, yearBuilt: 1995, _parcel: countyParcel({ landUseDescription: 'Multiple Unit Stores' }) },
      customer: null,
      isCommercial: true,
      subdivisionMedian: null,
    });
    expect(facts.home.value).toBe(1600);
    expect(facts.home.source).toBe(SQFT_SOURCES.CALLER_STATED);
    expect(facts.home.rejected[0].source).toBe(SQFT_SOURCES.COUNTY_ASSESSED);
    expect(facts.tenant).toBe(true);
  });

  test('commercial non-tenant: county >3× caller-described space falls to caller', () => {
    const facts = resolvePropertyFacts({
      extraction: { caller: { relationship_to_property: 'owner' }, property: { approximate_living_sqft: 1500 } },
      propertyRecord: { squareFootage: 12000, yearBuilt: 1995, _parcel: countyParcel() },
      customer: null,
      isCommercial: true,
      subdivisionMedian: null,
    });
    expect(facts.home.value).toBe(1500);
    expect(facts.home.source).toBe(SQFT_SOURCES.CALLER_STATED);
  });

  test('residential: county-assessed wins; hard caller disagreement is flagged, not adopted', () => {
    const facts = resolvePropertyFacts({
      extraction: { property: { approximate_living_sqft: 4000 } },
      propertyRecord: { squareFootage: 2100, yearBuilt: 2005, _parcel: countyParcel() },
      customer: null,
      isCommercial: false,
      subdivisionMedian: null,
    });
    expect(facts.home.value).toBe(2100);
    expect(facts.home.source).toBe(SQFT_SOURCES.COUNTY_ASSESSED);
    expect(facts.home.disputed).toBe(true);
  });

  test('new construction: vacant county roll + subdivision median (n>=8) resolves', () => {
    const facts = resolvePropertyFacts({
      extraction: { property: {} },
      propertyRecord: {
        _parcel: countyParcel({ landUseDescription: 'Vacant Residential Platted (1554)' }),
      },
      customer: null,
      isCommercial: false,
      subdivisionMedian: { medianSqft: 1799, sampleCount: 268 },
    });
    expect(facts.home.value).toBe(1799);
    expect(facts.home.source).toBe(SQFT_SOURCES.SUBDIVISION_MEDIAN);
    expect(facts.newConstruction).toBe(true);
  });

  test('subdivision median with too few samples is NOT used', () => {
    const facts = resolvePropertyFacts({
      extraction: { property: {} },
      propertyRecord: {
        _parcel: countyParcel({ landUseDescription: 'Vacant Residential Platted' }),
      },
      customer: null,
      isCommercial: false,
      subdivisionMedian: { medianSqft: 2500, sampleCount: 3 },
    });
    expect(facts.home.source).toBe(SQFT_SOURCES.NONE);
    expect(facts.home.value).toBeNull();
  });

  test('lot: county parcel is authoritative even when the building is unassessed', () => {
    const facts = resolvePropertyFacts({
      extraction: { property: {} },
      propertyRecord: { _parcel: countyParcel({ lotSqft: 10578, landUseDescription: 'Vacant Residential Platted' }) },
      customer: null,
      isCommercial: false,
      subdivisionMedian: null,
    });
    expect(facts.lot.value).toBe(10578);
    expect(facts.lot.source).toBe(SQFT_SOURCES.COUNTY_ASSESSED);
  });

  test('unassessed detection: vacant land use with no building', () => {
    expect(arb.countyLooksUnassessed({ livingAreaSqft: null, yearBuilt: null, landUseDescription: 'Vacant Residential Platted' })).toBe(true);
    expect(arb.countyLooksUnassessed({ unassessedVacant: true })).toBe(true);
    expect(arb.countyLooksUnassessed({ livingAreaSqft: 2100, yearBuilt: 2005, landUseDescription: 'Single Family' })).toBe(false);
  });
});

// ── Engine input mapping ──────────────────────────────────────
describe('engine input mapping', () => {
  const facts = (homeSource, lotSource = SQFT_SOURCES.COUNTY_ASSESSED) => ({
    home: { value: 1600, source: homeSource, confidence: 'medium', rejected: [] },
    lot: { value: 8000, source: lotSource, confidence: 'high', rejected: [] },
    newConstruction: false,
    tenant: false,
  });

  test('commercial intent feeds footprint under both names and asserts measurement provenance', () => {
    const intent = { ...baseIntent(), is_commercial: true, category: 'COMMERCIAL', commercial_risk_type: 'restaurant_food', commercial_subtype: 'restaurant' };
    const input = buildEngineInput({ intent, propertyFacts: facts(SQFT_SOURCES.CALLER_STATED), context: {} });
    expect(input.footprintSqFt).toBe(1600);
    expect(input.homeSqFt).toBe(1600);
    expect(input.buildingSizeMeasured).toBe(true);
    expect(input.commercialRiskType).toBe('restaurant_food');
  });

  test('fallback-sourced building size must NOT auto-price commercial pest', () => {
    const intent = { ...baseIntent(), is_commercial: true, category: 'COMMERCIAL' };
    const input = buildEngineInput({ intent, propertyFacts: facts(SQFT_SOURCES.SUBDIVISION_MEDIAN), context: {} });
    expect(input.buildingSizeMeasured).toBe(false);
  });

  test('fallback-sourced lot does not assert lotSizeMeasured', () => {
    const input = buildEngineInput({
      intent: baseIntent(),
      propertyFacts: facts(SQFT_SOURCES.COUNTY_ASSESSED, SQFT_SOURCES.LOOKUP_ESTIMATE),
      context: {},
    });
    expect(input.lotSizeMeasured).toBe(false);
  });
});

// ── Totals ────────────────────────────────────────────────────
describe('totals derivation', () => {
  test('prefers the engine summary buckets', () => {
    const totals = deriveTotals({
      summary: { recurringMonthlyAfterDiscount: 39.5, recurringAnnualAfterDiscount: 474, oneTimeTotal: 99, specialtyTotal: 0 },
      lineItems: [],
    });
    expect(totals).toEqual({ monthly: 39.5, annual: 474, oneTime: 99 });
  });

  test('falls back to summing priced lines when the summary is empty (commercial flat lines)', () => {
    const totals = deriveTotals({
      summary: {},
      lineItems: [
        { service: 'commercial_pest', monthly: 105.02, annual: 1260.22 },
        { service: 'commercial_pest_manual', quoteRequired: true, monthly: null },
      ],
    });
    expect(totals.monthly).toBe(105.02);
    expect(totals.annual).toBe(1260.22);
  });
});

// ── Lane classification ───────────────────────────────────────
describe('lane classification', () => {
  const pricedResult = () => ({
    summary: {},
    lineItems: [{ service: 'pest_control', monthly: 39, annual: 468, pricingConfidence: 'high' }],
  });
  const solidFacts = () => ({
    home: { value: 2100, source: SQFT_SOURCES.COUNTY_ASSESSED, confidence: 'high', rejected: [] },
    lot: { value: 9000, source: SQFT_SOURCES.COUNTY_ASSESSED, confidence: 'high', rejected: [] },
    newConstruction: false,
    tenant: false,
  });
  const cleanArgs = () => ({
    intent: baseIntent(),
    propertyFacts: solidFacts(),
    engineResult: pricedResult(),
    totals: { monthly: 39, annual: 468, oneTime: 0 },
    comps: { samples: 10, median: 41, outlier: false, insufficient: false },
    calibration: [],
    context: {
      isExistingCustomer: false,
      extractionSource: 'enriched',
      transcript: 'Caller: hi, I am looking for quarterly pest control at my house.',
      smsThread: [],
    },
  });

  test('clean draft lands green', () => {
    const { lane, reasons } = classifyLane(cleanArgs());
    expect(lane).toBe(LANES.GREEN);
    expect(reasons).toEqual([]);
  });

  test('composer skip is red', () => {
    const args = cleanArgs();
    args.intent = { ...baseIntent(), decision: 'skip', skip_reason: 'rodent trapping is manual-scope' };
    expect(classifyLane(args).lane).toBe(LANES.RED);
  });

  test('commercial over 10k sqft is red (relationship quote)', () => {
    const args = cleanArgs();
    args.intent = { ...baseIntent(), is_commercial: true, category: 'COMMERCIAL' };
    args.propertyFacts = { ...solidFacts(), home: { value: 14250, source: SQFT_SOURCES.COUNTY_ASSESSED, rejected: [] } };
    expect(classifyLane(args).lane).toBe(LANES.RED);
  });

  test('nothing auto-priceable is red', () => {
    const args = cleanArgs();
    args.engineResult = { summary: {}, lineItems: [{ service: 'commercial_pest', quoteRequired: true, manualReviewReasons: ['commercial_pest_missing_building_footprint'] }] };
    args.totals = { monthly: 0, annual: 0, oneTime: 0 };
    expect(classifyLane(args).lane).toBe(LANES.RED);
  });

  test('fallback sqft source forces yellow', () => {
    const args = cleanArgs();
    args.propertyFacts = { ...solidFacts(), home: { value: 1799, source: SQFT_SOURCES.SUBDIVISION_MEDIAN, sampleCount: 268, rejected: [] } };
    const { lane, reasons } = classifyLane(args);
    expect(lane).toBe(LANES.YELLOW);
    expect(reasons.join(' ')).toMatch(/subdivision_median/);
  });

  test('constraint flags force yellow', () => {
    const args = cleanArgs();
    args.intent = { ...baseIntent(), constraint_flags: [{ flag: 'interior_only', note: 'landlord covers exterior' }] };
    const { lane, reasons } = classifyLane(args);
    expect(lane).toBe(LANES.YELLOW);
    expect(reasons.join(' ')).toMatch(/interior_only/);
  });

  test('comps outlier forces yellow', () => {
    const args = cleanArgs();
    args.comps = { samples: 12, median: 100, outlier: true, insufficient: false };
    expect(classifyLane(args).lane).toBe(LANES.YELLOW);
  });

  test('partial manual-quote lines force yellow, not red', () => {
    const args = cleanArgs();
    args.engineResult = {
      summary: {},
      lineItems: [
        { service: 'pest_control', monthly: 39, annual: 468 },
        { service: 'rodent_bait', quoteRequired: true },
      ],
    };
    const { lane, reasons } = classifyLane(args);
    expect(lane).toBe(LANES.YELLOW);
    expect(reasons.join(' ')).toMatch(/rodent_bait/);
  });

  test('existing active customer forces yellow (upsell review)', () => {
    const args = cleanArgs();
    args.context = { isExistingCustomer: true, extractionSource: 'enriched' };
    expect(classifyLane(args).lane).toBe(LANES.YELLOW);
  });

  test('manual-review detection covers every engine flag shape', () => {
    expect(draftPriv.lineRequiresReview({ quoteRequired: true })).toBe(true);
    expect(draftPriv.lineRequiresReview({ requiresManualReview: true })).toBe(true);
    expect(draftPriv.lineRequiresReview({ manualReviewReasons: ['x'] })).toBe(true);
    expect(draftPriv.lineRequiresReview({ monthly: 10 })).toBe(false);
  });

  test('evidence not covering every service forces yellow', () => {
    const args = cleanArgs();
    args.intent = { ...baseIntent(), services: { pest: {}, lawn: {} }, evidence: [{ decision: 'pest', quote: 'q', speaker: 'caller' }] };
    const { lane, reasons } = classifyLane(args);
    expect(lane).toBe(LANES.YELLOW);
    expect(reasons.join(' ')).toMatch(/evidence/);
  });

  test('ambiguous shared-phone profile match forces yellow', () => {
    const args = cleanArgs();
    args.context = { isExistingCustomer: false, extractionSource: 'enriched', customerPhoneAmbiguous: true };
    const { lane, reasons } = classifyLane(args);
    expect(lane).toBe(LANES.YELLOW);
    expect(reasons.join(' ')).toMatch(/share this phone/);
  });
});

// ── Codex-review regressions (PR #2761) ──────────────────────
describe('review fixes', () => {
  const { _private: ctxPriv } = require('../services/estimator-engine/context-builder');
  const { _private: idxPriv } = require('../services/estimator-engine/index');

  test('installation totals count toward one-time money', () => {
    const totals = deriveTotals({
      summary: { recurringMonthlyAfterDiscount: 40, recurringAnnualAfterDiscount: 480, oneTimeTotal: 0, installationTotal: 350 },
      lineItems: [],
    });
    expect(totals.oneTime).toBe(350);
  });

  test('shared phone: name match beats recency; no match marks ambiguous', () => {
    const rows = [
      { id: 'newer', first_name: 'Pat', last_name: 'Landlord' },
      { id: 'older', first_name: 'Sam', last_name: 'Caller' },
    ];
    const matched = ctxPriv.pickCustomerMatch(rows, { caller: { first_name: 'Sam', last_name: 'Caller' } });
    expect(matched.customer.id).toBe('older');
    expect(matched.ambiguous).toBe(false);
    const unmatched = ctxPriv.pickCustomerMatch(rows, { caller: { first_name: 'Alex', last_name: 'Unknown' } });
    expect(unmatched.customer.id).toBe('newer');
    expect(unmatched.ambiguous).toBe(true);
  });

  test('shared phone: same first name with a DIFFERENT last name is ambiguous, not a match', () => {
    const rows = [
      { id: 'a', first_name: 'Sam', last_name: 'Landlord' },
      { id: 'b', first_name: 'Sam', last_name: 'Tenant' },
    ];
    const result = ctxPriv.pickCustomerMatch(rows, { caller: { first_name: 'Sam', last_name: 'Visitor' } });
    expect(result.ambiguous).toBe(true);
  });

  test('shared phone: MULTIPLE rows with the same full name (multi-property customer) stay ambiguous', () => {
    const rows = [
      { id: 'home-a', first_name: 'Sam', last_name: 'Caller' },
      { id: 'home-b', first_name: 'Sam', last_name: 'Caller' },
    ];
    const result = ctxPriv.pickCustomerMatch(rows, { caller: { first_name: 'Sam', last_name: 'Caller' } });
    expect(result.ambiguous).toBe(true);
    expect(result.customer.id).toBe('home-a');
  });

  test('property type resolves from lookup record, then extraction', () => {
    const fromRecord = resolvePropertyFacts({
      extraction: { property: { property_type: 'condo' } },
      propertyRecord: { propertyType: 'Townhome', squareFootage: 1400, yearBuilt: 2010, _parcel: countyParcel() },
      customer: null,
      isCommercial: false,
      subdivisionMedian: null,
    });
    expect(fromRecord.propertyType).toBe('townhome_end');
    const fromExtraction = resolvePropertyFacts({
      extraction: { property: { property_type: 'condo' } },
      propertyRecord: null,
      customer: null,
      isCommercial: false,
      subdivisionMedian: null,
    });
    expect(fromExtraction.propertyType).toBe('condo_ground');
  });

  test('engine input carries the resolved property type, stories, and prior services', () => {
    const input = buildEngineInput({
      intent: baseIntent(),
      propertyFacts: {
        home: { value: 1400, source: SQFT_SOURCES.COUNTY_ASSESSED, rejected: [] },
        lot: { value: 5000, source: SQFT_SOURCES.COUNTY_ASSESSED, rejected: [] },
        propertyType: 'Condo',
        stories: 2,
      },
      context: {},
      priorQualifyingServices: ['lawn_care'],
    });
    expect(input.propertyType).toBe('Condo');
    expect(input.stories).toBe(2);
    expect(input.priorQualifyingServices).toEqual(['lawn_care']);
  });

  test('fresh resolved property type beats the profile saved type', () => {
    const input = buildEngineInput({
      intent: baseIntent(),
      propertyFacts: {
        home: { value: 1400, source: SQFT_SOURCES.COUNTY_ASSESSED, rejected: [] },
        lot: { value: 5000, source: SQFT_SOURCES.COUNTY_ASSESSED, rejected: [] },
        propertyType: 'Townhome',
      },
      context: { customer: { property_type: 'Single Family' } },
    });
    expect(input.propertyType).toBe('Townhome');
  });

  test('street-address comparison detects a different quoted property', () => {
    expect(idxPriv.sameStreetAddress('123 Example St, Testville FL', '123 Example Street')).toBe(true);
    expect(idxPriv.sameStreetAddress('123 Example St', '456 Other Rd')).toBe(false);
    expect(idxPriv.sameStreetAddress('123 Example St', null)).toBe(false);
  });

  test('street comparison catches suffix and directional corrections', () => {
    expect(idxPriv.sameStreetAddress('123 Palm St', '123 Palm Ave')).toBe(false);
    expect(idxPriv.sameStreetAddress('123 N Palm Ave', '123 North Palm Avenue')).toBe(true);
  });

  test('composer adding locality to a bare street triggers a re-gather', () => {
    expect(idxPriv.addressAddsLocality('123 Palm Ave, Bradenton FL 34209', '123 Palm Ave')).toBe(true);
    expect(idxPriv.addressAddsLocality('123 Palm Ave', '123 Palm Ave, Bradenton FL')).toBe(false);
    expect(idxPriv.addressAddsLocality('123 Palm Ave, Bradenton', '123 Palm Ave, Sarasota')).toBe(false);
  });

  test('an all-provisional draft is yellow, not red-suppressed', () => {
    const { lane, reasons } = classifyLane({
      intent: { ...baseIntent(), services: { lawn: { track: 'st_augustine', tier: 'enhanced' } } },
      propertyFacts: {
        home: { value: 2100, source: SQFT_SOURCES.COUNTY_ASSESSED, rejected: [] },
        lot: { value: 45000, source: SQFT_SOURCES.COUNTY_ASSESSED, rejected: [] },
      },
      engineResult: {
        summary: {},
        lineItems: [{ service: 'lawn_care', monthly: 260, annual: 3120, customQuoteFlag: true }],
      },
      totals: { monthly: 260, annual: 3120, oneTime: 0 },
      comps: null,
      calibration: [],
      context: { isExistingCustomer: false, extractionSource: 'enriched', transcript: 'looking for quarterly pest control', smsThread: [] },
    });
    expect(lane).toBe(LANES.YELLOW);
    expect(reasons.join(' ')).toMatch(/PROVISIONAL/);
  });

  test('verified sqft overrides count as authoritative, listing evidence does not', () => {
    const verified = resolvePropertyFacts({
      extraction: { property: {} },
      propertyRecord: {
        squareFootage: 2450,
        yearBuilt: 2012,
        _fieldEvidence: { squareFootage: { sourceType: 'verified' } },
        _parcel: countyParcel(),
      },
      customer: null,
      isCommercial: false,
      subdivisionMedian: null,
    });
    expect(verified.home.value).toBe(2450);
    expect(verified.home.source).toBe(SQFT_SOURCES.COUNTY_ASSESSED);
  });

  test('street comparison treats a city or ZIP change as a different parcel', () => {
    expect(idxPriv.sameStreetAddress('123 Palm Ave, Bradenton FL', '123 Palm Avenue, Sarasota FL')).toBe(false);
    expect(idxPriv.sameStreetAddress('123 Palm Ave, Bradenton FL 34209', '123 Palm Ave, Bradenton FL 34211')).toBe(false);
    expect(idxPriv.sameStreetAddress('123 Palm Ave, Bradenton FL 34209', '123 Palm Avenue, Bradenton FL 34209')).toBe(true);
    expect(idxPriv.sameStreetAddress('123 Palm Ave, Bradenton', '123 Palm Ave')).toBe(true);
  });

  test('token-sharing city pairs are still different parcels (North Port vs Port Charlotte)', () => {
    expect(idxPriv.sameStreetAddress('123 Palm Ave, North Port FL', '123 Palm Ave, Port Charlotte FL')).toBe(false);
  });

  test('priced-but-custom-quote lines are review-blocking', () => {
    expect(draftPriv.lineRequiresReview({ monthly: 250, customQuoteFlag: true })).toBe(true);
    expect(draftPriv.lineRequiresReview({ monthly: 250, requiresCustomQuote: true })).toBe(true);
  });

  test('stored totals stay CONSISTENT with the engine payload when priced review lines exist', () => {
    // Money-consistency rule (pre-push P0): the public view recomputes from
    // the engine payload, so stored totals must match it — priced review
    // lines stay in the totals and the lane flags them as provisional.
    const totals = deriveTotals({
      summary: { recurringMonthlyAfterDiscount: 300, recurringAnnualAfterDiscount: 3600, oneTimeTotal: 0 },
      lineItems: [
        { service: 'pest_control', monthly: 40, annual: 480 },
        { service: 'lawn_care', monthly: 260, annual: 3120, customQuoteFlag: true },
      ],
    });
    expect(totals.monthly).toBe(300);
    expect(totals.annual).toBe(3600);
  });

  test('priced custom-quote lines flag totals as provisional in the lane reasons', () => {
    const { lane, reasons } = classifyLane({
      intent: baseIntent(),
      propertyFacts: {
        home: { value: 2100, source: SQFT_SOURCES.COUNTY_ASSESSED, rejected: [] },
        lot: { value: 9000, source: SQFT_SOURCES.COUNTY_ASSESSED, rejected: [] },
      },
      engineResult: {
        summary: {},
        lineItems: [
          { service: 'pest_control', monthly: 40, annual: 480 },
          { service: 'lawn_care', monthly: 260, annual: 3120, customQuoteFlag: true },
        ],
      },
      totals: { monthly: 300, annual: 3600, oneTime: 0 },
      comps: null,
      calibration: [],
      context: { isExistingCustomer: false, extractionSource: 'enriched', transcript: 'looking for quarterly pest control', smsThread: [] },
    });
    expect(lane).toBe(LANES.YELLOW);
    expect(reasons.join(' ')).toMatch(/PROVISIONAL/);
  });

  test('fabricated evidence quotes force yellow; verbatim quotes pass', () => {
    const context = { transcript: 'Caller: I want quarterly pest control please.', smsThread: [] };
    const fabricated = draftPriv.verifyEvidenceQuotes(
      { evidence: [{ decision: 'pest', quote: 'definitely sign me up for the platinum plan' }] },
      context,
    );
    expect(fabricated.unverified).toBe(1);
    const verbatim = draftPriv.verifyEvidenceQuotes(
      { evidence: [{ decision: 'pest', quote: 'I want quarterly pest control' }] },
      context,
    );
    expect(verbatim.unverified).toBe(0);
  });

  test('commercial pest without a risk type forces yellow', () => {
    const { lane, reasons } = classifyLane({
      intent: {
        ...baseIntent(),
        is_commercial: true,
        category: 'COMMERCIAL',
        commercial_risk_type: null,
        evidence: [{ decision: 'pest', quote: 'looking for quarterly pest control', speaker: 'caller' }],
      },
      propertyFacts: {
        home: { value: 1600, source: SQFT_SOURCES.CALLER_STATED, rejected: [] },
        lot: { value: 8000, source: SQFT_SOURCES.COUNTY_ASSESSED, rejected: [] },
      },
      engineResult: { summary: {}, lineItems: [{ service: 'commercial_pest', monthly: 105, annual: 1260 }] },
      totals: { monthly: 105, annual: 1260, oneTime: 0 },
      comps: null,
      calibration: [],
      context: { isExistingCustomer: false, extractionSource: 'enriched', transcript: 'looking for quarterly pest control', smsThread: [] },
    });
    expect(lane).toBe(LANES.YELLOW);
    expect(reasons.join(' ')).toMatch(/risk type/);
  });

  test('non-county sqft evidence never claims county-assessed confidence', () => {
    const record = {
      squareFootage: 2600,
      yearBuilt: 2015,
      _fieldEvidence: { squareFootage: { sourceType: 'listing' } },
      _parcel: countyParcel(),
    };
    const facts = resolvePropertyFacts({
      extraction: { property: {} },
      propertyRecord: record,
      customer: null,
      isCommercial: false,
      subdivisionMedian: null,
    });
    expect(facts.home.source).toBe(SQFT_SOURCES.LOOKUP_ESTIMATE);
  });

  test('treated-lawn profile sqft is never a home-sqft source', () => {
    const facts = resolvePropertyFacts({
      extraction: { property: {} },
      propertyRecord: null,
      customer: { property_sqft: 6000, lot_sqft: 9000 },
      isCommercial: false,
      subdivisionMedian: null,
    });
    expect(facts.home.value).toBeNull();
    expect(facts.home.source).toBe(SQFT_SOURCES.NONE);
  });

  test('profile lawn sqft feeds measured turf ONLY when the profile describes the quoted property', () => {
    const facts = {
      home: { value: 2100, source: SQFT_SOURCES.COUNTY_ASSESSED, rejected: [] },
      lot: { value: 9000, source: SQFT_SOURCES.COUNTY_ASSESSED, rejected: [] },
    };
    const matched = buildEngineInput({
      intent: baseIntent(),
      propertyFacts: facts,
      context: { customer: { property_sqft: 6000 } },
      profileDescribesQuotedProperty: true,
    });
    expect(matched.measuredTurfSf).toBe(6000);
    expect(matched.homeSqFt).toBe(2100);
    // Different quoted property (extraction-supplied address, re-gather, or
    // ambiguous match) → the saved home's turf/type never leak in.
    const differentProperty = buildEngineInput({
      intent: baseIntent(),
      propertyFacts: facts,
      context: { customer: { property_sqft: 6000, property_type: 'Condo' } },
      profileDescribesQuotedProperty: false,
    });
    expect(differentProperty.measuredTurfSf).toBeUndefined();
    expect(differentProperty.propertyType).toBe('Single Family');
  });

  test('pricing-safe property type keys reach the pest normalizer alias table', () => {
    expect(arb.pricingSafePropertyType('Condo')).toBe('condo_ground');
    expect(arb.pricingSafePropertyType('condo')).toBe('condo_ground');
    expect(arb.pricingSafePropertyType('Townhome')).toBe('townhome_end');
    expect(arb.pricingSafePropertyType('Interior Townhome')).toBe('townhome_interior');
    expect(arb.pricingSafePropertyType('townhouse')).toBe('townhome_end');
    expect(arb.pricingSafePropertyType('single_family')).toBe('single_family');
    expect(arb.pricingSafePropertyType('Single Family')).toBe('single_family');
    expect(arb.pricingSafePropertyType(null)).toBeNull();
  });

  test('fallback lot source forces yellow for lot-driven services', () => {
    const { lane, reasons } = classifyLane({
      intent: { ...baseIntent(), services: { lawn: { track: 'st_augustine', tier: 'enhanced' } } },
      propertyFacts: {
        home: { value: 2100, source: SQFT_SOURCES.COUNTY_ASSESSED, rejected: [] },
        lot: { value: 8000, source: SQFT_SOURCES.LOOKUP_ESTIMATE, rejected: [] },
        newConstruction: false,
        tenant: false,
      },
      engineResult: { summary: {}, lineItems: [{ service: 'lawn_care', monthly: 60, annual: 720, turfSf: 5200 }] },
      totals: { monthly: 60, annual: 720, oneTime: 0 },
      comps: { samples: 10, median: 62, outlier: false, insufficient: false },
      calibration: [],
      context: { isExistingCustomer: false, extractionSource: 'enriched' },
    });
    expect(lane).toBe(LANES.YELLOW);
    expect(reasons.join(' ')).toMatch(/lot sqft from fallback/);
  });

  test('existing-customer address beats a stale phone-matched lead', () => {
    const context = {
      extraction: null,
      isExistingCustomer: true,
      customer: { address_line1: '10 Current Home Rd', city: 'Testville', state: 'FL', zip: '34200' },
      lead: { address: '99 Old Lead Property Ln', city: 'Elsewhere', zip: '34999' },
    };
    expect(idxPriv.addressFromContext(context)).toMatch(/Current Home/);
    context.isExistingCustomer = false;
    expect(idxPriv.addressFromContext(context)).toMatch(/Old Lead Property/);
  });

  test('ambiguous phone match never supplies the service address', () => {
    const context = {
      extraction: null,
      isExistingCustomer: false,
      customerPhoneAmbiguous: true,
      customer: { address_line1: '10 Wrong Profile Rd', city: 'Testville', state: 'FL', zip: '34200' },
      lead: null,
    };
    expect(idxPriv.addressFromContext(context)).toBeNull();
  });
});
