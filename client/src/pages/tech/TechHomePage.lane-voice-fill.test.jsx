// @vitest-environment jsdom
// Lane voice fill routing (GATE_LANE_VOICE_FILL, Fast Complete step 2): with
// `laneVoiceFillEnabled` and the report flow on the schedule row, a bed bug,
// fire ant, tick, bee & wasp, mud dauber or mosquito visit opens the Fast
// Complete sheet in its report flow, reading its own record, in place of the
// project editor; the sheet's Full form opens the project editor as before.
// A visit that completes through a project, a closed visit, or a row whose
// profile could not be read keeps the old path.
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
vi.mock('../../components/tech/CreateProjectModal', () => ({
  default: ({ defaultScheduledServiceId }) => <div>Project editor for {defaultScheduledServiceId}</div>,
  wdoFeeSeedFromVisit: () => null,
}));
vi.mock('../../components/tech/TechTimeTrackingCard', () => ({ default: () => <div>Shift time</div> }));
vi.mock('../../components/tech/TechServicePhotosModal', () => ({ default: () => null }));
vi.mock('../../components/tech/TechTreatmentZoneModal', () => ({ default: () => null }));
vi.mock('../../components/tech/FieldLeadModal', () => ({ default: () => null }));
vi.mock('../../components/ServiceRecapModal', () => ({ default: ({ service }) => <div>Existing recap form for {service.id}</div> }));
vi.mock('../../components/tech/FastCompleteSheet', () => ({
  default: ({ service, onFullForm }) => (
    <div data-testid="sheet" data-service={JSON.stringify(service)}>
      <button type="button" onClick={onFullForm}>Full form</button>
    </div>
  ),
}));
import TechHomePage from './TechHomePage';

const row = (id, overrides = {}) => ({
  id,
  technicianId: 'tech-fixture',
  technicianName: 'Fixture Technician',
  customerName: `Fixture ${id}`,
  address: '100 Example Lane',
  serviceType: 'Fire Ant Treatment',
  serviceTypeRaw: 'Fire Ant Treatment',
  scheduledDate: '2099-01-01',
  status: 'confirmed',
  windowStart: '09:00:00',
  windowEnd: '10:00:00',
  lat: 27.41,
  lng: -82.52,
  completionProfile: { category: 'specialty', serviceKey: 'fire_ant' },
  fastCompleteReportEnabled: true,
  laneVoiceFillEnabled: true,
  ...overrides,
});

let rows;

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
  vi.stubGlobal('fetch', vi.fn(async (path) => {
    if (path.includes('/admin/schedule?')) return { ok: true, status: 200, json: async () => ({ services: rows }) };
    return { ok: true, status: 200, json: async () => ({}) };
  }));
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

async function openFromTools() {
  fireEvent.click(await screen.findByRole('button', { name: /Project Report/ }));
}
const sheetService = async () => JSON.parse((await screen.findByTestId('sheet')).getAttribute('data-service'));

it('opens a lane visit in the report flow, reading its own lane, with no trace on the sheet', async () => {
  rows = [row('svc-fire-ant')];
  mount();
  await openFromTools();
  expect(await sheetService()).toMatchObject({
    id: 'svc-fire-ant', reportFlow: true, laneFlow: true, laneKey: 'fire_ant', traceEligible: false,
  });
  expect(screen.queryByText(/Project editor for/)).not.toBeInTheDocument();
});

it('the sheet\'s Full form opens the project editor, the path the visit had before', async () => {
  rows = [row('svc-fire-ant')];
  mount();
  await openFromTools();
  fireEvent.click(await screen.findByRole('button', { name: 'Full form' }));
  expect(await screen.findByText('Project editor for svc-fire-ant')).toBeInTheDocument();
  expect(screen.queryByTestId('sheet')).not.toBeInTheDocument();
});

it('a lane visit filed under pest control still opens as its lane, outline trace and all', async () => {
  rows = [row('svc-tick', {
    serviceType: 'Tick Control', serviceTypeRaw: 'Tick Control', traceVariant: 'outline',
    completionProfile: { category: 'pest_control', serviceKey: 'tick_control' },
  })];
  mount();
  await openFromTools();
  expect(await sheetService()).toMatchObject({ laneFlow: true, laneKey: 'tick_control', traceEligible: false });
  expect(screen.queryByText(/Existing recap form/)).not.toBeInTheDocument();
});

it.each([
  ['the lane switch off', { laneVoiceFillEnabled: false }],
  ['the switch absent (an older payload)', { laneVoiceFillEnabled: undefined }],
  ['the report flow off', { fastCompleteReportEnabled: false }],
  ['a project-backed profile', { completionProfile: { category: 'specialty', serviceKey: 'fire_ant', projectBacked: true, requiresProject: true } }],
  ['a profile that could not be read', { completionProfileLookupFailed: true }],
])('%s: the project editor, as before', async (_label, overrides) => {
  rows = [row('svc-old-path', overrides)];
  mount();
  await openFromTools();
  expect(await screen.findByText('Project editor for svc-old-path')).toBeInTheDocument();
  expect(screen.queryByTestId('sheet')).not.toBeInTheDocument();
});

it('a visit with a project already linked continues that project', async () => {
  rows = [row('svc-linked', { linkedProject: { id: 'project-fixture', status: 'draft' } })];
  mount();
  await openFromTools();
  await screen.findByText(/Project/);
  expect(screen.queryByTestId('sheet')).not.toBeInTheDocument();
});

it('a completed lane visit never opens the sheet', async () => {
  rows = [row('svc-done', { status: 'completed' })];
  mount('/tech/tools', { fieldWorkspace: false });
  await openFromTools();
  expect(screen.queryByTestId('sheet')).not.toBeInTheDocument();
});
