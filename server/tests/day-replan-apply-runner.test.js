/**
 * The runner in apply mode (GATE_DAY_REPLAN=true, the owner's flip): only accepted days are written, the plan row
 * records the outcome, and shadow and off stay read-only. In-memory schedule + fake rebooker; synthetic ids.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/route-reorder', () => ({ _internals: { LIVE_HOLD_SQL: '(live-hold)' }, CUSTOMER_PREMISE_ALIASES: [] }));
jest.mock('../services/auto-dispatch/preferences', () => ({ getCustomerSchedulingPreferences: jest.fn() }));
jest.mock('../services/scheduling/occupancy', () => ({ techScopedConfirmActive: jest.fn(() => false) }));
jest.mock('../services/auto-dispatch/candidate-slots', () => ({ DAY_OPEN: 8 * 60, DAY_CLOSE: 17 * 60 }));
// Loading the real night writer or rebooker must never happen from these tests: deps are injected.
// Loading the real night writer or rebooker must never happen from these tests: deps are injected.
jest.mock('../services/auto-dispatch/apply', () => { throw new Error('the night writer must not be loaded here'); });
jest.mock('../services/rebooker', () => { throw new Error('the rebooker must not be loaded here'); });

const { getCustomerSchedulingPreferences } = require('../services/auto-dispatch/preferences');
const { runDayReplanIfEnabled } = require('../services/day-replan');
const { makeDb, zigzagRows, row, makeApplyDeps } = require('./helpers/day-replan-db');

const NOW = new Date('2026-11-03T12:00:00Z'); // 07:00 ET; DST has ended
const TOMORROW = '2026-11-04';
const savedEnv = { ...process.env };

function setup({ rows, reminders = [], over = {} }) {
  const { conn, db } = makeDb({ rows, reminders });
  const { deps, mocks } = makeApplyDeps(db, { now: NOW, over });
  const run = () => runDayReplanIfEnabled({ now: NOW, conn, deps });
  const windows = () => Object.fromEntries(db.rows.map((r) => [r.id, String(r.window_start).slice(0, 5)]));
  return { conn, db, deps, ...mocks, run, windows };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GATE_DAY_REPLAN;
  delete process.env.DAY_REPLAN_DAYS_AHEAD;
  delete process.env.GATE_TECH_START_POINTS;
  delete process.env.GATE_AUTO_DISPATCH_DAY_RULES;
  getCustomerSchedulingPreferences.mockResolvedValue({ preferred_time_window: null });
});
afterAll(() => { process.env = savedEnv; });

describe('shadow and off never write a visit', () => {
  test.each([[undefined], ['shadow'], ['false'], ['garbage']])('GATE_DAY_REPLAN=%s: no lock, no visit write, no plan update', async (value) => {
    if (value !== undefined) process.env.GATE_DAY_REPLAN = value;
    const w = setup({ rows: zigzagRows() });
    const before = w.windows();
    const out = await w.run();
    expect(w.acquireOccupancyLock).not.toHaveBeenCalled();
    expect(w.syncMovedReminders).not.toHaveBeenCalled();
    expect(w.windows()).toEqual(before);
    expect(w.db.updates).toEqual([]);
    if (value === 'shadow') {
      // Byte-identical to PR 1: a shadow row, no id, no apply fields, no apply section in the summary.
      expect(w.db.inserts).toHaveLength(1);
      expect(w.db.inserts[0].row.mode).toBe('shadow');
      expect(w.db.inserts[0].row).not.toHaveProperty('id');
      expect(out).not.toHaveProperty('apply');
    } else {
      expect(w.db.inserts).toEqual([]);
      expect(out).toEqual({ status: 'off' });
    }
  });
});

describe('apply mode', () => {
  beforeEach(() => { process.env.GATE_DAY_REPLAN = 'true'; });

  test('writes the accepted day in one go, records the outcome on its plan row, and counts the visits', async () => {
    const w = setup({ rows: zigzagRows() });
    const out = await w.run();
    expect(out.status).toBe('completed');
    expect(out.apply).toEqual([expect.objectContaining({ date: TOMORROW, technician_id: 'tech-1', status: 'applied', reason: 'applied' })]);
    expect(out.appliedVisits).toBe(out.changedVisits);
    expect(out.appliedVisits).toBeGreaterThan(0);

    const insert = w.db.inserts.find((i) => i.table === 'day_replan_plans').row;
    expect(insert.mode).toBe('apply');
    expect(insert.accepted).toBe(true);
    const changes = JSON.parse(insert.changes);
    // The visits now sit on the planned hours, written directly: no temporary hour, one hour each.
    const after = w.windows();
    for (const c of changes) expect(after[c.id]).toBe(c.to);
    expect(new Set(Object.values(after)).size).toBe(4);
    const hourWrites = w.db.updates.filter((u) => u.table === 'scheduled_services' && 'window_start' in u.patch);
    expect(hourWrites).toHaveLength(changes.length);
    expect(w.db.rows.map((r) => r.route_order).sort()).toEqual([1, 2, 3, 4]);
    // One reschedule_log row per moved visit, all day_replan.
    const logs = w.db.inserts.filter((i) => i.table === 'reschedule_log').map((i) => i.row);
    expect(logs).toHaveLength(changes.length);
    expect(logs.every((l) => l.initiated_by === 'day_replan' && l.reason_code === 'day_replan')).toBe(true);
    // The plan row holds only the outcome: no journal is written any more.
    const planUpdates = w.db.updates.filter((u) => u.table === 'day_replan_plans');
    expect(planUpdates).toHaveLength(1);
    expect(planUpdates[0].patch).toMatchObject({ apply_status: 'applied', apply_reason: 'applied', applied_at: expect.anything() });
    expect(Object.keys(planUpdates[0].patch)).not.toContain('apply_steps');
    expect(insert.id).toBeTruthy();
    expect(w.syncMovedReminders).toHaveBeenCalledTimes(changes.length);
  });

  test('the applied marker commits with the hours, before any post-commit effect runs', async () => {
    const w = setup({ rows: zigzagRows() });
    const seen = [];
    // The first post-commit effect sees the plan row already applied: a crash right after the commit leaves a plan
    // reconcileApplied repairs, never one it skips.
    w.syncMovedReminders.mockImplementation(async () => { seen.push(w.db.plans[0] && w.db.plans[0].apply_status); });
    const out = await w.run();
    expect(out.apply[0].status).toBe('applied');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((st) => st === 'applied')).toBe(true);
    // Recorded once, inside the schedule transaction (the runner does not write it again).
    expect(w.db.updates.filter((u) => u.table === 'day_replan_plans')).toHaveLength(1);
  });

  test('a day the plan does not accept is planned and logged, never written', async () => {
    // Two stops that cannot save 10 minutes.
    const w = setup({ rows: [row('a', 0.05, 9), row('b', 0.06, 10)] });
    const out = await w.run();
    expect(out.accepted).toBe(0);
    expect(w.acquireOccupancyLock).not.toHaveBeenCalled();
    expect(w.db.inserts[0].row.mode).toBe('apply');
    expect(w.db.updates).toEqual([]); // no apply_status: nothing was attempted
    expect(out.apply).toEqual([]);
  });

  test('only the accepted technician-day is written when two share a date', async () => {
    const other = [row('p', 0.05, 9, { technician_id: 'tech-2' }), row('q', 0.06, 10, { technician_id: 'tech-2' })];
    const w = setup({ rows: [...zigzagRows(), ...other] });
    const before = w.windows();
    const out = await w.run();
    expect(out.apply.map((a) => a.technician_id)).toEqual(['tech-1']);
    const after = w.windows();
    expect({ p: after.p, q: after.q }).toEqual({ p: before.p, q: before.q });
    // The date was read again for the next technician after the first was written.
    expect(w.db.reads.stops).toBeGreaterThanOrEqual(3);
  });

  test('a change made after planning (any stop of the date) skips the day as changed_since_plan', async () => {
    let calls = 0;
    const w = setup({
      rows: zigzagRows(),
      // The re-read happens right after deps.now() is called for it; touch one row then.
      over: { now: () => { calls += 1; if (calls === 1) w.db.rows[1].updated_at = new Date('2026-11-03T12:30:00Z'); return NOW; } },
    });
    const out = await w.run();
    expect(out.apply).toEqual([expect.objectContaining({ status: 'skipped', reason: 'changed_since_plan', moved: 0 })]);
    expect(w.acquireOccupancyLock).not.toHaveBeenCalled();
    expect(w.db.updates[0].patch).toEqual({ apply_status: 'skipped', apply_reason: 'changed_since_plan' });
  });

  test('a clash at commit changes nothing and the plan row says skipped', async () => {
    const w = setup({ rows: zigzagRows() });
    w.findConflicts.mockImplementationOnce(async () => [{ id: 'x' }]);
    const before = w.windows();
    const out = await w.run();
    expect(out.apply[0]).toMatchObject({ status: 'skipped', reason: 'slot_taken', moved: 0 });
    expect(w.windows()).toEqual(before);
    expect(w.db.rows.map((r) => r.route_order)).toEqual([null, null, null, null]);
    expect(w.syncMovedReminders).not.toHaveBeenCalled();
    expect(w.db.updates.filter((u) => u.table === 'day_replan_plans').at(-1).patch).toMatchObject({ apply_status: 'skipped', apply_reason: 'slot_taken' });
    expect(out.appliedVisits).toBe(0);
  });

  test('an unexpected error in the writer is recorded, never thrown out of the run, and shows in the health', async () => {
    const w = setup({ rows: zigzagRows(), over: { loadDayRows: jest.fn(async () => { throw new Error('boom'); }) } });
    const out = await w.run();
    expect(out.status).toBe('completed_with_errors');
    expect(out.apply[0]).toMatchObject({ status: 'failed' });
  });
});

describe('repairing a day committed on an earlier run', () => {
  const etTime = (hhmm) => require('../utils/datetime-et').parseETDateTime(`${TOMORROW}T${hhmm}`);
  const seed = (w) => w.db.plans.push({
    id: 'old-plan', service_date: TOMORROW, apply_status: 'applied', applied_at: '2026-11-03T04:41:00Z', changes: [{ id: 'a', from: '08:00', to: '12:00' }],
  });
  const rows = () => [row('a', 0.30, 12), row('b', 0.02, 9), row('c', 0.31, 14), row('d', 0.03, 15)];
  const reminders = () => [{ scheduled_service_id: 'a', appointment_time: etTime('08:00'), cancelled: false }];

  test.each([['true'], ['shadow']])('GATE_DAY_REPLAN=%s: the moved visit\'s reminder is synced again and its records repaired, before planning', async (value) => {
    process.env.GATE_DAY_REPLAN = value;
    const w = setup({ rows: rows(), reminders: reminders() });
    seed(w);
    const out = await w.run();
    expect(out.repaired).toBe(1);
    expect(w.syncMovedReminders.mock.calls[0][1]).toMatchObject({ date: TOMORROW, start_time: '12:00' });
    expect(w.repairMoved).toHaveBeenCalledWith(expect.anything(), 'a');
    // Repair runs before any plan row is written.
    expect(w.syncMovedReminders.mock.invocationCallOrder[0]).toBeLessThan(
      Math.min(...[w.deps.loadDayRows.mock.invocationCallOrder[0] || Infinity]),
    );
  });

  test('off never looks: the kill switch reads nothing', async () => {
    delete process.env.GATE_DAY_REPLAN;
    const w = setup({ rows: rows(), reminders: reminders() });
    seed(w);
    expect(await w.run()).toEqual({ status: 'off' });
    expect(w.syncMovedReminders).not.toHaveBeenCalled();
  });

  test('a repair that cannot read never stops the run', async () => {
    process.env.GATE_DAY_REPLAN = 'true';
    const w = setup({ rows: zigzagRows() });
    let first = true;
    const failing = new Proxy(w.conn, {
      apply(target, thisArg, args) {
        if (args[0] === 'day_replan_plans' && first) {
          first = false;
          const chain = { where: () => chain, whereNotNull: () => chain, select: async () => { throw new Error('read failed'); } };
          return chain;
        }
        return Reflect.apply(target, thisArg, args);
      },
    });
    const out = await runDayReplanIfEnabled({ now: NOW, conn: failing, deps: w.deps });
    expect(out.status).toBe('completed');
  });
});
