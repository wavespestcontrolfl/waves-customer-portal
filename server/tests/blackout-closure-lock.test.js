/**
 * Closure-state advisory lock (services/scheduling/blackout-dates.js
 * lockClosureState) — serializes the blackout-date / weekly-days-off
 * mutation endpoints against the capacity reservation transaction's
 * closure-state read (codex #4346 P2). Pure unit coverage of the exact
 * lock statement and the transaction-required guard; the real-lock
 * blocking behavior is covered on Postgres in
 * scheduling-capacity-holds-postgres.test.js.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { lockClosureState } = require('../services/scheduling/blackout-dates');

function fakeTrx() {
  const raw = jest.fn().mockResolvedValue(undefined);
  const trx = (...args) => raw(...args);
  trx.raw = raw;
  trx.isTransaction = true;
  return trx;
}

describe('lockClosureState', () => {
  test('rejects a connection that is not a transaction', async () => {
    await expect(lockClosureState(undefined)).rejects.toMatchObject({ code: 'TRANSACTION_REQUIRED' });
    await expect(lockClosureState(null)).rejects.toMatchObject({ code: 'TRANSACTION_REQUIRED' });
    const plainDb = () => {};
    await expect(lockClosureState(plainDb)).rejects.toMatchObject({ code: 'TRANSACTION_REQUIRED' });
  });

  test('default call issues the shared advisory lock with the fixed namespace/key', async () => {
    const trx = fakeTrx();
    await lockClosureState(trx);
    expect(trx.raw).toHaveBeenCalledTimes(1);
    const [sql, bindings] = trx.raw.mock.calls[0];
    expect(sql).toBe('SELECT pg_advisory_xact_lock_shared(hashtext(?), hashtext(?::text))');
    expect(bindings).toEqual(['slot-reserve', 'closure-state']);
  });

  test('exclusive: true issues the exclusive advisory lock with the same namespace/key', async () => {
    const trx = fakeTrx();
    await lockClosureState(trx, { exclusive: true });
    expect(trx.raw).toHaveBeenCalledTimes(1);
    const [sql, bindings] = trx.raw.mock.calls[0];
    expect(sql).toBe('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))');
    expect(bindings).toEqual(['slot-reserve', 'closure-state']);
  });

  test('exclusive: false is equivalent to the default (shared) call', async () => {
    const trx = fakeTrx();
    await lockClosureState(trx, { exclusive: false });
    const [sql] = trx.raw.mock.calls[0];
    expect(sql).toBe('SELECT pg_advisory_xact_lock_shared(hashtext(?), hashtext(?::text))');
  });
});
