import { describe, expect, it } from 'vitest';
import { formatTimeWindow } from './timeWindow';

// Owner 2026-11-02: minutes on every time, AM/PM once when both ends share it.
describe('formatTimeWindow', () => {
  it.each([
    ['07:00', '08:00', '7:00–8:00 AM'],
    ['08:00', '08:30', '8:00–8:30 AM'],
    ['09:00:00', '10:00:00', '9:00–10:00 AM'],
    ['11:00', '12:00', '11:00 AM–12:00 PM'],
    ['12:00', '13:00', '12:00–1:00 PM'],
    ['23:00', '24:00', '11:00 PM–12:00 AM'],
  ])('%s to %s reads %s', (start, end, label) => {
    expect(formatTimeWindow(start, end)).toBe(label);
  });

  it('shows the start alone without a readable end, and nothing without a start', () => {
    expect(formatTimeWindow('14:30', null)).toBe('2:30 PM');
    expect(formatTimeWindow(null, '10:00')).toBe('');
    expect(formatTimeWindow('soon', '10:00')).toBe('');
  });
});
