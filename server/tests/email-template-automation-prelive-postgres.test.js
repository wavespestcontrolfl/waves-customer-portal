/**
 * Real PostgreSQL proof for the pre-live fixes to the email template
 * automation executor (follow-up to merged #5154, shadow mode):
 *
 *  1. a shadow WOULD-BLOCK run (status 'skipped' + a would_block ledger
 *     event) is promoted in place by a live replay of the same idempotency
 *     key once the operator has fixed whatever blocked it — but a genuine
 *     condition skip is never promoted, and two concurrent live replays
 *     promote it exactly once (the UPDATE's status + would_block re-check);
 *  2. one misconfigured automation does not stop the other automations on
 *     the same trigger, and it does not make the shared intent marker
 *     unrecoverable — it stays 'pending', and once the automation is fixed a
 *     replay creates its run and settles the marker (a permanent recipient
 *     error still settles 'unrecoverable');
 *  3. the Automations dashboard reports would_send_30d / would_block_30d
 *     aggregated from the run ledger (runs joined to their events).
 *
 * The executor's unit tests mock the db; none of these SQL predicates
 * (latest-event subquery, countDistinct/group by over the join) can be
 * proven without a real Postgres.
 */
const SKIP = !process.env.DATABASE_URL;
const { randomUUID } = require('crypto');

jest.setTimeout(60000);

const mockGate = { mode: 'shadow' };
const mockPreflight = { result: { ok: true } };

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return {
    ...actual,
    isEnabled: jest.fn((name) => (name === 'emailTemplateAutomations' ? mockGate.mode !== 'off' : actual.isEnabled(name))),
    emailTemplateAutomationsMode: jest.fn(() => mockGate.mode),
  };
});
jest.mock('../utils/cron-lock', () => ({
  runExclusive: jest.fn(async (_name, fn) => fn()),
  wasLockSkipped: jest.requireActual('../utils/cron-lock').wasLockSkipped,
}));
jest.mock('../services/email-template-library', () => ({
  preflightTemplateSend: jest.fn(async () => mockPreflight.result),
  sendTemplate: jest.fn(async () => { throw new Error('a live send must never happen in this suite'); }),
  LEDGER_REQUIRED_CODE: 'EMAIL_DIVISION_LEDGER_REQUIRED',
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technician = { id: 'admin-1', role: 'admin' }; req.techRole = 'admin'; next(); },
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => false),
  newsletterGroupId: jest.fn(() => null),
  serviceGroupId: jest.fn(() => null),
  unsubscribeUrl: jest.fn(() => 'https://example.com/unsubscribe'),
}));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));

(SKIP ? describe.skip : describe)('email-template automation pre-live fixes on PostgreSQL', () => {
  let db;
  let Executor;
  let emitters;
  let templateKey;
  const automationKeys = [];
  const customerIds = [];
  const markerIds = [];

  beforeAll(async () => {
    db = require('../models/db');
    Executor = require('../services/email-template-automation-executor');
    emitters = require('../services/email-template-automation-emitters');
    const template = await db('email_templates').whereNotNull('active_version_id').first();
    templateKey = template.template_key;
  });

  afterAll(async () => {
    if (automationKeys.length) {
      await db('email_template_automation_runs').whereIn('automation_key', automationKeys).del();
      await db('email_template_automations').whereIn('automation_key', automationKeys).del();
    }
    if (markerIds.length) await db('email_template_automation_intents').whereIn('id', markerIds).del();
    if (customerIds.length) await db('customers').whereIn('id', customerIds).del();
    await db.destroy();
  });

  beforeEach(() => {
    mockGate.mode = 'shadow';
    mockPreflight.result = { ok: true };
  });

  async function makeAutomation(overrides = {}) {
    const key = `qa_prelive_${randomUUID().slice(0, 8)}`;
    automationKeys.push(key);
    const [row] = await db('email_template_automations').insert({
      automation_key: key,
      name: key,
      trigger_event_key: overrides.trigger_event_key || `qa.prelive.${key}`,
      template_key: templateKey,
      delay_minutes: 0,
      audience: 'customer',
      status: 'active',
      idempotency_key_template: `${key}:{trigger_event_id}`,
      conditions: JSON.stringify({}),
      exit_conditions: JSON.stringify({}),
      retry_policy: JSON.stringify({ max_attempts: 2, backoff_minutes: [15, 60] }),
      ...overrides,
    }).returning('*');
    return row;
  }

  const trigger = (automation, eventId, extra = {}) => Executor.processTrigger({
    triggerEventKey: automation.trigger_event_key,
    triggerEventId: eventId,
    payload: { recipient_email: 'synthetic-prelive@example.com', renewal_count: 0, ...extra.payload },
    executeImmediately: extra.executeImmediately,
  });

  const eventTypes = async (runId) => (await db('email_template_automation_run_events')
    .where({ run_id: runId }).orderBy('created_at', 'asc')).map((e) => e.event_type);

  describe('fix 1: a corrected shadow would_block run goes live', () => {
    test('would_block -> operator fixes it -> live replay promotes the SAME row (never a second row) and it stays a single run under concurrency', async () => {
      const automation = await makeAutomation();
      const eventId = `evt-${randomUUID().slice(0, 8)}`;

      // Shadow: the preflight says the live send would have blocked.
      mockPreflight.result = { ok: false, code: 'TEMPLATE_DISABLED', reason: 'template is disabled' };
      const shadow = await trigger(automation, eventId);
      const shadowRun = shadow.results[0].run;
      expect(shadowRun.status).toBe('skipped');
      expect(await eventTypes(shadowRun.id)).toContain('would_block');

      // A shadow replay still dedupes — mode must be live to promote.
      const shadowReplay = await trigger(automation, eventId);
      expect(shadowReplay.results[0].deduped).toBe(true);
      expect((await db('email_template_automation_runs').where({ id: shadowRun.id }).first()).status).toBe('skipped');

      // Operator fixes the block; the gate flips live. Two replays race.
      mockGate.mode = 'live';
      const [a, b] = await Promise.all([
        trigger(automation, eventId, { executeImmediately: false }),
        trigger(automation, eventId, { executeImmediately: false }),
      ]);
      const outcomes = [a.results[0], b.results[0]];
      expect(outcomes.filter((r) => r.deduped === false)).toHaveLength(1);
      expect(outcomes.filter((r) => r.deduped === true)).toHaveLength(1);

      const rows = await db('email_template_automation_runs').where({ automation_key: automation.automation_key });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(shadowRun.id);
      expect(rows[0].status).toBe('queued');
      expect(rows[0].exit_reason).toBeNull();
      expect(rows[0].completed_at).toBeNull();
      expect(rows[0].context.origin_mode).toBe('live');
      const types = await eventTypes(shadowRun.id);
      expect(types.filter((t) => t === 'promoted_from_shadow')).toHaveLength(1);

      // And once promoted (now queued), a further replay is an ordinary dedupe.
      const again = await trigger(automation, eventId, { executeImmediately: false });
      expect(again.results[0].deduped).toBe(true);
    });

    test('a genuine condition skip is NOT promoted by a live replay', async () => {
      const automation = await makeAutomation({ conditions: JSON.stringify({ renewal_count_gt: 5 }) });
      const eventId = `evt-${randomUUID().slice(0, 8)}`;

      const first = await trigger(automation, eventId);
      expect(first.results[0].run.status).toBe('skipped');
      expect(await eventTypes(first.results[0].run.id)).not.toContain('would_block');

      mockGate.mode = 'live';
      const replay = await trigger(automation, eventId, { executeImmediately: false });
      expect(replay.results[0].deduped).toBe(true);
      expect((await db('email_template_automation_runs').where({ id: first.results[0].run.id }).first()).status).toBe('skipped');
    });

    test('a live block AFTER a promotion is not re-promoted (its latest ledger event is no longer would_block)', async () => {
      const automation = await makeAutomation();
      const eventId = `evt-${randomUUID().slice(0, 8)}`;
      mockPreflight.result = { ok: false, code: 'TEMPLATE_DISABLED', reason: 'template is disabled' };
      const shadow = await trigger(automation, eventId);
      const runId = shadow.results[0].run.id;

      mockGate.mode = 'live';
      await trigger(automation, eventId, { executeImmediately: false });
      // Simulate the promoted live attempt being skipped by a live guard.
      await db('email_template_automation_runs').where({ id: runId }).update({ status: 'skipped', exit_reason: 'live guard' });
      await db('email_template_automation_run_events').insert({ run_id: runId, event_type: 'skipped', message: 'live guard' });

      const replay = await trigger(automation, eventId, { executeImmediately: false });
      expect(replay.results[0].deduped).toBe(true);
      expect((await db('email_template_automation_runs').where({ id: runId }).first()).status).toBe('skipped');
    });
  });

  describe('fix 2: per-automation isolation on a shared trigger', () => {
    async function makeReviewCustomer(email) {
      const id = randomUUID();
      customerIds.push(id);
      await db('customers').insert({
        id, first_name: 'Synthetic', last_name: 'Isolation', email,
        phone: `qa-${id.slice(0, 8)}`, address_line1: '100 Synthetic Test Lane', city: 'Bradenton', zip: '34201',
      });
      return id;
    }

    async function makeMarker(customerId, reviewId) {
      const rows = await emitters.recordAutomationIntents(db, [{
        triggerEventKey: 'review.linked_5star',
        entityType: 'review',
        entityId: reviewId,
        occurredAt: new Date(),
        payload: { review_id: reviewId, customer_id: customerId, star_rating: 5 },
      }]);
      markerIds.push(rows[0].id);
      return rows[0].id;
    }

    test('a blank-template automation does not block the healthy one, keeps the marker pending, and a replay after the fix settles it', async () => {
      const customerId = await makeReviewCustomer(`synthetic-iso-${randomUUID().slice(0, 8)}@example.com`);
      const reviewId = randomUUID();
      const bad = await makeAutomation({
        trigger_event_key: 'review.linked_5star',
        automation_key: `qa_prelive_bad_${randomUUID().slice(0, 6)}`,
        idempotency_key_template: '',
        delay_minutes: 0,
      });
      const good = await makeAutomation({
        trigger_event_key: 'review.linked_5star',
        automation_key: `qa_prelive_good_${randomUUID().slice(0, 6)}`,
        idempotency_key_template: `qa_prelive_good:{review_id}:${randomUUID().slice(0, 6)}`,
        delay_minutes: 30, // scheduled: no execution, just the run row
      });
      const markerId = await makeMarker(customerId, reviewId);

      await emitters.emitReviewLinked5Star({ reviewId, customerId, locationId: 'venice', starRating: 5 }, markerId);

      const goodRuns = await db('email_template_automation_runs').where({ automation_key: good.automation_key });
      expect(goodRuns).toHaveLength(1); // visited even though the bad one failed FIRST alphabetically
      const marker = await db('email_template_automation_intents').where({ id: markerId }).first();
      expect(marker.status).toBe('pending');
      expect(marker.attempts).toBe(1);
      expect(marker.last_error).toContain(bad.automation_key);

      // Operator fixes the automation in the admin editor; the sweep replays.
      await db('email_template_automations').where({ id: bad.id }).update({
        idempotency_key_template: `qa_prelive_bad:{review_id}:${randomUUID().slice(0, 6)}`,
        delay_minutes: 30,
      });
      await emitters.emitReviewLinked5Star({ reviewId, customerId, locationId: 'venice', starRating: 5 }, markerId);

      expect(await db('email_template_automation_runs').where({ automation_key: bad.automation_key })).toHaveLength(1);
      expect(await db('email_template_automation_runs').where({ automation_key: good.automation_key })).toHaveLength(1); // deduped, not doubled
      expect((await db('email_template_automation_intents').where({ id: markerId }).first()).status).toBe('processed');
    });

    test('a permanent recipient failure (no resolvable email) still settles the marker unrecoverable at once', async () => {
      const customerId = await makeReviewCustomer(null);
      const reviewId = randomUUID();
      await makeAutomation({
        trigger_event_key: 'review.linked_5star',
        automation_key: `qa_prelive_norecip_${randomUUID().slice(0, 6)}`,
        idempotency_key_template: `qa_prelive_norecip:{review_id}:${randomUUID().slice(0, 6)}`,
      });
      const markerId = await makeMarker(customerId, reviewId);

      await emitters.emitReviewLinked5Star({ reviewId, customerId, locationId: 'venice', starRating: 5 }, markerId);

      const marker = await db('email_template_automation_intents').where({ id: markerId }).first();
      expect(marker.status).toBe('unrecoverable');
    });
  });

  describe('fix 3: dashboard would_send / would_block come from the run ledger', () => {
    test('GET /automations reports per-automation 30d would_send and would_block, not the email_messages send count', async () => {
      const express = require('express');
      const automation = await makeAutomation();
      const other = await makeAutomation();

      // Two would_send, one would_block for `automation`; one would_send for `other`.
      await trigger(automation, `evt-${randomUUID().slice(0, 8)}`);
      await trigger(automation, `evt-${randomUUID().slice(0, 8)}`);
      mockPreflight.result = { ok: false, code: 'SUPPRESSED', reason: 'recipient suppressed' };
      await trigger(automation, `evt-${randomUUID().slice(0, 8)}`);
      mockPreflight.result = { ok: true };
      await trigger(other, `evt-${randomUUID().slice(0, 8)}`);

      const router = require('../routes/admin-email-templates');
      const app = express();
      app.use('/admin/email-templates', router);
      app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
      const server = app.listen(0);
      try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/email-templates/automations`);
        const body = await res.json();
        expect(res.status).toBe(200);
        const row = body.automations.find((r) => r.automation_key === automation.automation_key);
        const otherRow = body.automations.find((r) => r.automation_key === other.automation_key);
        expect(row).toMatchObject({ would_send_30d: 2, would_block_30d: 1 });
        expect(otherRow).toMatchObject({ would_send_30d: 1, would_block_30d: 0 });
        // Untouched automations report zeros, never undefined.
        const untouched = body.automations.find((r) => !automationKeys.includes(r.automation_key));
        if (untouched) expect(untouched).toMatchObject({ would_send_30d: 0, would_block_30d: 0 });
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });
});
