// @vitest-environment jsdom
// Day-only promise part E: the Edit appointment and Reschedule windows. A moving save shows "Customer asked for this time"
// (pre-filled from the stored choice) and sends customerAskedTime true or false; the "Told: ..." badge reads the feed's `told`.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditServiceModal, RescheduleModal } from './SchedulePage';

vi.mock('../../components/schedule/useSlotConflicts', () => ({ useSlotConflicts: () => ({ conflicts: [] }) }));
vi.mock('../../components/schedule/useBestTimes', () => ({
  useBestTimes: () => ({ pickedByTech: [], availability: undefined }),
}));

const BASE = { reminder24hOn: true, id: 'fixture-visit', customerId: 'fixture-account', customerName: 'Fixture account', serviceType: 'Pest Control', scheduledDate: '2035-01-02', windowStart: '08:00', windowEnd: '09:00', status: 'confirmed', notes: 'Existing note' };

beforeEach(() => {
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('fetch', vi.fn(async (url) => ({ ok: true, json: async () => (String(url).endsWith('/reschedule-options') ? { options: [] } : url.endsWith('/admin/discounts') ? [] : {}) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const saves = () => fetch.mock.calls.filter(([url, options]) => options?.method === 'PUT' && String(url).endsWith('/update-details'));

async function saveEdit({ moveTo } = {}) {
  if (moveTo) fireEvent.change(document.querySelector('input[type="date"]'), { target: { value: moveTo } });
  const save = screen.getByRole('button', { name: 'Save', exact: true });
  await waitFor(() => expect(save).toBeEnabled(), { timeout: 3000 });
  fireEvent.click(save);
  await waitFor(() => expect(saves()).toHaveLength(1));
  return JSON.parse(saves()[0][1].body);
}

describe('Edit appointment', () => {

  it('the box appears only when the save moves the visit, unchecked by default, and sends false', async () => {
    render(<EditServiceModal service={BASE} technicians={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByLabelText('Customer asked for this time')).not.toBeInTheDocument();
    fireEvent.change(document.querySelector('input[type="date"]'), { target: { value: '2035-01-09' } });
    const box = screen.getByLabelText('Customer asked for this time');
    expect(box).not.toBeChecked();
    expect(screen.getByTestId('asked-time-hint')).toHaveTextContent("Promise the day only: 'We'll text your arrival window the day before.'");
    const body = await saveEdit();
    expect(body.customerAskedTime).toBe(false);
  });

  it('the phone script is withheld when the 24-hour reminder will not go out, or the answer is unknown', () => {
    const off = render(<EditServiceModal service={{ ...BASE, reminder24hOn: false }} technicians={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(document.querySelector('input[type="date"]'), { target: { value: '2035-01-09' } });
    expect(screen.getByTestId('asked-time-hint')).toHaveTextContent('Tell the customer this time.');
    off.unmount();
    const { reminder24hOn: _unknown, ...unknown } = BASE;
    render(<EditServiceModal service={unknown} technicians={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(document.querySelector('input[type="date"]'), { target: { value: '2035-01-09' } });
    expect(screen.getByTestId('asked-time-hint')).toHaveTextContent('Tell the customer this time.');
  });

  it('moving the visit inside the 24.25-hour cutoff swaps the script for "Tell the customer this time."', () => {
    render(<EditServiceModal service={BASE} technicians={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(document.querySelector('input[type="date"]'), { target: { value: '2035-01-09' } });
    expect(screen.getByTestId('asked-time-hint')).toHaveTextContent('Promise the day only');
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
    fireEvent.change(document.querySelector('input[type="date"]'), { target: { value: today } });
    expect(screen.getByTestId('asked-time-hint')).toHaveTextContent('Tell the customer this time.');
  });

  describe('a same-date re-time versus a change of date', () => {
    const SCRIPT = "Promise the day only: 'We'll text your arrival window the day before.'";

    it('edit window: changing only the start time (same date) says "Tell the customer this time."; a different date says the day script', () => {
      render(<EditServiceModal service={BASE} technicians={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
      fireEvent.change(document.querySelector('input[type="time"]'), { target: { value: '10:00' } });
      expect(screen.getByLabelText('Customer asked for this time')).toBeInTheDocument();
      expect(screen.getByTestId('asked-time-hint')).toHaveTextContent('Tell the customer this time.');
      fireEvent.change(document.querySelector('input[type="date"]'), { target: { value: '2035-01-09' } });
      expect(screen.getByTestId('asked-time-hint')).toHaveTextContent(SCRIPT);
    });

    describe('reschedule window: every suggested option judges its own slot', () => {
      const option = (date, start) => ({ date, displayDate: `Day ${date}`, suggestedWindow: { start, end: '12:00', display: `${start} window` }, driveMinutes: 5 });
      const todayET = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
      const serve = (options) => vi.stubGlobal('fetch', vi.fn(async (url) => ({ ok: true, json: async () => (String(url).endsWith('/reschedule-options') ? { options } : {}) })));
      const hints = async () => {
        await waitFor(() => expect(screen.queryAllByTestId('option-hint').length).toBeGreaterThan(0));
        return screen.getAllByTestId('option-hint').map((node) => node.textContent);
      };

      it('a same-date option and a later-date option show different lines', async () => {
        serve([option('2035-01-02', '10:00'), option('2035-01-09', '09:00')]);
        render(<RescheduleModal service={BASE} onClose={vi.fn()} onRescheduled={vi.fn()} />);
        expect(await hints()).toEqual(['Tell the customer this time.', SCRIPT]);
        // No window-level line that could contradict an option's own.
        expect(screen.queryByTestId('asked-time-hint')).toBeNull();
      });

      it('an option inside the 24.25-hour cutoff shows the second line', async () => {
        serve([option(todayET(), '23:00'), option('2035-01-09', '09:00')]);
        render(<RescheduleModal service={BASE} onClose={vi.fn()} onRescheduled={vi.fn()} />);
        expect(await hints()).toEqual(['Tell the customer this time.', SCRIPT]);
      });

      it('reminders off or unknown: every option shows the second line', async () => {
        serve([option('2035-01-09', '09:00'), option('2035-01-10', '09:00')]);
        render(<RescheduleModal service={{ ...BASE, reminder24hOn: false }} onClose={vi.fn()} onRescheduled={vi.fn()} />);
        expect(await hints()).toEqual(['Tell the customer this time.', 'Tell the customer this time.']);
      });

      it('a checked box makes every option show the second line', async () => {
        serve([option('2035-01-09', '09:00'), option('2035-01-10', '09:00')]);
        render(<RescheduleModal service={BASE} onClose={vi.fn()} onRescheduled={vi.fn()} />);
        expect(await hints()).toEqual([SCRIPT, SCRIPT]);
        fireEvent.click(screen.getByLabelText('Customer asked for this time'));
        expect(await hints()).toEqual(['Tell the customer this time.', 'Tell the customer this time.']);
      });

      it('the custom picker has its own line that follows the manual slot', async () => {
        serve([option('2035-01-09', '09:00')]);
        render(<RescheduleModal service={BASE} onClose={vi.fn()} onRescheduled={vi.fn()} />);
        await hints();
        fireEvent.click(screen.getByRole('button', { name: /Pick Custom Date/ }));
        fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2035-01-02' } }); // the visit's own date
        expect(screen.getByTestId('asked-time-hint')).toHaveTextContent('Tell the customer this time.');
        fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2035-01-09' } });
        expect(screen.getByTestId('asked-time-hint')).toHaveTextContent(SCRIPT);
        // The options keep their own lines meanwhile.
        expect(screen.getAllByTestId('option-hint').map((node) => node.textContent)).toEqual([SCRIPT]);
      });

    });
  });

  describe('changing the service address in the same save', () => {
    const SCRIPT = "Promise the day only: 'We'll text your arrival window the day before.'";
    const PROPERTIES = [
      { id: 'p-home', label: 'Home', address_line1: '1 Fixture Way' },
      { id: 'p-off', label: 'Rental', address_line1: '2 Fixture Way' },
      { id: 'p-on', label: 'Lake house', address_line1: '3 Fixture Way' },
    ];
    let estimatesGate = {};

    function installAddressFetch({ estimates = { reminder24hOn: true, reminder24hByProperty: { 'p-off': false, 'p-on': true } } } = {}) {
      let release;
      estimatesGate = new Promise((resolve) => { release = resolve; });
      estimatesGate.release = release;
      vi.stubGlobal('fetch', vi.fn(async (url) => {
        const u = String(url);
        if (u.includes('/properties?context=appointment_address')) return { ok: true, json: async () => ({ properties: PROPERTIES }) };
        if (u.includes('/schedule-estimates')) { await estimatesGate; return { ok: true, json: async () => ({ estimates: [], ...estimates }) }; }
        return { ok: true, json: async () => (u.endsWith('/reschedule-options') ? { options: [] } : u.endsWith('/admin/discounts') ? [] : {}) };
      }));
    }

    async function openAndMove(service) {
      render(<EditServiceModal service={service} technicians={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
      fireEvent.change(document.querySelector('input[type="date"]'), { target: { value: '2035-01-09' } });
      return screen.findByLabelText('Service address');
    }

    it('to a property with reminders off: "Tell the customer this time."', async () => {
      installAddressFetch();
      const select = await openAndMove({ ...BASE, propertyId: 'p-home' });
      expect(screen.getByTestId('asked-time-hint')).toHaveTextContent(SCRIPT);
      fireEvent.change(select, { target: { value: 'p-off' } });
      estimatesGate.release();
      await waitFor(() => expect(fetch.mock.calls.some(([u]) => String(u).includes('/schedule-estimates'))).toBe(true));
      await waitFor(() => expect(screen.getByTestId('asked-time-hint')).toHaveTextContent('Tell the customer this time.'));
    });

    it('to a property with reminders on: the day script; and while the answer loads, the second line', async () => {
      installAddressFetch({ estimates: { reminder24hOn: false, reminder24hByProperty: { 'p-on': true } } });
      const select = await openAndMove({ ...BASE, propertyId: 'p-home' });
      fireEvent.change(select, { target: { value: 'p-on' } });
      // The reply is held back: the answer is unknown, so the hint tells staff to name the time.
      expect(screen.getByTestId('asked-time-hint')).toHaveTextContent('Tell the customer this time.');
      estimatesGate.release();
      await waitFor(() => expect(screen.getByTestId('asked-time-hint')).toHaveTextContent(SCRIPT));
    });

    it('an unlisted or primary property reads the customer row; choosing the current property again reads no reply', async () => {
      installAddressFetch({ estimates: { reminder24hOn: true, reminder24hByProperty: {} } });
      const select = await openAndMove({ ...BASE, propertyId: 'p-home', reminder24hOn: false });
      fireEvent.change(select, { target: { value: 'p-home' } });
      expect(fetch.mock.calls.some(([u]) => String(u).includes('/schedule-estimates'))).toBe(false);
      expect(screen.getByTestId('asked-time-hint')).toHaveTextContent('Tell the customer this time.');
      fireEvent.change(select, { target: { value: 'p-off' } });
      estimatesGate.release();
      await waitFor(() => expect(screen.getByTestId('asked-time-hint')).toHaveTextContent(SCRIPT));
    });

  });

  it('pre-filled from the visit (true = checked), the hint changes, and the save sends true', async () => {
    render(<EditServiceModal service={{ ...BASE, customerAskedTime: true }} technicians={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(document.querySelector('input[type="date"]'), { target: { value: '2035-01-09' } });
    expect(screen.getByLabelText('Customer asked for this time')).toBeChecked();
    expect(screen.getByTestId('asked-time-hint')).toHaveTextContent('Tell the customer this time.');
    const body = await saveEdit();
    expect(body.customerAskedTime).toBe(true);
  });

  it('a save that does not move the visit sends no field', async () => {
    render(<EditServiceModal service={{ ...BASE, customerAskedTime: true }} technicians={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
    const body = await saveEdit();
    expect(body).not.toHaveProperty('customerAskedTime');
  });

  it('the badge reads "Told: day only" for level day, the promised window for level hour, nothing for none', () => {
    const day = render(<EditServiceModal service={{ ...BASE, told: { level: 'day', dayOnly: true } }} technicians={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByTestId('told-badge')).toHaveTextContent('Told: day only');
    day.unmount();
    const hour = render(<EditServiceModal service={{ ...BASE, told: { level: 'hour', dayOnly: false, date: '2035-01-02', window: '8:00 AM - 10:00 AM' } }} technicians={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByTestId('told-badge')).toHaveTextContent('Told: 8:00 AM - 10:00 AM');
    hour.unmount();
    render(<EditServiceModal service={{ ...BASE, told: { level: 'none', dayOnly: false } }} technicians={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByTestId('told-badge')).not.toBeInTheDocument();
  });
});

describe('Reschedule', () => {
  const moveCustom = async () => {
    fireEvent.click(screen.getByRole('button', { name: /Pick Custom Date/ }));
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2035-01-09' } });
    fireEvent.change(screen.getByLabelText('Start Time'), { target: { value: '10:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reschedule', exact: true }));
    await waitFor(() => expect(fetch.mock.calls.some(([, o]) => o?.method === 'POST')).toBe(true));
    return fetch.mock.calls.find(([, o]) => o?.method === 'POST')[1].body;
  };

  it('the box starts unchecked, sends false, and a checked box sends true', async () => {
    const first = render(<RescheduleModal service={BASE} onClose={vi.fn()} onRescheduled={vi.fn()} />);
    expect(screen.getByLabelText('Customer asked for this time')).not.toBeChecked();
    expect(JSON.parse(await moveCustom()).customerAskedTime).toBe(false);
    first.unmount();
    fetch.mockClear();
    render(<RescheduleModal service={BASE} onClose={vi.fn()} onRescheduled={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Customer asked for this time'));
    const raw = await moveCustom();
    // The custom picker's line (the picker is open now): a checked box says to name the time.
    expect(screen.getByTestId('asked-time-hint')).toHaveTextContent('Tell the customer this time.');
    expect(JSON.parse(raw).customerAskedTime).toBe(true);
  });

  it('pre-filled from the visit and shows the Told badge', () => {
    render(<RescheduleModal service={{ ...BASE, customerAskedTime: true, told: { level: 'day', dayOnly: true } }} onClose={vi.fn()} onRescheduled={vi.fn()} />);
    expect(screen.getByLabelText('Customer asked for this time')).toBeChecked();
    expect(within(screen.getByRole('dialog', { name: 'Reschedule service' })).getByTestId('told-badge')).toHaveTextContent('Told: day only');
  });
});
