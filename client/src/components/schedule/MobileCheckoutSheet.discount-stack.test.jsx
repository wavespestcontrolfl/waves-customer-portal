// @vitest-environment jsdom
//
// Checkout discounts stack the way the mint endpoint totals them (owner
// ruling 2026-09-11): fixed credits first, then percentages compounding on
// what is left — never each percentage off the full services subtotal.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MobileCheckoutSheet from './MobileCheckoutSheet';

// GATE_DISCOUNT_STACKING, as the sheet sees it.
const stacking = vi.hoisted(() => ({ enabled: true }));
vi.mock('../../hooks/useDiscountStacking', () => ({
  useDiscountStacking: () => stacking.enabled,
}));

const SILVER = {
  id: 'silver', name: 'WaveGuard Silver', discount_type: 'percentage', amount: 10,
  stack_group: 'tier', is_stackable: false, is_waveguard_tier_discount: true,
};
const MILITARY = {
  id: 'military', name: 'Military Discount', discount_type: 'percentage', amount: 5,
  is_stackable: true,
};
const REFERRAL = {
  id: 'referral', name: 'Referral Credit', discount_type: 'fixed_amount', amount: 25,
  is_stackable: true,
};

// Stand-in picker: one button per discount, each calling onSelect the way
// the real sheet does.
vi.mock('./MobileItemDiscountPickerSheet', () => ({
  default: ({ onSelect, chosenDiscounts = [] }) => (
    <div>
      <div data-testid="chosen-count">{chosenDiscounts.length}</div>
      {[SILVER, MILITARY, REFERRAL].map((d) => (
        <button key={d.id} type="button" onClick={() => onSelect({ kind: 'discount', discount: d })}>
          {`pick ${d.name}`}
        </button>
      ))}
    </div>
  ),
}));
vi.mock('./MobileServicePickerSheet', () => ({ default: () => null }));
vi.mock('../../hooks/useCustomerCards', () => ({
  useCustomerCards: () => ({ cards: null }),
  chargeableCardOnFile: () => null,
  cardOnFileTitle: () => '',
  isCardExpired: () => false,
}));

afterEach(cleanup);
beforeEach(() => { stacking.enabled = true; });

const SERVICE = {
  id: 'svc-1',
  serviceType: 'Quarterly Pest Control',
  serviceTypeDisplay: 'Quarterly Pest Control',
  waveguardTier: 'Silver',
  estimatedPrice: 111,
  windowStart: '11:00:00',
  estimatedDuration: 60,
};

function addDiscount(name) {
  fireEvent.click(screen.getByRole('button', { name: 'Add Item or Discount' }));
  fireEvent.click(screen.getByRole('button', { name: `pick ${name}` }));
}

describe('MobileCheckoutSheet discount stacking', () => {
  it('compounds a second percentage on what is left — $111 less 10% then 5% is $94.90', () => {
    render(<MobileCheckoutSheet service={SERVICE} onClose={() => {}} />);
    addDiscount('WaveGuard Silver');
    expect(screen.getByRole('button', { name: 'Charge $99.90' })).toBeInTheDocument();

    addDiscount('Military Discount');
    // 5% of the remaining $99.90 = $5.00, not 5% of $111 ($5.55).
    expect(screen.getByText('−$11.10')).toBeInTheDocument();
    expect(screen.getByText('−$5.00')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Charge $94.90' })).toBeInTheDocument();
  });

  it('takes a dollar credit before the percentage', () => {
    render(<MobileCheckoutSheet service={SERVICE} onClose={() => {}} />);
    addDiscount('WaveGuard Silver');
    addDiscount('Referral Credit');
    // $25 off first, then 10% of the remaining $86 = $8.60.
    expect(screen.getByText('−$25.00')).toBeInTheDocument();
    expect(screen.getByText('−$8.60')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Charge $77.40' })).toBeInTheDocument();
  });

  it('re-derives every row when the base changes, so rows never go stale', () => {
    render(<MobileCheckoutSheet service={SERVICE} onClose={() => {}} />);
    addDiscount('WaveGuard Silver');
    addDiscount('Military Discount');
    // Removing the first discount restates the second against the full base.
    fireEvent.click(screen.getByRole('button', { name: 'Remove WaveGuard Silver (10%)' }));
    expect(screen.getByText('−$5.55')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Charge $105.45' })).toBeInTheDocument();
  });

  it('hands the picker what is already chosen so it can hide the other tiers', () => {
    render(<MobileCheckoutSheet service={SERVICE} onClose={() => {}} />);
    addDiscount('WaveGuard Silver');
    fireEvent.click(screen.getByRole('button', { name: 'Add Item or Discount' }));
    expect(screen.getByTestId('chosen-count')).toHaveTextContent('1');
  });
});

describe('MobileCheckoutSheet with stacking dark', () => {
  beforeEach(() => { stacking.enabled = false; });

  it('resolves each discount against the full base, as before the lane', () => {
    render(<MobileCheckoutSheet service={SERVICE} onClose={() => {}} />);
    addDiscount('WaveGuard Silver');
    addDiscount('Military Discount');
    // 10% and 5% BOTH off $111 — the additive $16.65 the mint endpoint
    // still stores while the gate is off.
    expect(screen.getByText('−$11.10')).toBeInTheDocument();
    expect(screen.getByText('−$5.55')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Charge $94.35' })).toBeInTheDocument();
  });

  it('does not tell the picker what is chosen, so no tier is hidden', () => {
    render(<MobileCheckoutSheet service={SERVICE} onClose={() => {}} />);
    addDiscount('WaveGuard Silver');
    fireEvent.click(screen.getByRole('button', { name: 'Add Item or Discount' }));
    expect(screen.getByTestId('chosen-count')).toHaveTextContent('0');
  });
});
