// @vitest-environment jsdom
// GATE_DAY_ONLY_PROMISE: a visit the customer was told only the day for arrives with no hour (the server blanks
// windowStart) plus day_only and arrival_note. The Upcoming tab shows the date and the note, not "Time TBD" or the
// 72-hour line, and the Confirm button posts the blank hour the server then fills in.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/api', () => ({
  default: {
    getSchedule: vi.fn(),
    getNotificationPrefs: vi.fn(),
    getPropertyNotificationPrefs: vi.fn(),
    getNextService: vi.fn(),
    getServices: vi.fn(),
    getRequests: vi.fn(),
    confirmAppointment: vi.fn(),
  },
}));
vi.mock('../components/brand/CustomerDialogHost', () => ({
  showCustomerAlert: vi.fn(),
  showCustomerConfirm: vi.fn(async () => true),
}));

import api from '../utils/api';
import { ScheduleTab } from './PortalPage';

const customer = {
  id: 'cust-1', firstName: 'Pat', lastName: 'Customer',
  phone: '9415551234', email: 'pat@example.com', tier: null, property: {},
};
const NOTE = 'Arrival window texted the day before';
const date = new Date(Date.now() + 8 * 86400000).toISOString().slice(0, 10);
const visit = {
  id: 'svc-1', date, serviceType: 'Quarterly Pest Control', windowStart: null, windowEnd: null,
  status: 'pending', customerConfirmed: false, day_only: true, arrival_note: NOTE,
};

beforeEach(() => {
  Object.values(api).forEach((fn) => { if (typeof fn?.mockResolvedValue === 'function') fn.mockResolvedValue(null); });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

async function renderSchedule(v) {
  api.getSchedule.mockResolvedValue({ upcoming: [v] });
  render(<ScheduleTab customer={customer} />);
  await waitFor(() => expect(api.getSchedule).toHaveBeenCalled());
  await screen.findByText(/Quarterly Pest Control/);
}

describe('ScheduleTab — day-only visit', () => {
  it('shows the arrival note in place of the hour, not "Time TBD" or the 72-hour line', async () => {
    await renderSchedule(visit);
    expect(screen.getAllByText(NOTE).length).toBeGreaterThan(0);
    expect(screen.queryByText('Time TBD')).not.toBeInTheDocument();
    expect(screen.queryByText(/72 hours before this visit/)).not.toBeInTheDocument();
  });

  it('Confirm posts the date and the blank hour', async () => {
    api.confirmAppointment.mockResolvedValue({ success: true });
    await renderSchedule(visit);
    fireEvent.click(screen.getAllByRole('button', { name: 'Confirm' })[0]);
    await waitFor(() => expect(api.confirmAppointment).toHaveBeenCalled());
    expect(api.confirmAppointment.mock.calls[0][0]).toBe('svc-1');
    expect(api.confirmAppointment.mock.calls[0][1]).toEqual({ date, windowStart: null });
  });

  it('an older payload (no day_only) keeps today\'s "Time TBD"', async () => {
    const { day_only: _d, arrival_note: _n, ...plain } = visit;
    await renderSchedule(plain);
    expect(screen.getAllByText('Time TBD').length).toBeGreaterThan(0);
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
  });

  it('a visit that shows its hour is unchanged', async () => {
    await renderSchedule({ ...visit, windowStart: '09:00:00', windowEnd: '11:00:00', day_only: undefined, arrival_note: undefined });
    expect(screen.getAllByText(/9:00 AM - 11:00 AM/).length).toBeGreaterThan(0);
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
  });
});
