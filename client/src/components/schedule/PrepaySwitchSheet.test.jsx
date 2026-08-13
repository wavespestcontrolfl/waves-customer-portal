// @vitest-environment jsdom
//
// The on-site annual-prepay switch sheet. What's actually load-bearing here
// is the ORDER of the money moves, so that's what these cover: the superseded
// per-application invoice is voided only AFTER the prepay is collected or
// sent, and never when the operator backs out.
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

const SERVICE = { id: 'svc-1', customerId: 'cust-1', customerName: 'Trang Nguyen' };

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
function stubFetch({ preview = PREVIEW, voidFails = false, mintFails = false, deliveryFails = false } = {}) {
  calls = [];
  global.fetch = vi.fn(async (url, options = {}) => {
    const path = String(url);
    calls.push({ path, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    const ok = (json) => ({ ok: true, json: async () => json });
    if (path.includes('annual-prepay-preview')) return ok(preview);
    if (path.includes('/annual-prepay-invoice')) {
      if (mintFails) return { ok: false, status: 409, json: async () => ({ error: 'already has a term' }) };
      // The mint returns 201 even when the send leg failed — `delivery.ok`
      // is the only signal that the customer never got the pay link.
      return ok({
        invoice: { id: 'inv-prepay', invoice_number: 'WPC-2026-0400', token: 'tok', total: 512 },
        ...(deliveryFails ? { delivery: { ok: false, error: 'SMS gateway rejected' } } : {}),
      });
    }
    if (path.endsWith('/void')) {
      if (voidFails) return { ok: false, status: 400, json: async () => ({ error: 'invoice is not voidable' }) };
      return ok({ status: 'void' });
    }
    if (path.includes('/admin/invoices/')) return ok({ id: 'inv-prepay', status: 'draft' });
    return ok({});
  });
}

const voidedIds = () => calls.filter((c) => c.path.endsWith('/void')).map((c) => c.path.match(/invoices\/([^/]+)\/void/)[1]);

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

  it('voids the superseded invoice only AFTER the prepay is collected', async () => {
    const onSaved = vi.fn();
    render(<PrepaySwitchSheet service={SERVICE} onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.click(await screen.findByRole('button', { name: /Collect \$512\.00 now/ }));

    // Minted and handed to the tender sheet — nothing voided yet.
    await screen.findByText('tender 512');
    expect(voidedIds()).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'tender-success' }));
    await waitFor(() => expect(voidedIds()).toEqual(['inv-1']));
    expect(onSaved).toHaveBeenCalled();
    expect(await screen.findByText('Annual prepay collected')).toBeInTheDocument();
  });

  it('backing out of the tender voids the PREPAY invoice and leaves the old one alone', async () => {
    const onClose = vi.fn();
    render(<PrepaySwitchSheet service={SERVICE} onClose={onClose} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Collect \$512\.00 now/ }));
    await screen.findByText('tender 512');

    fireEvent.click(screen.getByRole('button', { name: 'tender-abort' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    // The visit must bill exactly as it did before the operator tapped in.
    expect(voidedIds()).toEqual(['inv-prepay']);
  });

  it('sending the invoice instead still supersedes the per-application one', async () => {
    render(<PrepaySwitchSheet service={SERVICE} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Send the invoice instead/ }));
    await waitFor(() => expect(voidedIds()).toEqual(['inv-1']));
    const mint = calls.find((c) => c.path.includes('/annual-prepay-invoice'));
    expect(mint.body).toMatchObject({ amount: 512, visitCount: 4, chargeInPerson: false });
    expect(await screen.findByText('Annual prepay invoice sent')).toBeInTheDocument();
  });

  it('a failed supersede void is loud — completion would reuse that invoice', async () => {
    stubFetch({ voidFails: true });
    render(<PrepaySwitchSheet service={SERVICE} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Collect \$512\.00 now/ }));
    await screen.findByText('tender 512');
    fireEvent.click(screen.getByRole('button', { name: 'tender-success' }));

    expect(await screen.findByText(/the old invoice is still open/i)).toBeInTheDocument();
    expect(screen.getByText(/bill Trang Nguyen for a visit they just prepaid/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry void/ })).toBeInTheDocument();
  });

  it('a failed DELIVERY keeps the old invoice — the customer never got the prepay link', async () => {
    stubFetch({ deliveryFails: true });
    render(<PrepaySwitchSheet service={SERVICE} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Send the invoice instead/ }));
    expect(await screen.findByText(/could NOT be delivered/)).toBeInTheDocument();
    expect(screen.getByText(/per-application invoice was left in place/)).toBeInTheDocument();
    expect(voidedIds()).toEqual([]);
  });

  it('a cleanup retry on the SEND path does not claim the money was collected', async () => {
    // Void fails once, then succeeds — the retry must still report "sent",
    // not "collected": the term is payment_pending until the customer pays.
    let voidAttempts = 0;
    stubFetch();
    const base = global.fetch;
    global.fetch = vi.fn(async (url, options = {}) => {
      if (String(url).endsWith('/void')) {
        voidAttempts += 1;
        calls.push({ path: String(url), method: 'POST', body: null });
        if (voidAttempts === 1) return { ok: false, status: 400, json: async () => ({ error: 'temporary' }) };
        return { ok: true, json: async () => ({ status: 'void' }) };
      }
      return base(url, options);
    });

    render(<PrepaySwitchSheet service={SERVICE} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Send the invoice instead/ }));
    expect(await screen.findByText(/Prepay invoice sent — but the old invoice is still open/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Retry void/ }));
    expect(await screen.findByText('Annual prepay invoice sent')).toBeInTheDocument();
    expect(screen.queryByText('Annual prepay collected')).not.toBeInTheDocument();
    // …and it must not tell the operator to complete a visit nothing covers.
    expect(screen.queryByText(/Complete the visit next/)).not.toBeInTheDocument();
  });

  it('a mint failure surfaces the server reason and voids nothing', async () => {
    stubFetch({ mintFails: true });
    render(<PrepaySwitchSheet service={SERVICE} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Collect \$512\.00 now/ }));
    expect(await screen.findByText(/already has a term/)).toBeInTheDocument();
    expect(voidedIds()).toEqual([]);
  });

  it('renders the server blockReason instead of an offer when the switch is refused', async () => {
    stubFetch({ preview: { eligible: false, blockReason: 'already has an annual prepay invoice on this visit' } });
    render(<PrepaySwitchSheet service={SERVICE} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(await screen.findByText(/already has an annual prepay invoice on this visit/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Collect/ })).not.toBeInTheDocument();
  });
});
