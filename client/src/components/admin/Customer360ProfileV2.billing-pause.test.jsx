// @vitest-environment jsdom
/**
 * Customer 360 — the billing-pause banner and its Resume control.
 *
 * billing-cron sets customers.service_paused_at when autopay's 3-retry ladder
 * exhausts and then skips that customer forever. Before this, the state was
 * invisible on the customer record and nothing could clear it, so a paused
 * customer's dues stopped permanently and the fix was a hand-edited row.
 */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
});

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('waves_admin_token', 'test-token');
  localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
});

describe('Customer 360 billing-pause banner', () => {
  it('stays hidden for a customer who is not paused', async () => {
    vi.stubGlobal('fetch', vi.fn((url) => {
      const path = String(url);
      if (path.endsWith('/admin/payers')) return response({ payers: [] });
      if (path.endsWith('/timeline')) return response({ timeline: [] });
      if (path.endsWith('/admin/customers/customer-a')) return response(customerDetail());
      return response({});
    }));

    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
    expect(await screen.findAllByText('Avery Customer')).not.toHaveLength(0);

    expect(screen.queryByText(/Billing paused since/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Resume billing/i })).not.toBeInTheDocument();
  });

  it('shows why dues stopped, that visits are unaffected, and that nothing is back-billed', async () => {
    vi.stubGlobal('fetch', vi.fn((url) => {
      const path = String(url);
      if (path.endsWith('/admin/payers')) return response({ payers: [] });
      if (path.endsWith('/timeline')) return response({ timeline: [] });
      if (path.endsWith('/admin/customers/customer-a')) {
        return response(customerDetail({
          servicePausedAt: '2026-05-02T23:30:00Z', servicePausedOn: '2026-05-02',
          servicePauseReason: 'autopay_final_failure',
        }));
      }
      return response({});
    }));

    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);

    expect(await screen.findByText(/Billing paused since May 2, 2026/i)).toBeInTheDocument();
    // The three facts that make this actionable rather than alarming.
    expect(screen.getByText(/autopay failed three times/i)).toBeInTheDocument();
    expect(screen.getByText(/Visits are unaffected/i)).toBeInTheDocument();
    expect(screen.getByText(/not\s+back-billed/i)).toBeInTheDocument();
  });

  it('resumes billing and clears the banner', async () => {
    let paused = true;
    const fetchMock = vi.fn((url, options) => {
      const path = String(url);
      if (path.endsWith('/admin/payers')) return response({ payers: [] });
      if (path.endsWith('/timeline')) return response({ timeline: [] });
      if (path.endsWith('/resume-service')) {
        expect(options?.method).toBe('POST');
        paused = false;
        return response({ success: true, resumed: true });
      }
      if (path.endsWith('/admin/customers/customer-a')) {
        return response(customerDetail(paused
          ? { servicePausedAt: '2026-05-02T23:30:00Z', servicePausedOn: '2026-05-02', servicePauseReason: 'autopay_final_failure' }
          : {}));
      }
      return response({});
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
    await screen.findByText(/Billing paused since May 2, 2026/i);

    fireEvent.click(screen.getByRole('button', { name: /Resume billing/i }));

    await waitFor(() => {
      expect(screen.queryByText(/Billing paused since/i)).not.toBeInTheDocument();
    });
    expect(fetchMock.mock.calls.some(
      ([u, o]) => String(u).endsWith('/admin/customers/customer-a/resume-service') && o?.method === 'POST',
    )).toBe(true);
  });

  it('surfaces a failed resume instead of pretending it worked', async () => {
    vi.stubGlobal('fetch', vi.fn((url) => {
      const path = String(url);
      if (path.endsWith('/admin/payers')) return response({ payers: [] });
      if (path.endsWith('/timeline')) return response({ timeline: [] });
      if (path.endsWith('/resume-service')) return response({ error: 'Customer not found' }, 404);
      if (path.endsWith('/admin/customers/customer-a')) {
        return response(customerDetail({
          servicePausedAt: '2026-05-02T23:30:00Z', servicePausedOn: '2026-05-02',
          servicePauseReason: 'autopay_final_failure',
        }));
      }
      return response({});
    }));

    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
    await screen.findByText(/Billing paused since May 2, 2026/i);

    fireEvent.click(screen.getByRole('button', { name: /Resume billing/i }));

    expect(await screen.findByText(/Customer not found/i)).toBeInTheDocument();
    // The pause is still real, so the banner must stay.
    expect(screen.getByText(/Billing paused since May 2, 2026/i)).toBeInTheDocument();
  });
});
