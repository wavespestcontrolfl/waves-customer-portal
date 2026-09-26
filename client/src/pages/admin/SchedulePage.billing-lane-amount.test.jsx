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
  it('never invoices a sibling-covered first-application visit (amount is null, covered by the sibling row)', async () => {
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
          invoiceNumber: 'WPC-2026-0505',
          siblingServiceType: 'Quarterly Pest Control',
        },
      },
    });
    await expectRecapOnlyCta();
    expect(screen.queryByRole('button', { name: /^Complete & Send Invoice/i })).not.toBeInTheDocument();
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
});
