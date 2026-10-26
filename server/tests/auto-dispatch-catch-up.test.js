/**
 * 5:00 AM auto-dispatch catch-up (GATE_AUTO_DISPATCH_CATCH_UP, owner 2026-10-26).
 * The 04:10 run is cut off by a deploy restart (2026-09-03, 2026-10-26); the
 * catch-up settles the dead cron row and runs the night tool once more.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { needsCatchUp, settleDeadCronRuns, runCatchUp } = require('../services/auto-dispatch/catch-up');

// 2026-10-26 09:00Z = 05:00 EDT. ET day = 2026-10-26 04:00Z .. 2026-10-27 04:00Z.
const NOW = new Date('2026-10-26T09:00:00Z');

// In-memory auto_dispatch_runs: understands the where/whereIn/update calls
// catch-up.js makes and nothing else.
function fakeDb(rows) {
  const state = { rows: rows.map((r) => ({ ...r })), queries: [] };
  const db = jest.fn((table) => {
    const filters = [];
    const api = {
      where(...args) {
        if (args.length === 1 && typeof args[0] === 'object') {
          const o = args[0];
          filters.push((r) => Object.keys(o).every((k) => r[k] === o[k]));
        } else {
          const [col, op, val] = args;
          filters.push((r) => (op === '>=' ? r[col] >= val : r[col] < val));
        }
        return api;
      },
      whereIn(col, vals) { filters.push((r) => vals.includes(r[col])); return api; },
      select() {
        state.queries.push({ table, kind: 'select' });
        return Promise.resolve(state.rows.filter((r) => filters.every((f) => f(r))).map((r) => ({ triggered_by: r.triggered_by, status: r.status })));
      },
      update(patch) {
        state.queries.push({ table, kind: 'update', patch });
        const hit = state.rows.filter((r) => filters.every((f) => f(r)));
        hit.forEach((r) => Object.assign(r, patch));
        return Promise.resolve(hit.length);
      },
    };
    return api;
  });
  db.fn = { now: () => 'NOW()' };
  db.state = state;
  return db;
}

const todayRow = (triggered_by, status, extra = {}) => ({ triggered_by, status, started_at: new Date('2026-10-26T08:10:59Z'), ...extra });

describe('needsCatchUp decision table', () => {
  test('cron run completed today: not needed', async () => {
    const r = await needsCatchUp(fakeDb([todayRow('cron', 'completed')]), NOW);
    expect(r.needed).toBe(false);
    expect(r.reason).toMatch(/already finished \(completed\)/);
  });

  test('cron run completed_with_errors today: not needed', async () => {
    const r = await needsCatchUp(fakeDb([todayRow('cron', 'completed_with_errors')]), NOW);
    expect(r.needed).toBe(false);
  });

  test('cron run still marked running: needed, reason names the cut-off', async () => {
    const r = await needsCatchUp(fakeDb([todayRow('cron', 'running')]), NOW);
    expect(r.needed).toBe(true);
    expect(r.reason).toMatch(/cut off \(still marked running\)/);
  });

  test('cron run failed: needed', async () => {
    const r = await needsCatchUp(fakeDb([todayRow('cron', 'failed')]), NOW);
    expect(r.needed).toBe(true);
    expect(r.reason).toMatch(/failed/);
  });

  test('no run today: needed', async () => {
    const r = await needsCatchUp(fakeDb([]), NOW);
    expect(r).toEqual({ needed: true, reason: 'no night run started on 2026-10-26' });
  });

  test('a run from yesterday does not count (ET day boundary)', async () => {
    // 2026-10-26 03:30Z is 23:30 EDT on 10-25.
    const r = await needsCatchUp(fakeDb([todayRow('cron', 'completed', { started_at: new Date('2026-10-26T03:30:00Z') })]), NOW);
    expect(r.needed).toBe(true);
  });

  test('a catch_up row today, whatever its status: not needed (one catch-up a day)', async () => {
    for (const status of ['running', 'failed', 'completed', 'completed_with_errors']) {
      const r = await needsCatchUp(fakeDb([todayRow('cron', 'failed'), todayRow('catch_up', status)]), NOW);
      expect(r.needed).toBe(false);
      expect(r.reason).toMatch(/catch-up run already started/);
    }
  });

  test('a manual run never counts as the night run', async () => {
    const r = await needsCatchUp(fakeDb([todayRow('manual', 'completed')]), NOW);
    expect(r.needed).toBe(true);
  });

  test('a completed cron run is enough even when an earlier cron row failed', async () => {
    const r = await needsCatchUp(fakeDb([todayRow('cron', 'failed'), todayRow('cron', 'completed')]), NOW);
    expect(r.needed).toBe(false);
  });
});

describe('settleDeadCronRuns', () => {
  test('settles running cron rows and leaves every other row alone', async () => {
    const db = fakeDb([
      todayRow('cron', 'running', { id: 'dead' }),
      todayRow('manual', 'running', { id: 'manual-run' }),
      todayRow('catch_up', 'running', { id: 'catch-up-run' }),
      todayRow('cron', 'completed', { id: 'done' }),
    ]);
    const n = await settleDeadCronRuns(db, NOW);
    expect(n).toBe(1);
    const byId = Object.fromEntries(db.state.rows.map((r) => [r.id, r]));
    expect(byId.dead.status).toBe('failed');
    expect(byId.dead.completed_at).toBe('NOW()');
    expect(byId.dead.updated_at).toBe('NOW()');
    expect(byId.dead.error_message).toMatch(/process exited mid-run \(settled by the 5:00 AM catch-up while it held the run lock\)/);
    expect(byId['manual-run'].status).toBe('running');
    expect(byId['catch-up-run'].status).toBe('running');
    expect(byId.done.status).toBe('completed');
  });
});

describe('runCatchUp', () => {
  test('cut-off 04:10 run: settles it, then runs the night tool as catch_up', async () => {
    const db = fakeDb([todayRow('cron', 'running', { id: 'dead' })]);
    const runAutoDispatch = jest.fn(async () => ({ runId: 'run-2', status: 'completed' }));
    const out = await runCatchUp({ nowDate: NOW, db, runAutoDispatch });
    expect(db.state.rows[0].status).toBe('failed');
    expect(runAutoDispatch).toHaveBeenCalledWith({ triggeredBy: 'catch_up' });
    expect(out).toMatchObject({ ran: true, settled: 1, result: { runId: 'run-2' } });
    expect(out.reason).toMatch(/failed/); // the row was settled to failed before the decision
  });

  test('night run already completed: no run', async () => {
    const db = fakeDb([todayRow('cron', 'completed')]);
    const runAutoDispatch = jest.fn();
    const out = await runCatchUp({ nowDate: NOW, db, runAutoDispatch });
    expect(runAutoDispatch).not.toHaveBeenCalled();
    expect(out).toMatchObject({ ran: false, settled: 0 });
  });

  test('no row at all (job never fired): runs', async () => {
    const runAutoDispatch = jest.fn(async () => ({ runId: 'run-3', status: 'completed' }));
    const out = await runCatchUp({ nowDate: NOW, db: fakeDb([]), runAutoDispatch });
    expect(out.ran).toBe(true);
    expect(runAutoDispatch).toHaveBeenCalledTimes(1);
  });

  test('a catch-up already ran today: no second run', async () => {
    const runAutoDispatch = jest.fn();
    const out = await runCatchUp({ nowDate: NOW, db: fakeDb([todayRow('cron', 'failed'), todayRow('catch_up', 'failed')]), runAutoDispatch });
    expect(out.ran).toBe(false);
    expect(runAutoDispatch).not.toHaveBeenCalled();
  });
});
