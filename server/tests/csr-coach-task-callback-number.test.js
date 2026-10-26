// Live miss 2026-10-26: 81 follow-up tasks since April told staff to "Call
// <name> at 941-318-7612" — our own Bradenton office line, the number the
// caller dialed. The scoring prompt never carried the caller's number. Fix:
// the prompt states it, and replaceOwnedNumbers rewrites any Waves-owned
// number left in recommended_action before the task insert. All numbers here
// are synthetic except the owned lines, which come from config/twilio-numbers.js.
const mockInserts = {};
jest.mock('../models/db', () => {
  const fn = jest.fn((table) => ({
    insert: (row) => ({ returning: async () => { mockInserts[table] = row; return [{ id: `${table}-1`, ...row }]; } }),
    where: () => ({ update: async () => 1 }),
  }));
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));

const { dispatchWithFallback } = require('../services/llm/call');
const CSRCoach = require('../services/csr/csr-coach');
const { replaceOwnedNumbers, buildCsrScoringText } = CSRCoach;

const CALLER = '+19415550142';
const CORE = ['greeting', 'empathy', 'problem_capture', 'address', 'time_options', 'fee_confirmation', 'name_confirmation', 'callback_number', 'set_expectations', 'strong_close'];
const RESCUE = ['objection_save', 'upsell_attempt', 'urgency_creation', 'referral_mention', 'follow_up_offer'];
const scoreAnswer = (recommended_action) => ({
  point_details: Object.fromEntries([...CORE, ...RESCUE].map((k) => [k, 1])),
  control_score: 4, warmth_score: 4, clarity_score: 4, objection_handling_score: 3, closing_strength_score: 4,
  call_outcome: 'not_booked',
  call_summary: 'Caller asked about ants.',
  coaching_notes: 'Ask for the sale sooner.',
  lead_quality_score: 8,
  follow_up_task: { type: 'call_back', recommended_action, deadline_hours: 4, priority: 'high' },
});

describe('replaceOwnedNumbers — callback guard', () => {
  test('replaces the Bradenton office line with the caller\'s number in every common format', () => {
    for (const fmt of ['941-318-7612', '(941) 318-7612', '941.318.7612', '9413187612', '+1 941 318 7612', '+19413187612', '1-941-318-7612']) {
      expect(replaceOwnedNumbers(`Call Pat at ${fmt} today.`, CALLER)).toBe('Call Pat at 941-555-0142 today.');
    }
  });

  test('replaces other Waves-owned lines too (location, tracking, main)', () => {
    expect(replaceOwnedNumbers('Try (941) 297-2817 or 941-241-3824 or 941-297-5749.', CALLER))
      .toBe('Try 941-555-0142 or 941-555-0142 or 941-555-0142.');
  });

  test('uses "the caller\'s number" when the caller\'s number is unknown', () => {
    for (const unknown of [null, undefined, '', 'abc', '555-0142']) {
      expect(replaceOwnedNumbers('Call Pat at 941-318-7612 now.', unknown)).toBe("Call Pat at the caller's number now.");
    }
  });

  test('uses "the caller\'s number" when the ANI is itself a Waves line', () => {
    expect(replaceOwnedNumbers('Call at (941) 318-7612.', '+19413187612')).toBe("Call at the caller's number.");
  });

  test('leaves text with no phone number unchanged', () => {
    const text = 'Follow up by text about the ant treatment on Tuesday.';
    expect(replaceOwnedNumbers(text, CALLER)).toBe(text);
  });

  test('leaves a non-Waves number unchanged', () => {
    const text = 'Call Pat at 941-555-0199 before noon.';
    expect(replaceOwnedNumbers(text, CALLER)).toBe(text);
  });

  test('replaces only the owned number when both appear', () => {
    expect(replaceOwnedNumbers('Pat is at 941-555-0199; do not use 941-318-7612.', CALLER))
      .toBe('Pat is at 941-555-0199; do not use 941-555-0142.');
  });

  test('does not touch longer digit runs', () => {
    const text = 'Reference 19413187612345 on the ticket.';
    expect(replaceOwnedNumbers(text, CALLER)).toBe(text);
  });

  test('passes non-string input through', () => {
    expect(replaceOwnedNumbers(null, CALLER)).toBeNull();
    expect(replaceOwnedNumbers(undefined, CALLER)).toBeUndefined();
  });
});

describe('buildCsrScoringText — caller\'s number in the prompt', () => {
  const base = { callDirection: 'inbound', csrName: 'Test CSR', callSource: 'main', metadata: {}, transcript: 'hello' };

  test('carries the caller ID line and the callback rule when contactPhone is given', () => {
    const text = buildCsrScoringText({ ...base, contactPhone: CALLER });
    expect(text).toContain('Caller ID: 941-555-0142');
    expect(text).toContain('number the caller gave in the call if it differs from the caller ID');
    expect(text).toContain('Never use a Waves number');
  });

  test('omits the caller line when contactPhone is unknown or one of our lines', () => {
    for (const contactPhone of [null, undefined, '', '+19413187612']) {
      const text = buildCsrScoringText({ ...base, contactPhone });
      expect(text).not.toContain('Caller ID:');
      expect(text).toContain('Never put a Waves phone number in the follow-up task');
    }
  });
});

// A caller can disclaim the ANI ("that's the office line / not my number") or
// give a different callback number. Pre-push review P1: the ANI must not be
// forced on the model or inserted by the guard in those cases.
const ALT = '+19415550988';
const disclaimedNoNumber = { caller: { caller_id_disclaimed: true, phone_source: 'unknown', phone_e164: null } };
const disclaimedWithAlt = { caller: { caller_id_disclaimed: true, phone_source: 'spoken', phone_e164: ALT } };
const disclaimedAltEqualsAni = { caller: { caller_id_disclaimed: true, phone_source: 'both', phone_e164: CALLER } };
const spokenAltNotDisclaimed = { caller: { caller_id_disclaimed: false, phone_source: 'spoken', phone_e164: ALT } };
const ownedAsCallback = { caller: { caller_id_disclaimed: true, phone_source: 'spoken', phone_e164: '+19413187612' } };

describe('disclaimed ANI and alternate confirmed callback number', () => {
  test('disclaimed ANI: the guard does not insert the ANI, it uses the words', () => {
    expect(replaceOwnedNumbers('Call Pat at 941-318-7612.', CALLER, disclaimedNoNumber))
      .toBe("Call Pat at the caller's number.");
    // The disclaimed number repeated back as the "callback" is still the ANI.
    expect(replaceOwnedNumbers('Call Pat at 941-318-7612.', CALLER, disclaimedAltEqualsAni))
      .toBe("Call Pat at the caller's number.");
  });

  test('disclaimed ANI with a confirmed alternate: the alternate is inserted', () => {
    expect(replaceOwnedNumbers('Call Pat at (941) 318-7612.', CALLER, disclaimedWithAlt))
      .toBe('Call Pat at 941-555-0988.');
  });

  test('a confirmed alternate wins over the ANI when the ANI was not disclaimed', () => {
    expect(replaceOwnedNumbers('Call Pat at 941-318-7612.', CALLER, spokenAltNotDisclaimed))
      .toBe('Call Pat at 941-555-0988.');
  });

  test('an owned number given as the "callback" is never used', () => {
    expect(replaceOwnedNumbers('Call Pat at 941-318-7612.', CALLER, ownedAsCallback))
      .toBe("Call Pat at the caller's number.");
  });

  test('a caller-ID-only extraction (not disclaimed) still falls back to the ANI', () => {
    const ext = { caller: { caller_id_disclaimed: false, phone_source: 'caller_id', phone_e164: CALLER } };
    expect(replaceOwnedNumbers('Call Pat at 941-318-7612.', CALLER, ext)).toBe('Call Pat at 941-555-0142.');
  });

  test('prompt omits the caller ID line when the ANI is disclaimed', () => {
    const text = buildCsrScoringText({ callDirection: 'inbound', csrName: 'Test CSR', transcript: 'hi', contactPhone: CALLER, v2Extraction: disclaimedNoNumber });
    expect(text).not.toContain('Caller ID:');
    expect(text).not.toContain('941-555-0142');
    expect(text).toContain('not theirs');
    expect(text).toContain("the caller's number");
  });

  test('prompt gives the confirmed number, not the disclaimed ANI', () => {
    const text = buildCsrScoringText({ callDirection: 'inbound', csrName: 'Test CSR', transcript: 'hi', contactPhone: CALLER, v2Extraction: disclaimedWithAlt });
    expect(text).not.toContain('Caller ID:');
    expect(text).not.toContain('941-555-0142');
    expect(text).toContain('Confirmed callback number: 941-555-0988');
  });

  test('prompt lists both the caller ID and a different spoken number when not disclaimed', () => {
    const text = buildCsrScoringText({ callDirection: 'inbound', csrName: 'Test CSR', transcript: 'hi', contactPhone: CALLER, v2Extraction: spokenAltNotDisclaimed });
    expect(text).toContain('Caller ID: 941-555-0142');
    expect(text).toContain('Confirmed callback number: 941-555-0988');
  });

  test('scoreCall end to end: disclaimed ANI never reaches the prompt or the stored task', async () => {
    for (const k of Object.keys(mockInserts)) delete mockInserts[k];
    dispatchWithFallback.mockReset();
    dispatchWithFallback.mockResolvedValue({ ok: true, json: scoreAnswer('Call Pat at 941-318-7612 today.') });
    await CSRCoach.scoreCall({
      csrName: 'Test CSR', customerId: null, callDirection: 'inbound', callSource: 'main',
      transcript: 'that is the office line', metadata: {}, contactPhone: CALLER, v2Extraction: disclaimedNoNumber,
    });
    const [, request] = dispatchWithFallback.mock.calls[0];
    expect(request.text).not.toContain('941-555-0142');
    expect(mockInserts.ai_follow_up_tasks.recommended_action).toBe("Call Pat at the caller's number today.");
  });
});

describe('scoreCall — end to end' , () => {
  beforeEach(() => {
    for (const k of Object.keys(mockInserts)) delete mockInserts[k];
    dispatchWithFallback.mockReset();
  });

  test('sends the caller line to the model and stores the task with the office line replaced', async () => {
    dispatchWithFallback.mockResolvedValue({
      ok: true,
      json: scoreAnswer('Call Pat at 941-318-7612 immediately, before she books another company.'),
    });
    await CSRCoach.scoreCall({
      csrName: 'Test CSR', customerId: null, callDirection: 'inbound', callSource: 'main',
      transcript: 'caller asks about ants', metadata: {}, contactPhone: CALLER,
    });
    const [, request] = dispatchWithFallback.mock.calls[0];
    expect(request.text).toContain('Caller ID: 941-555-0142');
    expect(mockInserts.ai_follow_up_tasks.recommended_action)
      .toBe('Call Pat at 941-555-0142 immediately, before she books another company.');
  });

  test('stores "the caller\'s number" when the ANI is not available', async () => {
    dispatchWithFallback.mockResolvedValue({
      ok: true,
      json: scoreAnswer('Call the number back (941-318-7612) and confirm the WDO inspection.'),
    });
    await CSRCoach.scoreCall({
      csrName: 'Test CSR', customerId: null, callDirection: 'inbound', callSource: 'main',
      transcript: 'caller asks about WDO', metadata: {},
    });
    expect(mockInserts.ai_follow_up_tasks.recommended_action)
      .toBe("Call the number back (the caller's number) and confirm the WDO inspection.");
  });
});
