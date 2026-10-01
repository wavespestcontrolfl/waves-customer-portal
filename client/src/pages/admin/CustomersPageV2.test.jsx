// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BrowserRouter, MemoryRouter, Route, Routes, useNavigate, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CustomersPageV2 from './CustomersPageV2';

vi.mock('../../components/admin/Customer360ProfileV2', () => ({
  default: function Profile({ customerId, initialTab, onCustomerMutation, onDraftActiveChange }) {
    const [tab, setTab] = React.useState(initialTab);
    // Stands in for the embedded address-review panel's own draft-active
    // signal (CustomerGeocodeReviewPanel -> useCustomerProfileNavigation),
    // which is what a real open draft reports through this same prop.
    const [draftOpen, setDraftOpen] = React.useState(false);
    return <div data-testid="customer-profile">Profile {customerId}
      <span data-testid="profile-active-tab">{tab}</span>
      <span data-testid="draft-open">{String(draftOpen)}</span>
      <button onClick={() => setTab('overview')}>Profile overview</button>
      <button onClick={() => onCustomerMutation?.({ customerId, action: 'update' })}>Save profile address</button>
      <button onClick={() => { setDraftOpen(true); onDraftActiveChange?.(true); }}>Open address draft</button>
      <button onClick={() => { setDraftOpen(false); onDraftActiveChange?.(false); }}>Close address draft</button>
    </div>;
  },
}));
vi.mock('../../components/admin/MobileNewCustomerSheet', () => ({ default: () => null }));
vi.mock('../../components/admin/CustomerGeocodeReviewPanel', () => ({
  default: function GeocodeReviewPanel({ refreshToken = 0, onResolved, onDraftActiveChange }) {
    // Stands in for this panel's own draft-active signal — real for the
    // directory-level queue instance (no customerId) this test file mounts;
    // the embedded per-customer instance lives inside the fully-mocked
    // Customer360ProfileV2 above and never renders this component.
    const [draftOpen, setDraftOpen] = React.useState(false);
    return <>
      <output data-testid="geocode-review-refresh">{refreshToken}</output>
      <span data-testid="queue-draft-open">{String(draftOpen)}</span>
      <button type="button" onClick={onResolved}>Resolve address review</button>
      <button type="button" onClick={() => { setDraftOpen(true); onDraftActiveChange?.(true); }}>Open queue draft</button>
    </>;
  },
  confirmDiscardDraft: () => window.confirm('This will discard the unsaved address review draft. Continue?'),
}));
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
  it.each(['/admin/customers', '/admin/customers?view=intelligence'])('keeps office intelligence out of technician navigation at %s', async (entry) => {
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'technician' }));
    vi.stubGlobal('fetch', vi.fn((url) => String(url).includes('/admin/customers?') ? response(list) : response({})));
    render(<MemoryRouter initialEntries={[entry]}><CustomersPageV2 /></MemoryRouter>);
    await screen.findByRole('button', { name: 'Open Avery Customer customer profile' });
    expect(screen.queryByRole('button', { name: 'Opportunities', exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add Customer', exact: true })).not.toBeInTheDocument();
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/customers/intelligence'))).toBe(false);
  });

  it('preserves the admin Opportunities navigation', async () => {
    vi.stubGlobal('fetch', vi.fn((url) => String(url).includes('/admin/customers?') ? response(list) : response({})));
    render(<MemoryRouter initialEntries={['/admin/customers']}><CustomersPageV2 /></MemoryRouter>);
    await screen.findByRole('button', { name: 'Open Avery Customer customer profile' });
    expect(screen.getByRole('button', { name: 'Opportunities', exact: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Customer', exact: true })).toBeInTheDocument();
  });

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

  it('refreshes the address review queue after a successful city save and customer deletion', async () => {
    const writes = [];
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.stubGlobal('fetch', vi.fn((url, options = {}) => {
      const parsed = new URL(String(url), 'http://fixture.invalid');
      if (options.method === 'PUT' || options.method === 'DELETE') {
        writes.push({ method: options.method, path: parsed.pathname, body: options.body });
        return response({ success: true });
      }
      return response(parsed.pathname === '/api/admin/customers' ? list : {});
    }));

    render(<MemoryRouter initialEntries={['/admin/customers']}><CustomersPageV2 /></MemoryRouter>);
    await screen.findByRole('button', { name: 'Open Avery Customer customer profile' });
    expect(screen.getByTestId('geocode-review-refresh')).toHaveTextContent('0');

    fireEvent.click(screen.getByLabelText('Actions for Avery Customer'));
    fireEvent.click(screen.getByRole('button', { name: 'Edit customer' }));
    const editor = screen.getByRole('region', { name: 'Edit customer' });
    fireEvent.change(within(editor).getByLabelText('City'), { target: { value: 'Sarasota' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() => expect(screen.getByTestId('geocode-review-refresh')).toHaveTextContent('1'));

    fireEvent.click(screen.getByLabelText('Actions for Avery Customer'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete customer' }));
    await waitFor(() => expect(screen.getByTestId('geocode-review-refresh')).toHaveTextContent('2'));
    expect(writes.map(({ method }) => method)).toEqual(['PUT', 'DELETE']);
    confirm.mockRestore();
  });

  it('refreshes the mounted overlay queue after quick-add and Customer 360 mutations', async () => {
    vi.stubGlobal('fetch', vi.fn((url, options = {}) => {
      const parsed = new URL(String(url), 'http://fixture.invalid');
      if (parsed.pathname === '/api/admin/customers' && options.method === 'POST') {
        return response({ id: 'customer-new', firstName: 'New', lastName: 'Customer' });
      }
      return response(parsed.pathname === '/api/admin/customers' ? list : {});
    }));

    render(<MemoryRouter initialEntries={['/admin/customers?customer360=overlay']}><CustomersPageV2 /></MemoryRouter>);
    await screen.findByRole('button', { name: 'Open Avery Customer customer profile' });
    expect(screen.getByTestId('geocode-review-refresh')).toHaveTextContent('0');

    fireEvent.click(screen.getByRole('button', { name: 'Add Customer' }));
    const dialog = within(screen.getByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('First name *'), { target: { value: 'New' } });
    fireEvent.change(dialog.getByLabelText('Phone *'), { target: { value: '5551234567' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(screen.getByTestId('geocode-review-refresh')).toHaveTextContent('1'));

    fireEvent.click(await screen.findByRole('button', { name: 'Save profile address' }));
    await waitFor(() => expect(screen.getByTestId('geocode-review-refresh')).toHaveTextContent('2'));
  });

  it.each(['/admin/customers', '/admin/customers?customer360=workspace'])('refreshes the directory after a workspace address review at %s', async (entry) => {
    let customerReads = 0;
    const reviewedAddress = '25 Reviewed Ave, Naples FL 34102';
    vi.stubGlobal('fetch', vi.fn((url) => {
      const parsed = new URL(String(url), 'http://fixture.invalid');
      if (parsed.pathname !== '/api/admin/customers') return response({});
      customerReads += 1;
      return response({
        ...list,
        customers: [{ ...list.customers[0], address: customerReads > 1 ? reviewedAddress : list.customers[0].address }],
      });
    }));

    render(<MemoryRouter initialEntries={[entry]}><CustomersPageV2 /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Avery Customer customer profile' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save profile address' }));
    await waitFor(() => expect(customerReads).toBe(2));
    fireEvent.click(screen.getByRole('button', { name: 'All customers', exact: true }));
    expect(await screen.findByText(reviewedAddress)).toBeInTheDocument();
    expect(screen.getByTestId('geocode-review-refresh')).toHaveTextContent('1');
  });

  it('refreshes the displayed customer list after a queue resolution', async () => {
    let customerReads = 0;
    const addresses = ['10 Palm Ave, Unit 4, Naples FL 34102', '25 Reviewed Ave, Naples FL 34102'];
    vi.stubGlobal('fetch', vi.fn((url) => {
      const parsed = new URL(String(url), 'http://fixture.invalid');
      if (parsed.pathname !== '/api/admin/customers') return response({});
      return response({
        ...list,
        customers: [{
          ...list.customers[0],
          address: addresses[Math.min(customerReads++, 1)],
        }],
      });
    }));

    render(<MemoryRouter initialEntries={['/admin/customers']}><CustomersPageV2 /></MemoryRouter>);
    expect(await screen.findByText('10 Palm Ave, Unit 4, Naples FL 34102')).toBeInTheDocument();
    expect(screen.getByTestId('geocode-review-refresh')).toHaveTextContent('0');

    fireEvent.click(screen.getByRole('button', { name: 'Resolve address review' }));

    expect(await screen.findByText('25 Reviewed Ave, Naples FL 34102')).toBeInTheDocument();
    expect(customerReads).toBe(2);
    expect(screen.getByTestId('geocode-review-refresh')).toHaveTextContent('0');
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

  it('preserves server relevance order while a name search is active', async () => {
    const requests = [];
    const ranked = {
      customers: [
        { id: 'customer-exact', firstName: 'Zed', lastName: 'Exact', address: '1 Fixture Way' },
        { id: 'customer-broad', firstName: 'Aaron', lastName: 'Broad', address: '2 Fixture Way' },
      ],
      total: 2,
      totalPages: 1,
    };
    vi.stubGlobal('fetch', vi.fn((url) => {
      const parsed = new URL(String(url), 'http://fixture.invalid');
      requests.push(parsed.searchParams);
      return response(parsed.searchParams.get('search') === 'Exact' ? ranked : list);
    }));
    render(<MemoryRouter initialEntries={['/admin/customers']}><CustomersPageV2 /></MemoryRouter>);
    await screen.findByRole('button', { name: 'Open Avery Customer customer profile' });

    fireEvent.change(screen.getByPlaceholderText('Search customers...'), {
      target: { value: 'Exact' },
    });

    await screen.findByRole('button', { name: 'Open Zed Exact customer profile' });
    const resultButtons = screen.getAllByRole('button', { name: /customer profile$/ });
    expect(resultButtons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Open Zed Exact customer profile',
      'Open Aaron Broad customer profile',
    ]);
    expect(requests.at(-1).get('sort')).toBe('name');
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
    window.history.replaceState({}, '', '/');
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

  // Browser Back/Forward is same-document navigation for this page's own
  // ?customerId= — it never fires beforeunload, so it needs its own guard
  // (CustomersPageV2's popstate listener) fed by the same draft-active
  // signal the embedded profile already reports for its tab/close guards.
  // A real BrowserRouter is required here (unlike the MemoryRouter used
  // elsewhere in this file) because MemoryRouter never touches window.history
  // or dispatches a 'popstate' event — see TechFieldShell.test.jsx for the
  // same precedent on TechNavigationLock's own history guard.
  it('keeps a draft-open profile mounted and the draft intact when browser Back is declined', async () => {
    vi.stubGlobal('fetch', vi.fn((url) => String(url).includes('/admin/customers?') ? response(list) : response({})));
    window.history.replaceState({ idx: 0 }, '', '/admin/customers');
    window.history.pushState({ idx: 1 }, '', '/admin/customers?customerId=customer-a');
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><CustomersPageV2 /></BrowserRouter>);
    expect(await screen.findByTestId('customer-profile')).toHaveTextContent('customer-a');
    fireEvent.click(screen.getByRole('button', { name: 'Open address draft' }));
    expect(screen.getByTestId('draft-open')).toHaveTextContent('true');

    // jsdom (like a real browser) dispatches 'popstate' asynchronously after
    // history.back() — waitFor gives that task a chance to run, same as
    // TechFieldShell.test.jsx's own history-guard assertions.
    act(() => { window.history.back(); });
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledOnce());

    // The profile, its draft, and the URL all stay exactly as they were —
    // no unmount/remount round trip through a blank customerId.
    await waitFor(() => expect(window.location.search).toBe('?customerId=customer-a'));
    expect(screen.getByTestId('customer-profile')).toHaveTextContent('customer-a');
    expect(screen.getByTestId('draft-open')).toHaveTextContent('true');

    // The decline stepped forward rather than overwriting the entry it popped
    // to, so a later confirmed Back still reaches the directory.
    confirmSpy.mockReturnValue(true);
    act(() => { window.history.back(); });
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(window.location.pathname).toBe('/admin/customers');
  });

  it('lets browser Back through once the draft discard is confirmed', async () => {
    vi.stubGlobal('fetch', vi.fn((url) => String(url).includes('/admin/customers?') ? response(list) : response({})));
    window.history.replaceState({ idx: 0 }, '', '/admin/customers');
    window.history.pushState({ idx: 1 }, '', '/admin/customers?customerId=customer-a');
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><CustomersPageV2 /></BrowserRouter>);
    expect(await screen.findByTestId('customer-profile')).toHaveTextContent('customer-a');
    fireEvent.click(screen.getByRole('button', { name: 'Open address draft' }));
    expect(screen.getByTestId('draft-open')).toHaveTextContent('true');

    act(() => { window.history.back(); });
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledOnce());
    await waitFor(() => expect(window.location.search).toBe(''));
    await waitFor(() => expect(screen.queryByTestId('customer-profile')).not.toBeInTheDocument());
  });

  // The directory-level address-review QUEUE (no customerId — rendered on
  // the bare Customers directory) has its own open-draft state, independent
  // of a customer profile's. It shares the same page-level guard. Two
  // separate tests (rather than declining then confirming in the same one)
  // because declining replaces the popped-to entry with the draft's own URL
  // — a second real Back from that same minimal two-entry stack would have
  // nothing left before it to go to, a test-stack artifact, not a real-world
  // dead end (see the analogous profile-level tests above).
  it('keeps a directory queue draft intact when browser Back is declined', async () => {
    vi.stubGlobal('fetch', vi.fn((url) => String(url).includes('/admin/customers?') ? response(list) : response({})));
    window.history.replaceState({ idx: 0 }, '', '/admin/dashboard');
    window.history.pushState({ idx: 1 }, '', '/admin/customers');
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><CustomersPageV2 /></BrowserRouter>);
    await screen.findByText('Avery Customer');
    fireEvent.click(screen.getByRole('button', { name: 'Open queue draft' }));
    expect(screen.getByTestId('queue-draft-open')).toHaveTextContent('true');

    // Declined: still on the Customers directory with the queue draft intact.
    act(() => { window.history.back(); });
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledOnce());
    expect(window.location.pathname).toBe('/admin/customers');
    expect(screen.getByTestId('queue-draft-open')).toHaveTextContent('true');
  });

  it('lets browser Back away from the Customers directory through once a queue draft discard is confirmed', async () => {
    vi.stubGlobal('fetch', vi.fn((url) => String(url).includes('/admin/customers?') ? response(list) : response({})));
    window.history.replaceState({ idx: 0 }, '', '/admin/dashboard');
    window.history.pushState({ idx: 1 }, '', '/admin/customers');
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><CustomersPageV2 /></BrowserRouter>);
    await screen.findByText('Avery Customer');
    fireEvent.click(screen.getByRole('button', { name: 'Open queue draft' }));
    expect(screen.getByTestId('queue-draft-open')).toHaveTextContent('true');

    act(() => { window.history.back(); });
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledOnce());
    await waitFor(() => expect(window.location.pathname).toBe('/admin/dashboard'));
  });

  // In-app link navigation (the AdminLayoutV2 sidebar/tab bar, or any other
  // <a href>) pushes a new location instead of firing 'popstate' — the
  // separate guardLink capture-phase listener covers it, same pattern as
  // EstimateToolViewV2's own unsaved-draft guard.
  it('confirms before an in-app link push away from the Customers page discards an open draft', async () => {
    vi.stubGlobal('fetch', vi.fn((url) => String(url).includes('/admin/customers?') ? response(list) : response({})));
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const linkClicks = vi.fn();

    render(<MemoryRouter initialEntries={['/admin/customers']}>
      {/* A plain onClick counter (preventDefault always, so jsdom never
          attempts a real document navigation) stands in for react-router's
          <Link> reaching its own click handler — guardLink runs in the
          capture phase, so stopping it there keeps the target's own
          handler from ever firing, same as it would for a real <Link>. */}
      <a href="/admin/dashboard" onClick={(e) => { e.preventDefault(); linkClicks(); }}>Leave to Dashboard</a>
      <CustomersPageV2 />
    </MemoryRouter>);
    await screen.findByText('Avery Customer');
    fireEvent.click(screen.getByRole('button', { name: 'Open queue draft' }));
    expect(screen.getByTestId('queue-draft-open')).toHaveTextContent('true');

    // Declined: the click is swallowed before the link's own handler runs.
    fireEvent.click(screen.getByRole('link', { name: 'Leave to Dashboard' }));
    expect(confirmSpy).toHaveBeenCalledOnce();
    expect(linkClicks).not.toHaveBeenCalled();
    expect(screen.getByTestId('queue-draft-open')).toHaveTextContent('true');

    // Confirmed: the click reaches the link's own handler.
    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByRole('link', { name: 'Leave to Dashboard' }));
    expect(confirmSpy).toHaveBeenCalledTimes(2);
    expect(linkClicks).toHaveBeenCalledOnce();
  });

  it('does not prompt for a link to the page already open', async () => {
    vi.stubGlobal('fetch', vi.fn((url) => String(url).includes('/admin/customers?') ? response(list) : response({})));
    window.history.replaceState({ idx: 0 }, '', '/admin/customers');
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const linkClicks = vi.fn();

    render(<MemoryRouter initialEntries={['/admin/customers']}>
      <a href="/admin/customers" onClick={(e) => { e.preventDefault(); linkClicks(); }}>Customers</a>
      <a href="/admin/customers#queue" onClick={(e) => { e.preventDefault(); linkClicks(); }}>Queue section</a>
      <a href="/admin/communications#notifications" onClick={(e) => { e.preventDefault(); linkClicks(); }}>Notifications</a>
      <a href="tel:+15555550100" onClick={(e) => { e.preventDefault(); linkClicks(); }}>Call</a>
      <a href="/admin/export.csv" download onClick={(e) => { e.preventDefault(); linkClicks(); }}>Export</a>
      <CustomersPageV2 />
    </MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Open queue draft' }));
    fireEvent.click(screen.getByRole('link', { name: 'Customers' }));
    fireEvent.click(screen.getByRole('link', { name: 'Queue section' }));
    // A phone link or a download never unloads this page either.
    fireEvent.click(screen.getByRole('link', { name: 'Call' }));
    fireEvent.click(screen.getByRole('link', { name: 'Export' }));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(linkClicks).toHaveBeenCalledTimes(4);

    // A fragment on a different page still leaves this one.
    fireEvent.click(screen.getByRole('link', { name: 'Notifications' }));
    expect(confirmSpy).toHaveBeenCalledOnce();
    expect(linkClicks).toHaveBeenCalledTimes(4);
  });

  // Overlay mode mounts the directory queue and a profile together: opening
  // a profile keeps the queue draft (no prompt), and closing the profile's
  // draft must not drop the guard for the queue's open draft.
  it('keeps guarding an open queue draft after an overlay profile draft closes', async () => {
    vi.stubGlobal('fetch', vi.fn((url) => String(url).includes('/admin/customers?') ? response(list) : response({})));
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const linkClicks = vi.fn();

    render(<MemoryRouter initialEntries={['/admin/customers?customer360=overlay']}>
      <a href="/admin/dashboard" onClick={(e) => { e.preventDefault(); linkClicks(); }}>Leave to Dashboard</a>
      <CustomersPageV2 />
    </MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Open queue draft' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open Avery Customer customer profile' }));
    expect(confirmSpy).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Open address draft' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close address draft' }));
    expect(screen.getByTestId('queue-draft-open')).toHaveTextContent('true');

    fireEvent.click(screen.getByRole('link', { name: 'Leave to Dashboard' }));
    expect(confirmSpy).toHaveBeenCalledOnce();
    expect(linkClicks).not.toHaveBeenCalled();
  });

  // The directory table's own customer-name click (and the mobile/legacy
  // list, and the "Open profile" menu item) is a plain programmatic
  // ?customerId= write — no popstate, no <a> click — so neither
  // guardHistory nor guardLink ever sees it. It needs its own guard.
  it('prompts before opening a directory profile while a queue draft is open, and opens it once confirmed', async () => {
    vi.stubGlobal('fetch', vi.fn((url) => String(url).includes('/admin/customers?') ? response(list) : response({})));
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<MemoryRouter initialEntries={['/admin/customers']}><CustomersPageV2 /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Open queue draft' }));
    expect(screen.getByTestId('queue-draft-open')).toHaveTextContent('true');

    // Declined: the profile never opens, and the queue draft survives.
    fireEvent.click(screen.getByRole('button', { name: 'Open Avery Customer customer profile' }));
    expect(confirmSpy).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('customer-profile')).not.toBeInTheDocument();
    expect(screen.getByTestId('queue-draft-open')).toHaveTextContent('true');

    // Confirmed: the same click now opens it.
    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Open Avery Customer customer profile' }));
    expect(await screen.findByTestId('customer-profile')).toHaveTextContent('customer-a');
  });

  // Switching away from Directory unmounts the queue panel below (it only
  // renders under view === "directory") with no popstate and no <a> click
  // of its own — same unguarded gap as opening a profile from the table.
  it('prompts before switching the Customers view while a queue draft is open, and switches once confirmed', async () => {
    vi.stubGlobal('fetch', vi.fn((url) => String(url).includes('/admin/customers?') ? response(list) : response({})));
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<MemoryRouter initialEntries={['/admin/customers']}><CustomersPageV2 /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Open queue draft' }));
    expect(screen.getByTestId('queue-draft-open')).toHaveTextContent('true');

    // Re-selecting the view already shown discards nothing.
    fireEvent.click(screen.getByRole('button', { name: 'Directory' }));
    expect(confirmSpy).not.toHaveBeenCalled();

    // Declined: stays on Directory with the queue draft intact.
    fireEvent.click(screen.getByRole('button', { name: 'Map' }));
    expect(confirmSpy).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Directory' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('queue-draft-open')).toHaveTextContent('true');

    // Confirmed: the view actually switches, unmounting the queue panel.
    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Map' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Map' })).toHaveAttribute('aria-current', 'page'));
    expect(screen.queryByTestId('queue-draft-open')).not.toBeInTheDocument();
  });

  // shiftKey/altKey open a new window or trigger a download, same as
  // _blank/meta/ctrl (already covered above) — none of those unmount this
  // page, so none should prompt.
  it('does not prompt a shift-click or alt-click on a same-tab link while a queue draft is open', async () => {
    vi.stubGlobal('fetch', vi.fn((url) => String(url).includes('/admin/customers?') ? response(list) : response({})));
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const linkClicks = vi.fn();

    render(<MemoryRouter initialEntries={['/admin/customers']}>
      <a href="/admin/dashboard" onClick={(e) => { e.preventDefault(); linkClicks(); }}>Leave to Dashboard</a>
      <CustomersPageV2 />
    </MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Open queue draft' }));
    expect(screen.getByTestId('queue-draft-open')).toHaveTextContent('true');

    fireEvent.click(screen.getByRole('link', { name: 'Leave to Dashboard' }), { shiftKey: true });
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(linkClicks).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('link', { name: 'Leave to Dashboard' }), { altKey: true });
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(linkClicks).toHaveBeenCalledTimes(2);
  });

  // A link/back-forward move that keeps the SAME panel mounted (view stays
  // "directory", customerId and customer360 mode unchanged) must never
  // prompt just because some other query param — healthRisk here — differs.
  // The sidebar's "Customers" link from an at-risk filter is exactly this:
  // the router keeps rendering CustomersPageV2 with the same queue panel
  // underneath (only the health filter itself, applied ~1755-1764, changes).
  it('does not prompt a link that only changes a filter param, and still prompts a link that changes the view', async () => {
    vi.stubGlobal('fetch', vi.fn((url) => String(url).includes('/admin/customers?') ? response(list) : response({})));
    window.history.replaceState({ idx: 0 }, '', '/admin/customers?healthRisk=at_risk');
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const linkClicks = vi.fn();

    render(<MemoryRouter initialEntries={['/admin/customers?healthRisk=at_risk']}>
      <a href="/admin/customers" onClick={(e) => { e.preventDefault(); linkClicks(); }}>Customers</a>
      <a href="/admin/customers?view=map" onClick={(e) => { e.preventDefault(); linkClicks(); }}>Map</a>
      <CustomersPageV2 />
    </MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Open queue draft' }));
    expect(screen.getByTestId('queue-draft-open')).toHaveTextContent('true');

    // Dropping the health filter keeps the same queue panel mounted.
    fireEvent.click(screen.getByRole('link', { name: 'Customers' }));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(linkClicks).toHaveBeenCalledOnce();
    expect(screen.getByTestId('queue-draft-open')).toHaveTextContent('true');

    // A view change is a real remount of the panel underneath.
    fireEvent.click(screen.getByRole('link', { name: 'Map' }));
    expect(confirmSpy).toHaveBeenCalledOnce();
    expect(linkClicks).toHaveBeenCalledOnce();
  });

  // Same story for browser Back/Forward: a pop that only changes healthRisk
  // never discards the queue panel that stays mounted underneath it.
  it('does not prompt browser Back when it only changes a filter param', async () => {
    vi.stubGlobal('fetch', vi.fn((url) => String(url).includes('/admin/customers?') ? response(list) : response({})));
    window.history.replaceState({ idx: 0 }, '', '/admin/customers');
    window.history.pushState({ idx: 1 }, '', '/admin/customers?healthRisk=at_risk');
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><CustomersPageV2 /></BrowserRouter>);
    await screen.findByText('Avery Customer');
    fireEvent.click(screen.getByRole('button', { name: 'Open queue draft' }));
    expect(screen.getByTestId('queue-draft-open')).toHaveTextContent('true');

    act(() => { window.history.back(); });
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('queue-draft-open')).toHaveTextContent('true');
  });

  // Both customers routes render the same page element, so React keeps the
  // page and its queue mounted across a move between them: no prompt, and
  // the draft is still there afterwards.
  it('does not prompt or lose a queue draft moving between the two customers routes', async () => {
    vi.stubGlobal('fetch', vi.fn((url) => String(url).includes('/admin/customers?') ? response(list) : response({})));
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<MemoryRouter initialEntries={['/admin/customers']}>
      <NewCustomerLink />
      <Routes>
        <Route path="/admin/customers" element={<CustomersPageV2 />} />
        <Route path="/admin/customers/new" element={<CustomersPageV2 />} />
      </Routes>
    </MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Open queue draft' }));
    fireEvent.click(screen.getByRole('link', { name: 'New customer' }));
    expect(confirmSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('route-path')).toHaveTextContent('/admin/customers/new'));
    expect(screen.getByTestId('queue-draft-open')).toHaveTextContent('true');
  });

  // The profile is keyed on location.key while tab=comms, so opening Comms
  // for the same customer remounts it and would drop its draft.
  it('prompts before a same-customer Comms navigation remounts an open profile draft', async () => {
    vi.stubGlobal('fetch', vi.fn((url) => String(url).includes('/admin/customers?') ? response(list) : response({})));
    window.history.replaceState({}, '', '/admin/customers?customerId=customer-a');
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<MemoryRouter initialEntries={['/admin/customers?customerId=customer-a']}>
      <a href="/admin/customers?customerId=customer-a&tab=comms" onClick={(e) => e.preventDefault()}>Open Comms</a>
      <CustomersPageV2 />
    </MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Open address draft' }));
    fireEvent.click(screen.getByRole('link', { name: 'Open Comms' }));
    expect(confirmSpy).toHaveBeenCalledOnce();
  });
});

function NewCustomerLink() {
  const navigate = useNavigate();
  const location = useLocation();
  return <>
    <output data-testid="route-path">{location.pathname}</output>
    <a href="/admin/customers/new" onClick={(e) => { e.preventDefault(); navigate('/admin/customers/new'); }}>New customer</a>
  </>;
}
