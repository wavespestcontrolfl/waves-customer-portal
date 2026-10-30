// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../components/AddressAutocomplete', () => ({ default: () => null }));

import { TeamTab } from './TimeTrackingPage';

// GATE_SERVICE_LINE_MAP=shadow (owner 2026-10-25): the Team tab "Service lines" card,
// shown only when the server marks the roster response.
const TECHS = [
  { id: 'tech-adam', name: 'Owner Tech', role: 'admin', active: true, employment_status: 'active', field_dispatchable: true },
  { id: 'tech-new', name: 'New Hire', role: 'technician', active: false, employment_status: 'prospective', field_dispatchable: true },
  { id: 'tech-gone', name: 'Former Tech', role: 'technician', active: false, employment_status: 'inactive', field_dispatchable: true },
];
const SAVED = [
  { service_category: 'general', home_technician_id: 'tech-new', gap_technician_id: 'tech-adam' },
  { service_category: 'lawn', home_technician_id: 'tech-adam', gap_technician_id: null },
];

function setup({ enabled = true, role = 'admin', mode = 'shadow' } = {}) {
  localStorage.setItem('waves_admin_user', JSON.stringify({ role }));
  const calls = [];
  const showToast = vi.fn();
  vi.stubGlobal('fetch', vi.fn((url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    if (String(url).endsWith('/service-lines')) {
      return Promise.resolve({ ok: true, json: async () => ({ mode, lines: SAVED, success: true }) });
    }
    return Promise.resolve({
      ok: true,
      json: async () => ({ technicians: TECHS, ...(enabled ? { serviceLinesEnabled: true } : {}) }),
    });
  }));
  render(<TeamTab showToast={showToast} />);
  return { calls, showToast };
}

describe('TeamTab service lines', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('waves_admin_token', 'admin-token');
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('gate off: no card and the service-lines route is never called', async () => {
    const { calls } = setup({ enabled: false });
    await screen.findByText('Technicians');
    expect(screen.queryByRole('region', { name: 'Service lines' })).not.toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('service-lines'))).toBe(false);
  });

  it('a non-admin never sees the card', async () => {
    const { calls } = setup({ role: 'technician' });
    await screen.findByText('Technicians');
    expect(screen.queryByRole('region', { name: 'Service lines' })).not.toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('service-lines'))).toBe(false);
  });

  it('shows five lines with the saved home and gap, and lists active and prospective techs only', async () => {
    setup();
    const card = await screen.findByRole('region', { name: 'Service lines' });
    await waitFor(() => expect(within(card).getByLabelText('General pest Home tech')).toHaveValue('tech-new'));
    expect(within(card).getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual([
      'General pest', 'Mosquito', 'Lawn / tree & shrub', 'Rodent', 'Termite / WDO',
    ]);
    expect(within(card).getByLabelText('General pest Gap tech')).toHaveValue('tech-adam');
    expect(within(card).getByLabelText('Mosquito Home tech')).toHaveValue('');
    const options = within(within(card).getByLabelText('Rodent Home tech')).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['None', 'Owner Tech', 'New Hire (not started)']);
  });

  it('saves all five lines, ids or null', async () => {
    const { calls, showToast } = setup();
    const card = await screen.findByRole('region', { name: 'Service lines' });
    await waitFor(() => expect(within(card).getByLabelText('General pest Home tech')).toHaveValue('tech-new'));
    fireEvent.change(within(card).getByLabelText('Rodent Home tech'), { target: { value: 'tech-new' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Save service lines' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Service lines saved'));
    const put = calls.find((c) => c.method === 'PUT');
    expect(put.body.lines).toHaveLength(5);
    expect(put.body.lines.find((l) => l.service_category === 'rodent')).toEqual({
      service_category: 'rodent', home_technician_id: 'tech-new', gap_technician_id: null,
    });
    expect(put.body.lines.find((l) => l.service_category === 'general')).toEqual({
      service_category: 'general', home_technician_id: 'tech-new', gap_technician_id: 'tech-adam',
    });
  });

  it('says what the map does: records only in shadow, places new bookings in live', async () => {
    setup();
    const shadowCard = await screen.findByRole('region', { name: 'Service lines' });
    await waitFor(() => expect(within(shadowCard).getByText(/changes no booking/)).toBeInTheDocument());
    cleanup();
    setup({ mode: 'live' });
    const liveCard = await screen.findByRole('region', { name: 'Service lines' });
    await waitFor(() => expect(within(liveCard).getByText(/go to its home technician, else its gap technician/)).toBeInTheDocument());
    expect(within(liveCard).queryByText(/changes no booking/)).not.toBeInTheDocument();
  });
});
