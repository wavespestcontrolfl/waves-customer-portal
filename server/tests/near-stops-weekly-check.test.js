/**
 * Weekly near-stops check (owner 2026-11-19, "check"): one read-only owner
 * notification each Monday. These tests pin what the owner reads:
 *   1. which next-door stops count as booked apart (and which do not), and what
 *      holds each visit: the night run's reason, or the day re-plan's for one day,
 *   2. the truck GPS count: one drive per stop, a combined visit too, all so far,
 *   3. the one standing admin row: the admin notification rule, a ring only when a
 *      split joins, a close when none is left, a throw (so no stamp) on a failure,
 *   4. the run's marker: one run a week, a catch-up only while it is missing.
 * Names here are synthetic. Drive minutes are the plain model (no calibration).
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/admin-alert-episodes', () => ({
  raiseAdminAlertWithReopen: jest.fn(async () => ({ id: 'n-1', deduped: false })),
  closeAdminAlertKeys: jest.fn(async () => 1),
}));
jest.mock('../services/admin-alert-compose', () => ({
  ...jest.requireActual('../services/admin-alert-compose'),
  raiseAdminAlert: jest.fn(async () => ({ id: 'n-1', deduped: false })),
}));
jest.mock('../config/feature-gates', () => ({
  ...jest.requireActual('../config/feature-gates'),
  alertEpisodesLive: jest.fn(() => true),
}));
const mockFirst = jest.fn();
jest.mock('../models/db', () => {
  const chain = { where: jest.fn(() => chain), first: (...args) => mockFirst(...args) };
  const db = jest.fn(() => chain);
  db.raw = jest.fn();
  db.fn = { now: jest.fn() };
  return db;
});

delete process.env.GATE_DRIVE_TIME_CALIBRATION;

const { raiseAdminAlertWithReopen, closeAdminAlertKeys } = require('../services/admin-alert-episodes');
const { composeAdminAlert, raiseAdminAlert } = require('../services/admin-alert-compose');
const { alertEpisodesLive } = require('../config/feature-gates');
const { INTERNAL_TEST_CUSTOMER_IDS } = require('../services/internal-test-customers');
const { HQ } = require('../services/auto-dispatch/geo');
const {
  runNearStopsWeeklyCheck,
  weekIsMissing,
  DEDUPE_KEY,
  _private: {
    buildPlaces, findApartPairs, holdFor, replanHoldFor, loadNightLog, loadReplanFixed, loadStops, physicalLegs,
    shortDriveSummary, composeWeeklyCheck, ringOnNewPair, writeAlert, sentRecently, loadWeek,
  },
} = require('../services/near-stops-weekly-check');

// A knex stand-in that records each call; a query on a table resolves to
// `byTable[table]` when awaited.
function recorder(byTable) {
  const calls = [];
  const chainFor = (result) => {
    const chain = new Proxy({}, {
      get(_target, prop) {
        if (prop === 'then') return (resolve, reject) => Promise.resolve(result).then(resolve, reject);
        return (...args) => { calls.push([prop, ...args]); return chain; };
      },
    });
    return chain;
  };
  const conn = jest.fn((table) => { calls.push(['table', table]); return chainFor(byTable[table]); });
  return { conn, calls };
}

const MILES_PER_DEGREE = (3959 * Math.PI) / 180; // route-optimizer haversine's radius
const north = (miles, from = HQ) => ({ lat: from.lat + miles / MILES_PER_DEGREE, lng: from.lng });

const TECH = { id: 'tech-1', name: 'Tech One' };

// ------------------------------------------------------------------ part 1

let seq = 0;
function stop({ customer, first = 'Avery', last = 'Sample', city = 'Lakewood Ranch', at, date, start = '09:00', plan = false, status = 'pending', property = null, street = null, unit = null, zip = null }) {
  seq += 1;
  return {
    id: `svc-${seq}`,
    customer_id: customer,
    property_id: property,
    visit_id: null,
    time_window: null,
    status,
    scheduled_date: date,
    window_start: start ? `${start}:00` : null,
    technician_id: TECH.id,
    is_recurring: plan,
    recurring_parent_id: plan ? `plan-${customer}` : null,
    lat: at.lat,
    lng: at.lng,
    service_address_line1: street,
    service_address_line2: unit,
    service_address_zip: zip,
    service_address_city: city,
    first_name: first,
    last_name: last,
    customer_address_line1: null,
    customer_zip: null,
    customer_city: city,
    customer_latitude: at.lat,
    customer_longitude: at.lng,
  };
}

const HOME_A = north(5);
const NEXT_DOOR = north(0.05, HOME_A); // about 260 feet from HOME_A

describe('part 1: next-door stops booked apart', () => {
  test('two customers 0.05 mile apart, booked 3 days apart: one split, with the distance in feet', () => {
    const rows = [
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', plan: true }),
      stop({ customer: 'c-b', first: 'Blake', last: 'Example', at: NEXT_DOOR, date: '2027-03-04', plan: true }),
    ];
    const pairs = findApartPairs(rows);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ gap: 3, sameCustomer: false });
    expect(pairs[0].first.date).toBe('2027-03-01');
    const { detail } = composeWeeklyCheck({ apart: pairs, nightLog: new Map(), weekStart: '2027-03-01' });
    expect(detail).toMatch(/- Avery S\. and Blake E\. \(Lakewood Ranch\), about 260 ft apart: Mon, Mar 1 9:00\sAM \(not in the night run\) and Thu, Mar 4 9:00\sAM \(not in the night run\), 3 days apart\./);
    expect(detail).not.toContain('Sample');
  });

  test('back to back on one day is together, not a split', () => {
    const rows = [
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', start: '09:00' }),
      stop({ customer: 'c-b', at: NEXT_DOOR, date: '2027-03-01', start: '10:00' }),
    ];
    expect(findApartPairs(rows)).toEqual([]);
  });

  test("two customers on one day with a stop between are reported, with the re-plan's reason for each hour", () => {
    const rows = [
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', start: '09:00' }),
      stop({ customer: 'c-x', at: north(8), date: '2027-03-01', start: '10:00' }),
      stop({ customer: 'c-b', first: 'Blake', last: 'Example', at: NEXT_DOOR, date: '2027-03-01', start: '11:00' }),
    ];
    const pairs = findApartPairs(rows);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ sameCustomer: false, between: 1 });
    const replan = new Map([['2027-03-01|tech-1', new Map([[pairs[0].first.id, 'time_told']])]]);
    const { detail } = composeWeeklyCheck({ apart: pairs, nightLog: new Map(), replan, weekStart: '2027-03-01' });
    expect(detail).toMatch(/- Avery S\. and Blake E\. \(Lakewood Ranch\), about 260 ft apart: Mon, Mar 1 9:00\sAM \(customer already told the time\) and 11:00\sAM \(no lock listed in the last re-plan\), same day, 1 stop between\./);
  });

  test("two technicians on one day: each visit reads its own technician's re-plan", () => {
    const rows = [
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', start: '09:00' }),
      { ...stop({ customer: 'c-b', first: 'Blake', last: 'Example', at: NEXT_DOOR, date: '2027-03-01', start: '11:00' }), technician_id: 'tech-2' },
    ];
    const pairs = findApartPairs(rows);
    expect(pairs).toEqual([expect.objectContaining({ twoTechs: true })]);
    const replan = new Map([
      ['2027-03-01|tech-1', new Map([[pairs[0].first.id, 'time_told']])],
      ['2027-03-01|tech-2', new Map([[pairs[0].second.id, 'staff_lock']])],
    ]);
    const { detail } = composeWeeklyCheck({ apart: pairs, nightLog: new Map(), replan, weekStart: '2027-03-01' });
    expect(detail).toMatch(/Mon, Mar 1 9:00\sAM \(customer already told the time\) and 11:00\sAM \(locked by staff\), same day, two technicians\./);
  });

  test('a combined visit next door pairs the same way whatever order its rows come in', () => {
    const home = stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', plan: true });
    const pest = stop({ customer: 'c-b', at: NEXT_DOOR, date: '2027-03-04', plan: true });
    const lawn = stop({ customer: 'c-b', at: NEXT_DOOR, date: '2027-03-04', plan: true });
    const keys = (rows) => composeWeeklyCheck({ apart: findApartPairs(rows), nightLog: new Map(), weekStart: '2027-03-01' }).itemKeys;
    expect(keys([lawn, pest, home])).toEqual(keys([home, pest, lawn]));
    expect(keys([home, lawn, pest])).toEqual(keys([home, pest, lawn]));
  });

  test("one customer's two homes on one day with a stop between are reported: the re-plan keeps their hours", () => {
    const rental = north(0.3, HOME_A);
    const rows = [
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', start: '09:00' }),
      stop({ customer: 'c-x', at: north(8), date: '2027-03-01', start: '10:00' }),
      stop({ customer: 'c-a', at: rental, date: '2027-03-01', start: '11:00' }),
    ];
    const pairs = findApartPairs(rows);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ sameCustomer: true, between: 1 });
    const replan = new Map([['2027-03-01|tech-1', new Map([[pairs[0].first.id, 'same_customer'], [pairs[0].second.id, 'same_customer']])]]);
    const { detail } = composeWeeklyCheck({ apart: pairs, nightLog: new Map(), replan, weekStart: '2027-03-01' });
    expect(detail).toMatch(/- Avery S\.'s two homes \(Lakewood Ranch\), 0\.3 mi apart: Mon, Mar 1 9:00\sAM \(same customer twice that day\) and 11:00\sAM \(same customer twice that day\), same day, 1 stop between\./);
    const noPlan = composeWeeklyCheck({ apart: pairs, nightLog: new Map(), replan: new Map(), weekStart: '2027-03-01' });
    expect(noPlan.detail).toMatch(/9:00\sAM \(the re-plan did not plan this day\) and 11:00\sAM \(the re-plan did not plan this day\)/);
  });

  test("a stop with no map pin between one customer's two homes still splits them", () => {
    const pinless = { ...stop({ customer: 'c-x', at: north(8), date: '2027-03-01', start: '10:00' }), lat: null, lng: null, customer_latitude: null, customer_longitude: null };
    const rows = [
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', start: '09:00' }),
      pinless,
      stop({ customer: 'c-a', at: north(0.3, HOME_A), date: '2027-03-01', start: '11:00' }),
    ];
    expect(findApartPairs(rows)).toEqual([expect.objectContaining({ sameCustomer: true, between: 1 })]);
  });

  test('a combined visit between two homes is one stop, not two', () => {
    const rows = [
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', start: '09:00' }),
      stop({ customer: 'c-x', at: north(8), date: '2027-03-01', start: '10:00' }),
      stop({ customer: 'c-x', at: north(8), date: '2027-03-01', start: '10:00' }),
      stop({ customer: 'c-a', at: north(0.3, HOME_A), date: '2027-03-01', start: '11:00' }),
    ];
    expect(findApartPairs(rows)).toEqual([expect.objectContaining({ between: 1 })]);
  });

  test("a third home of the same customer between the two near homes splits them", () => {
    const rows = [
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', start: '09:00' }),
      stop({ customer: 'c-a', at: north(9), date: '2027-03-01', start: '10:00' }),
      stop({ customer: 'c-a', at: north(0.3, HOME_A), date: '2027-03-01', start: '11:00' }),
    ];
    expect(findApartPairs(rows)).toEqual([expect.objectContaining({ sameCustomer: true, between: 1 })]);
  });

  test("an unassigned visit is judged on its partner's route: another route's stop does not split them", () => {
    const rows = [
      { ...stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', start: '09:00' }), technician_id: null },
      { ...stop({ customer: 'c-x', at: north(8), date: '2027-03-01', start: '10:00' }), technician_id: 'tech-2' },
      stop({ customer: 'c-a', at: north(0.3, HOME_A), date: '2027-03-01', start: '11:00' }),
    ];
    expect(findApartPairs(rows)).toEqual([]);
  });

  test('outside the radius: two customers 0.2 mile apart, or one customer\'s homes 0.6 mile apart', () => {
    const rows = [
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01' }),
      stop({ customer: 'c-b', at: north(0.2, HOME_A), date: '2027-03-05' }),
      stop({ customer: 'c-d', at: north(20), date: '2027-03-01' }),
      stop({ customer: 'c-d', at: north(20.6), date: '2027-03-05' }),
    ];
    expect(findApartPairs(rows)).toEqual([]);
  });

  test('rounds pair one to one, nearest dates first: the April round with no partner is not a split', () => {
    const rows = [
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', start: '09:00', plan: true }),
      stop({ customer: 'c-a', at: HOME_A, date: '2027-04-01', start: '09:00', plan: true }),
      stop({ customer: 'c-a', at: HOME_A, date: '2027-05-03', start: '09:00', plan: true }),
      stop({ customer: 'c-b', at: NEXT_DOOR, date: '2027-03-01', start: '10:00', plan: true }),
      stop({ customer: 'c-b', at: NEXT_DOOR, date: '2027-05-10', start: '10:00', plan: true }),
    ];
    const pairs = findApartPairs(rows);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ gap: 7 });
    expect([pairs[0].first.date, pairs[0].second.date]).toEqual(['2027-05-03', '2027-05-10']);
    const { detail } = composeWeeklyCheck({ apart: pairs, nightLog: new Map(), weekStart: '2027-03-01' });
    expect(detail).toContain("7 days apart, past the night run's 5-day reach.");
  });

  test('a combined visit together with its neighbor is one stop: a later visit next door is no split', () => {
    const combined = () => stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', start: '09:00', plan: true });
    const rows = [
      combined(), combined(), combined(),
      stop({ customer: 'c-b', at: NEXT_DOOR, date: '2027-03-01', start: '10:00', plan: true }),
      stop({ customer: 'c-b', at: NEXT_DOOR, date: '2027-03-04', start: '10:00', plan: true }),
    ];
    expect(findApartPairs(rows)).toEqual([]);
  });

  test('two rounds of the same two homes booked apart are two splits', () => {
    const rows = [
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', plan: true }),
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-29', plan: true }),
      stop({ customer: 'c-b', at: NEXT_DOOR, date: '2027-03-03', plan: true }),
      stop({ customer: 'c-b', at: NEXT_DOOR, date: '2027-03-30', plan: true }),
    ];
    const pairs = findApartPairs(rows);
    expect(pairs.map((p) => [p.first.date, p.second.date])).toEqual([['2027-03-29', '2027-03-30'], ['2027-03-01', '2027-03-03']]);
    expect(composeWeeklyCheck({ apart: pairs, nightLog: new Map(), weekStart: '2027-03-01' }).itemKeys).toHaveLength(2);
  });

  test("a round near the end of the 30 days meets its own partner just past them, not an older round", () => {
    const rows = [
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-29', plan: true }),
      stop({ customer: 'c-b', at: NEXT_DOOR, date: '2027-03-03', plan: true }),
      stop({ customer: 'c-b', at: NEXT_DOOR, date: '2027-03-31', plan: true }),
    ];
    // Its partner is a day past the report: no split now (never a 26-day one with the
    // March 3 round), and the split reports once both visits are inside the 30 days.
    expect(findApartPairs(rows, { until: '2027-03-30' })).toEqual([]);
    expect(findApartPairs(rows, { until: '2027-03-31' }).map((p) => [p.first.date, p.second.date])).toEqual([['2027-03-29', '2027-03-31']]);
  });

  test("a round whose partner was served last month keeps that partner: next month's visit next door is no split", () => {
    const rows = [
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-03', plan: true }),
      stop({ customer: 'c-b', at: NEXT_DOOR, date: '2027-02-27', plan: true, status: 'completed' }),
      stop({ customer: 'c-b', at: NEXT_DOOR, date: '2027-03-29', plan: true }),
    ];
    expect(findApartPairs(rows, { from: '2027-03-01', until: '2027-03-31' })).toEqual([]);
    // Without last month's served visit, the round would meet the wrong one.
    expect(findApartPairs(rows.slice(0, 1).concat(rows.slice(2)), { from: '2027-03-01' })).toHaveLength(1);
  });

  test('a split with a served visit, or one that starts before today, is over and not reported', () => {
    const rows = [
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', plan: true, status: 'completed' }),
      stop({ customer: 'c-b', at: NEXT_DOOR, date: '2027-03-04', plan: true }),
      stop({ customer: 'c-d', at: north(12), date: '2027-02-27', plan: true }),
      stop({ customer: 'c-e', at: north(0.05, north(12)), date: '2027-03-02', plan: true }),
    ];
    expect(findApartPairs(rows, { from: '2027-03-01', until: '2027-03-31' })).toEqual([]);
    expect(findApartPairs(rows)).toHaveLength(1);
  });

  test("one customer's two units at one map pin are two homes: booked apart, they are a split", () => {
    const rows = [
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', property: 'prop-1', plan: true }),
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-08', property: 'prop-2', plan: true }),
    ];
    const pairs = findApartPairs(rows);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ sameCustomer: true, gap: 7 });
  });

  test('one home under two map pins is one home: its own visits are never a split', () => {
    const fiftyFeet = north(50 / 5280, HOME_A);
    // One linked property...
    expect(findApartPairs([
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', property: 'prop-1', plan: true }),
      stop({ customer: 'c-a', at: fiftyFeet, date: '2027-03-08', property: 'prop-1', plan: true }),
    ])).toEqual([]);
    // ...or one service address on rows with no property link.
    expect(findApartPairs([
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', street: '100 Sample Way', plan: true }),
      stop({ customer: 'c-a', at: fiftyFeet, date: '2027-03-08', street: '100 Sample Way', plan: true }),
    ])).toEqual([]);
  });

  test('a combined stop stays live while any of its services is open, in either id order', () => {
    for (const [doneId, openId] of [['svc-x1', 'svc-x2'], ['svc-x2', 'svc-x1']]) {
      const rows = [
        { ...stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', plan: true, status: 'completed' }), id: doneId },
        { ...stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', plan: true }), id: openId },
        stop({ customer: 'c-b', at: NEXT_DOOR, date: '2027-03-04', plan: true }),
      ];
      const pairs = findApartPairs(rows);
      expect(pairs).toHaveLength(1);
      expect(pairs[0].first.id).toBe(openId); // the open service stands for the stop and gives its reason
    }
  });

  test('services back to back at one home are one trip: a later visit next door is no split', () => {
    const rows = [
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', start: '09:00', plan: true }),
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', start: '10:00', plan: true }),
      stop({ customer: 'c-b', at: NEXT_DOOR, date: '2027-03-01', start: '11:00', plan: true }),
      stop({ customer: 'c-b', at: NEXT_DOOR, date: '2027-03-04', start: '11:00', plan: true }),
    ];
    expect(findApartPairs(rows)).toEqual([]);
  });

  test("one day: the two homes' nearest services decide, so a home's second trip never hides a back-to-back pair", () => {
    const rows = [
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', start: '09:00' }),
      stop({ customer: 'c-x', at: north(20), date: '2027-03-01', start: '10:00' }),
      stop({ customer: 'c-y', at: north(22), date: '2027-03-01', start: '11:00' }),
      stop({ customer: 'c-b', at: NEXT_DOOR, date: '2027-03-01', start: '14:00' }),
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', start: '15:00' }),
    ];
    expect(findApartPairs(rows)).toEqual([]);
  });

  test('stops between are counted on the route as the board runs it: a tied hour counts where the route puts it', () => {
    const route = (customer, at, start, order) => ({ ...stop({ customer, at, date: '2027-03-01', start }), route_order: order });
    // The route numbers put a third home between two neighbors booked in tied hours...
    expect(findApartPairs([
      route('c-a', HOME_A, '09:00', 1), route('c-x', north(20), '09:00', 2), route('c-b', NEXT_DOOR, '10:00', 3),
    ])).toEqual([expect.objectContaining({ between: 1 })]);
    // ...or the neighbors back to back, ahead of a stop in the same hour.
    expect(findApartPairs([
      route('c-a', HOME_A, '09:00', 1), route('c-b', NEXT_DOOR, '09:00', 2), route('c-x', north(20), '09:00', 3),
    ])).toEqual([]);
  });

  test("a third home's back-to-back services between two neighbors are one stop", () => {
    const rows = [
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', start: '09:00' }),
      stop({ customer: 'c-x', at: north(20), date: '2027-03-01', start: '10:00' }),
      stop({ customer: 'c-x', at: north(20), date: '2027-03-01', start: '11:00' }),
      stop({ customer: 'c-b', at: NEXT_DOOR, date: '2027-03-01', start: '12:00' }),
    ];
    expect(findApartPairs(rows)).toEqual([expect.objectContaining({ between: 1 })]);
  });

  test("an unassigned visit goes on its partner's numbered route where the app's time fallback puts it, never last", () => {
    const route = (customer, at, start, order) => ({ ...stop({ customer, at, date: '2027-03-01', start }), route_order: order });
    const rows = [
      route('c-x', north(20), '08:00', 1),
      route('c-b', NEXT_DOOR, '10:00', 2),
      route('c-y', north(22), '13:00', 3),
      { ...stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', start: '11:00' }), technician_id: null },
    ];
    // By hour it goes between the 10:00 neighbor and the 13:00 stop: back to back.
    expect(findApartPairs(rows)).toEqual([]);
  });

  test('two unassigned neighbors on one day are not judged: neither is on a route yet', () => {
    const rows = [
      { ...stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', start: '09:00' }), technician_id: null },
      stop({ customer: 'c-x', at: north(20), date: '2027-03-01', start: '12:00' }),
      { ...stop({ customer: 'c-b', at: NEXT_DOOR, date: '2027-03-01', start: '15:00' }), technician_id: null },
    ];
    expect(findApartPairs(rows)).toEqual([]);
  });

  test('linked homes group first: an unlinked visit at an address two properties share never merges them', () => {
    const rows = [
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', street: '100 Sample Way', plan: true }),
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-08', street: '100 Sample Way', property: 'prop-1', plan: true }),
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-15', street: '100 Sample Way', property: 'prop-2', plan: true }),
    ];
    const pairs = findApartPairs(rows);
    // One split, the two properties; the unlinked visit cannot be placed, so it pairs with neither.
    expect(pairs.map((p) => [p.first.id, p.second.id])).toEqual([[rows[1].id, rows[2].id]]);
  });

  test('a first visit with only a map pin never merges two known homes at that pin', () => {
    const rows = [
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', plan: true }),
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-08', street: '100 Sample Way', unit: 'Unit 1', plan: true }),
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-15', street: '100 Sample Way', unit: 'Unit 2', plan: true }),
    ];
    // The two units are two homes; the pin-only visit fits both, so it pairs with neither.
    expect(findApartPairs(rows).map((p) => [p.first.id, p.second.id])).toEqual([[rows[1].id, rows[2].id]]);
  });

  test("an unassigned service goes beside its own home's sibling on a numbered route", () => {
    const route = (row, order) => ({ ...row, route_order: order });
    const homeA = (extra = {}) => ({ ...stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', start: '10:00', street: '100 Sample Way' }), ...extra });
    const rows = [
      route(homeA(), 1),
      route(stop({ customer: 'c-y', at: north(22), date: '2027-03-01', start: '10:00' }), 2),
      route(stop({ customer: 'c-b', at: NEXT_DOOR, date: '2027-03-01', start: '10:00' }), 3),
      homeA({ technician_id: null }),
    ];
    // The time fallback puts the unassigned service right after its sibling, so the
    // stop at the far home is still between the neighbors.
    expect(findApartPairs(rows)).toEqual([expect.objectContaining({ between: 1 })]);
  });

  test("a legacy visit with only a time_window is judged on the route at that window's start", () => {
    const legacy = (customer, at, window, order) => ({ ...stop({ customer, at, date: '2027-03-01', start: null }), time_window: window, route_order: order });
    const rows = [
      legacy('c-a', HOME_A, 'morning', 1),
      { ...stop({ customer: 'c-x', at: north(20), date: '2027-03-01', start: '10:00' }), route_order: 2 },
      legacy('c-b', NEXT_DOOR, 'afternoon', 3),
    ];
    const pairs = findApartPairs(rows);
    expect(pairs).toEqual([expect.objectContaining({ between: 1 })]);
    expect([pairs[0].first.windowStart, pairs[0].second.windowStart]).toEqual(['08:00', '12:00']);
  });

  test('an address missing its zip never bridges two homes whose zips differ', () => {
    const at = (date, zip) => stop({ customer: 'c-a', at: HOME_A, date, street: '100 Sample Way', zip, plan: true });
    const rows = [at('2027-03-01', '34202'), at('2027-03-08', null), at('2027-03-15', '34211')];
    // The two complete addresses are two homes; the partial one fits both, so it pairs with neither.
    expect(findApartPairs(rows).map((p) => [p.first.id, p.second.id])).toEqual([[rows[0].id, rows[2].id]]);
  });

  test('a visit with no time yet on the same day is not judged', () => {
    const rows = [
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', start: '09:00' }),
      stop({ customer: 'c-b', at: NEXT_DOOR, date: '2027-03-01', start: null }),
    ];
    expect(findApartPairs(rows)).toEqual([]);
  });
});

describe('what holds each visit, in plain words', () => {
  const planVisit = { id: 'svc-9', nightKind: 'cadence' };

  test('a first or one-time visit never enters the night run', () => {
    expect(holdFor({ id: 'svc-8', nightKind: 'first' }, new Map())).toBe('first or one-time visit');
    expect(buildPlaces([stop({ customer: 'c-b', at: HOME_A, date: '2027-03-01' })])[0].visits[0].nightKind).toBe('first');
  });

  test('a booster has a plan but is never a cadence visit, so the night run never moves it', () => {
    // auto-dispatch/eligibility.js: is_recurring true AND a recurring_parent_id, children only.
    const booster = { ...stop({ customer: 'c-b', at: HOME_A, date: '2027-03-01' }), recurring_parent_id: 'plan-c-b' };
    const visit = buildPlaces([booster])[0].visits[0];
    expect(visit.nightKind).toBe('booster');
    const log = new Map([[visit.id, { reason_code: 'NO_SCORE_IMPROVEMENT' }]]);
    expect(holdFor(visit, log)).toBe('booster visit, which the night run never moves');
    expect(buildPlaces([stop({ customer: 'c-b', at: HOME_A, date: '2027-03-01', plan: true })])[0].visits[0].nightKind).toBe('cadence');
  });

  test("the night run's own reason for the visit", () => {
    const log = new Map([['svc-9', { reason_code: 'REMINDER_SENT_FROZEN', action: 'no_change' }]]);
    expect(holdFor(planVisit, log)).toBe('customer already told the time');
  });

  test("the night run's reason is for the day it judged: a visit moved since then says so", () => {
    const at = (date) => ({ id: 'svc-9', nightKind: 'cadence', date });
    const moved = new Map([['svc-9', { action: 'changed', reason_code: 'CHANGE_APPLIED', old_scheduled_date: '2027-03-05', new_scheduled_date: '2027-03-08' }]]);
    expect(holdFor(at('2027-03-08'), moved)).toBe('the night run moved it there');
    expect(holdFor(at('2027-03-10'), moved)).toBe('moved after the last night run');
    const kept = new Map([['svc-9', { action: 'no_change', reason_code: 'REMINDER_SENT_FROZEN', old_scheduled_date: '2027-03-05' }]]);
    expect(holdFor(at('2027-03-05'), kept)).toBe('customer already told the time');
    expect(holdFor(at('2027-03-06'), kept)).toBe('moved after the last night run');
    // A dry run moves nothing: its reason is for the day the visit still has.
    const dry = new Map([['svc-9', { action: 'recommended', reason_code: 'DRY_RUN_RECOMMENDATION', old_scheduled_date: '2027-03-05', new_scheduled_date: '2027-03-07', dry_run: true }]]);
    expect(holdFor(at('2027-03-05'), dry)).toBe('dry run: the night run would move it');
  });

  test('a visit at the move limit says so, never a count the log does not hold', () => {
    expect(holdFor(planVisit, new Map([['svc-9', { reason_code: 'MOVE_LIMIT_REACHED' }]]))).toBe("already at the night run's move limit");
  });

  test('a gain under the night run\'s bar reads as not enough, never as none', () => {
    expect(holdFor(planVisit, new Map([['svc-9', { reason_code: 'NO_SCORE_IMPROVEMENT' }]]))).toBe('no other day scored enough better');
    expect(holdFor(planVisit, new Map([['svc-9', { reason_code: 'NO_ROAD_DRIVE_SAVING' }]]))).toBe('real roads showed too little saving');
  });

  test('an unknown reason reads as its own words', () => {
    const log = new Map([['svc-9', { reason_code: 'NEW_REASON_CODE' }]]);
    expect(holdFor(planVisit, log)).toBe('new reason code');
  });

  test('a plan visit the run did not log, and a week with no run to read', () => {
    expect(holdFor(planVisit, new Map())).toBe('not in the night run');
    expect(holdFor(planVisit, null)).toBe('no night run to read');
  });

  test("a dry run's reason says so", () => {
    const log = new Map([['svc-9', { reason_code: 'DRY_RUN_RECOMMENDATION', dry_run: true }]]);
    expect(holdFor(planVisit, log)).toBe('dry run: the night run would move it');
  });

  test("a same-day visit: the re-plan's own reason, no lock listed, no plan, or no technician", () => {
    const replan = new Map([['2027-03-01|tech-1', new Map([['svc-1', 'within_24h'], ['svc-2', 'new_reason']])]]);
    const visit = (id, tech = 'tech-1') => ({ id, date: '2027-03-01', tech });
    expect(replanHoldFor(visit('svc-1'), replan)).toBe('less than 24 hours away');
    expect(replanHoldFor(visit('svc-2'), replan)).toBe('new reason');
    // The plan lists only the stops it fixed: an unlisted visit is never called free to move.
    expect(replanHoldFor(visit('svc-3'), replan)).toBe('no lock listed in the last re-plan');
    expect(replanHoldFor(visit('svc-1', 'tech-2'), replan)).toBe('the re-plan did not plan this day');
    expect(replanHoldFor(visit('svc-1', null), replan)).toBe('no technician yet');
  });
});

describe('what the check reads', () => {
  const NOW = new Date('2027-03-01T11:17:00.000Z');

  test("the night run's reasons are read only for the lines the notification shows; every split still counts", async () => {
    const rows = [];
    for (let i = 0; i < 7; i += 1) {
      const home = north(10 + 2 * i);
      const later = `2027-03-${String(3 + i).padStart(2, '0')}`;
      rows.push(stop({ customer: `c-${i}a`, at: home, date: '2027-03-02', plan: true }));
      rows.push(stop({ customer: `c-${i}b`, at: north(0.05, home), date: later, plan: true }));
    }
    const { conn, calls } = recorder({
      'scheduled_services as s': rows, auto_dispatch_runs: { id: 'run-1', mode: 'apply' },
      auto_dispatch_audit_logs: [], day_replan_plans: [], visit_gps_legs: [],
    });
    const week = await loadWeek(NOW, conn);
    expect(week.apart).toHaveLength(7);
    const ids = calls.find((c) => c[0] === 'whereIn' && c[1] === 'scheduled_service_id')[2];
    const shown = week.apart.slice(0, 5).flatMap((p) => [p.first.id, p.second.id]);
    expect([...ids].sort()).toEqual([...shown].sort());
  });

  test('the stops read: live visits and served ones; never a cancelled, skipped, moved or missed visit, a held slot or the demo account', async () => {
    const { conn, calls } = recorder({ 'scheduled_services as s': [{ id: 'v1', customer_id: 'c-1' }, { id: 'v2', customer_id: INTERNAL_TEST_CUSTOMER_IDS[0] }] });
    const rows = await loadStops('2027-02-01', '2027-04-30', conn);
    expect(rows.map((r) => r.id)).toEqual(['v1']);
    const statuses = calls.find((c) => c[0] === 'whereIn' && c[1] === 's.status')[2];
    expect(statuses).toEqual(expect.arrayContaining(['pending', 'confirmed', 'completed']));
    for (const gone of ['cancelled', 'rescheduled', 'skipped', 'no_show']) expect(statuses).not.toContain(gone);
    expect(calls).toContainEqual(['whereNull', 's.reservation_expires_at']);
  });

  test("the re-plan's newest plan for each visit's day and technician wins; only same-day pairs are read", async () => {
    const sameDay = { between: 1, first: { id: 'svc-1', date: '2027-03-01', tech: 'tech-1' }, second: { id: 'svc-2', date: '2027-03-01', tech: null } };
    const twoTechs = { twoTechs: true, first: { id: 'svc-5', date: '2027-03-01', tech: 'tech-1' }, second: { id: 'svc-6', date: '2027-03-01', tech: 'tech-2' } };
    const twoDays = { gap: 3, first: { id: 'svc-3', date: '2027-03-02', tech: 'tech-3' }, second: { id: 'svc-4', date: '2027-03-05', tech: 'tech-3' } };
    const { conn, calls } = recorder({
      day_replan_plans: [
        { service_date: '2027-03-01', technician_id: 'tech-1', fixed: [{ id: 'svc-1', why: 'time_told' }] },
        { service_date: '2027-03-01', technician_id: 'tech-1', fixed: [{ id: 'svc-1', why: 'within_24h' }, { id: 'svc-2', why: 'person_placed' }] },
        { service_date: '2027-03-01', technician_id: 'tech-2', fixed: [] },
      ],
    });
    const plans = await loadReplanFixed([sameDay, twoTechs, twoDays], NOW, conn);
    expect(plans).toEqual(new Map([
      ['2027-03-01|tech-1', new Map([['svc-1', 'time_told']])],
      ['2027-03-01|tech-2', new Map()],
    ]));
    expect(calls).toContainEqual(['table', 'day_replan_plans']);
    expect(calls).toContainEqual(['whereIn', 'service_date', ['2027-03-01']]);
    expect(calls).toContainEqual(['whereIn', 'technician_id', ['tech-1', 'tech-2']]);
    expect(calls).toContainEqual(['orderBy', [{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }]]);
  });

  test('the newest finished night run of either mode: a dry run marks its lines', async () => {
    const { conn, calls } = recorder({
      auto_dispatch_runs: { id: 'run-9', mode: 'dry_run' },
      auto_dispatch_audit_logs: [{ scheduled_service_id: 'svc-1', action: 'recommended', reason_code: 'DRY_RUN_RECOMMENDATION' }],
    });
    const log = await loadNightLog(['svc-1'], NOW, conn);
    expect(log.get('svc-1')).toMatchObject({ reason_code: 'DRY_RUN_RECOMMENDATION', dry_run: true });
    expect(calls.some((c) => c[0] === 'where' && c[1] && c[1].mode)).toBe(false);
    expect(calls).toContainEqual(['first', 'id', 'mode']);
  });

  test('no same-day pair: the re-plan is not read', async () => {
    const { conn } = recorder({});
    const twoDays = { gap: 2, first: { date: '2027-03-01', tech: 'tech-1' }, second: { date: '2027-03-03', tech: 'tech-1' } };
    await expect(loadReplanFixed([twoDays], NOW, conn)).resolves.toEqual(new Map());
    expect(conn).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------- the message

function manyPairs(n) {
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const at = north(30 + i);
    rows.push(stop({ customer: `p-${i}`, first: 'Maximiliana-Josephine', last: 'Worthington', city: 'Lakewood Ranch Main Street District', at, date: '2027-03-01', plan: true }));
    rows.push(stop({ customer: `q-${i}`, first: 'Bartholomew-Alexander', last: 'Fairweather', city: 'Lakewood Ranch Main Street District', at: north(0.05, at), date: `2027-03-${String(10 + i).padStart(2, '0')}`, plan: true }));
  }
  return findApartPairs(rows);
}

describe('the notification', () => {
  test('no next-door split: nothing to raise', () => {
    expect(composeWeeklyCheck({ apart: [], weekStart: '2027-03-01' })).toEqual({ items: 0 });
  });

  test('the row passes the admin notification rule and stays inside its limits', () => {
    const apart = manyPairs(12);
    const longest = { reason_code: 'NO_SLOT_MATCHING_PREFERENCE' };
    const nightLog = new Map(apart.flatMap((p) => [[p.first.id, longest], [p.second.id, longest]]));
    const out = composeWeeklyCheck({
      apart,
      nightLog,
      weekStart: '2027-03-01',
      drives: {
        total: 3,
        median: 1.9,
        since: '2026-08-27',
        newest: [
          { service_date: '2027-02-26', drive_miles: 0.4, drive_minutes: 1.9 },
          { service_date: '2027-02-19', drive_miles: 0.3, drive_minutes: 1.5 },
          { service_date: '2027-02-12', drive_miles: 0.45, drive_minutes: 2.4 },
        ],
      },
    });
    const alert = composeAdminAlert(out.spec); // throws under NODE_ENV=test when a rule is broken
    expect(alert.headline).toBe('Schedule — review 12 next-door splits');
    expect(alert.link).toBe('/admin/schedule?date=2027-03-01');
    expect(alert.metadata).toMatchObject({
      area: 'Schedule', severity: 'needs-you', doneWhen: 'count_zero', who: 'person', subject: { type: 'check', id: DEDUPE_KEY },
    });
    expect(alert.why.length).toBeLessThanOrEqual(110);
    expect(out.detail.length).toBeLessThanOrEqual(2000);
    expect(out.detail).not.toContain('…');
    expect(out.detail.match(/- and 7 more/g)).toHaveLength(1);
    expect(out.detail).toContain('Truck GPS, drives under half a mile from one visit to the next: 3 since Thu, Aug 27, median 1.9 min. Newest: Fri, Feb 26: 0.4 mi in 1.9 min; Fri, Feb 19: 0.3 mi in 1.5 min; Fri, Feb 12: 0.5 mi in 2.4 min.');
    expect(out.itemKeys).toHaveLength(12);
    expect(out.metadata).toEqual({ weekOf: '2027-03-01', pairsApart: 12, shortDrivesTotal: 3 });
  });

  test('the why leads with the easiest pair to join, and the link opens its day', () => {
    const rows = [
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', plan: true }),
      stop({ customer: 'c-b', at: NEXT_DOOR, date: '2027-03-04', plan: true }),
    ];
    const pairs = findApartPairs(rows);
    const out = composeWeeklyCheck({ apart: pairs, nightLog: new Map(), weekStart: '2027-03-01' });
    const alert = composeAdminAlert(out.spec);
    expect(alert.headline).toBe('Schedule — review 1 next-door split');
    expect(alert.why).toBe('Easiest to join: two stops about 260 ft apart, Mon, Mar 1 and Thu, Mar 4.');
    expect(alert.link).toBe('/admin/schedule?date=2027-03-01');
    expect(out.itemKeys).toEqual([[pairs[0].first.id, pairs[0].second.id].sort().join('|')]);
  });

  test('no short drive yet: the GPS line says none, never a blank', () => {
    const rows = [
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', plan: true }),
      stop({ customer: 'c-b', at: NEXT_DOOR, date: '2027-03-04', plan: true }),
    ];
    const out = composeWeeklyCheck({
      apart: findApartPairs(rows), nightLog: new Map(), weekStart: '2027-03-01',
      drives: { total: 0, median: null, since: '2026-08-27', newest: [] },
    });
    expect(out.detail).toContain('Truck GPS, drives under half a mile from one visit to the next: none since Thu, Aug 27. ');
    expect(out.detail).toMatch(/The app prices a 0\.1-mile hop at about \d+ min\.$/);
  });

  test("a combined visit's inbound drive, written on each of its service rows, counts once", () => {
    const arrived = new Date('2027-03-02T14:00:00.000Z');
    const leg = (id, extra = {}) => ({
      scheduled_service_id: id, technician_id: 'tech-1', service_date: '2027-03-02', gps_arrived_at: arrived,
      leg_group_key: 'g-1', drive_miles: 0.4, drive_minutes: 1.9, ...extra,
    });
    const rows = [leg('svc-a'), leg('svc-b'), leg('svc-c', { gps_arrived_at: new Date('2027-03-02T16:00:00.000Z'), leg_group_key: 'g-2' })];
    expect(physicalLegs(rows).map((r) => r.scheduled_service_id)).toEqual(['svc-a', 'svc-c']);
    const noArrival = [leg('svc-d', { gps_arrived_at: null }), leg('svc-e', { gps_arrived_at: null }), leg('svc-f', { gps_arrived_at: null, leg_group_key: 'g-3' })];
    expect(physicalLegs(noArrival).map((r) => r.scheduled_service_id)).toEqual(['svc-d', 'svc-f']);
  });

  test('the GPS count is every drive so far: an even count takes the mean of the middle two, newest first', () => {
    const legs = [{ service_date: '2027-02-01', drive_minutes: 5 }, { service_date: '2027-03-02', drive_minutes: 1 }];
    const summary = shortDriveSummary(legs);
    expect(summary).toMatchObject({ total: 2, median: 3 });
    expect(summary.newest.map((l) => l.service_date)).toEqual(['2027-03-02', '2027-02-01']);
  });

  test('the newest drives: the latest day first, then the latest arrival, a drive with no arrival last', () => {
    const leg = (id, day, at) => ({ scheduled_service_id: id, service_date: day, gps_arrived_at: at ? new Date(at) : null, drive_minutes: 1 });
    const legs = [
      leg('a', '2027-03-02', '2027-03-02T14:00:00Z'),
      leg('b', '2027-03-02', '2027-03-02T18:00:00Z'),
      leg('c', '2027-03-02', null),
      leg('d', '2027-03-01', '2027-03-01T20:00:00Z'),
    ];
    expect(shortDriveSummary(legs).newest.map((l) => l.scheduled_service_id)).toEqual(['b', 'a', 'c']);
  });

  test('a refresh rings only when a split joins the set', () => {
    const ring = ringOnNewPair(['svc-1|svc-2', 'svc-3|svc-4']);
    expect(ring(null, { itemKeys: ['svc-1|svc-2', 'svc-3|svc-4'] })).toBe(false);
    expect(ring(null, { itemKeys: ['svc-1|svc-2', 'svc-3|svc-4', 'svc-5|svc-6'] })).toBe(false);
    expect(ring(null, { itemKeys: ['svc-1|svc-2'] })).toBe(true);
    expect(ring(null, null)).toBe(true);
  });
});

// ------------------------------------------------------------------ the run

const MONDAY = new Date('2027-03-08T11:17:00.000Z'); // Monday 6:17 AM EST

const oneSplit = () => {
  const rows = [
    stop({ customer: 'c-a', at: HOME_A, date: '2027-03-10', plan: true }),
    stop({ customer: 'c-b', at: NEXT_DOOR, date: '2027-03-12', plan: true }),
  ];
  return { weekStart: '2027-03-08', apart: findApartPairs(rows), nightLog: new Map(), replan: new Map(), drives: null };
};

describe('the admin row', () => {
  const trx = { raw: jest.fn(async () => ({ rows: [] })) };
  const conn = { transaction: jest.fn(async (work) => work(trx)) };
  const composedOne = () => composeWeeklyCheck(oneSplit());
  beforeEach(() => jest.clearAllMocks());

  test('a split raises one Schedule row under the lock, tagged to ring, carrying its set for the next refresh', async () => {
    await expect(writeAlert(composedOne(), MONDAY, conn)).resolves.toBe('raised');
    expect(trx.raw).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext(?))', ['admin:near-stops-weekly']);
    expect(raiseAdminAlertWithReopen).toHaveBeenCalledTimes(1);
    const [category, headline, why, opts] = raiseAdminAlertWithReopen.mock.calls[0];
    expect(category).toBe('alert');
    expect(headline).toBe('Schedule — review 1 next-door split');
    expect(why).toMatch(/^Easiest to join: /);
    expect(opts).toMatchObject({
      dedupeKey: 'near-stops-weekly',
      trx,
      bell: true,
      refreshOnDedupe: true,
      bumpOnRefresh: true,
      link: '/admin/schedule?date=2027-03-10',
      metadata: { count: 1, pairsApart: 1, area: 'Schedule', severity: 'needs-you', doneWhen: 'count_zero' },
    });
    expect(opts.metadata.itemKeys).toHaveLength(1);
    expect(opts.ringOnRefresh(null, { itemKeys: opts.metadata.itemKeys })).toBe(false);
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('a quiet refresh, a ringing refresh, an unchanged row and a muted row each read as such', async () => {
    raiseAdminAlertWithReopen.mockResolvedValueOnce({ deduped: true, refreshed: true, rung: false });
    await expect(writeAlert(composedOne(), MONDAY, conn)).resolves.toBe('refreshed');
    raiseAdminAlertWithReopen.mockResolvedValueOnce({ deduped: true, refreshed: true, rung: true });
    await expect(writeAlert(composedOne(), MONDAY, conn)).resolves.toBe('raised');
    raiseAdminAlertWithReopen.mockResolvedValueOnce({ deduped: true });
    await expect(writeAlert(composedOne(), MONDAY, conn)).resolves.toBe('unchanged');
    raiseAdminAlertWithReopen.mockResolvedValueOnce({ suppressed: true });
    await expect(writeAlert(composedOne(), MONDAY, conn)).resolves.toBe('suppressed');
  });

  test('with alert episodes off, the same spec goes through raiseAdminAlert', async () => {
    alertEpisodesLive.mockReturnValueOnce(false);
    const composed = composedOne();
    await expect(writeAlert(composed, MONDAY, conn)).resolves.toBe('raised');
    expect(raiseAdminAlert).toHaveBeenCalledWith('alert', composed.spec, expect.objectContaining({ dedupeKey: 'near-stops-weekly', bell: true, trx }));
    expect(raiseAdminAlertWithReopen).not.toHaveBeenCalled();
  });

  test('no split left: the open row closes, done at a zero count', async () => {
    await expect(writeAlert({ items: 0 }, MONDAY, conn)).resolves.toBe('closed');
    expect(closeAdminAlertKeys).toHaveBeenCalledWith(trx, ['near-stops-weekly'], 'count_zero', expect.objectContaining({ now: MONDAY }));
    closeAdminAlertKeys.mockResolvedValueOnce(0);
    await expect(writeAlert({ items: 0 }, MONDAY, conn)).resolves.toBe('clear');
    expect(raiseAdminAlertWithReopen).not.toHaveBeenCalled();
  });

  test('a close or a write that fails throws, so the run never stamps the week', async () => {
    closeAdminAlertKeys.mockRejectedValueOnce(new Error('pool closed'));
    await expect(writeAlert({ items: 0 }, MONDAY, conn)).rejects.toThrow('pool closed');
    raiseAdminAlertWithReopen.mockResolvedValueOnce(null);
    await expect(writeAlert(composedOne(), MONDAY, conn)).rejects.toThrow('near-stops row was not written');
  });
});

function deps(data) {
  return {
    now: MONDAY,
    sentRecently: jest.fn(async () => false),
    loadWeek: jest.fn(async () => data),
    writeAlert: jest.fn(async () => 'raised'),
    stampSendMarker: jest.fn(async () => {}),
  };
}

describe('runNearStopsWeeklyCheck', () => {
  beforeEach(() => jest.clearAllMocks());

  test("this week's check already ran: nothing is read or written", async () => {
    const opts = { ...deps(oneSplit()), sentRecently: jest.fn(async () => true) };
    await expect(runNearStopsWeeklyCheck(opts)).resolves.toEqual({ skipped: 'recent_send' });
    expect(opts.loadWeek).not.toHaveBeenCalled();
    expect(opts.writeAlert).not.toHaveBeenCalled();
  });

  test('a split writes the one row and stamps the week', async () => {
    const opts = deps(oneSplit());
    await expect(runNearStopsWeeklyCheck(opts)).resolves.toEqual({ sent: true, outcome: 'raised', pairs: 1 });
    expect(opts.writeAlert).toHaveBeenCalledWith(expect.objectContaining({ items: 1 }), MONDAY);
    expect(opts.stampSendMarker).toHaveBeenCalledTimes(1);
  });

  test('a clean week closes the open row and stamps the week', async () => {
    const opts = { ...deps({ weekStart: '2027-03-08', apart: [], nightLog: new Map(), replan: new Map(), drives: null }), writeAlert: jest.fn(async () => 'closed') };
    await expect(runNearStopsWeeklyCheck(opts)).resolves.toEqual({ sent: false, outcome: 'closed', pairs: 0 });
    expect(opts.writeAlert).toHaveBeenCalledWith({ items: 0 }, MONDAY);
    expect(opts.stampSendMarker).toHaveBeenCalledTimes(1);
  });

  test('unreadable data: nothing written, no stamp, so the catch-up tries again', async () => {
    const opts = { ...deps(null), loadWeek: jest.fn(async () => { throw new Error('read timeout'); }) };
    await expect(runNearStopsWeeklyCheck(opts)).resolves.toEqual({ skipped: 'query_failed' });
    expect(opts.writeAlert).not.toHaveBeenCalled();
    expect(opts.stampSendMarker).not.toHaveBeenCalled();
  });

  test('a row that could not be written or closed leaves the week unstamped', async () => {
    const opts = { ...deps(oneSplit()), writeAlert: jest.fn(async () => { throw new Error('pool closed'); }) };
    await expect(runNearStopsWeeklyCheck(opts)).resolves.toEqual({ sent: false, error: true, pairs: 1 });
    expect(opts.stampSendMarker).not.toHaveBeenCalled();
  });
});

describe('the weekly marker', () => {
  const TUESDAY = new Date('2027-03-09T16:17:00.000Z'); // Tuesday 11:17 AM EST
  beforeEach(() => jest.clearAllMocks());

  test("no marker, or last week's: this week is missing", async () => {
    mockFirst.mockResolvedValueOnce(undefined);
    await expect(weekIsMissing(TUESDAY)).resolves.toBe(true);
    mockFirst.mockResolvedValueOnce({ last_sent_at: new Date('2027-03-01T11:17:30.000Z') });
    await expect(weekIsMissing(TUESDAY)).resolves.toBe(true);
  });

  test("this week's marker, stamped Monday: not missing, and the Monday run is done", async () => {
    mockFirst.mockResolvedValue({ last_sent_at: new Date('2027-03-08T11:18:00.000Z') });
    await expect(weekIsMissing(TUESDAY)).resolves.toBe(false);
    await expect(sentRecently(TUESDAY)).resolves.toBe(true);
  });

  test('an unreadable marker: the catch-up skips, the Monday run goes ahead', async () => {
    mockFirst.mockRejectedValue(new Error('connection reset'));
    await expect(weekIsMissing(TUESDAY)).resolves.toBe(false);
    await expect(sentRecently(MONDAY)).resolves.toBe(false);
  });
});
