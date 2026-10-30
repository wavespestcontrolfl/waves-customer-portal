// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ navigationBusy: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: () => ({ on: vi.fn(), off: vi.fn(), disconnect: vi.fn() }) }));
vi.mock('../../hooks/useFeatureFlag', () => ({ useFeatureFlag: (key) => key === 'pest-recap-v1', useFeatureFlagReady: () => ({ enabled: false, ready: true }) }));
vi.mock('../../components/tech/TechIntelligenceBar', () => ({ default: () => <div>Field assistant</div> }));
vi.mock('../../components/tech/TechNoticeFeed', () => ({ default: () => <div /> }));
vi.mock('../../components/tech/CreateProjectModal', () => ({ default: () => null, wdoFeeSeedFromVisit: () => null }));
vi.mock('../../components/tech/TechTimeTrackingCard', () => ({ default: () => <div>Shift time</div> }));
vi.mock('../../components/tech/TechServicePhotosModal', () => ({ default: () => null }));
vi.mock('../../components/tech/TechTreatmentZoneModal', () => ({ default: () => null }));
vi.mock('../../components/tech/FieldLeadModal', () => ({ default: () => null }));
vi.mock('../../components/ServiceRecapModal', () => ({ default: () => null }));
vi.mock('../admin/ProjectsPage', () => ({ ProjectDetail: () => null }));
vi.mock('./VisitBriefPanel', () => ({ default: ({ stop }) => <p>Property brief for {stop.primary.id}</p> }));
import TechHomePage from './TechHomePage';

// Tech Home Quick Move: a result that needs follow-up stays on screen until the
// tech dismisses it, exactly like the dispatch Details flow.
const row = (id, name) => ({ id, technicianId: 'tech-fixture', customerName: name, address: '100 Example Lane', serviceType: 'Lawn care', scheduledDate: '2099-01-01', status: 'confirmed', windowStart: '09:00:00', windowEnd: '10:00:00' });
let commitBody;
let fetchMock;
let scheduleReads;

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
  scheduleReads = 0;
  commitBody = null;
  fetchMock = vi.fn(async (path, init) => {
    let data = {};
    if (path.includes('/admin/schedule?')) { scheduleReads += 1; data = { services: [row('one', 'Ames Fixture'), row('two', 'Baker Fixture')] }; }
    if (path.endsWith('/visit-brief')) data = { facts: { access: { accessNotes: 'Use the side gate' } } };
    if (path.includes('/tech/line')) data = { line: null };
    if (path.endsWith('/rain-out-options')) {
      data = {
        ok: true, days: [], remainingRouteCount: 1, service: { window: { start: '09:00', end: '10:00' } }, today: {},
        sameDay: [{ kind: 'same_day', date: '2099-01-01', window: { start: '14:00', end: '15:00' }, label: 'Later today', display: 'Today, 2:00 PM-3:00 PM' }],
      };
    }
    if (path.endsWith('/rain-out') && init?.method === 'POST') data = commitBody;
    return { ok: true, status: 200, json: async () => data };
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

const commits = () => fetchMock.mock.calls.filter(([path, init]) => String(path).endsWith('/rain-out') && init?.method === 'POST');

async function openAndMove() {
  mount();
  await screen.findByText('Property brief for one');
  fireEvent.click(screen.getByRole('button', { name: 'Quick Move' }));
  await screen.findByText(/Today, 2:00 PM-3:00 PM/);
  fireEvent.click(screen.getByRole('button', { name: /^Move this stop/ }));
}

describe('Tech Home Quick Move result', () => {
  it('keeps a partial move open, names the stop to follow up, and locks a second Move until dismissed', async () => {
    commitBody = {
      ok: true, movedCount: 1, failedCount: 1,
      results: [{ id: 'one', ok: true, smsSent: true }, { id: 'two', ok: false, error: 'slot taken' }],
    };
    await openAndMove();
    const result = await screen.findByTestId('quick-move-result');
    expect(result).toHaveTextContent('Moved 1 stop to Today, 2:00 PM-3:00 PM, customer texted.');
    expect(result).toHaveTextContent('1 stop could not be moved');
    expect(result).toHaveTextContent('Baker Fixture: Not moved — review dispatch');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    const move = screen.getByRole('button', { name: 'Moved' });
    expect(move).toBeDisabled();
    fireEvent.click(move);
    expect(commits()).toHaveLength(1);
    // The route behind the sheet refreshed for the stop that did move.
    await waitFor(() => expect(scheduleReads).toBeGreaterThan(1));

    // Nothing dismisses it on its own.
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      await act(async () => { vi.advanceTimersByTime(7000); });
    } finally {
      vi.useRealTimers();
    }
    expect(screen.getByTestId('quick-move-result')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByTestId('quick-move-result')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps a customer-not-texted result and an overlap warning open with their detail', async () => {
    commitBody = {
      ok: true, movedCount: 1, failedCount: 0, overlapCount: 1,
      overlapWarnings: ['2099-01-01 overlaps another appointment.'],
      results: [{ id: 'one', ok: true, smsSent: false, warnings: ['2099-01-01 overlaps another appointment.'] }],
    };
    await openAndMove();
    const result = await screen.findByTestId('quick-move-result');
    expect(result).toHaveTextContent('customer NOT texted');
    expect(result).toHaveTextContent('2099-01-01 overlaps another appointment. Check the route on that day.');
    expect(result).toHaveTextContent('Ames Fixture: Customer not texted — follow up manually; 2099-01-01 overlaps another appointment.');
    expect(screen.getByRole('button', { name: 'Moved' })).toBeDisabled();
  });

  it('closes a clean move and shows the short banner', async () => {
    commitBody = { ok: true, movedCount: 1, failedCount: 0, results: [{ id: 'one', ok: true, smsSent: true }] };
    await openAndMove();
    expect(await screen.findByText('Moved 1 stop to Today, 2:00 PM-3:00 PM, customer texted')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quick-move-result')).not.toBeInTheDocument();
  });
});
