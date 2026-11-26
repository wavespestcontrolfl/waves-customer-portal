// @vitest-environment jsdom
// Saved home screen (owner 2026-11-25): while the app shows the last saved
// account (customerSaved) the portal does NOT mount: one small saved view shows
// the profile line, the saved next / last visit cards from storage and
// "Updating…", and makes no request at all. When the account turns fresh the
// normal portal mounts once and every live read starts exactly once.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { BrowserRouter } from 'react-router-dom';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
import { homeIdentityKey, writeHomeRead } from '../lib/homeSnapshot';

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
  const apiCalls = () => Object.entries(api)
    .filter(([, fn]) => typeof fn === 'function' && fn.mock && fn.mock.calls.length > 0)
    .map(([name]) => name);

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

  it('mounts no portal while saved: no request, no tab, no pay or request action, no chat pill, no recommendations', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, json: async () => ({}) });
    api.getPropertyRecommendations.mockResolvedValue({ available: true, oneTap: true, cards: [{ id: 'lawn_offer', kind: 'offer', title: 'Lawn Care', serviceKey: 'lawn_care', mode: 'one_tap', ctaLabel: 'Buy now' }] });
    api.getPortalMessagesUnread.mockResolvedValue({ count: 0 });
    window.history.replaceState({}, '', '/?tab=billing&stripe_setup_flow=one_tap_card&one_tap_resume=r1&setup_intent=seti_1&redirect_status=succeeded');
    view();
    await screen.findByText(/hello pat/i);
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    // The saved view makes no request at all, and nothing completes a SetupIntent return.
    expect(apiCalls()).toEqual([]);
    expect(api.saveStripeCard).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    // And it offers no way to act.
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    for (const name of [/Pay now/, /Billing/, /Refer/, /Request/, /Waves Chat/, /Buy now/, /More/]) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(screen.queryByText('Lawn Care')).not.toBeInTheDocument();
    expect(screen.queryByText(/\$\d/)).not.toBeInTheDocument();
    // Whatever tab the link named, it shows the updating note.
    expect(screen.getByRole('heading', { name: 'Updating…' })).toBeInTheDocument();
  });

  it('starts every live read exactly once when the account turns fresh, and shows Pay now and the Refer amount only then', async () => {
    api.getReferrals.mockResolvedValue({ stats: { total: 1 }, totalEarned: 5000, rewardPerReferral: 25 });
    const { rerender } = view();
    await screen.findByText(/hello pat/i);
    auth.saved = false;
    auth.customer = FRESH_CUSTOMER;
    rerender(<BrowserRouter><PortalPage /></BrowserRouter>);
    expect(await screen.findByText('Pay now')).toBeInTheDocument();
    for (const read of ['getBalance', 'getServiceStats', 'getAutopay', 'getReferrals', 'getGoogleReviewCard']) expect(api[read]).toHaveBeenCalledTimes(1);
    const refer = screen.getAllByRole('button').find((b) => /^refer/i.test(b.textContent.trim()) && !b.closest('nav'));
    await waitFor(() => expect(refer).toHaveTextContent('$25 credit'));
    expect(screen.queryByTestId('portal-updating')).not.toBeInTheDocument();
  });

  it('does not start a read twice on a normal fresh launch', async () => {
    auth.saved = false;
    auth.customer = FRESH_CUSTOMER;
    view();
    await screen.findByText(/hello pat/i);
    await waitFor(() => expect(api.getBalance).toHaveBeenCalled());
    for (const read of ['getBalance', 'getServiceStats', 'getAutopay', 'getReferrals']) expect(api[read]).toHaveBeenCalledTimes(1);
  });

  it('offers the Waves Chat pill only once the account is fresh', async () => {
    api.getPortalMessagesUnread.mockResolvedValue({ count: 0 });
    const { rerender } = view();
    await screen.findByText(/hello pat/i);
    expect(screen.queryByRole('button', { name: /Waves Chat/ })).not.toBeInTheDocument();
    auth.saved = false;
    auth.customer = FRESH_CUSTOMER;
    rerender(<BrowserRouter><PortalPage /></BrowserRouter>);
    expect(await screen.findByRole('button', { name: /Waves Chat/ })).toBeInTheDocument();
  });

  it('paints the saved next and last visit cards from storage with no request', async () => {
    const identity = homeIdentityKey(TOKEN);
    writeHomeRead(identity, 'cust-1', 'next-visit', { next: { id: 'n1', serviceType: 'Saved Next Pest Visit', date: '2026-12-10' }, propertyScope: null }, Date.now() - 1000);
    writeHomeRead(identity, 'cust-1', 'latest-service', { services: [{ id: 'l1', type: 'Saved Last Lawn Visit', date: '2026-11-10' }] }, Date.now() - 1000);
    view();
    expect(await screen.findByText('Saved Next Pest Visit')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Saved next visit' })).toBeInTheDocument();
    expect(screen.getByText('Saved Last Lawn Visit')).toBeInTheDocument();
    expect(apiCalls()).toEqual([]);
  });

  it('does not paint another property\'s saved reads', async () => {
    const identity = homeIdentityKey(TOKEN);
    writeHomeRead(identity, 'cust-1:other-house', 'next-visit', { next: { id: 'n1', serviceType: 'Other House Visit', date: '2026-12-10' } }, Date.now() - 1000);
    view();
    await screen.findByText(/hello pat/i);
    expect(screen.queryByText('Other House Visit')).not.toBeInTheDocument();
    expect(screen.getAllByText('No saved visits are available.')).toHaveLength(2);
  });
});
