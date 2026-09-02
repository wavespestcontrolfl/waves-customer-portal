// @vitest-environment jsdom
// Lawn program seasons (GATE_ESTIMATE_LAWN_CALENDAR): the four SWFL turf
// seasons from the program's first projected month, each with a one-line
// focus and the number of server-projected applications that land in it —
// no product or step names. The cadence line and months come from the
// /data payload (lawnCalendar.programs[frequencyKey]); rendered only for
// the lawn section when that block carries the selected frequency.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LawnProgramCalendar, ServiceSection, lawnProgramSeasons } from './EstimateViewPage';

afterEach(() => cleanup());

const counts = (seasons) => Object.fromEntries(seasons.map((s) => [s.key, s.applications]));
// The 9x / 42-day program projected from Sep 1: Sep, Oct, Nov, Jan, Feb, Mar, May, Jun, Aug.
const NINE_FROM_SEP = [8, 9, 10, 0, 1, 2, 4, 5, 7];
const program = (over = {}) => ({ visitsPerYear: 9, cadence: 'about every 42 days', months: NINE_FROM_SEP, ...over });

describe('lawnProgramSeasons', () => {
  it('buckets the projected months into seasons starting with the first month\'s season', () => {
    const seasons = lawnProgramSeasons(NINE_FROM_SEP);
    expect(seasons.map((s) => s.key)).toEqual(['summer', 'fall', 'winter', 'spring']);
    expect(seasons[0].current).toBe(true);
    expect(seasons.slice(1).every((s) => s.current === false)).toBe(true);
    expect(counts(seasons)).toEqual({ summer: 4, fall: 2, winter: 2, spring: 1 });
  });
  it('starts with the season containing the first month, wrapping winter across the year end', () => {
    expect(lawnProgramSeasons([0])[0].key).toBe('winter');
    expect(lawnProgramSeasons([11])[0].key).toBe('winter');
    expect(lawnProgramSeasons([2])[0].key).toBe('spring');
    expect(lawnProgramSeasons([9])[0].key).toBe('fall');
  });
  it('monthly, bimonthly, and quarterly projections sum to their counts', () => {
    const monthly = Array.from({ length: 12 }, (_, i) => (8 + i) % 12);
    expect(counts(lawnProgramSeasons(monthly))).toEqual({ summer: 5, fall: 2, winter: 3, spring: 2 });
    expect(counts(lawnProgramSeasons([8, 10, 0, 2, 4, 6]))).toEqual({ summer: 3, fall: 1, winter: 1, spring: 1 });
    expect(counts(lawnProgramSeasons([8, 11, 2, 5]))).toEqual({ summer: 2, fall: 0, winter: 1, spring: 1 });
  });
  it('ignores junk months and yields four zero-count seasons for none', () => {
    expect(lawnProgramSeasons(['x', 14, -1]).every((s) => s.applications === 0)).toBe(true);
    expect(lawnProgramSeasons(undefined)).toHaveLength(4);
  });
});

describe('LawnProgramCalendar', () => {
  it('renders the payload cadence line, and the four season rows behind the toggle, no product names', () => {
    render(<LawnProgramCalendar program={program()} />);
    expect(screen.getByText('9 applications a year — about every 42 days')).toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'What each season covers' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveAttribute('data-season', 'summer');
    expect(rows[0]).toHaveAttribute('data-current', 'true');
    expect(rows[0]).toHaveTextContent('4 applications');
    expect(rows[0]).toHaveTextContent('now');
    // No aria-label override: the row's visible description is what assistive tech reads.
    expect(rows[0]).not.toHaveAttribute('aria-label');
    expect(rows[3]).toHaveAttribute('data-season', 'spring');
    expect(rows[3]).toHaveTextContent('1 application');
    expect(screen.getByText(/summer fertilizer restrictions in your county/)).toBeInTheDocument();
    expect(screen.queryByText(/Jun – Sep|blackout/)).not.toBeInTheDocument();
    expect(screen.getByText('Timing shifts a little with weather and turf condition.')).toBeInTheDocument();
    expect(screen.queryByText(/fertilizer blend|granular|pre-emergent/i)).not.toBeInTheDocument();
  });
  it('opens the seasons when the browser is about to print', () => {
    render(<LawnProgramCalendar program={program()} />);
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    fireEvent(window, new Event('beforeprint'));
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
  });
  it('renders nothing without a positive count or a cadence', () => {
    expect(render(<LawnProgramCalendar program={program({ visitsPerYear: 0 })} />).container).toBeEmptyDOMElement();
    cleanup();
    expect(render(<LawnProgramCalendar program={program({ cadence: null })} />).container).toBeEmptyDOMElement();
    cleanup();
    expect(render(<LawnProgramCalendar program={null} />).container).toBeEmptyDOMElement();
  });
});

const frequency = { key: 'standard', label: 'Lawn Program', monthly: 85, annual: 1020, visitsPerYear: 9, included: [], addOns: [] };
const section = (key, label) => ({ key, label, isRecurring: true, isPest: key === 'pest_control', frequencies: [frequency], copy: { priceWording: {} } });
const renderSection = (sec, lawnCalendar) => render(
  <ServiceSection
    section={sec}
    selectedFrequencyKey="standard"
    selectedAddOns={new Set()}
    onFrequencyChange={vi.fn()}
    onAddOnToggle={vi.fn()}
    renderFlags={{}}
    waveGuardTier="Silver"
    lawnCalendar={lawnCalendar}
  />,
);

describe('ServiceSection wiring', () => {
  it('shows the calendar on the lawn section only when the payload carries the selected frequency', () => {
    renderSection(section('lawn_care', 'Lawn Care'), { programs: { standard: program() } });
    expect(screen.getByLabelText('Your lawn program calendar')).toBeInTheDocument();
    expect(screen.getByText('9 applications a year — about every 42 days')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'What each season covers' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
  });
  it('is absent without the block, absent for an unresolved frequency, and absent on pest', () => {
    renderSection(section('lawn_care', 'Lawn Care'), null);
    expect(screen.queryByLabelText('Your lawn program calendar')).not.toBeInTheDocument();
    cleanup();
    renderSection(section('lawn_care', 'Lawn Care'), { programs: { other: program() } });
    expect(screen.queryByLabelText('Your lawn program calendar')).not.toBeInTheDocument();
    cleanup();
    renderSection(section('pest_control', 'Pest Control'), { programs: { standard: program() } });
    expect(screen.queryByLabelText('Your lawn program calendar')).not.toBeInTheDocument();
  });
});
