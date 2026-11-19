// @vitest-environment jsdom
// The 15-minute time hold ran out while the customer was confirming (owner case
// 2026-09-11, a card saved and no visit booked). When the accept answers that the
// hold expired, the page holds the SAME time again if it is still free and asks
// for one more tap; if the time is gone it says so in plain words and reopens the
// time list. The customer never lands on a "done" screen without a booked visit.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import EstimateViewPage, { SlotIssueBanner, holdSameTimeAgain } from './EstimateViewPage';

vi.mock('react-router-dom', () => ({
  useParams: () => ({ token: 'rehold-token' }),
}));

vi.mock('../lib/stripeLoader', () => ({
  loadStripeSdk: vi.fn(async () => null),
}));

const jsonResponse = (body, { ok = true, status = 200 } = {}) => ({ ok, status, json: async () => body });

function recurringPayload() {
  return {
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
    cta: { canAccept: true, terminalState: null, quoteRequired: false, quoteRequiredReason: null, reviewBeforeBooking: false, reviewReason: null },
  };
}

const slotsPayload = () => ({
  primary: [
    { slotId: 'slot-1', date: '2026-07-15', windowStart: '09:00', windowEnd: '11:00' },
    { slotId: 'slot-2', date: '2026-07-16', windowStart: '13:00', windowEnd: '15:00' },
  ],
  expander: [],
});

const inFifteenMinutes = () => new Date(Date.now() + 15 * 60000).toISOString();
const EXPIRED_409 = () => jsonResponse(
  { error: 'Your time-slot hold expired — pick a time again to finish signing up', code: 'RESERVATION_EXPIRED' },
  { ok: false, status: 409 },
);

// reserveImpl(n) answers the n-th POST /reserve (1 = the first pick); acceptImpl(n) the n-th PUT /accept.
function makeFetchMock({ reserveImpl, acceptImpl }) {
  let reserves = 0;
  let accepts = 0;
  return vi.fn(async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/available-slots')) return jsonResponse(slotsPayload());
    if (/\/reserve$/.test(u) && init.method === 'POST') { reserves += 1; return reserveImpl(reserves); }
    if (u.includes('/reserve/') && init.method === 'DELETE') return jsonResponse({}, { ok: true, status: 200 });
    if (u.includes('/extend')) return jsonResponse({ expiresAt: inFifteenMinutes() });
    if (u.includes('/accept')) { accepts += 1; return acceptImpl(accepts); }
    if (u.includes('/data')) return jsonResponse(recurringPayload());
    return jsonResponse({});
  });
}

const reserveCalls = (fetchMock) => fetchMock.mock.calls
  .filter(([url, init]) => /\/reserve$/.test(String(url)) && init?.method === 'POST');

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
});

// The page's first render is heavy; give each step room on a loaded runner.
const SLOW = { timeout: 5000 };
const TEST_TIMEOUT_MS = 20000;

async function pickTimeAndConfirm() {
  const slotButtons = await screen.findAllByRole('button', { name: /^Choose / }, SLOW);
  fireEvent.click(slotButtons[0]);
  fireEvent.click(await screen.findByRole('button', { name: /Pay per application/i }, SLOW));
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm booking' }, SLOW));
}

const REHELD = /Your time ran out, so we held it again/;

describe('the accept says the hold expired', () => {
  it('holds the same time again and asks for one more tap, with no done screen', async () => {
    stubLocalStorage();
    const fetchMock = makeFetchMock({
      reserveImpl: (n) => jsonResponse({ scheduledServiceId: `ss-${n}`, expiresAt: inFifteenMinutes() }),
      acceptImpl: (n) => (n === 1 ? EXPIRED_409() : jsonResponse({ success: true })),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<EstimateViewPage />);

    await pickTimeAndConfirm();

    // The same time is held again, and the page says nothing is booked yet.
    const banner = await screen.findByText(REHELD, {}, SLOW);
    expect(banner.closest('[role="alert"]')).not.toBeNull();
    expect(screen.getByText(/Your visit is not booked yet/)).toBeInTheDocument();
    const reserves = reserveCalls(fetchMock);
    expect(reserves).toHaveLength(2);
    expect(JSON.parse(reserves[1][1].body).slotId).toBe(JSON.parse(reserves[0][1].body).slotId);
    // Still on the confirm step, not on a success card, and no time picker restart.
    expect(screen.getByRole('button', { name: 'Confirm booking' })).toBeInTheDocument();
    expect(screen.queryByText(/pick a time/i)).toBeNull();

    // The second tap books it, and the notice goes away with the review step.
    fireEvent.click(screen.getByRole('button', { name: 'Confirm booking' }));
    await waitFor(() => expect(screen.queryByText(REHELD)).toBeNull(), SLOW);
    const accepts = fetchMock.mock.calls.filter(([url]) => String(url).includes('/accept'));
    expect(accepts).toHaveLength(2);
  }, TEST_TIMEOUT_MS);

  it('says the time was taken, in plain words, and reopens the time list when the time is gone', async () => {
    stubLocalStorage();
    const fetchMock = makeFetchMock({
      reserveImpl: (n) => (n === 1
        ? jsonResponse({ scheduledServiceId: 'ss-1', expiresAt: inFifteenMinutes() })
        : jsonResponse({ error: 'slot no longer available' }, { ok: false, status: 409 })),
      acceptImpl: () => EXPIRED_409(),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<EstimateViewPage />);

    await pickTimeAndConfirm();

    expect(await screen.findByText('That time was just taken. Pick another time below.', {}, SLOW)).toBeInTheDocument();
    expect(screen.queryByText(REHELD)).toBeNull();
    // The picker is back, with the list read again.
    expect((await screen.findAllByRole('button', { name: /^Choose / }, SLOW)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Confirm booking' })).toBeNull();
  }, TEST_TIMEOUT_MS);

  it('falls back to the plain expiry recovery when the time cannot be held again', async () => {
    stubLocalStorage();
    const fetchMock = makeFetchMock({
      reserveImpl: (n) => (n === 1
        ? jsonResponse({ scheduledServiceId: 'ss-1', expiresAt: inFifteenMinutes() })
        : jsonResponse({ error: 'boom' }, { ok: false, status: 500 })),
      acceptImpl: () => EXPIRED_409(),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<EstimateViewPage />);

    await pickTimeAndConfirm();

    expect(await screen.findByText(/Your held time ran out and nothing was booked/, {}, SLOW)).toBeInTheDocument();
    expect(screen.queryByText(REHELD)).toBeNull();
  }, TEST_TIMEOUT_MS);
});

describe('holdSameTimeAgain', () => {
  const base = { token: 'tok', slotId: 'slot-1', serviceMode: 'recurring', selectedFrequency: { key: 'quarterly' }, serviceCadences: { lawn: 'standard' } };

  it('sends the same reserve body the first pick sent', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ scheduledServiceId: 'ss-2', expiresAt: 'soon' }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await holdSameTimeAgain(base);
    expect(out).toEqual({ held: { scheduledServiceId: 'ss-2', expiresAt: 'soon' } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/public\/estimates\/tok\/reserve$/);
    expect(JSON.parse(init.body)).toEqual({ slotId: 'slot-1', serviceMode: 'recurring', selectedFrequency: { key: 'quarterly' }, serviceCadences: { lawn: 'standard' } });
  });

  it('leaves the cadence out of a one-time reserve', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ scheduledServiceId: 'ss-2', expiresAt: 'soon' }));
    vi.stubGlobal('fetch', fetchMock);
    await holdSameTimeAgain({ ...base, serviceMode: 'one_time' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ slotId: 'slot-1', serviceMode: 'one_time' });
  });

  it.each([
    ['a taken time', () => jsonResponse({ error: 'slot no longer available' }, { ok: false, status: 409 }), { taken: true }],
    ['an estimate the office parked', () => jsonResponse({ code: 'ACCEPT_NEEDS_OFFICE_REVIEW', error: 'x' }, { ok: false, status: 409 }), { review: { code: 'ACCEPT_NEEDS_OFFICE_REVIEW', error: 'x' } }],
    ['another 409', () => jsonResponse({ error: 'something else' }, { ok: false, status: 409 }), { failed: true }],
    ['a server error', () => jsonResponse({}, { ok: false, status: 500 }), { failed: true }],
    ['a hold with no id', () => jsonResponse({}), { failed: true }],
  ])('answers %s', async (_label, answer, expected) => {
    vi.stubGlobal('fetch', vi.fn(async () => answer()));
    expect(await holdSameTimeAgain(base)).toEqual(expected);
  });

  it('never throws on a network error, and sends nothing without a slot', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await holdSameTimeAgain(base)).toEqual({ failed: true });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await holdSameTimeAgain({ ...base, slotId: '' })).toEqual({ failed: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('SlotIssueBanner copy', () => {
  it('says the hold ran out and nothing was booked', () => {
    render(<SlotIssueBanner kind="expired" />);
    expect(screen.getByText('Your held time ran out and nothing was booked. Pick a time below to finish signing up.')).toBeInTheDocument();
  });

  it('the held-again notice has no refresh button', () => {
    render(<SlotIssueBanner kind="reheld" onRetry={() => {}} />);
    expect(screen.getByText(REHELD)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /refresh/i })).toBeNull();
  });
});
