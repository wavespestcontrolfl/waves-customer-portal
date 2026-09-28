// @vitest-environment jsdom
//
// CompletionPanel's invoiceAmount — the single source of truth is now the
// schedule payload's own billingLane.prediction.amount (predictCompletionBilling
// / completionInvoiceAmount, server/services/billing-lane.js), never a local
// tier/lane guard re-derived client-side. Prod 2026-09-26: a slot-reserved
// per-application accept combining two recurring programs left the PROMOTED
// program's visit deliberately unpriced (estimate-converter.js
// reservedAcceptPerVisitSplit) — the old local guard either zeroed a real
// per-application fee or showed the annual/12 monthlyRate as an unpriced
// visit's price, neither of which is what completion actually bills. These
// pin invoiceAmount (observed through the willInvoice-driven CTA label) for
// the shapes pre-push audits kept re-flagging.
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompletionPanel } from './SchedulePage';

vi.mock('../../hooks/useFeatureFlag', () => ({
  useFeatureFlagReady: () => ({ enabled: false, ready: true }),
}));

const BASE_SERVICE = {
  id: 'billing-lane-amount-visit',
  customerId: 'billing-lane-amount-customer',
  customerName: 'Synthetic Customer',
  serviceType: 'Quarterly Pest Control',
  status: 'confirmed',
  scheduledDate: '2099-01-01',
  // Isolate invoiceAmount from the OTHER willInvoice conjuncts (tier /
  // typedOneTimeBilling) — every scenario here is otherwise eligible to
  // invoice; the only variable under test is the amount itself.
  createInvoiceOnComplete: true,
  estimatedPrice: null,
};

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('alert', vi.fn());
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ customer: {}, actions: [], available: false }),
  })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function renderPanel(service) {
  await act(async () => {
    render(
      <CompletionPanel
        service={service}
        products={[]}
        onClose={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue({})}
      />,
    );
  });
}

async function expectInvoiceCta() {
  const button = await screen.findByRole('button', { name: /^Complete & Send Invoice/i });
  return button;
}

async function expectRecapOnlyCta() {
  const button = await screen.findByRole('button', { name: /^Complete & Send Recap/i });
  return button;
}

describe('CompletionPanel invoiceAmount — server-computed billingLane.prediction', () => {
  it('never invoices a sibling-covered first-application visit whose sibling invoice is settled (amount is null, covered by the sibling row)', async () => {
    await renderPanel({
      ...BASE_SERVICE,
      waveguardTier: 'Silver',
      billingLane: {
        mode: 'per_application',
        source: 'explicit',
        monthlyRate: 74.7,
        prediction: {
          kind: 'covered_sibling_invoice',
          amount: null,
          conflictStampedPrice: false,
          invoiceId: 'inv-1',
          invoiceNumber: 'WPC-TEST-0001',
          siblingServiceType: 'Quarterly Pest Control',
        },
        // The server's own canonical verdict (billing-lane.js
        // siblingCoverageForSchedule).
        siblingCoverage: { state: 'settled', invoiceId: 'inv-1', invoiceNumber: 'WPC-TEST-0001', amountDue: 0, reason: 'invoice_settled' },
      },
    });
    await expectRecapOnlyCta();
    expect(screen.queryByRole('button', { name: /^Complete & Send Invoice/i })).not.toBeInTheDocument();
  });

  // Round-8 P1: `billingLane.siblingCoverage` in state
  // 'collect_on_combined_invoice' means completion REUSES the sibling
  // invoice at completion (complete-scheduled-service.js) — an EXISTING
  // outstanding invoice, not a fresh mint — so the panel must treat it as
  // an invoice that WILL happen (pay link + held review), matching what
  // completion actually does, even though `createInvoiceOnComplete` /
  // `waveguardTier` / `typedOneTimeBilling` say nothing about it.
  it('invoices (reuses) a sibling-covered visit whose combined invoice is STILL DUE — pay link, held review, real amount', async () => {
    await renderPanel({
      ...BASE_SERVICE,
      createInvoiceOnComplete: false,
      waveguardTier: null,
      billingLane: {
        mode: 'per_application',
        source: 'explicit',
        monthlyRate: null,
        prediction: {
          kind: 'covered_sibling_invoice',
          amount: null,
          conflictStampedPrice: false,
          invoiceId: 'inv-1',
          invoiceNumber: 'WPC-TEST-0001',
          siblingServiceType: 'Quarterly Pest Control',
        },
        siblingCoverage: { state: 'collect_on_combined_invoice', invoiceId: 'inv-1', invoiceNumber: 'WPC-TEST-0001', amountDue: 153.6, reason: null },
      },
    });
    await expectInvoiceCta();
    expect(screen.queryByRole('button', { name: /^Complete & Send Recap/i })).not.toBeInTheDocument();
  });

  it('invoices the per-application acceptance fee for an unpriced visit on a tiered per-application customer (never $0, never the monthlyRate)', async () => {
    await renderPanel({
      ...BASE_SERVICE,
      waveguardTier: 'Silver',
      monthlyRate: 74.7, // the OLD bug: this annual/12 figure has no relationship to the per-visit fee
      billingLane: {
        mode: 'per_application',
        source: 'explicit',
        monthlyRate: 74.7,
        prediction: { kind: 'invoice', amount: 97.2, conflictStampedPrice: false },
      },
    });
    await expectInvoiceCta();
  });

  it('invoices the monthlyRate for an EXPLICIT monthly-membership customer with no tier stamped', async () => {
    await renderPanel({
      ...BASE_SERVICE,
      waveguardTier: null,
      monthlyRate: 45,
      billingLane: {
        mode: 'monthly_membership',
        source: 'explicit',
        monthlyRate: 45,
        prediction: { kind: 'invoice', amount: 45, conflictStampedPrice: false },
      },
    });
    await expectInvoiceCta();
  });

  it('keeps the monthlyRate fallback for a LEGACY inferred lane (matches the Charge Now mint endpoint)', async () => {
    await renderPanel({
      ...BASE_SERVICE,
      waveguardTier: 'Bronze',
      monthlyRate: 60,
      billingLane: {
        mode: 'per_visit',
        source: 'inferred',
        monthlyRate: 60,
        prediction: { kind: 'invoice', amount: 60, conflictStampedPrice: false },
      },
    });
    await expectInvoiceCta();
  });

  it('never invoices a callback (re-service), regardless of the prediction amount on file', async () => {
    await renderPanel({
      ...BASE_SERVICE,
      isCallback: true,
      waveguardTier: 'Bronze',
      monthlyRate: 60,
      billingLane: {
        mode: 'monthly_membership',
        source: 'explicit',
        monthlyRate: 60,
        prediction: { kind: 'invoice', amount: 60, conflictStampedPrice: false },
      },
    });
    await expectRecapOnlyCta();
  });

  // Codex pre-push P1: predictCompletionBilling already nets prepaidAmount
  // out of an 'invoice' prediction server-side ($100 fee − $60 prepaid =
  // $40 due). Comparing service.prepaidAmount against that ALREADY-NET
  // invoiceAmount a second time misclassified this as prepaidCovered
  // (60 >= 40), which suppressed the invoice for the real remaining $40.
  it('still invoices the real remaining balance on a partially-prepaid unpriced visit (never double-nets the prepayment)', async () => {
    await renderPanel({
      ...BASE_SERVICE,
      waveguardTier: null,
      prepaidAmount: 60,
      prepaidMethod: 'cash',
      billingLane: {
        mode: 'per_application',
        source: 'explicit',
        monthlyRate: null,
        prediction: { kind: 'invoice', amount: 40, conflictStampedPrice: false },
      },
    });
    await expectInvoiceCta();
  });

  // Codex ROUND 2 P1 (sweep finding): autopayCoversVisit used to infer
  // "dues cover it" from autopayActive + a tier + a positive monthlyRate +
  // no stamped visit price — the SAME heuristic class as
  // MobileAppointmentDetailSheet's coveredByMembership bug, just gated on
  // autopay instead of the tier alone. A tiered per_application customer
  // with autopay ON and a real, positive acceptance-fee prediction for
  // this unpriced row satisfied that heuristic anyway (it never looked at
  // the prediction), silencing the invoice CTA for a fee completion and
  // the mint endpoint both bill.
  it('still invoices the acceptance fee when autopay is active on a tiered per-application customer (autopayCoversVisit must not override the prediction)', async () => {
    await renderPanel({
      ...BASE_SERVICE,
      waveguardTier: 'Silver',
      autopayActive: true,
      monthlyRate: 74.7,
      billingLane: {
        mode: 'per_application',
        source: 'explicit',
        monthlyRate: 74.7,
        autopayActive: true,
        prediction: { kind: 'invoice', amount: 97.2, grossAmount: 97.2, conflictStampedPrice: false },
      },
    });
    await expectInvoiceCta();
  });

  // A 'prepaid' kind means completion mints nothing new — its `amount` is
  // what was ALREADY collected (informational), never a balance still due.
  it('sends a recap only for a fully-covered "prepaid" prediction, never invoicing the prepaid figure itself', async () => {
    await renderPanel({
      ...BASE_SERVICE,
      waveguardTier: null,
      prepaidAmount: 100,
      prepaidMethod: 'cash',
      billingLane: {
        mode: 'per_application',
        source: 'explicit',
        monthlyRate: null,
        prediction: { kind: 'prepaid', amount: 100, conflictStampedPrice: false },
      },
    });
    await expectRecapOnlyCta();
  });
});
