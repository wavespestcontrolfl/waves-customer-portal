import { describe, expect, it } from 'vitest';
import { captureTimingProps, resolvePaymentTiming } from './paymentTiming';

const COHORT = { afterVisitExisting: true, afterVisitConsent: true };
const ATTACHED = { hasFirstVisitInvoice: true, setupOnly: false };
const SETUP_ONLY = { hasFirstVisitInvoice: false, setupOnly: true };

describe('resolvePaymentTiming (one timing answer for every surface)', () => {
  it('outside the cohort, for annual prepay and for one-time it is null (existing copy everywhere)', () => {
    expect(resolvePaymentTiming({ policy: {}, invoiceShape: ATTACHED })).toBeNull();
    expect(resolvePaymentTiming({ policy: COHORT, paymentPreference: 'prepay_annual', invoiceShape: ATTACHED })).toBeNull();
    expect(resolvePaymentTiming({ policy: COHORT, serviceMode: 'one_time', invoiceShape: ATTACHED })).toBeNull();
  });

  it('a capture customer with an attached first-application invoice: billed after the visit, after-visit consent, attested', () => {
    expect(resolvePaymentTiming({ policy: COHORT, invoiceShape: ATTACHED })).toEqual({
      held: null, firstInvoice: 'after_visit', consentVariant: 'after_visit_card', attestTiming: true,
    });
  });

  it('a setup-only invoice goes out at confirm: base consent, no timing attestation', () => {
    expect(resolvePaymentTiming({ policy: COHORT, invoiceShape: SETUP_ONLY })).toEqual({
      held: null, firstInvoice: 'at_confirm', consentVariant: null, attestTiming: false,
    });
  });

  it('the accept\'s answer wins for THIS selection only', () => {
    const now = { key: 'sel-1', deferred: false };
    expect(resolvePaymentTiming({ policy: COHORT, invoiceShape: ATTACHED, selectionKey: 'sel-1', timingAnswer: now }).firstInvoice).toBe('at_confirm');
    expect(resolvePaymentTiming({ policy: COHORT, invoiceShape: ATTACHED, selectionKey: 'sel-2', timingAnswer: now }).firstInvoice).toBe('after_visit');
    // deferred:true brings a stale tab (no cohort flag yet) onto the after-visit timing.
    const later = { key: 'sel-1', deferred: true };
    expect(resolvePaymentTiming({ policy: {}, invoiceShape: { hasFirstVisitInvoice: false }, selectionKey: 'sel-1', timingAnswer: later }))
      .toMatchObject({ firstInvoice: 'after_visit', attestTiming: true, consentVariant: null });
  });

  it('held cohorts never get the after-visit consent; their timing still follows the invoice', () => {
    expect(resolvePaymentTiming({ policy: { ...COHORT, afterVisitPaused: true }, invoiceShape: ATTACHED }))
      .toMatchObject({ held: 'paused', firstInvoice: 'after_visit', consentVariant: null });
    expect(resolvePaymentTiming({ policy: { afterVisitExisting: true, afterVisitAutopayOff: true }, invoiceShape: SETUP_ONLY }))
      .toMatchObject({ held: 'off', firstInvoice: 'at_confirm' });
  });

  it('a saved-method customer (no capture offered) is on the timing but records no after-visit consent', () => {
    expect(resolvePaymentTiming({ policy: { afterVisitExisting: true }, invoiceShape: ATTACHED }))
      .toMatchObject({ held: null, firstInvoice: 'after_visit', consentVariant: null, attestTiming: true });
  });

  it('captureTimingProps derives every capture prop from the one answer', () => {
    expect(captureTimingProps(null)).toEqual({ afterVisit: false, paused: false, autopayOff: false, firstInvoiceNow: false });
    expect(captureTimingProps(resolvePaymentTiming({ policy: { ...COHORT, afterVisitPaused: true }, invoiceShape: SETUP_ONLY })))
      .toEqual({ afterVisit: false, paused: true, autopayOff: false, firstInvoiceNow: true });
  });
});
