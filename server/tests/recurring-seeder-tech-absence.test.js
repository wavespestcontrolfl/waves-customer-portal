/**
 * recurring-appointment-seeder — a follow-up whose date is a day the
 * inherited technician is marked out (uncleared technician_absences row) is
 * seeded UNASSIGNED; every other follow-up keeps the tech (Codex r7 P1 on
 * #4678). Harness mirrors recurring-seeder-weekend-preference.test.js.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/blackout-dates', () => ({
  getBlackoutDates: jest.fn(async () => new Set()),
}));
jest.mock('../utils/customer-comms-lock', () => ({
  lockCustomerComms: jest.fn(async () => {}),
  withCustomerCommsLock: jest.fn(async (conn, _id, fn) => fn(conn)),
}));

const { seedFollowUpsForParent } = require('../services/recurring-appointment-seeder');

const COLS = Object.fromEntries([
  'id', 'customer_id', 'technician_id', 'scheduled_date', 'window_start', 'window_end',
  'service_type', 'status', 'notes', 'time_window', 'zone', 'estimated_duration_minutes',
  'estimated_price', 'payment_method_preference', 'source_estimate_id', 'source',
  'is_recurring', 'recurring_pattern', 'recurring_parent_id', 'recurring_ongoing',
  'recurring_nth', 'recurring_weekday', 'recurring_interval_days',
  'customer_confirmed', 'confirmed_at', 'skip_weekends', 'weekend_shift',
  'appointment_type', 'updated_at',
].map((c) => [c, {}]));

const TECH = 'aaaaaaaa-1111-4222-8333-444444444444';

function makeConn({ absences = [], tech = { id: TECH, employment_status: 'active', field_dispatchable: true } } = {}) {
  const inserted = [];
  const absenceReads = [];
  const conn = (table) => {
    if (table === 'scheduled_services') {
      const q = {};
      ['where', 'orWhere', 'whereNotIn', 'select', 'orderBy'].forEach((m) => {
        q[m] = (arg) => { if (typeof arg === 'function') arg.call(q); return q; };
      });
      q.columnInfo = async () => COLS;
      q.update = async () => 1;
      q.insert = (rows) => ({ returning: async () => { inserted.push(...rows); return rows; } });
      q.first = async () => null;
      q.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
      q.catch = () => Promise.resolve([]);
      return q;
    }
    if (table === 'property_preferences') return { where: () => ({ first: async () => null }) };
    if (table === 'technicians') {
      const q = { where: () => q, forShare: () => q, first: async () => tech };
      return q;
    }
    if (table === 'technician_absences') {
      const q = { _args: {} };
      q.whereBetween = (col, range) => { q._args.range = range; return q; };
      q.whereNull = () => q;
      q.whereIn = (col, ids) => { q._args.ids = ids; return q; };
      q.select = async () => { absenceReads.push(q._args); return absences; };
      return q;
    }
    throw new Error(`unexpected table ${table}`);
  };
  conn.isTransaction = true;
  conn.transaction = async (fn) => fn(conn);
  conn.executionPromise = { then: () => {} };
  conn.raw = async () => ({});
  return { conn, inserted, absenceReads };
}

const PARENT = {
  id: 'parent-1',
  customer_id: 'customer-1',
  technician_id: TECH,
  scheduled_date: '2026-06-03',
  service_type: 'Quarterly Pest Control',
  recurring_pattern: 'quarterly',
  skip_weekends: false,
};

describe('follow-up seeding honors technician_absences per child date', () => {
  test('a child on an absent day is seeded unassigned; the others keep the inherited tech; one range read', async () => {
    const { conn, inserted, absenceReads } = makeConn({
      absences: [{ technician_id: TECH, absence_date: '2026-12-02' }],
    });
    const res = await seedFollowUpsForParent(conn, PARENT, { pattern: 'quarterly', plannedCount: 4 });
    expect(res.insertedCount).toBe(3);
    const byDate = Object.fromEntries(inserted.map((r) => [r.scheduled_date, r.technician_id]));
    expect(byDate).toEqual({ '2026-09-02': TECH, '2026-12-02': null, '2027-03-03': TECH });
    expect(absenceReads).toHaveLength(1);
    expect(absenceReads[0]).toEqual({ range: ['2026-09-02', '2027-03-03'], ids: [TECH] });
  });

  test('a DATE-typed absence_date (pg read-back) matches the child date too', async () => {
    const { conn, inserted } = makeConn({
      absences: [{ technician_id: TECH, absence_date: new Date('2026-09-02T00:00:00Z') }],
    });
    await seedFollowUpsForParent(conn, PARENT, { pattern: 'quarterly', plannedCount: 4 });
    expect(inserted.find((r) => r.scheduled_date === '2026-09-02').technician_id).toBeNull();
    expect(inserted.find((r) => r.scheduled_date === '2026-12-02').technician_id).toBe(TECH);
  });

  test('no absences: every child keeps the tech', async () => {
    const { conn, inserted } = makeConn();
    await seedFollowUpsForParent(conn, PARENT, { pattern: 'quarterly', plannedCount: 4 });
    expect(inserted.every((r) => r.technician_id === TECH)).toBe(true);
  });

  test('an unassignable inherited tech seeds everything unassigned and skips the absence read', async () => {
    const { conn, inserted, absenceReads } = makeConn({ tech: { id: TECH, employment_status: 'inactive', field_dispatchable: true } });
    await seedFollowUpsForParent(conn, PARENT, { pattern: 'quarterly', plannedCount: 4 });
    expect(inserted.every((r) => r.technician_id === null)).toBe(true);
    expect(absenceReads).toHaveLength(0);
  });
});
