// @vitest-environment jsdom
// Fast Complete report flow routing (GATE_FAST_COMPLETE_REPORT): with
// `fastCompleteReportEnabled` on the schedule row, every open untyped pest
// visit (a regular visit or a re-service) opens the one-screen sheet in its
// report flow, carrying what its trace step needs. Off, a regular pest visit
// keeps the recap modal and a re-service keeps the re-service sheet's own
// routing; a closed visit stays on the recap editor either way.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ navigationBusy: vi.fn(), attempts: new Map(), getAttempt: vi.fn(), listAttempts: vi.fn(), prune: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: () => ({ on: vi.fn(), off: vi.fn(), disconnect: vi.fn() }) }));
vi.mock('../../hooks/useFeatureFlag', () => ({ useFeatureFlag: () => false, useFeatureFlagReady: () => ({ enabled: false, ready: true }) }));
vi.mock('../../lib/completion-resume-store', () => ({
  getFastCompletionAttempt: mocks.getAttempt,
  listFastCompletionAttempts: (...args) => mocks.listAttempts(...args),
  pruneFastCompletionAttempts: (...args) => mocks.prune(...args),
  pruneRecapClipDrafts: () => Promise.resolve(0),
}));
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
vi.mock('../../components/tech/FastCompleteTreeShrubSheet', () => ({ default: () => <div data-testid="tree-sheet" /> }));
vi.mock('../../components/tech/FastCompleteLawnReserviceSheet', () => ({ default: () => <div data-testid="lawn-sheet" /> }));
import TechHomePage from './TechHomePage';
import { addETDays, etDateString } from '../../lib/timezone';

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
  mocks.attempts.clear();
  mocks.listAttempts.mockReset();
  mocks.listAttempts.mockImplementation(async (operatorId) => ({ available: true, attempts: operatorId === 'tech-fixture' ? [...mocks.attempts].map(([serviceId, attempt]) => ({ ...attempt, serviceId })) : [] }));
  mocks.prune.mockReset();
  mocks.prune.mockResolvedValue(0);
  mocks.getAttempt.mockReset();
  mocks.getAttempt.mockImplementation(async (serviceId, operatorId) => ({
    available: true,
    attempt: operatorId === 'tech-fixture' ? mocks.attempts.get(String(serviceId)) || null : null,
  }));
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
  mount('/admin/today/tools', { fieldWorkspace: false });
  await openFromTools();
  expect(await screen.findByText('Existing recap form for svc-done')).toBeInTheDocument();
  expect(screen.queryByTestId('sheet')).not.toBeInTheDocument();
});

it.each([
  ['report', { reportDraftBase: {}, structuredFindings: { type: 'tree_shrub' } }, {}, 'sheet', true],
  ['pest', { products: [] }, {}, 'sheet', false],
  ['lawn', { structuredFindings: { type: 'one_time_lawn_treatment' } }, { completionProfile: { category: 'lawn_care', serviceKey: 'lawn_re_service', findingsType: 'one_time_lawn_treatment' } }, 'lawn-sheet', null],
  ['tree', { structuredFindings: { type: 'tree_shrub' } }, { completionProfile: { category: 'lawn_care', findingsType: 'tree_shrub' } }, 'tree-sheet', null],
])('recovers a completed %s attempt in the sheet that prepared its body', async (kind, body, overrides, testId, reportFlow) => {
  const serviceId = `svc-recover-${kind}`;
  mocks.attempts.set(serviceId, { body: { idempotencyKey: `${kind}-key`, ...body }, summary: 'Original summary' });
  rows = [row(serviceId, { status: 'completed', ...overrides })];
  mount();
  fireEvent.click(await screen.findByRole('button', { name: /Recover Completion/ }));
  const sheet = await screen.findByTestId(testId);
  if (reportFlow !== null) expect(JSON.parse(sheet.getAttribute('data-service')).reportFlow).toBe(reportFlow);
  expect(screen.queryByText(/Existing recap form/)).not.toBeInTheDocument();
});

it('keeps an earlier completion reachable when it is absent from today’s route', async () => {
  mocks.attempts.set('prior-day', { body: { idempotencyKey: 'prior-key', reportDraftBase: {}, expectedVisit: { scheduledDate: '2020-01-01' } }, summary: 'Earlier report' });
  rows = [];
  mount();
  fireEvent.click(await screen.findByRole('button', { name: /Recover Completion/ }));
  expect(await sheetService()).toMatchObject({ id: 'prior-day', reportFlow: true });
});

it('a saved completion a tap finds gone leaves the list (GitHub Codex P2 on 102b99cb1b)', async () => {
  mocks.attempts.set('prior-day', { body: { idempotencyKey: 'prior-key', reportDraftBase: {} }, summary: 'Earlier report' });
  rows = [];
  mount();
  const recover = await screen.findByRole('button', { name: /Recover Completion/ });
  // Another tab discards it after this page's scan.
  mocks.getAttempt.mockImplementation(async () => ({ available: true, attempt: null }));
  fireEvent.click(recover);
  const reportTool = await screen.findByRole('button', { name: /Project Report/ });
  expect(reportTool).toBeDisabled();
  expect(screen.queryByTestId('sheet')).not.toBeInTheDocument();
});

it('an unreadable device says so on the tool and keeps the saved completion (GitHub Codex P2 on 102b99cb1b)', async () => {
  mocks.attempts.set('prior-day', { body: { idempotencyKey: 'prior-key', reportDraftBase: {} }, summary: 'Earlier report' });
  rows = [];
  mount();
  const recover = await screen.findByRole('button', { name: /Recover Completion/ });
  mocks.getAttempt.mockImplementation(async () => ({ available: false, attempt: null }));
  fireEvent.click(recover);
  expect(await screen.findByText(/Could not read the completion saved on this device/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Recover Completion/ })).toBeInTheDocument();
});

it('two off-route saved completions show when each was saved and what it holds (GitHub Codex P2 on 102b99cb1b)', async () => {
  mocks.attempts.set('prior-a', { body: { idempotencyKey: 'a-key', reportDraftBase: {} }, summary: 'Taurus SC · Perimeter', storedAt: Date.UTC(2026, 9, 2, 19, 15) });
  mocks.attempts.set('prior-b', { body: { idempotencyKey: 'b-key', reportDraftBase: {} }, summary: 'Advion WDG · Kitchen', storedAt: Date.UTC(2026, 9, 1, 13, 5) });
  rows = [];
  mount();
  await openFromTools();
  const picker = await screen.findByRole('dialog');
  expect(within(picker).getByText(/^Saved completion · Oct 2, 3:15\sPM$/)).toBeInTheDocument();
  expect(within(picker).getByText(/^Saved completion · Oct 1, 9:05\sAM$/)).toBeInTheDocument();
  expect(within(picker).getByText(/^saved on this device · Taurus SC · Perimeter/)).toBeInTheDocument();
  expect(within(picker).getByText(/^saved on this device · Advion WDG · Kitchen/)).toBeInTheDocument();
});


it('an unreadable re-scan keeps the saved completions this device listed, and says so (GitHub Codex P2 on 458cc517e5)', async () => {
  mocks.attempts.set('prior-day', { body: { idempotencyKey: 'prior-key', reportDraftBase: {} }, summary: 'Earlier report' });
  rows = [];
  mount();
  const recover = await screen.findByRole('button', { name: /Recover Completion/ });
  // Opening the sheet scans again, and this time the device cannot be read.
  mocks.listAttempts.mockImplementation(async () => ({ available: false, attempts: [] }));
  fireEvent.click(recover);
  await screen.findByTestId('sheet');
  await waitFor(() => expect(mocks.listAttempts.mock.calls.length).toBeGreaterThan(1));
  expect(await screen.findByText(/Could not read the completion saved on this device/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Recover Completion/ })).toBeInTheDocument();
});

it('after a failed read, a tap on the tool scans again (GitHub Codex P2 on 458cc517e5)', async () => {
  mocks.attempts.set('prior-day', { body: { idempotencyKey: 'prior-key', reportDraftBase: {} }, summary: 'Earlier report' });
  rows = [];
  mount();
  fireEvent.click(await screen.findByRole('button', { name: /Recover Completion/ }));
  mocks.listAttempts.mockImplementation(async () => ({ available: false, attempts: [] }));
  await screen.findByTestId('sheet');
  const tool = await screen.findByRole('button', { name: /Recover Completion.*Could not read the completion saved on this device/ });
  // The device reads again.
  mocks.listAttempts.mockImplementation(async (operatorId) => ({ available: true, attempts: operatorId === 'tech-fixture' ? [...mocks.attempts].map(([serviceId, attempt]) => ({ ...attempt, serviceId })) : [] }));
  const scans = mocks.listAttempts.mock.calls.length;
  fireEvent.click(tool);
  await waitFor(() => expect(mocks.listAttempts.mock.calls.length).toBeGreaterThan(scans));
  await waitFor(() => expect(screen.queryByText(/Could not read the completion saved on this device/)).not.toBeInTheDocument());
});

it('a device that cannot store saved completions at all stays quiet (GitHub Codex P2 on 458cc517e5)', async () => {
  mocks.listAttempts.mockImplementation(async () => ({ available: false, attempts: [] }));
  rows = [];
  mount();
  expect(await screen.findByRole('button', { name: /Project Report/ })).toBeDisabled();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.queryByText(/Could not read the completion saved on this device/)).not.toBeInTheDocument();
});

it('a visit with a saved retry the device cannot read now opens nothing (GitHub Codex P2 on 458cc517e5)', async () => {
  mocks.attempts.set('svc-live', { body: { idempotencyKey: 'live-key', reportDraftBase: {} }, summary: 'Saved report' });
  rows = [row('svc-live', { fastCompleteReportEnabled: true })];
  mount();
  const recover = await screen.findByRole('button', { name: /Recover Completion/ });
  mocks.getAttempt.mockImplementation(async () => ({ available: false, attempt: null }));
  fireEvent.click(recover);
  expect(await screen.findByText(/Could not read the completion saved on this device/)).toBeInTheDocument();
  expect(screen.queryByTestId('sheet')).not.toBeInTheDocument();
  expect(screen.queryByText(/Existing recap form/)).not.toBeInTheDocument();
});

it('a technician\'s device sweeps its own saved retries on the server\'s access cutoff, never another operator\'s (GitHub Codex P2 on 458cc517e5; pre-push P0s on 1dc0f16fb9 and f405ea3185)', async () => {
  rows = [];
  mount();
  await screen.findByRole('button', { name: /Project Report/ });
  expect(mocks.prune).toHaveBeenCalledWith(expect.any(Number), undefined, {
    operatorId: 'tech-fixture', scheduledCutoff: etDateString(addETDays(new Date(), -7)),
  });
  // Every operator's rows keep the store's own sweep.
  expect(mocks.prune).toHaveBeenCalledWith();
});
