// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NotificationBell from './NotificationBell';

const native = vi.hoisted(() => ({ enabled: false, locked: false, request: vi.fn(), connection: vi.fn() }));
vi.mock('../native/nativePush.js', () => ({
  isNativeApp: () => native.enabled,
  requestNativePushPermission: native.request,
  nativePushConnectionState: native.connection,
}));
vi.mock('./BiometricGate', () => ({ useBiometricLock: () => native.locked }));

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

function jsonResponse(body) {
  return { ok: true, json: async () => body };
}

beforeEach(() => {
  native.enabled = false;
  native.locked = false;
  native.request.mockReset().mockResolvedValue('granted');
  native.connection.mockReset().mockResolvedValue('granted');
  global.fetch = vi.fn(async (url) => {
    if (String(url).includes('/unread-count')) return jsonResponse({ count: 2 });
    return jsonResponse({ notifications: NOTIFICATIONS });
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('NotificationBell panel', () => {
  it('requests the native permission popup automatically after biometric unlock, once per mount', async () => {
    native.enabled = true;
    native.locked = true;
    const { rerender } = render(<NotificationBell type="customer" />);
    expect(native.request).not.toHaveBeenCalled();

    native.locked = false;
    rerender(<NotificationBell type="customer" />);
    await waitFor(() => expect(native.request).toHaveBeenCalledTimes(1));

    native.locked = true;
    rerender(<NotificationBell type="customer" />);
    native.locked = false;
    rerender(<NotificationBell type="customer" />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /notifications/i })); });
    expect(native.request).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Enable push' })).toBeNull();
  });

  it('keeps Settings guidance available after a saved denial', async () => {
    native.enabled = true;
    native.request.mockResolvedValue('denied');
    native.connection.mockResolvedValue('denied');
    render(<NotificationBell type="customer" />);
    await waitFor(() => expect(native.request).toHaveBeenCalledTimes(1));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /notifications/i })); });
    expect(screen.getByText('Notifications are off. Enable them for Waves in your device Settings, then try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enable push' })).toBeEnabled();
    expect(native.request).toHaveBeenCalledTimes(1);
  });

  it.each([['customer', false], ['admin', true]])('does not request native permission for %s when native=%s', async (type, enabled) => {
    native.enabled = enabled;
    render(<NotificationBell type={type} />);
    await act(async () => {});
    expect(native.request).not.toHaveBeenCalled();
  });

  it('portals the open panel to document.body so a glass (backdrop-filter) header cannot become its containing block', async () => {
    // Regression: the customer portal header is a glass surface whose
    // backdrop-filter makes it the containing block for position:fixed
    // descendants. Rendered in place, the panel collapsed to the header's
    // box and the notification list was invisible (issue: empty panel).
    const { container } = render(<NotificationBell type="customer" />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /notifications/i }));
    });

    const items = await screen.findAllByText('Visit completed');
    expect(items.length).toBeGreaterThan(0);

    // The list must NOT be nested inside the bell wrapper (which lives in
    // the header) — it must mount under document.body via the portal.
    for (const el of items) {
      expect(container.contains(el)).toBe(false);
      expect(document.body.contains(el)).toBe(true);
    }
  });

  it('keeps the panel open when clicking inside the portaled panel, and closes on outside click', async () => {
    render(<NotificationBell type="customer" />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /notifications/i }));
    });
    const title = (await screen.findAllByText('Visit completed'))[0];

    // Click inside the portaled panel — must stay open.
    await act(async () => {
      fireEvent.mouseDown(title);
    });
    expect(screen.getAllByText('Visit completed').length).toBeGreaterThan(0);

    // Click outside (document body) — must close.
    await act(async () => {
      fireEvent.mouseDown(document.body);
    });
    expect(screen.queryByText('Visit completed')).toBeNull();
  });
});
