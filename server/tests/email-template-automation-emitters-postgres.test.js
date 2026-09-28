/**
 * Real PostgreSQL proof for the lifecycle sweep's durable-marker design
 * (codex round 3 on #5154 — supersedes round 2's timestamp-based anti-join
 * sweep entirely; that sweep and this file's round-2 tests are gone).
 *
 * A mocked db cannot prove any of these:
 *  - the marker write really shares the SAME Postgres transaction as the
 *    transition it records — a rollback must leave NEITHER the transition
 *    NOR the marker, which only a real ROLLBACK can demonstrate;
 *  - a pending marker committed to a real table is picked back up and
 *    replayed by retryPendingIntents/sweepMissedLifecycleEvents;
 *  - an unrecoverable marker is excluded from the very next 'pending' query
 *    (real WHERE status = 'pending' semantics) so it can never pin the
 *    sweep's batch, while a co-batched sibling still gets through;
 *  - the attempts ceiling's single-statement CASE really reads the
 *    PRE-update attempts value (Postgres SET semantics), and the sweep's
 *    ORDER BY attempts, occurred_at really puts a fresh marker ahead of an
 *    older, repeatedly failing one (pre-push audit P1).
 */
const SKIP = !process.env.DATABASE_URL;
const { randomUUID } = require('crypto');

jest.setTimeout(60000);

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => true),
  emailTemplateAutomationsMode: jest.fn(() => 'live'),
}));
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn(async (_name, fn) => fn()) }));
jest.mock('../services/email-template-automation-executor', () => ({
  processTrigger: jest.fn(async () => ({ automation_count: 1, results: [] })),
}));

(SKIP ? describe.skip : describe)('email-template-automation lifecycle intent markers on PostgreSQL (codex round 3 on #5154)', () => {
  let db;
  let AutomationExecutor;
  let emitters;

  beforeAll(() => {
    db = require('../models/db');
    AutomationExecutor = require('../services/email-template-automation-executor');
    emitters = require('../services/email-template-automation-emitters');
  });

  afterAll(async () => { await db.destroy(); });

  beforeEach(() => {
    jest.clearAllMocks();
    AutomationExecutor.processTrigger.mockReset();
    AutomationExecutor.processTrigger.mockResolvedValue({ automation_count: 1, results: [] });
  });

  async function makeCustomer() {
    const id = randomUUID();
    await db('customers').insert({
      id,
      first_name: 'Synthetic',
      last_name: 'Sweep',
      phone: `qa-${id.slice(0, 8)}`,
      address_line1: '100 Synthetic Test Lane',
      city: 'Bradenton',
      zip: '34201',
    });
    return id;
  }

  async function cleanup({ customerIds = [], reviewIds = [], estimateIds = [], markerIds = [] }) {
    if (markerIds.length) await db('email_template_automation_intents').whereIn('id', markerIds).del();
    if (estimateIds.length) await db('estimates').whereIn('id', estimateIds).del();
    if (reviewIds.length) await db('google_reviews').whereIn('id', reviewIds).del();
    if (customerIds.length) await db('customers').whereIn('id', customerIds).del();
  }

  test('a rollback of the transition leaves NEITHER the entity write NOR its intent marker (same transaction)', async () => {
    const customerId = await makeCustomer();
    const reviewId = randomUUID();
    await db('google_reviews').insert({
      id: reviewId, location_id: 'venice', star_rating: 5, customer_id: null,
    });

    try {
      await expect(db.transaction(async (trx) => {
        // Mirror google-business.js's _upsertGbpReview: the attribution
        // write and the marker recording happen inside the SAME trx, in
        // that order, before anything else runs.
        await trx('google_reviews').where({ id: reviewId }).update({ customer_id: customerId });
        const intent = await emitters.recordAutomationIntent(trx, {
          triggerEventKey: 'review.linked_5star',
          entityType: 'review',
          entityId: reviewId,
          occurredAt: new Date(),
          payload: { review_id: reviewId, customer_id: customerId, star_rating: 5 },
        });
        expect(intent).toBeTruthy(); // the insert itself succeeded, mid-transaction
        throw new Error('synthetic failure forcing a rollback');
      })).rejects.toThrow('synthetic failure forcing a rollback');

      const reviewAfter = await db('google_reviews').where({ id: reviewId }).first();
      expect(reviewAfter.customer_id).toBeNull(); // the attribution write rolled back

      const markerAfter = await db('email_template_automation_intents').where({ entity_id: reviewId }).first();
      expect(markerAfter).toBeUndefined(); // the marker rolled back WITH it — neither survived
    } finally {
      await cleanup({ customerIds: [customerId], reviewIds: [reviewId] });
    }
  });

  test('a committed transition keeps BOTH the entity write and its intent marker', async () => {
    const customerId = await makeCustomer();
    const reviewId = randomUUID();
    await db('google_reviews').insert({
      id: reviewId, location_id: 'venice', star_rating: 5, customer_id: null,
    });
    let markerId;

    try {
      await db.transaction(async (trx) => {
        await trx('google_reviews').where({ id: reviewId }).update({ customer_id: customerId });
        const intent = await emitters.recordAutomationIntent(trx, {
          triggerEventKey: 'review.linked_5star',
          entityType: 'review',
          entityId: reviewId,
          occurredAt: new Date(),
          payload: { review_id: reviewId, customer_id: customerId, star_rating: 5 },
        });
        markerId = intent.id;
      });

      const reviewAfter = await db('google_reviews').where({ id: reviewId }).first();
      expect(reviewAfter.customer_id).toBe(customerId);

      const markerAfter = await db('email_template_automation_intents').where({ id: markerId }).first();
      expect(markerAfter).toBeTruthy();
      expect(markerAfter.status).toBe('pending');
      expect(markerAfter.entity_id).toBe(reviewId);
    } finally {
      await cleanup({ customerIds: [customerId], reviewIds: [reviewId], markerIds: markerId ? [markerId] : [] });
    }
  });

  test('the sweep replays a real, committed pending marker and settles it processed', async () => {
    const markerId = randomUUID();
    const occurredAt = new Date(Date.now() - 10 * 60 * 1000); // well past the sweep's grace window
    await db('email_template_automation_intents').insert({
      id: markerId,
      trigger_event_key: 'estimate.expired',
      entity_type: 'estimate',
      entity_id: 'est-pg-1',
      occurred_at: occurredAt,
      status: 'pending',
      payload: JSON.stringify({ id: 'est-pg-1', customer_email: 'sweep-qa@example.com' }),
    });

    try {
      const result = await emitters.sweepMissedLifecycleEvents();

      expect(result.intentsRetried).toBe(1);
      expect(AutomationExecutor.processTrigger).toHaveBeenCalledWith(expect.objectContaining({
        triggerEventKey: 'estimate.expired', entityId: 'est-pg-1',
      }));
      const after = await db('email_template_automation_intents').where({ id: markerId }).first();
      expect(after.status).toBe('processed');
    } finally {
      await cleanup({ markerIds: [markerId] });
    }
  });

  test('an unrecoverable marker settles out of "pending" in the SAME pass and never resurfaces — never pins a co-batched sibling (codex P2)', async () => {
    const unresolvableId = randomUUID();
    const resolvableId = randomUUID();
    const occurredAt = new Date(Date.now() - 10 * 60 * 1000);
    await db('email_template_automation_intents').insert([
      {
        id: unresolvableId,
        trigger_event_key: 'estimate.expired',
        entity_type: 'estimate',
        entity_id: 'est-pg-unresolvable',
        occurred_at: occurredAt,
        status: 'pending',
        // No customer_email/customer_id at all — recipientFor's own
        // "recipient email is required" throw is what settles this
        // unrecoverable; the executor is mocked here so the rejection is
        // simulated directly on it (proven for real against recipientFor's
        // exact error in the mocked emitters unit suite).
        payload: JSON.stringify({ id: 'est-pg-unresolvable' }),
      },
      {
        id: resolvableId,
        trigger_event_key: 'estimate.expired',
        entity_type: 'estimate',
        entity_id: 'est-pg-resolvable',
        occurred_at: new Date(occurredAt.getTime() + 1000), // one second later — still oldest-first ahead of nothing else
        status: 'pending',
        payload: JSON.stringify({ id: 'est-pg-resolvable', customer_email: 'sweep-qa@example.com' }),
      },
    ]);
    const unrecoverableErr = new Error('recipient email is required for automation execution');
    unrecoverableErr.status = 400;
    AutomationExecutor.processTrigger
      .mockRejectedValueOnce(unrecoverableErr)
      .mockResolvedValueOnce({ automation_count: 1, results: [] });

    try {
      const first = await emitters.sweepMissedLifecycleEvents();

      // Both markers were IN the same 'pending' batch (LIMIT 100 easily
      // covers 2 rows) — the unresolvable one failing never stopped the
      // resolvable sibling from being attempted in the SAME pass.
      expect(first.intentsRetried).toBe(1); // only the resolvable one counts as an actual emit
      expect(AutomationExecutor.processTrigger).toHaveBeenCalledTimes(2);

      const unresolvableAfter = await db('email_template_automation_intents').where({ id: unresolvableId }).first();
      expect(unresolvableAfter.status).toBe('unrecoverable');
      const resolvableAfter = await db('email_template_automation_intents').where({ id: resolvableId }).first();
      expect(resolvableAfter.status).toBe('processed');

      // A second sweep pass — the real WHERE status = 'pending' clause must
      // never re-select the unrecoverable row.
      AutomationExecutor.processTrigger.mockClear();
      const second = await emitters.sweepMissedLifecycleEvents();
      expect(second.intentsRetried).toBe(0);
      expect(AutomationExecutor.processTrigger).not.toHaveBeenCalled();
    } finally {
      await cleanup({ markerIds: [unresolvableId, resolvableId] });
    }
  });

  test('attempts ceiling: the failure that reaches MAX_INTENT_ATTEMPTS settles unrecoverable in one statement, with a scrubbed last_error', async () => {
    const markerId = randomUUID();
    await db('email_template_automation_intents').insert({
      id: markerId,
      trigger_event_key: 'estimate.expired',
      entity_type: 'estimate',
      entity_id: 'est-pg-ceiling',
      occurred_at: new Date(Date.now() - 10 * 60 * 1000),
      status: 'pending',
      attempts: emitters.MAX_INTENT_ATTEMPTS - 2,
      payload: JSON.stringify({ id: 'est-pg-ceiling', customer_email: 'sweep-qa@example.com' }),
    });
    AutomationExecutor.processTrigger.mockRejectedValue(new Error(
      'duplicate key value violates unique constraint: Key (recipient_email)=(sweep-qa@example.com)',
    ));

    try {
      await emitters.emitEstimateExpired({ id: 'est-pg-ceiling', customer_email: 'sweep-qa@example.com' }, markerId);
      const afterFirst = await db('email_template_automation_intents').where({ id: markerId }).first();
      expect(afterFirst.status).toBe('pending');
      expect(afterFirst.attempts).toBe(emitters.MAX_INTENT_ATTEMPTS - 1);

      await emitters.emitEstimateExpired({ id: 'est-pg-ceiling', customer_email: 'sweep-qa@example.com' }, markerId);
      const afterSecond = await db('email_template_automation_intents').where({ id: markerId }).first();
      expect(afterSecond.status).toBe('unrecoverable');
      expect(afterSecond.attempts).toBe(emitters.MAX_INTENT_ATTEMPTS);
      expect(afterSecond.last_error).toContain('duplicate key value');
      expect(afterSecond.last_error).not.toContain('sweep-qa@example.com');
    } finally {
      await cleanup({ markerIds: [markerId] });
    }
  });

  test('the sweep reaches a fresh marker ahead of an older, repeatedly failing one (ORDER BY attempts, occurred_at)', async () => {
    const stuckId = randomUUID();
    const freshId = randomUUID();
    const base = Date.now() - 60 * 60 * 1000;
    await db('email_template_automation_intents').insert([
      {
        id: stuckId,
        trigger_event_key: 'estimate.expired',
        entity_type: 'estimate',
        entity_id: 'est-pg-stuck',
        occurred_at: new Date(base), // OLDER — would lead a pure oldest-first batch
        status: 'pending',
        attempts: 5,
        payload: JSON.stringify({ id: 'est-pg-stuck', customer_email: 'sweep-qa@example.com' }),
      },
      {
        id: freshId,
        trigger_event_key: 'estimate.expired',
        entity_type: 'estimate',
        entity_id: 'est-pg-fresh',
        occurred_at: new Date(base + 30 * 60 * 1000),
        status: 'pending',
        payload: JSON.stringify({ id: 'est-pg-fresh', customer_email: 'sweep-qa@example.com' }),
      },
    ]);
    AutomationExecutor.processTrigger.mockImplementation(async ({ entityId }) => {
      if (entityId === 'est-pg-stuck') throw new Error('persistent failure');
      return { automation_count: 1, results: [] };
    });

    try {
      await emitters.sweepMissedLifecycleEvents();

      const order = AutomationExecutor.processTrigger.mock.calls
        .map((c) => c[0].entityId)
        .filter((id) => id === 'est-pg-stuck' || id === 'est-pg-fresh');
      expect(order).toEqual(['est-pg-fresh', 'est-pg-stuck']);
      const stuckAfter = await db('email_template_automation_intents').where({ id: stuckId }).first();
      expect(stuckAfter).toMatchObject({ status: 'pending', attempts: 6, last_error: 'persistent failure' });
      const freshAfter = await db('email_template_automation_intents').where({ id: freshId }).first();
      expect(freshAfter.status).toBe('processed');
    } finally {
      AutomationExecutor.processTrigger.mockReset();
      await cleanup({ markerIds: [stuckId, freshId] });
    }
  });
});
