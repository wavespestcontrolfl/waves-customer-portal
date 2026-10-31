jest.mock('../models/db', () => jest.fn());

const { summarizeRouteEngine, buildRouteEngineSummary } = require('../services/scheduling/route-engine-summary');

// 04:10 ET runs. 2026-10-31 is EDT (UTC-4), so 08:10Z is 04:10 ET.
const at = (date, hhmm = '08:10') => `${date}T${hhmm}:00.000Z`;
const run = (id, date, status, config = { maxChangesPerRun: 10 }) => ({ id, started_at: at(date), status, config_snapshot: config });
const changed = (runId, svc, saved, created) => ({
  auto_dispatch_run_id: runId, scheduled_service_id: svc, action: 'changed', reason_code: null,
  route_metrics_snapshot: saved === undefined ? {} : { drive_saving_minutes: saved }, created_at: created,
});
const held = (runId, svc, created) => ({
  auto_dispatch_run_id: runId, scheduled_service_id: svc, action: 'recommended', reason_code: 'MAX_CHANGES_REACHED',
  route_metrics_snapshot: { drive_saving_minutes: 99 }, created_at: created,
});

describe('summarizeRouteEngine', () => {
  const today = '2026-10-31';

  test('classifies finished, with_errors, failed and no_run nights, oldest first', () => {
    const out = summarizeRouteEngine({
      today, nights: 5,
      runs: [
        run('a', '2026-10-27', 'completed'),
        run('b', '2026-10-28', 'completed_with_errors'),
        run('c', '2026-10-29', 'failed'),
        run('d', '2026-10-31', 'failed'),
        { ...run('e', '2026-10-31', 'completed'), started_at: at('2026-10-31', '09:05') },
      ],
      rows: [],
    });
    expect(out.nights.map((n) => [n.date, n.status])).toEqual([
      ['2026-10-27', 'finished'], ['2026-10-28', 'with_errors'], ['2026-10-29', 'failed'],
      ['2026-10-30', 'no_run'], ['2026-10-31', 'finished'],
    ]);
    expect(out.totals).toMatchObject({ finishedNights: 2, withErrorsNights: 1, failedNights: 1, noRunNights: 1 });
    expect(out.windowNights).toBe(5);
  });

  test('a finished catch-up beats an earlier failed cron run the same night', () => {
    const out = summarizeRouteEngine({ today, nights: 1, runs: [run('a', '2026-10-31', 'failed'), run('b', '2026-10-31', 'completed')], rows: [] });
    expect(out.nights[0].status).toBe('finished');
  });

  test('ignores runs outside the window', () => {
    const out = summarizeRouteEngine({ today, nights: 2, runs: [run('a', '2026-10-20', 'completed')], rows: [changed('a', 's1', 5, at('2026-10-20'))] });
    expect(out.totals.finishedNights).toBe(0);
    expect(out.totals.movesMade).toBe(0);
    expect(out.cap).toBeNull();
  });

  test('counts moves, distinct held visits and held visits that moved later', () => {
    const out = summarizeRouteEngine({
      today, nights: 3,
      runs: [run('a', '2026-10-29', 'completed'), run('b', '2026-10-30', 'completed'), run('c', '2026-10-31', 'completed')],
      rows: [
        held('a', 's1', at('2026-10-29')), held('a', 's2', at('2026-10-29')), held('a', 's3', at('2026-10-29')),
        held('b', 's1', at('2026-10-30')), // s1 held twice: still one visit
        changed('b', 's2', 30, at('2026-10-30', '08:20')), // s2 moved later
        changed('c', 's1', 20.4, at('2026-10-31', '08:20')), // s1 moved later
        changed('a', 's9', 10, at('2026-10-29', '08:15')), // moved before any hold of its own
        held('c', 's9', at('2026-10-31', '08:30')), // held after it moved: not "held then moved"
      ],
    });
    expect(out.nights.map((n) => [n.movesMade, n.held])).toEqual([[1, 3], [1, 1], [1, 1]]);
    expect(out.totals).toMatchObject({ movesMade: 3, heldVisits: 4, heldThenMoved: 2, estDriveMinutesSaved: 60 });
  });

  test('estimated minutes: a net sum (a move that adds driving subtracts), missing numbers give null', () => {
    const base = { today, nights: 1, runs: [run('a', '2026-10-31', 'completed')] };
    const some = summarizeRouteEngine({ ...base, rows: [changed('a', 's1', -5, at('2026-10-31')), changed('a', 's2', 12, at('2026-10-31'))] });
    expect(some.totals.estDriveMinutesSaved).toBe(7);
    const none = summarizeRouteEngine({ ...base, rows: [changed('a', 's1', undefined, at('2026-10-31'))] });
    expect(none.totals.movesMade).toBe(1);
    expect(none.totals.estDriveMinutesSaved).toBeNull();
    const text = summarizeRouteEngine({ ...base, rows: [{ ...changed('a', 's1', 0, at('2026-10-31')), route_metrics_snapshot: '{"drive_saving_minutes":"7"}' }] });
    expect(text.totals.estDriveMinutesSaved).toBe(7);
  });

  test('cap comes from the latest run config_snapshot.maxChangesPerRun, null when absent', () => {
    const runs = [run('a', '2026-10-30', 'completed', { maxChangesPerRun: 5 }), run('b', '2026-10-31', 'completed', { maxChangesPerRun: 10 })];
    expect(summarizeRouteEngine({ today, nights: 2, runs, rows: [] }).cap).toBe(10);
    expect(summarizeRouteEngine({ today, nights: 2, runs: [run('a', '2026-10-31', 'completed', {})], rows: [] }).cap).toBeNull();
    expect(summarizeRouteEngine({ today, nights: 2, runs: [run('a', '2026-10-31', 'completed', null)], rows: [] }).cap).toBeNull();
    expect(summarizeRouteEngine({ today, nights: 2, runs: [run('a', '2026-10-31', 'completed', '{"maxChangesPerRun":8}')], rows: [] }).cap).toBe(8);
  });

  test('a run still in progress reads as running, never failed', () => {
    const out = summarizeRouteEngine({
      today, nights: 3,
      runs: [
        run('a', '2026-10-29', 'running'),
        run('b', '2026-10-30', 'failed'),
        { ...run('c', '2026-10-30', 'running'), started_at: at('2026-10-30', '09:05') },
        run('d', '2026-10-31', 'completed'),
        { ...run('e', '2026-10-31', 'running'), started_at: at('2026-10-31', '09:05') },
      ],
      rows: [],
    });
    expect(out.nights.map((n) => n.status)).toEqual(['running', 'running', 'finished']);
    expect(out.totals).toMatchObject({ runningNights: 2, failedNights: 0, finishedNights: 1 });
  });

  test('held then moved counts only a move on a LATER ET night', () => {
    const out = summarizeRouteEngine({
      today, nights: 3,
      runs: [
        run('a', '2026-10-29', 'completed'),
        run('b', '2026-10-30', 'failed'),
        { ...run('c', '2026-10-30', 'completed'), started_at: at('2026-10-30', '09:05') },
      ],
      rows: [
        held('a', 's1', at('2026-10-29', '08:12')), changed('c', 's1', 4, at('2026-10-30', '09:07')),
        held('b', 's2', at('2026-10-30', '08:12')), changed('c', 's2', 4, at('2026-10-30', '09:07')),
      ],
    });
    expect(out.totals).toMatchObject({ heldVisits: 2, heldThenMoved: 1, movesMade: 2 });
  });
});

describe('buildRouteEngineSummary', () => {
  function fakeConn(runs, rows) {
    const calls = [];
    const conn = (table) => {
      const q = {
        whereIn: (...a) => { calls.push([table, 'whereIn', ...a]); return q; },
        where: (...a) => { calls.push([table, 'where', ...a]); return q; },
        select: () => Promise.resolve(table === 'auto_dispatch_runs' ? runs : rows),
      };
      return q;
    };
    conn.calls = calls;
    return conn;
  }

  test('reads night runs only and summarizes them', async () => {
    const conn = fakeConn([run('a', '2026-10-31', 'completed')], [changed('a', 's1', 15, at('2026-10-31'))]);
    const out = await buildRouteEngineSummary(conn, { nights: 2, now: new Date('2026-10-31T16:00:00Z') });
    expect(conn.calls[0]).toEqual(['auto_dispatch_runs', 'whereIn', 'triggered_by', ['cron', 'catch_up']]);
    expect(out.nights.map((n) => n.date)).toEqual(['2026-10-30', '2026-10-31']);
    expect(out.totals).toMatchObject({ movesMade: 1, estDriveMinutesSaved: 15, finishedNights: 1, noRunNights: 1 });
  });

  test('skips the audit read when no run exists', async () => {
    const conn = fakeConn([], []);
    const out = await buildRouteEngineSummary(conn, { nights: 1, now: new Date('2026-10-31T16:00:00Z') });
    expect(conn.calls.some((c) => c[0] === 'auto_dispatch_audit_logs')).toBe(false);
    expect(out.totals.noRunNights).toBe(1);
  });
});
