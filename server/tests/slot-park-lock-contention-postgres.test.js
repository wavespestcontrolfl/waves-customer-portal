/**
 * The reserve / extend park recheck against REAL Postgres (B18 re-cut): a FOR SHARE NOWAIT that hits a row another
 * connection holds raises 55P03 and ABORTS the whole transaction (waves-db 5b) - a mocked rejection cannot show
 * that, because a fake connection has no transaction semantics. This suite drives the route's real
 * lockedContactReviewRefusal against two real connections:
 *   - a second connection holds the matched customer row FOR UPDATE;
 *   - the locked read runs in a SAVEPOINT, so the 55P03 rolls back only the savepoint and the reservation
 *     transaction is still usable (no 25P02) - extend skips and carries on, reserve gets its retryable refusal;
 *   - without contention the savepoint is RELEASED and the share lock is kept to the outer commit.
 * It commits two synthetic customer rows (a second connection cannot see an uncommitted one) and deletes them in
 * `finally`, so it only runs against a disposable database (same gate as the repo's other Postgres suites).
 *
 * Run:
 *   SLOT_PARK_LOCK_TEST_DATABASE_URL=postgres://localhost/waves_qa_… \
 *     npm exec jest -- --runInBand server/tests/slot-park-lock-contention-postgres.test.js
 */

jest.mock('../models/db', () => new Proxy((...args) => mockPg(...args), {
  get: (_, key) => (typeof mockPg[key] === 'function' ? mockPg[key].bind(mockPg) : mockPg[key]),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const knex = require('knex');
const { randomUUID } = require('node:crypto');

const connection = process.env.SLOT_PARK_LOCK_TEST_DATABASE_URL;
const isolatedTarget = (() => {
  if (!connection) return false;
  let url;
  try { url = new URL(connection); } catch { return false; }
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  const localCI = process.env.CI === 'true' && local && url.pathname === '/waves_test';
  const qaName = /^\/waves_qa_[a-z0-9]+$/i.test(url.pathname);
  return localCI || (local && qaName);
})();
if (connection && !isolatedTarget) {
  throw new Error('SLOT_PARK_LOCK_TEST_DATABASE_URL must point at a disposable localhost waves_qa_* database or localhost waves_test with CI=true - this suite commits and deletes synthetic customer rows.');
}
const postgres = isolatedTarget ? describe : describe.skip;
let mockPg;
jest.setTimeout(120000);

const { _internals } = require('../routes/estimate-slots-public');
const { lockedContactReviewRefusal } = _internals;

postgres('reserve / extend park recheck: FOR SHARE NOWAIT contention (real Postgres)', () => {
  let pool;
  let customerId;
  let phone;
  let estimateRow;
  const cleanups = [];

  beforeAll(() => { pool = knex({ client: 'pg', connection, pool: { min: 0, max: 6 } }); mockPg = pool; });
  afterAll(async () => { await pool.destroy(); });

  beforeEach(async () => {
    // A unique synthetic ten-digit phone per test; the candidate AGREES with the estimate on email, so the recheck's
    // verdict is "not parked" (null) whenever it can read the row, and the savepoint behavior is what is under test.
    phone = `+1941555${String(Math.floor(1000 + Math.random() * 8999))}`;
    customerId = randomUUID();
    await pool('customers').insert({
      id: customerId, first_name: 'Synthetic', last_name: 'ParkLock', email: 'agree@example.invalid',
      phone, address_line1: '1 Test Way', city: 'Parrish', zip: '34219',
    });
    estimateRow = {
      id: randomUUID(), customer_id: null, customer_name: 'Synthetic ParkLock', customer_phone: phone,
      customer_email: 'agree@example.invalid', address: '1 Test Way, Parrish, FL 34219', estimate_data: {},
    };
    cleanups.push(() => pool('customers').where({ id: customerId }).del());
  });
  afterEach(async () => { while (cleanups.length) await cleanups.pop()().catch(() => {}); });

  const holdRowForUpdate = async () => {
    const locker = await pool.transaction();
    await locker('customers').where({ id: customerId }).forUpdate().first('id');
    return locker;
  };

  test('negative control: a bare FOR SHARE NOWAIT under contention aborts the transaction - the next statement fails 25P02', async () => {
    const locker = await holdRowForUpdate();
    const reserveTrx = await pool.transaction();
    try {
      await expect(reserveTrx('customers').where({ id: customerId }).forShare().noWait().first('id')).rejects.toMatchObject({ code: '55P03' });
      await expect(reserveTrx.raw('SELECT 1')).rejects.toMatchObject({ code: '25P02' });
    } finally {
      await reserveTrx.rollback().catch(() => {});
      await locker.rollback();
    }
  });

  test('EXTEND (skipOnBusy): a customer row another connection holds FOR UPDATE does not fail the extension - null, and the SAME transaction still works', async () => {
    const locker = await holdRowForUpdate();
    const reserveTrx = await pool.transaction();
    try {
      await expect(lockedContactReviewRefusal(estimateRow, reserveTrx, { skipOnBusy: true })).resolves.toBeNull();
      // The statement extendReservation runs next: no 25P02.
      await expect(reserveTrx.raw('SELECT 1 AS ok')).resolves.toMatchObject({ rows: [{ ok: 1 }] });
      await reserveTrx.commit();
    } finally {
      await reserveTrx.rollback().catch(() => {});
      await locker.rollback();
    }
  });

  test('RESERVE: the retryable refusal (CUSTOMER_BUSY_RETRY), and the reservation transaction is still usable and commits cleanly', async () => {
    const locker = await holdRowForUpdate();
    const reserveTrx = await pool.transaction();
    try {
      const refusal = await lockedContactReviewRefusal(estimateRow, reserveTrx);
      expect(refusal).toMatchObject({ status: 409, body: { code: 'CUSTOMER_BUSY_RETRY' } });
      await expect(reserveTrx('customers').where({ id: customerId }).count({ n: '*' }).first()).resolves.toBeTruthy();
      await reserveTrx.commit();
    } finally {
      await reserveTrx.rollback().catch(() => {});
      await locker.rollback();
    }
  });

  test('no contention: the savepoint is RELEASED and the share lock is KEPT to the outer commit (a writer waits until then)', async () => {
    const reserveTrx = await pool.transaction();
    try {
      await expect(lockedContactReviewRefusal(estimateRow, reserveTrx)).resolves.toBeNull();
      // Another connection cannot take the row FOR UPDATE while the reservation transaction holds its share lock.
      const writer = await pool.transaction();
      try {
        await expect(writer('customers').where({ id: customerId }).forUpdate().noWait().first('id')).rejects.toMatchObject({ code: '55P03' });
      } finally {
        await writer.rollback().catch(() => {});
      }
      await reserveTrx.commit();
      const after = await pool.transaction();
      try {
        await expect(after('customers').where({ id: customerId }).forUpdate().noWait().first('id')).resolves.toMatchObject({ id: customerId });
      } finally {
        await after.rollback();
      }
    } finally {
      await reserveTrx.rollback().catch(() => {});
    }
  });
});
