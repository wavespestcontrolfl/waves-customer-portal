// @vitest-environment jsdom
// Customer 360 → Cards on File → Remove: one DELETE to the admin route, the
// server's Auto Pay refusal shown verbatim, and the profile refreshed only
// after a removal that happened.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const adminFetch = vi.fn();
vi.mock('../../utils/admin-fetch', () => ({ adminFetch: (...a) => adminFetch(...a) }));
import RemovePaymentMethodDialog from './RemovePaymentMethodDialog';

const customer = { id: 'cust-1', firstName: 'Pat' };
const method = { id: 'pm-1', card_brand: 'VISA', last_four: '4242' };

afterEach(() => { cleanup(); adminFetch.mockReset(); });

describe('RemovePaymentMethodDialog', () => {
  it('renders nothing without a method', () => {
    const { container } = render(<RemovePaymentMethodDialog customer={customer} method={null} onClose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('removes through the admin route, refreshes, then closes', async () => {
    adminFetch.mockResolvedValue({ success: true });
    const onDone = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<RemovePaymentMethodDialog customer={customer} method={method} onClose={onClose} onDone={onDone} />);
    expect(screen.getByText('Remove VISA ending 4242?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(adminFetch).toHaveBeenCalledWith('/admin/customers/cust-1/payment-methods/pm-1', { method: 'DELETE' });
    expect(onDone).toHaveBeenCalled();
  });

  it('shows the Auto Pay refusal and stays open without refreshing', async () => {
    adminFetch.mockRejectedValue(Object.assign(new Error('This payment method is currently used for Auto Pay. Add another payment method or turn off Auto Pay before removing it.'), { status: 409 }));
    const onDone = vi.fn();
    const onClose = vi.fn();
    render(<RemovePaymentMethodDialog customer={customer} method={method} onClose={onClose} onDone={onDone} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText(/currently used for Auto Pay/)).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
