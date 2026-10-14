import { afterEach, describe, expect, it, vi } from 'vitest';
import { elapsedSince, onSiteTimeOf } from './on-site-time';

afterEach(() => vi.useRealTimers());

describe('on-site time', () => {
  it('takes the on-site status-log entry, else checkInTime, else nothing', () => {
    expect(onSiteTimeOf({ statusLog: [{ status: 'en_route', at: 'a' }, { status: 'on_site', at: 'b' }], checkInTime: 'c' })).toBe('b');
    expect(onSiteTimeOf({ statusLog: [{ status: 'en_route', at: 'a' }], checkInTime: 'c' })).toBe('c');
    expect(onSiteTimeOf({ checkInTime: 'c' })).toBe('c');
    expect(onSiteTimeOf({})).toBeUndefined();
    expect(onSiteTimeOf(null)).toBeUndefined();
  });

  it('reads m:ss under an hour and h:mm:ss after, never negative, 0:00 with no time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T14:00:00.000Z'));
    expect(elapsedSince('2026-10-05T13:59:55.000Z')).toBe('0:05');
    expect(elapsedSince('2026-10-05T13:30:09.000Z')).toBe('29:51');
    expect(elapsedSince('2026-10-05T12:40:39.000Z')).toBe('1:19:21');
    expect(elapsedSince('2026-10-05T15:00:00.000Z')).toBe('0:00');
    expect(elapsedSince(null)).toBe('0:00');
  });
});
