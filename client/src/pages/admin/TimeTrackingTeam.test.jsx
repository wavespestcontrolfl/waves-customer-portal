// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TeamTab } from './TimeTrackingPage';

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

  it('describes and performs staff deactivation without offering a data purge', async () => {
    const showToast = vi.fn();
    const confirmMock = vi.fn(() => true);
    let active = true;
    const fetchMock = vi.fn(async (url, options = {}) => {
      if (options.method === 'DELETE') {
        active = false;
        return apiResponse({ success: true, deactivated: true });
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
    vi.stubGlobal('confirm', confirmMock);
    vi.stubGlobal('fetch', fetchMock);

    render(<TeamTab showToast={showToast} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate' }));

    expect(confirmMock).toHaveBeenCalledOnce();
    const confirmation = confirmMock.mock.calls[0][0];
    expect(confirmation).toContain('Historical time, payroll, job, and audit records will be kept.');
    expect(confirmation).not.toMatch(/permanent|purge|delete/i);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/timetracking/technicians/tech-1',
      expect.objectContaining({ method: 'DELETE' }),
    ));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('force=true'))).toBe(false);
    expect(showToast).toHaveBeenCalledWith('River Tech deactivated');
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
