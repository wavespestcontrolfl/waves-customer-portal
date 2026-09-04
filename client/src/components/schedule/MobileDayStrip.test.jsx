// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MobileDayStrip from './MobileDayStrip';

afterEach(() => {
  cleanup();
});

const options = () => screen.getAllByRole('option');
const isoOf = (el) => el.getAttribute('data-iso');

describe('MobileDayStrip', () => {
  it('renders a rolling window around the selected date with the selection marked', () => {
    render(<MobileDayStrip date="2026-09-04" onSelect={() => {}} />);
    const days = options();
    expect(isoOf(days[0])).toBe('2026-07-06'); // 60 back
    expect(isoOf(days[days.length - 1])).toBe('2027-01-02'); // 120 forward
    expect(days).toHaveLength(181);
    const selected = days.filter((el) => el.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(isoOf(selected[0])).toBe('2026-09-04');
    expect(selected[0]).toHaveTextContent('Fri');
    expect(selected[0]).toHaveTextContent('4');
  });

  it('shows the month and year of the selected date', () => {
    render(<MobileDayStrip date="2026-12-30" onSelect={() => {}} />);
    expect(screen.getByText('December 2026')).toBeInTheDocument();
    // The window crosses the year boundary and labels January's first day.
    expect(screen.getByText('Jan')).toBeInTheDocument();
  });

  it('tapping a day reports it and scrolling alone does not', () => {
    const onSelect = vi.fn();
    render(<MobileDayStrip date="2026-09-04" onSelect={onSelect} />);
    const list = screen.getByRole('listbox');
    fireEvent.scroll(list);
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(list.querySelector('[data-iso="2026-09-11"]'));
    expect(onSelect).toHaveBeenCalledWith('2026-09-11');
  });

  it('re-seeds the window when the selection jumps outside it', () => {
    const { rerender } = render(<MobileDayStrip date="2026-09-04" onSelect={() => {}} />);
    rerender(<MobileDayStrip date="2027-06-15" onSelect={() => {}} />);
    const days = options();
    expect(isoOf(days[0])).toBe('2027-04-16');
    expect(isoOf(days[days.length - 1])).toBe('2027-10-13');
    expect(screen.getByText('June 2027')).toBeInTheDocument();
  });

  it('keeps only the selected day in the tab order and walks the strip with arrow keys', () => {
    render(<MobileDayStrip date="2026-09-04" onSelect={() => {}} />);
    const list = screen.getByRole('listbox');
    const selected = list.querySelector('[data-iso="2026-09-04"]');
    expect(selected).toHaveAttribute('tabindex', '0');
    expect(list.querySelector('[data-iso="2026-09-05"]')).toHaveAttribute('tabindex', '-1');
    selected.focus();
    fireEvent.keyDown(selected, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(list.querySelector('[data-iso="2026-09-05"]'));
    fireEvent.keyDown(document.activeElement, { key: 'ArrowLeft' });
    fireEvent.keyDown(document.activeElement, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(list.querySelector('[data-iso="2026-09-03"]'));
  });

  it('extends the window when scrolled to the end', () => {
    render(<MobileDayStrip date="2026-09-04" onSelect={() => {}} />);
    const list = screen.getByRole('listbox');
    const before = options().length;
    // jsdom has no layout: scrollWidth/clientWidth/scrollLeft are all 0,
    // which reads as "at the start" — so the prepend branch fires.
    fireEvent.scroll(list);
    expect(options().length).toBe(before + 30);
    expect(isoOf(options()[0])).toBe('2026-06-06');
  });
});
