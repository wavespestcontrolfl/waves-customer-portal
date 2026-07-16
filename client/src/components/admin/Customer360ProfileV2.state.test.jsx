// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Customer360ProfileV2, { CancelSignupModal } from './Customer360ProfileV2';

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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function response(body, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }));
}

function customerDetail(id, firstName) {
  return {
    customer: {
      id,
      firstName,
      lastName: 'Customer',
      address: { line1: `${id} Main St`, line2: 'Unit 4', city: 'Naples', state: 'FL', zip: '34102' },
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

describe('Customer360ProfileV2 profile state', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('waves_admin_token', 'test-token');
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'technician' }));
  });

  it('never renders stale customer actions when a customer switch fails', async () => {
    let failSecond = false;
    vi.stubGlobal('fetch', vi.fn((url) => {
      const path = String(url);
      if (path.endsWith('/admin/payers')) return response({ payers: [] });
      if (path.endsWith('/admin/customers/customer-a/timeline')) return response({ timeline: [] });
      if (path.endsWith('/admin/customers/customer-b/timeline')) return response({ timeline: [] });
      if (path.endsWith('/admin/customers/customer-a')) return response(customerDetail('customer-a', 'Avery'));
      if (path.endsWith('/admin/customers/customer-b')) {
        return failSecond
          ? response({ error: 'Profile unavailable' }, 503)
          : response(customerDetail('customer-b', 'Blair'));
      }
      return response({});
    }));

    const { rerender } = render(
      <Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />,
    );
    expect(await screen.findAllByText('Avery Customer')).toHaveLength(2);
    expect(screen.getByRole('switch')).toBeDisabled();

    failSecond = true;
    rerender(<Customer360ProfileV2 customerId="customer-b" onClose={vi.fn()} />);

    expect(await screen.findByText('Failed to load customer')).toBeInTheDocument();
    expect(screen.queryAllByText('Avery Customer')).toHaveLength(0);
    expect(screen.queryByRole('link', { name: 'Book Appt' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();

    failSecond = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findAllByText('Blair Customer')).toHaveLength(2);
  });

  it('ignores a late response from the previously selected customer', async () => {
    const first = deferred();
    vi.stubGlobal('fetch', vi.fn((url) => {
      const path = String(url);
      if (path.endsWith('/admin/payers')) return response({ payers: [] });
      if (path.endsWith('/timeline')) return response({ timeline: [] });
      if (path.endsWith('/admin/customers/customer-a')) return first.promise;
      if (path.endsWith('/admin/customers/customer-b')) return response(customerDetail('customer-b', 'Blair'));
      return response({});
    }));

    const { rerender } = render(
      <Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />,
    );
    rerender(<Customer360ProfileV2 customerId="customer-b" onClose={vi.fn()} />);
    expect(await screen.findAllByText('Blair Customer')).toHaveLength(2);

    await act(async () => {
      first.resolve(new Response(JSON.stringify(customerDetail('customer-a', 'Avery')), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
      await first.promise;
    });

    expect(screen.getAllByText('Blair Customer')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Book Appt' })).toHaveAttribute(
      'href',
      '/admin/schedule?customer=customer-b',
    );
    expect(screen.queryAllByText('Avery Customer')).toHaveLength(0);
  });

  it('closes customer-scoped edit state when navigation selects another customer', async () => {
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
    vi.stubGlobal('fetch', vi.fn((url) => {
      const path = String(url);
      if (path.endsWith('/admin/payers')) return response({ payers: [] });
      if (path.endsWith('/timeline')) return response({ timeline: [] });
      if (path.endsWith('/admin/customers/customer-a')) return response(customerDetail('customer-a', 'Avery'));
      if (path.endsWith('/admin/customers/customer-b')) return response(customerDetail('customer-b', 'Blair'));
      return response({});
    }));

    const { rerender } = render(
      <Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />,
    );
    await screen.findAllByText('Avery Customer');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByText('Edit customer')).toBeInTheDocument();

    rerender(<Customer360ProfileV2 customerId="customer-b" onClose={vi.fn()} />);
    expect(await screen.findAllByText('Blair Customer')).toHaveLength(2);
    expect(screen.queryByText('Edit customer')).not.toBeInTheDocument();
  });

  it('surfaces a failed refresh after a successful signup cancellation', async () => {
    const onDone = vi.fn().mockRejectedValue(new Error('Refresh unavailable'));
    vi.stubGlobal('fetch', vi.fn((url, options = {}) => {
      if (options.method === 'POST') {
        return response({
          invoicesVoided: [], visitsCancelled: 0, refunded: 25, email: { ok: true },
        });
      }
      return response({
        eligible: true,
        blockers: [],
        invoices: [],
        terms: [],
        visits: [],
        refundTotal: 25,
      });
    }));

    render(
      <CancelSignupModal
        customer={{ id: 'customer-a' }}
        onClose={vi.fn()}
        onDone={onDone}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel & refund $25.00 now' }));
    expect(await screen.findByText(/Cancellation succeeded, but the customer profile could not refresh: Refresh unavailable/))
      .toBeInTheDocument();
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
