// @vitest-environment jsdom
// Pins the tranche-1 truth fixes: customer-facing copy must not promise
// schedules, money, or outcomes the server doesn't back.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
import { ScheduleTab, ServiceTracker, DashboardTab, MyPlanTab, ReferTab } from './PortalPage';

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
  api.getGoogleReviewCard.mockResolvedValue({ card: null });
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

describe('My Plan tree & shrub card does not invent the retired quarterly cadence (codex P1 pre-push, 2026-09-24)', () => {
  it('shows 0/0 applications for a fresh tree & shrub plan with no real schedule yet, not the retired 4-visit Feb/May/Aug/Nov fallback', async () => {
    // Platinum pads the included-services list to 4 from SERVICE_CATALOG
    // order (pest_control, lawn_care, mosquito, tree_shrub), so with an
    // empty schedule/services response tree_shrub renders with ZERO real
    // events — exactly the case SERVICE_SCHEDULE_MONTHS.tree_shrub used to
    // paper over with a fabricated 4-visit cadence (any newly sold 6x
    // Standard or 9x Enhanced customer would see the same wrong 4/4).
    render(<MyPlanTab customer={{ ...customer, tier: 'Platinum' }} />);
    // "Tree & Shrub" renders twice (the service row + the summary sentence)
    // — wait on the summary line, then assert on the unambiguous applications count.
    expect(await screen.findByText(/4 services bundled under WaveGuard Platinum/)).toBeInTheDocument();
    expect(screen.getAllByText('Tree & Shrub').length).toBeGreaterThan(0);
    expect(screen.getByText('0/0 applications')).toBeInTheDocument();
    expect(screen.queryByText('4/4 applications')).not.toBeInTheDocument();
    // pest_control and lawn_care keep their own (unaffected) 4-month fallbacks.
    expect(screen.getAllByText('0/4 applications')).toHaveLength(2);
  });
});

describe('My Plan pest card names the plan\'s own cadence', () => {
  // Dates run from the real clock: the card only needs upcoming recurring pest visits in date order.
  const dayFromNow = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const pestVisit = (daysOut, serviceType) => ({
    id: `visit-${daysOut}`, date: dayFromNow(daysOut), serviceType, status: 'pending', isRecurring: true, isCallback: false,
  });
  const renderPlan = async (upcoming) => {
    api.getSchedule.mockResolvedValue({ upcoming });
    api.getNextService.mockResolvedValue({ next: upcoming[0] });
    render(<MyPlanTab customer={customer} />);
    await screen.findByText('Included Services');
  };

  it.each([
    ['Quarterly Pest Control Service', 'Quarterly (4x)'],
    ['Bi-Monthly Pest Control Service', 'Bi-Monthly (6x)'],
    ['Monthly Pest Control Service', 'Monthly (12x)'],
    // A label that states no cadence keeps the first, as before.
    ['Pest Control', 'Quarterly (4x)'],
  ])('a plan of "%s" reads %s, not the catalog\'s first cadence for everyone', async (serviceType, line) => {
    await renderPlan([pestVisit(20, serviceType), pestVisit(80, serviceType)]);
    expect(screen.getByRole('button', { name: new RegExp(`${serviceType}\\s*${line.replace(/[()]/g, '\\$&')}`) })).toBeInTheDocument();
    for (const other of ['Quarterly (4x)', 'Bi-Monthly (6x)', 'Monthly (12x)'].filter((label) => label !== line)) {
      expect(screen.queryByText(other)).not.toBeInTheDocument();
    }
  });

  it('after a frequency change the card names the new plan, not the next visit that stays as booked on the old one', async () => {
    await renderPlan([
      pestVisit(5, 'Quarterly Pest Control Service'),
      pestVisit(35, 'Monthly Pest Control Service'),
      pestVisit(65, 'Monthly Pest Control Service'),
    ]);
    expect(screen.getByRole('button', { name: /Monthly Pest Control Service\s*Monthly \(12x\)/ })).toBeInTheDocument();
    expect(screen.queryByText('Quarterly (4x)')).not.toBeInTheDocument();
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

describe('plan tab cancel flow', () => {
  it('opens the C1 review screen from the Account Options card with server facts only', async () => {
    api.getSchedule.mockResolvedValue({ upcoming: [], hasCancellableWork: true });
    api.getStationMap.mockResolvedValue({ available: false });
    api.cancelResolutionPreview.mockResolvedValue({
      kind: 'none', reasonCode: null, scope: [],
      impact: {
        families: [{ key: 'pest_control', label: 'Pest Control', monthlyRate: 49, perAppRate: null, upcomingVisits: 1, nextVisitDate: '2026-09-05', prepay: null }],
        tierBefore: 'Bronze', tierAfter: null, tierDiscountBefore: 5, tierDiscountAfter: 0,
        accountMonthlyBefore: 49, accountMonthlyAfter: 0, remaining: [],
        visitsCancelled: 1, nextVisitCancelled: '2026-09-05', lateCancelFee: 0, openBalance: 0, payUrl: null,
        prepay: null, autopayOn: false, termiteRental: false, effectiveDate: '2026-08-31', billingMode: 'monthly',
      },
    });

    render(<MyPlanTab customer={{ ...customer, tier: 'Bronze' }} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('heading', { name: 'Review cancelling my plan' })).toBeInTheDocument();
    expect(screen.getByText('$49.00 → $0.00')).toBeInTheDocument();
    expect(screen.queryByText(/pause/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep my plan' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
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

  it('promises no credit to a member at the yearly limit (Step 2)', async () => {
    api.getReferrals.mockResolvedValue({
      stats: { totalReferrals: 10, converted: 10 },
      rewardPerReferral: 25,
      capReached: true,
      annualCap: 10,
    });

    render(<DashboardTab customer={customer} onSwitchTab={() => {}} onOpenPlanService={() => {}} />);

    expect(await screen.findByText('View details')).toBeInTheDocument();
    expect(screen.queryByText(/\$25 credit/)).not.toBeInTheDocument();
  });

  it('the Refer tab at the yearly limit says how many credits were earned, not the limit setting', async () => {
    api.getReferrals.mockResolvedValue({
      stats: { totalReferrals: 8, converted: 8 },
      rewardPerReferral: 0,
      standardReward: 25,
      capReached: true,
      annualCap: 5,
      creditsThisYear: 8,
    });

    render(<ReferTab customer={customer} onSwitchTab={() => {}} />);

    expect(await screen.findByText(/You earned 8 credits this year/)).toBeInTheDocument();
    expect(screen.queryByText(/You earned 5 credits/)).not.toBeInTheDocument();
  });
});

// GATE_REFERRAL_STEP2 words (owner 2026-11-21, *visit* + *flat*): the friend gets an account credit after the first plan
// service. The server sends annualCap only on Step 2, and friendReward from the live Referee Discount setting.
describe('Refer tab Step 2 words', () => {
  const step2 = (over = {}) => ({
    stats: { totalReferrals: 2, converted: 1 },
    referralCode: 'PAT123',
    rewardPerReferral: 25,
    standardReward: 25,
    annualCap: 10,
    creditsThisYear: 1,
    capReached: false,
    friendReward: 50,
    ...over,
  });
  const tapText = async () => {
    const location = { href: '' };
    Object.defineProperty(window, 'location', { configurable: true, writable: true, value: location });
    fireEvent.click(await screen.findByRole('button', { name: 'Text' }));
    return decodeURIComponent(location.href);
  };
  const realLocation = window.location;
  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, writable: true, value: realLocation });
  });

  it('names both credits, the first plan service and the yearly limit', async () => {
    api.getReferrals.mockResolvedValue(step2());
    render(<ReferTab customer={customer} onSwitchTab={() => {}} />);

    expect(await screen.findByRole('heading', { name: 'Friends & Neighbors' })).toBeInTheDocument();
    expect(screen.getByText('Share your link. They get a $50 credit after their first plan service. You earn a $25 credit after their first plan service. Up to 10 credits a year.')).toBeInTheDocument();
    expect(screen.getByText('Your $25 credit is applied after their first plan service.')).toBeInTheDocument();
    expect(screen.queryByText(/Refer and Earn/)).not.toBeInTheDocument();
    expect(await tapText()).toBe('sms:?body=I use Waves and thought you might want their info. You get a $50 credit after your first plan service with my link: https://portal.wavespestcontrol.com/r/PAT123');
  });

  it('an amount with cents is shown to the cent, never rounded up', async () => {
    api.getReferrals.mockResolvedValue(step2({ friendReward: 49.99, rewardPerReferral: 12.5 }));
    render(<ReferTab customer={customer} onSwitchTab={() => {}} />);

    expect(await screen.findByText('Share your link. They get a $49.99 credit after their first plan service. You earn a $12.50 credit after their first plan service. Up to 10 credits a year.')).toBeInTheDocument();
  });

  it('promises the friend nothing when the friend amount is 0: no friend sentence, and today\'s share text', async () => {
    api.getReferrals.mockResolvedValue(step2({ friendReward: 0 }));
    render(<ReferTab customer={customer} onSwitchTab={() => {}} />);

    expect(await screen.findByText('Share your link. You earn a $25 credit after their first plan service. Up to 10 credits a year.')).toBeInTheDocument();
    expect(screen.queryByText(/They get/)).not.toBeInTheDocument();
    expect(await tapText()).toBe('sms:?body=I use Waves and thought you might want their info. Here is my referral link: https://portal.wavespestcontrol.com/r/PAT123');
  });

  it('a member at the yearly limit keeps the limit line and is promised no credit', async () => {
    api.getReferrals.mockResolvedValue(step2({ rewardPerReferral: 0, capReached: true, creditsThisYear: 10 }));
    render(<ReferTab customer={customer} onSwitchTab={() => {}} />);

    expect(await screen.findByRole('heading', { name: 'Friends & Neighbors' })).toBeInTheDocument();
    // The whole approved line (owner 2026-11-21 "words ok"): the note is still promised at the limit.
    expect(screen.getByText('You earned 10 credits this year, the most we give. Thank you! Credits start again January 1. We still send a thank-you note for every friend who books.')).toBeInTheDocument();
    expect(screen.queryByText(/You earn a/)).not.toBeInTheDocument();
    expect(screen.queryByText(/credit is applied after/)).not.toBeInTheDocument();
  });

  it('a paused program promises nothing to a member at the yearly limit: no limit line, no note, no January restart', async () => {
    // The server's paused answer keeps capReached and creditsThisYear, with every amount at 0.
    api.getReferrals.mockResolvedValue(step2({
      rewardPerReferral: 0, standardReward: 0, friendReward: 0, programPaused: true, capReached: true, creditsThisYear: 10,
    }));
    render(<ReferTab customer={customer} onSwitchTab={() => {}} />);

    expect(await screen.findByText('Share your Waves link with neighbors who could use a hand with pest or lawn care.')).toBeInTheDocument();
    expect(screen.queryByText(/the most we give/)).not.toBeInTheDocument();
    expect(screen.queryByText(/thank-you note/)).not.toBeInTheDocument();
    expect(screen.queryByText(/January 1/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\$\d+ credit/)).not.toBeInTheDocument();
  });

  it('a paused program names no amount', async () => {
    api.getReferrals.mockResolvedValue(step2({ rewardPerReferral: 0, standardReward: 0, friendReward: 0, programPaused: true }));
    render(<ReferTab customer={customer} onSwitchTab={() => {}} />);

    expect(await screen.findByText('Share your Waves link with neighbors who could use a hand with pest or lawn care.')).toBeInTheDocument();
    expect(screen.queryByText(/\$\d+ credit/)).not.toBeInTheDocument();
  });

  it('with Step 2 off (no annualCap) the tab keeps today\'s words, even if a friend amount arrives', async () => {
    api.getReferrals.mockResolvedValue({ stats: { totalReferrals: 0, converted: 0 }, referralCode: 'PAT123', rewardPerReferral: 25, friendReward: 50 });
    render(<ReferTab customer={customer} onSwitchTab={() => {}} />);

    expect(await screen.findByRole('heading', { name: 'Refer and Earn' })).toBeInTheDocument();
    expect(screen.getByText('Share your Waves link with neighbors. You earn $25 account credit when a referral starts service.')).toBeInTheDocument();
    expect(screen.getByText('$25 credit is applied after their qualifying first service.')).toBeInTheDocument();
    expect(await tapText()).toBe('sms:?body=I use Waves and thought you might want their info. Here is my referral link: https://portal.wavespestcontrol.com/r/PAT123');
  });
});
