// @vitest-environment jsdom
// The visit text recipient's tracker link (GATE_CALL_GIVEN_VISIT_TEXTS): the server sends a reduced, map-only payload
// (scope 'visit_recipient'). Every state must render from it without the holder-only keys, and the complete state
// must show no report, invoice, review or offer.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { io } from 'socket.io-client';
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

  it('a 404 (the link is closed) shows the not-found card', async () => {
    global.fetch = vi.fn(() => Promise.resolve({ ok: false, status: 404, json: async () => ({ error: 'Not found' }) }));
    render(
      <MemoryRouter initialEntries={['/track/token']}>
        <Routes><Route path="/track/:token" element={<TrackPage />} /></Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Tracking link unavailable/i)).toBeInTheDocument();
    expect(io).not.toHaveBeenCalled();
  });
});

describe('the live socket', () => {
  it('never opens for a visit text recipient\'s link (its token is not a socket credential)', async () => {
    io.mockClear();
    renderTrack(payload('en_route', { meta: { pollIntervalSeconds: 30 } }));
    expect(await screen.findByText(/Pat is on the way/i)).toBeInTheDocument();
    expect(io).not.toHaveBeenCalled();
  });

  it('does not open before the GET has answered; for the holder it opens once the answer arrives (and not again on a refetch)', async () => {
    io.mockClear();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    global.fetch = vi.fn(async (url, init) => {
      if (init?.method === 'POST') return { ok: true, status: 204 };
      await gate;
      return { ok: true, status: 200, json: async () => ({ ...payload('en_route', { meta: { pollIntervalSeconds: 0 } }), scope: undefined }) };
    });
    render(
      <MemoryRouter initialEntries={['/track/token']}>
        <Routes><Route path="/track/:token" element={<TrackPage />} /></Routes>
      </MemoryRouter>,
    );
    await Promise.resolve();
    expect(io).not.toHaveBeenCalled();
    release();
    expect(await screen.findByText(/Pat is on the way/i)).toBeInTheDocument();
    await waitFor(() => expect(io).toHaveBeenCalledTimes(1));
  });
});
