/**
 * Capture-token (proof-of-funnel) contract for /booking/capture-intent.
 *
 * The token is minted in the availability response and required by the public
 * capture endpoint so it can't be used to seed abandoned-booking recovery
 * SMS/email to arbitrary recipients. Pin: a freshly minted token verifies; junk,
 * tampered, expired, and far-future tokens are rejected.
 */

const { _internals } = require('../routes/booking');
const { mintCaptureToken, verifyCaptureToken } = _internals;

describe('capture token', () => {
  test('a freshly minted token verifies', () => {
    expect(verifyCaptureToken(mintCaptureToken())).toBe(true);
  });

  test('rejects missing / malformed tokens', () => {
    for (const t of [undefined, null, '', 'nope', 'a.b.c', '123', {}, 12345]) {
      expect(verifyCaptureToken(t)).toBe(false);
    }
  });

  test('rejects a tampered signature', () => {
    const tok = mintCaptureToken();
    const [exp, sig] = tok.split('.');
    const flipped = sig.slice(0, -1) + (sig.slice(-1) === 'A' ? 'B' : 'A');
    expect(verifyCaptureToken(`${exp}.${flipped}`)).toBe(false);
  });

  test('rejects a forged expiry (signature no longer matches)', () => {
    const tok = mintCaptureToken();
    const sig = tok.split('.')[1];
    const farFuture = Date.now() + 365 * 24 * 3600 * 1000;
    expect(verifyCaptureToken(`${farFuture}.${sig}`)).toBe(false);
  });

  test('rejects an expired token', () => {
    // Mint as if 31 minutes ago (TTL is 30 min) → now > exp.
    const past = Date.now() - 31 * 60 * 1000;
    const expired = mintCaptureToken(past);
    expect(verifyCaptureToken(expired)).toBe(false);
  });
});
