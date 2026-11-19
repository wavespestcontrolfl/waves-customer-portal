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

// The website quote offers its Book button only when every price row has an amount.
function websitePayload() {
  const payload = recurringPayload();
  payload.pricing.services[0].frequencies[0] = {
    ...payload.pricing.services[0].frequencies[0],
    visitsPerYear: 4,
    perServiceTreatments: [{ service: 'pest_control', displayPrice: 50, visitsPerYear: 4, monthly: 17 }],
  };
  return payload;
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
function makeFetchMock({ reserveImpl, acceptImpl, data = recurringPayload, slotsImpl = () => jsonResponse(slotsPayload()) }) {
  let reserves = 0;
  let accepts = 0;
  return vi.fn(async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/available-slots')) return slotsImpl(u);
    if (/\/reserve$/.test(u) && init.method === 'POST') { reserves += 1; return reserveImpl(reserves); }
    if (u.includes('/reserve/') && init.method === 'DELETE') return jsonResponse({}, { ok: true, status: 200 });
    if (u.includes('/extend')) return jsonResponse({ expiresAt: inFifteenMinutes() });
    if (u.includes('/accept')) { accepts += 1; return acceptImpl(accepts); }
    if (u.includes('/data')) return jsonResponse(data());
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

const setQuery = (query) => window.history.pushState({}, '', query ? `/?${query}` : '/');

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setQuery('');
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

// Real slot ids (date_start_technician, then the signed-offer segments): the re-hold reads the picked day from them.
const OLD_ID = '2026-07-15_09-00_tech-1.1767210000000.90.oldsig';
const FRESH_ID = '2026-07-15_09-00_tech-1.1767216000000.90.freshsig';
const slotAt = (slotId) => ({ slotId, date: '2026-07-15', windowStart: '09:00', windowEnd: '11:00' });
// The picker's default list offers OLD_ID; the picked-day read (?date=) answers dayList.
const pickerThenDay = (dayList) => (u) => (u.includes('date=2026-07-15') ? dayList() : jsonResponse({ primary: [slotAt(OLD_ID)], expander: [] }));
const LAPSED_409 = () => jsonResponse({ error: 'slot no longer available', availableSlots: { primary: [], expander: [] } }, { ok: false, status: 409 });

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

    // The same time is held again, and the page says nothing is booked yet, inside the review anchor the
    // review-entry scroll brings into view.
    const banner = await screen.findByText(REHELD, {}, SLOW);
    expect(banner.closest('[role="alert"]')).not.toBeNull();
    expect(banner.closest('#estimate-review-section')).not.toBeNull();
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

  it('the website checkout shows the same notice on its review step', async () => {
    stubLocalStorage();
    setQuery('website=1');
    const fetchMock = makeFetchMock({
      reserveImpl: (n) => jsonResponse({ scheduledServiceId: `ss-${n}`, expiresAt: inFifteenMinutes() }),
      acceptImpl: (n) => (n === 1 ? EXPIRED_409() : jsonResponse({ success: true })),
      data: websitePayload,
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<EstimateViewPage />);

    // The website flow starts on the quote; its Book button opens the times.
    fireEvent.click(await screen.findByRole('button', { name: /^Book My Service/ }, SLOW));
    await pickTimeAndConfirm();

    const banner = await screen.findByText(REHELD, {}, SLOW);
    expect(banner.closest('[role="alert"]')).not.toBeNull();
    expect(banner.closest('#estimate-review-section')).not.toBeNull();
    expect(screen.getByText(/Your visit is not booked yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm booking' })).toBeInTheDocument();
    expect(reserveCalls(fetchMock)).toHaveLength(2);
  }, TEST_TIMEOUT_MS);

  it('an offer that lapsed while the time is still free: holds it with the fresh signed id from the picked day', async () => {
    stubLocalStorage();
    const fetchMock = makeFetchMock({
      reserveImpl: (n) => (n === 2 ? LAPSED_409() : jsonResponse({ scheduledServiceId: `ss-${n}`, expiresAt: inFifteenMinutes() })),
      acceptImpl: (n) => (n === 1 ? EXPIRED_409() : jsonResponse({ success: true })),
      slotsImpl: pickerThenDay(() => jsonResponse({ primary: [slotAt(FRESH_ID)], expander: [] })),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<EstimateViewPage />);

    await pickTimeAndConfirm();

    expect(await screen.findByText(REHELD, {}, SLOW)).toBeInTheDocument();
    expect(reserveCalls(fetchMock).map(([, init]) => JSON.parse(init.body).slotId)).toEqual([OLD_ID, OLD_ID, FRESH_ID]);
    expect(screen.queryByText(/just taken/i)).toBeNull();
  }, TEST_TIMEOUT_MS);

  it('a fresh offer refused too still gets the plain expiry copy (a refusal is no proof the time is gone), and the time list reopens', async () => {
    stubLocalStorage();
    const fetchMock = makeFetchMock({
      reserveImpl: (n) => (n === 1 ? jsonResponse({ scheduledServiceId: 'ss-1', expiresAt: inFifteenMinutes() }) : LAPSED_409()),
      acceptImpl: () => EXPIRED_409(),
      // The picked day still lists 9:00 with a fresh offer, and reserving that one is refused too: the proof it is gone.
      slotsImpl: pickerThenDay(() => jsonResponse({ primary: [slotAt(FRESH_ID)], expander: [] })),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<EstimateViewPage />);

    await pickTimeAndConfirm();

    expect(await screen.findByText(/Your held time ran out and nothing was booked/, {}, SLOW)).toBeInTheDocument();
    expect(screen.queryByText(/just taken/i)).toBeNull();
    expect(screen.queryByText(REHELD)).toBeNull();
    expect(reserveCalls(fetchMock).map(([, init]) => JSON.parse(init.body).slotId)).toEqual([OLD_ID, OLD_ID, FRESH_ID]);
    // The picker is back, with the list read again.
    expect((await screen.findAllByRole('button', { name: /^Choose / }, SLOW)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Confirm booking' })).toBeNull();
  }, TEST_TIMEOUT_MS);

  it('a picked day that does not list the time is no proof it is gone: the plain expiry copy, never "taken"', async () => {
    stubLocalStorage();
    const fetchMock = makeFetchMock({
      reserveImpl: (n) => (n === 1 ? jsonResponse({ scheduledServiceId: 'ss-1', expiresAt: inFifteenMinutes() }) : LAPSED_409()),
      acceptImpl: () => EXPIRED_409(),
      // A ranked, capped day list that leaves out 9:00.
      slotsImpl: pickerThenDay(() => jsonResponse({ primary: [{ ...slotAt('2026-07-15_13-00_tech-1.1767216000000.90.x'), windowStart: '13:00', windowEnd: '15:00' }], expander: [] })),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<EstimateViewPage />);

    await pickTimeAndConfirm();

    expect(await screen.findByText(/Your held time ran out and nothing was booked/, {}, SLOW)).toBeInTheDocument();
    expect(screen.queryByText(/just taken/i)).toBeNull();
    expect(reserveCalls(fetchMock)).toHaveLength(2);
  }, TEST_TIMEOUT_MS);

  it('another tab holds a newer time: the server keeps it, and the page shows that hold with a notice', async () => {
    stubLocalStorage();
    let otherTabHeld = false;
    // After the refusal, /data offers the other tab's hold (a reload lands on the estimate's live hold).
    const heldElsewhere = () => {
      const payload = recurringPayload();
      payload.estimate = { ...payload.estimate, acceptance: { mode: 'existing_appointment', appointment: {
        id: 'ss-other-tab', scheduledDate: '2026-07-16', windowStart: '13:00', windowEnd: '15:00', windowDisplay: '1:00 PM - 3:00 PM',
        serviceType: 'Pest Control', status: 'pending', isHold: true, reservationExpiresAt: inFifteenMinutes(),
      } } };
      return payload;
    };
    const fetchMock = makeFetchMock({
      reserveImpl: (n) => {
        if (n === 1) return jsonResponse({ scheduledServiceId: 'ss-1', expiresAt: inFifteenMinutes() });
        otherTabHeld = true;
        return jsonResponse({ error: 'another time is held for this estimate', code: 'OTHER_LIVE_HOLD' }, { ok: false, status: 409 });
      },
      acceptImpl: () => EXPIRED_409(),
      data: () => (otherTabHeld ? heldElsewhere() : recurringPayload()),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<EstimateViewPage />);

    await pickTimeAndConfirm();

    expect(await screen.findByText(/a different time is held for you/, {}, SLOW)).toBeInTheDocument();
    expect(await screen.findByText('Time held for you', {}, SLOW)).toBeInTheDocument();
    expect(screen.queryByText(/Pick a time below/)).toBeNull();
    expect(screen.queryByText(REHELD)).toBeNull();
    expect(screen.queryByText(/just taken/i)).toBeNull();
    // Only the automatic re-hold says so; the customer's own pick is an ordinary reserve.
    expect(reserveCalls(fetchMock).map(([, init]) => JSON.parse(init.body).rehold)).toEqual([undefined, true]);
    // The page released only its own expired hold, never the other tab's.
    const released = fetchMock.mock.calls.filter(([url, init]) => String(url).includes('/reserve/') && init?.method === 'DELETE').map(([url]) => String(url));
    expect(released.some((u) => u.includes('ss-other-tab'))).toBe(false);
  }, TEST_TIMEOUT_MS);

  it('never says "taken" when the fresh availability cannot be read: the plain expiry copy', async () => {
    stubLocalStorage();
    const fetchMock = makeFetchMock({
      reserveImpl: (n) => (n === 1 ? jsonResponse({ scheduledServiceId: 'ss-1', expiresAt: inFifteenMinutes() }) : LAPSED_409()),
      acceptImpl: () => EXPIRED_409(),
      // The picked-day read fails.
      slotsImpl: pickerThenDay(() => jsonResponse({}, { ok: false, status: 500 })),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<EstimateViewPage />);

    await pickTimeAndConfirm();

    expect(await screen.findByText(/Your held time ran out and nothing was booked/, {}, SLOW)).toBeInTheDocument();
    expect(screen.queryByText(/just taken/i)).toBeNull();
  }, TEST_TIMEOUT_MS);

  it('an estimate staff reshaped meanwhile reloads the page, with no "pick a time" or held-again copy', async () => {
    stubLocalStorage();
    const fetchMock = makeFetchMock({
      reserveImpl: (n) => (n === 1
        ? jsonResponse({ scheduledServiceId: 'ss-1', expiresAt: inFifteenMinutes() })
        : jsonResponse({ error: 'Commercial service is scheduled by our team — no self-booking.', commercialManualScheduling: true }, { ok: false, status: 409 })),
      acceptImpl: () => EXPIRED_409(),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<EstimateViewPage />);

    await pickTimeAndConfirm();

    const dataReads = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/data')).length;
    await waitFor(() => expect(dataReads()).toBeGreaterThan(1), SLOW);
    expect(screen.queryByText(REHELD)).toBeNull();
    expect(screen.queryByText(/Your held time ran out/)).toBeNull();
    expect(screen.queryByText(/just taken/i)).toBeNull();
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
    expect(JSON.parse(init.body)).toEqual({ slotId: 'slot-1', serviceMode: 'recurring', selectedFrequency: { key: 'quarterly' }, serviceCadences: { lawn: 'standard' }, rehold: true });
  });

  it('leaves the cadence out of a one-time reserve', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ scheduledServiceId: 'ss-2', expiresAt: 'soon' }));
    vi.stubGlobal('fetch', fetchMock);
    await holdSameTimeAgain({ ...base, serviceMode: 'one_time' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ slotId: 'slot-1', serviceMode: 'one_time', rehold: true });
  });

  it.each([
    ['a refusal for a time whose id names no day (it cannot be looked up)', () => jsonResponse({ error: 'slot no longer available' }, { ok: false, status: 409 }), { failed: true }],
    ['a commercial estimate (staff reshaped it)', () => jsonResponse({ error: 'x', commercialManualScheduling: true }, { ok: false, status: 409 }), { noBooking: true }],
    ['a guarantee-only renewal', () => jsonResponse({ error: 'x', invoiceOnlyAcceptance: true }, { ok: false, status: 409 }), { noBooking: true }],
    ['an add-on limit, whatever the status', () => jsonResponse({ error: 'x', code: 'AREA_ADDON_YEARLY_LIMIT_REACHED' }, { ok: false, status: 422 }), { noBooking: true }],
    ['an estimate the office parked', () => jsonResponse({ code: 'ACCEPT_NEEDS_OFFICE_REVIEW', error: 'x' }, { ok: false, status: 409 }), { review: { code: 'ACCEPT_NEEDS_OFFICE_REVIEW', error: 'x' } }],
    ['another tab\'s newer hold (OTHER_LIVE_HOLD)', () => jsonResponse({ error: 'another time is held for this estimate', code: 'OTHER_LIVE_HOLD' }, { ok: false, status: 409 }), { otherHold: true }],
    ['another 409', () => jsonResponse({ error: 'something else' }, { ok: false, status: 409 }), { failed: true }],
    ['a server error', () => jsonResponse({}, { ok: false, status: 500 }), { failed: true }],
    ['a hold with no id', () => jsonResponse({}), { failed: true }],
  ])('answers %s', async (_label, answer, expected) => {
    vi.stubGlobal('fetch', vi.fn(async () => answer()));
    expect(await holdSameTimeAgain(base)).toEqual(expected);
  });

  const OLD = '2026-07-15_09-00_tech-1.1767210000000.90.oldsig';
  const FRESH = '2026-07-15_09-00_tech-1.1767216000000.90.newsig';
  const refusal = (primary, expander = []) => jsonResponse(
    { error: 'slot no longer available', availableSlots: { primary, expander } },
    { ok: false, status: 409 },
  );

  // The refusal answers /reserve; the picked day answers /available-slots.
  const routed = ({ reserve, day }) => vi.fn(async (url) => (String(url).includes('/available-slots') ? day() : reserve()));

  it("never takes the offer from the refusal's own list (it skips the customer filters): the picked day decides", async () => {
    const fetchMock = routed({ reserve: () => refusal([{ slotId: FRESH }]), day: () => jsonResponse({ primary: [], expander: [] }) });
    vi.stubGlobal('fetch', fetchMock);
    expect(await holdSameTimeAgain({ ...base, slotId: OLD })).toEqual({ failed: true });
    expect(fetchMock.mock.calls.filter(([url]) => /\/reserve$/.test(String(url)))).toHaveLength(1);
  });

  it('a day read that says the office parked the estimate goes to the office-review transition', async () => {
    const parked = { primary: [], expander: [], availableSlots: [], summary: null, reviewBeforeBooking: true, reason: 'contact_review', message: 'x' };
    vi.stubGlobal('fetch', routed({ reserve: () => refusal([]), day: () => jsonResponse(parked) }));
    expect(await holdSameTimeAgain({ ...base, slotId: OLD })).toEqual({ review: parked });
  });

  it('a day read that refuses booking (staff reshaped the estimate) is noBooking', async () => {
    const day = () => jsonResponse({ error: 'x', commercialManualScheduling: true }, { ok: false, status: 409 });
    vi.stubGlobal('fetch', routed({ reserve: () => refusal([]), day }));
    expect(await holdSameTimeAgain({ ...base, slotId: OLD })).toEqual({ noBooking: true });
  });

  it.each([
    ['another technician at the same time is not the same time', [{ slotId: '2026-07-15_09-00_tech-2.1767216000000.90.x' }]],
    ['neither list has the time', [{ slotId: '2026-07-15_10-00_tech-1.1767216000000.90.x' }]],
    ['a list that is not a list', 'oops'],
  ])('answers failed, never taken, when the picked day does not list the time: %s', async (_label, primary) => {
    const fetchMock = routed({ reserve: () => refusal(primary), day: () => jsonResponse({ primary: Array.isArray(primary) ? primary : [], expander: [] }) });
    vi.stubGlobal('fetch', fetchMock);
    expect(await holdSameTimeAgain({ ...base, slotId: OLD })).toEqual({ failed: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a time first found by date search: the picked day gives the fresh offer, read with the picker query', async () => {
    const reserves = [
      () => refusal([{ slotId: '2026-07-15_10-00_tech-1.1767216000000.90.x' }]),
      () => jsonResponse({ scheduledServiceId: 'ss-4', expiresAt: 'soon' }),
    ];
    const fetchMock = routed({ reserve: () => reserves.shift()(), day: () => jsonResponse({ primary: [], expander: [{ slotId: FRESH }] }) });
    vi.stubGlobal('fetch', fetchMock);
    const out = await holdSameTimeAgain({ ...base, slotId: OLD, selectedFrequency: 'quarterly' });
    expect(out).toEqual({ held: { scheduledServiceId: 'ss-4', expiresAt: 'soon' } });
    const [dayUrl] = fetchMock.mock.calls.find(([url]) => String(url).includes('/available-slots'));
    const query = new URL(String(dayUrl), 'http://x').searchParams;
    expect(query.get('date')).toBe('2026-07-15');
    expect(query.get('serviceMode')).toBe('recurring');
    expect(query.get('selectedFrequency')).toBe('quarterly');
    expect(JSON.parse(query.get('serviceCadences'))).toEqual({ lawn: 'standard' });
    const sent = fetchMock.mock.calls.filter(([url]) => /\/reserve$/.test(String(url))).map(([, init]) => JSON.parse(init.body).slotId);
    expect(sent).toEqual([OLD, FRESH]);
  });

  it.each([
    ['the day read fails', () => jsonResponse({}, { ok: false, status: 500 })],
    ['the day read throws', () => { throw new Error('offline'); }],
    ['the day answers no list', () => jsonResponse({ summary: null })],
  ])('answers failed, never taken, when availability cannot be read: %s', async (_label, day) => {
    const fetchMock = routed({ reserve: () => refusal([{ slotId: '2026-07-15_10-00_tech-1.1767216000000.90.x' }]), day });
    vi.stubGlobal('fetch', fetchMock);
    expect(await holdSameTimeAgain({ ...base, slotId: OLD })).toEqual({ failed: true });
  });

  it('retries only once, and a second refusal is still failed, never taken', async () => {
    const fetchMock = routed({ reserve: () => refusal([]), day: () => jsonResponse({ primary: [{ slotId: FRESH }], expander: [] }) });
    vi.stubGlobal('fetch', fetchMock);
    expect(await holdSameTimeAgain({ ...base, slotId: OLD })).toEqual({ failed: true });
    // reserve, the day read, the one retry.
    expect(fetchMock).toHaveBeenCalledTimes(3);
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
