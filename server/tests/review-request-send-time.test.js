jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));
jest.mock('../services/sms-template-renderer', () => ({
  renderSmsTemplate: jest.fn(),
}));

const ReviewService = require('../services/review-request');
const { etParts } = require('../utils/datetime-et');

describe('review request send-time calculator', () => {
  const { calculateReviewSendTime } = ReviewService.__private;

  test('keeps lawn and mosquito review requests before 5 PM ET', () => {
    const lawn = calculateReviewSendTime(new Date('2026-05-26T17:00:00Z'), 'lawn care');
    const mosquito = calculateReviewSendTime(new Date('2026-05-26T17:00:00Z'), 'mosquito');

    expect(etParts(lawn)).toMatchObject({ year: 2026, month: 5, day: 26, hour: 16 });
    expect(etParts(mosquito)).toMatchObject({ year: 2026, month: 5, day: 26, hour: 16 });
  });

  test('moves early-morning review requests into the allowed window', () => {
    const sendAt = calculateReviewSendTime(new Date('2026-05-26T11:00:00Z'), 'pest control');
    const parts = etParts(sendAt);

    expect(parts.year).toBe(2026);
    expect(parts.month).toBe(5);
    expect(parts.day).toBe(26);
    expect(parts.hour).toBeGreaterThanOrEqual(9);
    expect(parts.hour).toBeLessThan(17);
  });

  test('moves late-afternoon review requests to the next morning', () => {
    const sendAt = calculateReviewSendTime(new Date('2026-05-26T20:30:00Z'), 'pest control');

    expect(etParts(sendAt)).toMatchObject({ year: 2026, month: 5, day: 27, hour: 10 });
  });

  test('jitter never crosses the 9 AM / 5 PM bucket — the preview names the day enrollment picks (codex #4140 r3)', () => {
    // WDO at 3:29 PM ET → +90 min = 4:59 PM; a +15 jitter used to spill past 5 PM
    // and reschedule to 10 AM next day while the jitter-free preview said today.
    const completedAt = new Date('2026-05-26T19:29:00Z'); // 3:29 PM EDT
    const preview = calculateReviewSendTime(completedAt, 'WDO inspection', { jitter: false });
    for (let i = 0; i < 200; i += 1) {
      const live = calculateReviewSendTime(completedAt, 'WDO inspection');
      expect(etParts(live).day).toBe(etParts(preview).day);
      expect(etParts(live).hour).toBeLessThan(17);
    }
  });

  test('jitter:false gives the completion panel a stable preview of the same rule', () => {
    const a = calculateReviewSendTime(new Date('2026-05-26T17:00:00Z'), 'lawn care', { jitter: false });
    const b = calculateReviewSendTime(new Date('2026-05-26T17:00:00Z'), 'lawn care', { jitter: false });
    expect(a.getTime()).toBe(b.getTime());
    expect(etParts(a)).toMatchObject({ year: 2026, month: 5, day: 26, hour: 16, minute: 30 });
  });

  test('moves WDO review requests that would land after 5 PM to the next morning', () => {
    const sendAt = calculateReviewSendTime(new Date('2026-05-26T19:45:00Z'), 'wdo inspection');

    expect(etParts(sendAt)).toMatchObject({ year: 2026, month: 5, day: 27, hour: 10 });
  });
});
