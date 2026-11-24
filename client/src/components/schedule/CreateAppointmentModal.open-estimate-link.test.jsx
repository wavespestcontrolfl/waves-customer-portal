/**
 * Booking-win tracking (owner 2026-11-23): booking a visit for a customer who has an open estimate sent in the last
 * 60 days links that estimate by default, so the existing accept-on-book path records the win. Staff can press Clear.
 * No acceptance side effect lives here: the modal only sets sourceEstimateId, the server path is unchanged.
 */
// @vitest-environment jsdom
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { etDateString } from '../../lib/timezone';

vi.mock('../../hooks/useDiscountStacking', () => ({
  useDiscountStackingState: vi.fn(() => ({ enabled: false, known: true, retry: vi.fn() })),
  ensureStackingFresh: vi.fn(async () => ({ enabled: true, known: true })),
}));
import CreateAppointmentModal, { pickAutoScheduleEstimate } from './CreateAppointmentModal.jsx';
import { isRecentOpenEstimate, openEstimateLinkNotice, recentOpenEstimates } from './openEstimateLink.js';

const NOW = new Date('2026-11-23T15:00:00Z').getTime();
const daysAgo = (n) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();
const est = (over = {}) => ({ id: 'est-1', customerId: 'cust-1', status: 'sent', sentAt: daysAgo(10), linkedAppointment: null, ...over });

describe('isRecentOpenEstimate', () => {
  it('accepts a sent or viewed estimate this customer was sent in the last 60 days', () => {
    expect(isRecentOpenEstimate(est(), 'cust-1', NOW)).toBe(true);
    expect(isRecentOpenEstimate(est({ status: 'viewed', sentAt: daysAgo(60) }), 'cust-1', NOW)).toBe(true);
  });

  it('falls back to the created date when no sent date came back', () => {
    expect(isRecentOpenEstimate(est({ sentAt: null, createdAt: daysAgo(5) }), 'cust-1', NOW)).toBe(true);
  });

  it('rejects an estimate older than 60 days', () => {
    expect(isRecentOpenEstimate(est({ sentAt: daysAgo(61) }), 'cust-1', NOW)).toBe(false);
  });

  it('rejects an already accepted, expired or declined estimate', () => {
    for (const status of ['accepted', 'expired', 'declined', 'draft']) {
      expect(isRecentOpenEstimate(est({ status }), 'cust-1', NOW)).toBe(false);
    }
  });

  it('rejects an estimate already tied to a visit, one owned by someone else, one with no owner and one with no date', () => {
    expect(isRecentOpenEstimate(est({ linkedAppointment: { id: 's1' } }), 'cust-1', NOW)).toBe(false);
    expect(isRecentOpenEstimate(est({ customerId: 'cust-2' }), 'cust-1', NOW)).toBe(false);
    expect(isRecentOpenEstimate(est({ customerId: null }), 'cust-1', NOW)).toBe(false);
    expect(isRecentOpenEstimate(est({ sentAt: null }), 'cust-1', NOW)).toBe(false);
    expect(isRecentOpenEstimate(est(), null, NOW)).toBe(false);
  });
});

describe('pickAutoScheduleEstimate with an open estimate', () => {
  const base = { customerId: 'cust-1', nowMs: NOW };

  it('links exactly one recent open estimate by default', () => {
    const e = est();
    expect(pickAutoScheduleEstimate({ ...base, estimates: [e] })).toEqual({ estimate: e, key: 'cust-1:est-1' });
  });

  it('does not link when there is none, when it is too old, or when two are open', () => {
    expect(pickAutoScheduleEstimate({ ...base, estimates: [] })).toBeNull();
    expect(pickAutoScheduleEstimate({ ...base, estimates: [est({ sentAt: daysAgo(90) })] })).toBeNull();
    expect(pickAutoScheduleEstimate({ ...base, estimates: [est(), est({ id: 'est-2' })] })).toBeNull();
  });

  it('does not link once staff already added services, or after the same estimate was applied once', () => {
    expect(pickAutoScheduleEstimate({ ...base, estimates: [est()], serviceCount: 1 })).toBeNull();
    expect(pickAutoScheduleEstimate({ ...base, estimates: [est()], appliedKey: 'cust-1:est-1' })).toBeNull();
  });

  it('waits for the address list before linking an open estimate, but never delays an accepted one', () => {
    expect(pickAutoScheduleEstimate({ ...base, estimates: [est()], propertiesSettled: false })).toBeNull();
    expect(pickAutoScheduleEstimate({ ...base, estimates: [est()], propertiesSettled: true }).estimate.id).toBe('est-1');
    const accepted = est({ id: 'est-9', status: 'accepted' });
    expect(pickAutoScheduleEstimate({ ...base, estimates: [accepted], propertiesSettled: false }).estimate.id).toBe('est-9');
  });

  it('an accepted estimate keeps priority over an open one', () => {
    const accepted = est({ id: 'est-9', status: 'accepted', sentAt: daysAgo(100) });
    expect(pickAutoScheduleEstimate({ ...base, estimates: [est(), accepted] }).estimate.id).toBe('est-9');
  });
});

describe('openEstimateLinkNotice', () => {
  it('says the estimate is linked and counts as won, with how to undo it', () => {
    const e = est({ sentAt: '2026-11-13T15:00:00Z' });
    expect(openEstimateLinkNotice({ estimates: [e], linkedEstimate: e, customerId: 'cust-1', nowMs: NOW }))
      .toBe('This customer has an open estimate from Nov 13. It is linked so this booking counts as won. Press Clear to book without it.');
  });

  it('after Clear it asks staff to pick the estimate from the list', () => {
    const e = est({ sentAt: '2026-11-13T15:00:00Z' });
    expect(openEstimateLinkNotice({ estimates: [e], linkedEstimate: null, customerId: 'cust-1', nowMs: NOW }))
      .toBe('This customer has an open estimate from Nov 13. Pick it above so this booking counts as won.');
  });

  it('with two open estimates it asks staff to pick the one the customer said yes to', () => {
    const list = [est({ sentAt: '2026-11-13T15:00:00Z' }), est({ id: 'est-2', sentAt: '2026-11-01T15:00:00Z' })];
    expect(openEstimateLinkNotice({ estimates: list, customerId: 'cust-1', nowMs: NOW }))
      .toBe('This customer has 2 open estimates (newest from Nov 13). Pick the one they said yes to so this booking counts as won.');
    expect(recentOpenEstimates(list, 'cust-1', NOW)[0].id).toBe('est-1');
  });

  it('names the Eastern day, from the sent date (late evening Eastern is already the next UTC day)', () => {
    // 2026-11-14 02:30 UTC is still Nov 13 in Eastern time.
    const e = est({ sentAt: '2026-11-14T02:30:00Z', createdAt: '2026-10-01T12:00:00Z' });
    expect(openEstimateLinkNotice({ estimates: [e], customerId: 'cust-1', nowMs: NOW })).toContain('from Nov 13.');
  });

  it('is silent for no estimate, an accepted one or an old one', () => {
    expect(openEstimateLinkNotice({ estimates: [], customerId: 'cust-1', nowMs: NOW })).toBeNull();
    expect(openEstimateLinkNotice({ estimates: [est({ status: 'accepted' })], customerId: 'cust-1', nowMs: NOW })).toBeNull();
    const old = est({ sentAt: daysAgo(80) });
    expect(openEstimateLinkNotice({ estimates: [old], linkedEstimate: old, customerId: 'cust-1', nowMs: NOW })).toBeNull();
  });
});

describe('the New Appointment form for a customer with an open estimate', () => {
  const CUSTOMER = { id: 'cust-1', firstName: 'Pat', lastName: 'Sampleton', phone: '9415550100', address: '12 Test Lane', city: 'Bradenton', zip: '34205' };
  const quote = (over = {}) => ({
    id: 'est-1', customerId: 'cust-1', status: 'sent', sentAt: new Date(Date.now() - 5 * 86400000).toISOString(),
    annualTotal: 472, monthlyTotal: 39.33, prepay: { eligible: false },
    lines: [{ name: 'Quarterly Pest Control', serviceKey: null, serviceId: null, price: 118, cadence: 'quarterly', duration: 30 }],
    ...over,
  });
  let estimates;
  beforeEach(() => {
    estimates = [quote()];
    vi.stubGlobal('fetch', vi.fn(async (url) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).includes('/schedule-estimates') ? { estimates } : {}),
    })));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  const openForm = () => render(
    <MemoryRouter>
      <CreateAppointmentModal defaultCustomer={CUSTOMER} defaultDate={etDateString()} defaultWindowStart="09:00" onClose={vi.fn()} onCreated={vi.fn()} />
    </MemoryRouter>,
  );

  it('links the open estimate by default and tells staff it counts as won', async () => {
    openForm();
    expect(await screen.findByText(/It is linked so this booking counts as won/)).toBeTruthy();
    expect(await screen.findByText(/saving marks it accepted and links it/)).toBeTruthy();
    expect(document.querySelector('option[value="est-1"]').closest('select').value).toBe('est-1');
  });

  it('Clear unlinks it and the notice asks staff to pick it instead', async () => {
    openForm();
    await screen.findByText(/It is linked so this booking counts as won/);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(await screen.findByText(/Pick it above so this booking counts as won/)).toBeTruthy();
    await waitFor(() => expect(document.querySelector('option[value="est-1"]').closest('select').value).toBe(''));
  });

  it('links nothing and shows no notice when the open estimate is older than 60 days', async () => {
    estimates = [quote({ sentAt: new Date(Date.now() - 90 * 86400000).toISOString() })];
    openForm();
    await waitFor(() => expect(document.querySelector('option[value="est-1"]')).not.toBeNull());
    expect(document.querySelector('option[value="est-1"]').closest('select').value).toBe('');
    expect(screen.queryByTestId('open-estimate-link-notice')).toBeNull();
  });
});


// The booking itself: what the form sends after Clear, after a customer switch, and while addresses load.
describe('the booking payload and timing of the open-estimate link', () => {
  const json = (body) => ({ ok: true, status: 200, json: vi.fn(async () => body) });
  const CATALOG = [
    { id: 'svc-pest', service_key: 'pest_control', name: 'Pest Control Visit', billing_type: 'one_time', base_price: 50, default_duration_minutes: 30 },
  ];
  const futureDate = () => {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
  };
  const recent = () => new Date(Date.now() - 5 * 86400000).toISOString();
  const quote = (over = {}) => ({
    id: 'est-1', customerId: 'cust-1', status: 'sent', sentAt: recent(), prepay: { eligible: false },
    lines: [{ name: 'Quarterly Lawn Care', serviceKey: null, serviceId: 'svc-quote', price: 118, cadence: 'one_time', duration: 30 }],
    ...over,
  });
  const propertyRow = (id, primary) => ({ id, is_primary: primary, address_line1: '1 Test Ln', city: 'Bradenton', state: 'FL', zip: '34205' });

  function installFetch({ estimatesFor, propertiesFor = () => ({ properties: [] }) }) {
    const fetcher = vi.fn((input, options = {}) => {
      const url = String(input);
      if (url.includes('/admin/triage?')) return Promise.resolve(json({ items: [] }));
      if (url.includes('/admin/customers?search=')) return Promise.resolve(json({ customers: [{ id: 'cust-2', firstName: 'Grace', lastName: 'Hopper', address: '200 Test Ave', phone: '555-0002' }] }));
      if (url.includes('/admin/services?')) return Promise.resolve(json({ services: CATALOG }));
      if (url.endsWith('/admin/schedule') && options.method === 'POST') return Promise.resolve(json({ id: 'appt-1' }));
      if (url.includes('/properties?context=appointment_address')) {
        const id = url.match(/customers\/([^/]+)\/properties/)[1];
        return Promise.resolve(propertiesFor(id)).then(json);
      }
      if (url.includes('/schedule-estimates')) {
        const id = url.match(/customers\/([^/]+)\/schedule-estimates/)[1];
        return Promise.resolve(json({ estimates: estimatesFor(id) }));
      }
      if (url.endsWith('/admin/technicians')) return Promise.resolve(json({ technicians: [] }));
      if (url.endsWith('/admin/discounts')) return Promise.resolve(json([]));
      if (url.endsWith('/annual-prepay-availability')) return Promise.resolve(json({ enabled: false }));
      if (url.endsWith('/card-request-availability')) return Promise.resolve(json({ enabled: false }));
      if (url.endsWith('/admin/dispatch/slot-check')) return Promise.resolve(json({ ok: true, results: [{ conflicts: [] }] }));
      if (url.includes('/admin/schedule/find-time')) return Promise.resolve(json({ gated: true }));
      if (url.endsWith('/admin/schedule/preview') && options.method === 'POST') {
        const groups = JSON.parse(options.body || '{}').groups || [];
        return Promise.resolve(json({ regime: false, results: groups.map((g) => ({ key: g.key })) }));
      }
      return Promise.resolve(json({}));
    });
    vi.stubGlobal('fetch', fetcher);
    return fetcher;
  }
  const posts = (fetcher) => fetcher.mock.calls
    .filter(([u, o]) => String(u).endsWith('/admin/schedule') && o?.method === 'POST')
    .map(([, o]) => JSON.parse(o.body));
  const mount = (customer = { id: 'cust-1', firstName: 'Pat', lastName: 'Sampleton' }) => render(
    <MemoryRouter>
      <CreateAppointmentModal defaultCustomer={customer} defaultDate={futureDate()} defaultWindowStart="09:00" onClose={vi.fn()} onCreated={vi.fn()} onChange={vi.fn()} />
    </MemoryRouter>,
  );
  async function addService(query, name) {
    if (!screen.queryByPlaceholderText('Search services')) fireEvent.click(screen.getByRole('button', { name: /\+ Add service/i }));
    fireEvent.change(screen.queryByPlaceholderText('Search services') || screen.getByPlaceholderText('Search to add service'), { target: { value: query } });
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(name, 'i') }));
  }
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('Clear takes back the quote lines, keeps a service staff added, and books with no estimate link', async () => {
    const fetcher = installFetch({ estimatesFor: () => [quote()] });
    mount();
    await screen.findByText(/It is linked so this booking counts as won/);
    expect(screen.getAllByText('Quarterly Lawn Care').length).toBeGreaterThan(0);
    await addService('Pest', 'Pest Control Visit');
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(screen.queryByText('Quarterly Lawn Care')).toBeNull());
    const submit = screen.getByRole('button', { name: 'Schedule appointment' });
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(posts(fetcher)).toHaveLength(1));
    const body = posts(fetcher)[0];
    expect(body.sourceEstimateId).toBeUndefined();
    expect(body.serviceId).toBe('svc-pest');
    expect(body.serviceAddons || []).toHaveLength(0);
  });

  it('the Clear button on a linked estimate leaves no stale quote price behind', async () => {
    installFetch({ estimatesFor: () => [quote()] });
    mount();
    await screen.findByText(/It is linked so this booking counts as won/);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(screen.queryByText('Quarterly Lawn Care')).toBeNull());
    expect(screen.queryByText(/Total: \$118/)).toBeNull();
  });

  it('does not link an open estimate while the address list is still loading, and never links one of two', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    installFetch({
      estimatesFor: () => [quote(), quote({ id: 'est-2', propertyId: 'prop-1' })],
      propertiesFor: () => gate,
    });
    mount();
    await screen.findByRole('combobox');
    // Estimates have loaded; only the address-agnostic quote is visible, and it must NOT link yet.
    await waitFor(() => expect(document.querySelector('option[value="est-1"]')).not.toBeNull());
    expect(screen.queryByText(/It is linked so this booking counts as won/)).toBeNull();
    release({ properties: [propertyRow('prop-1', true), propertyRow('prop-2', false)] });
    // Once the addresses land both quotes are eligible, so staff must choose.
    expect(await screen.findByText(/has 2 open estimates/)).toBeTruthy();
    expect(screen.queryByText(/It is linked so this booking counts as won/)).toBeNull();
    expect(document.querySelector('option[value="est-1"]').closest('select').value).toBe('');
  });

  it('links the single open estimate once the address list settles', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    installFetch({ estimatesFor: () => [quote()], propertiesFor: () => gate });
    mount();
    await waitFor(() => expect(document.querySelector('option[value="est-1"]')).not.toBeNull());
    expect(screen.queryByText(/It is linked so this booking counts as won/)).toBeNull();
    release({ properties: [] });
    expect(await screen.findByText(/It is linked so this booking counts as won/)).toBeTruthy();
  });

  async function switchToSecondCustomer() {
    fireEvent.click(screen.getByRole('button', { name: 'Clear selected customer' }));
    fireEvent.change(screen.getByPlaceholderText('Search by name or phone...'), { target: { value: 'Grace' } });
    fireEvent.click(await screen.findByText('Grace Hopper'));
  }

  it('switching customers drops the first customer\'s quote lines and books the second with no estimate link', async () => {
    const fetcher = installFetch({ estimatesFor: (id) => (id === 'cust-1' ? [quote()] : []) });
    mount();
    await screen.findByText(/It is linked so this booking counts as won/);
    await switchToSecondCustomer();
    await waitFor(() => expect(screen.queryByText('Quarterly Lawn Care')).toBeNull());
    expect(screen.queryByText(/It is linked so this booking counts as won/)).toBeNull();
    await addService('Pest', 'Pest Control Visit');
    const submit = screen.getByRole('button', { name: 'Schedule appointment' });
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(posts(fetcher)).toHaveLength(1));
    const body = posts(fetcher)[0];
    expect(body.customerId).toBe('cust-2');
    expect(body.sourceEstimateId).toBeUndefined();
    expect(body.serviceId).toBe('svc-pest');
  });

  it('after a switch the second customer\'s own open estimate links (the old lines no longer block it)', async () => {
    installFetch({ estimatesFor: (id) => (id === 'cust-1' ? [quote()] : [quote({ id: 'est-2', customerId: 'cust-2' })]) });
    mount();
    await screen.findByText(/It is linked so this booking counts as won/);
    await switchToSecondCustomer();
    await waitFor(() => expect(document.querySelector('option[value="est-2"]')?.closest('select').value).toBe('est-2'));
    expect(document.querySelector('option[value="est-1"]')).toBeNull();
  });

  it('an estimate date never shifts a day: the picker and the notice both use the sent date in Eastern time', async () => {
    installFetch({ estimatesFor: () => [quote({ sentAt: '2026-11-14T02:30:00Z', createdAt: '2026-10-01T12:00:00Z' })] });
    mount();
    // Not within 60 days of the real clock in this run, so it only shows in the picker.
    await waitFor(() => expect(document.querySelector('option[value="est-1"]')).not.toBeNull());
    expect(document.querySelector('option[value="est-1"]').textContent).toContain('Sent Nov 13');
  });
});
