// @vitest-environment jsdom
// Pest Fast Complete on admin Dispatch (owner 2026-10-05, GATE_FAST_COMPLETE_REPORT):
// an eligible open regular pest visit or pest re-service opens the one-screen
// report-flow sheet instead of CompletionPanel. The sheet's own "Full form"
// button opens CompletionPanel. The gate off (`fastCompleteReportEnabled` not
// true), lawn, typed visits and terminal visits keep the long form as before.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DispatchPageV2 from './DispatchPageV2';
import { adminFetch } from '../../utils/admin-fetch';

vi.mock('../../utils/admin-fetch', () => ({ adminFetch: vi.fn(), isRateLimitError: () => false }));
vi.mock('./SchedulePage', () => ({
  CompletionPanel: ({ service }) => <div>Completion panel for {service.id}</div>,
  RescheduleModal: () => null,
  EditServiceModal: () => null,
  ProtocolPanel: () => null,
  completionResumeOwed: () => false,
}));
vi.mock('../../components/tech/FastCompleteTreeShrubSheet', () => ({ default: ({ service }) => <div>Tree and shrub sheet for {service.id}</div> }));
vi.mock('../../components/tech/FastCompleteLawnSheet', () => ({ default: ({ service }) => <div>Lawn sheet for {service.id}</div> }));
vi.mock('../../components/tech/FastCompleteSheet', () => ({
  default: ({ service, voiceFillEnabled, onClose, onCompleted, onFullForm }) => (
    <div>
      Pest sheet for {service.id} (flow {String(service.reportFlow)}, trace {String(service.traceEligible)}, key {String(service.routedServiceKey)}, voice {String(voiceFillEnabled)})
      <button type="button" onClick={() => onClose()}>Sheet close</button>
      <button type="button" onClick={() => onClose({ refresh: true })}>Sheet close refresh</button>
      <button type="button" onClick={() => onCompleted()}>Sheet completed</button>
      <button type="button" onClick={onFullForm}>Full form</button>
    </div>
  ),
}));
vi.mock('../../components/schedule/MobileDispatchList', () => ({ default: ({ services = [], onEdit }) => <div>
  {services.map((service) => <button key={service.id} aria-label={`Open mobile ${service.id}`} onClick={() => onEdit(service)}>Mobile visit</button>)}
</div> }));
vi.mock('../../components/schedule/MobilePaymentSheet', () => ({ default: () => null }));
vi.mock('../../components/schedule/MobileAppointmentDetailSheet', () => ({ default: ({ service }) => <div>Details sheet for {service.id}</div> }));
vi.mock('../../components/schedule/MobileDayStrip', () => ({ default: () => <div>Day strip</div> }));
vi.mock('../../hooks/useFeatureFlag', () => ({ useFeatureFlag: () => false }));

const visit = (id, overrides = {}) => ({
  id,
  customerName: `Fixture ${id}`,
  address: '100 Example Lane',
  serviceType: 'Pest Control',
  status: 'on_site',
  scheduledDate: '2026-09-12',
  propertyId: null,
  completionProfile: { category: 'pest_control', serviceKey: 'pest_control_quarterly', findingsType: null },
  fastCompleteReportEnabled: true,
  ...overrides,
});

function mount(services, path = '/admin/dispatch?date=2026-09-12') {
  vi.mocked(adminFetch).mockImplementation(async (url) => (
    url === '/admin/dispatch/products/catalog'
      ? { products: [] }
      : { services, technicians: [], techSummary: [], products: [], types: [] }
  ));
  return render(<MemoryRouter initialEntries={[path]}><DispatchPageV2 activeTab="board" /></MemoryRouter>);
}
const open = async (id) => fireEvent.click(await screen.findByRole('button', { name: `Open mobile ${id}` }));

beforeEach(() => {
  vi.stubGlobal('innerWidth', 390);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ alerts: [] }) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('Dispatch completion routing for regular pest visits', () => {
  it('opens the sheet in its report flow, not CompletionPanel, for an eligible open pest visit', async () => {
    mount([visit('svc-pest-on', { fastCompleteVoiceFillEnabled: true })]);
    await open('svc-pest-on');
    expect(await screen.findByText('Pest sheet for svc-pest-on (flow true, trace true, key pest_control_quarterly, voice true)')).toBeInTheDocument();
    expect(screen.queryByText(/Completion panel/)).not.toBeInTheDocument();
  });

  it('opens it for a pest re-service too, and passes the trace verdict', async () => {
    mount([visit('svc-pest-re', { traceEligible: false, completionProfile: { category: 'pest_control', serviceKey: 'pest_re_service', findingsType: null } })]);
    await open('svc-pest-re');
    expect(await screen.findByText(/Pest sheet for svc-pest-re \(flow true, trace false, key pest_re_service/)).toBeInTheDocument();
  });

  it('"Full form" closes the sheet and opens CompletionPanel for that visit', async () => {
    mount([visit('svc-pest-escape')]);
    await open('svc-pest-escape');
    fireEvent.click(await screen.findByRole('button', { name: 'Full form' }));
    expect(await screen.findByText('Completion panel for svc-pest-escape')).toBeInTheDocument();
    expect(screen.queryByText(/Pest sheet/)).not.toBeInTheDocument();
  });

  it('with the gate off (fastCompleteReportEnabled false or absent) keeps CompletionPanel', async () => {
    mount([visit('svc-pest-off', { fastCompleteReportEnabled: false }), visit('svc-pest-absent', { fastCompleteReportEnabled: undefined })]);
    await open('svc-pest-off');
    expect(await screen.findByText('Completion panel for svc-pest-off')).toBeInTheDocument();
    expect(screen.queryByText(/Pest sheet/)).not.toBeInTheDocument();
    cleanup();
    mount([visit('svc-pest-absent', { fastCompleteReportEnabled: undefined })]);
    await open('svc-pest-absent');
    expect(await screen.findByText('Completion panel for svc-pest-absent')).toBeInTheDocument();
    expect(screen.queryByText(/Pest sheet/)).not.toBeInTheDocument();
  });

  it.each([
    ['a terminal visit that still owes its completion', { status: 'completed', has_service_record: false }],
    ['a typed visit (findings type)', { completionProfile: { category: 'pest_control', serviceKey: 'cockroach', findingsType: 'cockroach' } }],
    ['a combined visit (companions)', { completionProfile: { category: 'pest_control', serviceKey: 'pest_control_quarterly', findingsType: null, companions: [{ type: 'rodent_bait' }] } }],
    ['an outline-traced visit', { traceVariant: 'outline' }],
    ['a failed linked-project lookup', { linkedProjectLookupFailed: true }],
    ['a visit returning from the payment flow', { completionInvoiceAlreadySent: true }],
  ])('keeps CompletionPanel for %s even with the flag on', async (_label, overrides) => {
    mount([visit('svc-other', overrides)]);
    await open('svc-other');
    expect(await screen.findByText('Completion panel for svc-other')).toBeInTheDocument();
    expect(screen.queryByText(/Pest sheet/)).not.toBeInTheDocument();
  });

  it('keeps lawn and tree & shrub on their own routes (the pest rule never claims them)', async () => {
    mount([
      visit('svc-lawn', { lawnFastCompleteEnabled: true, completionProfile: { category: 'lawn_care', serviceKey: 'lawn_care_recurring', findingsType: null } }),
      visit('svc-lawn-off', { completionProfile: { category: 'lawn_care', serviceKey: 'lawn_care_recurring', findingsType: null } }),
    ]);
    await open('svc-lawn');
    expect(await screen.findByText('Lawn sheet for svc-lawn')).toBeInTheDocument();
    expect(screen.queryByText(/Pest sheet/)).not.toBeInTheDocument();
    cleanup();
    mount([visit('svc-lawn-off', { completionProfile: { category: 'lawn_care', serviceKey: 'lawn_care_recurring', findingsType: null } })]);
    await open('svc-lawn-off');
    expect(await screen.findByText('Completion panel for svc-lawn-off')).toBeInTheDocument();
    expect(screen.queryByText(/Pest sheet/)).not.toBeInTheDocument();
  });

  it('opens the long form from the ?completeService deep link (the Full form escape target)', async () => {
    mount([visit('svc-pest-link')], '/admin/dispatch?date=2026-09-12&completeService=svc-pest-link');
    expect(await screen.findByText('Completion panel for svc-pest-link')).toBeInTheDocument();
    expect(screen.queryByText(/Pest sheet/)).not.toBeInTheDocument();
  });

  it('closes the sheet and refreshes the day when the visit completes', async () => {
    mount([visit('svc-pest-finish')]);
    await open('svc-pest-finish');
    await screen.findByText(/Pest sheet for svc-pest-finish/);
    const loads = () => vi.mocked(adminFetch).mock.calls.filter(([url]) => String(url).startsWith('/admin/schedule?date=')).length;
    const before = loads();
    fireEvent.click(screen.getByRole('button', { name: 'Sheet completed' }));
    await waitFor(() => expect(loads()).toBe(before + 1));
    expect(screen.queryByText(/Pest sheet/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Completion panel/)).not.toBeInTheDocument();
  });

  it('refreshes the day on a close that may have left it stale, and just closes on a plain close', async () => {
    mount([visit('svc-pest-close')]);
    await open('svc-pest-close');
    fireEvent.click(await screen.findByRole('button', { name: 'Sheet close' }));
    expect(screen.queryByText(/Pest sheet/)).not.toBeInTheDocument();
    await open('svc-pest-close');
    const loads = () => vi.mocked(adminFetch).mock.calls.filter(([url]) => String(url).startsWith('/admin/schedule?date=')).length;
    const before = loads();
    fireEvent.click(await screen.findByRole('button', { name: 'Sheet close refresh' }));
    await waitFor(() => expect(loads()).toBe(before + 1));
  });
});
