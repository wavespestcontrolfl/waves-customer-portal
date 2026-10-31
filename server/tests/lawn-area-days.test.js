/**
 * Lawn 9x neighborhood days (owner 2026-10-31, PR 5a): a NEW lawn_rounds_9 series
 * is born on its AREA's anchor, so neighbors share one day in every round.
 * Covers the area module (config, ZIP-then-city match, anchor validation), the
 * shared dates, the 28-day first follow-up floor, and the seeder that stamps the
 * anchor (its planner equals its write). The office spawn has its own harness
 * (lawn-9x-rounds-admin-create.test.js); the prepay new parent is below.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/scheduling/blackout-dates', () => ({
  getBlackoutDates: jest.fn(async () => new Set()),
}));
jest.mock('../utils/customer-comms-lock', () => ({
  lockCustomerComms: jest.fn(async () => {}),
  withCustomerCommsLock: jest.fn(async (conn, id, fn) => fn(conn)),
}));

const logger = require('../services/logger');
const {
  LAWN_ROUNDS_9, lawnRoundDate, lawnRoundDateFrom, roundOf, roundOrdinal, roundStart, roundEnd,
} = require('../services/lawn-rounds');
const area = require('../services/lawn-area-days');
const seeder = require('../services/recurring-appointment-seeder');
const { coverageScheduleDates, areaRoundAnchorOptionsForTerm } = require('../services/annual-prepay-renewals')._private;

const {
  parseLawnAreaDays, readLawnAreaDays, matchLawnArea, validAreaAnchor, lawnAreaRoundAnchor, newSeriesAreaAnchor,
  areaFirstFollowUpDate, DEFAULT_LAWN_ROUND_AREA_DAYS,
} = area;

const PARRISH = '2027-01-12';
const LAKEWOOD = '2027-01-19';
const weekday = (s) => new Date(`${s}T12:00:00Z`).getUTCDay();
const addDays = (s, n) => new Date(new Date(`${s}T12:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
const gap = (a, b) => Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 86400000);

beforeEach(() => { area._resetWarnings(); jest.clearAllMocks(); });

// A scripted connection for the config read and the address lookups.
function addressConn({ setting = undefined, settingThrows = false, customer = null, parentCols = null, parentRow = null } = {}) {
  const reads = [];
  const conn = (table) => {
    if (table === 'system_settings') {
      return { where: () => ({ first: async () => {
        reads.push('system_settings');
        if (settingThrows) throw new Error('db down');
        return setting === undefined ? undefined : { value: setting };
      } }) };
    }
    if (table === 'customers') {
      return { where: () => ({ first: async () => { reads.push('customers'); return customer; } }) };
    }
    if (table === 'scheduled_services') {
      return {
        columnInfo: async () => parentCols || {},
        where: () => ({ first: async () => { reads.push('scheduled_services'); return parentRow; } }),
      };
    }
    throw new Error(`unexpected table ${table}`);
  };
  conn.reads = reads;
  return conn;
}

describe('the code default', () => {
  test('both default anchors are valid and pick weekdays', () => {
    const areas = parseLawnAreaDays(DEFAULT_LAWN_ROUND_AREA_DAYS);
    expect(areas.map((a) => a.key)).toEqual(['parrish', 'lakewood_ranch']);
    expect(areas.map((a) => a.anchor)).toEqual([PARRISH, LAKEWOOD]);
    expect(areas.map((a) => weekday(a.anchor))).toEqual([2, 2]);
  });

  test('key absent -> the default; `{}` -> no areas; jsonb object and JSON text read alike', async () => {
    expect((await readLawnAreaDays(addressConn({ setting: undefined }))).map((a) => a.key)).toEqual(['parrish', 'lakewood_ranch']);
    expect(await readLawnAreaDays(addressConn({ setting: '{}' }))).toEqual([]);
    expect(await readLawnAreaDays(addressConn({ setting: {} }))).toEqual([]);
    const one = { x: { zips: ['34219'], anchor: PARRISH } };
    expect((await readLawnAreaDays(addressConn({ setting: JSON.stringify(one) }))).map((a) => a.key)).toEqual(['x']);
    expect((await readLawnAreaDays(addressConn({ setting: one }))).map((a) => a.key)).toEqual(['x']);
  });

  test('invalid JSON and a read failure -> no areas, logged once', async () => {
    expect(await readLawnAreaDays(addressConn({ setting: '{not json' }))).toEqual([]);
    expect(await readLawnAreaDays(addressConn({ setting: '{not json' }))).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(await readLawnAreaDays(addressConn({ settingThrows: true }))).toEqual([]);
    expect(await readLawnAreaDays(addressConn({ settingThrows: true }))).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(await readLawnAreaDays(addressConn({ setting: '[1,2]' }))).toEqual([]);
    expect(await readLawnAreaDays(addressConn({ setting: '' }))).toEqual([]);
  });
});

describe('matching: ZIP first, then city', () => {
  const areas = parseLawnAreaDays(DEFAULT_LAWN_ROUND_AREA_DAYS);

  test('a ZIP match (first 5 digits)', () => {
    expect(matchLawnArea(areas, { zip: '34219' }).key).toBe('parrish');
    expect(matchLawnArea(areas, { zip: '34219-1234' }).key).toBe('parrish');
    expect(matchLawnArea(areas, { zip: 34211 }).key).toBe('lakewood_ranch');
    expect(matchLawnArea(areas, { zip: ' 34202 ' }).key).toBe('lakewood_ranch');
  });

  test('ZIP beats city: a "Bradenton" address in a Lakewood Ranch ZIP is Lakewood Ranch', () => {
    expect(matchLawnArea(areas, { zip: '34212', city: 'Bradenton' }).key).toBe('lakewood_ranch');
    // And against an area that does list the city:
    const claimed = parseLawnAreaDays({
      bradenton: { cities: ['bradenton'], anchor: '2027-01-14' },
      lwr: { zips: ['34212'], anchor: LAKEWOOD },
    });
    expect(matchLawnArea(claimed, { zip: '34212', city: 'Bradenton' }).key).toBe('lwr');
  });

  test('city fallback: lower-cased, trimmed, spaces collapsed', () => {
    expect(matchLawnArea(areas, { city: '  Lakewood   Ranch ' }).key).toBe('lakewood_ranch');
    expect(matchLawnArea(areas, { city: 'PARRISH' }).key).toBe('parrish');
    expect(matchLawnArea(areas, { zip: '99999', city: 'Duette' }).key).toBe('parrish');
    expect(matchLawnArea(areas, { zip: 'abc', city: 'Lakewood Rch' }).key).toBe('lakewood_ranch');
  });

  test('no area -> null', () => {
    expect(matchLawnArea(areas, { zip: '34251', city: 'Myakka City' })).toBeNull();
    expect(matchLawnArea(areas, { zip: '34205', city: 'Bradenton' })).toBeNull();
    expect(matchLawnArea(areas, {})).toBeNull();
    expect(matchLawnArea([], { zip: '34219', city: 'Parrish' })).toBeNull();
  });

  test('two areas claiming one ZIP or city: the first in key order wins, with a warning', () => {
    const dup = parseLawnAreaDays({
      a: { zips: ['34219'], cities: ['parrish'], anchor: PARRISH },
      b: { zips: ['34219'], cities: ['parrish'], anchor: LAKEWOOD },
    });
    expect(matchLawnArea(dup, { zip: '34219' }).key).toBe('a');
    expect(matchLawnArea(dup, { city: 'Parrish' }).key).toBe('a');
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});

describe('lawnAreaRoundAnchor reads the address', () => {
  test('the parent service address wins, field by field, over the customer', async () => {
    const conn = addressConn({ customer: { zip: '34219', city: 'Parrish' } });
    // Customer is a Parrish customer; the series parent services a Lakewood Ranch property.
    const parent = { id: 'p1', customer_id: 'c1', service_address_zip: '34211', service_address_city: 'Bradenton' };
    expect(await lawnAreaRoundAnchor(conn, parent)).toBe(LAKEWOOD);
  });

  test('a parent with no address falls back to the customer zip, then city', async () => {
    const parent = { id: 'p1', customer_id: 'c1', service_address_zip: null, service_address_city: null };
    expect(await lawnAreaRoundAnchor(addressConn({ customer: { zip: '34219', city: 'x' } }), parent)).toBe(PARRISH);
    expect(await lawnAreaRoundAnchor(addressConn({ customer: { zip: null, city: 'Lakewood Ranch' } }), parent)).toBe(LAKEWOOD);
    expect(await lawnAreaRoundAnchor(addressConn({ customer: { zip: '34251', city: 'Myakka City' } }), parent)).toBeNull();
  });

  test('a parent row without the address keys is read by id (only the columns that exist)', async () => {
    const withCols = addressConn({
      parentCols: { service_address_zip: {}, service_address_city: {} },
      parentRow: { service_address_zip: '34212', service_address_city: 'Bradenton' },
      customer: { zip: '34219', city: 'Parrish' },
    });
    expect(await lawnAreaRoundAnchor(withCols, { id: 'p1', customer_id: 'c1' })).toBe(LAKEWOOD);
    const noCols = addressConn({ parentCols: {}, customer: { zip: '34219', city: 'Parrish' } });
    expect(await lawnAreaRoundAnchor(noCols, { id: 'p1', customer_id: 'c1' })).toBe(PARRISH);
    expect(noCols.reads).not.toContain('scheduled_services');
  });

  test('`{}` and a failing read -> null (the series keeps its own anchor)', async () => {
    const parent = { id: 'p1', customer_id: 'c1', service_address_zip: '34219', service_address_city: 'Parrish' };
    expect(await lawnAreaRoundAnchor(addressConn({ setting: '{}' }), parent)).toBeNull();
    expect(await lawnAreaRoundAnchor(addressConn({ settingThrows: true }), parent)).toBeNull();
    const brokenCustomer = addressConn({});
    expect(await lawnAreaRoundAnchor(brokenCustomer, { id: 'p1', customer_id: 'c1', service_address_zip: null, service_address_city: null }))
      .toBeNull();
  });

  test('newSeriesAreaAnchor: rounds only, and not when the parent already stores an anchor', async () => {
    const parent = { id: 'p1', customer_id: 'c1', service_address_zip: '34219', service_address_city: 'Parrish' };
    expect(await newSeriesAreaAnchor(addressConn({}), parent, LAWN_ROUNDS_9)).toBe(PARRISH);
    expect(await newSeriesAreaAnchor(addressConn({}), parent, 'every_6_weeks')).toBeNull();
    expect(await newSeriesAreaAnchor(addressConn({}), parent, 'custom')).toBeNull();
    expect(await newSeriesAreaAnchor(addressConn({}), { ...parent, recurring_round_anchor_date: '2026-11-03' }, LAWN_ROUNDS_9)).toBeNull();
  });
});

describe('an invalid anchor ignores its area', () => {
  test.each([
    ['a Saturday', '2027-01-16'],
    ['a Sunday', '2027-01-17'],
    ['not a date', 'January 12'],
    ['an impossible date', '2027-02-30'],
    ['empty', ''],
    ['missing', undefined],
    ['the first day of a round (no room before)', '2027-02-03'],
    ['3 days into a round', '2027-02-08'],
    ['6 days before a round ends', '2027-02-02'],
    ['the last day of round 9', '2026-12-24'],
  ])('%s', (_name, anchor) => {
    expect(validAreaAnchor(anchor)).toBeNull();
    const parsed = parseLawnAreaDays({
      bad: { zips: ['34219'], anchor },
      ok: { zips: ['34202'], anchor: LAKEWOOD },
    });
    expect(parsed.map((a) => a.key)).toEqual(['ok']);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test('the boundary: 7 days from each round edge is valid, 6 is not', () => {
    for (let programYear = 2027; programYear <= 2028; programYear++) {
      for (let round = 1; round <= 9; round++) {
        const start = roundStart(programYear, round);
        const end = roundEnd(programYear, round);
        const okAt = (s) => validAreaAnchor(s) === s;
        // Pick the nearest weekday inside the allowed band.
        const lo = addDays(start, 7);
        const hi = addDays(end, -7);
        for (const d of [lo, addDays(lo, 1), addDays(lo, 2)]) {
          if (weekday(d) >= 1 && weekday(d) <= 5) expect(okAt(d)).toBe(true);
        }
        for (const d of [hi, addDays(hi, -1), addDays(hi, -2)]) {
          if (weekday(d) >= 1 && weekday(d) <= 5) expect(okAt(d)).toBe(true);
        }
        for (const d of [addDays(start, 6), addDays(end, -6)]) expect(validAreaAnchor(d)).toBeNull();
      }
    }
  });
});

describe('customers of one area share every date', () => {
  // Two customers booked in different weeks and different rounds. Over two program
  // years (round 9 is Nov 10 - Dec 24; 2028 is a leap year), they get the same date
  // in every round they share, on the area weekday, inside the round.
  const walk = (anchor, parentDate, visits) => (
    Array.from({ length: visits }, (_, i) => lawnRoundDateFrom(anchor, parentDate, i))
  );
  const customers = [
    ['2026-10-20', 'booked in round 8'],
    ['2026-12-01', 'booked in round 9'],
    ['2027-03-02', 'booked in round 3'],
    ['2027-06-29', 'booked in round 5, near its end'],
  ];

  test.each([[PARRISH], [LAKEWOOD], ['2028-02-29']])('anchor %s', (anchor) => {
    const wanted = weekday(anchor);
    const byRound = new Map();
    for (const [parentDate] of customers) {
      for (const date of walk(anchor, parentDate, 19).slice(1)) {
        const key = roundOrdinal(date);
        expect(weekday(date)).toBe(wanted);
        const home = roundOf(date);
        expect(date >= home.start && date <= home.end).toBe(true);
        if (byRound.has(key)) expect(date).toBe(byRound.get(key));
        else byRound.set(key, date);
      }
    }
    // Rounds covered span round 9 and the leap-year February.
    const keys = [...byRound.keys()];
    expect(keys.some((k) => k % 9 === 8)).toBe(true);
    expect(byRound.get(roundOrdinal('2028-02-10'))).toBeDefined();
  });

  test('the Feb 29 anchor: round 2 of 2028 is 41 days and the area day is the anchor itself', () => {
    expect(roundOf('2028-02-29')).toMatchObject({ round: 2, length: 41 });
    expect(validAreaAnchor('2028-02-29')).toBe('2028-02-29');
    // Round 9 of 2027 (Nov 10 - Dec 24) + 2 and round 5 of 2027 + 6 both land in round 2 of 2028.
    expect(lawnRoundDateFrom('2028-02-29', '2027-12-01', 2)).toBe('2028-02-29');
    expect(lawnRoundDateFrom('2028-02-29', '2027-06-29', 6)).toBe('2028-02-29');
  });

  test('both default areas keep every round on its weekday, 35 to 49 days apart', () => {
    for (const anchor of [PARRISH, LAKEWOOD]) {
      const dates = walk(anchor, '2026-12-10', 20).slice(1);
      for (let i = 1; i < dates.length; i++) {
        expect([35, 42, 49]).toContain(gap(dates[i - 1], dates[i]));
      }
    }
  });
});

describe('the 28-day first follow-up floor', () => {
  test('keeps the area date when it is 28 or more days after the visit', () => {
    expect(areaFirstFollowUpDate('2026-12-30', '2027-02-23')).toBe('2027-02-23');
    expect(areaFirstFollowUpDate('2026-12-26', '2027-01-23')).toBe('2027-01-23'); // exactly 28
  });

  test('uses visit + 28 days when the area date is closer', () => {
    expect(areaFirstFollowUpDate('2026-12-26', '2027-01-22')).toBe('2027-01-23');
    expect(areaFirstFollowUpDate('2027-02-02', '2027-02-23')).toBe('2027-03-02');
  });

  test('a floored date stays inside the next round, for every visit day of two program years', () => {
    let floored = 0;
    for (const anchor of [PARRISH, LAKEWOOD, '2028-02-29', '2027-03-24', '2027-11-23']) {
      for (let day = '2026-12-25'; day <= '2028-12-24'; day = addDays(day, 1)) {
        const areaDate = lawnRoundDateFrom(anchor, day, 1);
        const first = areaFirstFollowUpDate(day, areaDate);
        const next = roundOf(areaDate);
        expect(roundOrdinal(first)).toBe(roundOrdinal(day) + 1);
        expect(first >= next.start && first <= next.end).toBe(true);
        expect(gap(day, first)).toBeGreaterThanOrEqual(28);
        if (first !== areaDate) { floored += 1; expect(first).toBe(addDays(day, 28)); }
        else expect(gap(day, areaDate)).toBeGreaterThanOrEqual(28);
      }
    }
    expect(floored).toBeGreaterThan(0);
  });
});

// ---- the seeder: stamps the area anchor; the planner equals the write ----

const COLS = Object.fromEntries([
  'id', 'customer_id', 'technician_id', 'scheduled_date', 'window_start', 'window_end',
  'service_type', 'service_id', 'service_key_snapshot', 'status', 'notes', 'time_window', 'zone',
  'estimated_duration_minutes', 'estimated_price', 'payment_method_preference', 'source_estimate_id',
  'source', 'is_recurring', 'recurring_pattern', 'recurring_parent_id', 'recurring_ongoing',
  'recurring_nth', 'recurring_weekday', 'recurring_interval_days', 'customer_confirmed',
  'confirmed_at', 'skip_weekends', 'weekend_shift', 'appointment_type', 'updated_at',
  'recurring_round_anchor_date', 'service_address_zip', 'service_address_city',
].map((c) => [c, {}]));

function seedConn({ customer = { zip: '34219', city: 'Parrish' }, setting = undefined } = {}) {
  const inserted = [];
  const parentUpdates = [];
  const conn = (table) => {
    if (table === 'scheduled_services') {
      const q = {};
      ['where', 'orWhere', 'whereNotIn', 'select', 'orderBy'].forEach((m) => {
        q[m] = (arg) => { if (typeof arg === 'function') arg.call(q); return q; };
      });
      q.columnInfo = async () => COLS;
      q.update = async (u) => { parentUpdates.push(u); return 1; };
      q.insert = (rows) => ({ returning: async () => { inserted.push(...rows); return rows; } });
      q.first = async () => null;
      q.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
      q.catch = () => Promise.resolve([]);
      return q;
    }
    if (table === 'system_settings') return { where: () => ({ first: async () => (setting === undefined ? undefined : { value: setting }) }) };
    if (table === 'customers') return { where: () => ({ first: async () => customer }) };
    if (table === 'services') {
      const q = { forShare() { return q; }, where() { return q; }, whereRaw() { return q; }, async select() { return []; }, async first() { return null; } };
      return q;
    }
    if (table === 'property_preferences') return { where: () => ({ first: async () => null }) };
    throw new Error(`unexpected table ${table}`);
  };
  conn.isTransaction = true;
  conn.transaction = async (fn) => fn(conn);
  conn.executionPromise = { then: () => {} };
  conn.raw = async () => ({});
  return { conn, inserted, parentUpdates };
}

const parentRow = (extra = {}) => ({
  id: 'parent-1',
  customer_id: 'customer-1',
  scheduled_date: '2027-03-02', // a Tuesday, round 3
  service_type: 'Lawn Care',
  service_id: null,
  service_key_snapshot: null,
  status: 'pending',
  recurring_pattern: LAWN_ROUNDS_9,
  ...extra,
});
const seedOpts = { pattern: LAWN_ROUNDS_9, plannedCount: 9, skipWeekends: true };

describe('seedFollowUpsForParent on an area', () => {
  test('stamps the area anchor on the parent and places every follow-up from it', async () => {
    const { conn, inserted, parentUpdates } = seedConn({ customer: { zip: '34211', city: 'Bradenton' } });
    const parent = parentRow();
    const res = await seeder.seedFollowUpsForParent(conn, parent, seedOpts);
    expect(res.insertedCount).toBe(8);
    expect(parentUpdates[0]).toEqual(expect.objectContaining({ recurring_pattern: LAWN_ROUNDS_9, recurring_round_anchor_date: LAKEWOOD }));
    const expected = Array.from({ length: 9 }, (_, i) => lawnRoundDateFrom(LAKEWOOD, parent.scheduled_date, i)).slice(1);
    expect(inserted.map((r) => r.scheduled_date)).toEqual(expected);
    expect(inserted.every((r) => r.recurring_pattern === LAWN_ROUNDS_9)).toBe(true);
    // Children never carry the anchor (it lives on the parent only).
    expect(inserted.every((r) => !('recurring_round_anchor_date' in r))).toBe(true);
  });

  test('two customers of one area get identical dates', async () => {
    const a = seedConn({ customer: { zip: '34219', city: 'Parrish' } });
    const b = seedConn({ customer: { zip: null, city: 'Duette' } });
    await seeder.seedFollowUpsForParent(a.conn, parentRow({ scheduled_date: '2026-11-17' }), seedOpts);
    await seeder.seedFollowUpsForParent(b.conn, parentRow({ id: 'parent-2', customer_id: 'customer-2', scheduled_date: '2026-11-24' }), seedOpts);
    const datesA = a.inserted.map((r) => r.scheduled_date);
    const datesB = b.inserted.map((r) => r.scheduled_date);
    // Same area date in every round both series reach (customer B has no visit before round 9 ends).
    for (const date of datesB) expect(datesA).toContain(date);
    expect(a.parentUpdates[0].recurring_round_anchor_date).toBe(PARRISH);
    expect(b.parentUpdates[0].recurring_round_anchor_date).toBe(PARRISH);
  });

  test('the planner returns exactly the dates the write inserts, floor included', async () => {
    // Parent on the last day of round 1: the Parrish date in round 2 is 21 days later, so the floor applies.
    const parent = parentRow({ scheduled_date: '2027-02-02' });
    const planned = await seeder.planFollowUpSeedDates(seedConn().conn, parent, seedOpts);
    const { conn, inserted } = seedConn();
    await seeder.seedFollowUpsForParent(conn, parent, seedOpts);
    expect(planned).toEqual(inserted.map((r) => r.scheduled_date));
    expect(inserted[0].scheduled_date).toBe('2027-03-02'); // 2027-02-02 + 28, not the area day Feb 23
    expect(lawnRoundDateFrom(PARRISH, parent.scheduled_date, 1)).toBe('2027-02-23');
    expect(roundOf(inserted[0].scheduled_date).round).toBe(2);
    // Later rounds follow the area anchor.
    expect(inserted.slice(1).map((r) => r.scheduled_date)).toEqual(
      Array.from({ length: 9 }, (_, i) => lawnRoundDateFrom(PARRISH, parent.scheduled_date, i)).slice(2),
    );
  });

  test('the floor applies only to the first follow-up, and only on an area anchor', async () => {
    const parent = parentRow({ scheduled_date: '2027-02-02' });
    const noArea = seedConn({ customer: { zip: '34251', city: 'Myakka City' } });
    await seeder.seedFollowUpsForParent(noArea.conn, parent, seedOpts);
    expect(noArea.inserted[0].scheduled_date).toBe(lawnRoundDate('2027-02-02', 1));
  });

  test('a series outside every area is unchanged: no stamp, its own anchor walk', async () => {
    const { conn, inserted, parentUpdates } = seedConn({ customer: { zip: '34251', city: 'Myakka City' } });
    const parent = parentRow();
    await seeder.seedFollowUpsForParent(conn, parent, seedOpts);
    expect(inserted.map((r) => r.scheduled_date)).toEqual(
      Array.from({ length: 9 }, (_, i) => lawnRoundDate(parent.scheduled_date, i)).slice(1),
    );
    expect(parentUpdates[0]).not.toHaveProperty('recurring_round_anchor_date');
  });

  test('`{}` is the kill switch: an area customer keeps its own anchor', async () => {
    const off = seedConn({ setting: '{}' });
    const on = seedConn({ setting: undefined });
    const parent = parentRow();
    await seeder.seedFollowUpsForParent(off.conn, parent, seedOpts);
    await seeder.seedFollowUpsForParent(on.conn, parent, seedOpts);
    expect(off.parentUpdates[0]).not.toHaveProperty('recurring_round_anchor_date');
    expect(off.inserted.map((r) => r.scheduled_date)).toEqual(
      Array.from({ length: 9 }, (_, i) => lawnRoundDate(parent.scheduled_date, i)).slice(1),
    );
    expect(on.parentUpdates[0].recurring_round_anchor_date).toBe(PARRISH);
  });

  test('a parent that already stores an anchor, a caller roundAnchor and other patterns are untouched', async () => {
    const stored = seedConn();
    await seeder.seedFollowUpsForParent(stored.conn, parentRow({ recurring_round_anchor_date: '2026-11-03' }), seedOpts);
    expect(stored.parentUpdates[0]).not.toHaveProperty('recurring_round_anchor_date');
    const explicit = seedConn();
    await seeder.seedFollowUpsForParent(explicit.conn, parentRow(), { ...seedOpts, roundAnchor: '2027-02-09' });
    expect(explicit.parentUpdates[0]).not.toHaveProperty('recurring_round_anchor_date');
    const other = seedConn();
    await seeder.seedFollowUpsForParent(other.conn, parentRow({ recurring_pattern: 'quarterly' }), { pattern: 'quarterly', plannedCount: 4, skipWeekends: true });
    expect(other.parentUpdates[0]).not.toHaveProperty('recurring_round_anchor_date');
    expect(other.inserted).toHaveLength(3);
  });

  test('the parent service address wins over the customer address', async () => {
    const { conn, parentUpdates } = seedConn({ customer: { zip: '34219', city: 'Parrish' } });
    await seeder.seedFollowUpsForParent(conn, parentRow({ service_address_zip: '34202', service_address_city: 'Bradenton' }), seedOpts);
    expect(parentUpdates[0].recurring_round_anchor_date).toBe(LAKEWOOD);
  });
});

// ---- prepay: a new series parent is born on the area anchor ----

describe('prepay gap-fill for a term that covers no series', () => {
  const term = { id: 'term-1', customer_id: 'customer-1' };

  test('areaRoundAnchorOptionsForTerm: rounds term, no visits, area customer', async () => {
    const conn = seedConn({ customer: { zip: '34219', city: 'Parrish' } }).conn;
    expect(await areaRoundAnchorOptionsForTerm({ term, coverageCadence: LAWN_ROUNDS_9, existingRows: [], conn }))
      .toEqual({ roundAnchor: PARRISH, areaFirstGapFloor: true });
    // Tied to a series, another cadence, or no area -> {}
    expect(await areaRoundAnchorOptionsForTerm({ term, coverageCadence: LAWN_ROUNDS_9, existingRows: [{ id: 'x' }], conn })).toEqual({});
    expect(await areaRoundAnchorOptionsForTerm({ term, coverageCadence: 'every_6_weeks', existingRows: [], conn })).toEqual({});
    const away = seedConn({ customer: { zip: '34251', city: 'Myakka City' } }).conn;
    expect(await areaRoundAnchorOptionsForTerm({ term, coverageCadence: LAWN_ROUNDS_9, existingRows: [], conn: away })).toEqual({});
  });

  test('the schedule keeps visit 1 on the paid anchor and follows the area afterwards, with the 28-day floor', () => {
    const start = '2027-02-02'; // last day of round 1
    const plain = coverageScheduleDates(start, 9, LAWN_ROUNDS_9);
    const areaDates = coverageScheduleDates(start, 9, LAWN_ROUNDS_9, null, { roundAnchor: PARRISH, areaFirstGapFloor: true });
    expect(areaDates[0]).toBe(start);
    expect(areaDates[1]).toBe('2027-03-02');
    expect(areaDates.slice(2)).toEqual(Array.from({ length: 9 }, (_, i) => lawnRoundDateFrom(PARRISH, start, i)).slice(2));
    expect(areaDates).not.toEqual(plain);
    // A stored series anchor (no floor flag) is unchanged by this feature.
    expect(coverageScheduleDates(start, 9, LAWN_ROUNDS_9, null, { roundAnchor: PARRISH }))
      .toEqual(Array.from({ length: 9 }, (_, i) => lawnRoundDateFrom(PARRISH, start, i)));
  });
});
