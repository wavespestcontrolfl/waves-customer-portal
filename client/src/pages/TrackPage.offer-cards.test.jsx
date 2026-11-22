// @vitest-environment jsdom
// The completed-visit tracker shows the add-a-service card and the referral
// card from its payload (GATE_DOC_CROSS_SELL). Owner 2026-11-22: a track
// link is texted to the visit's contacts, so each card only opens the Waves
// app. This file pins the PAGE's wiring: the payload keys reach the cards,
// absent keys render nothing, and the page sends no card request.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TrackPage from './TrackPage';

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({ on: vi.fn(), off: vi.fn(), disconnect: vi.fn() })),
}));
vi.mock('@react-google-maps/api', () => ({
  useJsApiLoader: () => ({ isLoaded: false }),
  GoogleMap: () => null,
  Marker: () => null,
}));

const trackBody = (state, extra = {}) => ({
  state,
  tech: { firstName: 'Adam' },
  vehicle: null,
  property: null,
  window: null,
  service: { type: 'Pest Control' },
  summary: {},
  meta: { pollIntervalSeconds: 0 },
  ...extra,
});
const CARDS = {
  crossSell: { label: 'Lawn Care', relationship: 'add', perApplication: 62 },
  referral: { headline: 'Know someone who could use Waves?', cta: 'Send My Referral Link' },
};

let body;
beforeEach(() => {
  body = trackBody('complete', CARDS);
  global.fetch = vi.fn((url, init) => {
    if (init?.method === 'POST') return Promise.resolve({ ok: true, status: 204 });
    if (String(url).includes('/public/track/')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => body });
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const renderTrack = () => render(
  <MemoryRouter initialEntries={['/track/tok-1']}>
    <Routes>
      <Route path="/track/:token" element={<TrackPage />} />
    </Routes>
  </MemoryRouter>,
);

describe('TrackPage — add-a-service and referral cards on a completed visit', () => {
  it('shows both cards as links into the Waves app, with no token in either link', async () => {
    renderTrack();
    expect(await screen.findByRole('heading', { name: 'Add lawn care to your plan' })).toBeInTheDocument();
    expect(screen.getByText('$62 per application, priced for your home')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the Waves app' })).toHaveAttribute('href', '/?tab=billing');
    expect(screen.getByRole('link', { name: 'Send My Referral Link' })).toHaveAttribute('href', '/?tab=refer');
    // The page's only write is its view beacon: no card request leaves it.
    const posts = global.fetch.mock.calls.filter(([, init]) => init?.method === 'POST').map(([url]) => String(url));
    expect(posts.filter((url) => /cross-sell|referral/.test(url))).toEqual([]);
  });

  it('a payload with no card keys renders no card', async () => {
    body = trackBody('complete');
    renderTrack();
    expect(await screen.findByText(/Thanks for choosing Waves/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open the Waves app' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Send My Referral Link' })).not.toBeInTheDocument();
  });

  it('a visit that is not complete shows no card, whatever the payload carries', async () => {
    body = trackBody('en_route', CARDS);
    renderTrack();
    expect(await screen.findByText(/TEXT ADAM/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open the Waves app' })).not.toBeInTheDocument();
  });
});
