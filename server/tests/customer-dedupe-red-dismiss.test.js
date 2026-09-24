/**
 * customer-dedupe red-pair auto-dismiss sweep.
 *
 * Red tier is the detector's own "two different people sharing a phone"
 * verdict, so those pairs can never be merged and would otherwise park in the
 * review queue forever. The sweep records the same "not a duplicate"
 * dismissal an operator would click, attributed 'auto:red-tier'.
 */
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.transaction = jest.fn();
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => null) }));

const db = require('../models/db');
const { notifyAdmin } = require('../services/notification-service');
const dedupe = require('../services/customer-dedupe');
const { resetFkCache } = dedupe._test;

// Same chainable knex stub as customer-dedupe.test.js.
function makeChain(table, route) {
  const q = { _table: table, _calls: [] };
  const methods = [
    'where', 'whereIn', 'whereRaw', 'whereNull', 'whereNotNull', 'whereNotIn', 'whereNot', 'select', 'groupBy',
    'orderBy', 'forUpdate', 'update', 'insert', 'del', 'count', 'sum', 'onConflict',
    'ignore', 'returning', 'first', 'increment', 'decrement', 'limit', 'leftJoin',
  ];
  for (const m of methods) {
    q[m] = jest.fn((...args) => { q._calls.push([m, args]); return q; });
  }
  q.called = (m) => q._calls.some(([name]) => name === m);
  q.args = (m) => q._calls.find(([name]) => name === m)?.[1];
  q.then = (resolve, reject) => Promise.resolve().then(() => route(q)).then(resolve, reject);
  return q;
}

function installDb(router) {
  db.mockImplementation((table) => makeChain(table, (q) => router(table, q)));
}

beforeEach(() => {
  jest.clearAllMocks();
  resetFkCache();
});

describe('runRedPairAutoDismissSweep', () => {
  // Clearly synthetic identities only — never real customer names, phones,
  // or addresses in fixtures.
  const personA = {
    id: 'aaaaaaaa-0000-0000-0000-000000000001',
    first_name: 'Pat', last_name: 'Sampleone', phone: '+15550000001',
    address_line1: '11 Sample Way', zip: '00001',
    pipeline_stage: 'active_customer', created_at: '2026-07-08',
    stripe_customer_id: 'cus_test_a',
  };
  const personB = {
    id: 'aaaaaaaa-0000-0000-0000-000000000003',
    first_name: 'Quinn', last_name: 'Sampletwo', phone: '+15550000001',
    address_line1: '22 Example Ave', zip: '00002',
    pipeline_stage: 'active_customer', created_at: '2026-07-01',
  };
  const shell = {
    id: 'aaaaaaaa-0000-0000-0000-000000000002',
    first_name: 'Pat', last_name: null, phone: '5550000001',
    address_line1: null, zip: null,
    pipeline_stage: 'new_lead', created_at: '2026-07-09',
  };

  function install({ customers, lockedCustomers = null, dismissalsError = false, existingDismissals = [] }) {
    const inserted = [];
    const updated = [];
    const router = (table, q) => {
      if (table === 'customers') {
        // The FOR UPDATE re-read at write time can see different rows than
        // the detection read (that gap is the race the sweep must survive).
        if (q.called('forUpdate')) return lockedCustomers || customers;
        return customers;
      }
      if (table === 'customer_duplicate_dismissals') {
        if (q.called('insert')) {
          inserted.push({ row: q.args('insert')[0], onConflict: q.called('onConflict'), ignored: q.called('ignore') });
          return 1;
        }
        if (q.called('update')) {
          updated.push({ where: q.args('where')[0], patch: q.args('update')[0] });
          return 1;
        }
        if (dismissalsError) throw new Error('relation is unreadable');
        // The under-lock pair read (`.where({a,b}).select('reason')`) sees
        // the rows that landed since the snapshot; the detection read
        // sees the same rows (an undo sentinel is visible to this sweep).
        if (q.called('where')) {
          const w = q.args('where')[0];
          return existingDismissals.filter((d) => d.customer_id_a === w.customer_id_a && d.customer_id_b === w.customer_id_b);
        }
        return existingDismissals;
      }
      return [];
    };
    installDb(router);
    db.transaction.mockImplementation(async (fn) => {
      const trx = jest.fn((table) => makeChain(table, (q) => router(table, q)));
      trx.fn = { now: () => 'NOW' };
      trx.raw = jest.fn(async () => ({ rows: [] }));
      return fn(trx);
    });
    inserted.updated = updated;
    return inserted;
  }

  it('dismisses only red pairs, attributed auto:red-tier, via the idempotent upsert', async () => {
    // personA+personB = red (different last names, different addresses on a
    // shared phone); the shell pair is yellow (identity conflict) and must
    // NOT be dismissed.
    const inserted = install({ customers: [personA, personB, shell] });
    const result = await dedupe.runRedPairAutoDismissSweep();
    expect(result.dismissed).toHaveLength(1);
    expect(inserted).toHaveLength(1);
    const [a, b] = [personA.id, personB.id].sort();
    expect(inserted[0].row.customer_id_a).toBe(a);
    expect(inserted[0].row.customer_id_b).toBe(b);
    expect(inserted[0].row.created_by).toBe('auto:red-tier');
    expect(inserted[0].row.reason).toMatch(/red tier/);
    // Idempotency rides on the ordered-pair unique constraint.
    expect(inserted[0].onConflict).toBe(true);
    expect(inserted[0].ignored).toBe(true);
    // ONE digest bell for the sweep.
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    expect(notifyAdmin.mock.calls[0][0]).toBe('customer');
    expect(notifyAdmin.mock.calls[0][3].link).toBe('/admin/customers/duplicates');
  });

  it('stays silent when there is nothing red', async () => {
    const inserted = install({ customers: [personA, shell] });
    const result = await dedupe.runRedPairAutoDismissSweep();
    expect(result.dismissed).toHaveLength(0);
    expect(inserted).toHaveLength(0);
    expect(notifyAdmin).not.toHaveBeenCalled();
  });

  it('aborts fail-closed when the dismissals table is unreadable', async () => {
    const inserted = install({ customers: [personA, personB], dismissalsError: true });
    const result = await dedupe.runRedPairAutoDismissSweep();
    expect(result.aborted).toBe('dismissals_unreadable');
    expect(inserted).toHaveLength(0);
    expect(notifyAdmin).not.toHaveBeenCalled();
  });

  it('skips the permanent dismissal when the pair is no longer red at write time (races an admin edit)', async () => {
    // Detection classifies red from an earlier read; before the write lands,
    // an admin fixes the last name — the FOR UPDATE re-read sees compatible
    // names, so the red predicate no longer holds and NO dismissal may land.
    const inserted = install({
      customers: [personA, personB],
      lockedCustomers: [personA, { ...personB, last_name: 'Sampleone' }],
    });
    const result = await dedupe.runRedPairAutoDismissSweep();
    expect(result.dismissed).toHaveLength(0);
    expect(result.skippedStale).toBe(1);
    expect(inserted).toHaveLength(0);
    // Nothing dismissed → no digest bell.
    expect(notifyAdmin).not.toHaveBeenCalled();
  });

  // Codex round 3 P2: revertMerge's undo sentinel is deliberately visible to
  // this sweep's read, so an undone pair that is red is selected every day.
  // An ignored conflict would leave the sentinel in place yet report
  // 'dismissed' — a repeated false digest. The sentinel is REPLACED by the
  // real red verdict (the pair leaves the queue like any red pair).
  it('replaces an undo-merge sentinel with the real red verdict instead of ignoring the conflict', async () => {
    const [a, b] = [personA.id, personB.id].sort();
    const inserted = install({
      customers: [personA, personB],
      existingDismissals: [{ customer_id_a: a, customer_id_b: b, reason: dedupe.UNDO_MERGE_DISMISSAL_REASON }],
    });
    const result = await dedupe.runRedPairAutoDismissSweep();
    expect(result.dismissed).toHaveLength(1);
    expect(inserted).toHaveLength(0);
    expect(inserted.updated).toHaveLength(1);
    expect(inserted.updated[0].where).toEqual({ customer_id_a: a, customer_id_b: b, reason: dedupe.UNDO_MERGE_DISMISSAL_REASON });
    expect(inserted.updated[0].patch.reason).toMatch(/red tier/);
    expect(inserted.updated[0].patch.created_by).toBe('auto:red-tier');
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
  });

  it('treats a real dismissal that raced in since the snapshot as already handled — no write, no digest', async () => {
    const [a, b] = [personA.id, personB.id].sort();
    // The detection read (module db) still returns the pair; the locked
    // pair read sees an operator's verdict that landed in between.
    const inserted = install({
      customers: [personA, personB],
      existingDismissals: [],
    });
    // Swap the router's dismissal answer for the locked read only.
    const seen = [];
    db.transaction.mockImplementation(async (fn) => {
      const trx = jest.fn((table) => makeChain(table, (q) => {
        if (table === 'customers') return [personA, personB];
        if (table === 'customer_duplicate_dismissals') {
          if (q.called('insert') || q.called('update')) { seen.push(q._calls); return 1; }
          return [{ customer_id_a: a, customer_id_b: b, reason: 'operator: separate tenants' }];
        }
        return [];
      }));
      trx.fn = { now: () => 'NOW' };
      trx.raw = jest.fn(async () => ({ rows: [] }));
      return fn(trx);
    });
    const result = await dedupe.runRedPairAutoDismissSweep();
    expect(result.dismissed).toHaveLength(0);
    expect(result.alreadyDismissed).toBe(1);
    expect(seen).toHaveLength(0);
    expect(inserted).toHaveLength(0);
    expect(notifyAdmin).not.toHaveBeenCalled();
  });

  it('skips when a locked row was retired between detection and the write', async () => {
    const inserted = install({
      customers: [personA, personB],
      lockedCustomers: [personA, { ...personB, deleted_at: '2026-07-31T00:00:00Z' }],
    });
    const result = await dedupe.runRedPairAutoDismissSweep();
    expect(result.dismissed).toHaveLength(0);
    expect(result.skippedStale).toBe(1);
    expect(inserted).toHaveLength(0);
  });
});
