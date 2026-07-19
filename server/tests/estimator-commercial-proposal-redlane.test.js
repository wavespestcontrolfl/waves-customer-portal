/**
 * Red-branch wiring for the commercial proposal lane: when the pipeline
 * classifies the relationship-quote red AND the gate is on, the proposal
 * builder runs INSTEAD of the bell-only dead end — and every miss (gate off,
 * builder declined, builder threw) falls through to the standard red bell so
 * the owed-quote task can never be lost to this lane. Drives runDraftPipeline
 * directly with the collaborators mocked.
 */

let mockState;
jest.mock('../models/db', () => {
  const db = (table) => ({
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
jest.mock('../routes/property-lookup-v2', () => ({
  performPropertyLookup: async () => ({}),
}));

const mockComposeIntent = jest.fn();
jest.mock('../services/estimator-engine/intent-composer', () => ({
  composeIntent: (...args) => mockComposeIntent(...args),
}));

jest.mock('../services/pricing-engine', () => ({
  generateEstimate: () => { throw new Error('pricing engine down'); },
}));

const mockExistingDraftForCall = jest.fn();
const mockBuildCallContext = jest.fn();
jest.mock('../services/estimator-engine/context-builder', () => ({
  buildCallContext: (...args) => mockBuildCallContext(...args),
  existingDraftForCall: (...args) => mockExistingDraftForCall(...args),
}));

jest.mock('../services/estimator-engine/source-arbitration', () => ({
  resolvePropertyFacts: () => ({ home: { value: 25000 }, lot: { value: null } }),
  normalizeParcelView: () => null,
  SQFT_SOURCES: {},
  FALLBACK_SQFT_SOURCES: [],
}));

const mockClassifyLane = jest.fn();
const mockCreateDraft = jest.fn();
jest.mock('../services/estimator-engine/draft-builder', () => ({
  LANES: { GREEN: 'green', YELLOW: 'yellow', RED: 'red' },
  buildEngineInput: () => ({}),
  deriveTotals: () => ({ monthly: 0, annual: 0, oneTime: 0 }),
  compsBand: async () => null,
  calibrationWarnings: async () => [],
  classifyLane: (...args) => mockClassifyLane(...args),
  createDraftEstimate: (...args) => mockCreateDraft(...args),
}));

const mockProposalsEnabled = jest.fn();
const mockBuildProposal = jest.fn();
jest.mock('../services/estimator-engine/commercial-proposal', () => ({
  commercialProposalsEnabled: () => mockProposalsEnabled(),
  maybeBuildCommercialProposalDraft: (...args) => mockBuildProposal(...args),
}));

const mockNotifyAdmin = jest.fn();
jest.mock('../services/notification-service', () => ({
  notifyAdmin: (...args) => { mockNotifyAdmin(...args); return Promise.resolve({ id: 'bell-1' }); },
}));

const { runDraftPipeline } = require('../services/estimator-engine');

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

const INTENT = {
  decision: 'draft',
  customer_name: 'Test Manager',
  address: '500 Example Commons Blvd, Testville, FL 34200',
  is_commercial: true,
  category: 'COMMERCIAL',
  services: {},
  evidence: [],
  constraint_flags: [],
  confidence: 'high',
};

const CONTEXT = {
  call: { id: 'call-1', twilio_call_sid: 'CA-int-1' },
  phone: '+19410000002',
  lead: { id: 'lead-1', address: '500 Example Commons Blvd, Testville, FL 34200' },
  leadIsForThisCall: true,
  customer: null,
  customerPhoneAmbiguous: false,
  extraction: {},
  transcript: 'synthetic',
};

const run = () => runDraftPipeline({
  context: { ...CONTEXT },
  origin: ORIGIN,
  result: { lane: null, created: false },
  quotePromised: true,
});

beforeEach(() => {
  mockState = {};
  mockComposeIntent.mockReset().mockResolvedValue({ intent: { ...INTENT }, model: 'test-composer' });
  mockClassifyLane.mockReset().mockReturnValue({
    lane: 'red',
    reasons: ['commercial building over 10,000 sqft — relationship quote, not an auto-draft'],
    causes: ['commercial_relationship_quote'],
  });
  mockCreateDraft.mockReset();
  mockProposalsEnabled.mockReset().mockReturnValue(true);
  mockBuildProposal.mockReset().mockResolvedValue({ created: true, estimateId: 'est-9', briefComposed: true });
  mockNotifyAdmin.mockReset();
  mockExistingDraftForCall.mockReset().mockResolvedValue(null);
  mockBuildCallContext.mockReset();
});

test('relationship red + gate on ⇒ proposal draft + deep-linked bell, no red bell', async () => {
  const result = await run();

  expect(mockBuildProposal).toHaveBeenCalledTimes(1);
  const args = mockBuildProposal.mock.calls[0][0];
  expect(args.intent.is_commercial).toBe(true);
  expect(args.reasons.join(' ')).toContain('relationship quote');

  expect(result.created).toBe(true);
  expect(result.estimateId).toBe('est-9');
  expect(result.commercialProposal).toBe(true);
  expect(result.lane).toBe('red');

  expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
  const [category, title, body, opts] = mockNotifyAdmin.mock.calls[0];
  expect(category).toBe('lead');
  expect(title).toBe('PROPOSAL-TITLE');
  expect(body).toContain('PROPOSAL-BODY Test Manager');
  expect(opts.link).toBe('/admin/estimates/est-9/proposal');
  expect(opts.metadata.estimateId).toBe('est-9');
  expect(opts.metadata.lane).toBe('red');

  // The engine's residential draft writer never ran.
  expect(mockCreateDraft).not.toHaveBeenCalled();
});

test('builder declines (duplicate/error) ⇒ falls through to the standard red bell', async () => {
  mockBuildProposal.mockResolvedValue({ created: false, skipped: 'error' });
  const result = await run();

  expect(result.created).toBe(false);
  expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
  const [, title] = mockNotifyAdmin.mock.calls[0];
  expect(title).toBe('RED-TITLE');
});

test('builder THROWS ⇒ red bell still rings (owed quote never lost)', async () => {
  mockBuildProposal.mockRejectedValue(new Error('exploded'));
  const result = await run();

  expect(result.created).toBe(false);
  expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
  expect(mockNotifyAdmin.mock.calls[0][1]).toBe('RED-TITLE');
});

test('gate off ⇒ builder never consulted, red path unchanged', async () => {
  mockProposalsEnabled.mockReturnValue(false);
  await run();

  expect(mockBuildProposal).not.toHaveBeenCalled();
  expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
  expect(mockNotifyAdmin.mock.calls[0][1]).toBe('RED-TITLE');
});

test('red WITHOUT the relationship cause ⇒ builder never consulted, even on a commercial property', async () => {
  // A >10k-sqft commercial intent whose red came from something else (zero
  // totals, no line items) must keep the standard red + clarify path — the
  // routing keys on classifyLane's CAUSE, never the raw predicate.
  mockClassifyLane.mockReturnValue({ lane: 'red', reasons: ['engine produced zero totals'] });
  await run();

  expect(mockBuildProposal).not.toHaveBeenCalled();
  expect(mockNotifyAdmin.mock.calls[0][1]).toBe('RED-TITLE');
});

test('pricing-engine failure red (classifyLane never ran) ⇒ builder never consulted', async () => {
  // Draftable intent (services + address) whose pricing threw: the pipeline
  // takes the fallback red literal, which carries no causes.
  mockComposeIntent.mockResolvedValue({
    intent: { ...INTENT, services: { pest: { frequency: 'monthly' } } },
    model: 'test-composer',
  });
  await run();

  expect(mockClassifyLane).not.toHaveBeenCalled();
  expect(mockBuildProposal).not.toHaveBeenCalled();
  expect(mockNotifyAdmin.mock.calls[0][1]).toBe('RED-TITLE');
  expect(mockNotifyAdmin.mock.calls[0][2]).toContain('pricing engine failed');
});

test('request-only red (quotePromised=false) with a created scaffold still bells the artifact', async () => {
  const result = await runDraftPipeline({
    context: { ...CONTEXT },
    origin: ORIGIN,
    result: { lane: null, created: false },
    quotePromised: false,
  });

  expect(result.created).toBe(true);
  expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
  expect(mockNotifyAdmin.mock.calls[0][1]).toBe('PROPOSAL-TITLE');
});

test('re-entry recovery: existing proposal scaffold keeps proposal semantics + deep-link', async () => {
  // Crash between insert and notify ⇒ next run is intercepted by
  // existingDraftForCall. The scaffold row is deliberately unpriced — the
  // generic recovery bell would read "$0/mo" and link the estimates list.
  const { maybeDraftEstimateForCall } = require('../services/estimator-engine');
  mockBuildCallContext.mockResolvedValue({ ...CONTEXT });
  mockExistingDraftForCall.mockResolvedValue({
    id: 'est-77',
    monthly_total: null,
    estimate_data: JSON.stringify({ estimatorEngine: { lane: 'red', commercialProposal: true } }),
  });

  const result = await maybeDraftEstimateForCall({ callLogId: 'call-1' });
  expect(result.lane).toBe('existing');
  expect(result.estimateId).toBe('est-77');
  expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
  const [, title, body, opts] = mockNotifyAdmin.mock.calls[0];
  expect(title).toBe('Commercial prospect on call — proposal scaffold ready');
  expect(body).toContain('proposal builder');
  expect(opts.link).toBe('/admin/estimates/est-77/proposal');
});

test('re-entry recovery: generic existing draft keeps the classic bell (regression)', async () => {
  const { maybeDraftEstimateForCall } = require('../services/estimator-engine');
  mockBuildCallContext.mockResolvedValue({ ...CONTEXT });
  mockExistingDraftForCall.mockResolvedValue({
    id: 'est-78',
    monthly_total: 120,
    estimate_data: JSON.stringify({ estimatorEngine: { lane: 'green' } }),
  });

  await maybeDraftEstimateForCall({ callLogId: 'call-1' });
  const [, title, , opts] = mockNotifyAdmin.mock.calls[0];
  expect(title).toBe('AI estimate draft ready — $120/mo');
  expect(opts.link).toBe('/admin/estimates');
});

test('request-only red WITHOUT a scaffold stays silent (no false owed-quote task)', async () => {
  mockProposalsEnabled.mockReturnValue(false);
  const result = await runDraftPipeline({
    context: { ...CONTEXT },
    origin: ORIGIN,
    result: { lane: null, created: false },
    quotePromised: false,
  });

  expect(result.created).toBe(false);
  expect(mockNotifyAdmin).not.toHaveBeenCalled();
});
