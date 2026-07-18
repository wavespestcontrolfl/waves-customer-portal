// Codex round 5 (07-18, P2): when both providers miss (or return unparseable
// JSON), analyzeSentiment must NOT fabricate a neutral/non-escalation result
// — that object was persisted into call_log.metadata and made an analysis
// outage read as a genuinely low-risk call. The pre-failover behavior (throw
// before any metadata write) is the contract.

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));

const db = require('../models/db');
const { dispatchWithFallback } = require('../services/llm/call');
const { analyzeSentiment } = require('../services/call-sentiment');

function callLogChain(record) {
  const chain = {
    where: jest.fn(() => chain),
    first: jest.fn(async () => record),
    update: jest.fn(async () => 1),
  };
  return chain;
}

describe('analyzeSentiment provider-failure contract', () => {
  beforeEach(() => jest.clearAllMocks());

  test('both providers missing → throws, and call_log metadata is never written', async () => {
    const chain = callLogChain({ id: 1, transcription: 'CUSTOMER: the ants are back again', metadata: null });
    db.mockImplementation(() => chain);
    dispatchWithFallback.mockResolvedValue({ ok: false, reason: 'no_key' });

    await expect(analyzeSentiment('CA-unit-test')).rejects.toThrow(/Sentiment analysis unavailable/);
    expect(chain.update).not.toHaveBeenCalled();
  });

  test('unparseable provider output → throws instead of persisting a neutral result', async () => {
    const chain = callLogChain({ id: 1, transcription: 'CUSTOMER: please call me back', metadata: null });
    db.mockImplementation(() => chain);
    dispatchWithFallback.mockResolvedValue({ ok: true, json: null, text: 'not json at all' });

    await expect(analyzeSentiment('CA-unit-test')).rejects.toThrow(/Sentiment analysis unavailable/);
    expect(chain.update).not.toHaveBeenCalled();
  });

  test('a real analysis still persists to call_log metadata', async () => {
    const chain = callLogChain({ id: 1, transcription: 'CUSTOMER: thanks so much', metadata: null });
    db.mockImplementation(() => chain);
    const analysis = {
      overall: 'positive',
      customerSatisfaction: 5,
      keyMoments: [],
      escalationRisk: false,
      summary: 'Satisfied customer.',
    };
    dispatchWithFallback.mockResolvedValue({ ok: true, json: analysis, text: JSON.stringify(analysis) });

    await expect(analyzeSentiment('CA-unit-test')).resolves.toEqual(analysis);
    expect(chain.update).toHaveBeenCalledTimes(1);
    const written = JSON.parse(chain.update.mock.calls[0][0].metadata);
    expect(written.sentiment).toEqual(analysis);
  });
});
