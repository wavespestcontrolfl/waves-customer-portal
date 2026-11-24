// @vitest-environment jsdom

// Owner 2026-11-18: a check taken at the dispatch checkout got no receipt. The Cash and Check sheets keep
// sendReceipt: false and add checkoutTender: true with totalSeen; with GATE_CHECKOUT_TENDER_RECEIPT on, the server then
// queues the receipt and records exactly that amount. Gate off, the server ignores the marker.

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import MobileCashTenderSheet from './MobileCashTenderSheet';
import MobileCheckTenderSheet from './MobileCheckTenderSheet';

function stubRecordPayment() {
  vi.stubGlobal('localStorage', { getItem: vi.fn(() => 'test-token') });
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, invoice: { id: 'inv-1', status: 'paid' } }) }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('checkout Cash and Check sheets mark the payment as a checkout tender', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it.each([
    ['Check', MobileCheckTenderSheet, 'Record Payment', 'check'],
    ['Cash', MobileCashTenderSheet, 'Tender', 'cash'],
  ])('%s posts checkoutTender: true and still asks for no receipt itself', async (_name, Sheet, button, method) => {
    const fetchMock = stubRecordPayment();
    const onRecorded = vi.fn();
    render(<Sheet desktopVisible invoiceId="inv-1" amount={125} onRecorded={onRecorded} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText(button));
    await waitFor(() => expect(onRecorded).toHaveBeenCalled());
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/admin\/invoices\/inv-1\/record-payment$/);
    // totalSeen: the amount this sheet showed, so the server refuses a balance that moved since.
    expect(JSON.parse(options.body)).toEqual(expect.objectContaining({ method, sendReceipt: false, checkoutTender: true, totalSeen: 125 }));
  });

  it.each([
    ['Check', MobileCheckTenderSheet, 'Record Payment'],
    ['Cash', MobileCashTenderSheet, 'Tender'],
  ])('%s says so when the payment was recorded with no receipt, and closes on Done', async (_name, Sheet, button) => {
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => 'test-token') });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, invoice: { id: 'inv-1', status: 'paid' }, receipt: { manual: true } }) })));
    const onRecorded = vi.fn();
    const onClose = vi.fn();
    render(<Sheet desktopVisible invoiceId="inv-1" amount={125} onRecorded={onRecorded} onClose={onClose} />);
    fireEvent.click(screen.getByText(button));
    expect(await screen.findByText('Payment recorded. No receipt went out for this payment.')).toBeInTheDocument();
    expect(onRecorded).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Done'));
    expect(onRecorded).toHaveBeenCalledWith(expect.objectContaining({ invoice: { id: 'inv-1', status: 'paid' } }));
    expect(onClose).toHaveBeenCalled();
  });

  it.each([
    ['Check', MobileCheckTenderSheet, 'Record Payment'],
    ['Cash', MobileCashTenderSheet, 'Tender'],
  ])('%s keeps Back disabled while the payment request runs, so its result is never dropped', async (_name, Sheet, button) => {
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => 'test-token') });
    let answer;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { answer = resolve; })));
    const onRecorded = vi.fn();
    render(<Sheet desktopVisible invoiceId="inv-1" amount={125} onRecorded={onRecorded} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText(button));
    await waitFor(() => expect(screen.getByLabelText('Back')).toBeDisabled());
    answer({ ok: true, json: async () => ({ ok: true, invoice: { id: 'inv-1', status: 'paid' } }) });
    await waitFor(() => expect(onRecorded).toHaveBeenCalled());
  });
});
