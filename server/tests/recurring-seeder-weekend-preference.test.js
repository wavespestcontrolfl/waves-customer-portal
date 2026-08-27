// B6 (owner ruling 2026-08-27): a customer whose property_preferences
// preferred_day names a WEEKDAY has said "not weekends" — the enum has no
// weekend values — so every recurring-series generator treats that as
// skip_weekends unless the caller resolved it explicitly.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/blackout-dates', () => ({
  getBlackoutDates: jest.fn(async () => new Set()),
}));
jest.mock('../utils/customer-comms-lock', () => ({
  lockCustomerComms: jest.fn(async () => {}),
  withCustomerCommsLock: jest.fn(async (conn, id, fn) => fn(conn)),
}));

const fs = require('fs');
const path = require('path');
const {
  customerPrefersNoWeekends,
  seedFollowUpsForParent,
} = require('../services/recurring-appointment-seeder');

const COLS = Object.fromEntries([
  'id', 'customer_id', 'technician_id', 'scheduled_date', 'window_start', 'window_end',
  'service_type', 'status', 'notes', 'time_window', 'zone', 'estimated_duration_minutes',
  'estimated_price', 'payment_method_preference', 'source_estimate_id', 'source',
  'is_recurring', 'recurring_pattern', 'recurring_parent_id', 'recurring_ongoing',
  'recurring_nth', 'recurring_weekday', 'recurring_interval_days',
  'customer_confirmed', 'confirmed_at', 'skip_weekends', 'weekend_shift',
  'appointment_type', 'updated_at',
].map((c) => [c, {}]));

function makeConn({ prefRow = null, prefThrows = false } = {}) {
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
    if (table === 'property_preferences') {
      return {
        where: () => ({
          first: async () => { if (prefThrows) throw new Error('db down'); return prefRow; },
        }),
      };
    }
    throw new Error(`unexpected table ${table}`);
  };
  conn.isTransaction = true;
  conn.executionPromise = { then: () => {} };
  conn.raw = async () => ({});
  return { conn, inserted, parentUpdates };
}

const PARENT = {
  id: 'parent-1',
  customer_id: 'customer-1',
  scheduled_date: '2026-06-06', // Saturday anchor; raw quarterly nexts land on Saturdays
  service_type: 'Quarterly Pest Control',
  recurring_pattern: 'quarterly',
  skip_weekends: false,
};

describe('customerPrefersNoWeekends', () => {
  test('weekday preference reads as no-weekends', async () => {
    const { conn } = makeConn({ prefRow: { preferred_day: 'tuesday' } });
    expect(await customerPrefersNoWeekends(conn, 'c1')).toBe(true);
  });
  test('no_preference / missing row / missing customer read as false', async () => {
    expect(await customerPrefersNoWeekends(makeConn({ prefRow: { preferred_day: 'no_preference' } }).conn, 'c1')).toBe(false);
    expect(await customerPrefersNoWeekends(makeConn({ prefRow: null }).conn, 'c1')).toBe(false);
    expect(await customerPrefersNoWeekends(makeConn({}).conn, null)).toBe(false);
  });
  test('lookup error fails OPEN (keeps existing behavior)', async () => {
    expect(await customerPrefersNoWeekends(makeConn({ prefThrows: true }).conn, 'c1')).toBe(false);
  });
});

describe('seedFollowUpsForParent honors the saved weekday preference', () => {
  test('pref set + parent flag false → children skip weekends and are stamped skip_weekends', async () => {
    const { conn, inserted, parentUpdates } = makeConn({ prefRow: { preferred_day: 'tuesday' } });
    const res = await seedFollowUpsForParent(conn, PARENT, { pattern: 'quarterly', plannedCount: 4 });
    expect(res.insertedCount).toBe(3);
    expect(inserted.map((r) => r.scheduled_date)).toEqual(['2026-09-07', '2026-12-07', '2027-03-08']);
    for (const row of inserted) {
      expect(row.skip_weekends).toBe(true);
      expect(new Date(`${row.scheduled_date}T12:00:00Z`).getUTCDay()).not.toBe(0);
      expect(new Date(`${row.scheduled_date}T12:00:00Z`).getUTCDay()).not.toBe(6);
    }
    // Parent stamped too, so later extends/reschedules inherit the decision.
    expect(parentUpdates[0]).toEqual(expect.objectContaining({ skip_weekends: true }));
  });

  test('no preference → existing behavior unchanged (weekend dates allowed)', async () => {
    const { conn, inserted, parentUpdates } = makeConn({ prefRow: { preferred_day: 'no_preference' } });
    await seedFollowUpsForParent(conn, PARENT, { pattern: 'quarterly', plannedCount: 4 });
    expect(inserted.map((r) => r.scheduled_date)).toEqual(['2026-09-05', '2026-12-05', '2027-03-06']);
    expect(inserted[0].skip_weekends).toBe(false);
    expect(parentUpdates[0]).toEqual(expect.objectContaining({ skip_weekends: false }));
  });

  test('explicit caller skipWeekends wins outright (no pref lookup override)', async () => {
    const { conn, inserted } = makeConn({ prefRow: { preferred_day: 'tuesday' } });
    await seedFollowUpsForParent(conn, PARENT, { pattern: 'quarterly', plannedCount: 4, skipWeekends: false });
    expect(inserted[0].skip_weekends).toBe(false);
  });
});

describe('every admin-schedule generator consults the preference (source pins)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');
  test('all seven consult sites present', () => {
    // import + create route + plan helper + cadence-rewrite + spawn +
    // reconcile + maintenance + alert action
    expect((src.match(/customerPrefersNoWeekends/g) || []).length).toBe(8);
    expect(src).toContain('|| (isRecurring && recurringPattern ? await customerPrefersNoWeekends(db, customerId) : false)');
    expect(src).toContain('const prefNoWeekends = await customerPrefersNoWeekends(conn, before.customer_id);');
    // Edit paths: the preference ORs over the form's routinely-submitted
    // false — an "explicit" checkbox value must not bypass the ruling.
    expect(src).toContain('|| rewritePrefNoWeekends;');
    expect(src).toContain('|| spawnPrefNoWeekends;');
    expect(src).toContain('const skip = (skipWeekends !== undefined ? !!skipWeekends : !!after.skip_weekends) || prefNoWeekends;');
    expect(src).toContain('const skip = (skipWeekends !== undefined ? !!skipWeekends : skipParent) || prefNoWeekends;');
    expect((src.match(/\|\| await customerPrefersNoWeekends\(trx, parent\.customer_id\)/g) || []).length).toBe(2);
    expect(src).toContain('|| await customerPrefersNoWeekends(conn, parent.customer_id)');
  });
});
