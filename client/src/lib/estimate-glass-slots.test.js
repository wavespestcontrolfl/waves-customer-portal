// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  glassScarcityInfo,
  glassSlotIsStale,
  glassSlotMeta,
  glassSlotWeekday,
} from './estimate-glass-slots';

// 15:00Z = 11:00 ET (EDT) on Sunday 2026-07-05.
const NOW = new Date('2026-07-05T15:00:00Z');

afterEach(() => vi.useRealTimers());

describe('glassSlotIsStale', () => {
  it('marks a same-day slot strictly inside the 2-hour lead stale, matching the server guard', () => {
    expect(glassSlotIsStale({ date: '2026-07-05', windowStart: '12:30' }, NOW)).toBe(true);
    expect(glassSlotIsStale({ date: '2026-07-05', windowStart: '13:30' }, NOW)).toBe(false);
    expect(glassSlotIsStale({ date: '2026-07-04', windowStart: '09:00' }, NOW)).toBe(true);
    expect(glassSlotIsStale({ date: '2026-07-06', windowStart: '08:00' }, NOW)).toBe(false);
  });

  it('keeps a slot exactly at the lead boundary bookable — the generator offers it', () => {
    // 11:00 ET now, 13:00 ET start = exactly 120 minutes: NOT stale.
    expect(glassSlotIsStale({ date: '2026-07-05', windowStart: '13:00' }, NOW)).toBe(false);
  });
});

describe('glassSlotMeta', () => {
  it('builds the slot-aware CTA label parts', () => {
    expect(glassSlotMeta({ slotId: 's1', date: '2026-07-07', windowStart: '09:00' })).toEqual({
      slotId: 's1',
      date: '2026-07-07',
      windowStart: '09:00',
      dow: 'Tue',
      time: '9:00 AM',
      techFirstName: null,
    });
    // Real technician carries through for the chip — never default to the
    // wrong name for a valid slot.
    expect(glassSlotMeta({ slotId: 's3', date: '2026-07-07', windowStart: '09:00', techFirstName: 'Jose' }).techFirstName).toBe('Jose');
    expect(glassSlotMeta({ slotId: 's2', date: '2026-07-07', windowStart: '13:30' }).time).toBe('1:30 PM');
    expect(glassSlotMeta(null)).toBe(null);
  });

  it('weekday derives from the ET calendar date, stable across browser TZs', () => {
    expect(glassSlotWeekday('2026-07-05')).toBe('Sunday');
    expect(glassSlotWeekday('not-a-date')).toBe(null);
  });
});

describe('glassScarcityInfo', () => {
  it('reports scarcity only when the first day has ≤2 fresh slots', () => {
    const info = glassScarcityInfo([
      { date: '2026-07-06', windowStart: '09:00' },
      { date: '2026-07-06', windowStart: '14:00' },
      { date: '2026-07-08', windowStart: '09:00' },
    ], NOW);
    expect(info).toEqual({ count: 2, label: 'Only 2 openings tomorrow — 9:00 AM & 2:00 PM' });
  });

  it('self-removes when the first day has plenty', () => {
    const slots = ['09:00', '10:30', '13:00'].map((windowStart) => ({ date: '2026-07-06', windowStart }));
    expect(glassScarcityInfo(slots, NOW)).toBe(null);
  });

  it('ignores stale same-day slots when picking the first day', () => {
    // The 12:30 slot is inside the lead — the first REAL day is the 7th.
    const info = glassScarcityInfo([
      { date: '2026-07-05', windowStart: '12:30' },
      { date: '2026-07-07', windowStart: '09:00' },
    ], NOW);
    expect(info).toEqual({ count: 1, label: 'Only 1 opening on Tuesday — 9:00 AM' });
  });

  it('returns null with no slots', () => {
    expect(glassScarcityInfo([], NOW)).toBe(null);
    expect(glassScarcityInfo(null, NOW)).toBe(null);
  });
});
