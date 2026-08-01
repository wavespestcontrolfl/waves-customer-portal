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
// Pass-through auth so the /merges revertible flag can be pinned end-to-end.
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
}));

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
    expect(recorded.stripe_derived_from).toBe(null);
    // No payment methods, no collisions — clean revertible record.
    expect(recorded.payment_method_flags).toEqual({});
    expect(recorded.collision_handlers).toEqual([]);
    // Autopay untouched and nothing deliberately nulled on the winner.
    expect(recorded.winner_autopay_before).toBe(null);
    expect(recorded.winner_prior_values).toEqual({});
    // No winner cards pre-merge — empty exemption list, still journaled.
    expect(recorded.winner_premerge_pm_ids).toEqual([]);
    // No notes folded — no note-append record.
    expect(recorded.winner_note_appends).toBe(null);
  });

  it("journals the winner's PRE-FOLD notes with the applied concatenation when the merge appends loser notes", async () => {
    const winner = {
      id: WINNER, first_name: 'Winner', last_name: 'Testcase', phone: '+15550000001',
      crm_notes: 'Winner note', technician_notes: null,
    };
    const loser = {
      id: LOSER, first_name: 'Winner', last_name: null, phone: '5550000001',
      crm_notes: 'Loser note', technician_notes: 'Gate code 0000',
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

    await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });

    const recorded = JSON.parse(state.journal.repointed_ids);
    const expectedCrm = `Winner note\n\n[From merged duplicate ${LOSER.slice(0, 8)}]: Loser note`;
    expect(recorded.winner_note_appends).toEqual({
      before: { crm_notes: 'Winner note', technician_notes: null },
      applied: { crm_notes: expectedCrm, technician_notes: 'Gate code 0000' },
    });
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

  it("journals the winner's partial address values the whole-tuple backfill overwrites", async () => {
    const winner = {
      id: WINNER, first_name: 'Winner', last_name: 'Testcase', phone: '+15550000001',
      // No street, but a stale partial address the tuple REPLACES.
      address_line1: null, address_line2: null, city: 'Sarasota', state: 'FL', zip: '34236',
    };
    const loser = {
      id: LOSER, first_name: 'Winner', last_name: null, phone: '5550000001',
      address_line1: '100 Sample St', address_line2: 'Apt 2', city: 'Bradenton', state: 'FL', zip: '34205',
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

    // The tuple still replaces wholesale (no mixed addresses)...
    expect(result.backfills).toMatchObject({
      address_line1: '100 Sample St', address_line2: 'Apt 2', city: 'Bradenton', state: 'FL', zip: '34205',
    });
    // ...and the winner's overwritten NON-EMPTY priors are journaled so the
    // undo can restore them (empty priors need no record — the generic
    // backfill-clear vacates those to null).
    const recorded = JSON.parse(state.journal.repointed_ids);
    expect(recorded.winner_prior_values).toEqual({
      city: 'Sarasota', state: 'FL', zip: '34236',
    });
  });

  it('journals the self-referral the merge deliberately cleared (winner was referred BY the loser)', async () => {
    const winner = {
      id: WINNER, first_name: 'Winner', last_name: 'Testcase', phone: '+15550000001',
      referred_by_customer_id: LOSER, // the loser referred the winner pre-merge
    };
    const loser = { id: LOSER, first_name: 'Winner', last_name: null, phone: '5550000001' };
    const state = { journal: null };
    const route = (table, q) => {
      if (table === 'customers') {
        if (q.called('forUpdate')) return [winner, loser];
        if (q.called('update')) {
          const where = q.args('where')?.[0];
          // The self-referral clear: the FK sweep moved the pointer
          // loser→winner, so this row now matches and is nulled.
          if (where && where.referred_by_customer_id === WINNER) return 1;
          return 1;
        }
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

    await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });

    const recorded = JSON.parse(state.journal.repointed_ids);
    // Without this the undo finds no row matching referred_by = winner,
    // reads drift, and the winner's referral stays permanently null.
    expect(recorded.winner_prior_values.referred_by_customer_id).toBe(LOSER);
  });

  it('journals WHICH side supplied a derived Stripe profile (stripe_derived_from)', async () => {
    const winner = { id: WINNER, first_name: 'Winner', last_name: 'Testcase', phone: '+15550000001', stripe_customer_id: null };
    const loser = { id: LOSER, first_name: 'Winner', last_name: null, phone: '5550000001', stripe_customer_id: null };
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
        if (q.called('first')) return null;
        if (q.called('select')) {
          const sel = q.args('select');
          if (sel[0] === 'stripe_customer_id') {
            // Only the LOSER's cards identify the profile.
            return q.args('where')[0].customer_id === LOSER
              ? [{ stripe_customer_id: 'cus_derived' }]
              : [];
          }
          return [];
        }
        if (q.called('update')) return 0;
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

    expect(result.backfills.stripe_customer_id).toBe('cus_derived');
    const recorded = JSON.parse(state.journal.repointed_ids);
    expect(recorded.stripe_transferred_id).toBe('cus_derived');
    // Loser cards alone identified it — the undo may restore it to the
    // split-out customer. Winner/both attributions make the undo refuse
    // when cards return on the profile.
    expect(recorded.stripe_derived_from).toBe('loser');
  });

  it('journals customer_refresh_tokens repoints BY JTI (PK override — no id column on that table)', async () => {
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
      if (table === 'customer_refresh_tokens') {
        if (q.called('update')) return 2;
        if (q.called('select')) return [{ jti: 'tok-1' }, { jti: 'tok-2' }];
      }
      if (q.called('first')) return null;
      if (q.called('update')) return 0;
      return [];
    };
    const trx = jest.fn((table) => makeChain(table, (q) => route(table, q)));
    trx.raw = jest.fn(async () => ({
      rows: [{ table_name: 'customer_refresh_tokens', column_name: 'customer_id' }],
    }));
    trx.transaction = jest.fn(async (fn) => fn(trx));
    trx.fn = { now: () => 'NOW()' };
    db.transaction.mockImplementation(async (fn) => fn(trx));

    await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });

    const recorded = JSON.parse(state.journal.repointed_ids);
    // Real jti key list — before the override this journaled { count: 2 }
    // and the undo silently left the loser's sessions winner-assigned.
    expect(recorded.tables['customer_refresh_tokens.customer_id']).toEqual(['tok-1', 'tok-2']);
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
          const sel = q.args('select');
          // stripe-profile probe vs winner-ids capture vs loser-flags capture.
          if (sel[0] === 'stripe_customer_id') return [];
          if (sel.length === 1 && sel[0] === 'id') return [{ id: 'pm-winner-own' }];
          return [{ id: 'pm-1', is_default: true, autopay_enabled: true }];
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
    // The winner's OWN pre-merge card ids journaled — the undo's new-card
    // guard exempts them (derived-profile case).
    expect(recorded.winner_premerge_pm_ids).toEqual(['pm-winner-own']);
  });
});

// ---------------------------------------------------------------------------
// countActivityRows — the untouched-merges gate (r8)
// ---------------------------------------------------------------------------

describe('countActivityRows (untouched-merges gate)', () => {
  const { countActivityRows } = dedupe._test;
  const MERGE_AT = '2026-07-30T04:00:00Z';
  const journaledIds = new Set(['j1']);

  it('counts unjournaled rows regardless of age by default; journaled rows only when updated since the merge', () => {
    const rows = [
      { id: 'j1' }, // journaled, untouched → not activity
      { id: 'j1x', updated_at: '2026-07-29T00:00:00Z' }, // unjournaled, old → activity (default)
      { id: 'new', created_at: '2026-07-30T09:00:00Z' }, // unjournaled, new → activity
    ];
    expect(countActivityRows(rows, { journaledIds, mergeAt: MERGE_AT })).toBe(2);
    // A journaled row TOUCHED after the merge is activity.
    expect(countActivityRows([{ id: 'j1', updated_at: '2026-07-30T09:00:00Z' }],
      { journaledIds, mergeAt: MERGE_AT })).toBe(1);
    // Same-transaction stamps (== mergeAt) are the merge's own writes.
    expect(countActivityRows([{ id: 'j1', updated_at: MERGE_AT }],
      { journaledIds, mergeAt: MERGE_AT })).toBe(0);
  });

  it('sinceOnly exempts unjournaled rows that predate the merge (the winner\'s own history)', () => {
    const rows = [
      { id: 'own', created_at: '2026-07-01T00:00:00Z' }, // pre-merge → exempt
      { id: 'new', created_at: '2026-07-30T09:00:00Z' }, // post-merge → activity
      { id: 'upd', created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-30T09:00:00Z' }, // old row touched → activity
    ];
    expect(countActivityRows(rows, { journaledIds, mergeAt: MERGE_AT, sinceOnly: true })).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// EMAIL_BOUND_SURFACES — fanout-registry mirror pins
// ---------------------------------------------------------------------------

describe('EMAIL_BOUND_SURFACES', () => {
  it('the newsletter probe counts PENDING subscribers too (fanout-canonical — their DOI link is a live bearer token)', () => {
    const surface = dedupe._test.EMAIL_BOUND_SURFACES.find((s) => s.table === 'newsletter_subscribers');
    expect(surface).toBeTruthy();
    const q = makeChain('newsletter_subscribers', () => []);
    surface.active(q);
    expect(q.args('whereIn')).toEqual(['status', ['active', 'pending']]);
  });
});

// ---------------------------------------------------------------------------
// revertMerge
// ---------------------------------------------------------------------------

describe('revertMerge', () => {
  const WINNER = 'bbbbbbbb-0000-0000-0000-000000000001';
  const LOSER = 'bbbbbbbb-0000-0000-0000-000000000002';
  const JOURNAL = 'cccccccc-0000-0000-0000-000000000001';

  // Which TIMESTAMP columns each table actually has, transcribed from the
  // migrations. Selecting one a table lacks raises undefined_column in
  // Postgres even when no rows match — the r9 regression (an unconditional
  // updated_at select on customer_credit_ledger) 409'd every invoice-bearing
  // merge. The stub below raises the same error, so a wrong select FAILS THE
  // SUITE instead of silently turning into a refusal.
  const TABLE_TIMESTAMPS = {
    invoices: ['created_at', 'updated_at'],
    payments: ['created_at', 'updated_at'],
    payment_methods: ['created_at', 'updated_at'],
    payment_plans: ['created_at', 'updated_at'],
    annual_prepay_terms: ['created_at', 'updated_at'],
    estimate_deposits: ['created_at', 'updated_at'],
    estimate_card_holds: ['created_at', 'updated_at'],
    scheduled_services: ['created_at', 'updated_at'],
    leads: ['created_at', 'updated_at'],
    estimates: ['created_at', 'updated_at'],
    automation_enrollments: ['created_at', 'updated_at'],
    email_template_automation_runs: ['created_at', 'updated_at'],
    notification_prefs: ['created_at', 'updated_at'],
    customer_contracts: ['created_at', 'updated_at'],
    booking_intents: ['created_at', 'updated_at'],
    newsletter_subscribers: ['created_at', 'updated_at'],
    customer_properties: ['created_at', 'updated_at'],
    customer_refresh_tokens: ['created_at', 'updated_at'],
    // created_at ONLY — the regression class.
    customer_credit_ledger: ['created_at'],
    customer_discounts: ['created_at'],
    payment_method_consents: ['created_at'],
    // updated_at ONLY (creation stamp is enrolled_at).
    referral_promoters: ['updated_at'],
    // created_at ONLY — append-only audit rows (20260511000002).
    customer_contract_events: ['created_at'],
  };
  const assertSelectableColumns = (table, q) => {
    const known = TABLE_TIMESTAMPS[table];
    if (!known) return;
    const selected = (q._calls || [])
      .filter(([name]) => name === 'select')
      .flatMap(([, args]) => args.flat());
    for (const col of selected) {
      if ((col === 'created_at' || col === 'updated_at') && !known.includes(col)) {
        const err = new Error(`column "${col}" does not exist`);
        err.code = '42703';
        throw err;
      }
    }
  };

  function buildRevertTrx({
    journal, winner, loser, tables = {}, loserEmailConflict = false, emailClaimant = null,
  }) {
    const state = {
      repointedBack: [], winnerPatch: null, loserRestore: null, journalUpdate: null,
      decremented: null, flagRestores: [], propertyDeleted: null, propertyTransferred: null,
      verified: [], rawCalls: [],
    };
    const route = (table, q) => {
      // Fails the suite on any select of a timestamp column the real table
      // does not have (the r9 regression class).
      if (q.called('select')) assertSelectableColumns(table, q);
      if (table === 'customer_merge_journal') {
        if (q.called('update')) { state.journalUpdate = q.args('update')[0]; return 1; }
        if (q.called('first')) return journal;
        return [];
      }
      if (table === 'customers') {
        if (q.called('forUpdate')) return [winner, loser].filter(Boolean);
        // The explicit email-claim check (r13): lower(email) = ? against
        // OTHER live customers. customers.email has no unique constraint,
        // so this query — not a 23505 catch — is the guard.
        if (q.called('whereRaw') && q.called('whereNotIn')) {
          state.emailClaimProbe = { where: q.args('whereRaw'), notIn: q.args('whereNotIn') };
          // The normalized-email lock must already have been taken (r14).
          state.emailClaimLockedFirst = state.rawCalls.some(([sql, bindings]) =>
            String(sql).includes('pg_advisory_xact_lock')
            && Array.isArray(bindings) && String(bindings[0]).startsWith('customer-email:'));
          return emailClaimant;
        }
        if (q.called('decrement')) { state.decremented = q.args('decrement'); return 1; }
        if (q.called('update')) {
          const whereArg = q.args('where')?.[0];
          if (whereArg && whereArg.id === winner?.id) { state.winnerPatch = q.args('update')[0]; return 1; }
          if (loserEmailConflict) {
            const e = new Error('duplicate key value violates unique constraint "customers_email_unique"');
            e.code = '23505';
            throw e;
          }
          state.loserRestore = q.args('update')[0];
          return 1;
        }
        return [];
      }
      // Row-id verification selects are the only ones using whereIn('id',…)
      // — everything else on these tables is a probe.
      const isIdVerification = q.called('whereIn') && q.args('whereIn')?.[0] === 'id';
      // Children minted by a journaled ESTIMATE (accept → hold/deposit/
      // booked visit). Checked BEFORE the scheduled_services branch below:
      // booked visits are matched by source_estimate_id, not customer_id.
      if (q.called('whereIn') && ['estimate_id', 'source_estimate_id'].includes(q.args('whereIn')?.[0])) {
        return (tables[table] && tables[table].fromEstimates) || [];
      }
      // scheduled_services has TWO probes: referencing visits (selects
      // customer_id, FOR UPDATE) and the billing-activity gate (selects
      // created_at/updated_at).
      if (table === 'scheduled_services' && q.called('select') && !isIdVerification) {
        const sel = q.args('select') || [];
        if (sel.includes('customer_id')) {
          state.visitProbe = { forUpdate: q.called('forUpdate') };
          return (tables.scheduled_services && tables.scheduled_services.referencingVisits) || [];
        }
        return (tables.scheduled_services && tables.scheduled_services.billingRows) || [];
      }
      // recipient_optin activity probe (whereIn on customer_id).
      if (table === 'recipient_optin' && q.called('select')) {
        return (tables.recipient_optin && tables.recipient_optin.rows) || [];
      }
      // Consent rows tied to returned cards (whereIn is on
      // payment_method_id, not id — still a probe).
      if (table === 'payment_method_consents' && q.called('select')) {
        return (tables.payment_method_consents && tables.payment_method_consents.rows) || [];
      }
      // Invoice-child probes: payments matches via whereRaw on the metadata
      // jsonb keys, credit-ledger via whereIn('invoice_id', …) — neither is
      // an id verification.
      if (table === 'payments' && q.called('whereRaw')) {
        return (tables.payments && tables.payments.invoiceChildren) || [];
      }
      // Invoice-child probes (credit ledger, payment plans) key on
      // invoice_id — generic so a new child probe can't dodge the stub.
      if (q.called('whereIn') && q.args('whereIn')?.[0] === 'invoice_id') {
        return (tables[table] && tables[table].invoiceChildren) || [];
      }
      // Contract-event probe keys on contract_id.
      if (q.called('whereIn') && q.args('whereIn')?.[0] === 'contract_id') {
        return (tables[table] && tables[table].fromContracts) || [];
      }
      // Invoices minted BY a journaled visit (real scheduled_service_id FK).
      if (table === 'invoices' && q.called('whereIn')
        && q.args('whereIn')?.[0] === 'scheduled_service_id') {
        return (tables.invoices && tables.invoices.mintedFromVisits) || [];
      }
      // Email-bound artifact probes — every EMAIL_BOUND_SURFACES table (the
      // fanout-registry mirror). Status filters may use whereIn — still a
      // probe, not an id verification.
      if (['leads', 'estimates', 'automation_enrollments', 'email_template_automation_runs',
        'referral_promoters', 'notification_prefs', 'customer_contracts', 'booking_intents',
        'newsletter_subscribers'].includes(table)
        && q.called('select') && !isIdVerification) {
        return (tables[table] && tables[table].emailArtifacts) || [];
      }
      if (table === 'customer_properties') {
        if (q.called('first')) {
          // The r5 lock-order read: property row FOR UPDATE before the
          // visit probe.
          state.propertyLock = { where: q.args('where')[0], forUpdate: q.called('forUpdate') };
          return { id: q.args('where')[0].id };
        }
        if (q.called('del')) { state.propertyDeleted = q.args('where')[0]; return 1; }
        if (q.called('update')) {
          state.propertyTransferred = { where: q.args('where')[0], payload: q.args('update')[0] };
          return 1;
        }
      }
      const cfg = tables[table];
      if (cfg) {
        if (q.called('sum')) {
          const whereArg = q.args('where')?.[0] || {};
          return { total: (cfg.ledgerSums || {})[whereArg.customer_id] ?? 0 };
        }
        if (q.called('update')) {
          if (q.called('whereIn')) {
            state.repointedBack.push({
              table, pk: q.args('whereIn')[0], ids: q.args('whereIn')[1], payload: q.args('update')[0],
            });
            return cfg.updateCount !== undefined ? cfg.updateCount : q.args('whereIn')[1].length;
          }
          // Non-whereIn update = the per-card flag restore.
          state.flagRestores.push({ table, where: q.args('where')[0], payload: q.args('update')[0] });
          return 1;
        }
        if (q.called('select')) {
          // Non-whereIn select = a probe (current winner cards, or the
          // billing-activity gate's rows), not a verification pass.
          if (!q.called('whereIn')) return cfg.probeRows || cfg.winnerCards || [];
          state.verified.push({ table, forUpdate: q.called('forUpdate') });
          // Rows shaped by the verification's key column ('id', or a
          // REPOINT_PK_COLUMNS override like customer_refresh_tokens.jti).
          // `verifiedRows` lets a test stamp updated_at (financial drift).
          const keyCol = q.args('whereIn')[0];
          if (cfg.verifiedRows) return cfg.verifiedRows;
          return cfg.stillOnWinner.map((v) => ({ [keyCol]: v }));
        }
      }
      return [];
    };
    const trx = jest.fn((table) => makeChain(table, (q) => route(table, q)));
    trx.transaction = jest.fn(async (fn) => fn(trx));
    trx.fn = { now: () => 'NOW()' };
    // Captures the per-customer comms advisory lock (r6).
    trx.raw = jest.fn(async (...args) => { state.rawCalls.push(args); return { rows: [] }; });
    return { trx, state };
  }

  // Clearly synthetic identity fixtures only.
  const baseJournal = () => ({
    id: JOURNAL,
    winner_customer_id: WINNER,
    loser_customer_id: LOSER,
    undone_at: null,
    created_at: '2026-07-30T04:00:00Z',
    loser_snapshot: {
      id: LOSER, first_name: 'Loser', last_name: null, phone: '5550000001',
      email: 'loser.testcase@example.com', stripe_customer_id: 'cus_only', account_credits: 0,
    },
    repointed_ids: {
      version: 1,
      tables: { 'leads.customer_id': ['lead-1', 'lead-2'], 'invoices.customer_id': ['inv-1'] },
      stripe_transferred_id: 'cus_only',
      stripe_derived_from: 'loser',
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
    // The email clear takes the per-customer comms advisory lock BEFORE
    // probing — the executor's insert path takes the same key, so a run
    // queued mid-undo blocks instead of racing the probe.
    expect(state.rawCalls.some(([sql, bindings]) => String(sql).includes('pg_advisory_xact_lock')
      && Array.isArray(bindings) && bindings[0] === `customer-comms:${WINNER}`)).toBe(true);
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
      tables: {
        payment_methods: {
          stillOnWinner: ['pm-1', 'pm-2'],
          // Every current winner card is in the journaled repointed set —
          // the post-merge-cards refusal must NOT fire (its boundary).
          winnerCards: [
            { id: 'pm-1', stripe_customer_id: 'cus_only' },
            { id: 'pm-2', stripe_customer_id: 'cus_only' },
          ],
        },
      },
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

  it("restores the winner's overwritten partial address from winner_prior_values; edited fields stay and report", async () => {
    const journal = baseJournal();
    journal.winner_backfills = {
      ...journal.winner_backfills,
      address_line1: '100 Sample St',
      address_line2: 'Apt 2',
      city: 'Bradenton',
      state: 'FL',
      zip: '34205',
    };
    journal.repointed_ids.winner_prior_values = { city: 'Sarasota', state: 'FL', zip: '34236' };
    const { trx, state } = buildRevertTrx({
      journal,
      winner: {
        ...baseWinner(),
        address_line1: '100 Sample St', // fill-if-empty backfill, unchanged → vacates to null
        address_line2: 'Apt 2',
        city: 'Bradenton', // still the merge-written value → prior RESTORED
        state: 'FL', // merge-written === prior → restored (no-op value)
        zip: '34240', // admin corrected since the merge → stays, reported
      },
      loser: baseLoser(),
      tables: { leads: { stillOnWinner: ['lead-1', 'lead-2'] }, invoices: { stillOnWinner: ['inv-1'] } },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' });
    // Tuple fields with a journaled prior RESTORE instead of nulling out —
    // the pre-r3 undo permanently lost e.g. the winner's original ZIP.
    expect(state.winnerPatch.city).toBe('Sarasota');
    expect(state.winnerPatch.state).toBe('FL');
    // No prior recorded → plain vacate.
    expect(state.winnerPatch.address_line1).toBe(null);
    expect(state.winnerPatch.address_line2).toBe(null);
    // Edited since the merge → untouched, reported.
    expect(state.winnerPatch.zip).toBeUndefined();
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'customers.zip', reason: 'winner_value_changed_since_merge' }),
    ]));
  });

  it('TRANSFERS the link-as-property row to the restored loser when appointments reference it (SET NULL FK would silently unlink them)', async () => {
    const journal = baseJournal();
    journal.evidence = { via: 'admin_link_as_property' };
    journal.repointed_ids.linked_property_id = 'prop-9';
    const { trx, state } = buildRevertTrx({
      journal,
      winner: baseWinner(),
      loser: baseLoser(),
      tables: {
        leads: { stillOnWinner: ['lead-1', 'lead-2'] },
        invoices: { stillOnWinner: ['inv-1'] },
        // The loser's own appointment (moved back with the undo) points at
        // the property — deleting would SET NULL its property_id without
        // ever erroring, so the row must transfer instead.
        scheduled_services: { referencingVisits: [{ id: 'visit-1', customer_id: LOSER }] },
      },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' });
    // Transferred, never deleted: the appointment keeps its property link
    // and the address rides back to its owner.
    expect(state.propertyDeleted).toBe(null);
    expect(state.propertyTransferred.where).toEqual({ id: 'prop-9', customer_id: WINNER });
    expect(state.propertyTransferred.payload.customer_id).toBe(LOSER);
    expect(result.repointedBack['customer_properties.linked_property_transferred']).toBe(1);
    expect(result.repointedBack['customer_properties.linked_property_removed']).toBeUndefined();
    // r5 lock order: the property row is locked FOR UPDATE before the visit
    // probe, and the probe itself locks the referencing visits — a booking
    // inserted between probe and delete/transfer must block on the property
    // lock, never slip through to be property-stripped by the SET NULL FK.
    expect(state.propertyLock).toEqual({ where: { id: 'prop-9', customer_id: WINNER }, forUpdate: true });
    expect(state.visitProbe).toEqual({ forUpdate: true });
  });

  it('refuses (409) when a WINNER-owned post-merge appointment references the linked property (transfer would strand it)', async () => {
    const journal = baseJournal();
    journal.evidence = { via: 'admin_link_as_property' };
    journal.repointed_ids.linked_property_id = 'prop-9';
    const { trx, state } = buildRevertTrx({
      journal,
      winner: baseWinner(),
      loser: baseLoser(),
      tables: {
        leads: { stillOnWinner: ['lead-1', 'lead-2'] },
        invoices: { stillOnWinner: ['inv-1'] },
        // Booked for the WINNER after the merge, absent from the journal —
        // moving the property to the loser would leave the visit's customer
        // and property on different accounts.
        scheduled_services: { referencingVisits: [{ id: 'visit-new', customer_id: WINNER }] },
      },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/appointment.*would not belong to the restored customer/) });
    // The refusal throw rolls the transaction back — journal never stamped,
    // property neither transferred nor deleted.
    expect(state.journalUpdate).toBe(null);
    expect(state.propertyTransferred).toBe(null);
    expect(state.propertyDeleted).toBe(null);
  });

  it('refuses (409) when a JOURNALED referencing visit drifted to a THIRD customer (the skip path) — the transfer would strand it', async () => {
    const journal = baseJournal();
    journal.evidence = { via: 'admin_link_as_property' };
    journal.repointed_ids.linked_property_id = 'prop-9';
    // visit-1 is journaled but no longer on the winner (rows_changed skip
    // path): the reverse repoint leaves it where it drifted, so after the
    // undo it would reference a property on someone else's account.
    journal.repointed_ids.tables['scheduled_services.customer_id'] = ['visit-1'];
    const THIRD = 'dddddddd-0000-0000-0000-000000000009';
    const { trx, state } = buildRevertTrx({
      journal,
      winner: baseWinner(),
      loser: baseLoser(),
      tables: {
        leads: { stillOnWinner: ['lead-1', 'lead-2'] },
        invoices: { stillOnWinner: ['inv-1'] },
        scheduled_services: {
          stillOnWinner: [],
          referencingVisits: [{ id: 'visit-1', customer_id: THIRD }],
        },
      },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/would not belong to the restored customer/) });
    expect(state.journalUpdate).toBe(null);
    expect(state.propertyTransferred).toBe(null);
  });

  it('still TRANSFERS when the only referencing visits are in the journaled repoint set (they move back anyway)', async () => {
    const journal = baseJournal();
    journal.evidence = { via: 'admin_link_as_property' };
    journal.repointed_ids.linked_property_id = 'prop-9';
    // visit-1 is journaled: it was the loser's, repointed by the merge, and
    // the undo moved it back BEFORE this probe runs — so it reads
    // loser-owned here and must NOT refuse the transfer.
    journal.repointed_ids.tables['scheduled_services.customer_id'] = ['visit-1'];
    const { trx, state } = buildRevertTrx({
      journal,
      winner: baseWinner(),
      loser: baseLoser(),
      tables: {
        leads: { stillOnWinner: ['lead-1', 'lead-2'] },
        invoices: { stillOnWinner: ['inv-1'] },
        scheduled_services: {
          stillOnWinner: ['visit-1'],
          referencingVisits: [{ id: 'visit-1', customer_id: LOSER }],
        },
      },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' });
    expect(state.propertyTransferred.payload.customer_id).toBe(LOSER);
    expect(result.repointedBack['customer_properties.linked_property_transferred']).toBe(1);
    expect(result.repointedBack['scheduled_services.customer_id']).toBe(1);
  });

  it("restores the DERIVED transferred Stripe id on the loser (snapshot holds null — the cards' profile was derived)", async () => {
    const journal = baseJournal();
    // Neither customer row named a profile at merge time; the loser's saved
    // cards identified cus_derived and executeMerge journaled it.
    journal.loser_snapshot.stripe_customer_id = null;
    journal.repointed_ids.stripe_transferred_id = 'cus_derived';
    journal.winner_backfills = { email: 'loser.testcase@example.com', stripe_customer_id: 'cus_derived' };
    const { trx, state } = buildRevertTrx({
      journal,
      winner: { ...baseWinner(), stripe_customer_id: 'cus_derived' },
      loser: baseLoser(),
      tables: { leads: { stillOnWinner: ['lead-1', 'lead-2'] }, invoices: { stillOnWinner: ['inv-1'] } },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' });
    expect(result.stripeMovedBack).toBe(true);
    expect(state.winnerPatch.stripe_customer_id).toBe(null);
    // The RECORDED id, not the snapshot's null — the repointed cards live
    // on cus_derived and the restored loser must own it.
    expect(state.loserRestore.stripe_customer_id).toBe('cus_derived');
  });

  it('refuses (409) when active email-bound artifacts were created on the backfilled email after the merge', async () => {
    const journal = baseJournal(); // winner_backfills.email = loser's email, unchanged on winner
    const { trx, state } = buildRevertTrx({
      journal,
      winner: baseWinner(),
      loser: baseLoser(),
      tables: {
        leads: { stillOnWinner: ['lead-1', 'lead-2'] },
        invoices: { stillOnWinner: ['inv-1'] },
        // An open estimate created post-merge delivers to the merged-in
        // email — clearing the email would orphan it.
        estimates: { emailArtifacts: [{ id: 'est-new' }] },
      },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/1 open estimate.*deliver to the merged-in email/) });
    expect(state.journalUpdate).toBe(null);
  });

  it('proceeds when the only email-bound artifacts are journaled rows (pre-merge, moving back with the undo)', async () => {
    const journal = baseJournal();
    journal.repointed_ids.tables['estimates.customer_id'] = ['est-1'];
    const { trx, state } = buildRevertTrx({
      journal,
      winner: baseWinner(),
      loser: baseLoser(),
      tables: {
        leads: { stillOnWinner: ['lead-1', 'lead-2'] },
        invoices: { stillOnWinner: ['inv-1'] },
        estimates: { stillOnWinner: ['est-1'], emailArtifacts: [{ id: 'est-1' }] },
      },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' });
    // Email cleared as before; the journaled estimate moved back to the
    // restored loser along with the email it delivers to.
    expect(state.winnerPatch.email).toBe(null);
    expect(result.repointedBack['estimates.customer_id']).toBe(1);
    expect(state.journalUpdate.undone_at).toBeTruthy();
  });

  it('refuses (409, zero writes) when a payment recorded against a journaled invoice is outside the journal', async () => {
    // The invoice was paid after the merge: the repoint loop would move the
    // invoice back to the restored customer while the payment that settled
    // it stays winner-owned (payments key on customer_id; this one is
    // unjournaled). Probed in the PRE-WRITE pass so ordering can't defeat it.
    const { trx, state } = buildRevertTrx({
      journal: baseJournal(),
      winner: baseWinner(),
      loser: baseLoser(),
      tables: {
        leads: { stillOnWinner: ['lead-1', 'lead-2'] },
        invoices: { stillOnWinner: ['inv-1'] },
        payments: { invoiceChildren: [{ id: 'pay-new' }] },
      },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/payment\(s\) recorded against this merge's invoices/) });
    // Zero writes: the refusal happened before any repoint.
    expect(state.repointedBack).toHaveLength(0);
    expect(state.journalUpdate).toBe(null);
  });

  it('refuses when a credit-ledger entry outside the journal keys on a journaled invoice', async () => {
    const { trx, state } = buildRevertTrx({
      journal: baseJournal(),
      winner: baseWinner(),
      loser: baseLoser(),
      tables: {
        leads: { stillOnWinner: ['lead-1', 'lead-2'] },
        invoices: { stillOnWinner: ['inv-1'] },
        customer_credit_ledger: { invoiceChildren: [{ id: 'led-new' }] },
      },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/credit-ledger entr\(ies\) recorded against this merge's invoices/) });
    expect(state.repointedBack).toHaveLength(0);
  });

  it("a clean journaled invoice (no unjournaled children, untouched) still reverts", async () => {
    const journal = baseJournal();
    journal.repointed_ids.tables['payments.customer_id'] = ['pay-1'];
    const { trx, state } = buildRevertTrx({
      journal,
      winner: baseWinner(),
      loser: baseLoser(),
      tables: {
        leads: { stillOnWinner: ['lead-1', 'lead-2'] },
        invoices: { stillOnWinner: ['inv-1'] },
        // The only child payment is the journaled one — it moves back with
        // the invoice, so nothing is separated.
        payments: { stillOnWinner: ['pay-1'], invoiceChildren: [{ id: 'pay-1' }] },
      },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' });
    expect(result.repointedBack['invoices.customer_id']).toBe(1);
    expect(result.repointedBack['payments.customer_id']).toBe(1);
    expect(state.journalUpdate.undone_at).toBeTruthy();
  });

  it('refuses when a JOURNALED financial row itself was updated since the merge (drift on state about to move back)', async () => {
    const { trx, state } = buildRevertTrx({
      journal: baseJournal(),
      winner: baseWinner(),
      loser: baseLoser(),
      tables: {
        leads: { stillOnWinner: ['lead-1', 'lead-2'] },
        invoices: {
          stillOnWinner: ['inv-1'],
          // Still winner-owned, but touched after the merge (04:00).
          verifiedRows: [{ id: 'inv-1', updated_at: '2026-07-30T09:00:00Z' }],
        },
      },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/invoices row\(s\) recorded by this merge were updated after it/) });
    expect(state.repointedBack).toHaveLength(0);
    expect(state.journalUpdate).toBe(null);
  });

  it("restores the winner's self-referral cleared by the merge; an operator-set referrer stays and reports", async () => {
    const journal = baseJournal();
    journal.repointed_ids.winner_prior_values = { referred_by_customer_id: LOSER };
    const ok = buildRevertTrx({
      journal,
      winner: { ...baseWinner(), referred_by_customer_id: null }, // still the merge-written null
      loser: baseLoser(),
      tables: { leads: { stillOnWinner: ['lead-1', 'lead-2'] }, invoices: { stillOnWinner: ['inv-1'] } },
    });
    db.transaction.mockImplementation(async (fn) => fn(ok.trx));
    await dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' });
    // The winner was referred BY the loser pre-merge — that link comes back.
    expect(ok.state.winnerPatch.referred_by_customer_id).toBe(LOSER);

    // An operator set a different referrer since: leave it, report it.
    jest.clearAllMocks();
    const THIRD = 'dddddddd-0000-0000-0000-000000000009';
    const edited = buildRevertTrx({
      journal: JSON.parse(JSON.stringify(journal)),
      winner: { ...baseWinner(), referred_by_customer_id: THIRD },
      loser: baseLoser(),
      tables: { leads: { stillOnWinner: ['lead-1', 'lead-2'] }, invoices: { stillOnWinner: ['inv-1'] } },
    });
    db.transaction.mockImplementation(async (fn) => fn(edited.trx));
    const result = await dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' });
    expect(edited.state.winnerPatch.referred_by_customer_id).toBeUndefined();
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'customers.referred_by_customer_id', reason: 'winner_value_changed_since_merge' }),
    ]));
  });

  it('REGRESSION: probes select only timestamp columns the table actually has (credit ledger has no updated_at)', async () => {
    // r9 selected updated_at from customer_credit_ledger unconditionally.
    // Postgres raises undefined_column even with zero matching rows, the
    // probe's catch turned it into a 409, and EVERY invoice-bearing merge
    // became non-revertible. The stub raises the same error, so this
    // reverts cleanly only while each probe respects the per-table map.
    const journal = baseJournal();
    journal.repointed_ids.tables['customer_credit_ledger.customer_id'] = ['led-1'];
    journal.repointed_ids.tables['customer_discounts.customer_id'] = ['disc-1'];
    const { trx, state } = buildRevertTrx({
      journal,
      winner: baseWinner(),
      loser: baseLoser(),
      tables: {
        leads: { stillOnWinner: ['lead-1', 'lead-2'] },
        invoices: { stillOnWinner: ['inv-1'] },
        // Directly journaled rows on both created_at-only financial tables:
        // the generic verifier had the same defect.
        customer_credit_ledger: { stillOnWinner: ['led-1'], ledgerSums: { [WINNER]: 0, [LOSER]: 0 } },
        customer_discounts: { stillOnWinner: ['disc-1'] },
      },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' });
    expect(result.repointedBack['customer_credit_ledger.customer_id']).toBe(1);
    expect(result.repointedBack['customer_discounts.customer_id']).toBe(1);
    expect(state.journalUpdate.undone_at).toBeTruthy();
  });

  it('refuses when a journaled VISIT minted an invoice after the merge (completion billing)', async () => {
    const journal = baseJournal();
    journal.repointed_ids.tables['scheduled_services.customer_id'] = ['visit-1'];
    const { trx, state } = buildRevertTrx({
      journal,
      winner: baseWinner(),
      loser: baseLoser(),
      tables: {
        leads: { stillOnWinner: ['lead-1', 'lead-2'] },
        invoices: {
          stillOnWinner: ['inv-1'],
          // Billed from the moved visit AFTER the merge, unjournaled:
          // invoices.scheduled_service_id is a real column (20260420000002).
          mintedFromVisits: [{ id: 'inv-minted', created_at: '2026-07-30T09:00:00Z' }],
        },
        scheduled_services: { stillOnWinner: ['visit-1'] },
      },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/invoice\(s\) billed from this merge's appointments/) });
    expect(state.repointedBack).toHaveLength(0);
    expect(state.journalUpdate).toBe(null);
  });

  it('refuses when a JOURNALED VISIT itself was updated since the merge (completion is an update)', async () => {
    const journal = baseJournal();
    journal.repointed_ids.tables['scheduled_services.customer_id'] = ['visit-1'];
    const { trx, state } = buildRevertTrx({
      journal,
      winner: baseWinner(),
      loser: baseLoser(),
      tables: {
        leads: { stillOnWinner: ['lead-1', 'lead-2'] },
        invoices: { stillOnWinner: ['inv-1'] },
        scheduled_services: {
          stillOnWinner: ['visit-1'],
          verifiedRows: [{ id: 'visit-1', updated_at: '2026-07-30T09:00:00Z' }],
        },
      },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/scheduled_services row\(s\) recorded by this merge were updated after it/) });
    expect(state.journalUpdate).toBe(null);
  });

  it('refuses when the transferred Stripe profile was CHARGED since the merge (no new card involved)', async () => {
    // A loser-only profile transferred to a card-less winner can still be
    // invoiced and paid on that profile — no payment_methods row is ever
    // written, so the new-card guard sees nothing while the profile
    // accumulates the KEPT customer's transaction history.
    const journal = baseJournal(); // stripe_transferred_id 'cus_only', still on winner
    const { trx, state } = buildRevertTrx({
      journal,
      winner: baseWinner(),
      loser: baseLoser(),
      tables: {
        leads: { stillOnWinner: ['lead-1', 'lead-2'] },
        invoices: {
          stillOnWinner: ['inv-1'],
          // inv-1 is journaled (the loser's, moving back); inv-charged was
          // raised on the kept customer after the merge.
          probeRows: [{ id: 'inv-1' }, { id: 'inv-charged', created_at: '2026-07-30T09:00:00Z' }],
        },
      },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/while it held the transferred Stripe profile/) });
    expect(state.repointedBack).toHaveLength(0);
    expect(state.journalUpdate).toBe(null);
  });

  it("a transferred profile with only PRE-MERGE winner billing still reverts (sinceOnly)", async () => {
    const journal = baseJournal();
    const { trx, state } = buildRevertTrx({
      journal,
      winner: baseWinner(),
      loser: baseLoser(),
      tables: {
        leads: { stillOnWinner: ['lead-1', 'lead-2'] },
        invoices: {
          stillOnWinner: ['inv-1'],
          probeRows: [{ id: 'inv-own', created_at: '2026-07-01T00:00:00Z' }],
        },
      },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' });
    expect(result.stripeMovedBack).toBe(true);
    expect(state.journalUpdate.undone_at).toBeTruthy();
  });

  it('refuses when a NEW recipient_optin row appeared since the merge (a missing row reads as "allowed to text")', async () => {
    const { trx, state } = buildRevertTrx({
      journal: baseJournal(),
      winner: baseWinner(),
      loser: baseLoser(),
      tables: {
        leads: { stillOnWinner: ['lead-1', 'lead-2'] },
        invoices: { stillOnWinner: ['inv-1'] },
        // Composite PK (customer_id, phone_key) — never journalable
        // per-row, so time is the only signal. Created after the merge.
        recipient_optin: { rows: [{ customer_id: WINNER, created_at: '2026-07-30T09:00:00Z' }] },
      },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/recipient opt-in record\(s\) were created or updated since the merge/) });
    expect(state.repointedBack).toHaveLength(0);
    expect(state.journalUpdate).toBe(null);
  });

  it("the winner's own PRE-MERGE opt-in rows do not block the undo", async () => {
    const { trx, state } = buildRevertTrx({
      journal: baseJournal(),
      winner: baseWinner(),
      loser: baseLoser(),
      tables: {
        leads: { stillOnWinner: ['lead-1', 'lead-2'] },
        invoices: { stillOnWinner: ['inv-1'] },
        recipient_optin: { rows: [{ customer_id: WINNER, created_at: '2026-07-01T00:00:00Z' }] },
      },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' });
    expect(result.skipped).toHaveLength(0);
    expect(state.journalUpdate.undone_at).toBeTruthy();
  });

  it('refuses when a payment PLAN was created against a journaled invoice after the merge (plan creation never touches the invoice)', async () => {
    // admin-invoices locks but does not UPDATE the invoice when creating a
    // plan, so neither the invoice-drift check nor payment_plans' own
    // financial membership sees it — yet the plan governs the invoice's
    // collection path wherever the invoice lands after the undo.
    const { trx, state } = buildRevertTrx({
      journal: baseJournal(),
      winner: baseWinner(),
      loser: baseLoser(),
      tables: {
        leads: { stillOnWinner: ['lead-1', 'lead-2'] },
        invoices: { stillOnWinner: ['inv-1'] },
        payment_plans: { invoiceChildren: [{ id: 'plan-new', created_at: '2026-07-30T09:00:00Z' }] },
      },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/payment plan\(s\) recorded against this merge's invoices/) });
    expect(state.repointedBack).toHaveLength(0);
    expect(state.journalUpdate).toBe(null);
  });

  it('refuses when a journaled CONTRACT was signed/cancelled after the merge (terminal transitions are activity)', async () => {
    const journal = baseJournal();
    journal.repointed_ids.tables['customer_contracts.customer_id'] = ['ct-1'];
    const { trx, state } = buildRevertTrx({
      journal,
      winner: baseWinner(),
      loser: baseLoser(),
      tables: {
        leads: { stillOnWinner: ['lead-1', 'lead-2'] },
        invoices: { stillOnWinner: ['inv-1'] },
        customer_contracts: {
          stillOnWinner: ['ct-1'],
          // Signed after the merge — the terminal transition updates the row
          // (and the identity-surface probes exclude terminal statuses, so
          // only this activity check can see it).
          verifiedRows: [{ id: 'ct-1', updated_at: '2026-07-30T09:00:00Z' }],
        },
      },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/customer_contracts row\(s\) recorded by this merge were updated after it/) });
    expect(state.repointedBack).toHaveLength(0);
    expect(state.journalUpdate).toBe(null);
  });

  it('refuses on unjournaled contract EVENTS keyed to a journaled contract (the audit trail of a post-merge signing)', async () => {
    const journal = baseJournal();
    journal.repointed_ids.tables['customer_contracts.customer_id'] = ['ct-1'];
    const { trx, state } = buildRevertTrx({
      journal,
      winner: baseWinner(),
      loser: baseLoser(),
      tables: {
        leads: { stillOnWinner: ['lead-1', 'lead-2'] },
        invoices: { stillOnWinner: ['inv-1'] },
        customer_contracts: { stillOnWinner: ['ct-1'] },
        customer_contract_events: { fromContracts: [{ id: 'ev-new', created_at: '2026-07-30T09:00:00Z' }] },
      },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/contract event\(s\) recorded against this merge's contracts/) });
    expect(state.journalUpdate).toBe(null);
  });

  it('a journaled contract with only its own journaled events still reverts', async () => {
    const journal = baseJournal();
    journal.repointed_ids.tables['customer_contracts.customer_id'] = ['ct-1'];
    journal.repointed_ids.tables['customer_contract_events.customer_id'] = ['ev-1'];
    const { trx, state } = buildRevertTrx({
      journal,
      winner: baseWinner(),
      loser: baseLoser(),
      tables: {
        leads: { stillOnWinner: ['lead-1', 'lead-2'] },
        invoices: { stillOnWinner: ['inv-1'] },
        customer_contracts: { stillOnWinner: ['ct-1'] },
        customer_contract_events: {
          stillOnWinner: ['ev-1'],
          fromContracts: [{ id: 'ev-1', created_at: '2026-07-01T00:00:00Z' }],
        },
      },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' });
    expect(result.repointedBack['customer_contracts.customer_id']).toBe(1);
    expect(state.journalUpdate.undone_at).toBeTruthy();
  });

  it('refuses when a journaled ESTIMATE was accepted after the merge (its updated_at moved)', async () => {
    const journal = baseJournal();
    journal.repointed_ids.tables['estimates.customer_id'] = ['est-1'];
    const { trx, state } = buildRevertTrx({
      journal,
      winner: baseWinner(),
      loser: baseLoser(),
      tables: {
        leads: { stillOnWinner: ['lead-1', 'lead-2'] },
        invoices: { stillOnWinner: ['inv-1'] },
        estimates: {
          stillOnWinner: ['est-1'],
          verifiedRows: [{ id: 'est-1', updated_at: '2026-07-30T09:00:00Z' }],
        },
      },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/estimates row\(s\) recorded by this merge were updated after it/) });
    expect(state.repointedBack).toHaveLength(0);
    expect(state.journalUpdate).toBe(null);
  });

  it("refuses on each unjournaled child an accepted estimate mints (card hold, deposit, booked visit)", async () => {
    // No email/name/billing backfill is being cleared here — only these
    // probes stand between the undo and a split-apart acceptance.
    const cases = [
      ['estimate_card_holds', 'card hold\\(s\\)'],
      ['estimate_deposits', 'deposit\\(s\\)'],
      ['scheduled_services', 'booked appointment\\(s\\)'],
    ];
    for (const [table, label] of cases) {
      jest.clearAllMocks();
      const journal = baseJournal();
      journal.repointed_ids.tables['estimates.customer_id'] = ['est-1'];
      const { trx, state } = buildRevertTrx({
        journal,
        winner: baseWinner(),
        loser: baseLoser(),
        tables: {
          leads: { stillOnWinner: ['lead-1', 'lead-2'] },
          invoices: { stillOnWinner: ['inv-1'] },
          estimates: { stillOnWinner: ['est-1'] },
          [table]: { fromEstimates: [{ id: `${table}-new`, created_at: '2026-07-30T09:00:00Z' }] },
        },
      });
       
      db.transaction.mockImplementation(async (fn) => fn(trx));
      await expect(dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' }))
        .rejects.toMatchObject({
          statusCode: 409,
          message: expect.stringMatching(new RegExp(`${label} created from this merge's estimates`)),
        });
      expect(state.repointedBack).toHaveLength(0);
      expect(state.journalUpdate).toBe(null);
    }
  });

  it('a journaled estimate with no unjournaled children still reverts', async () => {
    const journal = baseJournal();
    journal.repointed_ids.tables['estimates.customer_id'] = ['est-1'];
    const { trx, state } = buildRevertTrx({
      journal,
      winner: baseWinner(),
      loser: baseLoser(),
      tables: {
        leads: { stillOnWinner: ['lead-1', 'lead-2'] },
        invoices: { stillOnWinner: ['inv-1'] },
        estimates: { stillOnWinner: ['est-1'] },
      },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' });
    expect(result.repointedBack['estimates.customer_id']).toBe(1);
    expect(state.journalUpdate.undone_at).toBeTruthy();
  });

  it('refuses clearing an inherited NAME backfill when name-bearing surfaces show activity (email untouched)', async () => {
    const journal = baseJournal();
    // The winner kept its OWN email — only the name was inherited, so the
    // email guard never fires and the name surfaces need their own pass.
    journal.winner_backfills = { first_name: 'Loser', last_name: 'Testcase' };
    const { trx, state } = buildRevertTrx({
      journal,
      winner: { ...baseWinner(), first_name: 'Loser', last_name: 'Testcase', email: 'winner.own@example.com' },
      loser: baseLoser(),
      tables: {
        leads: { stillOnWinner: ['lead-1', 'lead-2'] },
        invoices: { stillOnWinner: ['inv-1'] },
        // A queued template send whose stored payload renders the greeting
        // from the inherited name (customer-contact-fanout's registry).
        email_template_automation_runs: { emailArtifacts: [{ id: 'run-new' }] },
      },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/queued template send\(s\).*addressed to the merged-in name/) });
    expect(state.journalUpdate).toBe(null);
  });

  it('clears an inherited name normally when the name surfaces are quiet', async () => {
    const journal = baseJournal();
    journal.winner_backfills = { first_name: 'Loser' };
    const { trx, state } = buildRevertTrx({
      journal,
      winner: { ...baseWinner(), first_name: 'Loser', email: 'winner.own@example.com' },
      loser: baseLoser(),
      tables: { leads: { stillOnWinner: ['lead-1', 'lead-2'] }, invoices: { stillOnWinner: ['inv-1'] } },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' });
    expect(state.winnerPatch.first_name).toBe(null);
    expect(result.skipped).toHaveLength(0);
  });

  it('refuses when a JOURNALED email-bound row was UPDATED since the merge (activity on state about to move back)', async () => {
    const journal = baseJournal();
    journal.repointed_ids.tables['estimates.customer_id'] = ['est-1'];
    const { trx } = buildRevertTrx({
      journal,
      winner: baseWinner(),
      loser: baseLoser(),
      tables: {
        leads: { stillOnWinner: ['lead-1', 'lead-2'] },
        invoices: { stillOnWinner: ['inv-1'] },
        estimates: {
          stillOnWinner: ['est-1'],
          // Journaled, but touched after the merge (created 07-30 04:00).
          emailArtifacts: [{ id: 'est-1', updated_at: '2026-07-30T09:00:00Z' }],
        },
      },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/1 open estimate.*deliver to the merged-in email/) });
  });

  it('refuses on an OLD unjournaled email-bound row — soft-pointer writers update in place, so age proves nothing', async () => {
    const journal = baseJournal();
    const { trx } = buildRevertTrx({
      journal,
      winner: baseWinner(),
      loser: baseLoser(),
      tables: {
        leads: { stillOnWinner: ['lead-1', 'lead-2'] },
        invoices: { stillOnWinner: ['inv-1'] },
        // Pre-merge created_at (07-01) — the r4 created_at cut would have
        // let this slide even though /capture-intent can have re-pointed
        // its contact fields at the merged-in email afterwards.
        booking_intents: { emailArtifacts: [{ id: 'bi-old', created_at: '2026-07-01T00:00:00Z' }] },
      },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/pending booking follow-up.*deliver to the merged-in email/) });
  });

  it("refuses (409, zero writes) when a THIRD live customer holds the loser's email — explicit check, not a unique violation", async () => {
    // customers.email has NO unique constraint (20260417000010 dropped
    // customers_email_unique; 20260504000008 replaced it with a NON-unique
    // index), so the pre-r13 23505 catch could never fire — the stub
    // therefore raises NO error here and the refusal must come from the
    // explicit claim query alone.
    const { trx, state } = buildRevertTrx({
      journal: baseJournal(),
      winner: baseWinner(),
      loser: baseLoser(),
      tables: { leads: { stillOnWinner: ['lead-1', 'lead-2'] }, invoices: { stillOnWinner: ['inv-1'] } },
      emailClaimant: { id: 'dddddddd-0000-0000-0000-000000000009' },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/email address is now used by another live customer/) });
    // Zero writes: no partial restoration, journal never stamped.
    expect(state.loserRestore).toBe(null);
    expect(state.journalUpdate).toBe(null);
    // The probe excludes BOTH merge participants — the winner holds the
    // address only because this merge backfilled it.
    expect(state.emailClaimProbe.notIn[1]).toEqual([LOSER, WINNER]);
  });

  it('refuses (409, zero writes) when the winner spent below a cache-only credit the merge moved', async () => {
    // Legacy/cache-only balance (no ledger rows journaled): the winner has
    // since spent below it, so the loser cannot be revived WITH its credit.
    // Reporting a skip used to complete the undo — reviving the customer
    // without its money while the remainder stayed on the winner.
    const journal = baseJournal();
    journal.loser_snapshot.account_credits = 25.5;
    const { trx, state } = buildRevertTrx({
      journal,
      winner: { ...baseWinner(), account_credits: 10 }, // below the 25.50 moved
      loser: baseLoser(),
      tables: { leads: { stillOnWinner: ['lead-1', 'lead-2'] }, invoices: { stillOnWinner: ['inv-1'] } },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/balance has fallen below the credit this merge moved/) });
    expect(state.loserRestore).toBe(null);
    expect(state.journalUpdate).toBe(null);
  });

  it('restores a cache-only credit normally when the winner still holds it', async () => {
    const journal = baseJournal();
    journal.loser_snapshot.account_credits = 25.5;
    const { trx, state } = buildRevertTrx({
      journal,
      winner: { ...baseWinner(), account_credits: 65.5 },
      loser: baseLoser(),
      tables: { leads: { stillOnWinner: ['lead-1', 'lead-2'] }, invoices: { stillOnWinner: ['inv-1'] } },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' });
    expect(result.creditsMovedBack).toBe(25.5);
    expect(state.loserRestore.account_credits).toBe(25.5);
    expect(state.decremented).toEqual(['account_credits', 25.5]);
  });

  it('takes the normalized-email advisory lock BEFORE the claim check (serializes against email writers)', async () => {
    const { trx, state } = buildRevertTrx({
      journal: baseJournal(),
      winner: baseWinner(),
      loser: baseLoser(),
      tables: { leads: { stillOnWinner: ['lead-1', 'lead-2'] }, invoices: { stillOnWinner: ['inv-1'] } },
      emailClaimant: null,
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' });
    // customers.email has no unique constraint, so only this shared lock
    // keeps the claim check honest between its read and the commit. Same
    // key derivation as the Customer 360 edit and the IB update_customer
    // tool: 'customer-email:' || lower(trim(email)).
    const lockCall = state.rawCalls.find(([sql, bindings]) => String(sql).includes('pg_advisory_xact_lock')
      && Array.isArray(bindings) && String(bindings[0]).startsWith('customer-email:'));
    expect(lockCall).toBeTruthy();
    expect(lockCall[1][0]).toBe('customer-email:loser.testcase@example.com');
    // ORDERING: the lock is taken BEFORE the claim probe runs.
    const lockIdx = state.rawCalls.indexOf(lockCall);
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(state.emailClaimProbe).toBeTruthy();
    expect(state.emailClaimLockedFirst).toBe(true);
  });

  it('restores normally when nobody else claims the email (the claim probe finds no row)', async () => {
    const { trx, state } = buildRevertTrx({
      journal: baseJournal(),
      winner: baseWinner(),
      loser: baseLoser(),
      tables: { leads: { stillOnWinner: ['lead-1', 'lead-2'] }, invoices: { stillOnWinner: ['inv-1'] } },
      emailClaimant: null,
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' });
    expect(state.loserRestore.email).toBe('loser.testcase@example.com');
    expect(state.journalUpdate.undone_at).toBeTruthy();
    expect(result.skipped).toHaveLength(0);
  });

  it('still refuses if a unique constraint is ever restored (belt-and-braces 23505 path)', async () => {
    const { trx, state } = buildRevertTrx({
      journal: baseJournal(),
      winner: baseWinner(),
      loser: baseLoser(),
      tables: { leads: { stillOnWinner: ['lead-1', 'lead-2'] }, invoices: { stillOnWinner: ['inv-1'] } },
      loserEmailConflict: true, // simulates a re-added unique index
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/email address is now used by another live customer/) });
    expect(state.journalUpdate).toBe(null);
  });

  it('refuses billing-identity clears when winner billing artifacts were created/updated since the merge (activity gate)', async () => {
    const journal = baseJournal();
    // No transferred Stripe profile here — this pins the BILLING-IDENTITY
    // gate specifically, isolated from the r12 charged-profile refusal
    // (which would otherwise fire first on the same probe rows).
    journal.repointed_ids.stripe_transferred_id = null;
    journal.repointed_ids.stripe_derived_from = null;
    journal.winner_backfills = { billing_mode: 'per_application', per_application_fee: '65.00' };
    const { trx, state } = buildRevertTrx({
      journal,
      winner: { ...baseWinner(), billing_mode: 'per_application', per_application_fee: '65.00' },
      loser: baseLoser(),
      tables: {
        leads: { stillOnWinner: ['lead-1', 'lead-2'] },
        invoices: {
          stillOnWinner: ['inv-1'],
          // inv-1 is journaled and untouched; inv-new was created after the
          // merge under the inherited billing identity.
          probeRows: [{ id: 'inv-1' }, { id: 'inv-new', created_at: '2026-07-30T09:00:00Z' }],
        },
      },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/invoices row\(s\) were created or updated since the merge/) });
    expect(state.journalUpdate).toBe(null);
  });

  it("winner's own PRE-MERGE billing artifacts do not block the clear (sinceOnly) — the gate targets post-merge activity", async () => {
    const journal = baseJournal();
    journal.winner_backfills = { ...journal.winner_backfills, payer_id: 5 };
    const { trx, state } = buildRevertTrx({
      journal,
      winner: { ...baseWinner(), payer_id: 5 },
      loser: baseLoser(),
      tables: {
        leads: { stillOnWinner: ['lead-1', 'lead-2'] },
        invoices: {
          stillOnWinner: ['inv-1'],
          // Unjournaled but created BEFORE the merge — the winner's own
          // history under its own identity.
          probeRows: [{ id: 'inv-own', created_at: '2026-07-01T00:00:00Z' }],
        },
      },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' });
    expect(state.winnerPatch.payer_id).toBe(null);
    expect(result.skipped).toHaveLength(0);
  });

  it('refuses (409) on unjournaled payment_method_consents tied to a returned card; journaled consents pass', async () => {
    const journal = baseJournal();
    journal.repointed_ids.tables['payment_methods.customer_id'] = ['pm-1'];
    journal.repointed_ids.payment_method_flags = { 'pm-1': { is_default: false, autopay_enabled: false } };
    const cfgWith = (consentRows, extraTables = {}) => ({
      journal: JSON.parse(JSON.stringify(journal)),
      winner: baseWinner(),
      loser: baseLoser(),
      tables: {
        leads: { stillOnWinner: ['lead-1', 'lead-2'] },
        invoices: { stillOnWinner: ['inv-1'] },
        payment_methods: {
          stillOnWinner: ['pm-1'],
          winnerCards: [{ id: 'pm-1', stripe_customer_id: 'cus_only' }],
        },
        payment_method_consents: { rows: consentRows },
        ...extraTables,
      },
    });
    // Unjournaled consent captured post-merge for the winner on the card →
    // refuse (immutable authorization bound to customer+method).
    const bad = buildRevertTrx(cfgWith([{ id: 'cons-new' }]));
    db.transaction.mockImplementation(async (fn) => fn(bad.trx));
    await expect(dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/consent record\(s\) tied to the returned card/) });
    expect(bad.state.journalUpdate).toBe(null);

    // The loser's own journaled consent moves back with everything else.
    jest.clearAllMocks();
    const okCfg = cfgWith([{ id: 'cons-1' }]);
    okCfg.journal.repointed_ids.tables['payment_method_consents.customer_id'] = ['cons-1'];
    okCfg.tables.payment_method_consents.rows = [{ id: 'cons-1' }];
    okCfg.tables.payment_method_consents.stillOnWinner = ['cons-1'];
    const ok = buildRevertTrx(okCfg);
    db.transaction.mockImplementation(async (fn) => fn(ok.trx));
    const result = await dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' });
    expect(result.repointedBack['payment_methods.customer_id']).toBe(1);
    expect(ok.state.journalUpdate.undone_at).toBeTruthy();
  });

  it('Stripe derivation side attribution: winner/both-derived stays with the winner; returned cards on it REFUSE; pre-upgrade journals with cards REFUSE', async () => {
    const build = (derivedFrom, { withCards = true, deleteKey = false } = {}) => {
      const journal = baseJournal();
      journal.loser_snapshot.stripe_customer_id = null;
      journal.repointed_ids.stripe_transferred_id = 'cus_derived';
      journal.winner_backfills = { stripe_customer_id: 'cus_derived' };
      if (deleteKey) delete journal.repointed_ids.stripe_derived_from;
      else journal.repointed_ids.stripe_derived_from = derivedFrom;
      if (withCards) {
        journal.repointed_ids.tables['payment_methods.customer_id'] = ['pm-1'];
        journal.repointed_ids.payment_method_flags = { 'pm-1': { is_default: false, autopay_enabled: false } };
      }
      return buildRevertTrx({
        journal,
        winner: { ...baseWinner(), email: null, stripe_customer_id: 'cus_derived' },
        loser: baseLoser(),
        tables: {
          leads: { stillOnWinner: ['lead-1', 'lead-2'] },
          invoices: { stillOnWinner: ['inv-1'] },
          ...(withCards ? {
            payment_methods: {
              stillOnWinner: ['pm-1'],
              winnerCards: [{ id: 'pm-1', stripe_customer_id: 'cus_derived' }],
            },
          } : {}),
        },
      });
    };
    // winner-derived + returned cards → refuse.
    const w = build('winner');
    db.transaction.mockImplementation(async (fn) => fn(w.trx));
    await expect(dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/identified from the kept customer's own saved cards/) });

    // both-derived is winner-involved (conservative) → same refusal.
    jest.clearAllMocks();
    const b = build('both');
    db.transaction.mockImplementation(async (fn) => fn(b.trx));
    await expect(dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' }))
      .rejects.toMatchObject({ statusCode: 409 });

    // winner-derived with NO returned cards: the id stays with the winner
    // (skip-reported), the loser restores without it.
    jest.clearAllMocks();
    const noCards = build('winner', { withCards: false });
    db.transaction.mockImplementation(async (fn) => fn(noCards.trx));
    const result = await dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' });
    expect(result.stripeMovedBack).toBe(false);
    expect(noCards.state.winnerPatch?.stripe_customer_id).toBeUndefined();
    expect(noCards.state.loserRestore.stripe_customer_id).toBeUndefined();
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'customers.stripe_customer_id', reason: 'stripe_profile_winner_derived' }),
    ]));

    // Pre-upgrade journal (no stripe_derived_from) + returned cards →
    // attribution unknowable → refuse.
    jest.clearAllMocks();
    const pre = build(null, { deleteKey: true });
    db.transaction.mockImplementation(async (fn) => fn(pre.trx));
    await expect(dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/predates Stripe-derivation records/) });
  });

  it('refuses (409, zero writes) when NEW payment methods joined the transferred Stripe profile after the merge', async () => {
    // The transferred id still sits on the winner, but a card NOT in the
    // journaled repointed set is attached to it — moving the profile back
    // to the loser would strand the winner-owned card. Refuse whole.
    const journal = baseJournal();
    journal.repointed_ids.tables = { 'payment_methods.customer_id': ['pm-1'] };
    journal.repointed_ids.payment_method_flags = { 'pm-1': { is_default: true, autopay_enabled: true } };
    const { trx, state } = buildRevertTrx({
      journal,
      winner: baseWinner(), // stripe_customer_id 'cus_only' === transferred
      loser: baseLoser(),
      tables: {
        payment_methods: {
          stillOnWinner: ['pm-1'],
          winnerCards: [
            { id: 'pm-1', stripe_customer_id: 'cus_only' }, // journaled — fine
            { id: 'pm-new', stripe_customer_id: 'cus_only' }, // saved post-merge — refuse
          ],
        },
      },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/new payment method.*strand/) });
    expect(state.repointedBack).toHaveLength(0);
    expect(state.flagRestores).toHaveLength(0);
    expect(state.journalUpdate).toBe(null);
  });

  it("exempts the winner's OWN pre-merge cards from the new-card refusal (derived-profile case) — but a genuinely new card still refuses", async () => {
    const journal = baseJournal();
    journal.loser_snapshot.stripe_customer_id = null;
    journal.repointed_ids.stripe_transferred_id = 'cus_derived';
    journal.repointed_ids.tables = { 'payment_methods.customer_id': ['pm-1'] };
    journal.repointed_ids.payment_method_flags = { 'pm-1': { is_default: false, autopay_enabled: false } };
    journal.repointed_ids.winner_premerge_pm_ids = ['pm-w1'];
    journal.winner_backfills = { email: 'loser.testcase@example.com', stripe_customer_id: 'cus_derived' };
    const winnerCfg = (cards) => ({
      journal,
      winner: { ...baseWinner(), stripe_customer_id: 'cus_derived' },
      loser: baseLoser(),
      tables: { payment_methods: { stillOnWinner: ['pm-1'], winnerCards: cards } },
    });
    // The winner's own pre-merge card on the derived profile: the undo
    // returns the winner to exactly its pre-merge state — revertible.
    const ok = buildRevertTrx(winnerCfg([
      { id: 'pm-1', stripe_customer_id: 'cus_derived' },
      { id: 'pm-w1', stripe_customer_id: 'cus_derived' },
    ]));
    db.transaction.mockImplementation(async (fn) => fn(ok.trx));
    const result = await dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' });
    expect(result.repointedBack['payment_methods.customer_id']).toBe(1);
    expect(ok.state.journalUpdate.undone_at).toBeTruthy();

    // A card that is neither journaled nor pre-merge — saved after the
    // merge — still refuses.
    jest.clearAllMocks();
    const bad = buildRevertTrx(winnerCfg([
      { id: 'pm-1', stripe_customer_id: 'cus_derived' },
      { id: 'pm-w1', stripe_customer_id: 'cus_derived' },
      { id: 'pm-new', stripe_customer_id: 'cus_derived' },
    ]));
    db.transaction.mockImplementation(async (fn) => fn(bad.trx));
    await expect(dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/new payment method/) });
    expect(bad.state.journalUpdate).toBe(null);
  });

  it("restores the loser's SHARED Stripe id from the snapshot when nothing was transferred (both rows named the same profile)", async () => {
    const journal = baseJournal();
    // Shared profile: no transfer recorded; the retire cleared the loser's
    // copy and the winner keeps the profile.
    journal.repointed_ids.stripe_transferred_id = null;
    journal.loser_snapshot.stripe_customer_id = 'cus_shared';
    journal.winner_backfills = { email: 'loser.testcase@example.com' };
    const { trx, state } = buildRevertTrx({
      journal,
      winner: { ...baseWinner(), stripe_customer_id: 'cus_shared' },
      loser: baseLoser(),
      tables: { leads: { stillOnWinner: ['lead-1', 'lead-2'] }, invoices: { stillOnWinner: ['inv-1'] } },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' });
    // The winner KEEPS the shared profile; the loser gets its own copy
    // back so its returned cards aren't stranded.
    expect(result.stripeMovedBack).toBe(false);
    expect(state.winnerPatch?.stripe_customer_id).toBeUndefined();
    expect(state.loserRestore.stripe_customer_id).toBe('cus_shared');
  });

  it('refuses (409, zero writes) when recipient_optin rows were journaled count-only — a missing consent row means "allowed to text"', async () => {
    const journal = baseJournal();
    // Composite PK (customer_id, phone_key), no id column — the merge can
    // only ever journal these count-only.
    journal.repointed_ids.tables['recipient_optin.customer_id'] = { count: 2 };
    const { trx, state } = buildRevertTrx({
      journal,
      winner: baseWinner(),
      loser: baseLoser(),
      tables: { leads: { stillOnWinner: ['lead-1', 'lead-2'] }, invoices: { stillOnWinner: ['inv-1'] } },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/recipient_optin.*comms consent/) });
    expect(state.repointedBack).toHaveLength(0);
    expect(state.journalUpdate).toBe(null);
  });

  it("restores the winner's PRE-FOLD notes while still the merge-written concatenation; an edited note stays and reports", async () => {
    const journal = baseJournal();
    const foldedCrm = `Winner note\n\n[From merged duplicate ${LOSER.slice(0, 8)}]: Loser note`;
    journal.repointed_ids.winner_note_appends = {
      before: { crm_notes: 'Winner note', technician_notes: null },
      applied: { crm_notes: foldedCrm, technician_notes: 'Gate code 0000' },
    };
    const { trx, state } = buildRevertTrx({
      journal,
      winner: {
        ...baseWinner(),
        crm_notes: foldedCrm, // still the merge-written fold → prior restored
        technician_notes: 'Operator rewrote this since', // edited → stays, reported
      },
      loser: baseLoser(),
      tables: { leads: { stillOnWinner: ['lead-1', 'lead-2'] }, invoices: { stillOnWinner: ['inv-1'] } },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' });
    expect(state.winnerPatch.crm_notes).toBe('Winner note');
    expect(state.winnerPatch.technician_notes).toBeUndefined();
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'customers.technician_notes', reason: 'winner_value_changed_since_merge' }),
    ]));
  });

  it('pre-upgrade journal without winner_note_appends: the folded text stays, no refusal (documented behavior)', async () => {
    const journal = baseJournal(); // no winner_note_appends key
    const { trx, state } = buildRevertTrx({
      journal,
      winner: { ...baseWinner(), crm_notes: 'Winner note\n\n[From merged duplicate x]: Loser note' },
      loser: baseLoser(),
      tables: { leads: { stillOnWinner: ['lead-1', 'lead-2'] }, invoices: { stillOnWinner: ['inv-1'] } },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' });
    expect(state.winnerPatch?.crm_notes).toBeUndefined();
    expect(result.skipped).toHaveLength(0);
  });

  it('refuses (409) when a payment_plans row no longer belongs to the winner — the plan governs an invoice collection path', async () => {
    const journal = baseJournal();
    journal.repointed_ids.tables['payment_plans.customer_id'] = ['plan-1'];
    const { trx, state } = buildRevertTrx({
      journal,
      winner: baseWinner(),
      loser: baseLoser(),
      tables: {
        leads: { stillOnWinner: ['lead-1', 'lead-2'] },
        invoices: { stillOnWinner: ['inv-1'] },
        payment_plans: { stillOnWinner: [] }, // moved on since the merge
      },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/payment_plans row/) });
    expect(state.verified).toEqual(expect.arrayContaining([
      { table: 'payment_plans', forUpdate: true },
    ]));
    expect(state.repointedBack).toHaveLength(0);
    expect(state.journalUpdate).toBe(null);
  });

  it('repoints customer_refresh_tokens back BY JTI (PK override) — the restored loser keeps its sessions', async () => {
    const journal = baseJournal();
    journal.repointed_ids.tables['customer_refresh_tokens.customer_id'] = ['tok-1', 'tok-2'];
    const { trx, state } = buildRevertTrx({
      journal,
      winner: baseWinner(),
      loser: baseLoser(),
      tables: {
        leads: { stillOnWinner: ['lead-1', 'lead-2'] },
        invoices: { stillOnWinner: ['inv-1'] },
        customer_refresh_tokens: { stillOnWinner: ['tok-1', 'tok-2'] },
      },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' });
    expect(result.repointedBack['customer_refresh_tokens.customer_id']).toBe(2);
    const entry = state.repointedBack.find((r) => r.table === 'customer_refresh_tokens');
    // Verified and repointed by the REAL key column, not a nonexistent id.
    expect(entry.pk).toBe('jti');
    expect(entry.ids).toEqual(['tok-1', 'tok-2']);
    expect(entry.payload.customer_id).toBe(LOSER);
  });

  it('pre-upgrade count-only customer_refresh_tokens journals keep the skip (sessions are not financial/consent)', async () => {
    const journal = baseJournal();
    journal.repointed_ids.tables['customer_refresh_tokens.customer_id'] = { count: 3 };
    const { trx, state } = buildRevertTrx({
      journal,
      winner: baseWinner(),
      loser: baseLoser(),
      tables: { leads: { stillOnWinner: ['lead-1', 'lead-2'] }, invoices: { stillOnWinner: ['inv-1'] } },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' });
    // Skipped and reported — a stale winner-assigned session just fails
    // rotation and forces a re-login; it never blocks the undo.
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'customer_refresh_tokens.customer_id', reason: 'no_row_ids_recorded' }),
    ]));
    expect(state.journalUpdate.undone_at).toBeTruthy();
  });

  it('refuses (409) when an estimate_deposits row no longer belongs to the winner — held money is all-or-nothing like invoices', async () => {
    const journal = baseJournal();
    journal.repointed_ids.tables['estimate_deposits.customer_id'] = ['dep-1'];
    const { trx, state } = buildRevertTrx({
      journal,
      winner: baseWinner(),
      loser: baseLoser(),
      tables: {
        leads: { stillOnWinner: ['lead-1', 'lead-2'] },
        invoices: { stillOnWinner: ['inv-1'] },
        estimate_deposits: { stillOnWinner: [] }, // moved on since the merge
      },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/estimate_deposits row/) });
    // Financial verification runs under FOR UPDATE, and the refusal landed
    // in the pre-write verification pass.
    expect(state.verified).toEqual(expect.arrayContaining([
      { table: 'estimate_deposits', forUpdate: true },
    ]));
    expect(state.repointedBack).toHaveLength(0);
    expect(state.journalUpdate).toBe(null);
  });

  it('the email-clear refusal covers the full fanout registry — an open contract on the merged-in email refuses too', async () => {
    const journal = baseJournal();
    const { trx, state } = buildRevertTrx({
      journal,
      winner: baseWinner(),
      loser: baseLoser(),
      tables: {
        leads: { stillOnWinner: ['lead-1', 'lead-2'] },
        invoices: { stillOnWinner: ['inv-1'] },
        // customer_contracts is in customer-email-fanout's registry but was
        // absent from the r4 three-table allowlist — the regression class
        // this pin guards.
        customer_contracts: { emailArtifacts: [{ id: 'ct-new' }] },
      },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/1 open contract.*deliver to the merged-in email/) });
    expect(state.journalUpdate).toBe(null);
  });

  it('refuses on a post-merge card with NULL stripe linkage too — ambiguous attachment fails closed', async () => {
    const journal = baseJournal();
    journal.repointed_ids.tables = { 'payment_methods.customer_id': ['pm-1'] };
    journal.repointed_ids.payment_method_flags = { 'pm-1': { is_default: false, autopay_enabled: false } };
    const { trx } = buildRevertTrx({
      journal,
      winner: baseWinner(),
      loser: baseLoser(),
      tables: {
        payment_methods: {
          stillOnWinner: ['pm-1'],
          winnerCards: [
            { id: 'pm-1', stripe_customer_id: 'cus_only' },
            { id: 'pm-null-link', stripe_customer_id: null },
          ],
        },
      },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.revertMerge({ journalId: JOURNAL, performedBy: 'admin:test' }))
      .rejects.toMatchObject({ statusCode: 409 });
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

  it('GET /merges: a PURGED winner (left-join null columns) reads revertible:false; a live winner reads true', async () => {
    // No supertest in this repo — real router on an ephemeral port, hit
    // with the built-in fetch (same pattern as public-ui-flags.test.js).
    const express = require('express');
    const journalRow = (overrides) => ({
      id: JOURNAL,
      winner_customer_id: WINNER,
      loser_customer_id: LOSER,
      tier: 'manual',
      performed_by: 'admin:test',
      created_at: '2026-07-30T04:00:00Z',
      undone_at: null,
      undone_by: null,
      loser_snapshot: JSON.stringify({ id: LOSER, first_name: 'Loser', last_name: null }),
      repointed_ids: JSON.stringify({
        version: 1,
        tables: { 'leads.customer_id': ['lead-1'] },
        stripe_transferred_id: null,
        payment_method_flags: {},
        collision_handlers: [],
      }),
      evidence: JSON.stringify({}),
      winner_first_name: 'Winner',
      winner_last_name: 'Testcase',
      winner_active: true,
      winner_deleted_at: null,
      winner_stripe_customer_id: null,
      // r8: the loser row must exist and still be merged-away.
      loser_row_id: LOSER,
      loser_row_deleted_at: '2026-07-30T04:40:00Z',
      ...overrides,
    });
    // Purged winner: the left join leaves every winner column null — the
    // old `winner_active !== false` check read that as alive and offered an
    // undo that 409s with "kept customer no longer exists".
    const purged = journalRow({
      winner_first_name: null, winner_last_name: null, winner_active: null, winner_deleted_at: null,
    });
    const live = journalRow({});
    let listRows = [purged];
    installDb((table) => {
      if (table === 'customer_merge_journal as j') return listRows;
      return [];
    });
    const app = express();
    app.use('/dup', require('../routes/admin-customer-duplicates'));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    try {
      const base = `http://127.0.0.1:${server.address().port}`;

      const resPurged = await fetch(`${base}/dup/merges`);
      expect(resPurged.status).toBe(200);
      const bodyPurged = await resPurged.json();
      expect(bodyPurged.merges[0].revertible).toBe(false);

      // Control: the identical journal with a positively-live winner IS
      // revertible — the pin bites on the null, not on the fixture.
      listRows = [live];
      const resLive = await fetch(`${base}/dup/merges`);
      expect(resLive.status).toBe(200);
      const bodyLive = await resLive.json();
      expect(bodyLive.merges[0].revertible).toBe(true);

      // r8: a PURGED loser row (left-join nulls) is not revertible — the
      // snapshot alone is not the live state revertMerge checks.
      listRows = [journalRow({ loser_row_id: null, loser_row_deleted_at: null })];
      const resPurgedLoser = await fetch(`${base}/dup/merges`);
      expect((await resPurgedLoser.json()).merges[0].revertible).toBe(false);

      // r8: a loser row that is ALREADY LIVE again (deleted_at null) has
      // nothing to undo.
      listRows = [journalRow({ loser_row_deleted_at: null })];
      const resLiveLoser = await fetch(`${base}/dup/merges`);
      expect((await resLiveLoser.json()).merges[0].revertible).toBe(false);

      // r11: winner/both-DERIVED Stripe profile + journaled loser cards —
      // revertMerge refuses unconditionally, so the UI must not offer it.
      // Pure journal data; the winner-pre-merge exemption and the journaled
      // cards mean no OTHER guard rejects this shape.
      const derivedRow = (derivedFrom) => journalRow({
        winner_stripe_customer_id: 'cus_derived',
        repointed_ids: JSON.stringify({
          version: 1,
          tables: {
            'leads.customer_id': ['lead-1'],
            'payment_methods.customer_id': ['pm-1'],
          },
          stripe_transferred_id: 'cus_derived',
          ...(derivedFrom === undefined ? {} : { stripe_derived_from: derivedFrom }),
          payment_method_flags: { 'pm-1': { is_default: false, autopay_enabled: false } },
          winner_premerge_pm_ids: ['pm-1'],
          collision_handlers: [],
        }),
      });
      for (const derivedFrom of ['winner', 'both', undefined]) {
        listRows = [derivedRow(derivedFrom)];
         
        const res = await fetch(`${base}/dup/merges`);
         
        expect((await res.json()).merges[0].revertible).toBe(false);
      }
      // Control: loser-derived with the same shape IS offered.
      listRows = [derivedRow('loser')];
      const resLoserDerived = await fetch(`${base}/dup/merges`);
      expect((await resLoserDerived.json()).merges[0].revertible).toBe(true);
    } finally {
      await new Promise((resolve) => { server.close(resolve); });
    }
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
