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

// Completion invoice amount precedence: explicit visit price → per-app fee →
// (legacy only) monthly_rate. A per-application customer must NEVER fall back
// to monthly_rate: a multi-service accept intentionally leaves the fee and
// row prices NULL, and monthly_rate is the whole-plan amount — the fallback
// would bill the full package on every service row (Codex round-2 P1).
describe('completionInvoiceAmount', () => {
  const { completionInvoiceAmount } = require('../routes/admin-dispatch')._test;
  const base = {
    estimatedPrice: null,
    isCallback: false,
    perApplicationBilling: false,
    perApplicationFee: null,
    monthlyRate: null,
  };

  test('explicit visit price wins for everyone', () => {
    expect(completionInvoiceAmount({ ...base, estimatedPrice: '129.00', monthlyRate: 55 })).toBe(129);
    expect(completionInvoiceAmount({ ...base, estimatedPrice: 89, perApplicationBilling: true, perApplicationFee: 55.3 })).toBe(89);
  });

  test('per-application: acceptance fee when no explicit price', () => {
    expect(completionInvoiceAmount({ ...base, perApplicationBilling: true, perApplicationFee: '55.30', monthlyRate: 55.3 })).toBe(55.3);
  });

  test('per-application multi-service (no fee, no row price) returns 0 — NEVER the whole-plan monthly_rate (Codex round-2 P1)', () => {
    expect(completionInvoiceAmount({ ...base, perApplicationBilling: true, perApplicationFee: null, monthlyRate: 145 })).toBe(0);
  });

  test('per-application callback is $0 even with a fee on file', () => {
    expect(completionInvoiceAmount({ ...base, perApplicationBilling: true, perApplicationFee: 55.3, isCallback: true })).toBe(0);
  });

  test('legacy customers keep the monthly_rate fallback (WaveGuard membership flows)', () => {
    expect(completionInvoiceAmount({ ...base, monthlyRate: '49.00' })).toBe(49);
  });

  test('legacy callback never falls back to monthly_rate', () => {
    expect(completionInvoiceAmount({ ...base, monthlyRate: 49, isCallback: true })).toBe(0);
  });
});
