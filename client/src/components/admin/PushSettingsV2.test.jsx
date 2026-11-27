// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import PushSettingsV2 from './PushSettingsV2';

vi.mock('../../lib/push-subscribe.js', () => ({
  isPushEnabled: vi.fn(async () => true),
  ensurePushSubscription: vi.fn(),
  disablePush: vi.fn(),
  sendTestPush: vi.fn(),
}));

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('blocks saving after a failed preference read, then preserves saved opt-outs after retry', async () => {
  const saved = {
    preferences: [{ key: 'customer_email_received', label: 'Customer email', group: 'Customer', push_enabled: false, bell_enabled: false, sound_enabled: false }],
    bellCategories: [{ key: 'category:billing', category: 'billing', bell_enabled: true }],
  };
  let reads = 0;
  global.fetch = vi.fn(async (_url, options) => {
    if (options?.method === 'PUT') return { ok: true, json: async () => ({ ok: true }) };
    if (++reads === 1) return { ok: false, status: 503 };
    return { ok: true, json: async () => saved };
  });
  render(<PushSettingsV2 />);
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  expect(await screen.findByRole('alert')).toHaveTextContent("Notification preferences couldn't be loaded.");
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(global.fetch).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await screen.findByText('Customer email');
  expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/api/admin/push/preferences', expect.objectContaining({
    method: 'PUT', body: JSON.stringify({ preferences: [...saved.preferences, ...saved.bellCategories] }),
  })));
});

it('inside Waves Admin, points to iPhone Settings instead of the browser push switch', async () => {
  window.webkit = { messageHandlers: { wavesAdmin: { postMessage: vi.fn() } } };
  try {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ preferences: [], bellCategories: [] }) }));
    render(<PushSettingsV2 />);
    expect(await screen.findByText('Push notifications on this iPhone')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enable' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Disable' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Send test' })).toBeInTheDocument();
  } finally {
    delete window.webkit;
  }
});

it('renders server-filtered triggers, labels all categories, locks switches during save, and reloads server state on failed PUT without window.alert', async () => {
  const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
  const initial = {
    preferences: [
      { key: 'sms_reply', label: 'Customer text', group: 'Customer', push_enabled: true, bell_enabled: true, sound_enabled: true },
      { key: 'payment_refunded', label: 'Payment refunded', group: 'Billing', push_enabled: true, bell_enabled: true, sound_enabled: true },
    ],
    bellCategories: [
      { key: 'category:customer_landline_from_call', category: 'customer_landline_from_call', bell_enabled: true },
      { key: 'category:typed_decisions', category: 'typed_decisions', bell_enabled: true },
    ],
  };
  const reloadedAfterPartial = {
    preferences: [
      { key: 'sms_reply', label: 'Customer text', group: 'Customer', push_enabled: false, bell_enabled: true, sound_enabled: true },
      { key: 'payment_refunded', label: 'Payment refunded', group: 'Billing', push_enabled: true, bell_enabled: true, sound_enabled: true },
    ],
    bellCategories: initial.bellCategories,
  };
  let getCount = 0;
  let resolvePut;
  global.fetch = vi.fn((_url, options) => {
    if (options?.method === 'PUT') {
      return new Promise((resolve) => { resolvePut = resolve; });
    }
    getCount += 1;
    const payload = getCount === 1 ? initial : reloadedAfterPartial;
    return Promise.resolve({ ok: true, json: async () => payload });
  });

  render(<PushSettingsV2 />);
  expect(await screen.findByText('Customer text')).toBeInTheDocument();
  expect(screen.getByText('Payment refunded')).toBeInTheDocument();
  expect(screen.getByText('Landline numbers from calls')).toBeInTheDocument();
  expect(screen.getByText('AI decision review list')).toBeInTheDocument();

  const switches = screen.getAllByRole('switch');
  expect(switches[0]).toHaveAttribute('aria-checked', 'true');
  fireEvent.click(switches[0]);
  expect(switches[0]).toHaveAttribute('aria-checked', 'false');

  // Start saving: all switches must lock until PUT + recovery complete.
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled());
  for (const sw of screen.getAllByRole('switch')) {
    expect(sw).toBeDisabled();
  }
  fireEvent.click(switches[1]);
  expect(switches[1]).toHaveAttribute('aria-checked', 'true');

  // Fail PUT: component reloads authoritative preferences from the server.
  resolvePut({ ok: false, status: 500 });
  expect(await screen.findByRole('alert')).toHaveTextContent(/Reloaded saved settings from the server/);
  expect(getCount).toBe(2);
  // Reflects the server's reloaded state (first switch stayed persisted false, second stayed true).
  expect(screen.getAllByRole('switch')[0]).toHaveAttribute('aria-checked', 'false');
  expect(screen.getAllByRole('switch')[1]).toHaveAttribute('aria-checked', 'true');
  expect(screen.getAllByRole('switch')[0]).not.toBeDisabled();
  expect(alertSpy).not.toHaveBeenCalled();

  // Unknown network drop: keeps controls locked until the user clicks Try again
  // instead of racing a recovery GET against a still-running server write.
  global.fetch = vi.fn((_url, options) => {
    if (options?.method === 'PUT') return Promise.reject(new TypeError('Failed to fetch'));
    return Promise.resolve({ ok: true, json: async () => reloadedAfterPartial });
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText(/Connection dropped while saving notification preferences/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  for (const sw of screen.getAllByRole('switch')) {
    expect(sw).toBeDisabled();
  }
  expect(global.fetch).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled());
});
