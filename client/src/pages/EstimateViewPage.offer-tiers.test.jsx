// @vitest-environment jsdom
// Good / Better / Best (GATE_ESTIMATE_OFFER_TIERS): on a tiered /data payload
// the plan picker replaces the [Recurring | One-time] toggle, Best swaps in the
// full-bundle sections, Good is the one-time visit, and only Best sends
// `offerTier` on the slot reads. An untiered estimate keeps the old toggle.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WavesShell from '../components/brand/WavesShell';
import { setGlassDefault } from '../lib/estimate-glass-copy';
import EstimateViewPage, { pricingViewForOfferTier } from './EstimateViewPage';
import pageSource from './EstimateViewPage.jsx?raw';

const routerState = vi.hoisted(() => ({ token: 'tiered-token' }));
vi.mock('react-router-dom', () => ({ useParams: () => ({ token: routerState.token }) }));
vi.mock('../lib/stripeLoader', () => ({ loadStripeSdk: vi.fn(async () => null) }));

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
  setGlassDefault(false);
  vi.unstubAllGlobals();
});

const pestRow = { service: 'pest_control', label: 'Pest Control (Quarterly)', perTreatment: 107, displayPrice: 96.3, visitsPerYear: 4 };
const lawnRow = { service: 'lawn_care', label: 'Lawn Care', perTreatment: 77, displayPrice: 69.3, visitsPerYear: 9 };

const pestOnlyFrequency = {
  key: 'quarterly', label: 'Quarterly', monthly: 32.1, annual: 385.2, perVisit: 107,
  perServiceTreatments: [pestRow], included: [{ key: 'service', label: 'Recurring service' }], addOns: [],
};
const bestPestFrequency = {
  key: 'quarterly', label: 'Quarterly', monthly: 32.1, annual: 385.2, perVisit: 107,
  included: [{ key: 'service', label: 'Recurring service' }], addOns: [],
};
const lawnFrequency = {
  key: 'enhanced', label: 'Enhanced lawn program', monthly: 51.98, annual: 623.76,
  included: [{ key: 'service', label: 'Lawn visits' }], addOns: [],
};
const bestFrequency = {
  key: 'quarterly', label: 'Quarterly', monthly: 84.08, annual: 1008.96, perVisit: 107,
  perServiceTreatments: [pestRow, lawnRow], included: [{ key: 'service', label: 'Recurring service' }], addOns: [],
};

const bestSections = [
  {
    key: 'pest_control', label: 'Pest Control', isRecurring: true, isPest: true,
    defaultFrequencyKey: 'quarterly', frequencies: [bestPestFrequency], copy: { priceWording: {} },
  },
  {
    key: 'lawn_care', label: 'Lawn Care', isRecurring: true, isPest: false,
    defaultFrequencyKey: 'enhanced', frequencies: [lawnFrequency], copy: { priceWording: {} },
  },
];

function tieredPayload({ tiers = true } = {}) {
  return {
    glassDefault: false,
    estimate: {
      customerFirstName: 'Casey',
      address: '1 Tiered Way',
      serviceCategory: 'pest_control',
      acceptance: { mode: 'standard_slot_pick' },
      defaultServiceMode: 'recurring',
      isOneTimeOnly: false,
      showOneTimeOption: true,
      billByInvoice: false,
      membership: null,
      intelligence: null,
      acceptedServiceMode: null,
      acceptedFrequencyKey: null,
      askToken: 'ask-token',
    },
    pricing: {
      // The bundle's own view is PEST-ONLY (what Better shows).
      frequencies: [pestOnlyFrequency],
      services: [{
        key: 'pest_control', label: 'Pest Control', isRecurring: true, isPest: true,
        defaultFrequencyKey: 'quarterly', frequencies: [pestOnlyFrequency], copy: { priceWording: {} },
      }],
      anchorOneTimePrice: 264,
      oneTimeBreakdown: { total: 264, items: [{ service: 'one_time_pest', label: 'One-Time Pest Control', amount: 264, kind: 'charge' }] },
      askChips: [],
      defaultServiceMode: 'recurring',
      renderFlags: {},
      ...(tiers ? {
        offerTierDefaultKey: 'better',
        offerTiers: [
          { key: 'good', label: 'One-time visit', serviceMode: 'one_time', services: ['one_time_pest'], oneTimeTotal: 264 },
          { key: 'better', label: 'Pest control plan', serviceMode: 'recurring', services: ['pest_control'], usesBundleFrequencies: true },
          {
            key: 'best',
            label: 'Pest control + companion plan',
            serviceMode: 'recurring',
            services: ['pest_control', 'lawn_care'],
            sections: bestSections,
            frequencies: [bestFrequency],
            combinedRecurring: { waveGuardTier: 'silver', waveGuardTierLabel: 'Silver', waveGuardDiscountPct: 0.1, monthlySubtotal: 84.08 },
            waveGuardTier: 'Silver',
          },
        ],
      } : {}),
    },
    cta: { canAccept: true, terminalState: null, quoteRequired: false, reviewBeforeBooking: false },
  };
}

function stubFetch(payload) {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const href = String(url);
    calls.push({ url: href, init });
    if (href.includes('/available-slots')) return { ok: true, status: 200, json: async () => ({ primary: [], expander: [] }) };
    if (href.includes('/data')) return { ok: true, status: 200, json: async () => payload };
    return { ok: true, status: 200, json: async () => ({}) };
  }));
  return calls;
}

const mount = () => render(<WavesShell><EstimateViewPage /></WavesShell>);
const slotCalls = (calls) => calls.filter((c) => c.url.includes('/available-slots'));
const lastSlotQuery = (calls) => new URL(slotCalls(calls).at(-1).url, 'http://x').searchParams;

describe('EstimateViewPage Good / Better / Best', () => {
  it('shows the plan picker instead of the one-time toggle, with Better selected', async () => {
    stubFetch(tieredPayload());
    mount();
    await screen.findByRole('radiogroup', { name: 'Choose your plan' });
    const [good, better, best] = screen.getAllByRole('radio');
    expect(better).toHaveAttribute('aria-checked', 'true');
    expect(good).toHaveTextContent('$264.00');
    expect(best).toHaveTextContent('$96.30 + $69.30');
    expect(screen.queryByRole('button', { name: 'Recurring Pest Control' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'One-Time Pest Control' })).not.toBeInTheDocument();
    // Better is the pest-only view: no lawn section.
    expect(screen.queryByText(/Lawn Care by Waves/)).not.toBeInTheDocument();
    expect(screen.queryByText('One-time services')).not.toBeInTheDocument();
  });

  it('choosing Best shows the lawn section and its slot reads carry offerTier=best; going back to Better drops it', async () => {
    const calls = stubFetch(tieredPayload());
    mount();
    await screen.findByRole('radiogroup', { name: 'Choose your plan' });
    await waitFor(() => expect(slotCalls(calls).length).toBeGreaterThan(0));
    // Better: the visit profile is today's.
    expect(lastSlotQuery(calls).get('offerTier')).toBeNull();

    fireEvent.click(screen.getAllByRole('radio')[2]);
    await waitFor(() => expect(screen.getByText(/Lawn Care by Waves/)).toBeInTheDocument());
    // The one-time breakdown is the ALTERNATE (Good) price, never an extra on top of the plan.
    expect(screen.queryByText('One-time services')).not.toBeInTheDocument();
    expect(screen.getAllByRole('radio')[2]).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => expect(lastSlotQuery(calls).get('offerTier')).toBe('best'));
    expect(lastSlotQuery(calls).get('serviceMode')).toBe('recurring');

    fireEvent.click(screen.getAllByRole('radio')[1]);
    await waitFor(() => expect(screen.queryByText(/Lawn Care by Waves/)).not.toBeInTheDocument());
    await waitFor(() => expect(lastSlotQuery(calls).get('offerTier')).toBeNull());
  });

  it('choosing Good switches to the one-time price card and one-time slot reads (no offerTier)', async () => {
    const calls = stubFetch(tieredPayload());
    mount();
    await screen.findByRole('radiogroup', { name: 'Choose your plan' });
    fireEvent.click(screen.getAllByRole('radio')[0]);
    await waitFor(() => expect(screen.getAllByRole('radio')[0]).toHaveAttribute('aria-checked', 'true'));
    await waitFor(() => expect(lastSlotQuery(calls).get('serviceMode')).toBe('one_time'));
    expect(lastSlotQuery(calls).get('offerTier')).toBeNull();
    // The plan section is gone; the one-time price card stands in for it.
    await waitFor(() => expect(screen.queryByText(/Pest Protection by Waves/)).not.toBeInTheDocument());
    expect(screen.getAllByText(/\$264\.00/).length).toBeGreaterThan(1);
  });

  it('without offerTiers the page renders the old toggle and no picker (regression guard)', async () => {
    stubFetch(tieredPayload({ tiers: false }));
    mount();
    await screen.findByRole('button', { name: 'Recurring Pest Control' });
    expect(screen.getByRole('button', { name: 'One-Time Pest Control' })).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });

  it('the Best view swaps sections, ladder and combined summary; every other tier reads the bundle as served', () => {
    const { pricing } = tieredPayload();
    expect(pricingViewForOfferTier(pricing, 'better')).toBe(pricing);
    expect(pricingViewForOfferTier(pricing, 'good')).toBe(pricing);
    const best = pricingViewForOfferTier(pricing, 'best');
    expect(best.services.map((s) => s.key)).toEqual(['pest_control', 'lawn_care']);
    expect(best.frequencies).toBe(pricing.offerTiers[2].frequencies);
    expect(best.combinedRecurring.monthlySubtotal).toBe(84.08);
    expect(best.waveGuardTier).toBe('Silver');
    expect(best.serviceCadenceCombos).toBeUndefined();
    // An untiered payload is returned untouched.
    const plain = tieredPayload({ tiers: false }).pricing;
    expect(pricingViewForOfferTier(plain, 'best')).toBe(plain);
  });

  // The accept and reserve handlers are far too heavy to drive from a mount,
  // so their wiring is pinned from source like the sibling accept pins.
  it('sends the tier on the accept and Best on the reserve, and never offers prepay on Best', () => {
    expect(pageSource).toMatch(/selectedTier: tiered \? offerTierKey : undefined,/);
    // A refused tier leaves review and reloads (accept 400 / 409, reserve 409):
    // retrying from review would resend the same tier forever.
    expect(pageSource.match(/body\.code === 'offer_tier_unavailable'/g)).toHaveLength(2);
    expect(pageSource).toMatch(/That plan option is no longer available\. We refreshed your estimate/);
    expect(pageSource).toMatch(/if \(serviceModeForAttempt !== 'one_time' && bestOfferActive\) \{\s*reservePayload\.offerTier = 'best';/);
    expect(pageSource).toMatch(/offerTier=\{bestOfferActive && serviceMode !== 'one_time' \? 'best' : null\}/);
    expect(pageSource).toMatch(/const annualPrepayEligibleEffective = \(\(\) => \{\s*\/\/ [^\n]*\n\s*if \(bestOfferActive\) return false;/);
  });
});
