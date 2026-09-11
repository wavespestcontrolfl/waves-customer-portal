const { __private: { pushTagFor } } = require('../services/notification-triggers');
const { missedCallEligible } = require('../services/missed-call-bell');
const { repeatCallerPlan, callerKey, REPEAT_THRESHOLD, LEASE_MS } = require('../services/repeat-caller-bell');
const ANI = '+19415550100';


describe('finding 5/6 — repeat callers and spoken-name variants', () => {
  test('repeat-caller plan: three calls in the window ring once, a booking or a prior ring silences', () => {
    const now = Date.parse('2026-09-06T18:00:00Z');
    const at = (minsAgo, extra = {}) => ({ created_at: new Date(now - minsAgo * 60000).toISOString(), status: 'completed', answered_by: 'voicemail', ...extra });
    expect(repeatCallerPlan([at(6), at(30)], now)).toBeNull();
    const plan = repeatCallerPlan([at(6), at(30), at(90, { answered_by: 'human' })], now);
    expect(plan).toEqual(expect.objectContaining({ count: REPEAT_THRESHOLD, unanswered: 2 }));
    expect(repeatCallerPlan([at(6), at(30), at(200)], now)).toBeNull(); // third call outside 3h
    expect(repeatCallerPlan([at(6), at(30, { repeat_caller_alerted_at: '2026-09-06T17:30:00Z' }), at(90)], now)).toBeNull();
    expect(repeatCallerPlan([at(6), at(30, { booked: true }), at(90)], now)).toBeNull();
    // codex r3: a live lease is another worker delivering; a stale one is a dead worker's and is reclaimable
    expect(repeatCallerPlan([at(6), at(30, { repeat_caller_claim: new Date(now - 60000).toISOString() }), at(90)], now)).toBeNull();
    expect(repeatCallerPlan([at(6), at(30, { repeat_caller_claim: new Date(now - LEASE_MS - 1000).toISOString() }), at(90)], now)).not.toBeNull();
  });

  test('repeat-caller identity is the full E.164 number, not a ten-digit suffix (r3 P2)', () => {
    expect(callerKey('+19415550100')).toBe('19415550100');
    expect(callerKey('9415550100')).toBe('19415550100');
    expect(callerKey('+449415550100')).toBe('449415550100');
    expect(callerKey('+449415550100')).not.toBe(callerKey('+19415550100'));
    expect(callerKey('anonymous')).toBeNull();
  });

  test('repeat counts distinguish known unanswered outcomes from ambiguous completed calls', () => {
    const now = Date.parse('2026-09-06T18:00:00Z');
    const calls = [
      { status: 'completed', answered_by: null },
      { status: 'completed', answered_by: 'human' },
      { status: 'completed', answered_by: 'ai_agent' },
      { status: 'completed', answered_by: 'voicemail' },
      { status: 'no-answer', answered_by: null },
    ].map((call, i) => ({ ...call, created_at: new Date(now - (10 + i) * 60000) }));
    expect(repeatCallerPlan(calls, now)).toMatchObject({ count: 5, unanswered: 2 });
  });
});

describe('finding 4 — missed-call bell for unknown callers (GATE_MISSED_CALL_UNKNOWN_CALLERS)', () => {
  const base = { direction: 'inbound', customer_id: null, from_phone: '+19415550123', answered_by: 'voicemail', recording_sid: null, call_outcome: null, metadata: { location: 'GBP — Sarasota' } };

  test('gate off → customers only, as before', () => {
    expect(missedCallEligible(base)).toBe(false);
    expect(missedCallEligible({ ...base, customer_id: 'c1' })).toBe(true);
  });

  test('gate on → an unknown dialable number rings; withheld ID, sandbox and Nomorobo spam stay quiet', () => {
    const on = { unknownCallers: true };
    expect(missedCallEligible(base, Date.now(), on)).toBe(true);
    expect(missedCallEligible({ ...base, from_phone: 'anonymous' }, Date.now(), on)).toBe(false);
    expect(missedCallEligible({ ...base, source: 'voice_relay_sandbox' }, Date.now(), on)).toBe(false);
    const spam = { ...base, metadata: { addons: { results: { nomorobo_spamscore: { status: 'successful', result: { score: 1 } } } } } };
    expect(missedCallEligible(spam, Date.now(), on)).toBe(false);
    const clean = { ...base, metadata: { addons: { results: { nomorobo_spamscore: { status: 'successful', result: { score: 0 } } } } } };
    expect(missedCallEligible(clean, Date.now(), on)).toBe(true);
  });
});

describe('regressions', () => {
  test.each(['restricted', '+7378742833', '7378742833', '+17378742833', '+86282452253'])('withheld caller %s cannot ring either bell', (from_phone) => {
    expect(callerKey(from_phone)).toBeNull();
    expect(missedCallEligible({ direction: 'inbound', customer_id: null, from_phone, answered_by: 'missed' }, Date.now(), { unknownCallers: true })).toBe(false);
  });

  test('repeat-caller pushes carry a per-call tag (P2)', () => {
    expect(pushTagFor('repeat_caller', { callLogId: 'c-1' })).toBe('waves-repeat_caller-c-1');
    expect(pushTagFor('repeat_caller', { callLogId: 'c-2' })).not.toBe(pushTagFor('repeat_caller', { callLogId: 'c-1' }));
    expect(pushTagFor('repeat_caller', { callLogId: 'c-3', repeatCallerDeliveryId: 'c-1' })).toBe('waves-repeat_caller-c-1');
  });
});
