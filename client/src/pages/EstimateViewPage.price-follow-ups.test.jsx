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

  it('the owner-approved sentence, word for word', () => {
    const { container } = render(<PriceFollowUps firstVisit={firstVisit} />);
    expect(firstVisitLine(container).textContent)
      .toBe('First visit: $216.00 ($117.00 application + $99.00 one-time setup). Each visit after that: $117.00.');
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
  const pestFrequency = (perApp, visits, monthly, extra = {}) => ({
    key: 'quarterly', label: 'Quarterly', monthly, annual: monthly * 12, perVisit: perApp, perTreatment: perApp, visitsPerYear: visits,
    perServiceTreatments: [treatment('pest_control', 'Pest Control', perApp, visits, monthly)],
    included: [{ key: 'pest_control', label: 'Pest Control', detail: null }], addOns: [],
    ...extra,
  });
  const pestSection = (frequency) => ({
    key: 'pest_control', label: 'Pest Control', isRecurring: true, isPest: true, waveGuardTierEligible: true,
    defaultFrequencyKey: 'quarterly', copy: { priceWording: {} }, frequencies: [frequency],
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
  // One pest plan: $117.00 an application, 4 a year, $39.00 a month. `frequency` overrides the
  // selected cadence on the section AND on the plan-level list the server sends beside it (the
  // payment box and the first-visit line read the selected plan frequency from that list).
  const single = ({ withSetup = true, frequency = pestFrequency(117, 4, 39), planFrequency = frequency } = {}) => ({
    ...base(),
    pricing: {
      services: [pestSection(frequency)], waveGuardTier: 'Bronze', askChips: [], defaultServiceMode: 'recurring',
      frequencies: [planFrequency],
      renderFlags: withSetup ? { showWaveGuardSetupFee: true } : {},
      ...(withSetup ? { setupFee } : {}),
      oneTimeBreakdown: withSetup ? setupBreakdown : { total: 0, items: [] },
    },
  });
  // Pest + mosquito. Production charges no setup fee on a bundle; `withSetup` builds the
  // payload a stale or mistaken fee would make, which still must not show a line.
  const bundle = ({ withSetup = false } = {}) => ({
    ...base(),
    estimate: { ...base().estimate, serviceCategory: 'bundle' },
    pricing: {
      services: [pestSection(pestFrequency(115.2, 4, 38.4)), mosquitoSection(74.7, 74.7)],
      frequencies: [{
        key: 'quarterly', label: 'Quarterly', monthly: 113.1, annual: 1357.2,
        perServiceTreatments: [
          treatment('pest_control', 'Pest Control', 115.2, 4, 38.4),
          treatment('mosquito', 'Mosquito Control', 74.7, 12, 74.7),
        ],
      }],
      combinedRecurring: { monthlySubtotal: 113.1, annualSubtotal: 1357.2, waveGuardTierLabel: 'Silver', waveGuardDiscountPct: 0.1 },
      renderFlags: { showRecurringSummary: true, ...(withSetup ? { showWaveGuardSetupFee: true } : {}) }, waveGuardTier: 'Silver', askChips: [],
      ...(withSetup ? { setupFee } : {}),
      oneTimeBreakdown: withSetup ? setupBreakdown : { total: 0, items: [] }, defaultServiceMode: 'recurring',
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
  // The page has settled (the link is up) and shows no first-visit line.
  const expectNoLine = async (payload) => {
    const { container } = await renderPage(payload);
    await waitFor(() => expect(screen.getByRole('button', { name: ASK_LINK })).toBeInTheDocument());
    expect(firstVisitLine(container)).toBeNull();
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
    await expectNoLine(single({ withSetup: false }));
  });

  it.each([
    ['as production sends it (no setup fee)', {}],
    ['even if a payload carried a setup fee', { withSetup: true }],
  ])('a bundle %s: no line (the setup fee is charged on a one-service plan only)', async (_label, options) => {
    await expectNoLine(bundle(options));
  });

  it('another first-visit fee (initial cockroach treatment): no line, because setup + application is not the whole bill', async () => {
    // The estimate also offers a one-time visit, so the breakdown reads as the alternate price
    // and the "billed after completion" total is 0; only the first-visit fee list shows the fee.
    const payload = single();
    const roachFee = { service: 'pest_initial_roach', amount: 150, label: 'Cockroach Treatment Service', waivedWithPrepay: false };
    await expectNoLine({
      ...payload,
      estimate: { ...payload.estimate, showOneTimeOption: true },
      pricing: {
        ...payload.pricing,
        firstVisitFees: [setupFee, roachFee],
        oneTimeBreakdown: { total: 249, items: [...setupBreakdown.items, { service: 'pest_initial_roach', label: roachFee.label, amount: 150, kind: 'charge' }] },
      },
    });
  });

  // The accept bills the plan's row less any service-preference credit and plan-credit slice,
  // and credits a deposit or a code against the invoice. In each case below the box's first
  // application is not proven to be the invoice, so the page states no first-visit total.
  it('the plan\'s monthly sits below the card price (a credit the page does not itemize): no line', async () => {
    // $10 off each of 4 applications: the monthly drops, the card's per-application price does
    // not, so the monthly average does not reconcile.
    await expectNoLine(single({ frequency: pestFrequency(117, 4, 39, { monthly: 35.67, annual: 428 }) }));
  });

  it('a pest service turned off, even when the pricing floor caps its credit to cents: no line', async () => {
    const addOns = [
      { key: 'interior_spray', label: 'Interior spraying', detail: 'Save $10 per application if removed.', preChecked: false },
      { key: 'exterior_sweep', label: 'Exterior eave sweep', detail: 'Save $10 per application if removed.', preChecked: true },
    ];
    // 4 cents a month off: inside the average's rounding band, so only the direct check sees it.
    await expectNoLine(single({ frequency: pestFrequency(117, 4, 39, { monthly: 38.96, annual: 467.52, addOns }) }));
  });

  it('a plan credit on the selected cadence, small enough to sit inside the average\'s rounding band: no line', async () => {
    const credit = { label: 'Courtesy credit', amount: 0.48, recurringAmount: 0.48 };
    await expectNoLine(single({ frequency: pestFrequency(117, 4, 39, { monthly: 38.96, annual: 467.52, manualDiscount: credit }) }));
  });

  it.each([
    ['a required booking deposit (credited against the first invoice)', { depositPolicy: { enforced: true, required: true, recurringAmount: 49, oneTimeAmount: 49 } }],
    ['a promo or referral code applied on this estimate', { promoCode: { canEnter: false, applied: { code: 'NEIGHBOR', credited: false } } }],
  ])('%s: no line', async (_label, extra) => {
    await expectNoLine({ ...single(), ...extra });
  });

  it('a code applied while the line shows: the line goes at once, with no reload', async () => {
    const applied = { canEnter: false, applied: { code: 'NEIGHBOR', credited: false } };
    vi.stubGlobal('fetch', vi.fn(async (url) => ({
      ok: true,
      status: 200,
      json: async () => {
        if (String(url).includes('/promo-code')) return { success: true, promoCode: applied };
        if (String(url).includes('/available-slots')) return { primary: [], expander: [] };
        return { ...single(), promoCode: { canEnter: true, acceptsReferral: true } };
      },
    })));
    const { container } = render(<EstimateViewPage />);
    await waitFor(() => expect(firstVisitLine(container)).not.toBeNull());
    fireEvent.change(screen.getByLabelText('Promo or referral code'), { target: { value: 'NEIGHBOR' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(firstVisitLine(container)).toBeNull());
  });

  it('the plan row and the price card disagree: no line (the box amount is not the card price)', async () => {
    await expectNoLine(single({ planFrequency: pestFrequency(120, 4, 39) }));
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
