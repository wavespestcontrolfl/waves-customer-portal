// @vitest-environment jsdom
// GATE_ESTIMATE_LAWN_LIMITS accept attestation: the tab echoes the hash /data served with the
// "What we can and can't fix" block it rendered; with no block it sends none; a 409
// LAWN_LIMITS_STALE refetches the estimate and asks for one more tap.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import EstimateViewPage from './EstimateViewPage';

vi.mock('react-router-dom', () => ({ useParams: () => ({ token: 'lawn-limits-accept-token' }) }));
vi.mock('../lib/stripeLoader', () => ({ loadStripeSdk: vi.fn(async () => null) }));

const jsonResponse = (body, { ok = true, status = 200 } = {}) => ({ ok, status, json: async () => body });

const BLOCK = { heading: "What we can and can't fix", paragraphs: [{ key: 'always', text: 'Fixed paragraph.' }] };

function payload(extra = {}) {
  return {
    estimate: {
      customerFirstName: 'Rae', address: '19 Retry Road', serviceCategory: 'pest_control',
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
    cta: { canAccept: true, terminalState: null, quoteRequired: false, quoteRequiredReason: null, reviewBeforeBooking: false, reviewReason: null },
    ...extra,
  };
}

function makeFetch(acceptImpl, data) {
  const calls = [];
  const fn = vi.fn(async (url, options = {}) => {
    const u = String(url);
    calls.push({ url: u, options });
    if (u.includes('/available-slots')) {
      return jsonResponse({ primary: [{ slotId: 'slot-1', date: '2026-07-15', windowStart: '09:00', windowEnd: '11:00' }], expander: [] });
    }
    if (u.includes('/reserve')) return jsonResponse({ scheduledServiceId: 'ss-1', expiresAt: new Date(Date.now() + 15 * 60000).toISOString() });
    if (u.includes('/accept')) return acceptImpl();
    if (u.includes('/data')) return jsonResponse(data);
    return jsonResponse({});
  });
  fn.calls = calls;
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

async function confirmBooking() {
  fireEvent.click((await screen.findAllByRole('button', { name: /^Choose / }))[0]);
  fireEvent.click(await screen.findByRole('button', { name: /Pay per application/i }));
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm booking' }));
}
const acceptBody = (fetchMock) => JSON.parse(fetchMock.calls.find((c) => c.url.includes('/accept')).options.body);

describe('accept attestation of the lawn limits block', () => {
  it('echoes the hash /data served with the block it rendered', async () => {
    stubLocalStorage();
    const fetchMock = makeFetch(() => new Promise(() => {}), payload({ lawnLimits: BLOCK, lawnLimitsHash: 'hash-from-server' }));
    vi.stubGlobal('fetch', fetchMock);
    render(<EstimateViewPage />);
    await confirmBooking();
    await waitFor(() => expect(fetchMock.calls.some((c) => c.url.includes('/accept'))).toBe(true));
    expect(acceptBody(fetchMock).lawnLimitsHash).toBe('hash-from-server');
  });

  it('sends no hash when the page rendered no block', async () => {
    stubLocalStorage();
    const fetchMock = makeFetch(() => new Promise(() => {}), payload());
    vi.stubGlobal('fetch', fetchMock);
    render(<EstimateViewPage />);
    await confirmBooking();
    await waitFor(() => expect(fetchMock.calls.some((c) => c.url.includes('/accept'))).toBe(true));
    expect(acceptBody(fetchMock)).not.toHaveProperty('lawnLimitsHash');
  });

  it('a 409 LAWN_LIMITS_STALE refetches the estimate and shows the reload message', async () => {
    stubLocalStorage();
    const message = 'This estimate was refreshed. Please reload the page and review the updated terms before accepting.';
    const fetchMock = makeFetch(
      () => jsonResponse({ error: message, code: 'LAWN_LIMITS_STALE' }, { ok: false, status: 409 }),
      payload({ lawnLimits: BLOCK, lawnLimitsHash: 'hash-from-server' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<EstimateViewPage />);
    const dataLoadsBefore = () => fetchMock.calls.filter((c) => c.url.includes('/data')).length;
    await confirmBooking();
    await waitFor(() => expect(screen.getByText(new RegExp(message.slice(0, 40)))).toBeInTheDocument());
    expect(dataLoadsBefore()).toBeGreaterThanOrEqual(2);
  });
});
