'use strict';

// Property-based tests (fast-check) for dueDateFromVisit, the Billing Recovery
// due date. Rule: the due date is the visit's own service date; with no service
// date it is the Eastern (America/New_York) calendar day of completed_at. The
// result is a 'YYYY-MM-DD' string, or undefined when the visit has neither.
//
// #6681 shipped because pg returns a DATE column as a Date at the server's local
// midnight. On the UTC production host that instant is the previous evening in
// Eastern time, so every due date landed one day early, and a developer Mac
// (Eastern) never showed it. The service_date property builds the value both
// ways (pg on this host, and pg on a UTC host), so it catches that class of bug
// on any machine.

jest.mock('../models/db', () => {
  const db = jest.fn(() => { throw new Error('db access in a property test'); });
  db.raw = jest.fn();
  db.transaction = jest.fn();
  db.fn = { now: jest.fn() };
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const fc = require('fast-check');
const { fastCheckParams } = require('./helpers/fast-check-params');
const { dueDateFromVisit } = require('../services/billing-recovery-bill');

// ---------------------------------------------------------------- oracle
// The Eastern calendar day of an instant, from the US DST rules (2007 and
// later) with plain arithmetic: no Intl and no repo date helper.
const HOUR = 3600000;
const pad = (n, w = 2) => String(n).padStart(w, '0');

function nthSundayUtcDay(year, month0, nth) {
  const firstDow = new Date(Date.UTC(year, month0, 1)).getUTCDay();
  return 1 + ((7 - firstDow) % 7) + (nth - 1) * 7;
}

function isEasternDst(ms) {
  const y = new Date(ms).getUTCFullYear();
  // DST starts on the 2nd Sunday of March at 2:00 EST (07:00Z) and ends on the
  // 1st Sunday of November at 2:00 EDT (06:00Z).
  const start = Date.UTC(y, 2, nthSundayUtcDay(y, 2, 2), 7);
  const end = Date.UTC(y, 10, nthSundayUtcDay(y, 10, 1), 6);
  return ms >= start && ms < end;
}

function easternDay(ms) {
  const shifted = new Date(ms + (isEasternDst(ms) ? -4 : -5) * HOUR);
  return `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

// How pg returns a DATE column: a Date at the reading host's local midnight.
const pgDateOnThisHost = (day) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d);
};
// The same value as the UTC production host returns it.
const pgDateOnUtcHost = (day) => new Date(`${day}T00:00:00.000Z`);

// ---------------------------------------------------------------- generators
const MIN_MS = Date.UTC(2007, 0, 1);
const MAX_MS = Date.UTC(2060, 0, 1);

// Instants spread over 2007-2060, plus instants near the points where the
// Eastern calendar day flips: UTC midnight, Eastern midnight (EDT and EST), both
// DST changes and New Year in Eastern time.
const nearDayFlip = fc.tuple(
  fc.integer({ min: 2007, max: 2059 }),
  fc.constantFrom('utcMidnight', 'etMidnightEdt', 'etMidnightEst', 'dstStart', 'dstEnd', 'newYear'),
  fc.integer({ min: 1, max: 366 }),
  fc.integer({ min: -3 * 60, max: 3 * 60 }),
).map(([y, kind, dayOfYear, minuteDelta]) => {
  const day = Date.UTC(y, 0, dayOfYear);
  const base = {
    utcMidnight: day,
    etMidnightEdt: day + 4 * HOUR,
    etMidnightEst: day + 5 * HOUR,
    dstStart: Date.UTC(y, 2, nthSundayUtcDay(y, 2, 2), 7),
    dstEnd: Date.UTC(y, 10, nthSundayUtcDay(y, 10, 1), 6),
    newYear: Date.UTC(y, 0, 1, 5),
  }[kind];
  return base + minuteDelta * 60000;
});
const instantMs = fc.oneof(
  { arbitrary: fc.integer({ min: MIN_MS, max: MAX_MS - 1 }), weight: 2 },
  { arbitrary: nearDayFlip, weight: 3 },
);

// Valid calendar days 'YYYY-MM-DD', 1970-2099.
const calendarDay = fc.integer({ min: 0, max: Date.UTC(2099, 11, 31) / 86400000 }).map((n) => {
  const d = new Date(n * 86400000);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
});

const pgServiceDate = fc.tuple(calendarDay, fc.constantFrom('thisHost', 'utcHost')).map(([day, host]) => ({
  day,
  host,
  value: host === 'utcHost' ? pgDateOnUtcHost(day) : pgDateOnThisHost(day),
}));

// completed_at as pg returns a timestamptz (a Date), or as an ISO string.
const completedAt = fc.tuple(instantMs, fc.boolean()).map(([ms, asString]) => (
  asString ? new Date(ms).toISOString() : new Date(ms)
));
const absent = fc.constantFrom(undefined, null, '');

// ---------------------------------------------------------------- properties
describe('dueDateFromVisit properties', () => {
  test('completed_at with no service_date gives the Eastern calendar day of that instant', () => {
    fc.assert(fc.property(instantMs, absent, (ms, serviceDate) => {
      expect(dueDateFromVisit({ service_date: serviceDate, completed_at: new Date(ms) })).toBe(easternDay(ms));
    }), fastCheckParams());
  });

  test('a service_date read from a Postgres DATE keeps its calendar day, on this host and on a UTC host', () => {
    fc.assert(fc.property(pgServiceDate, fc.option(completedAt, { nil: undefined }), (sd, done) => {
      expect(dueDateFromVisit({ service_date: sd.value, completed_at: done })).toBe(sd.day);
    }), fastCheckParams());
  });

  test('a YYYY-MM-DD service_date string is returned unchanged', () => {
    fc.assert(fc.property(calendarDay, fc.option(completedAt, { nil: undefined }), (day, done) => {
      expect(dueDateFromVisit({ service_date: day, completed_at: done })).toBe(day);
    }), fastCheckParams());
  });

  test('no date field gives undefined; any date field gives a YYYY-MM-DD string and never throws', () => {
    const serviceDate = fc.oneof(absent, pgServiceDate.map((sd) => sd.value), calendarDay);
    fc.assert(fc.property(serviceDate, fc.oneof(absent, completedAt), (sd, done) => {
      const got = dueDateFromVisit({ service_date: sd, completed_at: done });
      if (!sd && !done) {
        expect(got).toBeUndefined();
      } else {
        expect(got).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }), fastCheckParams());
  });
});
