// @vitest-environment jsdom
// Billing's Plan Charges box lists the member's OWN plan services, the list
// My Plan shows (owner 2026-11-22, "fix box"). It used to list the first N
// catalog services for an N-service tier, so a lawn-only Bronze member read
// "Pest Control". This file pins the shared derivation
// (resolvePlanServices) and what the box does with it: the same two schedule
// reads as My Plan, no service named while they load or after they fail,
// and no schedule read for a cancelled account or a non-member. Billing and
// Learn name only the services a plan visit on the schedule confirms
// (confirmedServices); My Plan alone keeps its tier placeholders. The Learn
// tab's "Your {tier} plan includes ..." sentence used the same wrong list
// and follows the same rule.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/api', () => ({
  default: {
    getPropertyRecommendations: vi.fn(async () => ({ available: false })),
    requestPropertyRecommendation: vi.fn(),
    saveStripeCard: vi.fn(),
    oneTapGet: vi.fn(),
    oneTapRelease: vi.fn(),
    oneTapConfirm: vi.fn(),
    getSchedule: vi.fn(),
    getNextService: vi.fn(),
    getNotificationPrefs: vi.fn(),
    getPayments: vi.fn(),
    getBalance: vi.fn(),
    getCards: vi.fn(),
    getAutopay: vi.fn(),
    getAlerts: vi.fn(),
    getBlogPosts: vi.fn(),
    getNewsletterPosts: vi.fn(),
    getExpertPosts: vi.fn(),
    getLocalNews: vi.fn(),
    getFaq: vi.fn(),
    getMonthlyTip: vi.fn(),
    getLawnHealth: vi.fn(),
    getWeather: vi.fn(),
  },
}));
vi.mock('../components/brand/CustomerDialogHost', () => ({
  showCustomerAlert: vi.fn(),
  showCustomerConfirm: vi.fn(async () => true),
}));

import api from '../utils/api';
import { BillingTab, LearnTab, resolvePlanServices } from './PortalPage';

const visit = (serviceType, extra = {}) => ({
  id: `v-${serviceType}`, serviceType, date: '2026-12-10', status: 'pending', isRecurring: true, ...extra,
});
const LAWN = visit('Lawn Care Program');
const PEST = visit('Quarterly Pest Control');
const bronze = { id: 'cust-1', firstName: 'Pat', tier: 'Bronze', monthlyRate: 62, property: {} };
const ids = (customer, next, upcoming) => resolvePlanServices(customer, next, upcoming).includedServices.map((s) => s.id);
const confirmedIds = (customer, next, upcoming) => resolvePlanServices(customer, next, upcoming).confirmedServices.map((s) => s.id);

describe('resolvePlanServices — one service list for My Plan and Billing', () => {
  it('a lawn-only Bronze member has lawn care, under the visit\'s own name, and no pest control', () => {
    const { includedServices, confirmedServices } = resolvePlanServices(bronze, LAWN, [LAWN]);
    expect(includedServices.map((s) => s.id)).toEqual(['lawn_care']);
    expect(includedServices[0].displayName).toBe('Lawn Care Program');
    expect(confirmedServices).toEqual(includedServices);
  });

  // A tier gives a count, never which service is missing. My Plan fills the
  // count with catalog placeholders; the confirmed list never does.
  it('with no plan visit on the schedule, My Plan keeps the tier placeholders and the confirmed list is empty', () => {
    const { includedServices, confirmedServices } = resolvePlanServices(bronze, null, []);
    expect(includedServices.map((s) => s.id)).toEqual(['pest_control']);
    expect(includedServices[0].displayName).toBe('Pest Control');
    expect(confirmedServices).toEqual([]);
  });

  it('a Gold member with one service on the schedule: three for My Plan, one confirmed', () => {
    const gold = { ...bronze, tier: 'Gold' };
    expect(ids(gold, null, [LAWN])).toEqual(['lawn_care', 'pest_control', 'mosquito']);
    expect(confirmedIds(gold, null, [LAWN])).toEqual(['lawn_care']);
  });

  it('the confirmed list never passes the tier\'s size (My Plan\'s own cut)', () => {
    expect(confirmedIds(bronze, LAWN, [LAWN, PEST])).toEqual(['lawn_care']);
    expect(confirmedIds({ ...bronze, tier: 'Silver' }, LAWN, [LAWN, PEST])).toEqual(['lawn_care', 'pest_control']);
  });

  it('a customer with no plan lists only what the schedule shows', () => {
    const noPlan = { id: 'cust-2', tier: null, monthlyRate: 0 };
    expect(ids(noPlan, null, [])).toEqual([]);
    expect(ids(noPlan, LAWN, [LAWN])).toEqual(['lawn_care']);
  });

  it.each([
    ['a one-time visit', visit('Pest Control', { isRecurring: false })],
    ['a free re-service', visit('Pest Control', { isCallback: true })],
    ['a rescheduled row', visit('Pest Control', { status: 'rescheduled' })],
    ['a visit the server marks as not plan coverage', visit('Pest Control', { waveguardQualifying: false })],
  ])('%s does not put pest control on a lawn member\'s list', (_label, row) => {
    // The excluded row comes FIRST: a resolver that accepted it would detect
    // pest control first and, on a one-service tier, drop lawn care.
    expect(ids(bronze, row, [row, LAWN])).toEqual(['lawn_care']);
    expect(confirmedIds(bronze, row, [row, LAWN])).toEqual(['lawn_care']);
    // Alone, it confirms nothing.
    expect(confirmedIds(bronze, row, [row])).toEqual([]);
  });

  // The two reads return the same visit in two shapes: /schedule/next
  // (all properties) is a thin projection with no coverage verdict, no
  // family and no catalog name; the schedule row carries all three.
  describe('the next visit and its own schedule row', () => {
    const thinNext = { id: 'v-1', serviceType: 'Pest Control', date: '2026-12-01', status: 'pending', isRecurring: true, isCallback: false };

    it('the schedule row\'s "not plan coverage" wins over the next visit\'s label', () => {
      const scheduleRow = { ...thinNext, waveguardQualifying: false };
      const { includedServices, confirmedServices } = resolvePlanServices(bronze, thinNext, [scheduleRow, LAWN]);
      expect(includedServices.map((s) => s.id)).toEqual(['lawn_care']);
      expect(confirmedServices.map((s) => s.id)).toEqual(['lawn_care']);
    });

    it('the schedule row\'s family and catalog name win over the next visit\'s label', () => {
      const scheduleRow = {
        ...thinNext, waveguardQualifying: true, serviceFamily: 'lawn_care', serviceDisplayName: 'Lawn Care Program',
      };
      const { confirmedServices } = resolvePlanServices(bronze, thinNext, [scheduleRow]);
      expect(confirmedServices.map((s) => s.id)).toEqual(['lawn_care']);
      expect(confirmedServices[0].displayName).toBe('Lawn Care Program');
    });

    // /schedule/next has no upper date bound; the schedule read ends at 365
    // days. A next visit past that has only its label, with no server
    // verdict: My Plan still shows its card, Billing and Learn do not name it.
    it('a next visit the schedule does not list counts for My Plan and confirms nothing', () => {
      expect(ids(bronze, thinNext, [])).toEqual(['pest_control']);
      expect(confirmedIds(bronze, thinNext, [])).toEqual([]);
      const silver = { ...bronze, tier: 'Silver' };
      expect(ids(silver, thinNext, [LAWN])).toEqual(['pest_control', 'lawn_care']);
      expect(confirmedIds(silver, thinNext, [LAWN])).toEqual(['lawn_care']);
    });

    it('a confirmed service is named by its schedule row, not by an unlisted next visit', () => {
      const farNext = { ...thinNext, id: 'v-far', serviceType: 'Lawn Care' };
      const { confirmedServices } = resolvePlanServices(bronze, farNext, [LAWN]);
      expect(confirmedServices.map((s) => s.displayName)).toEqual(['Lawn Care Program']);
    });
  });

  // Pre-push audit 2026-11-22: a visit cancelled between the two reads left
  // /next naming pest control while the schedule confirmed lawn care alone.
  // On a one-service tier the stale row took the slot and lawn care was lost.
  it('a next visit the schedule no longer lists never takes a confirmed service\'s place', () => {
    const staleNext = { id: 'v-gone', serviceType: 'Pest Control', date: '2026-11-25', status: 'pending', isRecurring: true, isCallback: false };
    expect(ids(bronze, staleNext, [LAWN])).toEqual(['pest_control']);
    expect(confirmedIds(bronze, staleNext, [LAWN])).toEqual(['lawn_care']);
  });

  it('pest control is named by its last upcoming visit', () => {
    const monthly = visit('Monthly Pest Control', { id: 'v-later', date: '2027-01-10' });
    const { includedServices, confirmedServices, pestPlanName } = resolvePlanServices(bronze, PEST, [PEST, monthly]);
    expect(pestPlanName).toBe('Monthly Pest Control');
    expect(includedServices[0].displayName).toBe('Monthly Pest Control');
    expect(confirmedServices.map((s) => s.displayName)).toEqual(['Monthly Pest Control']);
  });
});

beforeEach(() => {
  Object.values(api).forEach((fn) => { if (typeof fn?.mockResolvedValue === 'function') fn.mockResolvedValue(null); });
  api.getPropertyRecommendations.mockResolvedValue({ available: false });
  api.getPayments.mockResolvedValue({ payments: [], nextCursor: null });
  api.getBalance.mockResolvedValue({ currentBalance: 0, openInvoices: [] });
  api.getCards.mockResolvedValue({ cards: [] });
  api.getAutopay.mockResolvedValue({ state: 'disabled', autopay_enabled: false, autopay_selected_method_ids: [] });
  api.getNextService.mockResolvedValue({ next: LAWN });
  api.getSchedule.mockResolvedValue({ upcoming: [LAWN] });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

async function renderPlanCharges(customer) {
  render(<BillingTab customer={customer} refreshCustomer={vi.fn()} />);
  await screen.findByText(/^Payment History$/i);
  return screen.getByText('Plan Charges').closest('[data-glass="card"]');
}

describe('BillingTab — Plan Charges', () => {
  it('lists a lawn-only Bronze member\'s lawn care and never pest control', async () => {
    const box = await renderPlanCharges(bronze);
    expect(await within(box).findByText('Lawn Care Program')).toBeInTheDocument();
    expect(within(box).queryByText(/Pest Control/)).not.toBeInTheDocument();
    // My Plan's own reads: every property, a year ahead.
    // One read, the schedule. The next-visit read is not made.
    expect(api.getSchedule).toHaveBeenCalledWith(365, { allProperties: true });
    expect(api.getNextService).not.toHaveBeenCalled();
  });

  // Pre-push audit 2026-11-22: tier padding named "Pest Control" here.
  it('names no service for a member with no plan visit on the schedule; the plan line stays', async () => {
    api.getNextService.mockResolvedValue({ next: null });
    api.getSchedule.mockResolvedValue({ upcoming: [] });
    const box = await renderPlanCharges(bronze);
    await waitFor(() => expect(api.getSchedule).toHaveBeenCalled());
    await Promise.resolve();
    expect(within(box).getByText('WaveGuard Bronze')).toBeInTheDocument();
    expect(within(box).queryByText(/Pest Control|Lawn Care/)).not.toBeInTheDocument();
  });

  it('a Gold member with only lawn care on the schedule is named lawn care alone', async () => {
    const box = await renderPlanCharges({ ...bronze, tier: 'Gold' });
    expect(await within(box).findByText('Lawn Care Program')).toBeInTheDocument();
    expect(within(box).queryByText(/Pest Control|Mosquito/)).not.toBeInTheDocument();
  });

  it('the box follows the schedule row when the next visit\'s label disagrees with it', async () => {
    const thinNext = { id: 'v-1', serviceType: 'Pest Control', date: '2026-12-01', status: 'pending', isRecurring: true, isCallback: false };
    api.getNextService.mockResolvedValue({ coverageOnly: true, next: thinNext });
    api.getSchedule.mockResolvedValue({ upcoming: [{ ...thinNext, waveguardQualifying: false }, LAWN] });
    const box = await renderPlanCharges(bronze);
    expect(await within(box).findByText('Lawn Care Program')).toBeInTheDocument();
    expect(within(box).queryByText(/Pest Control/)).not.toBeInTheDocument();
  });

  it('a failed or stale next-visit read changes nothing: the box lists what the schedule confirms', async () => {
    api.getNextService.mockRejectedValue(new Error('offline'));
    const box = await renderPlanCharges(bronze);
    expect(await within(box).findByText('Lawn Care Program')).toBeInTheDocument();
    expect(within(box).queryByText(/Pest Control/)).not.toBeInTheDocument();
  });

  it('a next visit past the schedule\'s 365 days names no service', async () => {
    api.getNextService.mockResolvedValue({ coverageOnly: true, next: { id: 'v-far', serviceType: 'Pest Control', date: '2028-01-10', status: 'pending', isRecurring: true, isCallback: false } });
    api.getSchedule.mockResolvedValue({ upcoming: [] });
    const box = await renderPlanCharges(bronze);
    await waitFor(() => expect(api.getSchedule).toHaveBeenCalled());
    await Promise.resolve();
    expect(within(box).getByText('WaveGuard Bronze')).toBeInTheDocument();
    expect(within(box).queryByText(/Pest Control|Lawn Care/)).not.toBeInTheDocument();
  });

  it('names no service when the schedule read fails; the plan line stays', async () => {
    api.getSchedule.mockRejectedValue(new Error('offline'));
    const box = await renderPlanCharges(bronze);
    await waitFor(() => expect(api.getSchedule).toHaveBeenCalled());
    expect(within(box).getByText('WaveGuard Bronze')).toBeInTheDocument();
    expect(within(box).queryByText(/Pest Control|Lawn Care/)).not.toBeInTheDocument();
  });

  it.each([
    ['a cancelled account', { ...bronze, cancelled: true, cancelledAt: '2026-08-22' }],
    ['a customer with no plan', { ...bronze, tier: null, monthlyRate: 0 }],
  ])('%s: no schedule read, no service row', async (_label, customer) => {
    const box = await renderPlanCharges(customer);
    expect(api.getNextService).not.toHaveBeenCalled();
    expect(api.getSchedule).not.toHaveBeenCalled();
    expect(within(box).queryByText(/Pest Control|Lawn Care/)).not.toBeInTheDocument();
  });
});

// The sentence sits in the monthly tip card.
describe('LearnTab: "Your plan includes ..."', () => {
  const TIP = { month: 'December', title: 'Check door sweeps', tip: 'Seal gaps before the cold nights.' };
  beforeEach(() => { api.getMonthlyTip.mockResolvedValue(TIP); });

  it('names a lawn-only Bronze member\'s lawn care, by family name, and never pest control', async () => {
    render(<LearnTab customer={bronze} />);
    expect(await screen.findByText('Your Bronze plan includes Lawn Care.')).toBeInTheDocument();
    expect(screen.queryByText(/plan includes.*Pest Control/)).not.toBeInTheDocument();
    expect(api.getSchedule).toHaveBeenCalledWith(365, { allProperties: true });
  });

  it('a pest member reads the family name, not the visit\'s program name', async () => {
    api.getNextService.mockResolvedValue({ next: PEST });
    api.getSchedule.mockResolvedValue({ upcoming: [PEST] });
    render(<LearnTab customer={bronze} />);
    expect(await screen.findByText('Your Bronze plan includes Pest Control.')).toBeInTheDocument();
  });

  it('a member with no plan visit on the schedule: no sentence, never a tier guess', async () => {
    api.getNextService.mockResolvedValue({ next: null });
    api.getSchedule.mockResolvedValue({ upcoming: [] });
    render(<LearnTab customer={bronze} />);
    expect(await screen.findByText(TIP.tip)).toBeInTheDocument();
    await waitFor(() => expect(api.getSchedule).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.queryByText(/plan includes/)).not.toBeInTheDocument();
  });

  it('says nothing about services when the schedule read fails; the tip stays', async () => {
    api.getSchedule.mockRejectedValue(new Error('offline'));
    render(<LearnTab customer={bronze} />);
    expect(await screen.findByText(TIP.tip)).toBeInTheDocument();
    await waitFor(() => expect(api.getSchedule).toHaveBeenCalled());
    expect(screen.queryByText(/plan includes/)).not.toBeInTheDocument();
  });

  it('a customer with no plan: no sentence and no schedule read', async () => {
    render(<LearnTab customer={{ ...bronze, tier: null, monthlyRate: 0 }} />);
    expect(await screen.findByText(TIP.tip)).toBeInTheDocument();
    expect(screen.queryByText(/plan includes/)).not.toBeInTheDocument();
    expect(api.getSchedule).not.toHaveBeenCalled();
  });
});
