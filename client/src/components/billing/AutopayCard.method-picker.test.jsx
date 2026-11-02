// @vitest-environment jsdom
// Auto Pay method picker (UI audit 2026-11-02): the confirm button names the
// kind of method picked (a bank row confirmed with "Use this card" misled, UI-05),
// and the dialog cannot be closed while a save runs, which hid the result
// while the save went on (UI-06).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetAutopay = vi.fn();
const mockUpdateAutopay = vi.fn();
vi.mock('../../utils/api', () => ({
  default: {
    getAutopay: (...a) => mockGetAutopay(...a),
    updateAutopay: (...a) => mockUpdateAutopay(...a),
    createSetupIntent: vi.fn(),
  },
}));
vi.mock('../../lib/stripeLoader', () => ({ getStripe: vi.fn() }));

import AutopayCard from './AutopayCard';

const autopay = (overrides = {}) => ({
  state: 'active', autopay_enabled: true, autopay_payment_method_id: 'pm-card', billing_day: 1,
  billing_mode: 'monthly', non_monthly_billing: false, next_charge_date: null, next_charge_amount: null, monthly_rate: null,
  payment_methods: [
    { id: 'pm-card', method_type: 'card', brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2032 },
    { id: 'pm-bank', method_type: 'us_bank_account', bank_name: 'Example Bank', last4: '6789', ach_status: 'verified' },
  ],
  ...overrides,
});

async function openMethodPicker() {
  render(<AutopayCard customer={{}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Manage Auto Pay' }));
  fireEvent.click(screen.getByRole('button', { name: 'Change payment method' }));
  return screen.getByRole('dialog', { name: 'Change Auto Pay method' });
}

// jsdom does not implement scrollTo (the modal's body-scroll lock calls it).
beforeEach(() => { window.scrollTo = vi.fn(); });

afterEach(() => {
  cleanup();
  mockGetAutopay.mockReset();
  mockUpdateAutopay.mockReset();
});

describe('AutopayCard method picker', () => {
  it('names the picked method: card rows say card, bank rows say bank account', async () => {
    mockGetAutopay.mockResolvedValue(autopay());
    await openMethodPicker();
    expect(screen.getByRole('button', { name: 'Use this card' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /Example Bank ending in 6789/ }));
    expect(screen.getByRole('button', { name: 'Use this bank account' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use this card' })).toBeNull();
  });

  it('an empty list says payment methods, not cards', async () => {
    mockGetAutopay.mockResolvedValue(autopay({ state: 'disabled', autopay_enabled: false, autopay_payment_method_id: null, payment_methods: [] }));
    render(<AutopayCard customer={{}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on Auto Pay' }));
    expect(await screen.findByText('No payment methods on file yet. Add one before Auto Pay can run.')).toBeInTheDocument();
    expect(screen.queryByText(/No cards on file/)).toBeNull();
  });

  it('while the save runs, Close, Cancel, Escape and the scrim leave the dialog open', async () => {
    mockGetAutopay.mockResolvedValue(autopay());
    let finish;
    mockUpdateAutopay.mockReturnValue(new Promise((resolve, reject) => { finish = reject; }));
    const dialog = await openMethodPicker();
    fireEvent.click(screen.getByRole('radio', { name: /Example Bank ending in 6789/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Use this bank account' }));
    expect(mockUpdateAutopay).toHaveBeenCalledWith({ autopay_payment_method_id: 'pm-bank' });
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.click(dialog.parentElement);
    expect(screen.getByRole('dialog', { name: 'Change Auto Pay method' })).toBeInTheDocument();
    // The result lands in the dialog the customer is still looking at.
    finish(Object.assign(new Error('Your bank declined the change.'), { status: 400 }));
    expect(await screen.findByText('Your bank declined the change.')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Change Auto Pay method' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeEnabled();
  });
});
