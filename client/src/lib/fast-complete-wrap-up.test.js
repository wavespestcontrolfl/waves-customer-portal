import { describe, expect, test } from 'vitest';
import {
  adjustedTimeProblem,
  adoptSeed,
  customTimeProblem,
  previewRecheckWanted,
  reentrySeedsFrom,
  reviewTimeMissingProblem,
  stepReentry,
  wrapUpBilling,
  wrapUpFields,
} from './fast-complete-wrap-up';

const base = { sendSms: true, includePayLink: true, willInvoice: false, willReview: true, reviewTiming: 'auto', reviewCustomAt: '', adjusted: '', ext: null, int: null, seeds: null };

describe('the Wrap-up body fragment', () => {
  test('untouched it is the four customer-text flags', () => {
    expect(wrapUpFields(base)).toEqual({ sendCompletionSms: true, requestReview: true, includePayLink: true, reviewTiming: 'auto' });
  });

  test('every other key appears only once changed', () => {
    const fields = wrapUpFields({ ...base, adjusted: '45', reviewTiming: 'customer_requested', ext: 35, int: 120, seeds: { exteriorMinutes: 30, interiorMinutes: 120 } });
    expect(fields).toMatchObject({ timeOnSite: 45, reviewTiming: 'customer_requested', reviewDelayMinutes: 0, reviewScheduledFor: null, reentryExteriorMinutes: 35 });
    expect(fields).not.toHaveProperty('reentryInteriorMinutes');
  });

  test('the pay link posts its choice only while the visit invoices and the text is on', () => {
    expect(wrapUpFields({ ...base, includePayLink: false }).includePayLink).toBe(true);
    expect(wrapUpFields({ ...base, includePayLink: false, willInvoice: true }).includePayLink).toBe(false);
    expect(wrapUpFields({ ...base, includePayLink: false, willInvoice: true, sendSms: false }).includePayLink).toBe(true);
  });
});

describe('the Wrap-up guards', () => {
  test('the override must be 1 to 720 minutes, and only an admin has one', () => {
    expect(adjustedTimeProblem({ isAdmin: true, adjusted: '800' })).toBe('Adjusted time on site must be 1–720 minutes.');
    expect(adjustedTimeProblem({ isAdmin: true, adjusted: 'x' })).toBeTruthy();
    expect(adjustedTimeProblem({ isAdmin: true, adjusted: '' })).toBeNull();
    expect(adjustedTimeProblem({ isAdmin: true, adjusted: '45' })).toBeNull();
    expect(adjustedTimeProblem({ isAdmin: false, adjusted: '800' })).toBeNull();
  });

  test('a custom timing needs a time, and only while the review is asked for', () => {
    expect(reviewTimeMissingProblem({ willReview: true, reviewTiming: 'custom', reviewCustomAt: '' })).toBe('Choose a review request time.');
    expect(reviewTimeMissingProblem({ willReview: false, reviewTiming: 'custom', reviewCustomAt: '' })).toBeNull();
    expect(customTimeProblem({ willReview: true, reviewTiming: 'custom', reviewCustomAt: '2020-01-01T10:00' })).toBe('Choose a future review request time.');
    expect(customTimeProblem({ willReview: true, reviewTiming: 'auto', reviewCustomAt: '' })).toBeNull();
  });

  test('the preview is read again for Automatic, and for any timing while the scheduler is unknown', () => {
    expect(previewRecheckWanted({ willReview: true, reviewTiming: 'auto', schedulerStateKnown: true })).toBe(true);
    expect(previewRecheckWanted({ willReview: true, reviewTiming: 'tomorrow_8', schedulerStateKnown: true })).toBe(false);
    expect(previewRecheckWanted({ willReview: true, reviewTiming: 'tomorrow_8', schedulerStateKnown: false })).toBe(true);
    expect(previewRecheckWanted({ willReview: false, reviewTiming: 'auto', schedulerStateKnown: false })).toBe(false);
  });
});

describe('re-entry seeds and billing facts', () => {
  test('seeds are whole positive minutes per side, else 0; a moved side is never clobbered', () => {
    expect(reentrySeedsFrom({ exteriorMinutes: '30.4', interiorMinutes: -5 })).toEqual({ exteriorMinutes: 30, interiorMinutes: 0 });
    expect(reentrySeedsFrom(null)).toEqual({ exteriorMinutes: 0, interiorMinutes: 0 });
    expect(adoptSeed(null, undefined, 30)).toBe(30);
    expect(adoptSeed(30, 30, 45)).toBe(45);
    expect(adoptSeed(35, 30, 45)).toBe(35);
    expect(adoptSeed(35, 30, 0)).toBe(0);
  });

  test('a step stays between 0 and 1440', () => {
    expect(stepReentry(-5)(3)).toBe(0);
    expect(stepReentry(15)(1435)).toBe(1440);
    expect(stepReentry(5)(null)).toBe(5);
  });

  test('a confirmed payer gets the banner; a visit that bills shows no banner without one', () => {
    expect(wrapUpBilling({ estimatedPrice: 90, createInvoiceOnComplete: true, billedToPayer: { name: 'Fixture Group' } }).payerBanner).toMatch(/^Billed to Fixture Group/);
    expect(wrapUpBilling({ estimatedPrice: 90, createInvoiceOnComplete: true })).toEqual({ willInvoice: true, reviewAwaitsPayment: true, payerBanner: null });
    expect(wrapUpBilling(undefined).willInvoice).toBe(false);
  });
});
