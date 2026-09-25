/**
 * The $99 one-time WaveGuard Membership add-on (service key
 * `waveguard_membership`) must never be copied onto later visits of a
 * recurring series. Its `scheduled_service_addons` rows were written with
 * `recurring_pattern` NULL, and lineDueOnRecurringDate reads a NULL pattern
 * as "due on every occurrence" — so on 2026-09-25 the nightly top-up and the
 * completion auto-extend copied the fee onto six customers' future visits.
 * The key alone now makes the line due only on the visit it was sold on.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return { ...actual, adminAuthenticate: (req, _res, next) => next() };
});

const { lineDueOnRecurringDate, filterAddonLinesForDate } = require('../routes/admin-schedule')._test;

const BASE = '2026-09-12';
const LATER = '2026-12-10';

// Stored rows (spawn / top-up / auto-extend / alert callers).
const storedMembership = { service_key_snapshot: 'waveguard_membership', recurring_pattern: null, estimated_price: 99 };
const storedBait = { service_key_snapshot: 'rodent_bait', recurring_pattern: null, estimated_price: 30 };
// Booking-time pricing lines (camelCase).
const pricedMembership = { serviceKey: 'waveguard_membership', recurringPattern: null, price: 99 };
const pricedBait = { serviceKey: 'rodent_bait', recurringPattern: null, price: 30 };

describe('one-time WaveGuard Membership add-on', () => {
  test('a NULL-pattern membership row is not due on a later visit', () => {
    expect(lineDueOnRecurringDate(storedMembership, BASE, LATER)).toBe(false);
    expect(lineDueOnRecurringDate(pricedMembership, BASE, LATER)).toBe(false);
  });

  test('a membership row carrying a recurring pattern is still not due later', () => {
    expect(lineDueOnRecurringDate({ ...storedMembership, recurring_pattern: 'quarterly' }, BASE, LATER)).toBe(false);
  });

  test('an ordinary NULL-pattern add-on is still due on every visit', () => {
    expect(lineDueOnRecurringDate(storedBait, BASE, LATER)).toBe(true);
    expect(lineDueOnRecurringDate(pricedBait, BASE, LATER)).toBe(true);
  });

  test('the visit it was sold on keeps the fee (booking price-floor gate)', () => {
    expect(lineDueOnRecurringDate(pricedMembership, BASE, BASE)).toBe(true);
    expect(filterAddonLinesForDate([pricedMembership, pricedBait], BASE, BASE)).toEqual([pricedMembership, pricedBait]);
  });

  test('later-visit filtering drops only the membership line', () => {
    expect(filterAddonLinesForDate([storedMembership, storedBait], BASE, LATER)).toEqual([storedBait]);
  });
});
