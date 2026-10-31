// @vitest-environment jsdom
// Approve with no visit time picked, and re-tapping the current choice:
// 1. The approve buttons can't open the payment step without a time, so they
//    scroll to the times AND the booking section says why. The bare scroll
//    read as "it kicked me back to the beginning" and a customer phoned in.
//    Picking a time clears the banner, and a later slot reset never re-raises it.
// 2. Re-tapping the cadence or the plan mode already chosen is a no-op. Both
//    used to clear the picked time and refetch the slots.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import EstimateViewPage from './EstimateViewPage';
import { setGlassDefault } from '../lib/estimate-glass-copy';

vi.mock('react-router-dom', () => ({
  useParams: () => ({ token: 'pick-time-token' }),
}));

vi.mock('../lib/stripeLoader', () => ({
  loadStripeSdk: vi.fn(async () => null),
}));

const PICK_TIME = /Pick a visit time below to approve your plan/;

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

function frequency(key, label, monthly) {
  return {
    key,
    label,
    monthly,
    annual: monthly * 12,
    included: [{ key: 'service', label: 'Recurring service' }],
    addOns: [],
  };
}

function recurringPayload({ glass }) {
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
        frequencies: [frequency('quarterly', 'Quarterly', 50), frequency('bimonthly', 'Every other month', 60)],
        copy: { priceWording: {} },
      }],
      askChips: [],
      anchorOneTimePrice: 250,
      defaultServiceMode: 'recurring',
      renderFlags: {},
    },
    cta: {
      canAccept: true,
      terminalState: null,
      quoteRequired: false,
      quoteRequiredReason: null,
      reviewBeforeBooking: false,
      reviewReason: null,
    },
  };
}

// Future dates: the glass layout hides slots dated before today (glassSlotIsStale).
const ymdDaysAhead = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

function slotsPayload() {
  return {
    primary: [
      { slotId: 'slot-1', date: ymdDaysAhead(3), windowStart: '09:00', windowEnd: '11:00' },
      { slotId: 'slot-2', date: ymdDaysAhead(4), windowStart: '13:00', windowEnd: '15:00' },
    ],
    expander: [],
  };
}

function makeFetchMock({ glass = false } = {}) {
  return vi.fn(async (url) => {
    const u = String(url);
    if (u.includes('/available-slots')) return jsonResponse(slotsPayload());
    if (u.includes('/data')) return jsonResponse(recurringPayload({ glass }));
    return jsonResponse({});
  });
}

const slotFetches = (fetchMock) => fetchMock.mock.calls
  .filter(([url]) => String(url).includes('/available-slots')).length;

const pickedSlot = () => screen.queryAllByRole('button', { name: /^Choose / })
  .find((button) => button.getAttribute('aria-pressed') === 'true') || null;

// The page's first render is heavy; give the slot list (and each test) room on a loaded runner.
const TEST_TIMEOUT_MS = 15000;
const findSlots = () => screen.findAllByRole('button', { name: /^Choose / }, { timeout: 5000 });

// jsdom in this runner ships without a usable localStorage (same workaround
// as EstimateViewPage.review-error.test.jsx) — stub a functional one.
function stubLocalStorage(store = {}) {
  vi.stubGlobal('localStorage', {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  });
}

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.scrollTo = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // The /data load flips the module-global glass default; reset it per test.
  setGlassDefault(false);
});

describe('EstimateViewPage approve with no visit time picked', () => {
  it.each([
    ['classic', false, /^Get service today!/],
    ['glass', true, /^Approve my plan/],
  ])('%s layout: says to pick a time, and picking one clears it for good', async (_layout, glass, approveName) => {
    stubLocalStorage();
    vi.stubGlobal('fetch', makeFetchMock({ glass }));
    render(<EstimateViewPage />);

    const [firstSlot] = await findSlots();
    expect(screen.queryByText(PICK_TIME)).toBeNull();

    window.HTMLElement.prototype.scrollIntoView.mockClear();
    fireEvent.click(screen.getAllByRole('button', { name: approveName })[0]);
    const banner = await screen.findByText(PICK_TIME);
    expect(banner.closest('[role="status"]')).not.toBeNull();
    expect(screen.getByRole('link', { name: '(941) 297-5749' })).toHaveAttribute('href', 'tel:+19412975749');
    expect(window.HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();

    fireEvent.click(firstSlot);
    await waitFor(() => expect(screen.queryByText(PICK_TIME)).toBeNull());

    // A real cadence change clears the picked time; the banner stays down
    // until the customer taps approve again.
    fireEvent.click(screen.getByRole('button', { name: 'Every other month frequency' }));
    await waitFor(() => expect(pickedSlot()).toBeNull());
    expect(screen.queryByText(PICK_TIME)).toBeNull();
  }, TEST_TIMEOUT_MS);

  it('an approve tap with a time picked never shows the banner', async () => {
    stubLocalStorage();
    vi.stubGlobal('fetch', makeFetchMock());
    render(<EstimateViewPage />);

    const [firstSlot] = await findSlots();
    fireEvent.click(firstSlot);
    await screen.findByRole('button', { name: /Pay per application/i });

    // Classic layout: this CTA still scrolls to the booking section with a time picked.
    fireEvent.click(screen.getAllByRole('button', { name: /^Get service today!/ })[0]);
    expect(screen.queryByText(PICK_TIME)).toBeNull();
  }, TEST_TIMEOUT_MS);
});

describe('EstimateViewPage re-tapping the current choice', () => {
  it('keeps the picked time when the chosen cadence or plan mode is tapped again', async () => {
    stubLocalStorage();
    const fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    render(<EstimateViewPage />);

    const [firstSlot] = await findSlots();
    fireEvent.click(firstSlot);
    await screen.findByRole('button', { name: /Pay per application/i });
    expect(pickedSlot()).not.toBeNull();
    const fetchesBefore = slotFetches(fetchMock);

    fireEvent.click(screen.getByRole('button', { name: 'Quarterly frequency' }));
    fireEvent.click(screen.getByRole('button', { name: 'Recurring Pest Control' }));

    expect(pickedSlot()).not.toBeNull();
    expect(screen.getByRole('button', { name: /Pay per application/i })).toBeInTheDocument();
    expect(slotFetches(fetchMock)).toBe(fetchesBefore);

    // A different cadence still resets: the guard is "already chosen", not "any tap".
    fireEvent.click(screen.getByRole('button', { name: 'Every other month frequency' }));
    await waitFor(() => expect(slotFetches(fetchMock)).toBe(fetchesBefore + 1));
    expect(pickedSlot()).toBeNull();
    expect(screen.queryByRole('button', { name: /Pay per application/i })).toBeNull();
  }, TEST_TIMEOUT_MS);
});
