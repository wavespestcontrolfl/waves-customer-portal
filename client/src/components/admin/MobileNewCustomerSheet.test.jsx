// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MobileNewCustomerSheet from './MobileNewCustomerSheet';

vi.mock('../AddressAutocomplete', () => ({
  default: ({ value, onChange, placeholder }) => (
    <input placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));

describe('MobileNewCustomerSheet', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('sends address line 2 when creating a customer', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      customer: { id: 'customer-a' },
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    })));
    vi.stubGlobal('fetch', fetchMock);
    localStorage.setItem('waves_admin_token', 'test-token');

    render(
      <MobileNewCustomerSheet open onClose={vi.fn()} onCreated={vi.fn()} />,
    );

    fireEvent.change(screen.getByPlaceholderText('First name'), { target: { value: 'Avery' } });
    fireEvent.change(screen.getByPlaceholderText('Phone number'), { target: { value: '9415550100' } });
    fireEvent.change(screen.getByPlaceholderText('Address line 1'), { target: { value: '10 Palm Ave' } });
    fireEvent.change(screen.getByPlaceholderText('Address line 2'), { target: { value: 'Unit 4' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0]);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, options] = fetchMock.mock.calls[0];
    expect(JSON.parse(options.body)).toMatchObject({
      address: '10 Palm Ave',
      addressLine2: 'Unit 4',
    });
  });

  it('surfaces the server error message instead of a bare HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      error: 'That phone number already belongs to another account',
    }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    }))));

    render(<MobileNewCustomerSheet open onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('First name'), { target: { value: 'Avery' } });
    fireEvent.change(screen.getByPlaceholderText('Phone number'), { target: { value: '9415550100' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0]);

    expect(await screen.findByText('That phone number already belongs to another account')).toBeInTheDocument();
  });
});
