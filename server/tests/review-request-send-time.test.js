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
  const { calculateReviewSendPlan } = ReviewService.__private;

  test('a jitter-free plan names the eligibility range live jitter can land in: ±15 min, clamped inside the hour for an anchored answer (codex #4140 r14 P2)', () => {
    // 1 PM ET lawn → anchored 4:30 PM; minute clamped to the hour → 4:15..4:45.
    const anchored = calculateReviewSendPlan(new Date('2026-05-26T17:00:00Z'), 'lawn care', { jitter: false });
    expect(anchored.kind).toBe('anchored');
    expect(anchored.earliestAt.toISOString()).toBe('2026-05-26T20:15:00.000Z');
    expect(anchored.latestAt.toISOString()).toBe('2026-05-26T20:45:00.000Z');
    // 10 AM next-morning anchor: the clamp keeps the range inside 10:00..10:15.
    const morning = calculateReviewSendPlan(new Date('2026-05-26T21:30:00Z'), 'pest control', { jitter: false });
    expect(morning.earliestAt.toISOString()).toBe(morning.at.toISOString());
    expect(morning.latestAt.getTime() - morning.at.getTime()).toBe(15 * 60000);
    // 11 AM pest → relative +120 → 1 PM; the range moves freely.
    const relative = calculateReviewSendPlan(new Date('2026-05-26T15:00:00Z'), 'pest control', { jitter: false });
    expect(relative.kind).toBe('relative');
    expect(relative.latestAt.getTime() - relative.earliestAt.getTime()).toBe(30 * 60000);
    // 3:29 PM WDO → relative +90 → 4:59 PM; a jitter past the 5 PM fence is
    // dropped by normalizeReviewSendWindow, so the late end collapses to `at`
    // (codex #4140 r15 P2).
    const fenced = calculateReviewSendPlan(new Date('2026-05-26T19:29:00Z'), 'wdo inspection', { jitter: false });
    expect(fenced.kind).toBe('relative');
    expect(fenced.at.toISOString()).toBe('2026-05-26T20:59:00.000Z');
    expect(fenced.latestAt.toISOString()).toBe(fenced.at.toISOString());
    expect(fenced.earliestAt.toISOString()).toBe('2026-05-26T20:44:00.000Z');
  });


  test.each([
    ['2026-05-26T11:44:30Z', '2026-05-26T13:00:30.000Z', '2026-05-26T13:29:30.000Z'],
    ['2026-05-26T19:20:30Z', '2026-05-26T20:35:30.000Z', '2026-05-26T20:59:30.000Z'],
  ])('relative preview retains valid interior jitter samples at the fence (%s)', (completed, earliest, latest) => {
    const plan = calculateReviewSendPlan(new Date(completed), 'wdo inspection', { jitter: false });
    expect(plan.earliestAt.toISOString()).toBe(earliest);
    expect(plan.latestAt.toISOString()).toBe(latest);
    const samples = Array.from({ length: 31 }, (_,i) => {
      const random = jest.spyOn(Math, 'random').mockReturnValue((i + 0.5) / 31);
      try { return calculateReviewSendPlan(new Date(completed), 'wdo inspection').at.getTime(); }
      finally { random.mockRestore(); }
    });
    expect(plan.earliestAt.getTime()).toBe(Math.min(...samples));
    expect(plan.latestAt.getTime()).toBe(Math.max(...samples));
  });

  test('keeps lawn and mosquito review requests before 5 PM ET', () => {
    const lawn = calculateReviewSendPlan(new Date('2026-05-26T17:00:00Z'), 'lawn care').at;
    const mosquito = calculateReviewSendPlan(new Date('2026-05-26T17:00:00Z'), 'mosquito').at;

    expect(etParts(lawn)).toMatchObject({ year: 2026, month: 5, day: 26, hour: 16 });
    expect(etParts(mosquito)).toMatchObject({ year: 2026, month: 5, day: 26, hour: 16 });
  });

  test('moves early-morning review requests into the allowed window', () => {
    const sendAt = calculateReviewSendPlan(new Date('2026-05-26T11:00:00Z'), 'pest control').at;
    const parts = etParts(sendAt);

    expect(parts.year).toBe(2026);
    expect(parts.month).toBe(5);
    expect(parts.day).toBe(26);
    expect(parts.hour).toBeGreaterThanOrEqual(9);
    expect(parts.hour).toBeLessThan(17);
  });

  test('moves late-afternoon review requests to the next morning', () => {
    const sendAt = calculateReviewSendPlan(new Date('2026-05-26T20:30:00Z'), 'pest control').at;

    expect(etParts(sendAt)).toMatchObject({ year: 2026, month: 5, day: 27, hour: 10 });
  });

  test('jitter never crosses the 9 AM / 5 PM bucket — the preview names the day enrollment picks (codex #4140 r3)', () => {
    // WDO at 3:29 PM ET → +90 min = 4:59 PM; a +15 jitter used to spill past 5 PM
    // and reschedule to 10 AM next day while the jitter-free preview said today.
    const completedAt = new Date('2026-05-26T19:29:00Z'); // 3:29 PM EDT
    const preview = calculateReviewSendPlan(completedAt, 'WDO inspection', { jitter: false }).at;
    for (let i = 0; i < 200; i += 1) {
      const live = calculateReviewSendPlan(completedAt, 'WDO inspection').at;
      expect(etParts(live).day).toBe(etParts(preview).day);
      expect(etParts(live).hour).toBeLessThan(17);
    }
  });

  test('jitter:false gives the completion panel a stable preview of the same rule', () => {
    const a = calculateReviewSendPlan(new Date('2026-05-26T17:00:00Z'), 'lawn care', { jitter: false }).at;
    const b = calculateReviewSendPlan(new Date('2026-05-26T17:00:00Z'), 'lawn care', { jitter: false }).at;
    expect(a.getTime()).toBe(b.getTime());
    expect(etParts(a)).toMatchObject({ year: 2026, month: 5, day: 26, hour: 16, minute: 30 });
  });

  describe('calculateReviewSendPlan — the bucket behind the preview (codex #4140 r4 P1)', () => {
    const { calculateReviewSendPlan } = ReviewService.__private;

    test('a relative rule keeps one bucket while the completion instant moves by seconds', () => {
      // 10:00:05 vs 10:00:47 AM EDT — pest control in the morning is "+120 minutes",
      // so `at` differs by 42 seconds but the plan is the same plan.
      const a = calculateReviewSendPlan(new Date('2026-05-26T14:00:05Z'), 'pest control', { jitter: false });
      const b = calculateReviewSendPlan(new Date('2026-05-26T14:00:47Z'), 'pest control', { jitter: false });
      expect(a.kind).toBe('relative');
      expect(a.at.getTime()).not.toBe(b.at.getTime());
      expect(a.bucket).toBe(b.bucket);
      expect(a.bucket).toBe('relative:2026-05-26:+120m');
    });

    test('an anchored rule is bucketed by its wall-clock minute on its day', () => {
      const lawn = calculateReviewSendPlan(new Date('2026-05-26T17:00:00Z'), 'lawn care', { jitter: false });
      expect(lawn.kind).toBe('anchored');
      expect(lawn.bucket).toBe('anchored:2026-05-26T16:30');
      expect(lawn.at.getTime()).toBe(calculateReviewSendPlan(new Date('2026-05-26T17:00:00Z'), 'lawn care', { jitter: false }).at.getTime());
    });

    test('crossing a rule boundary changes the bucket — that is the change the panel re-confirms', () => {
      // 2:59 PM EDT pest control = +90 min (relative); 3:00 PM = next morning 10 AM (anchored).
      const before = calculateReviewSendPlan(new Date('2026-05-26T18:59:30Z'), 'pest control', { jitter: false });
      const after = calculateReviewSendPlan(new Date('2026-05-26T19:00:10Z'), 'pest control', { jitter: false });
      expect(before.kind).toBe('relative');
      expect(after).toMatchObject({ kind: 'anchored', bucket: 'anchored:2026-05-27T10:00' });
      expect(before.bucket).not.toBe(after.bucket);
    });

    test('a relative answer the 5 PM fence pushes to next morning is anchored, not relative', () => {
      // WDO at 3:45 PM EDT: +90 min = 5:15 PM → normalizeReviewSendWindow → 10 AM next day.
      const plan = calculateReviewSendPlan(new Date('2026-05-26T19:45:00Z'), 'wdo inspection', { jitter: false });
      expect(plan).toMatchObject({ kind: 'anchored', bucket: 'anchored:2026-05-27T10:00' });
    });
  });

  test('moves WDO review requests that would land after 5 PM to the next morning', () => {
    const sendAt = calculateReviewSendPlan(new Date('2026-05-26T19:45:00Z'), 'wdo inspection').at;

    expect(etParts(sendAt)).toMatchObject({ year: 2026, month: 5, day: 27, hour: 10 });
  });
});
