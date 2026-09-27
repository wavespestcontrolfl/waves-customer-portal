// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { adminFetch } from '../../lib/adminFetch';

vi.mock('../admin/CallBridgeLink', () => ({ default: ({ phone }) => <span>{phone}</span> }));
vi.mock('../../lib/cardHoldCancel', () => ({ confirmCardHoldFeeChoice: vi.fn() }));
vi.mock('../../lib/adminFetch', () => ({
  adminFetch: vi.fn(async () => ({
    ok: true,
    json: async () => ({
      customer: { firstName: 'Test', lastName: 'Customer' },
      payments: [],
      cards: [],
      // Newest-first history from the server; 9 rows so the 8-cap applies.
      scheduled: Array.from({ length: 9 }, (_, i) => ({
        id: `v${i}`,
        scheduled_date: `2026-0${9 - Math.floor(i / 4)}-${String(28 - (i % 4) * 7).padStart(2, '0')}`,
        status: 'completed',
        service_type: `Visit ${i}`,
      })),
    }),
  })),
}));

import ScheduleCustomerSidebar from './ScheduleCustomerSidebar';

afterEach(cleanup);

describe('ScheduleCustomerSidebar appointment history', () => {
  it('renders the newest 8 history rows without the helper being shadowed by the memo local', async () => {
    render(
      <ScheduleCustomerSidebar
        service={{ id: 'v0', customerId: 'c1', customerName: 'Test Customer', status: 'pending' }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText('Visit 0')).toBeTruthy());
    // The open visit is pinned server-side so a >cap customer still shows it.
    expect(adminFetch).toHaveBeenCalledWith('/admin/customers/c1?focusServiceId=v0');
    expect(screen.getByText('Visit 7')).toBeTruthy();
    expect(screen.queryByText('Visit 8')).toBeNull();
    expect(screen.getByText('Current')).toBeTruthy();
  });
});

describe('ScheduleCustomerSidebar unpriced-visit billingLane.prediction fallback', () => {
  // Codex pre-push P1: prediction.amount for a 'prepaid' kind is what was
  // ALREADY collected out of band, not a balance still due — displaying it
  // as the Total above the Take-payment action told the office $100 was
  // owed on a visit that was already fully paid.
  it('reads a fully-covered "prepaid" prediction as $0 due, never the prepaid figure itself', async () => {
    render(
      <ScheduleCustomerSidebar
        service={{
          id: 'v0',
          customerId: 'c1',
          customerName: 'Test Customer',
          status: 'confirmed',
          estimatedPrice: null,
          billingLane: {
            mode: 'per_application',
            source: 'explicit',
            monthlyRate: null,
            prediction: { kind: 'prepaid', amount: 100, grossAmount: 97.2, conflictStampedPrice: false },
          },
        }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText('Total')).toBeTruthy());
    expect(screen.getAllByText('$0.00').length).toBeGreaterThan(0);
    expect(screen.queryByText('$100.00')).toBeNull();
  });

  // Codex pre-push P1: `service?.estimatedPrice != null` reads a stamped 0
  // as an authoritative "$0 visit" too — 0 != null is true — so it must use
  // the SAME positive-price precedence as completionInvoiceAmount /
  // resolveScheduledServiceCharge (server/services/billing-lane.js,
  // server/routes/admin-schedule.js) and defer to the prediction exactly
  // like an absent price does.
  it('defers a stamped estimatedPrice of 0 to the acceptance-fee prediction, never previewing $0', async () => {
    render(
      <ScheduleCustomerSidebar
        service={{
          id: 'v0',
          customerId: 'c1',
          customerName: 'Test Customer',
          status: 'confirmed',
          estimatedPrice: 0,
          billingLane: {
            mode: 'per_application',
            source: 'explicit',
            monthlyRate: null,
            prediction: { kind: 'invoice', amount: 97.2, grossAmount: 97.2, conflictStampedPrice: false },
          },
        }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText('Total')).toBeTruthy());
    expect(screen.getAllByText('$97.20').length).toBeGreaterThan(0);
    expect(screen.queryByText('$0.00')).toBeNull();
  });
});

// Codex round-7 P1: a covered_sibling_invoice prediction whose sibling
// invoice is still collectible (draft/sent/overdue/…) used to render as a
// silent $0 Total with no explanation — the combined trip invoice still had
// a real balance due. These pin the settled-vs-collectible copy split and
// the deep link into that invoice; the collectible case fails on the
// pre-fix code (no covered_sibling_invoice branch existed here at all).
describe('ScheduleCustomerSidebar sibling-covered visit', () => {
  const baseService = {
    id: 'v0',
    customerId: 'c1',
    customerName: 'Test Customer',
    status: 'confirmed',
    estimatedPrice: null,
    billingLane: {
      mode: 'per_application',
      source: 'explicit',
      monthlyRate: 74.7,
      prediction: {
        kind: 'covered_sibling_invoice',
        amount: null,
        invoiceId: 'inv-1',
        invoiceNumber: 'WPC-TEST-0001',
        siblingServiceType: 'Quarterly Pest Control',
      },
    },
  };

  it('a settled (paid) sibling invoice reads as covered, no link needed', async () => {
    render(
      <ScheduleCustomerSidebar
        service={{
          ...baseService,
          billingLane: {
            ...baseService.billingLane,
            // The server's own canonical verdict (billing-lane.js
            // siblingCoverageForSchedule) — the sidebar renders THAT, never
            // a raw invoiceStatus.
            siblingCoverage: { state: 'settled', invoiceId: 'inv-1', invoiceNumber: 'WPC-TEST-0001', amountDue: 0, reason: 'invoice_settled' },
          },
        }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText('Total')).toBeTruthy());
    expect(screen.getAllByText('$0.00').length).toBeGreaterThan(0);
    expect(screen.getByText(/nothing to collect/i)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /open invoice/i })).toBeNull();
  });

  it('a collectible (sent) sibling invoice tells staff to collect there, with the amount due and a link to it', async () => {
    render(
      <ScheduleCustomerSidebar
        service={{
          ...baseService,
          billingLane: {
            ...baseService.billingLane,
            siblingCoverage: { state: 'collect_on_combined_invoice', invoiceId: 'inv-1', invoiceNumber: 'WPC-TEST-0001', amountDue: 153.6, reason: null },
          },
        }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText('Total')).toBeTruthy());
    expect(screen.queryByText(/nothing to collect/i)).toBeNull();
    expect(screen.getByText(/\$153\.60 due/i)).toBeTruthy();
    const link = screen.getByRole('link', { name: /open invoice/i });
    expect(link.getAttribute('href')).toBe('/admin/invoices/inv-1');
  });
});
