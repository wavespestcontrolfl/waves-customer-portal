// @vitest-environment jsdom
// Pins the tranche-3 silent-failure fixes: a failed request must degrade
// loudly (error + retry) instead of masquerading as valid data or success.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ enabled: false }));
vi.mock('../native/platform', async (importOriginal) => ({
  ...await importOriginal(), isNativeApp: () => native.enabled,
}));

// Any api method not explicitly mocked returns a forever-pending promise, so
// untested widgets sit in their loading states instead of crashing the render.
vi.mock('../utils/api', () => {
  const target = {};
  const proxy = new Proxy(target, {
    get: (obj, prop) => {
      if (typeof prop !== 'string') return obj[prop];
      if (!(prop in obj)) obj[prop] = vi.fn(() => new Promise(() => {}));
      return obj[prop];
    },
    set: (obj, prop, value) => { obj[prop] = value; return true; },
  });
  return { default: proxy };
});

import api from '../utils/api';
import { ScheduleTab, PropertyTab, ServiceTracker, DashboardTab, ServicesTab } from './PortalPage';
import NotificationBell from '../components/NotificationBell';
import InstallPrompt from '../components/InstallPrompt';
import { PortalReadProvider } from '../hooks/usePortalRead';
import { PortalRefreshArea } from '../components/portal/PortalRefresh';

const customer = {
  id: 'cust-1', firstName: 'Pat', lastName: 'Customer',
  phone: '9415551234', email: 'pat@example.com', tier: null,
  monthlyRate: 89, property: {},
};

const futureDate = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

beforeEach(() => {
  native.enabled = false;
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  api.getSchedule.mockResolvedValue({ upcoming: [] });
  api.getNotificationPrefs.mockResolvedValue({});
  api.getPropertyNotificationPrefs.mockResolvedValue({ properties: [] });
  api.getPropertyPreferences.mockResolvedValue({ preferences: {} });
  api.getServicePreferences.mockResolvedValue({ preferences: {} });
  api.getTodayTracker.mockResolvedValue({ tracker: null });
  api.getActiveTracker.mockResolvedValue({ tracker: null });
  api.getWeather.mockResolvedValue(null);
  api.getAutopay.mockResolvedValue({ state: 'disabled' });
  api.getNextService.mockResolvedValue({ next: null });
  api.getServiceStats.mockResolvedValue({});
  api.getBalance.mockResolvedValue({ currentBalance: 0 });
  api.getServices.mockResolvedValue({ services: [] });
  api.getPendingSatisfaction.mockResolvedValue({ pending: null });
  api.getReferrals.mockResolvedValue({ stats: null });
  api.getBlogPosts.mockResolvedValue({ posts: [] });
  api.getNewsletterPosts.mockResolvedValue({ posts: [] });
  api.getRequests.mockResolvedValue({ requests: [] });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('open service reports', () => {
  it('retains previously loaded older visits when going offline and revisiting the tab', async () => {
    api.getServices.mockResolvedValueOnce({ services: [{ id: 'recent', type: 'Recent fixture treatment', date: '2024-02-01' }], total: 2 })
      .mockResolvedValueOnce({ services: [{ id: 'older', type: 'Older fixture treatment', date: '2024-01-01' }] });
    const view = (show) => <PortalReadProvider enabled><PortalRefreshArea>{show && <ServicesTab />}</PortalRefreshArea></PortalReadProvider>;
    const { rerender } = render(view(true));
    fireEvent.click(await screen.findByRole('button', { name: 'Load More Visits', exact: true }));
    await screen.findByRole('button', { name: /Older fixture treatment/ });
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    fireEvent(window, new Event('offline'));
    expect(screen.getByText('Older fixture treatment', { exact: true })).toBeInTheDocument();
    rerender(view(false));
    rerender(view(true));
    expect(await screen.findByText('Older fixture treatment', { exact: true })).toBeInTheDocument();
    expect(api.getServices).toHaveBeenCalledTimes(2);
  });

  it.each(['refresh', 'offline'])('keeps the existing report iframe mounted during %s', async (transition) => {
    native.enabled = true;
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const visits = { services: [{ id: 'visit-report', date: futureDate, type: 'Fixture treatment', reportUrl: '/report/fixture' }] };
    let finishRead;
    api.getServices.mockResolvedValueOnce(visits).mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
    render(<PortalReadProvider enabled><PortalRefreshArea><ServicesTab /></PortalRefreshArea></PortalReadProvider>);
    fireEvent.click(await screen.findByRole('button', { name: /Fixture treatment/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Download', exact: true }));
    const frame = screen.getByRole('dialog').querySelector('iframe');
    expect(frame).not.toBeNull();
    if (transition === 'offline') {
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
      fireEvent(window, new Event('offline'));
    } else {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh', exact: true }));
    }
    expect(screen.getByRole('heading', { name: 'Saved completed visits' })).toBeInTheDocument();
    expect(screen.getByRole('dialog').querySelector('iframe')).toBe(frame);
    if (transition === 'offline') {
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
      fireEvent(window, new Event('online'));
    }
    await act(async () => finishRead(visits));
    expect(screen.getByRole('dialog').querySelector('iframe')).toBe(frame);
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    expect(document.body.style.position).not.toBe('fixed');
  });
});

describe('dashboard appointment confirmation', () => {
  it('does not confirm a replacement appointment when an earlier confirmation finishes', async () => {
    let finishConfirmation;
    api.confirmAppointment.mockImplementationOnce(() => new Promise(resolve => { finishConfirmation = resolve; }));
    api.getNextService.mockResolvedValueOnce({ next: {
      id: 'visit-a', date: futureDate, serviceType: 'First appointment', customerConfirmed: false,
    } }).mockResolvedValue({ next: {
      id: 'visit-b', date: futureDate, serviceType: 'Replacement appointment', customerConfirmed: false,
    } });
    render(<PortalReadProvider enabled><PortalRefreshArea><DashboardTab customer={customer} onSwitchTab={() => {}} onOpenPlanService={() => {}} /></PortalRefreshArea></PortalReadProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm Visit', exact: true }));
    expect(api.confirmAppointment).toHaveBeenCalledWith('visit-a');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh', exact: true }));
    expect(await screen.findByText('Replacement appointment')).toBeInTheDocument();
    await act(async () => { finishConfirmation({ success: true }); });
    await waitFor(() => expect(api.getNextService).toHaveBeenCalledTimes(3));
    expect(screen.getByRole('button', { name: 'Confirm Visit', exact: true })).toBeEnabled();
    expect(screen.queryByText('Confirmed', { exact: true })).not.toBeInTheDocument();
  });
});

describe('schedule survives notification-preference failures', () => {
  it('refreshes the next-visit summaries for the other properties on the account', async () => {
    const properties = [{ id: customer.id, profileLabel: 'Home' }, { id: 'cust-2', profileLabel: 'Second property' }];
    api.getAccountUpcoming.mockResolvedValueOnce({ properties: [{ id: 'cust-2', next: {
      date: futureDate, serviceType: 'Original other-property service',
    } }] }).mockResolvedValue({ properties: [{ id: 'cust-2', next: {
      date: futureDate, serviceType: 'Updated other-property service',
    } }] });
    render(<PortalReadProvider enabled><PortalRefreshArea><ScheduleTab customer={customer} properties={properties} /></PortalRefreshArea></PortalReadProvider>);
    expect(await screen.findByText('Original other-property service')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh', exact: true }));
    expect(await screen.findByText('Updated other-property service')).toBeInTheDocument();
    expect(screen.queryByText('Original other-property service')).not.toBeInTheDocument();
    expect(api.getAccountUpcoming).toHaveBeenCalledTimes(2);
  });

  it('refreshes visits without replacing an unsaved service-contact edit', async () => {
    api.getPropertyNotificationPrefs.mockResolvedValue({ properties: [{
      id: customer.id, label: 'Home', preferences: {},
      serviceContacts: [{ firstName: 'Fixture', lastName: '', phone: '', email: '' }],
    }] });
    render(<PortalReadProvider enabled><PortalRefreshArea><ScheduleTab customer={customer} properties={[]} /></PortalRefreshArea></PortalReadProvider>);
    const input = await screen.findByLabelText('First name');
    fireEvent.change(input, { target: { value: 'Unsaved edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh', exact: true }));
    await waitFor(() => expect(api.getSchedule).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText('First name')).toHaveValue('Unsaved edit');
    expect(api.getPropertyNotificationPrefs).toHaveBeenCalledTimes(1);
  });

  it('keeps valid appointments visible and offers a prefs retry', async () => {
    api.getSchedule.mockResolvedValue({
      upcoming: [{ id: 'svc-1', date: futureDate, serviceType: 'Pest Control', status: 'confirmed', windowStart: '09:00' }],
    });
    api.getNotificationPrefs.mockRejectedValue(new Error('prefs unavailable'));

    render(<ScheduleTab customer={customer} properties={[]} onRequestVisit={() => {}} />);

    expect(await screen.findByText('Pest Control')).toBeInTheDocument();
    expect(screen.queryByText(/could not load your schedule/i)).not.toBeInTheDocument();
    expect(screen.getByText(/notification preferences couldn.t be loaded/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});

describe('service preferences fail closed', () => {
  it('never renders default toggles when the read fails', async () => {
    api.getServicePreferences.mockRejectedValue(new Error('unavailable'));

    render(<PropertyTab customer={customer} />);

    expect(await screen.findByText(/visit preferences couldn.t be loaded/i)).toBeInTheDocument();
    expect(screen.queryByText('Interior spraying')).not.toBeInTheDocument();
    expect(screen.queryByText('Exterior eave sweep')).not.toBeInTheDocument();
  });
});

describe('notification bell failures', () => {
  it('distinguishes a failed inbox from an empty one', async () => {
    api.request.mockImplementation((path) => {
      if (path.includes('unread-count')) return Promise.resolve({ count: 0 });
      return Promise.reject(new Error('list unavailable'));
    });

    render(<NotificationBell type="customer" />);
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }));

    expect(await screen.findByText(/notifications couldn.t be loaded/i)).toBeInTheDocument();
    expect(screen.queryByText('No notifications yet')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});

describe('tracker polls from step 1', () => {
  it('keeps refreshing a Scheduled tracker so state changes arrive', async () => {
    vi.useFakeTimers();
    api.getTodayTracker.mockResolvedValue({
      tracker: {
        currentStep: 1, state: 'scheduled', service: { type: 'Pest Control' },
        steps: Array.from({ length: 7 }, () => ({ completedAt: null })),
      },
    });

    render(<ServiceTracker />);
    await vi.advanceTimersByTimeAsync(50); // initial load settles

    expect(api.getActiveTracker).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15000);
    expect(api.getActiveTracker).toHaveBeenCalled();
  });
});

describe('satisfaction note failures', () => {
  it('keeps the feedback form open instead of a false thank-you', async () => {
    api.getPendingSatisfaction.mockResolvedValue({
      pending: [{ id: 'svc-9', serviceType: 'Pest Control', date: futureDate }],
    });
    api.submitSatisfaction
      .mockResolvedValueOnce({ action: 'feedback' }) // the rating itself
      .mockRejectedValueOnce(new Error('network down')); // the written note

    render(<DashboardTab customer={customer} onSwitchTab={() => {}} onOpenPlanService={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: '3' }));

    const noteBox = await screen.findByPlaceholderText(/anything we could do better/i);
    fireEvent.change(noteBox, { target: { value: 'Tech left the gate open' } });
    fireEvent.click(screen.getByRole('button', { name: /send feedback/i }));

    expect(await screen.findByText(/your note could not be sent/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/anything we could do better/i)).toHaveValue('Tech left the gate open');
    expect(screen.queryByText(/we appreciate the note/i)).not.toBeInTheDocument();
  });

  it('treats a duplicate 409 on the note as already saved', async () => {
    api.getPendingSatisfaction.mockResolvedValue({
      pending: [{ id: 'svc-9', serviceType: 'Pest Control', date: futureDate }],
    });
    const dupe = new Error('Already rated this service');
    dupe.status = 409;
    api.submitSatisfaction
      .mockResolvedValueOnce({ action: 'feedback' })
      .mockRejectedValueOnce(dupe);

    render(<DashboardTab customer={customer} onSwitchTab={() => {}} onOpenPlanService={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: '3' }));
    const noteBox = await screen.findByPlaceholderText(/anything we could do better/i);
    fireEvent.change(noteBox, { target: { value: 'Second tab double-submit' } });
    fireEvent.click(screen.getByRole('button', { name: /send feedback/i }));

    expect(await screen.findByText(/we appreciate the note/i)).toBeInTheDocument();
    expect(screen.queryByText(/your note could not be sent/i)).not.toBeInTheDocument();
  });

  it('skips the POST entirely for an empty note', async () => {
    api.getPendingSatisfaction.mockResolvedValue({
      pending: [{ id: 'svc-9', serviceType: 'Pest Control', date: futureDate }],
    });
    api.submitSatisfaction.mockResolvedValueOnce({ action: 'feedback' });

    render(<DashboardTab customer={customer} onSwitchTab={() => {}} onOpenPlanService={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: '3' }));
    await screen.findByPlaceholderText(/anything we could do better/i);
    fireEvent.click(screen.getByRole('button', { name: /send feedback/i }));

    expect(await screen.findByText(/we appreciate the note/i)).toBeInTheDocument();
    expect(api.submitSatisfaction).toHaveBeenCalledTimes(1); // rating only
  });
});

describe('install banner', () => {
  it('hides after the browser prompt is consumed, even on decline', async () => {
    vi.useFakeTimers();
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    });
    sessionStorage.removeItem('pwaPromptDismissed');
    window.history.pushState({}, '', '/login');

    render(<MemoryRouter initialEntries={['/login']}><InstallPrompt /></MemoryRouter>);

    const evt = new Event('beforeinstallprompt');
    evt.prompt = vi.fn();
    evt.userChoice = Promise.resolve({ outcome: 'dismissed' });
    window.dispatchEvent(evt);
    await vi.advanceTimersByTimeAsync(31000);

    const install = screen.getByRole('button', { name: 'Install' });
    fireEvent.click(install);
    await vi.advanceTimersByTimeAsync(50);

    expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument();
  });
});
