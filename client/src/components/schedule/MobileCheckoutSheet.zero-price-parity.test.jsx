// @vitest-environment jsdom
//
// Codex pre-push P1 (original finding, since superseded — see the owner
// ruling below): MobileCheckoutSheet read `rawPrice != null` as "this visit
// has its own authoritative price" — true for a stamped 0, since `0 !=
// null`. That let a $0 estimatedPrice win over the server's own
// billingLane.prediction fallback.
//
// Owner ruling — REMOVE THE CHARGE NOW FEE FALLBACK (2026-09-27): Charge Now
// must never bill an unpriced visit from the customer-level
// per_application_fee — only completion still does (predictCompletionBilling
// is completion's own prediction, unaffected; it still returns the fee as
// grossAmount so completion's OWN preview elsewhere stays accurate).
// resolveScheduledServiceCharge (server/routes/admin-schedule.js) no longer
// honors this fee at all, so the checkout sheet must not preview it either
// — this file's first describe block, which used to pin the fee winning
// over a stamped $0 (parity with the OLD mint behavior), now pins the
// OPPOSITE: no charge amount for the base, with the fee-based prediction
// ignored entirely; a checkout extra is still fully chargeable on its own
// (see server/tests/prepaid-receipt-gate.test.js's "completion still
// predicts the acceptance fee; Charge Now no longer mints it" for the
// server-side half of this same divergence).
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

describe('MobileCheckoutSheet — estimatedPrice: 0 under the removed per_application fee fallback', () => {
  // Owner ruling — REMOVE THE CHARGE NOW FEE FALLBACK: this used to pin the
  // fee winning as the previewed base. Charge Now no longer mints that fee
  // at all, so the sheet must not preview it — "No charge — complete from
  // job" (the same generic nothing-to-charge copy every other $0 visit
  // shows), never a "Charge $97.20" button the server would then 400.
  it('previews no charge — never the acceptance fee — with no extras added', () => {
    render(<MobileCheckoutSheet service={ZERO_PRICE_FEE_FALLBACK_SERVICE} onClose={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Charge $97.20' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'No charge — complete from job' })).toBeDisabled();
  });

  // A checkout extra is still fully chargeable on its own — "nothing else
  // to charge" only refused the base (the removed fee), never a genuine
  // extra riding on top of it. $40 only, never $137.20 (fee + extra).
  it('the checkout extra alone is chargeable — never stacked on the removed fee', () => {
    render(<MobileCheckoutSheet service={ZERO_PRICE_FEE_FALLBACK_SERVICE} onClose={() => {}} />);
    addCheckoutExtra();
    expect(screen.getByRole('button', { name: 'Charge $40.00' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Charge $137.20' })).not.toBeInTheDocument();
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
