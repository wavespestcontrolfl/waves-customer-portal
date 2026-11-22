// @vitest-environment jsdom
// C4 (GATE_CANCEL_FLOW_V2): a CANCELLED account's Billing tab keeps the
// reads (balance, history, credits) and hides every management surface
// whose writes the middleware 401s — Payment Methods (incl. Auto Pay
// controls), the auto-apply-credit toggle, and Billing Preferences. An
// active account renders all of them unchanged.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/api', () => ({
  default: {
    // Billing mounts Home's add-a-service card (owner 2026-11-21).
    getPropertyRecommendations: vi.fn(async () => ({ available: false })),
    requestPropertyRecommendation: vi.fn(),
    saveStripeCard: vi.fn(),
    oneTapGet: vi.fn(),
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
    getTermiteBond: vi.fn(),
    getLawnHealth: vi.fn(),
    getRequests: vi.fn(),
  },
}));
vi.mock('../components/brand/CustomerDialogHost', () => ({
  showCustomerAlert: vi.fn(),
  showCustomerConfirm: vi.fn(async () => true),
}));

import api from '../utils/api';
import { BillingTab, ScheduleTab } from './PortalPage';

const baseCustomer = {
  id: 'cust-1', firstName: 'Pat', lastName: 'Customer',
  phone: '9415551234', email: 'pat@example.com', tier: null, property: {},
  accountCredit: 45,
};

beforeEach(() => {
  // Every mocked call resolves — an undefined return breaks the mount
  // effect's `.catch` chains before assertions run.
  Object.values(api).forEach((fn) => { if (typeof fn?.mockResolvedValue === 'function') fn.mockResolvedValue(null); });
  api.getPayments.mockResolvedValue({ payments: [], nextCursor: null });
  api.getBalance.mockResolvedValue({ currentBalance: 0, openInvoices: [] });
  api.getCards.mockResolvedValue({ cards: [{ id: 'pm-1', processor: 'stripe', methodType: 'card', brand: 'VISA', lastFour: '4242', expMonth: '12', expYear: '2032', isDefault: true }] });
  api.getAutopay.mockResolvedValue({ state: 'disabled', autopay_enabled: false, autopay_selected_method_ids: [] });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

async function renderBilling(customer, props = {}) {
  render(<BillingTab customer={customer} refreshCustomer={vi.fn()} {...props} />);
  await waitFor(() => expect(api.getBalance).toHaveBeenCalled());
  // The loading copy also mentions payment history; wait for the section title.
  await screen.findByText(/^Payment History$/i);
}

describe('BillingTab — cancelled account is read-only (C4)', () => {
  it('hides Payment Methods, the auto-apply toggle, and Billing Preferences when cancelled', async () => {
    await renderBilling({ ...baseCustomer, cancelled: true, cancelledAt: '2026-08-22' });
    expect(screen.queryByText('Payment Methods')).not.toBeInTheDocument();
    expect(screen.queryByText('Billing Preferences')).not.toBeInTheDocument();
    expect(screen.queryByTestId('auto-apply-credit-row')).not.toBeInTheDocument();
    // Reads survive.
    expect(screen.getByText(/Payment History/i)).toBeInTheDocument();
  });

  it('renders the management surfaces unchanged for an active account', async () => {
    await renderBilling({ ...baseCustomer, cancelled: false });
    expect(screen.getByText('Payment Methods')).toBeInTheDocument();
    expect(screen.getByText('Billing Preferences')).toBeInTheDocument();
  });
});

// Owner 2026-11-21: Billing also carries Home's add-a-service offer (pest or
// lawn, from the same recommendations read) and a refer-a-friend card. Home's
// other cards (the mosquito note, irrigation advice) stay on Home, and a
// cancelled account sees neither card.
describe('BillingTab — add-a-service and refer cards', () => {
  const RECS = {
    available: true,
    oneTap: false,
    cards: [
      { id: 'lawn_offer', kind: 'offer', title: 'Lawn Care', body: 'Not on your plan yet.', serviceKey: 'lawn_care', mode: 'quote_cta', option: null, fingerprint: 'fp', ctaLabel: 'Request a quote' },
      { id: 'mosquito_note', kind: 'ask', title: 'Mosquito coverage', body: 'Season is here.' },
    ],
  };

  it('an active account sees the offer (offers only) and the refer card', async () => {
    api.getPropertyRecommendations.mockResolvedValue(RECS);
    const onSwitchTab = vi.fn();
    render(<BillingTab customer={{ ...baseCustomer, cancelled: false }} refreshCustomer={vi.fn()} onSwitchTab={onSwitchTab} />);
    expect(await screen.findByText('Lawn Care')).toBeInTheDocument();
    expect(screen.queryByText('Mosquito coverage')).not.toBeInTheDocument();
    screen.getByRole('button', { name: 'Refer a friend' }).click();
    expect(onSwitchTab).toHaveBeenCalledWith('refer');
    // The request says which tab the customer tapped on, so the office
    // request names Billing and not Home.
    screen.getByRole('button', { name: 'Get estimate' }).click();
    await waitFor(() => expect(api.requestPropertyRecommendation).toHaveBeenCalledWith(
      expect.objectContaining({ cardId: 'plan_offer', serviceKey: 'lawn_care', surface: 'billing' }),
    ));
  });

  // The offer's purchase overlay can save a payment method. Billing shows the
  // Payment Methods list on the same tab, so it must read the list again;
  // Home has no such list. Driven here by the return from a bank page, the
  // save the card component runs by itself at mount.
  it('a payment method saved from the offer reloads the Billing card list', async () => {
    window.history.replaceState({}, '', '/?stripe_setup_flow=one_tap_card&setup_intent=si_1&redirect_status=succeeded&one_tap_resume=p-7');
    try {
      api.getPropertyRecommendations.mockResolvedValue(RECS);
      api.saveStripeCard.mockResolvedValue({});
      api.oneTapGet.mockResolvedValue({ open: false });
      await renderBilling({ ...baseCustomer, cancelled: false }, { onSwitchTab: vi.fn() });
      await waitFor(() => expect(api.saveStripeCard).toHaveBeenCalledWith(null, 'si_1'));
      // Once at mount, once after the save.
      await waitFor(() => expect(api.getCards).toHaveBeenCalledTimes(2));
    } finally {
      window.history.replaceState({}, '', '/');
    }
  });

  it('a cancelled account sees neither and never asks for recommendations', async () => {
    api.getPropertyRecommendations.mockResolvedValue(RECS);
    // onSwitchTab is passed, as the page passes it. Without it the refer card
    // never renders, and this test would pass with the cancelled guard removed.
    await renderBilling({ ...baseCustomer, cancelled: true, cancelledAt: '2026-08-22' }, { onSwitchTab: vi.fn() });
    expect(api.getPropertyRecommendations).not.toHaveBeenCalled();
    expect(screen.queryByText('Lawn Care')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refer a friend' })).not.toBeInTheDocument();
  });
});

// C4 codex GH r4 P1: the widened /api/schedule read returns surviving
// pending/confirmed rows WITH rescheduleUrl — the read stays, but the
// mutation controls (Confirm, the tokenized Reschedule link) must not
// render for a cancelled session (the reschedule route refuses inactive
// accounts server-side too; the client must not advertise the side door).
describe('ScheduleTab — cancelled account renders no appointment mutations (C4)', () => {
  const futureDate = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  const upcomingVisit = {
    id: 'svc-1', date: futureDate, serviceType: 'Quarterly Pest Control',
    windowStart: '09:00', status: 'confirmed', customerConfirmed: false,
    rescheduleUrl: '/reschedule/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  };

  async function renderSchedule(customer) {
    render(<ScheduleTab customer={customer} />);
    await waitFor(() => expect(api.getSchedule).toHaveBeenCalled());
    await screen.findByText(/Quarterly Pest Control/);
  }

  it('cancelled: the visit row still renders (read), but Confirm and Reschedule do not', async () => {
    api.getSchedule.mockResolvedValue({ upcoming: [upcomingVisit] });
    await renderSchedule({ ...baseCustomer, cancelled: true, cancelledAt: '2026-08-22' });
    expect(screen.queryByRole('button', { name: /confirm/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Reschedule')).not.toBeInTheDocument();
    // The read survives: the appointment itself is listed.
    expect(screen.getByText(/Quarterly Pest Control/)).toBeInTheDocument();
  });

  it('active: Confirm and the tokenized Reschedule link render unchanged', async () => {
    api.getSchedule.mockResolvedValue({ upcoming: [upcomingVisit] });
    await renderSchedule({ ...baseCustomer, cancelled: false });
    expect(screen.getByRole('button', { name: /confirm/i })).toBeInTheDocument();
    const link = screen.getByText('Reschedule');
    expect(link).toHaveAttribute('href', upcomingVisit.rescheduleUrl);
  });
});
