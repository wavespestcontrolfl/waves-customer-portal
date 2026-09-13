// Completion panel review timing → the delay the review pipeline receives
// (owner decisions 2026-09-07: "Automatic" = smart window, "Customer asked
// for the link" = next cadence tick + recorded request; legacy values kept
// for older clients and the one-time recap path).
const fs = require('fs');
const path = require('path');
const { parseCompletionReviewDelayMinutes } = require('../services/complete-scheduled-service');

describe('parseCompletionReviewDelayMinutes', () => {
  test('no review requested → null (nothing scheduled)', () => {
    expect(parseCompletionReviewDelayMinutes({ requestReview: false, reviewTiming: 'auto' })).toBeNull();
  });

  test('"Automatic" and an untouched selector both mean no operator override (smart send window)', () => {
    expect(parseCompletionReviewDelayMinutes({ requestReview: true, reviewTiming: 'auto' })).toBeUndefined();
    expect(parseCompletionReviewDelayMinutes({ requestReview: true })).toBeUndefined();
  });

  test('"Customer asked for the link" is delay 0 — next cadence tick, never a bundled instant send in cadence mode', () => {
    expect(parseCompletionReviewDelayMinutes({ requestReview: true, reviewTiming: 'customer_requested' })).toBe(0);
  });

  test('legacy values still parse: now → 0, "120" → 120 minutes', () => {
    expect(parseCompletionReviewDelayMinutes({ requestReview: true, reviewTiming: 'now' })).toBe(0);
    expect(parseCompletionReviewDelayMinutes({ requestReview: true, reviewTiming: '120' })).toBe(120);
    expect(parseCompletionReviewDelayMinutes({ requestReview: true, reviewDelayMinutes: 45 })).toBe(45);
  });

  test('custom timing must be a future ET wall-clock time', () => {
    expect(() => parseCompletionReviewDelayMinutes({ requestReview: true, reviewTiming: 'custom' })).toThrow(/reviewScheduledFor required/);
    expect(() => parseCompletionReviewDelayMinutes({ requestReview: true, reviewTiming: 'custom', reviewScheduledFor: '2020-01-01T10:00' })).toThrow(/future/);
  });
});

describe('legacy (non-cadence) bundling', () => {
  test('only an explicit immediate ask rides inside the completion text — "Automatic" is the separate legacy ask (codex #4140 r1)', () => {
    // The full completion path needs the postgres suite; the rule itself is
    // one expression. No timing (undefined) used to bundle an instant link
    // while enrollment scheduled the same ask 120 minutes out.
    const source = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
    const start = source.indexOf('const shouldBundleReview =');
    const block = source.slice(start, source.indexOf(';', start));
    expect(block).toContain('completionReviewDelayMinutes === 0');
    expect(block).not.toContain('completionReviewDelayMinutes === undefined');
  });
});
