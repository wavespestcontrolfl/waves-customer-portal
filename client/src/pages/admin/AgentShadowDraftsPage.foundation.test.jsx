// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import AgentShadowDraftsPage from './AgentShadowDraftsPage';
import { adminFetch } from '../../utils/admin-fetch';

vi.mock('../../utils/admin-fetch', () => ({ adminFetch: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetAllMocks(); });

it('keeps live voice approval behind its existing confirmation and preserves the accepted payload', async () => {
  adminFetch.mockImplementation(async (url, options) => {
    if (options?.method) return {};
    if (url.endsWith('/voice-profiles')) return { pending: { id: 'fixture-profile', version: 2, profile_text: 'Fixture voice guidance.' } };
    if (url.endsWith('/shadow-drafts')) return { drafts: [] };
    if (url.endsWith('/sealed-eval')) return null;
    if (url.endsWith('/pathology')) return null;
    return { intents: [] };
  });
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<AgentShadowDraftsPage />);
  const approve = await screen.findByRole('button', { name: 'Approve — make this the live voice' });
  fireEvent.click(approve);
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Approve voice profile v2?'));
  expect(adminFetch.mock.calls.filter(([, options]) => options?.method)).toHaveLength(0);
  confirm.mockReturnValue(true);
  fireEvent.click(approve);
  await waitFor(() => expect(adminFetch).toHaveBeenCalledWith('/admin/agents/voice-profiles/fixture-profile/review', { method: 'POST', body: JSON.stringify({ action: 'approve' }) }));
});
