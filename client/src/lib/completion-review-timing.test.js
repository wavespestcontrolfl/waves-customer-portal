import { describe, expect, test } from 'vitest';
import {
  customReviewTimeProblem,
  reviewDelayMinutesOf,
  reviewPreviewSubmitVerdict,
  reviewScheduledForOf,
  reviewSendPreviewPath,
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
