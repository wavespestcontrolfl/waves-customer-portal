// @vitest-environment jsdom
// "Others at this address": two spouses at one house used to be two
// unconnected profiles. The 360 payload now carries `addressNeighbors` (other
// live customers at the same street address, unit-aware, same account
// excluded) and the overview cross-references them with a one-click open.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Customer360ProfileV2 from './Customer360ProfileV2';

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

function response(body, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }));
}

function customerDetail(addressNeighbors) {
  return {
    customer: {
      id: 'wife',
      firstName: 'Jane',
      lastName: 'Doe',
      address: { line1: '123 Palm Ave', line2: null, city: 'Venice', state: 'FL', zip: '34285' },
      active: true,
    },
    notificationPrefs: {},
    preferences: {},
    healthScore: {},
    invoices: [], cards: [], paymentMethodConsents: [], contracts: [], photos: [],
    customerDiscounts: [], complianceRecords: [], nutrientLedger: {}, services: [],
    payments: [], scheduled: [], upcomingScheduled: [], accountProperties: [], annualPrepayTerms: [],
    addressNeighbors,
  };
}

const HUSBAND = {
  id: 'husband', firstName: 'John', lastName: 'Doe', phone: '(941) 555-0102',
  pipelineStage: 'new_lead', matchedVia: 'primary',
  address: { line1: '123 Palm Ave', line2: null, city: 'Venice', state: 'FL', zip: '34285' },
};
const TENANT = {
  id: 'tenant', firstName: 'Pat', lastName: 'Renter', phone: null,
  pipelineStage: 'active_customer', matchedVia: 'property',
  address: { line1: '123 Palm Ave', line2: 'Unit B', city: 'Venice', state: 'FL', zip: '34285' },
};

function stubFetch(detail) {
  vi.stubGlobal('fetch', vi.fn((url) => {
    const path = String(url);
    if (path.endsWith('/admin/payers')) return response({ payers: [] });
    if (path.endsWith('/admin/customers/wife/timeline')) return response({ timeline: [] });
    if (path.endsWith('/admin/customers/wife')) return response(detail);
    return response({});
  }));
}

describe('Customer360ProfileV2 — Others at this address', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('waves_admin_token', 'test-token');
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lists every neighbour and opens one through onSelectCustomer', async () => {
    stubFetch(customerDetail([HUSBAND, TENANT]));
    const onSelectCustomer = vi.fn();
    render(<Customer360ProfileV2 customerId="wife" onClose={vi.fn()} onSelectCustomer={onSelectCustomer} />);

    const block = await screen.findByTestId('address-neighbors');
    expect(block).toHaveTextContent('Others at this address');
    expect(block).toHaveTextContent('John Doe');
    expect(block).toHaveTextContent('(941) 555-0102');
    expect(block).toHaveTextContent('Pat Renter');
    expect(block).toHaveTextContent('Unit B · secondary property');

    fireEvent.click(screen.getByRole('button', { name: /Pat Renter/ }));
    expect(onSelectCustomer).toHaveBeenCalledWith('tenant');
  });

  it('falls back to a deep link when no onSelectCustomer is wired', async () => {
    stubFetch(customerDetail([HUSBAND]));
    render(<Customer360ProfileV2 customerId="wife" onClose={vi.fn()} />);

    const link = await screen.findByRole('link', { name: /John Doe/ });
    expect(link).toHaveAttribute('href', '/admin/customers?customerId=husband');
  });

  it('renders no block when nobody else is at the address', async () => {
    stubFetch(customerDetail([]));
    render(<Customer360ProfileV2 customerId="wife" onClose={vi.fn()} />);

    expect(await screen.findAllByText('Jane Doe')).not.toHaveLength(0);
    expect(screen.queryByTestId('address-neighbors')).not.toBeInTheDocument();
  });
});
