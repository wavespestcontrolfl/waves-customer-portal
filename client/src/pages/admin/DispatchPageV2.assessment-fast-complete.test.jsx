// @vitest-environment jsdom
// Waves Assessment Fast Complete on admin Dispatch (GATE_ASSESSMENT_FAST_COMPLETE):
// an eligible open assessment opens the one-screen sheet instead of
// CompletionPanel; with the row flag off it opens the full form exactly as
// before; the sheet's own "Full form" escape and its completion are wired like
// the Tree & Shrub sheet's.
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
vi.mock('../../components/tech/FastCompleteAssessmentSheet', () => ({
  default: ({ service, onClose, onCompleted, onFullForm }) => (
    <div>
      Assessment sheet for {service.id} credit {String(service.inspectionCreditAvailable)} property {String(service.routedPropertyId)}
      {' '}address [{service.address}] full [{service.fullAddress}]
      <button type="button" onClick={() => onClose()}>Sheet close</button>
      <button type="button" onClick={() => onCompleted({ success: true })}>Sheet completed</button>
      <button type="button" onClick={onFullForm}>Sheet full form</button>
    </div>
  ),
}));
vi.mock('../../components/schedule/MobileDispatchList', () => ({ default: ({ services = [], onEdit }) => <div>
  {services.map((service) => <button key={service.id} aria-label={`Open mobile ${service.id}`} onClick={() => onEdit(service)}>Mobile visit</button>)}
</div> }));
vi.mock('../../components/schedule/MobilePaymentSheet', () => ({ default: () => <div>Payment sheet</div> }));
vi.mock('../../components/schedule/MobileDayStrip', () => ({ default: () => <div>Day strip</div> }));
vi.mock('../../hooks/useFeatureFlag', () => ({ useFeatureFlag: () => false, useFeatureFlagReady: () => ({ enabled: false, ready: true, known: true }) }));

const visit = (id, overrides = {}) => ({
  id,
  customerName: `Fixture ${id}`,
  address: '100 Example Lane',
  serviceType: 'Waves Assessment',
  status: 'on_site',
  scheduledDate: '2026-09-12',
  propertyId: 'prop-fixture',
  completionProfile: { category: 'inspection', serviceKey: 'lawn_inspection', companions: [] },
  inspectionCreditAvailable: true,
  assessmentFastCompleteEnabled: true,
  ...overrides,
});

function mount(services) {
  vi.mocked(adminFetch).mockImplementation(async (url) => (
    url === '/admin/dispatch/products/catalog'
      ? { products: [] }
      : { services, technicians: [], techSummary: [], products: [], types: [] }
  ));
  return render(<MemoryRouter initialEntries={['/admin/dispatch?date=2026-09-12']}><DispatchPageV2 activeTab="board" /></MemoryRouter>);
}

beforeEach(() => {
  vi.stubGlobal('innerWidth', 390);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ alerts: [] }) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('Dispatch completion routing for the Waves Assessment', () => {
  it('opens the sheet, not CompletionPanel, for an eligible open assessment', async () => {
    mount([visit('svc-as-on', { address: '100 Example Lane, Bradenton, FL 34201' })]);
    fireEvent.click(await screen.findByRole('button', { name: 'Open mobile svc-as-on' }));
    expect(await screen.findByText(/Assessment sheet for svc-as-on credit true property prop-fixture/)).toBeInTheDocument();
    // The sheet shows the short line and gets the whole address for the estimate prefill.
    expect(screen.getByText(/address \[100 Example Lane\] full \[100 Example Lane, Bradenton, FL 34201\]/)).toBeInTheDocument();
    expect(screen.queryByText(/Completion panel/)).not.toBeInTheDocument();
  });

  it('keeps CompletionPanel when the row flag is off, as before', async () => {
    mount([visit('svc-as-off', { assessmentFastCompleteEnabled: false })]);
    fireEvent.click(await screen.findByRole('button', { name: 'Open mobile svc-as-off' }));
    expect(await screen.findByText('Completion panel for svc-as-off')).toBeInTheDocument();
    expect(screen.queryByText(/Assessment sheet/)).not.toBeInTheDocument();
  });

  it('sends the sheet\'s full-form escape to CompletionPanel for that visit', async () => {
    mount([visit('svc-as-escape')]);
    fireEvent.click(await screen.findByRole('button', { name: 'Open mobile svc-as-escape' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sheet full form' }));
    expect(await screen.findByText('Completion panel for svc-as-escape')).toBeInTheDocument();
    expect(screen.queryByText(/Assessment sheet/)).not.toBeInTheDocument();
  });

  it('closes the sheet and refreshes the day when the visit completes', async () => {
    mount([visit('svc-as-finish')]);
    fireEvent.click(await screen.findByRole('button', { name: 'Open mobile svc-as-finish' }));
    await screen.findByText(/Assessment sheet for svc-as-finish/);
    const loads = () => vi.mocked(adminFetch).mock.calls.filter(([url]) => String(url).startsWith('/admin/schedule?date=')).length;
    const before = loads();
    fireEvent.click(screen.getByRole('button', { name: 'Sheet completed' }));
    await waitFor(() => expect(loads()).toBe(before + 1));
    expect(screen.queryByText(/Assessment sheet/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Completion panel/)).not.toBeInTheDocument();
  });
});
