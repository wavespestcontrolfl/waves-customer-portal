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

describe('lawnProgramSeasons', () => {
  it('9 applications from September → summer first, counts proportional to season length and summing to 9', () => {
    const seasons = lawnProgramSeasons(9, 8);
    expect(seasons.map((s) => s.key)).toEqual(['summer', 'fall', 'winter', 'spring']);
    expect(seasons[0].current).toBe(true);
    expect(seasons.slice(1).every((s) => s.current === false)).toBe(true);
    expect(counts(seasons)).toEqual({ summer: 4, fall: 2, winter: 2, spring: 1 });
  });
  it('starts with the season containing the month, wrapping winter across the year end', () => {
    expect(lawnProgramSeasons(12, 0)[0].key).toBe('winter');
    expect(lawnProgramSeasons(12, 11)[0].key).toBe('winter');
    expect(lawnProgramSeasons(12, 2)[0].key).toBe('spring');
    expect(lawnProgramSeasons(12, 9)[0].key).toBe('fall');
  });
  it('12 applications lands one per month; 4 and 8 still sum exactly', () => {
    expect(counts(lawnProgramSeasons(12, 0))).toEqual({ winter: 3, spring: 2, summer: 5, fall: 2 });
    for (const n of [4, 8, 9, 12, 20]) {
      const total = lawnProgramSeasons(n, 5).reduce((a, s) => a + s.applications, 0);
      expect(total).toBe(n);
    }
  });
  it('0 or missing visits yields four zero-count seasons', () => {
    expect(lawnProgramSeasons(0, 3).every((s) => s.applications === 0)).toBe(true);
    expect(lawnProgramSeasons(undefined, 3)).toHaveLength(4);
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
