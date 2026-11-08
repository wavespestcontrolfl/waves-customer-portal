import { describe, expect, it } from 'vitest';
import {
  ASKED_TIME_CHECKED_HINT, PHONE_SCRIPT_HINT, askedTimeCreateFields, askedTimeHint, askedTimeMoveFields, toldBadgeText,
} from './dayOnlyPromise';

describe('day-only promise words and request fields', () => {
  it('the helper line is the phone script until the box is checked', () => {
    expect(askedTimeHint(false)).toBe(PHONE_SCRIPT_HINT);
    expect(askedTimeHint(undefined)).toBe(PHONE_SCRIPT_HINT);
    expect(askedTimeHint(true)).toBe(ASKED_TIME_CHECKED_HINT);
    expect(PHONE_SCRIPT_HINT).toBe("Promise the day only: 'We'll text your arrival window the day before.'");
    expect(ASKED_TIME_CHECKED_HINT).toBe('Tell the customer this time.');
  });

  it('the create request carries customerAskedTime only with the gate on AND the box checked', () => {
    expect(askedTimeCreateFields(true, true)).toEqual({ customerAskedTime: true });
    expect(askedTimeCreateFields(true, false)).toEqual({});
    expect(askedTimeCreateFields(false, true)).toEqual({});
    expect(askedTimeCreateFields(undefined, undefined)).toEqual({});
  });

  it('a move request carries true or false with the gate on, nothing with it off', () => {
    expect(askedTimeMoveFields(true, true)).toEqual({ customerAskedTime: true });
    expect(askedTimeMoveFields(true, false)).toEqual({ customerAskedTime: false });
    expect(askedTimeMoveFields(true, undefined)).toEqual({ customerAskedTime: false });
    expect(askedTimeMoveFields(false, true)).toEqual({});
  });

  it('levels day / hour / none map to the badge text, from the promise not the visit\'s window', () => {
    expect(toldBadgeText({ level: 'day', dayOnly: true, date: null, window: null }, '2026-11-10')).toBe('Told: day only');
    expect(toldBadgeText({ level: 'hour', dayOnly: false, date: '2026-11-10', window: '9:00 AM - 11:00 AM' }, '2026-11-10')).toBe('Told: 9:00 AM - 11:00 AM');
    expect(toldBadgeText({ level: 'hour', dayOnly: false, date: null, window: null }, '2026-11-10')).toBe('Told: time not recorded');
    expect(toldBadgeText({ level: 'none', dayOnly: false }, '2026-11-10')).toBe('');
    expect(toldBadgeText(undefined, '2026-11-10')).toBe('');
    expect(toldBadgeText(null, 'x')).toBe('');
  });

  it('a promised date that differs from the visit\'s current date leads the text (a silent move)', () => {
    const told = { level: 'hour', dayOnly: false, date: '2026-11-10', window: '9:00 AM - 11:00 AM' };
    expect(toldBadgeText(told, '2026-11-12')).toBe('Told: Tue, Nov 10, 9:00 AM - 11:00 AM');
    expect(toldBadgeText(told, '2026-11-12T00:00:00.000Z')).toBe('Told: Tue, Nov 10, 9:00 AM - 11:00 AM');
    expect(toldBadgeText(told, '2026-11-10T00:00:00.000Z')).toBe('Told: 9:00 AM - 11:00 AM');
    expect(toldBadgeText({ level: 'day', dayOnly: true, date: '2026-11-10', window: null }, '2026-11-12')).toBe('Told: Tue, Nov 10, day only');
    expect(toldBadgeText({ level: 'day', dayOnly: true, date: '2026-11-10', window: null }, '2026-11-10')).toBe('Told: day only');
  });
});
