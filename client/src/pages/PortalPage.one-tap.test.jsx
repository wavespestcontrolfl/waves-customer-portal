// @vitest-environment jsdom
// One-tap purchase entry (portal roadmap bet 3): the Add-now buy CTA renders
// ONLY when the server said oneTap:true AND the offer card is priced —
// everything else keeps the request-only CTA. The buy tap opens the purchase
// overlay (server-composed terms/slots), never the request write.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
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
import { DashboardTab } from './PortalPage';

const customer = {
  id: 'cust-1', firstName: 'Pat', lastName: 'Customer',
  phone: '9415551234', email: 'pat@example.com', tier: null,
  monthlyRate: 89, property: {},
};

const PRICED_OFFER_CARD = {
  id: 'plan_offer',
  kind: 'offer',
  priority: 'medium',
  title: 'Lawn Care',
  body: 'Your plan does not include this yet.',
  serviceKey: 'lawn_care',
  mode: 'priced',
  relationship: 'add',
  option: { id: 'lawn-enhanced', label: 'Lawn care — 9x applications/yr', cadence: '9 applications/yr', perVisit: 84 },
  fingerprint: 'fp-1',
  ctaLabel: 'Add Lawn Care',
};

const recommendations = (overrides = {}) => ({
  available: true,
  oneTap: true,
  cards: [PRICED_OFFER_CARD],
  ...overrides,
});

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

const renderDashboard = () => render(
  <DashboardTab customer={customer} onSwitchTab={() => {}} onOpenPlanService={() => {}} />,
);

describe('one-tap purchase CTA gating', () => {
  it('oneTap:true + priced offer → Add-now is the ONLY CTA (owner ruling: no secondary ask, no priority chip)', async () => {
    api.getPropertyRecommendations.mockResolvedValue(recommendations());
    renderDashboard();
    const buy = await screen.findByText('Add now — $84.00 per application');
    expect(buy).toBeInTheDocument();
    // Owner ruling 08-13: yellow glass accent, same as the Waves AI Ask button.
    expect(buy.closest('button')).toHaveAttribute('data-glass-accent');
    expect(screen.queryByText('Ask a question instead')).not.toBeInTheDocument();
    // Offer cards carry no priority chip — the section header already says it.
    expect(screen.queryByText('Recommended')).not.toBeInTheDocument();
    // The plain request CTA is replaced, not duplicated.
    expect(screen.queryByText('Add Lawn Care')).not.toBeInTheDocument();
  });

  it('oneTap:false keeps the request-only CTA — no buy button', async () => {
    api.getPropertyRecommendations.mockResolvedValue(recommendations({ oneTap: false }));
    renderDashboard();
    expect(await screen.findByText('Add Lawn Care')).toBeInTheDocument();
    expect(screen.queryByText(/Add now —/)).not.toBeInTheDocument();
    expect(screen.queryByText('Ask a question instead')).not.toBeInTheDocument();
  });

  it('an unpriced (quote_cta) offer never gets a buy button, even with oneTap:true', async () => {
    api.getPropertyRecommendations.mockResolvedValue(recommendations({
      cards: [{ ...PRICED_OFFER_CARD, mode: 'quote_cta', option: null, ctaLabel: 'Request a quote' }],
    }));
    renderDashboard();
    expect(await screen.findByText('Request a quote')).toBeInTheDocument();
    expect(screen.queryByText(/Add now —/)).not.toBeInTheDocument();
  });

  it('the buy tap opens the purchase overlay and inits with the rendered offer identity', async () => {
    api.getPropertyRecommendations.mockResolvedValue(recommendations());
    renderDashboard();
    fireEvent.click(await screen.findByText('Add now — $84.00 per application'));
    // Overlay opens in its loading state while /init is in flight.
    expect(await screen.findByRole('dialog', { name: /Add Lawn Care/ })).toBeInTheDocument();
    expect(api.oneTapInit).toHaveBeenCalledWith({
      fingerprint: 'fp-1',
      serviceKey: 'lawn_care',
      optionId: 'lawn-enhanced',
      perApplication: 84,
    });
    // The buy tap must never fire the request-write path.
    expect(api.requestPropertyRecommendation).not.toHaveBeenCalled();
  });

  it('walks terms → time → confirm on the server payload and confirms with termsAccepted', async () => {
    api.getPropertyRecommendations.mockResolvedValue(recommendations());
    api.oneTapInit.mockResolvedValue({
      purchaseId: 'p-1',
      estimateId: 'est-1',
      serviceKey: 'lawn_care',
      label: 'Lawn Care',
      perVisit: 84,
      cadenceLabel: '9 applications/yr',
      visitsPerYear: 9,
      terms: { version: 'v1', text: 'Server terms text.' },
      hasCardOnFile: true,
      holdMinutes: 15,
      slots: {
        primary: [{
          slotId: 'slot-1', date: '2026-08-20', windowStart: '08:00', windowEnd: '10:00',
          techFirstName: 'Adam', routeOptimal: true,
        }],
        expander: [],
        nearby: true,
      },
    });
    api.oneTapReserve.mockResolvedValue({ scheduledServiceId: 'ss-1', expiresAt: new Date(Date.now() + 900000).toISOString(), holdMinutes: 15 });
    api.oneTapConfirm.mockResolvedValue({
      success: true, perVisit: 84, label: 'Lawn Care', emailQueued: true,
      firstVisit: { date: '2026-08-20', windowStart: '08:00', windowEnd: '10:00' },
    });

    renderDashboard();
    fireEvent.click(await screen.findByText('Add now — $84.00 per application'));

    // TERMS: server text renders verbatim; agreeing advances to the picker.
    expect(await screen.findByText('Server terms text.')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Agree and choose a time'));

    // TIME: server slots with the nearby-priority chip; picking reserves.
    expect(await screen.findByText('Tech nearby — priority')).toBeInTheDocument();
    fireEvent.click(screen.getByText(/Arrival 8:00 AM–10:00 AM/));
    expect(await screen.findByText(/held for 15 minutes/)).toBeInTheDocument();
    expect(api.oneTapReserve).toHaveBeenCalledWith('p-1', 'slot-1');

    // CONFIRM: card already on file → no capture form; confirm purchases.
    fireEvent.click(screen.getByText('Confirm'));
    expect(await screen.findByText('Lawn Care is confirmed')).toBeInTheDocument();
    expect(api.oneTapConfirm).toHaveBeenCalledWith('p-1', { termsAccepted: true });
    expect(screen.getByText(/confirmation email and an app notification/)).toBeInTheDocument();
  });

  it('a SetupIntent-return resume renders the held purchase even when no recommendation cards load (GH r5 P2)', async () => {
    window.history.replaceState({}, '', '/?stripe_setup_flow=one_tap_card&setup_intent=si_1&redirect_status=succeeded&one_tap_resume=p-7');
    try {
      api.getPropertyRecommendations.mockResolvedValue(recommendations({ cards: [] }));
      api.saveStripeCard.mockResolvedValue({});
      api.oneTapGet.mockResolvedValue({
        purchaseId: 'p-7', estimateId: 'est-1', status: 'reserved', open: true,
        serviceKey: 'lawn_care', label: 'Lawn Care', perVisit: 84,
        cadenceLabel: '9 applications/yr', visitsPerYear: 9,
        terms: { version: 'v1', text: 'Server terms text.' },
        hasCardOnFile: true, holdLive: true, holdMinutes: 15,
        slot: { date: '2026-08-20', windowStart: '08:00', windowEnd: '10:00', holdExpiresAt: new Date(Date.now() + 900000).toISOString() },
      });
      renderDashboard();
      // The resumed overlay must render despite the empty card list — it is
      // the only automatic path back to the held purchase.
      expect(await screen.findByRole('dialog', { name: /Add Lawn Care/ })).toBeInTheDocument();
      expect(api.oneTapGet).toHaveBeenCalledWith('p-7');
    } finally {
      window.history.replaceState({}, '', '/');
    }
  });

  it('an init that resolves after the overlay closed releases the freshly created purchase (GH r5 P2)', async () => {
    api.getPropertyRecommendations.mockResolvedValue(recommendations());
    let resolveInit;
    api.oneTapInit.mockReturnValue(new Promise((resolve) => { resolveInit = resolve; }));
    api.oneTapRelease.mockResolvedValue({ released: true });
    const view = renderDashboard();
    fireEvent.click(await screen.findByText('Add now — $84.00 per application'));
    expect(api.oneTapInit).toHaveBeenCalled();
    // Overlay unmounts while /init is still in flight — cleanup sees no id.
    view.unmount();
    resolveInit({ purchaseId: 'p-9', slots: { primary: [], expander: [], nearby: false } });
    // The stale success is the only holder of the new id — it must release.
    await vi.waitFor(() => expect(api.oneTapRelease).toHaveBeenCalledWith('p-9'));
  });

  it('Change time is locked while a confirmation is in flight (GH r5 P2)', async () => {
    api.getPropertyRecommendations.mockResolvedValue(recommendations());
    api.oneTapInit.mockResolvedValue({
      purchaseId: 'p-1', estimateId: 'est-1', serviceKey: 'lawn_care', label: 'Lawn Care',
      perVisit: 84, cadenceLabel: '9 applications/yr', visitsPerYear: 9,
      terms: { version: 'v1', text: 'Server terms text.' }, hasCardOnFile: true, holdMinutes: 15,
      slots: {
        primary: [{ slotId: 'slot-1', date: '2026-08-20', windowStart: '08:00', windowEnd: '10:00', techFirstName: 'Adam', routeOptimal: true }],
        expander: [], nearby: true,
      },
    });
    api.oneTapReserve.mockResolvedValue({ scheduledServiceId: 'ss-1', expiresAt: new Date(Date.now() + 900000).toISOString(), holdMinutes: 15 });
    api.oneTapConfirm.mockReturnValue(new Promise(() => {})); // never settles
    renderDashboard();
    fireEvent.click(await screen.findByText('Add now — $84.00 per application'));
    fireEvent.click(await screen.findByText('Agree and choose a time'));
    fireEvent.click(await screen.findByText(/Arrival 8:00 AM–10:00 AM/));
    await screen.findByText(/held for 15 minutes/);
    fireEvent.click(screen.getByText('Confirm'));
    expect(await screen.findByText('Confirming…')).toBeInTheDocument();
    // Reserving a replacement slot mid-confirm races the in-flight hold.
    expect(screen.getByText('Change time').closest('button')).toBeDisabled();
  });

  it('a 409 at init renders the offer-changed refresh state, never a dead retry', async () => {
    api.getPropertyRecommendations.mockResolvedValue(recommendations());
    const stale = Object.assign(new Error('offer changed'), { status: 409 });
    api.oneTapInit.mockRejectedValue(stale);
    renderDashboard();
    fireEvent.click(await screen.findByText('Add now — $84.00 per application'));
    expect(await screen.findByText('This offer changed')).toBeInTheDocument();
    expect(screen.getByText('Refresh the page')).toBeInTheDocument();
  });
});
