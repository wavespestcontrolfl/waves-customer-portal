// @vitest-environment jsdom
// Under the price (owner 2026-11-21):
// 1. The first visit's bill as one number. A customer reads the monthly average on the
//    price card and then meets a first bill about twice that in the "Reserve your spot" box,
//    which shows only after a time is picked. The line states that total up front and is the
//    box's own figure.
// 2. A link down to the Ask Waves box, which sits at the end of the page.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EstimateViewPage, { PriceFollowUps } from './EstimateViewPage';
import { setGlassDefault } from '../lib/estimate-glass-copy';

vi.mock('react-router-dom', () => ({ useParams: () => ({ token: 'price-follow-ups-token' }) }));
vi.mock('../lib/stripeLoader', () => ({ loadStripeSdk: vi.fn(async () => null) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setGlassDefault(false);
});

const ASK_LINK = 'Questions about this estimate? Ask Waves';
const firstVisitLine = (container) => container.querySelector('[data-first-visit-line]');

describe('PriceFollowUps', () => {
  const firstVisit = { total: 216, firstApplication: 117, setup: 99 };

  it('one service: the owner-approved sentence, word for word', () => {
    const { container } = render(<PriceFollowUps firstVisit={firstVisit} laterVisit={117} />);
    expect(firstVisitLine(container).textContent)
      .toBe('First visit: $216.00 ($117.00 application + $99.00 one-time setup). Each visit after that: $117.00.');
  });

  it('several services: plural "applications" and no "each visit after that" (the months differ)', () => {
    const { container } = render(<PriceFollowUps firstVisit={{ total: 288.9, firstApplication: 189.9, setup: 99 }} severalServices />);
    expect(firstVisitLine(container).textContent).toBe('First visit: $288.90 ($189.90 applications + $99.00 one-time setup).');
  });

  it('the link calls onAsk; without onAsk there is no link, and with neither part nothing renders', () => {
    const onAsk = vi.fn();
    const { container, rerender } = render(<PriceFollowUps onAsk={onAsk} />);
    expect(firstVisitLine(container)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: ASK_LINK }));
    expect(onAsk).toHaveBeenCalledTimes(1);
    rerender(<PriceFollowUps firstVisit={firstVisit} />);
    expect(screen.queryByRole('button', { name: ASK_LINK })).toBeNull();
    rerender(<PriceFollowUps />);
    expect(container.querySelector('[data-price-follow-ups]')).toBeNull();
  });
});

describe('estimate page: first-visit line and Ask Waves link under the price', () => {
  const base = (glass = true) => ({
    glassDefault: glass,
    estimate: {
      customerFirstName: 'Casey', address: '1 Plan Way, Sarasota, FL 34236', serviceCategory: 'pest_control',
      acceptance: { mode: 'standard_slot_pick' }, defaultServiceMode: 'recurring', isOneTimeOnly: false,
      showOneTimeOption: false, billByInvoice: false, membership: null, intelligence: null, askToken: 'ask-token',
    },
    cta: { canAccept: true, terminalState: null, quoteRequired: false, reviewBeforeBooking: false },
  });
  const treatment = (service, label, perApp, visits, monthly) => (
    { service, label, displayPrice: perApp, perTreatment: perApp, visitsPerYear: visits, monthly }
  );
  const pestSection = (perApp, visits, monthly) => ({
    key: 'pest_control', label: 'Pest Control', isRecurring: true, isPest: true, waveGuardTierEligible: true,
    defaultFrequencyKey: 'quarterly', copy: { priceWording: {} },
    frequencies: [{
      key: 'quarterly', label: 'Quarterly', monthly, annual: monthly * 12, perVisit: perApp, perTreatment: perApp, visitsPerYear: visits,
      perServiceTreatments: [treatment('pest_control', 'Pest Control', perApp, visits, monthly)],
      included: [{ key: 'pest_control', label: 'Pest Control', detail: null }], addOns: [],
    }],
  });
  const mosquitoSection = (perApp, monthly) => ({
    key: 'mosquito', label: 'Mosquito Control', isRecurring: true, isPest: false, waveGuardTierEligible: true,
    defaultFrequencyKey: 'monthly12', copy: { priceWording: {} },
    frequencies: [{
      key: 'monthly12', label: 'Monthly', serviceCategory: 'mosquito', visitsPerYear: 12, monthly, annual: monthly * 12,
      perTreatment: perApp, billedPerApplication: true,
      perServiceTreatments: [treatment('mosquito', 'Mosquito Control', perApp, 12, monthly)],
      included: [{ key: 'mosquito', label: 'Mosquito Control', detail: null }], addOns: [],
    }],
  });
  const setupFee = { amount: 99, service: 'waveguard_setup', label: 'WaveGuard setup', waivedWithPrepay: true };
  const setupBreakdown = { total: 99, items: [{ service: 'waveguard_setup', label: 'WaveGuard setup', amount: 99, kind: 'charge' }] };
  const single = ({ withSetup = true, glass = true } = {}) => ({
    ...base(glass),
    pricing: {
      services: [pestSection(117, 4, 39)], waveGuardTier: 'Bronze', askChips: [], defaultServiceMode: 'recurring',
      // The plan-level list the server sends beside the sections: the payment box and the
      // first-visit line both read the selected plan frequency from it.
      frequencies: pestSection(117, 4, 39).frequencies,
      renderFlags: withSetup ? { showWaveGuardSetupFee: true } : {},
      ...(withSetup ? { setupFee } : {}),
      oneTimeBreakdown: withSetup ? setupBreakdown : { total: 0, items: [] },
    },
  });
  const multi = () => ({
    ...base(),
    estimate: { ...base().estimate, serviceCategory: 'bundle' },
    pricing: {
      services: [pestSection(115.2, 4, 38.4), mosquitoSection(74.7, 74.7)],
      frequencies: [{
        key: 'quarterly', label: 'Quarterly', monthly: 113.1, annual: 1357.2,
        perServiceTreatments: [
          treatment('pest_control', 'Pest Control', 115.2, 4, 38.4),
          treatment('mosquito', 'Mosquito Control', 74.7, 12, 74.7),
        ],
      }],
      combinedRecurring: { monthlySubtotal: 113.1, annualSubtotal: 1357.2, waveGuardTierLabel: 'Silver', waveGuardDiscountPct: 0.1 },
      renderFlags: { showRecurringSummary: true, showWaveGuardSetupFee: true }, waveGuardTier: 'Silver', askChips: [],
      setupFee, oneTimeBreakdown: setupBreakdown, defaultServiceMode: 'recurring',
    },
  });
  const stub = (payload) => vi.stubGlobal('fetch', vi.fn(async (url) => ({
    ok: true,
    status: 200,
    json: async () => (String(url).includes('/available-slots') ? { primary: [], expander: [] } : payload),
  })));
  const renderPage = async (payload) => {
    stub(payload);
    const view = render(<EstimateViewPage />);
    await waitFor(() => expect(view.container.querySelector('#estimate-price-section')).not.toBeNull());
    return view;
  };

  it('one service with a setup fee: setup + first application as one number, then the price of each later visit', async () => {
    const { container } = await renderPage(single());
    await waitFor(() => expect(firstVisitLine(container)).not.toBeNull());
    expect(firstVisitLine(container).textContent)
      .toBe('First visit: $216.00 ($117.00 application + $99.00 one-time setup). Each visit after that: $117.00.');
    // Inside the price section, so it sits with the price it explains.
    expect(container.querySelector('#estimate-price-section').contains(firstVisitLine(container))).toBe(true);
  });

  it('no setup fee: the first visit costs what every visit costs, so there is no line', async () => {
    const { container } = await renderPage(single({ withSetup: false }));
    await waitFor(() => expect(screen.getByRole('button', { name: ASK_LINK })).toBeInTheDocument());
    expect(firstVisitLine(container)).toBeNull();
  });

  it('another first-visit fee (initial cockroach treatment): no line, because setup + application is not the whole bill', async () => {
    // The estimate also offers a one-time visit, so the breakdown reads as the alternate price
    // and the "billed after completion" total is 0; only the first-visit fee list shows the fee.
    const payload = single();
    const roachFee = { service: 'pest_initial_roach', amount: 150, label: 'Cockroach Treatment Service', waivedWithPrepay: false };
    const { container } = await renderPage({
      ...payload,
      estimate: { ...payload.estimate, showOneTimeOption: true },
      pricing: {
        ...payload.pricing,
        firstVisitFees: [setupFee, roachFee],
        oneTimeBreakdown: { total: 249, items: [...setupBreakdown.items, { service: 'pest_initial_roach', label: roachFee.label, amount: 150, kind: 'charge' }] },
      },
    });
    await waitFor(() => expect(screen.getByRole('button', { name: ASK_LINK })).toBeInTheDocument());
    expect(firstVisitLine(container)).toBeNull();
  });

  it('several services: the first bill is every first application plus setup, with no single later price', async () => {
    const { container } = await renderPage(multi());
    await waitFor(() => expect(firstVisitLine(container)).not.toBeNull());
    expect(firstVisitLine(container).textContent).toBe('First visit: $288.90 ($189.90 applications + $99.00 one-time setup).');
  });

  it('the link scrolls to the Ask Waves box at the end of the page', async () => {
    const scrollIntoView = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      const { container } = await renderPage(single());
      const link = await screen.findByRole('button', { name: ASK_LINK });
      const askBox = container.querySelector('#estimate-ask-section');
      expect(askBox).not.toBeNull();
      scrollIntoView.mockClear();
      fireEvent.click(link);
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView.mock.instances[0]).toBe(askBox);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});
