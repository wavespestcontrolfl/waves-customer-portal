/**
 * AUDIT REPRO r2-customer-merge-and-account-attach-1 — an auto-merge that the
 * owner UNDOES (revertMerge) is re-merged by the very next auto-merge sweep:
 * neither findDuplicateGroups nor runAutoMergeSweep consults
 * customer_merge_journal.undone_at, and revertMerge writes no
 * customer_duplicate_dismissals row.
 *
 * Real Postgres (clone of waves_audit_tpl via DATABASE_URL). Asserts the
 * EXPECTED behaviour (an undone pair is never auto-merged again), so it FAILS
 * on current code.
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
  afterAll(async () => { await db.destroy(); });

  test('sweep merges the shell, undo restores it, second sweep leaves the pair alone', async () => {
    const first = await dedupe.runAutoMergeSweep({ performedBy: 'auto:test' });
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

    // EXPECTED: an undone pair is excluded from automatic merging.
    const second = await dedupe.runAutoMergeSweep({ performedBy: 'auto:test' });
    const reMerged = second.merged.find((m) => m.loserId === loserId);
    const journals = await db('customer_merge_journal').where({ loser_customer_id: loserId }).select('id', 'undone_at');
    const loserAfter = await db('customers').where({ id: loserId }).first('active', 'deleted_at');

    expect(reMerged).toBeUndefined();
    expect(journals.length).toBe(1);
    expect(loserAfter.active).toBe(true);
    expect(loserAfter.deleted_at).toBeNull();
  });
});
