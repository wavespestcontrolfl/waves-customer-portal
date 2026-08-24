// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CustomersPageV2 from './CustomersPageV2';

vi.mock('../../components/admin/Customer360ProfileV2', () => ({
  default: ({ customerId }) => <div data-testid="customer-profile">Profile {customerId}</div>,
}));
vi.mock('../../components/admin/MobileNewCustomerSheet', () => ({ default: () => null }));
vi.mock('../../components/AddressAutocomplete', () => ({
  default: ({ onSelect }) => (
    <>
      <button type="button" onClick={() => onSelect({ line1: '10 Palm Ave', line2: 'Unit 8', city: 'Naples', state: 'FL', zip: '34102' })}>
        Select unit address
      </button>
      <button type="button" onClick={() => onSelect({ line1: '20 Oak St', city: 'Naples', state: 'FL', zip: '34102' })}>
        Select street address
      </button>
    </>
  ),
}));
vi.mock('./CustomerHealthTabs', () => ({ CustomerHealthSection: () => null }));

function response(body, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }));
}

const list = {
  customers: [{
    id: 'customer-a',
    firstName: 'Avery',
    lastName: 'Customer',
    address: '10 Palm Ave, Unit 4, Naples FL 34102',
    healthScore: 90,
  }],
  total: 1,
  totalPages: 1,
};

function NavigateToCustomerButton() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate('/admin/customers?customerId=customer-b')}>
      Open customer B
    </button>
  );
}

describe('CustomersPageV2 workflow state', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('waves_admin_token', 'test-token');
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
  });

  it('clears stale rows and keeps search controls available when refresh fails', async () => {
    vi.stubGlobal('fetch', vi.fn((url) => {
      const path = String(url);
      if (path.includes('/admin/customers?') && path.includes('search=fail')) {
        return response({ error: 'Customer search unavailable' }, 503);
      }
      if (path.includes('/admin/customers?')) return response(list);
      return response({});
    }));

    render(<MemoryRouter initialEntries={['/admin/customers']}><CustomersPageV2 /></MemoryRouter>);
    expect(await screen.findByText('Avery Customer')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Search customers...'), {
      target: { value: 'fail' },
    });

    expect(await screen.findByText('Failed to load customers')).toBeInTheDocument();
    expect(screen.queryByText('Avery Customer')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search customers...')).toHaveValue('fail');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('reacts to customerId URL changes after the page is mounted', async () => {
    vi.stubGlobal('fetch', vi.fn((url) => {
      if (String(url).includes('/admin/customers?')) return response(list);
      return response({});
    }));

    render(
      <MemoryRouter initialEntries={['/admin/customers']}>
        <NavigateToCustomerButton />
        <CustomersPageV2 />
      </MemoryRouter>,
    );
    await screen.findByText('Avery Customer');
    expect(screen.queryByTestId('customer-profile')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open customer B' }));
    await waitFor(() => {
      expect(screen.getByTestId('customer-profile')).toHaveTextContent('Profile customer-b');
    });
  });

  it('replaces and clears address line 2 from desktop autocomplete selections', async () => {
    vi.stubGlobal('fetch', vi.fn((url) => (
      String(url).includes('/admin/customers?') ? response(list) : response({})
    )));

    render(<MemoryRouter initialEntries={['/admin/customers']}><CustomersPageV2 /></MemoryRouter>);
    await screen.findByText('Avery Customer');
    fireEvent.click(screen.getByRole('button', { name: 'Add Customer' }));

    const line2 = screen.getByPlaceholderText('Unit, suite, apartment');
    fireEvent.click(screen.getByRole('button', { name: 'Select unit address' }));
    expect(line2).toHaveValue('Unit 8');
    fireEvent.click(screen.getByRole('button', { name: 'Select street address' }));
    expect(line2).toHaveValue('');
  });

  it('shows a retryable customer-load error on the Map view', async () => {
    vi.stubGlobal('fetch', vi.fn((url) => (
      String(url).includes('/admin/customers?')
        ? response({ error: 'Map customers unavailable' }, 503)
        : response({})
    )));

    render(
      <MemoryRouter initialEntries={['/admin/customers?view=map']}>
        <CustomersPageV2 />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Failed to load customers')).toBeInTheDocument();
    expect(screen.getByText('Map customers unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('phone-match 409 shows the confirm choices and resubmits with confirmAttach', async () => {
    const postBodies = [];
    vi.stubGlobal('fetch', vi.fn((url, opts) => {
      const path = String(url);
      if (path.includes('/admin/customers?')) return response(list);
      if (path.endsWith('/admin/customers') && opts?.method === 'POST') {
        const body = JSON.parse(opts.body);
        postBodies.push(body);
        if (body.confirmAttach === true) {
          return response(
            { id: 'cust-new', attachedToExistingAccount: true, existingCustomerName: 'Avery Customer' },
            201,
          );
        }
        return response(
          {
            error: 'This phone belongs to an existing customer',
            code: 'PHONE_MATCH_CONFIRM',
            match: { customerId: 'customer-a', accountId: 'acct-a', name: 'Avery Customer', address: '10 Palm Ave, Naples FL 34102' },
          },
          409,
        );
      }
      return response({});
    }));

    render(<MemoryRouter initialEntries={['/admin/customers']}><CustomersPageV2 /></MemoryRouter>);
    await screen.findByText('Avery Customer');
    fireEvent.click(screen.getByRole('button', { name: 'Add Customer' }));

    const dialog = screen.getByRole('dialog');
    const inputs = within(dialog).getAllByRole('textbox');
    fireEvent.change(inputs[0], { target: { value: 'Testfirst' } }); // First name
    fireEvent.change(inputs[2], { target: { value: '5551234567' } }); // Phone
    fireEvent.click(within(dialog).getByRole('button', { name: 'Submit' }));

    // The confirm panel names the matched customer + address — no silent create.
    expect(await within(dialog).findByText(/at 10 Palm Ave, Naples FL 34102/)).toBeInTheDocument();
    expect(postBodies).toHaveLength(1);
    expect(postBodies[0].confirmAttach).toBeUndefined();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Attach as additional property' }));
    await waitFor(() => expect(postBodies).toHaveLength(2));
    expect(postBodies[1].confirmAttach).toBe(true);
    // Attach success surfaces the account the profile landed on.
    expect(await screen.findByText(/additional property on Avery Customer's account/)).toBeInTheDocument();
  });
});
