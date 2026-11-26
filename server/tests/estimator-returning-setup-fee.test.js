/**
 * Call and text drafts: the returning-customer setup fee rule (owner 2026-11-24 and 2026-11-25,
 * GATE_RETURNING_SETUP_FEE_GAP). A staff save decides the rule on the plan the server priced; an engine draft
 * goes out with one click and no save, so it has to decide the same way when it is drafted.
 *
 * What these cases guard:
 *  - the draft decides from the visits of the customer it links, and only that customer (an ambiguous phone
 *    match is not a link, so it reads nobody's visits);
 *  - a waiver reaches the draft twice, as one answer: the mark on the engine result the draft stores (the page
 *    maps that result) and the waiver handed to the insert (the accept reads the stored operator waiver);
 *  - a failed history read costs the waiver, never the draft, and a decision that fails half way leaves the
 *    result as priced (never a result marked "no fee" with no waiver to bill by);
 *  - a dry run (the replay harness) prices what the live draft stores;
 *  - a lane that makes no draft reads nobody's visits.
 * The window, the visit history and the stored row are tested in returning-setup-fee-waiver.test.js and
 * returning-setup-fee-history-postgres.test.js.
 *
 * Drives runDraftPipeline with the collaborators mocked; the pricing engine, the mapper and the rule's decision
 * are the real ones. All fixtures synthetic.
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

// The real engine, through its own file (the index module loads the DB config).
jest.mock('../services/pricing-engine', () => ({
  generateEstimate: (...args) => jest.requireActual('../services/pricing-engine/estimate-engine').generateEstimate(...args),
}));

jest.mock('../services/estimator-engine/context-builder', () => ({
  buildCallContext: jest.fn(),
  existingDraftForCall: jest.fn(async () => null),
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

jest.mock('../services/notification-service', () => ({
  notifyAdmin: () => Promise.resolve({ id: 'bell-1' }),
}));

// The real mapper behind a handle, so one case can fail the map of a marked result.
const mockMapper = jest.fn();
jest.mock('../services/pricing-engine/v1-legacy-mapper', () => ({
  ...jest.requireActual('../services/pricing-engine/v1-legacy-mapper'),
  mapV1ToLegacyShape: (...args) => mockMapper(...args),
}));
const realMapper = jest.requireActual('../services/pricing-engine/v1-legacy-mapper').mapV1ToLegacyShape;

// The history read is the rule module's own (real Postgres suite); the decision made on it is the real one.
const mockHistory = jest.fn();
jest.mock('../services/returning-setup-fee-waiver', () => ({
  ...jest.requireActual('../services/returning-setup-fee-waiver'),
  loadReturningVisitHistory: (...args) => mockHistory(...args),
}));

const logger = require('../services/logger');
const { runDraftPipeline } = require('../services/estimator-engine');
const { LANES, deriveTotals, _private: { buildDraftNotes } } = require('../services/estimator-engine/draft-builder');

const ADDRESS = '123 Example St, Testville, FL 34200';
const CUSTOMER_ID = '00000000-0000-4000-8000-0000000000c1';
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

const intentFor = (services = { pest: { frequency: 'quarterly' } }) => ({
  decision: 'draft',
  skip_reason: null,
  customer_name: 'Test Caller',
  customer_phone: '+19410000000',
  address: ADDRESS,
  category: 'RESIDENTIAL',
  is_commercial: false,
  commercial_risk_type: null,
  commercial_subtype: null,
  services,
  service_interest_label: 'Pest Control',
  evidence: [{ decision: 'recurring pest', quote: 'looking for pest control at my house', speaker: 'caller' }],
  constraint_flags: [],
  uncertainties: [],
  confidence: 'high',
});

// A caller the draft links: a cancelled customer (no active plan, so the member waiver is not theirs).
const run = (contextOver = {}, { dryRun = false } = {}) => runDraftPipeline({
  context: {
    call: { id: 'call-1', twilio_call_sid: 'CA-returning-1' },
    phone: '+19410000000',
    lead: { id: 'lead-1', address: ADDRESS },
    leadIsForThisCall: true,
    customer: { id: CUSTOMER_ID, first_name: 'Test' },
    customerPhoneAmbiguous: false,
    isExistingCustomer: false,
    extraction: {},
    transcript: 'Caller: hi, I am looking for pest control at my house.',
    ...contextOver,
  },
  origin: ORIGIN,
  result: { lane: null, created: false },
  dryRun,
  quotePromised: true,
});

// The loader's answer for a customer whose last pest plan visit ran on a quarterly series.
const historyWithLastVisit = (lastVisitKey) => ({
  todayKey: '2026-11-26',
  lastByFamily: { pest_control: { lastVisitKey, cycleDays: 91 } },
});
const pestLine = (engineResult) => engineResult.lineItems.find((line) => line.service === 'pest_control');
const draftArgs = () => mockCreateDraft.mock.calls[0][0];

beforeEach(() => {
  jest.clearAllMocks();
  mockLookup.mockResolvedValue({
    propertyRecord: { formattedAddress: ADDRESS, squareFootage: 2100, lotSize: 9000, stories: 1, unitCount: 1, _source: 'ai' },
    enriched: { category: 'RESIDENTIAL', isCommercial: false, fieldVerifyFlags: [] },
    meta: { cache: 'miss' },
  });
  mockComposeIntent.mockResolvedValue({ intent: intentFor(), model: 'test-composer' });
  mockCreateDraft.mockResolvedValue({ created: true, estimate: { id: 'est-1', token: 'tok-1' } });
  mockMapper.mockImplementation(realMapper);
  // As the real loader: no customer (or the gate off, or an active member) = no history.
  mockHistory.mockImplementation(async (_db, { customerId } = {}) => (customerId ? historyWithLastVisit('2026-10-01') : null));
});

describe('a call draft decides the returning-customer setup fee rule when it is drafted', () => {
  test('inside the window: the draft stores a result with no setup fee and carries the waiver to the insert', async () => {
    const result = await run();
    expect(result.created).toBe(true);
    expect(result.lane).not.toBe(LANES.RED);
    // The visits read are the linked customer's.
    expect(mockHistory).toHaveBeenCalledTimes(1);
    expect(mockHistory.mock.calls[0][1]).toEqual({ customerId: CUSTOMER_ID });
    const { engineResult, returningSetupFeeWaiver, totals } = draftArgs();
    // The totals the draft stores were derived before the mark: they carry no setup fee, so they still agree
    // with the result stored beside them.
    expect(totals).toEqual(deriveTotals(engineResult));
    // Oct 1 to Nov 26 is 56 days; a quarterly series allows 91 + 30.
    expect(returningSetupFeeWaiver).toEqual({
      rule: 'returning_customer_gap', family: 'pest_control', lastCompletedVisitDate: '2026-10-01',
      decidedOn: '2026-11-26', gapDays: 56, windowDays: 121,
    });
    // The stored result is the marked one: the page maps it and shows no fee.
    expect(engineResult.membershipSetupFeeWaived).toBe(true);
    expect(pestLine(engineResult).initialFee).toBe(0);
    const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
    expect(mapV1ToLegacyShape(engineResult).oneTime.membershipFee).toBe(0);
  });

  test('past the window: the fee stays on the stored result and no waiver reaches the insert', async () => {
    mockHistory.mockResolvedValue(historyWithLastVisit('2026-06-01'));
    await run();
    const { engineResult, returningSetupFeeWaiver } = draftArgs();
    expect(returningSetupFeeWaiver).toBeNull();
    expect(engineResult.membershipSetupFeeWaived).toBeUndefined();
    expect(pestLine(engineResult).initialFee).toBeGreaterThan(0);
  });

  test('an ambiguous phone match is not a link: nobody\'s visits are read and the fee stays', async () => {
    await run({ customerPhoneAmbiguous: true });
    expect(mockHistory.mock.calls[0][1]).toEqual({ customerId: undefined });
    const { engineResult, returningSetupFeeWaiver } = draftArgs();
    expect(returningSetupFeeWaiver).toBeNull();
    expect(pestLine(engineResult).initialFee).toBeGreaterThan(0);
  });

  test('a plan with no setup fee has nothing to waive (a pest and lawn bundle)', async () => {
    mockComposeIntent.mockResolvedValue({
      intent: intentFor({ pest: { frequency: 'quarterly' }, lawn: { track: 'st_augustine', tier: 'enhanced' } }),
      model: 'test-composer',
    });
    await run();
    const { engineResult, returningSetupFeeWaiver } = draftArgs();
    expect(returningSetupFeeWaiver).toBeNull();
    expect(engineResult.membershipSetupFeeWaived).toBeUndefined();
  });

  test('a failed history read costs the waiver, never the draft', async () => {
    mockHistory.mockRejectedValue(new Error('connection lost'));
    const result = await run();
    expect(result.created).toBe(true);
    const { engineResult, returningSetupFeeWaiver } = draftArgs();
    expect(returningSetupFeeWaiver).toBeNull();
    expect(pestLine(engineResult).initialFee).toBeGreaterThan(0);
    expect(logger.warn).toHaveBeenCalledWith('[estimator-engine] returning setup fee rule skipped: connection lost');
  });

  test('a decision that fails half way leaves the result as priced: the fee on the page and on the bill', async () => {
    // The rule marks the result, then maps it again: fail that second map.
    mockMapper.mockImplementation((v1) => {
      if (v1.membershipSetupFeeWaived) throw new Error('map failed');
      return realMapper(v1);
    });
    const result = await run();
    expect(result.created).toBe(true);
    const { engineResult, returningSetupFeeWaiver } = draftArgs();
    // No waiver to bill by, so the stored result must not say "no fee" either.
    expect(returningSetupFeeWaiver).toBeNull();
    expect(engineResult.membershipSetupFeeWaived).toBeUndefined();
    expect(pestLine(engineResult).initialFee).toBeGreaterThan(0);
    expect(logger.warn).toHaveBeenCalledWith('[estimator-engine] returning setup fee rule skipped: map failed');
  });

  test('a dry run prices what the live draft stores, and writes nothing', async () => {
    const inside = await run({}, { dryRun: true });
    expect(inside.engineResult.membershipSetupFeeWaived).toBe(true);
    expect(pestLine(inside.engineResult).initialFee).toBe(0);
    mockHistory.mockResolvedValue(historyWithLastVisit('2026-06-01'));
    const past = await run({}, { dryRun: true });
    expect(past.engineResult.membershipSetupFeeWaived).toBeUndefined();
    expect(pestLine(past.engineResult).initialFee).toBeGreaterThan(0);
    expect(mockCreateDraft).not.toHaveBeenCalled();
  });

  test('a lane that makes no draft reads nobody\'s visits', async () => {
    mockComposeIntent.mockResolvedValue({
      intent: { ...intentFor(), decision: 'skip', skip_reason: 'the caller asked about an existing visit' },
      model: 'test-composer',
    });
    const result = await run({}, { dryRun: true });
    expect(result.lane).toBe(LANES.RED);
    expect(mockHistory).not.toHaveBeenCalled();
  });
});

describe('the staff notes of a draft name a waived setup fee', () => {
  const notesFor = (returningSetupFeeWaiver) => buildDraftNotes({
    intent: intentFor(), propertyFacts: {}, totals: { monthly: 39, annual: 468, oneTime: 0 }, lane: LANES.GREEN,
    laneReasons: [], comps: null, calibration: [], model: 'test-composer', call: { id: 'call-1' }, returningSetupFeeWaiver,
  });

  test('one line with the last plan visit, the gap and the window; no line when the rule did not waive', () => {
    const waiver = { lastCompletedVisitDate: '2026-10-01', gapDays: 56, windowDays: 121 };
    expect(notesFor(waiver)).toContain('Setup fee: waived, returning customer (last plan visit 2026-10-01, 56 days ago; window 121 days).');
    expect(notesFor(null)).not.toContain('Setup fee:');
  });
});
