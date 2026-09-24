/**
 * AUDIT REPRO r2-customer-merge-and-account-attach-1 — an UNDONE auto-merge is
 * silently re-applied by the next runAutoMergeSweep tick: neither
 * findDuplicateGroups nor the sweep consults customer_merge_journal.undone_at,
 * and revertMerge records no customer_duplicate_dismissals row for the pair.
 *
 * Real Postgres (clone of waves_audit_tpl via DATABASE_URL). Written to assert
 * the EXPECTED behaviour (an undone pair is never auto-merged again), so it
 * FAILS on current code if the bug is real.
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
  afterAll(async () => { await db.destroy(); });

  test('sweep -> undo -> sweep: the undone pair is NOT re-merged', async () => {
    // Sweep 1: the pair is green, so it auto-merges.
    const first = await dedupe.runAutoMergeSweep({ performedBy: 'test:sweep-1' });
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

    // Sweep 2 (next 4:40 tick): EXPECTED — the undone pair is excluded from
    // automatic merging (dismissal recorded, or journal consulted).
    const second = await dedupe.runAutoMergeSweep({ performedBy: 'test:sweep-2' });
    const secondHit = second.merged.filter((m) => m.loserId === loserId);
    const journals = await db('customer_merge_journal').where({ loser_customer_id: loserId }).orderBy('created_at');
    const dismissals = await db('customer_duplicate_dismissals')
      .where((q) => q.where({ customer_id_a: winnerId, customer_id_b: loserId }).orWhere({ customer_id_a: loserId, customer_id_b: winnerId }));
    const after = await db('customers').where({ id: loserId }).first('active', 'deleted_at');

     
    console.log('REPRO STATE', JSON.stringify({
      sweep2MergedThisPair: secondHit.length,
      journalRows: journals.map((j) => ({ id: j.id, performed_by: j.performed_by, undone_at: j.undone_at })),
      dismissalRowsForPair: dismissals.length,
      loserAfterSweep2: after,
    }, null, 2));

    expect(secondHit).toHaveLength(0);
    expect(journals).toHaveLength(1);
    expect(after.active).toBe(true);
  });
});
