// @vitest-environment jsdom
// Technician allow-list (owner 2026-10-02): POST /dispatch/sync ("Sync AI
// Data") is owner-only, so a technician's dispatch sub-tabs do not offer it.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DispatchPageV2 from './DispatchPageV2';
import { adminFetch } from '../../utils/admin-fetch';

vi.mock('../../utils/admin-fetch', () => ({ adminFetch: vi.fn(), isRateLimitError: () => false }));
vi.mock('../../components/schedule/TimeGridDay', () => ({ default: () => <div>Schedule visits</div> }));
vi.mock('../../components/schedule/MobileDispatchList', () => ({ default: () => null }));
vi.mock('../../hooks/useFeatureFlag', () => ({ useFeatureFlag: () => false }));

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ alerts: [] }) })));
  vi.mocked(adminFetch).mockImplementation(async (path) => (String(path).startsWith('/admin/schedule?')
    ? { services: [], technicians: [], weather: {} }
    : { products: [], types: [] }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  localStorage.clear();
});

function mount(role) {
  localStorage.setItem('waves_admin_user', JSON.stringify({ role }));
  render(
    <MemoryRouter initialEntries={['/admin/dispatch?tab=protocols&date=2026-09-05']}>
      <DispatchPageV2 activeTab="protocols" />
    </MemoryRouter>,
  );
}

describe('dispatch Sync AI Data', () => {
  it('is offered to an admin on a non-board sub-tab', async () => {
    mount('admin');
    expect(await screen.findByRole('button', { name: /Sync AI Data/ })).toBeInTheDocument();
  });

  it('is not offered to a technician', async () => {
    mount('technician');
    await screen.findAllByText(/./);
    await vi.waitFor(() => expect(adminFetch).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /Sync AI Data/ })).not.toBeInTheDocument();
  });
});
