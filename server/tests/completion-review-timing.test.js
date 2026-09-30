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

describe('bundled completion review suffix vs the send-time click guard', () => {
  // The full completion path needs the postgres suite; the bundling block is
  // self-contained (svc, record, logger, require), so it runs here as written.
  const source = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
  const from = source.indexOf('let bundledReviewUrl = null;');
  const to = source.indexOf("const reviewSuffix = bundledReviewUrl", from);
  const block = source.slice(from, source.indexOf("';", to) + 2);
  const run = async ({ clicked }) => {
    const createInline = jest.fn(async () => ({ url: 'https://portal.test/l/abc', requestId: 'rr-inline' }));
    const touchSuppressedByClick = jest.fn(async () => clicked);
    const req = (name) => (name.endsWith('review-click-guard') ? { touchSuppressedByClick } : { createInline });
    const fn = new Function('require', 'svc', 'record', 'logger', 'shouldBundleReview', `return (async () => { ${block}; return { bundledReviewUrl, bundledReviewRequestId, reviewSuffix }; })();`);
    const out = await fn(req, { id: 'ss-1', customer_id: 'cust-1' }, { id: 'rec-1' }, { error: jest.fn(), warn: jest.fn() }, true);
    return { out, createInline, touchSuppressedByClick };
  };

  test('bundling enabled (cadence off) and a tracked click since the visit: no ask is minted and the completion text carries NO review URL', async () => {
    const { out, createInline, touchSuppressedByClick } = await run({ clicked: true });
    expect(touchSuppressedByClick).toHaveBeenCalledWith('cust-1', { serviceRecordId: 'rec-1', scheduledServiceId: 'ss-1' });
    expect(createInline).not.toHaveBeenCalled();
    expect(out).toEqual({ bundledReviewUrl: null, bundledReviewRequestId: null, reviewSuffix: '' });
  });

  test('no click: the ask is minted and bundled as today', async () => {
    const { out, createInline } = await run({ clicked: false });
    expect(createInline).toHaveBeenCalledWith({ customerId: 'cust-1', serviceRecordId: 'rec-1' });
    expect(out.bundledReviewUrl).toBe('https://portal.test/l/abc');
    expect(out.bundledReviewRequestId).toBe('rr-inline');
    expect(out.reviewSuffix).toContain('https://portal.test/l/abc');
  });
});
