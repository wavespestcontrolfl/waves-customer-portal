// live-provider resolver: default-to-baseline on missing row, cache, fail-safe on
// DB error. DB + graduation mocked. No network.
const mockFirst = jest.fn();
jest.mock('../models/db', () => {
  const qb = { where: () => qb, first: (...a) => mockFirst(...a) };
  const fn = jest.fn(() => qb);
  fn.raw = jest.fn();
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/model-comparison-graduation', () => ({
  FEATURE_BASELINE: { estimate_assistant: 'anthropic', call_extraction: 'gemini' },
  evaluatePromotionEligibility: jest.fn(),
}));

const { getLiveProvider, _clearCache } = require('../services/live-provider');

beforeEach(() => { mockFirst.mockReset(); _clearCache(); });

describe('getLiveProvider', () => {
  test('no row → feature baseline (today\'s behavior)', async () => {
    mockFirst.mockResolvedValue(undefined);
    expect(await getLiveProvider('estimate_assistant')).toBe('anthropic');
    expect(await getLiveProvider('call_extraction')).toBe('gemini');
  });

  test('row present → the promoted provider', async () => {
    mockFirst.mockResolvedValue({ live_provider: 'openai' });
    expect(await getLiveProvider('estimate_assistant')).toBe('openai');
  });

  test('caches within TTL (one DB read for repeated calls)', async () => {
    mockFirst.mockResolvedValue({ live_provider: 'openai' });
    await getLiveProvider('estimate_assistant');
    await getLiveProvider('estimate_assistant');
    expect(mockFirst).toHaveBeenCalledTimes(1);
  });

  test('DB error → fail-safe to baseline (never an unintended provider)', async () => {
    mockFirst.mockRejectedValue(new Error('db down'));
    expect(await getLiveProvider('estimate_assistant')).toBe('anthropic');
  });

  test('unknown feature → null baseline', async () => {
    mockFirst.mockResolvedValue(undefined);
    expect(await getLiveProvider('nope')).toBeNull();
  });
});
