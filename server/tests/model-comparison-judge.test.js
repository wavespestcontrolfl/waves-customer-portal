// Judge response parsing (pure). Heavy deps mocked so requiring the judge module
// doesn't pull the notification/push graph. No DB/network/LLM.
jest.mock('../models/db', () => { const fn = jest.fn(); fn.raw = jest.fn(); return fn; });
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn() }));
jest.mock('../services/model-comparison-graduation', () => ({ computeReadiness: jest.fn(async () => new Map()) }));

const { _test, VERDICTS } = require('../services/model-comparison-judge');
const { parseJudgeResponse } = _test;

describe('parseJudgeResponse', () => {
  test('parses a clean JSON verdict', () => {
    expect(parseJudgeResponse('{"verdict":"candidate_better","score":78,"notes":"sharper"}'))
      .toEqual({ verdict: 'candidate_better', score: 78, notes: 'sharper' });
  });

  test('tolerates code fences and preamble', () => {
    const out = parseJudgeResponse('Sure:\n```json\n{"verdict":"equivalent","score":50}\n```');
    expect(out).toMatchObject({ verdict: 'equivalent', score: 50 });
  });

  test('clamps score to 0–100', () => {
    expect(parseJudgeResponse('{"verdict":"candidate_better","score":250}').score).toBe(100);
    expect(parseJudgeResponse('{"verdict":"live_better","score":-5}').score).toBe(0);
  });

  test('rejects an unknown verdict', () => {
    expect(parseJudgeResponse('{"verdict":"meh","score":50}')).toBeNull();
  });

  test('rejects a non-numeric / missing score', () => {
    expect(parseJudgeResponse('{"verdict":"equivalent"}')).toBeNull();
    expect(parseJudgeResponse('not json')).toBeNull();
    expect(parseJudgeResponse('')).toBeNull();
  });

  test('verdict enum covers candidate_unsafe (the safety verdict)', () => {
    expect(VERDICTS).toContain('candidate_unsafe');
  });
});
