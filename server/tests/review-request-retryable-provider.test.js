jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const db = require('../models/db');
const ReviewRequest = require('../services/review-request');

describe('review request SMS retry classification', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-25T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('uses provider nextAllowedAt for retryable provider failures', () => {
    const retryAt = ReviewRequest.__private.retryAtForDeferredSend({
      sent: false,
      blocked: false,
      code: 'PROVIDER_FAILURE',
      retryable: true,
      deferred: true,
      nextAllowedAt: '2026-05-25T12:05:00.000Z',
    });

    expect(retryAt.toISOString()).toBe('2026-05-25T12:05:00.000Z');
  });

  test('does not retry terminal provider failures', () => {
    const retryAt = ReviewRequest.__private.retryAtForDeferredSend({
      sent: false,
      blocked: false,
      code: 'PROVIDER_FAILURE',
      retryable: false,
      terminal: true,
      providerErrorCode: '21614',
    });

    expect(retryAt).toBeNull();
  });
});

describe('review request uncertain-handoff classification (codex #4338 P1)', () => {
  const { isExplicitlyUncertainOutcome } = ReviewRequest.__private;

  test('an uncertain handoff is uncertain even when retryable is unset', () => {
    expect(isExplicitlyUncertainOutcome({
      sent: false, blocked: false, deliveryOutcome: 'uncertain', retryable: false,
    })).toBe(true);
  });

  test('an uncertain handoff is uncertain even when retryable is true', () => {
    expect(isExplicitlyUncertainOutcome({
      sent: false, blocked: false, deliveryOutcome: 'uncertain', retryable: true,
    })).toBe(true);
  });

  test('a definitive not_sent 429 is not uncertain, so it stays on the retryable path', () => {
    const result = {
      sent: false, blocked: false, deliveryOutcome: 'not_sent', retryable: true,
      nextAllowedAt: '2026-05-25T12:05:00.000Z',
    };
    expect(isExplicitlyUncertainOutcome(result)).toBe(false);
    expect(ReviewRequest.__private.retryAtForDeferredSend(result).toISOString())
      .toBe('2026-05-25T12:05:00.000Z');
  });

  test('a legacy result with no deliveryOutcome field is never treated as uncertain', () => {
    expect(isExplicitlyUncertainOutcome({ sent: false, blocked: false, retryable: true })).toBe(false);
    expect(isExplicitlyUncertainOutcome({ sent: false, blocked: true })).toBe(false);
  });

  test('an accepted result is not uncertain', () => {
    expect(isExplicitlyUncertainOutcome({ sent: true, deliveryOutcome: 'accepted' })).toBe(false);
  });
});

describe('_applyOutreachSendResult settles the outreach step from deliveryOutcome (codex #4338 P1)', () => {
  afterEach(() => {
    db.mockReset();
  });

  test('holds an uncertain touch out of processScheduled instead of scheduling a retry', async () => {
    const update = jest.fn().mockResolvedValue(1);
    db.mockReturnValue({ where: jest.fn().mockReturnValue({ update }) });

    const outcome = await ReviewRequest._applyOutreachSendResult(
      { id: 'req-uncertain' },
      { sent: false, blocked: false, deliveryOutcome: 'uncertain', code: 'PROVIDER_FAILURE' },
      'cron',
      'sms',
    );

    expect(db).toHaveBeenCalledWith('review_requests');
    expect(update).toHaveBeenCalledWith({ status: 'deferred' });
    expect(outcome).toEqual({
      ok: false, deferred: true, uncertain: true, channel: 'sms', requestId: 'req-uncertain', code: 'PROVIDER_FAILURE',
    });
  });

  test('still schedules a retry for a definitive not_sent 429, even though retryable is true', async () => {
    const update = jest.fn().mockResolvedValue(1);
    db.mockReturnValue({ where: jest.fn().mockReturnValue({ update }) });

    const outcome = await ReviewRequest._applyOutreachSendResult(
      { id: 'req-429' },
      {
        sent: false, blocked: false, deliveryOutcome: 'not_sent', retryable: true,
        nextAllowedAt: '2026-05-25T12:05:00.000Z', code: 'PROVIDER_FAILURE',
      },
      'cron',
      'sms',
    );

    expect(update).toHaveBeenCalledWith({ status: 'pending', scheduled_for: new Date('2026-05-25T12:05:00.000Z') });
    expect(outcome).toEqual({
      ok: false, deferred: true, nextAllowedAt: new Date('2026-05-25T12:05:00.000Z'),
      channel: 'sms', requestId: 'req-429', code: 'PROVIDER_FAILURE',
    });
  });

  test('a legacy result with no deliveryOutcome still uses the retryable/deferred path unchanged', async () => {
    const update = jest.fn().mockResolvedValue(1);
    db.mockReturnValue({ where: jest.fn().mockReturnValue({ update }) });

    const outcome = await ReviewRequest._applyOutreachSendResult(
      { id: 'req-legacy' },
      { sent: false, blocked: false, retryable: true, code: 'PROVIDER_FAILURE' },
      'cron',
      'sms',
    );

    // No deliveryOutcome at all: falls straight to the pre-existing
    // retryable/deferred branch, exactly as before this fix.
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: 'pending' }));
    expect(outcome.deferred).toBe(true);
  });
});
