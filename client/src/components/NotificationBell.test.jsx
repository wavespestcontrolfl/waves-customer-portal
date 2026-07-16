// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NotificationBell from './NotificationBell';

vi.mock('../lib/push-subscribe.js', () => ({
  ensurePushSubscription: vi.fn(async () => ({ ok: true })),
  isPushEnabled: vi.fn(async () => true),
  syncPushSubscription: vi.fn(async () => ({ ok: true })),
}));

const NOTIFICATIONS = [
  {
    id: 1,
    title: 'Visit completed',
    body: 'Your quarterly pest control visit is done.',
    created_at: new Date().toISOString(),
    read_at: null,
    link: null,
  },
  {
    id: 2,
    title: 'Invoice paid',
    body: 'Thanks! Your payment went through.',
    created_at: new Date().toISOString(),
    read_at: null,
    link: null,
  },
];

function response(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

function defaultFetch(url) {
  if (String(url).includes('/unread-count')) return response({ count: 2 });
  if (String(url).includes('?limit=')) return response({ notifications: NOTIFICATIONS });
  return response({ success: true });
}

let notifyMediaChange;

beforeEach(() => {
  Object.defineProperty(window, 'scrollTo', { value: vi.fn(), writable: true });
  Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true, writable: true });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches: window.innerWidth < 768,
      addEventListener: (_event, listener) => { notifyMediaChange = listener; },
      removeEventListener: vi.fn(),
    })),
  });
  global.fetch = vi.fn(async (url) => defaultFetch(url));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('NotificationBell panel', () => {
  it('portals a labelled modal dialog to body and restores focus after Escape', async () => {
    const { container } = render(<NotificationBell type="customer" customerId="customer-a" />);
    const bell = screen.getByRole('button', { name: /notifications/i });
    bell.focus();

    await act(async () => { fireEvent.click(bell); });

    const dialog = await screen.findByRole('dialog', { name: 'Notifications' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(container.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
    expect(await screen.findByText('Visit completed')).toBeInTheDocument();
    expect(dialog).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Notifications' })).not.toBeInTheDocument());
    expect(bell).toHaveFocus();
  });

  it('keeps the portaled panel open for inside clicks and closes on an outside click', async () => {
    render(<NotificationBell type="customer" customerId="customer-a" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /notifications/i }));
    });
    const title = await screen.findByText('Visit completed');

    fireEvent.mouseDown(title);
    expect(screen.getByRole('dialog', { name: 'Notifications' })).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Notifications' })).not.toBeInTheDocument());
  });

  it('reflows an open drawer when the viewport crosses the mobile breakpoint', async () => {
    render(<NotificationBell type="customer" customerId="customer-a" />);
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }));
    const dialog = await screen.findByRole('dialog', { name: 'Notifications' });
    expect(screen.getByRole('button', { name: 'Close notifications' })).toBeInTheDocument();
    expect(dialog).toHaveStyle({ bottom: '12px' });

    Object.defineProperty(window, 'innerWidth', { value: 500, configurable: true, writable: true });
    act(() => { notifyMediaChange({ matches: true }); });

    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(dialog.style.bottom).toContain('safe-area-inset-bottom');
  });

  it('shows a retryable error instead of claiming an HTTP failure is an empty inbox', async () => {
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('/unread-count')) return response({ error: 'down' }, { ok: false, status: 503 });
      return response({ error: 'down' }, { ok: false, status: 503 });
    });
    render(<NotificationBell type="customer" customerId="customer-a" />);

    fireEvent.click(screen.getByRole('button', { name: /notifications/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByText('No notifications yet')).not.toBeInTheDocument();
  });

  it('supports keyboard activation and never marks a row read after a failed write', async () => {
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('/unread-count')) return response({ count: 2 });
      if (String(url).includes('?limit=')) return response({ notifications: NOTIFICATIONS });
      if (String(url).endsWith('/1/read')) return response({ error: 'down' }, { ok: false, status: 503 });
      return response({ success: true });
    });
    render(<NotificationBell type="customer" customerId="customer-a" />);
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }));

    const row = await screen.findByRole('button', { name: 'Visit completed, unread' });
    fireEvent.keyDown(row, { key: 'Enter' });

    expect(await screen.findByRole('alert')).toHaveTextContent('could not be marked as read');
    expect(screen.getByRole('button', { name: 'Visit completed, unread' })).toBeInTheDocument();
  });

  it('clears property A data before a failed property B reload', async () => {
    let property = 'a';
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('/unread-count')) return response({ count: property === 'a' ? 1 : 0 });
      if (property === 'a') {
        return response({ notifications: [{ ...NOTIFICATIONS[0], title: 'Property A visit' }] });
      }
      return response({ error: 'offline' }, { ok: false, status: 503 });
    });

    const { rerender } = render(<NotificationBell type="customer" customerId="customer-a" />);
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }));
    expect(await screen.findByText('Property A visit')).toBeInTheDocument();

    property = 'b';
    rerender(<NotificationBell type="customer" customerId="customer-b" />);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Notifications' })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
    expect(screen.queryByText('Property A visit')).not.toBeInTheDocument();
  });

  it('ignores a property A mark-read response after switching to property B', async () => {
    let property = 'a';
    let finishOldMark;
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('/unread-count')) return response({ count: property === 'a' ? 2 : 5 });
      if (String(url).includes('?limit=')) {
        return response({ notifications: property === 'a' ? NOTIFICATIONS : [] });
      }
      if (String(url).endsWith('/1/read')) {
        return new Promise((resolve) => { finishOldMark = resolve; });
      }
      return response({ success: true });
    });

    const { rerender } = render(<NotificationBell type="customer" customerId="customer-a" />);
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }));
    const oldRow = await screen.findByRole('button', { name: 'Visit completed, unread' });
    fireEvent.click(oldRow);
    await waitFor(() => expect(finishOldMark).toBeTypeOf('function'));

    property = 'b';
    rerender(<NotificationBell type="customer" customerId="customer-b" />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Notifications (5 unread)' })).toBeInTheDocument());
    await act(async () => { finishOldMark(response({ success: true })); });

    expect(screen.getByRole('button', { name: 'Notifications (5 unread)' })).toBeInTheDocument();
  });
});
