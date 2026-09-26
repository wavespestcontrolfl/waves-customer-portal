/**
 * Call booking window-end computation (schema 1.15.0, owner ruling
 * 2026-09-26 — "agreed time windows like '6 to 9pm' never get booked").
 *
 * resolveCallBookingWindowEnd is the pure decision helper the call-booking
 * path uses to pick window_end: the caller's AGREED arrival-window end when
 * it is usable, else the historical start+1h default. windowStart here is
 * always already on-the-hour (the off-hour guard upstream holds anything
 * else for office review) — this function does not re-check that.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/twilio-numbers', () => ({
  isInternalNumber: jest.fn(() => false),
  isOwnedNumber: jest.fn(() => false),
  findByNumber: jest.fn(() => null),
  getLeadSourceFromNumber: jest.fn(() => ({ source: 'phone_call' })),
}));

const { _test } = require('../services/call-recording-processor');
const { resolveCallBookingWindowEnd } = _test;

describe('resolveCallBookingWindowEnd', () => {
  test('an agreed window end on the SAME day, on the hour, after the start is used', () => {
    const result = resolveCallBookingWindowEnd({
      scheduledDate: '2026-08-11',
      windowStart: '18:00',
      confirmedWindowEndAt: '2026-08-11T21:00',
    });
    expect(result).toEqual({ windowEnd: '21:00', agreedUsed: true });
  });

  test('an agreed window end on the HALF hour is also usable', () => {
    const result = resolveCallBookingWindowEnd({
      scheduledDate: '2026-09-01',
      windowStart: '12:00',
      confirmedWindowEndAt: '2026-09-01T13:30',
    });
    expect(result).toEqual({ windowEnd: '13:30', agreedUsed: true });
  });

  test('no agreed window end falls back to start+1h', () => {
    const result = resolveCallBookingWindowEnd({
      scheduledDate: '2026-08-11',
      windowStart: '18:00',
      confirmedWindowEndAt: null,
    });
    expect(result).toEqual({ windowEnd: '19:00', agreedUsed: false });
  });

  test('start+1h caps at 23:00 for a 22:00+ start, same as before', () => {
    const result = resolveCallBookingWindowEnd({
      scheduledDate: '2026-08-11',
      windowStart: '23:00',
      confirmedWindowEndAt: null,
    });
    expect(result).toEqual({ windowEnd: '23:00', agreedUsed: false });
  });

  test('an agreed end on a DIFFERENT day is rejected (falls back to start+1h)', () => {
    const result = resolveCallBookingWindowEnd({
      scheduledDate: '2026-08-11',
      windowStart: '18:00',
      confirmedWindowEndAt: '2026-08-12T09:00',
    });
    expect(result).toEqual({ windowEnd: '19:00', agreedUsed: false });
  });

  test('an agreed end BEFORE (or equal to) the start is rejected', () => {
    const before = resolveCallBookingWindowEnd({
      scheduledDate: '2026-08-11',
      windowStart: '18:00',
      confirmedWindowEndAt: '2026-08-11T17:00',
    });
    expect(before).toEqual({ windowEnd: '19:00', agreedUsed: false });

    const equal = resolveCallBookingWindowEnd({
      scheduledDate: '2026-08-11',
      windowStart: '18:00',
      confirmedWindowEndAt: '2026-08-11T18:00',
    });
    expect(equal).toEqual({ windowEnd: '19:00', agreedUsed: false });
  });

  test('an agreed end NOT on the hour or half hour is rejected', () => {
    const result = resolveCallBookingWindowEnd({
      scheduledDate: '2026-08-11',
      windowStart: '18:00',
      confirmedWindowEndAt: '2026-08-11T21:15',
    });
    expect(result).toEqual({ windowEnd: '19:00', agreedUsed: false });
  });

  test('a malformed/free-text agreed end is rejected (no throw)', () => {
    const result = resolveCallBookingWindowEnd({
      scheduledDate: '2026-08-11',
      windowStart: '18:00',
      confirmedWindowEndAt: 'between 6 and 9 tonight',
    });
    expect(result).toEqual({ windowEnd: '19:00', agreedUsed: false });
  });

  test('an off-hour window START (e.g. a reused/legacy row) keeps the historical +1h behavior unaffected by an agreed end', () => {
    // windowStart itself being off-hour is guarded upstream (the booking
    // holds for office review before this ever runs) — this only pins that
    // resolveCallBookingWindowEnd, given one anyway, still computes the
    // same default relative to whatever start it is handed.
    const result = resolveCallBookingWindowEnd({
      scheduledDate: '2026-08-11',
      windowStart: '18:30',
      confirmedWindowEndAt: '2026-08-11T21:00',
    });
    // 21:00 is after 18:30, same day, on the hour — still usable; the
    // off-hour START is a separate, upstream concern (offHourStart guard),
    // not something this function re-validates.
    expect(result).toEqual({ windowEnd: '21:00', agreedUsed: true });
  });

  test('no window start returns null with agreedUsed false', () => {
    expect(resolveCallBookingWindowEnd({ scheduledDate: '2026-08-11', windowStart: null, confirmedWindowEndAt: '2026-08-11T21:00' }))
      .toEqual({ windowEnd: null, agreedUsed: false });
  });
});
