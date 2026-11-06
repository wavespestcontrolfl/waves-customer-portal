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

  it('levels day / hour / none map to the badge text', () => {
    expect(toldBadgeText({ level: 'day', dayOnly: true }, '8:00–9:30 AM')).toBe('Told: day only');
    expect(toldBadgeText({ level: 'hour', dayOnly: false }, '8:00–9:30 AM')).toBe('Told: 8:00–9:30 AM');
    expect(toldBadgeText({ level: 'hour', dayOnly: false }, '')).toBe('Told: an arrival window');
    expect(toldBadgeText({ level: 'none', dayOnly: false }, '8:00–9:30 AM')).toBe('');
    expect(toldBadgeText(undefined, '8:00–9:30 AM')).toBe('');
    expect(toldBadgeText(null, 'x')).toBe('');
  });
});
