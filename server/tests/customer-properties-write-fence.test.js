// recordCallProperty customer-lock fence (#3391 GitHub round P1): the
// click-to-estimate mint's single-premises proof reads customer_properties
// under the CTA writer's customer row lock — property creation must take the
// SAME lock so its evidence lands wholly before or wholly after any
// in-flight mint. The 23505 retry branches run in savepoints (nested trx) so
// a failed insert never poisons the fence transaction.
// Fixture identities are INVENTED (never copied from live payloads).

jest.mock('../models/db', () => {
  const state = { ops: [], failFirstPrimaryInsert: false, claimRow: { id: 'call-1' } };
  const builderFor = (table, runner) => {
    const b = { _table: table };
    for (const m of ['where', 'andWhere', 'whereNull', 'orWhere']) b[m] = jest.fn(() => b);
    b.forUpdate = jest.fn(() => { state.ops.push({ op: 'lock', table }); return b; });
    b.first = jest.fn(async () => {
      state.ops.push({ op: 'first', table });
      if (table === 'call_log') return state.claimRow;
      return { id: 'cust-77' };
    });
    b.then = (resolve, reject) => {
      state.ops.push({ op: 'select', table });
      return Promise.resolve([]).then(resolve, reject);
    };
    b.update = jest.fn(async () => { state.ops.push({ op: 'update', table }); return 1; });
    b.insert = jest.fn((row) => ({
      returning: async () => {
        state.ops.push({ op: 'insert', table, isPrimary: row.is_primary, runner });
        if (state.failFirstPrimaryInsert && row.is_primary) {
          state.failFirstPrimaryInsert = false;
          const err = new Error('duplicate key');
          err.code = '23505';
          err.constraint = 'customer_properties_one_primary';
          throw err;
        }
        return [{ id: 'prop-1' }];
      },
    }));
    return b;
  };
  const makeRunner = (label) => {
    const runner = jest.fn((table) => builderFor(table, label));
    runner.transaction = jest.fn(async (cb) => {
      state.ops.push({ op: 'txn-begin', label });
      const child = makeRunner(`${label}>sp`);
      const result = await cb(child);
      state.ops.push({ op: 'txn-end', label });
      return result;
    });
    return runner;
  };
  const mockDb = makeRunner('root');
  mockDb._state = state;
  return mockDb;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const { recordCallProperty } = require('../services/customer-properties');

beforeEach(() => {
  db._state.ops.length = 0;
  db._state.failFirstPrimaryInsert = false;
  db._state.claimRow = { id: 'call-1' };
});

describe('recordCallProperty customer-lock fence', () => {
  test('runs in a transaction that locks the customers row BEFORE reading or writing properties', async () => {
    const out = await recordCallProperty({
      customerId: 'cust-77', address_line1: '44 Invented Loop', city: 'Parrish', zip: '34219',
    });
    expect(out.created).toBe(true);
    const ops = db._state.ops;
    const lockIdx = ops.findIndex((o) => o.op === 'lock' && o.table === 'customers');
    const readIdx = ops.findIndex((o) => o.op === 'select' && o.table === 'customer_properties');
    const insertIdx = ops.findIndex((o) => o.op === 'insert' && o.table === 'customer_properties');
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(readIdx).toBeGreaterThan(lockIdx);
    expect(insertIdx).toBeGreaterThan(lockIdx);
    // The whole flow is transactional (fence), and inserts run in a NESTED
    // transaction (savepoint), never bare against the outer one.
    expect(ops.some((o) => o.op === 'txn-begin' && o.label === 'root')).toBe(true);
    expect(ops.find((o) => o.op === 'insert').runner).toMatch(/>sp$/);
  });

  // Processing-claim fence (#3418 r16): a call-pipeline caller conditions
  // the durable insert on the LIVE claim, atomically — FOR UPDATE on the
  // call_log row inside the same fence transaction.
  test('claimFence: a lost processing claim aborts BEFORE any property read or write', async () => {
    db._state.claimRow = null; // reclaim rotated the token
    const out = await recordCallProperty({
      customerId: 'cust-77', address_line1: '44 Invented Loop', city: 'Parrish', zip: '34219',
      claimFence: { callLogId: 'call-1', procToken: 'tok-a' },
    });
    expect(out).toMatchObject({ created: false, propertyId: null, claimLost: true });
    const ops = db._state.ops;
    expect(ops.some((o) => o.op === 'insert')).toBe(false);
    expect(ops.some((o) => o.op === 'select' && o.table === 'customer_properties')).toBe(false);
    // The claim check LOCKS the call_log row (atomic with the fence trx),
    // and runs after the customers lock (customers → call_log order).
    const custLock = ops.findIndex((o) => o.op === 'lock' && o.table === 'customers');
    const callLock = ops.findIndex((o) => o.op === 'lock' && o.table === 'call_log');
    expect(callLock).toBeGreaterThan(custLock);
  });

  test('claimFence: a held claim locks the call_log row and proceeds to insert', async () => {
    const out = await recordCallProperty({
      customerId: 'cust-77', address_line1: '44 Invented Loop', city: 'Parrish', zip: '34219',
      claimFence: { callLogId: 'call-1', procToken: 'tok-a' },
    });
    expect(out.created).toBe(true);
    expect(out.claimLost).toBeUndefined();
    const ops = db._state.ops;
    expect(ops.some((o) => o.op === 'lock' && o.table === 'call_log')).toBe(true);
    expect(ops.some((o) => o.op === 'insert' && o.table === 'customer_properties')).toBe(true);
  });

  test('losing the one-primary race retries as secondary inside a fresh savepoint — the fence transaction survives the 23505', async () => {
    db._state.failFirstPrimaryInsert = true;
    const out = await recordCallProperty({
      customerId: 'cust-77', address_line1: '44 Invented Loop', city: 'Parrish', zip: '34219',
    });
    expect(out.created).toBe(true);
    const inserts = db._state.ops.filter((o) => o.op === 'insert');
    expect(inserts).toHaveLength(2);
    expect(inserts[0].isPrimary).toBe(true);
    expect(inserts[1].isPrimary).toBe(false);
    // Both attempts ran in savepoints; the outer fence txn completed.
    expect(inserts.every((o) => o.runner.endsWith('>sp'))).toBe(true);
    expect(db._state.ops.some((o) => o.op === 'txn-end' && o.label === 'root')).toBe(true);
  });
});
