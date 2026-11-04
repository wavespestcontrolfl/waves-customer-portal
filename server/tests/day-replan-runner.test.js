/**
 * Nightly day re-plan runner (services/day-replan/index.js), shadow only: gate off reads nothing; shadow writes
 * plan rows to day_replan_plans and NEVER touches scheduled_services or appointment_reminders; stops are movable
 * or fixed by the owner's 2026-11-03 rules. Fake knex, synthetic ids only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/day-replan/planner', () => {
  const actual = jest.requireActual('../services/day-replan/planner');
  return { planDay: jest.fn(actual.planDay) };
});
jest.mock('../services/route-reorder', () => ({ _internals: { LIVE_HOLD_SQL: '(live-hold)' } }));
jest.mock('../services/auto-dispatch/preferences', () => ({ getCustomerSchedulingPreferences: jest.fn() }));

const logger = require('../services/logger');
const { planDay } = require('../services/day-replan/planner');
const { getCustomerSchedulingPreferences } = require('../services/auto-dispatch/preferences');
const { runDayReplanIfEnabled, _internals } = require('../services/day-replan');

const NOW = new Date('2026-11-03T12:00:00Z'); // 07:00 ET; DST has ended, ET = UTC-5
const TOMORROW = '2026-11-04';
const TECH = '00000000-0000-4000-8000-000000000001';
const HQ = { lat: 27.4330885, lng: -82.4056801 };

/** A chainable fake knex: reads resolve from `tables`, only inserts into day_replan_plans are expected. */
function fakeConn({ stopsByDate = {}, reminders = [], failReminders = false } = {}) {
  const calls = [];
  const inserts = [];
  const conn = (table) => {
    const state = { table, date: null };
    const chain = new Proxy(state, {
      get(target, prop) {
        if (prop === 'then') {
          return (resolve, reject) => {
            let out = [];
            if (table === 'scheduled_services') out = stopsByDate[target.date] || [];
            if (table === 'appointment_reminders') {
              if (failReminders) return Promise.reject(new Error('reminders down')).then(resolve, reject);
              out = reminders;
            }
            return Promise.resolve(out).then(resolve, reject);
          };
        }
        if (prop === 'insert') {
          return (row) => { inserts.push({ table, row }); calls.push([table, 'insert']); return Promise.resolve([]); };
        }
        return (...args) => {
          calls.push([table, String(prop)]);
          if (prop === 'where' && args[0] === 'scheduled_services.scheduled_date') target.date = args[1];
          return chain;
        };
      },
    });
    return chain;
  };
  conn.raw = (sql) => ({ sql });
  return { conn, calls, inserts };
}

function row(id, lngOffset, hour, extra = {}) {
  return {
    id,
    technician_id: TECH,
    customer_id: `cust-${id}`,
    visit_id: null,
    status: 'confirmed',
    window_start: `${String(hour).padStart(2, '0')}:00:00`,
    window_end: `${String(hour + 1).padStart(2, '0')}:00:00`,
    time_window: null,
    estimated_duration_minutes: 60,
    service_type: 'Quarterly Pest Control Service',
    is_recurring: true,
    is_callback: false,
    auto_dispatch_locked: false,
    auto_dispatch_excluded: false,
    reservation_expires_at: null,
    route_order: null,
    lat: HQ.lat,
    lng: HQ.lng + lngOffset,
    ...extra,
  };
}

// East of the office: far, near, far, near on slots 8, 9, 10, 11.
function zigzagRows(extra = {}) {
  return [row('a', 0.30, 8, extra.a), row('b', 0.02, 9, extra.b), row('c', 0.31, 10, extra.c), row('d', 0.03, 11, extra.d)];
}

const savedEnv = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GATE_DAY_REPLAN;
  delete process.env.DAY_REPLAN_DAYS_AHEAD;
  delete process.env.GATE_TECH_START_POINTS;
  delete process.env.GATE_AUTO_DISPATCH_DAY_RULES;
  getCustomerSchedulingPreferences.mockResolvedValue({ preferred_time_window: null });
});
afterAll(() => { process.env = savedEnv; });

describe('gate', () => {
  test('off (unset, false, garbage) returns at once and reads nothing', async () => {
    for (const value of [undefined, 'false', 'yes', '']) {
      if (value === undefined) delete process.env.GATE_DAY_REPLAN; else process.env.GATE_DAY_REPLAN = value;
      const { conn, calls } = fakeConn();
      await expect(runDayReplanIfEnabled({ now: NOW, conn })).resolves.toEqual({ status: 'off' });
      expect(calls).toEqual([]);
    }
  });

  test('true behaves like shadow and says apply is not built yet', async () => {
    process.env.GATE_DAY_REPLAN = 'true';
    const { conn, inserts } = fakeConn({ stopsByDate: { [TOMORROW]: zigzagRows() } });
    const out = await runDayReplanIfEnabled({ now: NOW, conn });
    expect(out.status).toBe('completed');
    expect(inserts).toHaveLength(1);
    expect(inserts[0].row.mode).toBe('shadow');
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('apply is not built yet'));
  });
});

describe('shadow run', () => {
  beforeEach(() => { process.env.GATE_DAY_REPLAN = 'shadow'; });

  test('writes one plan row per planned tech-day and never updates a visit or a reminder', async () => {
    const { conn, calls, inserts } = fakeConn({ stopsByDate: { [TOMORROW]: zigzagRows() } });
    const out = await runDayReplanIfEnabled({ now: NOW, conn });

    expect(out).toMatchObject({ status: 'completed', days: 1, accepted: 1, skipped: [], failed: [] });
    expect(out.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.savedMin).toBeGreaterThanOrEqual(10);
    expect(out.changedVisits).toBeGreaterThan(0);

    expect(inserts).toHaveLength(1);
    const { table, row: plan } = inserts[0];
    expect(table).toBe('day_replan_plans');
    expect(plan).toMatchObject({
      run_id: out.runId, mode: 'shadow', technician_id: TECH, service_date: TOMORROW, stop_count: 4, accepted: true, reason: 'accepted',
    });
    expect(plan.planned_drive_min).toBeLessThan(plan.current_drive_min);
    expect(plan.saved_min).toBe(plan.current_drive_min - plan.planned_drive_min);
    expect(plan.planned_end_min).toBeLessThanOrEqual(plan.current_end_min);
    const changes = JSON.parse(plan.changes);
    expect(changes.length).toBe(out.changedVisits);
    for (const c of changes) {
      expect(Object.keys(c).sort()).toEqual(['from', 'id', 'to']);
      expect(c.from).toMatch(/^\d\d:\d\d$/);
      expect(c.to).toMatch(/^\d\d:\d\d$/);
    }
    expect(JSON.parse(plan.fixed)).toEqual([]);

    // Nothing but reads, plus the one plan insert.
    const writes = calls.filter(([, method]) => ['insert', 'update', 'del', 'delete', 'upsert', 'merge'].includes(method));
    expect(writes).toEqual([['day_replan_plans', 'insert']]);
  });

  test('stops sharing an hour keep the order the 04:20 pass saved (route_order, nulls last, then id)', async () => {
    // Returned in reverse of their saved order; the planner's baseline must visit route_order 1 first.
    const rows = [
      row('x', 0.05, 9, { route_order: 2 }),
      row('y', 0.01, 9, { route_order: 1 }),
      row('n2', 0.02, 10, { route_order: null }),
      row('n1', 0.03, 10, { route_order: null }),
      row('r', 0.04, 10, { route_order: 5 }),
    ];
    const { conn } = fakeConn({ stopsByDate: { [TOMORROW]: rows } });
    await runDayReplanIfEnabled({ now: NOW, conn });
    expect(planDay.mock.calls[0][0].stops.map((s) => s.id)).toEqual(['y', 'x', 'r', 'n1', 'n2']);
    expect(planDay.mock.results[0].value.current.order).toEqual(['y', 'x', 'r', 'n1', 'n2']);
  });

  test('looks from tomorrow out DAY_REPLAN_DAYS_AHEAD days (default 14)', async () => {
    const dates = _internals.horizonDates(NOW);
    expect(dates).toHaveLength(14);
    expect(dates[0]).toBe('2026-11-04');
    expect(dates.at(-1)).toBe('2026-11-17');
    process.env.DAY_REPLAN_DAYS_AHEAD = '3';
    expect(_internals.horizonDates(NOW)).toEqual(['2026-11-04', '2026-11-05', '2026-11-06']);
    process.env.DAY_REPLAN_DAYS_AHEAD = 'junk';
    expect(_internals.horizonDates(NOW)).toHaveLength(14);
  });

  test('fixed stops keep their hour and are listed with why', async () => {
    const rows = zigzagRows({
      a: { auto_dispatch_locked: true },
      b: { visit_id: 'v1' },
      c: { visit_id: 'v1' },
      d: { status: 'pending' },
    });
    rows.push(row('e', 0.04, 12));
    rows.push(row('f', 0.05, 13, { customer_id: 'cust-d' }));
    const reminders = [{ scheduled_service_id: 'e', reminder_24h_sent: true }];
    const { conn, inserts } = fakeConn({ stopsByDate: { [TOMORROW]: rows }, reminders });
    await runDayReplanIfEnabled({ now: NOW, conn });
    const fixed = Object.fromEntries(JSON.parse(inserts[0].row.fixed).map((f) => [f.id, f.why]));
    const moved = JSON.parse(inserts[0].row.changes).map((c) => c.id);
    for (const id of Object.keys(fixed)) expect(moved).not.toContain(id);
    expect(fixed).toEqual({
      a: 'staff_lock', b: 'grouped', c: 'grouped', d: 'same_customer', e: 'reminder_24h_sent', f: 'same_customer',
    });
  });

  test('reads the customer preference only for movable stops and keeps a stop fixed when it cannot be read', async () => {
    getCustomerSchedulingPreferences.mockImplementation(async (customerId) => {
      if (customerId === 'cust-c') throw new Error('prefs down');
      return { preferred_time_window: customerId === 'cust-b' ? { startMin: 660, endMin: 720 } : null };
    });
    const rows = zigzagRows({ a: { auto_dispatch_locked: true } });
    const { conn, inserts } = fakeConn({ stopsByDate: { [TOMORROW]: rows } });
    await runDayReplanIfEnabled({ now: NOW, conn });
    const asked = getCustomerSchedulingPreferences.mock.calls.map((c) => c[0]).sort();
    expect(asked).toEqual(['cust-b', 'cust-c', 'cust-d']);
    expect(JSON.parse(inserts[0].row.fixed)).toEqual(expect.arrayContaining([{ id: 'a', why: 'staff_lock' }, { id: 'c', why: 'pref_unknown' }]));
    const changeToB = JSON.parse(inserts[0].row.changes).find((c) => c.id === 'b');
    if (changeToB) expect(changeToB.to).toBe('11:00');
  });

  test.each([
    ['fewer than 2 stops', [row('a', 0.1, 8)], 'FEWER_THAN_2_STOPS'],
    ['an untimed stop', zigzagRows({ b: { window_start: null } }), 'UNTIMED_STOP'],
    ['a stop without coordinates', zigzagRows({ b: { lat: null, lng: null } }), 'STOP_WITHOUT_COORDINATES'],
    ['a stop on site', zigzagRows({ b: { status: 'on_site' } }), 'STOP_IN_PROGRESS'],
    ['a stop en route', zigzagRows({ b: { status: 'en_route' } }), 'STOP_IN_PROGRESS'],
  ])('skips a day with %s and writes no row', async (_label, rows, reason) => {
    const { conn, inserts } = fakeConn({ stopsByDate: { [TOMORROW]: rows } });
    const out = await runDayReplanIfEnabled({ now: NOW, conn });
    expect(inserts).toEqual([]);
    expect(out.days).toBe(0);
    expect(out.skipped).toEqual([{ date: TOMORROW, technician_id: TECH, reason, stops: rows.length }]);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining(reason));
  });

  test('an unreadable reminder table skips the day (fail closed) and the run reports it', async () => {
    const { conn, inserts } = fakeConn({ stopsByDate: { [TOMORROW]: zigzagRows() }, failReminders: true });
    const out = await runDayReplanIfEnabled({ now: NOW, conn });
    expect(inserts).toEqual([]);
    expect(out.status).toBe('completed_with_errors');
    expect(out.failed).toEqual([{ date: TOMORROW, reason: 'LOAD_FAILED' }]);
  });

  test('a failed plan insert is reported, never thrown', async () => {
    const { conn } = fakeConn({ stopsByDate: { [TOMORROW]: zigzagRows() } });
    const failing = (table) => {
      const chain = conn(table);
      return table === 'day_replan_plans' ? { insert: () => Promise.reject(new Error('disk full')) } : chain;
    };
    failing.raw = conn.raw;
    const out = await runDayReplanIfEnabled({ now: NOW, conn: failing });
    expect(out.status).toBe('completed_with_errors');
    expect(out.failed).toEqual([{ date: TOMORROW, technician_id: TECH, reason: 'PLAN_FAILED' }]);
  });
});

describe('movable or fixed', () => {
  const base = () => ({
    dateStr: TOMORROW,
    now: NOW,
    visitCounts: new Map(),
    customerCounts: new Map(),
    sent24: new Set(),
  });
  const stop = (extra = {}) => ({ id: 's1', status: 'confirmed', window_start: '09:00:00', visit_id: null, customer_id: 'c1', ...extra });

  test('a plain confirmed or pending visit more than 24.25 h away may move', () => {
    expect(_internals.fixedReason(stop(), base())).toBeNull();
    expect(_internals.fixedReason(stop({ status: 'pending' }), base())).toBeNull();
  });

  test('the 24.25 hour boundary: exactly 24.25 h out is fixed, a minute more may move', () => {
    // 09:00 ET on 2026-11-04 is 14:00Z.
    const exactly = new Date('2026-11-03T13:45:00Z');
    const aMinuteMore = new Date('2026-11-03T13:44:00Z');
    expect(_internals.fixedReason(stop(), { ...base(), now: exactly })).toBe('within_24h');
    expect(_internals.fixedReason(stop(), { ...base(), now: aMinuteMore })).toBeNull();
    expect(_internals.LOCK_HOURS).toBe(24.25);
  });

  test('a sent 24-hour reminder fixes the visit', () => {
    expect(_internals.fixedReason(stop(), { ...base(), sent24: new Set(['s1']) })).toBe('reminder_24h_sent');
  });

  test('a staff lock, an exclusion, a hold, another status, a grouped visit and a co-visit are all fixed', () => {
    expect(_internals.fixedReason(stop({ auto_dispatch_locked: true }), base())).toBe('staff_lock');
    expect(_internals.fixedReason(stop({ auto_dispatch_excluded: true }), base())).toBe('staff_lock');
    expect(_internals.fixedReason(stop({ reservation_expires_at: new Date() }), base())).toBe('hold');
    expect(_internals.fixedReason(stop({ status: 'dispatched' }), base())).toBe('status');
    expect(_internals.fixedReason(stop({ visit_id: 'v1' }), { ...base(), visitCounts: new Map([['v1', 2]]) })).toBe('grouped');
    expect(_internals.fixedReason(stop({ visit_id: 'v1' }), { ...base(), visitCounts: new Map([['v1', 1]]) })).toBeNull();
    expect(_internals.fixedReason(stop(), { ...base(), customerCounts: new Map([['c1', 2]]) })).toBe('same_customer');
  });

  test('first visits, one-time visits and hand-placed visits are not locked by kind', () => {
    expect(_internals.fixedReason(stop({ service_type: 'One-Time Pest Control Service', is_recurring: false }), base())).toBeNull();
  });
});
