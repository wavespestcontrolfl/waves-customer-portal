/**
 * Quote→book handoff token — binds a booking's estimate_id to the customer's own
 * quote so the pay-at-visit money path can't be fed a forged estimate_id.
 */
process.env.ESTIMATE_HANDOFF_SECRET = 'test-secret-abc';
const { mintEstimateHandoffToken, verifyEstimateHandoffToken, TTL_SECONDS } = require('../utils/estimate-handoff-token');

const NOW = 1_700_000_000;

describe('estimate handoff token', () => {
  test('mint + verify round-trip', () => {
    const t = mintEstimateHandoffToken('est-1', NOW);
    expect(t).toBeTruthy();
    expect(verifyEstimateHandoffToken('est-1', t, NOW + 10)).toBe(true);
  });

  test('rejects a different estimate id', () => {
    const t = mintEstimateHandoffToken('est-1', NOW);
    expect(verifyEstimateHandoffToken('est-2', t, NOW + 10)).toBe(false);
  });

  test('rejects a tampered signature', () => {
    const t = mintEstimateHandoffToken('est-1', NOW);
    const exp = t.split('.')[0];
    expect(verifyEstimateHandoffToken('est-1', `${exp}.deadbeefdeadbeef`, NOW + 10)).toBe(false);
    expect(verifyEstimateHandoffToken('est-1', `${t}x`, NOW + 10)).toBe(false);
  });

  test('rejects an expired token', () => {
    const t = mintEstimateHandoffToken('est-1', NOW);
    expect(verifyEstimateHandoffToken('est-1', t, NOW + TTL_SECONDS + 1)).toBe(false);
    expect(verifyEstimateHandoffToken('est-1', t, NOW + TTL_SECONDS - 1)).toBe(true);
  });

  test('fails closed on missing / malformed inputs', () => {
    expect(mintEstimateHandoffToken('', NOW)).toBeNull();
    expect(mintEstimateHandoffToken(null, NOW)).toBeNull();
    expect(verifyEstimateHandoffToken('est-1', '', NOW)).toBe(false);
    expect(verifyEstimateHandoffToken('est-1', null, NOW)).toBe(false);
    expect(verifyEstimateHandoffToken('', mintEstimateHandoffToken('est-1', NOW), NOW)).toBe(false);
    expect(verifyEstimateHandoffToken('est-1', 'garbage', NOW)).toBe(false);
    expect(verifyEstimateHandoffToken('est-1', 'notanumber.sig', NOW)).toBe(false);
  });
});
