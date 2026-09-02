// @vitest-environment jsdom
// Lawn program calendar (GATE_ESTIMATE_LAWN_CALENDAR): 12 months from the
// current ET month, N evenly spaced application months from visitsPerYear,
// nothing else — no product or step names. Rendered only for the lawn
// section when the payload flags it.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LawnProgramCalendar, ServiceSection, lawnCalendarMonths } from './EstimateViewPage';

afterEach(() => cleanup());

describe('lawnCalendarMonths', () => {
  it('9 applications from September → 9 marked months, evenly spaced, wrapping the year', () => {
    const months = lawnCalendarMonths(9, 8);
    expect(months).toHaveLength(12);
    expect(months[0].label).toBe('Sep');
    expect(months[11].label).toBe('Aug');
    expect(months.filter((m) => m.marked)).toHaveLength(9);
    expect(months[0].marked).toBe(true);
  });
  it('12 applications marks every month; 4 marks each quarter', () => {
    expect(lawnCalendarMonths(12, 0).every((m) => m.marked)).toBe(true);
    const quarterly = lawnCalendarMonths(4, 0).map((m) => m.marked);
    expect(quarterly).toEqual([true, false, false, true, false, false, true, false, false, true, false, false]);
  });
  it('0 or missing visits marks nothing; more than 12 saturates', () => {
    expect(lawnCalendarMonths(0, 3).some((m) => m.marked)).toBe(false);
    expect(lawnCalendarMonths(undefined, 3).some((m) => m.marked)).toBe(false);
    expect(lawnCalendarMonths(20, 3).every((m) => m.marked)).toBe(true);
  });
});

describe('LawnProgramCalendar', () => {
  it('renders the count line and 12 month pills, no product names', () => {
    render(<LawnProgramCalendar visitsPerYear={9} now={new Date('2026-09-01T16:00:00Z')} />);
    expect(screen.getByText('9 applications a year — about every 6 weeks')).toBeInTheDocument();
    const pills = screen.getAllByRole('listitem');
    expect(pills).toHaveLength(12);
    expect(pills[0]).toHaveTextContent('Sep');
    expect(pills.filter((p) => p.getAttribute('data-marked') === 'true')).toHaveLength(9);
    expect(screen.queryByText(/fertiliz|granular|pre-emergent/i)).not.toBeInTheDocument();
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
    expect(screen.getByText('8 applications a year — about every 7 weeks')).toBeInTheDocument();
  });
  it('is absent without the flag and absent on pest', () => {
    renderSection(section('lawn_care', 'Lawn Care'), false);
    expect(screen.queryByLabelText('Your lawn program calendar')).not.toBeInTheDocument();
    cleanup();
    renderSection(section('pest_control', 'Pest Control'), true);
    expect(screen.queryByLabelText('Your lawn program calendar')).not.toBeInTheDocument();
  });
});
