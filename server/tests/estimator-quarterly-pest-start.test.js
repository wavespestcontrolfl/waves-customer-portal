/**
 * Call-agent draft: a home pest program starts at quarterly visits (owner
 * 2026-11-17, "both"). The draft prices quarterly whatever visit count the
 * composer recorded, and names that count as the FIRST review reason.
 *
 * What these cases guard:
 *  - buildEngineInput is shared with the tech estimate tool and the moving
 *    re-price. Both must keep the visit count they pass, so the rule is an
 *    opt-in and its default is off.
 *  - commercial pest takes its visit count from the risk-type program.
 *  - the pipeline must really opt in. A dropped flag would bring the monthly
 *    start back with no failing unit test, so one case drives
 *    runDraftPipeline (dry run) and reads what reached the pricing engine.
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

const { runDraftPipeline } = require('../services/estimator-engine');
const { LANES, buildEngineInput, classifyLane } = require('../services/estimator-engine/draft-builder');
const { SQFT_SOURCES } = require('../services/estimator-engine/source-arbitration');
// The index module is mocked for the pipeline case; the real engine prices
// the mapping cases through its own file.
const { generateEstimate: priceForReal } = require('../services/pricing-engine/estimate-engine');

const ADDRESS = '123 Example St, Testville, FL 34200';
const VISIT_REASON = /^pest visit count: /;

const intentFor = (pest, over = {}) => ({
  decision: 'draft',
  skip_reason: null,
  customer_name: 'Test Caller',
  customer_phone: '+19410000000',
  address: ADDRESS,
  category: 'RESIDENTIAL',
  is_commercial: false,
  commercial_risk_type: null,
  commercial_subtype: null,
  services: { pest },
  service_interest_label: 'Pest Control',
  evidence: [{ decision: 'recurring pest', quote: 'looking for pest control at my house', speaker: 'caller' }],
  constraint_flags: [],
  uncertainties: [],
  confidence: 'high',
  ...over,
});

const solidFacts = () => ({
  home: { value: 2100, source: SQFT_SOURCES.COUNTY_ASSESSED, confidence: 'high', rejected: [] },
  lot: { value: 9000, source: SQFT_SOURCES.COUNTY_ASSESSED, confidence: 'high', rejected: [] },
  newConstruction: false,
  tenant: false,
});

const build = (intent, extra = {}) => buildEngineInput({ intent, propertyFacts: solidFacts(), context: {}, ...extra });

describe('engine input: the quarterly start is an opt-in', () => {
  test('with the opt-in, a monthly or bi-monthly home pest program prices quarterly and keeps its other options', () => {
    const intent = intentFor({ frequency: 'monthly', roachType: 'german' }, { services: { pest: { frequency: 'monthly', roachType: 'german' }, mosquito: { tier: 'seasonal9' } } });
    const input = build(intent, { quarterlyPestStart: true });
    expect(input.services.pest).toEqual({ frequency: 'quarterly', roachType: 'german' });
    expect(input.services.mosquito).toEqual({ tier: 'seasonal9' });
    // The count that was discussed stays on the intent for the review reason.
    expect(intent.services.pest.frequency).toBe('monthly');

    expect(build(intentFor({ frequency: 'bimonthly' }), { quarterlyPestStart: true }).services.pest.frequency).toBe('quarterly');
  });

  test('without the opt-in the visit count passes through (tech estimate tool, moving re-price)', () => {
    expect(build(intentFor({ frequency: 'monthly' })).services.pest.frequency).toBe('monthly');
    expect(build(intentFor({ frequency: 'bimonthly' })).services.pest.frequency).toBe('bimonthly');
  });

  test('commercial pest is not touched: its visit count is the risk-type program, not this field', () => {
    const intent = intentFor({ frequency: 'monthly' }, { is_commercial: true, category: 'COMMERCIAL', commercial_risk_type: 'restaurant_food' });
    expect(build(intent, { quarterlyPestStart: true }).services.pest.frequency).toBe('monthly');
  });

  test('the priced line is the quarterly program: 4 visits a year at the quarterly price', () => {
    const pestLine = (input) => priceForReal(input).lineItems.find((l) => l.service === 'pest_control');
    const started = pestLine(build(intentFor({ frequency: 'monthly' }), { quarterlyPestStart: true }));
    const quarterly = pestLine(build(intentFor({ frequency: 'quarterly' })));
    const monthly = pestLine(build(intentFor({ frequency: 'monthly' })));
    expect(started.visitsPerYear).toBe(4);
    expect(started.annual).toBe(quarterly.annual);
    expect(monthly.visitsPerYear).toBe(12);
    expect(monthly.annual).toBeGreaterThan(started.annual);
  });
});

describe('lane: the visit count that was discussed is the first review reason', () => {
  const pricedResult = () => ({
    summary: {},
    lineItems: [{ service: 'pest_control', monthly: 39, annual: 468, pricingConfidence: 'high' }],
  });
  const argsFor = (intent, { quarterlyPestStart = true, facts = solidFacts() } = {}) => ({
    intent,
    propertyFacts: facts,
    engineResult: pricedResult(),
    engineInput: buildEngineInput({ intent, propertyFacts: facts, context: {}, quarterlyPestStart }),
    totals: { monthly: 39, annual: 468, oneTime: 0 },
    comps: { samples: 10, median: 41, outlier: false, insufficient: false },
    calibration: [],
    context: {
      isExistingCustomer: false,
      extractionSource: 'enriched',
      transcript: 'Caller: hi, I am looking for pest control at my house.',
      smsThread: [],
    },
  });

  test('a monthly ask parks an otherwise clean draft yellow and says what to do', () => {
    const { lane, reasons } = classifyLane(argsFor(intentFor({ frequency: 'monthly' })));
    expect(lane).toBe(LANES.YELLOW);
    expect(reasons).toEqual([
      'pest visit count: monthly (12 a year) was discussed, and this draft prices quarterly (4 a year) — change the visit count before send if the customer wants monthly',
    ]);
  });

  test('a bi-monthly ask is named in the estimate tool\'s own word', () => {
    const { reasons } = classifyLane(argsFor(intentFor({ frequency: 'bimonthly' })));
    expect(reasons).toEqual([
      'pest visit count: bi-monthly (6 a year) was discussed, and this draft prices quarterly (4 a year) — change the visit count before send if the customer wants bi-monthly',
    ]);
  });

  test('it stays first when the draft has other review reasons', () => {
    const facts = { ...solidFacts(), home: { value: 2000, source: SQFT_SOURCES.SUBDIVISION_MEDIAN, confidence: 'low', rejected: [] } };
    const { reasons } = classifyLane(argsFor(intentFor({ frequency: 'monthly' }), { facts }));
    expect(reasons.length).toBeGreaterThan(1);
    expect(reasons[0]).toMatch(VISIT_REASON);
    expect(reasons.filter((r) => VISIT_REASON.test(r))).toHaveLength(1);
  });

  test('a quarterly ask adds nothing: a clean draft stays green', () => {
    const { lane, reasons } = classifyLane(argsFor(intentFor({ frequency: 'quarterly' })));
    expect(lane).toBe(LANES.GREEN);
    expect(reasons).toEqual([]);
  });

  test('no reason when the draft did not re-price: an input built without the opt-in', () => {
    const { reasons } = classifyLane(argsFor(intentFor({ frequency: 'monthly' }), { quarterlyPestStart: false }));
    expect(reasons.some((r) => VISIT_REASON.test(r))).toBe(false);
  });

  test('no reason on a commercial draft, which keeps its program', () => {
    const intent = intentFor({ frequency: 'monthly' }, { is_commercial: true, category: 'COMMERCIAL', commercial_risk_type: 'restaurant_food' });
    const { reasons } = classifyLane(argsFor(intent));
    expect(reasons.some((r) => VISIT_REASON.test(r))).toBe(false);
  });
});

describe('the call-agent pipeline opts in', () => {
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
      call: { id: 'call-1', twilio_call_sid: 'CA-quarterly-1' },
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

  beforeEach(() => {
    jest.clearAllMocks();
    mockLookup.mockResolvedValue({
      propertyRecord: { formattedAddress: ADDRESS, squareFootage: 2100, lotSize: 9000, stories: 1, unitCount: 1, _source: 'ai' },
      enriched: { category: 'RESIDENTIAL', isCommercial: false, fieldVerifyFlags: [] },
      meta: { cache: 'miss' },
    });
    mockGenerateEstimate.mockImplementation(() => ({
      summary: {},
      lineItems: [{ service: 'pest_control', monthly: 39, annual: 468, pricingConfidence: 'high' }],
    }));
  });

  test('a monthly ask reaches the pricing engine as quarterly, and the reason leads the draft', async () => {
    const intent = intentFor({ frequency: 'monthly' });
    mockComposeIntent.mockResolvedValue({ intent, model: 'test-composer' });
    const result = await run();
    expect(mockGenerateEstimate).toHaveBeenCalledTimes(1);
    expect(mockGenerateEstimate.mock.calls[0][0].services.pest.frequency).toBe('quarterly');
    expect(result.engineInput.services.pest.frequency).toBe('quarterly');
    expect(result.lane).toBe(LANES.YELLOW);
    expect(result.reasons[0]).toMatch(/^pest visit count: monthly \(12 a year\) was discussed/);
    expect(intent.services.pest.frequency).toBe('monthly');
  });

  test('a quarterly ask is priced as asked with no visit-count reason', async () => {
    mockComposeIntent.mockResolvedValue({ intent: intentFor({ frequency: 'quarterly' }), model: 'test-composer' });
    const result = await run();
    expect(mockGenerateEstimate.mock.calls[0][0].services.pest.frequency).toBe('quarterly');
    expect(result.reasons.some((r) => VISIT_REASON.test(r))).toBe(false);
  });
});
