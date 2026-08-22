// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Customer360ProfileV2, { CancelSignupModal, RefundPaymentModal } from './Customer360ProfileV2';

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

  it('shows the account-owner appointment-SMS box CHECKED when no preference is stored', async () => {
    // Opt-OUT semantics (20260725000001): an absent preference means the
    // account holder IS included, so a strict `=== true` here would render the
    // box unchecked while the send path actually texts them.
    vi.stubGlobal('fetch', vi.fn((url) => {
      const path = String(url);
      if (path.endsWith('/admin/payers')) return response({ payers: [] });
      if (path.endsWith('/admin/customers/customer-a/timeline')) return response({ timeline: [] });
      if (path.endsWith('/admin/customers/customer-a')) return response(customerDetail('customer-a', 'Avery'));
      return response({});
    }));

    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
    expect(await screen.findAllByText('Avery Customer')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Comms' }));

    const box = await screen.findByRole('checkbox', {
      name: /Also send appointment SMS to the account owner/i,
    });
    expect(box).toBeChecked();

    // Same for the service-report sibling (20260725000003) — 3 real accounts
    // were receiving none of their own reports under the old opt-in default.
    const reportBox = screen.getByRole('checkbox', {
      name: /Also email service reports to the account owner/i,
    });
    expect(reportBox).toBeChecked();

    // Captions must describe the new default, not the retired opt-in behavior.
    expect(screen.getAllByText(/On by default/i).length).toBeGreaterThanOrEqual(2);
  });

  it('flags partially refunded payments in overview Recent Transactions', async () => {
    // A partial refund must not render like an untouched paid row — the
    // gross amount would read as fully collected while Lifetime Rev drops.
    const detail = customerDetail('customer-a', 'Avery');
    detail.payments = [{
      id: 'pay-1', amount: '100.00', refund_amount: '40.00', refund_status: 'partial',
      status: 'paid', processor: 'stripe', card_brand: 'VISA', last_four: '4242',
      payment_date: '2026-08-01',
    }];
    vi.stubGlobal('fetch', vi.fn((url) => {
      const path = String(url);
      if (path.endsWith('/admin/payers')) return response({ payers: [] });
      if (path.endsWith('/admin/customers/customer-a/timeline')) return response({ timeline: [] });
      if (path.endsWith('/admin/customers/customer-a')) return response(detail);
      return response({});
    }));

    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
    expect(await screen.findByText('$40.00 refunded')).toBeInTheDocument();
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
    expect(screen.queryAllByText('Avery Customer')).toHaveLength(0);
    expect(screen.queryByText('Edit customer')).not.toBeInTheDocument();
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

  describe('RefundPaymentModal', () => {
    const stripePayment = (overrides = {}) => ({
      id: 'pay-1',
      amount: '202.00',
      refund_amount: null,
      refund_status: null,
      status: 'paid',
      processor: 'stripe',
      card_brand: 'MASTERCARD',
      last_four: '9564',
      payment_date: '2026-08-21',
      ...overrides,
    });

    it('posts the entered partial amount and reports success', async () => {
      const fetchMock = vi.fn(() => response({ id: 'pay-1', refund_amount: 50 }));
      vi.stubGlobal('fetch', fetchMock);
      const onDone = vi.fn().mockResolvedValue();

      render(
        <RefundPaymentModal
          customer={{ id: 'customer-a', firstName: 'Avery', lastName: 'Customer' }}
          payment={stripePayment()}
          onClose={vi.fn()}
          onDone={onDone}
        />,
      );

      // Defaults to the full remaining balance.
      const input = screen.getByLabelText('Refund amount');
      expect(input).toHaveValue(202);

      fireEvent.change(input, { target: { value: '50.00' } });
      fireEvent.click(screen.getByRole('button', { name: 'Refund $50.00' }));

      expect(await screen.findByText(/Refund issued:/)).toBeInTheDocument();
      expect(screen.getByText('$50.00')).toBeInTheDocument();
      expect(onDone).toHaveBeenCalledTimes(1);

      const post = fetchMock.mock.calls.find(([, opts]) => opts?.method === 'POST');
      expect(post[0]).toContain('/admin/customers/customer-a/refund');
      expect(JSON.parse(post[1].body)).toEqual({
        paymentId: 'pay-1',
        amount: 50,
        reason: 'requested_by_customer',
      });
    });

    it('reports the attempt-specific gross even when a concurrent refund inflated the cumulative total', async () => {
      // Entering $50 on a surcharged payment issues $50 + the prorated
      // surcharge share; the success state must report what THIS attempt
      // issued (refund_issued_amount). The cumulative refund_amount here
      // includes a concurrent $20 refund that landed mid-request — a
      // snapshot diff would wrongly report $71.50.
      vi.stubGlobal('fetch', vi.fn(() => response({
        id: 'pay-1', refund_amount: '71.50', refund_issued_amount: '51.50',
      })));

      render(
        <RefundPaymentModal
          customer={{ id: 'customer-a', firstName: 'Avery', lastName: 'Customer' }}
          payment={stripePayment({ surcharge_amount_cents: 600 })}
          onClose={vi.fn()}
          onDone={vi.fn().mockResolvedValue()}
        />,
      );

      fireEvent.change(screen.getByLabelText('Refund amount'), { target: { value: '50.00' } });
      fireEvent.click(screen.getByRole('button', { name: 'Refund $50.00' }));

      expect(await screen.findByText(/Refund issued:/)).toBeInTheDocument();
      expect(screen.getByText('$51.50')).toBeInTheDocument();
      expect(screen.getByText(/includes the returned card-surcharge share/)).toBeInTheDocument();
    });

    it('caps the entry at the remaining BASE balance on a surcharged payment', async () => {
      // The entered amount is base dollars and the server grosses it up by
      // the surcharge share, capped at the gross remaining — so on a
      // $102.90 charge ($100 base + $2.90 surcharge) an entry of $102 would
      // say "Refund $102.00" while actually fully refunding $102.90. The
      // cap and default must be the remaining base.
      const fetchMock = vi.fn(() => response({}));
      vi.stubGlobal('fetch', fetchMock);

      render(
        <RefundPaymentModal
          customer={{ id: 'customer-a', firstName: 'Avery', lastName: 'Customer' }}
          payment={stripePayment({ amount: '102.90', surcharge_amount_cents: 290 })}
          onClose={vi.fn()}
          onDone={vi.fn()}
        />,
      );

      const input = screen.getByLabelText('Refund amount');
      expect(input).toHaveValue(100);
      expect(screen.getByText(/The \$2\.90 card-surcharge share is returned automatically/)).toBeInTheDocument();

      fireEvent.change(input, { target: { value: '102.00' } });
      expect(screen.getByText(/Enter an amount between \$0\.01 and \$100\.00/)).toBeInTheDocument();
      const confirmButton = screen.getByRole('button', { name: 'Refund' });
      expect(confirmButton).toBeDisabled();
      fireEvent.click(confirmButton);
      expect(fetchMock.mock.calls.some(([, opts]) => opts?.method === 'POST')).toBe(false);
    });

    it('caps the entry at the remaining balance of a partially refunded payment', async () => {
      const fetchMock = vi.fn(() => response({}));
      vi.stubGlobal('fetch', fetchMock);

      render(
        <RefundPaymentModal
          customer={{ id: 'customer-a', firstName: 'Avery', lastName: 'Customer' }}
          // App path stamps Stripe's own status on partials — 'succeeded',
          // not 'partial' — so the remaining math can't key off refund_status.
          payment={stripePayment({ refund_amount: '50.00', refund_status: 'succeeded' })}
          onClose={vi.fn()}
          onDone={vi.fn()}
        />,
      );

      const input = screen.getByLabelText('Refund amount');
      expect(input).toHaveValue(152);

      fireEvent.change(input, { target: { value: '200.00' } });
      expect(screen.getByText(/Enter an amount between \$0\.01 and \$152\.00/)).toBeInTheDocument();
      const confirmButton = screen.getByRole('button', { name: 'Refund' });
      expect(confirmButton).toBeDisabled();
      fireEvent.click(confirmButton);
      expect(fetchMock.mock.calls.some(([, opts]) => opts?.method === 'POST')).toBe(false);
    });

    it('keeps the server rejection visible without closing the modal', async () => {
      vi.stubGlobal('fetch', vi.fn(() => response({ error: 'Payment is already fully refunded' }, 400)));
      const onClose = vi.fn();

      render(
        <RefundPaymentModal
          customer={{ id: 'customer-a', firstName: 'Avery', lastName: 'Customer' }}
          payment={stripePayment()}
          onClose={onClose}
          onDone={vi.fn()}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Refund $202.00' }));
      expect(await screen.findByText(/already fully refunded/)).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
      // Still re-attemptable after the error.
      expect(screen.getByRole('button', { name: 'Refund $202.00' })).toBeEnabled();
    });

    it('swallows Escape while a refund is in flight so the profile-level handler cannot unmount it', async () => {
      const pending = deferred();
      vi.stubGlobal('fetch', vi.fn(() => pending.promise));
      // Stand-in for the profile-level window keydown handler that closes
      // the whole Customer 360 on Escape unconditionally.
      const profileEsc = vi.fn();
      const profileHandler = (e) => { if (e.key === 'Escape') profileEsc(); };
      window.addEventListener('keydown', profileHandler);
      try {
        render(
          <RefundPaymentModal
            customer={{ id: 'customer-a', firstName: 'Avery', lastName: 'Customer' }}
            payment={stripePayment()}
            onClose={vi.fn()}
            onDone={vi.fn().mockResolvedValue()}
          />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Refund $202.00' }));
        fireEvent.keyDown(document.body, { key: 'Escape' });
        expect(profileEsc).not.toHaveBeenCalled();

        await act(async () => {
          pending.resolve(new Response(JSON.stringify({ id: 'pay-1', refund_issued_amount: '202.00' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }));
          await pending.promise;
        });
        expect(await screen.findByText(/Refund issued:/)).toBeInTheDocument();

        fireEvent.keyDown(document.body, { key: 'Escape' });
        expect(profileEsc).toHaveBeenCalledTimes(1);
      } finally {
        window.removeEventListener('keydown', profileHandler);
      }
    });

    it('surfaces a failed refresh after a successful refund', async () => {
      vi.stubGlobal('fetch', vi.fn(() => response({ id: 'pay-1' })));
      const onDone = vi.fn().mockRejectedValue(new Error('Refresh unavailable'));

      render(
        <RefundPaymentModal
          customer={{ id: 'customer-a', firstName: 'Avery', lastName: 'Customer' }}
          payment={stripePayment()}
          onClose={vi.fn()}
          onDone={onDone}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Refund $202.00' }));
      expect(await screen.findByText(/The refund went through, but the customer profile could not refresh: Refresh unavailable/))
        .toBeInTheDocument();
      expect(onDone).toHaveBeenCalledTimes(1);
    });
  });
});
