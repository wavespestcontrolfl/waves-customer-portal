/**
 * AUDIT REPRO r2-customer-merge-and-account-attach-2 — a manual duplicate
 * merge repoints the loser's live same-family recurring parent series onto
 * the winner with no refusal or disclosure, so the winner owns TWO live
 * monthly-pest parents at one address (two visits per cycle, both billable).
 *
 * Real Postgres (clone of waves_audit_tpl via DATABASE_URL). Written to assert
 * the EXPECTED behaviour (a refusal, or exactly one surviving live parent of
 * the family), so it FAILS on current code if the bug is real.
 */
const { randomUUID } = require('crypto');
// Relative dates: the merge guard's liveness rule compares the series'
// upcoming child against today's ET date, so anchored dates would lapse.
const isoDaysAhead = (n) => new Date(Date.now() + n * 24 * 3600 * 1000).toISOString().slice(0, 10);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => null) }));

const db = require('../models/db');
const dedupe = require('../services/customer-dedupe');

jest.setTimeout(60000);

(process.env.DATABASE_URL?.includes('waves_audit_') ? describe : describe.skip)('manual merge with a live same-family series on both sides (real PG)', () => {
  const winnerId = randomUUID();
  const loserId = randomUUID();
  const phone = '5550002' + String(Math.floor(Math.random() * 900) + 100);
  const addr = { address_line1: '22 Sample Way', city: 'Sarasota', state: 'FL', zip: '34231' };

  async function seedSeries(customerId, tag) {
    const parentId = randomUUID();
    await db('scheduled_services').insert({
      id: parentId, customer_id: customerId, service_type: 'Monthly Pest Control',
      scheduled_date: isoDaysAhead(11), status: 'confirmed', is_recurring: true, recurring_parent_id: null,
      recurring_pattern: 'monthly', recurring_ongoing: true, notes: `repro-${tag}-parent`,
    });
    await db('scheduled_services').insert({
      id: randomUUID(), customer_id: customerId, service_type: 'Monthly Pest Control',
      scheduled_date: isoDaysAhead(42), status: 'pending', is_recurring: true, recurring_parent_id: parentId,
      recurring_pattern: 'monthly', notes: `repro-${tag}-child`,
    });
    return parentId;
  }

  beforeAll(async () => {
    await db('customers').insert({
      id: winnerId, first_name: 'Series', last_name: 'Reprowinner', phone, ...addr,
      email: `series-repro-w-${winnerId}@example.com`,
      pipeline_stage: 'active_customer', active: true, created_at: '2026-07-01T00:00:00Z',
    });
    await db('customers').insert({
      id: loserId, first_name: 'Series', last_name: 'Reprowinner', phone, ...addr,
      email: null,
      pipeline_stage: 'active_customer', active: true, created_at: '2026-08-09T00:00:00Z',
    });
    await seedSeries(winnerId, 'winner');
    await seedSeries(loserId, 'loser');
  });
  afterAll(async () => { await db.destroy(); });

  test('merge either refuses or leaves ONE live monthly-pest parent on the winner', async () => {
    // The pair must be in the queue, yellow (loser has scheduled_services), not red.
    const elig = await dedupe.duplicatePairEligibility(winnerId, loserId);
     
    console.log('ELIGIBILITY', JSON.stringify(elig));
    expect(elig.eligible).toBe(true);

    let refusal = null;
    let result = null;
    try {
      result = await dedupe.executeMerge({
        winnerId, loserId, mode: 'manual', performedBy: 'test:admin', performedById: null,
        evidence: { via: 'admin_review_queue' }, requireQueueEligibility: true,
      });
    } catch (e) {
      refusal = e.message;
    }

    const liveParents = await db('scheduled_services')
      .where({ customer_id: winnerId, is_recurring: true })
      .whereNull('recurring_parent_id')
      .whereNotIn('status', ['cancelled'])
      .select('id', 'service_type', 'scheduled_date', 'status', 'notes');
    const loserVisits = await db('scheduled_services').where({ customer_id: loserId }).count({ n: '*' }).first();

     
    console.log('REPRO STATE', JSON.stringify({
      refusal,
      repointedScheduledServices: result?.repointed?.['scheduled_services.customer_id'] ?? null,
      liveParentsOnWinner: liveParents,
      loserVisitsRemaining: Number(loserVisits?.n || 0),
    }, null, 2));

    if (!refusal) {
      expect(liveParents).toHaveLength(1);
    } else {
      expect(refusal).toMatch(/series|recurring/i);
    }
  });
});
