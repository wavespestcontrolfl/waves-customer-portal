// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useNavigate, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CustomersPageV2 from './CustomersPageV2';

vi.mock('../../components/admin/Customer360ProfileV2', () => ({
  default: function Profile({ customerId, initialTab }) {
    const [tab, setTab] = React.useState(initialTab);
    return <div data-testid="customer-profile">Profile {customerId}
      <span data-testid="profile-active-tab">{tab}</span>
      <button onClick={() => setTab('overview')}>Profile overview</button>
    </div>;
  },
}));
vi.mock('../../components/admin/MobileNewCustomerSheet', () => ({ default: () => null }));
vi.mock('../../components/AddressAutocomplete', () => ({
  default: ({ id, value, onChange, onSelect }) => (
    <>
      <input id={id} value={value} onChange={(e) => onChange(e.target.value)} />
      <button type="button" onClick={() => onSelect({ line1: '10 Palm Ave', line2: 'Unit 8', city: 'Naples', state: 'FL', zip: '34102' })}>
        Select unit address
      </button>
      <button type="button" onClick={() => onSelect({ line1: '20 Oak St', city: 'Naples', state: 'FL', zip: '34102' })}>
        Select street address
      </button>
    </>
  ),
}));

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

function RepeatCommsNotification({ workspace = false }) {
  const navigate = useNavigate();
  return <button onClick={() => navigate('/admin/customers?customerId=customer-a&tab=comms' + (workspace ? '&customer360=workspace' : ''))}>Open SMS notification</button>;
}

function RemountableDirectory() {
  const location = useLocation();
  const [version, setVersion] = React.useState(0);
  return <>
    <output data-testid="directory-url">{location.search}</output>
    <button onClick={() => setVersion((value) => value + 1)}>Remount directory</button>
    <CustomersPageV2 key={version} />
  </>;
}

describe('CustomersPageV2 workflow state', () => {
  it('opens the churn alert with the at-risk filter and preserves manual changes on profile return', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn((url) => {
      const parsed = new URL(String(url), 'http://fixture.invalid');
      if (parsed.pathname !== '/api/admin/customers') return response({});
      requests.push(parsed.searchParams);
      return response(list);
    }));
    render(<MemoryRouter initialEntries={['/admin/customers?customer360=workspace&healthRisk=at_risk']}><RemountableDirectory /></MemoryRouter>);
    await screen.findByRole('button', { name: 'Open Avery Customer customer profile' });
    expect(requests.every((params) => params.get('healthRisk') === 'at_risk')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    expect(screen.getByLabelText('Health / churn risk')).toHaveValue('at_risk');
    fireEvent.change(screen.getByLabelText('Health / churn risk'), { target: { value: 'low' } });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(requests.at(-1).get('healthRisk')).toBe('low'));
    fireEvent.click(screen.getByRole('button', { name: 'Open Avery Customer customer profile' }));
    fireEvent.click(screen.getByRole('button', { name: 'All customers', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    expect(screen.getByLabelText('Health / churn risk')).toHaveValue('low');
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    await waitFor(() => expect(requests.at(-1).has('healthRisk')).toBe(false));
    expect(screen.getByTestId('directory-url')).toHaveTextContent('?customer360=workspace');
    expect(screen.getByTestId('directory-url')).not.toHaveTextContent('healthRisk');
    fireEvent.click(screen.getByRole('button', { name: 'Remount directory' }));
    await screen.findByRole('button', { name: 'Open Avery Customer customer profile' });
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    expect(screen.getByLabelText('Health / churn risk')).toHaveValue('');
    expect(requests.at(-1).has('healthRisk')).toBe(false);
  });

  it('retains an edit through workspace navigation and a failed save without creating a membership', async () => {
    const writes = [];
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn((url, options = {}) => {
      const parsed = new URL(String(url), 'http://fixture.invalid');
      if (options.method === 'PUT') {
        writes.push({ path: parsed.pathname, body: JSON.parse(options.body) });
        return writes.length === 1 ? response({ error: 'Try again' }, 500) : response({ success: true });
      }
      return response(parsed.pathname === '/api/admin/customers' ? list : {});
    }));
    render(<MemoryRouter initialEntries={['/admin/customers?customer360=workspace']}><CustomersPageV2 /></MemoryRouter>);
    await screen.findByRole('button', { name: 'Open Avery Customer customer profile' });
    fireEvent.click(screen.getByLabelText('Actions for Avery Customer'));
    fireEvent.click(screen.getByRole('button', { name: 'Edit customer' }));
    fireEvent.change(screen.getByDisplayValue('Avery'), { target: { value: 'Edited name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open Avery Customer customer profile' }));
    fireEvent.click(screen.getByRole('button', { name: 'All customers', exact: true }));
    expect(screen.getByDisplayValue('Edited name')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() => expect(alert).toHaveBeenCalledWith('Save failed: Try again'));
    expect(screen.getByDisplayValue('Edited name')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() => expect(screen.queryByDisplayValue('Edited name')).not.toBeInTheDocument());
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
    expect(writes[0]).toMatchObject({
      path: '/api/admin/customers/customer-a',
      body: { firstName: 'Edited name', tier: null, serviceContactEmail: '' },
    });
    alert.mockRestore();
  });

  it('shows recorded circular scores beside names and composes server filters with search and pagination', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn((url) => {
      const parsed = new URL(String(url), 'http://fixture.invalid');
      if (parsed.pathname === '/api/admin/customers') {
        requests.push(parsed.searchParams);
        return response({ ...list, customers: [{ ...list.customers[0], healthGrade: 'A' }], total: 501, totalPages: 2 });
      }
      return response({});
    }));
    render(<MemoryRouter initialEntries={['/admin/customers?customer360=workspace']}><CustomersPageV2 /></MemoryRouter>);
    const score = await screen.findByRole('img', { name: 'Health score: 90/100' });
    expect(score.parentElement).toContainElement(screen.getByRole('button', { name: 'Open Avery Customer customer profile' }));
    expect(screen.queryByRole('button', { name: 'Health', exact: true })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
    await waitFor(() => expect(requests.at(-1).get('page')).toBe('2'));
    fireEvent.change(screen.getByPlaceholderText('Search customers...'), { target: { value: 'Avery' } });
    fireEvent.click(screen.getAllByRole('button', { name: /^Filter/ })[0]);
    const dialog = within(screen.getByRole('dialog', { name: 'Filter customers' }));
    fireEvent.change(dialog.getByLabelText('Health grade'), { target: { value: 'A' } });
    fireEvent.change(dialog.getByLabelText('Health / churn risk'), { target: { value: 'low' } });
    fireEvent.change(dialog.getByLabelText('Minimum health score'), { target: { value: '0' } });
    fireEvent.change(dialog.getByLabelText('Retention outcome'), { target: { value: 'saved' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(Object.fromEntries(requests.at(-1))).toMatchObject({ page: '1', search: 'Avery', healthGrade: 'A', healthRisk: 'low', minHealthScore: '0', retention: 'saved' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open Avery Customer customer profile' }));
    fireEvent.click(screen.getByRole('button', { name: 'All customers', exact: true }));
    fireEvent.click(screen.getAllByRole('button', { name: /^Filter/ })[0]);
    expect(screen.getByLabelText('Health grade')).toHaveValue('A');
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    await waitFor(() => expect(requests.at(-1).has('healthGrade')).toBe(false));
    expect(requests.at(-1).get('search')).toBe('Avery');
    expect(requests.at(-1).has('retention')).toBe(false);
  });

  it.each([null, 0])('opens old health links in the Directory and preserves a recorded score of %s', async (healthScore) => {
    vi.stubGlobal('fetch', vi.fn((url) => String(url).includes('/admin/customers?') ? response({ ...list, customers: [{ ...list.customers[0], healthScore }] }) : response({})));
    render(<MemoryRouter initialEntries={['/admin/customers?customer360=workspace&view=health']}><CustomersPageV2 /></MemoryRouter>);
    expect(await screen.findByRole('img', { name: healthScore == null ? 'Health score not recorded' : 'Health score: 0/100' })).toHaveTextContent(healthScore == null ? '—' : '0');
    expect(screen.getByRole('button', { name: 'Open Avery Customer customer profile' })).toBeInTheDocument();
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/admin/health/'))).toBe(false);
  });

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

  it.each([false, true])('reopens Comms after repeat notification navigation (workspace=%s)', async (workspace) => {
    vi.stubGlobal('fetch', vi.fn((url) => String(url).includes('/admin/customers?') ? response(list) : response({})));
    render(<MemoryRouter initialEntries={['/admin/customers?customerId=customer-a&tab=comms' + (workspace ? '&customer360=workspace' : '')]}>
      <RepeatCommsNotification workspace={workspace} /><CustomersPageV2 />
    </MemoryRouter>);
    expect(await screen.findByTestId('profile-active-tab')).toHaveTextContent('comms');
    fireEvent.click(screen.getByRole('button', { name: 'Profile overview' }));
    expect(screen.getByTestId('profile-active-tab')).toHaveTextContent('overview');
    fireEvent.click(screen.getByRole('button', { name: 'Open SMS notification' }));
    await waitFor(() => expect(screen.getByTestId('profile-active-tab')).toHaveTextContent('comms'));
  });

  it('names desktop customer inputs and selects using their visible labels', async () => {
    vi.stubGlobal('fetch', vi.fn((url) => (
      String(url).includes('/admin/customers?') ? response(list) : response({})
    )));
    render(<MemoryRouter initialEntries={['/admin/customers']}><CustomersPageV2 /></MemoryRouter>);
    await screen.findByText('Avery Customer');
    fireEvent.click(screen.getByRole('button', { name: 'Add Customer' }));
    const dialog = within(screen.getByRole('dialog'));
    for (const name of ['First name *', 'Last name', 'Phone *', 'Email', 'Address', 'Address line 2', 'City', 'State', 'ZIP', 'Notes']) {
      expect(dialog.getByRole('textbox', { name, exact: true })).toBe(dialog.getByLabelText(name, { exact: true }));
    }
    for (const name of ['Property label', 'Lead source', 'Pipeline stage', 'Tags']) {
      expect(dialog.getByRole('combobox', { name, exact: true })).toBe(dialog.getByLabelText(name, { exact: true }));
    }
    fireEvent.change(dialog.getByRole('combobox', { name: 'Property label' }), { target: { value: '__custom__' } });
    expect(dialog.getByRole('textbox', { name: 'Custom property label' })).toBeInTheDocument();
    expect(dialog.getByRole('textbox', { name: 'Custom tag' })).toBeInTheDocument();
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

  it.each(['/admin/customers', '/admin/customers?customer360=workspace'])('returns to the filtered directory when switching customers from %s', async (entry) => {
    const workspaceList = { ...list, customers: [...list.customers, { ...list.customers[0], id: 'customer-b', firstName: 'Blake' }], total: 2 };
    vi.stubGlobal('fetch', vi.fn((url) => {
      const path = String(url);
      if (path.includes('/admin/customers?')) return response(workspaceList);
      return response({});
    }));
    render(<MemoryRouter initialEntries={[entry]}><CustomersPageV2 /></MemoryRouter>);
    await screen.findByRole('button', { name: 'Open Avery Customer customer profile' });
    expect(screen.getAllByRole('link', { name: '10 Palm Ave, Unit 4, Naples FL 34102' })).toHaveLength(2);
    const search = screen.getByPlaceholderText('Search customers...');
    fireEvent.change(search, { target: { value: 'Customer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open Avery Customer customer profile' }));
    const workspace = within(await screen.findByRole('region', { name: 'Customer 360 workspace' }));
    expect(workspace.getByTestId('customer-profile')).toHaveTextContent('customer-a');
    fireEvent.click(workspace.getByRole('button', { name: 'All customers', exact: true }));
    expect(screen.getByPlaceholderText('Search customers...')).toHaveValue('Customer');
    fireEvent.click(await screen.findByRole('button', { name: 'Open Blake Customer customer profile' }));
    expect(within(screen.getByRole('region', { name: 'Customer 360 workspace' })).getByTestId('customer-profile')).toHaveTextContent('customer-b');
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
    // The confirm is bound to the account the admin saw in the 409.
    expect(postBodies[1].confirmMatchedAccountId).toBe('acct-a');
    // Attach success surfaces the account the profile landed on.
    expect(await screen.findByText(/additional property on Avery Customer's account/)).toBeInTheDocument();
  });
});
