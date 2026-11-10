// @vitest-environment jsdom
// Three stalls a new-customer walk found on the estimate page (2026-11-05):
// 1. Website flow: a time pick moved nothing, and the payment choices sit far
//    below a phone screen. A fresh customer pick now scrolls to them.
// 2. The success card's pay link opened inside the website dialog's small
//    frame. When embedded (embed=1) it opens in the full window.
// 3. The glass sticky book bar sat on the "Keep it" / "Never mind" button of a
//    service confirm. The bar hides while a confirm is open.
// Names and addresses are synthetic.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import EstimateViewPage, { SuccessCard } from './EstimateViewPage';
import { setGlassDefault } from '../lib/estimate-glass-copy';

vi.mock('react-router-dom', () => ({
  useParams: () => ({ token: 'walk-stalls-token' }),
}));

vi.mock('../lib/stripeLoader', () => ({
  loadStripeSdk: vi.fn(async () => null),
}));

const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });

const ymdDaysAhead = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

function payload({ glass = false, serviceOptOut } = {}) {
  return {
    glassDefault: glass,
    estimate: {
      customerFirstName: 'Rae',
      address: '19 Retry Road',
      serviceCategory: 'pest_control',
      acceptance: { mode: 'standard_slot_pick' },
      membership: null,
      intelligence: null,
      askToken: 'ask-token',
      defaultServiceMode: 'recurring',
      isOneTimeOnly: false,
      showOneTimeOption: true,
      billByInvoice: false,
      licenseNumber: 'JB000000',
      acceptedServiceMode: null,
      acceptedFrequencyKey: null,
    },
    pricing: {
      services: [{
        key: 'pest_control',
        label: 'Pest Control',
        isRecurring: true,
        isPest: true,
        frequencies: [{
          key: 'quarterly',
          label: 'Quarterly',
          monthly: 50,
          annual: 600,
          visitsPerYear: 4,
          perServiceTreatments: [{ service: 'pest_control', displayPrice: 50, visitsPerYear: 4, monthly: 17 }],
          included: [{ key: 'service', label: 'Recurring service' }],
          addOns: [],
        }],
        copy: { priceWording: {} },
      }],
      askChips: [],
      anchorOneTimePrice: 250,
      defaultServiceMode: 'recurring',
      renderFlags: {},
    },
    cta: { canAccept: true, terminalState: null, quoteRequired: false, reviewBeforeBooking: false },
    ...(serviceOptOut ? { serviceOptOut } : {}),
  };
}

const slots = () => ({
  primary: [
    { slotId: 'slot-1', date: ymdDaysAhead(3), windowStart: '09:00', windowEnd: '11:00' },
    { slotId: 'slot-2', date: ymdDaysAhead(4), windowStart: '13:00', windowEnd: '15:00' },
  ],
  expander: [],
});

function stubFetch(body, extra = () => null) {
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const u = String(url);
    const custom = extra(u, init);
    if (custom) return custom;
    if (u.includes('/available-slots')) return jsonResponse(slots());
    if (u.includes('/data')) return jsonResponse(body);
    return jsonResponse({});
  }));
}

function stubLocalStorage() {
  const store = {};
  vi.stubGlobal('localStorage', {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  });
}

const setQuery = (query) => window.history.pushState({}, '', query ? `/?${query}` : '/');
const findSlots = () => screen.findAllByRole('button', { name: /^Choose / }, { timeout: 5000 });
const scrolledIds = [];
// The website flow starts on the quote; its Book button opens the times.
async function openWebsiteSchedule() {
  fireEvent.click(await screen.findByRole('button', { name: /^Book My Service/ }, { timeout: 5000 }));
  return findSlots();
}
const TEST_TIMEOUT_MS = 15000;

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn(function recordScroll() { scrolledIds.push(this.id); });
  window.scrollTo = vi.fn();
  // Run animation frames at once so the post-pick scroll is observable.
  window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setGlassDefault(false);
  setQuery('');
  scrolledIds.length = 0;
});

describe('website flow: a time pick scrolls to the payment choices', () => {
  it('scrolls to the payment section after a customer pick', async () => {
    stubLocalStorage();
    setQuery('website=1');
    stubFetch(payload());
    render(<EstimateViewPage />);
    const [firstSlot] = await openWebsiteSchedule();
    scrolledIds.length = 0;
    fireEvent.click(firstSlot);
    await screen.findByRole('button', { name: /Pay per application/i });
    await waitFor(() => expect(scrolledIds).toContain('estimate-payment-section'));
  }, TEST_TIMEOUT_MS);

  it('does not scroll to payment on the office page', async () => {
    stubLocalStorage();
    stubFetch(payload());
    render(<EstimateViewPage />);
    const [firstSlot] = await findSlots();
    scrolledIds.length = 0;
    fireEvent.click(firstSlot);
    await screen.findByRole('button', { name: /Pay per application/i });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(scrolledIds).not.toContain('estimate-payment-section');
  }, TEST_TIMEOUT_MS);

  it('does not scroll when the page loads with no pick (nothing restored counts as a pick)', async () => {
    stubLocalStorage();
    setQuery('website=1');
    stubFetch(payload());
    render(<EstimateViewPage />);
    await openWebsiteSchedule();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(scrolledIds).not.toContain('estimate-payment-section');
  }, TEST_TIMEOUT_MS);
});

describe('success card pay link', () => {
  const acceptResult = { success: true, nextStep: 'pay_invoice', invoicePayUrl: 'https://example.test/pay/abc', reservationCommitted: true };

  it('opens in the full window when the page runs embedded', () => {
    setQuery('website=1&embed=1');
    render(<SuccessCard acceptResult={acceptResult} />);
    expect(screen.getByRole('link', { name: 'Pay now and save card' })).toHaveAttribute('target', '_top');
  });

  it('keeps the plain link when not embedded', () => {
    setQuery('website=1');
    render(<SuccessCard acceptResult={acceptResult} />);
    expect(screen.getByRole('link', { name: 'Pay now and save card' })).not.toHaveAttribute('target');
  });
});

describe('sticky book bar and the service confirm', () => {
  it('hides while a confirm is open and returns when it closes', async () => {
    stubLocalStorage();
    stubFetch(
      payload({
        glass: true,
        serviceOptOut: { removedKeys: ['lawn_care'], removedLabels: ['Lawn Care'] },
      }),
      (u, init) => (u.includes('/service-opt-out') && init?.method === 'PUT'
        ? jsonResponse({ previewBasis: 'basis-1', previous: { onetimeTotal: 100 }, next: { onetimeTotal: 150 }, disclosures: [] })
        : null),
    );
    render(<EstimateViewPage />);
    await findSlots();
    const stickyBar = () => document.querySelector('.gc-mbb');
    expect(stickyBar()).not.toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: 'Add it back' }));
    await screen.findByRole('button', { name: 'Never mind' });
    expect(stickyBar()).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Never mind' }));
    await waitFor(() => expect(stickyBar()).not.toBeNull());
  }, TEST_TIMEOUT_MS);
});
