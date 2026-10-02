// @vitest-environment jsdom
// Lawn re-service Fast Complete routing (GATE_LAWN_RESERVICE_FAST_COMPLETE): an
// open lawn_re_service visit (a typed one_time_lawn_treatment completion) opens
// the one-screen sheet when `lawnReserviceFastCompleteEnabled` rides the
// schedule payload as true; everything else keeps today's route, the Dispatch
// typed-completion deep link.
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
vi.mock('../../components/ServiceRecapModal', () => ({ default: () => null }));
vi.mock('../../components/tech/FastCompleteSheet', () => ({ default: () => null }));
vi.mock('../../components/tech/FastCompleteTreeShrubSheet', () => ({
  default: ({ service }) => <div>Tree and shrub sheet for {service.id}</div>,
}));
vi.mock('../../components/tech/FastCompleteLawnReserviceSheet', () => ({
  default: ({ service, onFullForm }) => (
    <div>
      Lawn re-service sheet for {service.id}
      <button type="button" onClick={onFullForm}>Sheet full form</button>
    </div>
  ),
}));
import TechHomePage from './TechHomePage';

const row = (id, overrides = {}) => ({
  id,
  technicianId: 'tech-fixture',
  customerName: `Fixture ${id}`,
  address: '100 Example Lane',
  serviceType: 'Lawn Care Re-Service',
  scheduledDate: '2099-01-01',
  status: 'confirmed',
  windowStart: '09:00:00',
  windowEnd: '10:00:00',
  completionProfile: { category: 'lawn_care', serviceKey: 'lawn_re_service', findingsType: 'one_time_lawn_treatment' },
  ...overrides,
});

let rows;
let assign;

function mount(path = '/admin/today/tools', { fieldWorkspace = true } = {}) {
  localStorage.setItem('waves_admin_token', 'fixture-only');
  localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'tech-fixture', name: 'Fixture Technician', role: 'technician' }));
  return render(<MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/admin/today" element={<Outlet context={{ fieldWorkspace, setNavigationBusy: mocks.navigationBusy }} />}>
      <Route index element={<TechHomePage />} />
      <Route path="tools" element={<TechHomePage section="tools" />} />
    </Route>
  </Routes></MemoryRouter>);
}

beforeEach(() => {
  mocks.navigationBusy.mockClear();
  assign = vi.fn();
  vi.stubGlobal('location', { ...window.location, assign });
  vi.stubGlobal('fetch', vi.fn(async (path) => {
    if (path.includes('/admin/schedule?')) return { ok: true, status: 200, json: async () => ({ services: rows }) };
    return { ok: true, status: 200, json: async () => ({}) };
  }));
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

it('opens the lawn re-service Fast Complete sheet when the gate rides the schedule payload as true', async () => {
  rows = [row('svc-lawn-on', { lawnReserviceFastCompleteEnabled: true })];
  mount();
  fireEvent.click(await screen.findByRole('button', { name: /Project Report/ }));
  expect(await screen.findByText('Lawn re-service sheet for svc-lawn-on')).toBeInTheDocument();
  expect(assign).not.toHaveBeenCalled();
});

it('keeps today\'s Dispatch deep link when the gate is false or absent', async () => {
  rows = [row('svc-lawn-off', { lawnReserviceFastCompleteEnabled: false }), row('svc-lawn-absent')];
  mount();
  fireEvent.click(await screen.findByRole('button', { name: /Project Report/ }));
  // Two open services: the picker lists them, and the tapped row goes to the deep link.
  fireEvent.click(await screen.findByText('Fixture svc-lawn-off'));
  expect(assign).toHaveBeenCalledWith('/admin/dispatch?tab=schedule&completeService=svc-lawn-off');
  expect(screen.queryByText(/Lawn re-service sheet/)).not.toBeInTheDocument();
});

it('keeps the deep link for a typed lawn visit that is not a re-service even with the gate on', async () => {
  rows = [row('svc-lawn-onetime', {
    lawnReserviceFastCompleteEnabled: true,
    serviceType: 'One-Time Lawn Treatment',
    completionProfile: { category: 'lawn_care', serviceKey: 'lawn_care_one_time', findingsType: 'one_time_lawn_treatment' },
  })];
  mount();
  fireEvent.click(await screen.findByRole('button', { name: /Project Report/ }));
  expect(assign).toHaveBeenCalledWith('/admin/dispatch?tab=schedule&completeService=svc-lawn-onetime');
  expect(screen.queryByText(/Lawn re-service sheet/)).not.toBeInTheDocument();
});

it('does not route a pest re-service or a tree & shrub visit to the lawn sheet', async () => {
  rows = [row('svc-ts', {
    lawnReserviceFastCompleteEnabled: true,
    completionProfile: { category: 'lawn_care', serviceKey: 'tree_shrub_program', findingsType: 'tree_shrub' },
  })];
  mount();
  fireEvent.click(await screen.findByRole('button', { name: /Project Report/ }));
  expect(assign).toHaveBeenCalledWith('/admin/dispatch?tab=schedule&completeService=svc-ts');
  expect(screen.queryByText(/Lawn re-service sheet/)).not.toBeInTheDocument();
});

it('keeps a completed re-service on the Dispatch route (nothing to complete) even with the gate on', async () => {
  const alertMock = vi.fn();
  vi.stubGlobal('alert', alertMock);
  rows = [row('svc-lawn-done', { lawnReserviceFastCompleteEnabled: true, status: 'completed' })];
  mount('/admin/today/tools', { fieldWorkspace: false });
  fireEvent.click(await screen.findByRole('button', { name: /Project Report/ }));
  expect(alertMock).toHaveBeenCalledWith('This visit is already completed — nothing to complete.');
  expect(screen.queryByText(/Lawn re-service sheet/)).not.toBeInTheDocument();
  expect(assign).not.toHaveBeenCalled();
});

it('sends the sheet\'s full-form escape to the Dispatch typed completion', async () => {
  rows = [row('svc-lawn-escape', { lawnReserviceFastCompleteEnabled: true })];
  mount();
  fireEvent.click(await screen.findByRole('button', { name: /Project Report/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Sheet full form' }));
  expect(assign).toHaveBeenCalledWith('/admin/dispatch?tab=schedule&completeService=svc-lawn-escape');
  expect(screen.queryByText(/Lawn re-service sheet/)).not.toBeInTheDocument();
});
