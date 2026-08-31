// @vitest-environment jsdom
// C4 (GATE_CANCEL_FLOW_V2): a CANCELLED account's Billing tab keeps the
// reads (balance, history, credits) and hides every management surface
// whose writes the middleware 401s — Payment Methods (incl. Auto Pay
// controls), the auto-apply-credit toggle, and Billing Preferences. An
// active account renders all of them unchanged.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
import { BillingTab } from './PortalPage';

const baseCustomer = {
  id: 'cust-1', firstName: 'Pat', lastName: 'Customer',
  phone: '9415551234', email: 'pat@example.com', tier: null, property: {},
  accountCredit: 45,
};

beforeEach(() => {
  // Every mocked call resolves — an undefined return breaks the mount
  // effect's `.catch` chains before assertions run.
  Object.values(api).forEach((fn) => { if (typeof fn?.mockResolvedValue === 'function') fn.mockResolvedValue(null); });
  api.getPayments.mockResolvedValue({ payments: [], nextCursor: null });
  api.getBalance.mockResolvedValue({ currentBalance: 0, openInvoices: [] });
  api.getCards.mockResolvedValue({ cards: [{ id: 'pm-1', processor: 'stripe', methodType: 'card', brand: 'VISA', lastFour: '4242', expMonth: '12', expYear: '2032', isDefault: true }] });
  api.getAutopay.mockResolvedValue({ state: 'disabled', autopay_enabled: false, autopay_selected_method_ids: [] });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

async function renderBilling(customer) {
  render(<BillingTab customer={customer} refreshCustomer={vi.fn()} />);
  await waitFor(() => expect(api.getBalance).toHaveBeenCalled());
  // The loading panel resolves before assertions run.
  await screen.findByText(/Payment History/i);
}

describe('BillingTab — cancelled account is read-only (C4)', () => {
  it('hides Payment Methods, the auto-apply toggle, and Billing Preferences when cancelled', async () => {
    await renderBilling({ ...baseCustomer, cancelled: true, cancelledAt: '2026-08-22' });
    expect(screen.queryByText('Payment Methods')).not.toBeInTheDocument();
    expect(screen.queryByText('Billing Preferences')).not.toBeInTheDocument();
    expect(screen.queryByTestId('auto-apply-credit-row')).not.toBeInTheDocument();
    // Reads survive.
    expect(screen.getByText(/Payment History/i)).toBeInTheDocument();
  });

  it('renders the management surfaces unchanged for an active account', async () => {
    await renderBilling({ ...baseCustomer, cancelled: false });
    expect(screen.getByText('Payment Methods')).toBeInTheDocument();
    expect(screen.getByText('Billing Preferences')).toBeInTheDocument();
  });
});
