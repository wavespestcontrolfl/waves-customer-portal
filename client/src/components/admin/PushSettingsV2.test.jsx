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

it('hides retired denylisted triggers, labels all categories, and reverts optimistic toggles on save failure without window.alert', async () => {
  const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
  const initial = {
    preferences: [
      { key: 'sms_reply', label: 'Customer text', group: 'Customer', push_enabled: true, bell_enabled: true, sound_enabled: true },
      { key: 'repeat_caller', label: 'Repeat caller', group: 'Customer', push_enabled: true, bell_enabled: true, sound_enabled: true },
      { key: 'dashboard_alert', label: 'Dashboard alert', group: 'Alerts', push_enabled: true, bell_enabled: true, sound_enabled: true },
    ],
    bellCategories: [
      { key: 'category:customer_landline_from_call', category: 'customer_landline_from_call', bell_enabled: true },
      { key: 'category:typed_decisions', category: 'typed_decisions', bell_enabled: true },
    ],
  };
  global.fetch = vi.fn(async (_url, options) => {
    if (options?.method === 'PUT') return { ok: false, status: 500 };
    return { ok: true, json: async () => initial };
  });

  render(<PushSettingsV2 />);
  expect(await screen.findByText('Customer text')).toBeInTheDocument();
  expect(screen.queryByText('Repeat caller')).toBeNull();
  expect(screen.queryByText('Dashboard alert')).toBeNull();
  expect(screen.getByText('Landline numbers from calls')).toBeInTheDocument();
  expect(screen.getByText('AI decision review list')).toBeInTheDocument();

  const switches = screen.getAllByRole('switch');
  expect(switches[0]).toHaveAttribute('aria-checked', 'true');
  fireEvent.click(switches[0]);
  expect(switches[0]).toHaveAttribute('aria-checked', 'false');

  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn't save notification preferences/);
  expect(switches[0]).toHaveAttribute('aria-checked', 'true');
  expect(alertSpy).not.toHaveBeenCalled();
});
