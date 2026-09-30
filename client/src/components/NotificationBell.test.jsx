// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NotificationBell, { _test } from './NotificationBell';
import api from '../utils/api';
import { CUSTOMER_SURFACE } from '../theme-customer';

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
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 240 });
  window.scrollTo = vi.fn();
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
  localStorage.removeItem('waves_admin_token');
});

describe('NotificationBell panel', () => {
  it('links admin-role staff to the notification settings tab, and never technicians or customers', async () => {
    const staffToken = (role) => `h.${btoa(JSON.stringify({ role })).replace(/=+$/, '')}.s`;
    try {
      localStorage.setItem('waves_admin_token', staffToken('admin'));
      render(<NotificationBell type="admin" />);
      fireEvent.click(screen.getByRole('button', { name: /notifications/i }));
      const link = await screen.findByRole('link', { name: /notification settings/i });
      // CommunicationsPageV2 reads the hash as #tab=<name>; the per-event
      // bell/push toggles are the "notifications" tab (PushSettingsV2),
      // which that page hides from non-admin roles.
      expect(link).toHaveAttribute('href', '/admin/communications#tab=notifications');
      cleanup();
      // AdminLayoutV2 mounts the same bell (type 'admin') for technicians.
      localStorage.setItem('waves_admin_token', staffToken('technician'));
      render(<NotificationBell type="admin" />);
      fireEvent.click(screen.getByRole('button', { name: /notifications/i }));
      await screen.findByRole('dialog');
      expect(screen.queryByRole('link', { name: /notification settings/i })).toBeNull();
      cleanup();
      render(<NotificationBell type="customer" customerId="cust-1" />);
      fireEvent.click(screen.getByRole('button', { name: /notifications/i }));
      await screen.findByRole('dialog');
      expect(screen.queryByRole('link', { name: /notification settings/i })).toBeNull();
    } finally {
      localStorage.removeItem('waves_admin_token');
    }
  });

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

  it('refreshes the admin count on resume, SMS changes, and visible service-worker pushes', async () => {
    const serviceWorker = new EventTarget();
    const serviceWorkerDescriptor = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
    const visibilityDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: serviceWorker });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    let countRequests = 0;
    global.fetch.mockImplementation(async url => {
      if (String(url).includes('/unread-count')) {
        countRequests += 1;
        return jsonResponse({ count: countRequests });
      }
      return jsonResponse({ notifications: NOTIFICATIONS });
    });

    try {
      render(<NotificationBell type="admin" />);
      await waitFor(() => expect(countRequests).toBe(1));

      act(() => document.dispatchEvent(new Event('visibilitychange')));
      await waitFor(() => expect(countRequests).toBe(2));

      act(() => window.dispatchEvent(new Event('waves:sms-unread-changed')));
      await waitFor(() => expect(countRequests).toBe(3));

      act(() => serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'waves:push-received' } })));
      await waitFor(() => expect(countRequests).toBe(4));

      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      act(() => serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'waves:push-received' } })));
      await act(async () => {});
      expect(countRequests).toBe(4);
    } finally {
      if (serviceWorkerDescriptor) Object.defineProperty(navigator, 'serviceWorker', serviceWorkerDescriptor);
      else delete navigator.serviceWorker;
      if (visibilityDescriptor) Object.defineProperty(document, 'visibilityState', visibilityDescriptor);
      else delete document.visibilityState;
    }
  });

  it('does not let an older admin poll replace newer push badge state', async () => {
    const setAppBadge = vi.fn();
    const clearAppBadge = vi.fn();
    const badgeCache = {
      match: vi.fn(async () => ({ json: async () => ({ seq: 200, count: 9 }) })),
      put: vi.fn(),
    };
    const cachesDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'caches');
    const setBadgeDescriptor = Object.getOwnPropertyDescriptor(navigator, 'setAppBadge');
    const clearBadgeDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clearAppBadge');
    const locksDescriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(globalThis, 'caches', { configurable: true, value: { open: vi.fn(async () => badgeCache) } });
    Object.defineProperty(navigator, 'setAppBadge', { configurable: true, value: setAppBadge });
    Object.defineProperty(navigator, 'clearAppBadge', { configurable: true, value: clearAppBadge });
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request: vi.fn(async (_name, apply) => apply()) },
    });
    localStorage.setItem('waves_admin_token', `header.${btoa(JSON.stringify({ role: 'admin' }))}.signature`);
    let pollAt = 100;
    global.fetch.mockImplementation(async url => {
      if (String(url).includes('/unread-count')) return jsonResponse({ count: 2, at: pollAt });
      return jsonResponse({ notifications: NOTIFICATIONS });
    });

    try {
      render(<NotificationBell type="admin" />);
      await waitFor(() => expect(badgeCache.match).toHaveBeenCalledWith('/__badge-seq'));
      await act(async () => {});
      expect(badgeCache.put).not.toHaveBeenCalled();
      expect(setAppBadge).not.toHaveBeenCalled();
      expect(clearAppBadge).not.toHaveBeenCalled();

      pollAt = 300;
      act(() => window.dispatchEvent(new Event('waves:sms-unread-changed')));
      await waitFor(() => expect(setAppBadge).toHaveBeenCalledWith(2));
      expect(badgeCache.put).toHaveBeenCalledWith('/__badge-seq', expect.any(Response));
      expect(await badgeCache.put.mock.calls[0][1].json()).toEqual({ seq: 300, count: 2 });
    } finally {
      if (cachesDescriptor) Object.defineProperty(globalThis, 'caches', cachesDescriptor);
      else delete globalThis.caches;
      if (setBadgeDescriptor) Object.defineProperty(navigator, 'setAppBadge', setBadgeDescriptor);
      else delete navigator.setAppBadge;
      if (clearBadgeDescriptor) Object.defineProperty(navigator, 'clearAppBadge', clearBadgeDescriptor);
      else delete navigator.clearAppBadge;
      if (locksDescriptor) Object.defineProperty(navigator, 'locks', locksDescriptor);
      else delete navigator.locks;
    }
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

describe('NotificationBell customer safe-area offsets', () => {
  it('uses customer ink and 44px touch targets for the mobile panel controls', async () => {
    const original = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    try {
      render(<NotificationBell type="customer" />);
      fireEvent.click(screen.getByRole('button', { name: /notifications/i }));

      const title = await screen.findByText('Notifications');
      const markAll = await screen.findByRole('button', { name: 'Mark all read' });
      const close = screen.getByRole('button', { name: 'Close' });
      const account = screen.getByRole('button', { name: 'Account' });
      const whatsNew = screen.getByRole('button', { name: "What's new" });
      expect(title).toHaveStyle({ color: CUSTOMER_SURFACE.text });
      expect(markAll).toHaveStyle({ minHeight: '44px', color: CUSTOMER_SURFACE.text });
      expect(close).toHaveStyle({ width: '44px', height: '44px', color: CUSTOMER_SURFACE.text });
      expect(account).toHaveStyle({ minHeight: '44px', color: CUSTOMER_SURFACE.text });
      expect(whatsNew).toHaveStyle({ minHeight: '44px', color: CUSTOMER_SURFACE.muted });

      fireEvent.click(whatsNew);
      expect(screen.getByText('Nothing new right now')).toHaveStyle({ color: CUSTOMER_SURFACE.muted });
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: original });
    }
  });

  it('keeps the mobile floating panel inside both horizontal safe areas', async () => {
    const original = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    try {
      render(<NotificationBell type="customer" />);
      fireEvent.click(screen.getByRole('button', { name: /notifications/i }));
      const panel = await screen.findByRole('dialog', { name: 'Notifications' });
      expect(document.documentElement.style.overflow).toBe('hidden');
      expect(document.body.style.position).toBe('');
      expect(document.body.style.top).toBe('');
      // jsdom reorders env()'s fallback while serializing the declaration.
      expect(panel.style.left).toMatch(/^calc\(10px \+ env\(/);
      expect(panel.style.left).toContain('safe-area-inset-left');
      expect(panel.style.right).toMatch(/^calc\(10px \+ env\(/);
      expect(panel.style.right).toContain('safe-area-inset-right');
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: original });
    }
  });

  it('keeps the landscape customer sheet above the bottom navigation through 899px', async () => {
    const original = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 844 });
    try {
      render(<NotificationBell type="customer" />);
      fireEvent.click(screen.getByRole('button', { name: /notifications/i }));
      const panel = await screen.findByRole('dialog', { name: 'Notifications' });
      expect(panel.style.bottom).toContain('safe-area-inset-bottom');
      expect(panel.style.bottom).toContain('--portal-bottom-nav-height');
      expect(panel.style.left).toContain('safe-area-inset-left');
      expect(panel.style.right).toContain('safe-area-inset-right');
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: original });
    }
  });

  it('keeps the desktop floating panel inside the top, right, and bottom safe areas', async () => {
    const original = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    try {
      render(<NotificationBell type="customer" />);
      fireEvent.click(screen.getByRole('button', { name: /notifications/i }));
      const panel = await screen.findByRole('dialog', { name: 'Notifications' });
      expect(panel.style.top).toMatch(/^calc\(12px \+ env\(/);
      expect(panel.style.top).toContain('safe-area-inset-top');
      expect(panel.style.right).toMatch(/^calc\(12px \+ env\(/);
      expect(panel.style.right).toContain('safe-area-inset-right');
      expect(panel.style.bottom).toMatch(/^calc\(12px \+ env\(/);
      expect(panel.style.bottom).toContain('safe-area-inset-bottom');
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: original });
    }
  });
});

// Admin-alerts-brevity scope (owner ruling 2026-09-28): a legacy ops_digest
// row's ACT:/FIX:/etc. prefix is stripped for display, a small "Needs you"
// / "Broken" chip reflects metadata.kind, and a click on a row whose link
// is the shared Activity feed carries a `focus=<id>` param so that feed can
// jump straight to the item.
describe('NotificationBell _test helpers (pure)', () => {
  it('displayTitle strips a legacy prefix only for ops_digest rows', () => {
    expect(_test.displayTitle({ category: 'ops_digest', title: 'ACT: something' })).toBe('something');
    expect(_test.displayTitle({ category: 'ops_digest', title: 'FIX: broken thing' })).toBe('broken thing');
    expect(_test.displayTitle({ category: 'ops_digest', title: '[Review] a draft' })).toBe('a draft');
    // A new-format row never carries a prefix — untouched either way.
    expect(_test.displayTitle({ category: 'ops_digest', title: 'Schedule — a call promise slipped' }))
      .toBe('Schedule — a call promise slipped');
    // Non-digest categories are never touched, even if they happen to start
    // with the same letters.
    expect(_test.displayTitle({ category: 'alert', title: 'ACT: not a digest' })).toBe('ACT: not a digest');
  });

  it('digestKindChip reads metadata.kind for ops_digest rows only', () => {
    expect(_test.digestKindChip({ category: 'ops_digest', metadata: { kind: 'ACT' } })).toEqual({ label: 'Needs you' });
    expect(_test.digestKindChip({ category: 'ops_digest', metadata: { kind: 'REVIEW' } })).toEqual({ label: 'Needs you' });
    expect(_test.digestKindChip({ category: 'ops_digest', metadata: { kind: 'FIX' } })).toEqual({ label: 'Broken' });
    expect(_test.digestKindChip({ category: 'ops_digest', metadata: { kind: 'FYI' } })).toBeNull();
    expect(_test.digestKindChip({ category: 'ops_digest', metadata: null })).toBeNull(); // legacy row, no chip
    expect(_test.digestKindChip({ category: 'alert', metadata: { kind: 'ACT' } })).toBeNull(); // non-digest, never a chip
  });

  it('digestKindChip parses a stringified metadata column', () => {
    expect(_test.digestKindChip({ category: 'ops_digest', metadata: JSON.stringify({ kind: 'FIX' }) })).toEqual({ label: 'Broken' });
  });

  it('linkFor appends &focus=<id> only for an ops_digest row pointed at the shared Activity feed', () => {
    expect(_test.linkFor({ id: 42, category: 'ops_digest', link: '/admin/agents?tab=activity' }))
      .toBe('/admin/agents?tab=activity&focus=42');
    // A more specific admin page is left alone.
    expect(_test.linkFor({ id: 42, category: 'ops_digest', link: '/admin/invoices' })).toBe('/admin/invoices');
    // Non-digest categories are never touched.
    expect(_test.linkFor({ id: 42, category: 'alert', link: '/admin/agents?tab=activity' })).toBe('/admin/agents?tab=activity');
    // No link at all stays falsy.
    expect(_test.linkFor({ id: 42, category: 'ops_digest', link: null })).toBeNull();
  });
});

describe('NotificationBell admin desktop — digest chip + prefix strip', () => {
  it('shows the "Needs you" / "Broken" chip and strips a legacy prefix, and a LONG title still ellipsizes with the chip visible', async () => {
    const longTitle = 'ACT: ' + 'a very long legacy ops digest title that would overflow the row '.repeat(3).trim();
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('/unread-count')) return jsonResponse({ count: 2 });
      return jsonResponse({
        notifications: [
          { id: 'd1', category: 'ops_digest', title: longTitle, body: null, metadata: { kind: 'ACT' }, created_at: new Date().toISOString(), read_at: null, link: null },
          { id: 'd2', category: 'ops_digest', title: 'Sends — duplicate detection failing', body: null, metadata: { kind: 'FIX' }, created_at: new Date().toISOString(), read_at: null, link: null },
        ],
        hasMore: false,
      });
    });
    render(<NotificationBell type="admin" />);
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }));
    await screen.findByText('Needs you');
    expect(screen.getByText('Broken')).toBeInTheDocument();
    // The legacy "ACT: " prefix is gone from the displayed title.
    expect(screen.queryByText(longTitle)).toBeNull();
    expect(screen.getByTitle(longTitle.replace(/^ACT: /, ''))).toBeInTheDocument();
    // Both chips render alongside their (possibly very long) titles.
    expect(screen.getByText('Sends — duplicate detection failing')).toBeInTheDocument();
  });
});

describe('NotificationBell admin MOBILE path (<768px) — same digest treatment', () => {
  // The owner reads the admin bell on a phone too: isMobile ({@link
  // NotificationBell}'s ternary at ~line 516) serves BOTH admin and
  // customer under 768px, so the digest chip/prefix-strip/focus-link must
  // work there as well, not just the desktop dropdown.
  it('strips a legacy prefix, shows the kind chip, and appends &focus= on a phone-width admin bell', async () => {
    const previousWidth = window.innerWidth;
    const previousLocation = window.location;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('/unread-count')) return jsonResponse({ count: 1 });
      return jsonResponse({
        notifications: [{
          id: 'd9', category: 'ops_digest', title: 'ACT: 3 promised quotes never went out',
          body: null, metadata: { kind: 'ACT' }, created_at: new Date().toISOString(), read_at: null,
          link: '/admin/agents?tab=activity',
        }],
      });
    });
    try {
      render(<NotificationBell type="admin" />);
      fireEvent.click(screen.getByRole('button', { name: /notifications/i }));
      await screen.findByText('Needs you');
      // Legacy "ACT: " prefix is stripped for display.
      expect(screen.queryByText('ACT: 3 promised quotes never went out')).toBeNull();
      const row = await screen.findByText('3 promised quotes never went out');
      const hrefSpy = vi.fn();
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...window.location, set href(v) { hrefSpy(v); } },
      });
      fireEvent.click(row);
      await waitFor(() => expect(hrefSpy).toHaveBeenCalledWith('/admin/agents?tab=activity&focus=d9'));
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: previousWidth });
      Object.defineProperty(window, 'location', { configurable: true, value: previousLocation });
    }
  });
});

describe('NotificationBell "Full report" link (codex r3 P0 on #5236)', () => {
  const { reportLinkFor } = _test;

  it('points a mapped or linkless ops_digest row at its focused Activity item, and nothing else', () => {
    expect(reportLinkFor({ id: 'd1', category: 'ops_digest', link: '/admin/communications' }))
      .toBe('/admin/agents?tab=activity&focus=d1');
    expect(reportLinkFor({ id: 'd2', category: 'ops_digest', link: null }))
      .toBe('/admin/agents?tab=activity&focus=d2');
    // The row's own tap already opens the report.
    expect(reportLinkFor({ id: 'd3', category: 'ops_digest', link: '/admin/agents?tab=activity' })).toBeNull();
    // Never on a non-digest row.
    expect(reportLinkFor({ id: 'r1', category: 'review', link: '/admin/reviews' })).toBeNull();
  });

  it('opens the report without following the row to its mapped work page', async () => {
    const previousLocation = window.location;
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('/unread-count')) return jsonResponse({ count: 1 });
      if (String(url).includes('/read')) return jsonResponse({ success: true });
      return jsonResponse({
        notifications: [{
          id: 'd7', category: 'ops_digest', title: 'Comms — 7 callbacks waiting',
          body: 'Plus 93 unanswered texts.', metadata: { kind: 'ACT' },
          created_at: new Date().toISOString(), read_at: null, link: '/admin/communications',
        }],
      });
    });
    const hrefSpy = vi.fn();
    try {
      render(<NotificationBell type="admin" />);
      fireEvent.click(screen.getByRole('button', { name: /notifications/i }));
      const report = await screen.findByRole('button', { name: 'Full report' });
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...window.location, set href(v) { hrefSpy(v); } },
      });
      fireEvent.click(report);
      await waitFor(() => expect(hrefSpy).toHaveBeenCalledWith('/admin/agents?tab=activity&focus=d7'));
      expect(hrefSpy).not.toHaveBeenCalledWith('/admin/communications');
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: previousLocation });
    }
  });

  it('leaves a customer row on a phone unclamped and without a report link', async () => {
    const previousWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    const longBody = 'Your technician is on the way and will arrive within the window you picked. '.repeat(3).trim();
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('/unread-count')) return jsonResponse({ count: 1 });
      return jsonResponse({
        notifications: [{
          id: 'c1', category: 'appointment', title: 'On the way', body: longBody,
          created_at: new Date().toISOString(), read_at: null, link: null,
        }],
      });
    });
    try {
      render(<NotificationBell type="customer" customerId="cust-1" />);
      fireEvent.click(screen.getByRole('button', { name: /notifications/i }));
      const body = await screen.findByText(longBody);
      expect(body.style.WebkitLineClamp || '').toBe('');
      expect(screen.queryByRole('button', { name: 'Full report' })).toBeNull();
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: previousWidth });
    }
  });
});
