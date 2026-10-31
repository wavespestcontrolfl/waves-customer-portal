// @vitest-environment jsdom
// The customer estimate page for the mosquito misting SYSTEM plan (GATE_MOSQUITO_MISTING, owner wording 2026-10-30): its own
// hero, headline, one monthly cadence, no WaveGuard tier, the refill line, the install detail and its own Waves AI card. The
// barrier mosquito program keeps its copy.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EstimateViewPage from './EstimateViewPage';
import { setGlassDefault } from '../lib/estimate-glass-copy';

vi.mock('react-router-dom', () => ({ useParams: () => ({ token: 'misting-plan-token' }) }));
vi.mock('../lib/stripeLoader', () => ({ loadStripeSdk: vi.fn(async () => null) }));

const INSTALL_ITEM = {
  service: 'mosquito_misting_installation', label: 'Standard system (55-gallon) Installation', amount: 4345, detail: '21 nozzles · 2 risers',
  kind: 'charge', quoteRequired: false, termsScope: 'all',
};
const MONTHLY = {
  key: 'monthly', label: 'Monthly', serviceCategory: 'mosquito_misting', serviceTierKey: 'monthly', billingFrequencyKey: 'monthly',
  monthlyBase: 59, monthly: 59, annual: 708, perTreatment: 59, visitsPerYear: 12, billedPerApplication: true, manualDiscount: null,
  included: [{ key: 'mosquito_misting_service_plan', label: 'Mosquito Misting Service Plan', detail: '21 nozzles · 12 applications/yr · $59 per application', includedAtThisFrequency: true }],
  addOns: [], quoteRequired: false,
  perServiceTreatments: [{ service: 'mosquito_misting', label: 'Mosquito Misting Service Plan', perTreatment: 59, displayPrice: 59, visitsPerYear: 12, waveGuardDiscountEligible: false, termsScope: 'all' }],
};
const SECTION = {
  key: 'mosquito_misting', label: 'Mosquito Misting Service Plan', isRecurring: true, isPest: false,
  waveGuardTierEligible: false, memberKeys: ['mosquito_misting'], isWaveGuardQualifier: false, excludeFromPctDiscount: true,
  defaultFrequencyKey: 'monthly', frequencies: [MONTHLY], setupFee: null,
  oneTimeContribution: { items: [INSTALL_ITEM], subtotal: 4345 },
  intelligence: { metrics: [], chips: [] }, quoteRequired: false, termsScope: 'all',
  copy: { aiEyebrow: 'Waves AI', aiTitle: 'Priced from your system layout', aiBody: 'Your price is set by your system size and your nozzle and riser count.', askChips: [], priceWording: { dayLine: "That's about {amount}/day for this plan." } },
  refill: { label: 'Standard solution', perFill: 129, refillsPerYear: 4 },
  system: { tierLabel: 'Standard system (55-gallon)', nozzles: 21, risers: 2 },
};

const payload = (over = {}) => ({
  glassDefault: true,
  estimate: {
    customerFirstName: 'Dana', address: '77 Preview Lane', serviceCategory: 'mosquito_misting',
    acceptance: { mode: 'standard_slot_pick' }, membership: null, askToken: 'ask-token',
    intelligence: {
      eyebrow: 'Waves AI', title: 'Priced from your system layout', body: 'Your price is set by your system size and your nozzle and riser count.', satelliteUrl: null,
      metrics: [{ label: 'System', value: 'Standard, 55-gallon' }, { label: 'Nozzles', value: '21' }, { label: 'Risers', value: '2' }], signals: [],
    },
    defaultServiceMode: 'recurring', isOneTimeOnly: false, showOneTimeOption: false, billByInvoice: false,
    licenseNumber: 'JB000000', acceptedServiceMode: null, acceptedFrequencyKey: null, status: 'sent',
  },
  pricing: {
    waveGuardTier: 'Bronze',
    frequencies: [MONTHLY],
    services: [SECTION],
    oneTimeBreakdown: { items: [INSTALL_ITEM], total: 4345, quoteRequired: false, quoteRequiredItems: [] },
    combinedRecurring: { waveGuardTier: 'bronze', waveGuardTierLabel: 'Bronze', qualifyingCount: 0, waveGuardDiscountPct: 0, monthlySubtotal: 59, annualSubtotal: 708, discountableBase: 0, excludedBase: 59, savingsPerMonth: 0, manualDiscount: null },
    renderFlags: { showRecurringSummary: true, showWaveGuardTierUi: false, showWaveGuardPerks: false, showWaveGuardSetupFee: false },
    askChips: [], defaultServiceMode: 'recurring',
  },
  cta: { canAccept: true, terminalState: null, quoteRequired: false, reviewBeforeBooking: false },
  ...over,
});

const stubStorage = () => {
  const store = {};
  vi.stubGlobal('localStorage', {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  });
};
async function renderPage(data) {
  stubStorage();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => data })));
  render(<EstimateViewPage />);
  // The loading skeleton already renders an h1 (Header with no first name): wait for the loaded hero, which names the
  // fixture's customer, so the assertions read the estimate and never the skeleton.
  await screen.findByRole('heading', { level: 1, name: /Dana/ });
}
const text = () => document.body.textContent;

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }));
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  setGlassDefault(false);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('estimate page: mosquito misting system plan', () => {
  it('leads with the misting hero and the plan name, never the barrier mosquito copy', async () => {
    await renderPage(payload());
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Hello Dana, your misting system estimate is ready!');
    expect(text()).toContain('Your misting system plan');
    expect(text()).toContain('We install your misting system, then service it every month.');
    expect(screen.getByRole('heading', { level: 2, name: 'Mosquito Misting Service Plan' })).toBeInTheDocument();
    expect(text()).not.toContain('Mosquito Defense by Waves');
    expect(text()).not.toContain('mosquito-free backyard');
    expect(text()).not.toContain('Priced from your actual lot');
  });

  it('has exactly one monthly cadence at $59 per application: no ladder buttons, nothing recommended, no WaveGuard tier', async () => {
    await renderPage(payload());
    expect(screen.queryByRole('radio', { name: /Quarterly|Bi-monthly/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Quarterly|Bi-monthly/i })).toBeNull();
    expect(text()).not.toMatch(/recommended/i);
    expect(text()).toContain('$59.00');
    expect(text()).toContain('/ application');
    expect(text()).toContain('12 applications per year');
    expect(text()).not.toMatch(/WaveGuard/);
  });

  it('prints the refill line and the install detail with no product names', async () => {
    await renderPage(payload());
    expect(screen.getByTestId('misting-refill-line')).toHaveTextContent(
      'Refills, Standard solution: $129.00 each. Billed when we refill the tank. We expect about 4 a year.',
    );
    expect(text()).toContain('21 nozzles · 2 risers');
    expect(text()).not.toMatch(/Sector|Mist Ultra|permethrin|Riptide|Troika/i);
  });

  it('lists the misting bullets under "See everything included", not the barrier ones', async () => {
    await renderPage(payload());
    const toggle = screen.queryByRole('button', { name: /See everything included/i });
    if (toggle) fireEvent.click(toggle);
    expect(text()).toContain('Every month, we check the tank, the timer, the tubing and the spray from each nozzle.');
    expect(text()).toContain('Every third visit, we clean every nozzle and replace the filter.');
    expect(text()).toContain('Only Waves technicians refill the tank, and the cabinet stays locked.');
    expect(text()).not.toContain('Barrier treatment');
    expect(text()).not.toContain('fog-and-go');
  });

  it('shows the Waves AI card as the system layout: System, Nozzles and Risers tiles', async () => {
    await renderPage(payload());
    expect(text()).toContain('Priced from your system layout');
    expect(text()).toContain('Your price is set by your system size and your nozzle and riser count.');
    expect(text()).toContain('Standard, 55-gallon');
    expect(text()).toContain('Nozzles');
    expect(text()).toContain('Risers');
    expect(text()).not.toMatch(/Mosquito treatment area|Near water|Mosquito program/);
  });

  it('leaves the refill sentence about the yearly count out when none is expected', async () => {
    await renderPage(payload({ pricing: { ...payload().pricing, services: [{ ...SECTION, refill: { label: 'Natural solution', perFill: 219, refillsPerYear: 0 } }] } }));
    expect(screen.getByTestId('misting-refill-line')).toHaveTextContent('Refills, Natural solution: $219.00 each. Billed when we refill the tank.');
    expect(screen.getByTestId('misting-refill-line').textContent).not.toContain('We expect');
  });
});

describe('estimate page: barrier mosquito program is unchanged', () => {
  it('keeps the barrier hero and headline and no refill line', async () => {
    const barrier = payload({
      estimate: { ...payload().estimate, serviceCategory: 'mosquito', intelligence: { title: 'x', body: 'y', metrics: [], signals: [] } },
      pricing: {
        ...payload().pricing,
        services: [{
          ...SECTION, key: 'mosquito', label: 'Mosquito', waveGuardTierEligible: true, memberKeys: ['mosquito'], excludeFromPctDiscount: false, refill: undefined, system: undefined,
          oneTimeContribution: null,
          frequencies: [{ ...MONTHLY, serviceCategory: 'mosquito', perServiceTreatments: [{ service: 'mosquito', label: 'Mosquito', perTreatment: 63.75, displayPrice: 63.75, visitsPerYear: 12, waveGuardDiscountEligible: true }], monthly: 63.75, monthlyBase: 63.75, perTreatment: 63.75, annual: 765 }],
        }],
        oneTimeBreakdown: { items: [], total: 0, quoteRequired: false, quoteRequiredItems: [] },
      },
    });
    await renderPage(barrier);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Hello Dana, your mosquito-free backyard plan is ready!');
    expect(text()).toContain('Mosquito Defense by Waves — evenings outside, mosquito-free');
    expect(document.querySelector('[data-testid="misting-refill-line"]')).toBeNull();
    expect(text()).not.toContain('Mosquito Misting Service Plan');
  });
});
