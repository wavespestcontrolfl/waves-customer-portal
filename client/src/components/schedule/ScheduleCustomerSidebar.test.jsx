// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { adminFetch } from '../../lib/adminFetch';
import { confirmCardHoldFeeChoice } from '../../lib/cardHoldCancel';

vi.mock('../admin/CallBridgeLink', () => ({ default: ({ phone }) => <span>{phone}</span> }));
// CancelFeeNotice (inside the cancel window) reads its own fee preview through fetchCardHoldCancelPreview.
vi.mock('../../lib/cardHoldCancel', () => ({ confirmCardHoldFeeChoice: vi.fn(), fetchCardHoldCancelPreview: vi.fn(async () => null) }));
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

afterEach(() => { cleanup(); localStorage.removeItem('waves_admin_user'); });

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

// Schedule access codes (owner ruling 2026-10-26): read-only Access block.
describe('ScheduleCustomerSidebar Access block', () => {
  it("shows the stop's codes with no buttons", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}), clone() { return this; }, text: async () => '', headers: { get: () => null } })));
    try {
      render(
        <ScheduleCustomerSidebar
          service={{ id: 'v0', customerId: 'c1', customerName: 'Test Customer', status: 'pending', address: '1 Test Lane', neighborhoodGateActions: true, propertyAlerts: [{ type: 'gate', text: 'Gate: #4821 (neighborhood)', neighborhoodEntryId: 'e1', neighborhoodEntryCode: '#4821' }] }}
          onClose={() => {}}
        />,
      );
      const panel = screen.getByTestId('schedule-access-panel');
      expect(panel.textContent).toContain('#4821');
      expect(panel.querySelector('button')).toBeNull();
      await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/admin/access-codes/visits/v0', expect.anything()));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// Audit C13: Book next, Edit and Take payment are office-only. /admin/invoices bounces a technician to Today.
describe('ScheduleCustomerSidebar office-only actions by role', () => {
  const service = { id: 'v0', customerId: 'c1', customerName: 'Test Customer', status: 'confirmed', estimatedPrice: 100 };

  it('a technician sees no Book next, Edit or Take payment', async () => {
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'technician' }));
    render(<ScheduleCustomerSidebar service={service} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Visit 0')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Book next' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByText('Take payment')).toBeNull();
  });

  it('an admin still sees Book next, Edit and Take payment', async () => {
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
    render(<ScheduleCustomerSidebar service={service} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Visit 0')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Book next' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(screen.getByText('Take payment')).toBeTruthy();
  });
});

// Owner decision 2026-11-13: the office can skip one plan visit. A skip marks
// the visit skipped, books no make-up visit and sends no customer text. The
// Cancel appointment window shows it as its own choice with its own button
// (SkipVisitOption.jsx); the cancel controls of the window are unchanged.
describe('ScheduleCustomerSidebar skip this visit', () => {
  const recurring = { id: 'v0', customerId: 'c1', customerName: 'Test Customer', status: 'pending', isRecurring: true, recurringPattern: 'quarterly' };
  const PREVIEW_PATH = '/admin/dispatch/v0/card-hold?skip=1';
  const eligible = { eligible: true, code: 'ok', message: '', nextVisitDate: '2027-02-22', lawnRound: null };
  // The file's adminFetch mock answers every path with the customer profile. Here the cancel preview gets its own
  // answer; every other request (the profile read, the status PUT) keeps the default.
  const profileFetch = adminFetch.getMockImplementation();
  afterEach(() => { adminFetch.mockImplementation(profileFetch); });

  async function openCancelWindow(user, preview, onCancel = () => {}) {
    if (user) localStorage.setItem('waves_admin_user', JSON.stringify(user));
    adminFetch.mockImplementation((path, options) => (path === PREVIEW_PATH
      ? Promise.resolve({ ok: true, json: async () => preview })
      : profileFetch(path, options)));
    render(<ScheduleCustomerSidebar service={recurring} onClose={() => {}} onCancel={onCancel} />);
    await waitFor(() => expect(screen.getByText('Visit 0')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'More appointment actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel appointment' }));
  }
  const previewAsked = () => adminFetch.mock.calls.some(([path]) => path === PREVIEW_PATH);
  const puts = () => adminFetch.mock.calls.filter(([, opts]) => opts?.method === 'PUT');

  it('the office skips an eligible visit: what a skip does and the next visit are shown, one request, no fee step', async () => {
    adminFetch.mockClear();
    confirmCardHoldFeeChoice.mockClear();
    const onCancel = vi.fn();
    await openCancelWindow({ role: 'admin' }, { skip: eligible }, onCancel);
    const button = await screen.findByRole('button', { name: 'Skip this visit' });
    expect(previewAsked()).toBe(true);
    expect(screen.getByText('The visit is marked Skipped. No make-up visit is booked. No text is sent to the customer.')).toBeTruthy();
    expect(screen.getByText('Next visit: Mon, Feb 22, 2027')).toBeTruthy();
    fireEvent.click(button);
    await waitFor(() => expect(onCancel).toHaveBeenCalledWith(recurring));
    expect(puts()).toEqual([[
      '/admin/dispatch/v0/status',
      { method: 'PUT', body: { status: 'skipped', notes: 'Skipped from appointment sidebar' } },
    ]]);
    expect(confirmCardHoldFeeChoice).not.toHaveBeenCalled();
  });

  it('a lawn round skip names the round and its dates; the last booked visit says nothing is booked after it', async () => {
    await openCancelWindow({ role: 'admin' }, {
      skip: { ...eligible, nextVisitDate: null, lawnRound: { round: 8, start: '2026-10-01', end: '2026-11-09' } },
    });
    await screen.findByRole('button', { name: 'Skip this visit' });
    expect(screen.getByText('This skips lawn round 8 (Oct 1 to Nov 9). Later rounds keep their dates.')).toBeTruthy();
    expect(screen.getByText('No later visit of this series is booked.')).toBeTruthy();
  });

  it('the office note is saved with the skip, and a refusal shows the server sentence and keeps the window open', async () => {
    adminFetch.mockClear();
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const onCancel = vi.fn();
    await openCancelWindow({ role: 'admin' }, { skip: eligible }, onCancel);
    const button = await screen.findByRole('button', { name: 'Skip this visit' });
    fireEvent.change(screen.getByLabelText('Note for the office (not sent to the customer)'), { target: { value: '  away until April ' } });
    const refusal = 'This visit has an invoice, a card or a linked visit on it. Cancel it instead.';
    // The profile and the preview are read by now, so the next request is the skip itself: the server refuses it.
    adminFetch.mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: refusal, code: 'skip_has_money_or_links' }) });
    fireEvent.click(button);
    await waitFor(() => expect(alert).toHaveBeenCalledWith(`Failed to skip visit: ${refusal}`));
    expect(puts()[0][1].body).toEqual({ status: 'skipped', notes: 'Skipped from appointment sidebar\nNote: away until April' });
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Skip this visit' })).toBeTruthy();
    alert.mockRestore();
  });

  it('a paid visit shows the sentence to move it, and no skip button', async () => {
    const message = 'This visit is paid for already. Move it to a new date instead of skipping it.';
    await openCancelWindow({ role: 'admin' }, { skip: { eligible: false, code: 'prepaid', message, nextVisitDate: null, lawnRound: null } });
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Skip this visit' })).toBeNull();
  });

  it.each([
    ['a visit the server refuses for another reason', { skip: { eligible: false, code: 'not_plan_visit', message: 'Only a visit of a recurring plan can be skipped. Cancel this visit instead.', nextVisitDate: null, lawnRound: null } }],
    ['a failed skip check', { held: false, skip: null }],
  ])('%s shows no skip choice, and a cancel from the window is sent as before', async (_label, preview) => {
    adminFetch.mockClear();
    confirmCardHoldFeeChoice.mockResolvedValue({ proceed: true, waiveCardHoldFee: false });
    await openCancelWindow({ role: 'admin' }, preview);
    await waitFor(() => expect(previewAsked()).toBe(true));
    await screen.findByText('Client booking notifications');
    expect(screen.queryByRole('button', { name: 'Skip this visit' })).toBeNull();
    expect(screen.queryByText(/Only a visit of a recurring plan/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel appointment(s)' }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0][1].body).toMatchObject({ status: 'cancelled', scope: 'this_only' });
    expect(confirmCardHoldFeeChoice).toHaveBeenCalledWith('v0', { scope: 'this_only' });
  });

  it('a technician is never offered a skip, and the window does not ask the server for it', async () => {
    adminFetch.mockClear();
    await openCancelWindow({ role: 'technician' }, { skip: eligible });
    await screen.findByText('Client booking notifications');
    expect(previewAsked()).toBe(false);
    expect(screen.queryByRole('button', { name: 'Skip this visit' })).toBeNull();
  });
});
