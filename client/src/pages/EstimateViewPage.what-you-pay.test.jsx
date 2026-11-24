// @vitest-environment jsdom
// "What you pay" under the price (owner 2026-11-23). Estimate customers asked what the
// $99 line was, why booking showed $177 against "$91.50 a month", and whether the lawn was billed
// monthly. The box states due today, the first visit itemised, each visit after, the first year
// and the setup fee, from the figures the page already shows.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EstimateViewPage from './EstimateViewPage';
import { buildWhatYouPay } from '../components/estimate/WhatYouPayBox';
import { setGlassDefault } from '../lib/estimate-glass-copy';

vi.mock('react-router-dom', () => ({ useParams: () => ({ token: 'what-you-pay-token' }) }));
vi.mock('../lib/stripeLoader', () => ({ loadStripeSdk: vi.fn(async () => null) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setGlassDefault(false);
});

const box = (container) => container.querySelector('[data-what-you-pay]');
const text = (container) => box(container).textContent;

const base = {
  glassDefault: true,
  estimate: {
    customerFirstName: 'Casey', address: '1 Plan Way, Sarasota, FL 34236', serviceCategory: 'pest_control',
    acceptance: { mode: 'standard_slot_pick' }, defaultServiceMode: 'recurring', isOneTimeOnly: false,
    showOneTimeOption: false, billByInvoice: false, membership: null, intelligence: null, askToken: 'ask-token',
  },
  cta: { canAccept: true, terminalState: null, quoteRequired: false, reviewBeforeBooking: false },
};
const treatment = (service, label, perApp, visits, monthly) => (
  { service, label, displayPrice: perApp, perTreatment: perApp, visitsPerYear: visits, monthly }
);
const pestSection = (perApp, visits, monthly, extra = {}) => ({
  key: 'pest_control', label: 'Pest Control', isRecurring: true, isPest: true, waveGuardTierEligible: true,
  defaultFrequencyKey: 'quarterly', copy: { priceWording: {} },
  frequencies: [{
    key: 'quarterly', label: 'Quarterly', monthly, annual: monthly * 12, perVisit: perApp, perTreatment: perApp, visitsPerYear: visits,
    perServiceTreatments: [treatment('pest_control', 'Pest Control', perApp, visits, monthly)],
    included: [{ key: 'pest_control', label: 'Pest Control', detail: null }], addOns: [], ...extra,
  }],
});
const lawnSection = (perApp, visits, monthly) => ({
  key: 'lawn_care', label: 'Lawn Care', isRecurring: true, isPest: false, waveGuardTierEligible: true,
  defaultFrequencyKey: 'standard', copy: { priceWording: {} },
  frequencies: [{
    key: 'standard', label: 'Standard', serviceCategory: 'lawn_care', monthly, annual: monthly * 12, perTreatment: perApp,
    visitsPerYear: visits, billedPerApplication: true,
    perServiceTreatments: [treatment('lawn_care', 'Lawn Care', perApp, visits, monthly)],
    included: [{ key: 'lawn_care', label: 'Lawn Care', detail: null }], addOns: [],
  }],
});
const setupFee = { amount: 99, service: 'waveguard_setup', label: 'WaveGuard setup', waivedWithPrepay: true };
const setupBreakdown = { total: 99, items: [{ service: 'waveguard_setup', label: 'WaveGuard setup', amount: 99, kind: 'charge' }] };
const noBreakdown = { total: 0, items: [] };

// Pest only: $99.00 an application, 4 a year, with the $99.00 setup fee.
const pestOnly = () => {
  const section = pestSection(99, 4, 33);
  return {
    ...base,
    pricing: {
      services: [section], waveGuardTier: 'Bronze', askChips: [], defaultServiceMode: 'recurring',
      frequencies: section.frequencies, renderFlags: { showWaveGuardSetupFee: true }, setupFee, oneTimeBreakdown: setupBreakdown,
      annualPrepayEligible: true,
    },
  };
};
// Pest $99.00 x 4 + lawn $78.00 x 9: the plan a customer saw as "$91.50 a month" beside a $177 first visit.
const bundle = () => {
  const pest = pestSection(99, 4, 33);
  const lawn = lawnSection(78, 9, 58.5);
  return {
    ...base,
    estimate: { ...base.estimate, serviceCategory: 'bundle' },
    pricing: {
      services: [pest, lawn],
      frequencies: [{
        key: 'quarterly', label: 'Quarterly', monthly: 91.5, annual: 1098,
        perServiceTreatments: [treatment('pest_control', 'Pest Control', 99, 4, 33), treatment('lawn_care', 'Lawn Care', 78, 9, 58.5)],
      }],
      combinedRecurring: { monthlySubtotal: 91.5, annualSubtotal: 1098, waveGuardTierLabel: 'Silver', waveGuardDiscountPct: 0 },
      renderFlags: { showRecurringSummary: true }, waveGuardTier: 'Silver', askChips: [],
      oneTimeBreakdown: noBreakdown, defaultServiceMode: 'recurring',
    },
  };
};
const lawnOnly = () => {
  const lawn = lawnSection(78, 9, 58.5);
  return {
    ...base,
    estimate: { ...base.estimate, serviceCategory: 'lawn_care' },
    pricing: {
      services: [lawn], askChips: [], defaultServiceMode: 'recurring', frequencies: lawn.frequencies,
      renderFlags: {}, oneTimeBreakdown: noBreakdown,
    },
  };
};

const renderPage = async (payload) => {
  vi.stubGlobal('fetch', vi.fn(async (url) => ({
    ok: true,
    status: 200,
    json: async () => (String(url).includes('/available-slots') ? { primary: [], expander: [] } : payload),
  })));
  const view = render(<EstimateViewPage />);
  await waitFor(() => expect(view.container.querySelector('#estimate-price-section')).not.toBeNull());
  return view;
};

describe('estimate page: what you pay and when', () => {
  it('pest only with the setup fee: first visit itemised, each visit after, first year, and the $99 sentence', async () => {
    const { container } = await renderPage(pestOnly());
    await waitFor(() => expect(box(container)).not.toBeNull());
    const t = text(container);
    expect(t).toContain('What you pay');
    expect(t).not.toMatch(/due today|prepay the year in one payment|exact total/i);
    expect(t).toContain('Pest Control$99.00');
    expect(t).toContain('Setup fee$99.00');
    expect(t).toContain('First visit total$198.00');
    expect(t).toContain('Each application after that');
    expect(t).toContain('4 applications a year, counting the first');
    // AGENTS.md: no combined plan total ($X/yr) on a customer estimate; units are "application", never "visit".
    expect(t).not.toMatch(/year total|first year|\$495|\$1,098|\$702/i);
    expect(t).not.toMatch(/visits? a year|each visit/i);
    expect(t).toContain('The $99.00 setup fee is a one-time charge to start a plan with one recurring service. Plans with two or more recurring services do not pay it. It is also waived if you prepay the year.');
    // Inside the price section, with the price it explains.
    expect(container.querySelector('#estimate-price-section').contains(box(container))).toBe(true);
  });

  it('a bundle: no setup fee line, the first visit is each service added up, the year is the whole plan', async () => {
    const { container } = await renderPage(bundle());
    await waitFor(() => expect(box(container)).not.toBeNull());
    const t = text(container);
    expect(t).toContain('Pest Control$99.00');
    expect(t).toContain('Lawn Care$78.00');
    expect(t).toContain('First visit total$177.00');
    expect(t).toContain('4 applications a year, counting the first');
    expect(t).toContain('9 applications a year, counting the first');
    expect(t).not.toMatch(/year total|\$1,098/i);
    expect(t).not.toMatch(/setup fee/i);
    // The monthly figure is explained as an average, never as the price.
  });

  it('lawn only: the per-application price and the visit count, with no setup fee', async () => {
    const { container } = await renderPage(lawnOnly());
    await waitFor(() => expect(box(container)).not.toBeNull());
    const t = text(container);
    expect(t).toContain('Lawn Care$78.00');
    expect(t).toContain('9 applications a year, counting the first');
    expect(t).not.toMatch(/year total|\$702/i);
    expect(t).not.toMatch(/setup fee/i);
    expect(t).not.toContain('First visit total');
  });

  it('pest only where prepay is not offered: the fee sentence does not promise a waiver', async () => {
    const payload = pestOnly();
    payload.pricing.annualPrepayEligible = false;
    const { container } = await renderPage(payload);
    await waitFor(() => expect(box(container)).not.toBeNull());
    expect(text(container)).toContain('Plans with two or more recurring services do not pay it.');
    expect(text(container)).not.toMatch(/waived/i);
  });

  it('never prints a price as a monthly bill: no "/mo" and no "about"', async () => {
    const { container } = await renderPage(bundle());
    await waitFor(() => expect(box(container)).not.toBeNull());
    expect(text(container)).not.toMatch(/\/\s?mo|\/month|about/i);
  });

  it('a plan credit takes the box away: the first bill is not the printed figures', async () => {
    const credit = { label: 'Courtesy credit', amount: 0.48, recurringAmount: 0.48 };
    const payload = pestOnly();
    payload.pricing.services = [pestSection(99, 4, 33, { monthly: 32.96, annual: 395.52, manualDiscount: credit })];
    payload.pricing.frequencies = payload.pricing.services[0].frequencies;
    const { container } = await renderPage(payload);
    await waitFor(() => expect(container.querySelector('[data-price-follow-ups]')).not.toBeNull());
    expect(box(container)).toBeNull();
  });

  it('another first-visit fee (initial cockroach treatment) takes the box away', async () => {
    const payload = pestOnly();
    const roachFee = { service: 'pest_initial_roach', amount: 150, label: 'Cockroach Treatment Service', waivedWithPrepay: false };
    payload.estimate = { ...payload.estimate, showOneTimeOption: true };
    payload.pricing = { ...payload.pricing, firstVisitFees: [setupFee, roachFee] };
    const { container } = await renderPage(payload);
    await waitFor(() => expect(container.querySelector('[data-price-follow-ups]')).not.toBeNull());
    expect(box(container)).toBeNull();
  });

  it('an invoice-billed estimate gets no box', async () => {
    const payload = pestOnly();
    payload.estimate = { ...payload.estimate, billByInvoice: true };
    const { container } = await renderPage(payload);
    await waitFor(() => expect(container.querySelector('[data-price-follow-ups]')).not.toBeNull());
    expect(box(container)).toBeNull();
  });
});

describe('buildWhatYouPay', () => {
  const model = (services) => ({
    planMonthly: 0, credit: null, multi: services.length > 1,
    services: services.map(([key, label, perApplication, visits]) => ({ key, label, perApplication, visits, monthly: 0 })),
  });
  const pest = model([['pest_control', 'Pest Control', 99, 4]]);
  const input = (extra = {}) => ({ model: pest, fees: [setupFee], serviceMode: 'recurring', invoiceFirstVisit: 99, ...extra });
  const FEE_SENTENCE = 'The $99.00 setup fee is a one-time charge to start a plan with one recurring service. Plans with two or more recurring services do not pay it.';

  it('the annual prepay choice renders no box (the Reserve your spot box owns payment timing and prepay)', () => {
    expect(buildWhatYouPay(input({ paymentPreference: 'prepay_annual', annualPrepayOffered: true }))).toBeNull();
    expect(buildWhatYouPay(input({ paymentPreference: 'pay_at_visit' }))).not.toBeNull();
  });

  it('the waiver clause needs both the page offering prepay and the server marking the fee waivable', () => {
    expect(buildWhatYouPay(input({ annualPrepayOffered: true })).setupSentence).toBe(`${FEE_SENTENCE} It is also waived if you prepay the year.`);
    expect(buildWhatYouPay(input({ annualPrepayOffered: false })).setupSentence).toBe(FEE_SENTENCE);
    const notWaivable = { ...setupFee, waivedWithPrepay: false };
    expect(buildWhatYouPay(input({ fees: [notWaivable], annualPrepayOffered: true })).setupSentence).toBe(FEE_SENTENCE);
  });

  it('prints no plan total and no payment-timing or prepay field', () => {
    const result = buildWhatYouPay(input({ annualPrepayOffered: true, monthlyShown: true }));
    expect(Object.keys(result).sort()).toEqual(['firstVisitTotal', 'lines', 'setup', 'setupSentence']);
    expect(result.firstVisitTotal).toBe(198);
  });

  it('the box first application must equal the sum of the prices to the cent', () => {
    expect(buildWhatYouPay(input({ invoiceFirstVisit: 100 }))).toBeNull();
    expect(buildWhatYouPay(input({ invoiceFirstVisit: null }))).toBeNull();
  });

  it('a bundle that carries a setup fee is not a plan this box describes', () => {
    const both = model([['pest_control', 'Pest Control', 99, 4], ['lawn_care', 'Lawn Care', 78, 9]]);
    expect(buildWhatYouPay(input({ model: both, invoiceFirstVisit: 177 }))).toBeNull();
    expect(buildWhatYouPay(input({ model: both, fees: [], invoiceFirstVisit: 177 })).firstVisitTotal).toBe(177);
  });
});
