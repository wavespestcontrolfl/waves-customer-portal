// @vitest-environment jsdom
// Customer-app fixes of 2026-11-26: real request status near the top of Home, retry on the
// money and schedule dead ends, tappable arrival-checklist rows and
// a Reschedule button on a missed visit, "You're offline" on a failed save, "View report" on a
// completed visit with no "N/A" tile, and Add to Calendar on every upcoming visit.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ enabled: false }));
vi.mock('../native/platform', async (importOriginal) => ({
  ...await importOriginal(), isNativeApp: () => native.enabled,
}));

// Any api method not explicitly mocked returns a forever-pending promise.
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
import CustomerDialogHost from '../components/brand/CustomerDialogHost';
import { DashboardTab, MyRequestsCard, ScheduleTab, ServiceTracker, ServicesTab } from './PortalPage';

const customer = {
  id: 'cust-1', firstName: 'Pat', lastName: 'Customer',
  phone: '9415551234', email: 'pat@example.com', tier: null, monthlyRate: 89, property: {},
};
const futureDate = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

const setOnLine = (value) => Object.defineProperty(navigator, 'onLine', { configurable: true, value });

beforeEach(() => {
  native.enabled = false;
  setOnLine(true);
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
  api.getGoogleReviewCard.mockResolvedValue({ card: null });
  api.getReferrals.mockResolvedValue({ stats: null });
  api.getBlogPosts.mockResolvedValue({ posts: [] });
  api.getNewsletterPosts.mockResolvedValue({ posts: [] });
  api.getRequests.mockResolvedValue({ requests: [] });
  api.getCards.mockResolvedValue({ cards: [] });
  api.getPayments.mockResolvedValue({ payments: [] });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const recentIso = () => new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

describe('fix 4: requests show their real status and sit near the top of Home', () => {
  it('prints the office status on every row, not only when opened from a notification', async () => {
    api.getRequests.mockResolvedValue({ requests: [
      { id: 'r1', subject: 'Ants in the kitchen', category: 'general', status: 'new', createdAt: recentIso() },
      { id: 'r2', subject: 'Gate was locked', category: 'general', status: 'acknowledged', createdAt: recentIso() },
      { id: 'r3', subject: 'Add lawn care', category: 'add_service', status: 'scheduled', createdAt: recentIso() },
    ] });
    render(<MyRequestsCard />);
    await screen.findByText('Ants in the kitchen');
    const pillFor = (subject) => within(screen.getByText(subject).closest('article')).getByText(/^(Received|Acknowledged|Scheduled|Resolved)$/);
    expect(pillFor('Ants in the kitchen')).toHaveTextContent('Received');
    expect(pillFor('Gate was locked')).toHaveTextContent('Acknowledged');
    expect(pillFor('Add lawn care')).toHaveTextContent('Scheduled');
  });

  it('renders the card under the shortcuts and above the blog, social and newsletter rows', async () => {
    api.getRequests.mockResolvedValue({ requests: [
      { id: 'r1', subject: 'Ants in the kitchen', category: 'general', status: 'acknowledged', createdAt: recentIso() },
    ] });
    api.getBlogPosts.mockResolvedValue({ posts: [{ link: 'https://example.test/post', title: 'Fixture blog post', description: 'x' }] });
    render(<DashboardTab customer={customer} onSwitchTab={() => {}} onOpenPlanService={() => {}} />);
    const requests = await screen.findByRole('region', { name: 'My Requests' });
    const blog = await screen.findByText('From the Waves Blog');
    const shortcuts = screen.getByRole('button', { name: /Billing/ });
    expect(shortcuts.compareDocumentPosition(requests) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(requests.compareDocumentPosition(blog) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows no card at all when no request is open', async () => {
    render(<DashboardTab customer={customer} onSwitchTab={() => {}} onOpenPlanService={() => {}} />);
    await waitFor(() => expect(api.getRequests).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: 'My Requests' })).not.toBeInTheDocument();
  });
});

describe('fix 5: money and schedule dead ends on Home retry', () => {
  it('turns "Billing unavailable / Call us" into "Tap to retry" that re-reads the balance', async () => {
    api.getBalance.mockRejectedValueOnce(new Error('balance down')).mockResolvedValue({ currentBalance: 0 });
    render(<DashboardTab customer={customer} onSwitchTab={() => {}} onOpenPlanService={() => {}} />);
    const tile = (await screen.findAllByText('Tap to retry'))[0].closest('button');
    expect(screen.queryByText('Call us')).not.toBeInTheDocument();
    expect(within(tile).getByText('Billing unavailable')).toBeInTheDocument();
    fireEvent.click(tile);
    await waitFor(() => expect(api.getBalance).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Account current')).toBeInTheDocument();
    expect(screen.queryByText('Tap to retry')).not.toBeInTheDocument();
  });

  it('still opens Billing from the balance tile when the balance loaded', async () => {
    const onSwitchTab = vi.fn();
    api.getBalance.mockResolvedValue({ currentBalance: 40 });
    render(<DashboardTab customer={customer} onSwitchTab={onSwitchTab} onOpenPlanService={() => {}} />);
    fireEvent.click((await screen.findByText('Balance due')).closest('button'));
    expect(onSwitchTab).toHaveBeenCalledWith('billing');
    expect(api.getBalance).toHaveBeenCalledTimes(1);
  });

  it('gives the failed schedule card a Try again button that reads the next visit again', async () => {
    api.getNextService.mockRejectedValueOnce(new Error('schedule down')).mockResolvedValue({
      next: { id: 'v1', date: futureDate, serviceType: 'Recovered visit', customerConfirmed: true },
    });
    render(<DashboardTab customer={customer} onSwitchTab={() => {}} onOpenPlanService={() => {}} />);
    await screen.findByText('We could not load your schedule right now.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Recovered visit')).toBeInTheDocument();
    expect(api.getNextService).toHaveBeenCalledTimes(2);
  });
});

describe('fix 7: service-day tracker rows and missed visits', () => {
  const tracker = (over = {}) => ({
    currentStep: 2, state: 'scheduled',
    steps: [{ completedAt: '2026-09-14T12:00:00Z' }, { completedAt: null }, { completedAt: null }, { completedAt: null }, { completedAt: null }, { completedAt: null }, { completedAt: null }],
    customerLocation: null, trackUrl: null, office: null, rainChance: null, stopsAhead: null, routeProgress: null, techApprox: null, etaSource: null,
    technician: { name: 'Sam Rivera', initials: 'SR' },
    service: { type: 'Quarterly Pest Control', date: '2026-09-14', windowStart: '09:00:00', windowEnd: '11:00:00' },
    etaMinutes: null, liveNotes: [], serviceSummary: null, techPosition: null,
    ...over,
  });

  it('opens My Property at access from "No gate code on file" and at pets from "Secure pets"', async () => {
    api.getTodayTracker.mockResolvedValue({ tracker: tracker() });
    const onOpenAccess = vi.fn();
    const onOpenPets = vi.fn();
    render(<ServiceTracker onOpenAccess={onOpenAccess} onOpenPets={onOpenPets} />);
    fireEvent.click(await screen.findByRole('button', { name: /No gate code on file/ }));
    expect(onOpenAccess).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /Secure pets before tech arrives/ }));
    expect(onOpenPets).toHaveBeenCalledTimes(1);
    // Rows that are already fine stay plain text, and the office hours stay as ruled.
    expect(screen.queryByRole('button', { name: /Ensure gates are unlocked/ })).not.toBeInTheDocument();
    expect(screen.getByText('Open 24 hrs')).toBeInTheDocument();
  });

  it('keeps "Secure pets" read-only on a secondary property, where My Property has no editor for this house', async () => {
    api.getTodayTracker.mockResolvedValue({ tracker: tracker() });
    const onOpenPets = vi.fn();
    const secondary = { id: 'c1:pb', key: 'c1:pb', customerId: 'c1', propertyId: 'pb', isPrimaryProperty: false };
    render(<ServiceTracker currentEntry={secondary} savedScope onOpenPets={onOpenPets} />);
    await screen.findByText('Secure pets before tech arrives');
    expect(screen.queryByRole('button', { name: /Secure pets before tech arrives/ })).not.toBeInTheDocument();
  });

  it.each([
    ['no_show', 'We missed you.'],
    ['cancelled', 'This visit was cancelled.'],
  ])('gives a %s visit a Reschedule button that opens the request flow', async (state, headline) => {
    api.getTodayTracker.mockResolvedValue({ tracker: tracker({ currentStep: 7, state, office: { name: 'Waves', phone: '(941) 297-5749' } }) });
    const onReschedule = vi.fn();
    render(<ServiceTracker onReschedule={onReschedule} />);
    await screen.findByText(headline);
    fireEvent.click(screen.getByRole('button', { name: 'Reschedule' }));
    expect(onReschedule).toHaveBeenCalledTimes(1);
  });

  it('links straight to the visit reschedule page when the data carries one', async () => {
    api.getTodayTracker.mockResolvedValue({ tracker: tracker({ currentStep: 7, state: 'no_show', rescheduleUrl: '/reschedule/abc', office: { name: 'Waves', phone: '(941) 297-5749' } }) });
    render(<ServiceTracker onReschedule={() => {}} />);
    expect(await screen.findByRole('link', { name: 'Reschedule' })).toHaveAttribute('href', '/reschedule/abc');
  });

  it('shows no Reschedule button on a completed visit', async () => {
    api.getTodayTracker.mockResolvedValue({ tracker: tracker({ currentStep: 7, state: 'complete', office: { name: 'Waves', phone: '(941) 297-5749' } }) });
    render(<ServiceTracker onReschedule={() => {}} />);
    await screen.findByText('Thanks for choosing Waves.');
    expect(screen.queryByRole('button', { name: 'Reschedule' })).not.toBeInTheDocument();
  });
});

describe('fix 8: a failed save with no signal says so', () => {
  const failConfirm = async () => {
    api.getNextService.mockResolvedValue({ next: { id: 'visit-a', date: futureDate, serviceType: 'Fixture visit', customerConfirmed: false } });
    api.confirmAppointment.mockRejectedValue(new Error('Failed to fetch'));
    render(<><CustomerDialogHost /><DashboardTab customer={customer} onSwitchTab={() => {}} onOpenPlanService={() => {}} /></>);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm Visit', exact: true }));
  };

  it('offline: names the missing signal instead of "Please try again"', async () => {
    setOnLine(false);
    await failConfirm();
    expect(await screen.findByText("You're offline. Try again when you have signal.")).toBeInTheDocument();
    expect(screen.queryByText('Could not confirm this visit. Please try again.')).not.toBeInTheDocument();
  });

  it('online: keeps the generic message', async () => {
    await failConfirm();
    expect(await screen.findByText('Could not confirm this visit. Please try again.')).toBeInTheDocument();
    expect(screen.queryByText(/You're offline/)).not.toBeInTheDocument();
  });
});

describe('fix 9: visits', () => {
  const completed = (over = {}) => ({
    id: 'svc-1', date: `${new Date().getFullYear()}-02-14`, type: 'Quarterly Pest Control', status: 'completed',
    hasPhotos: false, photoCount: 0, products: [], reportUrl: '/report/svc-1', reportAvailable: true, ...over,
  });

  it('drops the permanent "N/A" tile', async () => {
    api.getServices.mockResolvedValue({ services: [completed()], total: 1 });
    render(<ServicesTab />);
    await screen.findByText('Quarterly Pest Control');
    expect(screen.queryByText('N/A')).not.toBeInTheDocument();
    expect(screen.queryByText('Avg visit')).not.toBeInTheDocument();
    expect(screen.getByText('Technicians')).toBeInTheDocument();
  });

  it('on the web a completed visit opens the full report under "View report" and still offers the PDF', async () => {
    api.getServices.mockResolvedValue({ services: [completed()], total: 1 });
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<ServicesTab />);
    fireEvent.click(await screen.findByText('Quarterly Pest Control'));
    fireEvent.click(await screen.findByRole('button', { name: 'View report' }));
    expect(open).toHaveBeenCalledWith('/report/svc-1', '_blank', 'noopener');
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
  });

  it('with no report page on the web the only action is the PDF, still called Download', async () => {
    api.getServices.mockResolvedValue({ services: [completed({ reportUrl: null })], total: 1 });
    render(<ServicesTab />);
    fireEvent.click(await screen.findByText('Quarterly Pest Control'));
    expect(await screen.findByRole('button', { name: 'Download' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'View report' })).not.toBeInTheDocument();
  });

  it('in the app the one action is "View report" and it opens the in-app overlay', async () => {
    native.enabled = true;
    api.getServices.mockResolvedValue({ services: [completed()], total: 1 });
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<ServicesTab />);
    fireEvent.click(await screen.findByText('Quarterly Pest Control'));
    fireEvent.click(await screen.findByRole('button', { name: 'View report' }));
    expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument();
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();
  });

  it('gives every upcoming visit the server calendar file as Add to Calendar (all-day when the visit is day-only)', async () => {
    const live = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    api.getSchedule.mockResolvedValue({ upcoming: [
      { id: 'a', date: futureDate, serviceType: 'Pest Control', status: 'confirmed', calendarUrl: '/api/appointments/tok-a/calendar.ics', calendarExpiresAt: live },
      { id: 'b', date: futureDate, serviceType: 'Lawn Care', status: 'confirmed', calendarUrl: '/api/appointments/tok-b/calendar.ics', calendarExpiresAt: live },
      { id: 'c', date: futureDate, serviceType: 'Mosquito', status: 'confirmed', calendarUrl: null, calendarExpiresAt: null },
    ] });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 404 });
    render(<ScheduleTab customer={customer} properties={[]} onRequestVisit={() => {}} />);
    await screen.findByText('Lawn Care');
    const buttons = screen.getAllByRole('button', { name: 'Add to Calendar' });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(String(fetchSpy.mock.calls[0][0])).toMatch(/calendar\.ics$/);
  });

  it('removes Add to Calendar at the server deadline while the Visits tab stays open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const soon = new Date(Date.now() + 5000).toISOString();
      api.getSchedule.mockResolvedValue({ upcoming: [
        { id: 'a', date: futureDate, serviceType: 'Pest Control', status: 'confirmed', calendarUrl: '/api/appointments/tok-a/calendar.ics', calendarExpiresAt: soon },
      ] });
      render(<ScheduleTab customer={customer} properties={[]} onRequestVisit={() => {}} />);
      await screen.findByRole('button', { name: 'Add to Calendar' });
      await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
      expect(screen.queryByRole('button', { name: 'Add to Calendar' })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps Add to Calendar through the inclusive deadline and drops it 1 ms after, on Home and on Visits', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    try {
      const deadline = new Date(Date.now() + 3000).toISOString();
      const visit = { id: 'a', date: futureDate, serviceType: 'Pest Control', status: 'confirmed', calendarUrl: '/api/appointments/tok-a/calendar.ics', calendarExpiresAt: deadline };
      api.getSchedule.mockResolvedValue({ upcoming: [visit] });
      api.getNextService.mockResolvedValue({ next: visit });
      render(<><ScheduleTab customer={customer} properties={[]} onRequestVisit={() => {}} /><DashboardTab customer={customer} onSwitchTab={() => {}} onOpenPlanService={() => {}} /></>);
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      expect(screen.getAllByRole('button', { name: 'Add to Calendar' })).toHaveLength(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(2990); });
      // Now is exactly the deadline: the server still serves the file.
      expect(screen.getAllByRole('button', { name: 'Add to Calendar' })).toHaveLength(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(screen.queryByRole('button', { name: 'Add to Calendar' })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('hides Add to Calendar once the server window has closed', async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    api.getSchedule.mockResolvedValue({ upcoming: [
      { id: 'a', date: futureDate, serviceType: 'Pest Control', status: 'confirmed', calendarUrl: '/api/appointments/tok-a/calendar.ics', calendarExpiresAt: past },
    ] });
    render(<ScheduleTab customer={customer} properties={[]} onRequestVisit={() => {}} />);
    await screen.findByText('Pest Control');
    expect(screen.queryByRole('button', { name: 'Add to Calendar' })).not.toBeInTheDocument();
  });
});
