/**
 * AUDIT REPRO r2-customer-merge-and-account-attach-1 — an auto-merge that the
 * owner UNDOES (revertMerge) is re-merged by the very next auto-merge sweep:
 * neither findDuplicateGroups nor runAutoMergeSweep consults
 * customer_merge_journal.undone_at, and revertMerge writes no
 * customer_duplicate_dismissals row.
 *
 * Real Postgres (clone of waves_audit_tpl via DATABASE_URL). Asserts the
 * EXPECTED behaviour (an undone pair is never auto-merged again, but STAYS
 * reviewable for a human — Codex round 1 P2), so it FAILS on current code.
 *
 * Test hygiene (Codex round 1 P2): both sweep calls are scoped to the seeded
 * pair via runAutoMergeSweep's onlyPair filter, so this test never touches
 * any other live duplicate pair the target database happens to hold, and
 * every seeded row (customers, journal, dismissals) is deleted in afterAll
 * regardless of how the test ends.
 */
const { randomUUID } = require('crypto');
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => {}) }));

const db = require('../models/db');
const dedupe = require('../services/customer-dedupe');

jest.setTimeout(60000);

(process.env.DATABASE_URL?.includes('waves_audit_') ? describe : describe.skip)('undone auto-merge is not re-merged by the next sweep (real PG)', () => {
  const winnerId = randomUUID();
  const loserId = randomUUID();
  const phone = '9415559317';

  beforeAll(async () => {
    await db('customers').insert({
      id: winnerId, first_name: 'Undo', last_name: 'Resweep', phone,
      email: `undo-resweep-w-${winnerId}@example.com`, address_line1: '12 Undo Ln', city: 'Sarasota', zip: '34231',
      pipeline_stage: 'active_customer', active: true,
    });
    await db('customers').insert({
      id: loserId, first_name: 'Undo', last_name: 'Resweep', phone,
      email: null, address_line1: '12 Undo Ln', city: 'Sarasota', zip: '34231',
      pipeline_stage: 'new_lead', active: true,
    });
  });
  afterAll(async () => {
    await db('customer_duplicate_dismissals')
      .where((q) => q.where({ customer_id_a: winnerId, customer_id_b: loserId }).orWhere({ customer_id_a: loserId, customer_id_b: winnerId }))
      .del().catch(() => {});
    await db('customer_merge_journal').where({ winner_customer_id: winnerId }).del().catch(() => {});
    await db('customers').whereIn('id', [winnerId, loserId]).del().catch(() => {});
    await db.destroy();
  });

  test('sweep merges the shell, undo restores it, second sweep leaves the pair alone but reviewable', async () => {
    const first = await dedupe.runAutoMergeSweep({ performedBy: 'auto:test', onlyPair: { winnerId, loserId } });
    const firstHit = first.merged.find((m) => m.loserId === loserId);
    expect(firstHit).toBeTruthy();
    expect(firstHit.winnerId).toBe(winnerId);

    const journal = await db('customer_merge_journal').where({ loser_customer_id: loserId }).orderBy('created_at', 'desc').first();
    expect(journal).toBeTruthy();

    const undo = await dedupe.revertMerge({ journalId: journal.id, performedBy: 'owner-test', performedById: null });
    expect(undo.loserId).toBe(loserId);
    const restored = await db('customers').where({ id: loserId }).first('active', 'deleted_at', 'phone');
    expect(restored.active).toBe(true);
    expect(restored.deleted_at).toBeNull();
    expect(restored.phone).toBe(phone);

    const dismissal = await db('customer_duplicate_dismissals')
      .where((q) => q.where({ customer_id_a: winnerId, customer_id_b: loserId }).orWhere({ customer_id_a: loserId, customer_id_b: winnerId }))
      .first();
    expect(dismissal?.reason).toBe(dedupe.UNDO_MERGE_DISMISSAL_REASON);

    // Codex round 1 P2: still reviewable by a human even with the sentinel
    // dismissal recorded.
    const visibleGroups = await dedupe.findDuplicateGroups(db);
    const stillVisible = visibleGroups.some((g) => String(g.winner.id) === String(winnerId)
      && g.candidates.some((c) => String(c.loser.id) === String(loserId)));
    expect(stillVisible).toBe(true);

    // EXPECTED: an undone pair is excluded from AUTOMATIC merging.
    const second = await dedupe.runAutoMergeSweep({ performedBy: 'auto:test', onlyPair: { winnerId, loserId } });
    const reMerged = second.merged.find((m) => m.loserId === loserId);
    const journals = await db('customer_merge_journal').where({ loser_customer_id: loserId }).select('id', 'undone_at');
    const loserAfter = await db('customers').where({ id: loserId }).first('active', 'deleted_at');

    expect(reMerged).toBeUndefined();
    expect(journals.length).toBe(1);
    expect(loserAfter.active).toBe(true);
    expect(loserAfter.deleted_at).toBeNull();
  });
});
