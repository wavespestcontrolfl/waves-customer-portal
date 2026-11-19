// @vitest-environment jsdom
// The Today page routes a visit that is neither typed nor pest control as admin
// Dispatch routes it (handleComplete): a regular lawn visit opens the lawn Fast
// Complete sheet (GATE_LAWN_FAST_COMPLETE, `lawnFastCompleteEnabled` on the
// schedule row) with the product catalog read at the tap; a visit that
// completes through a project opens the project editor; any other visit opens
// the Dispatch completion form, never the project editor.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ navigationBusy: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: () => ({ on: vi.fn(), off: vi.fn(), disconnect: vi.fn() }) }));
vi.mock('../../hooks/useFeatureFlag', () => ({ useFeatureFlag: () => false, useFeatureFlagReady: () => ({ enabled: false, ready: true }) }));
vi.mock('../../components/tech/TechIntelligenceBar', () => ({ default: () => <div>Field assistant</div> }));
vi.mock('../../components/tech/TechNoticeFeed', () => ({ default: () => null }));
vi.mock('../../components/tech/CreateProjectModal', () => ({
  default: ({ defaultScheduledServiceId }) => <div>Project editor for {defaultScheduledServiceId}</div>,
  wdoFeeSeedFromVisit: () => null,
}));
vi.mock('../../components/tech/TechTimeTrackingCard', () => ({ default: () => <div>Shift time</div> }));
vi.mock('../../components/tech/TechServicePhotosModal', () => ({ default: () => null }));
vi.mock('../../components/tech/TechTreatmentZoneModal', () => ({ default: () => null }));
vi.mock('../../components/tech/FieldLeadModal', () => ({ default: () => null }));
vi.mock('../../components/ServiceRecapModal', () => ({ default: ({ service }) => <div>Existing recap form for {service.id}</div> }));
vi.mock('../../components/tech/FastCompleteSheet', () => ({ default: ({ service }) => <div data-testid="sheet">Fast Complete sheet for {service.id}</div> }));
vi.mock('../../components/tech/FastCompleteTreeShrubSheet', () => ({ default: () => null }));
vi.mock('../../components/tech/FastCompleteLawnReserviceSheet', () => ({ default: () => null }));
vi.mock('../../components/tech/FastCompleteLawnSheet', () => ({
  default: ({ service, catalog, onClose, onCompleted, onFullForm, onViewDetails, suspended }) => (
    <div data-testid="lawn-sheet" data-service={JSON.stringify(service)} data-catalog={JSON.stringify(catalog)} data-suspended={String(suspended)}>
      <button type="button" onClick={onFullForm}>Lawn full form</button>
      <button type="button" onClick={() => onClose({ refresh: true })}>Lawn close</button>
      <button type="button" onClick={() => onCompleted({ ok: true })}>Lawn completed</button>
      <button type="button" onClick={onViewDetails}>Lawn details</button>
    </div>
  ),
}));
vi.mock('../../components/schedule/MobileAppointmentDetailSheet', () => ({
  default: ({ service, onClose, onCompleteService, onRescheduled }) => (
    <div data-testid="details">
      Details for {service.id}
      <button type="button" onClick={() => onCompleteService(service)}>Complete from details</button>
      <button type="button" onClick={() => onRescheduled()}>Move visit</button>
      <button type="button" onClick={onClose}>Close details</button>
    </div>
  ),
}));
import TechHomePage from './TechHomePage';

const CATALOG = [{ id: 'prod-fixture', name: 'Fixture granular' }];
const DISPATCH_FORM = (id) => `/admin/dispatch?tab=schedule&completeService=${id}`;
const row = (id, overrides = {}) => ({
  id,
  technicianId: 'tech-fixture',
  technicianName: 'Fixture Technician',
  customerName: `Fixture ${id}`,
  customerId: 'cust-fixture',
  propertyId: 'prop-fixture',
  address: '100 Example Lane, Bradenton, FL 34202',
  serviceType: 'Lawn Care',
  serviceTypeRaw: 'Lawn Care 6-Week',
  scheduledDate: '2099-01-01',
  status: 'confirmed',
  windowStart: '09:00:00',
  windowEnd: '10:00:00',
  completionProfile: { category: 'lawn_care', serviceKey: 'lawn_care_6week', findingsType: null, projectBacked: false, requiresProject: false },
  lawnFastCompleteEnabled: true,
  ...overrides,
});

let rows;
let assign;
let catalogReply;

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

const catalogCalls = () => fetch.mock.calls.filter(([path]) => path.includes('/admin/dispatch/products/catalog')).length;
const scheduleCalls = () => fetch.mock.calls.filter(([path]) => path.includes('/admin/schedule?')).length;
const lawnSheet = async () => {
  const sheet = await screen.findByTestId('lawn-sheet');
  return { service: JSON.parse(sheet.getAttribute('data-service')), catalog: JSON.parse(sheet.getAttribute('data-catalog')), sheet };
};

beforeEach(() => {
  mocks.navigationBusy.mockClear();
  assign = vi.fn();
  catalogReply = async () => ({ ok: true, status: 200, json: async () => ({ products: CATALOG }) });
  vi.stubGlobal('location', { ...window.location, assign });
  vi.stubGlobal('alert', vi.fn());
  vi.stubGlobal('fetch', vi.fn(async (path) => {
    if (path.includes('/admin/schedule?')) return { ok: true, status: 200, json: async () => ({ services: rows }) };
    if (path.includes('/admin/dispatch/products/catalog')) return catalogReply();
    return { ok: true, status: 200, json: async () => ({}) };
  }));
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

async function openFromTools() {
  fireEvent.click(await screen.findByRole('button', { name: /Project Report/ }));
}

it('a regular lawn visit opens the lawn sheet with the catalog read at the tap, never the project editor', async () => {
  rows = [row('svc-lawn')];
  mount();
  await openFromTools();
  const { service, catalog } = await lawnSheet();
  expect(service).toMatchObject({
    id: 'svc-lawn', customerId: 'cust-fixture', routedPropertyId: 'prop-fixture', routedServiceType: 'Lawn Care 6-Week',
    fullAddress: '100 Example Lane, Bradenton, FL 34202',
  });
  expect(catalog).toEqual(CATALOG);
  expect(catalogCalls()).toBe(1);
  expect(screen.queryByText(/Project editor for/)).not.toBeInTheDocument();
  expect(assign).not.toHaveBeenCalled();
});

it('the lawn sheet\'s Full form opens the Dispatch completion form', async () => {
  rows = [row('svc-lawn')];
  mount();
  await openFromTools();
  await lawnSheet();
  fireEvent.click(screen.getByRole('button', { name: 'Lawn full form' }));
  expect(assign).toHaveBeenCalledWith(DISPATCH_FORM('svc-lawn'));
  expect(screen.queryByTestId('lawn-sheet')).not.toBeInTheDocument();
});

it('a completion closes the lawn sheet and reloads the route', async () => {
  rows = [row('svc-lawn')];
  mount();
  await openFromTools();
  await lawnSheet();
  const before = scheduleCalls();
  fireEvent.click(screen.getByRole('button', { name: 'Lawn completed' }));
  expect(screen.queryByTestId('lawn-sheet')).not.toBeInTheDocument();
  await waitFor(() => expect(scheduleCalls()).toBeGreaterThan(before));
});

it.each([
  ['the gate off', { lawnFastCompleteEnabled: false }],
  ['the gate absent (an older payload)', { lawnFastCompleteEnabled: undefined }],
  ['an area add-on row on the visit', { areaAddOnRowsAttached: true }],
  ['a termite bond renewal (internal only)', {
    serviceType: 'Termite Bond Renewal', serviceTypeRaw: 'Termite Bond 1 Year',
    completionProfile: { category: 'termite', serviceKey: 'termite_bond_1yr', completionMode: 'internal_only', findingsType: null, projectBacked: false, requiresProject: false },
  }],
])('%s: the Dispatch completion form, as Dispatch opens it, never the project editor', async (_label, overrides) => {
  rows = [row('svc-other', overrides)];
  mount();
  await openFromTools();
  await waitFor(() => expect(assign).toHaveBeenCalledWith(DISPATCH_FORM('svc-other')));
  expect(screen.queryByText(/Project editor for/)).not.toBeInTheDocument();
  expect(screen.queryByTestId('lawn-sheet')).not.toBeInTheDocument();
  expect(catalogCalls()).toBe(0);
});

it('a visit that completes through a project keeps the project editor', async () => {
  rows = [row('svc-wdo', {
    serviceType: 'WDO Inspection', serviceTypeRaw: 'WDO Inspection',
    completionProfile: { category: 'inspection', serviceKey: 'wdo_inspection', findingsType: null, projectBacked: true, requiresProject: true },
  })];
  mount();
  await openFromTools();
  expect(await screen.findByText('Project editor for svc-wdo')).toBeInTheDocument();
  expect(assign).not.toHaveBeenCalled();
});

it('a leftover linked project on a service-report lawn visit does not reopen the project: the profile wins, as on Dispatch', async () => {
  rows = [row('svc-lawn-linked', { linkedProject: { id: 'project-fixture', status: 'draft' } })];
  mount();
  await openFromTools();
  expect((await lawnSheet()).service.id).toBe('svc-lawn-linked');
  expect(screen.queryByText(/Project editor for/)).not.toBeInTheDocument();
});

it('no catalog, no sheet: the tech is told to tap again, and nothing else opens', async () => {
  catalogReply = async () => ({ ok: false, status: 503, json: async () => ({ error: 'unavailable' }) });
  rows = [row('svc-lawn')];
  mount();
  await openFromTools();
  await waitFor(() => expect(alert).toHaveBeenCalledWith(expect.stringMatching(/Could not load the product list/)));
  expect(screen.queryByTestId('lawn-sheet')).not.toBeInTheDocument();
  expect(assign).not.toHaveBeenCalled();
});

it('a later tap wins over a lawn sheet still reading its catalog', async () => {
  let release;
  catalogReply = () => new Promise((resolve) => { release = () => resolve({ ok: true, status: 200, json: async () => ({ products: CATALOG }) }); });
  rows = [row('svc-lawn'), row('svc-pest', { serviceType: 'Quarterly Pest Control', completionProfile: { category: 'pest_control', serviceKey: 'pest_general_quarterly', projectBacked: false } })];
  mount();
  await openFromTools();
  fireEvent.click(await screen.findByText('Fixture svc-lawn'));
  await waitFor(() => expect(catalogCalls()).toBe(1));
  await openFromTools();
  fireEvent.click(await screen.findByText('Fixture svc-pest'));
  expect(await screen.findByText('Existing recap form for svc-pest')).toBeInTheDocument();
  await act(async () => { release(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(screen.queryByTestId('lawn-sheet')).not.toBeInTheDocument();
});

it('Details over the lawn sheet suspends it, and Complete from Details returns to the same sheet', async () => {
  rows = [row('svc-lawn')];
  mount();
  await openFromTools();
  await lawnSheet();
  fireEvent.click(screen.getByRole('button', { name: 'Lawn details' }));
  expect(await screen.findByTestId('details')).toBeInTheDocument();
  expect((await lawnSheet()).sheet.getAttribute('data-suspended')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'Complete from details' }));
  expect(screen.queryByTestId('details')).not.toBeInTheDocument();
  expect((await lawnSheet()).sheet.getAttribute('data-suspended')).toBe('false');
  // Back to the sheet behind Details, entries intact: no second open, no second catalog read.
  expect(catalogCalls()).toBe(1);
});

it('a move from Details closes the lawn sheet behind it: that visit changed', async () => {
  rows = [row('svc-lawn')];
  mount();
  await openFromTools();
  await lawnSheet();
  fireEvent.click(screen.getByRole('button', { name: 'Lawn details' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Move visit' }));
  await waitFor(() => expect(screen.queryByTestId('lawn-sheet')).not.toBeInTheDocument());
});
