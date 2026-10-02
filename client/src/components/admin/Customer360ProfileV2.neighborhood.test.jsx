// @vitest-environment jsdom
/**
 * Customer 360 → Property → Neighborhood block (shared gate codes).
 * Staff-only: the block asks GET /admin/neighborhood-access/customers/:id/properties
 * and renders nothing at all when the directory is off (404) or the viewer is
 * not a full admin (403). The office can pick, create or clear a property's
 * neighborhood; every name and code here is synthetic.
 */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Customer360ProfileV2, { CustomerNeighborhoodBlock } from './Customer360ProfileV2';

vi.mock('./StickyActionBar', () => ({ CustomerActionBar: () => null }));
vi.mock('./AuthenticatedCallAudio', () => ({ default: () => null }));
vi.mock('./CustomerRequestsPanel', () => ({ default: () => null }));
vi.mock('./CallBridgeLink', () => ({
  default: ({ children }) => <span>{children}</span>,
  callViaBridge: vi.fn(),
}));
vi.mock('../../pages/admin/SchedulePage', () => ({
  ZoneMarkingStep: () => null,
  StationMarkingStep: () => null,
}));
vi.mock('../../hooks/useFeatureFlag', () => ({
  useFeatureFlagReady: () => ({ enabled: false, ready: true }),
}));

const BASE = '/admin/neighborhood-access';
const PROPS_URL = `${BASE}/customers/customer-a/properties`;

function response(body, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }));
}

const entry = (over = {}) => ({
  id: 'e1', gateLabel: 'Main gate', accessType: 'keypad', code: '4821', instructions: null, status: 'active', ...over,
});
const linked = (over = {}) => ({
  id: 'p1', label: 'Home', addressLine1: '100 Synthetic Way', city: 'Lakewood Ranch', zip: '34202',
  neighborhood: { id: 'n1', name: 'Synthetic Oaks', county: 'Manatee' }, neighborhoodSource: 'county',
  entries: [entry(), entry({ id: 'e2', gateLabel: 'Guard house', accessType: 'guard', code: null, instructions: 'Check in at the booth', status: 'needs_confirm' })],
  ...over,
});
const unlinked = (over = {}) => ({
  id: 'p1', label: 'Home', addressLine1: '100 Synthetic Way', city: 'Lakewood Ranch', zip: '34202',
  neighborhood: null, neighborhoodSource: null, entries: [], ...over,
});

let calls;
function stubFetch(handler) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn((url, init = {}) => {
    const path = String(url).replace(/^\/api/, '');
    calls.push({ path, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined });
    return handler(path, init);
  }));
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('waves_admin_token', 'test-token');
  localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CustomerNeighborhoodBlock', () => {
  it('shows the neighborhood, where it came from, and its live entries with Unconfirmed only for needs_confirm', async () => {
    stubFetch(() => response({ properties: [linked()] }));
    render(<CustomerNeighborhoodBlock customerId="customer-a" />);
    expect(await screen.findByText('Synthetic Oaks')).toBeInTheDocument();
    expect(screen.getByText('County records')).toBeInTheDocument();
    expect(screen.getByText('4821')).toBeInTheDocument();
    expect(screen.getByText('Check in at the booth')).toBeInTheDocument();
    expect(screen.getAllByText('Unconfirmed')).toHaveLength(1);
    expect(calls[0].path).toBe(PROPS_URL);
  });

  it('an office pick reads "Set by office"; no link reads "Not linked"', async () => {
    stubFetch(() => response({ properties: [linked({ neighborhoodSource: 'office' }), unlinked({ id: 'p2', addressLine1: '200 Sample Ct' })] }));
    render(<CustomerNeighborhoodBlock customerId="customer-a" />);
    expect(await screen.findByText('Set by office')).toBeInTheDocument();
    expect(screen.getByText('Not linked')).toBeInTheDocument();
    // Two properties: each is named by its label and address.
    expect(screen.getByText('Home · 200 Sample Ct, Lakewood Ranch')).toBeInTheDocument();
  });

  it('two units in one building read (and their Change buttons name) different rows', async () => {
    stubFetch(() => response({ properties: [
      unlinked({ id: 'p1', label: 'Unit A', addressLine2: 'Apt 101' }),
      unlinked({ id: 'p2', label: 'Unit B', addressLine2: 'Apt 202' }),
    ] }));
    render(<CustomerNeighborhoodBlock customerId="customer-a" />);
    expect(await screen.findByText('Unit A · 100 Synthetic Way Apt 101, Lakewood Ranch')).toBeInTheDocument();
    expect(screen.getByText('Unit B · 100 Synthetic Way Apt 202, Lakewood Ranch')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change neighborhood for Unit A · 100 Synthetic Way Apt 101, Lakewood Ranch' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change neighborhood for Unit B · 100 Synthetic Way Apt 202, Lakewood Ranch' })).toBeInTheDocument();
  });

  it.each([404, 403])('renders nothing at all on %i', async (status) => {
    stubFetch(() => response({ enabled: false }, status));
    const { container } = render(<CustomerNeighborhoodBlock customerId="customer-a" />);
    await waitFor(() => expect(calls).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
  });

  it('picking a searched neighborhood PUTs its id and shows the saved result', async () => {
    stubFetch((path, init) => {
      if (path === PROPS_URL) return response({ properties: [unlinked()] });
      if (path.startsWith(`${BASE}?q=`)) return response({ neighborhoods: [{ id: 'n7', name: 'Sample Pines', county: 'Sarasota' }], total: 1 });
      if (init.method === 'PUT') return response(linked({ neighborhood: { id: 'n7', name: 'Sample Pines', county: 'Sarasota' }, neighborhoodSource: 'office', entries: [] }));
      return response({});
    });
    render(<CustomerNeighborhoodBlock customerId="customer-a" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change neighborhood' }));
    fireEvent.change(screen.getByLabelText('Find a neighborhood'), { target: { value: 'pines' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Sample Pines · Sarasota' }));
    expect(await screen.findByText('Set by office')).toBeInTheDocument();
    expect(screen.getByText('Sample Pines')).toBeInTheDocument();
    expect(screen.getByText('No gate entry on file.')).toBeInTheDocument();
    expect(calls.find((c) => c.path.startsWith(`${BASE}?q=`)).path).toBe(`${BASE}?q=pines&limit=8`);
    const put = calls.find((c) => c.method === 'PUT');
    expect(put.path).toBe(`${BASE}/properties/p1/neighborhood`);
    expect(put.body).toEqual({ neighborhoodId: 'n7' });
  });

  it('a failed search never leaves the previous query\'s choices clickable', async () => {
    stubFetch((path) => {
      if (path === PROPS_URL) return response({ properties: [unlinked()] });
      if (path === `${BASE}?q=pines&limit=8`) return response({ neighborhoods: [{ id: 'n7', name: 'Sample Pines', county: 'Sarasota' }], total: 1 });
      if (path.startsWith(`${BASE}?q=`)) return response({ error: 'Could not load gate codes' }, 500);
      return response({});
    });
    render(<CustomerNeighborhoodBlock customerId="customer-a" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change neighborhood' }));
    fireEvent.change(screen.getByLabelText('Find a neighborhood'), { target: { value: 'pines' } });
    expect(await screen.findByRole('button', { name: 'Sample Pines · Sarasota' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Find a neighborhood'), { target: { value: 'oaks' } });
    await waitFor(() => expect(calls.some((c) => c.path === `${BASE}?q=oaks&limit=8`)).toBe(true));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Sample Pines · Sarasota' })).toBeNull());
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('Create neighborhood PUTs name and county', async () => {
    stubFetch((path, init) => {
      if (path === PROPS_URL) return response({ properties: [unlinked()] });
      if (init.method === 'PUT') return response(linked({ neighborhood: { id: 'n8', name: 'New Cove', county: 'Charlotte' }, neighborhoodSource: 'office', entries: [] }));
      return response({});
    });
    render(<CustomerNeighborhoodBlock customerId="customer-a" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change neighborhood' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create neighborhood' }));
    expect(screen.getByRole('button', { name: 'Save neighborhood' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Neighborhood name'), { target: { value: ' New Cove ' } });
    fireEvent.change(screen.getByLabelText('County'), { target: { value: 'Charlotte' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save neighborhood' }));
    expect(await screen.findByText('New Cove')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'PUT').body).toEqual({ create: { name: 'New Cove', county: 'Charlotte' } });
  });

  it('Clear PUTs a null neighborhood and is offered only when one is linked', async () => {
    stubFetch((path, init) => {
      if (path === PROPS_URL) return response({ properties: [linked()] });
      if (init.method === 'PUT') return response(unlinked());
      return response({});
    });
    render(<CustomerNeighborhoodBlock customerId="customer-a" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change neighborhood' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(await screen.findByText('Not linked')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'PUT').body).toEqual({ neighborhoodId: null });
    fireEvent.click(screen.getByRole('button', { name: 'Change neighborhood' }));
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
  });

  it('a refused save shows the server message and keeps the picker open', async () => {
    stubFetch((path, init) => {
      if (path === PROPS_URL) return response({ properties: [unlinked()] });
      if (init.method === 'PUT') return response({ error: 'Neighborhood not found' }, 404);
      return response({});
    });
    render(<CustomerNeighborhoodBlock customerId="customer-a" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change neighborhood' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create neighborhood' }));
    fireEvent.change(screen.getByLabelText('Neighborhood name'), { target: { value: 'Gone Glen' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save neighborhood' }));
    expect(await screen.findByText('Neighborhood not found')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save neighborhood' })).not.toBeDisabled();
  });
});

describe('Customer 360 Access section', () => {
  const detail = {
    customer: { id: 'customer-a', firstName: 'Avery', lastName: 'Customer', address: { line1: '1 Main St', city: 'Bradenton', state: 'FL', zip: '34205' }, active: true },
    notificationPrefs: {}, preferences: { id: 'pref-1', customer_id: 'customer-a' }, healthScore: {},
    invoices: [], cards: [], paymentMethodConsents: [], contracts: [], photos: [],
    customerDiscounts: [], complianceRecords: [], nutrientLedger: {}, services: [],
    payments: [], scheduled: [], upcomingScheduled: [], accountProperties: [], annualPrepayTerms: [],
  };
  const route = (path) => {
    if (path.endsWith('/admin/payers')) return response({ payers: [] });
    if (path.split('?')[0].endsWith('/timeline')) return response({ timeline: [] });
    if (path === PROPS_URL) return response({ properties: [linked()] });
    if (path.endsWith('/admin/customers/customer-a')) return response(detail);
    return response({});
  };

  it('an admin sees the Neighborhood block under the read view', async () => {
    stubFetch(route);
    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Property' }));
    expect(await screen.findByText('Synthetic Oaks')).toBeInTheDocument();
  });

  it('a technician never asks for it', async () => {
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'technician' }));
    stubFetch(route);
    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Property' }));
    expect(await screen.findByText('Access & Preferences')).toBeInTheDocument();
    expect(screen.queryByText('Synthetic Oaks')).toBeNull();
    expect(calls.some((c) => c.path === PROPS_URL)).toBe(false);
  });
});
