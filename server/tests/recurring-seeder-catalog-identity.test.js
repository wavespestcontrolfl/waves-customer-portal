/**
 * seedFollowUpsForParent (the canonical child creator for public booking +
 * estimate conversion) births follow-ups with the CURRENT catalog identity
 * resolved from the parent — not the parent label verbatim — and fails
 * closed to the parent's own label + link when the catalog can't be read.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/blackout-dates', () => ({
  getBlackoutDates: jest.fn(async () => new Set()),
}));
jest.mock('../utils/customer-comms-lock', () => ({
  lockCustomerComms: jest.fn(async () => {}),
  withCustomerCommsLock: jest.fn(async (conn, id, fn) => fn(conn)),
}));

const { seedFollowUpsForParent } = require('../services/recurring-appointment-seeder');

const COLS = Object.fromEntries([
  'id', 'customer_id', 'technician_id', 'scheduled_date', 'window_start', 'window_end',
  'service_type', 'service_id', 'service_key_snapshot', 'status', 'notes', 'time_window', 'zone',
  'estimated_duration_minutes', 'estimated_price', 'payment_method_preference', 'source_estimate_id',
  'source', 'is_recurring', 'recurring_pattern', 'recurring_parent_id', 'recurring_ongoing',
  'recurring_nth', 'recurring_weekday', 'recurring_interval_days', 'customer_confirmed',
  'confirmed_at', 'skip_weekends', 'weekend_shift', 'appointment_type', 'updated_at',
].map((c) => [c, {}]));

const CATALOG = [
  { id: 'svc-q', name: 'Quarterly Pest Control Service', service_key: 'pest_quarterly', is_active: true },
  { id: 'svc-m', name: 'Monthly Pest Control Service', service_key: 'pest_monthly', is_active: true },
];

function makeConn({ services = CATALOG, servicesThrow = false } = {}) {
  const inserted = [];
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
    if (table === 'services') {
      if (servicesThrow) throw new Error('catalog unavailable');
      const filters = [];
      let lowerNames = null;
      const q = {
        where(cond) { filters.push(cond); return q; },
        whereRaw(sql, bindings) { lowerNames = bindings.map((b) => String(b).toLowerCase()); return q; },
        async select() {
          return services.filter((s) => (lowerNames == null || lowerNames.includes(String(s.name).toLowerCase()))
            && filters.every((f) => Object.entries(f).every(([k, v]) => s[k] === v)));
        },
        async first() { return (await q.select())[0] || null; },
      };
      return q;
    }
    if (table === 'property_preferences') return { where: () => ({ first: async () => null }) };
    throw new Error(`unexpected table ${table}`);
  };
  conn.isTransaction = true;
  conn.transaction = async (fn) => fn(conn);
  conn.executionPromise = { then: () => {} };
  conn.raw = async () => ({});
  return { conn, inserted };
}

const PARENT = {
  id: 'parent-1',
  customer_id: 'customer-1',
  scheduled_date: '2026-06-10',
  service_type: 'Quarterly Pest Control', // pre-convention label, unlinked, no snapshot
  service_id: null,
  service_key_snapshot: null,
  recurring_pattern: 'quarterly',
  status: 'completed', // a terminal parent keeps this label by Invariant 1
};

describe('seedFollowUpsForParent child identity', () => {
  test('unlinked legacy-labeled parent → follow-ups born with the current name, linked, snapshot stamped', async () => {
    const { conn, inserted } = makeConn();
    const res = await seedFollowUpsForParent(conn, PARENT, { pattern: 'quarterly', plannedCount: 3 });
    expect(res.insertedCount).toBe(2);
    for (const row of inserted) {
      expect(row).toMatchObject({
        service_type: 'Quarterly Pest Control Service',
        service_id: 'svc-q',
        service_key_snapshot: 'pest_quarterly',
        recurring_parent_id: 'parent-1',
      });
    }
  });

  test('public-booking shape: parent inserted WITHOUT recurring_pattern, cadence only in opts.pattern → still resolves via (label, cadence)', async () => {
    const { conn, inserted } = makeConn();
    const bare = { ...PARENT, service_type: 'Pest Control', recurring_pattern: undefined, status: 'pending' };
    await seedFollowUpsForParent(conn, bare, { pattern: 'quarterly', plannedCount: 2 });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ service_type: 'Quarterly Pest Control Service', service_id: 'svc-q', service_key_snapshot: 'pest_quarterly' });
  });

  test('linked parent whose catalog row was renamed → follow-ups carry the CURRENT name and the parent\'s link', async () => {
    const renamed = [{ id: 'svc-q', name: 'Quarterly Pest Control Plan', service_key: 'pest_quarterly', is_active: true }];
    const { conn, inserted } = makeConn({ services: renamed });
    await seedFollowUpsForParent(conn, { ...PARENT, service_id: 'svc-q', service_key_snapshot: 'pest_quarterly' }, { pattern: 'quarterly', plannedCount: 2 });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ service_type: 'Quarterly Pest Control Plan', service_id: 'svc-q', service_key_snapshot: 'pest_quarterly' });
  });

  test('an explicit caller serviceType still wins the label; the resolved link still applies', async () => {
    const { conn, inserted } = makeConn();
    await seedFollowUpsForParent(conn, PARENT, { pattern: 'quarterly', plannedCount: 2, serviceType: 'Caller Label' });
    expect(inserted[0]).toMatchObject({ service_type: 'Caller Label', service_id: 'svc-q' });
  });

  test('catalog unreadable → fail closed to the parent label + link (verbatim), seeding still succeeds', async () => {
    const { conn, inserted } = makeConn({ servicesThrow: true });
    const res = await seedFollowUpsForParent(conn, PARENT, { pattern: 'quarterly', plannedCount: 2 });
    expect(res.insertedCount).toBe(1);
    expect(inserted[0].service_type).toBe('Quarterly Pest Control');
    expect(inserted[0].service_id).toBeNull(); // the parent's own (null) link, copied as before
  });
});
