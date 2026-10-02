// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import AvailabilityStrip, { availabilityVerdict, stripCoversRouteWarning, drivePhrase, fmtHour } from './AvailabilityStrip';

afterEach(cleanup);

// Far-future fixture dates: the strip says "Today" for the ET date.
const hour = (date, start, detourMinutes, over = {}) => ({
  date, start, end: `${String(Number(start.slice(0, 2)) + 1).padStart(2, '0')}:00`, detourMinutes,
  technicianId: 't1', technicianName: null, ...over,
});
const DAYS = [
  { date: '2035-01-01', status: 'open', hours: [hour('2035-01-01', '10:00', 9)] },
  { date: '2035-01-02', status: 'open', hours: [hour('2035-01-02', '09:00', 11), hour('2035-01-02', '11:00', 5), hour('2035-01-02', '16:00', 20)] },
  { date: '2035-01-03', status: 'overcommitted', hours: [] },
  { date: '2035-01-04', status: 'open', hours: [hour('2035-01-04', '13:00', 2), hour('2035-01-04', '09:00', 7)] },
  { date: '2035-01-05', status: 'unverified', hours: [] },
];
const answer = (picked, days = DAYS) => ({ pickedDate: '2035-01-02', days, picked });
const at = (currentDate, currentStart) => ({ currentDate, currentStart });
const starts = (verdict) => verdict.offers.map((h) => `${h.date.slice(8)} ${h.start}`);

describe('labels', () => {
  it('prints the added drive, "no added drive" for zero, and nothing for an unpriced route', () => {
    expect(drivePhrase(11.4)).toBe('+11 min drive');
    expect(drivePhrase(0)).toBe('no added drive');
    expect(drivePhrase(null)).toBeNull();
  });
  it('drops :00 from on-the-hour times', () => {
    expect(fmtHour('14:00')).toBe('2 PM');
    expect(fmtHour('09:15:00')).toBe('9:15 AM');
  });
});

describe('availabilityVerdict', () => {
  it('fits: says so with the added drive and offers the other hours that day, cheapest first', () => {
    const v = availabilityVerdict(answer({ start: '09:00', fits: true, reason: null, detourMinutes: 11 }), at('2035-01-02', '09:00'));
    expect(v).toMatchObject({ tone: 'ok', text: 'Tue Jan 2 · 9 AM fits.', detail: '+11 min drive.', lead: 'Also open that day:', withDay: false });
    expect(starts(v)).toEqual(['02 11:00', '02 16:00']);
  });

  it('window missed: a verified miss, offering the hours that do fit that day', () => {
    const v = availabilityVerdict(answer({ start: '14:00', fits: false, reason: 'arrival_window', detourMinutes: null }), at('2035-01-02', '14:00'));
    expect(v).toMatchObject({ tone: 'miss', text: "2 PM Tue Jan 2 doesn't fit.", detail: "Another stop's arrival window would be missed.", lead: 'Open that day:' });
    expect(starts(v)).toEqual(['02 11:00', '02 09:00', '02 16:00']);
  });

  it('over-booked day: nothing that day, so the closest days are offered with their dates', () => {
    const v = availabilityVerdict(answer({ start: '10:00', fits: false, reason: 'day_overcommitted', detourMinutes: null }), at('2035-01-03', '10:00'));
    expect(v).toMatchObject({ tone: 'miss', text: 'Wed Jan 3 is already over-booked', lead: 'Closest:', withDay: true });
    // One day away on both sides: the later day first, cheapest hours first.
    expect(starts(v)).toEqual(['04 13:00', '04 09:00', '02 11:00']);
  });

  it('past the workday: offers the earlier hours that day', () => {
    const v = availabilityVerdict(answer({ start: '17:00', fits: false, reason: 'return_time', detourMinutes: null }), at('2035-01-02', '17:00'));
    expect(v).toMatchObject({ tone: 'miss', lead: 'Earlier that day:' });
    expect(starts(v)).toEqual(['02 09:00', '02 11:00', '02 16:00']);
  });

  it('already booked is a warning, not a route miss', () => {
    const v = availabilityVerdict(answer({ start: '13:00', fits: false, reason: 'occupied', detourMinutes: null }), at('2035-01-02', '13:00'));
    expect(v).toMatchObject({ tone: 'warn', text: '1 PM Tue Jan 2 is already booked.' });
  });

  it('could not check is never a miss: unverified route, no technician, off-hour', () => {
    const unverified = availabilityVerdict(answer({ start: '10:00', fits: null, reason: 'route_unverified', detourMinutes: null }), at('2035-01-05', '10:00'));
    expect(unverified).toMatchObject({ tone: 'warn', text: "Can't check the route on Fri Jan 5.", lead: 'Checked nearby:', withDay: true });
    expect(starts(unverified)).toEqual(['04 13:00', '04 09:00', '02 11:00']);
    expect(availabilityVerdict(answer({ start: '09:00', fits: null, reason: 'no_technician', detourMinutes: null }), at('2035-01-02', '09:00')))
      .toMatchObject({ tone: 'warn', text: 'Pick a technician to check this hour.' });
    expect(availabilityVerdict(answer({ start: '09:15', fits: null, reason: 'not_checkable', detourMinutes: null }), at('2035-01-02', '09:15')))
      .toMatchObject({ tone: 'warn', text: "9:15 AM can't be checked." });
  });

  it('a verdict scored for a different hour is ignored until the next answer', () => {
    const stale = answer({ start: '14:00', fits: false, reason: 'arrival_window', detourMinutes: null });
    expect(availabilityVerdict(stale, at('2035-01-02', '11:00'))).toMatchObject({ tone: 'ok', text: 'Open Tue Jan 2:' });
  });

  it('no verdict at all (unassigned visit): states what the day has', () => {
    expect(availabilityVerdict(answer(null), at('2035-01-02', '09:00'))).toMatchObject({ tone: 'ok', text: 'Open Tue Jan 2:' });
    expect(availabilityVerdict(answer(null), at('2035-01-03', '09:00'))).toMatchObject({ tone: 'miss', text: 'Wed Jan 3 is already over-booked.' });
    expect(availabilityVerdict(answer(null), at('2035-01-05', '09:00'))).toMatchObject({ tone: 'warn' });
    expect(availabilityVerdict(null, at('2035-01-02', '09:00'))).toBeNull();
  });

  it('stripCoversRouteWarning only when the strip itself states a problem', () => {
    expect(stripCoversRouteWarning(null, at('2035-01-02', '09:00'))).toBe(false);
    expect(stripCoversRouteWarning(answer({ start: '09:00', fits: true, reason: null, detourMinutes: 1 }), at('2035-01-02', '09:00'))).toBe(false);
    expect(stripCoversRouteWarning(answer({ start: '14:00', fits: false, reason: 'arrival_window', detourMinutes: null }), at('2035-01-02', '14:00'))).toBe(true);
  });
});

describe('AvailabilityStrip', () => {
  const missed = answer({ start: '14:00', fits: false, reason: 'arrival_window', detourMinutes: null });

  it('renders nothing without an answer', () => {
    const { container } = render(<AvailabilityStrip availability={null} currentDate="2035-01-02" currentStart="14:00" />);
    expect(container.firstChild).toBeNull();
  });

  it('an offered hour fills the fields through onPick, with its added drive on the chip', () => {
    const onPick = vi.fn();
    render(<AvailabilityStrip availability={missed} currentDate="2035-01-02" currentStart="14:00" onPick={onPick} />);
    expect(screen.getByRole('status').getAttribute('data-tone')).toBe('miss');
    const chip = screen.getAllByTestId('availability-hour')[0];
    expect(chip.textContent).toBe('11 AM+5 min drive');
    fireEvent.click(chip);
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ date: '2035-01-02', start: '11:00', end: '12:00', technicianId: 't1' }));
  });

  it('day pills count open hours, mark full and unchecked days, and browse another day', () => {
    const onPick = vi.fn();
    render(<AvailabilityStrip availability={missed} currentDate="2035-01-02" currentStart="14:00" onPick={onPick} />);
    const pills = screen.getAllByTestId('availability-day');
    expect(pills.map((p) => p.textContent)).toEqual(['Mon11 open', 'Tue23 open', 'Wed3full', 'Thu42 open', 'Fri5unchecked']);
    expect(pills[1].getAttribute('aria-selected')).toBe('true');
    fireEvent.click(pills[3]);
    expect(screen.getAllByTestId('availability-day')[3].getAttribute('aria-selected')).toBe('true');
    const thursday = screen.getAllByTestId('availability-hour').filter((c) => /^(9 AM|1 PM)/.test(c.textContent));
    fireEvent.click(thursday.find((c) => c.textContent.startsWith('1 PM')));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ date: '2035-01-04', start: '13:00' }));
    fireEvent.click(screen.getAllByTestId('availability-day')[2]);
    expect(screen.getByText('Wed Jan 3: no hour fits.')).toBeTruthy();
  });

  it('the hour already in the fields is shown pressed, not offered again', () => {
    const fits = answer({ start: '09:00', fits: true, reason: null, detourMinutes: 11 });
    render(<AvailabilityStrip availability={fits} currentDate="2035-01-02" currentStart="09:00:00" currentTechnicianId="t1" onPick={() => {}} />);
    const current = screen.getAllByTestId('availability-hour').filter((c) => c.getAttribute('aria-pressed') === 'true');
    expect(current).toHaveLength(1);
    expect(current[0].disabled).toBe(true);
  });

  it('an unassigned visit can still take its own hour, adopting the technician it was scored for', () => {
    const fits = answer({ start: '09:00', fits: true, reason: null, detourMinutes: 11 });
    const onPick = vi.fn();
    render(<AvailabilityStrip availability={fits} currentDate="2035-01-02" currentStart="09:00" currentTechnicianId={null} onPick={onPick} />);
    const chips = screen.getAllByTestId('availability-hour');
    expect(chips.filter((c) => c.getAttribute('aria-pressed') === 'true')).toHaveLength(0);
    const nine = chips.find((c) => c.textContent.startsWith('9 AM'));
    expect(nine.disabled).toBe(false);
    fireEvent.click(nine);
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ date: '2035-01-02', start: '09:00', technicianId: 't1' }));
  });

  it('names the technician on an all-technician search', () => {
    const days = [{ date: '2035-01-02', status: 'open', hours: [hour('2035-01-02', '09:00', 0, { technicianName: 'Fixture Tech' })] }];
    render(<AvailabilityStrip availability={answer(null, days)} currentDate="2035-01-02" currentStart="12:00" onPick={() => {}} />);
    expect(screen.getAllByTestId('availability-hour')[0].textContent).toBe('9 AMno added drive · Fixture Tech');
  });
});
