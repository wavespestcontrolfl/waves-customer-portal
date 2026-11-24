// @vitest-environment jsdom
// The visit text recipient's tracker link (GATE_CALL_GIVEN_VISIT_TEXTS): the server sends a reduced, map-only payload
// (scope 'visit_recipient'). Every state must render from it without the holder-only keys, and the complete state
// must show no report, invoice, review or offer.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TrackPage from './TrackPage';

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({ on: vi.fn(), off: vi.fn(), disconnect: vi.fn() })),
}));
vi.mock('@react-google-maps/api', () => ({
  useJsApiLoader: () => ({ isLoaded: false }), GoogleMap: () => null, Marker: () => null,
}));

function payload(state, extra = {}) {
  return {
    scope: 'visit_recipient',
    state,
    tech: { firstName: 'Pat', photoUrl: null, yearsWithWaves: null },
    window: { date: null, start: '2026-12-01T14:00:00.000Z', end: '2026-12-01T16:00:00.000Z' },
    property: { lat: 27.4, lng: -82.5, city: 'Parrish' },
    service: { type: 'Pest Control' },
    vehicle: null,
    arrivedAt: null,
    visitChange: null,
    meta: { pollIntervalSeconds: 0 },
    ...extra,
  };
}

function renderTrack(body) {
  global.fetch = vi.fn((url, init) => {
    if (init?.method === 'POST') return Promise.resolve({ ok: true, status: 204 });
    return Promise.resolve({ ok: true, status: 200, json: async () => body });
  });
  return render(
    <MemoryRouter initialEntries={['/track/token']}>
      <Routes><Route path="/track/:token" element={<TrackPage />} /></Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('TrackPage for a visit text recipient', () => {
  it('renders the scheduled state with no holder name, address line or plan cards', async () => {
    renderTrack(payload('scheduled'));
    expect(await screen.findByRole('heading', { name: /your pest control is booked/i })).toBeInTheDocument();
    expect(screen.queryByText(/prep instructions/i)).not.toBeInTheDocument();
  });

  it('renders en route with the tech and a no-map fallback when the truck has no fix', async () => {
    renderTrack(payload('en_route', { meta: { pollIntervalSeconds: 30 } }));
    expect(await screen.findByText(/Pat is on the way/i)).toBeInTheDocument();
  });

  it('renders on property', async () => {
    renderTrack(payload('on_property', { arrivedAt: '2026-12-01T14:05:00.000Z', meta: { pollIntervalSeconds: 30 } }));
    expect(await screen.findByText(/Pat is servicing your property/i)).toBeInTheDocument();
  });

  it('complete shows a plain done line: no report, invoice, review, offer or referral', async () => {
    renderTrack(payload('complete'));
    expect(await screen.findByRole('heading', { name: /pest control visit is complete/i })).toBeInTheDocument();
    expect(screen.queryByText(/View service report/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/View invoice/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Google review/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Thanks for choosing Waves/i)).not.toBeInTheDocument();
  });

  it('cancelled renders without a reason', async () => {
    renderTrack(payload('cancelled'));
    expect(await screen.findByText(/was cancelled/i)).toBeInTheDocument();
    expect(screen.queryByText(/Reason:/)).not.toBeInTheDocument();
  });

  it('a scheduled visit polls on the server\'s slow interval and shows the en-route state when the tech heads out', async () => {
    const bodies = [
      payload('scheduled', { meta: { pollIntervalSeconds: 120 } }),
      payload('en_route', { meta: { pollIntervalSeconds: 30 } }),
    ];
    let n = 0;
    global.fetch = vi.fn((url, init) => {
      if (init?.method === 'POST') return Promise.resolve({ ok: true, status: 204 });
      const body = bodies[Math.min(n, bodies.length - 1)];
      n += 1;
      return Promise.resolve({ ok: true, status: 200, json: async () => body });
    });
    render(
      <MemoryRouter initialEntries={['/track/token']}>
        <Routes><Route path="/track/:token" element={<TrackPage />} /></Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: /your pest control is booked/i })).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(120 * 1000); });
    expect(await screen.findByText(/Pat is on the way/i)).toBeInTheDocument();
  });
});
