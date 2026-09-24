/**
 * executeMerge takes the 'recurring-series-create' advisory locks — the
 * same namespace/keys the series creators (checkActiveSeriesLocked /
 * acquireSeriesCreateLocks in recurring-appointment-seeder.js) take before
 * inserting a new parent — BEFORE its own `customers` row lock (GitHub
 * Codex round-4 P1 #4684).
 *
 * The race this closes: a series creator for the WINNER's identity can
 * pass its own duplicate-series guard while the LOSER still owns the
 * matching series (the creator's guard only ever looks at one customer),
 * then block on this merge's customer row lock, and insert a second live
 * series right after the merge moves the loser's series onto the winner.
 * Taking the creators' own lock namespace first — keyed by BOTH customer
 * ids for every identity either party anchors — means whichever side gets
 * there first (a creator or this merge) runs to completion before the
 * other can proceed.
 *
 * Two levels of test:
 *   1. A direct unit test of the extracted helper, lockSeriesCreateForMerge
 *      (dedupe, sort, both-customer-ids-per-identity, matches
 *      seriesCreateLockKeys exactly).
 *   2. A full executeMerge run (same recording-trx harness style as
 *      customer-dedupe.test.js's "invoice-issued-closeout gate lock" test)
 *      proving the locks land in trx.raw BEFORE the `customers` forUpdate
 *      row lock, in sorted order, for both customer ids.
 */
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.transaction = jest.fn();
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => null) }));
jest.mock('../services/stripe', () => ({
  retrievePaymentIntent: jest.fn(async () => null),
  cancelPaymentIntent: jest.fn(async () => ({})),
}));

const db = require('../models/db');
const dedupe = require('../services/customer-dedupe');
const { seriesCreateLockKeys } = require('../services/recurring-appointment-seeder');
const { resetFkCache } = dedupe._test;

beforeEach(() => {
  jest.clearAllMocks();
  resetFkCache();
});

// ---------------------------------------------------------------------------
// 1. lockSeriesCreateForMerge — the extracted helper, unit tested directly
// ---------------------------------------------------------------------------

describe('lockSeriesCreateForMerge', () => {
  const WINNER = 'cccccccc-0000-0000-0000-000000000001';
  const LOSER = 'cccccccc-0000-0000-0000-000000000002';
  const SVC_A = 'dddddddd-0000-0000-0000-0000000000a1';
  const SVC_B = 'dddddddd-0000-0000-0000-0000000000b2';

  // A minimal recording knex-ish stub: `scheduled_services` resolves
  // `parentRows`, everything else is unreachable (the helper only ever
  // queries that one table).
  function makeLockTrx(parentRows) {
    const rawCalls = [];
    const trx = (table) => {
      expect(table).toBe('scheduled_services');
      const q = {};
      q.whereIn = (...args) => { q._whereIn = args; return q; };
      q.where = (...args) => { q._where = args; return q; };
      q.whereNull = (...args) => { q._whereNull = args; return q; };
      q.select = () => Promise.resolve(parentRows);
      return q;
    };
    trx.raw = jest.fn(async (sql, bindings) => { rawCalls.push(bindings); return null; });
    return { trx, rawCalls };
  }

  test('acquires nothing when neither party anchors a recurring parent', async () => {
    const { trx, rawCalls } = makeLockTrx([]);
    const keys = await dedupe.lockSeriesCreateForMerge(trx, WINNER, LOSER);
    expect(keys).toEqual([]);
    expect(rawCalls).toEqual([]);
  });

  test('locks BOTH customer ids for a family the LOSER alone carries — the winner must be blocked for a family it is about to inherit', async () => {
    const { trx, rawCalls } = makeLockTrx([
      { customer_id: LOSER, service_id: SVC_A, service_type: null },
    ]);
    const keys = await dedupe.lockSeriesCreateForMerge(trx, WINNER, LOSER);
    const expected = [
      seriesCreateLockKeys({ customerId: WINNER, serviceId: SVC_A, serviceType: null })[0],
      seriesCreateLockKeys({ customerId: LOSER, serviceId: SVC_A, serviceType: null })[0],
    ].sort();
    expect(keys).toEqual(expected);
    expect(rawCalls).toEqual(expected.map((k) => ['recurring-series-create', k]));
  });

  test('two distinct identities (one per side) — dedup, sorted-union, both ids per identity, matching seriesCreateLockKeys exactly', async () => {
    const { trx, rawCalls } = makeLockTrx([
      { customer_id: WINNER, service_id: SVC_A, service_type: null },
      { customer_id: LOSER, service_id: SVC_B, service_type: 'Quarterly Pest Control' },
      // A duplicate identity row (e.g. a second cancelled parent under the
      // same family) must not double-acquire the same key.
      { customer_id: LOSER, service_id: SVC_B, service_type: 'Quarterly Pest Control' },
    ]);
    const keys = await dedupe.lockSeriesCreateForMerge(trx, WINNER, LOSER);
    const expected = [...new Set([
      ...seriesCreateLockKeys({ customerId: WINNER, serviceId: SVC_A, serviceType: null }),
      ...seriesCreateLockKeys({ customerId: LOSER, serviceId: SVC_A, serviceType: null }),
      ...seriesCreateLockKeys({ customerId: WINNER, serviceId: SVC_B, serviceType: 'Quarterly Pest Control' }),
      ...seriesCreateLockKeys({ customerId: LOSER, serviceId: SVC_B, serviceType: 'Quarterly Pest Control' }),
    ])].sort();
    expect(keys).toEqual(expected);
    expect(rawCalls.map((b) => b[1])).toEqual(expected);
    // Every acquisition uses the SAME namespace the series creators use.
    for (const bindings of rawCalls) expect(bindings[0]).toBe('recurring-series-create');
  });

  test('any status counts — a cancelled parent still anchors an identity (a creator\'s guard can still match it via cancelledParentStillLive)', async () => {
    const { trx, rawCalls } = makeLockTrx([
      { customer_id: WINNER, service_id: SVC_A, service_type: null, status: 'cancelled' },
    ]);
    const keys = await dedupe.lockSeriesCreateForMerge(trx, WINNER, LOSER);
    expect(keys.length).toBe(2);
    expect(rawCalls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 2. Full executeMerge — proves the call site: acquired before the row lock
// ---------------------------------------------------------------------------

describe('executeMerge — recurring-series-create lock ordering', () => {
  const WINNER = 'eeeeeeee-0000-0000-0000-000000000001';
  const LOSER = 'eeeeeeee-0000-0000-0000-000000000002';
  const SVC_A = 'ffffffff-0000-0000-0000-0000000000a1';
  const SVC_B = 'ffffffff-0000-0000-0000-0000000000b2';

  const FK_ROWS = [
    { table_name: 'leads', column_name: 'customer_id' },
    { table_name: 'call_log', column_name: 'customer_id' },
    { table_name: 'notification_prefs', column_name: 'customer_id' },
  ];

  // Same chainable knex stub as customer-dedupe.test.js's buildTrx, trimmed
  // to what executeMerge touches on a clean happy-path merge, plus event
  // logging (shared array, in call order) for the two things this suite
  // cares about: every trx.raw call, and the `customers` forUpdate row
  // lock — so ordering can be asserted directly instead of inferred from
  // array position alone.
  function buildTrx({ winner, loser, fkRows, recurringParents = [] }) {
    const state = { events: [], propertyRows: [] };
    const route = (table, q) => {
      if (table === 'customers') {
        if (q.called('forUpdate')) {
          if (q.called('first')) {
            const id = q.args('where')?.[0]?.id;
            return [winner, loser].find((row) => row?.id === id) || null;
          }
          state.events.push(['customers_forupdate']);
          return [winner, loser].filter(Boolean);
        }
        if (q.called('increment')) return 1;
        if (q.called('update')) return 1;
        return [];
      }
      if (table === 'customer_properties') return q.called('select') ? [] : [];
      if (table === 'customer_merge_journal') return [{ id: 'j1' }];
      if (table === 'customer_tags') return q.called('select') ? [] : 1;
      if (table === 'referral_promoters' && q.called('first')) return null;
      // The merge's own pre-row-lock identity read: whereIn + whereNull,
      // never .first()/.update().
      if (table === 'scheduled_services' && q.called('whereIn') && q.called('whereNull')
        && !q.called('update') && !q.called('first')) {
        return recurringParents;
      }
      // duplicateSeriesMergeConflict / liveFamilyMatches (post-row-lock,
      // per-customer .where(), never .whereIn()) — kept empty so
      // dbLevelMergeConflict reads no series conflict.
      if ((table === 'scheduled_services' || table === 'invoices') && q.called('first')) return null;
      if (table === 'invoices' && q.called('whereNotNull') && q.called('select')) return [];
      if (table === 'scheduled_services' && q.called('update')) return 0;
      if (q.called('del')) return 1;
      if (q.called('update')) return 1;
      return [];
    };
    const trx = jest.fn((table) => makeChain(table, (q) => route(table, q)));
    trx.raw = jest.fn(async (sql, bindings) => {
      state.events.push(['raw', bindings]);
      return { rows: fkRows };
    });
    trx.transaction = jest.fn(async (fn) => fn(trx));
    trx.fn = { now: () => 'NOW()' };
    trx.isTransaction = true;
    return { trx, state };
  }

  function makeChain(table, route) {
    const q = { _table: table, _calls: [] };
    const methods = [
      'where', 'whereIn', 'whereRaw', 'whereNull', 'whereNotNull', 'whereNotIn', 'whereNot', 'select', 'groupBy',
      'orderBy', 'forUpdate', 'skipLocked', 'update', 'insert', 'del', 'count', 'onConflict',
      'ignore', 'returning', 'first', 'increment', 'limit',
    ];
    for (const m of methods) {
      q[m] = jest.fn((...args) => { q._calls.push([m, args]); return q; });
    }
    q.called = (m) => q._calls.some(([name]) => name === m);
    q.args = (m) => q._calls.find(([name]) => name === m)?.[1];
    q.then = (resolve, reject) => Promise.resolve().then(() => {
      if (table === 'collection_cases') return q.called('first') ? null : [];
      return route(q);
    }).then(resolve, reject);
    return q;
  }

  beforeEach(() => { jest.clearAllMocks(); resetFkCache(); });

  test('acquires no recurring-series-create locks when neither party anchors a recurring parent', async () => {
    const winner = { id: WINNER, first_name: 'Synthetic', last_name: 'Winner', phone: '+19995550101' };
    const loser = { id: LOSER, first_name: 'Synthetic', last_name: null, phone: '9995550101' };
    const { trx } = buildTrx({ winner, loser, fkRows: FK_ROWS, recurringParents: [] });
    db.transaction.mockImplementation((fn) => fn(trx));
    await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });
    const seriesLockCalls = trx.raw.mock.calls.filter(([, bindings]) => bindings?.[0] === 'recurring-series-create');
    expect(seriesLockCalls).toEqual([]);
  });

  test('acquires the recurring-series-create locks for BOTH customer ids, per identity, sorted, BEFORE the customers forUpdate row lock', async () => {
    const winner = { id: WINNER, first_name: 'Synthetic', last_name: 'Winner', phone: '+19995550102' };
    const loser = { id: LOSER, first_name: 'Synthetic', last_name: null, phone: '9995550102' };
    const recurringParents = [
      { customer_id: WINNER, service_id: SVC_A, service_type: null },
      { customer_id: LOSER, service_id: SVC_B, service_type: null },
    ];
    const { trx, state } = buildTrx({ winner, loser, fkRows: FK_ROWS, recurringParents });
    db.transaction.mockImplementation((fn) => fn(trx));
    await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });

    const expectedKeys = [...new Set([
      ...seriesCreateLockKeys({ customerId: WINNER, serviceId: SVC_A, serviceType: null }),
      ...seriesCreateLockKeys({ customerId: LOSER, serviceId: SVC_A, serviceType: null }),
      ...seriesCreateLockKeys({ customerId: WINNER, serviceId: SVC_B, serviceType: null }),
      ...seriesCreateLockKeys({ customerId: LOSER, serviceId: SVC_B, serviceType: null }),
    ])].sort();

    const seriesLockCalls = trx.raw.mock.calls.filter(([, bindings]) => bindings?.[0] === 'recurring-series-create');
    expect(seriesLockCalls.map(([, bindings]) => bindings[1])).toEqual(expectedKeys);

    // Ordering: every 'raw' event carrying the recurring-series-create
    // namespace precedes the single 'customers_forupdate' event (the row
    // lock this file's own comment says every advisory lock must precede).
    const rowLockIdx = state.events.findIndex(([kind]) => kind === 'customers_forupdate');
    expect(rowLockIdx).toBeGreaterThan(-1);
    const seriesLockEventIdxs = state.events
      .map((ev, i) => [ev, i])
      .filter(([[kind, bindings]]) => kind === 'raw' && bindings?.[0] === 'recurring-series-create')
      .map(([, i]) => i);
    expect(seriesLockEventIdxs.length).toBe(expectedKeys.length);
    for (const idx of seriesLockEventIdxs) expect(idx).toBeLessThan(rowLockIdx);
  });
});
