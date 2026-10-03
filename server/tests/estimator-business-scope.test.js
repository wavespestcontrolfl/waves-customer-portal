/**
 * Estimator-engine half of the business-identity scope question
 * (GATE_LOOKUP_BUSINESS_IDENTITY). Owner ruling: Google Places may only
 * suggest on screen, nothing derived from it is saved, so the engine (call
 * drafts, no human in the loop) never applies a Places conclusion. With a
 * business listed and the scope open (`scope_unresolved`) it can only say a
 * human must confirm: red lane when the call says commercial or says nothing
 * about living there, a yellow review flag when the caller lives there. The
 * intent is never promoted to commercial.
 *
 * Drives runDraftPipeline (dry run) with the collaborators mocked; the
 * arbitration, unit-scope model, V2 shadow and lane classifier are the real
 * ones. All fixtures synthetic.
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
  stampBusinessScope,
  scopeUnresolvedVerdict,
  businessReviewReasons,
} = require('../services/estimator-engine/business-scope-engine');
const businessScopeEngine = require('../services/estimator-engine/business-scope-engine');
const { classifyLane, LANES } = require('../services/estimator-engine/draft-builder');

const ADDRESS = '100 Example Plaza Dr, Examplecity, FL 00000';
const QUESTION = 'Are we treating just your space or the whole building?';
const CONFIRM_REASON = 'commercial_scope_unresolved: an operating business may be at this address — confirm in Property Lookup whether the customer is that business, and whether the job is just their space or the whole building — no price until it is answered';
const KEPT_REASON = 'a business may be listed at this address but the caller says they live here — kept residential, confirm';

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

const record = () => ({ formattedAddress: ADDRESS, squareFootage: 2000, stories: 1, unitCount: 1, _source: 'ai' });
// The lookup's BASE values: with a business listed Places changes none of
// them, it only adds the open scope question.
const baseEnriched = (over = {}) => ({
  category: 'RESIDENTIAL',
  isCommercial: false,
  commercialSubtype: null,
  commercialDetectionSource: null,
  fieldVerifyFlags: [],
  ...over,
});
const withQuestion = (over = {}) => baseEnriched({ serviceScopeDecision: 'scope_unresolved', serviceScopeQuestion: QUESTION, ...over });

const pestLine = (sqft = 2000) => ({
  service: 'pest', name: 'Pest Control', monthly: 60, annual: 720, footprintUsed: sqft, manualReviewReasons: [], pricingConfidence: 'MEDIUM',
});

const lookupReturns = (enriched) => mockLookup.mockResolvedValue({ propertyRecord: record(), enriched, meta: { cache: 'miss' } });

const run = (extraction, { dryRun = true } = {}) => runDraftPipeline({
  context: contextFor(extraction),
  origin: ORIGIN,
  result: { lane: null, created: false },
  dryRun,
  quotePromised: true,
});

beforeEach(() => {
  jest.clearAllMocks();
  lookupReturns(withQuestion());
  mockComposeIntent.mockResolvedValue({ intent: intentFor(), model: 'test-composer' });
  mockGenerateEstimate.mockImplementation(() => ({ lineItems: [pestLine()], totals: {} }));
  mockResolveSuite.mockResolvedValue({
    value: 1200, source: 'suite_type_default', confidence: 'low', businessName: null, businessType: null, defaultBasis: null, evidence: [],
  });
});

describe('pure helpers', () => {
  test('lookupBusinessScope reads only the open question, and only when the lookup describes the gathered address', () => {
    expect(lookupBusinessScope(withQuestion(), true)).toEqual({ decision: 'scope_unresolved', question: QUESTION });
    expect(lookupBusinessScope(withQuestion(), false)).toBeNull();
    expect(lookupBusinessScope(null, true)).toBeNull();
    expect(lookupBusinessScope(baseEnriched(), true)).toBeNull();
    // The engine never applies a suite / whole-building conclusion.
    for (const decision of ['commercial_suite', 'entire_commercial_building']) {
      expect(lookupBusinessScope(baseEnriched({ serviceScopeDecision: decision }), true)).toBeNull();
    }
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

  test('the engine exports no promotion or suite-signal helpers any more', () => {
    expect(businessScopeEngine.businessSuiteSignals).toBeUndefined();
    expect(businessScopeEngine.BUSINESS_DETECTION_SOURCE).toBeUndefined();
  });

  test('applyBusinessCommercialVerdict: never touches the intent, returns the three shapes', () => {
    const lives = { property: { service_address_is_primary_residence: true } };
    const args = { enriched: withQuestion(), parcelOk: true, extraction: {} };

    const commercial = intentFor({ is_commercial: true });
    expect(applyBusinessCommercialVerdict({ ...args, intent: commercial }))
      .toEqual({ decision: 'scope_unresolved', question: QUESTION, keptResidential: false, needsConfirmation: false });
    expect(commercial.is_commercial).toBe(true);

    const residentLives = intentFor();
    expect(applyBusinessCommercialVerdict({ ...args, intent: residentLives, extraction: lives }))
      .toEqual({ decision: null, question: null, keptResidential: true, needsConfirmation: false });
    expect(residentLives.is_commercial).toBe(false);

    const residentOther = intentFor();
    expect(applyBusinessCommercialVerdict({ ...args, intent: residentOther }))
      .toEqual({ decision: 'scope_unresolved', question: null, keptResidential: false, needsConfirmation: true });
    expect(residentOther.is_commercial).toBe(false);
  });

  test('a cross-property re-gather cannot use the primary call\'s "lives there"', () => {
    const verdict = applyBusinessCommercialVerdict({
      intent: intentFor(),
      enriched: withQuestion(),
      parcelOk: true,
      extraction: { property: { service_address_is_primary_residence: true } },
      crossProperty: true,
    });
    expect(verdict).toMatchObject({ keptResidential: false, needsConfirmation: true });
  });

  test('inert without an open question: null verdict, nothing stamped, no reasons', () => {
    expect(applyBusinessCommercialVerdict({ intent: intentFor(), enriched: baseEnriched(), parcelOk: true, extraction: {} })).toBeNull();
    expect(applyBusinessCommercialVerdict({ intent: intentFor(), enriched: withQuestion(), parcelOk: false, extraction: {} })).toBeNull();
    expect(applyBusinessCommercialVerdict({ intent: intentFor(), enriched: null, parcelOk: true, extraction: {} })).toBeNull();
    expect(applyBusinessCommercialVerdict({ intent: null, enriched: withQuestion(), parcelOk: true, extraction: {} })).toBeNull();
    const facts = { home: { value: 1 } };
    expect(stampBusinessScope(facts, null)).toBe(facts);
    expect(facts).not.toHaveProperty('businessScope');
    expect(scopeUnresolvedVerdict({})).toBeNull();
    expect(scopeUnresolvedVerdict(null)).toBeNull();
    expect(scopeUnresolvedVerdict({ businessScope: { decision: null, keptResidential: true } })).toBeNull();
    expect(businessReviewReasons({})).toEqual([]);
    expect(businessReviewReasons(null)).toEqual([]);
  });

  test('scopeUnresolvedVerdict wording per shape', () => {
    expect(scopeUnresolvedVerdict({ businessScope: { decision: 'scope_unresolved', question: QUESTION, needsConfirmation: false } }))
      .toEqual({ reasons: [`commercial_scope_unresolved: ${QUESTION} — no price until it is answered`], causes: ['commercial_scope_unresolved'] });
    expect(scopeUnresolvedVerdict({ businessScope: { decision: 'scope_unresolved', question: null, needsConfirmation: true } }))
      .toEqual({ reasons: [CONFIRM_REASON], causes: ['commercial_scope_unresolved'] });
    expect(businessReviewReasons({ businessScope: { keptResidential: true } })).toEqual([KEPT_REASON]);
  });
});

describe('classifyLane', () => {
  const facts = (businessScope) => ({
    home: { value: 2000, source: 'property_lookup_estimate', confidence: 'medium', rejected: [] },
    lot: { value: null, source: 'unresolved', confidence: 'none', rejected: [] },
    ...(businessScope ? { businessScope } : {}),
  });
  const args = (intent, propertyFacts) => ({
    intent, propertyFacts, engineResult: { lineItems: [pestLine()] }, totals: { monthly: 60, annual: 720, oneTime: 0 }, comps: null, calibration: [],
  });

  test('an open scope is RED with the cause named, for both reason shapes', () => {
    const asked = classifyLane(args(intentFor({ is_commercial: true }), facts({ decision: 'scope_unresolved', question: QUESTION, keptResidential: false, needsConfirmation: false })));
    expect(asked.lane).toBe(LANES.RED);
    expect(asked.causes).toEqual(['commercial_scope_unresolved']);
    expect(asked.reasons.join(' ')).toContain(QUESTION);
    const confirm = classifyLane(args(intentFor(), facts({ decision: 'scope_unresolved', question: null, keptResidential: false, needsConfirmation: true })));
    expect(confirm.lane).toBe(LANES.RED);
    expect(confirm.causes).toEqual(['commercial_scope_unresolved']);
    expect(confirm.reasons).toEqual([CONFIRM_REASON]);
  });

  test('kept residential and no-stamp facts are not red for scope', () => {
    const kept = classifyLane(args(intentFor(), facts({ decision: null, question: null, keptResidential: true, needsConfirmation: false })));
    expect(kept.lane).not.toBe(LANES.RED);
    expect(kept.reasons).toContain(KEPT_REASON);
    const none = classifyLane(args(intentFor(), facts(null)));
    expect(none.lane).not.toBe(LANES.RED);
    expect(none.reasons.join(' ')).not.toMatch(/commercial_scope_unresolved|business may be listed/);
  });
});

describe('the draft pipeline', () => {
  const noPriceNoSuiteSizing = (result) => {
    expect(mockResolveSuite).not.toHaveBeenCalled();
    expect(result.propertyFacts.home.source).not.toBe('suite_type_default');
  };

  test('rule 1: the call already says commercial → RED, reason carries the question, no price', async () => {
    mockComposeIntent.mockResolvedValue({ intent: intentFor({ is_commercial: true }), model: 'test-composer' });
    const result = await run({});
    expect(result.lane).toBe(LANES.RED);
    expect(result.intent.is_commercial).toBe(true);
    expect(result.reasons.join(' ')).toMatch(/commercial_scope_unresolved/);
    expect(result.reasons.join(' ')).toContain(QUESTION);
    expect(result.propertyFacts.businessScope).toEqual({ decision: 'scope_unresolved', question: QUESTION, keptResidential: false, needsConfirmation: false });
    noPriceNoSuiteSizing(result);
  });

  test('rule 1 on a live (non-dry) run: no draft is created and the red bell carries the question', async () => {
    mockComposeIntent.mockResolvedValue({ intent: intentFor({ is_commercial: true }), model: 'test-composer' });
    const result = await run({}, { dryRun: false });
    expect(result.lane).toBe(LANES.RED);
    expect(mockCreateDraft).not.toHaveBeenCalled();
    const body = JSON.stringify(mockNotifyAdmin.mock.calls);
    expect(body).toContain('commercial_scope_unresolved');
    expect(body).toContain(QUESTION);
  });

  test('rule 2: the caller lives there → stays residential, no question, no red, ONE review reason', async () => {
    for (const property of [
      { service_address_is_primary_residence: true },
      { service_address_occupancy: 'owner_occupied' },
      { service_address_occupancy: 'seasonal', service_address_is_primary_residence: false },
    ]) {
      const result = await run({ property });
      expect(result.intent.is_commercial).toBe(false);
      expect(result.lane).not.toBe(LANES.RED);
      expect(result.propertyFacts.businessScope).toEqual({ decision: null, question: null, keptResidential: true, needsConfirmation: false });
      expect(result.reasons.filter((r) => r === KEPT_REASON)).toHaveLength(1);
      expect(result.reasons.join(' | ')).not.toMatch(/commercial_scope_unresolved|call describes a commercial premises/);
      expect(JSON.stringify(result.reasons)).not.toContain(QUESTION);
      expect(mockResolveSuite).not.toHaveBeenCalled();
    }
  });

  test('rule 3: residential otherwise → NOT promoted, RED with the confirm reason, no price', async () => {
    for (const extraction of [{}, { property: { service_address_occupancy: 'rental_investment' } }, { caller: { relationship_to_property: 'owner' } }]) {
      const result = await run(extraction);
      expect(result.intent.is_commercial).toBe(false);
      expect(result.lane).toBe(LANES.RED);
      expect(result.reasons).toContain(CONFIRM_REASON);
      expect(result.propertyFacts.businessScope).toEqual({ decision: 'scope_unresolved', question: null, keptResidential: false, needsConfirmation: true });
      noPriceNoSuiteSizing(result);
    }
  });

  test('cross-property re-gather: the primary call\'s "lives there" does not carry to the re-gathered property', async () => {
    const OTHER = '200 Example Plaza Dr, Examplecity, FL 00000';
    mockComposeIntent.mockResolvedValue({ intent: intentFor({ address: OTHER }), model: 'test-composer' });
    mockLookup.mockResolvedValue({
      propertyRecord: { ...record(), formattedAddress: OTHER },
      enriched: withQuestion(),
      meta: { cache: 'miss' },
    });
    const result = await run({ property: { service_address_is_primary_residence: true } });
    expect(result.intent.is_commercial).toBe(false);
    expect(result.propertyFacts.businessScope).toEqual({ decision: 'scope_unresolved', question: null, keptResidential: false, needsConfirmation: true });
    expect(result.lane).toBe(LANES.RED);
    expect(result.reasons).toContain(CONFIRM_REASON);
  });

  test('parcelOk false: a lookup that does not describe the gathered address decides nothing', async () => {
    lookupReturns(withQuestion({ fieldVerifyFlags: [{ field: 'address', priority: 'HIGH', reason: 'wrong premise' }] }));
    for (const intent of [intentFor(), intentFor({ is_commercial: true })]) {
      mockComposeIntent.mockResolvedValue({ intent, model: 'test-composer' });
      const result = await run({});
      expect(result.propertyFacts.businessScope).toBeUndefined();
      expect(result.reasons.join(' ')).not.toMatch(/commercial_scope_unresolved|business may be listed/);
      expect(result.intent.is_commercial).toBe(intent.is_commercial);
    }
  });

  test('gate off / no business listed: nothing stamped, identical draft with or without the other lookup keys', async () => {
    lookupReturns(baseEnriched());
    const plain = await run({});
    expect(plain.propertyFacts).not.toHaveProperty('businessScope');
    expect(plain.lane).not.toBe(LANES.RED);
    expect(plain.reasons.join(' | ')).not.toMatch(/commercial_scope_unresolved|business may be listed/);

    // A lookup that carries only the decision-less base profile again, for a commercial intent.
    mockComposeIntent.mockResolvedValue({ intent: intentFor({ is_commercial: true }), model: 'test-composer' });
    lookupReturns(baseEnriched({ category: 'COMMERCIAL', isCommercial: true, commercialSubtype: 'office_retail', commercialDetectionSource: 'property_record_property_type' }));
    const commercial = await run({});
    expect(commercial.propertyFacts).not.toHaveProperty('businessScope');
    expect(commercial.reasons.join(' | ')).not.toMatch(/commercial_scope_unresolved|business may be listed/);
  });

  test('no promotion ever: across every extraction and intent the engine never sets is_commercial itself', async () => {
    const extractions = [{}, { property: { service_address_is_primary_residence: true } }, { property: { service_address_occupancy: 'commercial' } }, { caller: { relationship_to_property: 'owner' } }];
    for (const extraction of extractions) {
      mockComposeIntent.mockResolvedValue({ intent: intentFor(), model: 'test-composer' });
      const result = await run(extraction);
      expect(result.intent.is_commercial).toBe(false);
    }
  });

  test('stored strings carry no business name, type, or "Google lists"', async () => {
    const results = [
      await run({}),
      await run({ property: { service_address_is_primary_residence: true } }),
    ];
    mockComposeIntent.mockResolvedValue({ intent: intentFor({ is_commercial: true }), model: 'test-composer' });
    results.push(await run({}));
    for (const result of results) {
      const stored = JSON.stringify({ reasons: result.reasons, causes: result.causes, businessScope: result.propertyFacts.businessScope });
      expect(stored).not.toMatch(/Google lists|Example Nail Bar|businessName|businessType|tenantCount/i);
    }
  });
});

describe('withoutBusinessListing', () => {
  const { withoutBusinessListing } = require('../services/estimator-engine/business-scope-engine');

  test('drops the listing, the suggestion and flags resting on the listing; keeps the open-scope marker', () => {
    const enriched = {
      category: 'RESIDENTIAL',
      serviceScopeDecision: 'scope_unresolved',
      serviceScopeQuestion: 'Are we treating just your space or the whole building?',
      serviceScopeSuggestion: 'suite',
      businessIdentity: { name: 'Example Nail Bar', type: 'salon_spa', tenantsAtNumber: 1 },
      fieldVerifyFlags: [
        { field: 'squareFootage', reason: 'question', priority: 'HIGH', source: 'google_places' },
        { field: 'stories', reason: 'confirm stories', priority: 'LOW' },
      ],
    };
    const held = withoutBusinessListing(enriched);
    expect(held).toEqual({
      category: 'RESIDENTIAL',
      serviceScopeDecision: 'scope_unresolved',
      serviceScopeQuestion: 'Are we treating just your space or the whole building?',
      fieldVerifyFlags: [{ field: 'stories', reason: 'confirm stories', priority: 'LOW' }],
    });
    expect(JSON.stringify(held)).not.toMatch(/Example Nail Bar|salon_spa/);
    expect(enriched.businessIdentity).toBeDefined();
  });

  test('a profile with no listing is returned as it is', () => {
    const enriched = { category: 'RESIDENTIAL' };
    expect(withoutBusinessListing(enriched)).toBe(enriched);
    expect(withoutBusinessListing(null)).toBeNull();
  });
});
