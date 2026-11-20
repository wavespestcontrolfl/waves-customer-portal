// @vitest-environment jsdom
// Waves Chat pill: the one floating pill on the customer portal. With
// Messages offered it opens the Waves Chat sheet, the customer's thread with
// the office, with the message box ready; with Messages off, or for a
// cancelled or contact session, there is no pill. Photo ID is not behind it.
// An unread answer shows on the pill.
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

const auth = vi.hoisted(() => ({ customer: null, epoch: 0 }));
vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({
    sessionEpoch: auth.epoch,
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
  auth.epoch = 0;
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
async function openChat() {
  await renderHome();
  const pill = await screen.findByRole('button', { name: /^Waves Chat/ });
  pill.focus(); // a real tap or key press focuses the pill first
  fireEvent.click(pill);
  return { pill, sheet: await screen.findByRole('dialog', { name: 'Waves Chat' }) };
}

describe('Waves Chat pill with Messages offered', () => {
  beforeEach(() => { messagesOn(); photoIdOn(); });

  it('opens the thread in a sheet with no menu, and closing returns focus to the pill', async () => {
    const { pill, sheet } = await openChat();
    expect(await within(sheet).findByText('Your visit is set for Thursday.')).toBeInTheDocument();
    expect(within(sheet).getByRole('heading', { name: 'Waves Chat' })).toBeInTheDocument();
    expect(within(sheet).getByRole('textbox', { name: 'Message Waves' })).toBeInTheDocument();
    // Photo ID is not offered from the pill, and the page behind stays where it was.
    expect(within(sheet).queryByText(/Photo ID/)).toBeNull();
    expect(window.location.search).toBe('');

    fireEvent.click(within(sheet).getByRole('button', { name: 'Close chat' }));
    expect(screen.queryByRole('dialog', { name: 'Waves Chat' })).toBeNull();
    expect(pill).toHaveFocus();
  });

  it('sends what the customer types and shows it in the thread', async () => {
    api.sendPortalMessage.mockResolvedValue({
      message: { id: 'y1', from: 'you', body: 'Can you come Friday?', createdAt: '2026-11-03T16:10:00.000Z' },
    });
    const { sheet } = await openChat();
    const box = await within(sheet).findByRole('textbox', { name: 'Message Waves' });
    const send = within(sheet).getByRole('button', { name: 'Send message' });
    expect(send).toBeDisabled();
    fireEvent.change(box, { target: { value: 'Can you come Friday?' } });
    fireEvent.click(send);
    expect(await within(sheet).findByText('Can you come Friday?')).toBeInTheDocument();
    expect(api.sendPortalMessage).toHaveBeenCalledWith('Can you come Friday?', expect.any(String));
    await waitFor(() => expect(box).toHaveValue(''));
  });

  it('a new chat offers starters that fill the message box without sending', async () => {
    api.getPortalMessages.mockResolvedValue({ messages: [], hasMore: false, unread: 0 });
    const { sheet } = await openChat();
    expect(await within(sheet).findByText('Hi Pat, what can we help with?')).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Pest, lawn or plant problem' }));
    const box = within(sheet).getByRole('textbox', { name: 'Message Waves' });
    expect(box).toHaveValue('I have a pest, lawn or plant problem: ');
    expect(box).toHaveFocus();
    expect(api.sendPortalMessage).not.toHaveBeenCalled();
  });

  it('a session switch while the sheet is open reloads the thread and drops the draft', async () => {
    const view = render(<BrowserRouter><PortalPage /></BrowserRouter>);
    await screen.findByText(/hello pat/i);
    fireEvent.click(await screen.findByRole('button', { name: /^Waves Chat/ }));
    const before = await screen.findByRole('dialog', { name: 'Waves Chat' });
    await within(before).findByText('Your visit is set for Thursday.');
    fireEvent.change(within(before).getByRole('textbox', { name: 'Message Waves' }), { target: { value: 'For the first account' } });

    api.getPortalMessages.mockResolvedValue({
      messages: [{ id: 'w9', from: 'waves', body: 'Second account thread.', createdAt: '2026-11-03T17:00:00.000Z' }],
      hasMore: false,
      unread: 0,
    });
    auth.epoch = 1;
    view.rerender(<BrowserRouter><PortalPage /></BrowserRouter>);
    const after = await screen.findByRole('dialog', { name: 'Waves Chat' });
    expect(await within(after).findByText('Second account thread.')).toBeInTheDocument();
    expect(within(after).queryByText('Your visit is set for Thursday.')).toBeNull();
    expect(within(after).getByRole('textbox', { name: 'Message Waves' })).toHaveValue('');
  });

  it('shows an unread answer on the pill and clears it once the sheet has shown it', async () => {
    messagesOn(2);
    await renderHome();
    const pill = await screen.findByRole('button', { name: 'Waves Chat, 2 unread messages' });
    fireEvent.click(pill);
    await waitFor(() => expect(api.markPortalMessagesRead).toHaveBeenCalledWith('w1'));
    await waitFor(() => expect(pill).toHaveAccessibleName('Waves Chat'));
  });
});

describe('Waves Chat pill without Messages', () => {
  it('is not on the page when Messages is off, even with Photo ID offered', async () => {
    messagesOff(); photoIdOn();
    await renderHome();
    await waitFor(() => expect(api.getPortalMessagesUnread).toHaveBeenCalled());
    await waitFor(() => expect(api.getPhotoIds).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /^Waves Chat/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Help/ })).toBeNull();
  });

  it('is not on the page for a cancelled account or a contact session', async () => {
    messagesOn(3); photoIdOn();
    auth.customer = { ...holder, cancelled: true, cancelledAt: '2026-08-22' };
    const first = render(<BrowserRouter><PortalPage /></BrowserRouter>);
    await screen.findByRole('button', { name: /^More$/ });
    expect(screen.queryByRole('button', { name: /^Waves Chat/ })).toBeNull();
    first.unmount();

    auth.customer = { ...holder, actor: { kind: 'contact', slot: 1, name: 'Sam', phone: '+19415550202' } };
    render(<BrowserRouter><PortalPage /></BrowserRouter>);
    await screen.findByRole('button', { name: /^More$/ });
    expect(screen.queryByRole('button', { name: /^Waves Chat/ })).toBeNull();
    expect(api.getPortalMessagesUnread).not.toHaveBeenCalled();
    expect(api.getPhotoIds).not.toHaveBeenCalled();
  });
});
