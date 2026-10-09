// Pin check after a visit (GATE_PIN_PARKED_CHECK): the flag rules, the home base, the bell wording and the wiring.
// Pure rules only; the SQL runs in pin-parked-check.db.test.js. Synthetic coordinates and names.
jest.mock('../models/db', () => Object.assign(jest.fn(), { raw: jest.fn(), transaction: jest.fn(), fn: { now: jest.fn() } }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const fs = require('fs');
const path = require('path');
const { _private: p, runPinParkedCheck } = require('../services/pin-parked-check');
const { distanceMeters } = require('../services/gps-arrival-detector');
const { composeAdminAlert } = require('../services/admin-alert-compose');

const BASE = { lat: 27.49, lng: -82.57 };
// A point `north` / `east` metres from BASE.
const at = (north, east = 0) => ({
  lat: BASE.lat + north / 111195,
  lng: BASE.lng + east / (111195 * Math.cos((BASE.lat * Math.PI) / 180)),
});
const RADIUS = 175;
const stop = (north, minutes = 25, east = 0) => ({ ...at(north, east), minutes, startMs: Date.parse('2026-10-08T15:00:00Z'), endMs: 0 });
const visit = (extra = {}) => ({
  id: 'visit-1', customer_id: 'customer-1', technician_id: 'tech-1', visit_id: null, property_id: null, primary_property_id: null,
  completed_at: new Date('2026-10-08T15:30:00Z'), scheduled_day: '2026-10-08',
  service_lat: BASE.lat, service_lng: BASE.lng,
  customer_latitude: BASE.lat, customer_longitude: BASE.lng,
  service_address_line1: null, service_address_city: null, service_address_zip: null,
  customer_address_line1: '100 Fixture Rd', customer_city: 'Fixture City', customer_zip: '34201',
  first_name: 'Fixture', last_name: 'Customer', bouncie_imei: 'imei-1',
  ...extra,
});
const NO_EXCLUSIONS = { home: null, fences: [], neighbours: [] };
const judge = (stops, extra = {}, context = NO_EXCLUSIONS) => p.judgeVisit({ visit: visit(extra), stops, radius: RADIUS, context });

describe('flag rules', () => {
  test('the test geometry is what it claims', () => {
    expect(Math.round(distanceMeters(BASE.lat, BASE.lng, at(540).lat, at(540).lng))).toBe(540);
  });

  test('flags a 25 minute stop 540 m from the pin and reports the spot, the distance and the length', () => {
    const verdict = judge([stop(540, 25)]);
    expect(verdict.flag).toBe(true);
    expect(verdict.distanceM).toBe(540);
    expect(verdict.stopMinutes).toBe(25);
    expect(verdict.parked.lat).toBeCloseTo(at(540).lat, 7);
    expect(verdict.pin).toEqual(BASE);
  });

  test('a stop inside the arrival radius, however short its neighbours, means the pin works', () => {
    expect(judge([stop(120, 6), stop(540, 40)])).toEqual({ flag: false, reason: 'stop_at_pin' });
  });

  test('the radius is the one passed in (the arrival setting), not a constant', () => {
    expect(p.judgeVisit({ visit: visit(), stops: [stop(300, 20)], radius: 350, context: NO_EXCLUSIONS }).reason).toBe('stop_at_pin');
    expect(p.judgeVisit({ visit: visit(), stops: [stop(300, 20)], radius: 175, context: NO_EXCLUSIONS }).flag).toBe(true);
  });

  test('a stop within the radius of the customer pin also settles it, even when the visit carries an old pin', () => {
    const old = at(900);
    const verdict = judge([stop(30, 20)], { service_lat: old.lat, service_lng: old.lng });
    expect(verdict).toEqual({ flag: false, reason: 'stop_at_pin' });
  });

  test.each([
    ['1500 m is the limit: 1501 m is another vehicle or a visit closed away from the truck', 1501, 30, 'stop_too_far'],
    ['a 9 minute stop is not enough', 540, 9, 'stop_too_short'],
  ])('%s', (_name, north, minutes, reason) => {
    expect(judge([stop(north, minutes)])).toEqual({ flag: false, reason });
  });

  test('just inside 1500 m and exactly 10 minutes still flag', () => {
    expect(judge([stop(1499, 10)]).flag).toBe(true);
  });

  test('judges the CLOSEST stop: a short stop nearer than a long one is the answer', () => {
    expect(judge([stop(600, 45), stop(300, 7)])).toEqual({ flag: false, reason: 'stop_too_short' });
  });

  test('no stops at all is not a finding', () => {
    expect(judge([])).toEqual({ flag: false, reason: 'no_stops' });
  });

  test('a customer with no pin and a visit with no pin cannot be checked', () => {
    expect(judge([stop(540)], { service_lat: null, service_lng: null, customer_latitude: null, customer_longitude: null }).flag).toBe(false);
    expect(judge([stop(540)], { service_lat: 0, service_lng: 0, customer_latitude: null, customer_longitude: null }).reason).toBe('no_pin_or_other_property');
  });

  test('falls back to the customer pin when the visit has none', () => {
    const verdict = judge([stop(540)], { service_lat: null, service_lng: null });
    expect(verdict.flag).toBe(true);
  });

  test('a visit stamped at another address, or on another property, is not about the primary pin', () => {
    expect(judge([stop(540)], { service_address_line1: '9 Other Way', service_address_city: 'Fixture City', service_address_zip: '34201' }).reason)
      .toBe('no_pin_or_other_property');
    expect(judge([stop(540)], { property_id: 'prop-2', primary_property_id: 'prop-1' }).reason).toBe('no_pin_or_other_property');
    expect(judge([stop(540)], { property_id: 'prop-1', primary_property_id: 'prop-1' }).flag).toBe(true);
  });

  describe('a stop that is not this job', () => {
    test('the vehicle home base', () => {
      expect(judge([stop(540)], {}, { ...NO_EXCLUSIONS, home: at(520) })).toEqual({ flag: false, reason: 'home_base' });
    });
    test('a business, personal or supplier fence, sized by its own radius', () => {
      const fence = { ...at(900), radius: 500 };
      expect(judge([stop(540)], {}, { ...NO_EXCLUSIONS, fences: [fence] })).toEqual({ flag: false, reason: 'geo_fence' });
      expect(judge([stop(540)], {}, { ...NO_EXCLUSIONS, fences: [{ ...at(900), radius: 100 }] }).flag).toBe(true);
    });
    test("the neighbour's visit the same technician completed that day", () => {
      expect(judge([stop(540)], {}, { ...NO_EXCLUSIONS, neighbours: [at(500)] })).toEqual({ flag: false, reason: 'neighbour_visit' });
      expect(judge([stop(540)], {}, { ...NO_EXCLUSIONS, neighbours: [at(900)] }).flag).toBe(true);
    });
    test('when the closest stop is excluded a farther stop does not take its place', () => {
      expect(judge([stop(300, 20), stop(900, 60)], {}, { ...NO_EXCLUSIONS, home: at(300) })).toEqual({ flag: false, reason: 'home_base' });
    });
  });
});

describe("the effective saved pin (the review panel's own rule)", () => {
  const row = (extra = {}) => ({
    customer_address_line1: '100 Fixture Rd', customer_address_line2: null, customer_city: 'Fixture City', customer_state: 'FL', customer_zip: '34201',
    customer_latitude: 27.5, customer_longitude: -82.6,
    primary_property_id: 'p1', primary_address_line1: '100 Fixture Rd', primary_address_line2: null, primary_city: 'Fixture City',
    primary_state: 'FL', primary_zip: '34201', primary_latitude: 27.49, primary_longitude: -82.57, ...extra,
  });
  test('the matching primary property pin wins over the customer row', () => {
    expect(p.effectivePinColumns(row())).toEqual({ customer_latitude: 27.49, customer_longitude: -82.57 });
  });
  test('a primary property at another address, without a pin, or absent leaves the customer row', () => {
    const own = { customer_latitude: 27.5, customer_longitude: -82.6 };
    expect(p.effectivePinColumns(row({ primary_address_line1: '9 Other Way' }))).toEqual(own);
    expect(p.effectivePinColumns(row({ primary_latitude: null, primary_longitude: null }))).toEqual(own);
    expect(p.effectivePinColumns(row({ primary_property_id: null }))).toEqual(own);
  });
});

describe('days, grouped visits and neighbours', () => {
  test('a visit looks at the day it was scheduled and the ET day it was completed', () => {
    expect(p.visitDays(visit({ scheduled_day: '2026-10-07', completed_at: new Date('2026-10-08T15:30:00Z') })).sort()).toEqual(['2026-10-07', '2026-10-08']);
    // 01:30 UTC on Oct 9 is still the evening of Oct 8 in New York.
    expect(p.visitDays(visit({ scheduled_day: '2026-10-08', completed_at: new Date('2026-10-09T01:30:00Z') }))).toEqual(['2026-10-08']);
  });

  test('grouped partners (one visit_id) are ONE visit', () => {
    const rows = [visit({ id: 'a', visit_id: 'v1' }), visit({ id: 'b', visit_id: 'v1' }), visit({ id: 'c', visit_id: null }), visit({ id: 'd', visit_id: null })];
    expect(p.oneRowPerVisit(rows).map((r) => r.id)).toEqual(['a', 'c', 'd']);
  });

  test('ET day bounds follow the clock change', () => {
    const summer = p.etDayBounds('2026-10-08');
    expect((summer.endMs - summer.startMs) / 3600000).toBe(24);
    expect(new Date(summer.startMs).toISOString()).toBe('2026-10-08T04:00:00.000Z');
    const fallBack = p.etDayBounds('2026-11-01');
    expect((fallBack.endMs - fallBack.startMs) / 3600000).toBe(25);
  });
});

describe("the neighbours' pins (a deliberately generous exclusion)", () => {
  const mine = visit({ id: 'mine', customer_id: 'c-mine' });
  const other = (extra) => visit({ id: 'other', customer_id: 'c-other', ...extra });

  test('a neighbour visit at a secondary property counts at its own stamped coordinates', () => {
    const secondary = other({
      service_lat: at(520).lat, service_lng: at(520).lng, service_address_line1: '9 Other Way', service_address_city: 'Fixture City',
      service_address_zip: '34201', property_id: 'p2', primary_property_id: 'p1',
      customer_latitude: at(3000).lat, customer_longitude: at(3000).lng,
    });
    expect(p.destinationOf(secondary)).toBeNull(); // the visit itself is not about the primary pin
    const pins = p.neighbourPins(mine, [mine, secondary]);
    expect(pins).toHaveLength(2);
    expect(pins.some((pin) => distanceMeters(pin.lat, pin.lng, at(520).lat, at(520).lng) < 1)).toBe(true);
  });

  test('a stop near EITHER the stamp or the primary pin is excluded', () => {
    const both = other({ service_lat: at(520).lat, service_lng: at(520).lng, customer_latitude: at(3000).lat, customer_longitude: at(3000).lng });
    const neighbours = p.neighbourPins(mine, [mine, both]);
    const context = { ...NO_EXCLUSIONS, neighbours };
    expect(judge([stop(540)], {}, context).reason).toBe('neighbour_visit');
    expect(p.excludedStopReason(stop(3000), { radius: RADIUS, ...context })).toBe('neighbour_visit');
  });

  test('with no stamp only the effective primary pin is used; same-customer and other-technician visits are not neighbours', () => {
    const unstamped = other({ service_lat: null, service_lng: null });
    expect(p.neighbourPins(mine, [mine, unstamped])).toHaveLength(1);
    expect(p.neighbourPins(mine, [mine, other({ customer_id: 'c-mine' })])).toEqual([]);
    expect(p.neighbourPins(mine, [mine, other({ technician_id: 'tech-2' })])).toEqual([]);
  });
});

describe('home base', () => {
  const day = (n, lat, lng) => ({ trip_date: `2026-09-${10 + n}`, start_lat: lat, start_lng: lng });

  test('is the spot most days began from, and needs 3 days', () => {
    const home = p.homeBaseFrom([day(1, 27.49, -82.57), day(2, 27.4901, -82.5701), day(3, 27.49, -82.57), day(4, 27.6, -82.6)]);
    expect(distanceMeters(home.lat, home.lng, 27.49, -82.57)).toBeLessThan(30);
    expect(p.homeBaseFrom([day(1, 27.49, -82.57), day(2, 27.49, -82.57), day(3, 27.6, -82.6)])).toBeNull();
    expect(p.homeBaseFrom([])).toBeNull();
  });

  test('ignores rows without coordinates', () => {
    expect(p.homeBaseFrom([day(1, null, null), day(2, 0, 0), day(3, 'x', 'y')])).toBeNull();
  });
});

describe('the bell', () => {
  const row = { id: '22222222-2222-4222-8222-222222222222', customer_id: '11111111-1111-4111-8111-111111111111', visit_date: '2026-10-08', distance_m: 540, stop_minutes: 25 };
  const customer = { first_name: 'Fixture', last_name: 'Customer', address_line1: '100 Fixture Rd', city: 'Fixture City' };

  test('obeys the admin notification rule (a violation throws under test)', () => {
    const composed = composeAdminAlert(p.alertSpec(row, customer));
    expect(composed.headline).toBe('Customers — check the map pin for Fixture Customer');
    expect(composed.why).toBe('Truck parked 540 m from the pin on Oct 8; open the customer to fix it.');
    expect(composed.link).toBe('/admin/customers?customerId=11111111-1111-4111-8111-111111111111');
    expect(composed.metadata).toMatchObject({ severity: 'needs-you', who: 'person', doneWhen: 'pin_checked', subject: { type: 'customer' } });
    // The headline and why together stay inside the owner's 110 characters for the two lines.
    expect(composed.why.length).toBeLessThanOrEqual(110);
  });

  test('a very long name still fits the headline', () => {
    const long = { ...customer, first_name: 'Fixturella-Bartholomew', last_name: 'Customerington-Smythe-Wellesley-Montgomery' };
    expect(() => composeAdminAlert(p.alertSpec(row, long))).not.toThrow();
  });

  test('the street address rides in the full text, never in the headline or why', () => {
    const composed = composeAdminAlert(p.alertSpec(row, customer));
    expect(`${composed.headline} ${composed.why}`).not.toContain('Fixture Rd');
    expect(p.alertDetail(row, customer)).toContain('100 Fixture Rd, Fixture City');
  });
});

describe('one decision per customer', () => {
  const judged = (verdict, completedAt = '2026-10-08T15:30:00Z') => ({ visit: visit({ completed_at: new Date(completedAt) }), verdict });
  const flagged = (metres, completedAt) => judged({ flag: true, distanceM: metres }, completedAt);
  const atPin = (completedAt) => judged({ flag: false, reason: 'stop_at_pin' }, completedAt);

  test('a stop at the pin on ANY visit means the pin works, whichever visit is newer or whose truck it was', () => {
    expect(p.decideCustomer([flagged(540, '2026-10-07T15:00:00Z'), atPin('2026-10-08T15:00:00Z')]).action).toBe('ok');
    expect(p.decideCustomer([atPin('2026-10-07T15:00:00Z'), flagged(540, '2026-10-08T15:00:00Z')]).action).toBe('ok');
  });
  test('an unreadable truck means the pin cannot be judged, unless another visit already shows the pin works', () => {
    const unknown = judged({ flag: false, reason: 'stops_unreadable', unknown: true });
    expect(p.decideCustomer([unknown, flagged(540)]).action).toBe('skip');
    expect(p.decideCustomer([unknown, atPin()]).action).toBe('ok');
  });
  test('with no stop at the pin the NEWEST qualifying visit makes the suggestion', () => {
    const older = flagged(600, '2026-10-07T15:00:00Z');
    const newer = flagged(540, '2026-10-08T15:00:00Z');
    expect(p.decideCustomer([older, newer])).toMatchObject({ action: 'flag', verdict: { distanceM: 540 } });
    expect(p.decideCustomer([newer, older]).verdict.distanceM).toBe(540);
  });
  test('nothing qualifying means nothing to do', () => {
    expect(p.decideCustomer([judged({ flag: false, reason: 'stop_too_short' })]).action).toBe('none');
  });
});

describe('settled suggestions', () => {
  const open = { pin_lat: '27.4900000', pin_lng: '-82.5700000' };
  const customer = { id: 'c1', address_line1: '100 Fixture Rd', address_line2: null, city: 'Fixture City', state: 'FL', zip: '34201', latitude: '27.4900000', longitude: '-82.5700000' };

  test('stays open while the pin is unchanged and not reviewed', () => {
    expect(p.settledReason(open, customer, null)).toBeNull();
  });
  test('closes for a missing customer, a changed pin and a verified pin', () => {
    expect(p.settledReason(open, undefined, null)).toBe('customer_gone');
    expect(p.settledReason(open, { ...customer, latitude: '27.4950000' }, null)).toBe('pin_changed');
    const verified = { status: 'verified', address_snapshot: ['100 Fixture Rd', null, 'Fixture City', 'FL', '34201'], latitude: 27.49, longitude: -82.57 };
    expect(p.settledReason(open, customer, verified)).toBe('pin_verified');
    expect(p.settledReason(open, customer, { status: 'outside_area', address_snapshot: verified.address_snapshot })).toBe('pin_verified');
  });
  test('a pin that is gone closes the suggestion too (nothing comparable is left to show)', () => {
    expect(p.settledReason(open, { ...customer, latitude: null, longitude: null }, null)).toBe('pin_changed');
  });
  test('a stale verification (the pin moved after it) does not count as verified', () => {
    const stale = { status: 'verified', address_snapshot: ['100 Fixture Rd', null, 'Fixture City', 'FL', '34201'], latitude: 27.5, longitude: -82.6 };
    expect(p.settledReason(open, customer, stale)).toBeNull();
  });
});

describe('gate and wiring', () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');

  test('gate off: the run returns before any query', async () => {
    delete process.env.GATE_PIN_PARKED_CHECK;
    const db = require('../models/db');
    expect(await runPinParkedCheck({ now: new Date('2026-10-09T12:00:00Z') })).toEqual({ skipped: 'gated' });
    expect(db).not.toHaveBeenCalled();
    expect(db.raw).not.toHaveBeenCalled();
  });

  test('address review off: the run stops before any query', async () => {
    process.env.GATE_PIN_PARKED_CHECK = 'true';
    delete process.env.GATE_GEOCODE_REVIEW;
    try {
      const db = require('../models/db');
      expect(await runPinParkedCheck({ now: new Date('2026-10-09T12:00:00Z') })).toEqual({ skipped: 'review_disabled' });
      expect(db).not.toHaveBeenCalled();
    } finally {
      delete process.env.GATE_PIN_PARKED_CHECK;
    }
  });

  test('the gate is strict, read at call time, and the cron checks it each tick', () => {
    const gates = read('../config/feature-gates.js');
    expect(gates).toMatch(/function pinParkedCheckLive\(\) \{\s*return process\.env\.GATE_PIN_PARKED_CHECK === 'true';\s*\}/);
    expect(gates).toContain('module.exports.pinParkedCheckLive = pinParkedCheckLive;');
    const scheduler = read('../services/scheduler.js');
    expect(scheduler).toMatch(/if \(!require\('\.\.\/config\/feature-gates'\)\.pinParkedCheckLive\(\)\) return;\s*try \{\s*await runExclusive\('pin-parked-check'/);
  });

  test('the job never calls the geocoder or writes a pin', () => {
    const source = read('../services/pin-parked-check.js') + read('../services/customer-pin-suggestions.js') + read('../services/bouncie-truck-stops.js');
    expect(source).not.toMatch(/require\('\.\/geocoder'\)|ensureCustomerGeocoded|geocodeAddress/);
    expect(source).not.toMatch(/update\(\{[^}]*latitude/);
    expect(source).not.toMatch(/sendCustomerMessage|twilio|sendgrid/i);
  });
});
