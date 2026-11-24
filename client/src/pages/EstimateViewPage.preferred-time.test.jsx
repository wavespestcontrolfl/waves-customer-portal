// @vitest-environment jsdom
// GATE_ESTIMATE_APPROVE_PREFERRED_TIME on the estimate page: under the time picker a customer can approve a standard
// recurring plan with preferred days. The accept then carries `preferredTime` and NO slot, nothing is reserved, annual
// prepay is not offered, and the success card says the office confirms the first visit (no date or time). A picked time
// takes over. With /data not offering it (gate off) the page is unchanged.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import EstimateViewPage from './EstimateViewPage';

vi.mock('react-router-dom', () => ({ useParams: () => ({ token: 'preferred-time-token' }) }));
vi.mock('../lib/stripeLoader', () => ({ loadStripeSdk: vi.fn(async () => null) }));

const jsonResponse = (body, { ok = true, status = 200 } = {}) => ({ ok, status, json: async () => body });

function payload({ offered = true } = {}) {
  return {
    estimate: {
      customerFirstName: 'Rae', address: '19 Retry Road', serviceCategory: 'pest_control',
      acceptance: { mode: 'standard_slot_pick', ...(offered ? { preferredTime: { offered: true } } : {}) },
      membership: null, intelligence: null, askToken: 'ask-token',
      defaultServiceMode: 'recurring', isOneTimeOnly: false, showOneTimeOption: false, billByInvoice: false,
      licenseNumber: 'JB000000', acceptedServiceMode: null, acceptedFrequencyKey: null,
    },
    pricing: {
      services: [{
        key: 'pest_control', label: 'Pest Control', isRecurring: true, isPest: true,
        frequencies: [{ key: 'quarterly', label: 'Quarterly', monthly: 50, annual: 600, annualPrepayEligible: true, included: [{ key: 'service', label: 'Recurring service' }], addOns: [] }],
        copy: { priceWording: {} },
      }],
      askChips: [], anchorOneTimePrice: 0, defaultServiceMode: 'recurring', renderFlags: {}, annualPrepayEligible: true,
    },
    cta: { canAccept: true, terminalState: null, quoteRequired: false, quoteRequiredReason: null, reviewBeforeBooking: false, reviewReason: null },
  };
}

function makeFetch(data, acceptBody = { success: true, nextStep: 'confirmed', serviceMode: 'recurring', reservationCommitted: false, preferredTimePending: true }) {
  const calls = [];
  const fn = vi.fn(async (url, options = {}) => {
    const u = String(url);
    calls.push({ url: u, options });
    if (u.includes('/available-slots')) {
      return jsonResponse({ primary: [{ slotId: 'slot-1', date: '2026-07-15', windowStart: '09:00', windowEnd: '11:00' }], expander: [] });
    }
    if (u.includes('/reserve')) return jsonResponse({ scheduledServiceId: 'ss-1', expiresAt: new Date(Date.now() + 15 * 60000).toISOString() });
    if (u.includes('/accept')) return jsonResponse(acceptBody);
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

const acceptCall = (fetchMock) => fetchMock.calls.find((c) => c.url.includes('/accept'));

async function saveDays() {
  fireEvent.click(await screen.findByRole('button', { name: /None of these times work/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Mon' }));
  fireEvent.click(screen.getByRole('button', { name: 'Thu' }));
  fireEvent.click(screen.getByRole('button', { name: 'Morning' }));
  fireEvent.click(screen.getByRole('button', { name: 'Use these days' }));
}

describe('approve with preferred days', () => {
  it('sends the days with no slot, reserves nothing, and says the office confirms the first visit', async () => {
    stubLocalStorage();
    const fetchMock = makeFetch(payload());
    vi.stubGlobal('fetch', fetchMock);
    render(<EstimateViewPage />);
    await saveDays();
    expect(await screen.findByTestId('preferred-time-summary')).toHaveTextContent('Mon, Thu, mornings');
    // Annual prepay needs a booked visit, so it is not offered here.
    expect(screen.queryByRole('button', { name: /annual/i })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: /Pay per application/i }));
    expect(await screen.findByText(/no time is set yet\. Our office will contact you to confirm it/)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve my plan' }));
    await waitFor(() => expect(acceptCall(fetchMock)).toBeTruthy());
    const body = JSON.parse(acceptCall(fetchMock).options.body);
    expect(body.preferredTime).toEqual({ days: ['mon', 'thu'], window: 'morning' });
    expect(body.slotId ?? null).toBeNull();
    expect(body.existingAppointmentId).toBeUndefined();
    expect(body.paymentMethodPreference).toBe('pay_at_visit');
    expect(fetchMock.calls.some((c) => c.url.includes('/reserve'))).toBe(false);
    // Success: approved, never "booked", and no date or time.
    expect(await screen.findByText("You're approved!")).toBeInTheDocument();
    expect(screen.getByTestId('preferred-time-pending-note')).toHaveTextContent('Our office will contact you soon to confirm your first visit');
    expect(screen.queryByText(/You're booked/)).toBeNull();
  });

  it('a picked time takes over: the accept carries the slot and no preferred days', async () => {
    stubLocalStorage();
    const fetchMock = makeFetch(payload(), { success: true, nextStep: 'confirmed', serviceMode: 'recurring', reservationCommitted: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<EstimateViewPage />);
    await saveDays();
    await screen.findByTestId('preferred-time-summary');
    fireEvent.click((await screen.findAllByRole('button', { name: /^Choose / }))[0]);
    await waitFor(() => expect(screen.queryByTestId('preferred-time-summary')).toBeNull());
    fireEvent.click(await screen.findByRole('button', { name: /Pay per application/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm booking' }));
    await waitFor(() => expect(acceptCall(fetchMock)).toBeTruthy());
    const body = JSON.parse(acceptCall(fetchMock).options.body);
    expect(body.slotId).toBe('slot-1');
    expect(body).not.toHaveProperty('preferredTime');
  });

  it('is not offered when /data does not offer it (gate off): no link, nothing else changes', async () => {
    stubLocalStorage();
    const fetchMock = makeFetch(payload({ offered: false }));
    vi.stubGlobal('fetch', fetchMock);
    render(<EstimateViewPage />);
    await screen.findAllByRole('button', { name: /^Choose / });
    expect(screen.queryByRole('button', { name: /None of these times work/ })).toBeNull();
  });
});
