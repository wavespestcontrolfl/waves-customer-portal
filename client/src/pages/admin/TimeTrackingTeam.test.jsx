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
    localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'admin-1', role: 'admin' }));
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

  it('shows a technician the roster with only its own Photo action: no add, edit, earnings or activation controls', async () => {
    localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'tech-2', role: 'technician' }));
    vi.stubGlobal('fetch', vi.fn(async () => apiResponse({
      technicians: [
        { id: 'tech-1', name: 'River Tech', role: 'technician', active: true },
        { id: 'tech-2', name: 'Sky Tech', email: 'sky@example.com', role: 'technician', active: true },
      ],
    })));

    render(<TeamTab showToast={vi.fn()} />);

    const ownRow = (await screen.findByText('Sky Tech')).closest('tr');
    expect(within(ownRow).getByRole('button', { name: 'Photo' })).toBeInTheDocument();
    expect(within(screen.getByText('River Tech').closest('tr')).queryByRole('button')).not.toBeInTheDocument();
    for (const name of ['+ Add Technician', 'Edit', 'Earnings', 'Capabilities', 'Deactivate', 'Activate']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
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

describe('TimeTrackingPage payroll deep-link resolution', () => {
  it('withholds the payroll tab while the admin status probe is pending, then resolves it', () => {
    expect(resolveStaffTab('payroll', false, 'admin', null)).toBeNull();
    expect(resolveStaffTab('payroll', false, 'admin', true)).toBe('payroll');
    expect(resolveStaffTab('payroll', false, 'admin', false)).toBe('team');
  });

  it('falls back to Team for non-admins and when the status is unknown to the caller', () => {
    expect(resolveStaffTab('payroll', true, 'technician', true)).toBe('team');
    expect(resolveStaffTab('payroll', true, null, true)).toBe('team');
    expect(resolveStaffTab('payroll', true, 'admin')).toBe('team');
    expect(resolveStaffTab('pay-growth', true, 'admin', false)).toBe('pay-growth');
  });
});

describe('TimeTrackingPage pay stubs deep-link resolution (GATE_TECH_PAY_STUBS)', () => {
  it('opens for any role once its request says ready, waits while pending, and falls back when off (Timesheet for an admin, Dashboard for a technician)', () => {
    expect(resolveStaffTab('pay-stubs', false, 'technician', false, 'ready')).toBe('pay-stubs');
    expect(resolveStaffTab('pay-stubs', false, 'admin', false, 'ready')).toBe('pay-stubs');
    expect(resolveStaffTab('pay-stubs', false, 'technician', false, 'loading')).toBeNull();
    expect(resolveStaffTab('pay-stubs', false, 'admin', false, 'off')).toBe('timesheet');
    expect(resolveStaffTab('pay-stubs', false, 'admin', false, 'error')).toBe('timesheet');
    expect(resolveStaffTab('pay-stubs', false, 'technician', false, 'off')).toBe('dashboard');
    expect(resolveStaffTab('pay-stubs', false, 'technician', false, 'error')).toBe('dashboard');
    expect(resolveStaffTab('pay-stubs', false, 'technician')).toBe('dashboard');
  });
});

describe('TimeTrackingPage office-only leaves', () => {
  it('opens Dashboard for a technician link to Timesheet, Entries, Approvals or Analytics and leaves an admin where it asked', () => {
    for (const leaf of ['timesheet', 'entries', 'approvals', 'analytics']) {
      expect(resolveStaffTab(leaf, false, 'technician')).toBe('dashboard');
      expect(resolveStaffTab(leaf, false, null)).toBe('dashboard');
      expect(resolveStaffTab(leaf, false, 'admin')).toBe(leaf);
    }
    expect(resolveStaffTab('team', false, 'technician')).toBe('team');
    expect(resolveStaffTab('documents', false, 'technician')).toBe('documents');
  });
});

describe('TimeTrackingPage team edit form names', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('waves_admin_token', 'admin-token');
    localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'admin-1', role: 'admin' }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('gives every edit field the name of its visible label', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => apiResponse({
      technicians: [{
        id: 'tech-1',
        name: 'River Tech',
        role: 'technician',
        active: true,
        employment_status: 'active',
        pay_rate: '22.50',
      }],
    })));
    render(<TeamTab showToast={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));

    // A pay rate on the row opens the payroll section with the form.
    expect(screen.getByRole('textbox', { name: 'Name *' })).toHaveValue('River Tech');
    for (const name of ['Phone', 'Email', 'Job title', 'Address', 'SSN (last 4)',
      'Emergency contact name', 'Emergency contact phone']) {
      expect(screen.getByRole('textbox', { name })).toBeInTheDocument();
    }
    for (const name of ['Employment', 'Tech line', 'Employment type']) {
      expect(screen.getByRole('combobox', { name })).toBeInTheDocument();
    }
    expect(screen.getByRole('spinbutton', { name: 'Pay rate ($/hr)' })).toHaveValue(22.5);
    expect(screen.getByLabelText('Hire date')).toHaveAttribute('type', 'date');
    expect(screen.getByLabelText('Date of birth')).toHaveAttribute('type', 'date');
  });
});
