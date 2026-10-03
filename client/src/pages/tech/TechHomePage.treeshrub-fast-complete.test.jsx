// @vitest-environment jsdom
// Tree & Shrub Fast Complete routing (GATE_TS_FAST_COMPLETE + the per-tech
// flag): an open tree & shrub visit opens the one-screen sheet when
// `treeShrubFastCompleteEnabled` rides the schedule payload as true;
// everything else keeps today's route, the Dispatch typed-completion deep link.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ navigationBusy: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: () => ({ on: vi.fn(), off: vi.fn(), disconnect: vi.fn() }) }));
vi.mock('../../hooks/useFeatureFlag', () => ({ useFeatureFlag: () => false, useFeatureFlagReady: () => ({ enabled: false, ready: true }) }));
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
  default: ({ service, onFullForm }) => (
    <div>
      Tree and shrub sheet for {service.id}
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
  serviceType: 'Tree & Shrub Program',
  scheduledDate: '2099-01-01',
  status: 'confirmed',
  windowStart: '09:00:00',
  windowEnd: '10:00:00',
  completionProfile: { category: 'lawn_care', findingsType: 'tree_shrub' },
  ...overrides,
});

let rows;
let assign;

function mount() {
  localStorage.setItem('waves_admin_token', 'fixture-only');
  localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'tech-fixture', name: 'Fixture Technician', role: 'technician' }));
  return render(<MemoryRouter initialEntries={['/tech/tools']}><Routes>
    <Route path="/tech" element={<Outlet context={{ fieldWorkspace: true, setNavigationBusy: mocks.navigationBusy }} />}>
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

it('opens the Tree & Shrub Fast Complete sheet when the flag rides the schedule payload as true', async () => {
  rows = [row('svc-ts-on', { treeShrubFastCompleteEnabled: true })];
  mount();
  fireEvent.click(await screen.findByRole('button', { name: /Project Report/ }));
  expect(await screen.findByText('Tree and shrub sheet for svc-ts-on')).toBeInTheDocument();
  expect(assign).not.toHaveBeenCalled();
});

it('keeps today\'s Dispatch deep link when the flag is false or absent', async () => {
  rows = [row('svc-ts-off', { treeShrubFastCompleteEnabled: false })];
  mount();
  fireEvent.click(await screen.findByRole('button', { name: /Project Report/ }));
  expect(assign).toHaveBeenCalledWith('/admin/dispatch?tab=schedule&completeService=svc-ts-off');
  expect(screen.queryByText(/Tree and shrub sheet/)).not.toBeInTheDocument();
});

it('keeps the deep link for a typed visit that is not tree & shrub even with the flag on', async () => {
  rows = [row('svc-other-typed', { treeShrubFastCompleteEnabled: true, completionProfile: { category: 'pest_control', findingsType: 'palm_injection' } })];
  mount();
  fireEvent.click(await screen.findByRole('button', { name: /Project Report/ }));
  expect(assign).toHaveBeenCalledWith('/admin/dispatch?tab=schedule&completeService=svc-other-typed');
  expect(screen.queryByText(/Tree and shrub sheet/)).not.toBeInTheDocument();
});

it('sends the sheet\'s full-form escape to the Dispatch typed completion', async () => {
  rows = [row('svc-ts-escape', { treeShrubFastCompleteEnabled: true })];
  mount();
  fireEvent.click(await screen.findByRole('button', { name: /Project Report/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Sheet full form' }));
  expect(assign).toHaveBeenCalledWith('/admin/dispatch?tab=schedule&completeService=svc-ts-escape');
  expect(screen.queryByText(/Tree and shrub sheet/)).not.toBeInTheDocument();
});
