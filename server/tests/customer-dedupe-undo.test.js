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
    'orderBy', 'forUpdate', 'update', 'insert', 'del', 'count', 'sum', 'onConflict',
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

  function install({ customers, lockedCustomers = null, dismissalsError = false }) {
    const inserted = [];
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
        if (dismissalsError) throw new Error('relation is unreadable');
        return [];
      }
      return [];
    };
    installDb(router);
    db.transaction.mockImplementation(async (fn) => {
      const trx = jest.fn((table) => makeChain(table, (q) => router(table, q)));
      trx.fn = { now: () => 'NOW' };
      return fn(trx);
    });
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

// ---------------------------------------------------------------------------
// executeMerge — repointed_ids journal record
// ---------------------------------------------------------------------------

describe('executeMerge repointed_ids journal record', () => {
  const WINNER = 'bbbbbbbb-0000-0000-0000-000000000001';
  const LOSER = 'bbbbbbbb-0000-0000-0000-000000000002';

  it('journals per-row ids for plain repoints and count-only when ids are unreliable', async () => {
    const winner = { id: WINNER, first_name: 'Winner', last_name: 'Testcase', phone: '+15550000001' };
    const loser = { id: LOSER, first_name: 'Winner', last_name: null, phone: '5550000001' };
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
    // No payment methods, no collisions — clean revertible record.
    expect(recorded.payment_method_flags).toEqual({});
    expect(recorded.collision_handlers).toEqual([]);
    // Autopay untouched and nothing deliberately nulled on the winner.
    expect(recorded.winner_autopay_before).toBe(null);
    expect(recorded.winner_prior_values).toEqual({});
  });

  it("journals the winner's ORIGINAL autopay state and the consent stamps the merge deliberately nulled", async () => {
    const winner = {
      id: WINNER, first_name: 'Winner', last_name: 'Testcase', phone: '+15550000001',
      autopay_enabled: true, autopay_paused_until: null,
      // Slot 1 partially filled (name only) — the winner HAS contacts, so a
      // loser phone joining the list invalidates the winner's stamp.
      service_contact_name: 'Owner Sample', service_contact_phone: null,
      service_contact_email: null, service_contact_role: null,
      service_contact2_name: null, service_contact2_phone: null,
      service_contact2_email: null, service_contact2_role: null,
      service_contacts_consent_at: '2026-06-01T00:00:00.000Z',
      service_contacts_consent_source: 'portal_form',
      service_contacts_consent_text_version: 'v2',
    };
    const loser = {
      id: LOSER, first_name: 'Winner', last_name: null, phone: '5550000001',
      autopay_enabled: false,
      service_contact2_name: 'Tenant Sample', service_contact2_phone: '+15550000042',
    };
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
      if (q.called('first')) return null;
      if (q.called('update')) return 0;
      return [];
    };
    const trx = jest.fn((table) => makeChain(table, (q) => route(table, q)));
    trx.raw = jest.fn(async () => ({ rows: [] }));
    trx.transaction = jest.fn(async (fn) => fn(trx));
    trx.fn = { now: () => 'NOW()' };
    db.transaction.mockImplementation(async (fn) => fn(trx));

    const result = await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });

    const recorded = JSON.parse(state.journal.repointed_ids);
    // The most-restrictive block applied the loser's opt-out DIRECTLY (not a
    // backfill) — the journal keeps the winner's pre-merge values for the
    // exact columns it overwrote so the undo can put them back.
    expect(recorded.winner_autopay_before).toEqual({
      before: { autopay_enabled: true },
      applied: { autopay_enabled: false },
    });
    // The merge cleared the winner's consent stamps (mixed contact list);
    // winner_backfills records the APPLIED nulls, winner_prior_values the
    // originals the undo restores.
    const backfills = JSON.parse(state.journal.winner_backfills);
    expect(backfills.service_contacts_consent_at).toBe(null);
    expect(recorded.winner_prior_values).toEqual({
      service_contacts_consent_at: '2026-06-01T00:00:00.000Z',
      service_contacts_consent_source: 'portal_form',
      service_contacts_consent_text_version: 'v2',
    });
    expect(result.backfills.service_contact2_phone).toBe('+15550000042');
  });

  it('registers the referral-promoter consolidation in collision_handlers (folded rewards cannot be split back)', async () => {
    const winner = { id: WINNER, first_name: 'Winner', last_name: 'Testcase', phone: '+15550000001' };
    const loser = { id: LOSER, first_name: 'Winner', last_name: null, phone: '5550000001' };
    const winnerPromoter = {
      id: 7, customer_id: WINNER, referral_balance_cents: 0,
      total_earned_cents: 0, total_paid_out_cents: 0, total_clicks: 0,
      total_referrals_sent: 0, total_referrals_converted: 0,
      available_balance_cents: 0, pending_earnings_cents: 0,
    };
    const loserPromoterRow = {
      id: 9, customer_id: LOSER, referral_balance_cents: 200,
      total_earned_cents: 250, total_paid_out_cents: 0, total_clicks: 2,
      total_referrals_sent: 3, total_referrals_converted: 1,
      available_balance_cents: 300, pending_earnings_cents: 50,
    };
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
      if (table === 'referral_promoters') {
        if (q.called('first')) {
          const w = q.args('where')[0];
          if (w.customer_id === LOSER) return { id: 9 };
          if (w.customer_id === WINNER) return winnerPromoter;
          if (w.id === 9) return loserPromoterRow;
          return null;
        }
        if (q.called('update')) return 1;
      }
      if (q.called('first')) return null;
      if (q.called('update')) return 1;
      return [];
    };
    const trx = jest.fn((table) => makeChain(table, (q) => route(table, q)));
    trx.raw = jest.fn(async () => ({ rows: [] }));
    trx.transaction = jest.fn(async (fn) => fn(trx));
    trx.fn = { now: () => 'NOW()' };
    db.transaction.mockImplementation(async (fn) => fn(trx));

    const result = await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });

    expect(result.repointed['referral_promoters.consolidated']).toMatch(/9 into 7/);
    // The consolidation moved referrals/payouts, zeroed balances, and
    // retired the loser promoter — none of it row-recorded, so the merge
    // must read as non-revertible (revertMerge 409s; GET /merges shows
    // revertible:false).
    const recorded = JSON.parse(state.journal.repointed_ids);
    expect(recorded.collision_handlers).toContain('referral_promoters');
  });

  it('journals collision handlers and the ORIGINAL per-card default/autopay flags', async () => {
    const winner = { id: WINNER, first_name: 'Winner', last_name: 'Testcase', phone: '+15550000001' };
    const loser = { id: LOSER, first_name: 'Winner', last_name: null, phone: '5550000001' };
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
      if (table === 'payment_methods') {
        if (q.called('first')) return null; // winner has no default card
        if (q.called('select')) {
          // stripe-profile probe vs the flags capture select.
          return q.args('select')[0] === 'stripe_customer_id'
            ? []
            : [{ id: 'pm-1', is_default: true, autopay_enabled: true }];
        }
        if (q.called('update')) return 1;
      }
      if (table === 'customer_mrr_snapshots') {
        if (q.called('select')) return [{ id: 'm1' }];
        if (q.called('update')) {
          // Bulk repoint collides; the rowwise drop-collisions handler runs.
          if (q.args('where')[0] === 'customer_id') {
            const err = new Error('duplicate key value violates unique constraint');
            err.code = '23505';
            throw err;
          }
          return 1;
        }
      }
      if (q.called('first')) return null;
      if (q.called('update')) return 0;
      return [];
    };
    const trx = jest.fn((table) => makeChain(table, (q) => route(table, q)));
    trx.raw = jest.fn(async () => ({
      rows: [{ table_name: 'customer_mrr_snapshots', column_name: 'customer_id' }],
    }));
    trx.transaction = jest.fn(async (fn) => fn(trx));
    trx.fn = { now: () => 'NOW()' };
    db.transaction.mockImplementation(async (fn) => fn(trx));

    await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });

    const recorded = JSON.parse(state.journal.repointed_ids);
    // The collision handler moved rows repointed_ids has no record of —
    // journaled so the revert endpoint refuses this merge.
    expect(recorded.collision_handlers).toEqual(['customer_mrr_snapshots']);
    expect(recorded.tables['customer_mrr_snapshots.customer_id']).toBeUndefined();
    // Original flags journaled per card so an undo can restore them exactly.
    expect(recorded.payment_method_flags).toEqual({
      'pm-1': { is_default: true, autopay_enabled: true },
    });
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
      repointedBack: [], winnerPatch: null, loserRestore: null, journalUpdate: null,
      decremented: null, flagRestores: [], propertyDeleted: null, verified: [],
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
      if (table === 'customer_properties' && q.called('del')) {
        state.propertyDeleted = q.args('where')[0];
        return 1;
      }
      const cfg = tables[table];
      if (cfg) {
        if (q.called('sum')) {
          const whereArg = q.args('where')?.[0] || {};
          return { total: (cfg.ledgerSums || {})[whereArg.customer_id] ?? 0 };
        }
        if (q.called('update')) {
          if (q.called('whereIn')) {
            state.repointedBack.push({ table, ids: q.args('whereIn')[1], payload: q.args('update')[0] });
            return cfg.updateCount !== undefined ? cfg.updateCount : q.args('whereIn')[1].length;
          }
          // Non-whereIn update = the per-card flag restore.
          state.flagRestores.push({ table, where: q.args('where')[0], payload: q.args('update')[0] });
          return 1;
        }
        if (q.called('select')) {
          state.verified.push({ table, forUpdate: q.called('forUpdate') });
          return cfg.stillOnWinner.map((id) => ({ id }));
        }
      }
      return [];
    };
    const trx = jest.fn((table) => makeChain(table, (q) => route(table, q)));
    trx.transaction = jest.fn(async (fn) => fn(trx));
    trx.fn = { now: () => 'NOW()' };
    return { trx, state };
  }

  // Clearly synthetic identity fixtures only.
  const baseJournal = () => ({
    id: JOURNAL,
    winner_customer_id: WINNER,
    loser_customer_id: LOSER,
    undone_at: null,
    loser_snapshot: {
      id: LOSER, first_name: 'Loser', last_name: null, phone: '5550000001',
      email: 'loser.testcase@example.com', stripe_customer_id: 'cus_only', account_credits: 0,
    },
    repointed_ids: {
      version: 1,
      tables: { 'leads.customer_id': ['lead-1', 'lead-2'], 'invoices.customer_id': ['inv-1'] },
      stripe_transferred_id: 'cus_only',
      payment_method_flags: {},
      collision_handlers: [],
    },
    winner_backfills: { email: 'loser.testcase@example.com', stripe_customer_id: 'cus_only' },
  });
  const baseWinner = () => ({
    id: WINNER, first_name: 'Winner', last_name: 'Testcase', active: true, deleted_at: null,
    stripe_customer_id: 'cus_only', email: 'loser.testcase@example.com', account_credits: 0,
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
    expect(state.loserRestore.phone).toBe('5550000001');
    expect(state.loserRestore.email).toBe('loser.testcase@example.com');
    expect(state.loserRestore.stripe_customer_id).toBe('cus_only');
    // Financial rows verify under FOR UPDATE; history rows don't need the lock.
    expect(state.verified).toEqual(expect.arrayContaining([
      { table: 'invoices', forUpdate: true },
      { table: 'leads', forUpdate: false },
    ]));
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

  it('skips-and-reports changed rows on low-stakes tables and leaves a changed Stripe id alone (NO moved cards)', async () => {
    // Boundary of the stripe-drift refusal: with no payment_methods rows in
    // the journal, a drifted Stripe id is merely reported — the refusal
    // below only fires when saved cards would repoint to the loser.
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

  it('refuses (409) when a collision handler ran during the merge — folded rows cannot be split back', async () => {
    const journal = baseJournal();
    journal.repointed_ids.collision_handlers = ['conversations'];
    const { trx, state } = buildRevertTrx({ journal, winner: baseWinner(), loser: baseLoser() });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/folded colliding rows \(conversations\)/) });
    expect(state.repointedBack).toHaveLength(0);
    expect(state.journalUpdate).toBe(null);
  });

  it('moves recorded credit-ledger rows back and RECOMPUTES both cached balances from the ledgers', async () => {
    const journal = baseJournal();
    journal.repointed_ids.tables = {
      'leads.customer_id': ['lead-1'],
      'customer_credit_ledger.customer_id': ['led-1', 'led-2'],
    };
    journal.loser_snapshot.account_credits = 25.5;
    const { trx, state } = buildRevertTrx({
      journal,
      winner: { ...baseWinner(), account_credits: '65.50' },
      loser: baseLoser(),
      tables: {
        leads: { stillOnWinner: ['lead-1'] },
        customer_credit_ledger: {
          stillOnWinner: ['led-1', 'led-2'],
          // Post-move ledger sums (cache must equal ledger on BOTH sides).
          ledgerSums: { [WINNER]: 40, [LOSER]: 25.5 },
        },
      },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' });
    expect(result.repointedBack['customer_credit_ledger.customer_id']).toBe(2);
    // Ledger rows verified under FOR UPDATE (financial table).
    expect(state.verified).toEqual(expect.arrayContaining([
      { table: 'customer_credit_ledger', forUpdate: true },
    ]));
    // Both caches recomputed from the ledgers — no blind decrement.
    expect(state.winnerPatch.account_credits).toBe(40);
    expect(state.loserRestore.account_credits).toBe(25.5);
    expect(state.decremented).toBe(null);
  });

  it("refuses (409, zero writes) when the winner's spend consumed the moved credit — its ledger would go negative", async () => {
    const journal = baseJournal();
    journal.repointed_ids.tables = { 'customer_credit_ledger.customer_id': ['led-1'] };
    journal.loser_snapshot.account_credits = 25.5;
    const { trx, state } = buildRevertTrx({
      journal,
      winner: baseWinner(),
      loser: baseLoser(),
      tables: {
        customer_credit_ledger: {
          stillOnWinner: ['led-1'],
          ledgerSums: { [WINNER]: -10, [LOSER]: 25.5 },
        },
      },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/consumed the merged-in credit/) });
    // The refusal throw rolls the transaction back — journal never stamped.
    expect(state.journalUpdate).toBe(null);
  });

  it('clears every UNCHANGED winner backfill (billing + contact) and reports the edited ones', async () => {
    const journal = baseJournal();
    journal.winner_backfills = {
      ...journal.winner_backfills,
      payer_id: 5,
      billing_mode: 'per_application',
      per_application_fee: '65.00',
      first_name: 'Loser',
    };
    const { trx, state } = buildRevertTrx({
      journal,
      winner: {
        ...baseWinner(),
        payer_id: 5, // unchanged → cleared
        billing_mode: 'per_application', // unchanged → cleared
        per_application_fee: 65, // numeric restringification still counts as unchanged
        first_name: 'Edited Since', // admin changed it → stays, reported
      },
      loser: baseLoser(),
      tables: { leads: { stillOnWinner: ['lead-1', 'lead-2'] }, invoices: { stillOnWinner: ['inv-1'] } },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' });
    expect(state.winnerPatch).toMatchObject({
      payer_id: null,
      billing_mode: null,
      per_application_fee: null,
      email: null,
    });
    expect(state.winnerPatch.first_name).toBeUndefined();
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'customers.first_name', reason: 'winner_value_changed_since_merge' }),
    ]));
  });

  it("restores each moved-back payment method's ORIGINAL default/autopay flags", async () => {
    const journal = baseJournal();
    journal.repointed_ids.tables = { 'payment_methods.customer_id': ['pm-1', 'pm-2'] };
    journal.repointed_ids.payment_method_flags = {
      'pm-1': { is_default: true, autopay_enabled: true },
      'pm-2': { is_default: false, autopay_enabled: false },
    };
    const { trx, state } = buildRevertTrx({
      journal,
      winner: baseWinner(),
      loser: baseLoser(),
      tables: { payment_methods: { stillOnWinner: ['pm-1', 'pm-2'] } },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' });
    expect(result.repointedBack['payment_methods.customer_id']).toBe(2);
    expect(state.flagRestores).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: 'payment_methods',
        where: { id: 'pm-1', customer_id: LOSER },
        payload: expect.objectContaining({ is_default: true, autopay_enabled: true }),
      }),
      expect.objectContaining({
        table: 'payment_methods',
        where: { id: 'pm-2', customer_id: LOSER },
        payload: expect.objectContaining({ is_default: false, autopay_enabled: false }),
      }),
    ]));
  });

  it("refuses (409, zero writes) when the winner's Stripe id changed since the merge AND payment methods were moved", async () => {
    // The transferred id can't move back (it no longer sits on the winner),
    // but the recorded payment_methods rows WOULD repoint — the restored
    // customer would hold saved cards referencing a Stripe profile its row
    // doesn't have. Financially-relevant restoration can't be exact → refuse
    // whole, never the old skip-and-split.
    const journal = baseJournal();
    journal.repointed_ids.tables = { 'payment_methods.customer_id': ['pm-1'] };
    journal.repointed_ids.payment_method_flags = { 'pm-1': { is_default: true, autopay_enabled: true } };
    const { trx, state } = buildRevertTrx({
      journal,
      winner: { ...baseWinner(), stripe_customer_id: 'cus_DIFFERENT' },
      loser: baseLoser(),
      tables: { payment_methods: { stillOnWinner: ['pm-1'] } },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/Stripe profile has changed .* payment methods were moved/) });
    expect(state.repointedBack).toHaveLength(0);
    expect(state.flagRestores).toHaveLength(0);
    expect(state.journalUpdate).toBe(null);
  });

  it("restores the winner's ORIGINAL autopay state when still the merge-written value; edited fields stay and report", async () => {
    const journal = baseJournal();
    journal.repointed_ids.winner_autopay_before = {
      before: { autopay_enabled: true, autopay_paused_until: null, autopay_pause_reason: null },
      applied: {
        autopay_enabled: false,
        autopay_paused_until: '2026-08-15T00:00:00.000Z',
        autopay_pause_reason: 'customer asked to hold',
      },
    };
    const { trx, state } = buildRevertTrx({
      journal,
      winner: {
        ...baseWinner(),
        autopay_enabled: false, // still the merge-written opt-out → restored
        autopay_paused_until: '2026-09-30T00:00:00.000Z', // admin re-paused later → stays, reported
        autopay_pause_reason: 'customer asked to hold', // unchanged → restored
      },
      loser: baseLoser(),
      tables: { leads: { stillOnWinner: ['lead-1', 'lead-2'] }, invoices: { stillOnWinner: ['inv-1'] } },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' });
    expect(state.winnerPatch.autopay_enabled).toBe(true);
    expect(state.winnerPatch.autopay_pause_reason).toBe(null);
    expect(state.winnerPatch.autopay_paused_until).toBeUndefined();
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'customers.autopay_paused_until', reason: 'winner_value_changed_since_merge' }),
    ]));
  });

  it('pre-upgrade journal without winner_autopay_before: no autopay restore, no refusal (documented behavior)', async () => {
    const journal = baseJournal(); // no winner_autopay_before key
    const { trx, state } = buildRevertTrx({
      journal,
      winner: { ...baseWinner(), autopay_enabled: false },
      loser: baseLoser(),
      tables: { leads: { stillOnWinner: ['lead-1', 'lead-2'] }, invoices: { stillOnWinner: ['inv-1'] } },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' });
    // Winner stays most-restrictive — never a silent re-enable.
    expect(state.winnerPatch?.autopay_enabled).toBeUndefined();
    expect(result.skipped).toHaveLength(0);
  });

  it('restores the consent stamps the merge deliberately nulled, only while still null on the winner', async () => {
    const journal = baseJournal();
    journal.winner_backfills = {
      ...journal.winner_backfills,
      service_contact2_name: 'Tenant Sample',
      service_contact2_phone: '+15550000042',
      service_contacts_consent_at: null,
      service_contacts_consent_source: null,
      service_contacts_consent_text_version: null,
    };
    journal.repointed_ids.winner_prior_values = {
      service_contacts_consent_at: '2026-06-01T00:00:00.000Z',
      service_contacts_consent_source: 'portal_form',
      service_contacts_consent_text_version: 'v2',
    };
    const { trx, state } = buildRevertTrx({
      journal,
      winner: {
        ...baseWinner(),
        service_contact2_name: 'Tenant Sample', // unchanged backfill → vacates
        service_contact2_phone: '+15550000042',
        service_contacts_consent_at: null, // still the merge-written null → restored
        service_contacts_consent_source: null,
        service_contacts_consent_text_version: 'v9', // re-attested since → stays, reported
      },
      loser: baseLoser(),
      tables: { leads: { stillOnWinner: ['lead-1', 'lead-2'] }, invoices: { stillOnWinner: ['inv-1'] } },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' });
    // Appended loser contacts vacate the winner...
    expect(state.winnerPatch.service_contact2_name).toBe(null);
    expect(state.winnerPatch.service_contact2_phone).toBe(null);
    // ...and the winner's own pre-merge consent stamps come back.
    expect(state.winnerPatch.service_contacts_consent_at).toBe('2026-06-01T00:00:00.000Z');
    expect(state.winnerPatch.service_contacts_consent_source).toBe('portal_form');
    expect(state.winnerPatch.service_contacts_consent_text_version).toBeUndefined();
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'customers.service_contacts_consent_text_version', reason: 'winner_value_changed_since_merge' }),
    ]));
  });

  it('refuses (409) when payment_methods rows were journaled WITHOUT their flag records (billing continuity)', async () => {
    const journal = baseJournal();
    journal.repointed_ids.tables = { 'payment_methods.customer_id': ['pm-1'] };
    delete journal.repointed_ids.payment_method_flags;
    const { trx, state } = buildRevertTrx({
      journal,
      winner: baseWinner(),
      loser: baseLoser(),
      tables: { payment_methods: { stillOnWinner: ['pm-1'] } },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/default\/autopay flags/) });
    expect(state.repointedBack).toHaveLength(0);
    expect(state.journalUpdate).toBe(null);
  });

  it('removes the link-as-property row the merge created (it belongs to the restored loser again)', async () => {
    const journal = baseJournal();
    journal.evidence = { via: 'admin_link_as_property' };
    journal.repointed_ids.linked_property_id = 'prop-9';
    const { trx, state } = buildRevertTrx({
      journal,
      winner: baseWinner(),
      loser: baseLoser(),
      tables: { leads: { stillOnWinner: ['lead-1', 'lead-2'] }, invoices: { stillOnWinner: ['inv-1'] } },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' });
    expect(state.propertyDeleted).toEqual({ id: 'prop-9', customer_id: WINNER });
    expect(result.repointedBack['customer_properties.linked_property_removed']).toBe(1);
  });

  it('refuses (409) a link-as-property merge whose created property was never journaled', async () => {
    const journal = baseJournal();
    journal.evidence = { via: 'admin_link_as_property' };
    // No linked_property_id key — the post-commit journal update failed.
    const { trx, state } = buildRevertTrx({ journal, winner: baseWinner(), loser: baseLoser() });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/never recorded in the journal/) });
    expect(state.journalUpdate).toBe(null);
  });

  it('throws (rolls back) when a financial reverse-repoint moves fewer rows than verified', async () => {
    const { trx, state } = buildRevertTrx({
      journal: baseJournal(),
      winner: baseWinner(),
      loser: baseLoser(),
      tables: {
        leads: { stillOnWinner: ['lead-1', 'lead-2'] },
        // Verified as still-on-winner, but the UPDATE lands on 0 rows.
        invoices: { stillOnWinner: ['inv-1'], updateCount: 0 },
      },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/invoices changed while reverting/) });
    // Transaction rollback semantics: the journal was never stamped undone.
    expect(state.journalUpdate).toBe(null);
  });
});
