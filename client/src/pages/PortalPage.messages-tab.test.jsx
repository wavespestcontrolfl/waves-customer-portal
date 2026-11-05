// @vitest-environment jsdom
// Customer Messages tab (dark behind a server gate): the tab is probed with
// GET /portal-messages/unread-count once the customer is loaded, listed in More
// only on a 200, badged when something is unread, never probed for a contact
// or cancelled session, and a ?tab=messages deep link opens it only when on.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { BrowserRouter } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Any api method not explicitly mocked returns a forever-pending promise, so
// untested widgets sit in their loading states instead of crashing the render.
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

const auth = vi.hoisted(() => ({ customer: null }));
vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({
    sessionEpoch: 0,
    customer: auth.customer,
    logout: vi.fn(),
    properties: [],
    propertiesError: null,
    refreshProperties: vi.fn(),
    switchProperty: vi.fn(),
  }),
  tokenCustomerId: () => 'cust-1',
}));

import api from '../utils/api';
import PortalPage from './PortalPage';

const ORIGINAL_INNER_WIDTH = window.innerWidth;
const holder = {
  id: 'cust-1', firstName: 'Pat', lastName: 'Customer',
  phone: '9415551234', email: 'pat@example.com', tier: 'Gold',
  monthlyRate: 89, property: {},
};
const notFound = () => Object.assign(new Error('Not found'), { status: 404 });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  window.history.replaceState({}, '', '/');
  window.innerWidth = 360; // useIsMobile reads innerWidth on mount
  auth.customer = holder;
  api.getSchedule.mockResolvedValue({ upcoming: [] });
  api.getNotificationPrefs.mockResolvedValue({});
  api.getAutopay.mockResolvedValue({ state: 'disabled' });
  api.getNextService.mockResolvedValue({ next: null });
  api.getBalance.mockResolvedValue({ currentBalance: 0 });
  api.getServices.mockResolvedValue({ services: [], total: 0 });
  api.getRequests.mockResolvedValue({ requests: [] });
  api.getReferrals.mockResolvedValue({ stats: null });
  api.getTodayTracker.mockResolvedValue({ tracker: null });
  api.getPortalMessages.mockResolvedValue({
    messages: [{ id: 'w1', from: 'waves', body: 'Your visit is set for Thursday.', createdAt: '2026-11-03T16:05:00.000Z' }],
    hasMore: false,
    unread: 1,
  });
  api.markPortalMessagesRead.mockResolvedValue({ unread: 0 });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.innerWidth = ORIGINAL_INNER_WIDTH;
});

async function openMore() {
  render(<BrowserRouter><PortalPage /></BrowserRouter>);
  await screen.findByText(/hello pat/i);
  fireEvent.click(screen.getByRole('button', { name: /^More/ }));
  return screen.findByRole('dialog', { name: 'More navigation' });
}

describe('PortalPage Messages tab', () => {
  it('is not listed in More when the probe answers 404', async () => {
    api.getPortalMessagesUnread.mockRejectedValue(notFound());
    const sheet = await openMore();
    await waitFor(() => expect(api.getPortalMessagesUnread).toHaveBeenCalled());
    expect(within(sheet).getByRole('button', { name: /Documents/ })).toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: /Messages/ })).toBeNull();
  });

  it('stays hidden when the probe fails some other way', async () => {
    api.getPortalMessagesUnread.mockRejectedValue(new Error('offline'));
    const sheet = await openMore();
    await waitFor(() => expect(api.getPortalMessagesUnread).toHaveBeenCalled());
    expect(within(sheet).queryByRole('button', { name: /Messages/ })).toBeNull();
  });

  it('is listed in More on a 200 without a dot or count at zero', async () => {
    api.getPortalMessagesUnread.mockResolvedValue({ count: 0 });
    const sheet = await openMore();
    expect(await within(sheet).findByRole('button', { name: /Messages/ })).toBeInTheDocument();
    expect(screen.queryByLabelText(/unread message/)).toBeNull();
  });

  it('shows a dot on More and a count on the Messages row when something is unread', async () => {
    api.getPortalMessagesUnread.mockResolvedValue({ count: 1 });
    render(<BrowserRouter><PortalPage /></BrowserRouter>);
    await screen.findByText(/hello pat/i);
    const more = await screen.findByRole('button', { name: /1 unread message.*More/ });
    fireEvent.click(more);
    const sheet = await screen.findByRole('dialog', { name: 'More navigation' });
    const row = await within(sheet).findByRole('button', { name: /Messages/ });
    expect(within(row).getByLabelText('1 unread message')).toHaveTextContent('1');
  });

  it('opens the page from More and clears the count once the thread is read', async () => {
    api.getPortalMessagesUnread.mockResolvedValue({ count: 1 });
    render(<BrowserRouter><PortalPage /></BrowserRouter>);
    await screen.findByText(/hello pat/i);
    fireEvent.click(await screen.findByRole('button', { name: /1 unread message.*More/ }));
    const sheet = await screen.findByRole('dialog', { name: 'More navigation' });
    fireEvent.click(await within(sheet).findByRole('button', { name: /Messages/ }));
    expect(await screen.findByText('Your visit is set for Thursday.')).toBeInTheDocument();
    await waitFor(() => expect(api.markPortalMessagesRead).toHaveBeenCalledWith('w1'));
    await waitFor(() => expect(screen.getByRole('button', { name: /^More$/ })).toBeInTheDocument());
    expect(window.location.search).toBe('?tab=messages');
  });

  it('is not probed and not listed for a contact session', async () => {
    auth.customer = { ...holder, actor: { kind: 'contact', slot: 1, name: 'Sam', phone: '+19415550202' } };
    api.getPortalMessagesUnread.mockResolvedValue({ count: 4 });
    render(<BrowserRouter><PortalPage /></BrowserRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /^More$/ }));
    const sheet = await screen.findByRole('dialog', { name: 'More navigation' });
    expect(within(sheet).queryByRole('button', { name: /Messages/ })).toBeNull();
    expect(api.getPortalMessagesUnread).not.toHaveBeenCalled();
  });

  it('is not probed and not listed for a cancelled account', async () => {
    auth.customer = { ...holder, cancelled: true, cancelledAt: '2026-08-22' };
    api.getPortalMessagesUnread.mockResolvedValue({ count: 4 });
    render(<BrowserRouter><PortalPage /></BrowserRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /^More$/ }));
    const sheet = await screen.findByRole('dialog', { name: 'More navigation' });
    expect(within(sheet).queryByRole('button', { name: /Messages/ })).toBeNull();
    expect(api.getPortalMessagesUnread).not.toHaveBeenCalled();
  });

  it('?tab=messages opens the page when it is on', async () => {
    window.history.replaceState({}, '', '/?tab=messages');
    api.getPortalMessagesUnread.mockResolvedValue({ count: 1 });
    render(<BrowserRouter><PortalPage /></BrowserRouter>);
    expect(await screen.findByText('Your visit is set for Thursday.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Messages' })).toBeInTheDocument();
    expect(window.location.search).toBe('?tab=messages');
  });

  it('?tab=messages falls back to Home when it is off', async () => {
    window.history.replaceState({}, '', '/?tab=messages');
    api.getPortalMessagesUnread.mockRejectedValue(notFound());
    render(<BrowserRouter><PortalPage /></BrowserRouter>);
    expect(await screen.findByText(/hello pat/i)).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(screen.queryByRole('heading', { name: 'Messages' })).toBeNull();
    // A deep link renders the page before the probe answers (so a push tap never shows a blank page); once the
    // server says off, it falls back home. At most that one thread read went out.
    expect(api.getPortalMessages.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
