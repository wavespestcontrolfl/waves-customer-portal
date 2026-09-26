// Codex r10 on #4884: the scoring dispatch's `validate` only checked "object,
// not array" — a reply missing e.g. total_score, or carrying a string where
// a number belongs, passed that check and then hit Knex's undefined-binding
// guard on the csr_call_scores insert (~L305-329), deep inside a try/catch
// the caller (scoreCallIfApplicable) reads back as "scored: false" — with
// the ledger row already marked a success. isUsableCsrScore checks every
// field that insert actually writes straight from the model's answer.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { isUsableCsrScore, normalizeCsrScore } = require('../services/csr/csr-coach');

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
    // A numeric string stands for its number (the sum fields keep the
    // total = core + rescue equation by restating GOOD's own values).
    expect(isUsableCsrScore({ ...GOOD, [field]: String(GOOD[field]) })).toBe(true);
  });

  test.each(['total_score', 'core_score', 'rescue_score', 'lead_quality_score'])('rejects a fractional %s (INTEGER column)', (field) => {
    expect(isUsableCsrScore({ ...GOOD, [field]: 2.5 })).toBe(false);
    expect(isUsableCsrScore({ ...GOOD, [field]: '2.5' })).toBe(false);
    expect(isUsableCsrScore({ ...GOOD, [field]: String(GOOD[field]) })).toBe(true);
  });

  test('decimal skill dimensions still accept fractions inside 1-5', () => {
    expect(isUsableCsrScore({ ...GOOD, warmth_score: 3.25 })).toBe(true);
  });

  // Codex r13 on #4884: values outside the rubric's documented ranges used to
  // be accepted and persisted into CSR averages.
  const triple = (core, rescue, total = core + rescue) => ({ ...GOOD, core_score: core, rescue_score: rescue, total_score: total });
  test('enforces the documented ranges of core (0-10), rescue (0-5) and total (0-15)', () => {
    expect(isUsableCsrScore(triple(0, 0))).toBe(true);
    expect(isUsableCsrScore(triple(10, 5))).toBe(true);
    expect(isUsableCsrScore(triple(11, 0))).toBe(false);
    expect(isUsableCsrScore(triple(-1, 1))).toBe(false);
    expect(isUsableCsrScore(triple(5, 6))).toBe(false);
    expect(isUsableCsrScore(triple(9, -4))).toBe(false);
    expect(isUsableCsrScore(triple(10, 5, 16))).toBe(false);
  });

  // Codex r14 on #4884: the rubric's total IS core + rescue.
  test('rejects a total that is not core + rescue (e.g. 15 = 0 + 0)', () => {
    expect(isUsableCsrScore(triple(0, 0, 15))).toBe(false);
    expect(isUsableCsrScore(triple(8, 4, 11))).toBe(false);
    expect(isUsableCsrScore(triple(8, 4, 12))).toBe(true);
  });

  test.each([
    ['control_score', 0, 5.5, [1, 5]],
    ['warmth_score', 0.5, 100, [1, 5]],
    ['clarity_score', 0, 6, [1, 5]],
    ['objection_handling_score', 0, 6, [1, 5]],
    ['closing_strength_score', 0, 6, [1, 5]],
    ['lead_quality_score', 0, 11, [1, 10]],
  ])('enforces the documented range of %s', (field, below, above, [min, max]) => {
    expect(isUsableCsrScore({ ...GOOD, [field]: below })).toBe(false);
    expect(isUsableCsrScore({ ...GOOD, [field]: above })).toBe(false);
    expect(isUsableCsrScore({ ...GOOD, [field]: min })).toBe(true);
    expect(isUsableCsrScore({ ...GOOD, [field]: max })).toBe(true);
  });

  test('rejects a missing, empty, non-string, or off-rubric call_outcome', () => {
    expect(isUsableCsrScore({ ...GOOD, call_outcome: undefined })).toBe(false);
    expect(isUsableCsrScore({ ...GOOD, call_outcome: '' })).toBe(false);
    expect(isUsableCsrScore({ ...GOOD, call_outcome: '   ' })).toBe(false);
    expect(isUsableCsrScore({ ...GOOD, call_outcome: 3 })).toBe(false);
    expect(isUsableCsrScore({ ...GOOD, call_outcome: 'booked_maybe' })).toBe(false);
  });

  test('canonicalizes call_outcome — "Booked" must count as booked, not a loss', () => {
    expect(normalizeCsrScore({ ...GOOD, call_outcome: ' Booked ' }).call_outcome).toBe('booked');
    expect(normalizeCsrScore({ ...GOOD, call_outcome: 'Not Booked' }).call_outcome).toBe('not_booked');
    expect(normalizeCsrScore({ ...GOOD, call_outcome: 'estimate-sent' }).call_outcome).toBe('estimate_sent');
  });

  test('numeric strings are normalized to numbers', () => {
    const n = normalizeCsrScore({ ...GOOD, total_score: '12', warmth_score: '4.5' });
    expect(n.total_score).toBe(12);
    expect(n.warmth_score).toBe(4.5);
  });

  test('optional fields: off-contract values become null/[] instead of failing the insert; the score stays usable', () => {
    const n = normalizeCsrScore({
      ...GOOD,
      call_summary: { text: 'x' },
      coaching_notes: '   ',
      better_phrasings: 'say it better',
      lead_intent: 'Price Shopping',
      lead_source_quality: 'excellent',
      loss_reason: 'The customer said they would think about it and call back later, which happens a lot on first calls like this one',
      estimated_job_value: '$500',
    });
    expect(n).not.toBeNull();
    expect(n.call_summary).toBeNull();
    expect(n.coaching_notes).toBeNull();
    expect(n.better_phrasings).toEqual([]);
    expect(n.lead_intent).toBe('price_shopping');
    expect(n.lead_source_quality).toBeNull();
    expect(n.loss_reason).toBeNull();
    expect(n.estimated_job_value).toBeNull();
    expect(normalizeCsrScore({ ...GOOD, estimated_job_value: '450.00' }).estimated_job_value).toBe(450);
    expect(normalizeCsrScore({ ...GOOD, estimated_job_value: -5 }).estimated_job_value).toBeNull();
  });

  test('follow_up_task: needs a recommended_action; type and deadline fall back to safe defaults', () => {
    expect(normalizeCsrScore({ ...GOOD, follow_up_task: 'call them' }).follow_up_task).toBeNull();
    expect(normalizeCsrScore({ ...GOOD, follow_up_task: { type: 'call_back', recommended_action: '  ' } }).follow_up_task).toBeNull();
    const t = normalizeCsrScore({ ...GOOD, follow_up_task: { type: 'Send SMS', recommended_action: 'Text the quote', deadline_hours: '4/24/48' } }).follow_up_task;
    expect(t).toMatchObject({ type: 'send_sms', recommended_action: 'Text the quote', deadline_hours: 24 });
    const u = normalizeCsrScore({ ...GOOD, follow_up_task: { type: 'carrier pigeon', recommended_action: 'Call back', deadline_hours: 48 } }).follow_up_task;
    expect(u).toMatchObject({ type: 'call_back', deadline_hours: 48 });
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
