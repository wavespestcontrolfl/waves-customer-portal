// @vitest-environment jsdom
// Fast Complete routing (PR C, GATE_RESERVICE_FAST_COMPLETE): a pest
// re-service (completionProfile.serviceKey === 'pest_re_service') opens the
// one-screen FastCompleteSheet when the gate rides the schedule payload as
// true; everything else — the gate off, or any other pest_control service —
// opens today's ServiceRecapModal, unchanged.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
vi.mock('../../components/ServiceRecapModal', () => ({ default: ({ service }) => <div>Existing recap form for {service.id}</div> }));
vi.mock('../../components/tech/FastCompleteSheet', () => ({
  default: ({ service, onFullForm, onViewDetails, voiceFillEnabled, suspended }) => (
    <div data-recap-enabled={String(service.recapEnabled)} data-voice-fill-enabled={String(voiceFillEnabled)} data-suspended={String(!!suspended)}>
      Fast Complete sheet for {service.id}
      <button type="button" onClick={onFullForm}>Sheet full form</button>
      {onViewDetails && <button type="button" onClick={onViewDetails}>Sheet details</button>}
    </div>
  ),
}));
vi.mock('../../components/schedule/MobileAppointmentDetailSheet', () => ({
  default: ({ service, onEdit, onRescheduled, onClose, adminActions }) => (
    <div data-admin-actions={String(adminActions)}>
      Appointment details for {service.id}
      <button type="button" onClick={() => onClose()}>Close details</button>
      <button type="button" onClick={() => onEdit(service)}>Edit appointment</button>
      <button type="button" onClick={() => onRescheduled(service)}>Moved with a warning</button>
    </div>
  ),
}));
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

function mount(path = '/admin/today/tools') {
  localStorage.setItem('waves_admin_token', 'fixture-only');
  localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'tech-fixture', name: 'Fixture Technician', role: 'technician' }));
  return render(<MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/admin/today" element={<Outlet context={{ setNavigationBusy: mocks.navigationBusy }} />}>
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

it('offers no report for a completed re-service, even with the gate on', async () => {
  rows = [row('svc-completed', { reserviceFastCompleteEnabled: true, status: 'completed' })];
  mount();
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/admin/schedule?'), expect.anything()));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(await screen.findByRole('button', { name: /Project Report/ })).toBeDisabled();
  expect(screen.queryByText(/Existing recap form/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Fast Complete sheet/)).not.toBeInTheDocument();
});

it('sends the sheet\'s full-form escape to the full completion screen, not the recap modal', async () => {
  const assign = vi.fn();
  vi.stubGlobal('location', { ...window.location, assign });
  rows = [row('svc-escape', { reserviceFastCompleteEnabled: true })];
  mount();
  fireEvent.click(await screen.findByRole('button', { name: /Project Report/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Sheet full form' }));
  expect(assign).toHaveBeenCalledWith('/admin/dispatch?tab=schedule&completeService=svc-escape');
  expect(screen.queryByText(/Existing recap form/)).not.toBeInTheDocument();
});

// GATE_FAST_COMPLETE_RECAP rides the same schedule row: the sheet learns from
// the payload, and only an exact true turns its customer recap on.
it.each([
  [true, 'true'],
  [false, 'false'],
  [undefined, 'false'],
  ['true', 'false'],
])('passes fastCompleteRecapEnabled %s to the sheet as recapEnabled=%s', async (flag, expected) => {
  rows = [row('svc-recap', { reserviceFastCompleteEnabled: true, ...(flag === undefined ? {} : { fastCompleteRecapEnabled: flag }) })];
  mount();
  fireEvent.click(await screen.findByRole('button', { name: /Project Report/ }));
  const sheet = (await screen.findByText('Fast Complete sheet for svc-recap')).closest('[data-recap-enabled]');
  expect(sheet.getAttribute('data-recap-enabled')).toBe(expected);
});

// Details (owner 2026-10-09): the sheet's Details pill swaps it for the
// appointment details sheet (quick move, cancel, reschedule, price edit); the
// sheet's Dispatch-only destinations reopen it there on the visit's day.
it('the sheet\'s Details opens the appointment details sheet over the sheet (kept, suspended); Close returns to it, a move closes it, and Edit goes to Dispatch', async () => {
  const assign = vi.fn();
  vi.stubGlobal('location', { ...window.location, assign });
  rows = [row('svc-details', { reserviceFastCompleteEnabled: true, scheduledDate: '2026-10-09' })];
  mount();
  fireEvent.click(await screen.findByRole('button', { name: /Project Report/ }));
  await screen.findByText('Fast Complete sheet for svc-details');
  const sheet = () => screen.queryByText('Fast Complete sheet for svc-details')?.closest('[data-suspended]');
  fireEvent.click(screen.getByRole('button', { name: 'Sheet details' }));
  expect(await screen.findByText('Appointment details for svc-details')).toBeInTheDocument();
  // Option 2 (owner 2026-10-09): the sheet stays mounted behind Details so its entries survive.
  expect(sheet().getAttribute('data-suspended')).toBe('true');
  // The fixture login is a technician: the office-only controls stay hidden.
  expect(screen.getByText('Appointment details for svc-details').closest('[data-admin-actions]').getAttribute('data-admin-actions')).toBe('false');
  fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
  await waitFor(() => expect(screen.queryByText('Appointment details for svc-details')).not.toBeInTheDocument());
  expect(sheet().getAttribute('data-suspended')).toBe('false');
  // A move refreshes the route and closes the sheet behind (that visit changed), but leaves
  // Details up: the details sheet closes itself after a clean move and keeps a partial or
  // not-texted result readable.
  fireEvent.click(screen.getByRole('button', { name: 'Sheet details' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Moved with a warning' }));
  expect(screen.getByText('Appointment details for svc-details')).toBeInTheDocument();
  await waitFor(() => expect(sheet()).toBeFalsy());
  fireEvent.click(screen.getByRole('button', { name: 'Edit appointment' }));
  expect(assign).toHaveBeenCalledWith('/admin/dispatch?tab=schedule&date=2026-10-09&appointment=svc-details');
});

it('the recap flag alone never opens the sheet: the routing gate still decides', async () => {
  rows = [row('svc-recap-only', { fastCompleteRecapEnabled: true })];
  mount();
  fireEvent.click(await screen.findByRole('button', { name: /Project Report/ }));
  expect(await screen.findByText('Existing recap form for svc-recap-only')).toBeInTheDocument();
  expect(screen.queryByText(/Fast Complete sheet/)).not.toBeInTheDocument();
});

// GATE_FAST_COMPLETE_VOICE_FILL rides the same schedule row: the sheet gets it
// as the `voiceFillEnabled` prop, and only an exact true turns voice fill on.
it.each([
  [true, 'true'],
  [false, 'false'],
  [undefined, 'false'],
  ['true', 'false'],
])('passes fastCompleteVoiceFillEnabled %s to the sheet as voiceFillEnabled=%s', async (flag, expected) => {
  rows = [row('svc-voice', { reserviceFastCompleteEnabled: true, ...(flag === undefined ? {} : { fastCompleteVoiceFillEnabled: flag }) })];
  mount();
  fireEvent.click(await screen.findByRole('button', { name: /Project Report/ }));
  const sheet = (await screen.findByText('Fast Complete sheet for svc-voice')).closest('[data-voice-fill-enabled]');
  expect(sheet.getAttribute('data-voice-fill-enabled')).toBe(expected);
});

it('the voice-fill flag alone never opens the sheet: the routing gate still decides', async () => {
  rows = [row('svc-voice-only', { fastCompleteVoiceFillEnabled: true })];
  mount();
  fireEvent.click(await screen.findByRole('button', { name: /Project Report/ }));
  expect(await screen.findByText('Existing recap form for svc-voice-only')).toBeInTheDocument();
  expect(screen.queryByText(/Fast Complete sheet/)).not.toBeInTheDocument();
});
