// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NotificationBell from './NotificationBell';
import api from '../utils/api';

const native = vi.hoisted(() => ({ enabled: false, locked: false, request: vi.fn(), connection: vi.fn() }));
const badge = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock('../native/nativeBadge', () => ({
  captureNativeBadgeUpdate: () => badge.write,
  clearNativeBadge: vi.fn(),
}));
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
  badge.write.mockReset().mockResolvedValue(true);
  global.fetch = vi.fn(async (url) => {
    if (String(url).includes('/push/status')) return jsonResponse({ available: true });
    if (String(url).includes('/unread-count')) return jsonResponse({ count: 2 });
    return jsonResponse({ notifications: NOTIFICATIONS });
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('NotificationBell panel', () => {
  it.each([390, 1280])('lets admins read an older refreshed alert on a %ipx screen', async (width) => {
    const previousWidth = window.innerWidth;
    window.innerWidth = width;
    const recent = Array.from({ length: 30 }, (_, i) => ({ ...NOTIFICATIONS[0], id: `recent-${i}`, title: `Recent alert ${i}`, read_at: new Date().toISOString() }));
    const older = { ...NOTIFICATIONS[0], id: 'older-refreshed', title: 'Updated restock alert', created_at: '2026-09-01T12:00:00Z' };
    global.fetch = vi.fn(async (url, options) => {
      if (String(url).includes('/unread-count')) return jsonResponse({ count: 1 });
      if (options?.method === 'PUT') return jsonResponse({ success: true });
      if (String(url).includes('page=2')) return jsonResponse({ notifications: [recent[29], older], hasMore: false });
      return jsonResponse({ notifications: recent, hasMore: true });
    });
    try {
      render(<NotificationBell type="admin" />);
      fireEvent.click(screen.getByRole('button', { name: /notifications/i }));
      fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
      const alert = await screen.findByText('Updated restock alert');
      expect(screen.getAllByText('Recent alert 29')).toHaveLength(1);
      expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
      fireEvent.click(alert);
      await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/api/admin/notifications/older-refreshed/read', expect.objectContaining({ method: 'PUT' })));
    } finally {
      window.innerWidth = previousWidth;
    }
  });

  it('preserves loaded alerts and retries the same older page after a failure', async () => {
    let attempts = 0;
    global.fetch = vi.fn(async url => {
      if (String(url).includes('/unread-count')) return jsonResponse({ count: 2 });
      if (String(url).includes('page=2')) {
        if (++attempts === 1) return { ok: false, status: 503 };
        return jsonResponse({ notifications: [{ ...NOTIFICATIONS[1], id: 3, title: 'Older alert' }], hasMore: false });
      }
      return jsonResponse({ notifications: NOTIFICATIONS, hasMore: true });
    });
    render(<NotificationBell type="admin" />);
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Older notifications couldn't be loaded.");
    expect(screen.getByText('Visit completed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Older alert')).toBeInTheDocument();
    expect(attempts).toBe(2);
  });


  it('refetches the authoritative badge after marking one notification read', async () => {
    native.enabled = true;
    let count = 2;
    global.fetch.mockImplementation(async url => {
      if (String(url).includes('/1/read')) { count = 1; return jsonResponse({ success: true }); }
      if (String(url).includes('/unread-count')) return jsonResponse({ count, nativeBadgeEnabled: true });
      return jsonResponse({ notifications: NOTIFICATIONS });
    });
    render(<NotificationBell type="customer" />);
    await waitFor(() => expect(badge.write).toHaveBeenLastCalledWith(2));
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }));
    fireEvent.click((await screen.findAllByText('Visit completed'))[0]);
    await waitFor(() => expect(badge.write).toHaveBeenLastCalledWith(1));
  });

  it('syncs the customer badge after a confirmed read-all and a native resume event', async () => {
    native.enabled = true;
    let count = 2;
    global.fetch.mockImplementation(async url => {
      if (String(url).includes('/read-all')) { count = 0; return jsonResponse({ success: true }); }
      if (String(url).includes('/unread-count')) return jsonResponse({ count, nativeBadgeEnabled: true });
      return jsonResponse({ notifications: NOTIFICATIONS });
    });
    render(<NotificationBell type="customer" />);
    await waitFor(() => expect(badge.write).toHaveBeenLastCalledWith(2));
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }));
    fireEvent.click(await screen.findByRole('button', { name: /mark all read/i }));
    await waitFor(() => expect(badge.write).toHaveBeenLastCalledWith(0));
    count = 4;
    act(() => window.dispatchEvent(new Event('waves:native-notification')));
    await waitFor(() => expect(badge.write).toHaveBeenLastCalledWith(4));
  });

  it.each([
    [{ count: 3, nativeBadgeEnabled: false }, 0],
    [{ count: 3 }, null],
    [{ nativeBadgeEnabled: true }, null],
    [{ count: -1, nativeBadgeEnabled: true }, null],
  ])('respects the gate and count contract: %j', async (response, expected) => {
    native.enabled = true;
    global.fetch.mockResolvedValue(jsonResponse(response));
    render(<NotificationBell type="customer" />);
    await act(async () => {});
    if (expected === null) expect(badge.write).not.toHaveBeenCalled();
    else expect(badge.write).toHaveBeenCalledWith(expected);
  });

  it('does not clear a badge on a failed read or unread-count request', async () => {
    native.enabled = true;
    global.fetch.mockImplementation(async url => {
      if (String(url).includes('/unread-count')) return jsonResponse({ count: 2, nativeBadgeEnabled: true });
      if (String(url).includes('/read-all')) throw new Error('offline');
      return jsonResponse({ notifications: NOTIFICATIONS });
    });
    render(<NotificationBell type="customer" />);
    await waitFor(() => expect(badge.write).toHaveBeenCalledWith(2));
    badge.write.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }));
    fireEvent.click(await screen.findByRole('button', { name: /mark all read/i }));
    global.fetch.mockRejectedValue(new Error('offline'));
    act(() => window.dispatchEvent(new Event('waves:native-notification')));
    await act(async () => {});
    expect(badge.write).not.toHaveBeenCalled();
  });

  it('ignores a late poll after a newer count, and responses after unmount', async () => {
    native.enabled = true;
    let finish;
    global.fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    global.fetch.mockResolvedValue(jsonResponse({ count: 1, nativeBadgeEnabled: true }));
    const { unmount } = render(<NotificationBell type="customer" />);
    act(() => window.dispatchEvent(new Event('waves:native-notification')));
    await waitFor(() => expect(badge.write).toHaveBeenCalledWith(1));
    await act(async () => { finish(jsonResponse({ count: 8, nativeBadgeEnabled: true })); });
    expect(badge.write).toHaveBeenCalledTimes(1);
    global.fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    act(() => window.dispatchEvent(new Event('waves:native-notification')));
    unmount();
    await act(async () => { finish(jsonResponse({ count: 9, nativeBadgeEnabled: true })); });
    expect(badge.write).toHaveBeenCalledTimes(1);
  });

  it('never sends an admin count to the customer native badge', async () => {
    global.fetch.mockResolvedValue(jsonResponse({ count: 3, nativeBadgeEnabled: true }));
    render(<NotificationBell type="admin" />);
    await act(async () => {});
    expect(badge.write).not.toHaveBeenCalled();
  });

  it('ignores a response when credentials changed before the component unmounted', async () => {
    native.enabled = true;
    const previousToken = api.token;
    let finish;
    global.fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    try {
      api.token = 'fixture-old-session';
      render(<NotificationBell type="customer" />);
      api.token = 'fixture-new-session';
      await act(async () => { finish(jsonResponse({ count: 9, nativeBadgeEnabled: true })); });
      expect(badge.write).not.toHaveBeenCalled();
    } finally {
      api.token = previousToken;
    }
  });

  it('leaves the customer web badge alone even when the native gate is enabled', async () => {
    global.fetch.mockResolvedValue(jsonResponse({ count: 3, nativeBadgeEnabled: true }));
    render(<NotificationBell type="customer" />);
    await act(async () => {});
    expect(badge.write).not.toHaveBeenCalled();
  });

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

  it.each([false, undefined])('does not auto-prompt when server availability is %s', async (available) => {
    native.enabled = true;
    global.fetch.mockImplementation(async () => jsonResponse({ available }));
    render(<NotificationBell type="customer" />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/push/status'), expect.anything()));
    await act(async () => {});
    expect(native.request).not.toHaveBeenCalled();
  });

  it('fails closed when the server availability read fails', async () => {
    native.enabled = true;
    global.fetch.mockRejectedValue(new Error('offline'));
    render(<NotificationBell type="customer" />);
    await act(async () => {});
    expect(native.request).not.toHaveBeenCalled();
  });

  it('ignores an availability response that arrives after biometric relock', async () => {
    native.enabled = true;
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    global.fetch.mockImplementation(async url => String(url).includes('/push/status') ? pending : jsonResponse({ count: 0 }));
    const { rerender } = render(<NotificationBell type="customer" />);
    native.locked = true;
    rerender(<NotificationBell type="customer" />);
    await act(async () => { finish(jsonResponse({ available: true })); });
    expect(native.request).not.toHaveBeenCalled();
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

describe('NotificationBell admin mobile panel offsets (UI audit F0034)', () => {
  it('sits flush under the 52px admin top bar and above the 56px tab bar', async () => {
    const original = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    try {
      render(<NotificationBell type="admin" />);
      fireEvent.click(screen.getByRole('button', { name: /notifications/i }));
      const panel = await screen.findByRole('dialog', { name: 'Notifications' });
      // jsdom re-serialises env() oddly, so assert the constant term only.
      expect(panel.style.top).toMatch(/^calc\(52px \+ env\(/);
      expect(panel.style.bottom).toMatch(/^calc\(56px \+ env\(/);
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: original });
    }
  });
});
