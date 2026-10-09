// @vitest-environment jsdom
// GATE_FAST_COMPLETE_INVOICED_VISITS (owner 2026-10-09): admin Dispatch opens a
// visit that is already invoiced, or returning from the payment flow, in its
// Fast Complete sheet when the schedule row carries
// `invoicedVisitFastCompleteEnabled`, and keeps the full form without it. The
// sheet gets the marker it posts the full form's invoiceAlreadySent from, and a
// completion on a sheet never opens a second payment prompt for an invoice the
// visit already sent.
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
const UNPAID_RESPONSE = { invoiceId: 'inv-fixture', invoiceToken: 'tok-fixture', invoiceTotal: 80, invoiceStatus: 'sent', invoicePaymentActionRequired: true };
vi.mock('../../components/tech/FastCompleteTreeShrubSheet', () => ({
  default: ({ service, onCompleted }) => (
    <div>
      Tree and shrub sheet for {service.id} (invoice sent {String(service.completionInvoiceAlreadySent)})
      <button type="button" onClick={() => onCompleted(UNPAID_RESPONSE)}>Sheet completed</button>
    </div>
  ),
}));
vi.mock('../../components/tech/FastCompleteLawnSheet', () => ({
  default: ({ service, onCompleted }) => (
    <div>
      Lawn sheet for {service.id} (invoice sent {String(service.completionInvoiceAlreadySent)})
      <button type="button" onClick={() => onCompleted(UNPAID_RESPONSE)}>Sheet completed</button>
    </div>
  ),
}));
vi.mock('../../components/tech/FastCompleteLawnReserviceSheet', () => ({
  default: ({ service, onCompleted }) => (
    <div>
      Lawn re-service sheet for {service.id} (invoice sent {String(service.completionInvoiceAlreadySent)})
      <button type="button" onClick={() => onCompleted(UNPAID_RESPONSE)}>Sheet completed</button>
    </div>
  ),
}));
vi.mock('../../components/tech/FastCompleteSheet', () => ({
  default: ({ service, onCompleted }) => (
    <div>
      Pest sheet for {service.id} (invoice sent {String(service.completionInvoiceAlreadySent)})
      <button type="button" onClick={() => onCompleted(UNPAID_RESPONSE)}>Sheet completed</button>
    </div>
  ),
}));
vi.mock('../../components/schedule/MobileDispatchList', () => ({ default: ({ services = [], onEdit }) => <div>
  {services.map((service) => <button key={service.id} aria-label={`Open mobile ${service.id}`} onClick={() => onEdit(service)}>Mobile visit</button>)}
</div> }));
vi.mock('../../components/schedule/MobilePaymentSheet', () => ({ default: ({ invoiceId }) => <div>Payment sheet for {invoiceId}</div> }));
vi.mock('../../components/schedule/MobileAppointmentDetailSheet', () => ({ default: ({ service }) => <div>Details sheet for {service.id}</div> }));
vi.mock('../../components/schedule/MobileDayStrip', () => ({ default: () => <div>Day strip</div> }));
vi.mock('../../hooks/useFeatureFlag', () => ({ useFeatureFlag: () => false, useFeatureFlagReady: () => ({ enabled: false, ready: true, known: true }) }));

const FIXTURES = {
  pest: { serviceType: 'Pest Control', fastCompleteReportEnabled: true, completionProfile: { category: 'pest_control', serviceKey: 'pest_control_quarterly', findingsType: null } },
  lawn: { serviceType: 'Lawn Care', lawnFastCompleteEnabled: true, completionProfile: { category: 'lawn_care', serviceKey: 'lawn_care_recurring', findingsType: null } },
  tree_shrub: { serviceType: 'Tree & Shrub Program', treeShrubFastCompleteEnabled: true, completionProfile: { category: 'lawn_care', findingsType: 'tree_shrub' } },
  lawn_reservice: { serviceType: 'Lawn Re-Service', lawnReserviceFastCompleteEnabled: true, completionProfile: { category: 'lawn_care', serviceKey: 'lawn_re_service', findingsType: 'one_time_lawn_treatment' } },
};
const SHEET_TEXT = {
  pest: /^Pest sheet for svc-1/, lawn: /^Lawn sheet for svc-1/, tree_shrub: /^Tree and shrub sheet for svc-1/, lawn_reservice: /^Lawn re-service sheet for svc-1/,
};
const MARKERS = [
  ['completionInvoiceAlreadySent', true],
  ['checkoutInvoiceId', 'inv-fixture'],
  ['checkoutInvoiceToken', 'tok-fixture'],
];

const visit = (kind, overrides = {}) => ({
  id: 'svc-1',
  customerName: 'Fixture One',
  address: '100 Example Lane',
  status: 'on_site',
  scheduledDate: '2026-09-12',
  propertyId: null,
  ...FIXTURES[kind],
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
const open = async () => fireEvent.click(await screen.findByRole('button', { name: 'Open mobile svc-1' }));

beforeEach(() => {
  vi.stubGlobal('innerWidth', 390);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ alerts: [] }) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('a visit already invoiced, on admin Dispatch', () => {
  for (const kind of Object.keys(FIXTURES)) {
    for (const [marker, value] of MARKERS) {
      it(`${kind} with ${marker}: the full form while the gate is off`, async () => {
        mount([visit(kind, { [marker]: value })]);
        await open();
        expect(await screen.findByText('Completion panel for svc-1')).toBeInTheDocument();
        expect(screen.queryByText(SHEET_TEXT[kind])).not.toBeInTheDocument();
      });

      it(`${kind} with ${marker}: its sheet while the gate is on, with the marker the sheet posts the invoice field from`, async () => {
        mount([visit(kind, { [marker]: value, invoicedVisitFastCompleteEnabled: true })]);
        await open();
        const sheet = await screen.findByText(SHEET_TEXT[kind]);
        expect(sheet).toHaveTextContent(`(invoice sent ${marker === 'completionInvoiceAlreadySent'})`);
        expect(screen.queryByText('Completion panel for svc-1')).not.toBeInTheDocument();
      });
    }
  }
});

describe('completing an invoiced visit on a sheet', () => {
  const loads = () => vi.mocked(adminFetch).mock.calls.filter(([url]) => String(url).startsWith('/admin/schedule?date=')).length;

  for (const kind of Object.keys(FIXTURES)) {
    it(`${kind}: an unpaid invoice from checkout (collectible, no sent marker) opens the payment prompt the full form would`, async () => {
      mount([visit(kind, { checkoutInvoiceId: 'inv-fixture', invoicedVisitFastCompleteEnabled: true })]);
      await open();
      await screen.findByText(SHEET_TEXT[kind]);
      fireEvent.click(screen.getByRole('button', { name: 'Sheet completed' }));
      expect(await screen.findByText('Payment sheet for inv-fixture')).toBeInTheDocument();
    });

    it(`${kind}: an invoice the visit already sent opens no second payment prompt`, async () => {
      mount([visit(kind, { completionInvoiceAlreadySent: true, invoicedVisitFastCompleteEnabled: true })]);
      await open();
      await screen.findByText(SHEET_TEXT[kind]);
      const before = loads();
      fireEvent.click(screen.getByRole('button', { name: 'Sheet completed' }));
      await waitFor(() => expect(loads()).toBe(before + 1));
      expect(screen.queryByText(/Payment sheet for/)).not.toBeInTheDocument();
    });
  }

  for (const kind of ['lawn', 'tree_shrub']) {
    it(`${kind}: the same response for a visit with no sent invoice still opens the payment prompt (control)`, async () => {
      mount([visit(kind, { invoicedVisitFastCompleteEnabled: true })]);
      await open();
      await screen.findByText(SHEET_TEXT[kind]);
      fireEvent.click(screen.getByRole('button', { name: 'Sheet completed' }));
      expect(await screen.findByText('Payment sheet for inv-fixture')).toBeInTheDocument();
    });
  }

  for (const kind of ['pest', 'lawn_reservice']) {
    it(`${kind}: a visit with no invoice marker completes as it always did (no payment prompt from the sheet)`, async () => {
      mount([visit(kind, { invoicedVisitFastCompleteEnabled: true })]);
      await open();
      await screen.findByText(SHEET_TEXT[kind]);
      const before = loads();
      fireEvent.click(screen.getByRole('button', { name: 'Sheet completed' }));
      await waitFor(() => expect(loads()).toBe(before + 1));
      expect(screen.queryByText(/Payment sheet for/)).not.toBeInTheDocument();
    });
  }
});
