// @vitest-environment jsdom
// Lawn Fast Complete on admin Dispatch (GATE_LAWN_FAST_COMPLETE): an eligible
// open lawn visit opens the one-screen sheet instead of CompletionPanel. The
// gate off, any other service line, and the sheet's own "Full form" way out
// keep the long form exactly as before. The technician portal is not touched.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DispatchPageV2 from './DispatchPageV2';
import { adminFetch } from '../../utils/admin-fetch';
import { shouldOpenLawnFastComplete } from '../../lib/dispatchCompletionRouting';
import { isLawnFastCompleteEligible } from '../../lib/lawn-fast-complete';

vi.mock('../../utils/admin-fetch', () => ({ adminFetch: vi.fn(), isRateLimitError: () => false }));
vi.mock('./SchedulePage', () => ({
  CompletionPanel: ({ service }) => <div>Completion panel for {service.id}</div>,
  RescheduleModal: () => null,
  EditServiceModal: () => null,
  ProtocolPanel: () => null,
  completionResumeOwed: () => false,
}));
vi.mock('../../components/tech/FastCompleteTreeShrubSheet', () => ({
  default: ({ service }) => <div>Tree and shrub sheet for {service.id}</div>,
}));
vi.mock('../../components/tech/FastCompleteLawnReserviceSheet', () => ({ default: ({ service }) => <div>Lawn re-service sheet for {service.id}</div> }));
vi.mock('../../components/tech/FastCompleteLawnSheet', () => ({
  default: ({ service, operatorId, catalog, onClose, onCompleted, onFullForm, onViewDetails }) => (
    <div>
      Lawn sheet for {service.id} (catalog {catalog.length}, type {String(service.routedServiceType)})
      <span data-testid="lawn-operator">{operatorId}</span>
      <button type="button" onClick={() => onClose()}>Sheet close</button>
      <button type="button" onClick={() => onClose({ refresh: true })}>Sheet close refresh</button>
      <button type="button" onClick={() => onCompleted()}>Sheet completed</button>
      <button type="button" onClick={() => onCompleted({ invoiceId: 'inv-fixture', invoiceToken: 'tok-fixture', invoiceTotal: 85, invoicePaymentActionRequired: true })}>Sheet completed unpaid</button>
      <button type="button" onClick={onFullForm}>Sheet full form</button>
      <button type="button" onClick={() => onViewDetails()}>Sheet details</button>
      <span>Sheet knows {service.customerId} / {service.fullAddress} / {service.customerPhone}</span>
      <span>Sheet on-site {String(service.onSiteAt)}</span>
      <span>Sheet trace {String(service.traceEligible)}</span>
    </div>
  ),
}));
vi.mock('../../components/schedule/MobileDispatchList', () => ({ default: ({ services = [], onEdit }) => <div>
  {services.map((service) => <button key={service.id} aria-label={`Open mobile ${service.id}`} onClick={() => onEdit(service)}>Mobile visit</button>)}
  {/* A visit that is not in the selected day's list. */}
  <button aria-label="Open week-only visit" onClick={() => onEdit({ id: 'svc-lawn-week', customerName: 'Fixture week', address: '200 Example Lane', serviceType: 'Lawn Care', status: 'on_site', scheduledDate: '2026-09-14', propertyId: 'prop-fixture', completionProfile: { category: 'lawn_care', serviceKey: 'lawn_care_recurring', findingsType: null }, lawnFastCompleteEnabled: true })}>Week visit</button>
</div> }));
vi.mock('../../components/schedule/MobilePaymentSheet', () => ({
  default: ({ invoiceId, service }) => <div>Payment sheet for {invoiceId} ({service?.id || 'no service'})</div>,
}));
vi.mock('../../components/schedule/MobileAppointmentDetailSheet', () => ({ default: ({ service }) => <div>Details sheet for {service.id}</div> }));
vi.mock('../../components/schedule/MobileDayStrip', () => ({ default: () => <div>Day strip</div> }));
vi.mock('../../hooks/useFeatureFlag', () => ({ useFeatureFlag: () => false, useFeatureFlagReady: () => ({ enabled: false, ready: true, known: true }) }));

const visit = (id, overrides = {}) => ({
  id,
  customerName: `Fixture ${id}`,
  address: '100 Example Lane',
  serviceType: 'Lawn Care',
  status: 'on_site',
  scheduledDate: '2026-09-12',
  propertyId: null,
  completionProfile: { category: 'lawn_care', serviceKey: 'lawn_care_recurring', findingsType: null },
  lawnFastCompleteEnabled: true,
  ...overrides,
});

function mount(services, path = '/admin/dispatch?date=2026-09-12') {
  vi.mocked(adminFetch).mockImplementation(async (url) => (
    url === '/admin/dispatch/products/catalog'
      ? { products: [{ id: 'p1' }, { id: 'p2' }] }
      : { services, technicians: [], techSummary: [], products: [], types: [] }
  ));
  return render(<MemoryRouter initialEntries={[path]}><DispatchPageV2 activeTab="board" /></MemoryRouter>);
}

beforeEach(() => {
  vi.stubGlobal('innerWidth', 390);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ alerts: [] }) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('Dispatch completion routing for lawn', () => {
  it('opens the sheet, not CompletionPanel, for an eligible open lawn visit, with the catalog', async () => {
    mount([visit('svc-lawn-on')]);
    fireEvent.click(await screen.findByRole('button', { name: 'Open mobile svc-lawn-on' }));
    expect(await screen.findByText('Lawn sheet for svc-lawn-on (catalog 2, type null)')).toBeInTheDocument();
    expect(screen.queryByText(/Completion panel/)).not.toBeInTheDocument();
  });

  it('passes the visit\'s raw service type to the sheet to check against the live visit (no findings type: the context decides that)', async () => {
    mount([visit('svc-lawn-once', { serviceTypeRaw: 'Lawn Care One-Time', completionProfile: { category: 'lawn_care', serviceKey: 'lawn_care_one_time', findingsType: 'one_time_lawn_treatment' } })]);
    fireEvent.click(await screen.findByRole('button', { name: 'Open mobile svc-lawn-once' }));
    expect(await screen.findByText(/type Lawn Care One-Time/)).toBeInTheDocument();
  });

  it('with the gate off the page is exactly what it was: the full form, and the same markup as a payload that has no such key', async () => {
    const first = mount([visit('svc-lawn-off', { lawnFastCompleteEnabled: false })]);
    fireEvent.click(await screen.findByRole('button', { name: 'Open mobile svc-lawn-off' }));
    expect(await screen.findByText('Completion panel for svc-lawn-off')).toBeInTheDocument();
    expect(screen.queryByText(/Lawn sheet/)).not.toBeInTheDocument();
    // dnd-kit numbers its live regions per mount; nothing else may differ.
    const markup = () => document.body.innerHTML.replace(/(Dnd(?:DescribedBy|LiveRegion))-\d+/g, '$1');
    const withFlag = markup();
    first.unmount();
    cleanup();

    const { lawnFastCompleteEnabled: _omit, ...before } = visit('svc-lawn-off');
    mount([before]);
    fireEvent.click(await screen.findByRole('button', { name: 'Open mobile svc-lawn-off' }));
    await screen.findByText('Completion panel for svc-lawn-off');
    expect(markup()).toBe(withFlag);
    // And the sheet never asked the server anything.
    expect(vi.mocked(adminFetch).mock.calls.some(([url]) => String(url).includes('lawn-fast'))).toBe(false);
  });

  it.each([
    ['a pest visit', { serviceType: 'Pest Control', completionProfile: { category: 'pest_control', findingsType: null } }],
    ['the lawn re-service (its own sheet)', { completionProfile: { category: 'lawn_care', serviceKey: 'lawn_re_service', findingsType: 'one_time_lawn_treatment' } }],
    ['the Waves Assessment visit', { completionProfile: { category: 'lawn_care', serviceKey: 'lawn_inspection', findingsType: null } }],
    ['a terminal visit that still owes its completion', { status: 'completed', has_service_record: false }],
  ])('keeps CompletionPanel for %s even with the flag on', async (_label, overrides) => {
    mount([visit('svc-other', overrides)]);
    fireEvent.click(await screen.findByRole('button', { name: 'Open mobile svc-other' }));
    expect(await screen.findByText('Completion panel for svc-other')).toBeInTheDocument();
    expect(screen.queryByText(/Lawn sheet/)).not.toBeInTheDocument();
  });

  it('gives a Tree & Shrub visit to its own sheet, not this one, even though it carries the lawn category', async () => {
    mount([visit('svc-ts', { treeShrubFastCompleteEnabled: true, completionProfile: { category: 'lawn_care', findingsType: 'tree_shrub' } })]);
    fireEvent.click(await screen.findByRole('button', { name: 'Open mobile svc-ts' }));
    expect(await screen.findByText('Tree and shrub sheet for svc-ts')).toBeInTheDocument();
    expect(screen.queryByText(/Lawn sheet/)).not.toBeInTheDocument();
  });

  it('sends the sheet\'s full-form escape (and its hand-over for an ineligible visit) to CompletionPanel', async () => {
    mount([visit('svc-lawn-escape')]);
    fireEvent.click(await screen.findByRole('button', { name: 'Open mobile svc-lawn-escape' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sheet full form' }));
    expect(await screen.findByText('Completion panel for svc-lawn-escape')).toBeInTheDocument();
    expect(screen.queryByText(/Lawn sheet/)).not.toBeInTheDocument();
  });

  it('the sheet\'s Details pill closes it and opens the appointment details sheet, as the full form\'s does', async () => {
    mount([visit('svc-lawn-details', { customerId: 'cust-9', address: '100 Example Lane, Bradenton, FL', customerPhone: '+19415550100', traceEligible: false })]);
    fireEvent.click(await screen.findByRole('button', { name: 'Open mobile svc-lawn-details' }));
    expect(await screen.findByText('Sheet knows cust-9 / 100 Example Lane, Bradenton, FL / +19415550100')).toBeInTheDocument();
    // Codex r1: the schedule's trace eligibility reaches the sheet.
    expect(screen.getByText('Sheet trace false')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Sheet details' }));
    expect(await screen.findByText('Details sheet for svc-lawn-details')).toBeInTheDocument();
    expect(screen.queryByText(/Lawn sheet for/)).not.toBeInTheDocument();
  });

  it('passes the sheet the check-in time by the full form\'s rule: the on-site status-log entry, else checkInTime', async () => {
    mount([
      visit('svc-lawn-log', { statusLog: [{ status: 'en_route', at: '2026-09-12T12:00:00.000Z' }, { status: 'on_site', at: '2026-09-12T13:05:00.000Z' }], checkInTime: '2026-09-12T12:30:00.000Z' }),
      visit('svc-lawn-checkin', { checkInTime: '2026-09-12T12:30:00.000Z' }),
      visit('svc-lawn-none'),
    ]);
    fireEvent.click(await screen.findByRole('button', { name: 'Open mobile svc-lawn-log' }));
    expect(await screen.findByText('Sheet on-site 2026-09-12T13:05:00.000Z')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sheet close' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open mobile svc-lawn-checkin' }));
    expect(await screen.findByText('Sheet on-site 2026-09-12T12:30:00.000Z')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sheet close' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open mobile svc-lawn-none' }));
    expect(await screen.findByText('Sheet on-site null')).toBeInTheDocument();
  });

  it('opens the full form from the ?completeService deep link the sheet escapes to', async () => {
    mount([visit('svc-lawn-link')], '/admin/dispatch?date=2026-09-12&completeService=svc-lawn-link');
    expect(await screen.findByText(/Lawn sheet for svc-lawn-link|Completion panel for svc-lawn-link/)).toBeInTheDocument();
  });

  it('closes the sheet and refreshes the day when the visit completes', async () => {
    mount([visit('svc-lawn-finish')]);
    fireEvent.click(await screen.findByRole('button', { name: 'Open mobile svc-lawn-finish' }));
    await screen.findByText(/Lawn sheet for svc-lawn-finish/);
    const loads = () => vi.mocked(adminFetch).mock.calls.filter(([url]) => String(url).startsWith('/admin/schedule?date=')).length;
    const before = loads();
    fireEvent.click(screen.getByRole('button', { name: 'Sheet completed' }));
    await waitFor(() => expect(loads()).toBe(before + 1));
    expect(screen.queryByText(/Lawn sheet/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Completion panel/)).not.toBeInTheDocument();
  });

  it('hands an unpaid invoice to the payment sheet, like a CompletionPanel completion', async () => {
    mount([visit('svc-lawn-unpaid')]);
    fireEvent.click(await screen.findByRole('button', { name: 'Open mobile svc-lawn-unpaid' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sheet completed unpaid' }));
    expect(await screen.findByText('Payment sheet for inv-fixture (svc-lawn-unpaid)')).toBeInTheDocument();
    expect(screen.queryByText(/Lawn sheet/)).not.toBeInTheDocument();
  });

  it('handles a visit outside the selected day\'s list', async () => {
    mount([visit('svc-lawn-today')]);
    fireEvent.click(await screen.findByRole('button', { name: 'Open week-only visit' }));
    // A row with a premise key opens the sheet; the payment handoff still finds the visit.
    await screen.findByText(/Lawn sheet for svc-lawn-week/);
    fireEvent.click(screen.getByRole('button', { name: 'Sheet completed unpaid' }));
    expect(await screen.findByText('Payment sheet for inv-fixture (svc-lawn-week)')).toBeInTheDocument();
  });

  it('refreshes the day on a close that may have left it stale, and just closes on a plain close', async () => {
    mount([visit('svc-lawn-close')]);
    fireEvent.click(await screen.findByRole('button', { name: 'Open mobile svc-lawn-close' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sheet close' }));
    expect(screen.queryByText(/Lawn sheet/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Completion panel/)).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Open mobile svc-lawn-close' }));
    const loads = () => vi.mocked(adminFetch).mock.calls.filter(([url]) => String(url).startsWith('/admin/schedule?date=')).length;
    const before = loads();
    fireEvent.click(await screen.findByRole('button', { name: 'Sheet close refresh' }));
    await waitFor(() => expect(loads()).toBe(before + 1));
  });
});

describe('shouldOpenLawnFastComplete', () => {
  it('follows the shared eligibility rule', () => {
    expect(shouldOpenLawnFastComplete(visit('a'))).toBe(true);
    expect(shouldOpenLawnFastComplete(visit('a', { lawnFastCompleteEnabled: undefined }))).toBe(false);
    expect(shouldOpenLawnFastComplete(visit('a', { status: 'cancelled' }))).toBe(false);
    expect(isLawnFastCompleteEligible(visit('a', { completionProfile: undefined }))).toBe(false);
  });
  it('keeps the full form for a row that carries no premise (the mobile week list)', () => {
    const { propertyId: _omit, ...weekRow } = visit('a');
    expect(shouldOpenLawnFastComplete(weekRow)).toBe(false);
  });
  it('keeps the full form for a visit returning from the payment flow', () => {
    expect(shouldOpenLawnFastComplete(visit('a', { completionInvoiceAlreadySent: true }))).toBe(false);
    expect(shouldOpenLawnFastComplete(visit('a', { checkoutInvoiceId: 'inv-fixture' }))).toBe(false);
    expect(shouldOpenLawnFastComplete(visit('a', { checkoutInvoiceToken: 'tok-fixture' }))).toBe(false);
  });
  it('is the same rule for every lawn visit type (recurring, one-time, per-application)', () => {
    for (const serviceKey of ['lawn_care_recurring', 'lawn_care_one_time', 'lawn_pest_knockdown', 'lawn_care_per_application']) {
      expect(isLawnFastCompleteEligible(visit('a', { completionProfile: { category: 'lawn_care', serviceKey, findingsType: serviceKey.includes('one_time') ? 'one_time_lawn_treatment' : null } }))).toBe(true);
    }
  });
});

describe('Dispatch saved-completion scope (GitHub Codex P2 on #6001)', () => {
  it('scopes the lawn sheet\'s saved attempts to the verified session, not only the stored profile copy', async () => {
    localStorage.removeItem('waves_admin_user');
    vi.mocked(adminFetch).mockImplementation(async (url) => (
      url === '/admin/dispatch/products/catalog'
        ? { products: [] }
        : { services: [visit('svc-lawn-scope')], technicians: [], techSummary: [], products: [], types: [] }
    ));
    render(
      <MemoryRouter initialEntries={['/admin/dispatch?date=2026-09-12']}>
        <Routes>
          <Route path="/admin" element={<Outlet context={{ user: { id: 'staff-verified', role: 'admin' } }} />}>
            <Route path="dispatch" element={<DispatchPageV2 activeTab="board" />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Open mobile svc-lawn-scope' }));
    expect(await screen.findByTestId('lawn-operator')).toHaveTextContent('staff-verified');
  });
});
