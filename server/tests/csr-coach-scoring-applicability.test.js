// The CSR coach's 15-point rubric is a SALES rubric (greeting → close →
// upsell). Applying it to every transcribed call scored billing questions,
// tech ETA/coordination calls, existing-customer service calls and vendor
// calls as botched sales pitches (2026-09-23 audit: 61 rows, avg 2.7/15,
// fifteen zeros — the model's own coaching text on those rows says "this is
// not a sales call"). csrScoringApplies is the pure, exported gate that
// decides whether the rubric applies at all; these pin its decision for
// every v2 call_nature the pipeline is known to produce, plus direction and
// v2-validity edge cases. All data here is synthetic.
//
// v2Promoted (codex r1 P2a, 2026-09-24): the flag contract at
// call-recording-processor.js ~64-71 says demoting
// CALL_EXTRACTION_V2_DRIVES_ROUTING to shadow restores the FULL legacy V1
// drive — v2 has no operational authority over anything until routing is
// promoted. So v2's call_nature may only SUPPRESS scoring once v2Promoted is
// true; in shadow mode (v2Promoted false/omitted) a genuine lead misread as
// e.g. billing_question must still score, exactly like legacy behavior.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { csrScoringApplies, SALES_RUBRIC_CALL_NATURE } = require('../services/csr/csr-coach');

describe('csrScoringApplies — the sales-rubric applicability gate (promoted mode: v2Promoted true)', () => {
  test('SALES_RUBRIC_CALL_NATURE is new_lead', () => {
    expect(SALES_RUBRIC_CALL_NATURE).toBe('new_lead');
  });

  test('an inbound new_lead call with a valid v2 extraction qualifies', () => {
    expect(csrScoringApplies({ direction: 'inbound', callNature: 'new_lead', v2Valid: true, v2Promoted: true })).toBe(true);
  });

  // The v2 call_nature enum (server/schemas/call-extraction.model-output.schema.json)
  // has no separate "returning prospect asking for pricing" value — every
  // non-qualifying nature the pipeline can produce must NOT be scored, but
  // ONLY once v2 is actually driving routing (v2Promoted: true).
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
  ])('an inbound %s call with a valid v2 extraction does NOT qualify when v2 is promoted', (callNature) => {
    expect(csrScoringApplies({ direction: 'inbound', callNature, v2Valid: true, v2Promoted: true })).toBe(false);
  });

  test('a valid v2 extraction with a null/indeterminate call_nature does NOT qualify when v2 is promoted', () => {
    expect(csrScoringApplies({ direction: 'inbound', callNature: null, v2Valid: true, v2Promoted: true })).toBe(false);
  });

  test('an outbound call never qualifies, even when v2 says new_lead and is promoted', () => {
    expect(csrScoringApplies({ direction: 'outbound', callNature: 'new_lead', v2Valid: true, v2Promoted: true })).toBe(false);
  });

  test('outbound-dial legs are outbound too', () => {
    expect(csrScoringApplies({ direction: 'outbound-dial', callNature: 'new_lead', v2Valid: true, v2Promoted: true })).toBe(false);
  });

  test('missing/invalid v2 extraction falls back to legacy behavior (score) on an inbound call, promoted or not', () => {
    expect(csrScoringApplies({ direction: 'inbound', callNature: null, v2Valid: false, v2Promoted: true })).toBe(true);
    expect(csrScoringApplies({ direction: 'inbound', callNature: undefined, v2Valid: false, v2Promoted: true })).toBe(true);
  });

  test('missing/invalid v2 extraction on an outbound call still does not qualify', () => {
    expect(csrScoringApplies({ direction: 'outbound', callNature: null, v2Valid: false, v2Promoted: true })).toBe(false);
  });

  test('a missing direction defaults to inbound semantics', () => {
    expect(csrScoringApplies({ callNature: 'new_lead', v2Valid: true, v2Promoted: true })).toBe(true);
    expect(csrScoringApplies({ callNature: 'billing_question', v2Valid: true, v2Promoted: true })).toBe(false);
  });
});

describe('csrScoringApplies — shadow mode (v2Promoted false/omitted): legacy scoring is preserved (codex r1 P2a)', () => {
  test('a billing_question misclassification still scores when v2Promoted is omitted', () => {
    expect(csrScoringApplies({ direction: 'inbound', callNature: 'billing_question', v2Valid: true })).toBe(true);
  });

  test('a billing_question misclassification still scores when v2Promoted is explicitly false', () => {
    expect(csrScoringApplies({ direction: 'inbound', callNature: 'billing_question', v2Valid: true, v2Promoted: false })).toBe(true);
  });

  test.each([
    'existing_customer_service',
    'vendor_or_partner',
    'wrong_number',
    'other',
  ])('an inbound %s call with a valid v2 extraction STILL qualifies in shadow mode', (callNature) => {
    expect(csrScoringApplies({ direction: 'inbound', callNature, v2Valid: true, v2Promoted: false })).toBe(true);
  });

  test('a new_lead call still qualifies in shadow mode too', () => {
    expect(csrScoringApplies({ direction: 'inbound', callNature: 'new_lead', v2Valid: true, v2Promoted: false })).toBe(true);
  });

  test('outbound is still refused in shadow mode — v2Promoted never overrides direction', () => {
    expect(csrScoringApplies({ direction: 'outbound', callNature: 'new_lead', v2Valid: true, v2Promoted: false })).toBe(false);
  });

  test('no options at all falls back to legacy scoring behavior', () => {
    expect(csrScoringApplies()).toBe(true);
  });
});
