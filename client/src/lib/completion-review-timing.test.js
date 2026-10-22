import { describe, expect, test } from 'vitest';
import {
  customReviewTimeProblem,
  reviewDelayMinutesOf,
  reviewPreviewSubmitVerdict,
  completionReportTextExpected,
  reviewScheduledForOf,
  reviewSendPreviewPath,
  timedReviewHint,
  completionReviewHint,
} from './completion-review-timing';

describe('the review timing a completion posts', () => {
  const base = { willReview: true, oneTimeRecapOnly: false, reviewCustomAt: '' };

  test('Automatic posts no explicit delay and no time; the fixed timings post a zero delay', () => {
    expect(reviewDelayMinutesOf({ ...base, reviewTiming: 'auto' })).toBeUndefined();
    expect(reviewScheduledForOf({ ...base, reviewTiming: 'auto' })).toBeNull();
    expect(reviewDelayMinutesOf({ ...base, reviewTiming: 'customer_requested' })).toBe(0);
    expect(reviewDelayMinutesOf({ ...base, reviewTiming: 'tomorrow_8' })).toBe(0);
    expect(reviewScheduledForOf({ ...base, reviewTiming: 'tomorrow_8' })).toMatch(/^\d{4}-\d{2}-\d{2}T08:00$/);
  });

  test('a custom time with nothing valid typed is incomplete (null), and a suppressed review posts nothing', () => {
    expect(reviewDelayMinutesOf({ ...base, reviewTiming: 'custom' })).toBeNull();
    expect(reviewDelayMinutesOf({ ...base, reviewTiming: 'custom', reviewCustomAt: '2030-01-02T10:00' })).toBe(0);
    expect(reviewScheduledForOf({ ...base, reviewTiming: 'custom', reviewCustomAt: '2030-01-02T10:00' })).toBe('2030-01-02T10:00');
    expect(reviewDelayMinutesOf({ ...base, willReview: false, reviewTiming: 'auto' })).toBeNull();
    expect(reviewScheduledForOf({ ...base, willReview: false, reviewTiming: 'tomorrow_8' })).toBeNull();
  });

  test('a custom time must be a real ET time ahead and within 30 days', () => {
    expect(customReviewTimeProblem('')).toBe('Choose a future review request time.');
    expect(customReviewTimeProblem('2020-01-01T10:00')).toBe('Choose a future review request time.');
    expect(customReviewTimeProblem('2099-01-01T10:00')).toBe('The review request time can be at most 30 days after completion.');
  });

  test('the preview path carries the service type', () => {
    expect(reviewSendPreviewPath('Lawn Care')).toBe('/admin/reviews/send-time-preview?serviceType=Lawn+Care');
    expect(reviewSendPreviewPath()).toBe('/admin/reviews/send-time-preview?serviceType=');
  });
});

describe('the verdict on the send-time preview read at submit', () => {
  const shown = { at: '2026-10-12T14:00:00.000Z', bucket: 'b1' };

  test('the same bucket, or a fixed timing against a known preview, goes on', () => {
    expect(reviewPreviewSubmitVerdict({ reviewTiming: 'auto', fresh: { ...shown, at: '2026-10-12T15:00:00.000Z' }, shown })).toBeNull();
    expect(reviewPreviewSubmitVerdict({ reviewTiming: 'tomorrow_8', fresh: { ...shown, bucket: 'b2' }, shown })).toBeNull();
  });

  test('a changed bucket stops for a second look; a failed read stops once and drops what was shown', () => {
    expect(reviewPreviewSubmitVerdict({ reviewTiming: 'auto', fresh: { ...shown, bucket: 'b2' }, shown }).message).toMatch(/changed to .*Submit again to confirm\.$/);
    const failed = reviewPreviewSubmitVerdict({ reviewTiming: 'auto', fresh: null, shown, failureNoticed: false });
    expect(failed).toMatchObject({ noticed: true, dropShown: true });
    expect(failed.message).toMatch(/could not be re-checked/);
    expect(reviewPreviewSubmitVerdict({ reviewTiming: 'auto', fresh: null, shown, failureNoticed: true })).toBeNull();
    expect(reviewPreviewSubmitVerdict({ reviewTiming: 'custom', fresh: null, shown: null, failureNoticed: false }).message).toMatch(/Whether automated review texts can send/);
  });
});

// GATE_REVIEW_ASK_AFTER_REPORT (owner 2026-10-22): the server preview names the rule;
// the Automatic hint words it as "about 10 minutes after the report text".
describe('the Automatic hint while the ask goes out after the report text', () => {
  const afterReport = {
    schedulerEnabled: true, reviewSequencesEnabled: true, afterReport: true, afterReportMinutes: 10,
    at: '2026-10-20T15:10:00.000Z', earliestAt: '2026-10-20T15:10:00.000Z', latestAt: '2026-10-20T15:10:00.000Z',
    bucket: 'after_report:+10m', smsSendWindowEnabled: true, cadenceTickMinutesOfHour: [14, 44], afterReportTickMinutesOfHour: [0, 5, 10, 14, 15, 20, 25, 30, 35, 40, 44, 45, 50, 55],
  };

  test('names the 10 minutes after the report text and the send window, not the smart window', () => {
    const text = timedReviewHint({ reviewTiming: 'auto', preview: afterReport });
    expect(text).toBe('Review text goes out separately, about 10 minutes after the report text, inside the 8 AM–8 PM window. If the report goes by the Waves app instead of a text, it goes at the smart send window.');
    expect(text).not.toMatch(/cadence tick/i);
  });

  test('without the send window gate the window is not promised', () => {
    expect(timedReviewHint({ reviewTiming: 'auto', preview: { ...afterReport, smsSendWindowEnabled: false } }))
      .toBe('Review text goes out separately, about 10 minutes after the report text. If the report goes by the Waves app instead of a text, it goes at the smart send window.');
  });

  test('an unpaid completion invoice: 10 minutes after payment', () => {
    const { text } = completionReviewHint({ willReview: true, effectiveSendSms: true, reviewTiming: 'auto', preview: afterReport, reviewAwaitsPayment: true });
    expect(text).toMatch(/waits for the invoice to be paid, then goes out about 10 minutes after payment/);
    // A report still queued for the morning comes first (codex #6434 r9 P2).
    expect(text).toMatch(/or after the report text if that is still queued for the morning/);
  });

  test.each([
    ['the completion text is off', { effectiveSendSms: false }],
    ['the customer has no phone', { effectiveSendSms: true, customerPhone: '' }],
  ])('no report text to follow (%s): the hint keeps the smart window', (_label, opts) => {
    const now = completionReviewHint({ willReview: true, reviewTiming: 'auto', preview: afterReport, ...opts });
    expect(now.text).toMatch(/smart send window, because no report text goes out/);
    expect(now.text).not.toMatch(/after the report text/);
    const paid = completionReviewHint({ willReview: true, reviewTiming: 'auto', preview: afterReport, reviewAwaitsPayment: true, ...opts });
    expect(paid.text).toMatch(/waits for the invoice to be paid, then goes out at the smart send window, because no report text goes out/);
  });

  test('gate off: the smart-window wording is unchanged', () => {
    const off = { ...afterReport, afterReport: false, afterReportMinutes: null, cadenceTickMinutesOfHour: [14, 44], earliestAt: '2026-10-20T20:00:00.000Z', latestAt: '2026-10-20T20:30:00.000Z', at: '2026-10-20T20:15:00.000Z' };
    expect(timedReviewHint({ reviewTiming: 'auto', preview: off })).not.toMatch(/after the report text/);
    const { text } = completionReviewHint({ willReview: true, effectiveSendSms: true, reviewTiming: 'auto', preview: off, reviewAwaitsPayment: true });
    expect(text).toMatch(/smart send window computed from the payment/);
  });

  test('explicit timings keep their own wording', () => {
    expect(timedReviewHint({ reviewTiming: 'tomorrow_8', preview: afterReport })).toMatch(/tomorrow/);
  });

  test('the preview bucket is stable between reads, so Automatic never asks for a second look', () => {
    const shown = { ...afterReport };
    const fresh = { ...afterReport, at: '2026-10-20T15:12:00.000Z' };
    expect(reviewPreviewSubmitVerdict({ reviewTiming: 'auto', fresh, shown })).toBeNull();
    expect(reviewPreviewSubmitVerdict({ reviewTiming: 'auto', fresh: null, shown, failureNoticed: false }).message)
      .toMatch(/time after the report text/);
  });

  test('a failed re-check without a report text names the smart send window', () => {
    const shown = { ...afterReport };
    expect(reviewPreviewSubmitVerdict({ reviewTiming: 'auto', fresh: null, shown, failureNoticed: false, reportTextExpected: false }).message)
      .toMatch(/smart send window/);
    expect(completionReportTextExpected({ effectiveSendSms: false, customerPhone: '+19415550100' })).toBe(false);
    expect(completionReportTextExpected({ effectiveSendSms: true, customerPhone: '' })).toBe(false);
    expect(completionReportTextExpected({ effectiveSendSms: true, customerPhone: undefined })).toBe(true);
  });
});
