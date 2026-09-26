// Codex r10 on #4884: the scoring dispatch's `validate` only checked "object,
// not array" — a reply missing e.g. total_score, or carrying a string where
// a number belongs, passed that check and then hit Knex's undefined-binding
// guard on the csr_call_scores insert (~L305-329), deep inside a try/catch
// the caller (scoreCallIfApplicable) reads back as "scored: false" — with
// the ledger row already marked a success. isUsableCsrScore checks every
// field that insert actually writes straight from the model's answer.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { isUsableCsrScore } = require('../services/csr/csr-coach');

const GOOD = {
  total_score: 12, core_score: 8, rescue_score: 4,
  control_score: 4, warmth_score: 4, clarity_score: 4, objection_handling_score: 3, closing_strength_score: 4,
  call_outcome: 'booked',
  point_details: { greeting: 1, empathy: 1 },
  lead_quality_score: 8,
};

describe('isUsableCsrScore', () => {
  test('accepts a fully-shaped score', () => {
    expect(isUsableCsrScore(GOOD)).toBe(true);
  });

  test('rejects the wrong top-level shapes', () => {
    for (const bad of [null, undefined, [], 'text', 42]) {
      expect(isUsableCsrScore(bad)).toBe(false);
    }
  });

  test.each([
    'total_score', 'core_score', 'rescue_score',
    'control_score', 'warmth_score', 'clarity_score', 'objection_handling_score', 'closing_strength_score',
    'lead_quality_score',
  ])('rejects a missing or non-finite %s (the exact field the insert writes)', (field) => {
    expect(isUsableCsrScore({ ...GOOD, [field]: undefined })).toBe(false);
    expect(isUsableCsrScore({ ...GOOD, [field]: 'great job' })).toBe(false);
    expect(isUsableCsrScore({ ...GOOD, [field]: NaN })).toBe(false);
    expect(isUsableCsrScore({ ...GOOD, [field]: '' })).toBe(false);
    expect(isUsableCsrScore({ ...GOOD, [field]: '8' })).toBe(true);
  });

  test.each(['total_score', 'core_score', 'rescue_score', 'lead_quality_score'])('rejects a fractional %s (INTEGER column)', (field) => {
    expect(isUsableCsrScore({ ...GOOD, [field]: 12.5 })).toBe(false);
    expect(isUsableCsrScore({ ...GOOD, [field]: '8.5' })).toBe(false);
    expect(isUsableCsrScore({ ...GOOD, [field]: '8' })).toBe(true);
  });

  test('decimal skill dimensions still accept fractions', () => {
    expect(isUsableCsrScore({ ...GOOD, warmth_score: 7.25 })).toBe(true);
  });

  test('rejects a missing, empty, or non-string call_outcome', () => {
    expect(isUsableCsrScore({ ...GOOD, call_outcome: undefined })).toBe(false);
    expect(isUsableCsrScore({ ...GOOD, call_outcome: '' })).toBe(false);
    expect(isUsableCsrScore({ ...GOOD, call_outcome: '   ' })).toBe(false);
    expect(isUsableCsrScore({ ...GOOD, call_outcome: 3 })).toBe(false);
  });

  test('rejects a missing, null, or array point_details — JSON.stringify(undefined) is undefined, not a string', () => {
    expect(isUsableCsrScore({ ...GOOD, point_details: undefined })).toBe(false);
    expect(isUsableCsrScore({ ...GOOD, point_details: null })).toBe(false);
    expect(isUsableCsrScore({ ...GOOD, point_details: [] })).toBe(false);
    expect(isUsableCsrScore({ ...GOOD, point_details: 'greeting:1' })).toBe(false);
  });

  test('the exact regression: an object missing total_score passes the old "not_an_object" check but fails this one', () => {
    const { total_score, ...missingTotal } = GOOD;
    expect(isUsableCsrScore(missingTotal)).toBe(false);
  });
});
