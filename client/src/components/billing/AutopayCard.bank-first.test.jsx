// @vitest-environment jsdom
// Bank first (owner 2026-11-01, option A): the Auto Pay add-method modal lists
// the bank tab first. The authorization and the save button shown at mount
// must be the FIRST tab's — bank (ACH) when the setup intent offers it, card
// otherwise — without waiting for a Payment Element 'change' event.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetAutopay = vi.fn();
const mockCreateSetupIntent = vi.fn();
vi.mock('../../utils/api', () => ({
  default: {
    getAutopay: (...a) => mockGetAutopay(...a),
    createSetupIntent: (...a) => mockCreateSetupIntent(...a),
  },
}));
vi.mock('../../lib/stripeLoader', () => ({ getStripe: vi.fn() }));

import { getStripe } from '../../lib/stripeLoader';
import { getConsentText } from '../../lib/paymentMethodConsentText';
import AutopayCard from './AutopayCard';

const base = {
  state: 'disabled', autopay_enabled: false, billing_mode: 'monthly', non_monthly_billing: false,
  next_charge_date: null, next_charge_amount: null, monthly_rate: null, payment_methods: [], billing_day: 1,
};

let created;
let handlers;

function fakeStripe() {
  created = [];
  handlers = {};
  const make = (type, opts) => {
    created.push({ type, opts });
    return {
      on: vi.fn((evt, cb) => { handlers[evt] = cb; }),
      mount: vi.fn(),
    };
  };
  return { elements: vi.fn(() => ({ create: make })) };
}

const text = (el) => (el.textContent || '').replace(/\s+/g, ' ');

async function openAddMethod(paymentMethodTypes) {
  mockGetAutopay.mockResolvedValue(base);
  mockCreateSetupIntent.mockResolvedValue({ publishableKey: 'pk_test_1', clientSecret: 'seti_secret', paymentMethodTypes });
  getStripe.mockResolvedValue(fakeStripe());
  const { container } = render(<AutopayCard customer={{}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Turn on Auto Pay' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Add payment method' }));
  await waitFor(() => expect(created?.length).toBeGreaterThan(0), { timeout: 2000 });
  return container;
}

// jsdom does not implement scrollTo (the modal's body-scroll lock calls it).
beforeEach(() => { window.scrollTo = vi.fn(); });

afterEach(() => {
  cleanup();
  mockGetAutopay.mockReset();
  mockCreateSetupIntent.mockReset();
  getStripe.mockReset();
});

describe('AutopayCard add-method modal — bank first', () => {
  it('labels the entry button "Add payment method"', async () => {
    mockGetAutopay.mockResolvedValue(base);
    render(<AutopayCard customer={{}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on Auto Pay' }));
    expect(await screen.findByRole('button', { name: 'Add payment method' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add new card' })).toBeNull();
  });

  it('bank offered: bank tab first, bank authorization and "Save bank account" at mount', async () => {
    await openAddMethod(['card', 'us_bank_account']);
    const payment = created.find((c) => c.type === 'payment');
    expect(payment.opts.paymentMethodOrder).toEqual(['us_bank_account', 'card', 'apple_pay', 'google_pay']);
    expect(screen.getByRole('button', { name: 'Save bank account' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save card' })).toBeNull();
    expect(text(document.body)).toContain(text({ textContent: getConsentText('us_bank_account') }));
    expect(text(document.body)).not.toContain(text({ textContent: getConsentText('card') }));
  });

  it('bank offered: following a change to the card tab swaps to the card authorization', async () => {
    await openAddMethod(['card', 'us_bank_account']);
    await act(async () => { handlers.change({ value: { type: 'card' } }); });
    expect(screen.getByRole('button', { name: 'Save card' })).toBeInTheDocument();
    expect(text(document.body)).toContain(text({ textContent: getConsentText('card') }));
  });

  it('bank NOT offered: card authorization and "Save card" at mount, as before', async () => {
    await openAddMethod(['card']);
    expect(screen.getByRole('button', { name: 'Save card' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save bank account' })).toBeNull();
    expect(text(document.body)).toContain(text({ textContent: getConsentText('card') }));
  });
});
