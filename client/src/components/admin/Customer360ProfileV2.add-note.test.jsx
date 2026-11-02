// @vitest-environment jsdom
// Customer 360 has no "Add note" action (owner 2026-11-02, UI audit F0065). The
// header pill and the ⋯ menu item both opened the Comms tab, whose text box
// sends the customer an SMS on Enter, so a staff note could reach the customer
// as a text. Every remaining ⋯ item is admin-only, so a technician gets no ⋯
// button instead of an empty menu.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

async function mount(role, props) {
  localStorage.setItem('waves_admin_user', JSON.stringify({ role }));
  render(<MemoryRouter><Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} {...props} /></MemoryRouter>);
  await screen.findAllByText(/Avery/);
}

// DOM queries on purpose: the mobile bar is shown or hidden by a CSS rule, and
// role queries would skip it when jsdom applies that rule.
const moreButton = (label) => document.querySelector(`[aria-label="${label}"]`);

describe.each([
  ['overlay', {}],
  ['embedded workspace', { embedded: true }],
])('customer profile (%s)', (_name, props) => {
  it.each(['admin', 'technician'])('offers %s no Add note action, with each ⋯ menu open', async (role) => {
    await mount(role, props);
    expect(screen.queryByText(/add note/i)).toBeNull();
    for (const label of ['More', 'More customer actions']) {
      const button = moreButton(label);
      if (!button) continue;
      fireEvent.click(button);
      expect(screen.queryByText(/add note/i)).toBeNull();
      fireEvent.click(button);
    }
  });
});

describe('mobile ⋯ menu (overlay)', () => {
  it('keeps the admin items for an admin', async () => {
    await mount('admin', {});
    fireEvent.click(moreButton('More'));
    expect(screen.getByText('Edit customer')).toBeInTheDocument();
  });

  it('is not rendered for a technician, whose menu would be empty', async () => {
    await mount('technician', {});
    expect(moreButton('More')).toBeNull();
  });
});
