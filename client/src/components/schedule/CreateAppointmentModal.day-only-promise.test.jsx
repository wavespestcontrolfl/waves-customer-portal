// @vitest-environment jsdom
/**
 * GATE_DAY_ONLY_PROMISE part E: New Appointment shows "Customer asked for this time" under the time picker only while the
 * gate is on (flag `day_only_promise`); a checked box adds customerAskedTime: true to the create request, and with the gate
 * off (or the box unchecked) the request body has no such field.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDiscountStackingState } from '../../hooks/useDiscountStacking';

const gate = vi.hoisted(() => ({ on: false }));
vi.mock('../../hooks/useFeatureFlag', async (importOriginal) => ({
  ...(await importOriginal()),
  useFeatureFlag: (key) => key === 'day_only_promise' && gate.on,
}));
vi.mock('../../hooks/useDiscountStacking', () => ({
  useDiscountStackingState: vi.fn(() => ({ enabled: false, known: true, retry: vi.fn() })),
  ensureStackingFresh: vi.fn(async () => ({ enabled: true, known: true })),
}));
import CreateAppointmentModal from './CreateAppointmentModal.jsx';

beforeEach(() => { gate.on = false; });
afterEach(() => {
  cleanup();
  vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: false, known: true, retry: vi.fn() });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const json = (body, { ok = true, status = 200 } = {}) => ({ ok, status, json: vi.fn(async () => body) });
const CUSTOMER = { id: 'customer-a', firstName: 'Ada', lastName: 'Lovelace' };

function futureDate(days = 30) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

function installFetch({ serviceKey = 'pest_re_service', serviceName = 'Pest Re-Service', services: catalog = null, probe = { enabled: false, suggestion: null }, probeFails = false, reminder24hOn = true, omitReminder = false } = {}) {
  const fetcher = vi.fn((input, options = {}) => {
    const url = String(input);
    if (url.includes('/admin/triage?')) return Promise.resolve(json({ items: [] }));
    if (url.includes('/admin/services?')) {
      if (catalog) {
        const q = (new URL(url, 'http://test').searchParams.get('search') || '').toLowerCase();
        return Promise.resolve(json({ services: catalog.filter((c) => c.name.toLowerCase().includes(q)) }));
      }
      return Promise.resolve(json({ services: [{ id: 'svc-1', service_key: serviceKey, name: serviceName, billing_type: 'one_time', base_price: 0, default_duration_minutes: 30 }] }));
    }
    if (url.includes('/reservice-request-suggestion')) {
      return probeFails ? Promise.reject(new Error('boom')) : Promise.resolve(json(probe));
    }
    if (url.endsWith('/admin/schedule') && options.method === 'POST') return Promise.resolve(json({ id: 'appt-1' }));
    if (url.includes('/properties?context=appointment_address')) return Promise.resolve(json({ properties: [], canChangeAppointmentAddress: false }));
    if (url.includes('/schedule-estimates')) return Promise.resolve(json({ estimates: [], ...(omitReminder ? {} : { reminder24hOn }) }));
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

async function mountWithService(query = 'Re-Service') {
  render(<CreateAppointmentModal
    defaultCustomer={CUSTOMER}
    defaultDate={futureDate()}
    defaultWindowStart="09:00"
    onClose={vi.fn()}
    onCreated={vi.fn()}
    onChange={vi.fn()}
  />);
  fireEvent.change(screen.getByPlaceholderText('Search services'), { target: { value: query } });
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(query, 'i') }));
}

const schedulePosts = (fetcher) => fetcher.mock.calls.filter(([u, o]) => String(u).endsWith('/admin/schedule') && o?.method === 'POST');

const BOX = 'Customer asked for this time';
const hint = () => screen.getByTestId('asked-time-hint');

describe('the New Appointment time picker', () => {
  it('gate off: no box, no hint, and the create body has no customerAskedTime', async () => {
    const fetcher = installFetch();
    await mountWithService();
    expect(screen.queryByLabelText(BOX)).toBeNull();
    expect(screen.queryByTestId('asked-time-hint')).toBeNull();
    const submit = screen.getByRole('button', { name: 'Schedule appointment' });
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(1));
    expect(JSON.parse(schedulePosts(fetcher)[0][1].body)).not.toHaveProperty('customerAskedTime');
  });

  it('gate on: the box starts unchecked with the phone-script line; an unchecked box sends no field', async () => {
    gate.on = true;
    const fetcher = installFetch();
    await mountWithService();
    const box = await screen.findByLabelText(BOX);
    expect(box.checked).toBe(false);
    await waitFor(() => expect(hint().textContent).toBe("Promise the day only: 'We'll text your arrival window the day before.'"));
    const submit = screen.getByRole('button', { name: 'Schedule appointment' });
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(1));
    expect(JSON.parse(schedulePosts(fetcher)[0][1].body)).not.toHaveProperty('customerAskedTime');
  });

  it('gate on: the phone script shows only while the day-only promise can be made (reminder on, slot beyond 24.25 h)', async () => {
    gate.on = true;
    installFetch({ reminder24hOn: false });
    await mountWithService();
    await screen.findByLabelText(BOX);
    // The customer's 24-hour reminder will not go out: the window text never comes, so the script is withheld.
    await waitFor(() => expect(hint().textContent).toBe('Tell the customer this time.'));
  });

  it('gate on: an unknown reminder answer reads as "will not go out" (the senders\' answer for unreadable preferences)', async () => {
    gate.on = true;
    installFetch({ omitReminder: true });
    await mountWithService();
    await screen.findByLabelText(BOX);
    expect(hint().textContent).toBe('Tell the customer this time.');
  });

  it('gate on: a slot inside the 24.25-hour cutoff gets "Tell the customer this time."', async () => {
    gate.on = true;
    installFetch();
    await mountWithService();
    await waitFor(() => expect(hint().textContent).toContain('Promise the day only'));
    const soon = new Date();
    const today = [soon.getFullYear(), String(soon.getMonth() + 1).padStart(2, '0'), String(soon.getDate()).padStart(2, '0')].join('-');
    fireEvent.change(document.getElementById('new-appt-date'), { target: { value: today } });
    expect(hint().textContent).toBe('Tell the customer this time.');
  });

  it('gate on: a checked box swaps the line for "Tell the customer this time." and sends customerAskedTime: true', async () => {
    gate.on = true;
    const fetcher = installFetch();
    await mountWithService();
    fireEvent.click(await screen.findByLabelText(BOX));
    expect(hint().textContent).toBe('Tell the customer this time.');
    const submit = screen.getByRole('button', { name: 'Schedule appointment' });
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(1));
    expect(JSON.parse(schedulePosts(fetcher)[0][1].body).customerAskedTime).toBe(true);
  });
});
