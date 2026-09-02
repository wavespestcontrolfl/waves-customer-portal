// @vitest-environment jsdom
// Lawn program seasons (GATE_ESTIMATE_LAWN_CALENDAR): the four SWFL turf
// seasons from the current ET month, each with a one-line focus and its
// proportional share of visitsPerYear — no product or step names. Rendered
// only for the lawn section when the payload flags it.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LawnProgramCalendar, ServiceSection, lawnCadenceLabel, lawnProgramSeasons } from './EstimateViewPage';

afterEach(() => cleanup());

const counts = (seasons) => Object.fromEntries(seasons.map((s) => [s.key, s.applications]));

const et = (iso) => new Date(iso);

describe('lawnProgramSeasons', () => {
  it('9 applications from September → summer first, counts projected at the 42-day step and summing to 9', () => {
    const seasons = lawnProgramSeasons(9, et('2026-09-01T16:00:00Z'));
    expect(seasons.map((s) => s.key)).toEqual(['summer', 'fall', 'winter', 'spring']);
    expect(seasons[0].current).toBe(true);
    expect(seasons.slice(1).every((s) => s.current === false)).toBe(true);
    // Sep 1, Oct 13, Nov 24, Jan 5, Feb 16, Mar 30, May 11, Jun 22, Aug 3
    expect(counts(seasons)).toEqual({ summer: 4, fall: 2, winter: 2, spring: 1 });
  });
  it('a 42-day program starting in May puts four applications in summer (May, Jun, Jul, Sep)', () => {
    expect(counts(lawnProgramSeasons(9, et('2026-05-01T16:00:00Z')))).toEqual({ summer: 4, fall: 2, winter: 2, spring: 1 });
  });
  it('starts with the season containing the ET month, wrapping winter across the year end', () => {
    expect(lawnProgramSeasons(12, et('2026-01-15T16:00:00Z'))[0].key).toBe('winter');
    expect(lawnProgramSeasons(12, et('2026-12-15T16:00:00Z'))[0].key).toBe('winter');
    expect(lawnProgramSeasons(12, et('2026-03-15T16:00:00Z'))[0].key).toBe('spring');
    expect(lawnProgramSeasons(12, et('2026-10-15T16:00:00Z'))[0].key).toBe('fall');
    // 03:00Z on Oct 1 is still Sep 30 in ET.
    expect(lawnProgramSeasons(12, et('2026-10-01T03:00:00Z'))[0].key).toBe('summer');
  });
  it('monthly lands one per month, bimonthly every other month, quarterly every third', () => {
    expect(counts(lawnProgramSeasons(12, et('2026-09-01T16:00:00Z')))).toEqual({ summer: 5, fall: 2, winter: 3, spring: 2 });
    // Sep, Nov, Jan, Mar, May, Jul
    expect(counts(lawnProgramSeasons(6, et('2026-09-01T16:00:00Z')))).toEqual({ summer: 3, fall: 1, winter: 1, spring: 1 });
    // Sep, Dec, Mar, Jun
    expect(counts(lawnProgramSeasons(4, et('2026-09-01T16:00:00Z')))).toEqual({ summer: 2, fall: 0, winter: 1, spring: 1 });
    for (const n of [4, 6, 8, 9, 12, 20]) {
      const total = lawnProgramSeasons(n, et('2026-06-10T16:00:00Z')).reduce((a, s) => a + s.applications, 0);
      expect(total).toBe(n);
    }
  });
  it('0 or missing visits yields four zero-count seasons', () => {
    expect(lawnProgramSeasons(0, et('2026-04-01T16:00:00Z')).every((s) => s.applications === 0)).toBe(true);
    expect(lawnProgramSeasons(undefined, et('2026-04-01T16:00:00Z'))).toHaveLength(4);
  });
});

describe('lawnCadenceLabel', () => {
  it('names the catalog intervals and falls back to an even split of the year', () => {
    expect(lawnCadenceLabel(12)).toBe('about once a month');
    expect(lawnCadenceLabel(9)).toBe('about every 42 days');
    expect(lawnCadenceLabel(6)).toBe('about every 2 months');
    expect(lawnCadenceLabel(4)).toBe('about every 3 months');
    expect(lawnCadenceLabel(8)).toBe('about every 46 days');
  });
});

describe('LawnProgramCalendar', () => {
  it('renders the count line, and the four season rows behind the toggle, no product names', () => {
    render(<LawnProgramCalendar visitsPerYear={9} now={new Date('2026-09-01T16:00:00Z')} />);
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
    expect(rows[3]).toHaveAttribute('data-season', 'spring');
    expect(rows[3]).toHaveTextContent('1 application');
    expect(screen.getByText(/County fertilizer blackout/)).toBeInTheDocument();
    expect(screen.getByText('Timing shifts a little with weather and turf condition.')).toBeInTheDocument();
    expect(screen.queryByText(/fertilizer blend|granular|pre-emergent/i)).not.toBeInTheDocument();
  });
  it('renders nothing without a positive visit count', () => {
    const { container } = render(<LawnProgramCalendar visitsPerYear={0} />);
    expect(container).toBeEmptyDOMElement();
  });
});

const frequency = { key: 'standard', label: 'Lawn Program', monthly: 85, annual: 1020, visitsPerYear: 8, included: [], addOns: [] };
const section = (key, label) => ({ key, label, isRecurring: true, isPest: key === 'pest_control', frequencies: [frequency], copy: { priceWording: {} } });
const renderSection = (sec, showLawnCalendar) => render(
  <ServiceSection
    section={sec}
    selectedFrequencyKey="standard"
    selectedAddOns={new Set()}
    onFrequencyChange={vi.fn()}
    onAddOnToggle={vi.fn()}
    renderFlags={{}}
    waveGuardTier="Silver"
    showLawnCalendar={showLawnCalendar}
  />,
);

describe('ServiceSection wiring', () => {
  it('shows the calendar on the lawn section only when the flag is on', () => {
    renderSection(section('lawn_care', 'Lawn Care'), true);
    expect(screen.getByLabelText('Your lawn program calendar')).toBeInTheDocument();
    expect(screen.getByText('8 applications a year — about every 46 days')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'What each season covers' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
  });
  it('is absent without the flag and absent on pest', () => {
    renderSection(section('lawn_care', 'Lawn Care'), false);
    expect(screen.queryByLabelText('Your lawn program calendar')).not.toBeInTheDocument();
    cleanup();
    renderSection(section('pest_control', 'Pest Control'), true);
    expect(screen.queryByLabelText('Your lawn program calendar')).not.toBeInTheDocument();
  });
});
