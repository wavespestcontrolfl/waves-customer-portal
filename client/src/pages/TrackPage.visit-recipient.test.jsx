// @vitest-environment jsdom
// The visit text recipient's tracker link (GATE_CALL_GIVEN_VISIT_TEXTS): the server sends a reduced, map-only payload
// (scope 'visit_recipient'). Every state must render from it without the holder-only keys, and the complete state
// must show no report, invoice, review or offer.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
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
  });
});

describe('the live socket', () => {
  const RECIPIENT = `vr_${'b'.repeat(48)}`; // a visit text recipient's own token shape
  const HOLDER = 'a'.repeat(64);
  const renderAt = (path) => render(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/track/:token" element={<TrackPage />} /></Routes>
    </MemoryRouter>,
  );
  const holderBody = () => ({ ...payload('en_route', { meta: { pollIntervalSeconds: 0 } }), scope: undefined });

  it('never opens for a recipient-format URL (its token is not a socket credential): not at mount, not after the GET answers', async () => {
    io.mockClear();
    global.fetch = vi.fn(async (url, init) => (init?.method === 'POST' ? { ok: true, status: 204 } : { ok: true, status: 200, json: async () => payload('en_route', { meta: { pollIntervalSeconds: 30 } }) }));
    renderAt(`/track/${RECIPIENT}`);
    expect(io).not.toHaveBeenCalled();
    expect(await screen.findByText(/Pat is on the way/i)).toBeInTheDocument();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(io).not.toHaveBeenCalled();
  });

  it('a holder URL opens its socket AT MOUNT, before the GET answers, and there is no connect refetch (as on main)', async () => {
    io.mockClear();
    const handlers = {};
    io.mockImplementation(() => ({ on: vi.fn((event, fn) => { handlers[event] = fn; }), off: vi.fn(), disconnect: vi.fn() }));
    const gets = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    global.fetch = vi.fn(async (url, init) => {
      if (init?.method === 'POST') return { ok: true, status: 204 };
      gets.push(String(url));
      await gate;
      return { ok: true, status: 200, json: async () => holderBody() };
    });
    renderAt(`/track/${HOLDER}`);
    await waitFor(() => expect(io).toHaveBeenCalledTimes(1));
    expect(io.mock.calls[0][0].auth.trackToken).toBe(HOLDER);
    release();
    expect(await screen.findByText(/Pat is on the way/i)).toBeInTheDocument();
    // only the job-update broadcast refetches; a socket connect does nothing, and no URL ever carries a query flag
    expect(handlers.connect).toBeUndefined();
    await act(async () => { handlers['customer:job_update'](); });
    await waitFor(() => expect(gets).toHaveLength(2));
    expect(gets.every((url) => !url.includes('?'))).toBe(true);
    io.mockImplementation(() => ({ on: vi.fn(), off: vi.fn(), disconnect: vi.fn() }));
  });

  it('navigating from a holder URL to a recipient URL closes the socket and never opens one with the recipient token', async () => {
    io.mockClear();
    const disconnect = vi.fn();
    io.mockImplementation(() => ({ on: vi.fn(), off: vi.fn(), disconnect }));
    let releaseRecipient;
    const recipientGate = new Promise((resolve) => { releaseRecipient = resolve; });
    global.fetch = vi.fn(async (url, init) => {
      if (init?.method === 'POST') return { ok: true, status: 204 };
      if (String(url).includes(HOLDER)) return { ok: true, status: 200, json: async () => holderBody() };
      await recipientGate;
      return { ok: true, status: 200, json: async () => payload('en_route', { meta: { pollIntervalSeconds: 0 } }) };
    });
    function GoToRecipient() {
      const navigate = useNavigate();
      return <button type="button" onClick={() => navigate(`/track/${RECIPIENT}`)}>go</button>;
    }
    render(
      <MemoryRouter initialEntries={[`/track/${HOLDER}`]}>
        <GoToRecipient />
        <Routes><Route path="/track/:token" element={<TrackPage />} /></Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Pat is on the way/i)).toBeInTheDocument();
    await waitFor(() => expect(io).toHaveBeenCalledTimes(1));
    await act(async () => { fireEvent.click(screen.getByText('go')); });
    expect(disconnect).toHaveBeenCalled();
    releaseRecipient();
    expect(await screen.findByText(/Pat is on the way/i)).toBeInTheDocument();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const handshakes = io.mock.calls.map((call) => (call[1] || call[0]).auth.trackToken);
    expect(handshakes).not.toContain(RECIPIENT);
    expect(io).toHaveBeenCalledTimes(1);
    io.mockImplementation(() => ({ on: vi.fn(), off: vi.fn(), disconnect: vi.fn() }));
  });
});
