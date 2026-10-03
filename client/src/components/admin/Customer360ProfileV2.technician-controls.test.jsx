// @vitest-environment jsdom
// Technician allow-list (owner 2026-10-02): the call bridge and the customer
// requests queue are owner-only routes, so a technician's customer profile
// offers neither a Call button nor the requests panel. Admins keep both.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import Customer360ProfileV2 from './Customer360ProfileV2';

vi.mock('./StickyActionBar', async (importOriginal) => ({
  ...await importOriginal(),
  CustomerActionBar: () => null,
}));
vi.mock('./AuthenticatedCallAudio', () => ({ default: () => null }));
vi.mock('./CustomerRequestsPanel', () => ({ default: () => <div data-testid="customer-requests-panel" /> }));
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

function customerDetail() {
  return {
    customer: {
      id: 'customer-a',
      firstName: 'Avery',
      lastName: 'Customer',
      phone: '+15555550103',
      address: { line1: '1 Main St', city: 'Naples', state: 'FL', zip: '34102' },
      active: true,
    },
    notificationPrefs: {},
    preferences: {},
    healthScore: {},
    invoices: [], cards: [], paymentMethodConsents: [], contracts: [], photos: [],
    customerDiscounts: [], complianceRecords: [], nutrientLedger: {}, services: [],
    payments: [], scheduled: [], upcomingScheduled: [], accountProperties: [], annualPrepayTerms: [],
  };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('waves_admin_token', 'test-token');
  vi.stubGlobal('fetch', vi.fn((url) => {
    const path = String(url).split('?')[0];
    if (path.endsWith('/customer-a')) return response(customerDetail());
    return response({ comms: [], commitments: [], timeline: [], enabled: true, has_more: false });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(role, props) {
  localStorage.setItem('waves_admin_user', JSON.stringify({ role }));
  render(<MemoryRouter><Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} {...props} /></MemoryRouter>);
}

describe.each([
  ['overlay', {}],
  ['embedded workspace', { embedded: true }],
])('customer profile (%s)', (_name, props) => {
  it('hides the Call button and the requests panel from a technician', async () => {
    mount('technician', props);
    await screen.findAllByText(/Avery/);
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/customer-a'))).toBe(true));
    expect(screen.queryByRole('button', { name: /^Call$/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId('customer-requests-panel')).not.toBeInTheDocument();
  });

  it('keeps the Call button and the requests panel for an admin', async () => {
    mount('admin', props);
    await screen.findAllByText(/Avery/);
    expect(await screen.findByTestId('customer-requests-panel')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Call$/ })).toBeInTheDocument();
  });
});
