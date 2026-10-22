/**
 * recurring-appointment-seeder — taken-hour hand-off (GATE_PLAN_TAKEN_HOUR_HANDOFF;
 * owner 2026-10-22, auto-dispatch audit D4: "If the automatic visit plan lands on
 * a taken time, leave the visit without a time so the tool picks a free one").
 * A follow-up whose hour another customer's live visit holds, four or more days
 * out, is seeded WINDOWLESS with its date as recurring_dispatch_due_date; every
 * other follow-up keeps the plan's hour. Gate off: no probe, rows unchanged.
 * Harness mirrors recurring-seeder-tech-absence.test.js.
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
jest.mock('../services/scheduling/occupancy', () => ({
  ...jest.requireActual('../services/scheduling/occupancy'),
  findConflictingVisits: jest.fn(async () => []),
}));

const { findConflictingVisits } = require('../services/scheduling/occupancy');
const { seedFollowUpsForParent } = require('../services/recurring-appointment-seeder');
const { etDateString, addETDays } = require('../utils/datetime-et');

const COLS = Object.fromEntries([
  'id', 'customer_id', 'technician_id', 'scheduled_date', 'window_start', 'window_end',
  'service_type', 'status', 'notes', 'time_window', 'zone', 'estimated_duration_minutes',
  'estimated_price', 'payment_method_preference', 'source_estimate_id', 'source',
  'is_recurring', 'recurring_pattern', 'recurring_parent_id', 'recurring_ongoing',
  'recurring_nth', 'recurring_weekday', 'recurring_interval_days',
  'customer_confirmed', 'confirmed_at', 'skip_weekends', 'weekend_shift',
  'appointment_type', 'updated_at', 'recurring_dispatch_due_date', 'window_display', 'route_order',
].map((c) => [c, {}]));

const TECH = 'aaaaaaaa-1111-4222-8333-444444444444';
const day = (n) => etDateString(addETDays(new Date(), n));

function makeConn() {
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
    if (table === 'property_preferences') return { where: () => ({ first: async () => null }) };
    if (table === 'technicians') {
      const q = { where: () => q, forShare: () => q, first: async () => ({ id: TECH, employment_status: 'active', field_dispatchable: true }) };
      return q;
    }
    if (table === 'technician_absences') {
      const q = { whereBetween: () => q, whereNull: () => q, whereIn: () => q, select: async () => [] };
      return q;
    }
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
  technician_id: TECH,
  scheduled_date: day(0),
  window_start: '10:00',
  window_end: '11:00',
  time_window: 'morning',
  estimated_duration_minutes: 60,
  service_type: 'Quarterly Pest Control',
  recurring_pattern: 'quarterly',
  skip_weekends: false,
};

// Another customer's live visit holds 10:00 on `takenDays` only.
function holdOn(takenDays) {
  findConflictingVisits.mockImplementation(async ({ date }) => (takenDays.includes(date) ? [{ id: `other-${date}`, customer_id: 'customer-2' }] : []));
}

// The dates the plan itself gives `parent` (its pattern walk), read from a
// gate-off pass, so each test can hold the hour on one of them.
async function planDates(parent) {
  const { conn, inserted } = makeConn();
  await seedFollowUpsForParent(conn, parent);
  return inserted.map((r) => r.scheduled_date);
}

describe('follow-up seeding hands a taken hour to auto-dispatch', () => {
  afterEach(() => {
    delete process.env.GATE_PLAN_TAKEN_HOUR_HANDOFF;
    findConflictingVisits.mockReset().mockImplementation(async () => []);
  });

  test('gate on: the taken day is seeded with no time and its date as the due date; the free days keep 10:00', async () => {
    const dates = await planDates(PARENT);
    expect(dates.length).toBeGreaterThanOrEqual(3);
    const taken = dates[1];
    process.env.GATE_PLAN_TAKEN_HOUR_HANDOFF = 'true';
    holdOn([taken]);
    const { conn, inserted } = makeConn();
    const result = await seedFollowUpsForParent(conn, PARENT);
    expect(result.insertedCount).toBe(dates.length);
    const byDate = Object.fromEntries(inserted.map((r) => [r.scheduled_date, r]));
    expect(byDate[taken]).toMatchObject({
      window_start: null, window_end: null, time_window: null, window_display: null, route_order: null,
      recurring_dispatch_due_date: taken, technician_id: TECH,
    });
    for (const d of dates.filter((x) => x !== taken)) {
      expect(byDate[d]).toMatchObject({ window_start: '10:00', window_end: '11:00', time_window: 'morning' });
      expect(byDate[d].recurring_dispatch_due_date).toBeUndefined();
    }
    // The probe asks for the plan's own block and carries the technician; the
    // customer's own rows count unless at the same place (plan-taken-hour.test.js).
    expect(findConflictingVisits).toHaveBeenCalledWith(expect.objectContaining({
      date: taken, windowStart: '10:00', windowEnd: '11:00', technicianId: TECH,
    }));
    expect(findConflictingVisits.mock.calls.every(([args]) => args.excludeCustomerId === undefined)).toBe(true);
  });

  test('gate on: a follow-up under four days out keeps its hour (the night tool cannot move it); nothing is probed for it', async () => {
    // A weekly plan whose first visit was five days ago: its next follow-up is two days out.
    const weekly = { ...PARENT, scheduled_date: day(-5), recurring_pattern: 'weekly' };
    const dates = await planDates(weekly);
    const near = dates.filter((d) => d < day(4));
    const far = dates.filter((d) => d >= day(4));
    expect(near.length).toBeGreaterThan(0);
    expect(far.length).toBeGreaterThan(0);
    process.env.GATE_PLAN_TAKEN_HOUR_HANDOFF = 'true';
    holdOn(dates);
    const { conn, inserted } = makeConn();
    await seedFollowUpsForParent(conn, weekly);
    const byDate = Object.fromEntries(inserted.map((r) => [r.scheduled_date, r]));
    for (const d of near) expect(byDate[d].window_start).toBe('10:00');
    for (const d of far) expect(byDate[d].window_start).toBeNull();
    expect(findConflictingVisits.mock.calls.map(([args]) => args.date)).toEqual(far);
  });

  test('gate off: no probe, every follow-up keeps the plan hour (unchanged)', async () => {
    const dates = await planDates(PARENT);
    holdOn(dates);
    const { conn, inserted } = makeConn();
    await seedFollowUpsForParent(conn, PARENT);
    expect(findConflictingVisits).not.toHaveBeenCalled();
    expect(inserted.length).toBe(dates.length);
    expect(inserted.every((r) => r.window_start === '10:00')).toBe(true);
  });

  test('gate on: a windowless plan has nothing to probe', async () => {
    process.env.GATE_PLAN_TAKEN_HOUR_HANDOFF = 'true';
    const { conn, inserted } = makeConn();
    await seedFollowUpsForParent(conn, { ...PARENT, window_start: null, window_end: null });
    expect(findConflictingVisits).not.toHaveBeenCalled();
    expect(inserted.length).toBeGreaterThan(0);
    expect(inserted.every((r) => r.window_start == null && r.recurring_dispatch_due_date === undefined)).toBe(true);
  });
});
