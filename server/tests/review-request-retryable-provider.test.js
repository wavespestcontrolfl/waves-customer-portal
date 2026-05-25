jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

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
