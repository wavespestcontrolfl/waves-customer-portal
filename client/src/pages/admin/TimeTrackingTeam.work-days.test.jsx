// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../components/AddressAutocomplete', () => ({ default: () => null }));

import { TeamTab } from './TimeTrackingPage';

// GATE_TECH_WORK_DAYS (owner 2026-10-25): the Team tab "Work days" row of seven
// day toggles, shown only when the server says the gate is on.
const BASE_TECH = {
  id: 'tech-1', name: 'River Tech', email: 'river@example.com', role: 'technician',
  active: true, employment_status: 'active', field_dispatchable: true,
};
const MON_THU = [1, 2, 3, 4];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function setup(tech, { enabled = true } = {}) {
  const writes = [];
  const showToast = vi.fn();
  vi.stubGlobal('fetch', vi.fn((url, options = {}) => {
    if (options.method === 'PUT' || options.method === 'POST') {
      writes.push({ method: options.method, body: JSON.parse(options.body) });
      return Promise.resolve({ ok: true, json: async () => ({ success: true, futureAssignedVisits: [] }) });
    }
    return Promise.resolve({
      ok: true,
      json: async () => ({ technicians: [tech], ...(enabled ? { workDaysEnabled: true } : {}) }),
    });
  }));
  render(<TeamTab showToast={showToast} />);
  return { writes, showToast };
}

const toggle = (label) => within(screen.getByRole('group', { name: 'Work days' })).getByRole('button', { name: label });

describe('TeamTab work days', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('waves_admin_token', 'admin-token');
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('gate off: no row, no summary, and nothing about work days is sent', async () => {
    const { writes } = setup({ ...BASE_TECH, work_days: MON_THU }, { enabled: false });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(screen.queryByRole('group', { name: 'Work days' })).not.toBeInTheDocument();
    expect(screen.queryByText(/^Works /)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].body).not.toHaveProperty('workDays');
  });

  it('shows seven toggles in Mon-to-Sun order and the saved days on the row', async () => {
    setup({ ...BASE_TECH, work_days: MON_THU });
    expect(await screen.findByText('Works Mon–Thu')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const group = screen.getByRole('group', { name: 'Work days' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(DAYS);
    for (const day of DAYS) {
      expect(toggle(day)).toHaveAttribute('aria-pressed', ['Mon', 'Tue', 'Wed', 'Thu'].includes(day) ? 'true' : 'false');
    }
  });

  it('a row that works every day (NULL) says nothing and loads with all seven on', async () => {
    setup({ ...BASE_TECH, work_days: null });
    await screen.findByRole('button', { name: 'Edit' });
    expect(screen.queryByText(/^Works /)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    for (const day of DAYS) expect(toggle(day)).toHaveAttribute('aria-pressed', 'true');
  });

  it('sends the picked days stored 0 = Sunday', async () => {
    const { writes } = setup({ ...BASE_TECH, work_days: null });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    for (const day of ['Fri', 'Sat', 'Sun']) fireEvent.click(toggle(day));
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].body.workDays).toEqual(MON_THU);
  });

  it('a Sunday-and-Saturday pick is stored as [0, 6]', async () => {
    const { writes } = setup({ ...BASE_TECH, work_days: MON_THU });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    for (const day of ['Mon', 'Tue', 'Wed', 'Thu', 'Sat', 'Sun']) fireEvent.click(toggle(day));
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].body.workDays).toEqual([0, 6]);
  });

  it('all seven days on is sent as null (works every day)', async () => {
    const { writes } = setup({ ...BASE_TECH, work_days: MON_THU });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    for (const day of ['Fri', 'Sat', 'Sun']) fireEvent.click(toggle(day));
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].body.workDays).toBeNull();
  });

  it('zero days picked shows "Pick at least one work day" and blocks the save', async () => {
    const { writes } = setup({ ...BASE_TECH, work_days: MON_THU });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    for (const day of ['Mon', 'Tue', 'Wed', 'Thu']) fireEvent.click(toggle(day));
    expect(screen.getByRole('alert')).toHaveTextContent('Pick at least one work day');
    const update = screen.getByRole('button', { name: 'Update' });
    expect(update).toBeDisabled();
    fireEvent.click(update);
    expect(writes).toHaveLength(0);
  });

  it('the add form starts with every day on and posts null', async () => {
    const { writes } = setup(BASE_TECH);
    fireEvent.click(await screen.findByRole('button', { name: '+ Add Technician' }));
    for (const day of DAYS) expect(toggle(day)).toHaveAttribute('aria-pressed', 'true');
    fireEvent.change(screen.getByPlaceholderText("e.g. John D."), { target: { value: 'New Tech' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].method).toBe('POST');
    expect(writes[0].body.workDays).toBeNull();
  });
});
