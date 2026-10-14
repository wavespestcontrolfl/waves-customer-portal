// @vitest-environment jsdom
// Customer 360 → Cards on File → Remove: the portal's removal disclosures
// (verified-bank debit lag, a card holding a future secured visit) before
// confirm, one DELETE to the admin route, the server's Auto Pay refusal
// shown verbatim, and the profile refreshed only after a removal that
// happened.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const adminFetch = vi.fn();
vi.mock('../../utils/admin-fetch', () => ({ adminFetch: (...a) => adminFetch(...a) }));
import RemovePaymentMethodDialog from './RemovePaymentMethodDialog';

const customer = { id: 'cust-1', firstName: 'Pat' };
const method = { id: 'pm-1', card_brand: 'VISA', last_four: '4242', method_type: 'card' };
const PREVIEW = '/admin/customers/cust-1/payment-methods/pm-1/removal-preview';
const noHold = { holdsAppointment: null, holdLookupFailed: false };

// Answers the preview GET with `preview`, the DELETE with `remove` (a value or an Error).
function routes(preview, remove = { success: true }) {
  adminFetch.mockImplementation(async (path, opts) => {
    if (path === PREVIEW) return preview;
    if (opts?.method === 'DELETE') {
      if (remove instanceof Error) throw remove;
      return remove;
    }
    throw new Error(`unexpected ${path}`);
  });
}

afterEach(() => { cleanup(); adminFetch.mockReset(); });

describe('RemovePaymentMethodDialog', () => {
  it('renders nothing without a method', () => {
    const { container } = render(<RemovePaymentMethodDialog customer={customer} method={null} onClose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('removes through the admin route, refreshes, then closes', async () => {
    routes(noHold);
    const onDone = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<RemovePaymentMethodDialog customer={customer} method={method} onClose={onClose} onDone={onDone} />);
    expect(screen.getByText('Remove VISA ending 4242?')).toBeInTheDocument();
    const remove = screen.getByRole('button', { name: 'Remove' });
    await waitFor(() => expect(remove).toBeEnabled());
    fireEvent.click(remove);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(adminFetch).toHaveBeenCalledWith('/admin/customers/cust-1/payment-methods/pm-1', { method: 'DELETE' });
    expect(onDone).toHaveBeenCalled();
  });

  it('shows the Auto Pay refusal and stays open without refreshing', async () => {
    routes(noHold, Object.assign(new Error('This payment method is currently used for Auto Pay. Add another payment method or turn off Auto Pay before removing it.'), { status: 409 }));
    const onDone = vi.fn();
    const onClose = vi.fn();
    render(<RemovePaymentMethodDialog customer={customer} method={method} onClose={onClose} onDone={onDone} />);
    const remove = screen.getByRole('button', { name: 'Remove' });
    await waitFor(() => expect(remove).toBeEnabled());
    fireEvent.click(remove);
    expect(await screen.findByText(/currently used for Auto Pay/)).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('discloses the held appointment and its fee before "Remove anyway"', async () => {
    routes({ holdsAppointment: { start: '2026-10-08T13:00:00.000Z', serviceType: 'Pest Control', feeAmount: 49 }, holdLookupFailed: false });
    render(<RemovePaymentMethodDialog customer={customer} method={method} onClose={vi.fn()} onDone={vi.fn()} />);
    expect(await screen.findByText('This card holds an appointment')).toBeInTheDocument();
    expect(screen.getByText(/Pest Control visit on .*\$49\.00 late-cancel fee/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove anyway' })).toBeEnabled();
  });

  it('warns that a verified bank debit can take 3 business days to stop', async () => {
    routes(noHold);
    const bank = { id: 'pm-1', method_type: 'us_bank_account', ach_status: 'verified', bank_name: 'Chase', bank_last_four: '6789' };
    render(<RemovePaymentMethodDialog customer={customer} method={bank} onClose={vi.fn()} onDone={vi.fn()} />);
    expect(screen.getByText('Remove Chase ending 6789?')).toBeInTheDocument();
    expect(screen.getByText(/up to 3 business days to stop/)).toBeInTheDocument();
  });

  it('a failed hold lookup says so and still allows removal', async () => {
    adminFetch.mockRejectedValueOnce(new Error('down'));
    render(<RemovePaymentMethodDialog customer={customer} method={method} onClose={vi.fn()} onDone={vi.fn()} />);
    expect(await screen.findByText(/Couldn.t check whether this card holds an upcoming appointment/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeEnabled();
  });
});
