// @vitest-environment jsdom
// Billing's Plan Charges box and the Learn tab's "Your {tier} plan includes
// ..." sentence name the member's OWN plan services (owner 2026-11-22,
// "fix box"). Both listed the first N catalog services for an N-service
// tier, so a lawn-only Bronze member read "Pest Control".
// The server builds the list (planFamilies on the all-properties schedule
// read; server/tests/schedule-plan-families.test.js). This file pins what
// the two places do with it: they print it and nothing else. No service is
// named while the read loads, after it fails, or from a server that does
// not send the list; a cancelled account and a non-member make no read.
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
import { BillingTab, LearnTab } from './PortalPage';

const bronze = { id: 'cust-1', firstName: 'Pat', tier: 'Bronze', monthlyRate: 62, property: {} };
// The all-properties schedule answer. `upcoming` is what My Plan reads; the
// two places under test read planFamilies only. The visit here is a pest
// visit on purpose: a client that classified rows itself would print it.
const schedule = (planFamilies) => ({
  coverageOnly: true,
  upcoming: [{ id: 'v-1', serviceType: 'Quarterly Pest Control', date: '2026-12-10', status: 'pending', isRecurring: true, waveguardQualifying: true, serviceFamily: 'pest_control' }],
  ...(planFamilies === undefined ? {} : { planFamilies }),
});

beforeEach(() => {
  Object.values(api).forEach((fn) => { if (typeof fn?.mockResolvedValue === 'function') fn.mockResolvedValue(null); });
  api.getPropertyRecommendations.mockResolvedValue({ available: false });
  api.getPayments.mockResolvedValue({ payments: [], nextCursor: null });
  api.getBalance.mockResolvedValue({ currentBalance: 0, openInvoices: [] });
  api.getCards.mockResolvedValue({ cards: [] });
  api.getAutopay.mockResolvedValue({ state: 'disabled', autopay_enabled: false, autopay_selected_method_ids: [] });
  api.getSchedule.mockResolvedValue(schedule(['lawn_care']));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

async function renderPlanCharges(customer) {
  render(<BillingTab customer={customer} refreshCustomer={vi.fn()} />);
  await screen.findByText(/^Payment History$/i);
  return screen.getByText('Plan Charges').closest('[data-glass="card"]');
}
const settled = async () => {
  await waitFor(() => expect(api.getSchedule).toHaveBeenCalled());
  await Promise.resolve();
};

describe('BillingTab — Plan Charges', () => {
  it('lists a lawn-only Bronze member\'s lawn care and never pest control', async () => {
    const box = await renderPlanCharges(bronze);
    expect(await within(box).findByText('Lawn Care')).toBeInTheDocument();
    expect(within(box).queryByText(/Pest Control/)).not.toBeInTheDocument();
    // One read, the all-properties schedule. The list is the server's: the
    // pest visit in `upcoming` names nothing here.
    expect(api.getSchedule).toHaveBeenCalledWith(365, { allProperties: true });
    expect(api.getNextService).not.toHaveBeenCalled();
  });

  it('lists every family the server sends, in catalog order, whatever the tier\'s size', async () => {
    api.getSchedule.mockResolvedValue(schedule(['tree_shrub', 'termite_bait', 'lawn_care', 'pest_control', 'mosquito']));
    const box = await renderPlanCharges(bronze);
    await within(box).findByText('Lawn Care');
    const names = ['Pest Control', 'Lawn Care', 'Mosquito Control', 'Tree & Shrub', 'Termite Bait Monitoring'];
    const shown = names.map((name) => within(box).getByText(name));
    for (let i = 1; i < shown.length; i += 1) {
       
      expect(shown[i - 1].compareDocumentPosition(shown[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('a Gold member with one service on the schedule is named that one service', async () => {
    const box = await renderPlanCharges({ ...bronze, tier: 'Gold' });
    expect(await within(box).findByText('Lawn Care')).toBeInTheDocument();
    expect(within(box).queryByText(/Pest Control|Mosquito/)).not.toBeInTheDocument();
  });

  it('a family the catalog does not know is not printed', async () => {
    api.getSchedule.mockResolvedValue(schedule(['lawn_care', 'palm_injection']));
    const box = await renderPlanCharges(bronze);
    expect(await within(box).findByText('Lawn Care')).toBeInTheDocument();
    expect(within(box).queryByText(/palm/i)).not.toBeInTheDocument();
  });

  it.each([
    ['an empty list (no plan visit on the schedule)', () => api.getSchedule.mockResolvedValue(schedule([]))],
    ['an answer with no list (an older server)', () => api.getSchedule.mockResolvedValue(schedule(undefined))],
    ['a failed read', () => api.getSchedule.mockRejectedValue(new Error('offline'))],
  ])('%s names no service, never a tier guess; the plan line stays', async (_label, arrange) => {
    arrange();
    const box = await renderPlanCharges(bronze);
    await settled();
    expect(within(box).getByText('WaveGuard Bronze')).toBeInTheDocument();
    expect(within(box).queryByText(/Pest Control|Lawn Care/)).not.toBeInTheDocument();
  });

  it.each([
    ['a cancelled account', { ...bronze, cancelled: true, cancelledAt: '2026-08-22' }],
    ['a customer with no plan', { ...bronze, tier: null, monthlyRate: 0 }],
  ])('%s: no schedule read, no service row', async (_label, customer) => {
    const box = await renderPlanCharges(customer);
    expect(api.getSchedule).not.toHaveBeenCalled();
    expect(within(box).queryByText(/Pest Control|Lawn Care/)).not.toBeInTheDocument();
  });
});

// The sentence sits in the monthly tip card.
describe('LearnTab: "Your plan includes ..."', () => {
  const TIP = { month: 'December', title: 'Check door sweeps', tip: 'Seal gaps before the cold nights.' };
  beforeEach(() => { api.getMonthlyTip.mockResolvedValue(TIP); });

  it('names a lawn-only Bronze member\'s lawn care and never pest control', async () => {
    render(<LearnTab customer={bronze} />);
    expect(await screen.findByText('Your Bronze plan includes Lawn Care.')).toBeInTheDocument();
    expect(screen.queryByText(/plan includes.*Pest Control/)).not.toBeInTheDocument();
    expect(api.getSchedule).toHaveBeenCalledWith(365, { allProperties: true });
  });

  it('names two services for a Silver member, in catalog order', async () => {
    api.getSchedule.mockResolvedValue(schedule(['lawn_care', 'pest_control']));
    render(<LearnTab customer={{ ...bronze, tier: 'Silver' }} />);
    expect(await screen.findByText('Your Silver plan includes Pest Control, Lawn Care.')).toBeInTheDocument();
    expect(screen.getByText(/2 included services in your guidance/)).toBeInTheDocument();
  });

  // The count line is the tier's size, and never fewer than the names
  // beside it: Platinum is "four or more", and a tier can trail the schedule.
  it('a Platinum member with five services: five names and "5 included services"', async () => {
    api.getSchedule.mockResolvedValue(schedule(['pest_control', 'lawn_care', 'mosquito', 'tree_shrub', 'termite_bait']));
    render(<LearnTab customer={{ ...bronze, tier: 'Platinum' }} />);
    expect(await screen.findByText(/plan includes Pest Control, Lawn Care, Mosquito Control, Tree & Shrub, Termite Bait Monitoring\./)).toBeInTheDocument();
    expect(screen.getByText(/5 included services in your guidance/)).toBeInTheDocument();
  });

  it('a Platinum member with two services on the schedule: the count stays the tier\'s 4', async () => {
    api.getSchedule.mockResolvedValue(schedule(['pest_control', 'lawn_care']));
    render(<LearnTab customer={{ ...bronze, tier: 'Platinum' }} />);
    expect(await screen.findByText(/4 included services in your guidance/)).toBeInTheDocument();
  });

  it('a Bronze member the schedule shows two services for: two names and "2 included services"', async () => {
    api.getSchedule.mockResolvedValue(schedule(['pest_control', 'lawn_care']));
    render(<LearnTab customer={bronze} />);
    expect(await screen.findByText('Your Bronze plan includes Pest Control, Lawn Care.')).toBeInTheDocument();
    expect(screen.getByText(/2 included services in your guidance/)).toBeInTheDocument();
  });

  it.each([
    ['an empty list', () => api.getSchedule.mockResolvedValue(schedule([]))],
    ['a failed read', () => api.getSchedule.mockRejectedValue(new Error('offline'))],
  ])('%s: no sentence, never a tier guess; the tip stays', async (_label, arrange) => {
    arrange();
    render(<LearnTab customer={bronze} />);
    expect(await screen.findByText(TIP.tip)).toBeInTheDocument();
    await settled();
    expect(screen.queryByText(/plan includes/)).not.toBeInTheDocument();
  });

  it.each([
    ['a customer with no plan', { ...bronze, tier: null, monthlyRate: 0 }],
    ['a cancelled account', { ...bronze, cancelled: true }],
  ])('%s: no sentence and no schedule read', async (_label, customer) => {
    render(<LearnTab customer={customer} />);
    expect(await screen.findByText(TIP.tip)).toBeInTheDocument();
    expect(api.getSchedule).not.toHaveBeenCalled();
    expect(screen.queryByText(/plan includes/)).not.toBeInTheDocument();
  });
});
