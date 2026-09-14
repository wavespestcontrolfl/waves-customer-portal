// retireIfClean: the senders' fall-off seam. Calls resolveOpsDigest with the
// key (and a default resolvedBy), reads as 0 when the digest module is a
// stub without it, and never throws.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

describe('retireIfClean', () => {
  afterEach(() => { jest.resetModules(); jest.dontMock('../services/ops-digest'); });

  test('delegates to resolveOpsDigest with the key and a clean-run resolvedBy', async () => {
    const resolveOpsDigest = jest.fn(async () => 3);
    jest.doMock('../services/ops-digest', () => ({ resolveOpsDigest }));
    const { retireIfClean } = require('../services/ops-digest-fall-off');
    await expect(retireIfClean('lead-to-cash-invariants')).resolves.toBe(3);
    expect(resolveOpsDigest).toHaveBeenCalledWith({ key: 'lead-to-cash-invariants', source: null, resolvedBy: 'lead-to-cash-invariants:clean-run' });
    await retireIfClean('gbp-sync-health', { resolvedBy: 'gbp:hourly' });
    expect(resolveOpsDigest).toHaveBeenLastCalledWith({ key: 'gbp-sync-health', source: null, resolvedBy: 'gbp:hourly' });
    await retireIfClean('call-extraction-eval', { alsoRetire: { category: 'eval_regression', field: 'evalKey' } });
    expect(resolveOpsDigest).toHaveBeenLastCalledWith({ key: 'call-extraction-eval', source: null, resolvedBy: 'call-extraction-eval:clean-run', alsoRetire: { category: 'eval_regression', field: 'evalKey' } });
  });

  test('a stubbed digest module without resolveOpsDigest is a no-op', async () => {
    jest.doMock('../services/ops-digest', () => ({ deliverOpsDigest: jest.fn() }));
    const { retireIfClean } = require('../services/ops-digest-fall-off');
    await expect(retireIfClean('anything')).resolves.toBe(0);
  });

  test('a throwing resolve never escapes the sender', async () => {
    jest.doMock('../services/ops-digest', () => ({ resolveOpsDigest: async () => { throw new Error('boom'); } }));
    const { retireIfClean } = require('../services/ops-digest-fall-off');
    await expect(retireIfClean('k')).resolves.toBe(0);
  });
});
