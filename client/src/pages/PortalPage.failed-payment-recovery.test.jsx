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
  it('reviews the invoice linked to the failed row, even when an older invoice is open', async () => {
    api.getPayments.mockResolvedValue({
      payments: [failedPayment({
        recoveryInvoice: { payUrl: '/pay/tok-failed', amountDue: 95, invoiceNumber: 'WPC-200' },
      })],
    });
    api.getBalance.mockResolvedValue({ currentBalance: 155, lastPaymentFailed: true, openInvoices });

    render(<BillingTab customer={customer} />);

    const row = paymentRow(await screen.findByText('November pest visit'));
    expect(screen.getByText('Your last payment could not be processed. Review and pay your open invoices above. Update your saved payment method below for future payments.'))
      .toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'Review invoice' })).toHaveAttribute('href', '/pay/tok-failed');
    expect(within(row).queryByRole('link', { name: /^Pay / })).not.toBeInTheDocument();
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

  it.each(['authentication_pending', 'authentication_unknown'])(
    'shows verification guidance without a new invoice shortcut for %s',
    async (recoveryState) => {
      api.getPayments.mockResolvedValue({
        payments: [
          failedPayment({
            recoveryInvoice: null,
            recoveryState,
          }),
          failedPayment({
            id: 'pay-other',
            date: '2026-10-17',
            description: 'October pest visit',
            recoveryInvoice: { payUrl: '/pay/tok-other', amountDue: 60, invoiceNumber: 'WPC-300' },
          }),
          failedPayment({ id: 'pay-legacy', date: '2026-09-17', description: 'September pest visit' }),
        ],
      });
      api.getBalance.mockResolvedValue({
        currentBalance: 95,
        lastPaymentFailed: true,
        openInvoices: [openInvoices[1]],
      });

      render(<BillingTab customer={customer} />);

      const row = paymentRow(await screen.findByText('November pest visit'));
      expect(screen.getByText('Payment needs verification')).toBeInTheDocument();
      expect(screen.getByText('Contact us to confirm the payment status before trying again.'))
        .toBeInTheDocument();
      expect(within(row).getByRole('status'))
        .toHaveTextContent('Payment needs verification. Contact us to confirm the payment status before trying again.');
      expect(screen.queryByRole('link', { name: 'View open invoices' })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Review invoice' })).not.toBeInTheDocument();
      // The bounded fix does not change the original account-balance invoice
      // list or central checkout behavior.
      expect(screen.getByRole('link', { name: 'Pay $95.00 now' }))
        .toHaveAttribute('href', '/pay/tok-failed');
    },
  );

  it('does not send a cancelled customer to hidden payment-method controls', async () => {
    api.getPayments.mockResolvedValue({ payments: [failedPayment()] });
    api.getBalance.mockResolvedValue({ currentBalance: 95, lastPaymentFailed: true, openInvoices: [openInvoices[1]] });

    render(<BillingTab customer={{ ...customer, cancelled: true }} />);

    expect(await screen.findByText('Your last payment could not be processed. Review your open invoices above.'))
      .toBeInTheDocument();
    expect(screen.queryByText(/update your saved payment method below/i)).not.toBeInTheDocument();
  });
});
