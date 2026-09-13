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
