// The CSR coach's 15-point rubric is a SALES rubric (greeting → close →
// upsell). Applying it to every transcribed call scored billing questions,
// tech ETA/coordination calls, existing-customer service calls and vendor
// calls as botched sales pitches (2026-09-23 audit: 61 rows, avg 2.7/15,
// fifteen zeros — the model's own coaching text on those rows says "this is
// not a sales call"). csrScoringApplies is the pure, exported gate that
// decides whether the rubric applies at all; these pin its decision for
// every v2 call_nature the pipeline is known to produce, plus direction and
// v2-validity edge cases. All data here is synthetic.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { csrScoringApplies, SALES_RUBRIC_CALL_NATURE } = require('../services/csr/csr-coach');

describe('csrScoringApplies — the sales-rubric applicability gate', () => {
  test('SALES_RUBRIC_CALL_NATURE is new_lead', () => {
    expect(SALES_RUBRIC_CALL_NATURE).toBe('new_lead');
  });

  test('an inbound new_lead call with a valid v2 extraction qualifies', () => {
    expect(csrScoringApplies({ direction: 'inbound', callNature: 'new_lead', v2Valid: true })).toBe(true);
  });

  // The v2 call_nature enum (server/schemas/call-extraction.model-output.schema.json)
  // has no separate "returning prospect asking for pricing" value — every
  // non-qualifying nature the pipeline can produce must NOT be scored.
  test.each([
    'existing_customer_service',
    'existing_customer_scheduling',
    'billing_question',
    'vendor_or_partner',
    'job_applicant',
    'spam_solicitation',
    'robocall',
    'wrong_number',
    'voicemail_message',
    'silent_or_noise',
    'other',
  ])('an inbound %s call with a valid v2 extraction does NOT qualify', (callNature) => {
    expect(csrScoringApplies({ direction: 'inbound', callNature, v2Valid: true })).toBe(false);
  });

  test('a valid v2 extraction with a null/indeterminate call_nature does NOT qualify', () => {
    expect(csrScoringApplies({ direction: 'inbound', callNature: null, v2Valid: true })).toBe(false);
  });

  test('an outbound call never qualifies, even when v2 says new_lead', () => {
    expect(csrScoringApplies({ direction: 'outbound', callNature: 'new_lead', v2Valid: true })).toBe(false);
  });

  test('outbound-dial legs are outbound too', () => {
    expect(csrScoringApplies({ direction: 'outbound-dial', callNature: 'new_lead', v2Valid: true })).toBe(false);
  });

  test('missing/invalid v2 extraction falls back to legacy behavior (score) on an inbound call', () => {
    expect(csrScoringApplies({ direction: 'inbound', callNature: null, v2Valid: false })).toBe(true);
    expect(csrScoringApplies({ direction: 'inbound', callNature: undefined, v2Valid: false })).toBe(true);
  });

  test('missing/invalid v2 extraction on an outbound call still does not qualify', () => {
    expect(csrScoringApplies({ direction: 'outbound', callNature: null, v2Valid: false })).toBe(false);
  });

  test('a missing direction defaults to inbound semantics', () => {
    expect(csrScoringApplies({ callNature: 'new_lead', v2Valid: true })).toBe(true);
    expect(csrScoringApplies({ callNature: 'billing_question', v2Valid: true })).toBe(false);
  });

  test('no options at all falls back to legacy scoring behavior', () => {
    expect(csrScoringApplies()).toBe(true);
  });
});
