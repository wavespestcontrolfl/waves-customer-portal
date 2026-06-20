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
});
