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
jest.mock('../services/auto-dispatch/apply', () => { throw new Error('the night writer must not be loaded here'); });
jest.mock('../services/rebooker', () => { throw new Error('the rebooker must not be loaded here'); });

const { getCustomerSchedulingPreferences } = require('../services/auto-dispatch/preferences');
const { runDayReplanIfEnabled, _internals } = require('../services/day-replan');
const { makeDb, zigzagRows, row, fakeRebooker } = require('./helpers/day-replan-db');

const NOW = new Date('2026-11-03T12:00:00Z'); // 07:00 ET; DST has ended
const TOMORROW = '2026-11-04';
const savedEnv = { ...process.env };

function setup({ rows, reminders = [], rebookerOpts = {}, depsOver = {} }) {
  const { conn, db } = makeDb({ rows, reminders });
  const rebooker = fakeRebooker(db, conn, rebookerOpts);
  const syncMovedReminders = jest.fn(async () => {});
  const raiseAlert = jest.fn(async () => ({ id: 1 }));
  const deps = {
    fixedReason: _internals.fixedReason,
    rowHours: _internals.rowHours,
    excludedStatuses: ['cancelled', 'completed', 'skipped', 'rescheduled', 'no_show'],
    rebooker,
    syncMovedReminders,
    locationFields: ['property_id', 'lat', 'lng'],
    raiseAlert,
    now: () => NOW,
    ...depsOver,
  };
  const run = () => runDayReplanIfEnabled({ now: NOW, conn, deps });
  const windows = () => Object.fromEntries(db.rows.map((r) => [r.id, String(r.window_start).slice(0, 5)]));
  return { conn, db, rebooker, syncMovedReminders, raiseAlert, deps, run, windows };
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
  test.each([[undefined], ['shadow'], ['false'], ['garbage']])('GATE_DAY_REPLAN=%s: no rebooker call, no visit or plan update', async (value) => {
    if (value !== undefined) process.env.GATE_DAY_REPLAN = value;
    const w = setup({ rows: zigzagRows() });
    const before = w.windows();
    const out = await w.run();
    expect(w.rebooker.reschedule).not.toHaveBeenCalled();
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

  test('writes the accepted day, records the outcome on its plan row, and counts the visits', async () => {
    const w = setup({ rows: zigzagRows() });
    const out = await w.run();
    expect(out.status).toBe('completed');
    expect(out.apply).toEqual([expect.objectContaining({ date: TOMORROW, technician_id: 'tech-1', status: 'applied', reason: 'applied' })]);
    expect(out.appliedVisits).toBe(out.changedVisits);
    expect(out.appliedVisits).toBeGreaterThan(0);

    const insert = w.db.inserts[0].row;
    expect(insert.mode).toBe('apply');
    expect(insert.accepted).toBe(true);
    const changes = JSON.parse(insert.changes);
    // The visits now sit on the planned hours, and every write used the day_replan initiator.
    const after = w.windows();
    for (const c of changes) expect(after[c.id]).toBe(c.to);
    expect(w.rebooker.calls.every((c) => c.reason === 'day_replan' && c.by === 'day_replan')).toBe(true);
    // No visit ends on a temporary hour: the final hours are one per hour.
    expect(new Set(Object.values(after)).size).toBe(4);

    expect(w.db.updates.filter((u) => u.table === 'scheduled_services')).toEqual([]);
    const outcome = w.db.updates.find((u) => u.table === 'day_replan_plans');
    expect(outcome.count).toBe(1);
    expect(outcome.patch).toMatchObject({ apply_status: 'applied', apply_reason: 'applied', applied_at: expect.anything() });
    expect(insert.id).toBeTruthy();
  });

  test('a day the plan does not accept is planned and logged, never written', async () => {
    // Two stops that cannot save 10 minutes.
    const w = setup({ rows: [row('a', 0.05, 9), row('b', 0.06, 10)] });
    const out = await w.run();
    expect(out.accepted).toBe(0);
    expect(w.rebooker.reschedule).not.toHaveBeenCalled();
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
      depsOver: { now: () => { calls += 1; if (calls === 1) w.db.rows[1].updated_at = new Date('2026-11-03T12:30:00Z'); return NOW; } },
    });
    const out = await w.run();
    expect(out.apply).toEqual([expect.objectContaining({ status: 'skipped', reason: 'changed_since_plan', moved: 0 })]);
    expect(w.rebooker.reschedule).not.toHaveBeenCalled();
    expect(w.db.updates[0].patch).toEqual({ apply_status: 'skipped', apply_reason: 'changed_since_plan' });
  });

  test('a failed write rolls the day back and the plan row says rolled_back', async () => {
    let n = 0;
    const w = setup({ rows: zigzagRows(), rebookerOpts: { failWhen: () => { n += 1; return n === 2; } } });
    const before = w.windows();
    const out = await w.run();
    expect(out.apply[0]).toMatchObject({ status: 'rolled_back', moved: 0 });
    expect(w.windows()).toEqual(before);
    expect(w.db.updates.find((u) => u.table === 'day_replan_plans').patch).toMatchObject({ apply_status: 'rolled_back' });
    expect(out.appliedVisits).toBe(0);
  });

  test('a rollback that fails is recorded as failed with one notice for Claude', async () => {
    let n = 0;
    const w = setup({ rows: zigzagRows(), rebookerOpts: { failWhen: () => { n += 1; return n >= 2; } } });
    const out = await w.run();
    expect(out.apply[0].status).toBe('failed');
    expect(out.status).toBe('completed_with_errors');
    expect(w.raiseAlert).toHaveBeenCalledTimes(1);
    expect(w.db.updates.find((u) => u.table === 'day_replan_plans').patch).toMatchObject({ apply_status: 'failed' });
  });

  test('an unexpected error in the writer is recorded, never thrown out of the run', async () => {
    // A staff-locked fifth visit stays put, so the writer reads its hours (and the injected fault fires).
    const w = setup({ rows: [...zigzagRows(), row('e', 0.04, 14, { auto_dispatch_locked: true })], depsOver: { rowHours: () => { throw new Error('boom'); } } });
    const out = await w.run();
    // A day the writer could not restore shows in the job's health, too.
    expect(out.status).toBe('completed_with_errors');
    expect(out.apply[0]).toMatchObject({ status: 'failed' });
  });
});
