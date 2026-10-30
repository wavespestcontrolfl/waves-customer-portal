// @vitest-environment jsdom
// Customers audit 2026-10-29, findings C04-C09 for the shared customer overlay:
// billing-arrangement refresh, credit refresh, save-vs-refresh failures,
// autopay read errors, dialog semantics and focus, and the review switch name.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import Customer360ProfileV2 from './Customer360ProfileV2';

vi.mock('./StickyActionBar', async (importOriginal) => ({
  ...await importOriginal(),
  CustomerActionBar: () => null,
}));
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

function detail(overrides = {}) {
  return {
    customer: {
      id: 'customer-a',
      firstName: 'Avery',
      lastName: 'Customer',
      address: { line1: '1 Main St', line2: null, city: 'Naples', state: 'FL', zip: '34102' },
      active: true,
      billingMode: 'per_application',
      ...overrides,
    },
    notificationPrefs: {},
    preferences: {},
    healthScore: {},
    invoices: [], cards: [], paymentMethodConsents: [], contracts: [], photos: [],
    customerDiscounts: [], complianceRecords: [], nutrientLedger: {}, services: [],
    payments: [], scheduled: [], upcomingScheduled: [], accountProperties: [], annualPrepayTerms: [],
  };
}

// One router for the fixture. `state` lets a test change what the server
// returns, and `calls` records every request for write-count assertions.
function installFetch(state = {}) {
  const calls = [];
  const fetchMock = vi.fn((url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const path = String(url).split('?')[0];
    calls.push({ method, path, body: init.body });
    if (path.endsWith('/customer-a')) {
      if (method === 'PUT') return response({ success: true });
      if (state.failProfileGet) return response({ error: 'Profile unavailable' }, 503);
      return response(detail(state.customer));
    }
    if (path.endsWith('/autopay-state')) {
      state.autopayReads = (state.autopayReads || 0) + 1;
      if (state.autopayFails) return response({ error: 'Autopay unavailable' }, 503);
      return response({ state: 'active', next_charge_date: '2026-11-01', billing_day: 1 });
    }
    if (path.endsWith('/credits')) {
      if (method === 'POST') return response({ success: true });
      return response({ balance: 0, ledger: [] });
    }
    return response({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, state };
}

const profileReads = (calls) => calls.filter((c) => c.method === 'GET' && c.path.endsWith('/customer-a')).length;
const profileWrites = (calls) => calls.filter((c) => c.method === 'PUT' && c.path.endsWith('/customer-a'));

async function openOverlay(initialTab = 'billing') {
  const onClose = vi.fn();
  render(<Customer360ProfileV2 customerId="customer-a" onClose={onClose} initialTab={initialTab} />);
  await screen.findAllByText('Avery Customer');
  return onClose;
}

describe('Customer360ProfileV2 audit fixes (C04-C09)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('waves_admin_token', 'test-token');
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
    vi.spyOn(window, 'matchMedia').mockImplementation((q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  });

  it('updates the Billing summary after the billing arrangement saves (C04)', async () => {
    const { calls, state } = installFetch({ customer: {} });
    await openOverlay();
    const summary = screen.getByText('Billing arrangement').parentElement;
    expect(within(summary).getByText('Per application')).toBeInTheDocument();

    state.customer = { billingMode: 'one_time' };
    fireEvent.change(await screen.findByLabelText('How this customer pays'), { target: { value: 'one_time' } });

    expect(await screen.findByText('Saved')).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByText('Billing arrangement').parentElement).getByText('One-time')).toBeInTheDocument());
    expect(profileWrites(calls)).toHaveLength(1);
  });

  it('says the billing arrangement was saved when only the follow-up refresh fails (C04)', async () => {
    const { calls, state } = installFetch();
    await openOverlay();
    state.failProfileGet = true;
    fireEvent.change(await screen.findByLabelText('How this customer pays'), { target: { value: 'one_time' } });

    expect((await screen.findAllByText('The change was saved. Refresh this record to see it.')).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Save failed|HTTP 503/)).not.toBeInTheDocument();
    expect(profileWrites(calls)).toHaveLength(1);
  });

  it('re-reads the profile after account credit is added (C05)', async () => {
    const { calls } = installFetch();
    await openOverlay();
    fireEvent.click(await screen.findByRole('button', { name: 'Issue credit' }));
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '25' } });
    const before = profileReads(calls);
    fireEvent.click(screen.getByRole('button', { name: /^Add credit to / }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/credits'))).toBe(true));
    await waitFor(() => expect(profileReads(calls)).toBe(before + 1));
  });

  it('closes the edit form and says the change was saved when the refresh fails, with one write (C06)', async () => {
    const { calls, state } = installFetch();
    await openOverlay('overview');
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Edit customer' });
    const first = within(dialog).getByDisplayValue('Avery');
    fireEvent.change(first, { target: { value: 'Averi' } });
    state.failProfileGet = true;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit customer' })).not.toBeInTheDocument());
    expect(await screen.findByText('The change was saved. Refresh this record to see it.')).toBeInTheDocument();
    expect(profileWrites(calls)).toHaveLength(1);
  });

  it('shows could-not-read with Retry when autopay returns 503, and Retry recovers (C07)', async () => {
    const { state } = installFetch({ autopayFails: true });
    await openOverlay();
    expect(await screen.findByText("Couldn't read the auto-pay status.")).toBeInTheDocument();
    expect(screen.queryByText('Unknown')).not.toBeInTheDocument();

    state.autopayFails = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('active')).toBeInTheDocument();
    expect(screen.queryByText("Couldn't read the auto-pay status.")).not.toBeInTheDocument();
  });

  it('shows could-not-read when the autopay read cannot reach the server (C07)', async () => {
    installFetch();
    const original = global.fetch;
    vi.stubGlobal('fetch', vi.fn((url, init) => (String(url).endsWith('/autopay-state')
      ? Promise.reject(new TypeError('network down'))
      : original(url, init))));
    await openOverlay();
    expect(await screen.findByText("Couldn't read the auto-pay status.")).toBeInTheDocument();
  });

  it('keeps Unknown for an autopay read that returns no state (C07)', async () => {
    installFetch();
    const original = global.fetch;
    vi.stubGlobal('fetch', vi.fn((url, init) => (String(url).endsWith('/autopay-state')
      ? response({})
      : original(url, init))));
    await openOverlay();
    expect(await screen.findByText('unknown')).toBeInTheDocument();
    expect(screen.queryByText("Couldn't read the auto-pay status.")).not.toBeInTheDocument();
  });

  it('exposes the overlay as a named modal dialog and keeps Tab inside it (C08)', async () => {
    installFetch();
    const outside = document.createElement('button');
    outside.textContent = 'Background control';
    document.body.appendChild(outside);
    outside.focus();
    await openOverlay('overview');

    const dialog = screen.getByRole('dialog', { name: /Avery Customer/ });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    for (let i = 0; i < 80; i += 1) {
      fireEvent.keyDown(document.activeElement, { key: 'Tab' });
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    for (let i = 0; i < 80; i += 1) {
      fireEvent.keyDown(document.activeElement, { key: 'Tab', shiftKey: true });
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    outside.remove();
  });

  it('does not trap focus or add dialog semantics in the full-page workspace (C08)', async () => {
    installFetch();
    render(<MemoryRouter><Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} embedded /></MemoryRouter>);
    await screen.findByRole('heading', { name: 'Avery Customer' });
    expect(screen.queryByRole('dialog', { name: /Avery Customer/ })).not.toBeInTheDocument();
  });

  it('closes only the top nested dialog on Escape, then the overlay on the next Escape (C08)', async () => {
    installFetch();
    const onClose = await openOverlay('overview');
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    await screen.findByRole('dialog', { name: 'Edit customer' });

    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit customer' })).not.toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: /Avery Customer/ })).toBeInTheDocument();

    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders the shared overlay at the 14px comfortable density, including its dialogs (C10)', async () => {
    installFetch();
    await openOverlay('overview');
    const dialog = screen.getByRole('dialog', { name: /Avery Customer/ });
    expect(dialog.parentElement).toHaveAttribute('data-ui-density', 'comfortable');
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    const edit = await screen.findByRole('dialog', { name: 'Edit customer' });
    expect(edit.parentElement).toHaveAttribute('data-ui-density', 'comfortable');
  });

  it('gives the Google review switch the visible label and description as its name (C09)', async () => {
    installFetch();
    await openOverlay('overview');
    const toggle = await screen.findByRole('switch', { name: 'Already left a Google review' });
    expect(toggle).toHaveAccessibleDescription(/excluded from review-request/);
  });
});
