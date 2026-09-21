// @vitest-environment jsdom

// Codex round (07-18, P2 on #2820): the server-side requireAdmin on
// POST /admin/invoices/:id/charge-card left the technician checkout UI
// rendering a tender that could only 403. The Card on File tender renders
// for admin-role users only; technician, corrupt, and missing profiles all
// fail closed to hidden.

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import MobilePaymentSheet from './MobilePaymentSheet';

function stubLocalStorage(entries) {
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key) => (key in entries ? entries[key] : null)),
  });
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

describe('MobilePaymentSheet Card on File role gate', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the Card on File tender for an admin-role user', () => {
    stubLocalStorage({
      waves_admin_token: 'test-token',
      waves_admin_user: JSON.stringify({ id: 'u1', role: 'admin' }),
    });
    renderSheet();
    expect(screen.getByText('Cash')).toBeInTheDocument();
    expect(screen.getByText('Card on File')).toBeInTheDocument();
  });

  it('hides the tender for a technician-role user (server would 403)', () => {
    stubLocalStorage({
      waves_admin_token: 'test-token',
      waves_admin_user: JSON.stringify({ id: 'u2', role: 'technician' }),
    });
    renderSheet();
    expect(screen.getByText('Cash')).toBeInTheDocument();
    expect(screen.queryByText('Card on File')).not.toBeInTheDocument();
  });

  it('fails closed when the stored profile is missing or corrupt', () => {
    stubLocalStorage({ waves_admin_token: 'test-token' });
    renderSheet();
    expect(screen.queryByText('Card on File')).not.toBeInTheDocument();
    cleanup();

    stubLocalStorage({
      waves_admin_token: 'test-token',
      waves_admin_user: 'not-json{',
    });
    renderSheet();
    expect(screen.getByText('Cash')).toBeInTheDocument();
    expect(screen.queryByText('Card on File')).not.toBeInTheDocument();
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
