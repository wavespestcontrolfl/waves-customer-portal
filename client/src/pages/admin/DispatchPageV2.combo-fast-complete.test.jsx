// @vitest-environment jsdom
// Dispatch routing for a stop of one regular pest visit and one lawn visit (GATE_COMBO_FAST_COMPLETE): that exact pair
// opens the one-screen container, before the long visit closeout. Anything else (the gate flag off, a re-service or
// callback, three open members, a member returning from payment) keeps the long visit closeout as today; a terminal
// sibling beside the pair is history, not a member. The container's "Full form" opens the long closeout.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
vi.mock('../../components/tech/FastCompleteComboSheet', () => ({
  default: ({ visitId, pest, lawn, onFullForm }) => (
    <div>
      Combo sheet for {visitId} (pest {pest.service.id} flow {String(pest.service.reportFlow)}, lawn {lawn.service.id})
      <button type="button" onClick={onFullForm}>Combo full form</button>
    </div>
  ),
}));
vi.mock('../../components/admin/VisitCloseoutSheet', () => ({ default: ({ visitId }) => <div>Visit closeout for {visitId}</div> }));
vi.mock('../../components/tech/FastCompleteSheet', () => ({ default: ({ service }) => <div>Pest sheet for {service.id}</div> }));
vi.mock('../../components/tech/FastCompleteLawnSheet', () => ({ default: ({ service }) => <div>Lawn sheet for {service.id}</div> }));
vi.mock('../../components/schedule/MobileDispatchList', () => ({ default: ({ services = [], onEdit }) => <div>
  {services.map((service) => <button key={service.id} aria-label={`Open mobile ${service.id}`} onClick={() => onEdit(service)}>Mobile visit</button>)}
</div> }));
vi.mock('../../components/schedule/MobilePaymentSheet', () => ({ default: () => null }));
vi.mock('../../components/schedule/MobileAppointmentDetailSheet', () => ({ default: ({ service }) => <div>Details sheet for {service.id}</div> }));
vi.mock('../../components/schedule/MobileDayStrip', () => ({ default: () => <div>Day strip</div> }));
vi.mock('../../hooks/useFeatureFlag', () => ({ useFeatureFlag: () => false, useFeatureFlagReady: () => ({ enabled: false, ready: true, known: true }) }));

const base = (id, overrides = {}) => ({
  id, customerName: `Fixture ${id}`, address: '100 Example Lane', status: 'on_site', scheduledDate: '2026-09-12', propertyId: null,
  visitId: 'visit-1', visitCloseoutEnabled: true, comboFastCompleteEnabled: true, ...overrides,
});
const pest = (id = 'svc-pest', overrides = {}) => base(id, {
  serviceType: 'Quarterly Pest Control', fastCompleteReportEnabled: true,
  completionProfile: { category: 'pest_control', serviceKey: 'pest_general_quarterly', findingsType: null, companions: [] }, ...overrides,
});
const lawn = (id = 'svc-lawn', overrides = {}) => base(id, {
  serviceType: 'Lawn Care', lawnFastCompleteEnabled: true,
  completionProfile: { category: 'lawn_care', serviceKey: 'lawn_care_monthly', findingsType: null, companions: [] }, ...overrides,
});

function mount(services) {
  vi.mocked(adminFetch).mockImplementation(async (url) => (
    url === '/admin/dispatch/products/catalog' ? { products: [] } : { services, technicians: [], techSummary: [], products: [], types: [] }
  ));
  return render(<MemoryRouter initialEntries={['/admin/dispatch?date=2026-09-12']}><DispatchPageV2 activeTab="board" /></MemoryRouter>);
}
const open = async (id) => fireEvent.click(await screen.findByRole('button', { name: `Open mobile ${id}` }));

beforeEach(() => {
  vi.stubGlobal('innerWidth', 390);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ alerts: [] }) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('Dispatch routing for a pest + lawn stop', () => {
  it('opens the container for the pair, from either member, before the visit closeout', async () => {
    mount([pest(), lawn()]);
    await open('svc-lawn');
    expect(await screen.findByText('Combo sheet for visit-1 (pest svc-pest flow true, lawn svc-lawn)')).toBeInTheDocument();
    expect(screen.queryByText(/Visit closeout for/)).not.toBeInTheDocument();
    cleanup();
    mount([pest(), lawn()]);
    await open('svc-pest');
    expect(await screen.findByText(/Combo sheet for visit-1/)).toBeInTheDocument();
  });

  it('a terminal sibling beside the pair is history: the container still opens', async () => {
    mount([pest(), lawn(), pest('svc-done', { status: 'completed' })]);
    await open('svc-pest');
    expect(await screen.findByText(/Combo sheet for visit-1/)).toBeInTheDocument();
  });

  it('the container\'s Full form opens the long visit closeout', async () => {
    mount([pest(), lawn()]);
    await open('svc-pest');
    fireEvent.click(await screen.findByRole('button', { name: 'Combo full form' }));
    expect(await screen.findByText('Visit closeout for visit-1')).toBeInTheDocument();
    expect(screen.queryByText(/Combo sheet for/)).not.toBeInTheDocument();
  });

  it.each([
    ['the gate flag off on the row', [pest('svc-pest', { comboFastCompleteEnabled: false }), lawn()]],
    ['the gate flag absent', [pest('svc-pest', { comboFastCompleteEnabled: undefined }), lawn('svc-lawn', { comboFastCompleteEnabled: undefined })]],
    ['a pest re-service', [pest('svc-pest', { completionProfile: { category: 'pest_control', serviceKey: 'pest_re_service', findingsType: null, companions: [] } }), lawn()]],
    ['a pest callback', [pest('svc-pest', { isCallback: true }), lawn()]],
    ['a lawn re-service', [pest(), lawn('svc-lawn', { completionProfile: { category: 'lawn_care', serviceKey: 'lawn_re_service', findingsType: null, companions: [] } })]],
    ['three open members', [pest(), lawn(), lawn('svc-lawn-2')]],
    ['two pest members', [pest(), pest('svc-pest-2')]],
    ['a typed pest visit', [pest('svc-pest', { fastCompleteReportEnabled: false, completionProfile: { category: 'pest_control', serviceKey: 'cockroach', findingsType: 'cockroach', companions: [] } }), lawn()]],
    ['a pest member returning from payment', [pest('svc-pest', { completionInvoiceAlreadySent: true }), lawn()]],
    ['a lawn member with a checkout invoice', [pest(), lawn('svc-lawn', { checkoutInvoiceId: 'inv-1' })]],
  ])('keeps the long visit closeout for %s', async (_label, services) => {
    mount(services);
    await open(services[0].id);
    expect(await screen.findByText('Visit closeout for visit-1')).toBeInTheDocument();
    expect(screen.queryByText(/Combo sheet for/)).not.toBeInTheDocument();
  });
});
