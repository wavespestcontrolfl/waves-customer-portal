process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
const { mintComposerContractToken, verifyComposerContractToken, TTL_SECONDS } = require('../utils/composer-contract-token');

describe('composer contract token (server-minted, contract-bound, short-lived)', () => {
  const NOW = 1_800_000_000;

  test('a minted token verifies for its contract within the window and is one [A-Za-z0-9_-] run', () => {
    const token = mintComposerContractToken('k1', NOW);
    expect(token).toMatch(/^[A-Za-z0-9_-]{53}$/);
    expect(verifyComposerContractToken('k1', token, NOW)).toBe(true);
    expect(verifyComposerContractToken('k1', token, NOW + TTL_SECONDS - 1)).toBe(true);
  });

  test('another contract, a tampered signature, a tampered expiry, or an expired token refuses', () => {
    const token = mintComposerContractToken('k1', NOW);
    expect(verifyComposerContractToken('k2', token, NOW)).toBe(false);
    expect(verifyComposerContractToken('k1', `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`, NOW)).toBe(false);
    expect(verifyComposerContractToken('k1', `${String(NOW + TTL_SECONDS + 5)}${token.slice(10)}`, NOW)).toBe(false);
    expect(verifyComposerContractToken('k1', token, NOW + TTL_SECONDS + 1)).toBe(false);
    expect(verifyComposerContractToken('k1', 'A'.repeat(43), NOW)).toBe(false);
    expect(verifyComposerContractToken('k1', '', NOW)).toBe(false);
  });

  test('no secret → no mint, no verify (fail closed)', () => {
    const prev = process.env.JWT_SECRET;
    const prevDedicated = process.env.CONTRACT_LINK_SECRET;
    delete process.env.JWT_SECRET;
    delete process.env.CONTRACT_LINK_SECRET;
    try {
      expect(mintComposerContractToken('k1', NOW)).toBeNull();
      expect(verifyComposerContractToken('k1', 'x'.repeat(53), NOW)).toBe(false);
    } finally {
      process.env.JWT_SECRET = prev;
      if (prevDedicated !== undefined) process.env.CONTRACT_LINK_SECRET = prevDedicated;
    }
  });
});
