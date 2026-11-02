// @vitest-environment jsdom
// Bank first (owner 2026-11-01, option A): the Billing tab's "Add Payment
// Method" modal lists the bank tab first. The consent state must START on that
// first tab — bank (ACH) authorization and "Save Bank Account" at mount when
// the setup intent offers bank, card otherwise — and never wait for a Payment
// Element 'change' event (Codex #2706 r3 invariant, kept the new way).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    createSetupIntent: vi.fn(),
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
import { getConsentText } from '../lib/paymentMethodConsentText';
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
