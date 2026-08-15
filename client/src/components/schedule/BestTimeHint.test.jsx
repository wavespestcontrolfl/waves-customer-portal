import { describe, it, expect } from 'vitest';
import { bestTimeLabel } from './BestTimeHint';

describe('bestTimeLabel', () => {
  it('formats an on-the-hour start with a rounded detour', () => {
    expect(bestTimeLabel({ start: '09:00', detourMinutes: 4.4 }))
      .toBe('9:00 AM · +4 min drive');
  });

  it('says no detour when the stop is on the way', () => {
    expect(bestTimeLabel({ start: '13:00', detourMinutes: 0 }))
      .toBe('1:00 PM · no detour');
  });

  it('treats a missing detour as no detour rather than NaN', () => {
    expect(bestTimeLabel({ start: '12:00', detourMinutes: null }))
      .toBe('12:00 PM · no detour');
  });
});
