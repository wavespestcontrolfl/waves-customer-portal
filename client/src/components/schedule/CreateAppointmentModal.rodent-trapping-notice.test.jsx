// @vitest-environment jsdom
/**
 * Rodent trapping notice on the Create Appointment modal (owner ruling
 * 2026-09-26): trapping covers the setup visit + 1 trap check, and visit 3
 * and later is booked as Rodent Trap Check - Additional. With no trapping-job
 * record, a trapping line asks the server for the booking address's recent
 * trapping visits and shows one read-only notice once 2 are on file.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../hooks/useDiscountStacking', () => ({
  useDiscountStackingState: vi.fn(() => ({ enabled: false, known: true, retry: vi.fn() })),
  ensureStackingFresh: vi.fn(async () => ({ enabled: false, known: true })),
}));
import CreateAppointmentModal, {
  RODENT_TRAPPING_NOTICE_FAILED,
  rodentTrappingNoticeText,
} from './CreateAppointmentModal.jsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const json = (body, { ok = true, status = 200 } = {}) => ({ ok, status, json: vi.fn(async () => body) });
const CUSTOMER = { id: 'customer-a', firstName: 'Ada', lastName: 'Lovelace' };
const CATALOG = [
  { id: 'svc-check', service_key: 'rodent_trapping_followup', name: 'Rodent Trapping Follow-Up Visit Service', billing_type: 'one_time', base_price: 0, default_duration_minutes: 30 },
  { id: 'svc-extra', service_key: 'rodent_trap_check_additional', name: 'Rodent Trap Check - Additional', billing_type: 'one_time', base_price: 95, default_duration_minutes: 30 },
  { id: 'svc-pest', service_key: 'pest_control', name: 'Pest Control Visit', billing_type: 'one_time', base_price: 50, default_duration_minutes: 30 },
];
const PROPERTIES = [
  { id: 'prop-home', is_primary: true, address_line1: '100 Synthetic Ln', city: 'Bradenton', state: 'FL', zip: '34201' },
  { id: 'prop-rental', is_primary: false, address_line1: '200 Synthetic Ln', city: 'Bradenton', state: 'FL', zip: '34201' },
];
const TWO_VISITS = {
  windowDays: 60, count: 2,
  visits: [{ id: 'v1', date: '2026-10-01', serviceKey: 'rodent_trapping' }, { id: 'v2', date: '2026-10-08', serviceKey: 'rodent_trapping_followup' }],
};
const NOTICE = '2 trapping visits at this address in the 60 days before this visit (latest 10/8). '
  + 'Trapping covers the setup visit + 1 trap check; book visit 3 and later as Rodent Trap Check - Additional. '
  + 'Jobs sold before 9/27/2026 keep all their checks included.';

function futureDate(days = 30) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

// `visits(params)` answers the notice's lookup (a function of its query).
function installFetch({ visits = () => json(TWO_VISITS), properties = { properties: [], canChangeAppointmentAddress: false } } = {}) {
  const fetcher = vi.fn((input, options = {}) => {
    const url = String(input);
    if (url.includes('/admin/schedule/rodent-trapping-visits?')) {
      return Promise.resolve(visits(new URL(url, 'http://test').searchParams));
    }
    if (url.includes('/admin/triage?')) return Promise.resolve(json({ items: [] }));
    if (url.includes('/admin/services?')) {
      const q = (new URL(url, 'http://test').searchParams.get('search') || '').toLowerCase();
      return Promise.resolve(json({ services: CATALOG.filter((c) => c.name.toLowerCase().includes(q)) }));
    }
    if (url.includes('/properties?context=appointment_address')) return Promise.resolve(properties).then((body) => json(body));
    if (url.includes('/schedule-estimates')) return Promise.resolve(json({ estimates: [] }));
    if (url.endsWith('/admin/technicians')) return Promise.resolve(json({ technicians: [] }));
    if (url.endsWith('/admin/discounts')) return Promise.resolve(json([]));
    if (url.endsWith('/annual-prepay-availability')) return Promise.resolve(json({ enabled: false }));
    if (url.endsWith('/card-request-availability')) return Promise.resolve(json({ enabled: false }));
    if (url.endsWith('/admin/dispatch/slot-check')) return Promise.resolve(json({ ok: true, results: [{ conflicts: [] }] }));
    if (url.includes('/admin/schedule/find-time')) return Promise.resolve(json({ gated: true }));
    throw new Error(`Unhandled fetch in test: ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

const lookups = (fetcher) => fetcher.mock.calls
  .map(([u]) => String(u))
  .filter((u) => u.includes('/admin/schedule/rodent-trapping-visits?'))
  .map((u) => Object.fromEntries(new URL(u, 'http://test').searchParams));

async function addService(query, name) {
  if (!screen.queryByPlaceholderText('Search services')) fireEvent.click(screen.getByRole('button', { name: /\+ Add service/i }));
  const box = screen.queryByPlaceholderText('Search services') || screen.getByPlaceholderText('Search to add service');
  fireEvent.change(box, { target: { value: query } });
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(name, 'i') }));
}

function mount(date = futureDate()) {
  return render(<CreateAppointmentModal
    defaultCustomer={CUSTOMER}
    defaultDate={date}
    defaultWindowStart="09:00"
    onClose={vi.fn()}
    onCreated={vi.fn()}
    onChange={vi.fn()}
  />);
}

describe('the rodent trapping notice', () => {
  it('shows on a trapping line once the address already has 2 trapping visits', async () => {
    const date = futureDate();
    const fetcher = installFetch();
    mount(date);
    await addService('Trapping Follow-Up', 'Rodent Trapping Follow-Up Visit Service');
    expect((await screen.findByTestId('rodent-trapping-notice')).textContent).toBe(NOTICE);
    // Asked for this customer and booking date; no saved-address choice, so no property.
    expect(lookups(fetcher)).toEqual([{ customerId: 'customer-a', date }]);
  });

  it('stays hidden while the address has fewer than 2 trapping visits', async () => {
    const fetcher = installFetch({ visits: () => json({ windowDays: 60, count: 1, visits: [{ id: 'v1', date: '2026-10-01' }] }) });
    mount();
    await addService('Trapping Follow-Up', 'Rodent Trapping Follow-Up Visit Service');
    await waitFor(() => expect(lookups(fetcher)).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId('rodent-trapping-notice')).toBeNull();
  });

  it('never asks when the booking has no trapping line', async () => {
    const fetcher = installFetch();
    mount();
    await addService('Pest Control', 'Pest Control Visit');
    await screen.findByRole('button', { name: 'Schedule appointment' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(lookups(fetcher)).toHaveLength(0);
    expect(screen.queryByTestId('rodent-trapping-notice')).toBeNull();
  });

  it('shows once per booking, on the first trapping line', async () => {
    installFetch();
    mount();
    await addService('Trapping Follow-Up', 'Rodent Trapping Follow-Up Visit Service');
    await addService('Trap Check - Additional', 'Rodent Trap Check - Additional');
    await screen.findByTestId('rodent-trapping-notice');
    expect(screen.getAllByTestId('rodent-trapping-notice')).toHaveLength(1);
  });

  it('says the visits could not be loaded when the lookup fails', async () => {
    installFetch({ visits: () => json({ error: 'boom' }, { ok: false, status: 500 }) });
    mount();
    await addService('Trap Check - Additional', 'Rodent Trap Check - Additional');
    expect((await screen.findByTestId('rodent-trapping-notice')).textContent).toBe(RODENT_TRAPPING_NOTICE_FAILED);
  });

  it('asks for the picked address and asks again when the office picks another', async () => {
    const fetcher = installFetch({
      properties: { properties: PROPERTIES, canChangeAppointmentAddress: true },
      visits: (params) => json(params.get('propertyId') === 'prop-rental' ? { windowDays: 60, count: 0, visits: [] } : TWO_VISITS),
    });
    mount();
    await screen.findByTestId('booking-property-picker');
    await addService('Trapping Follow-Up', 'Rodent Trapping Follow-Up Visit Service');
    await screen.findByTestId('rodent-trapping-notice');
    expect(lookups(fetcher).map((q) => q.propertyId)).toEqual(['prop-home']);

    fireEvent.click(screen.getByRole('radio', { name: 'Service address 200 Synthetic Ln' }));
    await waitFor(() => expect(lookups(fetcher).map((q) => q.propertyId)).toEqual(['prop-home', 'prop-rental']));
    await waitFor(() => expect(screen.queryByTestId('rodent-trapping-notice')).toBeNull());
  });

  it('waits for the saved addresses, so it never asks for the primary when the booking lands elsewhere', async () => {
    let release;
    const fetcher = installFetch({ properties: new Promise((resolve) => { release = resolve; }) });
    mount();
    await addService('Trapping Follow-Up', 'Rodent Trapping Follow-Up Visit Service');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lookups(fetcher)).toHaveLength(0);
    release({ properties: PROPERTIES, canChangeAppointmentAddress: true });
    await screen.findByTestId('rodent-trapping-notice');
    expect(lookups(fetcher).map((q) => q.propertyId)).toEqual(['prop-home']);
  });

  it('asks again for the new date when the office moves the visit', async () => {
    const fetcher = installFetch();
    mount(futureDate(30));
    await addService('Trapping Follow-Up', 'Rodent Trapping Follow-Up Visit Service');
    await screen.findByTestId('rodent-trapping-notice');
    const moved = futureDate(45);
    // The modal renders through a portal on document.body.
    fireEvent.change(document.querySelector('input.waves-sq-date'), { target: { value: moved } });
    await waitFor(() => expect(lookups(fetcher).map((q) => q.date)).toEqual([futureDate(30), moved]));
  });
});

describe('rodentTrappingNoticeText', () => {
  it('is null below the 2 included visits and for a missing or malformed answer', () => {
    expect(rodentTrappingNoticeText({ windowDays: 60, count: 1, visits: [{ date: '2026-10-01' }] })).toBeNull();
    expect(rodentTrappingNoticeText({ windowDays: 60, count: 0, visits: [] })).toBeNull();
    expect(rodentTrappingNoticeText(null)).toBeNull();
    expect(rodentTrappingNoticeText({ count: '2.5' })).toBeNull();
  });

  it('counts every visit on file and names the latest one', () => {
    expect(rodentTrappingNoticeText({
      windowDays: 60, count: 3,
      visits: [{ date: '2026-09-02' }, { date: '2026-09-12' }, { date: '2026-10-08' }],
    })).toMatch(/^3 trapping visits at this address in the 60 days before this visit \(latest 10\/8\)\. /);
  });

  it('prints no dollar figure', () => {
    expect(rodentTrappingNoticeText(TWO_VISITS)).not.toMatch(/\$/);
  });
});
