// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/api', () => {
  const target = {};
  const proxy = new Proxy(target, {
    get: (obj, prop) => {
      if (typeof prop !== 'string') return obj[prop];
      if (!(prop in obj)) obj[prop] = vi.fn(() => new Promise(() => {}));
      return obj[prop];
    },
    set: (obj, prop, value) => { obj[prop] = value; return true; },
  });
  return { default: proxy };
});

import api from '../utils/api';
import { BillingTab } from './PortalPage';

const customer = {
  id: 'cust-1', firstName: 'Pat', lastName: 'Customer', email: 'pat@example.com',
  tier: null, monthlyRate: 0, property: {},
};

const openInvoices = [
  { payUrl: '/pay/tok-old', amountDue: 60, invoiceNumber: 'WPC-100', dueDate: null },
  { payUrl: '/pay/tok-failed', amountDue: 95, invoiceNumber: 'WPC-200', dueDate: null },
];

function failedPayment(overrides = {}) {
  return {
    id: 'pay-failed', date: '2026-11-17', amount: 95, status: 'failed',
    description: 'November pest visit', type: 'one_time',
    methodType: 'card', cardBrand: 'visa', lastFour: '4242',
    ...overrides,
  };
}

function paymentRow(descriptionElement) {
  let row = descriptionElement;
  while (row.parentElement && !within(row.parentElement).queryByText(/^Failed$/i)) row = row.parentElement;
  return row.parentElement || row;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  api.getCards.mockResolvedValue({ cards: [] });
  api.getAutopay.mockResolvedValue({ state: 'disabled' });
  api.getNotificationPrefs.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('failed payment recovery', () => {
  it('pays the invoice linked to the failed row, even when an older invoice is open', async () => {
    api.getPayments.mockResolvedValue({
      payments: [failedPayment({
        recoveryInvoice: { payUrl: '/pay/tok-failed', amountDue: 95, invoiceNumber: 'WPC-200' },
      })],
    });
    api.getBalance.mockResolvedValue({ currentBalance: 155, lastPaymentFailed: true, openInvoices });

    render(<BillingTab customer={customer} />);

    const row = paymentRow(await screen.findByText('November pest visit'));
    expect(within(row).getByRole('link', { name: 'Pay $95.00 now' })).toHaveAttribute('href', '/pay/tok-failed');
    expect(within(row).queryByRole('link', { name: 'Pay $60.00 now' })).not.toBeInTheDocument();
  });

  it('sends an unlinked legacy failure to the invoice list without guessing', async () => {
    api.getPayments.mockResolvedValue({ payments: [failedPayment()] });
    api.getBalance.mockResolvedValue({ currentBalance: 155, lastPaymentFailed: true, openInvoices });

    render(<BillingTab customer={customer} />);

    const row = paymentRow(await screen.findByText('November pest visit'));
    expect(within(row).getByRole('link', { name: 'View open invoices' }))
      .toHaveAttribute('href', '#billing-open-invoices');
    expect(within(row).queryByRole('link', { name: /^Pay / })).not.toBeInTheDocument();
  });
});
