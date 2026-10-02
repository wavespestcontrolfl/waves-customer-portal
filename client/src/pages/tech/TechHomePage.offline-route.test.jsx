// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { etDateString } from '../../lib/timezone';
import { ROUTE_SNAPSHOT_KEY } from './routeSnapshot';

const mocks = vi.hoisted(() => ({ navigationBusy: vi.fn(), socketEvent: null }));
vi.mock('socket.io-client', () => ({ io: () => ({ on: (_event, callback) => { mocks.socketEvent = callback; }, off: vi.fn(), disconnect: vi.fn() }) }));
vi.mock('../../hooks/useFeatureFlag', () => ({ useFeatureFlag: () => false }));
vi.mock('../../components/tech/TechIntelligenceBar', () => ({ default: () => <div>Field assistant</div> }));
vi.mock('../../components/tech/GeofenceArrivalPrompt', () => ({ default: () => null }));
vi.mock('../../components/tech/CreateProjectModal', () => ({ default: () => null, wdoFeeSeedFromVisit: () => null }));
vi.mock('../../components/tech/TechTimeTrackingCard', () => ({ default: () => <div>Shift time</div> }));
vi.mock('../../components/tech/TechServicePhotosModal', () => ({ default: () => null }));
vi.mock('../../components/tech/TechTreatmentZoneModal', () => ({ default: () => null }));
vi.mock('../../components/tech/FieldLeadModal', () => ({ default: () => null }));
vi.mock('../../components/ServiceRecapModal', () => ({ default: () => null }));
vi.mock('./VisitBriefPanel', () => ({ default: ({ stop }) => <p>Property brief for {stop.primary.id}</p> }));
import TechHomePage from './TechHomePage';

const row = (id, overrides = {}) => ({ id, technicianId: 'tech-fixture', customerName: `Fixture ${id}`, address: '100 Example Lane', serviceType: 'Lawn care', scheduledDate: '2099-01-01', status: 'confirmed', windowStart: '09:00:00', windowEnd: '10:00:00', ...overrides });
const SAVED_AT = '2026-10-02T11:42:00.000Z';
let scheduleMode; // 'ok' | 'offline' | 'server-error' | 'hang'
let fetchMock;

function seedSnapshot(overrides = {}) {
  localStorage.setItem(ROUTE_SNAPSHOT_KEY, JSON.stringify({
    techId: 'tech-fixture', date: etDateString(), savedAt: SAVED_AT,
    data: { services: [row('saved-one'), row('saved-two', { status: 'en_route' })], rainChance: 55 },
    ...overrides,
  }));
}

function mount({ enabled = false, id = 'tech-fixture' } = {}) {
  localStorage.setItem('waves_admin_token', 'fixture-only');
  localStorage.setItem('waves_admin_user', JSON.stringify({ id, name: 'Fixture Technician', role: 'technician' }));
  return render(<MemoryRouter initialEntries={['/tech']}><Routes>
    <Route path="/tech" element={<Outlet context={{ fieldWorkspace: enabled, setNavigationBusy: mocks.navigationBusy }} />}>
      <Route index element={<TechHomePage />} />
    </Route>
  </Routes></MemoryRouter>);
}

beforeEach(() => {
  scheduleMode = 'ok';
  fetchMock = vi.fn(async (path) => {
    if (path.includes('/admin/schedule?')) {
      if (scheduleMode === 'offline') throw new TypeError('Failed to fetch');
      if (scheduleMode === 'hang') return new Promise(() => {});
      if (scheduleMode === 'server-error') return { ok: false, status: 503, json: async () => ({ error: 'Route connection unavailable' }) };
      return { ok: true, status: 200, json: async () => ({ services: [row('live-one'), row('foreign', { technicianId: 'other-tech' })], rainChance: 10, visitCloseout: true }) };
    }
    if (path.includes('/tech/line')) return { ok: true, status: 200, json: async () => ({ line: null }) };
    return { ok: true, status: 200, json: async () => ({}) };
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('saves the live route as this tech\'s snapshot for today', async () => {
  mount();
  await screen.findAllByText(/Fixture live-one/);
  await waitFor(() => expect(localStorage.getItem(ROUTE_SNAPSHOT_KEY)).toBeTruthy());
  const snapshot = JSON.parse(localStorage.getItem(ROUTE_SNAPSHOT_KEY));
  expect(snapshot).toMatchObject({ techId: 'tech-fixture', date: etDateString() });
  // Only this tech's own stops leave the page: the board payload carried a
  // foreign tech's row too.
  expect(snapshot.data.services.map((s) => s.id)).toEqual(['live-one']);
  expect(snapshot.data).toMatchObject({ rainChance: 10, visitCloseout: true });
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

it('shows the saved route with an offline notice when the network is unreachable', async () => {
  seedSnapshot();
  scheduleMode = 'offline';
  mount();
  await screen.findAllByText(/Fixture saved-one/);
  await screen.findByText('No connection — showing your route as saved at 7:42 AM. Changes since then are not shown.');
  expect(screen.getByRole('status')).toHaveTextContent('No connection');
  expect(screen.queryByText(/could not be loaded|Route failed to load/)).not.toBeInTheDocument();
  expect(screen.queryByText('Route unavailable — retry above.')).not.toBeInTheDocument();
  // Signal comes back: the refresh replaces the saved copy and drops the notice.
  scheduleMode = 'ok';
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await screen.findAllByText(/Fixture live-one/);
  await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  expect(screen.queryByText(/Fixture saved-one/)).not.toBeInTheDocument();
});

it('renders the saved route at once while the live request is still pending', async () => {
  seedSnapshot();
  scheduleMode = 'hang';
  mount();
  expect(screen.getAllByText(/Fixture saved-one/).length).toBeGreaterThan(0);
  expect(screen.getByRole('status')).toHaveTextContent('Refreshing your route — showing the copy saved at 7:42 AM.');
  expect(screen.queryByText('Loading your route…')).not.toBeInTheDocument();
});

it('keeps the real error when the server answered or the snapshot belongs to someone else', async () => {
  seedSnapshot();
  scheduleMode = 'server-error';
  mount();
  await screen.findByText('Route connection unavailable');
  expect(screen.getByText('Route connection unavailable').closest('[role="alert"]')).not.toBeNull();
  // Hydrated at mount, then the server answered with an error: the saved
  // copy leaves so stale stops never sit under a real error.
  await waitFor(() => expect(screen.queryByText(/Fixture saved-one/)).not.toBeInTheDocument());
  cleanup();

  localStorage.clear();
  seedSnapshot({ techId: 'other-tech' });
  scheduleMode = 'offline';
  mount();
  await screen.findByText(/Your route could not be loaded/);
  expect(screen.queryByText(/Fixture saved-one/)).not.toBeInTheDocument();
  cleanup();

  localStorage.clear();
  seedSnapshot({ date: '2000-01-01' });
  mount();
  await screen.findByText(/Your route could not be loaded/);
  expect(screen.queryByText(/Fixture saved-one/)).not.toBeInTheDocument();
});

it('falls back to the saved route when the live request times out', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  seedSnapshot();
  fetchMock.mockImplementation(async (path, options = {}) => {
    if (path.includes('/admin/schedule?')) {
      return new Promise((_, reject) => {
        options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    return { ok: true, status: 200, json: async () => ({ line: null }) };
  });
  mount();
  expect(screen.getByRole('status')).toHaveTextContent('Refreshing your route');
  await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
  await screen.findByText(/No connection — showing your route as saved at 7:42 AM/);
  expect(screen.getAllByText(/Fixture saved-two/).length).toBeGreaterThan(0);
});

it('shows the offline notice in the field layout too', async () => {
  seedSnapshot();
  scheduleMode = 'offline';
  mount({ enabled: true });
  await screen.findByText(/No connection — showing your route as saved at 7:42 AM/);
  expect(screen.getByRole('status')).toHaveTextContent('No connection');
  expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  expect(screen.getAllByText(/Fixture saved-one/).length).toBeGreaterThan(0);
  expect(screen.getByText('55% rain today')).toBeInTheDocument();
});
