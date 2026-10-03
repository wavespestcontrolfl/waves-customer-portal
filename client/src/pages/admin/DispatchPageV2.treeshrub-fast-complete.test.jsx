// @vitest-environment jsdom
// Tree & Shrub Fast Complete on admin Dispatch (GATE_TS_FAST_COMPLETE): an
// eligible open visit opens the one-screen sheet instead of CompletionPanel,
// by the same rule the technician home page uses. Everything else, and the
// sheet's own "Full form" escape, keeps the long typed form.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DispatchPageV2 from './DispatchPageV2';
import { adminFetch } from '../../utils/admin-fetch';
import { shouldOpenTreeShrubFastComplete } from '../../lib/dispatchCompletionRouting';

vi.mock('../../utils/admin-fetch', () => ({ adminFetch: vi.fn(), isRateLimitError: () => false }));
vi.mock('./SchedulePage', () => ({
  CompletionPanel: ({ service }) => <div>Completion panel for {service.id}</div>,
  RescheduleModal: () => null,
  EditServiceModal: () => null,
  ProtocolPanel: () => null,
  completionResumeOwed: () => false,
}));
vi.mock('../../components/tech/FastCompleteTreeShrubSheet', () => ({
  default: ({ service, onClose, onCompleted, onFullForm }) => (
    <div>
      Tree and shrub sheet for {service.id}
      <button type="button" onClick={() => onClose()}>Sheet close</button>
      <button type="button" onClick={() => onCompleted()}>Sheet completed</button>
      <button type="button" onClick={() => onCompleted({ invoiceId: 'inv-fixture', invoiceToken: 'tok-fixture', invoiceTotal: 85, invoicePaymentActionRequired: true })}>Sheet completed unpaid</button>
      <button type="button" onClick={() => onCompleted({ invoiceId: 'inv-fixture', invoiceToken: 'tok-fixture', invoiceTotal: 85, invoiceStatus: 'paid' })}>Sheet completed paid</button>
      <button type="button" onClick={onFullForm}>Sheet full form</button>
    </div>
  ),
}));
vi.mock('../../components/schedule/MobileDispatchList', () => ({ default: ({ services = [], onEdit }) => <div>
  {services.map((service) => <button key={service.id} aria-label={`Open mobile ${service.id}`} onClick={() => onEdit(service)}>Mobile visit</button>)}
  {/* A week-view row: a visit that is not in the selected day's list. */}
  <button aria-label="Open week-only visit" onClick={() => onEdit({ id: 'svc-ts-week', customerName: 'Fixture week', address: '200 Example Lane', serviceType: 'Tree & Shrub Program', status: 'on_site', scheduledDate: '2026-09-14', completionProfile: { category: 'lawn_care', findingsType: 'tree_shrub' }, treeShrubFastCompleteEnabled: true })}>Week visit</button>
</div> }));
vi.mock('../../components/schedule/MobilePaymentSheet', () => ({
  default: ({ invoiceId, service }) => <div>Payment sheet for {invoiceId} ({service?.id || 'no service'})</div>,
}));
vi.mock('../../components/schedule/MobileDayStrip', () => ({ default: () => <div>Day strip</div> }));
vi.mock('../../hooks/useFeatureFlag', () => ({ useFeatureFlag: () => false }));

const visit = (id, overrides = {}) => ({
  id,
  customerName: `Fixture ${id}`,
  address: '100 Example Lane',
  serviceType: 'Tree & Shrub Program',
  status: 'on_site',
  scheduledDate: '2026-09-12',
  completionProfile: { category: 'lawn_care', findingsType: 'tree_shrub' },
  treeShrubFastCompleteEnabled: true,
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

beforeEach(() => {
  vi.stubGlobal('innerWidth', 390);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ alerts: [] }) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('Dispatch completion routing for Tree & Shrub', () => {
  it('opens the sheet, not CompletionPanel, for an eligible open visit', async () => {
    mount([visit('svc-ts-on')]);
    fireEvent.click(await screen.findByRole('button', { name: 'Open mobile svc-ts-on' }));
    expect(await screen.findByText('Tree and shrub sheet for svc-ts-on')).toBeInTheDocument();
    expect(screen.queryByText(/Completion panel/)).not.toBeInTheDocument();
  });

  it('keeps CompletionPanel when the flag is false', async () => {
    mount([visit('svc-ts-off', { treeShrubFastCompleteEnabled: false })]);
    fireEvent.click(await screen.findByRole('button', { name: 'Open mobile svc-ts-off' }));
    expect(await screen.findByText('Completion panel for svc-ts-off')).toBeInTheDocument();
    expect(screen.queryByText(/Tree and shrub sheet/)).not.toBeInTheDocument();
  });

  it('keeps CompletionPanel for a visit that is not tree & shrub even with the flag on', async () => {
    mount([visit('svc-other', { serviceType: 'Pest Control', completionProfile: { category: 'pest_control', findingsType: null } })]);
    fireEvent.click(await screen.findByRole('button', { name: 'Open mobile svc-other' }));
    expect(await screen.findByText('Completion panel for svc-other')).toBeInTheDocument();
    expect(screen.queryByText(/Tree and shrub sheet/)).not.toBeInTheDocument();
  });

  it('keeps CompletionPanel for a terminal visit that still owes its completion', async () => {
    mount([visit('svc-ts-done', { status: 'completed', has_service_record: false })]);
    fireEvent.click(await screen.findByRole('button', { name: 'Open mobile svc-ts-done' }));
    expect(await screen.findByText('Completion panel for svc-ts-done')).toBeInTheDocument();
    expect(screen.queryByText(/Tree and shrub sheet/)).not.toBeInTheDocument();
  });

  it('sends the sheet\'s full-form escape to CompletionPanel for that visit', async () => {
    mount([visit('svc-ts-escape')]);
    fireEvent.click(await screen.findByRole('button', { name: 'Open mobile svc-ts-escape' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sheet full form' }));
    expect(await screen.findByText('Completion panel for svc-ts-escape')).toBeInTheDocument();
    expect(screen.queryByText(/Tree and shrub sheet/)).not.toBeInTheDocument();
  });

  it('opens the full form from the ?completeService deep link the tech sheet escapes to', async () => {
    mount([visit('svc-ts-link')], '/admin/dispatch?date=2026-09-12&completeService=svc-ts-link');
    expect(await screen.findByText('Completion panel for svc-ts-link')).toBeInTheDocument();
    expect(screen.queryByText(/Tree and shrub sheet/)).not.toBeInTheDocument();
  });

  it('closes the sheet and refreshes the day when the visit completes', async () => {
    mount([visit('svc-ts-finish')]);
    fireEvent.click(await screen.findByRole('button', { name: 'Open mobile svc-ts-finish' }));
    await screen.findByText('Tree and shrub sheet for svc-ts-finish');
    const loads = () => vi.mocked(adminFetch).mock.calls.filter(([url]) => String(url).startsWith('/admin/schedule?date=')).length;
    const before = loads();
    fireEvent.click(screen.getByRole('button', { name: 'Sheet completed' }));
    await waitFor(() => expect(loads()).toBe(before + 1));
    expect(screen.queryByText(/Tree and shrub sheet/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Completion panel/)).not.toBeInTheDocument();
  });

  it('hands an unpaid invoice to the payment sheet, like a CompletionPanel completion', async () => {
    mount([visit('svc-ts-unpaid')]);
    fireEvent.click(await screen.findByRole('button', { name: 'Open mobile svc-ts-unpaid' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sheet completed unpaid' }));
    expect(await screen.findByText('Payment sheet for inv-fixture (svc-ts-unpaid)')).toBeInTheDocument();
    expect(screen.queryByText(/Tree and shrub sheet/)).not.toBeInTheDocument();
  });

  it('hands off an unpaid invoice for a week-view visit outside the selected day', async () => {
    mount([visit('svc-ts-today')]);
    fireEvent.click(await screen.findByRole('button', { name: 'Open week-only visit' }));
    await screen.findByText('Tree and shrub sheet for svc-ts-week');
    fireEvent.click(screen.getByRole('button', { name: 'Sheet completed unpaid' }));
    expect(await screen.findByText('Payment sheet for inv-fixture (svc-ts-week)')).toBeInTheDocument();
  });

  it('opens no payment sheet when the invoice is already paid', async () => {
    mount([visit('svc-ts-paid')]);
    fireEvent.click(await screen.findByRole('button', { name: 'Open mobile svc-ts-paid' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sheet completed paid' }));
    await waitFor(() => expect(screen.queryByText(/Tree and shrub sheet/)).not.toBeInTheDocument());
    expect(screen.queryByText(/Payment sheet/)).not.toBeInTheDocument();
  });

  it('just closes on a plain close', async () => {
    mount([visit('svc-ts-close')]);
    fireEvent.click(await screen.findByRole('button', { name: 'Open mobile svc-ts-close' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sheet close' }));
    expect(screen.queryByText(/Tree and shrub sheet/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Completion panel/)).not.toBeInTheDocument();
  });
});

describe('shouldOpenTreeShrubFastComplete', () => {
  it('follows the shared eligibility rule', () => {
    expect(shouldOpenTreeShrubFastComplete(visit('a'))).toBe(true);
    expect(shouldOpenTreeShrubFastComplete(visit('a', { treeShrubFastCompleteEnabled: undefined }))).toBe(false);
    expect(shouldOpenTreeShrubFastComplete(visit('a', { status: 'cancelled' }))).toBe(false);
  });
  it('keeps the full form for a visit returning from the payment flow', () => {
    expect(shouldOpenTreeShrubFastComplete(visit('a', { completionInvoiceAlreadySent: true }))).toBe(false);
    expect(shouldOpenTreeShrubFastComplete(visit('a', { checkoutInvoiceId: 'inv-fixture' }))).toBe(false);
  });
});
