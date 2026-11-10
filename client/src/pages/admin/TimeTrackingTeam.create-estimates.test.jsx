// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../components/AddressAutocomplete', () => ({ default: () => <div /> }));

import { TeamTab } from './TimeTrackingPage';

const BASE_TECH = {
  id: 'tech-1', name: 'River Tech', email: 'river@example.com', role: 'technician',
  active: true, employment_status: 'active', field_dispatchable: true,
};

function setup(tech) {
  const puts = [];
  vi.stubGlobal('fetch', vi.fn((url, options = {}) => {
    if (options.method === 'PUT') {
      puts.push(JSON.parse(options.body));
      return Promise.resolve({ ok: true, json: async () => ({ success: true, futureAssignedVisits: [] }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({ technicians: [tech] }) });
  }));
  render(<TeamTab showToast={vi.fn()} />);
  return puts;
}

// The estimate tool's per-technician switch (GATE_TECH_ESTIMATES, 2026-11-09), shown and saved like Can move visits.
describe('TeamTab Can create estimates', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('waves_admin_token', 'admin-token');
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('shows the saved switch and sends the change on Update', async () => {
    const puts = setup({ ...BASE_TECH, can_create_estimates: false });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const box = screen.getByRole('checkbox', { name: /Can create estimates/ });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].canCreateEstimates).toBe(true);
  });

  it('a technician who has it loads ticked and saves unchanged', async () => {
    const puts = setup({ ...BASE_TECH, can_create_estimates: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('checkbox', { name: /Can create estimates/ })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].canCreateEstimates).toBe(true);
  });

  it('a row without the switch saves without it, so an edit never turns it off', async () => {
    const puts = setup(BASE_TECH);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).not.toHaveProperty('canCreateEstimates');
  });

  it('the add form does not show it: a new technician starts off', async () => {
    setup(BASE_TECH);
    fireEvent.click(await screen.findByRole('button', { name: '+ Add Technician' }));
    expect(screen.queryByRole('checkbox', { name: /Can create estimates/ })).not.toBeInTheDocument();
  });
});
