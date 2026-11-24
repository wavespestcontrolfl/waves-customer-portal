// @vitest-environment jsdom
// Bank first (owner 2026-11-01, option A): the Billing tab's "Add Payment
// Method" modal lists the bank tab first. The consent state must START on that
// first tab — bank (ACH) authorization and "Save Bank Account" at mount when
// the setup intent offers bank, card otherwise — and never wait for a Payment
// Element 'change' event (Codex #2706 r3 invariant, kept the new way).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/api', () => ({
  default: {
    // Billing mounts Home's add-a-service card (owner 2026-11-21).
    getPropertyRecommendations: vi.fn(async () => ({ available: false })),
    getSchedule: vi.fn(),
    getNotificationPrefs: vi.fn(),
    getPropertyNotificationPrefs: vi.fn(),
    getPayments: vi.fn(),
    getBalance: vi.fn(),
    getCards: vi.fn(),
    getAutopay: vi.fn(),
    updateAutopay: vi.fn(),
    removeCard: vi.fn(),
    createSetupIntent: vi.fn(),
    saveStripeCard: vi.fn(),
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
vi.mock('../lib/stripeLoader', () => ({ getStripe: vi.fn() }));

import api from '../utils/api';
import { getStripe } from '../lib/stripeLoader';
import { getConsentText, SAVE_ONLY_CONSENT_TEXT } from '../lib/paymentMethodConsentText';
import { BillingTab } from './PortalPage';

const customer = {
  id: 'cust-1', firstName: 'Pat', lastName: 'Customer',
  phone: '9415551234', email: 'pat@example.com', tier: null, property: {},
};
const cards = [
  { id: 'pm-live', processor: 'stripe', methodType: 'card', brand: 'VISA', lastFour: '4242', expMonth: '12', expYear: '2032', isDefault: true, autopayEnabled: true },
];
const autopay = {
  state: 'active', autopay_enabled: true, autopay_payment_method_id: 'pm-live', autopay_selected_method_ids: ['pm-live'],
  removal_guard: true, billing_day: 1, billing_mode: 'monthly', non_monthly_billing: false,
  next_charge_date: null, next_charge_amount: null, monthly_rate: null,
  payment_methods: cards.map((c) => ({ id: c.id, brand: c.brand, last4: c.lastFour, method_type: 'card', is_default: c.isDefault, autopay_enabled: c.autopayEnabled })),
  recent_events: [],
};

let created;
let handlers;
function fakeStripe() {
  created = [];
  handlers = {};
  const make = (type, opts) => {
    created.push({ type, opts });
    return { on: vi.fn((evt, cb) => { handlers[evt] = cb; }), mount: vi.fn() };
  };
  return { elements: vi.fn(() => ({ create: make })) };
}

const SETTLE = { timeout: 10000 };
const text = (s) => String(s).replace(/\s+/g, ' ');

async function openModal(paymentMethodTypes) {
  api.createSetupIntent.mockResolvedValue({ publishableKey: 'pk_test_1', clientSecret: 'seti_secret', paymentMethodTypes });
  getStripe.mockResolvedValue(fakeStripe());
  render(<BillingTab customer={customer} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Add payment' }, SETTLE));
  await screen.findByRole('dialog', { name: 'Add payment method' }, SETTLE);
  await waitFor(() => expect(created.length).toBeGreaterThan(0), { timeout: 2000 });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.scrollTo = vi.fn();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  api.getPayments.mockResolvedValue({ payments: [] });
  api.getBalance.mockResolvedValue({ currentBalance: 0 });
  api.getCards.mockResolvedValue({ cards });
  api.getNotificationPrefs.mockResolvedValue({});
  api.getLawnHealth.mockResolvedValue({ available: false });
  api.getStationMap.mockResolvedValue({ available: false });
  api.getTermiteBond.mockResolvedValue({ available: false });
  api.getAutopay.mockResolvedValue(autopay);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Billing tab Add Payment Method modal — bank first', { timeout: 30000 }, () => {
  it('bank offered: bank tab first, bank authorization and "Save Bank Account" at mount', async () => {
    await openModal(['card', 'us_bank_account']);
    const payment = created.find((c) => c.type === 'payment');
    expect(payment.opts.paymentMethodOrder).toEqual(['us_bank_account', 'card', 'apple_pay', 'google_pay']);
    const dialog = screen.getByRole('dialog', { name: 'Add payment method' });
    expect(screen.getByRole('button', { name: 'Save Bank Account' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save Card' })).toBeNull();
    expect(text(dialog.textContent)).toContain(text(getConsentText('us_bank_account')));
    expect(text(dialog.textContent)).not.toContain(text(getConsentText('card')));
    expect(dialog).toHaveTextContent('We never store your bank details directly.');
  });

  it('bank offered: a change to the card tab swaps to the card authorization', async () => {
    await openModal(['card', 'us_bank_account']);
    await act(async () => { handlers.change({ value: { type: 'card' } }); });
    const dialog = screen.getByRole('dialog', { name: 'Add payment method' });
    expect(screen.getByRole('button', { name: 'Save Card' })).toBeInTheDocument();
    expect(text(dialog.textContent)).toContain(text(getConsentText('card')));
  });

  it('bank NOT offered: card authorization and "Save Card" at mount, as before', async () => {
    await openModal(['card']);
    const dialog = screen.getByRole('dialog', { name: 'Add payment method' });
    expect(screen.getByRole('button', { name: 'Save Card' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save Bank Account' })).toBeNull();
    expect(text(dialog.textContent)).toContain(text(getConsentText('card')));
  });
});

// UI audit 2026-11-02 (UI-06): Close, the scrim and Escape stayed live while
// the save ran, so the customer could dismiss the dialog mid-save and lose
// its result while the save went on.
describe('Billing tab Add Payment Method modal — no close while saving', { timeout: 30000 }, () => {
  it('Close, Escape and the scrim leave the dialog open until the save settles', async () => {
    let settle;
    const confirmSetup = vi.fn(() => new Promise((resolve) => { settle = resolve; }));
    api.createSetupIntent.mockResolvedValue({ publishableKey: 'pk_test_1', clientSecret: 'seti_secret', paymentMethodTypes: ['card'] });
    getStripe.mockResolvedValue({ ...fakeStripe(), confirmSetup });
    render(<BillingTab customer={customer} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add payment' }, SETTLE));
    const dialog = await screen.findByRole('dialog', { name: 'Add payment method' }, SETTLE);
    await waitFor(() => expect(handlers.ready).toBeTypeOf('function'), { timeout: 2000 });
    await act(async () => { handlers.ready(); });
    fireEvent.click(screen.getByRole('button', { name: 'Save Card' }));
    await waitFor(() => expect(confirmSetup).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.click(dialog.parentElement);
    expect(screen.getByRole('dialog', { name: 'Add payment method' })).toBeInTheDocument();
    // The result lands in the dialog the customer is still looking at.
    await act(async () => { settle({ error: { message: 'Your card was declined.' } }); });
    expect(within(screen.getByRole('dialog', { name: 'Add payment method' })).getByText('Your card was declined.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'Add payment method' })).toBeNull();
  });
});

// The "add a card" reminder email links to /?tab=billing&add_card=1 (GATE_CARD_ON_FILE_REMINDER): the Billing tab
// opens the Add form once, as a save-only card form that never turns Auto Pay on.
describe('Billing tab Add Payment Method modal — save-only form from the reminder email link', { timeout: 30000 }, () => {
  const savedSetupIntent = { status: 'succeeded', payment_method: 'pm_new', id: 'si_new' };

  it('opens by itself, card only, minted with enrollAutopay:false, and shows the save-only statement instead of the Auto Pay authorization', async () => {
    api.createSetupIntent.mockResolvedValue({ publishableKey: 'pk_test_1', clientSecret: 'seti_secret', paymentMethodTypes: ['card'] });
    getStripe.mockResolvedValue(fakeStripe());
    window.history.replaceState({}, '', '/?tab=billing&add_card=1');
    render(<BillingTab customer={customer} openAddCard />);
    const dialog = await screen.findByRole('dialog', { name: 'Add payment method' }, SETTLE);
    expect(api.createSetupIntent).toHaveBeenCalledTimes(1);
    expect(api.createSetupIntent).toHaveBeenCalledWith('card', { enrollAutopay: false });
    expect(SAVE_ONLY_CONSENT_TEXT).toBe('Save this card for future payments. We charge it only when you pay with it or turn on Auto Pay.');
    expect(dialog).toHaveTextContent(SAVE_ONLY_CONSENT_TEXT);
    // The standard Auto Pay authorization is replaced, never shown beside it.
    expect(dialog).not.toHaveTextContent(getConsentText('card'));
    expect(dialog).not.toHaveTextContent('By checking this box');
    expect(screen.getByRole('button', { name: 'Save Card' })).toBeInTheDocument();
    // The link is consumed on open, so a Stripe redirect that returns to this URL cannot open a second form.
    expect(window.location.search).toBe('?tab=billing');
  });

  it('after the save: the card is saved, Auto Pay is not touched, and the page says it did not turn it on', async () => {
    api.getAutopay.mockResolvedValue({ ...autopay, state: 'disabled', autopay_enabled: false, autopay_payment_method_id: null, autopay_selected_method_ids: [] });
    const confirmSetup = vi.fn(async () => ({ setupIntent: savedSetupIntent }));
    api.createSetupIntent.mockResolvedValue({ publishableKey: 'pk_test_1', clientSecret: 'seti_secret', paymentMethodTypes: ['card'] });
    api.saveStripeCard.mockResolvedValue({ success: true, enrolled: false, enrollReason: 'save_only', card: { id: 'pm-new' } });
    getStripe.mockResolvedValue({ ...fakeStripe(), confirmSetup });
    render(<BillingTab customer={customer} openAddCard />);
    await screen.findByRole('dialog', { name: 'Add payment method' }, SETTLE);
    await waitFor(() => expect(handlers.ready).toBeTypeOf('function'), { timeout: 2000 });
    await act(async () => { handlers.ready(); });
    fireEvent.click(screen.getByRole('button', { name: 'Save Card' }));
    await waitFor(() => expect(api.saveStripeCard).toHaveBeenCalledWith('pm_new', 'si_new'));
    expect(await screen.findByText('Card saved. Saving it did not turn Auto Pay on. You can turn it on below if you want it.', {}, SETTLE)).toBeInTheDocument();
    expect(api.updateAutopay).not.toHaveBeenCalled();
  });

  it('a save-only form opened before a deploy is refused as stale: the link comes back, so the refresh opens the save-only form again', async () => {
    api.createSetupIntent.mockResolvedValue({ publishableKey: 'pk_test_1', clientSecret: 'seti_secret', paymentMethodTypes: ['card'] });
    api.saveStripeCard.mockRejectedValue(Object.assign(new Error('The payment authorization text was updated. Please refresh the page and try again.'), { status: 409, code: 'CONSENT_VERSION_STALE' }));
    getStripe.mockResolvedValue({ ...fakeStripe(), confirmSetup: vi.fn(async () => ({ setupIntent: savedSetupIntent })) });
    window.history.replaceState({}, '', '/?tab=billing&add_card=1');
    render(<BillingTab customer={customer} openAddCard />);
    await screen.findByRole('dialog', { name: 'Add payment method' }, SETTLE);
    expect(window.location.search).toBe('?tab=billing');
    await waitFor(() => expect(handlers.ready).toBeTypeOf('function'), { timeout: 2000 });
    await act(async () => { handlers.ready(); });
    fireEvent.click(screen.getByRole('button', { name: 'Save Card' }));
    expect(await screen.findByText(/payment authorization text was updated/, {}, SETTLE)).toBeInTheDocument();
    expect(window.location.search).toContain('add_card=1');
  });

  it.each([
    ['a save-only intent', true, true],
    ['a usual (Auto Pay) intent', false, false],
  ])('coming back from a Stripe redirect with %s refused as stale: the returned intent leaves the URL, and only save-only brings the link back', async (_name, saveOnly, linkBack) => {
    const stale = Object.assign(new Error('The payment authorization text was updated. Please refresh the page and try again.'), { status: 409, code: 'CONSENT_VERSION_STALE', ...(saveOnly ? { saveOnly: true } : {}) });
    api.saveStripeCard.mockRejectedValue(stale);
    window.history.replaceState({}, '', '/?tab=billing&stripe_setup_flow=portal_add_card&setup_intent=si_old&redirect_status=succeeded');
    render(<BillingTab customer={customer} />);
    expect(await screen.findByText(/payment authorization text was updated/, {}, SETTLE)).toBeInTheDocument();
    expect(api.saveStripeCard).toHaveBeenCalledWith(null, 'si_old');
    const params = new URLSearchParams(window.location.search);
    expect(params.get('setup_intent')).toBeNull();
    expect(params.get('stripe_setup_flow')).toBeNull();
    expect(params.get('tab')).toBe('billing');
    expect(params.get('add_card')).toBe(linkBack ? '1' : null);
    // An immediate retry on the visible button keeps the mode: save-only mints enrollAutopay:false, the usual form never does.
    api.createSetupIntent.mockResolvedValue({ publishableKey: 'pk_test_1', clientSecret: 'seti_secret', paymentMethodTypes: ['card'] });
    getStripe.mockResolvedValue(fakeStripe());
    fireEvent.click(await screen.findByRole('button', { name: 'Add payment' }, SETTLE));
    await screen.findByRole('dialog', { name: 'Add payment method' }, SETTLE);
    expect(api.createSetupIntent).toHaveBeenLastCalledWith(...(saveOnly ? ['card', { enrollAutopay: false }] : ['card_or_bank']));
  });

  it('a failed start keeps the link and the save-only mode: the retry button mints save-only again, never the Auto Pay form', async () => {
    api.createSetupIntent
      .mockRejectedValueOnce(new Error('Could not start the form'))
      .mockResolvedValue({ publishableKey: 'pk_test_1', clientSecret: 'seti_secret', paymentMethodTypes: ['card'] });
    getStripe.mockResolvedValue(fakeStripe());
    window.history.replaceState({}, '', '/?tab=billing&add_card=1');
    render(<BillingTab customer={customer} openAddCard />);
    expect(await screen.findByText('Could not start the form', {}, SETTLE)).toBeInTheDocument();
    // The link is only consumed once the form is open, so a refresh would try the save-only form again.
    expect(window.location.search).toBe('?tab=billing&add_card=1');
    fireEvent.click(screen.getByRole('button', { name: 'Add payment' }));
    await screen.findByRole('dialog', { name: 'Add payment method' }, SETTLE);
    expect(api.createSetupIntent).toHaveBeenCalledTimes(2);
    expect(api.createSetupIntent).toHaveBeenLastCalledWith('card', { enrollAutopay: false });
    expect(window.location.search).toBe('?tab=billing');
  });

  it('closing the opened form ends the save-only mode: the next Add payment is the full form again', async () => {
    api.createSetupIntent.mockResolvedValue({ publishableKey: 'pk_test_1', clientSecret: 'seti_secret', paymentMethodTypes: ['card'] });
    getStripe.mockResolvedValue(fakeStripe());
    render(<BillingTab customer={customer} openAddCard />);
    await screen.findByRole('dialog', { name: 'Add payment method' }, SETTLE);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'Add payment method' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Add payment' }, SETTLE));
    await screen.findByRole('dialog', { name: 'Add payment method' }, SETTLE);
    expect(api.createSetupIntent).toHaveBeenLastCalledWith('card_or_bank');
  });

  it('the usual Add payment button still mints the full form and shows the standard authorization, not the save-only text', async () => {
    await openModal(['card', 'us_bank_account']);
    expect(api.createSetupIntent).toHaveBeenCalledWith('card_or_bank');
    const dialog = screen.getByRole('dialog', { name: 'Add payment method' });
    expect(dialog).toHaveTextContent(getConsentText('us_bank_account'));
    expect(dialog).not.toHaveTextContent(SAVE_ONLY_CONSENT_TEXT);
  });
});
