/**
 * customer-dedupe queue resolvers — red-pair auto-dismiss sweep, the
 * journal's row-precise repointed_ids record, and the journal-backed
 * merge revert (guards + happy path).
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
    'orderBy', 'forUpdate', 'update', 'insert', 'del', 'count', 'onConflict',
    'ignore', 'returning', 'first', 'increment', 'decrement', 'limit',
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

// ---------------------------------------------------------------------------
// Red-pair auto-dismiss sweep
// ---------------------------------------------------------------------------

describe('runRedPairAutoDismissSweep', () => {
  const diana = {
    id: 'aaaaaaaa-0000-0000-0000-000000000001',
    first_name: 'Diana', last_name: 'Blowers', phone: '+16124074763',
    address_line1: '4414 Ozark Ave', zip: '34207',
    pipeline_stage: 'active_customer', created_at: '2026-07-08',
    stripe_customer_id: 'cus_d',
  };
  const nicole = {
    id: 'aaaaaaaa-0000-0000-0000-000000000003',
    first_name: 'Nicole', last_name: 'Tommelleo', phone: '+16124074763',
    address_line1: '13712 Saw Palm Creek Trl', zip: '34211',
    pipeline_stage: 'active_customer', created_at: '2026-07-01',
  };
  const shell = {
    id: 'aaaaaaaa-0000-0000-0000-000000000002',
    first_name: 'Diana', last_name: null, phone: '6124074763',
    address_line1: null, zip: null,
    pipeline_stage: 'new_lead', created_at: '2026-07-09',
  };

  function install({ customers, dismissalsError = false }) {
    const inserted = [];
    installDb((table, q) => {
      if (table === 'customers') return customers;
      if (table === 'customer_duplicate_dismissals') {
        if (q.called('insert')) {
          inserted.push({ row: q.args('insert')[0], onConflict: q.called('onConflict'), ignored: q.called('ignore') });
          return 1;
        }
        if (dismissalsError) throw new Error('relation is unreadable');
        return [];
      }
      return [];
    });
    return inserted;
  }

  it('dismisses only red pairs, attributed auto:red-tier, via the idempotent upsert', async () => {
    // Diana+Nicole = red (different last names, different addresses on a
    // shared phone); the shell pair is yellow (identity conflict) and must
    // NOT be dismissed.
    const inserted = install({ customers: [diana, nicole, shell] });
    const result = await dedupe.runRedPairAutoDismissSweep();
    expect(result.dismissed).toHaveLength(1);
    expect(inserted).toHaveLength(1);
    const [a, b] = [diana.id, nicole.id].sort();
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
    const inserted = install({ customers: [diana, shell] });
    const result = await dedupe.runRedPairAutoDismissSweep();
    expect(result.dismissed).toHaveLength(0);
    expect(inserted).toHaveLength(0);
    expect(notifyAdmin).not.toHaveBeenCalled();
  });

  it('aborts fail-closed when the dismissals table is unreadable', async () => {
    const inserted = install({ customers: [diana, nicole], dismissalsError: true });
    const result = await dedupe.runRedPairAutoDismissSweep();
    expect(result.aborted).toBe('dismissals_unreadable');
    expect(inserted).toHaveLength(0);
    expect(notifyAdmin).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// executeMerge — repointed_ids journal record
// ---------------------------------------------------------------------------

describe('executeMerge repointed_ids journal record', () => {
  const WINNER = 'bbbbbbbb-0000-0000-0000-000000000001';
  const LOSER = 'bbbbbbbb-0000-0000-0000-000000000002';

  it('journals per-row ids for plain repoints and count-only when ids are unreliable', async () => {
    const winner = { id: WINNER, first_name: 'Diana', last_name: 'Blowers', phone: '+16124074763' };
    const loser = { id: LOSER, first_name: 'Diana', last_name: null, phone: '6124074763' };
    const state = { journal: null };
    const route = (table, q) => {
      if (table === 'customers') {
        if (q.called('forUpdate')) return [winner, loser];
        if (q.called('update')) return 1;
        return [];
      }
      if (table === 'customer_merge_journal') {
        state.journal = q.args('insert')[0];
        return [{ id: 'j1' }];
      }
      if (table === 'leads') {
        if (q.called('update')) return 2;
        if (q.called('select')) return [{ id: 'lead-1' }, { id: 'lead-2' }];
      }
      if (table === 'call_log') {
        // The update moves a row the id-select did not see — the record must
        // degrade to count-only, never a wrong id list.
        if (q.called('update')) return 3;
        if (q.called('select')) return [{ id: 'call-1' }];
      }
      if (table === 'notifications') {
        if (q.called('update')) return 1;
        if (q.called('select')) return [{ id: 'note-1' }];
      }
      // .first() lookups must resolve a row or null, never [].
      if (q.called('first')) return null;
      if (q.called('update')) return 0;
      return [];
    };
    const trx = jest.fn((table) => makeChain(table, (q) => route(table, q)));
    trx.raw = jest.fn(async () => ({
      rows: [
        { table_name: 'leads', column_name: 'customer_id' },
        { table_name: 'call_log', column_name: 'customer_id' },
      ],
    }));
    trx.transaction = jest.fn(async (fn) => fn(trx));
    trx.fn = { now: () => 'NOW()' };
    db.transaction.mockImplementation(async (fn) => fn(trx));

    await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });

    const recorded = JSON.parse(state.journal.repointed_ids);
    expect(recorded.version).toBe(1);
    expect(recorded.tables['leads.customer_id']).toEqual(['lead-1', 'lead-2']);
    expect(recorded.tables['call_log.customer_id']).toEqual({ count: 3 });
    // Polymorphic pointers record ids too.
    expect(recorded.tables['notifications.recipient_id']).toEqual(['note-1']);
    expect(recorded.stripe_transferred_id).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// revertMerge
// ---------------------------------------------------------------------------

describe('revertMerge', () => {
  const WINNER = 'bbbbbbbb-0000-0000-0000-000000000001';
  const LOSER = 'bbbbbbbb-0000-0000-0000-000000000002';
  const JOURNAL = 'cccccccc-0000-0000-0000-000000000001';

  function buildRevertTrx({ journal, winner, loser, tables = {} }) {
    const state = {
      repointedBack: [], winnerPatch: null, loserRestore: null, journalUpdate: null, decremented: null,
    };
    const route = (table, q) => {
      if (table === 'customer_merge_journal') {
        if (q.called('update')) { state.journalUpdate = q.args('update')[0]; return 1; }
        if (q.called('first')) return journal;
        return [];
      }
      if (table === 'customers') {
        if (q.called('forUpdate')) return [winner, loser].filter(Boolean);
        if (q.called('decrement')) { state.decremented = q.args('decrement'); return 1; }
        if (q.called('update')) {
          const whereArg = q.args('where')?.[0];
          if (whereArg && whereArg.id === winner?.id) { state.winnerPatch = q.args('update')[0]; return 1; }
          state.loserRestore = q.args('update')[0];
          return 1;
        }
        return [];
      }
      const cfg = tables[table];
      if (cfg) {
        if (q.called('update')) {
          state.repointedBack.push({ table, ids: q.args('whereIn')[1], payload: q.args('update')[0] });
          return q.args('whereIn')[1].length;
        }
        if (q.called('select')) return cfg.stillOnWinner.map((id) => ({ id }));
      }
      return [];
    };
    const trx = jest.fn((table) => makeChain(table, (q) => route(table, q)));
    trx.transaction = jest.fn(async (fn) => fn(trx));
    trx.fn = { now: () => 'NOW()' };
    return { trx, state };
  }

  const baseJournal = () => ({
    id: JOURNAL,
    winner_customer_id: WINNER,
    loser_customer_id: LOSER,
    undone_at: null,
    loser_snapshot: {
      id: LOSER, first_name: 'Diana', last_name: null, phone: '6124074763',
      email: 'diana@example.com', stripe_customer_id: 'cus_only', account_credits: 0,
    },
    repointed_ids: {
      version: 1,
      tables: { 'leads.customer_id': ['lead-1', 'lead-2'], 'invoices.customer_id': ['inv-1'] },
      stripe_transferred_id: 'cus_only',
    },
    winner_backfills: { email: 'diana@example.com', stripe_customer_id: 'cus_only' },
  });
  const baseWinner = () => ({
    id: WINNER, first_name: 'Diana', last_name: 'Blowers', active: true, deleted_at: null,
    stripe_customer_id: 'cus_only', email: 'diana@example.com', account_credits: 0,
  });
  const baseLoser = () => ({
    id: LOSER, active: false, deleted_at: '2026-07-30T04:40:00Z', phone: `merged-${LOSER.slice(0, 8)}`,
  });

  it('repoints recorded rows back, restores the loser, moves the Stripe id back, stamps undone', async () => {
    const { trx, state } = buildRevertTrx({
      journal: baseJournal(),
      winner: baseWinner(),
      loser: baseLoser(),
      tables: {
        leads: { stillOnWinner: ['lead-1', 'lead-2'] },
        invoices: { stillOnWinner: ['inv-1'] },
      },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));

    const result = await dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' });

    expect(result.repointedBack['leads.customer_id']).toBe(2);
    expect(result.repointedBack['invoices.customer_id']).toBe(1);
    expect(state.repointedBack.every((r) => r.payload.customer_id === LOSER)).toBe(true);
    // Transferred Stripe id vacates the winner (it provably still sat there)
    // and the backfilled email vacates so the loser's identity can restore.
    expect(state.winnerPatch.stripe_customer_id).toBe(null);
    expect(state.winnerPatch.email).toBe(null);
    // Loser un-retires from the snapshot.
    expect(state.loserRestore.active).toBe(true);
    expect(state.loserRestore.deleted_at).toBe(null);
    expect(state.loserRestore.phone).toBe('6124074763');
    expect(state.loserRestore.email).toBe('diana@example.com');
    expect(state.loserRestore.stripe_customer_id).toBe('cus_only');
    expect(state.journalUpdate.undone_at).toBeTruthy();
    expect(state.journalUpdate.undone_by).toBe('admin:test');
    expect(result.stripeMovedBack).toBe(true);
    expect(result.skipped).toHaveLength(0);
    // ONE admin bell, post-commit.
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    expect(notifyAdmin.mock.calls[0][0]).toBe('customer');
  });

  it('refuses (409) when the merge was already undone', async () => {
    const { trx } = buildRevertTrx({
      journal: { ...baseJournal(), undone_at: '2026-07-30T05:00:00Z' },
      winner: baseWinner(),
      loser: baseLoser(),
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/already been undone/) });
  });

  it('refuses (409) a pre-upgrade merge with no row-level repoint record', async () => {
    const { trx } = buildRevertTrx({
      journal: { ...baseJournal(), repointed_ids: null },
      winner: baseWinner(),
      loser: baseLoser(),
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/predates row-level undo/) });
  });

  it('refuses when ANY invoice row no longer belongs to the winner (money ownership is all-or-nothing)', async () => {
    const { trx, state } = buildRevertTrx({
      journal: baseJournal(),
      winner: baseWinner(),
      loser: baseLoser(),
      tables: {
        leads: { stillOnWinner: ['lead-1', 'lead-2'] },
        invoices: { stillOnWinner: [] }, // moved on since the merge
      },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/invoices row/) });
    // The refusal happened in the verification pass — nothing was written.
    expect(state.repointedBack).toHaveLength(0);
    expect(state.journalUpdate).toBe(null);
  });

  it('skips-and-reports changed rows on low-stakes tables and leaves a changed Stripe id alone', async () => {
    const journal = baseJournal();
    journal.repointed_ids.tables = { 'leads.customer_id': ['lead-1', 'lead-2'] };
    const { trx, state } = buildRevertTrx({
      journal,
      winner: { ...baseWinner(), stripe_customer_id: 'cus_DIFFERENT' },
      loser: baseLoser(),
      tables: { leads: { stillOnWinner: ['lead-1'] } },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' });
    expect(result.repointedBack['leads.customer_id']).toBe(1);
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'leads.customer_id', reason: 'rows_changed_since_merge', count: 1 }),
      expect.objectContaining({ key: 'customers.stripe_customer_id', reason: 'winner_stripe_changed_since_merge' }),
    ]));
    expect(result.stripeMovedBack).toBe(false);
    // Winner keeps its (changed) Stripe id; loser restores WITHOUT one.
    expect(state.winnerPatch?.stripe_customer_id).toBeUndefined();
    expect(state.loserRestore.stripe_customer_id).toBeUndefined();
    // Still marked undone — the partial outcome is reported, not blocked.
    expect(state.journalUpdate.undone_at).toBeTruthy();
  });

  it('refuses (409) when the kept customer is retired', async () => {
    const { trx } = buildRevertTrx({
      journal: baseJournal(),
      winner: { ...baseWinner(), active: false },
      loser: baseLoser(),
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/inactive or deleted/) });
  });
});
