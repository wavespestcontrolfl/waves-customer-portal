// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/api', () => ({
  default: {
    getSchedule: vi.fn(),
    getNotificationPrefs: vi.fn(),
    getPropertyNotificationPrefs: vi.fn(),
    getPayments: vi.fn(),
    getBalance: vi.fn(),
    getCards: vi.fn(),
    getAutopay: vi.fn(),
    getNextService: vi.fn(),
    getServices: vi.fn(),
    getStationMap: vi.fn(),
    getLawnHealth: vi.fn(),
    getRequests: vi.fn(),
  },
}));

import api from '../utils/api';
import { BillingTab, MyPlanTab, MyRequestsCard, ScheduleTab } from './PortalPage';

const customer = {
  id: 'cust-1', firstName: 'Pat', lastName: 'Customer',
  phone: '9415551234', email: 'pat@example.com', tier: null,
  property: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  api.getLawnHealth.mockResolvedValue({ available: false });
  api.getAutopay.mockResolvedValue({ state: 'disabled' });
  api.getStationMap.mockResolvedValue({ available: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('authenticated portal partial failures', () => {
  it('keeps billing available when only notification preferences fail', async () => {
    api.getPayments.mockResolvedValue({ payments: [] });
    api.getBalance.mockResolvedValue({ currentBalance: 0 });
    api.getCards.mockResolvedValue({ cards: [] });
    api.getNotificationPrefs.mockRejectedValue(new Error('prefs unavailable'));

    render(<BillingTab customer={customer} />);

    expect(await screen.findByText(/notification preferences couldn.t be loaded/i)).toBeInTheDocument();
    expect(screen.getByText('Payment Methods')).toBeInTheDocument();
    expect(screen.queryByText(/could not load billing/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save billing preferences/i })).not.toBeInTheDocument();
  });

  it('shows a truthful retry state instead of an empty plan', async () => {
    api.getNextService.mockRejectedValue(new Error('schedule unavailable'));
    api.getSchedule.mockResolvedValue({ upcoming: [] });
    api.getServices.mockResolvedValue({ services: [] });

    render(<MyPlanTab customer={customer} />);

    expect(await screen.findByText(/couldn.t load your plan/i)).toBeInTheDocument();
    expect(screen.queryByText('No visit scheduled')).not.toBeInTheDocument();
    expect(screen.queryByText('No recurring plan on file')).not.toBeInTheDocument();
  });

  it('keeps current plan data available when only service history fails', async () => {
    api.getNextService.mockResolvedValue({ next: null });
    api.getSchedule.mockResolvedValue({ upcoming: [] });
    api.getServices.mockRejectedValue(new Error('history unavailable'));

    render(<MyPlanTab customer={customer} />);

    expect(await screen.findByText('No visit scheduled')).toBeInTheDocument();
    expect(screen.queryByText(/couldn.t load your plan/i)).not.toBeInTheDocument();
  });

  it('keeps the schedule visible while property recipients are unavailable', async () => {
    api.getSchedule.mockResolvedValue({ upcoming: [] });
    api.getNotificationPrefs.mockResolvedValue({});
    api.getPropertyNotificationPrefs.mockRejectedValue(new Error('property prefs unavailable'));

    render(<ScheduleTab customer={customer} properties={[]} onRequestVisit={() => {}} />);

    expect(await screen.findByText(/property contacts couldn.t be loaded/i)).toBeInTheDocument();
    expect(screen.getByText(/no upcoming services scheduled/i)).toBeInTheDocument();
  });

  it('describes reminder delivery using the customer saved channels', async () => {
    const futureDate = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    api.getSchedule.mockResolvedValue({
      upcoming: [{ id: 'svc-1', date: futureDate, serviceType: 'Pest Control', status: 'confirmed', windowStart: '09:00' }],
    });
    api.getNotificationPrefs.mockResolvedValue({
      serviceReminder72hChannel: 'email',
      serviceReminder24hChannel: 'both',
    });
    api.getPropertyNotificationPrefs.mockResolvedValue({ properties: [] });

    render(<ScheduleTab customer={customer} properties={[]} onRequestVisit={() => {}} />);

    expect(await screen.findByText('72-hour email reminder')).toBeInTheDocument();
    expect(screen.getByText('24-hour text + email reminder')).toBeInTheDocument();
    expect(screen.queryByText('72-hour SMS reminder')).not.toBeInTheDocument();
  });

  it('does not promise reminders the customer opted out of', async () => {
    const futureDate = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    api.getSchedule.mockResolvedValue({
      upcoming: [{ id: 'svc-1', date: futureDate, serviceType: 'Pest Control', status: 'confirmed', windowStart: '09:00' }],
    });
    api.getNotificationPrefs.mockResolvedValue({
      serviceReminder72h: false,
      serviceReminder24h: false,
      serviceReminder72hChannel: 'email',
      serviceReminder24hChannel: 'both',
    });
    api.getPropertyNotificationPrefs.mockResolvedValue({ properties: [] });

    render(<ScheduleTab customer={customer} properties={[]} onRequestVisit={() => {}} />);

    expect(await screen.findByText('Tech en route')).toBeInTheDocument();
    expect(screen.queryByText('72-hour email reminder')).not.toBeInTheDocument();
    expect(screen.queryByText('24-hour text + email reminder')).not.toBeInTheDocument();
  });

  it('does not silently remove the recent-request receipt on load failure', async () => {
    api.getRequests.mockRejectedValueOnce(new Error('requests unavailable'));
    render(<MyRequestsCard />);

    expect(await screen.findByText(/recent requests couldn.t be loaded/i)).toBeInTheDocument();
    api.getRequests.mockResolvedValueOnce({ requests: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.getRequests).toHaveBeenCalledTimes(2));
  });
});
