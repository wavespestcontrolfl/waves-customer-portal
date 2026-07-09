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
});

// Per-application billing (billing_mode 'per_application' — owner ruling
// 2026-07-09): every completed application bills the acceptance fee even
// without a scheduler flag, a WaveGuard tier, or the priced-visits gate —
// but never a callback or an always-free type, and never through the
// monthly-membership autopay suppression (the caller excludes per-application
// customers from autopayCoversVisit; billing is HOW their autopay card is
// used, not a reason to skip).
describe('shouldAutoInvoiceCompletion — per-application billing', () => {
  const perApp = { ...base, perApplicationBilling: true, invoiceAmount: 98 };

  test('per-application visit invoices with no flag, no tier, gate off', () => {
    expect(shouldAutoInvoiceCompletion(perApp)).toBe(true);
  });

  test('tier-less commercial per-application visit still invoices', () => {
    expect(shouldAutoInvoiceCompletion({ ...perApp, waveguardTier: null })).toBe(true);
  });

  test('per-application callback / re-treat is never billed', () => {
    expect(shouldAutoInvoiceCompletion({ ...perApp, isCallback: true })).toBe(false);
  });

  test('per-application always-free types are never billed', () => {
    ['Waves Pest Control Appointment Service', 'Estimate service', 'Pest Control Re-Service', 'Follow-up visit']
      .forEach((serviceType) => {
        expect(shouldAutoInvoiceCompletion({ ...perApp, serviceType })).toBe(false);
      });
  });

  test("per-application decides BEFORE the WaveGuard-tier shortcut — a tiered per-app customer's free visit types stay free (Codex P1)", () => {
    const tiered = { ...perApp, waveguardTier: 'Bronze' };
    expect(shouldAutoInvoiceCompletion({ ...tiered, serviceType: 'Pest Control Re-Service' })).toBe(false);
    expect(shouldAutoInvoiceCompletion({ ...tiered, isCallback: true })).toBe(false);
    // ...while their normal application still bills.
    expect(shouldAutoInvoiceCompletion(tiered)).toBe(true);
  });

  test('the explicit scheduler flag still outranks per-application (operator intent)', () => {
    expect(shouldAutoInvoiceCompletion({ ...perApp, serviceType: 'Pest Control Re-Service', createInvoiceOnComplete: true })).toBe(true);
  });

  test('coverage guards still block a per-application bill (first visit paid at acceptance)', () => {
    expect(shouldAutoInvoiceCompletion({ ...perApp, alreadyPaid: true })).toBe(false);
    expect(shouldAutoInvoiceCompletion({ ...perApp, existingCompletionInvoice: { id: 'inv' } })).toBe(false);
    expect(shouldAutoInvoiceCompletion({ ...perApp, prepaidCovered: true })).toBe(false);
  });

  test('zero fee never bills', () => {
    expect(shouldAutoInvoiceCompletion({ ...perApp, invoiceAmount: 0 })).toBe(false);
  });
});
