/**
 * Unit tests for server/utils/phone.js — preserves the existing toE164
 * contract from twilio-voice-webhook.js verbatim. Regression here would
 * silently rewrite caller IDs (e.g. UK +44 → +1 truncation) which
 * historically broke dashboard JOINs against lead_sources.
 */

const { toE164, normalizePhone, phoneIdentityKey } = require('../utils/phone');

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

// codex #4213 P2: an unlinked +44 sender that shares its last ten digits
// with a US customer must key/resolve separately from that customer — a
// last-10-digit collapse is the exact bug that let admin-communications.js
// hand the international thread the US customer's name and id.
describe('phoneIdentityKey — NANP-vs-international grouping (mirrors smsThreadKey)', () => {
  test('NANP formats all share one key regardless of formatting', () => {
    const key = phoneIdentityKey('+19415551234');
    expect(phoneIdentityKey('9415551234')).toBe(key);
    expect(phoneIdentityKey('(941) 555-1234')).toBe(key);
    expect(phoneIdentityKey('1-941-555-1234')).toBe(key);
    expect(key).toBe('9415551234');
  });

  test('a +44 international number keeps a distinct key from a US number sharing its last 10 digits', () => {
    const usKey = phoneIdentityKey('+12079460958');
    const ukKey = phoneIdentityKey('+442079460958');
    expect(usKey).toBe('2079460958');
    expect(ukKey).toBe('+442079460958');
    expect(ukKey).not.toBe(usKey);
  });

  test('two different countries never collide even at the same length', () => {
    expect(phoneIdentityKey('+442079460958')).not.toBe(phoneIdentityKey('+552079460958'));
  });

  test('empty/garbage input returns null', () => {
    expect(phoneIdentityKey('')).toBeNull();
    expect(phoneIdentityKey(null)).toBeNull();
    expect(phoneIdentityKey('anonymous')).toBeNull();
  });
});

describe('NANP validity (isValidNanpNumber / nanpPhoneProblem)', () => {
  const { isValidNanpNumber, nanpPhoneProblem, nanpNationalDigits } = require('../utils/phone');

  test('toE164 keeps its string contract for an 11-digit leading-1 number', () => {
    expect(toE164('12035550123')).toBe('+12035550123');
    expect(toE164('1 (203) 555-0123')).toBe('+12035550123');
    expect(toE164('(203) 555-0123')).toBe('+12035550123');
  });

  test.each([
    ['12035550123', true],
    ['2035550123', true],
    ['(203) 555-0123', true],
    ['+12035550123', true],
    ['1 203 555 0123', true],
    ['1035550123', false], // area code starts with 1 (ten digits)
    ['0035550123', false], // area code starts with 0
    ['0205550123', false],
    ['2031550123', false], // exchange starts with 1
    ['2030550123', false], // exchange starts with 0
    ['+11035550123', false], // stored E.164 of an impossible number
    ['11035550123', false],
    ['+442079460958', false], // not NANP
    ['', false],
    [null, false],
  ])('isValidNanpNumber(%p) is %p', (input, expected) => {
    expect(isValidNanpNumber(input)).toBe(expected);
  });

  test('nanpPhoneProblem names a NANP-shaped number that cannot exist', () => {
    expect(nanpPhoneProblem('1035550123')).toMatch(/not a valid US phone number/);
    expect(nanpPhoneProblem('+11035550123')).toMatch(/not a valid US phone number/);
    expect(nanpPhoneProblem('+1103555012')).toMatch(/not a valid US phone number/);
  });

  test('nanpPhoneProblem is null for valid, empty, international and non-NANP-shaped input', () => {
    expect(nanpPhoneProblem('2035550123')).toBeNull();
    expect(nanpPhoneProblem('+12035550123')).toBeNull();
    expect(nanpPhoneProblem('')).toBeNull();
    expect(nanpPhoneProblem(null)).toBeNull();
    expect(nanpPhoneProblem('+442079460958')).toBeNull();
    expect(nanpPhoneProblem('anonymous')).toBeNull();
  });

  test('nanpNationalDigits returns the ten national digits only for NANP-shaped input', () => {
    expect(nanpNationalDigits('+12035550123')).toBe('2035550123');
    expect(nanpNationalDigits('12035550123')).toBe('2035550123');
    expect(nanpNationalDigits('22035550123')).toBeNull();
    expect(nanpNationalDigits('+442079460958')).toBeNull();
  });
});
