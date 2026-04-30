/**
 * Unit tests for server/utils/phone.js — preserves the existing toE164
 * contract from twilio-voice-webhook.js verbatim. Regression here would
 * silently rewrite caller IDs (e.g. UK +44 → +1 truncation) which
 * historically broke dashboard JOINs against lead_sources.
 */

const { toE164, normalizePhone } = require('../utils/phone');

describe('toE164 — empty/null inputs', () => {
  test('null returns null', () => { expect(toE164(null)).toBeNull(); });
  test('undefined returns null', () => { expect(toE164(undefined)).toBeNull(); });
  test('empty string returns null', () => { expect(toE164('')).toBeNull(); });
  test('whitespace-only returns null', () => { expect(toE164('   ')).toBeNull(); });
});

describe('toE164 — already-E.164 input', () => {
  test('NANP +1 preserved', () => {
    expect(toE164('+19415551234')).toBe('+19415551234');
  });
  test('UK +44 preserved (does NOT get NANP-truncated)', () => {
    expect(toE164('+442079460958')).toBe('+442079460958');
  });
  test('Brazil +55 preserved', () => {
    expect(toE164('+5511987654321')).toBe('+5511987654321');
  });
  test('+ with formatting characters strips formatting', () => {
    expect(toE164('+1 (941) 555-1234')).toBe('+19415551234');
  });
  test('+ followed by garbage returns raw', () => {
    expect(toE164('+abc')).toBe('+abc');
  });
  test('+ with sub-minimum length returns raw', () => {
    expect(toE164('+1234567')).toBe('+1234567'); // 7 digits, fails 8..15 check
  });
});

describe('toE164 — NANP/US bare-digit inputs', () => {
  test('10 digits gets +1 prefix', () => {
    expect(toE164('9415551234')).toBe('+19415551234');
  });
  test('formatted 10-digit', () => {
    expect(toE164('(941) 555-1234')).toBe('+19415551234');
  });
  test('hyphenated 10-digit', () => {
    expect(toE164('941-555-1234')).toBe('+19415551234');
  });
  test('11 digits starting 1 → +1 + last 10', () => {
    expect(toE164('19415551234')).toBe('+19415551234');
  });
  test('1-prefixed formatted', () => {
    expect(toE164('1-941-555-1234')).toBe('+19415551234');
  });
  test('extra digits — takes last 10 (defensive)', () => {
    // "0019415551234" — 13 digits; takes last 10
    expect(toE164('0019415551234')).toBe('+19415551234');
  });
});

describe('toE164 — garbage / sub-10-digit inputs', () => {
  test('< 10 digits returns raw', () => {
    expect(toE164('555-1234')).toBe('555-1234'); // 7 digits
  });
  test('only letters returns raw', () => {
    expect(toE164('hello')).toBe('hello');
  });
  test('only formatting returns raw', () => {
    expect(toE164('()-')).toBe('()-');
  });
});

describe('normalizePhone — alias of toE164', () => {
  test('produces identical output to toE164', () => {
    expect(normalizePhone('9415551234')).toBe(toE164('9415551234'));
    expect(normalizePhone('+19415551234')).toBe(toE164('+19415551234'));
    expect(normalizePhone(null)).toBe(toE164(null));
  });
});
