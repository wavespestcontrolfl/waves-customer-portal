// Codex r13 on #4884: the sentiment pass took whichever label a substring
// search found first — "not negative; neutral" read as negative — and recorded
// that as a successful mentions_sentiment call. The reply must now be ONE
// unambiguous allowlisted label (its first word, and no other label anywhere);
// anything else is neutral and fails the ledger row.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/seo/dataforseo', () => ({}));

const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } })));

// Keep the real ledgerCall (GATE_LLM_CALL_LEDGER is unset in tests, so it's
// already a real no-DB no-op) but spy on ledgerCallRejected.
jest.mock('../services/llm-dispatch-metrics', () => {
  const actual = jest.requireActual('../services/llm-dispatch-metrics');
  return { ...actual, ledgerCallRejected: jest.fn() };
});

const prober = require('../services/seo/llm-mention-prober');
const { ledgerCallRejected } = require('../services/llm-dispatch-metrics');

const { parseSentimentLabel } = prober;

describe('parseSentimentLabel', () => {
  test.each([
    ['positive', 'positive'],
    ['Negative.', 'negative'],
    ['**Neutral**', 'neutral'],
    ['  "positive"  ', 'positive'],
    ['Positive — the answer recommends Waves', 'positive'],
  ])('%j reads as %s', (text, label) => {
    expect(parseSentimentLabel(text)).toBe(label);
  });

  test.each([
    ['the r13 case', 'not negative; neutral'],
    ['two labels', 'Neutral to positive'],
    ['a label that is not the first word', 'Mostly positive'],
    ['no label', 'mixed'],
    ['empty', ''],
    ['null', null],
  ])('%s (%j) is ambiguous or off-contract → null', (_label, text) => {
    expect(parseSentimentLabel(text)).toBeNull();
  });
});

describe('classifySentiment ledger row', () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    mockCreate.mockReset();
    ledgerCallRejected.mockClear();
  });
  afterAll(() => {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  });

  test('an ambiguous reply is neutral and fails the row', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'not negative; neutral' }] });
    expect(await prober.classifySentiment('Waves Pest Control was mentioned')).toBe('neutral');
    expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'invalid_output');
  });

  test('a clean one-word reply is used and not flagged', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'Negative' }] });
    expect(await prober.classifySentiment('Waves Pest Control was mentioned')).toBe('negative');
    expect(ledgerCallRejected).not.toHaveBeenCalled();
  });
});
