// @vitest-environment jsdom
// Technician Customer 360 dead ends (owner 2026-11-04, "the dead ends get fixed"): a technician's copy has no
// Billing or Contracts tab, no Invoice or Book link, a Text link that names the customer, a conversation read from
// the SMS log (texts only), and no block that states a stripped field as a fact. Admins keep every one of them.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    // A response that still carried the codes must not show them to a technician.
    preferences: { property_gate_code: '0000', neighborhood_gate_code: '1111', pet_details: 'Small dog' },
    healthScore: {},
    invoices: [], cards: [], paymentMethodConsents: [], contracts: [], photos: [],
    customerDiscounts: [], complianceRecords: [], nutrientLedger: {}, services: [],
    payments: [], scheduled: [], upcomingScheduled: [], accountProperties: [], annualPrepayTerms: [],
  };
}

const logMessage = {
  id: 'm1', conversationId: 'conv-1', twilioSid: 'SM1', direction: 'inbound', from: '+15555550103', to: '+15555550199',
  body: 'Please use the side door', status: 'received', messageType: 'general', customerId: 'customer-a',
  createdAt: '2026-11-03T15:00:00Z', media: [],
};

beforeEach(() => {
  Element.prototype.scrollTo = vi.fn();
  localStorage.clear();
  localStorage.setItem('waves_admin_token', 'test-token');
  vi.stubGlobal('fetch', vi.fn((url) => {
    const path = String(url).split('?')[0];
    if (path.endsWith('/customer-a')) return response(customerDetail());
    if (path.endsWith('/admin/communications/log')) return response({ messages: [logMessage], hasMore: false, nextPage: null });
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

const urls = () => fetch.mock.calls.map(([url]) => String(url));

describe('overlay tabs', () => {
  it('gives a technician no Billing or Contracts tab', async () => {
    mount('technician');
    await screen.findAllByText(/Avery/);
    expect(screen.getByRole('tab', { name: 'Services' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Billing' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Contracts' })).not.toBeInTheDocument();
  });

  it('keeps Billing and Contracts for an admin', async () => {
    mount('admin');
    await screen.findAllByText(/Avery/);
    expect(screen.getByRole('tab', { name: 'Billing' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Contracts' })).toBeInTheDocument();
  });

  it('opens a technician on Overview when it asks for Billing', async () => {
    mount('technician', { initialTab: 'billing' });
    await screen.findAllByText(/Avery/);
    expect(screen.getByRole('tab', { name: 'Overview', selected: true })).toBeInTheDocument();
  });
});

describe('overlay header links', () => {
  it('gives a technician no Book or Invoice link, and a Text link that names the customer', async () => {
    mount('technician');
    await screen.findAllByText(/Avery/);
    expect(screen.queryByRole('link', { name: 'Book Appt' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Invoice' })).not.toBeInTheDocument();
    const href = screen.getAllByRole('link', { name: 'Text' })[0].getAttribute('href');
    expect(href).toContain('customerId=customer-a');
    expect(href).toContain('thread=customer-a');
  });

  it('keeps Book, Invoice and the plain Text link for an admin', async () => {
    mount('admin');
    await screen.findAllByText(/Avery/);
    expect(screen.getByRole('link', { name: 'Book Appt' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Invoice' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Text' })[0].getAttribute('href')).toBe('/admin/communications?phone=%2B15555550103&action=sms');
  });
});

describe('overview facts', () => {
  it('shows a technician no gate code alert and no stripped-field claim', async () => {
    mount('technician');
    await screen.findAllByText(/Avery/);
    expect(screen.getByText(/Pet: Small dog/)).toBeInTheDocument();
    expect(screen.queryByText(/Property gate/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Neighborhood gate/)).not.toBeInTheDocument();
    expect(screen.queryByText('No card on file')).not.toBeInTheDocument();
    expect(screen.queryByText('No transactions yet')).not.toBeInTheDocument();
    expect(screen.queryByText('Already left a Google review')).not.toBeInTheDocument();
    expect(screen.getAllByText(/Not shown to technicians/).length).toBeGreaterThan(0);
  });

  it('keeps the gate alerts and the billing blocks for an admin', async () => {
    mount('admin');
    await screen.findAllByText(/Avery/);
    expect(await screen.findByText(/Property gate: 0000/)).toBeInTheDocument();
    expect(screen.getByText('No card on file')).toBeInTheDocument();
    expect(screen.getByText('No transactions yet')).toBeInTheDocument();
    expect(screen.getByText('Already left a Google review')).toBeInTheDocument();
  });
});

describe('conversation', () => {
  it('reads a technician\'s thread from the SMS log and offers no Calls filter', async () => {
    mount('technician', { initialTab: 'comms' });
    expect(await screen.findByText('Please use the side door')).toBeInTheDocument();
    expect(urls().some((url) => url.includes('/admin/communications/log?customerId=customer-a'))).toBe(true);
    expect(urls().some((url) => url.includes('/customer-a/comms'))).toBe(false);
    expect(screen.queryByRole('combobox', { name: 'Filter communication history' })).not.toBeInTheDocument();
  });

  it('keeps the admin thread on the customer comms route, with the channel filter', async () => {
    mount('admin', { initialTab: 'comms' });
    expect(await screen.findByRole('combobox', { name: 'Filter communication history' })).toBeInTheDocument();
    await waitFor(() => expect(urls().some((url) => url.includes('/customer-a/comms'))).toBe(true));
    expect(urls().some((url) => url.includes('/admin/communications/log'))).toBe(false);
  });
});

describe('embedded workspace', () => {
  async function openDetails() {
    await screen.findAllByText(/Avery/);
    fireEvent.click(await screen.findByRole('tab', { name: 'Details' }));
  }

  it('renders no Contracts section for a technician', async () => {
    mount('technician', { embedded: true });
    await openDetails();
    await screen.findByText(/Access & Preferences/);
    expect(screen.queryByText(/Contract history/)).not.toBeInTheDocument();
  });

  it('renders the Contracts section for an admin', async () => {
    mount('admin', { embedded: true });
    await openDetails();
    expect(await screen.findByText(/Contract history/)).toBeInTheDocument();
  });

  it('says where a technician finds access codes instead of "No access instructions recorded"', async () => {
    mount('technician', { embedded: true });
    await screen.findAllByText(/Avery/);
    expect(await screen.findByText(/show on the visit card on the day of service/)).toBeInTheDocument();
  });
});
