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
