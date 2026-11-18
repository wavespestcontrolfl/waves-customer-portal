// @vitest-environment jsdom
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
  useJsApiLoader: () => ({ isLoaded: false }), GoogleMap: () => null, Marker: () => null,
}));

function payload(state, extra = {}) {
  return {
    state,
    tech: null,
    property: null,
    window: null,
    service: { type: 'Lawn Care' },
    summary: {},
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

describe('TrackPage changed-visit recovery', () => {
  it('gives a Quick Move customer one authenticated path to pick a new day', async () => {
    renderTrack(payload('scheduled', {
      visitChange: {
        kind: 'customer_pick', stage: 'awaiting_customer', nextActor: 'customer',
        reason: 'Rain interrupted the route for this visit.', pickBy: '2026-11-20T01:00:00.000Z', deadlinePassed: false,
        current: null,
        action: { kind: 'portal_visits', href: '/?tab=schedule', label: 'Open Visits' },
      },
    }));
    expect(await screen.findByRole('heading', { name: /Your lawn care visit needs a new time/i })).toBeInTheDocument();
    expect(screen.getByText('Rain interrupted the route for this visit.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Visits' })).toHaveAttribute('href', '/?tab=schedule');
    expect(screen.getByRole('link', { name: 'Call Waves' })).toHaveAttribute('href', 'tel:+19412975749');
    expect(screen.getByRole('link', { name: 'Text Waves' })).toHaveAttribute('href', 'sms:+19412975749');
    expect(screen.queryByText(/we'll book|we'll text|by Fri/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/your lawn care is booked/i)).not.toBeInTheDocument();
  });

  it('shows the replacement with normal route and prep content, without another action', async () => {
    renderTrack(payload('scheduled', {
      tech: { firstName: 'Mia' },
      prepToken: 'prep-token-1',
      stopsAhead: 2,
      routeProgress: { yourStop: 4, totalStops: 7, currentStop: 1, atStop: false, headingToStop: false },
      visitChange: {
        kind: 'customer_pick', stage: 'booked', nextActor: 'none',
        reason: 'Rain interrupted the route for this visit.',
        current: { date: '2026-11-24', windowStart: '13:00' }, action: null,
      },
    }));
    expect(await screen.findByRole('heading', { name: /Your new lawn care visit is booked/i })).toBeInTheDocument();
    expect(screen.getByText('Rain interrupted the route for this visit.')).toBeInTheDocument();
    expect(screen.getByText('stops before yours')).toBeInTheDocument();
    expect(screen.getByText(/You'll get a text as soon as Mia is on the way/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View prep instructions' })).toHaveAttribute('href', '/prep/prep-token-1');
    expect(screen.queryByRole('link', { name: 'Open Visits' })).not.toBeInTheDocument();
  });

  it('shows a proven day-only replacement date when optional handoff history is unavailable', async () => {
    renderTrack(payload('scheduled', {
      window: { date: '2026-11-25', start: null, end: null },
      visitChange: null,
    }));
    expect(await screen.findByRole('heading', {
      name: /your lawn care is booked for Wednesday, November 25/i,
    })).toBeInTheDocument();
    expect(screen.queryByText(/\d{1,2}:\d{2}/)).not.toBeInTheDocument();
  });

  it('routes a missed visit to the office by call or text', async () => {
    renderTrack(payload('no_show', { customerFirstName: 'Dana', visitChange: { kind: 'missed', nextActor: 'office' } }));
    expect(await screen.findByRole('heading', { name: /We missed you, Dana/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Call Waves' })).toHaveAttribute('href', 'tel:+19412975749');
    expect(screen.getByRole('link', { name: 'Text Waves' })).toHaveAttribute('href', 'sms:+19412975749');
    expect(screen.queryByText('Call to reschedule')).not.toBeInTheDocument();
  });

  it('treats an operational reschedule as office-owned and hides its abandoned window', async () => {
    renderTrack(payload('scheduled', {
      window: { start: '2026-11-18T09:00:00', end: '2026-11-18T11:00:00' },
      visitChange: { kind: 'pending_rebook', nextActor: 'office' },
    }));
    expect(await screen.findByRole('heading', { name: /We're finding you a new time for your lawn care visit/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Call Waves' })).toHaveAttribute('href', 'tel:+19412975749');
    expect(screen.getByRole('link', { name: 'Text Waves' })).toHaveAttribute('href', 'sms:+19412975749');
    expect(screen.queryByText(/booked for/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/9:00|11:00/i)).not.toBeInTheDocument();
  });

  it('treats a skip as no service and no make-up, with the next regular date', async () => {
    renderTrack(payload('cancelled', {
      visitChange: { kind: 'skipped', nextActor: 'none', nextVisit: { date: '2026-12-16' } },
    }));
    expect(await screen.findByRole('heading', { name: /This lawn care visit was skipped/i })).toBeInTheDocument();
    expect(screen.getByText(/no make-up visit is being added/i)).toBeInTheDocument();
    expect(screen.getByText(/Your next regular visit is Wednesday, December 16/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /reschedule/i })).not.toBeInTheDocument();
  });
});
