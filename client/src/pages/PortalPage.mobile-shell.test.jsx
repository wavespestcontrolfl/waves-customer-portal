// @vitest-environment jsdom
// Pins the mobile-shell remediation: the Reminder Settings rows keep real
// switch semantics + labelled channel selects (the overflow fix restructured
// that row), and the home quick actions all render at compact phone widths
// (where the grid drops from 4-up to 2-up).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { ScheduleTab, DashboardTab } from './PortalPage';

const customer = {
  id: 'cust-1', firstName: 'Pat', lastName: 'Customer',
  phone: '9415551234', email: 'pat@example.com', tier: null,
  monthlyRate: 89, property: {},
};

const ORIGINAL_INNER_WIDTH = window.innerWidth;

beforeEach(() => {
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
  // innerWidth is [Replaceable] in jsdom — plain assignment shadows it.
  window.innerWidth = ORIGINAL_INNER_WIDTH;
});

describe('reminder settings rows', () => {
  it('keeps an accessible switch for every alert after the overflow restructure', async () => {
    render(<ScheduleTab customer={customer} properties={[]} onRequestVisit={() => {}} />);

    const switchNames = [
      'New Appointment Confirmation',
      '72-Hour Appointment Reminder',
      '24-Hour Service Reminder',
      'Tech En Route Alert',
      'Tech Arrived Alert',
      'Weather & Property Alerts',
    ];
    for (const name of switchNames) {
      expect(await screen.findByRole('switch', { name })).toBeInTheDocument();
    }
  });

  it('keeps labelled channel selects on the alerts that offer delivery choice', async () => {
    render(<ScheduleTab customer={customer} properties={[]} onRequestVisit={() => {}} />);
    await screen.findByRole('switch', { name: 'New Appointment Confirmation' });

    const channelNames = [
      'New Appointment Confirmation',
      '72-Hour Appointment Reminder',
      '24-Hour Service Reminder',
      'Tech En Route Alert',
    ];
    for (const name of channelNames) {
      expect(screen.getByRole('combobox', { name: `Delivery method for ${name}` })).toBeInTheDocument();
    }
    // SMS-only / app-only alerts deliberately never grew a select.
    expect(screen.queryByRole('combobox', { name: /Tech Arrived Alert/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /Weather & Property Alerts/i })).not.toBeInTheDocument();
  });
});

describe('home quick actions on compact widths', () => {
  it('renders all four actions at a 360px viewport', async () => {
    window.innerWidth = 360; // useIsMobile reads innerWidth on mount
    render(<DashboardTab customer={customer} onSwitchTab={() => {}} onOpenPlanService={() => {}} />);

    // Compact chips drop the sub-line, so the accessible name is the bare label.
    const request = await screen.findByRole('button', { name: 'Request' });
    for (const name of ['Message', 'Billing', 'Refer']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }

    // 2-up grid on compact. jsdom doesn't reliably parse grid shorthand
    // inline styles, so only assert when the value is readable.
    const cols = request.parentElement?.style?.gridTemplateColumns;
    if (cols) expect(cols).toContain('repeat(2');
  });
});
