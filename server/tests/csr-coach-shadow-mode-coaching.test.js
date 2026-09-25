/**
 * Codex round-5 P2 (PR #4807): scoreCallIfApplicable used to forward every
 * schema-valid V2 extraction into scoreCall regardless of v2Promoted — so
 * the deterministic callback-number coaching addendum
 * (callbackNumberCoachingNote, keyed off v2Extraction.caller) could persist
 * "ask for a cell" into csr_call_scores.coaching_notes from a SHADOW-mode
 * extraction, even though V2 has no operational authority over anything
 * else until routing is promoted (the same v2Promoted gate
 * csrScoringApplies already honors for the rubric-applicability decision
 * itself, right above this in the source).
 *
 * Fix: v2Extraction is only forwarded into scoreCall when v2Promoted is
 * true. This is pure wiring — the underlying predicate
 * (callbackNumberCoachingNote) and the SMS safety hold it is named after
 * (callbackNumberHoldActiveForVisit / call-recording-processor.js, which
 * must keep arming in shadow mode) are untouched.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const CSRCoach = require('../services/csr/csr-coach');

const V2_EXTRACTION = {
  meta: { schema_version: '1.14.0' },
  call_nature: 'new_lead',
  caller: { caller_id_disclaimed: true, phone_source: 'unknown', phone_e164: null },
};

describe('scoreCallIfApplicable — v2Extraction only reaches scoreCall (and its callback-coaching note) when v2Promoted', () => {
  let scoreCallSpy;

  beforeEach(() => {
    scoreCallSpy = jest.spyOn(CSRCoach, 'scoreCall').mockResolvedValue({ total_score: 10, call_outcome: 'booked' });
  });

  afterEach(() => {
    scoreCallSpy.mockRestore();
  });

  test('v2Promoted: true — a valid extraction is forwarded (the coaching note can fire)', async () => {
    await CSRCoach.scoreCallIfApplicable({
      direction: 'inbound',
      v2Extraction: V2_EXTRACTION,
      v2Status: 'valid',
      v2Promoted: true,
      csrName: 'Virginia',
      customerId: 'cust-1',
      callSource: 'main',
      transcript: 'call transcript',
      metadata: {},
      contactPhone: '+19415551234',
    });
    expect(scoreCallSpy).toHaveBeenCalledWith(expect.objectContaining({ v2Extraction: V2_EXTRACTION }));
  });

  test('v2Promoted: false (shadow mode) — a schema-VALID extraction is withheld from scoreCall, even though the rubric still applies via the v2Valid-false fallback', async () => {
    await CSRCoach.scoreCallIfApplicable({
      direction: 'inbound',
      v2Extraction: V2_EXTRACTION,
      v2Status: 'valid',
      v2Promoted: false,
      csrName: 'Virginia',
      customerId: 'cust-1',
      callSource: 'main',
      transcript: 'call transcript',
      metadata: {},
      contactPhone: '+19415551234',
    });
    expect(scoreCallSpy).toHaveBeenCalledWith(expect.objectContaining({ v2Extraction: null }));
  });

  test('v2Promoted omitted (defaults false, same as shadow) — withheld too', async () => {
    await CSRCoach.scoreCallIfApplicable({
      direction: 'inbound',
      v2Extraction: V2_EXTRACTION,
      v2Status: 'valid',
      csrName: 'Virginia',
      customerId: 'cust-1',
      callSource: 'main',
      transcript: 'call transcript',
      metadata: {},
      contactPhone: '+19415551234',
    });
    expect(scoreCallSpy).toHaveBeenCalledWith(expect.objectContaining({ v2Extraction: null }));
  });

  test('an invalid/missing v2 extraction is withheld either way (unrelated to v2Promoted)', async () => {
    await CSRCoach.scoreCallIfApplicable({
      direction: 'inbound',
      v2Extraction: null,
      v2Status: null,
      v2Promoted: true,
      csrName: 'Virginia',
      customerId: 'cust-1',
      callSource: 'main',
      transcript: 'call transcript',
      metadata: {},
      contactPhone: '+19415551234',
    });
    expect(scoreCallSpy).toHaveBeenCalledWith(expect.objectContaining({ v2Extraction: null }));
  });
});
