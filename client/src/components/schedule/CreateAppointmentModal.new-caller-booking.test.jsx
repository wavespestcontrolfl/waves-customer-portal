// @vitest-environment jsdom
// GATE_NEW_CALLER_BOOKING (owner 2026-10-25): with an address picked from the suggestions and no
// name or phone typed, Book saves a new caller's visit with no customer yet, stamped with the live
// call the office answered. Several live calls: the office picks one. Typing a name or phone
// switches back to the customer flow. Gate off: no call lookup, no Book.
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../AddressAutocomplete', () => ({
  default: ({ value, onSelect }) => (
    <>
      <input aria-label="quick-add address" value={value} readOnly />
      <button type="button" onClick={() => onSelect({ formatted: '100 Example Way, Bradenton, FL 34200', line1: '100 Example Way', city: 'Bradenton', state: 'FL', zip: '34200', lat: 27.5, lng: -82.5, source: 'suggestion' })}>pick suggestion</button>
    </>
  ),
}));
vi.mock('../../hooks/useDiscountStacking', () => ({
  useDiscountStackingState: vi.fn(() => ({ enabled: false, known: true, retry: vi.fn() })),
  ensureStackingFresh: vi.fn(async () => ({ enabled: true, known: true })),
}));
import CreateAppointmentModal, { newCallerBookBlockReason, newCallerRequestBody, newCallerCallLabel } from './CreateAppointmentModal.jsx';

const json = (body, { ok = true, status = 200 } = {}) => ({ ok, status, json: vi.fn(async () => body) });

function futureDate(days = 30) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

const ASSESSMENT = { id: 'svc-a', service_key: 'lawn_inspection', name: 'Waves Assessment', billing_type: 'one_time', base_price: 0, default_duration_minutes: 30 };
const PEST = { id: 'svc-q', service_key: 'pest_control_quarterly', name: 'Quarterly Pest Control', billing_type: 'recurring', frequency: 'quarterly', base_price: 100, default_duration_minutes: 30 };
const CALL = { id: 'call-1', direction: 'inbound', caller: '•••-0100', answeredBy: 'Office', startedAt: '2027-01-15T15:04:00.000Z', live: true };
const CALL_2 = { id: 'call-2', direction: 'outbound', caller: '•••-0177', answeredBy: null, startedAt: '2027-01-15T15:10:00.000Z', live: true };

function installFetch({ calls = [CALL], catalog = [ASSESSMENT, PEST] } = {}) {
  const fetcher = vi.fn((input, options = {}) => {
    const url = String(input);
    if (url.endsWith('/admin/schedule/new-caller/calls')) return Promise.resolve(json({ calls }));
    if (url.endsWith('/admin/schedule/new-caller') && options.method === 'POST') return Promise.resolve(json({ ok: true, id: 'visit-1', scheduledDate: futureDate(), warnings: [] }, { status: 201 }));
    if (url.includes('/admin/customers?search=')) return Promise.resolve(json({ customers: [] }));
    if (url.endsWith('/admin/customers/quick-add') && options.method === 'POST') return Promise.resolve(json({ customer: { id: 'cust-new' } }));
    if (url.endsWith('/admin/schedule') && options.method === 'POST') return Promise.resolve(json({ id: 'appt-1' }));
    if (url.includes('/admin/triage?')) return Promise.resolve(json({ items: [] }));
    if (url.includes('/admin/services?')) return Promise.resolve(json({ services: catalog }));
    if (url.includes('/properties?context=appointment_address')) return Promise.resolve(json({ properties: [], canChangeAppointmentAddress: false }));
    if (url.includes('/schedule-estimates')) return Promise.resolve(json({ estimates: [] }));
    if (url.includes('/reservice-request-suggestion')) return Promise.resolve(json({ enabled: false, suggestion: null }));
    if (url.endsWith('/admin/technicians')) return Promise.resolve(json({ technicians: [] }));
    if (url.endsWith('/admin/discounts')) return Promise.resolve(json([]));
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
const callLookups = (fetcher) => fetcher.mock.calls.filter(([u]) => String(u).endsWith('/admin/schedule/new-caller/calls'));

function mount(props = {}) {
  const onCreated = vi.fn();
  render(<CreateAppointmentModal defaultDate={futureDate()} defaultWindowStart="09:00" onClose={vi.fn()} onCreated={onCreated} onChange={vi.fn()} {...props} />);
  fireEvent.click(screen.getByText('+ New customer'));
  return { onCreated };
}

async function addService(term = 'Assessment', name = /Waves Assessment/i) {
  fireEvent.change(await screen.findByPlaceholderText(/^Search (services|to add service)$/), { target: { value: term } });
  fireEvent.click(await screen.findByRole('button', { name }));
}

const firstNameInput = () => {
  const block = screen.getByLabelText('quick-add address').closest('div').parentElement;
  return block.querySelectorAll('input')[0];
};

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete Element.prototype.scrollIntoView;
});

describe('new-caller Book helpers', () => {
  it('blocks two services, a discount and a lot-priced line with no typed price; one plain service books', () => {
    expect(newCallerBookBlockReason({ serviceCount: 2 })).toMatch(/one service/);
    expect(newCallerBookBlockReason({ serviceCount: 1, hasDiscount: true })).toMatch(/Discounts wait/);
    expect(newCallerBookBlockReason({ serviceCount: 1, lotPricedWithoutPrice: true })).toMatch(/priced by lot size/);
    expect(newCallerBookBlockReason({ serviceCount: 1 })).toBe('');
  });

  it('sends the picked address with its coordinates, the one line, the time and the call; Auto sends no technician', () => {
    expect(newCallerRequestBody({
      serviceId: 'svc-a', linePrice: null, durationMinutes: 30, scheduledDate: '2027-01-20T00:00:00', windowStart: '10:00',
      techMode: 'auto', techId: 'tech-9', quickAdd: { address: '100 Example Way Apt 2', city: 'Bradenton', state: 'FL', zip: '34200' },
      quickAddTarget: { lat: 27.5, lng: -82.5 }, callLogId: 'call-1', customerNotes: '', internalNotes: 'Gate code 1234',
    })).toEqual({
      scheduledDate: '2027-01-20', windowStart: '10:00', serviceId: 'svc-a', linePrice: null, durationMinutes: 30, technicianId: null,
      address: { line1: '100 Example Way Apt 2', city: 'Bradenton', state: 'FL', zip: '34200', lat: 27.5, lng: -82.5 },
      callLogId: 'call-1', notes: undefined, internalNotes: 'Gate code 1234', createInvoice: true,
    });
  });

  it('labels a call with its masked number, who answered, the ET start time and whether it is live', () => {
    expect(newCallerCallLabel(CALL)).toBe('•••-0100 · answered by Office · started 10:04 AM · live');
    expect(newCallerCallLabel({ ...CALL_2, live: false })).toBe('•••-0177 · callback · started 10:10 AM · ended');
  });
});

describe('CreateAppointmentModal new-caller Book', () => {
  it('books the visit by address with the one live call, and adds no customer', async () => {
    const fetcher = installFetch();
    const { onCreated } = mount({ newCallerBooking: true });
    fireEvent.click(screen.getByText('pick suggestion'));
    expect(await screen.findByText('This call')).toBeTruthy();
    expect(screen.getByLabelText(/•••-0100 · answered by Office/).checked).toBe(true);
    await addService();
    const book = await screen.findByRole('button', { name: 'Book' });
    await waitFor(() => expect(book.disabled).toBe(false));
    fireEvent.click(book);
    await waitFor(() => expect(posts(fetcher, '/admin/schedule/new-caller')).toHaveLength(1));
    const body = JSON.parse(posts(fetcher, '/admin/schedule/new-caller')[0][1].body);
    expect(body).toMatchObject({
      scheduledDate: futureDate(), windowStart: '09:00', serviceId: 'svc-a', callLogId: 'call-1', technicianId: null,
      address: { line1: '100 Example Way', city: 'Bradenton', state: 'FL', zip: '34200', lat: 27.5, lng: -82.5 },
    });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: 'visit-1', scheduledDate: futureDate() }));
    expect(posts(fetcher, '/admin/customers/quick-add')).toEqual([]);
    expect(posts(fetcher, '/admin/schedule')).toEqual([]);
  });

  it('with two live calls, Book waits until the office picks the call', async () => {
    const fetcher = installFetch({ calls: [CALL, CALL_2] });
    mount({ newCallerBooking: true });
    fireEvent.click(screen.getByText('pick suggestion'));
    expect(await screen.findByText('Pick the call this visit is for')).toBeTruthy();
    await addService();
    const book = await screen.findByRole('button', { name: 'Book' });
    expect(book.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/•••-0177 · callback/));
    await waitFor(() => expect(book.disabled).toBe(false));
    fireEvent.click(book);
    await waitFor(() => expect(posts(fetcher, '/admin/schedule/new-caller')).toHaveLength(1));
    expect(JSON.parse(posts(fetcher, '/admin/schedule/new-caller')[0][1].body).callLogId).toBe('call-2');
  });

  it('with no live call, Book still saves the visit, with no call', async () => {
    const fetcher = installFetch({ calls: [] });
    mount({ newCallerBooking: true });
    fireEvent.click(screen.getByText('pick suggestion'));
    expect(await screen.findByText(/No live call found/)).toBeTruthy();
    await addService();
    const book = await screen.findByRole('button', { name: 'Book' });
    await waitFor(() => expect(book.disabled).toBe(false));
    fireEvent.click(book);
    await waitFor(() => expect(posts(fetcher, '/admin/schedule/new-caller')).toHaveLength(1));
    expect(JSON.parse(posts(fetcher, '/admin/schedule/new-caller')[0][1].body).callLogId).toBeNull();
  });

  it('a failed call lookup is not "no live call": Book stays blocked until Try again loads the calls', async () => {
    const fetcher = installFetch();
    const base = fetcher.getMockImplementation();
    let fail = true;
    fetcher.mockImplementation((input, options) => (String(input).endsWith('/admin/schedule/new-caller/calls') && fail
      ? Promise.reject(new TypeError('Failed to fetch'))
      : base(input, options)));
    mount({ newCallerBooking: true });
    fireEvent.click(screen.getByText('pick suggestion'));
    expect(await screen.findByText(/The calls did not load/)).toBeTruthy();
    await addService();
    expect(screen.getByRole('button', { name: 'Book' }).disabled).toBe(true);
    expect(screen.queryByText(/No live call found/)).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('This call')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Book' }).disabled).toBe(false));
  });

  it('a pending Book keeps every save locked after the form leaves Book mode', async () => {
    const fetcher = installFetch();
    const base = fetcher.getMockImplementation();
    let release;
    fetcher.mockImplementation((input, options = {}) => (String(input).endsWith('/admin/schedule/new-caller') && options.method === 'POST'
      ? new Promise((resolve) => { release = () => resolve(json({ ok: true, id: 'visit-1', scheduledDate: futureDate(), warnings: [] }, { status: 201 })); })
      : base(input, options)));
    // Phone match on: a typed name and phone make the one-Save customer flow ready to save.
    mount({ newCallerBooking: true, newCustomerPhoneMatch: true });
    fireEvent.click(screen.getByText('pick suggestion'));
    await screen.findByText('This call');
    await addService();
    const book = await screen.findByRole('button', { name: 'Book' });
    await waitFor(() => expect(book.disabled).toBe(false));
    fireEvent.click(book);
    await waitFor(() => expect(posts(fetcher, '/admin/schedule/new-caller')).toHaveLength(1));
    const [first, last, phone] = Array.from(screen.getByLabelText('quick-add address').closest('div').parentElement.querySelectorAll('input'));
    fireEvent.change(first, { target: { value: 'Pat' } });
    fireEvent.change(last, { target: { value: 'Example' } });
    fireEvent.change(phone, { target: { value: '941-555-0199' } });
    const pending = screen.getByRole('button', { name: 'Booking…' });
    expect(pending.disabled).toBe(true);
    fireEvent.click(pending);
    expect(posts(fetcher, '/admin/customers/quick-add')).toEqual([]);
    expect(posts(fetcher, '/admin/schedule')).toEqual([]);
    release();
    // Only the pending Book held it: once it settles, the customer flow's save opens.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Schedule appointment' }).disabled).toBe(false));
  });

  it('a repeating service books its first visit only: no Repeats, cadence or booster choice in Book mode', async () => {
    const fetcher = installFetch();
    mount({ newCallerBooking: true });
    fireEvent.click(screen.getByText('pick suggestion'));
    await screen.findByText('This call');
    await addService('Quarterly', /Quarterly Pest Control/i);
    expect(await screen.findByText(/This service repeats\. Book saves the first visit only/)).toBeTruthy();
    expect(screen.getByText('First visit only')).toBeTruthy();
    expect(screen.queryByLabelText(/Repeats for/)).toBeNull();
    expect(screen.queryByText('Booster months (optional)')).toBeNull();
    // Series controls Book ignores stay hidden too: the visit count, its dates preview and the weekend rule.
    expect(screen.queryByText('Visits (leave blank for ongoing)')).toBeNull();
    expect(screen.queryByText(/then auto-extends/)).toBeNull();
    expect(screen.queryByText(/Weekend rule/i)).toBeNull();
    // Book texts nobody: no confirmation choice in Book mode.
    expect(screen.queryByText('Send confirmation SMS')).toBeNull();
    const book = await screen.findByRole('button', { name: 'Book' });
    await waitFor(() => expect(book.disabled).toBe(false));
    fireEvent.click(book);
    await waitFor(() => expect(posts(fetcher, '/admin/schedule/new-caller')).toHaveLength(1));
    expect(JSON.parse(posts(fetcher, '/admin/schedule/new-caller')[0][1].body)).toMatchObject({ serviceId: 'svc-q' });
  });

  it('leaving Book mode brings the Repeats choice back with the service\'s cadence', async () => {
    installFetch();
    mount({ newCallerBooking: true });
    fireEvent.click(screen.getByText('pick suggestion'));
    await screen.findByText('This call');
    await addService('Quarterly', /Quarterly Pest Control/i);
    await screen.findByText('First visit only');
    fireEvent.change(firstNameInput(), { target: { value: 'Pat' } });
    const repeats = await screen.findByLabelText(/Repeats for Quarterly Pest Control/);
    expect(repeats.value).not.toBe('one_time');
    expect(screen.getByText('Visits (leave blank for ongoing)')).toBeTruthy();
    expect(screen.getByText('Send confirmation SMS')).toBeTruthy();
  });

  it('Book stays blocked while Save-with-new-customer is still adding the customer', async () => {
    const fetcher = installFetch();
    const base = fetcher.getMockImplementation();
    let releaseAdd;
    fetcher.mockImplementation((input, options = {}) => (String(input).endsWith('/admin/customers/quick-add') && options.method === 'POST'
      ? new Promise((resolve) => { releaseAdd = () => resolve(json({ customer: { id: 'cust-new' } })); })
      : base(input, options)));
    mount({ newCallerBooking: true, newCustomerPhoneMatch: true });
    fireEvent.click(screen.getByText('pick suggestion'));
    await screen.findByText('This call');
    await addService();
    const [first, last, phone] = Array.from(screen.getByLabelText('quick-add address').closest('div').parentElement.querySelectorAll('input'));
    fireEvent.change(first, { target: { value: 'Pat' } });
    fireEvent.change(last, { target: { value: 'Example' } });
    fireEvent.change(phone, { target: { value: '941-555-0199' } });
    const schedule = await screen.findByRole('button', { name: 'Schedule appointment' });
    await waitFor(() => expect(schedule.disabled).toBe(false));
    fireEvent.click(schedule);
    await waitFor(() => expect(posts(fetcher, '/admin/customers/quick-add')).toHaveLength(1));
    // Staff clears the caller's fields mid-request: Book mode returns, but Book waits for the add.
    for (const input of [first, last, phone]) fireEvent.change(input, { target: { value: '' } });
    const book = await screen.findByRole('button', { name: 'Book' });
    await screen.findByText('This call');
    expect(book.disabled).toBe(true);
    fireEvent.click(book);
    releaseAdd();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Book' })).toBeNull());
    expect(posts(fetcher, '/admin/schedule/new-caller')).toEqual([]);
  });

  it('a Collect prepayment choice made before the address was picked does not carry into Book mode', async () => {
    installFetch();
    mount({ newCallerBooking: true });
    await addService('Quarterly', /Quarterly Pest Control/i);
    fireEvent.change(screen.getByText('Visits (leave blank for ongoing)').parentElement.querySelector('input'), { target: { value: '4' } });
    expect(await screen.findByText('Collect prepayment')).toBeTruthy();
    fireEvent.click(screen.getByText('pick suggestion'));
    await screen.findByText('This call');
    expect(screen.queryByText('Collect prepayment')).toBeNull();
  });

  it('two services stop Book with a reason', async () => {
    installFetch();
    mount({ newCallerBooking: true });
    fireEvent.click(screen.getByText('pick suggestion'));
    await screen.findByText('This call');
    await addService();
    fireEvent.click(screen.getByRole('button', { name: /\+ Add service/i }));
    await addService('Quarterly', /Quarterly Pest Control/i);
    expect(await screen.findByText(/Book saves one service for a new caller/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Book' }).disabled).toBe(true);
  });

  it('typing a name switches back to the customer flow', async () => {
    installFetch();
    mount({ newCallerBooking: true });
    fireEvent.click(screen.getByText('pick suggestion'));
    await screen.findByText('This call');
    fireEvent.change(firstNameInput(), { target: { value: 'Pat' } });
    await waitFor(() => expect(screen.queryByText('This call')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Book' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Schedule appointment' })).toBeTruthy();
  });

  it('gate off: no call lookup and no Book', async () => {
    const fetcher = installFetch();
    mount();
    fireEvent.click(screen.getByText('pick suggestion'));
    await addService();
    expect(callLookups(fetcher)).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Book' })).toBeNull();
    expect(screen.queryByText('This call')).toBeNull();
  });
});
