// @vitest-environment jsdom
//
// Codex round 5 P2: this visit's combined-trip sibling invoice needs manual
// review (billing-lane.js siblingCoverageForSchedule — a refunded/
// terminal match, or the lookup itself failing) — the mint resolver
// (resolveScheduledServiceCharge, admin-schedule.js) refuses to charge
// ANYTHING for it, base or extras, with a retryable 409. This sheet must
// never offer Charge for that prediction kind, even after an operator
// stacks a positive checkout extra on top of the (already $0) base — the
// base alone previewing $0 must not let a positive extraServicesTotal turn
// `nothingToCharge` false.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MobileCheckoutSheet from './MobileCheckoutSheet';

vi.mock('./MobileItemDiscountPickerSheet', () => ({ default: () => null }));
vi.mock('./MobileServicePickerSheet', () => ({
  default: ({ onSelect }) => (
    <button type="button" onClick={() => onSelect({ name: 'Extra Treatment', base_price: 40, pricing_type: 'fixed' })}>
      pick Extra Treatment
    </button>
  ),
}));
vi.mock('../../hooks/useCustomerCards', () => ({
  useCustomerCards: () => ({ cards: null }),
  chargeableCardOnFile: () => null,
  cardOnFileTitle: () => '',
  isCardExpired: () => false,
}));
vi.mock('../../hooks/useDiscountStacking', () => ({
  useDiscountStackingState: () => ({ enabled: false, known: true, retry: vi.fn() }),
}));

afterEach(cleanup);

const NEEDS_REVIEW_SERVICE = {
  id: 'svc-lawn',
  serviceType: 'Every 6 Weeks Lawn Care',
  serviceTypeDisplay: 'Every 6 Weeks Lawn Care',
  waveguardTier: 'Silver',
  estimatedPrice: null,
  windowStart: '11:00:00',
  estimatedDuration: 60,
  billingLane: {
    mode: 'per_application',
    prediction: {
      kind: 'sibling_needs_review',
      amount: null,
      conflictStampedPrice: false,
      invoiceId: 'inv-1',
      invoiceNumber: 'WPC-TEST-0001',
    },
    // The server's own canonical verdict (billing-lane.js
    // siblingCoverageForSchedule) — this sheet renders THAT, never a raw
    // invoiceStatus.
    siblingCoverage: {
      state: 'review',
      invoiceId: 'inv-1',
      invoiceNumber: 'WPC-TEST-0001',
      amountDue: null,
      reason: 'terminal_invoice',
    },
  },
};

function addService() {
  fireEvent.click(screen.getByRole('button', { name: 'Add Service' }));
  fireEvent.click(screen.getByRole('button', { name: 'pick Extra Treatment' }));
}

describe('MobileCheckoutSheet sibling invoice needs-review', () => {
  it('disables Charge for the unpriced base, pointing to Customer 360', () => {
    render(<MobileCheckoutSheet service={NEEDS_REVIEW_SERVICE} onClose={() => {}} />);
    expect(screen.getByRole('button', { name: /Needs review on Customer 360/i })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /^Charge \$/ })).not.toBeInTheDocument();
  });

  it('keeps Charge disabled even after a positive checkout extra is stacked on top', () => {
    render(<MobileCheckoutSheet service={NEEDS_REVIEW_SERVICE} onClose={() => {}} />);
    addService();
    // The extra shows in the line items, but the resolver would still
    // refuse the WHOLE mint (base + extras) — Charge must stay disabled
    // and never read a "Charge $40.00" total.
    expect(screen.getByText('Extra Treatment')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Needs review on Customer 360/i })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /^Charge \$/ })).not.toBeInTheDocument();
  });
});
