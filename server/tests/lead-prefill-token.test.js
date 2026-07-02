/**
 * Lead-prefill HMAC token (utils/lead-prefill-token.js) — the security
 * boundary for the voicemail text-back /estimate prefill+attach flow
 * (GET /lead-prefill exchange + the lead-attach on both wizard submit paths).
 * Pins: mint/verify round-trip, lead binding, expiry, tamper rejection, and
 * the fail-closed no-secret path. PREFILL authority only — identity/pricing
 * paths must never accept this token (see estimate-handoff-token.js rule).
 */

const {
  mintLeadPrefillToken,
  verifyLeadPrefillToken,
  TTL_SECONDS,
} = require('../utils/lead-prefill-token');

describe('lead prefill token', () => {
  const originalPrefillSecret = process.env.LEAD_PREFILL_SECRET;
  const originalJwtSecret = process.env.JWT_SECRET;

  const LEAD = '3f2f7b9c-1111-4222-8333-abcdefabcdef';
  const OTHER_LEAD = '9a8b7c6d-2222-4333-8444-fedcbafedcba';
  const NOW = 1_760_000_000; // fixed epoch seconds — tokens are deterministic

  beforeEach(() => {
    process.env.LEAD_PREFILL_SECRET = 'test-prefill-secret';
  });

  afterEach(() => {
    if (originalPrefillSecret === undefined) delete process.env.LEAD_PREFILL_SECRET;
    else process.env.LEAD_PREFILL_SECRET = originalPrefillSecret;
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
  });

  test('mint → verify round-trip, bound to the minted lead id', () => {
    const token = mintLeadPrefillToken(LEAD, NOW);
    expect(token).toEqual(expect.stringMatching(/^\d+\.[A-Za-z0-9_-]+$/));
    expect(verifyLeadPrefillToken(LEAD, token, NOW)).toBe(true);
    // Same token must not authorize a different lead.
    expect(verifyLeadPrefillToken(OTHER_LEAD, token, NOW)).toBe(false);
  });

  test('expires after TTL and never verifies past exp', () => {
    const token = mintLeadPrefillToken(LEAD, NOW);
    expect(verifyLeadPrefillToken(LEAD, token, NOW + TTL_SECONDS - 1)).toBe(true);
    expect(verifyLeadPrefillToken(LEAD, token, NOW + TTL_SECONDS + 1)).toBe(false);
  });

  test('rejects tampered and malformed tokens', () => {
    const token = mintLeadPrefillToken(LEAD, NOW);
    const [exp, sig] = token.split('.');

    // Flip a signature character.
    const flipped = sig[0] === 'A' ? 'B' : 'A';
    expect(verifyLeadPrefillToken(LEAD, `${exp}.${flipped}${sig.slice(1)}`, NOW)).toBe(false);
    // Extend the expiry without re-signing.
    expect(verifyLeadPrefillToken(LEAD, `${Number(exp) + 9999}.${sig}`, NOW)).toBe(false);
    // Malformed shapes.
    expect(verifyLeadPrefillToken(LEAD, '', NOW)).toBe(false);
    expect(verifyLeadPrefillToken(LEAD, 'no-dot-token', NOW)).toBe(false);
    expect(verifyLeadPrefillToken(LEAD, '.sig-only', NOW)).toBe(false);
    expect(verifyLeadPrefillToken(LEAD, 'NaN.sig', NOW)).toBe(false);
    expect(verifyLeadPrefillToken(LEAD, null, NOW)).toBe(false);
    expect(verifyLeadPrefillToken('', token, NOW)).toBe(false);
  });

  test('fails closed with no secret configured — no token, no verify', () => {
    const token = mintLeadPrefillToken(LEAD, NOW);
    delete process.env.LEAD_PREFILL_SECRET;
    delete process.env.JWT_SECRET;
    expect(mintLeadPrefillToken(LEAD, NOW)).toBeNull();
    expect(verifyLeadPrefillToken(LEAD, token, NOW)).toBe(false);
  });

  test('falls back to JWT_SECRET when no dedicated secret is set', () => {
    delete process.env.LEAD_PREFILL_SECRET;
    process.env.JWT_SECRET = 'jwt-fallback-secret';
    const token = mintLeadPrefillToken(LEAD, NOW);
    expect(token).toBeTruthy();
    expect(verifyLeadPrefillToken(LEAD, token, NOW)).toBe(true);
    // A token minted under a different secret must not verify.
    process.env.JWT_SECRET = 'rotated-secret';
    expect(verifyLeadPrefillToken(LEAD, token, NOW)).toBe(false);
  });
});
