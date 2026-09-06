// @vitest-environment jsdom
// Lawn program seasons (GATE_ESTIMATE_LAWN_CALENDAR): the program's annual
// count from the /data payload (lawnCalendar.programs[frequencyKey]) plus
// four fixed season rows in calendar order behind a toggle — customer-facing
// education only: no per-season counts, month ranges, "now" marker, or
// interval line (owner 2026-09-05), and no product or step names. Rendered
// only for the lawn section when the block carries the selected frequency.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LawnProgramCalendar, ServiceSection } from './EstimateViewPage';

afterEach(() => cleanup());

const program = (over = {}) => ({ visitsPerYear: 9, cadence: 'about every 42 days', months: [8, 9, 10, 0, 1, 2, 4, 5, 7], ...over });

describe('LawnProgramCalendar', () => {
  it('renders the annual count without the interval, and the four season rows behind the toggle', () => {
    render(<LawnProgramCalendar program={program()} />);
    expect(screen.getByText('9 applications a year')).toBeInTheDocument();
    expect(screen.queryByText(/42 days/)).not.toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'What each season covers' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/We inspect your lawn at each application/)).toBeInTheDocument();
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((r) => r.getAttribute('data-season'))).toEqual(['spring', 'summer', 'fall', 'winter']);
    expect(rows[0]).toHaveTextContent('Spring · Support new growth');
    expect(rows[1]).toHaveTextContent('Summer · Manage seasonal stress');
    expect(rows[1]).toHaveTextContent(/During local fertilizer restrictions/);
    expect(rows[2]).toHaveTextContent('Fall · Adjust as conditions change');
    expect(rows[3]).toHaveTextContent('Winter · Maintain lawn health');
    // Education, not a schedule: no per-season counts, month ranges, or "now".
    expect(screen.queryByText(/\d+ applications?$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/May – Sep|Mar – Apr|· now/)).not.toBeInTheDocument();
    // No aria-label override: the row's visible text is what assistive tech reads.
    expect(rows[0]).not.toHaveAttribute('aria-label');
    expect(screen.getByText('Timing shifts a little with weather and turf condition.')).toBeInTheDocument();
    expect(screen.queryByText(/fertilizer blend|granular|pre-emergent/i)).not.toBeInTheDocument();
  });
  it('opens the seasons when the browser is about to print', () => {
    render(<LawnProgramCalendar program={program()} />);
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    fireEvent(window, new Event('beforeprint'));
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
  });
  it('renders nothing without a positive count', () => {
    expect(render(<LawnProgramCalendar program={program({ visitsPerYear: 0 })} />).container).toBeEmptyDOMElement();
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
    expect(screen.getByText('9 applications a year')).toBeInTheDocument();
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
