// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  estimatedPrice: 115,
  scheduledDate: '2026-07-14',
  windowStart: '11:00:00',
  windowEnd: '12:00:00',
  estimatedDuration: 60,
  customerName: 'Pat Sample',
};

const ATTACHED_INVOICE_FIELDS = {
  checkoutInvoiceId: 'inv-1',
  checkoutInvoiceStatus: 'draft',
  checkoutInvoiceTotal: 214,
  checkoutInvoiceNumber: 'WPC-2099-0001',
  checkoutInvoiceLines: [
    { description: 'WaveGuard Membership — one-time setup fee', amount: 99 },
    { description: 'First service application', amount: 115 },
  ],
};

describe('MobileAppointmentDetailSheet invoice-on-file block', () => {
  it('routes a no-charge project visit with an open invoice through checkout', () => {
    const onCompleteService = vi.fn();
    const onReviewCheckout = vi.fn();
    render(
      <MobileAppointmentDetailSheet
        service={{
          ...BASE_SERVICE,
          ...ATTACHED_INVOICE_FIELDS,
          estimatedPrice: 0,
          completionProfile: { projectBacked: true },
          linkedProject: { id: 'project-1', status: 'draft' },
        }}
        onClose={() => {}}
        onCompleteService={onCompleteService}
        onReviewCheckout={onReviewCheckout}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Review & checkout' }));
    expect(onReviewCheckout).toHaveBeenCalledTimes(1);
    expect(onCompleteService).not.toHaveBeenCalled();
  });

  it('keeps checkout enabled after completion when an attached invoice is still open', () => {
    const onReviewCheckout = vi.fn();
    render(
      <MobileAppointmentDetailSheet
        service={{
          ...BASE_SERVICE,
          ...ATTACHED_INVOICE_FIELDS,
          status: 'completed',
          estimatedPrice: 0,
          completionProfile: { projectBacked: true },
          linkedProject: { id: 'project-1', status: 'closed' },
        }}
        onClose={() => {}}
        onReviewCheckout={onReviewCheckout}
      />,
    );

    const checkout = screen.getByRole('button', { name: 'Review & checkout' });
    expect(checkout).toBeEnabled();
    fireEvent.click(checkout);
    expect(onReviewCheckout).toHaveBeenCalledTimes(1);
  });

  it('shows the attached invoice breakdown under the visit total', () => {
    render(
      <MobileAppointmentDetailSheet
        service={{ ...BASE_SERVICE, ...ATTACHED_INVOICE_FIELDS }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/Invoice on file · WPC-2099-0001/)).toBeInTheDocument();
    expect(screen.getByText('$214.00')).toBeInTheDocument();
    expect(screen.getByText('WaveGuard Membership — one-time setup fee')).toBeInTheDocument();
    expect(screen.getByText('$99.00')).toBeInTheDocument();
    expect(screen.getByText('First service application')).toBeInTheDocument();
    expect(screen.getByText('Collected when the visit is completed.')).toBeInTheDocument();
    // The per-application visit price renders twice: the service row / visit
    // total stays as-is, and the invoice's first-application line matches it.
    expect(screen.getAllByText('$115.00').length).toBeGreaterThanOrEqual(2);
  });

  it('headlines the amount due and shows the credit row when account credit applies', () => {
    render(
      <MobileAppointmentDetailSheet
        service={{ ...BASE_SERVICE, ...ATTACHED_INVOICE_FIELDS, checkoutInvoiceCreditApplied: 50 }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('$164.00')).toBeInTheDocument();
    expect(screen.queryByText('$214.00')).not.toBeInTheDocument();
    expect(screen.getByText('Account credit applied')).toBeInTheDocument();
    expect(screen.getByText('−$50.00')).toBeInTheDocument();
  });

  it('marks a paid attached invoice as settled', () => {
    render(
      <MobileAppointmentDetailSheet
        service={{ ...BASE_SERVICE, ...ATTACHED_INVOICE_FIELDS, checkoutInvoiceStatus: 'paid' }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('Paid — nothing to collect at this visit.')).toBeInTheDocument();
  });

  it('renders no invoice block when the visit has no attached invoice', () => {
    render(<MobileAppointmentDetailSheet service={BASE_SERVICE} onClose={() => {}} />);
    expect(screen.queryByText(/Invoice on file/)).not.toBeInTheDocument();
  });

  it('suppresses the invoice block for payer-billed visits', () => {
    render(
      <MobileAppointmentDetailSheet
        service={{
          ...BASE_SERVICE,
          ...ATTACHED_INVOICE_FIELDS,
          billedToPayer: { id: 'payer-1', name: 'HOA Management' },
        }}
        onClose={() => {}}
      />,
    );
    // The invoice routes to the payer's AP inbox — "collected at the visit"
    // wording would send the tech after the homeowner.
    expect(screen.queryByText(/Invoice on file/)).not.toBeInTheDocument();
  });

  it('suppresses the block when the invoice itself is payer-billed, but not for a raw inactive payerId', () => {
    render(
      <MobileAppointmentDetailSheet
        service={{ ...BASE_SERVICE, ...ATTACHED_INVOICE_FIELDS, checkoutInvoicePayerBilled: true }}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByText(/Invoice on file/)).not.toBeInTheDocument();
    cleanup();
    // Inactive per-job payer resolves self-pay — the invoice IS the visit's
    // collectible and stays visible.
    render(
      <MobileAppointmentDetailSheet
        service={{ ...BASE_SERVICE, ...ATTACHED_INVOICE_FIELDS, payerId: 'payer-inactive' }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/Invoice on file · WPC-2099-0001/)).toBeInTheDocument();
  });
});
