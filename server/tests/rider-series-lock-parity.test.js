/**
 * The rider sync must take the SAME per-parent recurring-series-maintenance
 * advisory lock as every other series writer, or the two stop contending and
 * a rider sync could rewrite a series another writer is mid-way through.
 * rider-series.js keeps its own non-blocking copy (route files are not
 * imported by services), so this pins it to admin-schedule.js's canonical
 * acquireRecurringSeriesMaintenanceLock: same statement, same key.
 */
const { tryLockSeriesMaintenance } = require('../services/rider-series')._internals;
const { acquireRecurringSeriesMaintenanceLock } = require('../routes/admin-schedule')._test;

function recordingConn() {
  const calls = [];
  return {
    calls,
    raw: async (sql, bindings) => {
      calls.push({ sql, bindings });
      return { rows: [{ locked: true }] };
    },
  };
}

describe('rider sync lock parity with the canonical series-maintenance lock', () => {
  test('both take the identical non-blocking statement on the identical key', async () => {
    const parentId = '5d0c2a64-0f4e-4d0b-9a57-2f0e6b1c9a11';
    const canonical = recordingConn();
    const rider = recordingConn();
    await acquireRecurringSeriesMaintenanceLock(canonical, parentId, false);
    await tryLockSeriesMaintenance(rider, parentId);
    expect(canonical.calls).toHaveLength(1);
    expect(rider.calls).toEqual(canonical.calls);
  });
});
