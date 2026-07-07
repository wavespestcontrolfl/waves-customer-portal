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
  global.fetch = vi.fn((url) => {
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
    expect(await screen.findByText(/Service complete/i)).toBeInTheDocument();

    // The stale en_route response arrives late — it must be discarded.
    await act(async () => {
      fetchQueue[1].resolve(jsonResponse(trackBody('en_route')));
    });
    expect(screen.getByText(/Service complete/i)).toBeInTheDocument();
    expect(screen.queryByText(/TEXT ADAM/i)).not.toBeInTheDocument();
  });
});
