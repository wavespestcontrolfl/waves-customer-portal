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
    const req = (name) => {
      if (name.endsWith('review-click-guard')) return { touchSuppressedByClick };
      if (name.endsWith('scheduled-sms-delivery')) return require('../services/scheduled-sms-delivery');
      return { createInline };
    };
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
    expect(out.reviewSuffix).toBe(`\n\n${require('../services/scheduled-sms-delivery').COMPLETION_REVIEW_INVITE} https://portal.test/l/abc`);
  });
});

describe('immediate completion text: the bundled line is re-checked under the review lock held across the send', () => {
  const source = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
  const from = source.indexOf('        // Send-time click guard for the bundled review line');
  const block = source.slice(from, source.indexOf('        if (sentSmsBody) {', from));
  const { COMPLETION_REVIEW_INVITE } = require('../services/scheduled-sms-delivery');
  const URL = 'https://portal.test/l/abc';
  const COMPLETION = 'Your service is complete: https://portal.test/report/r1';
  const run = async (state) => {
    const updates = [];
    const fakeDb = (table) => {
      const q = { where: () => q, whereNull: () => q, update: async (patch) => { updates.push({ table, patch }); return 1; } };
      return q;
    };
    const markInlineRetryable = jest.fn(async () => {});
    const req = (name) => {
      if (name.endsWith('scheduled-sms-delivery')) return require('../services/scheduled-sms-delivery');
      if (name.endsWith('review-request')) return { markInlineRetryable };
      throw new Error(`unexpected require ${name}`);
    };
    const retryAt = new Date('2026-09-30T12:05:00Z');
    const fn = new Function('require', 'db', 'svc', 'record', 'logger', 'bundledReviewRetryAt', 'state',
      'bundledReviewRequestId', 'bundledReviewUrl', 'sentSmsBody',
      `return (async () => { ${block}; if (state) await dropBundledReviewLine(state); return { sentSmsBody, bundledReviewRequestId, bundledReviewUrl }; })();`);
    const out = await fn(req, fakeDb, { customer_id: 'cust-1' }, { id: 'rec-1' }, { info: jest.fn(), warn: jest.fn() },
      () => retryAt, state, 'rr-inline', URL, `${COMPLETION}\n\n${COMPLETION_REVIEW_INVITE} ${URL}`);
    return { out, updates, markInlineRetryable, retryAt };
  };

  test('a tap that landed after the mint: the text goes without the line and the ask is suppressed', async () => {
    const { out, updates, markInlineRetryable } = await run('clicked');
    expect(out).toEqual({ sentSmsBody: COMPLETION, bundledReviewRequestId: null, bundledReviewUrl: null });
    expect(updates).toEqual([{ table: 'review_requests', patch: { status: 'suppressed', scheduled_for: null } }]);
    expect(markInlineRetryable).not.toHaveBeenCalled();
  });

  test.each(['unknown', 'busy'])('%s: the text goes without the line and the ask is re-armed for the standalone sender', async (state) => {
    const { out, updates, markInlineRetryable, retryAt } = await run(state);
    expect(out).toEqual({ sentSmsBody: COMPLETION, bundledReviewRequestId: null, bundledReviewUrl: null });
    expect(markInlineRetryable).toHaveBeenCalledWith('rr-inline', retryAt);
    expect(updates).toEqual([]);
  });

  test('no tap: the line rides as composed', async () => {
    const { out } = await run(null);
    expect(out).toEqual({ sentSmsBody: `${COMPLETION}\n\n${COMPLETION_REVIEW_INVITE} ${URL}`, bundledReviewRequestId: 'rr-inline', bundledReviewUrl: URL });
  });

  test('both provider calls (first send and the MMS-to-SMS retry) run inside the gated send', () => {
    const at = source.indexOf('const sendCompletionSms = async (drop) => {');
    const fnBody = source.slice(at, source.indexOf('\n          };\n', at));
    expect(fnBody.match(/await sendCustomerMessage\(/g)).toHaveLength(2);
    expect(fnBody).toContain('await dropBundledReviewLine(drop)');
    expect(fnBody).toContain('await mergeRecordNotesKeys(record.id, droppedDelta)');
    expect(source.slice(at)).toMatch(/withBundledAskGate\(svc\.customer_id, bundledReviewRequestId, sendCompletionSms\)/);
  });
});
