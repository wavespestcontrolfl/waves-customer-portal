// Live miss 2026-10-26: 81 follow-up tasks since April told staff to "Call
// <name> at 941-318-7612" — our own Bradenton office line, the number the
// caller dialed. The scoring prompt never carried the caller's number. Fix: the
// prompt shows the caller ID (unless the caller disclaimed it) and any number
// the caller gave, and tells the model never to send staff to a Waves number.
// The task text is stored exactly as the model wrote it; scoreCall only WARNS
// when a call_back task still names one of our lines. Numbers here are
// synthetic except the owned lines, which come from config/twilio-numbers.js.
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

const logger = require('../services/logger');
const { dispatchWithFallback } = require('../services/llm/call');
const CSRCoach = require('../services/csr/csr-coach');
const { buildCsrScoringText, resolveCallbackNumbers, callbackNamesOwnedNumber } = CSRCoach;

const CALLER = '+19415550142';
const ALT = '+19415550988';
const CORE = ['greeting', 'empathy', 'problem_capture', 'address', 'time_options', 'fee_confirmation', 'name_confirmation', 'callback_number', 'source_question', 'set_expectations', 'strong_close'];
const RESCUE = ['objection_save', 'upsell_attempt', 'urgency_creation', 'referral_mention', 'follow_up_offer'];
const scoreAnswer = (type, recommended_action) => ({
  point_details: Object.fromEntries([...CORE, ...RESCUE].map((k) => [k, 1])),
  control_score: 4, warmth_score: 4, clarity_score: 4, objection_handling_score: 3, closing_strength_score: 4,
  call_outcome: 'not_booked',
  call_summary: 'Caller asked about ants.',
  coaching_notes: 'Ask for the sale sooner.',
  lead_quality_score: 8,
  follow_up_task: { type, recommended_action, deadline_hours: 4, priority: 'high' },
});
const promptFor = (contactPhone, v2Extraction = null) => buildCsrScoringText({
  callDirection: 'inbound', csrName: 'Test CSR', callSource: 'main', metadata: {}, transcript: 'hi', contactPhone, v2Extraction,
});

const disclaimedNoNumber = { caller: { caller_id_disclaimed: true, phone_source: 'unknown', phone_e164: null } };
const disclaimedWithAlt = { caller: { caller_id_disclaimed: true, phone_source: 'spoken', phone_e164: ALT } };
const disclaimedAltEqualsAni = { caller: { caller_id_disclaimed: true, phone_source: 'both', phone_e164: CALLER } };
const spokenAltNotDisclaimed = { caller: { caller_id_disclaimed: false, phone_source: 'spoken', phone_e164: ALT } };
const ownedAsCallback = { caller: { caller_id_disclaimed: true, phone_source: 'spoken', phone_e164: '+19413187612' } };
// ANI +19415550142; spoken ...0143 is one digit off, ...0152 two: mistranscriptions.
const nearMiss = { caller: { caller_id_disclaimed: false, phone_source: 'spoken', phone_e164: '+19415550143' } };
const twoOff = { caller: { caller_id_disclaimed: false, phone_source: 'spoken', phone_e164: '+19415550152' } };

describe('buildCsrScoringText — caller ID in the prompt', () => {
  test('carries the caller ID line and the callback rule when contactPhone is given', () => {
    const text = promptFor(CALLER);
    expect(text).toContain('Caller ID: 941-555-0142');
    expect(text).toContain('number the caller gave in the call if it differs from the caller ID');
    expect(text).toContain('Never tell staff to call a Waves number');
  });

  test('omits the caller ID line when contactPhone is unknown or one of our lines', () => {
    for (const contactPhone of [null, undefined, '', '+19413187612']) {
      const text = promptFor(contactPhone);
      expect(text).not.toContain('Caller ID:');
      expect(text).toContain('Never tell staff to call a Waves number');
    }
  });

  test('omits the caller ID line when the ANI is disclaimed', () => {
    const text = promptFor(CALLER, disclaimedNoNumber);
    expect(text).not.toContain('Caller ID:');
    expect(text).not.toContain('941-555-0142');
    expect(text).toContain('not theirs');
    expect(text).toContain("the caller's number");
  });

  test('gives the confirmed number, not the disclaimed ANI', () => {
    const text = promptFor(CALLER, disclaimedWithAlt);
    expect(text).not.toContain('Caller ID:');
    expect(text).not.toContain('941-555-0142');
    expect(text).toContain('Confirmed callback number: 941-555-0988');
  });

  test('lists both the caller ID and a different spoken number when not disclaimed', () => {
    const text = promptFor(CALLER, spokenAltNotDisclaimed);
    expect(text).toContain('Caller ID: 941-555-0142');
    expect(text).toContain('Confirmed callback number: 941-555-0988');
  });

  test('a near-miss spoken number shows only the ANI', () => {
    for (const ext of [nearMiss, twoOff]) {
      const text = promptFor(CALLER, ext);
      expect(text).toContain('Caller ID: 941-555-0142');
      expect(text).not.toContain('Confirmed callback number');
    }
  });

  test('an international confirmed callback and ANI keep their country code', () => {
    const uk = '+442079460123';
    const ext = { caller: { caller_id_disclaimed: true, phone_source: 'spoken', phone_e164: uk } };
    expect(promptFor(CALLER, ext)).toContain(`Confirmed callback number: ${uk}`);
    expect(promptFor(uk)).toContain(`Caller ID: ${uk}`);
  });
});

describe('resolveCallbackNumbers', () => {
  test('a wholly different spoken number is confirmed; near misses are not', () => {
    expect(resolveCallbackNumbers(spokenAltNotDisclaimed, CALLER).confirmed).toBe('941-555-0988');
    expect(resolveCallbackNumbers(nearMiss, CALLER).confirmed).toBeNull();
    expect(resolveCallbackNumbers(twoOff, CALLER).confirmed).toBeNull();
  });

  test('a disclaimed ANI is never the caller ID; a disclaimer repeating the ANI confirms nothing', () => {
    expect(resolveCallbackNumbers(disclaimedNoNumber, CALLER)).toEqual({ callerId: null, confirmed: null });
    expect(resolveCallbackNumbers(disclaimedAltEqualsAni, CALLER)).toEqual({ callerId: null, confirmed: null });
    expect(resolveCallbackNumbers(disclaimedWithAlt, CALLER)).toEqual({ callerId: null, confirmed: '941-555-0988' });
  });

  test('an owned number given as the callback is never confirmed', () => {
    expect(resolveCallbackNumbers(ownedAsCallback, CALLER).confirmed).toBeNull();
  });

  test('NANP shapes read 941-xxx-xxxx; junk and bare foreign digits are unusable', () => {
    for (const ani of ['+19415550142', '19415550142', '9415550142', '(941) 555-0142']) {
      expect(resolveCallbackNumbers(null, ani).callerId).toBe('941-555-0142');
    }
    for (const ani of ['anonymous', '442079460123', '+1941555', '+0123456789012']) {
      expect(resolveCallbackNumbers(null, ani).callerId).toBeNull();
    }
    expect(resolveCallbackNumbers(null, '+442079460123').callerId).toBe('+442079460123');
  });
});

describe('callbackNamesOwnedNumber', () => {
  test('true for a call_back task naming an owned line in any format', () => {
    for (const fmt of ['941-318-7612', '(941) 318-7612', '941.318.7612', '9413187612', '+1 941 318 7612']) {
      expect(callbackNamesOwnedNumber('call_back', `Call Pat at ${fmt}.`)).toBe(true);
    }
  });

  test('false for other task types, non-owned numbers, no number, or non-text', () => {
    expect(callbackNamesOwnedNumber('send_sms', 'Text: "Call us at 941-318-7612."')).toBe(false);
    expect(callbackNamesOwnedNumber('send_estimate', 'Call 941-318-7612')).toBe(false);
    expect(callbackNamesOwnedNumber('call_back', 'Call Pat at 941-555-0199.')).toBe(false);
    expect(callbackNamesOwnedNumber('call_back', 'Call Pat back today.')).toBe(false);
    expect(callbackNamesOwnedNumber('call_back', 'Reference 19413187612345.')).toBe(false);
    expect(callbackNamesOwnedNumber('call_back', null)).toBe(false);
  });
});

describe('scoreCall — end to end', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockInserts)) delete mockInserts[k];
    dispatchWithFallback.mockReset();
    logger.warn.mockClear();
  });

  const run = (type, action, extra = {}) => {
    dispatchWithFallback.mockResolvedValue({ ok: true, json: scoreAnswer(type, action) });
    return CSRCoach.scoreCall({
      csrName: 'Test CSR', customerId: null, callDirection: 'inbound', callSource: 'main',
      transcript: 'caller asks about ants', metadata: {}, contactPhone: CALLER, ...extra,
    });
  };

  test('sends the caller ID line to the model', async () => {
    await run('call_back', 'Call Pat at 941-555-0199.');
    const [, request] = dispatchWithFallback.mock.calls[0];
    expect(request.text).toContain('Caller ID: 941-555-0142');
  });

  test('a disclaimed ANI never reaches the prompt', async () => {
    await run('call_back', 'Call Pat at 941-555-0199.', { v2Extraction: disclaimedNoNumber });
    const [, request] = dispatchWithFallback.mock.calls[0];
    expect(request.text).not.toContain('941-555-0142');
  });

  test('stores the model text unchanged and warns (no digits) for an owned number in a call_back task', async () => {
    const action = 'Call Pat at 941-318-7612 today. Do not call (941) 297-2817. Say: "call us at 941-318-7612."';
    await run('call_back', action);
    expect(mockInserts.ai_follow_up_tasks.recommended_action).toBe(action);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const line = logger.warn.mock.calls[0][0];
    expect(line).toContain('ai_follow_up_tasks-1');
    expect(line).not.toMatch(/\d{3}[-.\s)]*\d{3}[-.\s]*\d{4}/);
  });

  test('stores a send_sms script unchanged and does not warn', async () => {
    const action = 'Text the caller: "Please call us at 941-318-7612 to book."';
    await run('send_sms', action);
    expect(mockInserts.ai_follow_up_tasks.recommended_action).toBe(action);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('does not warn for a call_back task with a customer number', async () => {
    const action = 'Call Pat at 941-555-0199 today.';
    await run('call_back', action);
    expect(mockInserts.ai_follow_up_tasks.recommended_action).toBe(action);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('a throwing logger never breaks the insert', async () => {
    logger.warn.mockImplementationOnce(() => { throw new Error('log down'); });
    await expect(run('call_back', 'Call Pat at 941-318-7612.')).resolves.toBeDefined();
  });
});
