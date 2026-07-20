/**
 * P1-9 (07-19 admin audit): /api/health always returned 200 without checking
 * the database, so a dead-DB instance still looked healthy (the process-level
 * uncaughtException handler is a deliberate no-exit). isDatabaseReady is the
 * readiness ping — false whenever the SELECT 1 errors or times out.
 */

const { isDatabaseReady } = require('../utils/db-health');

function fakeDb(rawImpl) {
  return { raw: () => ({ timeout: () => rawImpl() }) };
}

describe('isDatabaseReady', () => {
  test('true when SELECT 1 resolves', async () => {
    const db = fakeDb(() => Promise.resolve({ rows: [{ '?column?': 1 }] }));
    await expect(isDatabaseReady(db)).resolves.toBe(true);
  });

  test('false when the query rejects (DB down)', async () => {
    const db = fakeDb(() => Promise.reject(new Error('ECONNREFUSED')));
    await expect(isDatabaseReady(db)).resolves.toBe(false);
  });

  test('false when the query times out', async () => {
    const db = fakeDb(() => Promise.reject(new Error('Defined query timeout')));
    await expect(isDatabaseReady(db)).resolves.toBe(false);
  });

  test('false (bounded) when the pool hangs and the query never resolves', async () => {
    // Simulates a saturated pool: knex .timeout() never fires because no
    // connection is acquired. The outer deadline must still bound the probe.
    const db = fakeDb(() => new Promise(() => {}));
    await expect(isDatabaseReady(db, 20)).resolves.toBe(false);
  });
});
