// @vitest-environment jsdom
// Saved home screen (owner 2026-11-25): while the app shows the last saved
// account (customerSaved) the header says "Updating…", no money figure or pay
// action shows, and the tabs that hold money, plan or settings wait for fresh
// data. Home's next/last visit reads hydrate from storage as saved cards.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { BrowserRouter } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const auth = vi.hoisted(() => ({ saved: false, customer: null }));
vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({
    sessionEpoch: 0,
    customer: auth.customer,
    customerSaved: auth.saved,
    logout: vi.fn(),
    properties: [],
    propertiesError: null,
    refreshProperties: vi.fn(),
    switchProperty: vi.fn(),
    refreshCustomer: vi.fn(),
  }),
  tokenCustomerId: () => 'cust-1',
}));

import api from '../utils/api';
import PortalPage from './PortalPage';
import { HOME_READS_KEY, homeIdentityKey, writeHomeRead } from '../lib/homeSnapshot';

const b64u = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const TOKEN = `${b64u({ alg: 'none' })}.${b64u({ customerId: 'cust-1', sessionId: 'fam-1' })}.sig`;

const SAVED_CUSTOMER = { id: 'cust-1', firstName: 'Pat', lastName: 'Customer', phone: '9415551234', email: 'pat@example.com', tier: 'Gold', property: {}, actor: { kind: 'holder' }, cancelled: false };
const FRESH_CUSTOMER = { ...SAVED_CUSTOMER, monthlyRate: 89, accountCredit: 45 };

const view = () => render(<BrowserRouter><PortalPage /></BrowserRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  localStorage.clear();
  localStorage.setItem('waves_token', TOKEN);
  api.token = TOKEN;
  window.history.replaceState({}, '', '/');
  auth.saved = true;
  auth.customer = SAVED_CUSTOMER;
  api.getSchedule.mockResolvedValue({ upcoming: [] });
  api.getNotificationPrefs.mockResolvedValue({});
  api.getPropertyNotificationPrefs.mockResolvedValue({ properties: [] });
  api.getAutopay.mockResolvedValue({ state: 'disabled', billing_mode: 'monthly_membership' });
  api.getNextService.mockResolvedValue({ next: null });
  api.getBalance.mockResolvedValue({ currentBalance: 120 });
  api.getCards.mockResolvedValue({ cards: [] });
  api.getPayments.mockResolvedValue({ payments: [] });
  api.getServices.mockResolvedValue({ services: [], total: 0 });
  api.getRequests.mockResolvedValue({ requests: [] });
  api.getGoogleReviewCard.mockResolvedValue({ card: null });
  api.getReferrals.mockResolvedValue({ stats: null });
  api.getTodayTracker.mockResolvedValue({ tracker: null });
  api.getDocuments.mockResolvedValue({ documents: [] });
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

describe('saved home screen in the portal', () => {
  it('shows "Updating…" in the header only while the account is saved', async () => {
    const { unmount } = view();
    expect(await screen.findByTestId('portal-updating')).toHaveTextContent('Updating…');
    unmount();
    auth.saved = false;
    auth.customer = FRESH_CUSTOMER;
    view();
    await screen.findByText(/hello pat/i);
    expect(screen.queryByTestId('portal-updating')).not.toBeInTheDocument();
  });

  it('withholds the balance and the pay action on Home even when the live balance already answered', async () => {
    view();
    await screen.findByText(/hello pat/i);
    await waitFor(() => expect(api.getBalance).toHaveBeenCalled());
    expect(screen.queryByText('Pay now')).not.toBeInTheDocument();
    expect(screen.queryByText(/\$120/)).not.toBeInTheDocument();
    expect(screen.queryByText(/NaN|\$0\.00/)).not.toBeInTheDocument();
    const billing = screen.getAllByRole('button').filter((b) => /^billing/i.test(b.textContent.trim()) && !b.closest('nav'));
    expect(billing.length).toBeGreaterThan(0);
    for (const button of billing) expect(button).toBeDisabled();
    expect(screen.getByText('Checking balance').closest('button')).toBeDisabled();
  });

  it('shows the balance and Pay now once fresh data lands', async () => {
    auth.saved = false;
    auth.customer = FRESH_CUSTOMER;
    view();
    expect(await screen.findByText('Pay now')).toBeInTheDocument();
    expect(screen.getByText('Balance due').closest('button')).not.toBeDisabled();
  });

  it('holds the Billing, Plan and Refer tabs behind an updating note and never mounts their money screens', async () => {
    view();
    await screen.findByText(/hello pat/i);
    for (const tab of ['Billing', 'Plan', 'Refer']) {
      fireEvent.click(screen.getAllByRole('button', { name: tab })[0]);
      expect(await screen.findByRole('heading', { name: 'Updating…' })).toBeInTheDocument();
    }
    expect(api.getCards).not.toHaveBeenCalled();
    expect(api.getPayments).not.toHaveBeenCalled();
    expect(screen.queryByText('Payment Methods')).not.toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
  });

  it('keeps Visits and Documents open while saved', async () => {
    view();
    await screen.findByText(/hello pat/i);
    fireEvent.click(screen.getAllByRole('button', { name: 'Visits' })[0]);
    await screen.findByText(/no upcoming services scheduled/i);
    expect(screen.queryByRole('heading', { name: 'Updating…' })).not.toBeInTheDocument();
  });

  it('opens the Billing tab normally on a fresh account', async () => {
    auth.saved = false;
    auth.customer = FRESH_CUSTOMER;
    view();
    await screen.findByText(/hello pat/i);
    fireEvent.click(screen.getAllByRole('button', { name: 'Billing' })[0]);
    await waitFor(() => expect(api.getCards).toHaveBeenCalled());
    expect(screen.queryByRole('heading', { name: 'Updating…' })).not.toBeInTheDocument();
  });

  it('paints the saved next and last visit cards from storage while the loads are still pending', async () => {
    const identity = homeIdentityKey(TOKEN);
    writeHomeRead(identity, 'cust-1', 'next-visit', { next: { id: 'n1', serviceType: 'Saved Next Pest Visit', date: '2026-12-10' }, propertyScope: null }, Date.now() - 1000);
    writeHomeRead(identity, 'cust-1', 'latest-service', { services: [{ id: 'l1', type: 'Saved Last Lawn Visit', date: '2026-11-10' }] }, Date.now() - 1000);
    api.getNextService.mockImplementation(() => new Promise(() => {}));
    api.getServices.mockImplementation(() => new Promise(() => {}));
    view();
    expect(await screen.findByText('Saved Next Pest Visit')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Saved next visit' })).toBeInTheDocument();
    expect(screen.getByText('Saved Last Lawn Visit')).toBeInTheDocument();
  });

  it('does not paint another property\'s saved reads', async () => {
    const identity = homeIdentityKey(TOKEN);
    writeHomeRead(identity, 'cust-1:other-house', 'next-visit', { next: { id: 'n1', serviceType: 'Other House Visit', date: '2026-12-10' } }, Date.now() - 1000);
    api.getNextService.mockImplementation(() => new Promise(() => {}));
    view();
    await screen.findByText(/hello pat/i);
    expect(screen.queryByText('Other House Visit')).not.toBeInTheDocument();
    expect(localStorage.getItem(HOME_READS_KEY) || '').not.toContain('Other House Visit');
  });
});
