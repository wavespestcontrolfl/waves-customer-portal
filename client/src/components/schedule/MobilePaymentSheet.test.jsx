// @vitest-environment jsdom

// Codex round (07-18, P2 on #2820): the server-side requireAdmin on
// POST /admin/invoices/:id/charge-card left the technician checkout UI
// rendering a tender that could only 403. The Card on File tender renders
// for admin-role users only; technician, corrupt, and missing profiles all
// fail closed to hidden.
//
// Owner 2026-11-04 (technician visibility audit D4 A): a technician takes
// cards only. Cash, Check and Invoice are office tenders; Card on File shows
// to a technician only when GET /admin/invoices/:id marks the invoice
// tech_card_on_file (GATE_TECH_CARD_ON_FILE, its own visit today). A missing
// or corrupt profile gets the technician's list.

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import MobilePaymentSheet from './MobilePaymentSheet';
import { launchTapToPay } from '../../lib/tapToPay';

vi.mock('../../lib/tapToPay', () => ({ launchTapToPay: vi.fn() }));

function stubLocalStorage(entries) {
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key) => (key in entries ? entries[key] : null)),
  });
}

// The technician sheet reads the invoice once to learn whether to show Card on File.
function stubInvoiceRead(invoice) {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => invoice }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderSheet() {
  render(
    <MobilePaymentSheet
      desktopVisible
      service={{ id: 'svc-1' }}
      invoiceId="inv-1"
      amount={125}
    />,
  );
}

describe('MobilePaymentSheet tenders by role', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders every tender for an admin-role user, with no invoice read', () => {
    stubLocalStorage({
      waves_admin_token: 'test-token',
      waves_admin_user: JSON.stringify({ id: 'u1', role: 'admin' }),
    });
    const fetchMock = stubInvoiceRead({ id: 'inv-1' });
    renderSheet();
    for (const label of ['Cash', 'Check', 'Manual Credit Card Entry', 'Card on File', 'Invoice']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.queryByText('Cash or check: the office records it.')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a technician takes cards only: no Cash, Check or Invoice, and the office line shows', async () => {
    stubLocalStorage({
      waves_admin_token: 'test-token',
      waves_admin_user: JSON.stringify({ id: 'u2', role: 'technician' }),
    });
    const fetchMock = stubInvoiceRead({ id: 'inv-1', tech_card_on_file: false });
    renderSheet();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/admin\/invoices\/inv-1$/);
    expect(screen.getByText('Tap to Pay on iPhone')).toBeInTheDocument();
    expect(screen.getByText('Manual Credit Card Entry')).toBeInTheDocument();
    for (const label of ['Cash', 'Check', 'Invoice', 'Card on File']) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
    expect(screen.getByText('Cash or check: the office records it.')).toBeInTheDocument();
  });

  it('a technician sees Card on File when the server marks the invoice chargeable for it', async () => {
    stubLocalStorage({
      waves_admin_token: 'test-token',
      waves_admin_user: JSON.stringify({ id: 'u2', role: 'technician' }),
    });
    stubInvoiceRead({ id: 'inv-1', tech_card_on_file: true });
    renderSheet();
    expect(await screen.findByText('Card on File')).toBeInTheDocument();
    expect(screen.queryByText('Cash')).not.toBeInTheDocument();
  });

  it('fails closed to the technician list when the stored profile is missing or corrupt', async () => {
    stubLocalStorage({ waves_admin_token: 'test-token' });
    const first = stubInvoiceRead({ id: 'inv-1' });
    renderSheet();
    await waitFor(() => expect(first).toHaveBeenCalled());
    expect(screen.queryByText('Card on File')).not.toBeInTheDocument();
    expect(screen.queryByText('Cash')).not.toBeInTheDocument();
    cleanup();

    stubLocalStorage({
      waves_admin_token: 'test-token',
      waves_admin_user: 'not-json{',
    });
    const second = stubInvoiceRead({ id: 'inv-1' });
    renderSheet();
    await waitFor(() => expect(second).toHaveBeenCalled());
    expect(screen.queryByText('Cash')).not.toBeInTheDocument();
    expect(screen.queryByText('Card on File')).not.toBeInTheDocument();
    expect(screen.getByText('Manual Credit Card Entry')).toBeInTheDocument();
  });
});

describe('MobilePaymentSheet Invoice tender request contract (fourth round-1 P2 #4633)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function stubAdmin() {
    stubLocalStorage({
      waves_admin_token: 'test-token',
      waves_admin_user: JSON.stringify({ id: 'u1', role: 'admin' }),
    });
  }

  it('a fresh invoice send states firstDelivery: true — no internal legacy no-body request', async () => {
    stubAdmin();
    let capturedBody = null;
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      capturedBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ ok: true, sms: { ok: true }, email: { ok: true } }) };
    }));
    const onInvoiceSent = vi.fn();
    render(
      <MobilePaymentSheet
        desktopVisible
        service={{ id: 'svc-1' }}
        invoiceId="inv-1"
        amount={125}
        onInvoiceSent={onInvoiceSent}
      />,
    );
    fireEvent.click(screen.getByText('Invoice'));
    await waitFor(() => expect(onInvoiceSent).toHaveBeenCalled());
    expect(capturedBody).toEqual({ firstDelivery: true });
  });

  it('a no-op already_delivered outcome (ok:true) proceeds exactly like a normal send', async () => {
    stubAdmin();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, already_delivered: true, sms: { ok: false, code: 'already_delivered' }, email: { ok: false, code: 'already_delivered' } }),
    })));
    const onInvoiceSent = vi.fn();
    render(
      <MobilePaymentSheet
        desktopVisible
        service={{ id: 'svc-1' }}
        invoiceId="inv-1"
        amount={125}
        onInvoiceSent={onInvoiceSent}
      />,
    );
    fireEvent.click(screen.getByText('Invoice'));
    await waitFor(() => expect(onInvoiceSent).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/Failed to send invoice/)).not.toBeInTheDocument();
  });
});

// Inside the Waves Admin app, Tap to Pay answers on this page. A paid tap
// finishes like the other card tenders (the parents re-read the invoice);
// a failed or canceled tap leaves the sheet usable for another try.
describe('MobilePaymentSheet Tap to Pay inside the Waves Admin app', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  function renderTapSheet() {
    stubLocalStorage({
      waves_admin_token: 'test-token',
      waves_admin_user: JSON.stringify({ id: 'u2', role: 'technician' }),
    });
    stubInvoiceRead({ id: 'inv-1', tech_card_on_file: false });
    const onChargeSuccess = vi.fn();
    const onClose = vi.fn();
    render(
      <MobilePaymentSheet
        desktopVisible
        service={{ id: 'svc-1' }}
        invoiceId="inv-1"
        amount={125}
        onChargeSuccess={onChargeSuccess}
        onClose={onClose}
      />,
    );
    return { onChargeSuccess, onClose };
  }

  it('a paid tap reports the charge and closes the sheet', async () => {
    launchTapToPay.mockResolvedValue({ inApp: true, status: 'succeeded', paymentIntentId: 'pi_1', message: null });
    const { onChargeSuccess, onClose } = renderTapSheet();
    fireEvent.click(screen.getByText('Tap to Pay on iPhone'));
    await waitFor(() => expect(onChargeSuccess).toHaveBeenCalledWith({ paymentIntentId: 'pi_1' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(launchTapToPay).toHaveBeenCalledWith('inv-1');
  });

  it('a failed tap shows the reason and re-enables Tap to Pay', async () => {
    launchTapToPay.mockResolvedValue({
      inApp: true,
      status: 'failed',
      paymentIntentId: null,
      message: 'The invoice total changed. Close this and tap Tap to Pay again.',
    });
    const { onChargeSuccess, onClose } = renderTapSheet();
    fireEvent.click(screen.getByText('Tap to Pay on iPhone'));
    expect(await screen.findByText('The invoice total changed. Close this and tap Tap to Pay again.')).toBeInTheDocument();
    expect(screen.getByText('Tap to Pay on iPhone')).not.toBeDisabled();
    expect(onChargeSuccess).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a canceled tap re-enables Tap to Pay with no error', async () => {
    launchTapToPay.mockResolvedValue({ inApp: true, status: 'canceled', paymentIntentId: null, message: null });
    const { onChargeSuccess, onClose } = renderTapSheet();
    fireEvent.click(screen.getByText('Tap to Pay on iPhone'));
    await waitFor(() => expect(screen.getByText('Tap to Pay on iPhone')).not.toBeDisabled());
    expect(screen.queryByText(/did not go through/)).not.toBeInTheDocument();
    expect(onChargeSuccess).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
