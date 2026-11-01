// @vitest-environment jsdom
// Quick Move "let the customer pick a day": a visit handed to the customer sits
// at a placeholder date with no time. The Upcoming tab says so instead of
// showing the date, "Time TBD" and the 72-hour note. Every other windowless
// visit renders as before.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/api', () => ({
  default: {
    getSchedule: vi.fn(),
    getNotificationPrefs: vi.fn(),
    getPropertyNotificationPrefs: vi.fn(),
    getNextService: vi.fn(),
    getServices: vi.fn(),
    getRequests: vi.fn(),
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

const placeholderDate = new Date(Date.now() + 8 * 86400000).toISOString().slice(0, 10);
const baseVisit = {
  id: 'svc-1', date: placeholderDate, serviceType: 'Quarterly Pest Control',
  windowStart: null, status: 'pending', customerConfirmed: false,
  rescheduleUrl: '/reschedule/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
};

beforeEach(() => {
  Object.values(api).forEach((fn) => { if (typeof fn?.mockResolvedValue === 'function') fn.mockResolvedValue(null); });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

async function renderSchedule(visit, cust = customer) {
  api.getSchedule.mockResolvedValue({ upcoming: [visit] });
  render(<ScheduleTab customer={cust} />);
  await waitFor(() => expect(api.getSchedule).toHaveBeenCalled());
  await screen.findByText(/Quarterly Pest Control/);
}

describe('ScheduleTab — visit waiting for the customer to pick a day', () => {
  // 2026-11-05 01:00Z = Wed, Nov 4 at 8 PM Eastern (EST).
  const waiting = { ...baseVisit, customerPickBy: '2026-11-05T01:00:00.000Z' };

  it('shows the pick wording, the pick-by time and a link to the reschedule page', async () => {
    await renderSchedule(waiting);
    expect(screen.getByText('New day: your pick')).toBeInTheDocument();
    expect(screen.getByText('Pick a time', { selector: 'div' })).toBeInTheDocument();
    expect(screen.getByText(
      "Pick a new time by Wed, Nov 4 at 8 PM. If you don't, we'll book the best open time and text you 3 days before."
    )).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Pick a time' })).toHaveAttribute('href', waiting.rescheduleUrl);
    expect(screen.queryByText('Time TBD')).not.toBeInTheDocument();
    expect(screen.queryByText(/72 hours before this visit/)).not.toBeInTheDocument();
  });

  it('omits the link when the visit has no reschedule link', async () => {
    await renderSchedule({ ...waiting, rescheduleUrl: null });
    expect(screen.getByText(/Pick a new time by Wed, Nov 4 at 8 PM/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Pick a time' })).not.toBeInTheDocument();
  });

  it('omits the link for a cancelled (read-only) session', async () => {
    await renderSchedule(waiting, { ...customer, cancelled: true, cancelledAt: '2026-08-22' });
    expect(screen.getByText(/Pick a new time by Wed, Nov 4 at 8 PM/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Pick a time' })).not.toBeInTheDocument();
  });

  it('shows the minutes when the pick-by is not on the hour', async () => {
    await renderSchedule({ ...waiting, customerPickBy: '2026-11-05T01:30:00.000Z' });
    expect(screen.getByText(/Pick a new time by Wed, Nov 4 at 8:30 PM\./)).toBeInTheDocument();
  });
});

describe('ScheduleTab — ordinary windowless visit', () => {
  it('still shows Time TBD and the 72-hour note', async () => {
    await renderSchedule({ ...baseVisit, customerPickBy: null });
    expect(screen.getByText('Time TBD')).toBeInTheDocument();
    expect(screen.getByText("We'll confirm your time window 72 hours before this visit")).toBeInTheDocument();
    expect(screen.queryByText('New day: your pick')).not.toBeInTheDocument();
    expect(screen.queryByText(/Pick a new time by/)).not.toBeInTheDocument();
  });
});
