// @vitest-environment jsdom
// The open-times box (owner 2026-10-25, layout A): only open times, 15 dates,
// Best / Soonest, parts of the day, the Date field searches, tech pick.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import OpenTimesBox, { addsPhrase, openTimesRows } from './OpenTimesBox';
import AvailabilityStrip, { availabilityVerdict, stripCoversRouteWarning } from './AvailabilityStrip';

afterEach(cleanup);

const ADAM = { technicianId: 't1', technicianName: 'Fixture Tech' };
const NEW = { technicianId: 't2', technicianName: 'Second Fixture' };
const hour = (date, start, detourMinutes, over = {}) => ({
  date, start, end: `${String(Number(start.slice(0, 2)) + 1).padStart(2, '0')}:00`, detourMinutes,
  driveSource: null, rainTier: null, ...ADAM, ...over,
});
const day = (date, hours, over = {}) => ({ date, status: hours.length ? 'open' : 'full', hours, ...over });
// Far-future fixture dates (Mon Jan 1 2035 onward).
const DAYS = [
  day('2035-01-01', [hour('2035-01-01', '09:00', 12), hour('2035-01-01', '14:00', 7)]),
  day('2035-01-02', [hour('2035-01-02', '08:00', 3)]),
  day('2035-01-03', []),
  day('2035-01-04', [hour('2035-01-04', '17:00', 41)]),
  day('2035-01-05', [hour('2035-01-05', '10:00', 3)]),
  day('2035-01-07', [hour('2035-01-07', '10:00', 1)], { closed: true }),
];
const answer = (days = DAYS, over = {}) => ({ openTimes: { from: '2035-01-01', to: '2035-01-28' }, days, best: null, picked: null, ...over });
const rowTexts = () => screen.queryAllByTestId('open-time-row').map((row) => row.textContent);

describe('openTimesRows', () => {
  it('Best: the best hour of each date, least added drive first, the sooner date on a tie', () => {
    const { rows } = openTimesRows(DAYS, { mode: 'best', band: 'any', techId: '', focusDate: null });
    expect(rows.map((h) => `${h.date.slice(8)} ${h.start}`)).toEqual(['02 08:00', '05 10:00', '01 14:00', '04 17:00']);
  });
  it('Soonest: the same rows in date order; a closed day never lists', () => {
    const { rows } = openTimesRows(DAYS, { mode: 'soonest', band: 'any', techId: '', focusDate: null });
    expect(rows.map((h) => h.date.slice(8))).toEqual(['01', '02', '04', '05']);
  });
  it('lists at most 15 dates', () => {
    const many = Array.from({ length: 20 }, (_, i) => {
      const date = `2035-02-${String(i + 1).padStart(2, '0')}`;
      return day(date, [hour(date, '09:00', i)]);
    });
    expect(openTimesRows(many, { mode: 'best', band: 'any', techId: '', focusDate: null }).rows).toHaveLength(15);
  });
  it('a part of the day keeps only its start hours', () => {
    const { rows } = openTimesRows(DAYS, { mode: 'best', band: 'evening', techId: '', focusDate: null });
    expect(rows.map((h) => h.start)).toEqual(['17:00']);
    expect(openTimesRows(DAYS, { mode: 'best', band: 'morning', techId: '', focusDate: null }).rows.map((h) => h.start))
      .toEqual(['08:00', '10:00', '09:00']);
  });
  it('an outdoor job: a wet hour (rain tier 2) sorts after the dry ones', () => {
    const wet = [day('2035-01-01', [hour('2035-01-01', '09:00', 1, { rainTier: 2 }), hour('2035-01-01', '15:00', 9, { rainTier: 0 })])];
    expect(openTimesRows(wet, { mode: 'best', band: 'any', techId: '', focusDate: null }).rows.map((h) => h.start)).toEqual(['15:00']);
  });
  it('a last-resort day lists only when no other day has an open time', () => {
    const sunday = day('2035-01-07', [hour('2035-01-07', '10:00', 1)], { last_resort: true });
    expect(openTimesRows([...DAYS.slice(0, 2), sunday], { mode: 'best', band: 'any', techId: '', focusDate: null }).rows
      .map((h) => h.date.slice(8))).toEqual(['02', '01']);
    expect(openTimesRows([day('2035-01-01', []), sunday], { mode: 'best', band: 'any', techId: '', focusDate: null }).rows
      .map((h) => h.date.slice(8))).toEqual(['07']);
  });
  it('one day: its every open time, Best by added drive or Soonest by the clock', () => {
    expect(openTimesRows(DAYS, { mode: 'best', band: 'any', techId: '', focusDate: '2035-01-01' }).rows.map((h) => h.start)).toEqual(['14:00', '09:00']);
    expect(openTimesRows(DAYS, { mode: 'soonest', band: 'any', techId: '', focusDate: '2035-01-01' }).rows.map((h) => h.start)).toEqual(['09:00', '14:00']);
    expect(openTimesRows(DAYS, { mode: 'best', band: 'any', techId: '', focusDate: '2035-01-07' })).toEqual({ rows: [], empty: 'No open times this day' });
  });
  it('the number: "~" for the model, none for a road time, and no number for an unpriced route', () => {
    expect(addsPhrase(hour('2035-01-01', '09:00', 7.4))).toBe('adds ~7 min');
    expect(addsPhrase(hour('2035-01-01', '09:00', 7, { driveSource: 'google' }))).toBe('adds 7 min');
    expect(addsPhrase(hour('2035-01-01', '09:00', null))).toBe('drive unknown');
  });
});

describe('the box', () => {
  it('shows only open times: no verdict, and Save keeps its plain label', () => {
    render(<OpenTimesBox availability={answer()} currentDate="2035-01-04" currentStart="09:00" currentTechnicianId="t1" onPick={() => {}} />);
    expect(rowTexts()).toEqual([
      'Tue Jan 2Fixture Tech8 AMadds ~3 min',
      'Fri Jan 5Fixture Tech10 AMadds ~3 min',
      'Mon Jan 1Fixture Tech2 PMadds ~7 min',
      'Thu Jan 4Fixture Tech5 PMadds ~41 min',
    ]);
    expect(screen.queryByText(/doesn't fit|fits\.|anyway/i)).toBeNull();
    expect(availabilityVerdict(answer(), { currentDate: '2035-01-04', currentStart: '09:00' })).toBeNull();
    // A route warning would say what does not fit; the double-booking notice stays.
    expect(stripCoversRouteWarning(answer(), { currentDate: '2035-01-04', currentStart: '09:00' })).toBe(true);
    expect(screen.getByText('~ = straight-line estimate, not a road time.')).toBeTruthy();
  });
  it('a row adding more than 30 min shows in amber', () => {
    render(<OpenTimesBox availability={answer()} currentDate="2035-01-04" currentStart="09:00" onPick={() => {}} />);
    const rows = screen.getAllByTestId('open-time-row');
    expect(rows.filter((row) => row.dataset.far).map((row) => row.textContent)).toEqual(['Thu Jan 4Fixture Tech5 PMadds ~41 min']);
  });
  it('Best and Soonest sit at the top; parts of the day filter the list', () => {
    render(<OpenTimesBox availability={answer()} currentDate="2035-01-04" currentStart="09:00" onPick={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Soonest' }));
    expect(rowTexts().map((t) => t.slice(0, 10))).toEqual(['Mon Jan 1F', 'Tue Jan 2F', 'Thu Jan 4F', 'Fri Jan 5F']);
    fireEvent.click(screen.getByRole('button', { name: 'Afternoon' }));
    expect(rowTexts()).toEqual(['Mon Jan 1Fixture Tech2 PMadds ~7 min']);
  });
  it('a row fills the fields and shows its day; "All dates" goes back', () => {
    const onPick = vi.fn();
    const { rerender } = render(<OpenTimesBox availability={answer()} currentDate="2035-01-04" currentStart="09:00" currentTechnicianId="t1" onPick={onPick} />);
    fireEvent.click(screen.getAllByTestId('open-time-row')[2]);
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ date: '2035-01-01', start: '14:00', end: '15:00', technicianId: 't1', pickTech: false }));
    rerender(<OpenTimesBox availability={answer()} currentDate="2035-01-01" currentStart="14:00" currentTechnicianId="t1" onPick={onPick} />);
    expect(screen.getByText('Mon Jan 1')).toBeTruthy();
    expect(rowTexts()).toEqual(['2 PMFixture Techadds ~7 min', '9 AMFixture Techadds ~12 min']);
    // The time in the fields is marked and cannot be taken again.
    const [taken] = screen.getAllByTestId('open-time-row');
    expect(taken.getAttribute('aria-pressed')).toBe('true');
    expect(taken.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'All dates' }));
    expect(rowTexts()).toHaveLength(4);
  });
  it('the Date field searches: a new date shows that day, or says it has no open times', () => {
    const { rerender } = render(<OpenTimesBox availability={answer()} currentDate="2035-01-04" currentStart="09:00" onPick={() => {}} />);
    // The form's first date shows the 15 dates.
    expect(rowTexts()).toHaveLength(4);
    rerender(<OpenTimesBox availability={answer()} currentDate="2035-01-03" currentStart="09:00" onPick={() => {}} />);
    expect(screen.getByText('Wed Jan 3')).toBeTruthy();
    expect(screen.getByText('No open times this day')).toBeTruthy();
  });
  it('display only (the drag-and-drop confirm) and mid re-check: rows show, none can be taken', () => {
    const { rerender } = render(<OpenTimesBox availability={answer()} currentDate="2035-01-04" currentStart="09:00" />);
    expect(screen.getAllByTestId('open-time-row').every((row) => row.disabled)).toBe(true);
    const onPick = vi.fn();
    rerender(<OpenTimesBox availability={answer(DAYS, { stale: true })} currentDate="2035-01-04" currentStart="09:00" onPick={onPick} />);
    fireEvent.click(screen.getAllByTestId('open-time-row')[0]);
    expect(onPick).not.toHaveBeenCalled();
  });
  it('tech pick: one technician shows no Tech list; two do, and the row books its technician', () => {
    const { rerender } = render(<OpenTimesBox availability={answer()} currentDate="2035-01-04" currentStart="09:00" onPick={() => {}} techPick />);
    expect(screen.queryByRole('combobox', { name: 'Tech' })).toBeNull();
    const two = [
      day('2035-01-01', [hour('2035-01-01', '09:00', 30, NEW), hour('2035-01-01', '09:00', 4)]),
      day('2035-01-02', [hour('2035-01-02', '11:00', 2, NEW)]),
    ];
    const onPick = vi.fn();
    rerender(<OpenTimesBox availability={answer(two)} currentDate="2035-01-04" currentStart="09:00" onPick={onPick} techPick />);
    expect(rowTexts()).toEqual(['Tue Jan 2Second Fixture11 AMadds ~2 min', 'Mon Jan 1Fixture Tech9 AMadds ~4 min']);
    fireEvent.change(screen.getByRole('combobox', { name: 'Tech' }), { target: { value: 't2' } });
    expect(rowTexts()).toEqual(['Tue Jan 2Second Fixture11 AMadds ~2 min', 'Mon Jan 1Second Fixture9 AMadds ~30 min']);
    fireEvent.click(screen.getAllByTestId('open-time-row')[1]);
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ date: '2035-01-01', start: '09:00', technicianId: 't2', pickTech: true }));
  });
  it('while the first search runs it says so; the strip hands over to the box', () => {
    render(<AvailabilityStrip availability={{ openTimes: { pending: true }, days: [], best: null, picked: null }} currentDate="2035-01-04" currentStart="09:00" />);
    expect(screen.getByRole('status').textContent).toBe('Finding open times…');
    cleanup();
    render(<AvailabilityStrip bestRows availability={answer()} currentDate="2035-01-04" currentStart="09:00" onPick={() => {}} />);
    expect(screen.getByTestId('open-times-box')).toBeTruthy();
    expect(screen.queryByTestId('availability-strip')).toBeNull();
    expect(within(screen.getByRole('list', { name: 'Open dates' })).getAllByRole('listitem')).toHaveLength(4);
  });
});
