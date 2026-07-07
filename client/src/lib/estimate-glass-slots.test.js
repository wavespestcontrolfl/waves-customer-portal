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
  it('reports scarcity from the server pre-curation count, times from visible slots', () => {
    const info = glassScarcityInfo([
      { date: '2026-07-06', windowStart: '09:00' },
      { date: '2026-07-06', windowStart: '14:00' },
      { date: '2026-07-08', windowStart: '09:00' },
    ], { date: '2026-07-06', openCount: 2 }, NOW);
    expect(info).toEqual({ count: 2, label: 'Only 2 openings tomorrow — 9:00 AM & 2:00 PM' });
  });

  it('self-removes when the TRUE first-day count has plenty, even if the curated list shows few', () => {
    // Curation sliced the display list down to one same-day slot, but the
    // server counted 5 bookable — claiming "Only 1 opening" would be
    // manufactured scarcity.
    expect(glassScarcityInfo(
      [{ date: '2026-07-06', windowStart: '09:00' }],
      { date: '2026-07-06', openCount: 5 },
      NOW,
    )).toBe(null);
  });

  it('never renders without the server count', () => {
    expect(glassScarcityInfo(
      [{ date: '2026-07-06', windowStart: '09:00' }],
      null,
      NOW,
    )).toBe(null);
  });

  it('self-removes when the scarce day has no fresh visible slots left', () => {
    // Server said 1 opening today at 12:30 — but that window slipped inside
    // the lead client-side; no times to show, no claim to make.
    expect(glassScarcityInfo(
      [{ date: '2026-07-05', windowStart: '12:30' }],
      { date: '2026-07-05', openCount: 1 },
      NOW,
    )).toBe(null);
  });

  it('says "next at" instead of enumerating when visible times cover fewer than the counted openings', () => {
    // Server counted 2 openings today (9:00 stale-drifted or sliced away;
    // only 14:00 still visible). Enumerating "— 2:00 PM" would read as if
    // 2:00 PM were both openings — soften to "next at" instead.
    expect(glassScarcityInfo(
      [
        { date: '2026-07-05', windowStart: '12:30' }, // inside the 2h lead → stale
        { date: '2026-07-05', windowStart: '14:00' },
      ],
      { date: '2026-07-05', openCount: 2 },
      NOW,
    )).toEqual({ count: 2, label: 'Only 2 openings today — next at 2:00 PM' });
  });

  it('handles the weekday form for later-week scarcity', () => {
    expect(glassScarcityInfo(
      [{ date: '2026-07-07', windowStart: '09:00' }],
      { date: '2026-07-07', openCount: 1 },
      NOW,
    )).toEqual({ count: 1, label: 'Only 1 opening on Tuesday — 9:00 AM' });
  });
});
