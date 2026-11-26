// @vitest-environment jsdom
/**
 * One-time pest hint on the Create Appointment modal (owner ruling 2026-11-26 "say the one time price when asked").
 * Under a one-time pest line the modal shows "System price for this home: $N", the server's price for the property the
 * visit is booked at, so staff can quote it. READ ONLY: it never changes a line price, the total, the preview or the
 * booking. The answer belongs to one customer, property and linked estimate; a change of any of them, or a cleared
 * customer, discards it, and a late answer for an older request is ignored.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../hooks/useDiscountStacking', () => ({
  useDiscountStackingState: vi.fn(() => ({ enabled: false, known: true, retry: vi.fn() })),
  ensureStackingFresh: vi.fn(async () => ({ enabled: false, known: true })),
}));
import CreateAppointmentModal from './CreateAppointmentModal.jsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const json = (body, { ok = true, status = 200 } = {}) => ({ ok, status, json: vi.fn(async () => body) });
const CUSTOMER = { id: 'customer-a', firstName: 'Ada', lastName: 'Lovelace' };
const OTHER_CUSTOMER = { id: 'customer-b', firstName: 'Bob', lastName: 'Barker' };
const PEST_ONE_TIME = { id: 'svc-otp', service_key: 'one_time_pest_control', name: 'One-Time Pest Control Service', billing_type: 'one_time', base_price: 250, default_duration_minutes: 45 };
const GENERAL = { id: 'svc-gen', service_key: 'general_one_time', name: 'General Treatment Service', billing_type: 'one_time', base_price: 50, default_duration_minutes: 30 };

function futureDate(days = 30) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

// `quote(customerId)` answers the hint's request; it may return a promise to hold the answer back.
function installFetch({ quote }) {
  const fetcher = vi.fn((input, options = {}) => {
    const url = String(input);
    if (url.includes('/admin/schedule/one-time-pest-quote?')) return Promise.resolve(quote(new URL(url, 'http://test').searchParams.get('customerId')));
    if (url.includes('/admin/customers?search=')) return Promise.resolve(json({ customers: [OTHER_CUSTOMER] }));
    if (url.endsWith('/admin/schedule/preview') && options.method === 'POST') {
      const groups = JSON.parse(options.body || '{}').groups || [];
      return Promise.resolve(json({ regime: true, results: groups.map((g) => ({ key: g.key })) }));
    }
    if (url.endsWith('/admin/schedule') && options.method === 'POST') return Promise.resolve(json({ id: 'appt-1' }));
    if (url.includes('/admin/triage?')) return Promise.resolve(json({ items: [] }));
    if (url.includes('/admin/services?')) {
      const q = (new URL(url, 'http://test').searchParams.get('search') || '').toLowerCase();
      return Promise.resolve(json({ services: [PEST_ONE_TIME, GENERAL].filter((c) => c.name.toLowerCase().includes(q)) }));
    }
    if (url.includes('/properties?context=appointment_address')) return Promise.resolve(json({ properties: [] }));
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

async function addService(query, name) {
  if (!screen.queryByPlaceholderText('Search services')) fireEvent.click(screen.getByRole('button', { name: /\+ Add service/i }));
  const box = screen.queryByPlaceholderText('Search services') || screen.getByPlaceholderText('Search to add service');
  fireEvent.change(box, { target: { value: query } });
  fireEvent.click(await screen.findByRole('button', { name }));
}

const mount = () => render(<CreateAppointmentModal defaultCustomer={CUSTOMER} defaultDate={futureDate()} defaultWindowStart="09:00" onClose={vi.fn()} onCreated={vi.fn()} onChange={vi.fn()} />);
const hint = () => screen.queryByTestId('one-time-pest-hint');
const total = () => screen.getByText(/^Total: \$/).textContent;
const quoteCalls = (fetcher) => fetcher.mock.calls.map(([u]) => String(u)).filter((u) => u.includes('/admin/schedule/one-time-pest-quote?'));
const schedulePosts = (fetcher) => fetcher.mock.calls.filter(([u, o]) => String(u).endsWith('/admin/schedule') && o?.method === 'POST').map(([, o]) => JSON.parse(o.body));
const previews = (fetcher) => fetcher.mock.calls.filter(([u, o]) => String(u).endsWith('/admin/schedule/preview') && o?.method === 'POST').map(([, o]) => JSON.parse(o.body));
const settle = (ms = 40) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

async function switchToOtherCustomer() {
  fireEvent.click(screen.getByLabelText('Clear selected customer'));
  fireEvent.change(screen.getByPlaceholderText('Search by name or phone...'), { target: { value: 'Bob' } });
  fireEvent.click(await screen.findByRole('button', { name: /Bob Barker/i }));
}

// What a one-time pest booking sends, with the hint's request answered however the test says.
async function bookOneTimePest(quote) {
  const fetcher = installFetch({ quote });
  mount();
  await addService('General', /General Treatment Service/i);
  await addService('One-Time Pest', /One-Time Pest Control Service/i);
  await settle();
  const button = screen.getByRole('button', { name: 'Schedule appointment' });
  await waitFor(() => expect(button.disabled).toBe(false));
  const totalBefore = total();
  fireEvent.click(button);
  await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(1));
  // The ids a line gets are random; the payload is compared without the group key.
  const strip = (value) => JSON.parse(JSON.stringify(value, (k, v) => (k === 'key' ? undefined : v)));
  return { post: strip(schedulePosts(fetcher)[0]), previews: previews(fetcher).map(strip), totalBefore };
}

describe('the one-time pest hint', () => {
  it('shows the system price for the current customer under the one-time pest line only', async () => {
    const fetcher = installFetch({ quote: () => json({ price: 238 }) });
    mount();
    await addService('General', /General Treatment Service/i);
    expect(hint()).toBeNull();
    expect(quoteCalls(fetcher)).toEqual([]);
    await addService('One-Time Pest', /One-Time Pest Control Service/i);
    await waitFor(() => expect(hint()).not.toBeNull());
    expect(hint().textContent).toBe('System price for this home: $238');
    expect(quoteCalls(fetcher)).toHaveLength(1);
    expect(quoteCalls(fetcher)[0]).toContain('/admin/schedule/one-time-pest-quote?customerId=customer-a');
  });

  it('shows nothing when the server has no price or the request fails', async () => {
    installFetch({ quote: () => json({ price: null }) });
    mount();
    await addService('One-Time Pest', /One-Time Pest Control Service/i);
    await settle();
    expect(hint()).toBeNull();
    cleanup();
    installFetch({ quote: () => json({ error: 'boom' }, { ok: false, status: 500 }) });
    mount();
    await addService('One-Time Pest', /One-Time Pest Control Service/i);
    await settle();
    expect(hint()).toBeNull();
  });

  it('is discarded when the customer changes, and the old answer is not shown for the new customer', async () => {
    let releaseB;
    const heldB = new Promise((resolve) => { releaseB = resolve; });
    installFetch({ quote: (id) => (id === 'customer-a' ? json({ price: 238 }) : heldB) });
    mount();
    await addService('One-Time Pest', /One-Time Pest Control Service/i);
    await waitFor(() => expect(hint()?.textContent).toBe('System price for this home: $238'));
    await switchToOtherCustomer();
    await waitFor(() => expect(hint()).toBeNull());
    await act(async () => { releaseB(json({ price: 199 })); await new Promise((r) => setTimeout(r, 30)); });
    expect(hint().textContent).toBe('System price for this home: $199');
  });

  it('ignores a late answer for an older customer, and one that arrives after the customer was cleared', async () => {
    let releaseA;
    const heldA = new Promise((resolve) => { releaseA = resolve; });
    installFetch({ quote: (id) => (id === 'customer-a' ? heldA : json({ price: 199 })) });
    mount();
    await addService('One-Time Pest', /One-Time Pest Control Service/i);
    fireEvent.click(screen.getByLabelText('Clear selected customer'));
    await act(async () => { releaseA(json({ price: 238 })); await new Promise((r) => setTimeout(r, 30)); });
    expect(hint()).toBeNull();
    // Selecting another customer: A's late 238 stays out, B's own answer shows.
    fireEvent.change(screen.getByPlaceholderText('Search by name or phone...'), { target: { value: 'Bob' } });
    fireEvent.click(await screen.findByRole('button', { name: /Bob Barker/i }));
    await waitFor(() => expect(hint()?.textContent).toBe('System price for this home: $199'));
  });
});

describe('the hint changes nothing about the booking', () => {
  it('the line keeps the catalog price it always had, and the total does not move', async () => {
    installFetch({ quote: () => json({ price: 238 }) });
    mount();
    await addService('One-Time Pest', /One-Time Pest Control Service/i);
    await waitFor(() => expect(hint()).not.toBeNull());
    expect(screen.getByPlaceholderText('0.00').value).toBe('250');
    expect(total()).toBe('Total: $250.00');
  });

  it('the POST and the preview carry exactly the same payload whether the hint answers a price, nothing, or fails', async () => {
    const withHint = await bookOneTimePest(() => json({ price: 238 }));
    cleanup();
    vi.unstubAllGlobals();
    const withNull = await bookOneTimePest(() => json({ price: null }));
    cleanup();
    vi.unstubAllGlobals();
    const withFailure = await bookOneTimePest(() => json({ error: 'boom' }, { ok: false, status: 500 }));
    expect(withHint.post).toEqual(withNull.post);
    expect(withHint.post).toEqual(withFailure.post);
    expect(withHint.previews).toEqual(withNull.previews);
    expect(withHint.totalBefore).toBe(withNull.totalBefore);
    // And it is the payload the modal always sent: the typed-looking catalog prices, no hint number anywhere.
    expect(withHint.post.primaryLinePrice).toBe(50);
    expect(withHint.post.serviceAddons).toHaveLength(1);
    expect(withHint.post.serviceAddons[0]).toMatchObject({ serviceId: 'svc-otp', basePrice: 250 });
    expect(JSON.stringify(withHint.post)).not.toContain('238');
    expect(JSON.stringify(withHint.previews)).not.toContain('238');
  });
});
