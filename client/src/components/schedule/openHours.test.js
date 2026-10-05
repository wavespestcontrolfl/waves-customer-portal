import { describe, expect, it } from 'vitest';
import { formatOpenHour, openHoursForDay } from './openHours';

// 2026-10-03 06:00 ET (EDT, UTC-4) — before the open-hours day starts.
const EARLY = new Date('2026-10-03T10:00:00Z');

describe('openHoursForDay', () => {
  it('lists each empty hour from 7 AM to 7 PM; any overlap fills the hour', () => {
    const services = [
      { windowStart: '08:00', windowEnd: '09:00', status: 'confirmed' },
      { windowStart: '11:00', windowEnd: '11:30', status: 'confirmed' },
      { windowStart: '13:30', windowEnd: '14:30', status: 'pending' },
    ];
    expect(openHoursForDay('2026-10-03', services, { now: EARLY })).toEqual([7, 9, 10, 12, 15, 16, 17, 18]);
  });

  it('frees the hour of a cancelled or skipped visit and treats a missing end as one hour', () => {
    const services = [
      { windowStart: '09:00', windowEnd: '10:00', status: 'cancelled' },
      { windowStart: '10:00', windowEnd: '11:00', status: 'skipped' },
      { windowStart: '12:00', status: 'confirmed' },
    ];
    expect(openHoursForDay('2026-10-04', services, { now: EARLY })).toEqual([7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18]);
  });

  it('narrows to the booking hours the server enforces, and frees completed visits', () => {
    const services = [{ windowStart: '09:00', windowEnd: '10:00', status: 'completed' }];
    expect(openHoursForDay('2026-10-04', services, { now: EARLY, bookingHours: { startMinutes: 480, endMinutes: 1080 } }))
      .toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
  });

  it('reads a start-only visit by its stored duration', () => {
    const services = [{ windowStart: '08:00', estimatedDuration: 120, status: 'confirmed' }];
    expect(openHoursForDay('2026-10-04', services, { now: EARLY })).toEqual([7, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  });

  it('drops hours already started today and has none on a past day', () => {
    const tenFifteenEt = new Date('2026-10-03T14:15:00Z');
    expect(openHoursForDay('2026-10-03', [], { now: tenFifteenEt })).toEqual([11, 12, 13, 14, 15, 16, 17, 18]);
    expect(openHoursForDay('2026-10-02', [], { now: tenFifteenEt })).toEqual([]);
    // At 10:00 sharp the 10 AM hour has begun.
    expect(openHoursForDay('2026-10-03', [], { now: new Date('2026-10-03T14:00:00Z') })[0]).toBe(11);
  });
});

describe('formatOpenHour', () => {
  it('names the hour the way the day list writes windows', () => {
    expect(formatOpenHour(9)).toBe('9–10 AM');
    expect(formatOpenHour(11)).toBe('11 AM–12 PM');
    expect(formatOpenHour(12)).toBe('12–1 PM');
  });
});
