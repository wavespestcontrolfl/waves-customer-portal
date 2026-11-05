'use strict';

// Property-based tests (fast-check) for violatesWindowFeasibility, the guard
// that refuses a nightly route reorder when the new stop order would make the
// technician miss a promised arrival window. A wrong "true" blocks a good
// reorder; a wrong "false" lets a reorder break a promise to a customer.
//
// Each generated stop is its own customer, except in the last property: one
// customer's two services in the same slot at one address are one visit (#4435
// counted them as two arrivals). That property ends the day with the pair, so
// it does not depend on the work-time rule of a merged visit, which is still
// open. A pair without map coordinates is still counted as two arrivals today
// and is left out.

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
const { violatesWindowFeasibility } = require('../services/route-reorder')._internals;
const { workDuration } = require('../services/route-reorder-window-fit');

// A fixed travel model: "miles" are 10 x the coordinate distance; the same
// place is 0 minutes, any other leg 4 minutes plus 2 per mile.
const RO = {
  HQ: { lat: 0.5, lng: 0.5 },
  haversine: (lat1, lng1, lat2, lng2) => (Math.abs(lat1 - lat2) + Math.abs(lng1 - lng2)) * 10,
  fallbackLegMetrics: (miles) => (miles <= 0
    ? { meters: 0, minutes: 0 }
    : { meters: Math.round(miles * 1609), minutes: Math.round(4 + miles * 2) }),
};
const violates = (stops, legs) => violatesWindowFeasibility(RO, stops, stops, legs);

// ---------------------------------------------------------------- generators
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const windowStart = fc.integer({ min: 32, max: 64 }).map((q) => q * 15); // 08:00-16:00
const arrivalWindow = fc.oneof(
  { weight: 5, arbitrary: fc.record({ start: windowStart, endAdd: fc.option(fc.integer({ min: 2, max: 16 }).map((q) => q * 15), { nil: null }), label: fc.constant(null) }) },
  { weight: 1, arbitrary: fc.record({ start: fc.constant(null), endAdd: fc.constant(null), label: fc.constantFrom('morning', 'afternoon', 'any', null) }) },
  { weight: 2, arbitrary: fc.constant({ start: null, endAdd: null, label: null }) },
);
const stopArb = fc.record({
  coord: fc.oneof(
    { weight: 8, arbitrary: fc.record({ lat: fc.integer({ min: 1, max: 5 }), lng: fc.integer({ min: 1, max: 5 }) }) },
    { weight: 1, arbitrary: fc.constant(null) },
  ),
  win: arrivalWindow,
  minutes: fc.option(fc.integer({ min: 1, max: 12 }).map((q) => q * 10), { nil: null }),
  legMin: fc.integer({ min: 0, max: 90 }),
  service: fc.constantFrom('pest', 'lawn', 'mosquito'),
});

// One scheduled_services row per generated stop, each for its own customer.
function toRow(s, i) {
  return {
    id: `s${i}`, customer_id: `customer-${i}`, technician_id: 't1', visit_id: null,
    service_type: s.service, lat: s.coord ? s.coord.lat : null, lng: s.coord ? s.coord.lng : null,
    route_order: null,
    window_start: s.win.start == null ? null : hhmm(s.win.start),
    window_end: s.win.start == null || s.win.endAdd == null ? null : hhmm(s.win.start + s.win.endAdd),
    time_window: s.win.label,
    estimated_duration_minutes: s.minutes,
    service_address_line1: null, service_address_line2: null, service_address_city: null, service_address_zip: null,
    customer_address_line1: `${i + 1} Main St`, customer_address_line2: null,
    customer_city: 'Bradenton', customer_state: 'FL', customer_zip: '34202',
  };
}
const dayOf = (min, max) => fc.array(stopArb, { minLength: min, maxLength: max });
const legsFor = (minutes) => minutes.map((n) => ({ durationMinutes: n, distanceMeters: 1 }));

// ---------------------------------------------------------------- reference
// A separate simulation of the rule: leave HQ at 8:00, drive, wait for a window
// to open, refuse only when an arrival is after the deadline. The deadline is
// the window start plus 120 minutes; the legacy labels are morning 8:00-12:00
// and afternoon 12:00-17:00.
function referenceWindow(row) {
  if (row.window_start) {
    const [h, m] = row.window_start.slice(0, 5).split(':').map(Number);
    return { open: h * 60 + m, deadline: h * 60 + m + 120 };
  }
  const label = String(row.time_window || '').trim().toLowerCase();
  if (label === 'morning') return { open: 480, deadline: 720 };
  if (label === 'afternoon') return { open: 720, deadline: 1020 };
  return null;
}

function referenceMisses(rows, legMinutes) {
  let clock = 480;
  let prev = RO.HQ;
  let leg = 0;
  for (const row of rows) {
    let travel = 0;
    if (row.lat && row.lng) {
      travel = legMinutes ? legMinutes[leg] : RO.fallbackLegMetrics(RO.haversine(prev.lat, prev.lng, row.lat, row.lng)).minutes;
      leg += 1;
      prev = { lat: row.lat, lng: row.lng };
    }
    let start = clock + travel;
    const win = referenceWindow(row);
    if (win) {
      if (start > win.deadline) return true;
      start = Math.max(start, win.open);
    }
    clock = start + workDuration(row);
  }
  return false;
}

// ---------------------------------------------------------------- properties
describe('violatesWindowFeasibility properties', () => {
  test('the verdict matches a separate simulation of the arrival rule, with and without Google legs', () => {
    const legMode = fc.constantFrom('none', 'exact', 'exactPlusReturn', 'short', 'badValue');
    fc.assert(fc.property(dayOf(0, 7), legMode, fc.nat(20), (stops, mode, badAt) => {
      const rows = stops.map(toRow);
      const geoLegs = stops.filter((s) => s.coord).map((s) => s.legMin);
      let legs;
      let referenceLegs = null;
      if (mode === 'exact') { legs = legsFor(geoLegs); referenceLegs = geoLegs; }
      if (mode === 'exactPlusReturn') { legs = legsFor([...geoLegs, 7]); referenceLegs = geoLegs; }
      if (mode === 'short' && geoLegs.length > 0) legs = legsFor(geoLegs.slice(0, -1));
      if (mode === 'badValue' && geoLegs.length > 0) {
        legs = legsFor(geoLegs);
        legs[badAt % legs.length] = { durationMinutes: null };
      }
      // Partial or broken legs are never trusted: the guard falls back to the model.
      expect(violates(rows, legs)).toBe(referenceMisses(rows, referenceLegs));
    }), fastCheckParams());
  });

  test('a day with no promised arrival window is never refused', () => {
    fc.assert(fc.property(dayOf(0, 8), (stops) => {
      const rows = stops.map(toRow).map((row) => ({ ...row, window_start: null, window_end: null, time_window: null }));
      expect(violates(rows)).toBe(false);
    }), fastCheckParams());
  });

  test('every first part of an accepted order is accepted, and an untimed last stop never changes the verdict', () => {
    fc.assert(fc.property(dayOf(1, 7), fc.nat(10), stopArb, (stops, cut, extra) => {
      const rows = stops.map(toRow);
      const full = violates(rows);
      const prefix = rows.slice(0, cut % (rows.length + 1));
      if (full === false) expect(violates(prefix)).toBe(false);
      const tail = { ...toRow(extra, 99), id: 'tail', window_start: null, window_end: null, time_window: null };
      expect(violates([...rows, tail])).toBe(full);
    }), fastCheckParams());
  });

  test('longer work at one stop never turns a refused order into an accepted one', () => {
    fc.assert(fc.property(dayOf(1, 7), fc.nat(10), fc.integer({ min: 0, max: 240 }), (stops, pick, extraMinutes) => {
      const rows = stops.map(toRow);
      const k = pick % rows.length;
      const withWork = (minutes) => rows.map((row, i) => (i === k
        ? { ...row, window_end: null, estimated_duration_minutes: minutes }
        : row));
      const base = withWork(workDuration(rows[k]));
      const longer = withWork(workDuration(rows[k]) + extraMinutes);
      if (violates(base) === true) expect(violates(longer)).toBe(true);
    }), fastCheckParams());
  });

  test('the stored window_end never decides whether the arrival deadline is met', () => {
    fc.assert(fc.property(dayOf(1, 6), fc.integer({ min: 0, max: 600 }), (stops, endAdd) => {
      // Work time is held fixed above any window span, so only window_end varies.
      const base = stops.map(toRow).map((row) => ({
        ...row,
        window_end: null,
        estimated_duration_minutes: Math.max(workDuration(row), 1) + 600,
      }));
      const withEnd = base.map((row) => {
        if (!row.window_start) return row;
        const startMin = Number(row.window_start.slice(0, 2)) * 60 + Number(row.window_start.slice(3, 5));
        return { ...row, window_end: hhmm(Math.min(1439, startMin + (endAdd % 600))) };
      });
      expect(violates(withEnd)).toBe(violates(base));
    }), fastCheckParams());
  });

  test('when one customer ends the day with two services in one slot at one address, only the first arrival is checked', () => {
    const timedGeocoded = stopArb.filter((s) => s.coord !== null && s.win.start !== null);
    const minutes = fc.option(fc.integer({ min: 1, max: 12 }).map((q) => q * 10), { nil: null });
    fc.assert(fc.property(dayOf(0, 5), timedGeocoded, minutes, (stops, visit, secondMinutes) => {
      const rows = stops.map(toRow);
      const first = { ...toRow(visit, 50), id: 'pair-first', customer_id: 'pair-customer' };
      const second = { ...first, id: 'pair-second', service_type: 'lawn', estimated_duration_minutes: secondMinutes };
      const secondUntimed = { ...second, window_start: null, window_end: null, time_window: null };
      expect(violates([...rows, first, second])).toBe(violates([...rows, first, secondUntimed]));
    }), fastCheckParams());
  });
});
