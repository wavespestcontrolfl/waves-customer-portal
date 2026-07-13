// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MobileCheckoutSheet from './MobileCheckoutSheet';

vi.mock('./MobileServicePickerSheet', () => ({ default: () => null }));
vi.mock('./MobileItemDiscountPickerSheet', () => ({ default: () => null }));
vi.mock('../../hooks/useCustomerCards', () => ({
  // null = unknown → the card-on-file note renders nothing.
  useCustomerCards: () => ({ cards: null }),
  chargeableCardOnFile: () => null,
  cardOnFileTitle: () => '',
  isCardExpired: () => false,
}));

afterEach(cleanup);

const BASE_SERVICE = {
  id: 'svc-1',
  serviceType: 'Quarterly Pest Control',
  serviceTypeDisplay: 'Quarterly Pest Control',
  waveguardTier: 'Bronze',
  estimatedPrice: 115,
  windowStart: '11:00:00',
  estimatedDuration: 60,
};

const ATTACHED_INVOICE_FIELDS = {
  checkoutInvoiceId: 'inv-1',
  checkoutInvoiceStatus: 'draft',
  checkoutInvoiceTotal: 214,
  checkoutInvoiceNumber: 'WPC-2026-0262',
  checkoutInvoiceLines: [
    { description: 'WaveGuard Membership — one-time setup fee', amount: 99 },
    { description: 'First service application', amount: 115 },
  ],
};

describe('MobileCheckoutSheet attached-invoice preview', () => {
  it('previews the attached invoice total and lines, not the per-application price', () => {
    render(
      <MobileCheckoutSheet
        service={{ ...BASE_SERVICE, ...ATTACHED_INVOICE_FIELDS }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Charge $214.00' })).toBeInTheDocument();
    expect(screen.getByText('WaveGuard Membership — one-time setup fee')).toBeInTheDocument();
    expect(screen.getByText('$99.00')).toBeInTheDocument();
    expect(screen.getByText('First service application')).toBeInTheDocument();
    expect(screen.getByText('$115.00')).toBeInTheDocument();
    expect(screen.getByText(/Invoice on file · WPC-2026-0262/)).toBeInTheDocument();
    // The mint endpoint reuses the invoice and ignores extras — the pickers
    // must not be offered.
    expect(screen.queryByRole('button', { name: 'Add Service' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add Item or Discount' })).not.toBeInTheDocument();
    expect(screen.getByText(/Charging collects this invoice as-is/)).toBeInTheDocument();
  });

  it('keeps the per-application preview and add buttons when no invoice is attached', () => {
    render(<MobileCheckoutSheet service={BASE_SERVICE} onClose={() => {}} />);
    expect(screen.getByRole('button', { name: 'Charge $115.00' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Service' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Item or Discount' })).toBeInTheDocument();
    expect(screen.queryByText(/Invoice on file/)).not.toBeInTheDocument();
  });

  it('falls back to the standard preview when the attached invoice is already settled', () => {
    render(
      <MobileCheckoutSheet
        service={{ ...BASE_SERVICE, ...ATTACHED_INVOICE_FIELDS, checkoutInvoiceStatus: 'paid' }}
        onClose={() => {}}
      />,
    );
    // The server's Charge-now reuse path reports settled invoices as
    // alreadyPaid; the preview stays on the visit price and the add buttons
    // remain (they still apply if the office voids/replaces the invoice).
    expect(screen.getByRole('button', { name: 'Charge $115.00' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Service' })).toBeInTheDocument();
  });

  it('applies prepaid credit against the attached invoice total', () => {
    render(
      <MobileCheckoutSheet
        service={{ ...BASE_SERVICE, ...ATTACHED_INVOICE_FIELDS, prepaidAmount: 100 }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Charge $114.00' })).toBeInTheDocument();
    expect(screen.getByText('Prepaid credit')).toBeInTheDocument();
  });
});
