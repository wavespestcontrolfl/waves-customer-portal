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

  it('renders nothing extra when the payload has no billingLane (older cached payloads)', () => {
    render(<MobileAppointmentDetailSheet service={BASE_SERVICE} onClose={() => {}} />);
    expect(screen.queryByText(/Monthly membership/)).not.toBeInTheDocument();
    expect(screen.queryByText(/On completion:/)).not.toBeInTheDocument();
  });
});
