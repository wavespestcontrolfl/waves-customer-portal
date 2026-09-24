/**
 * Lead-consultation HMAC token (utils/lead-consultation-token.js) — the
 * security boundary for the "Book with Adam" consultation-link lane
 * (lead-inspection-link-scope.md §3). Pins: mint/verify round-trip (with the
 * lead id carried IN the token), expiry, tamper rejection, the fail-closed
 * no-secret path, and non-interchangeability with lead-prefill-token.js
 * (different namespace — a prefill token must never unlock a consultation
 * booking, and vice versa). BOOKING-PAGE authority only — never identity or
 * pricing authority on a money path.
 */

const crypto = require('crypto');
const {
  mintLeadConsultationToken,
  verifyLeadConsultationToken,
  smsChannelFor,
  TTL_SECONDS,
} = require('../utils/lead-consultation-token');
const { mintLeadPrefillToken } = require('../utils/lead-prefill-token');

describe('lead consultation token', () => {
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

  test('mint → verify round-trip carries the lead id in the token', () => {
    const token = mintLeadConsultationToken(LEAD, NOW);
    expect(token).toEqual(expect.stringMatching(new RegExp(`^${LEAD}\\.\\d+\\.[A-Za-z0-9_-]+$`)));
    expect(verifyLeadConsultationToken(token, NOW)).toEqual({ leadId: LEAD });
  });

  test('a token minted for one lead does not verify as another lead', () => {
    const token = mintLeadConsultationToken(LEAD, NOW);
    const otherToken = mintLeadConsultationToken(OTHER_LEAD, NOW);
    expect(verifyLeadConsultationToken(token, NOW).leadId).toBe(LEAD);
    // Splicing another lead's id onto this signature must not verify.
    const [, exp, sig] = token.split('.');
    expect(verifyLeadConsultationToken(`${OTHER_LEAD}.${exp}.${sig}`, NOW)).toBeNull();
    expect(verifyLeadConsultationToken(otherToken, NOW).leadId).toBe(OTHER_LEAD);
  });

  test('expires after TTL and never verifies past exp', () => {
    const token = mintLeadConsultationToken(LEAD, NOW);
    expect(verifyLeadConsultationToken(token, NOW + TTL_SECONDS - 1)).toEqual({ leadId: LEAD });
    expect(verifyLeadConsultationToken(token, NOW + TTL_SECONDS + 1)).toBeNull();
  });

  test('rejects tampered and malformed tokens', () => {
    const token = mintLeadConsultationToken(LEAD, NOW);
    const [leadId, exp, sig] = token.split('.');

    const flipped = sig[0] === 'A' ? 'B' : 'A';
    expect(verifyLeadConsultationToken(`${leadId}.${exp}.${flipped}${sig.slice(1)}`, NOW)).toBeNull();
    expect(verifyLeadConsultationToken(`${leadId}.${Number(exp) + 9999}.${sig}`, NOW)).toBeNull();
    expect(verifyLeadConsultationToken('', NOW)).toBeNull();
    expect(verifyLeadConsultationToken('no-dots-token', NOW)).toBeNull();
    expect(verifyLeadConsultationToken('.', NOW)).toBeNull();
    expect(verifyLeadConsultationToken(`${leadId}.NaN.${sig}`, NOW)).toBeNull();
    expect(verifyLeadConsultationToken(null, NOW)).toBeNull();
  });

  test('fails closed with no secret configured — no token, no verify', () => {
    const token = mintLeadConsultationToken(LEAD, NOW);
    delete process.env.LEAD_PREFILL_SECRET;
    delete process.env.JWT_SECRET;
    expect(mintLeadConsultationToken(LEAD, NOW)).toBeNull();
    expect(verifyLeadConsultationToken(token, NOW)).toBeNull();
  });

  test('falls back to JWT_SECRET when no dedicated secret is set', () => {
    delete process.env.LEAD_PREFILL_SECRET;
    process.env.JWT_SECRET = 'jwt-fallback-secret';
    const token = mintLeadConsultationToken(LEAD, NOW);
    expect(token).toBeTruthy();
    expect(verifyLeadConsultationToken(token, NOW)).toEqual({ leadId: LEAD });
    process.env.JWT_SECRET = 'rotated-secret';
    expect(verifyLeadConsultationToken(token, NOW)).toBeNull();
  });

  test('a lead-prefill token never verifies as a lead-consultation token (namespace isolation)', () => {
    const prefillToken = mintLeadPrefillToken(LEAD, NOW); // "<exp>.<sig>", different HMAC input
    expect(verifyLeadConsultationToken(prefillToken, NOW)).toBeNull();
    // And a consultation token strung into the prefill verifier's shape must
    // not accidentally verify there either (belt + suspenders on the pairing).
    const { verifyLeadPrefillToken } = require('../utils/lead-prefill-token');
    const consultToken = mintLeadConsultationToken(LEAD, NOW);
    const [, exp, sig] = consultToken.split('.');
    expect(verifyLeadPrefillToken(LEAD, `${exp}.${sig}`, NOW)).toBe(false);
  });

  // Round 11 — Codex pre-push P1, 2026-09-24: the optional `channel` claim
  // (server/services/lead-consultation-link.js passes it through from a
  // future SMS send) is signed IN, not just appended — inspection-public.js's
  // leadContactVerified trusts `channel === 'sms'` as proof this exact link
  // reached the lead's own phone, so it must be exactly as tamper-proof as
  // the lead id and expiry.
  describe('optional channel claim', () => {
    test('mint → verify round-trip with a channel carries it as a 4th segment', () => {
      const token = mintLeadConsultationToken(LEAD, NOW, 'sms');
      expect(token).toEqual(expect.stringMatching(new RegExp(`^${LEAD}\\.\\d+\\.sms\\.[A-Za-z0-9_-]+$`)));
      expect(verifyLeadConsultationToken(token, NOW)).toEqual({ leadId: LEAD, channel: 'sms' });
    });

    test('no channel passed → byte-identical 3-segment token to every existing caller, no channel key on the payload', () => {
      const token = mintLeadConsultationToken(LEAD, NOW);
      expect(token).toEqual(expect.stringMatching(new RegExp(`^${LEAD}\\.\\d+\\.[A-Za-z0-9_-]+$`)));
      expect(verifyLeadConsultationToken(token, NOW)).toEqual({ leadId: LEAD });
    });

    test('splicing a channel segment onto an unchanneled token does not verify (signature does not match)', () => {
      const token = mintLeadConsultationToken(LEAD, NOW);
      const [leadId, exp, sig] = token.split('.');
      expect(verifyLeadConsultationToken(`${leadId}.${exp}.sms.${sig}`, NOW)).toBeNull();
    });

    test('stripping the channel segment off a channeled token does not downgrade it to verify unchanneled', () => {
      const token = mintLeadConsultationToken(LEAD, NOW, 'sms');
      const [leadId, exp, , sig] = token.split('.');
      expect(verifyLeadConsultationToken(`${leadId}.${exp}.${sig}`, NOW)).toBeNull();
    });

    test('swapping the channel value does not verify (a different channel is a different signed payload)', () => {
      const token = mintLeadConsultationToken(LEAD, NOW, 'sms');
      const [leadId, exp, , sig] = token.split('.');
      expect(verifyLeadConsultationToken(`${leadId}.${exp}.email.${sig}`, NOW)).toBeNull();
    });
  });

  // Round 8 — Codex P1: smsChannelFor must be keyed with the server secret,
  // not a bare sha256(phone). The page reveals the last 4 digits, so an
  // unsalted digest would let anyone with the claim brute-force the
  // remaining 6 digits offline (10^6 guesses) and recover the full phone.
  describe('smsChannelFor is secret-keyed, not a bare phone digest', () => {
  // Codex #4737 r13 pre-push P0: full phone identity — an international
  // number sharing a US number's last ten digits gets a different claim.
  test('an international number never shares a US number\'s SMS claim', () => {
    const { smsChannelFor } = require('../utils/lead-consultation-token');
    expect(smsChannelFor('+19415550101')).toBe(smsChannelFor('9415550101'));
    expect(smsChannelFor('+449415550101')).not.toBe(smsChannelFor('9415550101'));
  });

    const PHONE = '9415550101';

    test('differs from a plain unsalted sha256 of the phone (not brute-forceable from the claim alone)', () => {
      const plainSha256 = `sms-${crypto.createHash('sha256').update(`lead-consultation-sms:${PHONE}`).digest('hex').slice(0, 16)}`;
      expect(smsChannelFor(PHONE)).not.toBe(plainSha256);
    });

    test('is stable for the same phone', () => {
      expect(smsChannelFor(PHONE)).toBe(smsChannelFor(PHONE));
      expect(smsChannelFor('+1 (941) 555-0101')).toBe(smsChannelFor(PHONE));
    });

    test('changes if the server secret changes (keyed with the signing secret, not a fixed salt)', () => {
      const withOriginalSecret = smsChannelFor(PHONE);
      process.env.LEAD_PREFILL_SECRET = 'a-completely-different-secret';
      expect(smsChannelFor(PHONE)).not.toBe(withOriginalSecret);
    });

    test('fails closed with no secret configured', () => {
      delete process.env.LEAD_PREFILL_SECRET;
      delete process.env.JWT_SECRET;
      expect(smsChannelFor(PHONE)).toBeNull();
    });
  });
});
