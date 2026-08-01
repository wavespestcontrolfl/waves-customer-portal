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

  function buildRevertTrx({ journal, winner, loser, tables = {} }) {
    const state = {
      repointedBack: [], winnerPatch: null, loserRestore: null, journalUpdate: null,
      decremented: null, flagRestores: [], propertyDeleted: null, propertyTransferred: null,
      verified: [], rawCalls: [],
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
      // Row-id verification selects are the only ones using whereIn('id',…)
      // — everything else on these tables is a probe.
      const isIdVerification = q.called('whereIn') && q.args('whereIn')?.[0] === 'id';
      // The linked-property undo probes for referencing visits (the FK is
      // ON DELETE SET NULL, so only this probe can catch them) — under
      // FOR UPDATE since r5.
      if (table === 'scheduled_services' && q.called('select') && !isIdVerification) {
        state.visitProbe = { forUpdate: q.called('forUpdate') };
        return (tables.scheduled_services && tables.scheduled_services.referencingVisits) || [];
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
          // Non-whereIn select = the winner's CURRENT payment methods (the
          // post-merge-cards refusal probe), not a verification pass.
          if (!q.called('whereIn')) return cfg.winnerCards || [];
          state.verified.push({ table, forUpdate: q.called('forUpdate') });
          // Rows shaped by the verification's key column ('id', or a
          // REPOINT_PK_COLUMNS override like customer_refresh_tokens.jti).
          const keyCol = q.args('whereIn')[0];
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
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/appointment.*booked for the kept customer after the merge/) });
    // The refusal throw rolls the transaction back — journal never stamped,
    // property neither transferred nor deleted.
    expect(state.journalUpdate).toBe(null);
    expect(state.propertyTransferred).toBe(null);
    expect(state.propertyDeleted).toBe(null);
  });

  it('still TRANSFERS when the only referencing visits are in the journaled repoint set (they move back anyway)', async () => {
    const journal = baseJournal();
    journal.evidence = { via: 'admin_link_as_property' };
    journal.repointed_ids.linked_property_id = 'prop-9';
    // visit-1 is journaled: it was the loser's, repointed by the merge, and
    // the undo moves it back — winner-owned at probe time must NOT refuse.
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
          referencingVisits: [{ id: 'visit-1', customer_id: WINNER }],
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
