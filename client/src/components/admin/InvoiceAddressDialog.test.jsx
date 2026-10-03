// @vitest-environment jsdom
// Invoices → Edit address: prefilled from the address the invoice's
// documents display, saved with one PUT, server validation shown in place.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const adminFetch = vi.fn();
vi.mock('../../utils/admin-fetch', () => ({ adminFetch: (...a) => adminFetch(...a) }));
import InvoiceAddressDialog from './InvoiceAddressDialog';

const invoice = { id: 'inv-1', invoice_number: 'WPC-1', first_name: 'Pat', last_name: 'Doe' };
const shown = { address_line1: '100 Wrong St', address_line2: null, city: 'Sarasota', state: 'FL', zip: '34201' };

afterEach(() => { cleanup(); adminFetch.mockReset(); });

describe('InvoiceAddressDialog', () => {
  it('prefills the displayed address and saves the correction', async () => {
    adminFetch.mockResolvedValueOnce({ address: shown }).mockResolvedValueOnce({ address: {} });
    const onSaved = vi.fn();
    render(<InvoiceAddressDialog invoice={invoice} onClose={vi.fn()} onSaved={onSaved} />);
    const street = await screen.findByDisplayValue('100 Wrong St');
    fireEvent.change(street, { target: { value: '12 Corrected Way' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save address' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(adminFetch).toHaveBeenNthCalledWith(1, '/admin/invoices/inv-1/receipt-address');
    expect(adminFetch).toHaveBeenNthCalledWith(2, '/admin/invoices/inv-1/receipt-address', {
      method: 'PUT',
      body: JSON.stringify({ ...shown, address_line1: '12 Corrected Way', address_line2: '' }),
    });
  });

  it('shows a server refusal and does not report saved', async () => {
    adminFetch.mockResolvedValueOnce({ address: shown }).mockRejectedValueOnce(new Error('ZIP must be 5 digits (or ZIP+4).'));
    const onSaved = vi.fn();
    render(<InvoiceAddressDialog invoice={invoice} onClose={vi.fn()} onSaved={onSaved} />);
    await screen.findByDisplayValue('100 Wrong St');
    fireEvent.click(screen.getByRole('button', { name: 'Save address' }));
    expect(await screen.findByText('ZIP must be 5 digits (or ZIP+4).')).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
