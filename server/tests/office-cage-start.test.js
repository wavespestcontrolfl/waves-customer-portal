/**
 * Office starting size for a county-measured pool cage
 * (GATE_CAGE_START_MEDIUM, owner 2026-11-17 "both").
 *
 * What these cases guard:
 *  - gate off, the call-agent draft's profile is the SAME object and the
 *    estimate tool gets no hint (every output as before);
 *  - gate on, a county cage of 601-2,000 sq ft starts at Medium in the two
 *    office tools, a cage over 2,000 sq ft keeps its size, and the call-agent
 *    draft drops a cage on a home with no decided pool;
 *  - the lookup's own profile is never changed (the website quote's manual
 *    hold, the website-lead draft and the customer price assistant read it);
 *  - buildEngineInput itself is untouched, so the tech estimate tool and the
 *    moving re-price price the lookup's size with the gate on;
 *  - the pipeline really applies the rule: one case drives runDraftPipeline
 *    (dry run) and reads what reached the pricing engine.
 *
 * All fixtures synthetic.
 */

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

jest.mock('../services/estimator-engine/draft-builder', () => ({
  ...jest.requireActual('../services/estimator-engine/draft-builder'),
  compsBand: async () => null,
  calibrationWarnings: async () => [],
  createDraftEstimate: jest.fn(),
}));

jest.mock('../services/estimator-engine/commercial-proposal', () => ({
  commercialProposalsEnabled: () => false,
  maybeBuildCommercialProposalDraft: jest.fn(),
}));

jest.mock('../services/notification-service', () => ({
  notifyAdmin: () => Promise.resolve({ id: 'bell-1' }),
}));

const {
  officeCageStartSize,
  agentDraftCageProfile,
  stampEstimateToolCageStart,
} = require('../services/property-lookup/office-cage-start');
const { runDraftPipeline } = require('../services/estimator-engine');
const { buildEngineInput } = require('../services/estimator-engine/draft-builder');
const { SQFT_SOURCES } = require('../services/estimator-engine/source-arbitration');
// The index module is mocked for the pipeline case; the real engine prices
// the mapping cases through its own file.
const { generateEstimate: priceForReal } = require('../services/pricing-engine/estimate-engine');

const GATE = 'GATE_CAGE_START_MEDIUM';
let priorGate;
beforeAll(() => { priorGate = process.env[GATE]; });
afterAll(() => {
  // process.env persists across files on one worker — restore, never leak.
  if (priorGate === undefined) delete process.env[GATE];
  else process.env[GATE] = priorGate;
});
const gate = (value) => {
  if (value === undefined) delete process.env[GATE];
  else process.env[GATE] = value;
};
beforeEach(() => gate(undefined));

const ADDRESS = '123 Example St, Testville, FL 34200';
// The lookup's own sizes for these areas (classifyPoolCageSize).
const cagedHome = (sqft, size, over = {}) => ({ pool: 'YES', poolCage: 'YES', poolCageSize: size, poolCageSqft: sqft, ...over });

describe('officeCageStartSize', () => {
  test('gate off or unset: no start size, whatever the area', () => {
    for (const value of [undefined, 'false', '1', 'on']) {
      gate(value);
      expect(officeCageStartSize(cagedHome(812, 'LARGE'))).toBeNull();
    }
  });

  test('gate on: Medium from over 600 sq ft through 2,000 sq ft, and only there', () => {
    gate('true');
    expect(officeCageStartSize(cagedHome(600, 'MEDIUM'))).toBeNull();
    expect(officeCageStartSize(cagedHome(601, 'LARGE'))).toBe('MEDIUM');
    expect(officeCageStartSize(cagedHome(1300, 'OVERSIZED'))).toBe('MEDIUM');
    expect(officeCageStartSize(cagedHome(2000, 'OVERSIZED'))).toBe('MEDIUM');
    expect(officeCageStartSize(cagedHome(2001, 'OVERSIZED'))).toBeNull();
    expect(officeCageStartSize(cagedHome(250, 'SMALL'))).toBeNull();
  });

  test('gate on: a cage sized from the satellite image has no county area and keeps its size', () => {
    gate('true');
    expect(officeCageStartSize(cagedHome(null, 'LARGE'))).toBeNull();
    expect(officeCageStartSize(null)).toBeNull();
  });

  test('a whole-module feature-gates mock without the reader reads as off', () => {
    gate('true');
    jest.isolateModules(() => {
      jest.doMock('../config/feature-gates', () => ({ isEnabled: () => false }));
      const isolated = require('../services/property-lookup/office-cage-start');
      expect(isolated.officeCageStartSize(cagedHome(812, 'LARGE'))).toBeNull();
      const profile = cagedHome(812, 'LARGE');
      expect(isolated.agentDraftCageProfile(profile)).toBe(profile);
    });
    jest.dontMock('../config/feature-gates');
  });
});

describe('agentDraftCageProfile (the call-agent draft)', () => {
  test('gate off: the same object comes back, for every shape', () => {
    for (const profile of [cagedHome(812, 'LARGE'), cagedHome(704, 'LARGE', { pool: 'NO' }), null]) {
      expect(agentDraftCageProfile(profile)).toBe(profile);
    }
  });

  test('gate on: a 601-2,000 sq ft cage starts at Medium and the lookup\'s profile is not changed', () => {
    gate('true');
    const profile = cagedHome(812, 'LARGE', { shrubDensity: 'HEAVY' });
    const draft = agentDraftCageProfile(profile);
    expect(draft).toEqual({ ...profile, poolCageSize: 'MEDIUM' });
    expect(profile.poolCageSize).toBe('LARGE');
  });

  test('gate on: sizes the rule does not cover pass through as the same object', () => {
    gate('true');
    for (const profile of [
      cagedHome(2400, 'OVERSIZED'),
      cagedHome(450, 'MEDIUM'),
      cagedHome(null, 'LARGE'),
      { pool: 'YES', poolCage: 'NO', poolCageSize: 'NONE' },
    ]) {
      expect(agentDraftCageProfile(profile)).toBe(profile);
    }
  });

  test('gate on: a cage with no decided pool is dropped, as the estimate tool does', () => {
    gate('true');
    for (const pool of ['NO', 'POSSIBLE', 'UNKNOWN', undefined]) {
      const profile = cagedHome(704, 'LARGE', { pool });
      expect(agentDraftCageProfile(profile)).toEqual({ ...profile, poolCage: 'NO', poolCageSize: 'NONE' });
      expect(profile.poolCage).toBe('YES');
    }
  });
});

describe('stampEstimateToolCageStart (the estimate tool\'s first fill)', () => {
  test('gate on: the hint sits beside the profile and the profile keeps the lookup\'s size', () => {
    gate('true');
    const result = { enriched: cagedHome(1300, 'OVERSIZED'), meta: { cache: 'miss' } };
    expect(stampEstimateToolCageStart(result)).toBe(result);
    expect(result.meta).toEqual({ cache: 'miss', poolCageStartSize: 'MEDIUM' });
    expect(result.enriched.poolCageSize).toBe('OVERSIZED');
  });

  test('gate off, or a cage outside the rule: no hint', () => {
    const off = { enriched: cagedHome(1300, 'OVERSIZED'), meta: {} };
    expect(stampEstimateToolCageStart(off).meta).toEqual({});
    gate('true');
    const large = { enriched: cagedHome(2400, 'OVERSIZED'), meta: {} };
    expect(stampEstimateToolCageStart(large).meta).toEqual({});
    expect(stampEstimateToolCageStart({ enriched: null, meta: {} }).meta).toEqual({});
  });
});

describe('pricing', () => {
  const facts = () => ({
    home: { value: 2100, source: SQFT_SOURCES.COUNTY_ASSESSED, confidence: 'high', rejected: [] },
    lot: { value: 9000, source: SQFT_SOURCES.COUNTY_ASSESSED, confidence: 'high', rejected: [] },
    newConstruction: false,
    tenant: false,
  });
  const intent = () => ({
    decision: 'draft', is_commercial: false, category: 'RESIDENTIAL', address: ADDRESS,
    services: { pest: { frequency: 'quarterly' } },
  });
  const pestLine = (lookupEnriched) => priceForReal(buildEngineInput({ intent: intent(), propertyFacts: facts(), context: {}, lookupEnriched }))
    .lineItems.find((l) => l.service === 'pest_control');
  const CAGE_REASONS = ['large_pool_cage', 'oversized_pool_cage', 'pest_large_or_oversized_pool_cage'];
  const cageReasons = (line) => (line.manualReviewReasons || []).filter((r) => CAGE_REASONS.includes(r));

  test('gate on: the draft prices the cage at Medium, with no large-cage review reason', () => {
    const before = pestLine(agentDraftCageProfile(cagedHome(812, 'LARGE')));
    expect(before.poolCageSize).toBe('large');
    expect(cageReasons(before)).toEqual(['large_pool_cage', 'pest_large_or_oversized_pool_cage']);

    gate('true');
    const after = pestLine(agentDraftCageProfile(cagedHome(812, 'LARGE')));
    const handSetMedium = pestLine(cagedHome(812, 'MEDIUM'));
    expect(after.poolCageSize).toBe('medium');
    expect(cageReasons(after)).toEqual([]);
    expect(after.perApp).toBe(handSetMedium.perApp);
    expect(after.perApp).toBeLessThan(before.perApp);
  });

  test('gate on: a cage on a home with no decided pool is not priced', () => {
    const noPool = cagedHome(704, 'LARGE', { pool: 'NO' });
    const before = pestLine(agentDraftCageProfile(noPool));
    expect(before.poolCageSize).toBe('large');

    gate('true');
    const after = pestLine(agentDraftCageProfile(noPool));
    const noCage = pestLine({ pool: 'NO', poolCage: 'NO', poolCageSize: 'NONE' });
    expect(after.poolCageSize).toBe('none');
    expect(after.perApp).toBe(noCage.perApp);
  });

  test('gate on: buildEngineInput itself is untouched (tech estimate tool, moving re-price)', () => {
    gate('true');
    const input = buildEngineInput({ intent: intent(), propertyFacts: facts(), context: {}, lookupEnriched: cagedHome(812, 'LARGE') });
    expect(input.features).toMatchObject({ pool: true, poolCage: true, poolCageSize: 'large' });
    const noPool = buildEngineInput({ intent: intent(), propertyFacts: facts(), context: {}, lookupEnriched: cagedHome(704, 'LARGE', { pool: 'NO' }) });
    expect(noPool.features).toMatchObject({ pool: false, poolCage: true, poolCageSize: 'large' });
  });
});

describe('the call-agent pipeline applies the rule', () => {
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
  const run = () => runDraftPipeline({
    context: {
      call: { id: 'call-1', twilio_call_sid: 'CA-cage-1' },
      phone: '+19410000000',
      lead: { id: 'lead-1', address: ADDRESS },
      leadIsForThisCall: true,
      customer: null,
      customerPhoneAmbiguous: false,
      extraction: {},
      transcript: 'Caller: hi, I am looking for pest control at my house.',
    },
    origin: ORIGIN,
    result: { lane: null, created: false },
    dryRun: true,
    quotePromised: true,
  });
  const lookupReturns = (cage) => mockLookup.mockResolvedValue({
    propertyRecord: { formattedAddress: ADDRESS, squareFootage: 2100, lotSize: 9000, stories: 1, unitCount: 1, _source: 'ai' },
    enriched: { category: 'RESIDENTIAL', isCommercial: false, fieldVerifyFlags: [], ...cage },
    meta: { cache: 'miss' },
  });
  const pricedFeatures = async () => {
    await run();
    expect(mockGenerateEstimate).toHaveBeenCalledTimes(1);
    return mockGenerateEstimate.mock.calls[0][0].features;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockComposeIntent.mockResolvedValue({
      intent: {
        decision: 'draft', skip_reason: null, customer_name: 'Test Caller', customer_phone: '+19410000000',
        address: ADDRESS, category: 'RESIDENTIAL', is_commercial: false, commercial_risk_type: null, commercial_subtype: null,
        services: { pest: { frequency: 'quarterly' } }, service_interest_label: 'Pest Control',
        evidence: [{ decision: 'recurring pest', quote: 'looking for pest control at my house', speaker: 'caller' }],
        constraint_flags: [], uncertainties: [], confidence: 'high',
      },
      model: 'test-composer',
    });
    mockGenerateEstimate.mockImplementation(() => ({
      summary: {},
      lineItems: [{ service: 'pest_control', monthly: 39, annual: 468, pricingConfidence: 'high' }],
    }));
  });

  test('gate off: the lookup\'s Large cage, and a cage with no pool, reach the pricing engine as before', async () => {
    lookupReturns(cagedHome(812, 'LARGE'));
    expect(await pricedFeatures()).toMatchObject({ pool: true, poolCage: true, poolCageSize: 'large' });

    jest.clearAllMocks();
    lookupReturns(cagedHome(704, 'LARGE', { pool: 'NO' }));
    expect(await pricedFeatures()).toMatchObject({ pool: false, poolCage: true, poolCageSize: 'large' });
  });

  test('gate on: the cage reaches the pricing engine at Medium', async () => {
    gate('true');
    lookupReturns(cagedHome(812, 'LARGE'));
    expect(await pricedFeatures()).toMatchObject({ pool: true, poolCage: true, poolCageSize: 'medium' });
  });

  test('gate on: a cage with no decided pool does not reach the pricing engine', async () => {
    gate('true');
    lookupReturns(cagedHome(704, 'LARGE', { pool: 'NO' }));
    const features = await pricedFeatures();
    expect(features).toMatchObject({ pool: false, poolCage: false });
    expect(features.poolCageSize).toBeUndefined();
  });
});
