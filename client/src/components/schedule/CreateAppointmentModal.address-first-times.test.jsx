// @vitest-environment jsdom
// GATE_NEW_APPT_ADDRESS_TIMES (owner 2026-10-24): a new caller's picked address alone answers
// the time box, on a 30-minute search until a service sets the length; a chip fills the day
// and hour. Gate off: no customer, no search.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { etDateString } from '../../lib/timezone';
import { resetHintsGated } from './useBestTimes';

vi.mock('../AddressAutocomplete', () => ({
  default: ({ value, onSelect }) => (
    <>
      <input aria-label="quick-add address" value={value} readOnly />
      <button type="button" onClick={() => onSelect({ formatted: '100 Example Way, Bradenton, FL 34200', line1: '100 Example Way', city: 'Bradenton', state: 'FL', zip: '34200', lat: 27.5, lng: -82.5 })}>pick suggestion</button>
    </>
  ),
}));
vi.mock('../../hooks/useDiscountStacking', () => ({
  useDiscountStackingState: vi.fn(() => ({ enabled: false, known: true, retry: vi.fn() })),
  ensureStackingFresh: vi.fn(async () => ({ enabled: true, known: true })),
}));
import CreateAppointmentModal from './CreateAppointmentModal.jsx';

const today = etDateString();
const slot = (date, start) => ({
  date, start_time: start, end_time: '10:30', detour_minutes: 9, drive_in_minutes: 6, rain_chance: 10,
  technician: { id: 'tech-9', name: 'Example Tech' },
});

let fetcher;
beforeEach(() => {
  resetHintsGated();
  fetcher = vi.fn(async (url) => ({
    ok: true,
    status: 200,
    json: async () => {
      if (String(url).includes('/find-time')) {
        return { ok: true, slots: [], summary: { days: [{ date: today, status: 'open', hours: [slot(today, '10:00')] }], best: { day: [slot(today, '10:00')], week: [], week_covered: true } } };
      }
      if (String(url).includes('/customers/quick-add')) {
        return { customer: { id: 'cust-1', firstName: 'Pat', lastName: 'Example', phone: '9415550100', address: '100 Example Way', city: 'Bradenton', state: 'FL', zip: '34200' } };
      }
      return {};
    },
  }));
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const findTimeBodies = () => fetcher.mock.calls
  .filter(([url]) => String(url).includes('/find-time'))
  .map(([, options]) => JSON.parse(options.body));

const renderModal = (props = {}) => render(
  <MemoryRouter>
    <CreateAppointmentModal defaultDate={today} defaultWindowStart="13:00" onClose={vi.fn()} onCreated={vi.fn()} {...props} />
  </MemoryRouter>,
);

const pickAddress = () => {
  fireEvent.click(screen.getByText('+ New customer'));
  fireEvent.click(screen.getByText('pick suggestion'));
};

describe('CreateAppointmentModal address-first best times', () => {
  it('searches on the picked address alone, 30 minutes, and a chip fills the day and hour', async () => {
    renderModal({ addressFirstTimes: true });
    pickAddress();
    const chips = await screen.findAllByTestId('availability-hour');
    const [body] = findTimeBodies();
    expect(body.customerId ?? null).toBeNull();
    expect(body.lat).toBe(27.5);
    expect(body.lng).toBe(-82.5);
    expect(body.durationMinutes).toBe(30);
    fireEvent.click(chips[0]);
    // The Time select (its options carry HH:MM values) now holds the chip's hour.
    await waitFor(() => expect(Array.from(document.querySelectorAll('select')).some((el) => el.value === '10:00')).toBe(true));
    // No service is known yet, so the chip's technician is NOT pinned: the
    // re-check after the pick is still an all-technician search.
    await waitFor(() => expect(findTimeBodies().length).toBeGreaterThan(1));
    expect(findTimeBodies().at(-1).technicianId ?? null).toBeNull();
    // Still nothing written: no customer, no visit.
    // (find-time and the dispatch slot-check are read-only POSTs.)
    const writes = fetcher.mock.calls.map(([url, o]) => [String(url), o?.method]).filter(([url, m]) => m === 'POST' && !/\/find-time|\/slot-check/.test(url));
    expect(writes).toEqual([]);
  });

  it('searches nothing before a suggestion is picked, and drops the answer when the address is edited by hand', async () => {
    renderModal({ addressFirstTimes: true });
    fireEvent.click(screen.getByText('+ New customer'));
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    expect(findTimeBodies()).toEqual([]);
    fireEvent.click(screen.getByText('pick suggestion'));
    await screen.findAllByTestId('availability-hour');
    fireEvent.change(screen.getByDisplayValue('34200'), { target: { value: '34201' } });
    await waitFor(() => expect(screen.queryAllByTestId('availability-hour')).toEqual([]));
  });

  it('collapsing the New customer block drops the chips for its address', async () => {
    renderModal({ addressFirstTimes: true });
    pickAddress();
    await screen.findAllByTestId('availability-hour');
    fireEvent.click(screen.getByText('+ New customer'));
    await waitFor(() => expect(screen.queryAllByTestId('availability-hour')).toEqual([]));
  });

  it('after Add customer, a reopened blank New customer block does not search the created customer\'s address (Codex #6655 r1)', async () => {
    renderModal({ addressFirstTimes: true });
    pickAddress();
    await screen.findAllByTestId('availability-hour');
    const block = screen.getByRole('button', { name: 'Add customer' }).parentElement;
    const [first, last, phone] = Array.from(block.querySelectorAll('input'));
    fireEvent.change(first, { target: { value: 'Pat' } });
    fireEvent.change(last, { target: { value: 'Example' } });
    fireEvent.change(phone, { target: { value: '9415550100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add customer' }));
    await screen.findByLabelText('Clear selected customer');
    const searchesBefore = findTimeBodies().length;
    fireEvent.click(screen.getByLabelText('Clear selected customer'));
    fireEvent.click(screen.getByText('+ New customer'));
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    expect(findTimeBodies().slice(searchesBefore).filter((b) => b.lat === 27.5)).toEqual([]);
    expect(screen.queryAllByTestId('availability-hour')).toEqual([]);
  });

  it('shows no per-technician rows for the typed hour until a customer exists, so none is pinned before a service is known', async () => {
    // Auto mode prices the typed hour on every technician's route
    // (compareTechs) and offers a "Use" row for each, which pins that technician.
    const base = fetcher.getMockImplementation();
    fetcher.mockImplementation(async (url, options) => {
      const res = await base(url, options);
      if (!String(url).includes('/find-time')) return res;
      const data = await res.json();
      return { ...res, json: async () => ({ ...data, pickedByTech: [{ start: '13:00', fits: true, detour_minutes: 9, drive_in_minutes: 6, technician: { id: 'tech-9', name: 'Example Tech' } }] }) };
    });
    renderModal({ addressFirstTimes: true });
    pickAddress();
    await screen.findAllByTestId('availability-hour');
    expect(findTimeBodies().at(-1).compareTechs).toBe(true);
    expect(screen.queryByRole('region', { name: 'Technicians free at this hour' })).toBeNull();
    // Add customer creates and selects the customer: the rows come back.
    const block = screen.getByRole('button', { name: 'Add customer' }).parentElement;
    const [first, last, phone] = Array.from(block.querySelectorAll('input'));
    fireEvent.change(first, { target: { value: 'Pat' } });
    fireEvent.change(last, { target: { value: 'Example' } });
    fireEvent.change(phone, { target: { value: '9415550100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add customer' }));
    expect(await screen.findByRole('region', { name: 'Technicians free at this hour' })).toBeTruthy();
  });

  it('gate off: a picked address with no customer searches nothing', async () => {
    renderModal();
    pickAddress();
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    expect(findTimeBodies()).toEqual([]);
    expect(screen.queryAllByTestId('availability-hour')).toEqual([]);
  });
});
