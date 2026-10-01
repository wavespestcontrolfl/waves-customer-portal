// @vitest-environment jsdom
//
// Codex round-7 P1: a covered_sibling_invoice prediction never mints a
// second invoice for THIS visit's base fee (the sibling's own invoice
// already covers the trip) — but the generic "No charge — complete from
// job" copy read exactly the same whether that sibling invoice was
// genuinely settled OR still draft/sent/overdue and collectible elsewhere.
// These pin the settled/collectible split on the Charge button's own copy;
// the collectible case fails on the pre-fix code (no covered_sibling_invoice
// branch existed here at all — every case fell through to the generic
// "No charge — complete from job").
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MobileCheckoutSheet from './MobileCheckoutSheet';

vi.mock('./MobileItemDiscountPickerSheet', () => ({ default: () => null }));
vi.mock('./MobileServicePickerSheet', () => ({ default: () => null }));
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

// `state`/`amountDue` mirror the server's own canonical
// `billingLane.siblingCoverage` verdict (billing-lane.js
// siblingCoverageForSchedule) — the component renders THAT, never a raw
// invoiceStatus, per the owner's narrow + fail closed decision.
function siblingService(state, amountDue = 153.6) {
  return {
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
        kind: 'covered_sibling_invoice',
        amount: null,
        conflictStampedPrice: false,
        invoiceId: 'inv-1',
        invoiceNumber: 'WPC-TEST-0001',
        siblingServiceType: 'Quarterly Pest Control',
      },
      siblingCoverage: {
        state,
        invoiceId: 'inv-1',
        invoiceNumber: 'WPC-TEST-0001',
        amountDue: state === 'collect_on_combined_invoice' ? amountDue : 0,
        reason: state === 'settled' ? 'invoice_settled' : null,
      },
    },
  };
}

describe('MobileCheckoutSheet sibling-covered visit', () => {
  it('a settled (paid) sibling invoice reads as the ordinary no-charge state', () => {
    render(<MobileCheckoutSheet service={siblingService('settled')} onClose={() => {}} />);
    expect(screen.getByRole('button', { name: 'No charge — complete from job' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Combined trip invoice due/i })).not.toBeInTheDocument();
  });

  it('a collectible (overdue) sibling invoice says so instead of the ordinary no-charge state', () => {
    render(<MobileCheckoutSheet service={siblingService('collect_on_combined_invoice')} onClose={() => {}} />);
    expect(screen.getByRole('button', { name: /Combined trip invoice due — collect there, not here/i })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'No charge — complete from job' })).not.toBeInTheDocument();
  });
});
