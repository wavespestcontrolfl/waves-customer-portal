// Retroactive call_log→customer linking (2026-07-30). Born from the Knorr
// voicemail that arrived 18 minutes before its customer record existed and
// stayed customer_id NULL for two weeks. These tests pin the pure contact-
// phone/lookup-key helpers (which must stay in lockstep with webhook intake's
// customerPhoneLookupKey) and the gate-off no-op.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  runCallLogRelink,
  pickContactPhone,
  phoneLookupKey,
} = require('../services/call-log-relink');

describe('pickContactPhone — the customer side of the call', () => {
  test('inbound → from_phone', () => {
    expect(pickContactPhone({ direction: 'inbound', from_phone: '+19413759789', to_phone: '+19413521572' }))
      .toBe('+19413759789');
  });

  test('outbound (including outbound-dial legs) → to_phone', () => {
    expect(pickContactPhone({ direction: 'outbound', from_phone: '+19412975749', to_phone: '+19413759789' }))
      .toBe('+19413759789');
    expect(pickContactPhone({ direction: 'outbound-dial', from_phone: '+19412975749', to_phone: '+19413759789' }))
      .toBe('+19413759789');
  });

  test('missing direction defaults to inbound semantics', () => {
    expect(pickContactPhone({ direction: null, from_phone: '+19413759789', to_phone: '+19413521572' }))
      .toBe('+19413759789');
  });
});

describe('phoneLookupKey — lockstep with webhook intake', () => {
  test('NANP numbers reduce to the 10-digit key regardless of formatting', () => {
    expect(phoneLookupKey('+19413759789')).toBe('9413759789');
    expect(phoneLookupKey('19413759789')).toBe('9413759789');
    expect(phoneLookupKey('(941) 375-9789')).toBe('9413759789');
    expect(phoneLookupKey('941-375-9789')).toBe('9413759789');
  });

  test('garbage and empty values produce empty/short keys (callers must length-check)', () => {
    expect(phoneLookupKey('')).toBe('');
    expect(phoneLookupKey(null)).toBe('');
    expect(phoneLookupKey('anonymous')).toBe('');
  });
});

describe('runCallLogRelink — gate', () => {
  const OLD_GATE = process.env.GATE_CALL_LOG_RELINK;
  afterEach(() => {
    if (OLD_GATE === undefined) delete process.env.GATE_CALL_LOG_RELINK;
    else process.env.GATE_CALL_LOG_RELINK = OLD_GATE;
  });

  test('gated off (default) → no-op, no DB access', async () => {
    delete process.env.GATE_CALL_LOG_RELINK;
    const result = await runCallLogRelink();
    expect(result).toEqual({ skipped: true, reason: 'gated_off' });
  });
});
