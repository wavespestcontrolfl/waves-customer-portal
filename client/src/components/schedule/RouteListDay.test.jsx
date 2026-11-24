// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RouteListDay, { DayLayoutToggle, readDayLayout, useDayLayout } from './RouteListDay';

const KEY = 'waves_dispatch_day_layout';
const TECHS = [{ id: 't1', name: 'Alex Tech' }, { id: 't2', name: 'Blair Tech' }];

function stop(id, name, windowStart, extra = {}) {
  const hour = Number(windowStart.slice(0, 2));
  return {
    id, customerName: name, status: 'confirmed', serviceType: 'General Pest Control', technicianId: 't1',
    windowStart, windowEnd: `${String(hour + 1).padStart(2, '0')}:00`, scheduledDate: '2026-11-25', ...extra,
  };
}
const told = (window) => ({ level: 'hour', dayOnly: false, date: '2026-11-25', window });

afterEach(() => { cleanup(); localStorage.removeItem(KEY); vi.restoreAllMocks(); });

function Harness() {
  const [layout, setLayout] = useDayLayout();
  return <div><DayLayoutToggle layout={layout} onChange={setLayout} /><span data-testid="layout">{layout}</span></div>;
}

describe('Grid / Route toggle', () => {
  it('defaults to Grid, switches to Route, and remembers the choice', () => {
    expect(readDayLayout()).toBe('grid');
    const first = render(<Harness />);
    expect(screen.getByTestId('layout')).toHaveTextContent('grid');
    expect(screen.getByRole('button', { name: 'Grid' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Route' }));
    expect(screen.getByTestId('layout')).toHaveTextContent('route');
    expect(localStorage.getItem(KEY)).toBe('route');
    first.unmount();
    render(<Harness />);
    expect(screen.getByTestId('layout')).toHaveTextContent('route');
    fireEvent.click(screen.getByRole('button', { name: 'Grid' }));
    expect(localStorage.getItem(KEY)).toBe('grid');
  });

  it('opens on Grid and still switches when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(readDayLayout()).toBe('grid');
    render(<Harness />);
    expect(screen.getByTestId('layout')).toHaveTextContent('grid');
    fireEvent.click(screen.getByRole('button', { name: 'Route' }));
    expect(screen.getByTestId('layout')).toHaveTextContent('route');
  });
});

describe('RouteListDay', () => {
  const lines = (card) => within(card).getAllByRole('button');
  const card = (name) => screen.getByRole('region', { name: `${name} route` });

  it('gives Unassigned first (only with visits), then a card per technician, each stop list in route order', () => {
    render(<RouteListDay technicians={TECHS} services={[
      stop('a', 'Late Lou', '09:00', { plannedArrivalMin: 11 * 60, plannedMinutes: 35 }),
      stop('b', 'Early Ed', '13:00', { plannedArrivalMin: 8 * 60 + 30, plannedMinutes: 35 }),
      stop('c', 'No Plan Pia', '10:00'),
      stop('u', 'Loose Lin', '10:00', { technicianId: null }),
    ]} />);
    const sections = screen.getAllByRole('region');
    expect(sections.map((s) => s.getAttribute('aria-label'))).toEqual(['Unassigned route', 'Alex Tech route', 'Blair Tech route']);
    // Planned arrival first, the booked start for a stop with no plan: 08:30, 10:00 booked, 11:00.
    expect(lines(card('Alex Tech')).map((b) => within(b).getByTestId('stop-number').textContent)).toEqual(['1', '2', '3']);
    expect(lines(card('Alex Tech')).map((b) => b.textContent)).toEqual([
      expect.stringContaining('Early Ed'), expect.stringContaining('No Plan Pia'), expect.stringContaining('Late Lou'),
    ]);
    expect(within(card('Blair Tech')).getByText('No stops')).toBeInTheDocument();
  });

  it('shows each line\'s fields: number, planned time, customer, service, minutes, drive, window chip', () => {
    render(<RouteListDay technicians={TECHS} services={[
      stop('a', 'Planned Pat', '10:00', {
        plannedArrivalMin: 10 * 60 + 45, plannedMinutes: 35, driveFromPrevMin: 9, told: told('10:00 AM - 12:00 PM'),
      }),
    ]} />);
    const line = lines(card('Alex Tech'))[0];
    expect(within(line).getByTestId('stop-number')).toHaveTextContent('1');
    expect(within(line).getByTestId('stop-time')).toHaveTextContent('10:45 AM');
    expect(within(line).getByTestId('stop-time')).not.toHaveTextContent('booked');
    expect(within(line).getByText('Planned Pat')).toBeInTheDocument();
    expect(within(line).getByText('General Pest Control')).toBeInTheDocument();
    expect(within(line).getByTestId('stop-minutes')).toHaveTextContent('35 min');
    expect(within(line).getByText('~9 min drive')).toBeInTheDocument();
    const chip = within(line).getByText('window 10–12');
    expect(chip).toHaveAttribute('title', 'Promised arrival window');
    expect(line.style.borderLeftColor).not.toBe('rgb(220, 38, 38)');
  });

  it('flags a planned arrival outside the told window with the grid\'s red edge and tooltip', () => {
    render(<RouteListDay technicians={TECHS} services={[
      stop('a', 'Late Lou', '10:00', { plannedArrivalMin: 12 * 60 + 15, plannedMinutes: 35, told: told('10:00 AM - 12:00 PM') }),
    ]} />);
    const line = lines(card('Alex Tech'))[0];
    expect(line.style.borderLeftColor).toBe('rgb(220, 38, 38)');
    expect(line.getAttribute('title')).toMatch(/outside the window 10–12 \(stop reached 12:15\)/);
  });

  it('falls back to the booked start, marked booked, with no minutes or chip when nothing is planned', () => {
    render(<RouteListDay technicians={TECHS} services={[stop('a', 'Plain Pat', '14:00')]} />);
    const line = lines(card('Alex Tech'))[0];
    expect(within(line).getByTestId('stop-time')).toHaveTextContent('2:00 PM');
    expect(within(line).getByTestId('stop-time')).toHaveTextContent('booked');
    expect(within(line).queryByTestId('stop-minutes')).toBeNull();
    expect(within(line).queryByText(/^window /)).toBeNull();
  });

  it('totals the header: stops, planned minutes and the planned finish', () => {
    render(<RouteListDay technicians={TECHS} services={[
      stop('a', 'One', '08:00', { plannedArrivalMin: 8 * 60, plannedMinutes: 35 }),
      stop('b', 'Two', '09:00', { plannedArrivalMin: 9 * 60, plannedMinutes: 45 }),
      stop('c', 'Three', '15:00', { plannedArrivalMin: 15 * 60 + 10, plannedMinutes: 35 }),
      stop('d', 'Done', '07:00', { status: 'completed' }),
    ]} />);
    const header = card('Alex Tech').querySelector('header');
    expect(header).toHaveTextContent('Alex Tech');
    expect(header).toHaveTextContent('4 stops');
    expect(header).toHaveTextContent('115 min planned');
    // Last planned departure: 3:10 PM + 35 min.
    expect(header).toHaveTextContent('Planned finish 3:45 PM');
  });

  it('counts the rows of one co-visit once in the minutes, and keeps completed, skipped and cancelled stops in order with their look', () => {
    render(<RouteListDay technicians={TECHS} services={[
      stop('a', 'Pair A', '10:00', { plannedArrivalMin: 600, plannedMinutes: 60 }),
      stop('b', 'Pair B', '10:00', { plannedArrivalMin: 600, plannedMinutes: 60 }),
      stop('c', 'Done Dee', '08:00', { status: 'completed' }),
      stop('s', 'Skip Sam', '09:00', { status: 'skipped' }),
      stop('x', 'Cancelled Cy', '12:00', { status: 'cancelled' }),
    ]} />);
    expect(card('Alex Tech').querySelector('header')).toHaveTextContent('60 min planned');
    const all = lines(card('Alex Tech'));
    expect(all.map((b) => within(b).getByTestId('stop-number').textContent)).toEqual(['1', '2', '3', '4', '5']);
    expect(all[0]).toHaveTextContent('Done Dee');
    expect(all[0]).toHaveClass('bg-zinc-200');
    expect(all[1]).toHaveTextContent('Skip Sam');
    expect(all[1]).toHaveClass('bg-alert-bg');
    expect(all[4]).toHaveTextContent('Cancelled Cy');
    expect(all[4]).toHaveClass('line-through');
  });

  it('opens the line\'s visit through onEdit, and marks a closeout still owed', () => {
    const onEdit = vi.fn();
    const svc = stop('a', 'Click Cal', '10:00', { plannedArrivalMin: 600, plannedMinutes: 35 });
    render(<RouteListDay technicians={TECHS} services={[svc]} onEdit={onEdit} owesCompletion={() => true} />);
    expect(screen.getByText('Closeout owed')).toBeInTheDocument();
    fireEvent.click(lines(card('Alex Tech'))[0]);
    expect(onEdit).toHaveBeenCalledWith(svc);
  });

  it('holds 16 stops for one technician in one column', () => {
    const many = Array.from({ length: 16 }, (_, i) => stop(`s${i}`, `Customer ${i + 1}`, '08:00', { plannedArrivalMin: 8 * 60 + i * 40, plannedMinutes: 35 }));
    render(<RouteListDay technicians={TECHS} services={many} />);
    expect(lines(card('Alex Tech'))).toHaveLength(16);
    expect(screen.getByTestId('route-list')).toHaveClass('grid-cols-1');
  });
});
