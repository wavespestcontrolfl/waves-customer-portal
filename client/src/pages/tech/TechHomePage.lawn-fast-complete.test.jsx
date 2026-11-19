// @vitest-environment jsdom
// The Today page routes a lawn visit as admin Dispatch routes it
// (handleComplete): a regular lawn visit, or a typed one-time lawn treatment,
// opens the lawn Fast Complete sheet (GATE_LAWN_FAST_COMPLETE,
// `lawnFastCompleteEnabled` on the schedule row) at once, with the product
// catalog read at the tap; a visit that completes through a project opens the
// project editor; a whole-visit closeout and any other visit open the Dispatch
// completion form (on the visit's own day), never the project editor.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { completionFailureOutcome } from '../../hooks/useFastCompleteSubmit';

const mocks = vi.hoisted(() => ({ navigationBusy: vi.fn(), lawnRequest: null }));
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
  default: ({ service, request, catalog, catalogError, onClose, onCompleted, onFullForm, onViewDetails, suspended, collectOnSheet }) => {
    mocks.lawnRequest = request;
    return (
    <div data-testid="lawn-sheet" data-service={JSON.stringify(service)} data-catalog={JSON.stringify(catalog)} data-catalog-error={catalogError} data-suspended={String(suspended)} data-collect={String(!!collectOnSheet)}>
      <button type="button" onClick={onFullForm}>Lawn full form</button>
      <button type="button" onClick={() => onClose({ refresh: true })}>Lawn close</button>
      <button type="button" onClick={() => onClose()}>Lawn dismiss</button>
      <button type="button" onClick={() => onCompleted({ ok: true })}>Lawn completed</button>
      <button type="button" onClick={onViewDetails}>Lawn details</button>
    </div>
    );
  },
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
const DISPATCH_FORM = (id) => `/admin/dispatch?tab=schedule&date=2099-01-01&completeService=${id}`;
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
const catalogOnSheet = () => JSON.parse(screen.getByTestId('lawn-sheet').getAttribute('data-catalog'));
const TYPED_LAWN = { category: 'lawn_care', serviceKey: 'lawn_care_one_time', findingsType: 'one_time_lawn_treatment', projectBacked: false, requiresProject: false };

beforeEach(() => {
  mocks.navigationBusy.mockClear();
  assign = vi.fn();
  catalogReply = async () => ({ ok: true, status: 200, json: async () => ({ products: CATALOG }) });
  vi.stubGlobal('location', { ...window.location, assign });
  vi.stubGlobal('alert', vi.fn());
  vi.stubGlobal('fetch', vi.fn(async (path) => {
    if (path.includes('/admin/schedule?')) return { ok: true, status: 200, json: async () => ({ services: rows }) };
    if (path.includes('/admin/dispatch/products/catalog')) return catalogReply();
    // For the request the lawn sheet is handed: a 2xx whose body is not JSON
    // (a captive portal page), and a refusal that names the product and place.
    if (path.endsWith('/unreadable-2xx')) return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } };
    if (path.endsWith('/refused')) {
      const reply = { ok: false, status: 422, statusText: '', json: async () => ({ error: 'Over the yearly amount', code: 'lawn_product_limit', productId: 'prod-fixture', place: 'front' }) };
      return { ...reply, clone: () => reply };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  }));
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

async function openFromTools() {
  fireEvent.click(await screen.findByRole('button', { name: /Project Report/ }));
}

it('a regular lawn visit opens the lawn sheet at once, with the catalog read at the tap, never the project editor', async () => {
  rows = [row('svc-lawn')];
  mount();
  await openFromTools();
  const { service } = await lawnSheet();
  expect(service).toMatchObject({
    id: 'svc-lawn', customerId: 'cust-fixture', routedPropertyId: 'prop-fixture', routedServiceType: 'Lawn Care 6-Week',
    fullAddress: '100 Example Lane, Bradenton, FL 34202',
  });
  await waitFor(() => expect(catalogOnSheet()).toEqual(CATALOG));
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

// A sent or closed legacy project too: it ends only a project-backed visit
// (projectReportClosed), so the Report picker still lists this one.
it.each(['draft', 'sent', 'closed'])('a leftover %s linked project on a service-report lawn visit does not reopen the project: the profile wins, as on Dispatch', async (status) => {
  rows = [row('svc-lawn-linked', { linkedProject: { id: 'project-fixture', status } })];
  mount();
  await openFromTools();
  expect((await lawnSheet()).service.id).toBe('svc-lawn-linked');
  expect(screen.queryByText(/Project editor for/)).not.toBeInTheDocument();
});

it('a failed catalog read leaves the sheet open, saying why in place of its form; nothing else opens', async () => {
  catalogReply = async () => ({ ok: false, status: 503, json: async () => ({ error: 'unavailable' }) });
  rows = [row('svc-lawn')];
  mount();
  await openFromTools();
  await lawnSheet();
  await waitFor(() => expect(screen.getByTestId('lawn-sheet')).toHaveAttribute('data-catalog-error', expect.stringMatching(/Could not load the product list/)));
  expect(catalogOnSheet()).toBeNull();
  expect(alert).not.toHaveBeenCalled();
  expect(assign).not.toHaveBeenCalled();
});

it('a catalog reply lands only on the sheet its tap opened, never on one opened since', async () => {
  const pending = [];
  catalogReply = () => new Promise((resolve) => { pending.push(() => resolve({ ok: true, status: 200, json: async () => ({ products: CATALOG }) })); });
  rows = [row('svc-lawn')];
  mount();
  await openFromTools();
  await lawnSheet();
  fireEvent.click(screen.getByRole('button', { name: 'Lawn dismiss' }));
  expect(screen.queryByTestId('lawn-sheet')).not.toBeInTheDocument();
  await openFromTools();
  await lawnSheet();
  await waitFor(() => expect(pending).toHaveLength(2));
  await act(async () => { pending[0](); await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(catalogOnSheet()).toBeNull();
  await act(async () => { pending[1](); await new Promise((resolve) => setTimeout(resolve, 0)); });
  await waitFor(() => expect(catalogOnSheet()).toEqual(CATALOG));
});

it('the lawn sheet\'s request: a 2xx it cannot read is no success, and a refusal keeps its details', async () => {
  rows = [row('svc-lawn')];
  mount();
  await openFromTools();
  await lawnSheet();
  // A resolved {} would read as a saved completion and clear the attempt kept for a same-key retry.
  const err = await mocks.lawnRequest('/admin/dispatch/svc-lawn/unreadable-2xx', { method: 'POST', body: '{}' }).catch((error) => error);
  expect(err).toBeInstanceOf(Error);
  expect(completionFailureOutcome(err)).toBe('retry');
  // The sheet marks the refused product and place from err.details.
  await expect(mocks.lawnRequest('/admin/dispatch/svc-lawn/refused', { method: 'POST', body: '{}' }))
    .rejects.toMatchObject({ status: 422, code: 'lawn_product_limit', details: { productId: 'prod-fixture', place: 'front' } });
});

// This page opens no payment prompt of its own from the completion response, so
// the sheet offers Take payment now on its saved view (CollectPayment).
it('the lawn sheet offers Take payment now on its saved view here', async () => {
  rows = [row('svc-lawn')];
  mount();
  await openFromTools();
  expect(await screen.findByTestId('lawn-sheet')).toHaveAttribute('data-collect', 'true');
});

// A Waves Assessment: its one-screen sheet is only on Dispatch, so its link
// asks Dispatch to open the visit as its Complete button does
// (completeSheet=1). Typed or not, Dispatch's own decision picks it; with the
// gate off it is the plain link to the completion form.
const ASSESSMENT = {
  serviceType: 'Waves Assessment', serviceTypeRaw: 'Waves Assessment', lawnFastCompleteEnabled: false,
  completionProfile: { category: 'inspection', serviceKey: 'lawn_inspection', companions: [], findingsType: null, projectBacked: false, requiresProject: false },
};
it.each([
  ['eligible', { assessmentFastCompleteEnabled: true }, '&completeSheet=1'],
  ['eligible and typed', { assessmentFastCompleteEnabled: true, completionProfile: { ...ASSESSMENT.completionProfile, findingsType: 'lawn_assessment' } }, '&completeSheet=1'],
  ['with the gate off', { assessmentFastCompleteEnabled: false }, ''],
])('a Waves Assessment (%s) goes to Dispatch, which opens its own sheet when the gate allows', async (_label, overrides, param) => {
  rows = [row('svc-as', { ...ASSESSMENT, ...overrides })];
  mount();
  await openFromTools();
  await waitFor(() => expect(assign).toHaveBeenCalledWith(`${DISPATCH_FORM('svc-as')}${param}`));
  expect(screen.queryByText(/Project editor for/)).not.toBeInTheDocument();
  expect(screen.queryByTestId('lawn-sheet')).not.toBeInTheDocument();
});

it('a typed one-time lawn treatment opens the lawn sheet too, as Dispatch opens it', async () => {
  rows = [row('svc-typed-lawn', { serviceType: 'Lawn Treatment', serviceTypeRaw: 'One-Time Lawn Treatment', completionProfile: TYPED_LAWN })];
  mount();
  await openFromTools();
  expect((await lawnSheet()).service.id).toBe('svc-typed-lawn');
  expect(assign).not.toHaveBeenCalled();
});

it.each([
  ['a whole-visit closeout', { visitId: 'visit-fixture', visitCloseoutEnabled: true }],
  ['a project-backed visit', { completionProfile: { ...TYPED_LAWN, projectBacked: true } }],
])('a typed lawn treatment that is %s keeps the Dispatch deep link, which takes it first', async (_label, overrides) => {
  rows = [row('svc-typed-lawn', { completionProfile: TYPED_LAWN, ...overrides })];
  mount();
  await openFromTools();
  await waitFor(() => expect(assign).toHaveBeenCalledWith(DISPATCH_FORM('svc-typed-lawn')));
  expect(screen.queryByTestId('lawn-sheet')).not.toBeInTheDocument();
  expect(catalogCalls()).toBe(0);
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
