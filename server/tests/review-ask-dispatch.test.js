jest.mock('../services/review-ask-history', () => ({
  ASK_SPACING_MS: 72 * 3600000,
  lastDeliveredAskAt: jest.fn(async () => null),
  lastManualAskAt: jest.fn(async () => null),
}));
jest.mock('../utils/cron-lock', () => ({
  runExclusive: jest.fn(async (_key, callback) => callback()),
  wasLockSkipped: result => result?.skipped === true,
}));
const history = require('../services/review-ask-history');
const lock = require('../utils/cron-lock');
const { dispatchReviewAsk } = require('../services/review-ask-dispatch');

describe('review ask dispatch boundary', () => {
  const now = new Date('2040-01-10T16:00:00Z');
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    history.lastDeliveredAskAt.mockReset().mockResolvedValue(null);
    history.lastManualAskAt.mockReset().mockResolvedValue(null);
    lock.runExclusive.mockReset().mockImplementation(async (_key, callback) => callback());
  });
  afterEach(() => jest.useRealTimers());

  test('a first ask invokes the provider under the customer lock', async () => {
    let held = false;
    lock.runExclusive.mockImplementation(async (_key, callback) => {
      held = true;
      try { return await callback(); } finally { held = false; }
    });
    const provider = jest.fn(async () => { expect(held).toBe(true); return { sent: true }; });
    expect(await dispatchReviewAsk('customer', provider)).toEqual({ sent: true });
    expect(lock.runExclusive).toHaveBeenCalledWith('review-send:customer', expect.any(Function), { recordHealth: false, waitForSlot: false });
    expect(held).toBe(false);
  });

  test.each(['lastDeliveredAskAt', 'lastManualAskAt'])('%s is a hard 72-hour floor with equality allowed', async reader => {
    const provider = jest.fn(async () => ({ sent: true }));
    history[reader].mockResolvedValue(new Date(now.getTime() - history.ASK_SPACING_MS + 1));
    const refusal = await dispatchReviewAsk('customer', provider);
    expect(refusal).toMatchObject({ sent: false, blocked: true, code: 'REVIEW_ASK_SPACING',
      nextAllowedAt: new Date(now.getTime() + 1).toISOString() });
    expect(provider).not.toHaveBeenCalled();
    history[reader].mockResolvedValue(new Date(now.getTime() - history.ASK_SPACING_MS));
    expect(await dispatchReviewAsk('customer', provider)).toEqual({ sent: true });
  });

  test('the latest staff delivery wins over an older tracked ask', async () => {
    history.lastDeliveredAskAt.mockResolvedValue(new Date(now.getTime() - 2 * 86400000));
    history.lastManualAskAt.mockResolvedValue(new Date(now.getTime() - 86400000));
    const provider = jest.fn();
    expect(await dispatchReviewAsk('customer', provider, { excludeRequestId: 'own-row' }))
      .toMatchObject({ nextAllowedAt: new Date(now.getTime() + 2 * 86400000).toISOString() });
    expect(history.lastDeliveredAskAt).toHaveBeenCalledWith('customer', { excludeRequestId: 'own-row' });
    expect(provider).not.toHaveBeenCalled();
  });

  test.each(['lastDeliveredAskAt', 'lastManualAskAt'])('%s errors fail closed', async reader => {
    history[reader].mockRejectedValue(new Error('unavailable'));
    const provider = jest.fn();
    expect(await dispatchReviewAsk('customer', provider)).toMatchObject({ code: 'REVIEW_HISTORY_UNAVAILABLE', httpStatus: 503 });
    expect(provider).not.toHaveBeenCalled();
  });

  test('a busy lock or unresolved customer never reaches the provider', async () => {
    lock.runExclusive.mockResolvedValue({ skipped: true, reason: 'lease_held' });
    const provider = jest.fn();
    expect(await dispatchReviewAsk('customer', provider)).toMatchObject({ code: 'REVIEW_SEND_BUSY', httpStatus: 409 });
    expect(await dispatchReviewAsk(null, provider)).toMatchObject({ code: 'REVIEW_CUSTOMER_REQUIRED' });
    expect(provider).not.toHaveBeenCalled();
  });

  test('a provider throw preserves its known outcome for the caller', async () => {
    const error = Object.assign(new Error('audit failed'), { providerOutcome: { sent: true } });
    await expect(dispatchReviewAsk('customer', async () => { throw error; })).rejects.toBe(error);
  });
});
