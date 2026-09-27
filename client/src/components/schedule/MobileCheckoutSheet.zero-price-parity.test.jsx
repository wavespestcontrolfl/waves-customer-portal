// @vitest-environment jsdom
//
// Codex pre-push P1: MobileCheckoutSheet read `rawPrice != null` as "this
// visit has its own authoritative price" — true for a stamped 0, since
// `0 != null`. That let a $0 estimatedPrice win over the server's own
// billingLane.prediction fallback (the same fee/rate completionInvoiceAmount
// and resolveScheduledServiceCharge, server/services/billing-lane.js +
// server/routes/admin-schedule.js, would fall back to). Fixture from the
// finding: estimatedPrice: 0, a $97.20 per-application acceptance fee, plus
// a $40 checkout extra — the sheet previewed $40 (extra only) while the mint
// endpoint would create $137.20 (fee + extra). This pins the fix and the
// preview/mint parity: both now agree on $137.20 for the same fixture (see
// server/tests/prepaid-receipt-gate.test.js for the server-side half of the
// parity check, run against predictCompletionBilling +
// resolveScheduledServiceCharge directly).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MobileCheckoutSheet from './MobileCheckoutSheet';

vi.mock('./MobileItemDiscountPickerSheet', () => ({ default: () => null }));
vi.mock('./MobileServicePickerSheet', () => ({
  default: ({ onSelect }) => (
    <button type="button" onClick={() => onSelect({ name: 'Checkout Extra', base_price: 40, pricing_type: 'fixed' })}>
      pick Checkout Extra
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

function addCheckoutExtra() {
  fireEvent.click(screen.getByRole('button', { name: 'Add Service' }));
  fireEvent.click(screen.getByRole('button', { name: 'pick Checkout Extra' }));
}

const ZERO_PRICE_FEE_FALLBACK_SERVICE = {
  id: 'svc-1',
  serviceType: 'Quarterly Pest Control',
  serviceTypeDisplay: 'Quarterly Pest Control',
  waveguardTier: 'Bronze',
  // The exact bug shape: a stamped 0, not an absent price.
  estimatedPrice: 0,
  windowStart: '11:00:00',
  estimatedDuration: 60,
  billingLane: {
    mode: 'per_application',
    source: 'explicit',
    monthlyRate: null,
    prediction: { kind: 'invoice', amount: 97.2, grossAmount: 97.2, conflictStampedPrice: false },
  },
};

describe('MobileCheckoutSheet — estimatedPrice: 0 defers to the fee prediction', () => {
  it('previews the acceptance fee, never $0, with no extras added', () => {
    render(<MobileCheckoutSheet service={ZERO_PRICE_FEE_FALLBACK_SERVICE} onClose={() => {}} />);
    expect(screen.getByRole('button', { name: 'Charge $97.20' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Charge $0.00' })).not.toBeInTheDocument();
  });

  // The finding's exact fixture: estimatedPrice 0 + a $97.20 fee + a $40
  // checkout extra. Before the fix, this previewed "Charge $40.00" (the
  // extra alone, since rawPrice 0 won as the "own price" base) while the
  // mint endpoint would have created a $137.20 invoice (fee + extra).
  it('stacks the checkout extra on top of the fee, never on top of a false $0 base', () => {
    render(<MobileCheckoutSheet service={ZERO_PRICE_FEE_FALLBACK_SERVICE} onClose={() => {}} />);
    addCheckoutExtra();
    expect(screen.getByRole('button', { name: 'Charge $137.20' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Charge $40.00' })).not.toBeInTheDocument();
  });
});

// Codex round 4 P2: the SAME unpriced per-application prediction, but for a
// third-party payer. `price` still falls through to the predicted fee (as
// above), making this sheet preview a positive, seemingly-chargeable total
// — but the payer's AR is the payer's AP inbox, never in-person collection,
// and the mint endpoint's payer guard refuses this outright. nothingToCharge
// must disable Charge for it exactly like a genuinely $0 visit does.
describe('MobileCheckoutSheet — a payer-billed prediction never offers to collect the predicted fee', () => {
  const PAYER_PREDICTION_SERVICE = {
    id: 'svc-payer-1',
    serviceType: 'Quarterly Pest Control',
    serviceTypeDisplay: 'Quarterly Pest Control',
    estimatedPrice: null,
    windowStart: '11:00:00',
    estimatedDuration: 60,
    billingLane: {
      mode: 'per_application',
      source: 'explicit',
      monthlyRate: null,
      prediction: { kind: 'payer', amount: 97.2, conflictStampedPrice: false },
    },
  };

  it('disables Charge for an unpriced payer prediction, never offering the predicted fee', () => {
    render(<MobileCheckoutSheet service={PAYER_PREDICTION_SERVICE} onClose={() => {}} />);
    expect(screen.queryByRole('button', { name: /^Charge \$97\.20$/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'No charge — complete from job' })).toBeDisabled();
  });

  it('disables Charge via the resolved billedToPayer stamp alone, even with an invoice-kind prediction', () => {
    render(
      <MobileCheckoutSheet
        service={{ ...PAYER_PREDICTION_SERVICE, billedToPayer: true,
          billingLane: { ...PAYER_PREDICTION_SERVICE.billingLane, prediction: { kind: 'invoice', amount: 97.2, conflictStampedPrice: false } } }}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: /^Charge \$97\.20$/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'No charge — complete from job' })).toBeDisabled();
  });
});
