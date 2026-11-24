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
import WhatYouPayBox, { whatYouPayForSelection } from '../components/estimate/WhatYouPayBox';
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

const PEST_PAYLOAD = {
  selection: { frequency: 'quarterly', serviceCadences: null },
  lines: [{ key: 'pest_control', label: 'Pest Control', perApplication: 99, applicationsPerYear: 4 }],
  setupFee: 99,
  setupWaivedWithPrepay: true,
  firstVisitTotal: 198,
};
const BUNDLE_PAYLOAD = {
  selection: { frequency: 'quarterly', serviceCadences: null },
  lines: [
    { key: 'pest_control', label: 'Pest Control', perApplication: 99, applicationsPerYear: 4 },
    { key: 'lawn_care', label: 'Lawn Care', perApplication: 78, applicationsPerYear: 9 },
  ],
  setupFee: null,
  setupWaivedWithPrepay: false,
  firstVisitTotal: 177,
};
const LAWN_PAYLOAD = {
  selection: { frequency: 'standard', serviceCadences: null },
  lines: [{ key: 'lawn_care', label: 'Lawn Care', perApplication: 78, applicationsPerYear: 9 }],
  setupFee: null,
  setupWaivedWithPrepay: false,
  firstVisitTotal: 78,
};
const withPayload = (payload, whatYouPay) => ({ ...payload, whatYouPay });

describe('WhatYouPayBox renders the server payload as given', () => {
  const renderBox = (payload) => render(<WhatYouPayBox box={payload} />).container;

  it('pest only with the setup fee: first visit itemised, each application after, the fee sentence and its waiver clause', () => {
    const t = renderBox(PEST_PAYLOAD).textContent;
    expect(t).toContain('What you pay and when');
    expect(t).toContain('Pest Control$99.00');
    expect(t).toContain('Setup fee$99.00');
    expect(t).toContain('First visit total$198.00');
    expect(t).toContain('Each application after that');
    expect(t).toContain('4 applications a year, counting the first');
    expect(t).toContain('This plan has a one-time $99.00 setup fee. It is waived if you prepay the year.');
  });

  it('the waiver clause only when the server says the fee is waivable', () => {
    const t = renderBox({ ...PEST_PAYLOAD, setupWaivedWithPrepay: false }).textContent;
    expect(t).toContain('This plan has a one-time $99.00 setup fee.');
    expect(t).not.toMatch(/waived/i);
  });

  it('a bundle: each service itemised and the server first visit total, no setup line', () => {
    const t = renderBox(BUNDLE_PAYLOAD).textContent;
    expect(t).toContain('Pest Control$99.00');
    expect(t).toContain('Lawn Care$78.00');
    expect(t).toContain('First visit total$177.00');
    expect(t).toContain('4 applications a year, counting the first');
    expect(t).toContain('9 applications a year, counting the first');
    expect(t).not.toMatch(/setup/i);
  });

  it('lawn only: the price and the count, with no total row and no setup', () => {
    const t = renderBox(LAWN_PAYLOAD).textContent;
    expect(t).toContain('Lawn Care$78.00');
    expect(t).toContain('9 applications a year, counting the first');
    expect(t).not.toMatch(/first visit total|setup/i);
  });

  it('one application a year reads "once a year"', () => {
    const lines = [{ key: 'pest_control', label: 'Pest Control', perApplication: 120, applicationsPerYear: 1 }];
    expect(renderBox({ ...LAWN_PAYLOAD, lines }).textContent).toContain('once a year');
  });

  it('prints no plan total, no due-today or prepay offer, no per-visit unit and no monthly figure', () => {
    for (const payload of [PEST_PAYLOAD, BUNDLE_PAYLOAD, LAWN_PAYLOAD]) {
      const t = renderBox(payload).textContent;
      expect(t).not.toMatch(/year total|first year|due today|exact total|visits? a year|each visit|\/\s?mo|a month|about/i);
    }
  });

  it('renders nothing for a null payload', () => {
    expect(renderBox(null).querySelector('[data-what-you-pay]')).toBeNull();
  });
});

describe('whatYouPayForSelection: only while the page is on the selection the server priced', () => {
  it('the same frequency key and cadences: the payload as given', () => {
    expect(whatYouPayForSelection(PEST_PAYLOAD, { frequency: 'quarterly' })).toBe(PEST_PAYLOAD);
    const combo = { ...BUNDLE_PAYLOAD, selection: { frequency: 'quarterly', serviceCadences: { lawn_care: 'standard', tree_shrub: 'light' } } };
    expect(whatYouPayForSelection(combo, { frequency: 'quarterly', serviceCadences: { tree_shrub: 'light', lawn_care: 'standard' } })).toBe(combo);
  });

  it.each([
    ['another frequency', { frequency: 'monthly' }],
    ['no frequency', { frequency: null }],
    ['a cadence the server did not price', { frequency: 'quarterly', serviceCadences: { lawn_care: 'standard' } }],
  ])('%s: null', (_label, selection) => {
    expect(whatYouPayForSelection(PEST_PAYLOAD, selection)).toBeNull();
  });

  it('a different cadence map: null', () => {
    const combo = { ...BUNDLE_PAYLOAD, selection: { frequency: 'quarterly', serviceCadences: { lawn_care: 'standard' } } };
    expect(whatYouPayForSelection(combo, { frequency: 'quarterly', serviceCadences: { lawn_care: 'monthly' } })).toBeNull();
    expect(whatYouPayForSelection(combo, { frequency: 'quarterly', serviceCadences: null })).toBeNull();
  });

  it('no payload, or no lines: null', () => {
    expect(whatYouPayForSelection(null, { frequency: 'quarterly' })).toBeNull();
    expect(whatYouPayForSelection({ ...PEST_PAYLOAD, lines: [] }, { frequency: 'quarterly' })).toBeNull();
    expect(whatYouPayForSelection(undefined)).toBeNull();
  });
});

describe('estimate page: what you pay and when', () => {
  it('pest only: shows the server payload inside the price section, next to the existing first-visit line', async () => {
    const { container } = await renderPage(withPayload(pestOnly(), PEST_PAYLOAD));
    await waitFor(() => expect(box(container)).not.toBeNull());
    expect(text(container)).toContain('First visit total$198.00');
    expect(container.querySelector('#estimate-price-section').contains(box(container))).toBe(true);
    await waitFor(() => expect(container.querySelector('[data-first-visit-line]')).not.toBeNull());
    expect(container.querySelector('[data-first-visit-line]').textContent).toContain('$198.00');
  });

  it('bundle and lawn only: show the server payload', async () => {
    const first = await renderPage(withPayload(bundle(), BUNDLE_PAYLOAD));
    await waitFor(() => expect(box(first.container)).not.toBeNull());
    expect(text(first.container)).toContain('First visit total$177.00');
    cleanup();
    const second = await renderPage(withPayload(lawnOnly(), LAWN_PAYLOAD));
    await waitFor(() => expect(box(second.container)).not.toBeNull());
    expect(text(second.container)).toContain('Lawn Care$78.00');
  });

  it.each([
    ['no whatYouPay in /data (the server could not resolve it)', undefined],
    ['a null whatYouPay', null],
    ['a payload priced for another selection', { ...PEST_PAYLOAD, selection: { frequency: 'monthly', serviceCadences: null } }],
  ])('%s: no box', async (_label, payload) => {
    const { container } = await renderPage(withPayload(pestOnly(), payload));
    await waitFor(() => expect(container.querySelector('[data-price-follow-ups]')).not.toBeNull());
    expect(box(container)).toBeNull();
  });

  it('a code the page can see applied hides the box', async () => {
    const payload = withPayload(pestOnly(), PEST_PAYLOAD);
    payload.promoCode = { canEnter: false, applied: { code: 'NEIGHBOR', credited: false } };
    const { container } = await renderPage(payload);
    await waitFor(() => expect(container.querySelector('[data-price-follow-ups]')).not.toBeNull());
    expect(box(container)).toBeNull();
  });
});
