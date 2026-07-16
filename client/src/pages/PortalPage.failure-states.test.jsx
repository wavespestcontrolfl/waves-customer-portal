// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/api', () => ({
  default: {
    request: vi.fn(),
    fetchRaw: vi.fn(),
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
    getPropertyPreferences: vi.fn(),
    updatePropertyPreferences: vi.fn(),
    getServicePreferences: vi.fn(),
    updateServicePreferences: vi.fn(),
  },
}));

import api from '../utils/api';
import {
  BillingTab,
  ChatWidget,
  MyPlanTab,
  MyRequestsCard,
  PropertyTab,
  ScheduleTab,
  clearRequestDeepLink,
  getRequestPhotoConfirmationError,
} from './PortalPage';

const customer = {
  id: 'cust-1', firstName: 'Pat', lastName: 'Customer',
  phone: '9415551234', email: 'pat@example.com', tier: null,
  property: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  api.getLawnHealth.mockResolvedValue({ available: false });
  api.getAutopay.mockResolvedValue({ state: 'disabled' });
  api.getStationMap.mockResolvedValue({ available: false });
});

afterEach(() => {
  cleanup();
  delete Element.prototype.scrollIntoView;
  vi.restoreAllMocks();
});

describe('authenticated portal partial failures', () => {
  it('sends chat messages and AI reports through the refresh-aware API client', async () => {
    api.request
      .mockResolvedValueOnce({ reply: 'Your next visit is Tuesday.', canReport: true })
      .mockResolvedValueOnce({ success: true });
    render(<ChatWidget customer={customer} onClose={() => {}} />);

    fireEvent.change(screen.getByLabelText('Chat message'), { target: { value: 'When is my visit?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(await screen.findByText('Your next visit is Tuesday.')).toBeInTheDocument();
    expect(api.request).toHaveBeenNthCalledWith(1, '/ai/chat', {
      method: 'POST',
      body: expect.any(String),
    });
    expect(JSON.parse(api.request.mock.calls[0][1].body)).toMatchObject({
      message: 'When is my visit?',
      sessionId: expect.stringMatching(/^chat-/),
    });

    fireEvent.click(screen.getByRole('button', { name: /report this ai response/i }));
    await waitFor(() => expect(api.request).toHaveBeenNthCalledWith(2, '/ai/chat/report', {
      method: 'POST',
      body: expect.any(String),
    }));
    expect(JSON.parse(api.request.mock.calls[1][1].body)).toMatchObject({
      messageContent: 'Your next visit is Tuesday.',
      sessionId: expect.stringMatching(/^chat-/),
    });
  });

  it('does not invent an attachment warning when a request had no photos', () => {
    expect(getRequestPhotoConfirmationError(0, undefined)).toBe('');
    expect(getRequestPhotoConfirmationError(2, undefined)).toMatch(/confirmation was unavailable/i);
    expect(getRequestPhotoConfirmationError(2, 1)).toMatch(/only 1 of 2 photos/i);
    expect(getRequestPhotoConfirmationError(2, 2)).toBe('');
  });

  it('clears a request deep-link when the request overlay closes', () => {
    window.history.replaceState({}, '', '/portal?tab=request');
    clearRequestDeepLink('dashboard');
    expect(window.location.pathname).toBe('/portal');
    expect(window.location.search).toBe('');
  });

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

  it('loads billing history through every server cursor before calculating totals', async () => {
    api.getPayments
      .mockResolvedValueOnce({
        payments: [{ id: 'pay-1', date: '2026-01-10', amount: 45, status: 'paid', description: 'January service', type: 'recurring' }],
        total: 2,
        hasMore: true,
        nextCursor: 17,
      })
      .mockResolvedValueOnce({
        payments: [{ id: 'pay-2', date: '2026-02-10', amount: 55, status: 'paid', description: 'February service', type: 'recurring' }],
        total: 2,
        hasMore: false,
        nextCursor: null,
      });
    api.getBalance.mockResolvedValue({ currentBalance: 0 });
    api.getCards.mockResolvedValue({ cards: [] });
    api.getNotificationPrefs.mockResolvedValue({});

    render(<BillingTab customer={customer} />);

    expect(await screen.findByText('January service')).toBeInTheDocument();
    expect(screen.getByText('February service')).toBeInTheDocument();
    expect(api.getPayments).toHaveBeenNthCalledWith(1, 100, 0);
    expect(api.getPayments).toHaveBeenNthCalledWith(2, 100, 17);
    expect(screen.getAllByText('$100.00').length).toBeGreaterThan(0);
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
    expect(screen.getByText(/completed visit history unavailable/i)).toBeInTheDocument();
  });

  it('counts individual plan visits when several occur in the same month', async () => {
    api.getNextService.mockResolvedValue({ next: null });
    api.getSchedule.mockResolvedValue({
      upcoming: [
        { id: 'up-1', date: '2026-08-05', serviceType: 'Pest Control', status: 'confirmed', isRecurring: true },
        { id: 'up-2', date: '2026-08-19', serviceType: 'Pest Control', status: 'confirmed', isRecurring: true },
      ],
    });
    api.getServices.mockResolvedValue({
      services: [
        { id: 'done-1', date: '2026-02-04', type: 'Pest Control', status: 'completed' },
        { id: 'done-2', date: '2026-02-18', type: 'Pest Control', status: 'completed' },
      ],
      total: 2,
    });

    render(<MyPlanTab customer={customer} />);

    expect(await screen.findByText('4 recorded or scheduled in 2026')).toBeInTheDocument();
    expect(screen.getByText('2 completed')).toBeInTheDocument();
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

  it('flushes a quick property edit through the scoped navigation event before unmount', async () => {
    api.getPropertyPreferences.mockResolvedValue({ preferences: {} });
    api.getServicePreferences.mockResolvedValue({
      preferences: { interior_spray: true, exterior_sweep: true },
    });
    api.updatePropertyPreferences.mockResolvedValue({ preferences: { neighborhoodGateCode: '1234' } });

    const { unmount } = render(<PropertyTab customer={customer} />);
    await screen.findByRole('heading', { name: 'My Property' });
    fireEvent.click(screen.getByRole('button', { name: /^Access/ }));
    fireEvent.change(screen.getByLabelText('Community Gate'), { target: { value: '1234' } });
    const waiters = [];
    await act(async () => {
      window.dispatchEvent(new CustomEvent('waves:property-switching', { detail: { waiters } }));
      await Promise.all(waiters);
    });
    unmount();

    await waitFor(() => expect(api.updatePropertyPreferences).toHaveBeenCalledWith({ neighborhoodGateCode: '1234' }));
  });

  it('does not start an unscoped property write while unmounting', async () => {
    api.getPropertyPreferences.mockResolvedValue({ preferences: {} });
    api.getServicePreferences.mockResolvedValue({
      preferences: { interior_spray: true, exterior_sweep: true },
    });

    const { unmount } = render(<PropertyTab customer={customer} />);
    await screen.findByRole('heading', { name: 'My Property' });
    fireEvent.click(screen.getByRole('button', { name: /^Access/ }));
    fireEvent.change(screen.getByLabelText('Community Gate'), { target: { value: '5678' } });
    unmount();

    await act(async () => { await Promise.resolve(); });
    expect(api.updatePropertyPreferences).not.toHaveBeenCalled();
  });

  it('drains an edit made while the navigation flush is saving', async () => {
    api.getPropertyPreferences.mockResolvedValue({ preferences: {} });
    api.getServicePreferences.mockResolvedValue({
      preferences: { interior_spray: true, exterior_sweep: true },
    });
    let resolveFirstSave;
    api.updatePropertyPreferences
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirstSave = resolve; }))
      .mockResolvedValueOnce({ preferences: { neighborhoodGateCode: '5678' } });

    render(<PropertyTab customer={customer} />);
    await screen.findByRole('heading', { name: 'My Property' });
    fireEvent.click(screen.getByRole('button', { name: /^Access/ }));
    const gateInput = screen.getByLabelText('Community Gate');
    fireEvent.change(gateInput, { target: { value: '1234' } });

    const waiters = [];
    let flushPromise;
    act(() => {
      window.dispatchEvent(new CustomEvent('waves:property-switching', { detail: { waiters } }));
      flushPromise = Promise.all(waiters);
    });
    await waitFor(() => expect(api.updatePropertyPreferences).toHaveBeenCalledWith({ neighborhoodGateCode: '1234' }));

    fireEvent.change(gateInput, { target: { value: '5678' } });
    await act(async () => {
      resolveFirstSave({ preferences: { neighborhoodGateCode: '1234' } });
      await flushPromise;
    });

    expect(api.updatePropertyPreferences).toHaveBeenNthCalledWith(2, { neighborhoodGateCode: '5678' });
  });
});
