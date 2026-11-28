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
    getContactNotificationPrefs: vi.fn(),
    getPropertyNotificationPrefs: vi.fn(),
    getPropertyPreferences: vi.fn(),
    getPropertyRecommendations: vi.fn(),
    getPropertyAlerts: vi.fn(),
    getPropertyScore: vi.fn(),
    getWeather: vi.fn(),
    getTodayTracker: vi.fn(),
    getAutopay: vi.fn(),
    getBalance: vi.fn(),
    getServiceStats: vi.fn(),
    getGoogleReviewCard: vi.fn(),
    getReferrals: vi.fn(),
    getBlogPosts: vi.fn(),
    getNewsletterPosts: vi.fn(),
    getMistingSystem: vi.fn(),
    getYardWrapped: vi.fn(),
    getPetNameAsk: vi.fn(),
    getLawnHealth: vi.fn(),
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
import { DashboardTab, ScheduleTab } from './PortalPage';

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
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });

async function renderSchedule(visit, cust = customer) {
  api.getSchedule.mockResolvedValue({ upcoming: [visit] });
  render(<ScheduleTab customer={cust} />);
  await waitFor(() => expect(api.getSchedule).toHaveBeenCalled());
  await screen.findByText(/Quarterly Pest Control/);
}

describe('ScheduleTab — visit waiting for the customer to pick a day', () => {
  // Pin clock before 2026-11-05T01:00Z (Wed, Nov 4 at 8 PM Eastern) for the future-deadline assertions.
  const waiting = { ...baseVisit, customerPickBy: '2026-11-05T01:00:00.000Z' };

  it('shows the pick wording, the pick-by time and a link to the reschedule page', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-11-03T15:00:00.000Z').getTime());
    await renderSchedule(waiting);
    expect(screen.getByText('New day: your pick')).toBeInTheDocument();
    expect(screen.getByText('Pick a time', { selector: 'div' })).toBeInTheDocument();
    expect(screen.getByText(
      "Pick a new time by Wed, Nov 4 at 8 PM. If you don't, we'll book the best open time and text you 3 days before."
    )).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Pick a time' })).toHaveAttribute('href', waiting.rescheduleUrl);
    expect(screen.queryByText('Time TBD')).not.toBeInTheDocument();
    expect(screen.queryByText(/72 hours before this visit/)).not.toBeInTheDocument();
    // No time yet: the server refuses a confirm (409 PICK_A_TIME), so no Confirm button.
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
  });

  it('shows the same late pick-by wording as Home after the deadline passes while keeping Pick a time available', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-11-05T02:00:00.000Z').getTime());
    await renderSchedule(waiting);
    expect(screen.getByText(
      "The pick-by time passed (Wed, Nov 4 at 8 PM). You can still pick a time now, or overnight we'll book the best open time and text you 3 days before."
    )).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Pick a time' })).toHaveAttribute('href', waiting.rescheduleUrl);
  });

  it('shows neutral automatic-booking wording after the deadline when no pick link is available or the session is read-only', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-11-05T02:00:00.000Z').getTime());
    await renderSchedule({ ...waiting, rescheduleUrl: null });
    expect(screen.getByText(
      "The pick-by time passed (Wed, Nov 4 at 8 PM). Overnight we'll book the best open time and text you 3 days before."
    )).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Pick a time' })).not.toBeInTheDocument();

    cleanup();
    await renderSchedule(waiting, { ...customer, actor: { kind: 'contact', id: 'c-1' } });
    expect(screen.getByText(
      "The pick-by time passed (Wed, Nov 4 at 8 PM). Overnight we'll book the best open time and text you 3 days before."
    )).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Pick a time' })).not.toBeInTheDocument();
  });

  it('omits the link when the visit has no reschedule link', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-11-03T15:00:00.000Z').getTime());
    await renderSchedule({ ...waiting, rescheduleUrl: null });
    expect(screen.getByText(/Pick a new time by Wed, Nov 4 at 8 PM/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Pick a time' })).not.toBeInTheDocument();
  });

  it('omits the link for a cancelled (read-only) session', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-11-03T15:00:00.000Z').getTime());
    await renderSchedule(waiting, { ...customer, cancelled: true, cancelledAt: '2026-08-22' });
    expect(screen.getByText(/Pick a new time by Wed, Nov 4 at 8 PM/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Pick a time' })).not.toBeInTheDocument();
  });

  it('shows the minutes when the pick-by is not on the hour', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-11-03T15:00:00.000Z').getTime());
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
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
  });
});

describe('DashboardTab — visit waiting for the customer to pick a day', () => {
  // Future pick-by deadline relative to the test clock: 3 days out at 8 PM Eastern (EST/EDT safe).
  const futurePickBy = new Date(Date.now() + 3 * 86400000).toISOString();
  const pastPickBy = '2026-11-05T01:00:00.000Z'; // Wed, Nov 4 at 8 PM Eastern (in the past)
  const waitingFuture = { ...baseVisit, customerPickBy: futurePickBy };
  const waitingPast = { ...baseVisit, customerPickBy: pastPickBy };

  async function renderDashboard(nextVisit, cust = customer) {
    api.getNextService.mockResolvedValue({ next: nextVisit });
    api.getServices.mockResolvedValue({ services: [] });
    api.getServiceStats.mockResolvedValue({});
    api.getBalance.mockResolvedValue({ currentBalance: 0 });
    api.getAutopay.mockResolvedValue({ state: 'disabled' });
    api.getTodayTracker.mockResolvedValue({ tracker: null });
    api.getGoogleReviewCard.mockResolvedValue({ card: null });
    api.getReferrals.mockResolvedValue({ stats: null });
    api.getBlogPosts.mockResolvedValue({ posts: [] });
    api.getNewsletterPosts.mockResolvedValue({ posts: [] });
    api.getMistingSystem.mockResolvedValue({ system: null });
    api.getYardWrapped.mockResolvedValue({ enabled: false });
    api.getPetNameAsk.mockResolvedValue({ ask: false });
    api.getLawnHealth.mockResolvedValue(null);
    api.getPropertyRecommendations.mockResolvedValue({ available: false, cards: [] });
    api.getPropertyAlerts.mockResolvedValue({ alerts: [] });
    api.getPropertyScore.mockResolvedValue(null);
    render(<DashboardTab customer={cust} onSwitchTab={() => {}} onOpenPlanService={() => {}} />);
    await screen.findByText('Quarterly Pest Control');
  }

  it('replaces broken Confirm Visit + countdown with Pick a time link, preserves Send photos, and shows future pick-by copy', async () => {
    await renderDashboard({ ...waitingFuture, prepPhotos: { eligible: true } });
    expect(screen.getByText('New day: your pick')).toBeInTheDocument();
    expect(screen.getByText(/Pick a new time by .+\. If you don't, we'll book the best open time and text you 3 days before\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Pick a time' })).toHaveAttribute('href', waitingFuture.rescheduleUrl);
    expect(screen.getByRole('button', { name: 'Send photos' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm Visit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Reschedule' })).not.toBeInTheDocument();
    expect(screen.queryByText('days')).not.toBeInTheDocument();
  });

  it('shows late pick-by wording when the deadline passed while keeping Pick a time available', async () => {
    await renderDashboard(waitingPast);
    expect(screen.getByText(
      "The pick-by time passed (Wed, Nov 4 at 8 PM). You can still pick a time now, or overnight we'll book the best open time and text you 3 days before.",
    )).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Pick a time' })).toHaveAttribute('href', waitingPast.rescheduleUrl);
  });

  it('omits the Pick a time link for cancelled or contact-actor read-only sessions', async () => {
    await renderDashboard(waitingFuture, { ...customer, cancelled: true, cancelledAt: '2026-08-22' });
    expect(screen.getByText('New day: your pick')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Pick a time' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm Visit' })).not.toBeInTheDocument();

    cleanup();
    await renderDashboard(waitingFuture, { ...customer, actor: { kind: 'contact', id: 'c-1' } });
    expect(screen.getByText('New day: your pick')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Pick a time' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm Visit' })).not.toBeInTheDocument();
  });
});
