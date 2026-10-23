// @vitest-environment jsdom
/**
 * Customer 360 → Contacts & Recipients → on-location contacts' OWN
 * notification choices (contact login, GATE_CONTACT_LOGIN). Staff see each
 * contact's effective choices (the holder's account-wide off is locked and
 * labelled), can narrow one through PUT /api/admin/customers/:id/
 * contact-notification-prefs/:slot, and are told when a contact has not yet
 * agreed to texts in the app (only the contact can turn one on).
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
      serviceContactName: 'Sam Spouse', serviceContactPhone: '+19415550202', serviceContactEmail: 'sam@example.com',
    },
    notificationPrefs: {}, preferences: {}, healthScore: {},
    invoices: [], cards: [], paymentMethodConsents: [], contracts: [], photos: [],
    customerDiscounts: [], complianceRecords: [], nutrientLedger: {}, services: [],
    payments: [], scheduled: [], upcomingScheduled: [], accountProperties: [], annualPrepayTerms: [],
  };
}

const prefs = (overrides = {}) => ({
  appointmentConfirmation: true, serviceReminder72h: false, serviceReminder24h: true, techEnRoute: true, techArrived: true, serviceCompleted: true,
  appointmentConfirmationChannel: 'both', serviceReminder72hChannel: 'both', serviceReminder24hChannel: 'both', enRouteChannel: 'both', techArrivedChannel: 'both', serviceCompleteChannel: 'both',
  smsEnabled: true, emailEnabled: true, ...overrides,
});
const accountOff = { appointmentConfirmation: false, serviceReminder72h: true, serviceReminder24h: false, techEnRoute: false, techArrived: false, serviceCompleted: false };

function choices(samOverrides = {}) {
  return {
    live: true,
    contacts: [
      { slot: 1, name: 'Sam Spouse', phone: '+19415550202', email: 'sam@example.com', contactRole: null, preferences: prefs(), accountOff, hasOwnChoices: false, emailAvailable: true, reportsWithheld: false, consentAttestedAt: null, smsOptin: 'pending', ...samOverrides },
      { slot: 2, name: 'Terry Tenant', phone: '+19415550303', email: '', contactRole: 'tenant', preferences: prefs(), accountOff, hasOwnChoices: true, emailAvailable: false, reportsWithheld: true, consentAttestedAt: '2026-10-20T00:00:00Z', smsOptin: 'confirmed' },
    ],
  };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('waves_admin_token', 'test-token');
  localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
});

function stubFetch({ onPut } = {}) {
  let current = choices();
  const fetchMock = vi.fn((url, options) => {
    const path = String(url).split('?')[0];
    if (path.endsWith('/admin/payers')) return response({ payers: [] });
    if (path.endsWith('/timeline')) return response({ timeline: [] });
    if (path.endsWith('/admin/customers/customer-a')) return response(customerDetail());
    if (/\/contact-notification-prefs\/\d$/.test(path)) {
      const slot = Number(path.slice(-1));
      const body = JSON.parse(options.body);
      if (onPut) return onPut(slot, body);
      current = { ...current, contacts: current.contacts.map((c) => (c.slot === slot ? { ...c, hasOwnChoices: true, preferences: { ...c.preferences, ...body } } : c)) };
      return response({ success: true, ...current });
    }
    if (path.endsWith('/contact-notification-prefs')) return response(current);
    return response({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function openPanel() {
  render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} initialTab="comms" />);
  await screen.findAllByText('Avery Customer');
  fireEvent.click(await screen.findByText('View routing & override recipients'));
  const panel = await screen.findByTestId('contact-notification-choices');
  // The panel mounts with "Loading…" before its own fetch resolves; under CI
  // load that first paint can be the one findByTestId returns, so wait for the
  // first contact row before any getBy* (flaked on main 2026-10-22, run 39857297728).
  await within(panel).findByText('Sam Spouse');
  return panel;
}

describe('Customer 360 → contacts\' own notification choices', () => {
  it('reads out each contact: texts, alerts on, consent state, withheld reports', async () => {
    stubFetch();
    const panel = await openPanel();
    expect(within(panel).getByText('Sam Spouse')).toBeInTheDocument();
    expect(within(panel).getByText(/Texts on · 5 of 6 alerts · Account defaults · Opt-in text pending/)).toBeInTheDocument();
    expect(within(panel).getByText(/Texts on · 5 of 6 alerts · Own choices · Agreed to texts in the app/)).toBeInTheDocument();
    expect(within(panel).getByText(/Service reports are withheld from this contact/)).toBeInTheDocument();
  });

  it('Edit shows the rows; the holder\'s account-wide off is locked and labelled; a toggle PUTs the slot and re-renders the response', async () => {
    const fetchMock = stubFetch();
    const panel = await openPanel();
    fireEvent.click(within(panel).getByRole('button', { name: 'Edit notification choices for Sam Spouse' }));
    const reminder72 = within(panel).getByRole('switch', { name: '3-day reminder for Sam Spouse' });
    expect(reminder72).toBeDisabled();
    expect(reminder72).toHaveAttribute('aria-checked', 'false');
    expect(within(panel).getByText('Off at account level')).toBeInTheDocument();
    expect(within(panel).getByText(/has not agreed to texts in the app yet/)).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole('switch', { name: 'On the way for Sam Spouse' }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([u, o]) => String(u).endsWith('/admin/customers/customer-a/contact-notification-prefs/1') && o?.method === 'PUT' && JSON.parse(o.body).techEnRoute === false)).toBe(true);
    });
    await waitFor(() => expect(within(panel).getByRole('switch', { name: 'On the way for Sam Spouse' })).toHaveAttribute('aria-checked', 'false'));
    expect(within(panel).getByText(/4 of 6 alerts · Own choices/)).toBeInTheDocument();
  });

  it('a refused save (contact has not agreed to texts) shows the server message and keeps the prior state', async () => {
    stubFetch({ onPut: () => response({ error: 'This contact has not agreed to texts in the app yet. Staff can turn their notifications off, but only the contact can turn them on.', code: 'CONSENT_REQUIRED' }, 400) });
    const panel = await openPanel();
    fireEvent.click(within(panel).getByRole('button', { name: 'Edit notification choices for Sam Spouse' }));
    fireEvent.click(within(panel).getByRole('switch', { name: 'Text messages for Sam Spouse' }));
    expect(await within(panel).findByText(/only the contact can turn them on/)).toBeInTheDocument();
    expect(within(panel).getByRole('switch', { name: 'Text messages for Sam Spouse' })).toHaveAttribute('aria-checked', 'true');
  });

  it('a contact without an email gets no Email delivery option; the gate-off note shows when the server says so', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockImplementation((url) => {
      const path = String(url).split('?')[0];
      if (path.endsWith('/contact-notification-prefs')) return response({ ...choices(), live: false });
      if (path.endsWith('/admin/payers')) return response({ payers: [] });
      if (path.endsWith('/timeline')) return response({ timeline: [] });
      if (path.endsWith('/admin/customers/customer-a')) return response(customerDetail());
      return response({});
    });
    const panel = await openPanel();
    expect(within(panel).getByText(/stored but not applied/)).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'Edit notification choices for Terry Tenant' }));
    const select = within(panel).getByRole('combobox', { name: 'Delivery for On the way (Terry Tenant)' });
    expect([...select.options].map((o) => o.value)).toEqual(['both', 'sms']);
    expect(within(panel).queryByRole('switch', { name: 'Service reports for Terry Tenant' })).not.toBeInTheDocument();
  });

  it('an email-only contact (no phone) is read-only: no Edit, a note instead (codex r1 P2)', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockImplementation((url) => {
      const path = String(url).split('?')[0];
      if (path.endsWith('/contact-notification-prefs')) {
        const base = choices();
        return response({ ...base, contacts: [...base.contacts, { slot: 3, name: 'Morgan Mail', phone: '', email: 'morgan@example.com', contactRole: null, preferences: prefs(), accountOff, hasOwnChoices: false, emailAvailable: true, reportsWithheld: false, consentAttestedAt: null, smsOptin: 'none' }] });
      }
      if (path.endsWith('/admin/payers')) return response({ payers: [] });
      if (path.endsWith('/timeline')) return response({ timeline: [] });
      if (path.endsWith('/admin/customers/customer-a')) return response(customerDetail());
      return response({});
    });
    const panel = await openPanel();
    expect(within(panel).getByText('Morgan Mail')).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Edit notification choices for Morgan Mail' })).not.toBeInTheDocument();
    expect(within(panel).getByText(/Email-only contact/)).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Edit notification choices for Sam Spouse' })).toBeInTheDocument();
  });
});
