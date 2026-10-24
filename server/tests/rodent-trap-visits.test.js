/**
 * Booking notice (owner ruling 2026-09-26): lists a customer's active
 * trapping visits at one premise in the 60 days up to the booking date.
 * Advisory only — no included/billable decision, no price.
 *
 * The SQL itself runs against a migrated database in
 * rodent-trap-visits-postgres.test.js; this file pins what the module does
 * with the rows (dedupe, premise scoping, ordering, output) and the query
 * shape it builds.
 */
jest.mock('../services/review-request', () => ({
  trappingPremiseMatcher: jest.fn(async () => () => true),
}));
const { trappingPremiseMatcher } = require('../services/review-request');
const { recentTrappingVisits, WINDOW_DAYS, INACTIVE_STATUSES } = require('../services/rodent-trap-visits');

// Per-table rows. Records every builder call (callbacks included) so a test
// can read the query shape back; the filtering itself is the database's job.
function fakeDb({ primaries = [], addons = [], properties = [] } = {}) {
  const seen = { primary: [], addon: [], property: [] };
  const builder = (log, rows) => {
    const q = {};
    for (const name of ['join', 'leftJoin', 'where', 'orWhere', 'whereIn', 'whereNotIn', 'whereNull', 'orWhereNull', 'orderBy', 'limit']) {
      q[name] = (...args) => {
        log.push([name, ...args.filter((a) => typeof a !== 'function')]);
        const fn = args.find((a) => typeof a === 'function');
        if (fn) fn.call(q, q);
        return q;
      };
    }
    q.select = async (...cols) => { log.push(['select', ...cols]); return rows; };
    return q;
  };
  // No insert/update on the fake: a write from this read-only lookup throws.
  const db = (table) => {
    const name = String(table);
    if (name.startsWith('scheduled_service_addons')) return builder(seen.addon, addons);
    if (name.startsWith('customer_properties')) return builder(seen.property, properties);
    return builder(seen.primary, primaries);
  };
  db.raw = (sql) => sql;
  db.seen = seen;
  return db;
}
const everywhere = () => true;
const calls = (log, name) => log.filter((c) => c[0] === name).map((c) => c.slice(1));

afterEach(() => {
  jest.useRealTimers();
  trappingPremiseMatcher.mockClear();
});

describe('recent trapping visits notice', () => {
  test('lists active visits oldest-first with calendar-text dates', async () => {
    const db = fakeDb({
      primaries: [
        { id: 'b', scheduled_day: '2026-10-08', service_key: 'rodent_trapping_followup' },
        { id: 'a', scheduled_day: '2026-10-01', service_key: 'rodent_trapping' },
      ],
    });
    const out = await recentTrappingVisits(db, 'c', { date: '2026-10-09', premiseMatcher: everywhere });
    expect(out).toMatchObject({ windowDays: WINDOW_DAYS, count: 2, through: '2026-10-09', since: '2026-08-10' });
    expect(out.visits).toEqual([
      { id: 'a', date: '2026-10-01', serviceKey: 'rodent_trapping' },
      { id: 'b', date: '2026-10-08', serviceKey: 'rodent_trapping_followup' },
    ]);
    expect(calls(db.seen.primary, 'select')[0]).toContain("to_char(ss.scheduled_date, 'YYYY-MM-DD') as scheduled_day");
  });

  test('an appointment is one visit even with trapping on the primary and an add-on line', async () => {
    const row = { id: 'a', scheduled_day: '2026-10-01', service_key: 'rodent_trapping' };
    const out = await recentTrappingVisits(fakeDb({ primaries: [row], addons: [{ ...row, service_key: 'rodent_trapping_followup' }] }), 'c', { date: '2026-10-02', premiseMatcher: everywhere });
    expect(out.count).toBe(1);
  });

  test('a trapping add-on on another service still counts', async () => {
    const out = await recentTrappingVisits(fakeDb({ addons: [{ id: 'x', scheduled_day: '2026-10-01', service_key: 'rodent_trap_check_additional' }] }), 'c', { date: '2026-10-02', premiseMatcher: everywhere });
    expect(out.visits).toEqual([{ id: 'x', date: '2026-10-01', serviceKey: 'rodent_trap_check_additional' }]);
  });

  test('only visits at the booking premise count', async () => {
    const db = fakeDb({ primaries: [
      { id: 'a', scheduled_day: '2026-10-01', service_key: 'rodent_trapping', property_id: 'p1' },
      { id: 'b', scheduled_day: '2026-10-03', service_key: 'rodent_trapping', property_id: 'p2' },
    ] });
    const out = await recentTrappingVisits(db, 'c', { date: '2026-10-05', premiseMatcher: (r) => r.property_id === 'p2' });
    expect(out.visits.map((v) => v.id)).toEqual(['b']);
  });

  test('without an injected matcher it scopes by the trapping review premise rules for the booking property', async () => {
    const db = fakeDb({ properties: [{ id: 'p-sole' }] });
    await recentTrappingVisits(db, 'c', { date: '2026-10-05', propertyId: 'p1' });
    expect(trappingPremiseMatcher).toHaveBeenLastCalledWith('c', { property_id: 'p1' });
    // A picked property is used as is; nothing else is read for it.
    expect(db.seen.property).toEqual([]);
  });

  test('with no property picked, the premise is the one the booking route would anchor', async () => {
    // The customer's only active property, primary or not (soleActivePropertyId).
    const sole = fakeDb({ properties: [{ id: 'p-rental' }] });
    await recentTrappingVisits(sole, 'c', { date: '2026-10-05' });
    expect(calls(sole.seen.property, 'where')).toEqual([[{ customer_id: 'c', active: true }]]);
    expect(trappingPremiseMatcher).toHaveBeenLastCalledWith('c', { property_id: 'p-rental' });
    // Two or more active properties stay on the primary premise, and so does none.
    await recentTrappingVisits(fakeDb({ properties: [{ id: 'a' }, { id: 'b' }] }), 'c', { date: '2026-10-05' });
    expect(trappingPremiseMatcher).toHaveBeenLastCalledWith('c', { property_id: null });
    await recentTrappingVisits(fakeDb(), 'c', { date: '2026-10-05' });
    expect(trappingPremiseMatcher).toHaveBeenLastCalledWith('c', { property_id: null });
  });

  test('bounds the window at the booking date and 60 days back, on both lines', async () => {
    const db = fakeDb();
    await recentTrappingVisits(db, 'c', { date: '2026-10-05', premiseMatcher: everywhere });
    for (const log of [db.seen.primary, db.seen.addon]) {
      expect(calls(log, 'where')).toEqual(expect.arrayContaining([
        ['ss.customer_id', 'c'],
        ['ss.scheduled_date', '>=', '2026-08-06'],
        ['ss.scheduled_date', '<=', '2026-10-05'],
      ]));
    }
  });

  test('with no booking date the window ends today in Eastern time', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-10T02:30:00Z')); // 10:30 PM ET on 10/9
    const out = await recentTrappingVisits(fakeDb(), 'c', { premiseMatcher: everywhere });
    expect(out).toMatchObject({ through: '2026-10-09', since: '2026-08-10' });
  });

  test('a cancelled, rescheduled, skipped or missed visit is not a visit; a row with no status is', async () => {
    expect(INACTIVE_STATUSES).toEqual(['cancelled', 'rescheduled', 'skipped', 'no_show']);
    const db = fakeDb();
    await recentTrappingVisits(db, 'c', { date: '2026-10-05', premiseMatcher: everywhere });
    for (const log of [db.seen.primary, db.seen.addon]) {
      expect(calls(log, 'whereNotIn')).toEqual([['ss.status', INACTIVE_STATUSES]]);
      expect(calls(log, 'orWhereNull')).toEqual([['ss.status']]);
    }
  });

  test('a line whose catalog row is gone counts through its snapshot key, on both lines', async () => {
    const db = fakeDb();
    await recentTrappingVisits(db, 'c', { date: '2026-10-05', premiseMatcher: everywhere });
    expect(calls(db.seen.primary, 'select')[0]).toContain('COALESCE(sv.service_key, ss.service_key_snapshot) as service_key');
    expect(calls(db.seen.addon, 'select')[0]).toContain('COALESCE(sv.service_key, a.service_key_snapshot) as service_key');
    expect(calls(db.seen.primary, 'whereNull')).toEqual([['sv.id']]);
    expect(calls(db.seen.addon, 'whereNull')).toEqual([['sv.id']]);
    expect(calls(db.seen.primary, 'whereIn').map((c) => c[0])).toEqual(['sv.service_key', 'ss.service_key_snapshot']);
    expect(calls(db.seen.addon, 'whereIn').map((c) => c[0])).toEqual(['sv.service_key', 'a.service_key_snapshot']);
  });
});
