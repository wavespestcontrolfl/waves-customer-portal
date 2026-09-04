// @vitest-environment jsdom
// Payment Methods row hierarchy (owner ruling 2026-08-27): the row Auto Pay
// is USING — from the server's autopay_selected_method_ids, never the
// per-row autopayEnabled flag — offers Replace card / Turn off Auto Pay and
// NO Remove; every other row keeps Set default / Remove. Gate off (or a
// stale getAutopay) renders the legacy layout unchanged.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/api', () => ({
  default: {
    getSchedule: vi.fn(),
    getNotificationPrefs: vi.fn(),
    getPropertyNotificationPrefs: vi.fn(),
    getPayments: vi.fn(),
    getBalance: vi.fn(),
    getCards: vi.fn(),
    getAutopay: vi.fn(),
    updateAutopay: vi.fn(),
    removeCard: vi.fn(),
    getNextService: vi.fn(),
    getServices: vi.fn(),
    getStationMap: vi.fn(),
    getTermiteBond: vi.fn(),
    getLawnHealth: vi.fn(),
    getRequests: vi.fn(),
  },
}));
vi.mock('../components/brand/CustomerDialogHost', () => ({
  showCustomerAlert: vi.fn(),
  showCustomerConfirm: vi.fn(async () => true),
}));

import api from '../utils/api';
import { showCustomerConfirm } from '../components/brand/CustomerDialogHost';
import { BillingTab } from './PortalPage';

const customer = {
  id: 'cust-1', firstName: 'Pat', lastName: 'Customer',
  phone: '9415551234', email: 'pat@example.com', tier: null, property: {},
};

const cards = [
  { id: 'pm-live', processor: 'stripe', methodType: 'card', brand: 'VISA', lastFour: '4242', expMonth: '12', expYear: '2032', isDefault: true, autopayEnabled: true },
  { id: 'pm-spare', processor: 'stripe', methodType: 'card', brand: 'MASTERCARD', lastFour: '1881', expMonth: '11', expYear: '2031', isDefault: false, autopayEnabled: false },
];

function autopayPayload(overrides = {}) {
  return {
    state: 'active',
    autopay_enabled: true,
    autopay_payment_method_id: 'pm-live',
    autopay_selected_method_ids: ['pm-live'],
    removal_guard: true,
    billing_day: 1,
    billing_mode: 'monthly_membership',
    next_charge_date: '2026-09-01',
    next_charge_amount: 100,
    monthly_rate: 100,
    payment_methods: cards.map((c) => ({ id: c.id, brand: c.brand, last4: c.lastFour, method_type: 'card', is_default: c.isDefault, autopay_enabled: c.autopayEnabled })),
    recent_events: [],
    ...overrides,
  };
}

// The Payment Methods list only — the billing summary card repeats the
// default method's label. A row = the list container's direct child that
// holds the label.
const list = () => document.getElementById('billing-payment-methods');
const rowFor = (last4) => {
  let el = within(list()).getByText(new RegExp(`ending in ${last4}`));
  while (el.parentElement && el.parentElement !== list()) el = el.parentElement;
  return el;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  api.getPayments.mockResolvedValue({ payments: [] });
  api.getBalance.mockResolvedValue({ currentBalance: 0 });
  api.getCards.mockResolvedValue({ cards });
  api.getNotificationPrefs.mockResolvedValue({});
  api.getLawnHealth.mockResolvedValue({ available: false });
  api.getStationMap.mockResolvedValue({ available: false });
  api.getTermiteBond.mockResolvedValue({ available: false });
  api.updateAutopay.mockResolvedValue({ success: true });
  api.removeCard.mockResolvedValue({ success: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Payment Methods row hierarchy', () => {
  it('the in-use row offers Replace card / Turn off Auto Pay and hides Remove; other rows keep Remove', async () => {
    api.getAutopay.mockResolvedValue(autopayPayload());
    render(<BillingTab customer={customer} />);

    await screen.findByText(/Auto Pay method/);
    const live = rowFor('4242');
    expect(within(live).getByRole('button', { name: 'Replace card' })).toBeInTheDocument();
    expect(within(live).getByRole('button', { name: 'Turn off' })).toBeInTheDocument();
    expect(within(live).queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();

    const spare = rowFor('1881');
    expect(within(spare).getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    expect(within(spare).getByRole('button', { name: 'Set default' })).toBeInTheDocument();
    expect(within(spare).queryByRole('button', { name: 'Replace card' })).not.toBeInTheDocument();
  });

  it('identity comes from the server set, not the per-row flag', async () => {
    // Stale per-row flag on the spare card; server says only pm-live is in use.
    api.getCards.mockResolvedValue({ cards: cards.map((c) => ({ ...c, autopayEnabled: true })) });
    api.getAutopay.mockResolvedValue(autopayPayload());
    render(<BillingTab customer={customer} />);
    await screen.findByText(/Auto Pay method/);
    expect(within(rowFor('1881')).getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    expect(screen.getAllByText(/Auto Pay method/)).toHaveLength(1);
  });

  it('Turn off Auto Pay confirms, then disables server-side and refreshes', async () => {
    api.getAutopay.mockResolvedValue(autopayPayload());
    render(<BillingTab customer={customer} />);
    await screen.findByText(/Auto Pay method/);
    fireEvent.click(within(rowFor('4242')).getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(api.updateAutopay).toHaveBeenCalledWith({ autopay_enabled: false }));
    expect(showCustomerConfirm).toHaveBeenCalled();
    await waitFor(() => expect(api.getCards).toHaveBeenCalledTimes(2));
  });

  it('gate off → legacy layout: every row has Remove, no Auto Pay method badge', async () => {
    api.getAutopay.mockResolvedValue(autopayPayload({ removal_guard: false }));
    render(<BillingTab customer={customer} />);
    await waitFor(() => expect(within(list()).getAllByRole('button', { name: 'Remove' })).toHaveLength(2));
    expect(screen.queryByText(/Auto Pay method/)).not.toBeInTheDocument();
  });

  it('removing a verified bank row under ANY bank alias carries the 3-business-day ACH copy', async () => {
    api.getCards.mockResolvedValue({ cards: [
      cards[0],
      { id: 'pm-bank', processor: 'stripe', methodType: 'bank_account', brand: null, lastFour: '9001', bankName: 'Sun Bank', achStatus: 'verified', isDefault: false, autopayEnabled: false },
    ] });
    api.getAutopay.mockResolvedValue(autopayPayload());
    render(<BillingTab customer={customer} />);
    await screen.findByText(/Auto Pay method/);
    fireEvent.click(within(rowFor('9001')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(showCustomerConfirm).toHaveBeenCalledWith(expect.stringMatching(/3 business days/), expect.anything()));
  });

  // GATE_PORTAL_CARD_REMOVAL_HOLD_NOTICE: a card carrying holdsAppointment
  // opens the call-us disclaimer (visit + agreed fee survive removal; call
  // or reschedule), with Keep card as the default and Remove anyway still
  // available — removal is never blocked.
  const holdingCards = () => [cards[0], {
    ...cards[1],
    holdsAppointment: { serviceId: 'svc-9', start: '2026-09-12T13:00:00.000Z', serviceType: 'Pest Control', feeAmount: 49, rescheduleUrl: '/reschedule/tok-9' },
  }];

  it('Remove on a card holding a visit opens the disclaimer with the phone + reschedule links; Keep card removes nothing', async () => {
    api.getCards.mockResolvedValue({ cards: holdingCards() });
    api.getAutopay.mockResolvedValue(autopayPayload());
    showCustomerConfirm.mockResolvedValue(false);
    render(<BillingTab customer={customer} />);
    await screen.findByText(/Auto Pay method/);
    fireEvent.click(within(rowFor('1881')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(showCustomerConfirm).toHaveBeenCalledTimes(1));
    const [message, options] = showCustomerConfirm.mock.calls[0];
    expect(options).toEqual({ title: 'This card holds an appointment', confirmLabel: 'Remove anyway', cancelLabel: 'Keep card', danger: true });
    const { container } = render(<div data-testid="msg">{message}</div>);
    const text = container.textContent;
    expect(text).toMatch(/holding your Pest Control visit on Sat, Sep 12, 9:00 AM/);
    expect(text).toMatch(/does not cancel the visit or the \$49\.00 late-cancel fee you agreed to/);
    expect(within(container).getByRole('link', { name: '(941) 297-5749' })).toHaveAttribute('href', 'tel:+19412975749');
    expect(within(container).getByRole('link', { name: 'reschedule online' })).toHaveAttribute('href', '/reschedule/tok-9');
    expect(api.removeCard).not.toHaveBeenCalled();
  });

  it('a fractional agreed fee keeps its cents', async () => {
    const [live, holding] = holdingCards();
    api.getCards.mockResolvedValue({ cards: [live, { ...holding, holdsAppointment: { ...holding.holdsAppointment, feeAmount: 49.5 } }] });
    api.getAutopay.mockResolvedValue(autopayPayload());
    showCustomerConfirm.mockResolvedValue(false);
    render(<BillingTab customer={customer} />);
    await screen.findByText(/Auto Pay method/);
    fireEvent.click(within(rowFor('1881')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(showCustomerConfirm).toHaveBeenCalledTimes(1));
    const { container } = render(<div>{showCustomerConfirm.mock.calls[0][0]}</div>);
    expect(container.textContent).toMatch(/\$49\.50 late-cancel fee/);
  });

  it('Remove anyway still removes the holding card', async () => {
    api.getCards.mockResolvedValue({ cards: holdingCards() });
    api.getAutopay.mockResolvedValue(autopayPayload());
    render(<BillingTab customer={customer} />);
    await screen.findByText(/Auto Pay method/);
    fireEvent.click(within(rowFor('1881')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.removeCard).toHaveBeenCalledWith('pm-spare'));
  });

  it('no reschedule link when the server sent none; a card without a hold keeps the plain confirm', async () => {
    const [live, holding] = holdingCards();
    api.getCards.mockResolvedValue({ cards: [live, { ...holding, holdsAppointment: { ...holding.holdsAppointment, rescheduleUrl: null } }] });
    api.getAutopay.mockResolvedValue(autopayPayload({ autopay_selected_method_ids: [] }));
    showCustomerConfirm.mockResolvedValue(false);
    render(<BillingTab customer={customer} />);
    await waitFor(() => expect(within(list()).getAllByRole('button', { name: 'Remove' })).toHaveLength(2));
    fireEvent.click(within(rowFor('1881')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(showCustomerConfirm).toHaveBeenCalledTimes(1));
    const { container } = render(<div>{showCustomerConfirm.mock.calls[0][0]}</div>);
    expect(within(container).queryByRole('link', { name: 'reschedule online' })).not.toBeInTheDocument();
    expect(within(container).getByRole('link', { name: '(941) 297-5749' })).toBeInTheDocument();
    fireEvent.click(within(rowFor('4242')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(showCustomerConfirm).toHaveBeenCalledTimes(2));
    expect(showCustomerConfirm.mock.calls[1]).toEqual(['Remove this payment method?', { title: 'Remove payment method?', confirmLabel: 'Remove', danger: true }]);
  });

  it('a 409 autopay_method_in_use on Remove surfaces the server message and refreshes', async () => {
    api.getAutopay.mockResolvedValue(autopayPayload({ autopay_selected_method_ids: [] }));
    const err = new Error('This payment method is currently used for Auto Pay. Add another payment method or turn off Auto Pay before removing it.');
    err.status = 409; err.code = 'autopay_method_in_use';
    api.removeCard.mockRejectedValue(err);
    const { showCustomerAlert } = await import('../components/brand/CustomerDialogHost');
    render(<BillingTab customer={customer} />);
    await waitFor(() => expect(within(list()).getAllByRole('button', { name: 'Remove' })).toHaveLength(2));
    fireEvent.click(within(rowFor('4242')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(showCustomerAlert).toHaveBeenCalledWith(expect.stringMatching(/turn off Auto Pay before removing/)));
    await waitFor(() => expect(api.getCards).toHaveBeenCalledTimes(2));
    // The AutopayCard remounts too (it owns its own state): mount load +
    // refreshCards' getAutopay + the remounted card's load.
    await waitFor(() => expect(api.getAutopay.mock.calls.length).toBeGreaterThanOrEqual(3));
  });
});
