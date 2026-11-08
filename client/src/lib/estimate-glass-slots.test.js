// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  approveSlotLabel,
  approveSlotWhen,
  arrivalWindowLabel,
  firstVisitDayAndWindow,
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

  it('recounts from still-bookable slots when a counted opening stales out', () => {
    // Server counted 2 openings today, but 12:30 drifted inside the 2-hour
    // lead while the page sat open. The server pins every scarce-first-day
    // slot into the payload, so the shortfall means that opening is truly
    // gone — the badge must say 1, not keep the fetch-time 2 (Codex P2,
    // PR #2469).
    expect(glassScarcityInfo(
      [
        { date: '2026-07-05', windowStart: '12:30' }, // inside the 2h lead → stale
        { date: '2026-07-05', windowStart: '14:00' },
      ],
      { date: '2026-07-05', openCount: 2 },
      NOW,
    )).toEqual({ count: 1, label: 'Only 1 opening today — 2:00 PM' });
  });

  it('handles the weekday form for later-week scarcity', () => {
    expect(glassScarcityInfo(
      [{ date: '2026-07-07', windowStart: '09:00' }],
      { date: '2026-07-07', openCount: 1 },
      NOW,
    )).toEqual({ count: 1, label: 'Only 1 opening on Tuesday — 9:00 AM' });
  });
});

describe('first visit line pieces', () => {
  it('the arrival window is the start plus two hours, with AM/PM once when both ends share it', () => {
    expect(arrivalWindowLabel('09:00')).toBe('9:00-11:00 AM');
    expect(arrivalWindowLabel('11:00')).toBe('11:00 AM-1:00 PM');
    expect(arrivalWindowLabel('13:00:00')).toBe('1:00-3:00 PM');
    expect(arrivalWindowLabel('')).toBeNull();
  });

  it('names the ET calendar day and the window, independent of the browser zone', () => {
    expect(firstVisitDayAndWindow('2026-11-09', '09:00')).toBe('Mon, Nov 9, 9:00-11:00 AM');
    expect(firstVisitDayAndWindow(undefined, '09:00')).toBeNull();
    expect(firstVisitDayAndWindow('2026-11-09', null)).toBeNull();
  });
});

describe('approveSlotLabel', () => {
  // Fri 2026-11-06, 10:00 ET.
  const FRIDAY = new Date('2026-11-06T15:00:00Z');
  const meta = (date) => glassSlotMeta({ slotId: 's', date, windowStart: '09:00' });

  it('keeps the weekday-and-time label for a visit within 6 days', () => {
    expect(approveSlotLabel(meta('2026-11-09'), FRIDAY)).toBe('Approve — Mon 9:00 AM');
    expect(approveSlotLabel(meta('2026-11-12'), FRIDAY)).toBe('Approve — Thu 9:00 AM');
  });

  it('adds the date once the visit is 7 or more days out', () => {
    expect(approveSlotLabel(meta('2026-11-13'), FRIDAY)).toBe('Approve — Fri, Nov 13, 9:00 AM');
    expect(approveSlotLabel(meta('2026-11-23'), FRIDAY)).toBe('Approve — Mon, Nov 23, 9:00 AM');
  });

  it('counts days on the ET calendar, not the UTC one (9 PM ET Friday is already Saturday in UTC)', () => {
    expect(approveSlotLabel(meta('2026-11-13'), new Date('2026-11-07T02:00:00Z'))).toBe('Approve — Fri, Nov 13, 9:00 AM');
  });

  it('approveSlotWhen is the same rule without the prefix (the sticky bar uses it)', () => {
    expect(approveSlotWhen(meta('2026-11-09'), FRIDAY)).toBe('Mon 9:00 AM');
    expect(approveSlotWhen(meta('2026-11-23'), FRIDAY)).toBe('Mon, Nov 23, 9:00 AM');
    expect(approveSlotWhen({ dow: 'Tue', time: '9 AM' }, FRIDAY)).toBe('Tue 9 AM');
  });
});
