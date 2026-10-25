// @vitest-environment jsdom
// GATE_NEW_APPT_PHONE_MATCH (owner 2026-10-24): a complete phone in the New customer block offers
// the customers already on it with one tap (never an automatic pick); one Save adds a new caller
// and books the visit; a known phone stops at the Attach / Separate account choice; a picked
// address suggestion scrolls the best times into view. Gate off: today's two-step flow.
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../AddressAutocomplete', () => ({
  default: ({ value, onSelect }) => (
    <>
      <input aria-label="quick-add address" value={value} readOnly />
      <button type="button" onClick={() => onSelect({ formatted: '100 Example Way, Bradenton, FL 34200', line1: '100 Example Way', city: 'Bradenton', state: 'FL', zip: '34200', lat: 27.5, lng: -82.5, source: 'suggestion' })}>pick suggestion</button>
      <button type="button" onClick={() => onSelect({ formatted: '100 Example Way, Bradenton, FL 34200', line1: '100 Example Way', city: 'Bradenton', state: 'FL', zip: '34200', lat: 27.5, lng: -82.5, source: 'typed' })}>geocode typed</button>
    </>
  ),
}));
vi.mock('../../hooks/useDiscountStacking', () => ({
  useDiscountStackingState: vi.fn(() => ({ enabled: false, known: true, retry: vi.fn() })),
  ensureStackingFresh: vi.fn(async () => ({ enabled: true, known: true })),
}));
import CreateAppointmentModal, { quickAddPhoneDigits } from './CreateAppointmentModal.jsx';

const json = (body, { ok = true, status = 200 } = {}) => ({ ok, status, json: vi.fn(async () => body) });
const ON_FILE = { id: 'cust-on-file', firstName: 'Robin', lastName: 'Sample', phone: '(941) 555-0100', address: '200 Sample St, Parrish, FL 34200' };
const CREATED = { id: 'cust-new', firstName: 'Pat', lastName: 'Example', phone: '9415550199', address: '100 Example Way', city: 'Bradenton', state: 'FL', zip: '34200' };

function futureDate(days = 30) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

const PEST = { id: 'svc-q', service_key: 'pest_control_quarterly', name: 'Quarterly Pest Control', billing_type: 'recurring', frequency: 'quarterly', base_price: 100, default_duration_minutes: 30 };

function installFetch({ search = {}, quickAdd = () => json({ customer: CREATED }), catalog = [PEST] } = {}) {
  const fetcher = vi.fn((input, options = {}) => {
    const url = String(input);
    if (url.includes('/admin/customers?search=')) {
      const term = new URL(url, 'http://test').searchParams.get('search') || '';
      return Promise.resolve(json({ customers: search[term] || [] }));
    }
    if (url.endsWith('/admin/customers/quick-add') && options.method === 'POST') return Promise.resolve(quickAdd(JSON.parse(options.body)));
    if (url.endsWith('/admin/schedule') && options.method === 'POST') return Promise.resolve(json({ id: 'appt-1' }));
    if (url.includes('/admin/triage?')) return Promise.resolve(json({ items: [] }));
    if (url.includes('/admin/services?')) {
      return Promise.resolve(json({ services: catalog }));
    }
    if (url.includes('/properties?context=appointment_address')) return Promise.resolve(json({ properties: [], canChangeAppointmentAddress: false }));
    if (url.includes('/schedule-estimates')) return Promise.resolve(json({ estimates: [] }));
    if (url.includes('/reservice-request-suggestion')) return Promise.resolve(json({ enabled: false, suggestion: null }));
    if (url.endsWith('/admin/technicians')) return Promise.resolve(json({ technicians: [] }));
    if (url.endsWith('/admin/discounts')) return Promise.resolve(json([]));
    if (url.includes('/admin/schedule/mosquito-onetime-quote')) return Promise.resolve(json({ price: 129 }));
    if (url.endsWith('/annual-prepay-availability')) return Promise.resolve(json({ enabled: false }));
    if (url.endsWith('/card-request-availability')) return Promise.resolve(json({ enabled: false }));
    if (url.endsWith('/admin/dispatch/slot-check')) return Promise.resolve(json({ ok: true, results: [{ conflicts: [] }] }));
    if (url.includes('/admin/schedule/find-time')) return Promise.resolve(json({ gated: true }));
    if (url.endsWith('/admin/schedule/preview') && options.method === 'POST') {
      const groups = JSON.parse(options.body || '{}').groups || [];
      return Promise.resolve(json({ regime: true, results: groups.map((g) => ({ key: g.key })) }));
    }
    throw new Error(`Unhandled fetch in test: ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

const posts = (fetcher, suffix) => fetcher.mock.calls.filter(([u, o]) => String(u).endsWith(suffix) && o?.method === 'POST');
const phoneSearches = (fetcher) => fetcher.mock.calls.map(([u]) => String(u)).filter((u) => u.includes('/admin/customers?search='));

function mount(props = {}) {
  render(<CreateAppointmentModal defaultDate={futureDate()} defaultWindowStart="09:00" onClose={vi.fn()} onCreated={vi.fn()} onChange={vi.fn()} {...props} />);
  fireEvent.click(screen.getByText('+ New customer'));
}

const quickAddInputs = () => {
  const block = screen.getByLabelText('quick-add address').closest('div').parentElement;
  const [first, last, phone] = Array.from(block.querySelectorAll('input'));
  return { first, last, phone };
};

async function fillCaller(phoneValue = '941-555-0199') {
  const { first, last, phone } = quickAddInputs();
  fireEvent.change(first, { target: { value: 'Pat' } });
  fireEvent.change(last, { target: { value: 'Example' } });
  fireEvent.change(phone, { target: { value: phoneValue } });
  fireEvent.click(screen.getByText('pick suggestion'));
}

async function addService() {
  fireEvent.change(screen.getByPlaceholderText('Search services'), { target: { value: 'Quarterly' } });
  fireEvent.click(await screen.findByRole('button', { name: /Quarterly Pest Control/i }));
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete Element.prototype.scrollIntoView;
});

describe('quickAddPhoneDigits', () => {
  it('compares on ten digits, drops a leading US 1, and waits for a complete number', () => {
    expect(quickAddPhoneDigits('(941) 555-0100')).toBe('9415550100');
    expect(quickAddPhoneDigits('+1 941 555 0100')).toBe('9415550100');
    expect(quickAddPhoneDigits('941555010')).toBe('');
    expect(quickAddPhoneDigits('')).toBe('');
  });
});

describe('New customer phone match (gate on)', () => {
  it('offers the customer on a complete phone, and one tap selects them with nothing written', async () => {
    // The search also matches names and partial numbers: only the exact phone is offered.
    const fetcher = installFetch({ search: { 9415550100: [ON_FILE, { id: 'other', firstName: 'Lee', lastName: 'Other', phone: '9415550100 ext 2 9', address: 'x' }] } });
    mount({ newCustomerPhoneMatch: true });
    const { phone } = quickAddInputs();
    fireEvent.change(phone, { target: { value: '941 555 010' } });
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    expect(phoneSearches(fetcher)).toEqual([]);

    fireEvent.change(phone, { target: { value: '(941) 555-0100' } });
    const region = await screen.findByRole('region', { name: 'Phone already on file' });
    expect(region.textContent).toContain('Robin Sample');
    expect(region.textContent).toContain('200 Sample St');
    expect(region.textContent).not.toContain('Lee Other');
    // Offered, not picked: nothing is selected until the tap.
    expect(screen.queryByLabelText('Clear selected customer')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Use this customer' }));
    expect(await screen.findByLabelText('Clear selected customer')).toBeTruthy();
    expect(screen.queryByLabelText('quick-add address')).toBeNull();
    expect(posts(fetcher, '/admin/customers/quick-add')).toEqual([]);
  });

  it('one Save adds the new caller, then books the visit for them', async () => {
    const fetcher = installFetch();
    mount({ newCustomerPhoneMatch: true });
    expect(screen.queryByRole('button', { name: 'Add customer' })).toBeNull();
    await fillCaller();
    await addService();
    const save = screen.getByRole('button', { name: 'Schedule appointment' });
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(posts(fetcher, '/admin/schedule')).toHaveLength(1));
    expect(posts(fetcher, '/admin/customers/quick-add')).toHaveLength(1);
    const order = fetcher.mock.calls.map(([u, o]) => (o?.method === 'POST' ? String(u) : '')).filter((u) => /quick-add|\/admin\/schedule$/.test(u));
    expect(order).toEqual([expect.stringMatching(/quick-add$/), expect.stringMatching(/\/admin\/schedule$/)]);
    expect(JSON.parse(posts(fetcher, '/admin/schedule')[0][1].body).customerId).toBe('cust-new');
  });

  it('a note typed while one Save waits for the form to settle is booked as shown', async () => {
    const fetcher = installFetch();
    mount({ newCustomerPhoneMatch: true });
    await fillCaller();
    await addService();
    const save = screen.getByRole('button', { name: 'Schedule appointment' });
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(posts(fetcher, '/admin/customers/quick-add')).toHaveLength(1));
    // The customer exists and the booking is waiting: staff add a note now.
    const notes = screen.getByText('Internal Notes (Admin only)').parentElement.querySelector('textarea');
    fireEvent.change(notes, { target: { value: 'Dog in the back yard' } });
    await waitFor(() => expect(posts(fetcher, '/admin/schedule')).toHaveLength(1));
    expect(JSON.parse(posts(fetcher, '/admin/schedule')[0][1].body).internalNotes).toBe('Dog in the back yard');
  });

  it('a known phone stops at the Attach / Separate account choice and books nothing', async () => {
    const fetcher = installFetch({
      quickAdd: () => json({ error: 'This phone belongs to an existing customer', code: 'PHONE_MATCH_CONFIRM', match: { accountId: 'acct-1', name: 'Robin Sample', address: '200 Sample St' } }, { ok: false, status: 409 }),
    });
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    mount({ newCustomerPhoneMatch: true });
    await fillCaller();
    await addService();
    const save = screen.getByRole('button', { name: 'Schedule appointment' });
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    expect(await screen.findByRole('button', { name: 'Attach as additional property' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create separate account' })).toBeTruthy();
    expect(alertSpy).not.toHaveBeenCalled();
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
    expect(posts(fetcher, '/admin/schedule')).toEqual([]);
  });

  it('a line priced from the new customer\'s lot waits for a second Save', async () => {
    // A one-time mosquito line with no typed price is priced from the property's lot
    // size, which exists only once the customer does: staff see it before it books.
    const fetcher = installFetch({ catalog: [{ id: 'svc-m', service_key: 'mosquito_one_time', name: 'One-Time Mosquito Treatment', billing_type: 'one_time', base_price: 0, default_duration_minutes: 30 }] });
    mount({ newCustomerPhoneMatch: true });
    await fillCaller();
    fireEvent.change(screen.getByPlaceholderText('Search services'), { target: { value: 'Mosquito' } });
    fireEvent.click(await screen.findByRole('button', { name: /One-Time Mosquito Treatment/i }));
    const save = screen.getByRole('button', { name: 'Schedule appointment' });
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    expect(await screen.findByText(/Customer added\. Check the mosquito price/)).toBeTruthy();
    expect(posts(fetcher, '/admin/customers/quick-add')).toHaveLength(1);
    expect(posts(fetcher, '/admin/schedule')).toEqual([]);
  });

  it('scrolls the best times into view after a picked suggestion, not after a blur geocode', async () => {
    installFetch();
    mount({ newCustomerPhoneMatch: true, addressFirstTimes: true });
    fireEvent.click(screen.getByText('geocode typed'));
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('pick suggestion'));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
  });
});

describe('gate off', () => {
  it('no phone lookup, Add customer stays, and Save waits for a customer', async () => {
    const fetcher = installFetch({ search: { 9415550100: [ON_FILE] } });
    mount({ addressFirstTimes: true });
    await fillCaller('(941) 555-0100');
    await addService();
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    expect(phoneSearches(fetcher)).toEqual([]);
    expect(screen.getByRole('button', { name: 'Add customer' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Schedule appointment' }).disabled).toBe(true);
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });
});
