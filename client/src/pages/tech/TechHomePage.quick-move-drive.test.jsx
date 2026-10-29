// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ navigationBusy: vi.fn(), socketEvent: null }));
vi.mock('socket.io-client', () => ({ io: () => ({ on: (_event, callback) => { mocks.socketEvent = callback; }, off: vi.fn(), disconnect: vi.fn() }) }));
vi.mock('../../hooks/useFeatureFlag', () => ({ useFeatureFlag: (key) => key === 'pest-recap-v1', useFeatureFlagReady: () => ({ enabled: false, ready: true }) }));
vi.mock('../../components/tech/TechIntelligenceBar', () => ({ default: () => <div>Field assistant</div> }));
vi.mock('../../components/tech/TechNoticeFeed', () => ({ default: ({ inlineScheduleChanges, placement }) => <div data-testid="floating-notices" data-inline={String(Boolean(inlineScheduleChanges))} data-placement={placement} /> }));
vi.mock('../../components/tech/CreateProjectModal', () => ({
  default: ({ onPendingPhotosChange, onCreated }) => <div role="dialog" aria-label="Create project fixture">
    <button onClick={() => onPendingPhotosChange(true)}>Queue report photo</button>
    <button onClick={() => onPendingPhotosChange(false)}>Clear report photos</button>
    <button onClick={() => onCreated({ id: 'created-report', status: 'draft' })}>Finish partial report</button>
  </div>,
  wdoFeeSeedFromVisit: () => null,
}));
vi.mock('../../components/tech/TechTimeTrackingCard', () => ({ default: () => <div>Shift time</div> }));
vi.mock('../../components/tech/TechServicePhotosModal', () => ({ default: ({ serviceId }) => <div>Photos for {serviceId}</div> }));
vi.mock('../../components/tech/TechTreatmentZoneModal', () => ({ default: () => null }));
vi.mock('../../components/tech/FieldLeadModal', () => ({ default: () => null }));
vi.mock('../../components/ServiceRecapModal', () => ({ default: () => <div>Existing recap form</div> }));
vi.mock('../admin/ProjectsPage', () => ({ ProjectDetail: ({ projectId, onDirtyChange, onClose }) => <div data-testid="project-detail" data-project-id={projectId}>
  <button onClick={() => onDirtyChange(true)}>Edit report</button>
  <button onClick={() => onDirtyChange(false)}>Save report</button>
  <button onClick={onClose}>Close report</button>
</div> }));
vi.mock('./VisitBriefPanel', () => ({ default: ({ stop, detail, onRetry, onPhotos, onBusyChange }) => <div>
  <p>Property brief for {stop.primary.id}</p>
  <p>{detail?.byService?.[stop.primary.id]?.brief?.facts?.access?.accessNotes}</p>
  {detail?.status === 'error' && <button onClick={onRetry}>Retry details</button>}
  <button onClick={() => onPhotos(stop.primary)}>Service photos</button>
  <button onClick={() => onBusyChange(true)}>Start contact action</button>
</div> }));
import TechHomePage from './TechHomePage';

// Quick Move sheet: a "Later today" option the server priced with
// GATE_TECH_MOVE_ROUTE_TIMES carries its added drive minutes; the guesses
// (no driveMinutes) read as before.
const row = (id) => ({ id, technicianId: 'tech-fixture', customerName: `Fixture ${id}`, address: '100 Example Lane', serviceType: 'Lawn care', scheduledDate: '2099-01-01', status: 'confirmed', windowStart: '09:00:00', windowEnd: '10:00:00' });
let sameDay;
let fetchMock;

function mount() {
  localStorage.setItem('waves_admin_token', 'fixture-only');
  localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'tech-fixture', name: 'Fixture Technician', role: 'technician' }));
  return render(<MemoryRouter initialEntries={['/admin/today?visit=row%3Aone']}><Routes>
    <Route path="/admin/today" element={<Outlet context={{ setNavigationBusy: mocks.navigationBusy, techRole: 'technician' }} />}>
      <Route index element={<TechHomePage />} />
    </Route>
  </Routes></MemoryRouter>);
}

beforeEach(() => {
  fetchMock = vi.fn(async (path) => {
    let data = {};
    if (path.includes('/admin/schedule?')) data = { services: [row('one')] };
    if (path.endsWith('/visit-brief')) data = { facts: { access: { accessNotes: 'Use the side gate' } } };
    if (path.includes('/tech/line')) data = { line: null };
    if (path.endsWith('/rain-out-options')) {
      data = { ok: true, sameDay, days: [], remainingRouteCount: 0, service: { window: { start: '09:00', end: '10:00' } }, today: {} };
    }
    return { ok: true, status: 200, json: async () => data };
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

const option = (start, end, display, extra = {}) => ({ kind: 'same_day', date: '2099-01-01', window: { start, end }, label: 'Later today', display, ...extra });

describe('Quick Move sheet shows the drive a later-today hour adds', () => {
  it('shows the added drive minutes next to the window when the server priced it', async () => {
    sameDay = [option('14:00', '15:00', 'Today, 2:00 PM-3:00 PM', { driveMinutes: 12 }), option('15:00', '16:00', 'Today, 3:00 PM-4:00 PM', { driveMinutes: 0 })];
    mount();
    await screen.findByText('Property brief for one');
    fireEvent.click(screen.getByRole('button', { name: 'Quick Move' }));
    expect(await screen.findByText(/Today, 2:00 PM-3:00 PM/)).toBeInTheDocument();
    expect(screen.getByText('· +12 min drive')).toBeInTheDocument();
    expect(screen.getByText('· +0 min drive')).toBeInTheDocument();
  });

  it('shows no drive text for the plain +2h and +4h guesses', async () => {
    sameDay = [option('14:00', '15:00', 'Today, 2:00 PM-3:00 PM')];
    mount();
    await screen.findByText('Property brief for one');
    fireEvent.click(screen.getByRole('button', { name: 'Quick Move' }));
    expect(await screen.findByText(/Today, 2:00 PM-3:00 PM/)).toBeInTheDocument();
    expect(screen.queryByText(/min drive/)).not.toBeInTheDocument();
  });
});
