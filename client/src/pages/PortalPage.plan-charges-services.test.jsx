// @vitest-environment jsdom
// Billing's Plan Charges box lists the member's OWN plan services, the list
// My Plan shows (owner 2026-11-22, "fix box"). It used to list the first N
// catalog services for an N-service tier, so a lawn-only Bronze member read
// "Pest Control". This file pins the shared derivation
// (resolvePlanServices) and what the box does with it: the same two schedule
// reads as My Plan, no service named while they load or after they fail,
// and no schedule read for a cancelled account or a non-member. The Learn
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

describe('resolvePlanServices — one service list for My Plan and Billing', () => {
  it('a lawn-only Bronze member has lawn care, under the visit\'s own name, and no pest control', () => {
    const { includedServices } = resolvePlanServices(bronze, LAWN, [LAWN]);
    expect(includedServices.map((s) => s.id)).toEqual(['lawn_care']);
    expect(includedServices[0].displayName).toBe('Lawn Care Program');
  });

  it('a member with no plan visit on the schedule keeps the tier\'s default services', () => {
    const { includedServices } = resolvePlanServices(bronze, null, []);
    expect(includedServices.map((s) => s.id)).toEqual(['pest_control']);
    expect(includedServices[0].displayName).toBe('Pest Control');
    expect(ids({ ...bronze, tier: 'Gold' }, null, [LAWN])).toEqual(['lawn_care', 'pest_control', 'mosquito']);
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
    expect(ids(bronze, LAWN, [LAWN, row])).toEqual(['lawn_care']);
  });

  it('pest control is named by its last upcoming visit', () => {
    const monthly = visit('Monthly Pest Control', { id: 'v-later', date: '2027-01-10' });
    const { includedServices, pestPlanName } = resolvePlanServices(bronze, PEST, [PEST, monthly]);
    expect(pestPlanName).toBe('Monthly Pest Control');
    expect(includedServices[0].displayName).toBe('Monthly Pest Control');
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
    expect(api.getNextService).toHaveBeenCalledWith({ allProperties: true });
    expect(api.getSchedule).toHaveBeenCalledWith(365, { allProperties: true });
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
