import { describe, expect, test, vi } from 'vitest';
import {
  customReviewTimeProblem,
  reviewDelayMinutesOf,
  reviewPreviewSubmitVerdict,
  completionReportTextExpected,
  reviewScheduledForOf,
  reviewSendPreviewPath,
  timedReviewHint,
  completionReviewHint,
  COMPLAINT_ON_SITE_REASON,
  FIRST_REVIEW_ASK_LABEL,
  firstReviewAskFrom,
  nextReviewChoice,
  reviewBoxLabel,
  reviewOptOutFields,
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

  test('a visit id rides along only when given', () => {
    expect(reviewSendPreviewPath('Lawn Care', 'svc-1')).toBe('/admin/reviews/send-time-preview?serviceType=Lawn+Care&serviceId=svc-1');
  });
});

describe('the first review ask box (GATE_REVIEW_FIRST_ASK_LOCK)', () => {
  test('the label: suppressed and included wordings win; a first ask reads "First review ask"; else today\'s', () => {
    expect(reviewBoxLabel({ reviewSuppressionReason: 'customer_concern', firstAsk: true })).toBe('Review request suppressed');
    expect(reviewBoxLabel({ oneTimeRecapOnly: true, firstAsk: true })).toBe('Review request included');
    expect(reviewBoxLabel({ firstAsk: true })).toBe(FIRST_REVIEW_ASK_LABEL);
    expect(reviewBoxLabel({ firstAsk: false })).toBe('Send review request');
    expect(reviewBoxLabel({})).toBe('Send review request');
  });

  test('the verdict is read only when the server sent one', () => {
    expect(firstReviewAskFrom({ firstReviewAsk: true })).toBe(true);
    expect(firstReviewAskFrom({ firstReviewAsk: false })).toBe(false);
    expect(firstReviewAskFrom({ at: 'x' })).toBeNull();
    expect(firstReviewAskFrom(null)).toBeNull();
  });

  test('toggling: checking always turns it on; unchecking a first ask needs the confirmed reason', () => {
    const yes = () => true;
    const no = () => false;
    expect(nextReviewChoice({ checked: true, firstAsk: true, confirmOptOut: no })).toEqual({ requestReview: true, reviewOptOutReason: null });
    expect(nextReviewChoice({ checked: false, firstAsk: true, confirmOptOut: yes })).toEqual({ requestReview: false, reviewOptOutReason: COMPLAINT_ON_SITE_REASON });
    expect(nextReviewChoice({ checked: false, firstAsk: true, confirmOptOut: no })).toEqual({ requestReview: true, reviewOptOutReason: null });
    const never = vi.fn();
    expect(nextReviewChoice({ checked: false, firstAsk: false, confirmOptOut: never })).toEqual({ requestReview: false, reviewOptOutReason: null });
    expect(never).not.toHaveBeenCalled();
  });

  test('the body carries the reason only beside a first ask turned off', () => {
    expect(reviewOptOutFields({ firstAsk: true, willReview: false, reviewOptOutReason: COMPLAINT_ON_SITE_REASON })).toEqual({ reviewOptOutReason: 'complaint_on_site' });
    expect(reviewOptOutFields({ firstAsk: true, willReview: true, reviewOptOutReason: COMPLAINT_ON_SITE_REASON })).toEqual({});
    expect(reviewOptOutFields({ firstAsk: false, willReview: false, reviewOptOutReason: COMPLAINT_ON_SITE_REASON })).toEqual({});
    expect(reviewOptOutFields({ firstAsk: true, willReview: false, reviewOptOutReason: null })).toEqual({});
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
// the Automatic hint words it as the first :14/:44 send at least 10 minutes after the report text.
describe('the Automatic hint while the ask goes out after the report text', () => {
  const afterReport = {
    schedulerEnabled: true, reviewSequencesEnabled: true, afterReport: true, afterReportMinutes: 10,
    at: '2026-10-20T15:10:00.000Z', earliestAt: '2026-10-20T15:10:00.000Z', latestAt: '2026-10-20T15:10:00.000Z',
    bucket: 'after_report:+10m', smsSendWindowEnabled: true, cadenceTickMinutesOfHour: [14, 44],
  };

  test('names the first :14/:44 send at least 10 minutes after the report text, and the 8 PM limit (codex #6434 r12 P2)', () => {
    const text = timedReviewHint({ reviewTiming: 'auto', preview: afterReport });
    expect(text).toBe('Review text goes out separately at the first review send (:14 and :44 each hour) at least 10 minutes after the report text. A target after 8 PM waits for the next morning. If the report is held for the morning, it goes about 10 minutes after that report text goes out. If the report goes by the Waves app, or texts are turned off for this customer, it goes at the smart send window.');
    expect(text).not.toMatch(/cadence tick/i);
  });

  test('GATE_REVIEW_SENDER_EVERY_5_MIN: twelve ticks read as "every 5 minutes"', () => {
    const fast = { ...afterReport, cadenceTickMinutesOfHour: [4, 9, 14, 19, 24, 29, 34, 39, 44, 49, 54, 59] };
    expect(timedReviewHint({ reviewTiming: 'auto', preview: fast })).toMatch(/^Review text goes out separately at the first review send \(every 5 minutes\) at least 10 minutes after the report text\./);
  });

  test('without the send window gate the window is not promised', () => {
    expect(timedReviewHint({ reviewTiming: 'auto', preview: { ...afterReport, smsSendWindowEnabled: false } }))
      .toBe('Review text goes out separately at the first review send (:14 and :44 each hour) at least 10 minutes after the report text. If the report is held for the morning, it goes about 10 minutes after that report text goes out. If the report goes by the Waves app, or texts are turned off for this customer, it goes at the smart send window.');
  });

  test('an unpaid completion invoice: 10 minutes after payment', () => {
    const { text } = completionReviewHint({ willReview: true, effectiveSendSms: true, reviewTiming: 'auto', preview: afterReport, reviewAwaitsPayment: true });
    expect(text).toMatch(/waits for the invoice to be paid, then goes out at the first review send \(:14 and :44 each hour\) at least 10 minutes after payment/);
    // Any report not texted right away keeps the smart window (codex #6434 r11 P2).
    expect(text).toMatch(/If the report was held for the morning: about 10 minutes after that report text or the payment, whichever is later \(a single visit's held report that went out before the payment keeps the smart send window\)\./);
  });

  test('GATE_REVIEW_ASK_AT_VISIT (askAtVisit in the preview): an unpaid invoice gets the same 10 minutes after the report text, and the link still stays out of the pay-link text', () => {
    const atVisit = { ...afterReport, askAtVisit: true };
    const unpaid = completionReviewHint({ willReview: true, effectiveSendSms: true, reviewTiming: 'auto', preview: atVisit, reviewAwaitsPayment: true });
    expect(unpaid.text).toBe(completionReviewHint({ willReview: true, effectiveSendSms: true, reviewTiming: 'auto', preview: atVisit }).text);
    expect(unpaid.text).toMatch(/at least 10 minutes after the report text/);
    expect(unpaid.text).not.toMatch(/invoice/);
    const asked = completionReviewHint({ willReview: true, effectiveSendSms: true, reviewTiming: 'customer_requested', preview: { ...atVisit, bundlesImmediateAsk: true }, reviewAwaitsPayment: true });
    expect(asked.bundled).toBe(false);
    expect(asked.text).not.toMatch(/waits for invoice payment/);
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
