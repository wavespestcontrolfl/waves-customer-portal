// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TeamTab, resolveStaffTab } from './TimeTrackingPage';

function apiResponse(body) {
  return {
    ok: true,
    json: vi.fn(async () => body),
  };
}

describe('TimeTrackingPage team account actions', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('waves_admin_token', 'admin-token');
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('describes, cancels, and performs staff deactivation without offering a data purge', async () => {
    const showToast = vi.fn();
    let active = true;
    let resolveDelete;
    const deleteResponse = new Promise((resolve) => { resolveDelete = resolve; });
    const fetchMock = vi.fn((url, options = {}) => {
      if (options.method === 'DELETE') {
        active = false;
        return deleteResponse;
      }
      return Promise.resolve(apiResponse({
        technicians: [{
          id: 'tech-1',
          name: 'River Tech',
          email: 'river@example.com',
          role: 'technician',
          active,
        }],
      }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<TeamTab showToast={showToast} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate' }));

    let dialog = await screen.findByRole('dialog', { name: 'Deactivate River Tech?' });
    expect(dialog).toHaveTextContent('Historical time, payroll, job, and audit records will be kept.');
    expect(dialog).not.toHaveTextContent(/permanent|purge|delete/i);
    expect(fetchMock.mock.calls.some(([, options = {}]) => options.method === 'DELETE')).toBe(false);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Deactivate River Tech?' })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, options = {}]) => options.method === 'DELETE')).toBe(false);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Deactivate' })).toHaveFocus());

    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    dialog = await screen.findByRole('dialog', { name: 'Deactivate River Tech?' });
    const confirmButton = within(dialog).getByRole('button', { name: 'Deactivate' });
    fireEvent.click(confirmButton);
    fireEvent.click(confirmButton);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/timetracking/technicians/tech-1',
      expect.objectContaining({ method: 'DELETE' }),
    ));
    expect(fetchMock.mock.calls.filter(([, options = {}]) => options.method === 'DELETE')).toHaveLength(1);
    resolveDelete(apiResponse({ success: true, deactivated: true }));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('force=true'))).toBe(false);
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('River Tech deactivated'));
    expect(await screen.findByRole('button', { name: 'Activate' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('reactivates an inactive account with an explicit active update', async () => {
    const showToast = vi.fn();
    let active = false;
    const fetchMock = vi.fn(async (url, options = {}) => {
      if (options.method === 'PUT') {
        active = true;
        return apiResponse({ success: true });
      }
      return apiResponse({
        technicians: [{
          id: 'tech-1',
          name: 'River Tech',
          email: 'river@example.com',
          role: 'technician',
          active,
        }],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<TeamTab showToast={showToast} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Activate' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/timetracking/technicians/tech-1',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ active: true }),
      }),
    ));
    expect(showToast).toHaveBeenCalledWith('River Tech activated');
    expect(await screen.findByRole('button', { name: 'Deactivate' })).toBeInTheDocument();
  });
});

describe('TimeTrackingPage pay-growth deep-link resolution', () => {
  it('withholds the tab while an admin availability probe is pending, then resolves it', () => {
    expect(resolveStaffTab('pay-growth', null, 'admin')).toBeNull();
    expect(resolveStaffTab('pay-growth', true, 'admin')).toBe('pay-growth');
    expect(resolveStaffTab('pay-growth', false, 'admin')).toBe('team');
  });

  it('falls back to Team immediately for non-admins and leaves other tabs alone', () => {
    expect(resolveStaffTab('pay-growth', null, 'technician')).toBe('team');
    expect(resolveStaffTab('pay-growth', true, 'technician')).toBe('team');
    expect(resolveStaffTab('pay-growth', true, null)).toBe('team');
    expect(resolveStaffTab('documents', null, 'admin')).toBe('documents');
    expect(resolveStaffTab('dashboard', false, 'technician')).toBe('dashboard');
  });
});
