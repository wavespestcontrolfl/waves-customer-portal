// @vitest-environment jsdom
// The Home-tab misting system card: rows, copy, ET Today/Tomorrow, the
// one-time and three-time "Daily at" lines, and the Installed fallback.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import MistingSystemCard from './MistingSystemCard';

afterEach(() => cleanup());

const NOW = new Date('2026-10-30T20:00:00Z'); // 4:00 PM EDT, Fri Oct 30
const base = {
  installedOn: '2026-05-02',
  lastRefillOn: '2026-10-12',
  nextCheckOn: '2026-11-12',
  nextMistAt: '2026-10-30T23:30:00.000Z', // 7:30 PM EDT
  mistTimes: ['06:30', '19:30', '22:30'],
};
const rowValue = (label) => screen.getByText(label).parentElement.parentElement.lastChild.textContent;

describe('MistingSystemCard', () => {
  it('shows the chip, the three rows, the three-time line and the footnote', () => {
    render(<MistingSystemCard system={base} now={NOW} />);
    expect(screen.getByText('Your misting system')).toBeInTheDocument();
    expect(rowValue('Next mist')).toBe('Today at 7:30 PM');
    expect(screen.getByText('Daily at 6:30 AM, 7:30 PM and 10:30 PM')).toBeInTheDocument();
    expect(rowValue('Last refill')).toBe('Oct 12');
    expect(rowValue('Next check')).toBe('Thu, Nov 12');
    expect(screen.getByText("These are the mist times we set at your last visit. If you change them in the misting app, the app's times are the ones that run.")).toBeInTheDocument();
    expect(screen.queryByText('Installed')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('says Tomorrow when the next mist is on the next ET calendar day', () => {
    render(<MistingSystemCard system={{ ...base, nextMistAt: '2026-10-31T10:30:00.000Z' }} now={NOW} />);
    expect(rowValue('Next mist')).toBe('Tomorrow at 6:30 AM');
  });

  it('never shows a mist time that already passed as the next mist', () => {
    render(<MistingSystemCard system={{ ...base, nextMistAt: '2026-10-30T19:30:00.000Z' }} now={NOW} />);
    expect(rowValue('Next mist')).toBe('—');
    expect(screen.getByText('Daily at 6:30 AM, 7:30 PM and 10:30 PM')).toBeInTheDocument();
  });

  it('compares ET calendar dates, not 24-hour windows or the UTC date', () => {
    // 10:00 PM EDT Oct 30 is already Oct 31 in UTC; 6:30 AM EDT Oct 31 is "tomorrow", not "today".
    render(<MistingSystemCard system={{ ...base, nextMistAt: '2026-10-31T10:30:00.000Z' }} now={new Date('2026-10-31T02:00:00Z')} />);
    expect(rowValue('Next mist')).toBe('Tomorrow at 6:30 AM');
    cleanup();
    // 12:30 AM EDT Oct 31 (04:30Z): a mist at 6:30 AM the same ET day is "today".
    render(<MistingSystemCard system={{ ...base, nextMistAt: '2026-10-31T10:30:00.000Z' }} now={new Date('2026-10-31T04:30:00Z')} />);
    expect(rowValue('Next mist')).toBe('Today at 6:30 AM');
  });

  it('one mist time reads "Daily at 7:30 PM"; two read "A and B"', () => {
    render(<MistingSystemCard system={{ ...base, mistTimes: ['19:30'] }} now={NOW} />);
    expect(screen.getByText('Daily at 7:30 PM')).toBeInTheDocument();
    cleanup();
    render(<MistingSystemCard system={{ ...base, mistTimes: ['06:30', '19:30'] }} now={NOW} />);
    expect(screen.getByText('Daily at 6:30 AM and 7:30 PM')).toBeInTheDocument();
  });

  it('with no refill yet, shows Installed with the install date instead of Last refill', () => {
    render(<MistingSystemCard system={{ ...base, lastRefillOn: null }} now={NOW} />);
    expect(screen.queryByText('Last refill')).not.toBeInTheDocument();
    expect(rowValue('Installed')).toBe('May 2');
  });

  it('adds the year to a date from another year', () => {
    render(<MistingSystemCard system={{ ...base, lastRefillOn: '2025-12-28' }} now={NOW} />);
    expect(rowValue('Last refill')).toBe('Dec 28, 2025');
  });

  it('shows no prices or product words', () => {
    const { container } = render(<MistingSystemCard system={base} now={NOW} />);
    expect(container.textContent).not.toMatch(/\$|price|pyrethrin|permethrin|gallon/i);
  });

  it('renders nothing without a system', () => {
    const { container } = render(<MistingSystemCard system={null} now={NOW} />);
    expect(container).toBeEmptyDOMElement();
  });
});
