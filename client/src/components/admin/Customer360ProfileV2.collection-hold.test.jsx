// @vitest-environment jsdom
/**
 * Customer 360 — the collections dispute-hold notice and its Release control (B10).
 *
 * A dispute hold stops every automatic card charge. The office needs to see it
 * and lift it once the dispute is resolved; without a client caller the hold
 * would stand forever.
 */
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

function customerDetail({ servicePausedAt = null, servicePausedOn = null, servicePauseReason = null } = {}) {
  return {
    customer: {
      id: 'customer-a',
      firstName: 'Avery',
      lastName: 'Customer',
      address: { line1: '1 Main St', city: 'Bradenton', state: 'FL', zip: '34205' },
      active: true,
      servicePausedAt,
      // ET calendar date from the server — what the banner renders.
      servicePausedOn,
      servicePauseReason,
    },
    notificationPrefs: {}, preferences: {}, healthScore: {},
    invoices: [], cards: [], paymentMethodConsents: [], contracts: [], photos: [],
    customerDiscounts: [], complianceRecords: [], nutrientLedger: {}, services: [],
    payments: [], scheduled: [], upcomingScheduled: [], accountProperties: [],
    annualPrepayTerms: [],
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const HOLD = {
  flag: 'collection_hold',
  reason: 'dispute: says the lawn visit was never done',
  created_by: 'voice-agent',
  created_at: '2026-09-28T15:00:00Z',
  stops_charges: true,
};

function setRole(role) {
  localStorage.clear();
  localStorage.setItem('waves_admin_token', 'test-token');
  localStorage.setItem('waves_admin_user', JSON.stringify({ role }));
}

function installFetch({ holds = [HOLD], release } = {}) {
  const fetchMock = vi.fn((url, options) => {
    const path = String(url);
    if (path.endsWith('/admin/payers')) return response({ payers: [] });
    if (path.split('?')[0].endsWith('/timeline')) return response({ timeline: [] });
    if (path.endsWith('/collection-holds/release')) {
      return release ? release(options) : response({ released: 1 });
    }
    if (path.endsWith('/collection-holds')) return response({ holds });
    if (path.endsWith('/admin/customers/customer-a')) return response(customerDetail());
    return response({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const releaseCalls = (fetchMock) => fetchMock.mock.calls.filter(
  ([u, o]) => String(u).endsWith('/admin/customers/customer-a/collection-holds/release') && o?.method === 'POST',
);

describe('Customer 360 collections dispute-hold notice', () => {
  beforeEach(() => setRole('admin'));

  it('shows the notice with the reason and date for a dispute hold', async () => {
    installFetch();
    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);

    expect(await screen.findByText(/Billing on hold — customer disputed a bill on a collections call/i)).toBeInTheDocument();
    expect(screen.getByText(/says the lawn visit was never done/i)).toBeInTheDocument();
    expect(screen.getByText(/Sep 28, 2026/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Release hold/i })).toBeInTheDocument();
  });

  it('is hidden when the customer has no hold, or only an outreach-only hold', async () => {
    installFetch({ holds: [] });
    const { unmount } = render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
    expect(await screen.findAllByText('Avery Customer')).not.toHaveLength(0);
    expect(screen.queryByText(/Billing on hold/i)).not.toBeInTheDocument();
    unmount();

    installFetch({ holds: [{ ...HOLD, reason: 'wrong-number report', stops_charges: false }] });
    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
    expect(await screen.findAllByText('Avery Customer')).not.toHaveLength(0);
    expect(screen.queryByText(/Billing on hold/i)).not.toBeInTheDocument();
  });

  it('asks for confirmation, explains the release, and does nothing on cancel', async () => {
    const fetchMock = installFetch();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /Release hold/i }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0][0]).toMatch(/automatic charges/i);
    expect(confirmSpy.mock.calls[0][0]).toMatch(/invoice that was held back will be sent/i);
    expect(releaseCalls(fetchMock)).toHaveLength(0);
    expect(screen.getByText(/Billing on hold/i)).toBeInTheDocument();
  });

  it('releases on confirm, hides the notice, and says what happens next', async () => {
    const fetchMock = installFetch();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /Release hold/i }));

    expect(await screen.findByText(/Billing hold released/i)).toBeInTheDocument();
    expect(screen.queryByText(/Billing on hold — customer disputed/i)).not.toBeInTheDocument();
    expect(releaseCalls(fetchMock)).toHaveLength(1);
  });

  it('shows the server error and keeps the hold when the release fails', async () => {
    installFetch({ release: () => response({ error: 'Could not release the hold' }, 500) });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /Release hold/i }));

    expect(await screen.findByText(/Could not release the hold/i)).toBeInTheDocument();
    expect(screen.getByText(/Billing on hold — customer disputed/i)).toBeInTheDocument();
  });

  it('turns a 403 into a plain admin-only message', async () => {
    installFetch({ release: () => response({ error: 'Admin access required' }, 403) });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /Release hold/i }));

    expect(await screen.findByText(/Only an admin can release a billing hold/i)).toBeInTheDocument();
  });

  it('never reads or shows the hold for a non-admin viewer', async () => {
    setRole('technician');
    const fetchMock = installFetch();
    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
    expect(await screen.findAllByText('Avery Customer')).not.toHaveLength(0);

    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/collection-holds'))).toBe(false);
    expect(screen.queryByText(/Billing on hold/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Release hold/i })).not.toBeInTheDocument();
  });
});
