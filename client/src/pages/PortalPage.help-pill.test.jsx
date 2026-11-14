// @vitest-environment jsdom
// Help pill: the one floating pill on the customer portal. With Messages and
// Photo ID both offered it opens a menu (Chat with Waves, Photo ID); with one
// of them it opens that one directly; with neither, or for a cancelled or
// contact session, there is no pill. An unread answer shows on the pill.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { BrowserRouter } from 'react-router-dom';
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Many lanes share this machine; a resolved-mock chain can pass 1000 ms.
configure({ asyncUtilTimeout: 5000 });

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
const messagesOn = (count = 0) => api.getPortalMessagesUnread.mockResolvedValue({ count });
const messagesOff = () => api.getPortalMessagesUnread.mockRejectedValue(notFound());
const photoIdOn = () => api.getPhotoIds.mockResolvedValue({ items: [] });
const photoIdOff = () => api.getPhotoIds.mockRejectedValue(notFound());

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
    unread: 0,
  });
  api.markPortalMessagesRead.mockResolvedValue({ unread: 0 });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.innerWidth = ORIGINAL_INNER_WIDTH;
});

async function renderHome() {
  render(<BrowserRouter><PortalPage /></BrowserRouter>);
  await screen.findByText(/hello pat/i);
}
// The pill once both probes have answered "on": it then opens the menu.
async function openHelpMenu() {
  await renderHome();
  await waitFor(() => expect(api.getPhotoIds).toHaveBeenCalled());
  const pill = await screen.findByRole('button', { name: /^Help/ });
  await waitFor(() => {
    fireEvent.click(pill);
    expect(screen.getByRole('dialog', { name: 'Help' })).toBeInTheDocument();
  });
  return { pill, sheet: screen.getByRole('dialog', { name: 'Help' }) };
}

describe('Help pill with Messages and Photo ID both offered', () => {
  beforeEach(() => { messagesOn(); photoIdOn(); });

  it('opens a menu with Chat with Waves and Photo ID, and hides itself behind the menu', async () => {
    const { pill, sheet } = await openHelpMenu();
    expect(within(sheet).getByText('How can we help?')).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: /Chat with Waves/ })).toHaveTextContent('We answer between 8 AM and 8 PM');
    expect(within(sheet).getByRole('button', { name: /Photo ID/ })).toBeInTheDocument();
    expect(pill).toHaveAttribute('hidden');
    // No pill named for Photo ID alone is left on the page.
    expect(screen.queryByRole('button', { name: /^Photo ID/ })).toBe(within(sheet).getByRole('button', { name: /Photo ID/ }));

    fireEvent.click(within(sheet).getByRole('button', { name: 'Close help menu' }));
    expect(screen.queryByRole('dialog', { name: 'Help' })).toBeNull();
    expect(pill).not.toHaveAttribute('hidden');
  });

  it('Chat with Waves opens the Messages page, where the pill stays hidden', async () => {
    const { pill, sheet } = await openHelpMenu();
    fireEvent.click(within(sheet).getByRole('button', { name: /Chat with Waves/ }));
    expect(await screen.findByText('Your visit is set for Thursday.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Messages' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Help' })).toBeNull();
    expect(window.location.search).toBe('?tab=messages');
    expect(pill).toHaveAttribute('hidden');
  });

  it('Photo ID opens the Photo ID sheet', async () => {
    const { sheet } = await openHelpMenu();
    fireEvent.click(within(sheet).getByRole('button', { name: /Photo ID/ }));
    expect(await screen.findByRole('dialog', { name: 'Photo ID' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Help' })).toBeNull();
  });

  it('shows an unread answer on the pill and on the Chat row', async () => {
    messagesOn(2);
    await renderHome();
    const pill = await screen.findByRole('button', { name: 'Help, 2 unread messages' });
    await waitFor(() => {
      fireEvent.click(pill);
      expect(screen.getByRole('dialog', { name: 'Help' })).toBeInTheDocument();
    });
    const chat = within(screen.getByRole('dialog', { name: 'Help' })).getByRole('button', { name: /Chat with Waves/ });
    expect(within(chat).getByLabelText('2 unread messages')).toHaveTextContent('2');
  });
});

describe('Help pill with one feature, or none', () => {
  it('opens Photo ID directly when Messages is off', async () => {
    messagesOff(); photoIdOn();
    await renderHome();
    await waitFor(() => expect(api.getPortalMessagesUnread).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: 'Help' }));
    expect(await screen.findByRole('dialog', { name: 'Photo ID' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Help' })).toBeNull();
  });

  it('opens Messages directly when Photo ID is off', async () => {
    messagesOn(); photoIdOff();
    await renderHome();
    await waitFor(() => expect(api.getPhotoIds).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: 'Help' }));
    expect(await screen.findByRole('heading', { name: 'Messages' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Help' })).toBeNull();
  });

  it('is not on the page when neither is offered', async () => {
    messagesOff(); photoIdOff();
    await renderHome();
    await waitFor(() => expect(api.getPortalMessagesUnread).toHaveBeenCalled());
    await waitFor(() => expect(api.getPhotoIds).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /^Help/ })).toBeNull();
  });

  it('is not on the page for a cancelled account or a contact session', async () => {
    messagesOn(3); photoIdOn();
    auth.customer = { ...holder, cancelled: true, cancelledAt: '2026-08-22' };
    const first = render(<BrowserRouter><PortalPage /></BrowserRouter>);
    await screen.findByRole('button', { name: /^More$/ });
    expect(screen.queryByRole('button', { name: /^Help/ })).toBeNull();
    first.unmount();

    auth.customer = { ...holder, actor: { kind: 'contact', slot: 1, name: 'Sam', phone: '+19415550202' } };
    render(<BrowserRouter><PortalPage /></BrowserRouter>);
    await screen.findByRole('button', { name: /^More$/ });
    expect(screen.queryByRole('button', { name: /^Help/ })).toBeNull();
    expect(api.getPortalMessagesUnread).not.toHaveBeenCalled();
    expect(api.getPhotoIds).not.toHaveBeenCalled();
  });
});
