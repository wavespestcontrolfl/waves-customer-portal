// @vitest-environment jsdom
// Customer 360 sub-modals own their own Escape and backdrop clicks, and DATE
// columns render the calendar day the server stored (UI audit 2026-09-07:
// C360-02 / C360-03 / C360-06).
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

function customerDetail() {
  return {
    customer: {
      id: 'customer-a',
      firstName: 'Avery',
      lastName: 'Customer',
      address: { line1: '1 Main St', line2: null, city: 'Naples', state: 'FL', zip: '34102' },
      active: true,
    },
    notificationPrefs: {},
    preferences: {},
    healthScore: {},
    invoices: [], cards: [], paymentMethodConsents: [], contracts: [], photos: [],
    customerDiscounts: [], complianceRecords: [], nutrientLedger: {},
    // A Postgres DATE column serialised by a UTC server: midnight UTC on the 7th.
    services: [{ id: 'svc-1', service_type: 'Quarterly Pest Control', service_date: '2026-09-07T00:00:00.000Z', status: 'completed', price: 99 }],
    payments: [], scheduled: [], upcomingScheduled: [], accountProperties: [], annualPrepayTerms: [],
  };
}

async function openProfile() {
  vi.stubGlobal('fetch', vi.fn((url) => (String(url).endsWith('/customer-a')
    ? response(customerDetail())
    : response({}))));
  const onClose = vi.fn();
  render(<Customer360ProfileV2 customerId="customer-a" onClose={onClose} />);
  await screen.findAllByText('Avery Customer');
  return onClose;
}

describe('Customer360ProfileV2 sub-modals', () => {
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

  it('Escape closes only the open Edit customer modal — the profile stays', async () => {
    const onClose = await openProfile();
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Edit customer' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit customer' })).not.toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getAllByText('Avery Customer').length).toBeGreaterThan(0);

    // With no sub-modal open, Escape closes the profile as before.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a click on a sub-modal backdrop closes that modal only, never the profile behind it', async () => {
    const onClose = await openProfile();
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Edit customer' });

    // The overlay root (backdrop) is the dialog panel's parent.
    fireEvent.click(dialog.parentElement);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit customer' })).not.toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders a DATE column on the calendar day the server stored, not a day early', async () => {
    await openProfile();
    // The tab strip comes first in the DOM; a timeline filter chip shares the name.
    fireEvent.click(screen.getAllByRole('button', { name: 'Services' })[0]);
    expect(await screen.findByText(/Sep 7, 2026/)).toBeInTheDocument();
    expect(screen.queryByText(/Sep 6, 2026/)).not.toBeInTheDocument();
  });
});
