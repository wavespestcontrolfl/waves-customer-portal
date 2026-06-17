// Guards the Phase 2 shadow comparison helper (server/services/model-comparison-log.js):
// the pure agreement fns and the fail-closed, non-blocking shadowCompare orchestrator.
// No DB, no network — db + llm/call#dispatch are mocked (names are mock-prefixed so
// jest's mock-factory hoisting allows them).
const mockInsert = jest.fn().mockResolvedValue();
jest.mock('../models/db', () => jest.fn(() => ({ insert: mockInsert })));
const mockDispatch = jest.fn();
jest.mock('../services/llm/call', () => ({ dispatch: (...args) => mockDispatch(...args) }));

const {
  extractionAgreement,
  textAgreement,
  flattenLeaves,
  shadowCompare,
} = require('../services/model-comparison-log');
const { WORKHORSE } = require('../config/models');

beforeEach(() => {
  mockInsert.mockClear();
  mockDispatch.mockReset();
});

describe('agreement helpers (pure)', () => {
  test('extractionAgreement: identical, with server provenance ignored', () => {
    const live = { customer: { first_name: 'Sam', phone: '+19410001111' }, meta: { extraction_model: 'gemini-2.5-pro' } };
    const cand = { customer: { first_name: 'Sam', phone: '+19410001111' }, meta: { extraction_model: 'gpt-5.5' } };
    const r = extractionAgreement(live, cand);
    expect(r.level).toBe('identical');
    expect(r.score).toBe(100);
    expect(r.divergence).toBeNull();
  });

  test('extractionAgreement: routing-critical meta content (is_spam) IS compared', () => {
    // is_spam is model-authored content, not provenance — disagreement must be caught.
    const live = { meta: { is_spam: false, extraction_model: 'gemini-2.5-pro' } };
    const cand = { meta: { is_spam: true, extraction_model: 'gpt-5.5' } };
    const r = extractionAgreement(live, cand);
    expect(r.divergence).toContain('meta.is_spam');
    expect(r.level).toBe('divergent');
  });

  test('extractionAgreement: flags a divergent field', () => {
    const live = { customer: { first_name: 'Sam', city: 'Bradenton' } };
    const cand = { customer: { first_name: 'Sam', city: 'Sarasota' } };
    const r = extractionAgreement(live, cand);
    expect(r.score).toBe(50);
    expect(r.level).toBe('divergent');
    expect(r.divergence).toContain('customer.city');
  });

  test('textAgreement: identical vs disjoint', () => {
    expect(textAgreement('the lawn looks healthy', 'the lawn looks healthy').score).toBe(100);
    expect(textAgreement('alpha beta', 'gamma delta').score).toBe(0);
  });

  test('flattenLeaves: skips ignored prefixes', () => {
    const m = flattenLeaves({ a: 1, meta: { x: 2 } }, ['meta']);
    expect(m.get('a')).toBe(1);
    expect([...m.keys()]).not.toContain('meta.x');
  });
});

describe('shadowCompare (fail-closed, non-blocking)', () => {
  const base = {
    featureKey: 'estimate_assistant',
    live: { provider: 'anthropic', model: WORKHORSE, output: 'hi' },
    candidateRoute: { provider: 'openai', model: 'gpt-5.5' },
    candidatePayload: { text: 'q' },
    compare: textAgreement,
  };

  test('candidate {ok:false} → logged candidate_failed, never throws', async () => {
    mockDispatch.mockResolvedValue({ ok: false, reason: 'no_key' });
    await expect(shadowCompare(base)).resolves.toBeUndefined();
    expect(mockInsert).toHaveBeenCalledTimes(1);
    const row = mockInsert.mock.calls[0][0];
    expect(row.agreement_level).toBe('candidate_failed');
    expect(row.candidate_ok).toBe(false);
    expect(row.candidate_reason).toBe('no_key');
  });

  test('candidate ok → agreement computed + logged', async () => {
    mockDispatch.mockResolvedValue({ ok: true, text: 'hi' });
    await shadowCompare(base);
    const row = mockInsert.mock.calls[0][0];
    expect(row.candidate_ok).toBe(true);
    expect(row.agreement_level).toBe('identical');
    expect(row.agreement_score).toBe(100);
  });

  test('a thrown dispatch is swallowed (still never throws)', async () => {
    mockDispatch.mockRejectedValue(new Error('boom'));
    await expect(shadowCompare(base)).resolves.toBeUndefined();
  });
});
