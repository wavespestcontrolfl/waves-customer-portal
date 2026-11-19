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

  test('the candidate and both distance limits come from the saved pin, the stamp only settles "stop at pin"', () => {
    // stamp 1400 m north, saved pin at BASE; a stop 1700 m north is 300 m from the stamp but beyond the cap from the saved pin
    const stamped = { service_lat: at(1400).lat, service_lng: at(1400).lng };
    expect(judge([stop(1700, 30)], stamped)).toEqual({ flag: false, reason: 'stop_too_far' });
    expect(judge([stop(1450, 30)], stamped).reason).toBe('stop_at_pin'); // within 175 m of the stamp
    const verdict = judge([stop(900, 30), stop(500, 30)], { service_lat: at(700).lat, service_lng: at(700).lng });
    expect(verdict.distanceM).toBe(500);
  });

  test('no saved pin: a stop at the visit stamp still settles it, anything else creates nothing', () => {
    const noSaved = { customer_latitude: null, customer_longitude: null };
    expect(judge([stop(100, 30)], noSaved).reason).toBe('stop_at_pin');
    expect(judge([stop(540, 30)], noSaved)).toEqual({ flag: false, reason: 'no_saved_pin' });
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

  test('every day a visit was scheduled or worked is a day of evidence (en route, arrived, completed)', () => {
    const days = p.visitDays(visit({
      scheduled_day: '2026-10-06', en_route_at: new Date('2026-10-07T13:00:00Z'), arrived_at: new Date('2026-10-07T14:00:00Z'),
      completed_at: new Date('2026-10-08T15:30:00Z'),
    }));
    expect(days.sort()).toEqual(['2026-10-06', '2026-10-07', '2026-10-08']);
  });

  describe('requiredDays: what must be read before a visit can be judged', () => {
    const NOW = new Date('2026-10-09T12:00:00Z');
    test('a visit done on Oct 7 and closed out on Oct 8 needs both days', () => {
      const r = p.requiredDays(visit({ scheduled_day: '2026-10-07', completed_at: new Date('2026-10-08T15:30:00Z') }), NOW);
      expect(r).toMatchObject({ days: ['2026-10-07', '2026-10-08'], tooOld: false, unloadable: false });
    });
    test('7 days back is still loaded; 8 is not, and the visit is not judged', () => {
      expect(p.requiredDays(visit({ scheduled_day: '2026-10-02' }), NOW).tooOld).toBe(false);
      expect(p.requiredDays(visit({ scheduled_day: '2026-10-01' }), NOW).tooOld).toBe(true);
    });
    test('days that start before the current tracker mapping began cannot be judged (NULL = always mapped)', () => {
      const remapped = (iso) => p.requiredDays(visit({ scheduled_day: '2026-10-07', completed_at: new Date('2026-10-08T15:30:00Z'), mapping_changed_at: iso }), NOW);
      expect(remapped(null)).toMatchObject({ beforeMapping: false, unloadable: false });
      expect(remapped(undefined).unloadable).toBe(false);
      expect(remapped('2026-10-06T12:00:00Z')).toMatchObject({ beforeMapping: false, unloadable: false }); // both days after the remap
      expect(remapped('2026-10-07T20:00:00Z')).toMatchObject({ beforeMapping: true, unloadable: true }); // Oct 7 is partly the old vehicle
      expect(remapped('2026-10-08T04:00:00Z').beforeMapping).toBe(true); // Oct 8 starts exactly at the change: Oct 7 is old
      expect(remapped('2026-10-09T01:00:00Z').unloadable).toBe(true);
    });
    test('a day still ahead has no truck data to read and is not required', () => {
      expect(p.requiredDays(visit({ scheduled_day: '2026-10-12' }), NOW).days).toEqual(['2026-10-08']);
    });
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

describe('coordinates the detector cannot measure', () => {
  test('usablePin takes only latitude in [-90, 90] and longitude in [-180, 180], never 0, null or text', () => {
    expect(p.usablePin(27.49, -82.57)).toEqual({ lat: 27.49, lng: -82.57 });
    expect(p.usablePin('27.49', '-82.57')).toEqual({ lat: 27.49, lng: -82.57 });
    for (const [lat, lng] of [[91, -82], [27, -181], [-91, 10], [27, 200], [0, -82], [27, 0], [null, -82], ['', '-82'], ['x', 'y'], [Infinity, 1]]) {
      expect(p.usablePin(lat, lng)).toBeNull();
    }
  });
  test('a null distance matches nothing: not within, and not the closest', () => {
    expect(p.isWithin(null, 175)).toBe(false);
    expect(p.isWithin(0, 175)).toBe(true);
    expect(p.isWithin(175, 175)).toBe(true);
    expect(p.isWithin(176, 175)).toBe(false);
    // a pin the detector cannot measure is ignored, a measurable one still counts
    expect(p.nearestPinDistance([{ lat: 95, lng: 0.5 }], { lat: 27.49, lng: -82.57 })).toBeNull();
    const near = p.nearestPinDistance([{ lat: 95, lng: 0.5 }, at(300)], stop(0));
    expect(Math.round(near)).toBe(300);
  });
  test('a stop with an unmeasurable position is never "at the pin" and never the suggestion', () => {
    expect(judge([{ ...stop(0), lat: 95 }])).toEqual({ flag: false, reason: 'no_stops' });
    expect(judge([{ ...stop(0), lat: 95 }, stop(540)]).distanceM).toBe(540);
  });
});

describe('home base since', () => {
  const NOW = new Date('2026-10-09T12:00:00Z');
  test('is the lookback start with no remap, and the day after a later remap otherwise', () => {
    expect(p.homeSince(NOW, null)).toBe('2026-09-09');
    expect(p.homeSince(NOW, new Date('2026-08-01T12:00:00Z'))).toBe('2026-09-09'); // an old remap does not shorten the lookback
    expect(p.homeSince(NOW, new Date('2026-10-02T15:00:00Z'))).toBe('2026-10-03');
    expect(p.homeSince(NOW, 'not a date')).toBe('2026-09-09');
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
  test("a visit whose stop is another customer's (either rule) is named on the decision, whatever else is decided", () => {
    const cleared = judged({ flag: false, reason: 'other_customer_stop' });
    const unknown = judged({ flag: false, reason: 'stops_unreadable', unknown: true });
    const explained = [{ serviceId: 'visit-1', visitId: null, reason: 'other_customer_stop' }];
    expect(p.decideCustomer([cleared])).toEqual({ action: 'none', explained });
    expect(p.decideCustomer([cleared, flagged(540)])).toMatchObject({ action: 'flag', verdict: { distanceM: 540 }, explained });
    expect(p.decideCustomer([cleared, unknown])).toEqual({ action: 'skip', explained });
    expect(p.decideCustomer([cleared, atPin()]).action).toBe('ok');
    // the neighbour rule explains a stop the same way, but only for a neighbour's visit on the day of the stop;
    // a grouped visit carries its visit_id
    const neighbour = (verdict) => ({ visit: visit({ id: 'visit-2', visit_id: 'group-7' }), verdict: { flag: false, reason: 'neighbour_visit', ...verdict } });
    expect(p.decideCustomer([neighbour({ sameDayNeighbour: true })]).explained).toEqual([{ serviceId: 'visit-2', visitId: 'group-7', reason: 'neighbour_visit' }]);
    expect(p.decideCustomer([neighbour({})])).toEqual({ action: 'none' });
    // nothing explained: the decision is exactly what it was
    expect(p.decideCustomer([flagged(540)])).not.toHaveProperty('explained');
    expect(p.decideCustomer([judged({ flag: false, reason: 'stop_too_short' })])).toEqual({ action: 'none' });
  });
});

// 2026-11-16, the first live bell: nobody was home, the truck left the (correct) pin after 3 minutes and stood 29
// minutes at a customer 310 m away who had no completed visit that day. The bell offered to move the pin there.
describe("a short stop at the pin, then the long stop at another customer's", () => {
  const NOW = new Date('2026-10-08T20:00:00Z');
  const parkedShort = (north, minutes) => ({ ...stop(north, minutes), startMs: Date.parse('2026-10-08T14:20:00Z') });
  const vehicles = (stops) => new Map([['imei-1', { stops, home: null }]]);
  const judgeDay = (stops) => p.judgeVisits([visit()], vehicles(stops), { radius: RADIUS, fences: [], now: NOW });
  // A stand-in for knex: answers "is there a row" for the customers read and the properties read, or fails both. The
  // distance is decided inside the query (PostgreSQL suite); here the rows are what that query would return.
  function pinsConn({ customers = [], properties = [], fail = false } = {}) {
    const calls = [];
    const conn = (table) => {
      const call = { table, steps: [] };
      calls.push(call);
      const rows = String(table).startsWith('customer_properties') ? properties : customers;
      const b = {};
      for (const name of ['join', 'where', 'whereNull', 'whereNot', 'whereBetween', 'whereRaw', 'limit']) {
        b[name] = (...args) => { call.steps.push([name, ...args]); return b; };
      }
      b.first = async () => { if (fail) throw Object.assign(new Error('db down'), { code: 'XX000' }); return rows[0]; };
      return b;
    };
    conn.calls = calls;
    return conn;
  }
  const FOUND = [{ id: 'customer-2' }];
  const briefThenLong = () => judgeDay([parkedShort(19, 3), stop(310, 29)]);

  test('a parked gap under the 5 minute stop floor never settles the pin; the flag only notes it', () => {
    const [{ verdict }] = briefThenLong();
    expect(verdict).toMatchObject({ flag: true, distanceM: 310, stopMinutes: 29, briefAtPin: true });
    // at the floor it is a stop at the pin, as before
    expect(judgeDay([parkedShort(19, 5), stop(310, 29)])[0].verdict).toEqual({ flag: false, reason: 'stop_at_pin' });
    // a short gap is never the suggested spot and never a stop that is too short or too far
    expect(judgeDay([parkedShort(540, 3)])[0].verdict).toEqual({ flag: false, reason: 'no_stops' });
  });

  test("the neighbour exclusion stays generous; only a neighbour's visit on the ET day of the stop is marked as proof", () => {
    const neighbourOn = (...days) => ({ ...NO_EXCLUSIONS, neighbours: [{ ...at(520), days }] });
    // stop() is on Oct 8 (11:00 ET)
    expect(judge([stop(540)], {}, neighbourOn('2026-10-08'))).toEqual({ flag: false, reason: 'neighbour_visit', sameDayNeighbour: true });
    expect(judge([stop(540)], {}, neighbourOn('2026-10-07', '2026-10-08'))).toEqual({ flag: false, reason: 'neighbour_visit', sameDayNeighbour: true });
    // a neighbour's visit on another day still prevents a suggestion, as before, but proves nothing about this stop
    expect(judge([stop(540)], {}, neighbourOn('2026-10-09'))).toEqual({ flag: false, reason: 'neighbour_visit' });
    // one neighbour on the day but elsewhere, another at the stop on another day: not proof
    const split = { ...NO_EXCLUSIONS, neighbours: [{ ...at(3000), days: ['2026-10-08'] }, { ...at(520), days: ['2026-10-09'] }] };
    expect(judge([stop(540)], {}, split)).toEqual({ flag: false, reason: 'neighbour_visit' });
    // the pins a run builds carry the days of the neighbour's visit
    const mine = visit();
    const theirs = visit({ id: 'visit-2', customer_id: 'customer-2', service_lat: at(520).lat, service_lng: at(520).lng, customer_latitude: at(520).lat, customer_longitude: at(520).lng, arrived_at: new Date('2026-10-07T15:00:00Z') });
    expect(p.neighbourPins(mine, [mine, theirs]).map((pin) => [...pin.days].sort())).toEqual([['2026-10-07', '2026-10-08'], ['2026-10-07', '2026-10-08']]);
    // home base and fences are not "another customer's": no mark
    expect(p.excludedVerdict('home_base', stop(540), { radius: RADIUS, neighbours: [{ ...at(520), days: ['2026-10-08'] }] })).toEqual({ flag: false, reason: 'home_base' });
  });

  test('no short stop at the pin, or one somewhere else, leaves briefAtPin false', () => {
    expect(judgeDay([stop(310, 29)])[0].verdict.briefAtPin).toBe(false);
    expect(judgeDay([parkedShort(900, 3), stop(310, 29)])[0].verdict.briefAtPin).toBe(false);
  });

  test('the short stop counts before or after the long stop, but only on the ET day of the long stop', () => {
    const after = { ...stop(19, 3), startMs: Date.parse('2026-10-08T16:10:00Z') };
    expect(judgeDay([stop(310, 29), after])[0].verdict.briefAtPin).toBe(true);
    // A visit worked on two days: the short stop at the pin was on Oct 7, the long stop on Oct 8.
    const twoDays = visit({ arrived_at: new Date('2026-10-07T15:00:00Z') });
    const dayBefore = { ...stop(19, 3), startMs: Date.parse('2026-10-07T14:20:00Z') };
    const [{ verdict }] = p.judgeVisits([twoDays], vehicles([dayBefore, stop(310, 29)]), { radius: RADIUS, fences: [], now: NOW });
    expect(verdict).toMatchObject({ flag: true, distanceM: 310, briefAtPin: false });
    // 23:30 ET on Oct 7 is Oct 8 in UTC: the ET day decides
    const lateEvening = { ...stop(19, 3), startMs: Date.parse('2026-10-08T03:30:00Z') };
    expect(p.judgeVisits([twoDays], vehicles([lateEvening, stop(310, 29)]), { radius: RADIUS, fences: [], now: NOW })[0].verdict.briefAtPin).toBe(false);
  });

  test("both facts together clear the flag: the stop is the other customer's (customer row or an active property)", async () => {
    for (const pins of [{ customers: FOUND }, { properties: FOUND }]) {
      const judged = await p.clearStopsAtOtherCustomers(pinsConn(pins), briefThenLong(), RADIUS);
      expect(judged[0].verdict).toEqual({ flag: false, reason: 'other_customer_stop' });
    }
  });

  test('a brief stop at the pin alone still flags: the map can lead a technician to a wrong pin first', async () => {
    const conn = pinsConn();
    const judged = await p.clearStopsAtOtherCustomers(conn, briefThenLong(), RADIUS);
    expect(judged[0].verdict.flag).toBe(true);
    expect(conn.calls.map((call) => call.table)).toEqual(['customers as c', 'customer_properties as p']);
  });

  test("another customer's pin alone still flags, and other customers are not even read", async () => {
    const conn = pinsConn({ customers: FOUND });
    const judged = await p.clearStopsAtOtherCustomers(conn, judgeDay([stop(310, 29)]), RADIUS);
    expect(judged[0].verdict.flag).toBe(true);
    expect(conn.calls).toEqual([]);
  });

  test('the query measures the distance itself, so no row limit can hide a pin that is inside the radius', async () => {
    const conn = pinsConn();
    await p.clearStopsAtOtherCustomers(conn, briefThenLong(), RADIUS);
    for (const [call, lat, lng] of [[conn.calls[0], 'c.latitude', 'c.longitude'], [conn.calls[1], 'p.latitude', 'p.longitude']]) {
      const raw = call.steps.find(([name]) => name === 'whereRaw');
      expect(raw[1]).toBe(p.withinSql(lat, lng));
      expect(raw[2]).toEqual([at(310).lat, at(310).lat, at(310).lng, RADIUS]); // the long stop, then the radius
      expect(call.steps.some(([name]) => name === 'limit')).toBe(false);
      expect(call.steps).toContainEqual(['whereNot', 'c.id', 'customer-1']); // never this customer's own pin or property
      expect(call.steps).toContainEqual(['whereNull', 'c.deleted_at']);
    }
    expect(conn.calls[1].steps).toContainEqual(['where', 'p.active', true]);
    expect(p.withinSql('c.latitude', 'c.longitude')).toMatch(/^2 \* 6371000 \* asin\(.*<= \?$/);
  });

  test('a read that fails leaves the visit unknown: no suggestion, nothing closed', async () => {
    const judged = await p.clearStopsAtOtherCustomers(pinsConn({ fail: true }), briefThenLong(), RADIUS);
    expect(judged[0].verdict).toEqual({ flag: false, reason: 'other_pins_unreadable', unknown: true });
    expect(p.decideCustomer(judged).action).toBe('skip');
  });

  describe('retiring the suggestion an earlier run made from an explained visit', () => {
    const store = require('../services/customer-pin-suggestions');
    const openFrom = (serviceId) => new Map([['customer-1', { id: 's-1', scheduled_service_id: serviceId }]]);
    const explainedAs = (reason, extra = {}) => [{ serviceId: 'visit-1', visitId: null, reason, ...extra }];
    // A stand-in for knex that answers the one read of a suggestion's service (its visit_id).
    const servicesConn = (visitId) => {
      const conn = jest.fn(() => ({ where: () => ({ first: async () => ({ visit_id: visitId }) }) }));
      return conn;
    };
    let close;
    beforeEach(() => { close = jest.spyOn(store, 'closeSuggestion').mockResolvedValue({ id: 's-1' }); });
    afterEach(() => close.mockRestore());

    test("it is retired whatever else is decided; another visit's suggestion stays", async () => {
      const tally = { created: 0, closed: 0 };
      for (const action of ['none', 'skip']) {
        const decision = { action, explained: explainedAs('other_customer_stop') };
        await p.applyDecision({}, 'customer-1', decision, openFrom('visit-9'), tally);
        expect(close).not.toHaveBeenCalled();
        await p.applyDecision({}, 'customer-1', decision, openFrom('visit-1'), tally);
        expect(close).toHaveBeenCalledWith('s-1', 'superseded', expect.objectContaining({
          reason: 'other_customer_stop', resolution: expect.stringMatching(/^Closed: the truck also came to the pin that day/),
        }));
        close.mockClear();
      }
      expect(tally.closed).toBe(2);
      // nothing explained: nothing is closed for a customer with nothing to say
      await p.applyDecision({}, 'customer-1', { action: 'none' }, openFrom('visit-1'), tally);
      expect(close).not.toHaveBeenCalled();
    });

    test("a stop the neighbour rule explains since (their visit was completed after the bell) retires it too", async () => {
      const tally = { created: 0, closed: 0 };
      await p.applyDecision({}, 'customer-1', { action: 'none', explained: explainedAs('neighbour_visit') }, openFrom('visit-1'), tally);
      expect(close).toHaveBeenCalledWith('s-1', 'superseded', expect.objectContaining({
        reason: 'neighbour_visit', resolution: "Closed: the truck's stop was at another customer's visit that day",
      }));
      expect(tally.closed).toBe(1);
    });

    test('grouped services of one physical visit match by visit_id; a standalone visit never reads the service', async () => {
      const grouped = explainedAs('other_customer_stop', { serviceId: 'partner-2', visitId: 'group-7' });
      const same = servicesConn('group-7');
      expect(await p.explainedSource(same, { id: 's-1', scheduled_service_id: 'partner-1' }, grouped)).toEqual(grouped[0]);
      expect(same).toHaveBeenCalledWith('scheduled_services');
      expect(await p.explainedSource(servicesConn('group-8'), { id: 's-1', scheduled_service_id: 'partner-1' }, grouped)).toBeNull();
      expect(await p.explainedSource(servicesConn(null), { id: 's-1', scheduled_service_id: 'partner-1' }, grouped)).toBeNull();
      const never = servicesConn('group-7');
      expect(await p.explainedSource(never, { id: 's-1', scheduled_service_id: 'visit-9' }, explainedAs('other_customer_stop'))).toBeNull();
      expect(await p.explainedSource(never, { id: 's-1', scheduled_service_id: null }, grouped)).toBeNull();
      expect(await p.explainedSource(never, null, grouped)).toBeNull();
      expect(never).not.toHaveBeenCalled();
    });
  });

  test('the run reads the short gaps (1 minute and up) and clears before it decides', () => {
    const source = fs.readFileSync(path.join(__dirname, '../services/pin-parked-check.js'), 'utf8');
    expect(p.BRIEF_STOP_MIN_MINUTES).toBe(1);
    expect(source).toMatch(/minMinutes: BRIEF_STOP_MIN_MINUTES/);
    expect(source).toMatch(/const judged = await clearStopsAtOtherCustomers\(conn, judgeVisits\(/);
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

  // A stand-in for knex that answers the one open-suggestions read and records every table it was asked about.
  function fakeConn(openRows = []) {
    const tables = [];
    const conn = (table) => {
      tables.push(table);
      const b = { where: () => b, orderBy: () => b, limit: () => b, select: async () => openRows };
      return b;
    };
    conn.tables = tables;
    return conn;
  }

  test.each([
    ['gate off', () => { delete process.env.GATE_PIN_PARKED_CHECK; process.env.GATE_GEOCODE_REVIEW = 'true'; }, 'gated'],
    ['address review off', () => { process.env.GATE_PIN_PARKED_CHECK = 'true'; delete process.env.GATE_GEOCODE_REVIEW; }, 'review_disabled'],
  ])('%s: the run only retires open suggestions and reads nothing else', async (_name, setup, skipped) => {
    setup();
    try {
      const conn = fakeConn([]);
      expect(await runPinParkedCheck({ now: new Date('2026-10-09T12:00:00Z'), conn })).toEqual({ skipped, retired: 0 });
      expect(conn.tables).toEqual(['customer_pin_suggestions']); // one bounded read, no visits, no Bouncie log, no geocoder
    } finally {
      delete process.env.GATE_PIN_PARKED_CHECK;
      delete process.env.GATE_GEOCODE_REVIEW;
    }
  });

  test('a failed retire sweep never throws out of the run', async () => {
    delete process.env.GATE_PIN_PARKED_CHECK;
    const conn = () => { throw new Error('db down'); };
    expect(await runPinParkedCheck({ conn })).toEqual({ skipped: 'gated', retired: 0 });
  });

  test('the gate is strict, read at call time, and the cron ticks even with the gate off', () => {
    const gates = read('../config/feature-gates.js');
    expect(gates).toMatch(/function pinParkedCheckLive\(\) \{\s*return process\.env\.GATE_PIN_PARKED_CHECK === 'true';\s*\}/);
    expect(gates).toContain('module.exports.pinParkedCheckLive = pinParkedCheckLive;');
    const scheduler = read('../services/scheduler.js');
    // The tick is NOT skipped when the gate is off: the run retires leftover suggestions (clean rollback).
    expect(scheduler).toMatch(/cron\.schedule\('35 6 \* \* \*', async \(\) => \{\s*try \{\s*const lockRes = await runExclusive\('pin-parked-check'/);
    // A tick that never ran (no lock connection) is recorded as a failed run, as the geocode-review alert does; a held lease is normal.
    expect(scheduler).toMatch(/lockRes\?\.skipped === true && lockRes\.reason !== 'lease_held'\) \{[\s\S]{0,400}?recordJobStart\('pin-parked-check'\)[\s\S]{0,200}?recordJobEnd\('pin-parked-check', startedAt, error\)[\s\S]{0,100}?throw error;/);
  });

  test('the job never calls the geocoder or writes a pin', () => {
    const source = read('../services/pin-parked-check.js') + read('../services/customer-pin-suggestions.js') + read('../services/bouncie-truck-stops.js');
    expect(source).not.toMatch(/require\('\.\/geocoder'\)|ensureCustomerGeocoded|geocodeAddress/);
    expect(source).not.toMatch(/update\(\{[^}]*latitude/);
    expect(source).not.toMatch(/sendCustomerMessage|twilio|sendgrid/i);
  });
});
