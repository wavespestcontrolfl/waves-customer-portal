// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import Customer360ProfileV2, { CancelSignupModal, RefundPaymentModal } from './Customer360ProfileV2';
import { IntelligenceBarPageDataProvider, useIntelligenceBarActions } from '../../hooks/useIntelligenceBarPageData';

vi.mock('./StickyActionBar', async (importOriginal) => ({
  ...await importOriginal(),
  CustomerActionBar: () => null,
}));
vi.mock('./AuthenticatedCallAudio', () => ({
  default: ({ recordingId }) => <div data-testid="call-recording" data-recording-id={recordingId} />,
}));
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

function MutationTrigger({ customerId }) {
  const { notifyMutation } = useIntelligenceBarActions();
  return <button onClick={() => notifyMutation({ id: 'saved-operation', customer_id: customerId })}>Saved fixture</button>;
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

  it('opens the shell bar and refreshes only a matching customer after its verified property change', async () => {
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
    let name = 'Before';
    const fetchMock = vi.fn(url => String(url).endsWith('/customer-a')
      ? response(customerDetail('customer-a', name)) : response({ timeline: [], payers: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const open = vi.fn();
    const tree = id => <IntelligenceBarPageDataProvider open={open}>
      <MutationTrigger customerId={id} /><Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />
    </IntelligenceBarPageDataProvider>;
    const view = render(tree('customer-b'));
    await screen.findAllByText('Before Customer');
    fireEvent.click(screen.getByRole('button', { name: 'Intelligence Bar', exact: true }));
    expect(open).toHaveBeenCalledOnce();
    const reads = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/customer-a')).length;
    const before = reads(); name = 'After';
    fireEvent.click(screen.getByRole('button', { name: 'Saved fixture' }));
    expect(reads()).toBe(before);
    view.rerender(tree('customer-a'));
    fireEvent.click(screen.getByRole('button', { name: 'Saved fixture' }));
    await screen.findAllByText('After Customer');
    expect(reads()).toBe(before + 1);
  });

  it.each([
    [{ status: 'processing', amount: '102.90' }, 'Payment $102.90 is processing. Settlement is pending.'],
    [{ status: 'paid', amount: '102.90' }, 'Payment $102.90 completed'],
    [{ status: 'unknown' }, 'Payment status is not confirmed. Check payment history before trying again.'],
    [undefined, 'Payment status is not confirmed. Check payment history before trying again.'],
  ])('announces the returned charge outcome without assuming settlement: %j', async (payment, expected) => {
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
    const detail = customerDetail('customer-a', 'Avery');
    Object.assign(detail.customer, { billingMode: 'monthly_membership', monthlyRate: 100 });
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.stubGlobal('fetch', vi.fn((url) => {
      const path = String(url);
      if (path.endsWith('/customer-a')) return response(detail);
      if (path.endsWith('/charge-now')) return response({ success: true, payment });
      if (path.endsWith('/autopay-state')) return response({ state: 'active' });
      return response({});
    }));
    const { container } = render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} embedded />);
    await screen.findByRole('heading', { name: 'Avery Customer' });
    container.querySelector('.c360-panel').scrollTo = vi.fn();
    fireEvent.click(screen.getByRole('tab', { name: 'Billing', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Charge now ($100.00)' }));
    expect(await screen.findByText(expected)).toHaveAttribute('role', 'status');
    expect(screen.queryByText('Charged $100.00 successfully')).not.toBeInTheDocument();
    const charges = fetch.mock.calls.filter(([url]) => String(url).endsWith('/charge-now'));
    expect(charges).toHaveLength(1);
    expect(charges[0][1]).toMatchObject({ method: 'POST', body: '{}' });
  });

  it('announces a failed charge and clears the error after a processing retry', async () => {
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
    const detail = customerDetail('customer-a', 'Avery');
    Object.assign(detail.customer, { billingMode: 'monthly_membership', monthlyRate: 100 });
    let failed = true;
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.stubGlobal('fetch', vi.fn((url) => {
      const path = String(url);
      if (path.endsWith('/customer-a')) return response(detail);
      if (path.endsWith('/charge-now')) return failed
        ? response({ error: 'Synthetic decline' }, 502)
        : response({ success: true, payment: { status: 'processing', amount: '100.00' } });
      return response({});
    }));
    const { container } = render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} embedded />);
    await screen.findByRole('heading', { name: 'Avery Customer' });
    container.querySelector('.c360-panel').scrollTo = vi.fn();
    fireEvent.click(screen.getByRole('tab', { name: 'Billing', exact: true }));
    const charge = screen.getByRole('button', { name: 'Charge now ($100.00)' });
    fireEvent.click(charge);
    expect(await screen.findByText('Synthetic decline')).toHaveAttribute('role', 'alert');
    failed = false;
    fireEvent.click(charge);
    expect(await screen.findByText('Payment $100.00 is processing. Settlement is pending.')).toHaveAttribute('role', 'status');
    expect(screen.queryByText('Synthetic decline')).not.toBeInTheDocument();
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/charge-now'))).toHaveLength(2);
  });

  it('preserves technician texting when admin-only conversation history is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn((url) => {
      const path = String(url);
      if (path.endsWith('/customer-a')) {
        const detail = customerDetail('customer-a', 'Avery');
        detail.customer.phone = '+19415550100';
        return response(detail);
      }
      if (path.endsWith('/comms')) return response({ error: 'Admin access required' }, 403);
      if (path.endsWith('/communications/sms')) return response({ sent: true, providerMessageId: 'SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
      return response({});
    }));
    const { container } = render(<MemoryRouter><Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} embedded /></MemoryRouter>);
    await screen.findByRole('heading', { name: 'Avery Customer' });
    container.querySelector('.c360-panel').scrollTo = vi.fn();
    fireEvent.click(screen.getByRole('button', { name: 'Message', exact: true }));
    const field = await screen.findByRole('textbox', { name: 'Text message' }, { timeout: 5000 });
    fireEvent.change(field, { target: { value: 'Service update' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send', exact: true }));
    await waitFor(() => expect(field).toHaveValue(''));
    const sends = fetch.mock.calls.filter(([url]) => String(url).endsWith('/communications/sms'));
    expect(sends).toHaveLength(1);
    expect(JSON.parse(sends[0][1].body)).toMatchObject({ customerId: 'customer-a', to: '+19415550100', body: 'Service update' });
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/timeline'))).toBe(false);
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/unread-count'))).toBe(false);
  });

  it('refreshes the profile and timeline once after an admin message is sent', async () => {
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
    let sent = false;
    const fetchMock = vi.fn(url => {
      const path = String(url);
      if (path.endsWith('/customer-a')) {
        const detail = customerDetail('customer-a', sent ? 'Updated' : 'Avery');
        detail.customer.phone = '+19415550100';
        return response(detail);
      }
      if (path.endsWith('/timeline')) return response({ timeline: [{ type: 'interaction', title: sent ? 'Saved message activity' : 'Existing activity', date: '2024-08-01T16:00:00Z' }] });
      if (path.endsWith('/communications/sms')) {
        sent = true;
        return response({ sent: true, providerMessageId: 'SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
      }
      return response({ comms: [] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<MemoryRouter><Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} embedded /></MemoryRouter>);
    await screen.findByRole('heading', { name: 'Avery Customer' });
    container.querySelector('.c360-panel').scrollTo = vi.fn();
    fireEvent.click(screen.getByRole('button', { name: 'Message', exact: true }));
    const field = await screen.findByRole('textbox', { name: 'Text message' });
    fireEvent.change(field, { target: { value: 'Fixture service update' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send', exact: true }));
    await waitFor(() => expect(field).toHaveValue(''));
    await screen.findByRole('heading', { name: 'Updated Customer' });
    fireEvent.click(screen.getByRole('button', { name: 'Back to customer' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Activity', exact: true }));
    expect(await screen.findByText('Saved message activity')).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/timeline'))).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/customer-a'))).toHaveLength(2);
  });

  it('shows this customer\'s unread count beside Message and clears it after reading', async () => {
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    let read = false;
    const readScope = { conversationIds: ['conversation-a', 'older-conversation-a'], readBefore: '2024-08-01T17:00:00Z' };
    vi.stubGlobal('fetch', vi.fn((url) => {
      const path = String(url);
      if (path.includes('/unread-count?customerId=customer-a')) return response({ conversations: read ? 0 : 2, messages: 5 });
      if (path.endsWith('/customer-a')) {
        const detail = customerDetail('customer-a', 'Avery');
        detail.customer.phone = '+19415550100';
        return response(detail);
      }
      if (path.endsWith('/comms')) return response({ readScope, comms: [{ id: 'message-a', conversationId: 'conversation-a', channel: 'sms', direction: 'inbound', body: 'Service update', contactPhone: '+19415550100', createdAt: '2024-08-01T16:00:00Z', isRead: read }] });
      if (path.endsWith('/messages/read')) { read = true; return response({ success: true }); }
      return response({});
    }));
    const { container } = render(<MemoryRouter><Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} embedded /></MemoryRouter>);
    await screen.findByLabelText('2 unread conversations');
    expect(read).toBe(false);
    container.querySelector('.c360-panel').scrollTo = vi.fn();
    fireEvent.click(screen.getByRole('button', { name: /Message.*2 unread conversations/ }));
    await screen.findByRole('textbox', { name: 'Text message' }, { timeout: 5000 });
    await waitFor(() => expect(screen.queryByLabelText('2 unread conversations')).not.toBeInTheDocument());
    expect(read).toBe(true);
    const readCall = fetch.mock.calls.find(([url]) => String(url).endsWith('/messages/read'));
    expect(JSON.parse(readCall[1].body)).toEqual({ messageIds: ['message-a'], ...readScope });
    const draft = screen.getByRole('textbox', { name: 'Text message' });
    fireEvent.change(draft, { target: { value: 'Keep this draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Back to customer' }));
    expect(screen.queryByRole('dialog', { name: 'Conversation with Avery Customer' })).not.toBeInTheDocument();
    expect(screen.getByRole('tabpanel', { name: 'Summary' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Message', exact: true }));
    expect(screen.getByRole('textbox', { name: 'Text message' })).toHaveValue('Keep this draft');
    expect(screen.getByRole('heading', { name: 'Avery Customer' })).toBeInTheDocument();
  });

  it('does not request or offer admin-only history to a technician', async () => {
    vi.stubGlobal('fetch', vi.fn((url) => String(url).endsWith('/customer-a')
      ? response(customerDetail('customer-a', 'Avery'))
      : response({ error: 'Forbidden' }, 403)));
    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
    expect(await screen.findAllByText('Avery Customer')).toHaveLength(2);
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/timeline'))).toBe(false);
    expect(screen.queryByText('Could not load customer history.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry customer history' })).not.toBeInTheDocument();
    expect(screen.queryByText('Timeline (0)')).not.toBeInTheDocument();
  });

  it.each(['initial load', 'earlier refresh'])(
    'keeps the newest saved profile when the %s finishes late', async (pendingKind) => {
      localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
      const older = deferred();
      const newer = deferred();
      let reads = 0;
      vi.stubGlobal('fetch', vi.fn(url => {
        if (!String(url).endsWith('/customer-a')) return response({ timeline: [], payers: [] });
        reads += 1;
        if (pendingKind === 'earlier refresh' && reads === 1) return response(customerDetail('customer-a', 'Before'));
        return reads === (pendingKind === 'initial load' ? 1 : 2) ? older.promise : newer.promise;
      }));
      render(<IntelligenceBarPageDataProvider>
        <MutationTrigger customerId="customer-a" /><Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />
      </IntelligenceBarPageDataProvider>);
      if (pendingKind === 'earlier refresh') {
        await screen.findAllByText('Before Customer');
        fireEvent.click(screen.getByRole('button', { name: 'Saved fixture' }));
      }
      fireEvent.click(screen.getByRole('button', { name: 'Saved fixture' }));
      await act(async () => {
        newer.resolve(await response(customerDetail('customer-a', 'Newest')));
      });
      await screen.findAllByText('Newest Customer');
      await act(async () => {
        older.resolve(await response(customerDetail('customer-a', 'Stale')));
      });
      expect(screen.queryByText('Stale Customer')).not.toBeInTheDocument();
      expect(screen.getAllByText('Newest Customer')).toHaveLength(2);
    },
  );

  it('uses complete server balances instead of summing recent invoices, and tracks recipient changes', async () => {
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
    const detail = customerDetail('customer-a', 'Avery');
    detail.customer.billingMode = 'per_application';
    detail.customer.monthlyRate = 0;
    detail.customer.annualValue = 1130;
    detail.customer.email = 'account@example.invalid';
    detail.invoices = [{ id: 'recent-invoice', status: 'sent', amount_due: 125 }];
    detail.billingSummary = { complete: true, openBalance: 1125, overdueBalance: 0, overdueCount: 0, asOf: '2024-07-01' };
    detail.notificationPrefs = { billing_contact_name: 'Accounts', billing_email: 'billing@example.invalid' };
    vi.stubGlobal('fetch', vi.fn((url) => String(url).endsWith('/customer-a') ? response(detail) : response({})));
    const { container } = render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} embedded />);
    await screen.findByRole('heading', { name: 'Avery Customer' });
    container.querySelector('.c360-panel').scrollTo = vi.fn();
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
    expect(screen.queryByText(/overdue invoice/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Billing', exact: true }));
    expect(screen.getByText('$1,125.00')).toBeInTheDocument();
    expect(screen.getByText('Per application', { exact: true })).toBeInTheDocument();
    expect(screen.queryByText('Monthly Rate', { exact: true })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Details', exact: true }));
    expect(screen.getByRole('button', { name: 'Recipients saved' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Billing recipient email'), { target: { value: 'new-billing@example.invalid' } });
    expect(screen.getByRole('button', { name: 'Save recipients' })).toBeEnabled();
  });

  it('renders the workspace in its parent and keeps older activity available', async () => {
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
    const timeline = Array.from({ length: 46 }, (_, index) => ({ type: 'interaction', title: `History entry ${index + 1}`, date: '2024-07-02T16:00:00Z' }));
    vi.stubGlobal('fetch', vi.fn((url) => {
      const path = String(url);
      if (path.endsWith('/timeline')) return response({ timeline });
      if (path.endsWith('/customer-a')) return response(customerDetail('customer-a', 'Avery'));
      return response({});
    }));
    const onClose = vi.fn();
    const { container } = render(<Customer360ProfileV2 customerId="customer-a" onClose={onClose} embedded />);
    const name = await screen.findByRole('heading', { name: 'Avery Customer' });
    expect(container).toContainElement(name);
    expect(screen.queryByText('History entry 46')).not.toBeInTheDocument();
    container.querySelector('.c360-panel').scrollTo = vi.fn();
    fireEvent.click(screen.getByRole('tab', { name: 'Activity', exact: true }));
    expect(screen.getByText('History entry 46')).toBeInTheDocument();
    expect(screen.getAllByRole('region', { name: 'Customer activity history' })).toHaveLength(1);
    const estimateLink = screen.getByRole('link', { name: 'Create estimate', exact: true });
    const estimateParams = new URL(estimateLink.href).searchParams;
    expect(estimateParams.get('customerId')).toBe('customer-a');
    expect(estimateParams.get('customerName')).toBe('Avery Customer');
    expect(estimateParams.get('address')).toContain('Unit 4');
    fireEvent.click(screen.getByRole('button', { name: 'More customer actions' }));
    expect(screen.getByRole('link', { name: 'Book appointment', exact: true })).toHaveAttribute('href', '/admin/schedule?customer=customer-a');
    expect(screen.getByRole('link', { name: 'Invoices', exact: true })).toHaveAttribute('href', '/admin/invoices?customer=customer-a');
    fireEvent.click(screen.getByRole('button', { name: 'Edit customer' }));
    expect(screen.getByRole('dialog', { name: 'Edit customer' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit customer' })).not.toBeInTheDocument());
    expect(name).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps workspace history and admin actions unavailable to technicians', async () => {
    vi.stubGlobal('fetch', vi.fn((url) => String(url).endsWith('/customer-a')
      ? response(customerDetail('customer-a', 'Avery'))
      : response({})));
    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} initialTab="billing" embedded />);
    await screen.findByRole('heading', { name: 'Avery Customer' });
    expect(screen.queryByRole('link', { name: 'Create estimate', exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText('Balance could not be verified.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Why this status?'));
    expect(screen.queryByRole('button', { name: 'View billing', exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Book appointment', exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Billing', exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole('tabpanel', { name: 'Summary', exact: true })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^(Manage invoices|All invoices)$/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More customer actions' }));
    expect(screen.queryByRole('link', { name: 'Book appointment', exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Invoices', exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit customer' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Prepay invoice' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Customer activity history' })).not.toBeInTheDocument();
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/timeline'))).toBe(false);
  });

  it('shows SMS follow-up to technicians in the workspace Activity section without the admin history', async () => {
    vi.stubGlobal('fetch', vi.fn((url) => {
      const path = String(url);
      if (path.endsWith('/customer-a')) return response(customerDetail('customer-a', 'Avery'));
      if (path.includes('/commitments/sms?customer_id=customer-a')) {
        return response({ commitments: [{ id: 'sms-1', party: 'waves', description: 'Send the estimate', overdue: true }], enabled: true, has_more: false });
      }
      return response({});
    }));
    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} initialTab="comms" embedded />);
    await screen.findByRole('heading', { name: 'Avery Customer' });
    expect(await screen.findByTestId('sms-followup-summary')).toHaveTextContent('Send the estimate');
    expect(screen.getByRole('button', { name: 'Mark done' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Customer activity history' })).not.toBeInTheDocument();
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/timeline'))).toBe(false);
  });

  it.each([{ events: [] }, { events: [{ type: 'interaction', title: 'Recovered fixture note' }] }])(
    'distinguishes unavailable history from successful empty/nonempty history after retry (%j)',
    async ({ events }) => {
      localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
      let failTimeline = true;
      vi.stubGlobal('fetch', vi.fn((url) => {
        const path = String(url);
        if (path.endsWith('/timeline')) return failTimeline
          ? response({ error: 'Unavailable' }, 503)
          : response({ timeline: events });
        if (path.endsWith('/customer-a')) return failTimeline ? response(customerDetail('customer-a', 'Avery')) : response({ error: 'Profile unavailable' }, 503);
        return response({});
      }));
      render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
      expect(await screen.findByRole('alert')).toHaveTextContent('Could not load customer history.');
      expect(screen.getAllByText('Avery Customer')).toHaveLength(2);
      expect(screen.queryByText('No timeline events')).not.toBeInTheDocument();
      expect(screen.queryByText('Timeline (0)')).not.toBeInTheDocument();
      failTimeline = false;
      fireEvent.click(screen.getByRole('button', { name: 'Retry customer history' }));
      expect(await screen.findByText(events.length ? 'Recovered fixture note' : 'No timeline events')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByText(`Timeline (${events.length})`)).toBeInTheDocument();
      expect(screen.getAllByText('Avery Customer')).toHaveLength(2);
      expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/customer-a'))).toHaveLength(1);
    },
  );

  it('ignores history from an old customer when switching records during retry', async () => {
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
    const oldHistory = deferred();
    let attempts = 0;
    vi.stubGlobal('fetch', vi.fn((url) => {
      const path = String(url);
      if (path.endsWith('/customer-a/timeline')) {
        attempts += 1;
        return attempts === 1 ? response({ error: 'Unavailable' }, 503) : oldHistory.promise;
      }
      if (path.endsWith('/customer-b/timeline')) return response({ timeline: [{ title: 'Beta fixture note' }] });
      if (path.endsWith('/customer-a')) return response(customerDetail('customer-a', 'Avery'));
      if (path.endsWith('/customer-b')) return response(customerDetail('customer-b', 'Blake'));
      return response({});
    }));
    const { rerender } = render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry customer history' }));
    await waitFor(() => expect(attempts).toBe(2));
    rerender(<Customer360ProfileV2 customerId="customer-b" onClose={vi.fn()} />);
    expect(await screen.findByText('Beta fixture note')).toBeInTheDocument();
    await act(async () => {
      oldHistory.resolve(new Response(JSON.stringify({ timeline: [{ title: 'Stale Alpha note' }] })));
      await oldHistory.promise;
    });
    expect(screen.queryByText('Stale Alpha note')).not.toBeInTheDocument();
    expect(screen.getByText('Beta fixture note')).toBeInTheDocument();
    expect(screen.getAllByText('Blake Customer')).toHaveLength(2);
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

  it.each([
    ['appointmentNotifyPrimary', 'appointment_notify_primary', /Also send appointment SMS to the account owner/, true],
    ['serviceReportNotifyPrimary', 'service_report_notify_primary', /Also email service reports to the account owner/, true],
    ['serviceReportNotifyBilling', 'service_report_notify_billing', /Also email service reports to the billing recipient/, false],
    ['autoFlipEnRoute', 'auto_flip_en_route', /Auto-flip en route SMS/, true],
  ])('preserves the default, patch keys, and failed-save rollback for %s', async (apiKey, storedKey, label, defaultValue) => {
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
    const save = deferred();
    vi.stubGlobal('fetch', vi.fn((url, options) => {
      const path = String(url);
      if (path.endsWith('/notification-prefs') && options.method === 'PUT') return save.promise;
      if (path.endsWith('/customer-a')) return response(customerDetail('customer-a', 'Avery'));
      return response({});
    }));
    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} initialTab="comms" />);
    const checkbox = await screen.findByRole('checkbox', { name: label });
    expect(checkbox.checked).toBe(defaultValue);
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(!defaultValue);
    const call = fetch.mock.calls.find(([url]) => String(url).endsWith('/notification-prefs'));
    expect(JSON.parse(call[1].body)).toEqual({ [apiKey]: !defaultValue, [storedKey]: !defaultValue });
    await act(async () => { save.resolve(await response({ error: 'Preference update unavailable' }, 503)); });
    expect(await screen.findByText('Preference update unavailable')).toBeInTheDocument();
    expect(checkbox.checked).toBe(defaultValue);
  });

  it('deduplicates a new payer and assigns the returned payer to this customer', async () => {
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
    const detail = customerDetail('customer-a', 'Avery');
    vi.stubGlobal('fetch', vi.fn((url, options) => {
      const path = String(url);
      if (path.endsWith('/payers') && options.method === 'POST') {
        return response({ payer: { id: 'payer-fixture', display_name: 'Fixture accounts' }, deduped: true });
      }
      if (path.endsWith('/customer-a') && options.method === 'PUT') {
        detail.customer.payerId = JSON.parse(options.body).payerId;
        return response({ success: true });
      }
      if (path.endsWith('/customer-a')) return response(detail);
      return response({});
    }));
    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} initialTab="comms" />);
    fireEvent.change(await screen.findByRole('combobox', { name: 'Default bill-to' }), { target: { value: '__new__' } });
    fireEvent.change(screen.getByLabelText('Payer name *'), { target: { value: ' Fixture accounts ' } });
    fireEvent.change(screen.getByLabelText('Invoice email (AP)'), { target: { value: ' ACCOUNTS@EXAMPLE.INVALID ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create & select' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Default bill-to' })).toHaveValue('payer-fixture'));
    expect(screen.getByText(/Matched existing payer/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Payer name *')).not.toBeInTheDocument();
    const create = fetch.mock.calls.find(([url, options]) => String(url).endsWith('/payers') && options.method === 'POST');
    expect(JSON.parse(create[1].body)).toEqual({ displayName: 'Fixture accounts', apEmail: 'accounts@example.invalid', dedupeByEmail: true });
    const assign = fetch.mock.calls.find(([url, options]) => String(url).endsWith('/customer-a') && options.method === 'PUT');
    expect(JSON.parse(assign[1].body)).toEqual({ payerId: 'payer-fixture' });
  });

  it('renders SMS and call summaries with only available or legacy recording ids', async () => {
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
    const comms = [
      { id: 'sms-fixture', channel: 'sms', direction: 'inbound', body: 'SMS fixture body' },
      { id: 'call-fixture', channel: 'voice', direction: 'inbound', aiSummary: 'Available call summary', durationSeconds: 65, media: [{ type: 'recording', available: true, sid: 'recording-fixture' }] },
      { id: 'unavailable-fixture', channel: 'voice', direction: 'outbound', body: 'Unavailable call summary', media: [{ type: 'recording', available: false, sid: 'recording-hidden' }] },
      { id: 'legacy-fixture', channel: 'voice', direction: 'outbound', body: 'Legacy call summary', recordingSid: 'recording-legacy' },
    ];
    vi.stubGlobal('fetch', vi.fn((url) => {
      const path = String(url);
      if (path.endsWith('/comms')) return response({ comms });
      if (path.endsWith('/customer-a')) return response(customerDetail('customer-a', 'Avery'));
      return response({});
    }));
    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} initialTab="comms" />);
    expect(await screen.findByText('SMS fixture body')).toBeInTheDocument();
    expect(screen.getByText('Available call summary')).toBeInTheDocument();
    expect(screen.getByText('Unavailable call summary')).toBeInTheDocument();
    expect(screen.getByText('Legacy call summary')).toBeInTheDocument();
    expect(screen.getByText('1m 5s')).toBeInTheDocument();
    expect(screen.getAllByTestId('call-recording').map(node => node.dataset.recordingId)).toEqual(['recording-legacy', 'recording-fixture']);
  });

  it('discards an old conversation response after switching customers', async () => {
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
    const oldComms = deferred();
    vi.stubGlobal('fetch', vi.fn((url) => {
      const path = String(url);
      if (path.endsWith('/customer-a/comms')) return oldComms.promise;
      if (path.endsWith('/customer-b/comms')) return response({ comms: [{ id: 'new-message', channel: 'sms', direction: 'inbound', body: 'Current customer message' }] });
      if (path.endsWith('/customer-a')) return response(customerDetail('customer-a', 'Avery'));
      if (path.endsWith('/customer-b')) return response(customerDetail('customer-b', 'Blair'));
      return response({});
    }));
    const { rerender } = render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} initialTab="comms" />);
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/customer-a/comms'))).toBe(true));
    rerender(<Customer360ProfileV2 customerId="customer-b" onClose={vi.fn()} initialTab="comms" />);
    expect(await screen.findByText('Current customer message')).toBeInTheDocument();
    await act(async () => {
      oldComms.resolve(await response({ comms: [{ id: 'old-message', channel: 'sms', direction: 'inbound', body: 'Old customer message' }] }));
    });
    expect(screen.queryByText('Old customer message')).not.toBeInTheDocument();
    expect(screen.getByText('Current customer message')).toBeInTheDocument();
  });

  it('renders the service-addresses panel for admins only (technicians never call the requireAdmin properties endpoint)', async () => {
    const fetchFor = () => vi.fn((url) => {
      const path = String(url);
      if (path.endsWith('/admin/payers')) return response({ payers: [] });
      if (path.endsWith('/admin/customers/customer-a/timeline')) return response({ timeline: [] });
      if (path.endsWith('/admin/customers/customer-a/properties')) return response({ properties: [] });
      if (path.endsWith('/admin/customers/customer-a')) return response(customerDetail('customer-a', 'Avery'));
      return response({});
    });

    // Technician (beforeEach role): no panel, no properties request.
    const techFetch = fetchFor();
    vi.stubGlobal('fetch', techFetch);
    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
    expect(await screen.findAllByText('Avery Customer')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Property' }));
    await screen.findByText('Property Details');
    expect(screen.queryByTestId('customer-properties-panel')).not.toBeInTheDocument();
    expect(techFetch.mock.calls.some(([u]) => String(u).endsWith('/properties'))).toBe(false);
    cleanup();

    // Admin: panel renders and loads the list.
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
    const adminFetch = fetchFor();
    vi.stubGlobal('fetch', adminFetch);
    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
    expect(await screen.findAllByText('Avery Customer')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Property' }));
    expect(await screen.findByTestId('customer-properties-panel')).toBeInTheDocument();
    await waitFor(() => expect(adminFetch.mock.calls.some(([u]) => String(u).endsWith('/properties'))).toBe(true));
  });

  it('refetches the service-addresses panel after ANY profile save, even with an unchanged address', async () => {
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
    const fetchMock = vi.fn((url, options = {}) => {
      const path = String(url);
      if (path.endsWith('/admin/payers')) return response({ payers: [] });
      if (path.endsWith('/admin/customers/customer-a/timeline')) return response({ timeline: [] });
      if (path.endsWith('/admin/customers/customer-a/properties')) return response({ properties: [] });
      if (path.endsWith('/admin/customers/customer-a') && options.method === 'PUT') return response({ success: true });
      if (path.endsWith('/admin/customers/customer-a')) return response(customerDetail('customer-a', 'Avery'));
      return response({});
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
    expect(await screen.findAllByText('Avery Customer')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Property' }));
    await screen.findByTestId('customer-properties-panel');
    const propertyFetches = () => fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/properties')).length;
    await waitFor(() => expect(propertyFetches()).toBe(1));

    // Edit → Save with nothing changed (address tuple identical).
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    await screen.findByText('Edit customer');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, o]) => o?.method === 'PUT')).toBe(true));
    await waitFor(() => expect(propertyFetches()).toBe(2));
  });

  it('saves a city correction without resubmitting unchanged shared contacts or billing settings', async () => {
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
    const detail = customerDetail('customer-a', 'Avery');
    detail.customer.address.city = 'Duette';
    detail.customer.email = 'shared@example.test';
    detail.customer.phone = '+12025550123';
    detail.customer.monthlyRate = 0;
    let savedPayload;
    vi.stubGlobal('fetch', vi.fn((url, options = {}) => {
      const path = String(url);
      if (path.endsWith('/admin/payers')) return response({ payers: [] });
      if (path.endsWith('/admin/customers/customer-a') && options.method === 'PUT') {
        savedPayload = JSON.parse(options.body);
        if ('email' in savedPayload || 'phone' in savedPayload) {
          return response({ error: 'contact_exists_on_another_account' }, 409);
        }
        detail.customer.address.city = savedPayload.city;
        return response({ success: true });
      }
      if (path.endsWith('/admin/customers/customer-a')) return response(detail);
      return response({});
    }));
    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
    await screen.findAllByText('Avery Customer');
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    fireEvent.change(screen.getByDisplayValue('Duette'), { target: { value: 'Parrish' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByText('Edit customer')).not.toBeInTheDocument());
    expect(savedPayload).toEqual({
      addressLine1: 'customer-a Main St', addressLine2: 'Unit 4', city: 'Parrish', state: 'FL', zip: '34102',
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    expect(screen.getByDisplayValue('Parrish')).toBeInTheDocument();
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

  it('does not let a completed A save start a profile refresh after switching to B', async () => {
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
    const savedA = deferred();
    const loadedB = deferred();
    vi.stubGlobal('fetch', vi.fn((url, options = {}) => {
      const path = String(url);
      if (path.endsWith('/customer-a') && options.method === 'PUT') return savedA.promise;
      if (path.endsWith('/customer-a')) return response(customerDetail('customer-a', 'Avery'));
      if (path.endsWith('/customer-b')) return loadedB.promise;
      return response({ timeline: [], payers: [] });
    }));
    const view = render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
    await screen.findAllByText('Avery Customer');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByDisplayValue('Naples'), { target: { value: 'Parrish' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    view.rerender(<Customer360ProfileV2 customerId="customer-b" onClose={vi.fn()} />);
    await act(async () => { savedA.resolve(await response({ success: true })); });
    await act(async () => { loadedB.resolve(await response(customerDetail('customer-b', 'Blair'))); });
    await screen.findAllByText('Blair Customer');
    expect(screen.queryByText('Avery Customer')).not.toBeInTheDocument();
    expect(fetch.mock.calls.filter(([url, options]) => String(url).endsWith('/customer-a') && !options.method)).toHaveLength(1);
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

    it('swallows Escape while a refund is in flight, then owns Escape itself so the profile never hears it', async () => {
      const pending = deferred();
      vi.stubGlobal('fetch', vi.fn(() => pending.promise));
      // Stand-in for the profile-level window keydown handler. The modal owns
      // Escape while open (useModalFocus stops it at the document), so the
      // profile's handler must never fire from inside a sub-modal — neither
      // mid-request (swallowed) nor afterwards (closes the modal only).
      const profileEsc = vi.fn();
      const profileHandler = (e) => { if (e.key === 'Escape') profileEsc(); };
      const onClose = vi.fn();
      window.addEventListener('keydown', profileHandler);
      try {
        render(
          <RefundPaymentModal
            customer={{ id: 'customer-a', firstName: 'Avery', lastName: 'Customer' }}
            payment={stripePayment()}
            onClose={onClose}
            onDone={vi.fn().mockResolvedValue()}
          />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Refund $202.00' }));
        fireEvent.keyDown(document.body, { key: 'Escape' });
        expect(profileEsc).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();

        await act(async () => {
          pending.resolve(new Response(JSON.stringify({ id: 'pay-1', refund_issued_amount: '202.00' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }));
          await pending.promise;
        });
        expect(await screen.findByText(/Refund issued:/)).toBeInTheDocument();

        fireEvent.keyDown(document.body, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(profileEsc).not.toHaveBeenCalled();
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
