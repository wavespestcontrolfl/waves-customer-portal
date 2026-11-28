const { missedCallEligible } = require('../services/missed-call-bell');

describe('finding 4 — missed-call bell for unknown callers (GATE_MISSED_CALL_UNKNOWN_CALLERS)', () => {
  const base = { direction: 'inbound', customer_id: null, from_phone: '+19415550123', answered_by: 'voicemail', recording_sid: null, call_outcome: null, duration_seconds: 40, metadata: { location: 'GBP — Sarasota' } };

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

  test('gate on → an unknown caller rings only after waiting 15s or more (owner ruling 2026-10-05, replaces the 2026-09-24 25s rule); customers ring at any duration', () => {
    const on = { unknownCallers: true };
    const { UNKNOWN_CALLER_MIN_SECONDS } = require('../services/missed-call-bell');
    expect(UNKNOWN_CALLER_MIN_SECONDS).toBe(15);
    expect(missedCallEligible({ ...base, duration_seconds: 14 }, Date.now(), on)).toBe(false);
    expect(missedCallEligible({ ...base, duration_seconds: 15 }, Date.now(), on)).toBe(true);
    expect(missedCallEligible({ ...base, duration_seconds: 20 }, Date.now(), on)).toBe(true);
    expect(missedCallEligible({ ...base, duration_seconds: 24 }, Date.now(), on)).toBe(true);
    expect(missedCallEligible({ ...base, duration_seconds: '47' }, Date.now(), on)).toBe(true);
    expect(missedCallEligible({ ...base, duration_seconds: null }, Date.now(), on)).toBe(false);
    expect(missedCallEligible({ ...base, duration_seconds: undefined }, Date.now(), on)).toBe(false);
    expect(missedCallEligible({ ...base, answered_by: null, status: 'no-answer', duration_seconds: 6 }, Date.now(), on)).toBe(false);
    expect(missedCallEligible({ ...base, customer_id: 'c1', duration_seconds: 6 }, Date.now(), on)).toBe(true);
    expect(missedCallEligible({ ...base, customer_id: 'c1', duration_seconds: null })).toBe(true);
  });
});

describe('regressions', () => {
  test.each(['restricted', '+7378742833', '7378742833', '+17378742833', '+86282452253'])('withheld caller %s cannot ring the missed-call bell', (from_phone) => {
    expect(missedCallEligible({ direction: 'inbound', customer_id: null, from_phone, answered_by: 'missed', duration_seconds: 40 }, Date.now(), { unknownCallers: true })).toBe(false);
  });
});
