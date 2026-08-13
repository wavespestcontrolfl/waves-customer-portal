// @vitest-environment jsdom
//
// The on-site annual-prepay switch sheet. The switch itself is ONE atomic
// server operation (POST …/prepay-switch voids the superseded draft and
// mints the prepay together), so what's load-bearing on the client is what
// happens AROUND that commit. COLLECT-ONLY by owner ruling: the invoice goes
// straight to the tender; there is no send path here. Backing out voids the
// prepay then restores the old invoice, ambiguous outcomes are never
// auto-compensated, and every failure state says where the money stands.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PrepaySwitchSheet from './PrepaySwitchSheet';

// The tender sheet is a whole payment stack; stand in for it with the two
// outcomes this component branches on.
vi.mock('./MobilePaymentSheet', () => ({
  default: ({ onChargeSuccess, onClose, amount }) => (
    <div>
      <div>tender {amount}</div>
      <button type="button" onClick={() => onChargeSuccess()}>tender-success</button>
      <button type="button" onClick={() => onClose()}>tender-abort</button>
    </div>
  ),
}));

const SERVICE = { id: 'svc-1', customerId: 'cust-1', customerName: 'Pat Sample' };

const PREVIEW = {
  eligible: true,
  blockReason: null,
  perVisit: 128,
  visitsPerYear: 4,
  coverageCadence: 'quarterly',
  coverageServiceType: 'Quarterly Pest Control',
  prepayTotal: 512,
  discountAmount: 0,
  discountLabel: '',
  setupFee: { amount: 99, waivedWithPrepay: true },
  supersedes: [{
    id: 'inv-1',
    invoiceNumber: 'WPC-2026-0345',
    status: 'draft',
    total: 227,
    lines: [
      { description: 'WaveGuard Membership — one-time setup fee', amount: 99 },
      { description: 'First service application', amount: 128 },
    ],
  }],
  termStart: '2026-08-12',
  mintPayload: { amount: 512, visitCount: 4, coverageCadence: 'quarterly', serviceType: 'Quarterly Pest Control' },
};

let calls;

// Routes each fetch by path so assertions can talk about intent ("was the
// switch committed?", "was the old invoice restored?") instead of indexes.
function stubFetch({
  preview = PREVIEW, switchFails = false, switchNetworkFails = false,
  undoFails = false, freshStatus = 'paid',
} = {}) {
  calls = [];
  global.fetch = vi.fn(async (url, options = {}) => {
    const path = String(url);
    calls.push({ path, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    const ok = (json, status = 200) => ({ ok: true, status, json: async () => json });
    if (path.includes('annual-prepay-preview')) return ok(preview);
    if (path.includes('/prepay-switch/undo')) {
      if (undoFails) return ok({ restored: [], failed: [{ id: 'inv-1', invoiceNumber: 'WPC-2026-0345', error: 'insert failed' }] });
      return ok({ restored: [{ replacedInvoiceId: 'inv-1', invoiceId: 'inv-new', invoiceNumber: 'WPC-2026-0401' }], failed: [] });
    }
    if (path.includes('/prepay-switch')) {
      // A network-level failure: fetch rejects with no HTTP status at all —
      // the outcome is ambiguous, unlike a 409.
      if (switchNetworkFails) throw new TypeError('Failed to fetch');
      if (switchFails) return { ok: false, status: 409, json: async () => ({ error: 'Customer already has an annual prepay term through 2027-08-11' }) };
      return ok({
        invoice: { id: 'inv-prepay', invoice_number: 'WPC-2026-0400', token: 'tok', total: 512 },
        voided: [{ id: 'inv-1', invoiceNumber: 'WPC-2026-0345', total: 227 }],
      }, 201);
    }
    if (path.endsWith('/void')) return ok({ status: 'void' });
    if (path.includes('/admin/invoices/')) return ok({ id: 'inv-prepay', status: freshStatus });
    return ok({});
  });
}

const pathsHit = () => calls.map((c) => c.path.replace(/^.*\/api/, ''));
const didUndo = () => calls.some((c) => c.path.includes('/prepay-switch/undo'));
const voidedPrepay = () => calls.some((c) => c.path === '/api/admin/invoices/inv-prepay/void');

beforeEach(() => {
  localStorage.setItem('waves_admin_token', 'test-token');
  stubFetch();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PrepaySwitchSheet', () => {
  it('shows the server-priced year, the waived setup fee, and what it replaces', async () => {
    render(<PrepaySwitchSheet service={SERVICE} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(await screen.findByText('$512.00')).toBeInTheDocument();
    // The cadence prefix is dropped — the service name already carries it, so
    // "4 quarterly Quarterly Pest Control" must never render.
    expect(screen.getByText(/4 Quarterly Pest Control visits/)).toBeInTheDocument();
    expect(screen.queryByText(/quarterly Quarterly/)).not.toBeInTheDocument();
    expect(screen.getByText(/starts Aug 12, 2026/)).toBeInTheDocument();
    expect(screen.getByText(/\$99\.00 setup fee waived/)).toBeInTheDocument();
    expect(screen.getByText(/WPC-2026-0345/)).toBeInTheDocument();
  });

  it('one atomic switch call carrying NOTHING, then straight to the tender', async () => {
    const onSaved = vi.fn();
    render(<PrepaySwitchSheet service={SERVICE} onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.click(await screen.findByRole('button', { name: /Collect \$512\.00 now/ }));
    await screen.findByText('tender 512');

    const switchCall = calls.find((c) => c.path.endsWith('/prepay-switch') && c.method === 'POST');
    // The client sends NOTHING the server trusts — everything is server-derived.
    expect(switchCall.body).toEqual({});

    fireEvent.click(screen.getByRole('button', { name: 'tender-success' }));
    expect(await screen.findByText('Annual prepay collected')).toBeInTheDocument();
    // Success only after the SERVER confirms a settled status (Codex P0 r15)
    // — the tender sheet fires onChargeSuccess for processing tenders too.
    expect(calls.some((c) => c.path === '/api/admin/invoices/inv-prepay' && c.method === 'GET')).toBe(true);
    // The next step is spelled out — completion cuts no invoice now.
    expect(screen.getByText(/Complete the visit next/)).toBeInTheDocument();
    expect(onSaved).toHaveBeenCalled();
    expect(didUndo()).toBe(false);
  });

  it('a tender that reports success while PROCESSING parks — never a success claim', async () => {
    stubFetch({ freshStatus: 'processing' });
    render(<PrepaySwitchSheet service={SERVICE} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Collect \$512\.00 now/ }));
    await screen.findByText('tender 512');
    fireEvent.click(screen.getByRole('button', { name: 'tender-success' }));
    expect(await screen.findByText('Payment still processing')).toBeInTheDocument();
    expect(screen.queryByText('Annual prepay collected')).not.toBeInTheDocument();
    expect(didUndo()).toBe(false);
    expect(voidedPrepay()).toBe(false);
  });

  it('offers NO send option — Customer 360 is the pointer for pay-by-link', async () => {
    render(<PrepaySwitchSheet service={SERVICE} onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByText('$512.00');
    expect(screen.queryByRole('button', { name: /Send the invoice/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Customer 360/)).toBeInTheDocument();
  });

  it('a server-refused switch surfaces the reason; nothing to compensate', async () => {
    stubFetch({ switchFails: true });
    render(<PrepaySwitchSheet service={SERVICE} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Collect \$512\.00 now/ }));
    expect(await screen.findByText(/already has an annual prepay term/)).toBeInTheDocument();
    // The transaction rolled back server-side — the client must not "fix"
    // anything.
    expect(didUndo()).toBe(false);
    expect(voidedPrepay()).toBe(false);
  });

  it('backing out voids the PREPAY invoice and puts the per-application one back, in that order', async () => {
    stubFetch({ freshStatus: 'draft' });
    const onClose = vi.fn();
    render(<PrepaySwitchSheet service={SERVICE} onClose={onClose} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Collect \$512\.00 now/ }));
    await screen.findByText('tender 512');

    fireEvent.click(screen.getByRole('button', { name: 'tender-abort' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    // Never two live invoices: the prepay void strictly precedes the restore.
    const order = pathsHit();
    const voidAt = order.findIndex((pp) => pp === '/admin/invoices/inv-prepay/void');
    const undoAt = order.findIndex((pp) => pp.includes('/prepay-switch/undo'));
    expect(voidAt).toBeGreaterThanOrEqual(0);
    expect(undoAt).toBeGreaterThan(voidAt);
  });

  it('a failed restore is loud — the visit would complete with nothing to bill', async () => {
    stubFetch({ undoFails: true, freshStatus: 'draft' });
    const onClose = vi.fn();
    render(<PrepaySwitchSheet service={SERVICE} onClose={onClose} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Collect \$512\.00 now/ }));
    await screen.findByText('tender 512');
    fireEvent.click(screen.getByRole('button', { name: 'tender-abort' }));

    expect(await screen.findByText(/no invoice behind it/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore invoice' })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('an AMBIGUOUS switch failure never auto-compensates — retry and Restore are both safe', async () => {
    stubFetch({ switchNetworkFails: true });
    render(<PrepaySwitchSheet service={SERVICE} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Collect \$512\.00 now/ }));
    expect(await screen.findByText('Connection dropped mid-switch')).toBeInTheDocument();
    // No blind compensation: the commit may have landed (a retry then 409s
    // on the overlap assert) or not (a retry succeeds); the undo endpoint
    // itself refuses while a live prepay term stands.
    expect(didUndo()).toBe(false);
    expect(voidedPrepay()).toBe(false);
    expect(screen.getByRole('button', { name: 'Restore invoice' })).toBeInTheDocument();
  });

  it('an abort that finds the prepay already VOIDED still restores instead of claiming success', async () => {
    stubFetch({ freshStatus: 'void' });
    const onClose = vi.fn();
    render(<PrepaySwitchSheet service={SERVICE} onClose={onClose} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Collect \$512\.00 now/ }));
    await screen.findByText('tender 512');
    fireEvent.click(screen.getByRole('button', { name: 'tender-abort' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    // No second void of an already-void invoice; the restore still runs; and
    // nothing claimed the money was collected.
    expect(voidedPrepay()).toBe(false);
    expect(didUndo()).toBe(true);
    expect(screen.queryByText('Annual prepay collected')).not.toBeInTheDocument();
  });

  it('a PROCESSING prepay on abort is parked, never claimed collected or voided', async () => {
    stubFetch({ freshStatus: 'processing' });
    render(<PrepaySwitchSheet service={SERVICE} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Collect \$512\.00 now/ }));
    await screen.findByText('tender 512');
    fireEvent.click(screen.getByRole('button', { name: 'tender-abort' }));

    expect(await screen.findByText('Payment still processing')).toBeInTheDocument();
    expect(screen.getByText(/do not charge again/)).toBeInTheDocument();
    // In-flight: no void, no restore, no success claim.
    expect(voidedPrepay()).toBe(false);
    expect(didUndo()).toBe(false);
    expect(screen.queryByText('Annual prepay collected')).not.toBeInTheDocument();
  });

  it('renders the server blockReason instead of an offer when the switch is refused', async () => {
    stubFetch({ preview: { eligible: false, blockReason: 'already has an annual prepay invoice on this visit' } });
    render(<PrepaySwitchSheet service={SERVICE} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(await screen.findByText(/already has an annual prepay invoice on this visit/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Collect/ })).not.toBeInTheDocument();
  });
});
