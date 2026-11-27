// @vitest-environment jsdom
/**
 * Customer 360 -> Contacts & Recipients -> "Named on a call (texts only)":
 * people the customer named on a phone call, who get visit texts only.
 * Staff see status words and can Stop / Restart each one. The block is
 * hidden when the list is empty.
 */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Customer360ProfileV2 from './Customer360ProfileV2';

vi.mock('./StickyActionBar', () => ({ CustomerActionBar: () => null }));
vi.mock('./AuthenticatedCallAudio', () => ({ default: () => null }));
vi.mock('./CustomerRequestsPanel', () => ({ default: () => null }));
vi.mock('./CallBridgeLink', () => ({ default: ({ children }) => <span>{children}</span>, callViaBridge: vi.fn() }));
vi.mock('../../pages/admin/SchedulePage', () => ({ ZoneMarkingStep: () => null, StationMarkingStep: () => null }));
vi.mock('../../hooks/useFeatureFlag', () => ({ useFeatureFlagReady: () => ({ enabled: false, ready: true }) }));

function response(body, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

function customerDetail() {
  return {
    customer: {
      id: 'customer-a', firstName: 'Avery', lastName: 'Customer', email: 'avery@example.com',
      address: { line1: '1 Main St', city: 'Bradenton', state: 'FL', zip: '34205' }, active: true,
    },
    notificationPrefs: {}, preferences: {}, healthScore: {},
    invoices: [], cards: [], paymentMethodConsents: [], contracts: [], photos: [],
    customerDiscounts: [], complianceRecords: [], nutrientLedger: {}, services: [],
    payments: [], scheduled: [], upcomingScheduled: [], accountProperties: [], annualPrepayTerms: [],
  };
}

const person = (over = {}) => ({ id: 'r1', firstName: 'Bob', lastName: 'Example', phone: '+19415550111', stopped: false, stoppedAt: null, stoppedBy: null, addedAt: '2026-11-20T00:00:00Z', hasAppAccess: false, ...over });

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('waves_admin_token', 'test-token');
  localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
});

function stubFetch(list) {
  let current = list;
  const fetchMock = vi.fn((url, options) => {
    const path = String(url).split('?')[0];
    if (path.endsWith('/admin/payers')) return response({ payers: [] });
    if (path.endsWith('/timeline')) return response({ timeline: [] });
    if (path.endsWith('/admin/customers/customer-a')) return response(customerDetail());
    const action = path.match(/\/reminder-contacts\/([^/]+)\/(stop|restart)$/);
    if (action && options?.method === 'POST') {
      const stopped = action[2] === 'stop';
      current = current.map((p) => (p.id === action[1] ? { ...p, stopped, stoppedBy: stopped ? 'staff' : null } : p));
      return response({ reminderContact: current.find((p) => p.id === action[1]) });
    }
    if (path.endsWith('/admin/customers/customer-a/reminder-contacts')) return response({ reminderContacts: current });
    if (path.endsWith('/contact-notification-prefs')) return response({ live: true, contacts: [] });
    return response({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function openComms() {
  render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} initialTab="comms" />);
  await screen.findAllByText('Avery Customer');
  fireEvent.click(await screen.findByText('View routing & override recipients'));
}

describe('Customer 360 -> named on a call (texts only)', () => {
  it('lists each person with a status word', async () => {
    stubFetch([person(), person({ id: 'r2', firstName: 'Cam', lastName: 'Caller', phone: '+19415550222', stopped: true, stoppedBy: 'customer' }), person({ id: 'r3', firstName: 'Dee', lastName: 'Dial', phone: '+19415550333', stopped: true, stoppedBy: 'staff' })]);
    await openComms();
    const block = await screen.findByTestId('reminder-contacts');
    expect(within(block).getByText('Named on a call (texts only)')).toBeInTheDocument();
    expect(await within(block).findByText('Bob Example')).toBeInTheDocument();
    expect(within(block).getByText('Getting texts')).toBeInTheDocument();
    expect(within(block).getByText('Stopped by customer')).toBeInTheDocument();
    expect(within(block).getByText('Stopped by staff')).toBeInTheDocument();
  });

  it('Stop and Restart post to the right URL and update the row', async () => {
    const fetchMock = stubFetch([person()]);
    await openComms();
    const block = await screen.findByTestId('reminder-contacts');
    fireEvent.click(await within(block).findByRole('button', { name: 'Stop texts for Bob Example' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u, o]) => String(u).endsWith('/admin/customers/customer-a/reminder-contacts/r1/stop') && o?.method === 'POST')).toBe(true));
    expect(await within(block).findByText('Stopped by staff')).toBeInTheDocument();
    fireEvent.click(within(block).getByRole('button', { name: 'Restart texts for Bob Example' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u, o]) => String(u).endsWith('/admin/customers/customer-a/reminder-contacts/r1/restart') && o?.method === 'POST')).toBe(true));
    expect(await within(block).findByText('Getting texts')).toBeInTheDocument();
  });

  it('hides the block when the list is empty', async () => {
    const fetchMock = stubFetch([]);
    await openComms();
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/reminder-contacts'))).toBe(true));
    expect(screen.queryByTestId('reminder-contacts')).not.toBeInTheDocument();
    expect(screen.queryByText('Named on a call (texts only)')).not.toBeInTheDocument();
  });
});
