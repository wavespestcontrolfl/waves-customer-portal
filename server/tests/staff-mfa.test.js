// Staff two-step sign-in (GATE_ADMIN_MFA) — the pure parts of
// server/services/staff-mfa.js: RFC 6238 codes, the ±1 step window,
// recovery-code shape, and the session rule every staff auth check shares.
jest.mock('../models/db', () => jest.fn());

const {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  hotp,
  matchTotpStep,
  normalizeRecoveryCode,
  otpauthUri,
  sessionMfaBlock,
  timeStep,
  twoStepProfile,
} = require('../services/staff-mfa');

const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

function codeAt(secretBase32, ms) {
  return hotp(base32Decode(secretBase32), timeStep(ms));
}

describe('TOTP (RFC 6238 SHA-1 vectors, 6-digit truncation)', () => {
  test.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('T=%s → %s', (seconds, expected) => {
    expect(codeAt(RFC_SECRET, seconds * 1000)).toBe(expected);
  });

  test('base32 round-trips arbitrary bytes and ignores spaces, dashes and case', () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 7]);
    const encoded = base32Encode(bytes);
    expect(base32Decode(encoded)).toEqual(bytes);
    expect(base32Decode(encoded.toLowerCase().replace(/(.{4})/g, '$1 '))).toEqual(bytes);
    expect(() => base32Decode('not base32!')).toThrow();
  });

  test('accepts the current step and one step either side, never two', () => {
    const now = 1_800_000_000_000;
    const step = timeStep(now);
    const secretBytes = base32Decode(RFC_SECRET);
    expect(matchTotpStep(RFC_SECRET, hotp(secretBytes, step), now)).toBe(step);
    expect(matchTotpStep(RFC_SECRET, hotp(secretBytes, step - 1), now)).toBe(step - 1);
    expect(matchTotpStep(RFC_SECRET, hotp(secretBytes, step + 1), now)).toBe(step + 1);
    expect(matchTotpStep(RFC_SECRET, hotp(secretBytes, step - 2), now)).toBeNull();
    expect(matchTotpStep(RFC_SECRET, hotp(secretBytes, step + 2), now)).toBeNull();
  });

  test('rejects malformed codes and a malformed secret without throwing', () => {
    const now = 1_800_000_000_000;
    expect(matchTotpStep(RFC_SECRET, '12345', now)).toBeNull();
    expect(matchTotpStep(RFC_SECRET, '1234567', now)).toBeNull();
    expect(matchTotpStep(RFC_SECRET, 'abcdef', now)).toBeNull();
    expect(matchTotpStep(RFC_SECRET, null, now)).toBeNull();
    expect(matchTotpStep('!!!', '123456', now)).toBeNull();
  });

  test('the otpauth URI carries the issuer, secret and RFC parameters an authenticator needs', () => {
    const raw = otpauthUri(RFC_SECRET, 'owner@example.test');
    expect(raw.startsWith(`otpauth://totp/${encodeURIComponent('Waves Pest Control:owner@example.test')}?`)).toBe(true);
    const uri = new URL(raw);
    expect(uri.searchParams.get('secret')).toBe(RFC_SECRET);
    expect(uri.searchParams.get('issuer')).toBe('Waves Pest Control');
    expect(uri.searchParams.get('digits')).toBe('6');
    expect(uri.searchParams.get('period')).toBe('30');
    expect(uri.searchParams.get('algorithm')).toBe('SHA1');
  });
});

describe('recovery codes', () => {
  test('ten distinct XXXX-XXXX-XXXX-XXXX codes of 80 random bits each', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
  });

  test('normalizes typing differences and refuses anything else', () => {
    expect(normalizeRecoveryCode('abcd-efgh-ijkl-mnop')).toBe('ABCDEFGHIJKLMNOP');
    expect(normalizeRecoveryCode(' ABCD EFGH IJKL MNOP ')).toBe('ABCDEFGHIJKLMNOP');
    expect(normalizeRecoveryCode('123456')).toBeNull();
    expect(normalizeRecoveryCode('ABCD-EFGH-IJKL-MNO1')).toBeNull();
  });
});

describe('sessionMfaBlock — the one rule adminAuthenticate, verifyStaffBearer and sockets share', () => {
  const ENV = ['GATE_ADMIN_MFA', 'GATE_ADMIN_MFA_ENFORCE'];
  const saved = {};
  beforeEach(() => { for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  const enrolledAdmin = { id: 'a', role: 'admin', mfa_enabled_at: new Date() };
  const bareAdmin = { id: 'b', role: 'admin', mfa_enabled_at: null };
  const bareTech = { id: 'c', role: 'technician', mfa_enabled_at: null };

  test('gate off: persisted enrollment is ignored entirely (the kill switch outranks it)', () => {
    process.env.GATE_ADMIN_MFA_ENFORCE = 'true';
    expect(sessionMfaBlock({}, enrolledAdmin)).toBeNull();
    expect(sessionMfaBlock({}, bareAdmin)).toBeNull();
    expect(twoStepProfile(enrolledAdmin)).toEqual({});
  });

  test('gate on: an enrolled account needs a session that passed the code', () => {
    process.env.GATE_ADMIN_MFA = 'true';
    expect(sessionMfaBlock({}, enrolledAdmin)).toMatchObject({ status: 401, code: 'MFA_REQUIRED' });
    expect(sessionMfaBlock({ mfa: 'true' }, enrolledAdmin)).toMatchObject({ code: 'MFA_REQUIRED' });
    expect(sessionMfaBlock({ mfa: true }, enrolledAdmin)).toBeNull();
    expect(sessionMfaBlock({}, bareAdmin)).toBeNull();
    expect(twoStepProfile(bareAdmin)).toEqual({ twoStep: { enabled: false, enrollmentRequired: false } });
  });

  test('enforce: an admin with no authenticator is held on enrollment; technicians are not', () => {
    process.env.GATE_ADMIN_MFA = 'true';
    process.env.GATE_ADMIN_MFA_ENFORCE = 'true';
    expect(sessionMfaBlock({}, bareAdmin)).toMatchObject({ status: 403, code: 'MFA_ENROLLMENT_REQUIRED' });
    expect(sessionMfaBlock({}, bareTech)).toBeNull();
    expect(twoStepProfile(bareAdmin)).toEqual({ twoStep: { enabled: false, enrollmentRequired: true } });
  });

  test('enforce without the master gate does nothing', () => {
    process.env.GATE_ADMIN_MFA_ENFORCE = 'true';
    expect(sessionMfaBlock({}, bareAdmin)).toBeNull();
  });

  test('only the exact string true turns a gate on', () => {
    process.env.GATE_ADMIN_MFA = '1';
    expect(sessionMfaBlock({}, enrolledAdmin)).toBeNull();
    process.env.GATE_ADMIN_MFA = 'TRUE';
    expect(sessionMfaBlock({}, enrolledAdmin)).toBeNull();
  });
});
