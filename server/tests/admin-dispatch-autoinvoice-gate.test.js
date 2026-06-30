const { shouldAutoInvoiceCompletion } = require('../routes/admin-dispatch')._test;

const base = {
  recapReviewOnly: false,
  alreadyPaid: false,
  prepaidCovered: false,
  autopayCoversVisit: false,
  preMintedInvoice: null,
  existingCompletionInvoice: null,
  createInvoiceOnComplete: false,
  waveguardTier: null,
  hasVisitPrice: false,
  invoiceAmount: 0,
  autoInvoicePricedVisits: false,
  serviceType: 'Quarterly Pest Control Service',
  isCallback: false,
};

// The leak shape: priced, self-pay, non-WaveGuard, no scheduler flag.
const pricedSelfPay = { ...base, hasVisitPrice: true, invoiceAmount: 129 };

describe('shouldAutoInvoiceCompletion', () => {
  test('flagged visit invoices regardless of the gate', () => {
    expect(shouldAutoInvoiceCompletion({ ...base, createInvoiceOnComplete: true, invoiceAmount: 129 })).toBe(true);
  });

  test('WaveGuard visit invoices regardless of the gate', () => {
    expect(shouldAutoInvoiceCompletion({ ...base, waveguardTier: 'Gold', invoiceAmount: 49 })).toBe(true);
  });

  test('GATE OFF: priced self-pay visit still does NOT invoice (behaviour unchanged)', () => {
    expect(shouldAutoInvoiceCompletion({ ...pricedSelfPay, autoInvoicePricedVisits: false })).toBe(false);
  });

  test('GATE ON: priced self-pay visit now invoices (leak closed)', () => {
    expect(shouldAutoInvoiceCompletion({ ...pricedSelfPay, autoInvoicePricedVisits: true })).toBe(true);
  });

  test('GATE ON: an always-free service type is NEVER auto-billed even with a stale price', () => {
    const on = { ...pricedSelfPay, autoInvoicePricedVisits: true };
    ['Waves Pest Control Appointment Service', 'Estimate service', 'Pest Control Re-Service', 'Follow-up visit']
      .forEach((serviceType) => {
        expect(shouldAutoInvoiceCompletion({ ...on, serviceType })).toBe(false);
      });
  });

  test('GATE ON: a callback / re-treat is NEVER auto-billed even with a stale price', () => {
    expect(shouldAutoInvoiceCompletion({ ...pricedSelfPay, autoInvoicePricedVisits: true, isCallback: true })).toBe(false);
  });

  test('GATE ON: a paid inspection/rodent visit (ambiguous, not always-free) DOES invoice — price is authoritative at completion', () => {
    const on = { ...pricedSelfPay, autoInvoicePricedVisits: true };
    expect(shouldAutoInvoiceCompletion({ ...on, serviceType: 'WDO Inspection Service' })).toBe(true);
    expect(shouldAutoInvoiceCompletion({ ...on, serviceType: 'Rodent Trapping Service' })).toBe(true);
  });

  test('GATE ON: every coverage guard still blocks the invoice', () => {
    const on = { ...pricedSelfPay, autoInvoicePricedVisits: true };
    expect(shouldAutoInvoiceCompletion({ ...on, autopayCoversVisit: true })).toBe(false);
    expect(shouldAutoInvoiceCompletion({ ...on, prepaidCovered: true })).toBe(false);
    expect(shouldAutoInvoiceCompletion({ ...on, alreadyPaid: true })).toBe(false);
    expect(shouldAutoInvoiceCompletion({ ...on, preMintedInvoice: { id: 'inv' } })).toBe(false);
    expect(shouldAutoInvoiceCompletion({ ...on, existingCompletionInvoice: { id: 'inv' } })).toBe(false);
    expect(shouldAutoInvoiceCompletion({ ...on, recapReviewOnly: true })).toBe(false);
  });

  test('GATE ON: a price-free visit (no explicit price) does NOT invoice — gate only adds priced visits', () => {
    expect(shouldAutoInvoiceCompletion({ ...base, autoInvoicePricedVisits: true, hasVisitPrice: false, invoiceAmount: 49 })).toBe(false);
  });

  test('a zero/absent invoice amount never invoices', () => {
    expect(shouldAutoInvoiceCompletion({ ...base, createInvoiceOnComplete: true, invoiceAmount: 0 })).toBe(false);
    expect(shouldAutoInvoiceCompletion({ ...pricedSelfPay, autoInvoicePricedVisits: true, invoiceAmount: 0 })).toBe(false);
  });

  describe('annual-prepay coverage suppression', () => {
    // The double-bill shape: a WaveGuard customer who prepaid the year still
    // gets an unpriced monthly visit auto-billed at monthly_rate on completion,
    // because the per-visit prepaid_amount stamp was never written (term carried
    // no coverage config). An active PAID term must suppress it.
    test('suppresses the unpriced WaveGuard membership auto-bill', () => {
      expect(shouldAutoInvoiceCompletion({
        ...base, waveguardTier: 'Silver', invoiceAmount: 139.8, hasVisitPrice: false,
        annualPrepayCoversRecurring: true,
      })).toBe(false);
    });

    test('suppresses an unpriced flagged (create_invoice_on_complete) membership visit too', () => {
      expect(shouldAutoInvoiceCompletion({
        ...base, createInvoiceOnComplete: true, invoiceAmount: 139.8, hasVisitPrice: false,
        annualPrepayCoversRecurring: true,
      })).toBe(false);
    });

    test('does NOT over-suppress: a priced extra still bills during a prepay term', () => {
      // A genuinely-priced add-on is not covered by the recurring prepay.
      expect(shouldAutoInvoiceCompletion({
        ...pricedSelfPay, waveguardTier: 'Silver', annualPrepayCoversRecurring: true,
      })).toBe(true);
      expect(shouldAutoInvoiceCompletion({
        ...pricedSelfPay, autoInvoicePricedVisits: true, annualPrepayCoversRecurring: true,
      })).toBe(true);
    });

    test('no coverage flag → WaveGuard membership visit bills as before (regression)', () => {
      expect(shouldAutoInvoiceCompletion({
        ...base, waveguardTier: 'Silver', invoiceAmount: 139.8, hasVisitPrice: false,
        annualPrepayCoversRecurring: false,
      })).toBe(true);
    });
  });
});
