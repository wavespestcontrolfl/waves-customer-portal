// @vitest-environment jsdom
//
// The on-site annual-prepay switch sheet. What's load-bearing is the ORDER of
// the money moves, so that's what these cover: the per-application invoice is
// retired BEFORE the prepay is minted (so the two are never payable at once),
// and any path that doesn't complete puts it back.
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

// Routes each fetch by path so assertions can talk about intent ("was the old
// invoice voided?") instead of call indexes.
function stubFetch({
  preview = PREVIEW, supersedeFails = false, mintFails = false, mintNetworkFails = false,
  deliveryFails = false, undoFails = false, freshStatus = 'draft',
} = {}) {
  calls = [];
  global.fetch = vi.fn(async (url, options = {}) => {
    const path = String(url);
    calls.push({ path, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    const ok = (json) => ({ ok: true, json: async () => json });
    if (path.includes('annual-prepay-preview')) return ok(preview);
    if (path.includes('/prepay-switch/supersede')) {
      if (supersedeFails) return { ok: false, status: 409, json: async () => ({ error: 'WPC-2026-0345 has already gone out to the customer' }) };
      return ok({ voided: [{ id: 'inv-1', invoiceNumber: 'WPC-2026-0345', total: 227 }] });
    }
    if (path.includes('/prepay-switch/undo')) {
      if (undoFails) return ok({ restored: [], failed: [{ id: 'inv-1', invoiceNumber: 'WPC-2026-0345', error: 'insert failed' }] });
      return ok({ restored: [{ replacedInvoiceId: 'inv-1', invoiceId: 'inv-new', invoiceNumber: 'WPC-2026-0401' }], failed: [] });
    }
    if (path.includes('/annual-prepay-invoice')) {
      // A network-level failure: fetch rejects with no HTTP status at all —
      // the outcome is ambiguous, unlike a 409.
      if (mintNetworkFails) throw new TypeError('Failed to fetch');
      if (mintFails) return { ok: false, status: 409, json: async () => ({ error: 'already has a term' }) };
      // The mint returns 201 even when the send leg failed — `delivery.ok`
      // is the only signal that the customer never got the pay link.
      return ok({
        invoice: { id: 'inv-prepay', invoice_number: 'WPC-2026-0400', token: 'tok', total: 512 },
        ...(deliveryFails ? { delivery: { ok: false, error: 'SMS gateway rejected' } } : {}),
      });
    }
    if (path.endsWith('/void')) return ok({ status: 'void' });
    if (path.includes('/admin/invoices/')) return ok({ id: 'inv-prepay', status: freshStatus });
    return ok({});
  });
}

const pathsHit = () => calls.map((c) => c.path.replace(/^.*\/api/, ''));
const didSupersede = () => calls.some((c) => c.path.includes('/prepay-switch/supersede'));
const didUndo = () => calls.some((c) => c.path.includes('/prepay-switch/undo'));
const didMint = () => calls.some((c) => c.path.includes('/annual-prepay-invoice'));
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

  it('retires the per-application invoice BEFORE minting the prepay', async () => {
    const onSaved = vi.fn();
    render(<PrepaySwitchSheet service={SERVICE} onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.click(await screen.findByRole('button', { name: /Collect \$512\.00 now/ }));
    await screen.findByText('tender 512');

    // The two are never simultaneously payable: supersede strictly precedes
    // the mint.
    const order = pathsHit();
    const supersedeAt = order.findIndex((p) => p.includes('/prepay-switch/supersede'));
    const mintAt = order.findIndex((p) => p.includes('/annual-prepay-invoice'));
    expect(supersedeAt).toBeGreaterThanOrEqual(0);
    expect(mintAt).toBeGreaterThan(supersedeAt);

    fireEvent.click(screen.getByRole('button', { name: 'tender-success' }));
    expect(await screen.findByText('Annual prepay collected')).toBeInTheDocument();
    expect(onSaved).toHaveBeenCalled();
    // Nothing to clean up afterwards — the old invoice was already gone.
    expect(didUndo()).toBe(false);
  });

  it('a refused supersede stops before anything is minted or charged', async () => {
    stubFetch({ supersedeFails: true });
    render(<PrepaySwitchSheet service={SERVICE} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Collect \$512\.00 now/ }));
    expect(await screen.findByText(/already gone out to the customer/)).toBeInTheDocument();
    expect(didMint()).toBe(false);
  });

  it('backing out voids the PREPAY invoice and puts the per-application one back', async () => {
    const onClose = vi.fn();
    render(<PrepaySwitchSheet service={SERVICE} onClose={onClose} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Collect \$512\.00 now/ }));
    await screen.findByText('tender 512');

    fireEvent.click(screen.getByRole('button', { name: 'tender-abort' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    // The visit bills exactly as it did before the operator tapped in.
    expect(voidedPrepay()).toBe(true);
    expect(didUndo()).toBe(true);
  });

  it('a failed restore is loud — the visit would complete with nothing to bill', async () => {
    stubFetch({ undoFails: true });
    const onClose = vi.fn();
    render(<PrepaySwitchSheet service={SERVICE} onClose={onClose} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Collect \$512\.00 now/ }));
    await screen.findByText('tender 512');

    fireEvent.click(screen.getByRole('button', { name: 'tender-abort' }));
    expect(await screen.findByText(/no invoice behind it/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore invoice' })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('sending the invoice instead also supersedes first, and relays server-derived money', async () => {
    render(<PrepaySwitchSheet service={SERVICE} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Send the invoice instead/ }));
    expect(await screen.findByText('Annual prepay invoice sent')).toBeInTheDocument();
    expect(didSupersede()).toBe(true);
    const mint = calls.find((c) => c.path.includes('/annual-prepay-invoice'));
    expect(mint.body).toMatchObject({ amount: 512, visitCount: 4, chargeInPerson: false });
  });

  it('a mint failure restores the per-application invoice and says so', async () => {
    stubFetch({ mintFails: true });
    render(<PrepaySwitchSheet service={SERVICE} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Collect \$512\.00 now/ }));
    expect(await screen.findByText(/already has a term/)).toBeInTheDocument();
    expect(screen.getByText(/restored — nothing changed/)).toBeInTheDocument();
    expect(didUndo()).toBe(true);
  });

  it('a failed DELIVERY voids the undelivered prepay FIRST, then restores the old invoice', async () => {
    stubFetch({ deliveryFails: true });
    render(<PrepaySwitchSheet service={SERVICE} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Send the invoice instead/ }));
    expect(await screen.findByText(/could NOT be delivered/)).toBeInTheDocument();
    expect(screen.getByText(/per-application invoice was restored/)).toBeInTheDocument();
    // Never two live invoices: the prepay void strictly precedes the restore.
    const order = pathsHit();
    const voidAt = order.findIndex((pp) => pp === '/admin/invoices/inv-prepay/void');
    const undoAt = order.findIndex((pp) => pp.includes('/prepay-switch/undo'));
    expect(voidAt).toBeGreaterThanOrEqual(0);
    expect(undoAt).toBeGreaterThan(voidAt);
  });

  it('an AMBIGUOUS mint failure never auto-restores — the prepay may exist', async () => {
    stubFetch({ mintNetworkFails: true });
    render(<PrepaySwitchSheet service={SERVICE} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Collect \$512\.00 now/ }));
    expect(await screen.findByText('Connection dropped mid-switch')).toBeInTheDocument();
    expect(screen.getByText(/may exist in Invoices/)).toBeInTheDocument();
    // Restoring here without checking could park a fresh per-application
    // invoice beside a live prepay — it must be the operator's tap.
    expect(didUndo()).toBe(false);
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

  it('renders the server blockReason instead of an offer when the switch is refused', async () => {
    stubFetch({ preview: { eligible: false, blockReason: 'already has an annual prepay invoice on this visit' } });
    render(<PrepaySwitchSheet service={SERVICE} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(await screen.findByText(/already has an annual prepay invoice on this visit/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Collect/ })).not.toBeInTheDocument();
  });
});
