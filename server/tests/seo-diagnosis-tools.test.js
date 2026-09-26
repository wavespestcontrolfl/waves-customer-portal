/**
 * seo-diagnosis-tools.js — classify_query_intent.
 *
 * Codex r8 on #4884: a multi-query batch with only SOME valid classification
 * lines was recorded as a successful ledger call and returned fewer
 * classifications than inputs (the old guard only flagged a WHOLLY empty
 * parse). Fixed: every batched query gets a classification — a query with
 * no matching line falls back to the SAME deterministic keyword classifier
 * the no-key/exception paths already use — and the provider result is
 * recorded as a failure whenever any query was missing from the response.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } })));

// Keep the real ledgerCall (GATE_LLM_CALL_LEDGER is unset in tests, so it's
// already a real no-DB no-op) but spy on ledgerCallRejected.
jest.mock('../services/llm-dispatch-metrics', () => {
  const actual = jest.requireActual('../services/llm-dispatch-metrics');
  return { ...actual, ledgerCallRejected: jest.fn() };
});

const { _classifyQueryIntent: classifyQueryIntent } = require('../services/seo/seo-diagnosis-tools');
const { ledgerCallRejected } = require('../services/llm-dispatch-metrics');

const respondWithLines = (lines) => mockCreate.mockResolvedValue({ content: [{ type: 'text', text: lines.join('\n') }] });

const OLD_KEY = process.env.ANTHROPIC_API_KEY;
beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  jest.clearAllMocks();
});
afterAll(() => { if (OLD_KEY === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = OLD_KEY; });

test('no ANTHROPIC_API_KEY → deterministic keyword fallback for every query, no ledger call at all', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const out = await classifyQueryIntent({ queries: ['termite cost near me', 'how to identify a termite'] });
  expect(out.fallback).toBe('keyword-rules');
  expect(out.classifications).toHaveLength(2);
  expect(ledgerCallRejected).not.toHaveBeenCalled();
});

test('every query gets a matching line → full classifications, not flagged', async () => {
  respondWithLines([
    'termite cost near me\ttransactional\t0.9',
    'how to identify a termite\tinformational\t0.8',
  ]);
  const out = await classifyQueryIntent({ queries: ['termite cost near me', 'how to identify a termite'] });
  expect(out.classifications).toHaveLength(2);
  expect(out.classifications.map((c) => c.intent)).toEqual(['transactional', 'informational']);
  expect(ledgerCallRejected).not.toHaveBeenCalled();
});

test('a batch with SOME missing lines still returns one classification per input, and is recorded as a failure', async () => {
  // Only 1 of 3 queries gets a valid line back.
  respondWithLines(['termite cost near me\ttransactional\t0.9']);
  const queries = ['termite cost near me', 'how to identify a termite', 'best pest control sarasota'];
  const out = await classifyQueryIntent({ queries });

  expect(out.classifications).toHaveLength(3); // never fewer than the input, unlike before the fix
  expect(out.classifications[0]).toMatchObject({ query: 'termite cost near me', intent: 'transactional' });
  // The two missing queries fall back to the SAME deterministic classifier
  // the no-key path uses.
  expect(out.classifications[1]).toMatchObject({ query: 'how to identify a termite', intent: 'informational', confidence: 0.5 });
  expect(out.classifications[2]).toMatchObject({ query: 'best pest control sarasota', intent: 'commercial-investigation', confidence: 0.5 });
  expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'invalid_output');
});

test('a response with no usable lines at all still classifies every query (via fallback) and is flagged once', async () => {
  respondWithLines(['I could not classify these queries.']);
  const queries = ['termite cost near me', 'how to identify a termite'];
  const out = await classifyQueryIntent({ queries });

  expect(out.classifications).toHaveLength(2);
  expect(out.classifications.every((c) => c.confidence === 0.5)).toBe(true);
  expect(ledgerCallRejected).toHaveBeenCalledTimes(1);
  expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'invalid_output');
});

test('extra/unmatched lines in the response do not cause false matches or duplicate classifications', async () => {
  respondWithLines([
    'termite cost near me\ttransactional\t0.9',
    'some other unrelated query\tinformational\t0.5', // not in the batch — must be ignored
  ]);
  const out = await classifyQueryIntent({ queries: ['termite cost near me'] });
  expect(out.classifications).toHaveLength(1);
  expect(out.classifications[0].query).toBe('termite cost near me');
  expect(ledgerCallRejected).not.toHaveBeenCalled();
});

test('an empty queries array is a success with no classifications and no ledger call', async () => {
  const out = await classifyQueryIntent({ queries: [] });
  expect(out.classifications).toEqual([]);
  expect(mockCreate).not.toHaveBeenCalled();
  expect(ledgerCallRejected).not.toHaveBeenCalled();
});
