/**
 * Nightly day re-plan runner (services/day-replan/index.js), shadow only: gate off reads nothing; shadow writes
 * plan rows to day_replan_plans and NEVER touches scheduled_services or appointment_reminders; stops are movable
 * or fixed by the owner's 2026-11-03 rules. Fake knex, synthetic ids only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/day-replan/planner', () => {
  const actual = jest.requireActual('../services/day-replan/planner');
  return { planDay: jest.fn(actual.planDay), DEFAULT_OPTIONS: actual.DEFAULT_OPTIONS };
});
jest.mock('../services/scheduling/occupancy', () => ({ techScopedConfirmActive: jest.fn(() => false) }));
jest.mock('../services/auto-dispatch/candidate-slots', () => ({ DAY_OPEN: 8 * 60, DAY_CLOSE: 17 * 60 }));
jest.mock('../services/route-reorder', () => ({ _internals: { LIVE_HOLD_SQL: '(live-hold)' }, CUSTOMER_PREMISE_ALIASES: [{ customer_address_line1: 'customers.address_line1' }] }));
jest.mock('../services/auto-dispatch/preferences', () => ({ getCustomerSchedulingPreferences: jest.fn() }));

const logger = require('../services/logger');
const { planDay } = require('../services/day-replan/planner');
const { techScopedConfirmActive } = require('../services/scheduling/occupancy');
const { getCustomerSchedulingPreferences } = require('../services/auto-dispatch/preferences');
const { runDayReplanIfEnabled, _internals } = require('../services/day-replan');

const NOW = new Date('2026-11-03T12:00:00Z'); // 07:00 ET; DST has ended, ET = UTC-5
const TOMORROW = '2026-11-04';
const TECH = '00000000-0000-4000-8000-000000000001';
const HQ = { lat: 27.4330885, lng: -82.4056801 };

/** A chainable fake knex: reads resolve from `tables`, only inserts into day_replan_plans are expected. */
function fakeConn({ stopsByDate = {}, reminders = [], failReminders = false, blocks = [] } = {}) {
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
            if (table === 'tech_schedule_blocks') out = blocks;
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
    // Each stop is its own property unless a test says otherwise.
    service_address_line1: `${id} Test Ln`,
    service_address_line2: null,
    service_address_city: 'Parrish',
    service_address_zip: '34219',
    customer_address_line1: `${id} Test Ln`,
    customer_city: 'Parrish',
    customer_zip: '34219',
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
  techScopedConfirmActive.mockReturnValue(false);
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

  describe('the current route savings are measured against', () => {
    // Two stops share 09:00 and the stored numbers are a real plan (1, 2, 3: whole, no gaps or repeats).
    const day = (extra = {}) => [
      row('x', 0.30, 9, { route_order: 2, ...extra.x }),
      row('y', 0.01, 9, { route_order: 1, ...extra.y }),
      row('z', 0.02, 10, { route_order: 3, ...extra.z }),
    ];
    const run = async (rows) => {
      jest.clearAllMocks();
      const { conn, inserts } = fakeConn({ stopsByDate: { [TOMORROW]: rows } });
      const out = await runDayReplanIfEnabled({ now: NOW, conn });
      const result = planDay.mock.results[0].value;
      // The table keeps the documented shape: `fixed` is an array of stops, and no baseline key is in the row.
      expect(Array.isArray(JSON.parse(inserts[0].row.fixed))).toBe(true);
      expect(Object.keys(inserts[0].row).filter((k) => /baseline|stale/.test(k))).toEqual([]);
      return { result, fixed: out.plans[0], out, call: planDay.mock.calls[0][0] };
    };

    test('a real stored order that is cheaper than clock order is the baseline (route_order 1 first)', async () => {
      // Clock order breaks the 09:00 tie by id (x, far, first); the stored order visits the near stop y first.
      const { result, fixed, call } = await run(day());
      expect(result.current.baseline).toBe('stored');
      expect(result.current.order).toEqual(['y', 'x', 'z']);
      expect(fixed.baseline).toBe('stored');
      expect(fixed).toMatchObject({ date: TOMORROW, technician_id: TECH, stored_order_stale: [] });
      expect(fixed.baseline_drive_min.stored).toBeLessThan(fixed.baseline_drive_min.clock);
      expect(call.options.baselines.map((b) => b.name)).toEqual(['stored', 'clock']);
    });

    test('the summary and the one info line name the baseline of each planned day', async () => {
      const { out } = await run(day());
      expect(out.plans).toEqual([expect.objectContaining({ date: TOMORROW, technician_id: TECH, baseline: 'stored' })]);
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('baselines={"stored":1}'));
    });

    test('a stored order that drives more than clock order is not used', async () => {
      // Clock order breaks the 09:00 tie by id (a, near, first); the stored order sends the van to the far stop b first.
      const rows = [row('a', 0.01, 9, { route_order: 2 }), row('b', 0.30, 9, { route_order: 1 }), row('z', 0.02, 10, { route_order: 3 })];
      const { result, fixed } = await run(rows);
      expect(result.current.baseline).toBe('clock');
      expect(result.current.order).toEqual(['a', 'b', 'z']);
      expect(fixed.baseline).toBe('clock');
      expect(fixed.baseline_drive_min.clock).toBeLessThan(fixed.baseline_drive_min.stored);
    });

    test('leftover numbering (duplicate numbers) is not a candidate: the clock order is the baseline', async () => {
      const { result, fixed, call } = await run(day({ x: { route_order: 1 }, y: { route_order: 1 } }));
      expect(fixed.stored_order_stale).toEqual(expect.arrayContaining(['duplicate']));
      expect(fixed.baseline).toBe('clock');
      expect(result.current.order).toEqual(['x', 'y', 'z']);
      expect(call.options.baselines.map((b) => b.name)).toEqual(['clock']);
      expect(Object.keys(fixed.baseline_drive_min)).toEqual(['clock']);
    });

    test('missing numbers and gaps are leftover too', async () => {
      expect((await run(day({ y: { route_order: null } }))).fixed.stored_order_stale).toEqual(expect.arrayContaining(['null']));
      expect((await run(day({ z: { route_order: 9 } }))).fixed.stored_order_stale).toEqual(expect.arrayContaining(['gap']));
    });

    test('a tie keeps the stored order, and the choice repeats', async () => {
      // Both stops at one place: either order drives the same.
      const rows = [row('x', 0.05, 9, { route_order: 2 }), row('y', 0.05, 9, { route_order: 1 }), row('z', 0.06, 10, { route_order: 3 })];
      const first = await run(rows);
      const second = await run(rows);
      expect(first.result.current.baseline).toBe('stored');
      expect(first.result.current.order).toEqual(['y', 'x', 'z']);
      expect(second.result.current.order).toEqual(first.result.current.order);
      expect(second.result.current.baseline).toBe(first.result.current.baseline);
    });
  });

  describe('co-visit rows and the app simulation', () => {
    // One customer, one property, one promised hour, no real estimate: one physical stop of one hour.
    const pairRows = () => [
      row('x1', 0.05, 9, { customer_id: 'cust-pair', estimated_duration_minutes: null, service_address_line1: '9 Pair Ln', customer_address_line1: '9 Pair Ln' }),
      row('x2', 0.05, 9, { customer_id: 'cust-pair', estimated_duration_minutes: null, service_address_line1: '9 Pair Ln', customer_address_line1: '9 Pair Ln' }),
      row('o1', 0.30, 10),
      row('o2', 0.02, 11),
    ];

    test('a co-visit pair is ONE fixed planner stop charged one stay, and both rows are listed as fixed', async () => {
      const { conn, inserts } = fakeConn({ stopsByDate: { [TOMORROW]: pairRows() } });
      await runDayReplanIfEnabled({ now: NOW, conn });
      const { stops, options } = planDay.mock.calls[0][0];
      expect(stops.map((st) => st.id).sort()).toEqual(['o1', 'o2', 'x1']);
      const merged = stops.find((st) => st.id === 'x1');
      expect(merged).toMatchObject({ movable: false, workMin: 60, slotStartMin: 9 * 60 });
      // Baselines name the group by its first row.
      for (const b of options.baselines) expect(b.order.sort()).toEqual(['o1', 'o2', 'x1']);
      const fixed = JSON.parse(inserts[0].row.fixed).filter((f) => f.why === 'same_customer').map((f) => f.id).sort();
      expect(fixed).toEqual(['x1', 'x2']);
    });

    test('the row stores the app simulation numbers, and the summary has both sets', async () => {
      const { conn, inserts } = fakeConn({ stopsByDate: { [TOMORROW]: zigzagRows() } });
      const out = await runDayReplanIfEnabled({ now: NOW, conn });
      const plan = inserts[0].row;
      const sim = out.plans[0].app_sim;
      expect(plan.current_drive_min).toBe(sim.current.driveMin);
      expect(plan.planned_drive_min).toBe(sim.planned.driveMin);
      expect(plan.current_end_min).toBe(sim.current.endMin);
      expect(plan.planned_end_min).toBe(sim.planned.endMin);
      expect(plan.saved_min).toBe(sim.current.driveMin - sim.planned.driveMin);
      expect(sim.planned.kept).toBe(true);
      expect(out.plans[0].planner).toMatchObject({ accepted: true, reason: 'accepted' });
    });

    test('a planner plan the app simulation rejects is not accepted and lists no changes', async () => {
      // The planner (stubbed) claims a big saving by booking every stop at 08:00; the app simulation sees the van
      // reach the later stops far past their promise.
      planDay.mockImplementationOnce(() => ({
        current: { driveMin: 200, endMin: 900, order: ['a', 'b', 'c', 'd'], baseline: 'clock', baselineDrives: { clock: 200 } },
        best: { driveMin: 20, endMin: 800, order: ['a', 'b', 'c', 'd'], slots: { a: 480, b: 480, c: 480, d: 480 } },
        accepted: true,
        reason: 'accepted',
        savedMin: 180,
        grandfathered: [],
        changes: [{ id: 'b', fromMin: 540, toMin: 480 }],
      }));
      const { conn, inserts } = fakeConn({ stopsByDate: { [TOMORROW]: zigzagRows() } });
      const out = await runDayReplanIfEnabled({ now: NOW, conn });
      expect(inserts[0].row).toMatchObject({ accepted: false, reason: 'app_sim_rejects', changes: '[]' });
      expect(out.accepted).toBe(0);
      expect(out.changedVisits).toBe(0);
      expect(out.plans[0].app_sim.planned.kept).toBe(false);
    });
  });

  describe('technician schedule blocks', () => {
    const blockRow = (start, end, extra = {}) => ({ id: 'blk', technician_id: TECH, start_time: start, end_time: end, block_type: 'blocked', ...extra });

    test('loads own and global non-available blocks for the date, always, and hands them to the planner', async () => {
      const { conn, calls } = fakeConn({
        stopsByDate: { [TOMORROW]: zigzagRows() },
        blocks: [blockRow('08:00:00', '10:00:00'), blockRow('12:00:00', '13:00:00', { technician_id: null, block_type: 'lunch' })],
      });
      await runDayReplanIfEnabled({ now: NOW, conn });
      const methods = calls.filter(([t]) => t === 'tech_schedule_blocks').map(([, m]) => m);
      expect(methods).toEqual(expect.arrayContaining(['where', 'whereNot', 'select']));
      const options = planDay.mock.calls[0][0].options;
      expect(options.blocks).toEqual([{ startMin: 480, endMin: 600 }, { startMin: 720, endMin: 780 }]);
    });

    test('a block that covers the whole day skips the day and writes no row', async () => {
      const { conn, inserts } = fakeConn({ stopsByDate: { [TOMORROW]: zigzagRows() }, blocks: [blockRow('07:00:00', '18:00:00')] });
      const out = await runDayReplanIfEnabled({ now: NOW, conn });
      expect(inserts).toEqual([]);
      expect(out.skipped).toEqual([{ date: TOMORROW, technician_id: TECH, reason: 'DAY_BLOCKED', stops: 4 }]);
    });

    test('an unreadable block table fails that tech-day closed', async () => {
      const { conn } = fakeConn({ stopsByDate: { [TOMORROW]: zigzagRows() } });
      const failing = (table) => (table === 'tech_schedule_blocks' ? { where: () => { throw new Error('blocks down'); } } : conn(table));
      failing.raw = conn.raw;
      const out = await runDayReplanIfEnabled({ now: NOW, conn: failing });
      expect(out.failed).toEqual([{ date: TOMORROW, technician_id: TECH, reason: 'PLAN_FAILED' }]);
    });

    test('a fixed stop that overlapped a block as booked is listed with a note', async () => {
      const rows = [...zigzagRows(), row('e', 0.04, 12, { auto_dispatch_locked: true, customer_id: 'cust-e' })];
      const { conn, inserts } = fakeConn({ stopsByDate: { [TOMORROW]: rows }, blocks: [blockRow('12:00:00', '13:00:00')] });
      await runDayReplanIfEnabled({ now: NOW, conn });
      expect(JSON.parse(inserts[0].row.fixed)).toEqual([{ id: 'e', why: 'staff_lock', note: 'overlaps_block_as_booked' }]);
    });
  });

  describe('day bounds', () => {
    test('the planner gets the night pass open and close, not its own copy', async () => {
      const { conn } = fakeConn({ stopsByDate: { [TOMORROW]: zigzagRows() } });
      await runDayReplanIfEnabled({ now: NOW, conn });
      const { options } = planDay.mock.calls[0][0];
      expect(options.firstHour).toBe(8);
      expect(options.closeMin).toBe(17 * 60);
    });
  });

  describe('dry window', () => {
    const info = (extra = {}) => ({ mode: 'true', hours: 4, class: 'long', source: 'service_rule', window_key: 'dry_long', customer_time: false, ...extra });

    test('applies only in mode true, with no customer time, a rain-sensitive class and an in-season window', () => {
      expect(_internals.dryWindowPref(info())).toEqual({ startMin: 480, endMin: 600 });
      expect(_internals.dryWindowPref(info({ class: 'short', window_key: 'dry_short' }))).toEqual({ startMin: 480, endMin: 720 });
      expect(_internals.dryWindowPref(info({ mode: 'shadow' }))).toBeNull();
      expect(_internals.dryWindowPref(info({ mode: 'off' }))).toBeNull();
      expect(_internals.dryWindowPref(undefined)).toBeNull();
      expect(_internals.dryWindowPref(info({ customer_time: true }))).toBeNull();
      expect(_internals.dryWindowPref(info({ class: 'proof', window_key: 'dry_proof' }))).toBeNull();
      expect(_internals.dryWindowPref(info({ window_key: null }))).toBeNull();
    });

    test('mode true limits a movable stop to its dry window; shadow leaves it free; a customer time wins', async () => {
      const run = async (prefs) => {
        jest.clearAllMocks();
        getCustomerSchedulingPreferences.mockResolvedValue(prefs);
        const { conn } = fakeConn({ stopsByDate: { [TOMORROW]: zigzagRows() } });
        await runDayReplanIfEnabled({ now: NOW, conn });
        return planDay.mock.calls[0][0].stops.map((s) => s.pref);
      };
      expect(await run({ preferred_time_window: null, dry_time: info() })).toEqual(Array(4).fill({ startMin: 480, endMin: 600 }));
      expect(await run({ preferred_time_window: null, dry_time: info({ mode: 'shadow' }) })).toEqual(Array(4).fill(null));
      expect(await run({ preferred_time_window: { startMin: 780, endMin: 900 }, dry_time: info() })).toEqual(Array(4).fill({ startMin: 780, endMin: 900 }));
    });
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
