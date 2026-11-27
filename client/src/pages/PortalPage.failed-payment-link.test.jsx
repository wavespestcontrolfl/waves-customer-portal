// @vitest-environment jsdom
// Failed payment rows in Payment History must ONLY link directly to Pay when
// the server verified THAT attempt's own open invoice (never openInvoices[0],
// which can belong to another invoice/amount). Also pins the Account Deletion
// confirmation warning about active service plans and Auto Pay.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/api', () => ({
  default: {
    getPropertyRecommendations: vi.fn(async () => ({ available: false })),
    getSchedule: vi.fn(async () => ({ upcoming: [] })),
    getNotificationPrefs: vi.fn(async () => ({})),
    getPropertyNotificationPrefs: vi.fn(async () => ({ properties: [] })),
    getPayments: vi.fn(),
    getBalance: vi.fn(),
    getCards: vi.fn(async () => ({ cards: [] })),
    getAutopay: vi.fn(async () => ({ state: 'disabled', autopay_enabled: false })),
    getNextService: vi.fn(async () => ({ next: null })),
    getServices: vi.fn(async () => ({ services: [] })),
    getStationMap: vi.fn(async () => ({ available: false })),
    getTermiteBond: vi.fn(async () => ({ available: false })),
    getLawnHealth: vi.fn(async () => ({ available: false })),
    getRequests: vi.fn(async () => ({ requests: [] })),
  },
}));
vi.mock('../components/brand/CustomerDialogHost', () => ({
  showCustomerAlert: vi.fn(),
  showCustomerConfirm: vi.fn(async () => false),
}));

import api from '../utils/api';
import { BillingTab } from './PortalPage';
import portalSource from './PortalPage.jsx?raw';

const customer = {
  id: 'cust-1', firstName: 'Pat', lastName: 'Customer',
  phone: '9415551234', email: 'pat@example.com', tier: null, property: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('BillingTab — failed payment row Pay button scoping', () => {
  it('links a $95 failed row to its own $95 invoice even when an older $60 invoice is openInvoices[0]', async () => {
    api.getBalance.mockResolvedValue({
      currentBalance: 155,
      lastPaymentFailed: true,
      openInvoices: [
        { payUrl: '/pay/tok-older-60', amountDue: 60, invoiceNumber: 'WV-1001' },
        { payUrl: '/pay/tok-failed-95', amountDue: 95, invoiceNumber: 'WV-1002' },
      ],
    });
    api.getPayments.mockResolvedValue({
      payments: [
        {
          id: 'pay-failed-95',
          date: '2026-11-20',
          amount: 95,
          status: 'failed',
          description: 'Invoice WV-1002 — Lawn Care',
          type: 'one_time',
          methodType: 'card',
          cardBrand: 'visa',
          lastFour: '4242',
          invoiceLinked: true,
          payableInvoice: { payUrl: '/pay/tok-failed-95', amountDue: 95, invoiceNumber: 'WV-1002' },
        },
      ],
      hasMore: false,
    });

    render(<BillingTab customer={customer} />);
    const rowTitle = await screen.findByText('Invoice WV-1002 — Lawn Care');
    const rowCard = rowTitle.closest('div[style*="margin-bottom: 10px"]') || rowTitle.parentElement.parentElement.parentElement;
    const payLink = rowCard.querySelector('a[href="/pay/tok-failed-95"]');
    expect(payLink).toBeInTheDocument();
    expect(payLink).toHaveTextContent('Pay $95.00 now');
    expect(rowCard.querySelector('a[href="/pay/tok-older-60"]')).toBeNull();
  });

  it('renders no Pay button on a failed row whose own invoice was already settled, even if another invoice is open', async () => {
    api.getBalance.mockResolvedValue({
      currentBalance: 60,
      lastPaymentFailed: false,
      openInvoices: [{ payUrl: '/pay/tok-other-60', amountDue: 60, invoiceNumber: 'WV-1003' }],
    });
    api.getPayments.mockResolvedValue({
      payments: [
        {
          id: 'pay-failed-settled',
          date: '2026-11-10',
          amount: 95,
          status: 'failed',
          description: 'Invoice WV-1002 — Already Paid Later',
          type: 'one_time',
          methodType: 'card',
          cardBrand: 'visa',
          lastFour: '4242',
          invoiceLinked: true,
          payableInvoice: null,
        },
      ],
      hasMore: false,
    });

    render(<BillingTab customer={customer} />);
    const rowTitle = await screen.findByText('Invoice WV-1002 — Already Paid Later');
    const rowCard = rowTitle.parentElement.parentElement.parentElement;
    expect(rowCard.querySelector('a[href^="/pay/"]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'View open invoices' })).not.toBeInTheDocument();
  });

  it('offers "View open invoices" (never a blind Pay link) on a legacy unlinked failed attempt when invoices are open', async () => {
    api.getBalance.mockResolvedValue({
      currentBalance: 60,
      lastPaymentFailed: true,
      openInvoices: [{ payUrl: '/pay/tok-60', amountDue: 60, invoiceNumber: 'WV-1004' }],
    });
    api.getPayments.mockResolvedValue({
      payments: [
        {
          id: 'pay-legacy-unlinked',
          date: '2026-11-15',
          amount: 89,
          status: 'failed',
          description: 'Silver WaveGuard Monthly',
          type: 'recurring',
          methodType: 'card',
          cardBrand: 'visa',
          lastFour: '4242',
          invoiceLinked: false,
          payableInvoice: null,
        },
      ],
      hasMore: false,
    });

    render(<BillingTab customer={customer} />);
    const rowTitle = await screen.findByText('Silver WaveGuard Monthly');
    const rowCard = rowTitle.parentElement.parentElement.parentElement;
    expect(rowCard.querySelector('a[href^="/pay/"]')).toBeNull();

    const scrollBtn = screen.getByRole('button', { name: 'View open invoices' });
    const target = document.getElementById('billing-open-invoices');
    expect(target).toBeTruthy();
    target.scrollIntoView = vi.fn();
    fireEvent.click(scrollBtn);
    await waitFor(() => expect(target.scrollIntoView).toHaveBeenCalled());
  });
});

describe('Account Deletion confirmation warning', () => {
  it('explicitly warns that deleting the account does not cancel active service plans, visits, or Auto Pay', () => {
    expect(portalSource).toContain('Deleting your account here does not cancel active service plans, upcoming visits, or Auto Pay');
  });
});
