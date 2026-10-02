// @vitest-environment jsdom
// Fast Complete report flow routing (GATE_FAST_COMPLETE_REPORT): with
// `fastCompleteReportEnabled` on the schedule row, every open untyped pest
// visit (a regular visit or a re-service) opens the one-screen sheet in its
// report flow, carrying what its trace step needs. Off, a regular pest visit
// keeps the recap modal and a re-service keeps the re-service sheet's own
// routing; a closed visit stays on the recap editor either way.
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
vi.mock('../../components/tech/FastCompleteSheet', () => ({
  default: ({ service }) => (
    <div data-testid="sheet" data-service={JSON.stringify(service)}>Fast Complete sheet for {service.id}</div>
  ),
}));
import TechHomePage from './TechHomePage';

const row = (id, overrides = {}) => ({
  id,
  technicianId: 'tech-fixture',
  technicianName: 'Fixture Technician',
  customerName: `Fixture ${id}`,
  address: '100 Example Lane',
  serviceType: 'Quarterly Pest Control',
  scheduledDate: '2099-01-01',
  status: 'confirmed',
  windowStart: '09:00:00',
  windowEnd: '10:00:00',
  lat: 27.41,
  lng: -82.52,
  completionProfile: { category: 'pest_control', serviceKey: 'pest_general_quarterly' },
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

it('opens a regular pest visit in the report flow when the switch rides the row', async () => {
  rows = [row('svc-regular', { fastCompleteReportEnabled: true })];
  mount();
  await openFromTools();
  const service = await sheetService();
  expect(service).toMatchObject({
    id: 'svc-regular', reportFlow: true, traceEligible: true, lat: 27.41, lng: -82.52, technicianName: 'Fixture Technician',
  });
  expect(screen.queryByText(/Existing recap form/)).not.toBeInTheDocument();
});

it.each([
  [true, true],
  [false, false],
  [undefined, false],
  ['true', false],
])('passes noteBoxPhotosEnabled %s to the sheet as %s (codex local r1 on #5624)', async (flag, expected) => {
  rows = [row('svc-photos', { fastCompleteReportEnabled: true, ...(flag === undefined ? {} : { noteBoxPhotosEnabled: flag }) })];
  mount();
  await openFromTools();
  expect((await sheetService()).noteBoxPhotosEnabled).toBe(expected);
});

it('opens a re-service in the report flow too, with or without the re-service switch', async () => {
  rows = [row('svc-reservice', {
    fastCompleteReportEnabled: true,
    completionProfile: { category: 'pest_control', serviceKey: 'pest_re_service' },
  })];
  mount();
  await openFromTools();
  expect((await sheetService()).reportFlow).toBe(true);
});

it('passes a trace-ineligible row through, so the sheet leaves the trace out', async () => {
  rows = [row('svc-no-trace', { fastCompleteReportEnabled: true, traceEligible: false })];
  mount();
  await openFromTools();
  expect((await sheetService()).traceEligible).toBe(false);
});

it('keeps a visit traced as an outline (tick control) off the report flow', async () => {
  rows = [row('svc-outline', { fastCompleteReportEnabled: true, traceVariant: 'outline' })];
  mount();
  await openFromTools();
  expect(await screen.findByText('Existing recap form for svc-outline')).toBeInTheDocument();
  expect(screen.queryByTestId('sheet')).not.toBeInTheDocument();
});

it.each([false, undefined, 'true'])('switch %p: a regular pest visit keeps the recap modal', async (flag) => {
  rows = [row('svc-off', flag === undefined ? {} : { fastCompleteReportEnabled: flag })];
  mount();
  await openFromTools();
  expect(await screen.findByText('Existing recap form for svc-off')).toBeInTheDocument();
  expect(screen.queryByTestId('sheet')).not.toBeInTheDocument();
});

it('switch off: a re-service under the re-service switch opens the sheet without the report flow', async () => {
  rows = [row('svc-old-sheet', {
    reserviceFastCompleteEnabled: true,
    completionProfile: { category: 'pest_control', serviceKey: 'pest_re_service' },
  })];
  mount();
  await openFromTools();
  expect((await sheetService()).reportFlow).toBe(false);
});

it('keeps a completed pest visit on the recap editor with the switch on', async () => {
  rows = [row('svc-done', { fastCompleteReportEnabled: true, status: 'completed' })];
  mount('/tech/tools', { fieldWorkspace: false });
  await openFromTools();
  expect(await screen.findByText('Existing recap form for svc-done')).toBeInTheDocument();
  expect(screen.queryByTestId('sheet')).not.toBeInTheDocument();
});
