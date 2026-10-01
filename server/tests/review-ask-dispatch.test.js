jest.mock('../services/review-ask-history', () => ({
  ASK_SPACING_MS: 72 * 3600000,
  lastDeliveredAskAt: jest.fn(async () => null),
  lastManualAskAt: jest.fn(async () => null),
  hasInboundTextSince: jest.fn(async () => false),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/review-click-guard', () => ({
  askIdSuppressedByClick: jest.fn(async () => false),
  REVIEW_LINK_CLICKED_REASON: 'already tapped',
}));
jest.mock('../utils/cron-lock', () => ({
  runExclusive: jest.fn(async (_key, callback) => callback()),
  wasLockSkipped: result => result?.skipped === true,
}));
const history = require('../services/review-ask-history');
const lock = require('../utils/cron-lock');
const { dispatchReviewAsk, withBundledAskGate } = require('../services/review-ask-dispatch');
const guard = require('../services/review-click-guard');

describe('review ask dispatch boundary', () => {
  const now = new Date('2040-01-10T16:00:00Z');
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    history.lastDeliveredAskAt.mockReset().mockResolvedValue(null);
    history.lastManualAskAt.mockReset().mockResolvedValue(null);
    history.hasInboundTextSince.mockReset().mockResolvedValue(false);
    lock.runExclusive.mockReset().mockImplementation(async (_key, callback) => callback());
    guard.askIdSuppressedByClick.mockReset().mockResolvedValue(false);
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

  describe('allowAfterCustomerReply', () => {
    const lastAskAt = () => new Date(now.getTime() - 86400000);
    test('an inbound text after the last ask lets the staff ask run, judged in the same lock hold', async () => {
      let held = false;
      lock.runExclusive.mockImplementation(async (_key, callback) => {
        held = true;
        try { return await callback(); } finally { held = false; }
      });
      history.lastDeliveredAskAt.mockResolvedValue(lastAskAt());
      history.hasInboundTextSince.mockImplementation(async () => { expect(held).toBe(true); return true; });
      const provider = jest.fn(async () => ({ sent: true }));
      expect(await dispatchReviewAsk('customer', provider, { allowAfterCustomerReply: true })).toEqual({ sent: true });
      expect(history.hasInboundTextSince).toHaveBeenCalledWith('customer', lastAskAt());
      expect(provider).toHaveBeenCalledTimes(1);
    });

    test('the inbound read is anchored to the most recent ask (staff delivery newer than the tracked ask)', async () => {
      history.lastDeliveredAskAt.mockResolvedValue(new Date(now.getTime() - 2 * 86400000));
      history.lastManualAskAt.mockResolvedValue(lastAskAt());
      history.hasInboundTextSince.mockResolvedValue(true);
      await dispatchReviewAsk('customer', async () => ({ sent: true }), { allowAfterCustomerReply: true });
      expect(history.hasInboundTextSince).toHaveBeenCalledWith('customer', lastAskAt());
    });

    test('no inbound text after the last ask (one only BEFORE it) still blocks', async () => {
      history.lastDeliveredAskAt.mockResolvedValue(lastAskAt());
      history.hasInboundTextSince.mockResolvedValue(false);
      const provider = jest.fn();
      expect(await dispatchReviewAsk('customer', provider, { allowAfterCustomerReply: true }))
        .toMatchObject({ sent: false, blocked: true, code: 'REVIEW_ASK_SPACING', httpStatus: 409 });
      expect(provider).not.toHaveBeenCalled();
    });

    test('without the option an inbound text after the last ask changes nothing (other callers unchanged)', async () => {
      history.lastDeliveredAskAt.mockResolvedValue(lastAskAt());
      history.hasInboundTextSince.mockResolvedValue(true);
      const provider = jest.fn();
      expect(await dispatchReviewAsk('customer', provider)).toMatchObject({ code: 'REVIEW_ASK_SPACING' });
      expect(provider).not.toHaveBeenCalled();
      expect(history.hasInboundTextSince).not.toHaveBeenCalled();
    });

    test('an unreadable inbound history fails closed like a history failure', async () => {
      history.lastManualAskAt.mockResolvedValue(lastAskAt());
      history.hasInboundTextSince.mockRejectedValue(new Error('db down'));
      const provider = jest.fn();
      expect(await dispatchReviewAsk('customer', provider, { allowAfterCustomerReply: true }))
        .toMatchObject({ sent: false, blocked: true, code: 'REVIEW_HISTORY_UNAVAILABLE', httpStatus: 503 });
      expect(provider).not.toHaveBeenCalled();
    });

    test('no prior ask: the inbound read is never made', async () => {
      const provider = jest.fn(async () => ({ sent: true }));
      expect(await dispatchReviewAsk('customer', provider, { allowAfterCustomerReply: true })).toEqual({ sent: true });
      expect(history.hasInboundTextSince).not.toHaveBeenCalled();
    });

    test('a clicked link still blocks regardless of a customer reply', async () => {
      guard.askIdSuppressedByClick.mockResolvedValue(true);
      history.lastDeliveredAskAt.mockResolvedValue(lastAskAt());
      history.hasInboundTextSince.mockResolvedValue(true);
      expect(await dispatchReviewAsk('customer', jest.fn(), { clickAskId: 'rr-1', allowAfterCustomerReply: true }))
        .toMatchObject({ code: 'REVIEW_LINK_CLICKED' });
    });
  });

  test('a busy lock or unresolved customer never reaches the provider', async () => {
    lock.runExclusive.mockResolvedValue({ skipped: true, reason: 'lease_held' });
    const provider = jest.fn();
    expect(await dispatchReviewAsk('customer', provider)).toMatchObject({ code: 'REVIEW_SEND_BUSY', httpStatus: 409 });
    expect(await dispatchReviewAsk(null, provider)).toMatchObject({ code: 'REVIEW_CUSTOMER_REQUIRED' });
    expect(provider).not.toHaveBeenCalled();
  });

  test('excludeReservationId reaches lastManualAskAt so a caller\'s own pre-reserved row cannot self-block it', async () => {
    const provider = jest.fn(async () => ({ sent: true }));
    expect(await dispatchReviewAsk('customer', provider, { excludeReservationId: 'own-reservation' }))
      .toEqual({ sent: true });
    expect(history.lastManualAskAt).toHaveBeenCalledWith('customer', {
      since: new Date(now.getTime() - history.ASK_SPACING_MS), excludeReservationId: 'own-reservation',
    });
  });

  test('a provider throw preserves its known outcome for the caller', async () => {
    const error = Object.assign(new Error('audit failed'), { providerOutcome: { sent: true } });
    await expect(dispatchReviewAsk('customer', async () => { throw error; })).rejects.toBe(error);
  });
  test('a bundled ask is judged for a tracked tap under the same lock hold as the provider call', async () => {
    let held = false;
    lock.runExclusive.mockImplementation(async (_key, callback) => {
      held = true;
      try { return await callback(); } finally { held = false; }
    });
    guard.askIdSuppressedByClick.mockImplementation(async () => { expect(held).toBe(true); return true; });
    const provider = jest.fn();
    expect(await dispatchReviewAsk('customer', provider, { clickAskId: 'rr-1' }))
      .toMatchObject({ sent: false, blocked: true, code: 'REVIEW_LINK_CLICKED' });
    expect(guard.askIdSuppressedByClick).toHaveBeenCalledWith('rr-1');
    expect(provider).not.toHaveBeenCalled();
    expect(history.lastDeliveredAskAt).not.toHaveBeenCalled();
  });

  test('an unreadable click state holds the ask instead of sending it blind', async () => {
    guard.askIdSuppressedByClick.mockRejectedValue(new Error('db down'));
    const provider = jest.fn();
    expect(await dispatchReviewAsk('customer', provider, { clickAskId: 'rr-1' }))
      .toMatchObject({ sent: false, blocked: true, code: 'REVIEW_CLICK_STATE_UNAVAILABLE' });
    expect(provider).not.toHaveBeenCalled();
  });

  test('no clickAskId: the click guard is not consulted', async () => {
    const provider = jest.fn(async () => ({ sent: true }));
    expect(await dispatchReviewAsk('customer', provider)).toEqual({ sent: true });
    expect(guard.askIdSuppressedByClick).not.toHaveBeenCalled();
  });

  test('an immediate completion\'s text is sent inside the same lock hold as its click check (Codex r6 P1)', async () => {
    let held = false;
    lock.runExclusive.mockImplementation(async (_key, callback) => {
      held = true;
      try { return await callback(); } finally { held = false; }
    });
    const seen = [];
    const send = jest.fn(async (drop) => { seen.push({ drop, held }); return { sent: true }; });
    guard.askIdSuppressedByClick.mockImplementationOnce(async () => { expect(held).toBe(true); return true; });
    expect(await withBundledAskGate('customer', 'rr-1', send)).toEqual({ sent: true });
    guard.askIdSuppressedByClick.mockRejectedValueOnce(new Error('db down'));
    await withBundledAskGate('customer', 'rr-1', send);
    await withBundledAskGate('customer', 'rr-1', send);
    expect(seen).toEqual([{ drop: 'clicked', held: true }, { drop: 'unknown', held: true }, { drop: null, held: true }]);
    expect(guard.askIdSuppressedByClick).toHaveBeenCalledWith('rr-1');
    expect(lock.runExclusive).toHaveBeenCalledWith('review-send:customer', expect.any(Function), { recordHealth: false, waitForSlot: false });
  });

  test('a busy or failed lock still sends the completion, with the line dropped', async () => {
    const send = jest.fn(async () => ({ sent: true }));
    lock.runExclusive.mockResolvedValueOnce({ skipped: true, reason: 'lease_held' });
    expect(await withBundledAskGate('customer', 'rr-1', send)).toEqual({ sent: true });
    lock.runExclusive.mockRejectedValueOnce(new Error('no pool'));
    expect(await withBundledAskGate('customer', 'rr-1', send)).toEqual({ sent: true });
    expect(send.mock.calls).toEqual([['busy'], ['unknown']]);
  });

  test('a send that throws inside the lock is not re-sent', async () => {
    const send = jest.fn(async () => { throw new Error('provider exploded'); });
    await expect(withBundledAskGate('customer', 'rr-1', send)).rejects.toThrow('provider exploded');
    expect(send).toHaveBeenCalledTimes(1);
  });
});
