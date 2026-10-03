/**
 * Estimator-engine half of the business-identity scope decision (address-match
 * PR 5-1, GATE_LOOKUP_BUSINESS_IDENTITY): the lookup's verdict becomes unit
 * occupancy + part-building evidence for the unit-scope model, an unanswered
 * scope blocks the draft price, and a matched business makes a lead
 * commercial unless the call says the caller lives there.
 *
 * Drives runDraftPipeline (dry run) with the collaborators mocked; the
 * arbitration, unit-scope model, V2 shadow and lane classifier are the real ones.
 * All fixtures synthetic.
 */

process.env.GATE_UNIT_SCOPE_GUARDRAILS = 'true';
process.env.GATE_COMMERCIAL_SUITE_SIZING = 'true';

jest.mock('../models/db', () => {
  const db = () => ({
    where() { return this; },
    whereRaw() { return this; },
    whereNull() { return this; },
    orderBy() { return this; },
    select() { return this; },
    limit() { return this; },
    async first() { return null; },
    async update() { return 1; },
  });
  db.transaction = async (cb) => cb(db);
  db.raw = () => ({});
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockLookup = jest.fn();
jest.mock('../routes/property-lookup-v2', () => ({
  performPropertyLookup: (...args) => mockLookup(...args),
}));

const mockComposeIntent = jest.fn();
jest.mock('../services/estimator-engine/intent-composer', () => ({
  composeIntent: (...args) => mockComposeIntent(...args),
}));

const mockGenerateEstimate = jest.fn();
jest.mock('../services/pricing-engine', () => ({
  generateEstimate: (...args) => mockGenerateEstimate(...args),
}));

jest.mock('../services/estimator-engine/context-builder', () => ({
  buildCallContext: jest.fn(),
  existingDraftForCall: jest.fn(async () => null),
}));

const mockResolveSuite = jest.fn();
jest.mock('../services/commercial-suite-size', () => ({
  resolveCommercialSuiteSize: (...args) => mockResolveSuite(...args),
}));

const mockCreateDraft = jest.fn();
jest.mock('../services/estimator-engine/draft-builder', () => ({
  ...jest.requireActual('../services/estimator-engine/draft-builder'),
  compsBand: async () => null,
  calibrationWarnings: async () => [],
  createDraftEstimate: (...args) => mockCreateDraft(...args),
}));

jest.mock('../services/estimator-engine/commercial-proposal', () => ({
  commercialProposalsEnabled: () => false,
  maybeBuildCommercialProposalDraft: jest.fn(),
}));

const mockNotifyAdmin = jest.fn();
jest.mock('../services/notification-service', () => ({
  notifyAdmin: (...args) => { mockNotifyAdmin(...args); return Promise.resolve({ id: 'bell-1' }); },
}));

const { runDraftPipeline } = require('../services/estimator-engine');
const {
  lookupBusinessScope,
  callerLivesAtAddress,
  applyBusinessCommercialVerdict,
  businessSuiteSignals,
  scopeUnresolvedVerdict,
  businessReviewReasons,
} = require('../services/estimator-engine/business-scope-engine');
const { classifyLane, LANES } = require('../services/estimator-engine/draft-builder');
const { lookupCategoryConflict, resolveUnitScopeModel } = require('../services/estimator-engine/unit-scope-model');
const { computePropertyFactsV2Shadow } = require('../services/estimator-engine/property-facts-shadow');

const ADDRESS = '100 Example Plaza Dr, Examplecity, FL 00000';
const QUESTION = 'Are we treating just your space or the whole building?';

const ORIGIN = {
  channel: 'call',
  noun: 'call',
  threadKey: null,
  strings: {
    redTitle: 'RED-TITLE',
    redBody: (label, reasons) => `RED-BODY ${label} (${reasons})`,
    composerFailBody: (label) => `FAIL ${label}`,
    errorBody: 'ERROR',
    blockedTitle: 'BLOCKED-TITLE',
    blockedBody: (label) => `BLOCKED ${label}`,
    proposalTitle: 'PROPOSAL-TITLE',
    proposalBody: (label) => `PROPOSAL-BODY ${label}`,
  },
};

const intentFor = (over = {}) => ({
  decision: 'draft',
  customer_name: 'Test Caller',
  address: ADDRESS,
  is_commercial: false,
  category: 'pest',
  services: { pest: true },
  evidence: [{ speaker: 'caller', quote: 'we need pest control at the shop', decision: 'pest' }],
  constraint_flags: [],
  confidence: 'high',
  ...over,
});

const contextFor = (extraction = {}) => ({
  call: { id: 'call-1', twilio_call_sid: 'CA-int-1' },
  phone: '+19410000002',
  lead: { id: 'lead-1', address: ADDRESS },
  leadIsForThisCall: true,
  customer: null,
  customerPhoneAmbiguous: false,
  extraction,
  transcript: 'synthetic',
});

// What the property lookup hands the engine for the trigger case.
const record = () => ({ formattedAddress: ADDRESS, squareFootage: 9000, stories: 1, unitCount: 1, _source: 'ai' });
const enrichedFor = (over = {}) => ({
  category: 'COMMERCIAL',
  isCommercial: true,
  commercialSubtype: 'salon_spa',
  commercialDetectionSource: 'google_places_business',
  fieldVerifyFlags: [],
  ...over,
});

const pestLine = (sqft) => ({
  service: 'commercial_pest', name: 'Commercial Pest Control', monthly: 90, annual: 1080, footprintUsed: sqft, manualReviewReasons: [], pricingConfidence: 'MEDIUM',
});

const run = (extraction) => runDraftPipeline({
  context: contextFor(extraction),
  origin: ORIGIN,
  result: { lane: null, created: false },
  dryRun: true,
  quotePromised: true,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockLookup.mockResolvedValue({ propertyRecord: record(), enriched: enrichedFor({ serviceScopeDecision: 'commercial_suite' }), meta: { cache: 'miss' } });
  mockComposeIntent.mockResolvedValue({ intent: intentFor(), model: 'test-composer' });
  mockGenerateEstimate.mockImplementation(() => ({ lineItems: [pestLine(1200)], totals: {} }));
  mockResolveSuite.mockResolvedValue({
    value: 1200, source: 'suite_type_default', confidence: 'low', businessName: null, businessType: null, defaultBasis: 'salon_spa', evidence: [],
  });
});

describe('pure helpers', () => {
  test('lookupBusinessScope reads the lookup verdict only when it describes the gathered address', () => {
    const enriched = enrichedFor({ serviceScopeDecision: 'scope_unresolved', serviceScopeQuestion: QUESTION });
    expect(lookupBusinessScope(enriched, true)).toEqual({ decision: 'scope_unresolved', question: QUESTION, commercial: true });
    expect(lookupBusinessScope(enriched, false)).toBeNull();
    expect(lookupBusinessScope(null, true)).toBeNull();
    expect(lookupBusinessScope({ category: 'COMMERCIAL', commercialDetectionSource: 'property_record_property_type' }, true)).toBeNull();
  });

  test('"lives there" is the extraction\'s own property-role fields, never a relationship', () => {
    expect(callerLivesAtAddress({ property: { service_address_is_primary_residence: true } })).toBe(true);
    expect(callerLivesAtAddress({ property: { service_address_occupancy: 'owner_occupied' } })).toBe(true);
    // "Our winter place": a home, though not the caller's main one.
    expect(callerLivesAtAddress({ property: { service_address_occupancy: 'seasonal', service_address_is_primary_residence: false } })).toBe(true);
    expect(callerLivesAtAddress({ property: { service_address_occupancy: 'commercial' } })).toBe(false);
    expect(callerLivesAtAddress({ property: { service_address_occupancy: 'rental_investment' } })).toBe(false);
    expect(callerLivesAtAddress({ caller: { relationship_to_property: 'owner' } })).toBe(false);
    expect(callerLivesAtAddress(null)).toBe(false);
  });

  test('a business-identified suite counts as unit occupancy + part-building evidence; nothing else does', () => {
    expect(businessSuiteSignals({ unitSignal: false, partBuilding: false }, { decision: 'commercial_suite' }))
      .toEqual({ unitSignal: true, partBuilding: true });
    for (const scope of [null, undefined, { decision: 'scope_unresolved' }, { decision: 'entire_commercial_building' }]) {
      expect(businessSuiteSignals({ unitSignal: false, partBuilding: false }, scope)).toEqual({ unitSignal: false, partBuilding: false });
    }
    expect(businessSuiteSignals({ unitSignal: true, partBuilding: false }, null)).toEqual({ unitSignal: true, partBuilding: false });
  });

  test('the lookup\'s own Places-derived commercial verdict is no category conflict for the engine to red-lane', () => {
    const args = { isCommercialIntent: false, enrichedCategory: 'COMMERCIAL', commercialSubtype: 'salon_spa', serviceScope: 'entire_commercial_building' };
    expect(lookupCategoryConflict({ ...args, commercialDetectionSource: 'google_places_business' })).toBeNull();
    expect(lookupCategoryConflict({ ...args, commercialDetectionSource: 'property_record_property_type' })).toBe('lookup_category:commercial');
  });
});

describe('unit-scope model and V2 shadow', () => {
  const base = () => ({
    propertyRecord: record(),
    extraction: {},
    intent: { is_commercial: true, address: ADDRESS },
    propertyFacts: { home: { value: 9000, source: 'property_lookup_estimate' }, lot: { value: null }, tenant: false },
    address: ADDRESS,
  });

  test('without the business verdict: the trigger case is a whole-building scope (today)', () => {
    expect(resolveUnitScopeModel(base()).serviceScope).toBe('entire_commercial_building');
  });

  test('with a commercial_suite verdict: the same facts read as one suite with part-building evidence', () => {
    const model = resolveUnitScopeModel({ ...base(), businessScope: { decision: 'commercial_suite' } });
    expect(model.serviceScope).toBe('commercial_suite');
    expect(model.partBuildingEvidence).toBe(true);
    expect(model.unitSignal).toBe(true);
    // No individual lot either way: the building's lot is cleared by the apply.
    expect(['no_individual_lot', 'common_master_parcel']).toContain(model.lotApplicability);
  });

  test('scope_unresolved and entire_commercial_building verdicts change nothing in the model', () => {
    for (const decision of ['scope_unresolved', 'entire_commercial_building']) {
      expect(resolveUnitScopeModel({ ...base(), businessScope: { decision } }).serviceScope).toBe('entire_commercial_building');
    }
  });

  test('the V2 shadow takes the same verdict', () => {
    const args = {
      propertyRecord: { ...record(), propertyType: 'Commercial' },
      extraction: {},
      intent: { is_commercial: true },
      propertyFacts: { home: { value: 9000, source: 'property_lookup_estimate' }, tenant: false },
      address: ADDRESS,
    };
    const without = computePropertyFactsV2Shadow(args);
    const withSuite = computePropertyFactsV2Shadow({ ...args, businessScope: { decision: 'commercial_suite' } });
    expect(without?.facts?.serviceScope).toBe('entire_commercial_building');
    expect(withSuite?.facts?.serviceScope).toBe('commercial_suite');
  });
});

describe('classifyLane: an unanswered scope blocks the price', () => {
  const intent = intentFor({ is_commercial: true });
  const facts = (businessScope) => ({
    home: { value: 1200, source: 'suite_type_default', confidence: 'low', rejected: [] },
    lot: { value: null, source: 'unresolved', confidence: 'none', rejected: [] },
    ...(businessScope ? { businessScope } : {}),
  });
  const args = (propertyFacts) => ({
    intent, propertyFacts, engineResult: { lineItems: [pestLine(1200)] }, totals: { monthly: 90, annual: 1080, oneTime: 0 }, comps: null, calibration: [],
  });

  test('scope_unresolved → RED, reason commercial_scope_unresolved with the question, cause named', () => {
    const out = classifyLane(args(facts({ decision: 'scope_unresolved', question: QUESTION })));
    expect(out.lane).toBe(LANES.RED);
    expect(out.causes).toEqual(['commercial_scope_unresolved']);
    expect(out.reasons.join(' ')).toMatch(/commercial_scope_unresolved/);
    expect(out.reasons.join(' ')).toContain(QUESTION);
  });

  test('every other verdict leaves the lane to its usual rules', () => {
    for (const decision of ['commercial_suite', 'entire_commercial_building', null]) {
      const out = classifyLane(args(facts({ decision, question: null })));
      expect(out.reasons.join(' ')).not.toMatch(/commercial_scope_unresolved/);
      expect(out.lane).not.toBe(LANES.RED);
    }
    expect(classifyLane(args(facts(null))).lane).not.toBe(LANES.RED);
  });

  test('the verdict helpers are inert without a stamp', () => {
    expect(scopeUnresolvedVerdict({})).toBeNull();
    expect(scopeUnresolvedVerdict(null)).toBeNull();
    expect(businessReviewReasons({})).toEqual([]);
  });
});

describe('the draft pipeline', () => {
  test('a business-identified suite: the lead is commercial, unit-scope reads one suite, suite sizing runs, the draft parks yellow', async () => {
    const result = await run({});
    expect(result.intent.is_commercial).toBe(true);
    expect(result.unitScope.serviceScope).toBe('commercial_suite');
    expect(mockResolveSuite).toHaveBeenCalledTimes(1);
    expect(mockResolveSuite.mock.calls[0][0].commercialSubtype).toBe('salon_spa');
    expect(result.propertyFacts.home).toMatchObject({ value: 1200, source: 'suite_type_default' });
    expect(result.propertyFacts.businessScope).toMatchObject({ decision: 'commercial_suite', promoted: true, keptResidential: false });
    expect(result.lane).toBe(LANES.YELLOW);
    expect(result.reasons.join(' | ')).toMatch(/marked commercial because Google lists an operating business/);
    expect(result.reasons.join(' | ')).toMatch(/suite size not found by license — defaulted to 1,200 sq ft/);
    expect(result.reasons.join(' | ')).not.toMatch(/commercial_scope_unresolved/);
  });

  test('scope_unresolved: no price, the manual-quote RED with reason commercial_scope_unresolved and the question', async () => {
    mockLookup.mockResolvedValue({
      propertyRecord: record(),
      enriched: enrichedFor({ serviceScopeDecision: 'scope_unresolved', serviceScopeQuestion: QUESTION }),
      meta: { cache: 'miss' },
    });
    const result = await run({});
    expect(result.lane).toBe(LANES.RED);
    expect(result.reasons.join(' ')).toMatch(/commercial_scope_unresolved/);
    expect(result.reasons.join(' ')).toContain(QUESTION);
    expect(mockResolveSuite).not.toHaveBeenCalled();
    expect(result.propertyFacts.home.source).not.toBe('suite_type_default');
  });

  test('scope_unresolved on a live (non-dry) run: no draft is created and the red bell carries the question', async () => {
    mockLookup.mockResolvedValue({
      propertyRecord: record(),
      enriched: enrichedFor({ serviceScopeDecision: 'scope_unresolved', serviceScopeQuestion: QUESTION }),
      meta: { cache: 'miss' },
    });
    const result = await runDraftPipeline({
      context: contextFor({}), origin: ORIGIN, result: { lane: null, created: false }, quotePromised: true,
    });
    expect(result.lane).toBe(LANES.RED);
    expect(mockCreateDraft).not.toHaveBeenCalled();
    const body = JSON.stringify(mockNotifyAdmin.mock.calls);
    expect(body).toContain('commercial_scope_unresolved');
    expect(body).toContain(QUESTION);
  });

  test('an unanswered scope is never decided from a lookup that does not describe the gathered address', async () => {
    mockLookup.mockResolvedValue({
      propertyRecord: record(),
      enriched: enrichedFor({
        serviceScopeDecision: 'scope_unresolved', serviceScopeQuestion: QUESTION,
        fieldVerifyFlags: [{ field: 'address', priority: 'HIGH', reason: 'wrong premise' }],
      }),
      meta: { cache: 'miss' },
    });
    const result = await run({});
    expect(result.propertyFacts.businessScope).toBeUndefined();
    expect(result.intent.is_commercial).toBe(false);
    expect(result.reasons.join(' ')).not.toMatch(/commercial_scope_unresolved/);
  });

  test('the caller says they LIVE there: the lead stays residential with a review flag, no scope question, no commercial red', async () => {
    mockLookup.mockResolvedValue({
      propertyRecord: record(),
      enriched: enrichedFor({ serviceScopeDecision: 'scope_unresolved', serviceScopeQuestion: QUESTION }),
      meta: { cache: 'miss' },
    });
    mockGenerateEstimate.mockImplementation(() => ({
      lineItems: [{ service: 'pest', name: 'Pest Control', monthly: 60, annual: 720, manualReviewReasons: [], pricingConfidence: 'MEDIUM' }],
      totals: {},
    }));
    const result = await run({ property: { service_address_is_primary_residence: true } });
    expect(result.intent.is_commercial).toBe(false);
    expect(result.propertyFacts.businessScope).toMatchObject({ keptResidential: true, promoted: false, decision: null });
    expect(result.reasons.join(' | ')).toMatch(/Google lists an operating business at this address but the caller says they live here/);
    expect(result.reasons.join(' | ')).not.toMatch(/commercial_scope_unresolved|call describes a commercial premises/);
    expect(mockResolveSuite).not.toHaveBeenCalled();
  });

  test('a composer that already typed the lead commercial keeps it (and the scope decision applies)', async () => {
    mockComposeIntent.mockResolvedValue({ intent: intentFor({ is_commercial: true }), model: 'test-composer' });
    const result = await run({});
    expect(result.intent.is_commercial).toBe(true);
    expect(result.propertyFacts.businessScope).toMatchObject({ promoted: false, keptResidential: false, decision: 'commercial_suite' });
    expect(result.reasons.join(' | ')).not.toMatch(/marked commercial because Google lists/);
  });

  test('no business verdict (gate off or no match): nothing stamped, no extra reason, byte-identical flow', async () => {
    mockLookup.mockResolvedValue({
      propertyRecord: record(),
      enriched: { category: 'COMMERCIAL', commercialDetectionSource: 'property_record_property_type', commercialSubtype: 'office_retail', fieldVerifyFlags: [] },
      meta: { cache: 'miss' },
    });
    mockComposeIntent.mockResolvedValue({ intent: intentFor({ is_commercial: true }), model: 'test-composer' });
    const result = await run({});
    expect(result.propertyFacts).not.toHaveProperty('businessScope');
    expect(result.reasons.join(' | ')).not.toMatch(/Google lists|commercial_scope_unresolved/);
    expect(applyBusinessCommercialVerdict({ intent: intentFor(), enriched: null, parcelOk: true, extraction: {} })).toBeNull();
  });
});
