// An off-schema Claude-fallback triage (e.g. urgency "critical") used to be
// mapped onto the lead anyway while only the ledger row said it failed; it is
// now the same null the callers already handle for any AI failure.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatch: jest.fn(async () => ({ ok: false, reason: 'openai_timeout' })) }));

const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } })));

// Keep the real ledgerCall (GATE_LLM_CALL_LEDGER is unset in tests, so it's
// already a real no-DB no-op) but spy on ledgerCallRejected.
jest.mock('../services/llm-dispatch-metrics', () => {
  const actual = jest.requireActual('../services/llm-dispatch-metrics');
  return { ...actual, ledgerCallRejected: jest.fn() };
});

const { aiTriageLead } = require('../services/lead-triage');
const { ledgerCallRejected } = require('../services/llm-dispatch-metrics');

const LEAD = { name: 'Pat Doe', phone: '+19415550100', message: 'Ants in the kitchen', address: 'Sarasota', pageUrl: '/', formName: 'contact' };
const VALID = { serviceInterest: 'General Pest Control', urgency: 'high', extractedData: { pestType: 'ants', location: 'Sarasota', propertyType: 'residential' }, suggestedReply: 'Thanks — we can help with the ants.' };
const reply = (obj) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(obj) }] });

describe('aiTriageLead — Claude fallback schema', () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => { process.env.ANTHROPIC_API_KEY = 'test-key'; mockCreate.mockReset(); ledgerCallRejected.mockClear(); });
  afterAll(() => { if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey; });

  test('an on-schema answer is mapped and not flagged', async () => {
    mockCreate.mockResolvedValue(reply(VALID));
    expect(await aiTriageLead(LEAD)).toMatchObject({ urgency: 'high', serviceInterest: 'General Pest Control' });
    expect(ledgerCallRejected).not.toHaveBeenCalled();
  });

  test.each([
    ['an off-enum urgency', { ...VALID, urgency: 'critical' }],
    ['a missing extractedData', { ...VALID, extractedData: undefined }],
    ['an object serviceInterest', { ...VALID, serviceInterest: { name: 'x' } }],
  ])('%s returns null (nothing written to the lead) and fails the row', async (_label, answer) => {
    mockCreate.mockResolvedValue(reply(answer));
    expect(await aiTriageLead(LEAD)).toBeNull();
    expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'schema_invalid');
  });
});
