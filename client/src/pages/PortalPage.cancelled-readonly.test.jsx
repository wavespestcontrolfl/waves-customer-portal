// @vitest-environment jsdom
// C4 (GATE_CANCEL_FLOW_V2): a CANCELLED account's Billing tab keeps the
// reads (balance, history, credits) and hides every management surface
// whose writes the middleware 401s — Payment Methods (incl. Auto Pay
// controls), the auto-apply-credit toggle, and Billing Preferences. An
// active account renders all of them unchanged.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/api', () => ({
  default: {
    // Billing mounts Home's add-a-service card (owner 2026-11-21).
    getPropertyRecommendations: vi.fn(async () => ({ available: false })),
    requestPropertyRecommendation: vi.fn(),
    saveStripeCard: vi.fn(),
    oneTapGet: vi.fn(),
    oneTapRelease: vi.fn(),
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

  // The offer's purchase overlay can save a payment method, and a consented
  // save can enroll Auto Pay on the server. Billing shows the Payment Methods
  // list and the Auto Pay controls on the same tab, so both must read again;
  // Home has neither. Driven here by the return from a bank page, the save
  // the card component runs by itself at mount.
  it('a payment method saved from the offer reloads the Billing card list and the Auto Pay controls', async () => {
    window.history.replaceState({}, '', '/?stripe_setup_flow=one_tap_card&setup_intent=si_1&redirect_status=succeeded&one_tap_resume=p-7');
    try {
      let saved = false;
      api.getPropertyRecommendations.mockResolvedValue(RECS);
      api.saveStripeCard.mockImplementation(async () => { saved = true; return {}; });
      api.getAutopay.mockImplementation(async () => (saved
        ? { state: 'active', autopay_enabled: true, autopay_selected_method_ids: ['pm-1'] }
        : { state: 'disabled', autopay_enabled: false, autopay_selected_method_ids: [] }));
      api.oneTapGet.mockResolvedValue({ open: false });
      await renderBilling({ ...baseCustomer, cancelled: false }, { onSwitchTab: vi.fn() });
      await waitFor(() => expect(api.saveStripeCard).toHaveBeenCalledWith(null, 'si_1'));
      // Once at mount, once after the save.
      await waitFor(() => expect(api.getCards).toHaveBeenCalledTimes(2));
      // The Auto Pay controls read the state the save produced: the
      // "Turn on" button of the off state is gone.
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Turn on Auto Pay' })).not.toBeInTheDocument());
      expect(screen.getAllByText('Auto Pay is on').length).toBeGreaterThan(0);
    } finally {
      window.history.replaceState({}, '', '/');
    }
  });

  // The card owns the return from a bank page for its purchase. Billing has a
  // loading view and an error view; the return must be resumed in both, or a
  // failed balance read leaves the held visit time to expire. And the card
  // must be the same instance when Billing then loads, or the reopened
  // purchase closes by itself.
  it('a bank-page return is resumed while Billing fails to load, and stays open when Billing loads', async () => {
    window.history.replaceState({}, '', '/?stripe_setup_flow=one_tap_card&setup_intent=si_1&redirect_status=succeeded&one_tap_resume=p-7');
    try {
      api.getPropertyRecommendations.mockResolvedValue(RECS);
      api.saveStripeCard.mockResolvedValue({});
      api.oneTapGet.mockResolvedValue({
        purchaseId: 'p-7', estimateId: 'est-1', status: 'reserved', open: true,
        serviceKey: 'lawn_care', label: 'Lawn Care', perVisit: 84,
        cadenceLabel: '9 applications/yr', visitsPerYear: 9,
        terms: { version: 'v1', text: 'Server terms text.' },
        hasCardOnFile: true, holdLive: true, holdMinutes: 15,
        slot: { date: '2026-08-20', windowStart: '08:00', windowEnd: '10:00', holdExpiresAt: new Date(Date.now() + 900000).toISOString() },
      });
      api.getBalance.mockRejectedValueOnce(new Error('balance read failed'));
      render(<BillingTab customer={{ ...baseCustomer, cancelled: false }} refreshCustomer={vi.fn()} onSwitchTab={vi.fn()} />);

      expect(await screen.findByText('Could not load billing')).toBeInTheDocument();
      expect(await screen.findByRole('dialog', { name: /Add Lawn Care/ })).toBeInTheDocument();
      expect(api.saveStripeCard).toHaveBeenCalledWith(null, 'si_1');

      fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
      await screen.findByText(/^Payment History$/i);
      expect(screen.getByRole('dialog', { name: /Add Lawn Care/ })).toBeInTheDocument();
      // One instance: the return was read once, and no card unmounted on
      // the way (an unmounted overlay releases the held purchase).
      expect(api.oneTapGet).toHaveBeenCalledTimes(1);
      expect(api.oneTapRelease).not.toHaveBeenCalled();
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
