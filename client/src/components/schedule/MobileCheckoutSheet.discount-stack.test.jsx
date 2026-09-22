// @vitest-environment jsdom
//
// Checkout discounts stack the way the mint endpoint totals them (owner
// ruling 2026-09-11): fixed credits first, then percentages compounding on
// what is left — never each percentage off the full services subtotal.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MobileCheckoutSheet from './MobileCheckoutSheet';

// GATE_DISCOUNT_STACKING, as the sheet sees it.
const stacking = vi.hoisted(() => ({ enabled: true, known: true, retry: vi.fn() }));
vi.mock('../../hooks/useDiscountStacking', () => ({
  useDiscountStackingState: () => ({ enabled: stacking.enabled, known: stacking.known, retry: stacking.retry }),
  // Real contract: always issues a live probe (never trusts the render-time
  // snapshot) and returns { enabled, known }. Charge's submit-time
  // revalidation awaits this directly.
  ensureStackingFresh: () => Promise.resolve({ enabled: stacking.enabled, known: stacking.known }),
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
// Deliberately IDENTICAL on every canonical-order key (type, value, cap,
// scope) except catalog id — the only thing left to break the tie.
const PROMO_A = {
  id: 'promo-a', name: 'Promo A', discount_type: 'percentage', amount: 50,
  is_stackable: true,
};
const PROMO_B = {
  id: 'promo-b', name: 'Promo B', discount_type: 'percentage', amount: 50,
  is_stackable: true,
};

// Stand-in picker: one button per discount, each calling onSelect the way
// the real sheet does.
vi.mock('./MobileItemDiscountPickerSheet', () => ({
  default: ({ onSelect, chosenDiscounts = [] }) => (
    <div>
      <div data-testid="chosen-count">{chosenDiscounts.length}</div>
      {[SILVER, MILITARY, REFERRAL, PROMO_A, PROMO_B].map((d) => (
        <button key={d.id} type="button" onClick={() => onSelect({ kind: 'discount', discount: d })}>
          {`pick ${d.name}`}
        </button>
      ))}
    </div>
  ),
}));
vi.mock('./MobileServicePickerSheet', () => ({
  default: ({ onSelect }) => (
    <button type="button" onClick={() => onSelect({ name: 'Extra Treatment', base_price: 100, pricing_type: 'fixed' })}>
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

afterEach(cleanup);
beforeEach(() => { stacking.enabled = true; stacking.known = true; stacking.retry.mockClear(); });

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

function addService() {
  fireEvent.click(screen.getByRole('button', { name: 'Add Service' }));
  fireEvent.click(screen.getByRole('button', { name: 'pick Extra Treatment' }));
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

// Codex #4405 P1: if the stacking probe fails while the server gate is ON,
// this sheet must not let a tech charge two discounts on the previewed
// additive math while /admin/schedule/:id/invoice compounds — block until
// the probe is authoritative (known:true), regardless of what `enabled`
// last read.
describe('MobileCheckoutSheet with the stacking probe unconfirmed', () => {
  beforeEach(() => { stacking.known = false; });

  it('a single discount is unaffected — nothing to stack against yet', () => {
    render(<MobileCheckoutSheet service={SERVICE} onClose={() => {}} />);
    addDiscount('WaveGuard Silver');
    expect(screen.getByRole('button', { name: 'Charge $99.90' })).toBeEnabled();
    expect(screen.queryByText(/Could not confirm how multiple discounts combine/)).not.toBeInTheDocument();
  });

  it('a second discount in play blocks Charge until the probe resolves, with a Retry', () => {
    render(<MobileCheckoutSheet service={SERVICE} onClose={() => {}} />);
    addDiscount('WaveGuard Silver');
    addDiscount('Military Discount');
    const chargeButton = screen.getByRole('button', { name: 'Confirm discount stacking to charge' });
    expect(chargeButton).toBeDisabled();
    expect(screen.getByText(/Could not confirm how multiple discounts combine/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(stacking.retry).toHaveBeenCalledTimes(1);
  });
});

// Codex pre-push audit P1 (slice 9 scope extension): mirrors the server
// pattern #4655 already shipped for InvoiceService.create /
// calculateUpdateFinancials — a client that previewed under one gate regime
// must bind that CONFIRMED regime to the write itself, not just to its own
// disabled-Charge guard, so the server (server/routes/admin-schedule.js) can
// refuse a mismatch with a retryable 409 instead of silently minting the
// other regime's total.
describe('MobileCheckoutSheet — expected_discount_stacking on the wire', () => {
  let fetchMock;
  beforeEach(() => {
    fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ invoiceId: 'inv-1', token: 'tok-1', total: 94.90 }),
    }));
    vi.stubGlobal('fetch', fetchMock);
  });

  it('sends the confirmed gate state when the charge carries 2+ discounts', async () => {
    render(<MobileCheckoutSheet service={SERVICE} onClose={() => {}} />);
    addDiscount('WaveGuard Silver');
    addDiscount('Military Discount');
    fireEvent.click(screen.getByRole('button', { name: 'Charge $94.90' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.expected_discount_stacking).toBe(true);
  });

  it('omits expected_discount_stacking for a single discount — compounding cannot change that total', async () => {
    render(<MobileCheckoutSheet service={SERVICE} onClose={() => {}} />);
    addDiscount('WaveGuard Silver');
    fireEvent.click(screen.getByRole('button', { name: 'Charge $99.90' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body);
    expect('expected_discount_stacking' in body).toBe(false);
  });

  it('omits expected_discount_stacking when no discounts are on the sheet at all', async () => {
    render(<MobileCheckoutSheet service={SERVICE} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Charge $111.00' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body);
    expect('expected_discount_stacking' in body).toBe(false);
  });

  it('sends false (not omitted) when the confirmed gate is off with 2+ discounts', async () => {
    stacking.enabled = false;
    render(<MobileCheckoutSheet service={SERVICE} onClose={() => {}} />);
    addDiscount('WaveGuard Silver');
    addDiscount('Military Discount');
    fireEvent.click(screen.getByRole('button', { name: 'Charge $94.35' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.expected_discount_stacking).toBe(false);
  });
});

// Codex GitHub review round 1 on PR #4658, P1 (MobileCheckoutSheet.jsx:125):
// gate dark (or its probe unresolved — stackingEnabled already fails closed
// to false) must stay BYTE-IDENTICAL to before this lane: a percentage
// discount's dollar amount is snapshotted at selection (handleAddItem) and
// never recomputed as services are added/removed afterward. Only the
// gate-ON path re-derives live through the shared engine.
describe('MobileCheckoutSheet — snapshot vs. live recompute by gate state', () => {
  it('gate off: a picked percentage stays at its selection-time amount when a service is added after', () => {
    stacking.enabled = false;
    render(<MobileCheckoutSheet service={SERVICE} onClose={() => {}} />);
    addDiscount('WaveGuard Silver');
    // 10% of the $111 base at selection time.
    expect(screen.getByText('−$11.10')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Charge $99.90' })).toBeInTheDocument();

    addService();
    // Adding a $100 service moves the base to $211 — a live recompute
    // would show $21.10 off; the snapshot must still read $11.10.
    expect(screen.getByText('−$11.10')).toBeInTheDocument();
    expect(screen.queryByText('−$21.10')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Charge $199.90' })).toBeInTheDocument();
  });

  it('gate on: the same sequence re-derives live through the engine', () => {
    render(<MobileCheckoutSheet service={SERVICE} onClose={() => {}} />);
    addDiscount('WaveGuard Silver');
    expect(screen.getByRole('button', { name: 'Charge $99.90' })).toBeInTheDocument();

    addService();
    // Live recompute: 10% of the new $211 base is $21.10.
    expect(screen.getByText('−$21.10')).toBeInTheDocument();
    expect(screen.queryByText('−$11.10')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Charge $189.90' })).toBeInTheDocument();
  });
});

// Codex GitHub review round 1 on PR #4658, P2 (MobileCheckoutSheet.jsx:123):
// two catalog discounts tying on type/value/cap/scope must resolve the
// same regardless of click order — stackOrder's stable identity tiebreak
// only applies when the catalog id/key rides along on each term.
describe('MobileCheckoutSheet — stable identity tiebreak survives click order', () => {
  // The amount div sits as the description's next sibling within the same
  // row (see the extras.map render block) — read the row's OWN amount
  // rather than merely asserting the {$50, $25} pair appears SOMEWHERE
  // on screen, which can't tell the two rows apart.
  function rowAmount(description) {
    return screen.getByText(description).closest('.flex-1').nextElementSibling.textContent;
  }

  it('Promo A before Promo B: A (lower id) gets the larger resolved share', () => {
    render(<MobileCheckoutSheet service={{ ...SERVICE, estimatedPrice: 100 }} onClose={() => {}} />);
    addDiscount('Promo A');
    addDiscount('Promo B');
    // Identity order (promo-a < promo-b) puts A first: 50% of $100, then
    // B takes 50% of what's left.
    expect(rowAmount('Promo A (50%)')).toBe('−$50.00');
    expect(rowAmount('Promo B (50%)')).toBe('−$25.00');
  });

  it('Promo B before Promo A (reversed click order): A still gets the larger share', () => {
    render(<MobileCheckoutSheet service={{ ...SERVICE, estimatedPrice: 100 }} onClose={() => {}} />);
    addDiscount('Promo B');
    addDiscount('Promo A');
    // Click order reversed, but catalog identity is unchanged — the row
    // that gets the $50 vs. the $25 must match the un-reversed case
    // exactly: A (lower id) always first, regardless of which was clicked
    // first.
    expect(rowAmount('Promo A (50%)')).toBe('−$50.00');
    expect(rowAmount('Promo B (50%)')).toBe('−$25.00');
  });
});

// Codex GitHub review round 2 on PR #4658, P1 (MobileCheckoutSheet.jsx:270):
// the selection-time snapshot (posted verbatim while the gate is off, per
// round 1's fix) must be cent-exact, matching the server's own cap-check —
// not the plain-float formula that rounds 5% of $20.70 down to $1.03.
describe('MobileCheckoutSheet — cent-exact selection-time snapshot', () => {
  it('gate off: 5% of $20.70 snapshots at the cent-exact $1.04, never the float-rounded $1.03', () => {
    stacking.enabled = false;
    render(<MobileCheckoutSheet service={{ ...SERVICE, estimatedPrice: 20.70 }} onClose={() => {}} />);
    addDiscount('Military Discount');
    expect(screen.getByText('−$1.04')).toBeInTheDocument();
    expect(screen.queryByText('−$1.03')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Charge $19.66' })).toBeInTheDocument();
  });
});

// Codex GitHub review round 2 on PR #4658, P2 (MobileCheckoutSheet.jsx:128):
// a percentage discount picked while the base is $0 (a free callback, before
// any paid service is added) must not be dropped from the live stack once a
// paid service arrives — selection is by _kind, never by the provisional
// (possibly -0) dollar amount stamped at add-time.
describe('MobileCheckoutSheet — zero-base discount survives a later paid service', () => {
  it('gate on: a percentage picked at $0 recomputes once a paid service is added, not dropped', () => {
    render(<MobileCheckoutSheet service={{ ...SERVICE, estimatedPrice: 0 }} onClose={() => {}} />);
    addDiscount('WaveGuard Silver');
    // Nothing to stack against yet — $0 base, $0 off, nothing chargeable.
    expect(screen.getByRole('button', { name: 'No charge — complete from job' })).toBeInTheDocument();

    addService();
    // The $100 service becomes the base the (still-present) 10% discount
    // now resolves against — not silently dropped from the stack.
    expect(screen.getByText('−$10.00')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Charge $90.00' })).toBeInTheDocument();
  });
});
