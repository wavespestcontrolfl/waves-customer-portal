// @vitest-environment jsdom
// Pins the tranche-1 truth fixes: customer-facing copy must not promise
// schedules, money, or outcomes the server doesn't back.
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
import { ScheduleTab, ServiceTracker, DashboardTab } from './PortalPage';

const customer = {
  id: 'cust-1', firstName: 'Pat', lastName: 'Customer',
  phone: '9415551234', email: 'pat@example.com', tier: null,
  monthlyRate: 89, property: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  api.getSchedule.mockResolvedValue({ upcoming: [] });
  api.getNotificationPrefs.mockResolvedValue({});
  api.getPropertyNotificationPrefs.mockResolvedValue({ properties: [] });
  api.getPropertyPreferences.mockResolvedValue({ preferences: {} });
  api.getWeather.mockResolvedValue(null);
  api.getTodayTracker.mockResolvedValue({ tracker: null });
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
});

describe('empty schedule does not invent treatments', () => {
  it('shows a neutral empty state with no fabricated quarterly or mosquito months', async () => {
    render(<ScheduleTab customer={customer} properties={[]} onRequestVisit={() => {}} />);

    expect(await screen.findByText('No upcoming services scheduled')).toBeInTheDocument();
    expect(screen.getByText(/request a visit and we.ll get you scheduled/i)).toBeInTheDocument();
    expect(screen.queryByText(/quarterly pest treatment will be/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/mosquito service resumes/i)).not.toBeInTheDocument();
  });
});

describe('cancelled visit tracker', () => {
  const cancelledTracker = {
    currentStep: 7,
    state: 'cancelled',
    service: { type: 'Pest Control' },
    steps: Array.from({ length: 7 }, () => ({ completedAt: null })),
  };

  it('shows the cancelled terminal state, not service completion', async () => {
    api.getTodayTracker.mockResolvedValue({ tracker: cancelledTracker });

    render(<ServiceTracker />);

    expect(await screen.findByText('This visit was cancelled.')).toBeInTheDocument();
    expect(screen.getByText('Visit cancelled')).toBeInTheDocument();
    expect(screen.getByText(/no service was performed/i)).toBeInTheDocument();
    expect(screen.queryByText(/thanks for choosing waves/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Service complete')).not.toBeInTheDocument();
  });

  it('still shows completion for a genuinely completed visit', async () => {
    api.getTodayTracker.mockResolvedValue({
      tracker: { ...cancelledTracker, state: 'complete' },
    });

    render(<ServiceTracker />);

    expect(await screen.findByText(/thanks for choosing waves/i)).toBeInTheDocument();
    expect(screen.queryByText('This visit was cancelled.')).not.toBeInTheDocument();
  });
});

describe('dashboard billing honesty', () => {
  it('labels per-application customers by billing mode, not monthly rate', async () => {
    api.getAutopay.mockResolvedValue({ state: 'disabled', billing_mode: 'per_application' });

    render(<DashboardTab customer={customer} onSwitchTab={() => {}} onOpenPlanService={() => {}} />);

    expect(await screen.findByText('Per application')).toBeInTheDocument();
    expect(screen.queryByText('Monthly rate')).not.toBeInTheDocument();
  });

  it('keeps the monthly-rate row for monthly customers', async () => {
    api.getAutopay.mockResolvedValue({ state: 'disabled', billing_mode: 'monthly' });

    render(<DashboardTab customer={customer} onSwitchTab={() => {}} onOpenPlanService={() => {}} />);

    expect(await screen.findByText('Monthly rate')).toBeInTheDocument();
  });

  it('labels explicit per-visit customers by billing mode, not monthly rate (Codex r6)', async () => {
    api.getAutopay.mockResolvedValue({ state: 'disabled', billing_mode: 'per_visit' });

    render(<DashboardTab customer={customer} onSwitchTab={() => {}} onOpenPlanService={() => {}} />);

    expect(await screen.findByText('Per visit')).toBeInTheDocument();
    expect(screen.queryByText('Monthly rate')).not.toBeInTheDocument();
  });
});

describe('referral reward honesty', () => {
  it('does not advertise a dollar figure when the server reports zero reward', async () => {
    api.getReferrals.mockResolvedValue({
      stats: { totalReferrals: 0, converted: 0 },
      rewardPerReferral: 0,
    });

    render(<DashboardTab customer={customer} onSwitchTab={() => {}} onOpenPlanService={() => {}} />);

    expect(await screen.findByText('View details')).toBeInTheDocument();
    expect(screen.queryByText(/\$25 credit/)).not.toBeInTheDocument();
  });

  it('shows the server-confirmed reward when one exists', async () => {
    api.getReferrals.mockResolvedValue({
      stats: { totalReferrals: 0, converted: 0 },
      rewardPerReferral: 40,
    });

    render(<DashboardTab customer={customer} onSwitchTab={() => {}} onOpenPlanService={() => {}} />);

    expect(await screen.findByText('$40 credit')).toBeInTheDocument();
  });
});
