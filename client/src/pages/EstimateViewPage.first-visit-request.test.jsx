// @vitest-environment jsdom
// GATE_ESTIMATE_APPROVE_PREFERRED_TIME on the estimate page: under the time picker a customer can send a first-visit REQUEST.
// It never accepts: nothing is reserved, the accept route is not called, and the page says the office will call or text.
// A reopened link shows the same pending state from /data. With /data not offering it (gate off) the page is unchanged.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import EstimateViewPage from './EstimateViewPage';

vi.mock('react-router-dom', () => ({ useParams: () => ({ token: 'pref-days-token' }) }));
vi.mock('../lib/stripeLoader', () => ({ loadStripeSdk: vi.fn(async () => null) }));

const jsonResponse = (body, { ok = true, status = 200 } = {}) => ({ ok, status, json: async () => body });

function payload({ preferredTime = { offered: true } } = {}) {
  return {
    estimate: {
      customerFirstName: 'Rae', address: '19 Retry Road', serviceCategory: 'pest_control',
      acceptance: { mode: 'standard_slot_pick', ...(preferredTime ? { preferredTime } : {}) },
      membership: null, intelligence: null, askToken: 'ask-token',
      defaultServiceMode: 'recurring', isOneTimeOnly: false, showOneTimeOption: false, billByInvoice: false,
      licenseNumber: 'JB000000', acceptedServiceMode: null, acceptedFrequencyKey: null,
    },
    pricing: {
      services: [{
        key: 'pest_control', label: 'Pest Control', isRecurring: true, isPest: true,
        frequencies: [{ key: 'quarterly', label: 'Quarterly', monthly: 50, annual: 600, included: [{ key: 'service', label: 'Recurring service' }], addOns: [] }],
        copy: { priceWording: {} },
      }],
      askChips: [], anchorOneTimePrice: 0, defaultServiceMode: 'recurring', renderFlags: {},
    },
    cta: { canAccept: true, terminalState: null, quoteRequired: false, quoteRequiredReason: null, reviewBeforeBooking: false, reviewReason: null },
  };
}

function makeFetch(data) {
  const calls = [];
  const fn = vi.fn(async (url, options = {}) => {
    const u = String(url);
    calls.push({ url: u, options });
    if (u.includes('/available-slots')) {
      return jsonResponse({ primary: [{ slotId: 'slot-1', date: '2026-07-15', windowStart: '09:00', windowEnd: '11:00' }], expander: [] });
    }
    if (u.includes('/first-visit-request')) return jsonResponse({ success: true, requestPending: true, days: ['mon', 'thu'], window: 'morning' }, { status: 201 });
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

describe('first-visit request on the estimate page', () => {
  it('sends the request, never accepts or reserves, and shows the pending words', async () => {
    stubLocalStorage();
    const fetchMock = makeFetch(payload());
    vi.stubGlobal('fetch', fetchMock);
    render(<EstimateViewPage />);
    fireEvent.click(await screen.findByRole('button', { name: /None of these times work/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Mon' }));
    fireEvent.click(screen.getByRole('button', { name: 'Thu' }));
    fireEvent.click(screen.getByRole('button', { name: 'Morning' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send my request' }));
    const card = await screen.findByTestId('first-visit-request-pending');
    expect(card).toHaveTextContent('Our office will call or text you to set your first visit and finish your approval.');
    const request = fetchMock.calls.find((c) => c.url.includes('/first-visit-request'));
    expect(JSON.parse(request.options.body)).toEqual({ days: ['mon', 'thu'], window: 'morning' });
    expect(fetchMock.calls.some((c) => c.url.includes('/accept'))).toBe(false);
    expect(fetchMock.calls.some((c) => c.url.includes('/reserve'))).toBe(false);
    expect(screen.queryByText(/You're booked|You're approved/)).toBeNull();
  });

  it('a reopened link shows the pending state from /data', async () => {
    stubLocalStorage();
    vi.stubGlobal('fetch', makeFetch(payload({ preferredTime: { offered: true, requestPending: true, days: ['tue'], window: 'afternoon' } })));
    render(<EstimateViewPage />);
    const card = await screen.findByTestId('first-visit-request-pending');
    expect(card).toHaveTextContent('Tue, afternoons');
    expect(screen.queryByRole('button', { name: /None of these times work/ })).toBeNull();
  });

  it('a picked time hides the request option (the normal booking flow takes over)', async () => {
    stubLocalStorage();
    vi.stubGlobal('fetch', makeFetch(payload()));
    render(<EstimateViewPage />);
    await screen.findByRole('button', { name: /None of these times work/ });
    fireEvent.click((await screen.findAllByRole('button', { name: /^Choose / }))[0]);
    await waitFor(() => expect(screen.queryByRole('button', { name: /None of these times work/ })).toBeNull());
  });

  it('is not offered when /data does not offer it (gate off): no link, nothing else changes', async () => {
    stubLocalStorage();
    vi.stubGlobal('fetch', makeFetch(payload({ preferredTime: null })));
    render(<EstimateViewPage />);
    await screen.findAllByRole('button', { name: /^Choose / });
    expect(screen.queryByRole('button', { name: /None of these times work/ })).toBeNull();
    expect(screen.queryByTestId('first-visit-request-pending')).toBeNull();
  });
});
