// @vitest-environment jsdom
// Typed voice fill routing (GATE_TYPED_VOICE_FILL, Fast Complete step 3): with
// `typedReportFlowEnabled` on the schedule row, a typed visit whose form the
// reader reads (cockroach, flea, inspections, rodent, ...) opens the Fast
// Complete sheet in its report flow, reading its own record, in place of the
// Dispatch typed form; the sheet's Full form opens that typed form. A visit
// closed out as a whole visit, one that completes through a project, a row
// whose profile or form could not be read, or a closed visit keeps the old
// path, and so does a station visit while the tech's station map is on or
// not yet known (the sheet carries no map).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ navigationBusy: vi.fn(), stationMap: { enabled: false, ready: true } }));
vi.mock('socket.io-client', () => ({ io: () => ({ on: vi.fn(), off: vi.fn(), disconnect: vi.fn() }) }));
vi.mock('../../hooks/useFeatureFlag', () => ({
  useFeatureFlag: () => false,
  useFeatureFlagReady: (key) => (key === 'station-map-v1' ? mocks.stationMap : { enabled: false, ready: true }),
}));
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

const ROACH_SCHEMA = {
  type: 'cockroach',
  label: 'Cockroach',
  fields: [{ key: 'species', label: 'Species', type: 'select', options: ['German', 'American'], required: true }],
};
const row = (id, overrides = {}) => ({
  id,
  technicianId: 'tech-fixture',
  technicianName: 'Fixture Technician',
  customerName: `Fixture ${id}`,
  address: '100 Example Lane',
  serviceType: 'Cockroach Control',
  serviceTypeRaw: 'Cockroach Control',
  scheduledDate: '2099-01-01',
  status: 'confirmed',
  windowStart: '09:00:00',
  windowEnd: '10:00:00',
  lat: 27.41,
  lng: -82.52,
  completionProfile: { category: 'pest_control', serviceKey: 'cockroach_control', findingsType: 'cockroach' },
  findingsSchema: ROACH_SCHEMA,
  typedReportFlowEnabled: true,
  ...overrides,
});

let rows;
let assign;

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
  mocks.stationMap = { enabled: false, ready: true };
  assign = vi.fn();
  vi.stubGlobal('location', { ...window.location, assign });
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
const TYPED_FORM = (id) => `/admin/dispatch?tab=schedule&completeService=${id}`;

it('opens a typed visit in the report flow, reading its own form, with no trace on the sheet', async () => {
  rows = [row('svc-roach')];
  mount();
  await openFromTools();
  expect(await sheetService()).toMatchObject({
    id: 'svc-roach', reportFlow: true, typedFlow: true, typedType: 'cockroach', typedSchema: ROACH_SCHEMA, laneFlow: false, traceEligible: false,
  });
  expect(assign).not.toHaveBeenCalled();
});

it.each([
  ['a pest inspection with a credit available', { completionProfile: { category: 'inspection', serviceKey: 'pest_inspection', findingsType: 'pest_inspection' }, findingsSchema: { ...ROACH_SCHEMA, type: 'pest_inspection' }, inspectionCreditAvailable: true }, true],
  ['a rodent inspection with a credit available', { completionProfile: { category: 'rodent', serviceKey: 'rodent_inspection', findingsType: 'rodent_inspection' }, findingsSchema: { ...ROACH_SCHEMA, type: 'rodent_inspection' }, inspectionCreditAvailable: true }, true],
  ['an inspection with no credit available', { completionProfile: { category: 'inspection', serviceKey: 'pest_inspection', findingsType: 'pest_inspection' }, findingsSchema: { ...ROACH_SCHEMA, type: 'pest_inspection' } }, false],
  ['a treatment visit', { inspectionCreditAvailable: true }, false],
])('%s: the sheet offers the inspection credit: %s', async (_label, overrides, offered) => {
  rows = [row('svc-credit', overrides)];
  mount();
  await openFromTools();
  expect((await sheetService()).inspectionCredit).toBe(offered);
});

it('the sheet\'s Full form opens the visit\'s own typed form', async () => {
  rows = [row('svc-roach')];
  mount();
  await openFromTools();
  fireEvent.click(await screen.findByRole('button', { name: 'Full form' }));
  expect(assign).toHaveBeenCalledWith(TYPED_FORM('svc-roach'));
});

it.each([
  ['the switch off', { typedReportFlowEnabled: false }],
  ['the switch absent (an older payload)', { typedReportFlowEnabled: undefined }],
  ['a profile that could not be read', { completionProfileLookupFailed: true }],
  ['a project-backed profile', { completionProfile: { category: 'pest_control', serviceKey: 'cockroach_control', findingsType: 'cockroach', projectBacked: true } }],
  ['a form that does not match the profile', { findingsSchema: { ...ROACH_SCHEMA, type: 'flea' } }],
  ['no form on the row', { findingsSchema: null }],
  ['a visit closed out as a whole visit', { visitId: 'visit-fixture', visitCloseoutEnabled: true }],
])('%s: the typed form, as before', async (_label, overrides) => {
  rows = [row('svc-old-path', overrides)];
  mount();
  await openFromTools();
  await vi.waitFor(() => expect(assign).toHaveBeenCalledWith(TYPED_FORM('svc-old-path')));
  expect(screen.queryByTestId('sheet')).not.toBeInTheDocument();
});

it('a completed typed visit never opens the sheet', async () => {
  vi.stubGlobal('alert', vi.fn());
  rows = [row('svc-done', { status: 'completed' })];
  mount('/tech/tools', { fieldWorkspace: false });
  await openFromTools();
  expect(screen.queryByTestId('sheet')).not.toBeInTheDocument();
});

const STATION_VISITS = [
  ['a termite bait station check', { serviceType: 'Termite Monitoring', serviceTypeRaw: 'Termite Monitoring', completionProfile: { category: 'termite', serviceKey: 'termite_monitoring', findingsType: 'termite_bait_station' }, findingsSchema: { ...ROACH_SCHEMA, type: 'termite_bait_station' } }],
  ['a rodent bait station visit', { serviceType: 'Rodent Bait Stations', serviceTypeRaw: 'Rodent Bait Stations', completionProfile: { category: 'rodent', serviceKey: 'rodent_bait_quarterly', findingsType: 'rodent_bait_station' }, findingsSchema: { ...ROACH_SCHEMA, type: 'rodent_bait_station' } }],
  ['a trap check', { serviceType: 'Rodent Trapping Follow-up', serviceTypeRaw: 'Rodent Trapping Follow-up', completionProfile: { category: 'rodent', serviceKey: 'rodent_trapping', findingsType: 'rodent_trapping' }, findingsSchema: { ...ROACH_SCHEMA, type: 'rodent_trapping' } }],
];

it.each(STATION_VISITS)('%s opens the sheet, reading its own form, while the tech\'s station map is off', async (_label, overrides) => {
  rows = [row('svc-station', overrides)];
  mount();
  await openFromTools();
  expect(await sheetService()).toMatchObject({ id: 'svc-station', reportFlow: true, typedFlow: true, typedType: overrides.completionProfile.findingsType });
  expect(assign).not.toHaveBeenCalled();
});

it.each([
  ['on', { enabled: true, ready: true }],
  ['not yet loaded', { enabled: false, ready: false }],
])('with the tech\'s station map %s, a station visit keeps the typed form, which records every station (Codex P1 on #5638)', async (_label, stationMap) => {
  mocks.stationMap = stationMap;
  for (const [, overrides] of STATION_VISITS) {
    rows = [row('svc-station', overrides)];
    assign.mockClear();
    const view = mount();
    await openFromTools();
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith(TYPED_FORM('svc-station')));
    expect(screen.queryByTestId('sheet')).not.toBeInTheDocument();
    view.unmount();
  }
});

it('a visit without stations opens the sheet with the station map on', async () => {
  mocks.stationMap = { enabled: true, ready: true };
  rows = [row('svc-roach')];
  mount();
  await openFromTools();
  expect(await sheetService()).toMatchObject({ id: 'svc-roach', typedFlow: true, typedType: 'cockroach' });
});
