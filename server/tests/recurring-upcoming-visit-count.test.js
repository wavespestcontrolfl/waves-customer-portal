/**
 * Recurring series upcoming-visit counter — pending AND confirmed.
 *
 * Portal-confirm and the reschedule flows flip visits pending→confirmed.
 * The auto-extend / plan-ending / convert-ongoing counters used to count
 * only status='pending', so a plan whose remaining visits the customer had
 * confirmed read as empty:
 *   - ongoing plans auto-extended on every completion → extra billable
 *     visits beyond the intended 2-ahead window
 *   - fixed plans raised a false plan_ending alert → operator extends →
 *     customer billed past the plan they purchased
 *   - convert-ongoing topped the series up with duplicate (billable) visits
 *
 * All three sites now share countUpcomingSeriesVisits.
 */
const adminScheduleRouter = require('../routes/admin-schedule');

const { countUpcomingSeriesVisits } = adminScheduleRouter._test;

function fakeConn(countValue) {
  const calls = [];
  const chain = {
    where(...args) {
      if (typeof args[0] === 'function') {
        const nested = [];
        const sub = {
          where(...a) { nested.push(['where', ...a]); return sub; },
          orWhere(...a) { nested.push(['orWhere', ...a]); return sub; },
        };
        args[0].call(sub, sub);
        calls.push(['where', 'fn', nested]);
      } else {
        calls.push(['where', ...args]);
      }
      return chain;
    },
    whereIn(...args) { calls.push(['whereIn', ...args]); return chain; },
    count(...args) { calls.push(['count', ...args]); return chain; },
    first: async () => (countValue === undefined ? undefined : { c: countValue }),
  };
  const conn = (table) => { calls.push(['table', table]); return chain; };
  conn.calls = calls;
  return conn;
}

describe('countUpcomingSeriesVisits', () => {
  test('counts pending AND confirmed base-series rows', async () => {
    const conn = fakeConn('3');
    const count = await countUpcomingSeriesVisits(conn, 'parent-1');

    expect(count).toBe(3);
    expect(conn.calls).toContainEqual(['table', 'scheduled_services']);
    expect(conn.calls).toContainEqual(['whereIn', 'status', ['pending', 'confirmed']]);
    // Boosters excluded: base series only.
    expect(conn.calls).toContainEqual(['where', 'is_recurring', true]);
    // Stale rows whose date passed without completing are not "ahead" —
    // they must not suppress auto-extends or plan-ending alerts.
    const dateCutoff = conn.calls.find(([n, col, op]) => n === 'where' && col === 'scheduled_date' && op === '>=');
    expect(dateCutoff).toBeDefined();
    expect(dateCutoff[3]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Parent row + children scoped to the series.
    const scoped = conn.calls.find(([n, kind]) => n === 'where' && kind === 'fn');
    expect(scoped[2]).toContainEqual(['where', 'recurring_parent_id', 'parent-1']);
    expect(scoped[2]).toContainEqual(['orWhere', 'id', 'parent-1']);
  });

  test('returns 0 when the count row is missing', async () => {
    const conn = fakeConn(undefined);
    await expect(countUpcomingSeriesVisits(conn, 'parent-1')).resolves.toBe(0);
  });

  test('parses string counts from pg', async () => {
    const conn = fakeConn('0');
    await expect(countUpcomingSeriesVisits(conn, 'parent-1')).resolves.toBe(0);
  });
});
