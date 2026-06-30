const { shouldAutoInvoiceCompletion, shouldConsultAnnualPrepayCoverage } = require('../routes/admin-dispatch')._test;

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

  // Annual-prepay TERM coverage is folded into prepaidCovered (see
  // shouldConsultAnnualPrepayCoverage + the completion handler), so the gate
  // suppresses it via the existing prepaidCovered short-circuit — even for a
  // WaveGuard / create_invoice_on_complete membership visit that would
  // otherwise auto-bill at monthly_rate.
  test('prepaidCovered (incl. annual-prepay term) suppresses the WaveGuard membership auto-bill', () => {
    expect(shouldAutoInvoiceCompletion({
      ...base, waveguardTier: 'Silver', invoiceAmount: 139.8, hasVisitPrice: false, prepaidCovered: true,
    })).toBe(false);
    expect(shouldAutoInvoiceCompletion({
      ...base, createInvoiceOnComplete: true, invoiceAmount: 139.8, hasVisitPrice: false, prepaidCovered: true,
    })).toBe(false);
  });
});

describe('shouldConsultAnnualPrepayCoverage (over-suppress guards)', () => {
  const membership = { alreadyStampedPrepaid: false, visitIsPayerBilled: false, hasVisitPrice: false, invoiceAmount: 139.8 };

  test('consults coverage for an unpriced, self-pay membership visit', () => {
    expect(shouldConsultAnnualPrepayCoverage(membership)).toBe(true);
  });

  test('does NOT consult (so a priced extra still bills) when the visit has its own price', () => {
    expect(shouldConsultAnnualPrepayCoverage({ ...membership, hasVisitPrice: true })).toBe(false);
  });

  test('does NOT consult for a payer-billed visit — the payer is owed regardless of homeowner prepay', () => {
    expect(shouldConsultAnnualPrepayCoverage({ ...membership, visitIsPayerBilled: true })).toBe(false);
  });

  test('does NOT consult when already stamped-prepaid (no redundant lookup)', () => {
    expect(shouldConsultAnnualPrepayCoverage({ ...membership, alreadyStampedPrepaid: true })).toBe(false);
  });

  test('does NOT consult a zero/absent amount (callback / nothing to bill)', () => {
    expect(shouldConsultAnnualPrepayCoverage({ ...membership, invoiceAmount: 0 })).toBe(false);
  });
});
