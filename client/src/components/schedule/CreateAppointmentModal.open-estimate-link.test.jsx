/**
 * Booking-win tracking (owner 2026-11-23): booking a visit for a customer who has an open estimate sent in the last
 * 60 days shows "Link it". The button is the same pick as choosing the estimate in the Estimate source picker, so the
 * existing accept-on-book path and its refusals decide the rest. Nothing links, fills or changes without a tap.
 */
// @vitest-environment jsdom
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { etDateString } from '../../lib/timezone';

vi.mock('../../hooks/useDiscountStacking', () => ({
  useDiscountStackingState: vi.fn(() => ({ enabled: false, known: true, retry: vi.fn() })),
  ensureStackingFresh: vi.fn(async () => ({ enabled: true, known: true })),
}));
import CreateAppointmentModal, { pickAutoScheduleEstimate } from './CreateAppointmentModal.jsx';
import { isRecentOpenEstimate, openEstimateLinkNotice, recentOpenEstimates } from './openEstimateLink.js';

const NOW = new Date('2026-11-23T15:00:00Z').getTime();
const daysAgo = (n) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();
const est = (over = {}) => ({ id: 'est-1', customerId: 'cust-1', status: 'sent', bookable: true, sentAt: daysAgo(10), linkedAppointment: null, ...over });

describe('isRecentOpenEstimate', () => {
  it('accepts a bookable sent or viewed estimate this customer was sent in the last 60 days', () => {
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

  it('rejects an estimate the server says a booking would refuse (plan-start, unwon invoice proposal), or one with no flag', () => {
    expect(isRecentOpenEstimate(est({ bookable: false }), 'cust-1', NOW)).toBe(false);
    expect(isRecentOpenEstimate(est({ bookable: undefined }), 'cust-1', NOW)).toBe(false);
  });

  it('rejects an estimate already tied to a visit, one owned by someone else, one with no owner and one with no date', () => {
    expect(isRecentOpenEstimate(est({ linkedAppointment: { id: 's1' } }), 'cust-1', NOW)).toBe(false);
    expect(isRecentOpenEstimate(est({ customerId: 'cust-2' }), 'cust-1', NOW)).toBe(false);
    expect(isRecentOpenEstimate(est({ customerId: null }), 'cust-1', NOW)).toBe(false);
    expect(isRecentOpenEstimate(est({ sentAt: null }), 'cust-1', NOW)).toBe(false);
    expect(isRecentOpenEstimate(est(), null, NOW)).toBe(false);
  });
});

describe('pickAutoScheduleEstimate never auto-links an open estimate', () => {
  it('returns nothing for a recent open estimate (it must be picked, or linked with the button)', () => {
    expect(pickAutoScheduleEstimate({ customerId: 'cust-1', estimates: [est()], nowMs: NOW })).toBeNull();
  });
});

describe('openEstimateLinkNotice', () => {
  it('one open estimate: says to link it and names the estimate the button picks', () => {
    const e = est({ sentAt: '2026-11-13T15:00:00Z' });
    expect(openEstimateLinkNotice({ estimates: [e], customerId: 'cust-1', nowMs: NOW }))
      .toEqual({ text: 'This customer has an open estimate from Nov 13. Link it so this booking counts as won.', estimateId: 'est-1' });
  });

  it('two or more: asks staff to pick one above and offers no button', () => {
    const list = [est({ sentAt: '2026-11-13T15:00:00Z' }), est({ id: 'est-2', sentAt: '2026-11-01T15:00:00Z' })];
    expect(openEstimateLinkNotice({ estimates: list, customerId: 'cust-1', nowMs: NOW }))
      .toEqual({ text: 'This customer has 2 open estimates (newest from Nov 13). Pick the one they said yes to above so this booking counts as won.', estimateId: null });
    expect(recentOpenEstimates(list, 'cust-1', NOW)[0].id).toBe('est-1');
  });

  it('names the Eastern day from the sent date (late evening Eastern is already the next UTC day)', () => {
    // 2026-11-14 02:30 UTC is still Nov 13 in Eastern time.
    const e = est({ sentAt: '2026-11-14T02:30:00Z', createdAt: '2026-10-01T12:00:00Z' });
    expect(openEstimateLinkNotice({ estimates: [e], customerId: 'cust-1', nowMs: NOW }).text).toContain('from Nov 13.');
  });

  it('is silent for no estimate, an accepted one, an old one or one a booking would refuse', () => {
    expect(openEstimateLinkNotice({ estimates: [], customerId: 'cust-1', nowMs: NOW })).toBeNull();
    expect(openEstimateLinkNotice({ estimates: [est({ status: 'accepted' })], customerId: 'cust-1', nowMs: NOW })).toBeNull();
    expect(openEstimateLinkNotice({ estimates: [est({ sentAt: daysAgo(80) })], customerId: 'cust-1', nowMs: NOW })).toBeNull();
    expect(openEstimateLinkNotice({ estimates: [est({ bookable: false })], customerId: 'cust-1', nowMs: NOW })).toBeNull();
  });
});

describe('the New Appointment form for a customer with an open estimate', () => {
  const json = (body, { ok = true, status = 200 } = {}) => ({ ok, status, json: vi.fn(async () => body) });
  const CATALOG = [
    { id: 'svc-pest', service_key: 'pest_control', name: 'Pest Control Visit', billing_type: 'one_time', base_price: 50, default_duration_minutes: 30 },
    { id: 'svc-first', service_key: 'svc_first', name: 'First seasonal service', billing_type: 'recurring', frequency: 'seasonal_feb_oct', visits_per_year: 9, base_price: 40, default_duration_minutes: 30 },
    { id: 'svc-second', service_key: 'svc_second', name: 'Second seasonal service', billing_type: 'recurring', frequency: 'seasonal_feb_oct', visits_per_year: 9, base_price: 40, default_duration_minutes: 30 },
  ];
  const futureDate = () => {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
  };
  const recent = () => new Date(Date.now() - 5 * 86400000).toISOString();
  const quote = (over = {}) => ({
    id: 'est-1', customerId: 'cust-1', status: 'sent', bookable: true, sentAt: recent(), prepay: { eligible: false },
    lines: [{ name: 'Quarterly Lawn Care', serviceKey: null, serviceId: 'svc-quote', price: 118, cadence: 'one_time', duration: 30 }],
    ...over,
  });
  const propertyRow = (id, primary) => ({ id, is_primary: primary, address_line1: `${id} Test Ln`, city: 'Bradenton', state: 'FL', zip: '34205' });

  // `holdSecondPost` / `failSecondPost`: the second POST of a two-group booking stays pending / returns a 500.
  function installFetch({ estimates = [quote()], properties = [], holdSecondPost = null, failSecondPost = false } = {}) {
    const fetcher = vi.fn((input, options = {}) => {
      const url = String(input);
      if (url.includes('/admin/triage?')) return Promise.resolve(json({ items: [] }));
      if (url.includes('/admin/services?')) {
        const q = (new URL(url, 'http://test').searchParams.get('search') || '').toLowerCase();
        return Promise.resolve(json({ services: CATALOG.filter((c) => c.name.toLowerCase().includes(q)) }));
      }
      if (url.endsWith('/admin/schedule') && options.method === 'POST') {
        const n = fetcher.mock.calls.filter(([u, o]) => String(u).endsWith('/admin/schedule') && o?.method === 'POST').length;
        if (n === 2 && holdSecondPost) return holdSecondPost.promise;
        if (n === 2 && failSecondPost) return Promise.resolve(json({ error: 'failed' }, { ok: false, status: 500 }));
        return Promise.resolve(json({ id: `appt-${n}` }));
      }
      if (url.includes('/properties?context=appointment_address')) return Promise.resolve(json({ properties }));
      if (url.includes('/schedule-estimates')) return Promise.resolve(json({ estimates }));
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
  const mount = () => render(
    <MemoryRouter>
      <CreateAppointmentModal
        defaultCustomer={{ id: 'cust-1', firstName: 'Pat', lastName: 'Sampleton' }}
        defaultDate={futureDate() || etDateString()}
        defaultWindowStart="09:00"
        onClose={vi.fn()}
        onCreated={vi.fn()}
        onChange={vi.fn()}
      />
    </MemoryRouter>,
  );
  async function addService(query, name) {
    if (!screen.queryByPlaceholderText('Search services')) fireEvent.click(screen.getByRole('button', { name: /\+ Add service/i }));
    fireEvent.change(screen.queryByPlaceholderText('Search services') || screen.getByPlaceholderText('Search to add service'), { target: { value: query } });
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(name, 'i') }));
  }
  const pickerValue = () => document.querySelector('option[value="est-1"]').closest('select').value;
  beforeEach(() => { installFetch(); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('shows the notice with a Link it button, and links nothing and fills nothing until it is tapped', async () => {
    mount();
    expect(await screen.findByText('This customer has an open estimate from ' + new Date(Date.now() - 5 * 86400000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' }) + '. Link it so this booking counts as won.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Link it' })).toBeTruthy();
    expect(pickerValue()).toBe('');
    expect(screen.queryByText('Quarterly Lawn Care')).toBeNull();
    expect(screen.queryByText(/saving marks it accepted and links it/)).toBeNull();
  });

  it('Link it is the manual pick: the estimate is chosen in the picker, its lines fill, and the notice goes away', async () => {
    const fetcher = installFetch();
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Link it' }));
    await waitFor(() => expect(pickerValue()).toBe('est-1'));
    expect(await screen.findByText(/saving marks it accepted and links it/)).toBeTruthy();
    expect(screen.getAllByText('Quarterly Lawn Care').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('open-estimate-link-notice')).toBeNull();
    const submit = screen.getByRole('button', { name: 'Schedule appointment' });
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(posts(fetcher)).toHaveLength(1));
    expect(posts(fetcher)[0].sourceEstimateId).toBe('est-1');
  });

  it('the notice goes away once a service is added, and a booking made without the tap sends no estimate link', async () => {
    const fetcher = installFetch();
    mount();
    await screen.findByRole('button', { name: 'Link it' });
    await addService('Pest', 'Pest Control Visit');
    // A pick would replace the service list, so the notice is gone once staff add a service.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Link it' })).toBeNull());
    expect(screen.queryByTestId('open-estimate-link-notice')).toBeNull();
    const submit = screen.getByRole('button', { name: 'Schedule appointment' });
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(posts(fetcher)).toHaveLength(1));
    expect(posts(fetcher)[0].sourceEstimateId).toBeUndefined();
    expect(posts(fetcher)[0].serviceId).toBe('svc-pest');
  });

  it('two open estimates: the notice says to pick one above and has no button', async () => {
    installFetch({ estimates: [quote(), quote({ id: 'est-2' })] });
    mount();
    expect(await screen.findByText(/has 2 open estimates/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Link it' })).toBeNull();
    expect(pickerValue()).toBe('');
  });

  it('shows no notice for a plan-start or unwon invoice-proposal quote (the server marks it not bookable)', async () => {
    installFetch({ estimates: [quote({ bookable: false })] });
    mount();
    await waitFor(() => expect(document.querySelector('option[value="est-1"]')).not.toBeNull());
    expect(screen.queryByTestId('open-estimate-link-notice')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Link it' })).toBeNull();
  });

  it('shows no notice for an estimate older than 60 days', async () => {
    installFetch({ estimates: [quote({ sentAt: new Date(Date.now() - 90 * 86400000).toISOString() })] });
    mount();
    await waitFor(() => expect(document.querySelector('option[value="est-1"]')).not.toBeNull());
    expect(screen.queryByTestId('open-estimate-link-notice')).toBeNull();
  });

  it('updates when the booking address changes: a quote for the other address no longer counts', async () => {
    installFetch({
      estimates: [quote({ propertyId: 'prop-1' })],
      properties: [propertyRow('prop-1', true), propertyRow('prop-2', false)],
    });
    mount();
    // prop-1 is the default address, and the quote was priced for it.
    expect(await screen.findByRole('button', { name: 'Link it' })).toBeTruthy();
    const radio = (id) => document.querySelector(`input[name="booking-property"][value="${id}"]`);
    await waitFor(() => expect(radio('prop-2')).not.toBeNull());
    fireEvent.click(radio('prop-2'));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Link it' })).toBeNull());
    expect(screen.queryByTestId('open-estimate-link-notice')).toBeNull();
    fireEvent.click(radio('prop-1'));
    expect(await screen.findByRole('button', { name: 'Link it' })).toBeTruthy();
  });

  it('with one active property (picker hidden) a quote for another address gives no notice; an address-free or matching quote does', async () => {
    installFetch({ estimates: [quote({ propertyId: 'old-address' })], properties: [propertyRow('prop-1', true)] });
    mount();
    await waitFor(() => expect(document.querySelector('option[value="est-1"]')).not.toBeNull());
    await waitFor(() => expect(screen.queryByText('Loading estimates...')).toBeNull());
    expect(screen.queryByTestId('open-estimate-link-notice')).toBeNull();
    cleanup();
    installFetch({ estimates: [quote({ propertyId: 'prop-1' })], properties: [propertyRow('prop-1', true)] });
    mount();
    expect(await screen.findByRole('button', { name: 'Link it' })).toBeTruthy();
    cleanup();
    installFetch({ estimates: [quote({ propertyId: null })], properties: [propertyRow('prop-1', true)] });
    mount();
    expect(await screen.findByRole('button', { name: 'Link it' })).toBeTruthy();
  });

  it('is hidden while the appointment is saving', async () => {
    const hold = {};
    hold.promise = new Promise((resolve) => { hold.resolve = resolve; });
    // The only POST is held, so the form stays in its saving state.
    const fetcher = installFetch();
    fetcher.mockImplementation(((impl) => (input, options = {}) => (
      String(input).endsWith('/admin/schedule') && options.method === 'POST' ? hold.promise : impl(input, options)
    ))(fetcher.getMockImplementation()));
    mount();
    await screen.findByRole('button', { name: 'Link it' });
    await addService('Pest', 'Pest Control Visit');
    const submit = screen.getByRole('button', { name: 'Schedule appointment' });
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(posts(fetcher)).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Link it' })).toBeNull());
    expect(screen.queryByTestId('open-estimate-link-notice')).toBeNull();
    await act(async () => { hold.resolve(json({ id: 'appt-1' })); await hold.promise; });
  });

  it('is hidden after a partial split save (one group committed, one failed)', async () => {
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    const fetcher = installFetch({ failSecondPost: true });
    mount();
    await screen.findByRole('button', { name: 'Link it' });
    await addService('First', 'First seasonal service');
    await addService('Second', 'Second seasonal service');
    const submit = screen.getByRole('button', { name: 'Schedule appointment' });
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(posts(fetcher)).toHaveLength(2));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Link it' })).toBeNull());
    expect(screen.queryByTestId('open-estimate-link-notice')).toBeNull();
  });

  it('the picker label and the notice name the same Eastern day', async () => {
    installFetch({ estimates: [quote({ sentAt: '2026-11-14T02:30:00Z', createdAt: '2026-10-01T12:00:00Z' })] });
    mount();
    await waitFor(() => expect(document.querySelector('option[value="est-1"]')).not.toBeNull());
    expect(document.querySelector('option[value="est-1"]').textContent).toContain('Sent Nov 13');
  });
});
