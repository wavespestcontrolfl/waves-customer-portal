// Retroactive call_log→customer linking (2026-07-30). Born from a July 2026
// voicemail that arrived minutes before its customer record existed and
// stayed customer_id NULL for two weeks. These tests pin the pure contact-
// phone/lookup-key helpers (which must stay in lockstep with webhook intake's
// customerPhoneLookupKey) and the gate-off no-op. All fixture numbers are
// synthetic (555 range).
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/twilio-numbers', () => ({ isInternalNumber: jest.fn(() => false) }));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn(async () => null) }));

const {
  runCallLogRelink,
  pickContactPhone,
  phoneLookupKey,
  isLinkableKey,
  TRANSCRIPTION_REJECTED_SENTINEL,
} = require('../services/call-log-relink');

describe('pickContactPhone — the customer side of the call', () => {
  test('inbound → from_phone', () => {
    expect(pickContactPhone({ direction: 'inbound', from_phone: '+19415550111', to_phone: '+19415550122' }))
      .toBe('+19415550111');
  });

  test('outbound (including outbound-dial legs) → to_phone', () => {
    expect(pickContactPhone({ direction: 'outbound', from_phone: '+19415550122', to_phone: '+19415550111' }))
      .toBe('+19415550111');
    expect(pickContactPhone({ direction: 'outbound-dial', from_phone: '+19415550122', to_phone: '+19415550111' }))
      .toBe('+19415550111');
  });

  test('missing direction defaults to inbound semantics', () => {
    expect(pickContactPhone({ direction: null, from_phone: '+19415550111', to_phone: '+19415550122' }))
      .toBe('+19415550111');
  });
});

describe('phoneLookupKey — lockstep with webhook intake', () => {
  test('NANP numbers reduce to the 10-digit key regardless of formatting', () => {
    expect(phoneLookupKey('+19415550111')).toBe('9415550111');
    expect(phoneLookupKey('19415550111')).toBe('9415550111');
    expect(phoneLookupKey('(941) 555-0111')).toBe('9415550111');
    expect(phoneLookupKey('941-555-0111')).toBe('9415550111');
  });

  test('garbage and empty values produce empty/short keys (callers must length-check)', () => {
    expect(phoneLookupKey('')).toBe('');
    expect(phoneLookupKey(null)).toBe('');
    expect(phoneLookupKey('anonymous')).toBe('');
  });
});

describe('isLinkableKey — which contact numbers may auto-link', () => {
  test('NANP numbers are linkable in any formatting', () => {
    expect(isLinkableKey('+19415550111')).toBe(true);
    expect(isLinkableKey('(941) 555-0111')).toBe(true);
  });

  test('valid short international E.164 stays linkable (lockstep with intake exact-digit lookup)', () => {
    // 8-digit national number with +-prefixed country code — utils/phone
    // preserves these, and intake looks them up on exact digits.
    expect(isLinkableKey('+3712345678')).toBe(true);
  });

  test('bare shortcodes, anonymous, and empty presentations never link', () => {
    expect(isLinkableKey('262966')).toBe(false);
    expect(isLinkableKey('anonymous')).toBe(false);
    expect(isLinkableKey('')).toBe(false);
    expect(isLinkableKey(null)).toBe(false);
  });
});

describe('deliberate-unlink guards', () => {
  test('the rejected-voicemail sentinel matches the processor verbatim', () => {
    // If the processor's sentinel string ever changes, this constant must
    // change with it or deliberately-unlinked voicemails become relinkable.
    expect(TRANSCRIPTION_REJECTED_SENTINEL)
      .toBe('[Recording had no usable speech; an implausible transcription was rejected.]');
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
