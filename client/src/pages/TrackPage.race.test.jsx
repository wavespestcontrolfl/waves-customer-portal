// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TrackPage from './TrackPage';

// The socket only exists to trigger refetches; capture the job_update
// handler so the test can fire overlapping fetchTrack calls on demand.
let jobUpdateHandler = null;
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    on: (event, handler) => {
      if (event === 'customer:job_update') jobUpdateHandler = handler;
    },
    off: vi.fn(),
    disconnect: vi.fn(),
  })),
}));

vi.mock('@react-google-maps/api', () => ({
  useJsApiLoader: () => ({ isLoaded: false }),
  GoogleMap: () => null,
  Marker: () => null,
}));

function trackBody(state, extra = {}) {
  return {
    state,
    tech: { firstName: 'Adam' },
    vehicle: null,
    property: null,
    window: null,
    service: { type: 'Pest Control' },
    summary: {},
    meta: { pollIntervalSeconds: 0 },
    ...extra,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

let fetchQueue;
beforeEach(() => {
  jobUpdateHandler = null;
  fetchQueue = [];
  global.fetch = vi.fn((url, init) => {
    // The one-time page-view POST is a fire-and-forget write companion; it
    // must not enter the GET queue.
    if (init?.method === 'POST' && String(url).endsWith('/view')) {
      return Promise.resolve({ ok: true, status: 204 });
    }
    if (String(url).includes('/public/track/')) {
      const d = deferred();
      fetchQueue.push(d);
      return d.promise;
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderTrack() {
  return render(
    <MemoryRouter initialEntries={['/track/tok-1']}>
      <Routes>
        <Route path="/track/:token" element={<TrackPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('TrackPage fetch ordering (F-037)', () => {
  it('a stale slow response never overwrites a newer terminal state', async () => {
    renderTrack();

    // Initial mount fetch → en_route.
    await act(async () => {
      fetchQueue[0].resolve(jsonResponse(trackBody('en_route')));
    });
    expect(await screen.findByText(/TEXT ADAM/i)).toBeInTheDocument();
    expect(jobUpdateHandler).toBeTypeOf('function');

    // Request A: a poll-style refetch that will be slow to respond.
    await act(async () => { jobUpdateHandler(); });
    // Request B: a newer refetch (tech marked complete) that resolves first.
    await act(async () => { jobUpdateHandler(); });
    expect(fetchQueue).toHaveLength(3);

    await act(async () => {
      fetchQueue[2].resolve(jsonResponse(trackBody('complete')));
    });
    expect(await screen.findByText(/Thanks for choosing Waves/i)).toBeInTheDocument();

    // The stale en_route response arrives late — it must be discarded.
    await act(async () => {
      fetchQueue[1].resolve(jsonResponse(trackBody('en_route')));
    });
    expect(screen.getByText(/Thanks for choosing Waves/i)).toBeInTheDocument();
    expect(screen.queryByText(/TEXT ADAM/i)).not.toBeInTheDocument();
  });
});

describe('TrackPage page-view report', () => {
  const viewPosts = () => global.fetch.mock.calls.filter(([url, init]) => init?.method === 'POST' && String(url).endsWith('/public/track/tok-1/view'));

  it('POSTs /view once on the first successful load, never on polls or socket refetches', async () => {
    renderTrack();
    expect(viewPosts()).toHaveLength(0); // nothing before the first load lands
    await act(async () => {
      fetchQueue[0].resolve(jsonResponse(trackBody('en_route')));
    });
    expect(await screen.findByText(/TEXT ADAM/i)).toBeInTheDocument();
    expect(viewPosts()).toHaveLength(1);

    await act(async () => { jobUpdateHandler(); });
    await act(async () => {
      fetchQueue[1].resolve(jsonResponse(trackBody('en_route')));
    });
    expect(viewPosts()).toHaveLength(1);
  });

  it('does not report a view for a 404 token', async () => {
    renderTrack();
    await act(async () => {
      fetchQueue[0].resolve({ ok: false, status: 404, json: async () => ({}) });
    });
    expect(viewPosts()).toHaveLength(0);
  });
});

describe('TrackPage en-route partial coordinates', () => {
  it('a vehicle/property with lat but no lng renders without a NaN distance', async () => {
    renderTrack();
    await act(async () => {
      fetchQueue[0].resolve(jsonResponse(trackBody('en_route', {
        vehicle: { lat: 27.3, lng: null, lastReportedAt: new Date().toISOString() },
        property: { lat: 27.4, lng: null },
      })));
    });
    expect(await screen.findByText(/TEXT ADAM/i)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/NaN/);
  });
});
