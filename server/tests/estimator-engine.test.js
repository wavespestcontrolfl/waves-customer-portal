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
    context: { isExistingCustomer: false, extractionSource: 'enriched' },
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

  test('property type resolves from lookup record, then extraction', () => {
    const fromRecord = resolvePropertyFacts({
      extraction: { property: { property_type: 'condo' } },
      propertyRecord: { propertyType: 'Townhome', squareFootage: 1400, yearBuilt: 2010, _parcel: countyParcel() },
      customer: null,
      isCommercial: false,
      subdivisionMedian: null,
    });
    expect(fromRecord.propertyType).toBe('Townhome');
    const fromExtraction = resolvePropertyFacts({
      extraction: { property: { property_type: 'condo' } },
      propertyRecord: null,
      customer: null,
      isCommercial: false,
      subdivisionMedian: null,
    });
    expect(fromExtraction.propertyType).toBe('Condo');
  });

  test('engine input carries the resolved property type and prior services', () => {
    const input = buildEngineInput({
      intent: baseIntent(),
      propertyFacts: {
        home: { value: 1400, source: SQFT_SOURCES.COUNTY_ASSESSED, rejected: [] },
        lot: { value: 5000, source: SQFT_SOURCES.COUNTY_ASSESSED, rejected: [] },
        propertyType: 'Condo',
      },
      context: {},
      priorQualifyingServices: ['lawn_care'],
    });
    expect(input.propertyType).toBe('Condo');
    expect(input.priorQualifyingServices).toEqual(['lawn_care']);
  });

  test('street-address comparison detects a different quoted property', () => {
    expect(idxPriv.sameStreetAddress('123 Example St, Testville FL', '123 Example Street')).toBe(true);
    expect(idxPriv.sameStreetAddress('123 Example St', '456 Other Rd')).toBe(false);
    expect(idxPriv.sameStreetAddress('123 Example St', null)).toBe(false);
  });

  test('street comparison catches suffix and directional corrections', () => {
    expect(idxPriv.sameStreetAddress('123 Palm St', '123 Palm Ave')).toBe(false);
    expect(idxPriv.sameStreetAddress('123 N Palm Ave', '123 North Palm Avenue')).toBe(true);
    expect(idxPriv.sameStreetAddress('123 Palm Ave, Bradenton FL', '123 Palm Avenue, Sarasota FL')).toBe(true);
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
});
