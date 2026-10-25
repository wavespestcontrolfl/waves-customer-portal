// @vitest-environment jsdom
// Florida consumer notice (GATE_ESTIMATE_CONSUMER_NOTICE): /data carries cta.consumerNotice only with the gate on and a
// termite line. Until it reads 'signed' every accept control is held off through one flag; the page refetches when the
// customer comes back from the signing page; a server 409 consumer_notice_required shows its message and refetches.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import EstimateViewPage from './EstimateViewPage';

vi.mock('react-router-dom', () => ({ useParams: () => ({ token: 'consumer-notice-token' }) }));
vi.mock('../lib/stripeLoader', () => ({ loadStripeSdk: vi.fn(async () => null) }));

const jsonResponse = (body, { ok = true, status = 200 } = {}) => ({ ok, status, json: async () => body });
const HINT = 'Sign the Florida consumer notice above to accept.';

function payload(consumerNotice) {
  return {
    estimate: {
      customerFirstName: 'Pat', address: '12 Test Lane', serviceCategory: 'pest_control',
      acceptance: { mode: 'standard_slot_pick' }, membership: null, intelligence: null, askToken: 'ask-token',
      defaultServiceMode: 'recurring', isOneTimeOnly: false, showOneTimeOption: true, billByInvoice: false,
      licenseNumber: 'JB000000', acceptedServiceMode: null, acceptedFrequencyKey: null,
    },
    pricing: {
      services: [{
        key: 'pest_control', label: 'Pest Control', isRecurring: true, isPest: true,
        frequencies: [{ key: 'quarterly', label: 'Quarterly', monthly: 50, annual: 600, included: [{ key: 'service', label: 'Recurring service' }], addOns: [] }],
        copy: { priceWording: {} },
      }],
      askChips: [], anchorOneTimePrice: 250, defaultServiceMode: 'recurring', renderFlags: {},
    },
    cta: {
      canAccept: true, terminalState: null, quoteRequired: false, quoteRequiredReason: null, reviewBeforeBooking: false, reviewReason: null,
      ...(consumerNotice ? { consumerNotice } : {}),
    },
  };
}

// dataQueue: the payloads /data answers with, in order; the last one repeats.
function makeFetch({ dataQueue, acceptImpl = () => new Promise(() => {}) }) {
  const calls = [];
  let dataCalls = 0;
  const fn = vi.fn(async (url, options = {}) => {
    const u = String(url);
    calls.push({ url: u, options });
    if (u.includes('/available-slots')) {
      return jsonResponse({ primary: [{ slotId: 'slot-1', date: '2026-07-15', windowStart: '09:00', windowEnd: '11:00' }], expander: [] });
    }
    if (u.includes('/reserve')) return jsonResponse({ scheduledServiceId: 'ss-1', expiresAt: new Date(Date.now() + 15 * 60000).toISOString() });
    if (u.includes('/accept')) return acceptImpl();
    if (u.includes('/data')) { const next = dataQueue[Math.min(dataCalls, dataQueue.length - 1)]; dataCalls += 1; return jsonResponse(next); }
    return jsonResponse({});
  });
  fn.calls = calls;
  fn.count = (part) => calls.filter((c) => c.url.includes(part)).length;
  return fn;
}

function stubLocalStorage() {
  const store = {};
  vi.stubGlobal('localStorage', {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  });
}

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.scrollTo = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const chooseSlot = async () => fireEvent.click((await screen.findAllByRole('button', { name: /^Choose / }))[0]);
const payPerApplication = () => screen.findByRole('button', { name: /Pay per application/i });

describe('accept controls while the Florida consumer notice is unsigned', () => {
  it.each(['none', 'awaiting'])('state %s: the card shows above the controls, the payment choice is disabled with the hint, and no hold is reserved', async (state) => {
    stubLocalStorage();
    const fetchMock = makeFetch({ dataQueue: [payload({ state, canSign: true })] });
    vi.stubGlobal('fetch', fetchMock);
    render(<EstimateViewPage />);
    expect(await screen.findByRole('button', { name: 'Read and sign the notice' })).toBeInTheDocument();
    await chooseSlot();
    const choice = await payPerApplication();
    expect(choice).toBeDisabled();
    expect(screen.getAllByText(HINT).length).toBeGreaterThan(0);
    fireEvent.click(choice);
    await waitFor(() => expect(fetchMock.count('/available-slots')).toBeGreaterThan(0));
    expect(fetchMock.count('/reserve')).toBe(0);
    expect(fetchMock.count('/accept')).toBe(0);
  });

  it('a customer with no account sees the call-us card and the same held-off controls', async () => {
    stubLocalStorage();
    const fetchMock = makeFetch({ dataQueue: [payload({ state: 'none', canSign: false, reason: 'no_account' })] });
    vi.stubGlobal('fetch', fetchMock);
    render(<EstimateViewPage />);
    expect(await screen.findByTestId('consumer-notice-call')).toBeInTheDocument();
    await chooseSlot();
    expect(await payPerApplication()).toBeDisabled();
  });

  it('state signed: the thank-you shows, no hint, and the booking goes through to the accept', async () => {
    stubLocalStorage();
    const fetchMock = makeFetch({ dataQueue: [payload({ state: 'signed', canSign: false })] });
    vi.stubGlobal('fetch', fetchMock);
    render(<EstimateViewPage />);
    expect(await screen.findByText('Consumer notice signed')).toBeInTheDocument();
    await chooseSlot();
    const choice = await payPerApplication();
    expect(choice).toBeEnabled();
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
    fireEvent.click(choice);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm booking' }));
    await waitFor(() => expect(fetchMock.count('/accept')).toBe(1));
  });

  it('no block in /data (gate off, or no termite line): the page is as before', async () => {
    stubLocalStorage();
    const fetchMock = makeFetch({ dataQueue: [payload(null)] });
    vi.stubGlobal('fetch', fetchMock);
    render(<EstimateViewPage />);
    await chooseSlot();
    expect(await payPerApplication()).toBeEnabled();
    expect(screen.queryByText('Florida consumer notice')).not.toBeInTheDocument();
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
  });
});

describe('coming back from the signing page', () => {
  it('a bfcache restore (pageshow, persisted) refetches /data and shows the signed state', async () => {
    stubLocalStorage();
    const fetchMock = makeFetch({ dataQueue: [payload({ state: 'none', canSign: true }), payload({ state: 'signed', canSign: false })] });
    vi.stubGlobal('fetch', fetchMock);
    render(<EstimateViewPage />);
    await screen.findByRole('button', { name: 'Read and sign the notice' });
    // A restore that is not from the cache is a fresh load, not a refetch.
    await act(async () => { window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false })); });
    expect(fetchMock.count('/data')).toBe(1);
    await act(async () => { window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true })); });
    expect(await screen.findByText('Consumer notice signed')).toBeInTheDocument();
    expect(fetchMock.count('/data')).toBe(2);
    expect(fetchMock.calls.filter((c) => c.url.includes('/data'))[1].url).toContain('refresh=1');
  });

  it('a tab becoming visible refetches /data and shows the signed state', async () => {
    stubLocalStorage();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    const fetchMock = makeFetch({ dataQueue: [payload({ state: 'awaiting', canSign: true }), payload({ state: 'signed', canSign: false })] });
    vi.stubGlobal('fetch', fetchMock);
    render(<EstimateViewPage />);
    await screen.findByRole('button', { name: 'Read and sign the notice' });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(await screen.findByText('Consumer notice signed')).toBeInTheDocument();
    expect(fetchMock.count('/data')).toBe(2);
  });

  it('a page without the notice never refetches on a tab switch', async () => {
    stubLocalStorage();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    const fetchMock = makeFetch({ dataQueue: [payload(null)] });
    vi.stubGlobal('fetch', fetchMock);
    render(<EstimateViewPage />);
    await chooseSlot();
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true })); });
    expect(fetchMock.count('/data')).toBe(1);
  });
});

describe('a server refusal of the accept', () => {
  it('409 consumer_notice_required shows the server message and refetches /data', async () => {
    stubLocalStorage();
    const message = 'Please sign the Florida consumer notice above before you accept.';
    const fetchMock = makeFetch({
      dataQueue: [payload(null), payload({ state: 'none', canSign: true })],
      acceptImpl: () => jsonResponse({ error: message, code: 'consumer_notice_required' }, { ok: false, status: 409 }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<EstimateViewPage />);
    await chooseSlot();
    fireEvent.click(await payPerApplication());
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm booking' }));
    await waitFor(() => expect(screen.getByText(new RegExp(message.slice(0, 40)))).toBeInTheDocument());
    expect(fetchMock.count('/data')).toBeGreaterThanOrEqual(2);
    // The refetched page now holds the accept controls off.
    await waitFor(() => expect(screen.getAllByText(HINT).length).toBeGreaterThan(0));
  });
});
