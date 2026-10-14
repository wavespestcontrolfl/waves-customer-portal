import { describe, expect, it } from 'vitest';
import { celsiusCapTip } from './celsiusCapCopy';

describe('celsiusCapTip', () => {
  it('states the figure the stats route sent: 2 under v13, 3 before it', () => {
    expect(celsiusCapTip(2)).toBe('We spot-treat with Celsius WG (max 2 applications a year)');
    expect(celsiusCapTip(3)).toBe('We spot-treat with Celsius WG (max 3 applications a year)');
    expect(celsiusCapTip('2')).toBe('We spot-treat with Celsius WG (max 2 applications a year)');
  });
  it('names no number when the stats have not arrived or are unusable', () => {
    for (const none of [undefined, null, '', 0, -1, 2.5, 'two', NaN]) {
      expect(celsiusCapTip(none)).toBe('We spot-treat with Celsius WG (a yearly application limit applies)');
    }
  });
});
