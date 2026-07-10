// @vitest-environment jsdom
// Review-phase failure visibility + mid-submit mutation guard:
// 1. An /accept 500 lands the customer back in the REVIEW phase — the error
//    banner must render there (it used to render only in configure, so a
//    review-phase failure showed nothing at all).
// 2. While ctaPhase === 'submitting' the configure layout is on screen — the
//    one-time toggle and the slot picker must be frozen so the in-flight
//    reserve/accept payload can't be mutated from under the request.
// 3. A slot search started BEFORE the submit retains a selectSlot callback
//    with the old ctaPhase in its closure — when it resolves mid-accept its
//    selectSlot(null) must not clear the slot the request is committing
//    (only the synchronously updated ctaPhaseRef can catch it).
// 4. The same stale search can also resolve AFTER the page enters review —
//    when nothing is submitting but a reservation is live — so the guard
//    must reject on the live phase (review/submitting/success), not just on
//    a submitting flag.
// 5. The one-time add-on toggles render inside the configure layout too —
//    they must be frozen while the accept is in flight or a toggle repricing
//    the estimate lands underneath the request.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import EstimateViewPage from './EstimateViewPage';

vi.mock('react-router-dom', () => ({
  useParams: () => ({ token: 'review-error-token' }),
}));

vi.mock('../lib/stripeLoader', () => ({
  loadStripeSdk: vi.fn(async () => null),
}));

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

function recurringPayload({ renderFlags = {}, addOns = [] } = {}) {
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
          addOns,
        }],
        copy: { priceWording: {} },
      }],
      askChips: [],
      anchorOneTimePrice: 250,
      defaultServiceMode: 'recurring',
      renderFlags,
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

function slotsPayload() {
  return {
    primary: [
      { slotId: 'slot-1', date: '2026-07-15', windowStart: '09:00', windowEnd: '11:00' },
      { slotId: 'slot-2', date: '2026-07-16', windowStart: '13:00', windowEnd: '15:00' },
    ],
    expander: [],
  };
}

// Routes every fetch the booking flow makes; acceptImpl lets each test choose
// the /accept outcome (500 vs. hanging forever), findSlotsImpl the AI-search
// /find-slots outcome. Order matters: match the specific booking endpoints
// before the catch-all /data.
function makeFetchMock(acceptImpl, { findSlotsImpl = null, payload = null } = {}) {
  return vi.fn(async (url) => {
    const u = String(url);
    if (findSlotsImpl && u.includes('/find-slots')) return findSlotsImpl();
    if (u.includes('/available-slots')) return jsonResponse(slotsPayload());
    if (u.includes('/reserve')) {
      return jsonResponse({
        scheduledServiceId: 'ss-1',
        expiresAt: new Date(Date.now() + 15 * 60000).toISOString(),
      });
    }
    if (u.includes('/accept')) return acceptImpl();
    if (u.includes('/data')) return jsonResponse(payload || recurringPayload());
    return jsonResponse({});
  });
}

// jsdom in this runner ships without a usable localStorage (same workaround
// as EstimateViewPage.draft-preview.test.jsx) — stub a functional one.
function stubLocalStorage(store = {}) {
  vi.stubGlobal('localStorage', {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  });
}

// jsdom implements neither — the review/success phases scroll the active step
// into view.
beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.scrollTo = vi.fn();
});

async function bookThroughToReview() {
  // Slot list loads → pick the first slot.
  const slotButtons = await screen.findAllByRole('button', { name: /Arrival window/i });
  fireEvent.click(slotButtons[0]);

  // Payment preference appears once a slot is selected → reserve → review.
  fireEvent.click(await screen.findByRole('button', { name: /Pay per application/i }));
  return screen.findByRole('button', { name: 'Confirm booking' });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('EstimateViewPage review-phase accept failure', () => {
  it('shows the error banner in the review phase when /accept fails', async () => {
    stubLocalStorage();
    vi.stubGlobal('fetch', makeFetchMock(() => jsonResponse(
      { error: 'Payment processor unavailable' },
      { ok: false, status: 500 },
    )));

    render(<EstimateViewPage />);
    const confirmButton = await bookThroughToReview();

    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(screen.getByText(/Something went wrong: Payment processor unavailable/)).toBeInTheDocument();
    });
    // Still in the review phase — the confirm card is the retry surface.
    expect(screen.getByRole('button', { name: 'Confirm booking' })).toBeInTheDocument();

    // Going back clears the error instead of carrying it into configure.
    fireEvent.click(screen.getByRole('button', { name: 'Go back' }));
    await waitFor(() => {
      expect(screen.queryByText(/Something went wrong/)).not.toBeInTheDocument();
    });
  });

  it('freezes the one-time toggle and slot picker while the accept is in flight', async () => {
    stubLocalStorage();
    // /accept never resolves → the page stays in ctaPhase 'submitting',
    // which renders the configure layout.
    vi.stubGlobal('fetch', makeFetchMock(() => new Promise(() => {})));

    render(<EstimateViewPage />);
    const confirmButton = await bookThroughToReview();

    fireEvent.click(confirmButton);

    // Submitting drops back to the configure layout with the toggle disabled…
    const recurringPill = await screen.findByRole('button', { name: 'Recurring Pest Control' });
    expect(recurringPill).toBeDisabled();
    expect(screen.getByRole('button', { name: 'One-Time Pest Control' })).toBeDisabled();

    // …and the slot picker frozen: taps are blocked by the aria-disabled
    // pointer-events wrapper, and even a synthetic click (jsdom ignores CSS
    // pointer-events) is dropped by the guarded onSelect.
    const slotButtons = screen.getAllByRole('button', { name: /Arrival window/i });
    expect(slotButtons[0].closest('[aria-disabled="true"]')).not.toBeNull();
    const otherSlot = slotButtons[1];
    expect(otherSlot).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(otherSlot);
    expect(otherSlot).toHaveAttribute('aria-pressed', 'false');
  });

  it('a slot search started before submit cannot clear the selection when it resolves mid-accept', async () => {
    stubLocalStorage();
    // The AI slot search stays in flight until the test releases it — AFTER
    // the accept is submitting — modeling the stale-callback race: the
    // search's selectSlot(null) closure carries the pre-submit ctaPhase.
    let releaseFindSlots;
    const findSlotsGate = new Promise((resolve) => { releaseFindSlots = resolve; });
    vi.stubGlobal('fetch', makeFetchMock(
      () => new Promise(() => {}), // /accept never resolves → stays 'submitting'
      { findSlotsImpl: () => findSlotsGate },
    ));

    render(<EstimateViewPage />);

    // Pick a slot, then start an AI search that hangs on the gate.
    const slotButtons = await screen.findAllByRole('button', { name: /Arrival window/i });
    fireEvent.click(slotButtons[0]);
    const searchInput = screen.getByLabelText('Search for a service date or time');
    fireEvent.change(searchInput, { target: { value: 'anything next tuesday' } });
    fireEvent.submit(searchInput.closest('form'));

    // Reserve → review → confirm; the hanging /accept keeps 'submitting'
    // (frozen configure layout) on screen.
    fireEvent.click(await screen.findByRole('button', { name: /Pay per application/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm booking' }));
    const recurringPill = await screen.findByRole('button', { name: 'Recurring Pest Control' });
    expect(recurringPill).toBeDisabled();

    // The pre-submit search resolves mid-accept and its retained callback
    // fires selectSlot(null).
    await act(async () => {
      releaseFindSlots(jsonResponse({ primary: [], expander: [], summary: 'Found a match' }));
      await findSlotsGate;
      // Drain the search continuation (res.json() → selectSlot → setState).
      await Promise.resolve();
      await Promise.resolve();
    });

    // Selection survives: the slot the in-flight accept is committing stays
    // picked, and the payment section (gated on selectedSlotId) stays up.
    const slotsAfter = screen.getAllByRole('button', { name: /Arrival window/i });
    expect(slotsAfter[0]).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Pay per application/i })).toBeInTheDocument();
  });

  it('a slot search resolving after entering review does not clear the slot behind the live reservation', async () => {
    stubLocalStorage();
    // Nothing is submitting when the stale search resolves here — the page
    // sits in REVIEW with a live reservation, which a submitting-only flag
    // would wave straight through. The guard must read the live phase.
    let releaseFindSlots;
    const findSlotsGate = new Promise((resolve) => { releaseFindSlots = resolve; });
    vi.stubGlobal('fetch', makeFetchMock(
      () => jsonResponse({}), // /accept is never reached in this test
      { findSlotsImpl: () => findSlotsGate },
    ));

    render(<EstimateViewPage />);

    // Pick a slot, then start an AI search that hangs on the gate.
    const slotButtons = await screen.findAllByRole('button', { name: /Arrival window/i });
    fireEvent.click(slotButtons[0]);
    const searchInput = screen.getByLabelText('Search for a service date or time');
    fireEvent.change(searchInput, { target: { value: 'anything next tuesday' } });
    fireEvent.submit(searchInput.closest('form'));

    // Reserve → review (live reservation, ctaPhase 'review').
    fireEvent.click(await screen.findByRole('button', { name: /Pay per application/i }));
    await screen.findByRole('button', { name: 'Confirm booking' });

    // The pre-reserve search resolves now and its retained callback fires
    // selectSlot(null) — with the reservation still held server-side.
    await act(async () => {
      releaseFindSlots(jsonResponse({ primary: [], expander: [], summary: 'Found a match' }));
      await findSlotsGate;
      // Drain the search continuation (res.json() → selectSlot → setState).
      await Promise.resolve();
      await Promise.resolve();
    });

    // Review state survives untouched.
    expect(screen.getByRole('button', { name: 'Confirm booking' })).toBeInTheDocument();

    // Go back keeps the selected slot by design (the hold stays live) — if
    // the stale search had cleared it, the slot would be unpressed and the
    // payment section (gated on selectedSlotId) gone.
    fireEvent.click(screen.getByRole('button', { name: 'Go back' }));
    const slotsAfter = await screen.findAllByRole('button', { name: /Arrival window/i });
    expect(slotsAfter[0]).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Pay per application/i })).toBeInTheDocument();
  });

  it('freezes the one-time add-on toggles while the accept is in flight', async () => {
    stubLocalStorage();
    const payload = recurringPayload({
      renderFlags: { showOneTimePestAddOns: true },
      addOns: [{ key: 'interior_spray', label: 'Interior spraying', detail: 'Save $10 if removed', preChecked: true }],
    });
    // /accept never resolves → the page stays in ctaPhase 'submitting',
    // which renders the one-time configure layout (incl. AddOnsBlock).
    const fetchMock = makeFetchMock(() => new Promise(() => {}), { payload });
    vi.stubGlobal('fetch', fetchMock);

    render(<EstimateViewPage />);

    // Switch to the one-time mode — its layout renders the add-on toggles.
    fireEvent.click(await screen.findByRole('button', { name: 'One-Time Pest Control' }));
    expect(await screen.findByRole('checkbox')).toBeEnabled();

    // Book: slot → payment preference → confirm (hangs → 'submitting').
    const slotButtons = await screen.findAllByRole('button', { name: /Arrival window/i });
    fireEvent.click(slotButtons[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'Book + pay on service day' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm booking' }));

    // Submitting drops back to the configure layout with the toggle pills
    // disabled — and the add-on switch must be frozen too.
    expect(await screen.findByRole('button', { name: 'One-Time Pest Control' })).toBeDisabled();
    const addOnSwitch = screen.getByRole('checkbox');
    expect(addOnSwitch).toBeDisabled();

    // A click mid-submit must not fire the repricing PUT /preferences.
    fireEvent.click(addOnSwitch);
    const preferenceCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/preferences'));
    expect(preferenceCalls).toHaveLength(0);
  });
});
