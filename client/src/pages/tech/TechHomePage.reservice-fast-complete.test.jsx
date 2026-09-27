// @vitest-environment jsdom
// Fast Complete routing (PR C, GATE_RESERVICE_FAST_COMPLETE): a pest
// re-service (completionProfile.serviceKey === 'pest_re_service') opens the
// one-screen FastCompleteSheet when the gate rides the schedule payload as
// true; everything else — the gate off, or any other pest_control service —
// opens today's ServiceRecapModal, unchanged.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ navigationBusy: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: () => ({ on: vi.fn(), off: vi.fn(), disconnect: vi.fn() }) }));
vi.mock('../../hooks/useFeatureFlag', () => ({ useFeatureFlag: () => false }));
vi.mock('../../components/tech/TechIntelligenceBar', () => ({ default: () => <div>Field assistant</div> }));
vi.mock('../../components/tech/GeofenceArrivalPrompt', () => ({ default: () => null }));
vi.mock('../../components/tech/CreateProjectModal', () => ({ default: () => null, wdoFeeSeedFromVisit: () => null }));
vi.mock('../../components/tech/TechTimeTrackingCard', () => ({ default: () => <div>Shift time</div> }));
vi.mock('../../components/tech/TechServicePhotosModal', () => ({ default: () => null }));
vi.mock('../../components/tech/TechTreatmentZoneModal', () => ({ default: () => null }));
vi.mock('../../components/tech/FieldLeadModal', () => ({ default: () => null }));
vi.mock('../../components/ServiceRecapModal', () => ({ default: ({ service }) => <div>Existing recap form for {service.id}</div> }));
vi.mock('../../components/tech/FastCompleteSheet', () => ({ default: ({ service }) => <div>Fast Complete sheet for {service.id}</div> }));
import TechHomePage from './TechHomePage';

const row = (id, overrides = {}) => ({
  id,
  technicianId: 'tech-fixture',
  customerName: `Fixture ${id}`,
  address: '100 Example Lane',
  serviceType: 'Pest Re-Service',
  scheduledDate: '2099-01-01',
  status: 'confirmed',
  windowStart: '09:00:00',
  windowEnd: '10:00:00',
  completionProfile: { category: 'pest_control', serviceKey: 'pest_re_service' },
  ...overrides,
});

let rows;
let fetchMock;

function mount(path = '/tech/tools', { fieldWorkspace = true } = {}) {
  localStorage.setItem('waves_admin_token', 'fixture-only');
  localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'tech-fixture', name: 'Fixture Technician', role: 'technician' }));
  return render(<MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/tech" element={<Outlet context={{ fieldWorkspace, setNavigationBusy: mocks.navigationBusy }} />}>
      <Route index element={<TechHomePage />} />
      <Route path="tools" element={<TechHomePage section="tools" />} />
    </Route>
  </Routes></MemoryRouter>);
}

beforeEach(() => {
  mocks.navigationBusy.mockClear();
  fetchMock = vi.fn(async (path) => {
    if (path.includes('/admin/schedule?')) {
      return { ok: true, status: 200, json: async () => ({ services: rows }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

it('opens the Fast Complete sheet for a pest re-service when the gate rides the schedule payload as true', async () => {
  rows = [row('svc-gate-on', { reserviceFastCompleteEnabled: true })];
  mount();
  fireEvent.click(await screen.findByRole('button', { name: /Project Report/ }));
  expect(await screen.findByText('Fast Complete sheet for svc-gate-on')).toBeInTheDocument();
  expect(screen.queryByText(/Existing recap form/)).not.toBeInTheDocument();
});

it('opens the existing ServiceRecapModal for the same job when the gate is off', async () => {
  rows = [row('svc-gate-off', { reserviceFastCompleteEnabled: false })];
  mount();
  fireEvent.click(await screen.findByRole('button', { name: /Project Report/ }));
  expect(await screen.findByText('Existing recap form for svc-gate-off')).toBeInTheDocument();
  expect(screen.queryByText(/Fast Complete sheet/)).not.toBeInTheDocument();
});

it('opens the existing ServiceRecapModal for a non-re-service pest job even when the gate is on', async () => {
  rows = [row('svc-not-reservice', {
    reserviceFastCompleteEnabled: true,
    completionProfile: { category: 'pest_control', serviceKey: 'general_pest_control' },
  })];
  mount();
  fireEvent.click(await screen.findByRole('button', { name: /Project Report/ }));
  expect(await screen.findByText('Existing recap form for svc-not-reservice')).toBeInTheDocument();
  expect(screen.queryByText(/Fast Complete sheet/)).not.toBeInTheDocument();
});

it('keeps a completed re-service on the recap editor even with the gate on', async () => {
  // The legacy workspace lists completed rows; a completed visit is edited
  // through the recap path, which updates its existing record.
  rows = [row('svc-completed', { reserviceFastCompleteEnabled: true, status: 'completed' })];
  mount('/tech/tools', { fieldWorkspace: false });
  fireEvent.click(await screen.findByRole('button', { name: /Project Report/ }));
  expect(await screen.findByText('Existing recap form for svc-completed')).toBeInTheDocument();
  expect(screen.queryByText(/Fast Complete sheet/)).not.toBeInTheDocument();
});
