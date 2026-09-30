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
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Customer360ProfileV2 from './Customer360ProfileV2';

vi.mock('./StickyActionBar', () => ({ CustomerActionBar: () => null, customerEstimateHref: () => '#' }));
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

function customerDetail({ servicePausedAt = null, servicePausedOn = null, servicePauseReason = null, extra = {} } = {}) {
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
      ...extra,
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
  id: 'hold-1',
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

function installFetch({ holds = [HOLD], release, holdsResponse, detailExtra } = {}) {
  // holds may be a function so a test can change what the next read returns
  const currentHolds = () => (typeof holds === 'function' ? holds() : holds);
  const fetchMock = vi.fn((url, options) => {
    const path = String(url);
    if (path.endsWith('/admin/payers')) return response({ payers: [] });
    if (path.split('?')[0].endsWith('/timeline')) return response({ timeline: [] });
    if (path.endsWith('/collection-holds/release')) {
      return release ? release(options) : response({ released: 1 });
    }
    if (path.endsWith('/collection-holds')) return holdsResponse ? holdsResponse() : response({ holds: currentHolds() });
    if (path.endsWith('/charge-now')) return response({ success: true, payment: { status: 'paid', amount: '100.00' } });
    if (path.endsWith('/admin/customers/customer-a')) return response(customerDetail({ extra: detailExtra }));
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
    // the release names exactly the hold that was on screen
    expect(JSON.parse(releaseCalls(fetchMock)[0][1].body)).toEqual({ holdId: 'hold-1' });
  });

  it('releasing a dispute that sat on a wrong-number/wrong-party hold says the earlier hold stays, and re-reads the holds', async () => {
    let current = [HOLD];
    const fetchMock = installFetch({
      holds: () => current,
      release: () => {
        // server downgrades the shared row back to the fallback (still active)
        current = [{ ...HOLD, reason: 'wrong-party answer on billing follow-up call', stops_charges: false }];
        return response({
          released: 1,
          fallbackRestored: true,
          message: 'Dispute released; the earlier wrong-number/wrong-party hold stays.',
        });
      },
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /Release hold/i }));

    expect(await screen.findByText(/Dispute released; the earlier wrong-number\/wrong-party hold stays\./i)).toBeInTheDocument();
    // the dispute notice is gone (charging resumes) but the holds were re-read, not blanked
    expect(screen.queryByText(/Billing on hold — customer disputed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Billing hold released/i)).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/collection-holds'))).toHaveLength(2);
    expect(releaseCalls(fetchMock)).toHaveLength(1);
  });

  it('on a 409 (hold changed) shows the conflict inline, re-reads the holds, and releases nothing blind', async () => {
    let current = [HOLD];
    const fetchMock = installFetch({
      holds: () => current,
      release: () => {
        // another office session replaced the hold before this click landed
        current = [{ ...HOLD, id: 'hold-2', reason: 'dispute: second call' }];
        return response({ error: 'This hold changed — reload' }, 409);
      },
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /Release hold/i }));

    expect(await screen.findByText(/This hold changed — reload/i)).toBeInTheDocument();
    // re-fetched: the newer hold is now the one shown, and nothing was released
    expect(await screen.findByText(/second call/i)).toBeInTheDocument();
    expect(screen.queryByText(/Billing hold released/i)).not.toBeInTheDocument();
    expect(releaseCalls(fetchMock)).toHaveLength(1);
    expect(JSON.parse(releaseCalls(fetchMock)[0][1].body)).toEqual({ holdId: 'hold-1' });
  });

  it('on a 409 where the hold is now gone, the conflict message still shows', async () => {
    let current = [HOLD];
    installFetch({
      holds: () => current,
      release: () => {
        current = [];
        return response({ error: 'This hold changed — reload' }, 409);
      },
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /Release hold/i }));

    // the message first shows in the hold box, then moves out of it when the re-read finds no hold
    await waitFor(() => {
      expect(screen.queryByText(/Billing on hold — customer disputed/i)).not.toBeInTheDocument();
      expect(screen.getByText(/This hold changed — reload/i)).toBeInTheDocument();
    });
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
  describe('beside the manual Charge now control (billing tab, no billing summary)', () => {
    const MEMBER = { billingMode: 'monthly_membership', monthlyRate: 100 };
    const chargeNowCalls = (fetchMock) => fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/charge-now'));
    const openBilling = async () => {
      const utils = render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} initialTab="billing" />);
      const charge = await screen.findByRole('button', { name: /Charge now/i });
      return { ...utils, charge };
    };

    it('shows the hold next to Charge now and names it in the confirm, even though the billing summary is not on this tab', async () => {
      const fetchMock = installFetch({ detailExtra: MEMBER });
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
      const { charge } = await openBilling();

      expect(await screen.findByText(/A charge you make here goes past the hold/i)).toBeInTheDocument();
      // exactly one read of the hold for this customer, however many surfaces show it
      expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/collection-holds'))).toHaveLength(1);
      // Release lives in the summary only; this tab renders no second copy
      expect(screen.queryByRole('button', { name: /Release hold/i })).not.toBeInTheDocument();

      fireEvent.click(charge);
      expect(confirmSpy.mock.calls[0][0]).toMatch(/billing hold/i);
      expect(confirmSpy.mock.calls[0][0]).toMatch(/goes past the hold/i);
      expect(chargeNowCalls(fetchMock)).toHaveLength(0);
    });

    it('a failed hold read reads as UNKNOWN, not "no hold": warns beside Charge now and needs an extra confirm', async () => {
      const fetchMock = installFetch({ detailExtra: MEMBER, holdsResponse: () => response({ error: 'boom' }, 500) });
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
      const { charge } = await openBilling();

      expect(await screen.findByText(/Couldn't check for a billing hold — reload before charging/i)).toBeInTheDocument();

      fireEvent.click(charge);
      expect(confirmSpy).toHaveBeenCalledTimes(1);
      expect(confirmSpy.mock.calls[0][0]).toMatch(/Couldn't check for a billing hold/i);
      expect(chargeNowCalls(fetchMock)).toHaveLength(0);

      // an operator who confirms the extra warning can still charge
      confirmSpy.mockReturnValue(true);
      fireEvent.click(charge);
      await waitFor(() => expect(chargeNowCalls(fetchMock)).toHaveLength(1));
    });

    it('a network failure on the hold read is also unknown', async () => {
      installFetch({ detailExtra: MEMBER, holdsResponse: () => Promise.reject(new TypeError('network down')) });
      await openBilling();
      expect(await screen.findByText(/Couldn't check for a billing hold — reload before charging/i)).toBeInTheDocument();
    });

    it('with a verified no-hold the confirm is the ordinary one and no warning shows', async () => {
      const fetchMock = installFetch({ detailExtra: MEMBER, holds: [] });
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const { charge } = await openBilling();
      await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/collection-holds'))).toBe(true));
      await waitFor(() => expect(screen.queryByText(/Checking for a billing hold/i)).not.toBeInTheDocument());

      fireEvent.click(charge);
      expect(confirmSpy.mock.calls[0][0]).toBe('Charge Avery Customer $100.00 now?');
      expect(screen.queryByText(/goes past the hold/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/Couldn't check/i)).not.toBeInTheDocument();
    });

    it('the embedded billing tab shows the summary (with Release) alongside the charge warning when a hold is active', async () => {
      installFetch({ detailExtra: MEMBER });
      render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} initialTab="billing" embedded />);
      expect(await screen.findByRole('button', { name: /Release hold/i })).toBeInTheDocument();
      expect(await screen.findByText(/A charge you make here goes past the hold/i)).toBeInTheDocument();
    });
  });
});
