// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MobileAppointmentDetailSheet from './MobileAppointmentDetailSheet';

vi.mock('./MobileCustomerDetailSheet', () => ({ default: () => null }));
vi.mock('./RainOutSheet', () => ({ default: () => null }));
vi.mock('./EstimateProvenanceCard', () => ({ default: () => null }));
vi.mock('../../lib/cardHoldCancel', () => ({ confirmCardHoldFeeChoice: vi.fn() }));
vi.mock('../../hooks/useCustomerCards', () => ({
  useCustomerCards: () => ({ cards: null }),
}));

beforeEach(() => {
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
  localStorage.setItem('waves_admin_token', 'test-token');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const BASE_SERVICE = {
  id: 'svc-1',
  status: 'confirmed',
  serviceType: 'Quarterly Pest Control',
  serviceTypeDisplay: 'Quarterly Pest Control',
  waveguardTier: 'Bronze',
  estimatedPrice: 100,
  scheduledDate: '2026-07-17',
  windowStart: '15:00:00',
  windowEnd: '16:00:00',
  estimatedDuration: 60,
  customerName: 'Pat Sample',
};

describe('MobileAppointmentDetailSheet billing-lane card', () => {
  it('shows dues coverage plus the stamped-price conflict note for a monthly member', () => {
    render(
      <MobileAppointmentDetailSheet
        service={{
          ...BASE_SERVICE,
          billingLane: {
            mode: 'monthly_membership',
            source: 'explicit',
            monthlyRate: 33.33,
            autopayActive: true,
            openBalance: 96.6,
            openInvoiceCount: 1,
            hasOverdue: true,
            duesPaidThisMonth: true,
            prediction: { kind: 'covered_membership', amount: null, conflictStampedPrice: true },
          },
        }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/Monthly membership/)).toBeInTheDocument();
    expect(screen.getByText(/\$33\.33\/mo dues/)).toBeInTheDocument();
    expect(screen.getByText(/no invoice — covered by membership dues/i)).toBeInTheDocument();
    expect(screen.getByText(/the stamp will be ignored, not billed/i)).toBeInTheDocument();
    expect(screen.getByText(/This month's dues: collected/i)).toBeInTheDocument();
    expect(screen.getByText(/Open balance: \$96\.60 across 1 unpaid invoice — includes overdue/i)).toBeInTheDocument();
    expect(screen.queryByText(/Membership autopay is not active/i)).not.toBeInTheDocument();
  });

  it('warns when a member has autopay off and dues uncollected', () => {
    render(
      <MobileAppointmentDetailSheet
        service={{
          ...BASE_SERVICE,
          billingLane: {
            mode: 'monthly_membership',
            source: 'explicit',
            monthlyRate: 33.33,
            autopayActive: false,
            openBalance: 0,
            openInvoiceCount: 0,
            hasOverdue: false,
            duesPaidThisMonth: false,
            prediction: { kind: 'invoice', amount: 33.33, conflictStampedPrice: false },
          },
        }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/This month's dues: not collected yet/i)).toBeInTheDocument();
    expect(screen.getByText(/Membership autopay is not active/i)).toBeInTheDocument();
    expect(screen.queryByText(/Open balance/i)).not.toBeInTheDocument();
  });

  it('shows the invoice prediction for a per-visit customer, with the inferred hint', () => {
    render(
      <MobileAppointmentDetailSheet
        service={{
          ...BASE_SERVICE,
          estimatedPrice: 138,
          billingLane: {
            mode: 'per_visit',
            source: 'inferred',
            monthlyRate: null,
            prediction: { kind: 'invoice', amount: 138, conflictStampedPrice: false },
          },
        }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/Pays per visit/)).toBeInTheDocument();
    expect(screen.getByText(/sends the customer a \$138\.00 invoice/i)).toBeInTheDocument();
    expect(screen.getByText(/inferred — set it on the customer profile/i)).toBeInTheDocument();
    expect(screen.queryByText(/stamp will be ignored/i)).not.toBeInTheDocument();
  });

  it('shows the red BILLING HOLD banner when service is paused', () => {
    render(
      <MobileAppointmentDetailSheet
        service={{
          ...BASE_SERVICE,
          billingLane: {
            mode: 'monthly_membership',
            source: 'explicit',
            monthlyRate: 33.33,
            autopayActive: true,
            servicePausedAt: '2026-07-10T12:00:00Z',
            prediction: { kind: 'covered_membership', amount: null, conflictStampedPrice: false },
          },
        }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/BILLING HOLD — service is paused/i)).toBeInTheDocument();
  });

  it('renders nothing extra when the payload has no billingLane (older cached payloads)', () => {
    render(<MobileAppointmentDetailSheet service={BASE_SERVICE} onClose={() => {}} />);
    expect(screen.queryByText(/Monthly membership/)).not.toBeInTheDocument();
    expect(screen.queryByText(/On completion:/)).not.toBeInTheDocument();
  });
});

describe('MobileAppointmentDetailSheet money-gap warning', () => {
  // Prod 2026-08-31: hand-booked customer, monthly_rate 0, no card, four
  // recurring visits — the sheet said only "nothing bills for this visit".
  const GAP_SERVICE = {
    ...BASE_SERVICE,
    estimatedPrice: null,
    customerId: 'cust-1',
    billingLane: {
      mode: 'per_visit',
      source: 'inferred',
      monthlyRate: null,
      prediction: { kind: 'no_charge', amount: 0, conflictStampedPrice: false, reason: 'no_amount_on_file' },
      unbilledGap: { reason: 'no_amount_on_file', noPaymentMethod: true },
    },
  };

  it('warns that nothing will bill, and names the empty wallet', () => {
    render(<MobileAppointmentDetailSheet service={GAP_SERVICE} onClose={() => {}} />);
    expect(screen.getByText(/Nothing will bill for this visit/i)).toBeInTheDocument();
    expect(screen.getByText(/no rate or price is set, and there is no card on file/i)).toBeInTheDocument();
  });

  it('drops the card clause when the customer has a payment method', () => {
    render(
      <MobileAppointmentDetailSheet
        service={{
          ...GAP_SERVICE,
          billingLane: { ...GAP_SERVICE.billingLane, unbilledGap: { reason: 'no_amount_on_file', noPaymentMethod: false } },
        }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/Nothing will bill for this visit/i)).toBeInTheDocument();
    expect(screen.getByText(/No rate or price is set on this account/i)).toBeInTheDocument();
    expect(screen.queryByText(/no card on file/i)).not.toBeInTheDocument();
  });

  it('stays silent on a visit that is free BY DESIGN', () => {
    // Same no_charge kind, by-design reason — the server sends no unbilledGap.
    render(
      <MobileAppointmentDetailSheet
        service={{
          ...GAP_SERVICE,
          billingLane: {
            ...GAP_SERVICE.billingLane,
            prediction: { kind: 'no_charge', amount: 0, conflictStampedPrice: false, reason: 'callback' },
            unbilledGap: null,
          },
        }}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByText(/Nothing will bill for this visit/i)).not.toBeInTheDocument();
    expect(screen.getByText(/nothing bills for this visit/i)).toBeInTheDocument();
  });

  it('never blocks completion — the owner ruled warn-only (2026-08-31)', () => {
    render(<MobileAppointmentDetailSheet service={GAP_SERVICE} onClose={() => {}} />);
    const complete = screen.getByRole('button', { name: /Complete service/i });
    expect(complete).toBeEnabled();
  });
});

describe('MobileAppointmentDetailSheet priced-but-unminted warning', () => {
  it('says the visit is priced but no invoice will be created', () => {
    render(
      <MobileAppointmentDetailSheet
        service={{
          ...BASE_SERVICE,
          estimatedPrice: 129,
          customerId: 'cust-1',
          billingLane: {
            mode: 'per_visit',
            source: 'inferred',
            monthlyRate: null,
            prediction: { kind: 'invoice', amount: 129, conflictStampedPrice: false },
            unbilledGap: { reason: 'no_invoice_will_mint', noPaymentMethod: false },
          },
        }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/Nothing will bill for this visit/i)).toBeInTheDocument();
    expect(screen.getByText(/priced, but no invoice will be created/i)).toBeInTheDocument();
    // Not the "no rate is set" copy — a rate is not the problem here.
    expect(screen.queryByText(/No rate or price is set/i)).not.toBeInTheDocument();
  });
});

describe('MobileAppointmentDetailSheet sibling-covered first-application visit', () => {
  // Prod 2026-09-26: a per-application Silver customer accepted lawn
  // ($56.40/app) + pest ($97.20/app) into one reserved slot. The pest row's
  // invoice ($153.60) covered the trip; the lawn row was deliberately left
  // unpriced. The sheet showed $74.70 (monthlyRate/12 — meaningless here)
  // and warned "nothing will bill". Both are wrong: this pins the fix.
  const SIBLING_COVERED_SERVICE = {
    ...BASE_SERVICE,
    id: 'svc-lawn',
    serviceType: 'Every 6 Weeks Lawn Care',
    serviceTypeDisplay: 'Every 6 Weeks Lawn Care',
    waveguardTier: 'Silver',
    estimatedPrice: null,
    monthlyRate: 74.7,
    customerId: 'cust-1',
    billingLane: {
      mode: 'per_application',
      source: 'explicit',
      monthlyRate: 74.7,
      prediction: {
        kind: 'covered_sibling_invoice',
        amount: null,
        conflictStampedPrice: false,
        invoiceId: 'inv-1',
        invoiceNumber: 'WPC-2026-0505',
        invoiceStatus: 'sent',
        siblingServiceType: 'Quarterly Pest Control',
      },
      unbilledGap: null,
    },
  };

  it('reads "no charge — covered by invoice" instead of the money-gap warning', () => {
    render(<MobileAppointmentDetailSheet service={SIBLING_COVERED_SERVICE} onClose={() => {}} />);
    expect(screen.getByText(/no charge —.*WPC-2026-0505.*Quarterly Pest Control.*same trip/i)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing will bill for this visit/i)).not.toBeInTheDocument();
  });

  it('never previews the monthlyRate as this unpriced visit\'s price ($74.70 was the annual/12 equivalent, not a per-visit price)', () => {
    render(<MobileAppointmentDetailSheet service={SIBLING_COVERED_SERVICE} onClose={() => {}} />);
    expect(screen.queryByText(/\$74\.70/)).not.toBeInTheDocument();
    // Reads as covered, not as a $0.00 bill with no explanation.
    expect(screen.getAllByText(/Covered by invoice WPC-2026-0505/i).length).toBeGreaterThan(0);
  });

  // Codex pre-push P2: SIBLING_COVERED_SERVICE carries a real WaveGuard
  // tier (an established per_application member's combined same-day
  // accept) AND an unpriced row — exactly the shape the legacy
  // coveredByMembership heuristic (any tier + no price) also matches. The
  // authoritative server prediction (covered_sibling_invoice) must win: the
  // CTA area must say a sibling invoice covers it, never "Covered by
  // WaveGuard", or this sheet contradicts BillingLaneCard on the same
  // screen (both read the SAME prediction).
  it('prefers the sibling-invoice prediction over the tier heuristic in the CTA area', () => {
    render(<MobileAppointmentDetailSheet service={SIBLING_COVERED_SERVICE} onClose={() => {}} />);
    expect(screen.queryByText(/Covered by WaveGuard/i)).not.toBeInTheDocument();
    expect(
      screen.getByText(/Covered by invoice WPC-2026-0505 on the Quarterly Pest Control visit — no charge needed/i),
    ).toBeInTheDocument();
  });

  // Codex pre-push P1: a legacy customer with NO explicit billing_mode still
  // gets the monthlyRate fallback from the Charge Now mint endpoint's OWN
  // gate (resolveScheduledServiceCharge checks the RAW billing_mode column,
  // which is falsy here, not the inferred lane) — the preview must match
  // that, or it understates what completing/charging the visit will bill.
  it('keeps the monthlyRate fallback for an INFERRED (legacy, no explicit billing_mode) lane', () => {
    render(
      <MobileAppointmentDetailSheet
        service={{
          ...BASE_SERVICE,
          estimatedPrice: null,
          monthlyRate: 74.7,
          billingLane: {
            mode: 'per_visit',
            source: 'inferred',
            monthlyRate: 74.7,
            prediction: { kind: 'invoice', amount: 74.7, conflictStampedPrice: false },
          },
        }}
        onClose={() => {}}
      />,
    );
    expect(screen.getAllByText(/\$74\.70/).length).toBeGreaterThan(0);
  });

  it('does not fall back to monthlyRate for a non-monthly-membership lane even without sibling coverage', () => {
    render(
      <MobileAppointmentDetailSheet
        service={{
          ...BASE_SERVICE,
          estimatedPrice: null,
          monthlyRate: 74.7,
          billingLane: {
            mode: 'per_application',
            source: 'explicit',
            monthlyRate: 74.7,
            prediction: { kind: 'no_charge', amount: 0, conflictStampedPrice: false, reason: 'no_amount_on_file' },
            unbilledGap: { reason: 'no_amount_on_file', noPaymentMethod: true },
          },
        }}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByText(/\$74\.70/)).not.toBeInTheDocument();
  });

  // Codex pre-push P1: predictCompletionBilling already nets prepaidAmount
  // out of an 'invoice'/'auto_charge' prediction server-side. Comparing
  // service.prepaidAmount against that ALREADY-NET total a second time
  // misclassified a partially-prepaid visit as fully covered ($60 prepaid
  // on a $100 fee predicts $40 due; $60 >= $40 read as "covered"), hiding
  // the real $40 balance behind a $0.00 total and a disabled checkout.
  it('shows the real remaining balance on a partially-prepaid per-application visit, never a false "covered"', () => {
    render(
      <MobileAppointmentDetailSheet
        service={{
          ...BASE_SERVICE,
          estimatedPrice: null,
          // No WaveGuard tier — an untiered per-application customer, so
          // the unrelated coveredByMembership heuristic (any tier + no
          // price) doesn't mask the prepaidCovered case under test.
          waveguardTier: null,
          monthlyRate: 74.7,
          prepaidAmount: 60,
          prepaidMethod: 'cash',
          billingLane: {
            mode: 'per_application',
            source: 'explicit',
            monthlyRate: 74.7,
            prediction: { kind: 'invoice', amount: 40, conflictStampedPrice: false },
          },
        }}
        onClose={() => {}}
      />,
    );
    expect(screen.getAllByText(/\$40\.00/).length).toBeGreaterThan(0);
    // The real gap this pins: hasChargeableAmount (and so the checkout CTA)
    // must stay true for the remaining $40 — the double-netted bug flipped
    // this to the disabled "Review visit details" state instead.
    expect(screen.getByRole('button', { name: /Review & checkout/i })).toBeInTheDocument();
  });

  // Codex ROUND 2 P1: coveredByMembership used to come from `!!tier &&
  // (rawPrice === 0 || rawPrice == null)` — a tiered per_application
  // customer with an unpriced row and a real, positive invoice/auto_charge
  // prediction (the $97.20 acceptance-fee shape SchedulePage's own
  // billing-lane-amount test carries) satisfied that heuristic anyway,
  // because it never looked at the prediction at all. That zeroed the
  // displayed total, hid "Review & checkout," and claimed WaveGuard
  // coverage — although completion and the mint endpoint both bill the
  // fee. Membership coverage must come ONLY from
  // `prediction.kind === 'covered_membership'`.
  it('a tiered per_application customer with a positive acceptance-fee prediction bills the fee — never a false WaveGuard-covered $0', () => {
    render(
      <MobileAppointmentDetailSheet
        service={{
          ...BASE_SERVICE,
          estimatedPrice: null,
          waveguardTier: 'Silver',
          monthlyRate: 74.7,
          billingLane: {
            mode: 'per_application',
            source: 'explicit',
            monthlyRate: 74.7,
            prediction: { kind: 'invoice', amount: 97.2, grossAmount: 97.2, conflictStampedPrice: false },
          },
        }}
        onClose={() => {}}
      />,
    );
    expect(screen.getAllByText(/\$97\.20/).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Review & checkout/i })).toBeInTheDocument();
    expect(screen.queryByText(/Covered by WaveGuard/i)).not.toBeInTheDocument();
  });

  // A 'prepaid' kind means completion mints nothing new — its `amount` is
  // what was ALREADY collected (informational), never a balance still due.
  it('reads a fully-covered "prepaid" prediction as no new charge, not a bill for the prepaid figure', () => {
    render(
      <MobileAppointmentDetailSheet
        service={{
          ...BASE_SERVICE,
          estimatedPrice: null,
          waveguardTier: null,
          monthlyRate: 74.7,
          prepaidAmount: 100,
          prepaidMethod: 'cash',
          billingLane: {
            mode: 'per_application',
            source: 'explicit',
            monthlyRate: 74.7,
            prediction: { kind: 'prepaid', amount: 100, conflictStampedPrice: false },
          },
        }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /Review visit details/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Review & checkout/i })).not.toBeInTheDocument();
  });
});
