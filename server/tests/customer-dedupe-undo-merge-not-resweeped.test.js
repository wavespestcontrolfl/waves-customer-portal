/**
 * AUDIT REPRO r2-customer-merge-and-account-attach-1 — an UNDONE auto-merge is
 * silently re-applied by the next runAutoMergeSweep tick: neither
 * findDuplicateGroups nor the sweep consults customer_merge_journal.undone_at,
 * and revertMerge records no customer_duplicate_dismissals row for the pair.
 *
 * Real Postgres (clone of waves_audit_tpl via DATABASE_URL). Written to assert
 * the EXPECTED behaviour (an undone pair is never auto-merged again, but
 * STAYS reviewable for a human — Codex round 1 P2), so it FAILS on current
 * code if the bug is real.
 *
 * Test hygiene (Codex round 1 P2): both sweep calls are scoped to the seeded
 * pair via runAutoMergeSweep's onlyPair filter, so this test never touches
 * any other live duplicate pair the target database happens to hold, and
 * every seeded row (customers, journal, dismissals) is deleted in afterAll
 * regardless of how the test ends.
 */
const { randomUUID } = require('crypto');
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => null) }));

const db = require('../models/db');
const dedupe = require('../services/customer-dedupe');

jest.setTimeout(60000);

(process.env.DATABASE_URL?.includes('waves_audit_') ? describe : describe.skip)('undone auto-merge vs next auto-merge sweep (real PG)', () => {
  const winnerId = randomUUID();
  const loserId = randomUUID();
  // Unique synthetic phone so no other fixture row in the clone shares it.
  const phone = '5550001' + String(Math.floor(Math.random() * 900) + 100);

  beforeAll(async () => {
    await db('customers').insert({
      id: winnerId, first_name: 'Undo', last_name: 'Reprowinner', phone,
      email: `undo-repro-w-${winnerId}@example.com`, address_line1: '11 Sample Way', zip: '00001',
      pipeline_stage: 'active_customer', active: true, created_at: '2026-07-01T00:00:00Z',
    });
    await db('customers').insert({
      id: loserId, first_name: 'Undo', last_name: null, phone,
      email: null, address_line1: null, zip: null,
      pipeline_stage: 'new_lead', active: true, created_at: '2026-07-09T00:00:00Z',
    });
  });
  afterAll(async () => {
    // Delete every seeded row regardless of how the test ended — the merge
    // may have soft-deleted the loser and repointed rows back onto the
    // winner, and a dismissal row may or may not exist depending on where
    // the test failed.
    await db('customer_duplicate_dismissals')
      .where((q) => q.where({ customer_id_a: winnerId, customer_id_b: loserId }).orWhere({ customer_id_a: loserId, customer_id_b: winnerId }))
      .del().catch(() => {});
    await db('customer_merge_journal').where({ winner_customer_id: winnerId }).del().catch(() => {});
    await db('customers').whereIn('id', [winnerId, loserId]).del().catch(() => {});
    await db.destroy();
  });

  test('sweep -> undo -> sweep: the undone pair is NOT re-merged, but stays reviewable', async () => {
    // Sweep 1: the pair is green, so it auto-merges. Scoped to this pair
    // only — never touches another live duplicate pair in the clone.
    const first = await dedupe.runAutoMergeSweep({ performedBy: 'test:sweep-1', onlyPair: { winnerId, loserId } });
    const firstHit = first.merged.filter((m) => m.loserId === loserId);
    expect(firstHit).toHaveLength(1);
    const journal1 = await db('customer_merge_journal').where({ loser_customer_id: loserId }).orderBy('created_at').first();
    expect(journal1).toBeTruthy();

    // Owner undoes it from Recent merges.
    const undo = await dedupe.revertMerge({ journalId: journal1.id, performedBy: 'test:owner-undo', performedById: null });
    expect(undo).toBeTruthy();
    const restored = await db('customers').where({ id: loserId }).first();
    expect(restored.active).toBe(true);
    expect(restored.deleted_at).toBeNull();
    expect(restored.phone).toBe(phone);
    const j1 = await db('customer_merge_journal').where({ id: journal1.id }).first();
    expect(j1.undone_at).not.toBeNull();

    // The dismissal recorded is the sweep-only sentinel, not a plain
    // "not a duplicate" verdict.
    const dismissalAfterUndo = await db('customer_duplicate_dismissals')
      .where((q) => q.where({ customer_id_a: winnerId, customer_id_b: loserId }).orWhere({ customer_id_a: loserId, customer_id_b: winnerId }))
      .first();
    expect(dismissalAfterUndo?.reason).toBe(dedupe.UNDO_MERGE_DISMISSAL_REASON);

    // Codex round 1 P2: the pair must stay visible to a HUMAN (the review
    // queue, findDuplicateGroups' default read) even though the sentinel
    // dismissal exists — only the automatic sweep suppresses it.
    const visibleGroups = await dedupe.findDuplicateGroups(db);
    const stillVisible = visibleGroups.some((g) => String(g.winner.id) === String(winnerId)
      && g.candidates.some((c) => String(c.loser.id) === String(loserId)));
    expect(stillVisible).toBe(true);

    // Sweep 2 (next 4:40 tick), scoped to this pair only: EXPECTED — the
    // undone pair is excluded from automatic merging.
    const second = await dedupe.runAutoMergeSweep({ performedBy: 'test:sweep-2', onlyPair: { winnerId, loserId } });
    const secondHit = second.merged.filter((m) => m.loserId === loserId);
    const journals = await db('customer_merge_journal').where({ loser_customer_id: loserId }).orderBy('created_at');
    const after = await db('customers').where({ id: loserId }).first('active', 'deleted_at');


    console.log('REPRO STATE', JSON.stringify({
      sweep2MergedThisPair: secondHit.length,
      journalRows: journals.map((j) => ({ id: j.id, performed_by: j.performed_by, undone_at: j.undone_at })),
      dismissalReason: dismissalAfterUndo?.reason || null,
      stillVisibleInQueue: stillVisible,
      loserAfterSweep2: after,
    }, null, 2));

    expect(secondHit).toHaveLength(0);
    expect(journals).toHaveLength(1);
    expect(after.active).toBe(true);
  });

  // Codex round 1 P1: a later EXPLICIT "not a duplicate" verdict on the same
  // pair (the operator manually deciding, from the still-reviewable queue,
  // that these really are two different people) must REPLACE the
  // undo-merge sentinel, not be silently ignored by it — otherwise the pair
  // would stay visible/mergeable forever despite the operator's real
  // dismissal. Continues from the previous test's end state (undone,
  // sentinel-dismissed, not re-merged).
  test('an explicit dismiss after undo replaces the sentinel and the pair leaves the review queue', async () => {
    const before = await db('customer_duplicate_dismissals')
      .where((q) => q.where({ customer_id_a: winnerId, customer_id_b: loserId }).orWhere({ customer_id_a: loserId, customer_id_b: winnerId }))
      .first();
    expect(before?.reason).toBe(dedupe.UNDO_MERGE_DISMISSAL_REASON);

    // Same write shape as POST /dismiss (admin-customer-duplicates.js):
    // insert-or-merge on the ordered pair, under the pair's adjudication lock.
    const [a, b] = winnerId < loserId ? [winnerId, loserId] : [loserId, winnerId];
    await db.transaction(async (trx) => {
      await dedupe.acquirePairAdjudicationLock(trx, a, b);
      await trx('customer_duplicate_dismissals')
        .insert({ customer_id_a: a, customer_id_b: b, reason: 'confirmed two different people', created_by: 'test:owner-dismiss' })
        .onConflict(['customer_id_a', 'customer_id_b'])
        .merge(['reason', 'created_by']);
    });

    const after = await db('customer_duplicate_dismissals')
      .where((q) => q.where({ customer_id_a: winnerId, customer_id_b: loserId }).orWhere({ customer_id_a: loserId, customer_id_b: winnerId }))
      .first();
    expect(after.reason).toBe('confirmed two different people');

    // The sentinel is gone — the pair now leaves the review queue like any
    // ordinary dismissal.
    const visibleGroups = await dedupe.findDuplicateGroups(db);
    const stillVisible = visibleGroups.some((g) => String(g.winner.id) === String(winnerId)
      && g.candidates.some((c) => String(c.loser.id) === String(loserId)));
    expect(stillVisible).toBe(false);
  });
});
