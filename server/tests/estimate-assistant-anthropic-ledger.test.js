// Codex r9 on #4884: the Claude fallback leg of the estimate assistant must fail
// its ledger row when cleanAssistantAnswer strips the reply to nothing — the
// caller then serves the deterministic template, same as the OpenAI leg.
jest.mock('../services/llm/call', () => ({ dispatch: jest.fn() }));

const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } })));

jest.mock('../services/llm-dispatch-metrics', () => {
  const actual = jest.requireActual('../services/llm-dispatch-metrics');
  return { ...actual, ledgerCallRejected: jest.fn() };
});

const { dispatch } = require('../services/llm/call');
const { ledgerCallRejected } = require('../services/llm-dispatch-metrics');
const { answerEstimateQuestion } = require('../services/estimate-assistant');

const ARGS = {
  database: null,
  question: 'How long does the first visit usually take?',
  estimate: { id: 'synthetic-estimate', token: 'synthetic-token', status: 'sent' },
  estData: { services: [{ service: 'pest', label: 'Pest Control' }] },
  pricingBundle: { waveGuardTier: 'WaveGuard' },
};

describe('estimate assistant — Claude fallback leg on the call ledger', () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    dispatch.mockReset();
    dispatch.mockResolvedValue({ ok: false, text: '' });
    mockCreate.mockReset();
    ledgerCallRejected.mockClear();
  });
  afterAll(() => {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  });

  test('a reply the sanitizer strips to nothing is rejected and the template answers', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: '- \n* ' }] });
    const result = await answerEstimateQuestion(ARGS);
    expect(result.source).toBe('fallback');
    expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'invalid_output');
  });

  test('a usable reply is served and not rejected', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'Most first visits take about an hour.' }] });
    const result = await answerEstimateQuestion(ARGS);
    expect(result.source).toBe('anthropic');
    expect(ledgerCallRejected).not.toHaveBeenCalled();
  });
});
