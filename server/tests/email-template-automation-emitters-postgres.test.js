/**
 * Real PostgreSQL proof for the lifecycle sweep's SQL (codex round 2 on
 * #5154).
 *
 * A mocked db cannot catch any of these:
 *  - entity_id::text vs uuid casts: email_template_automation_runs.entity_id
 *    is varchar while estimates.id/google_reviews.id are uuid. Without the
 *    cast Postgres rejects the anti-join outright ("operator does not exist:
 *    character varying = uuid"), and the sweep's own try/catch silently
 *    swallows that into "0 emitted" forever.
 *  - per-automation reconciliation: several active automations can share one
 *    trigger, so the anti-join must be correlated per (entity, trigger,
 *    automation), not just per entity — otherwise one automation's run looks
 *    like full coverage and a later automation's missing run is never
 *    retried.
 *  - click_auto exclusion: a review linked only by the probabilistic
 *    click-tracking matcher must never surface until a human confirms it via
 *    manualAttributeGoogleReview.
 *
 * This runs the real, exported sweepMissedLifecycleEvents against a real,
 * migrated database so the type mismatch and the anti-join shape can never
 * come back silently.
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

(SKIP ? describe.skip : describe)('email-template-automation lifecycle sweep on PostgreSQL (codex round 2 on #5154)', () => {
  let db;
  let logger;
  let AutomationExecutor;
  let sweepMissedLifecycleEvents;

  beforeAll(() => {
    db = require('../models/db');
    logger = require('../services/logger');
    AutomationExecutor = require('../services/email-template-automation-executor');
    ({ sweepMissedLifecycleEvents } = require('../services/email-template-automation-emitters'));
  });

  afterAll(async () => { await db.destroy(); });

  beforeEach(() => {
    jest.clearAllMocks();
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

  async function makeTemplate() {
    const key = `qa_sweep_${randomUUID().slice(0, 8)}`;
    await db('email_templates').insert({ template_key: key, name: key, status: 'active' });
    return key;
  }

  async function makeAutomation({ triggerEventKey, templateKey, status = 'active' }) {
    const id = randomUUID();
    await db('email_template_automations').insert({
      id,
      automation_key: `qa_${id.slice(0, 8)}`,
      name: `QA sweep automation ${id.slice(0, 8)}`,
      trigger_event_key: triggerEventKey,
      template_key: templateKey,
      status,
    });
    return id;
  }

  async function makeRun({ automationId, entityType, entityId, templateKey, triggerEventKey }) {
    const id = randomUUID();
    await db('email_template_automation_runs').insert({
      id,
      automation_id: automationId,
      automation_key: `qa-run-${id.slice(0, 8)}`,
      trigger_event_key: triggerEventKey,
      entity_type: entityType,
      entity_id: entityId,
      template_key: templateKey,
      recipient_email: 'sweep-qa@example.com',
      idempotency_key: `qa:${id}`,
      status: 'shadow',
    });
    return id;
  }

  async function cleanup({
    customerIds = [], templateKeys = [], automationIds = [], estimateIds = [], reviewIds = [],
  }) {
    if (automationIds.length) await db('email_template_automation_runs').whereIn('automation_id', automationIds).del();
    if (estimateIds.length) await db('estimates').whereIn('id', estimateIds).del();
    if (reviewIds.length) await db('google_reviews').whereIn('id', reviewIds).del();
    if (automationIds.length) await db('email_template_automations').whereIn('id', automationIds).del();
    if (templateKeys.length) await db('email_templates').whereIn('template_key', templateKeys).del();
    if (customerIds.length) await db('customers').whereIn('id', customerIds).del();
  }

  test('estimate.expired sweep: the entity_id::text cast lets the uuid anti-join run without a Postgres type error', async () => {
    const templateKey = await makeTemplate();
    const automationId = await makeAutomation({ triggerEventKey: 'estimate.expired', templateKey });
    const estimateId = randomUUID();
    await db('estimates').insert({
      id: estimateId,
      status: 'expired',
      customer_email: 'sweep-qa@example.com',
      category: 'RESIDENTIAL',
      service_interest: 'Pest Control',
    });

    try {
      const result = await sweepMissedLifecycleEvents();

      expect(result.estimatesEmitted).toBe(1);
      expect(AutomationExecutor.processTrigger).toHaveBeenCalledWith(expect.objectContaining({
        triggerEventKey: 'estimate.expired',
        entityId: estimateId,
      }));
      expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('sweep query failed'));
    } finally {
      await cleanup({ templateKeys: [templateKey], automationIds: [automationId], estimateIds: [estimateId] });
    }
  });

  test('per-automation reconciliation: two active automations share a trigger; one has a run, the sweep still surfaces the entity for the missing one, then stops once both are covered', async () => {
    const templateKey = await makeTemplate();
    const customerId = await makeCustomer();
    const automationA = await makeAutomation({ triggerEventKey: 'review.linked_5star', templateKey });
    const automationB = await makeAutomation({ triggerEventKey: 'review.linked_5star', templateKey });
    const reviewId = randomUUID();
    await db('google_reviews').insert({
      id: reviewId, location_id: 'venice', star_rating: 5, customer_id: customerId,
    });
    await makeRun({
      automationId: automationA, entityType: 'review', entityId: reviewId, templateKey, triggerEventKey: 'review.linked_5star',
    });

    try {
      const result = await sweepMissedLifecycleEvents();

      // Automation A already has a run; automation B does not — one active
      // automation missing coverage is enough to surface the entity once.
      expect(result.reviewsEmitted).toBe(1);
      expect(AutomationExecutor.processTrigger).toHaveBeenCalledWith(expect.objectContaining({
        triggerEventKey: 'review.linked_5star',
        entityId: reviewId,
      }));
      expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('sweep query failed'));

      // Cover automation B too — nothing left missing, so a second sweep is silent.
      await makeRun({
        automationId: automationB, entityType: 'review', entityId: reviewId, templateKey, triggerEventKey: 'review.linked_5star',
      });
      jest.clearAllMocks();
      AutomationExecutor.processTrigger.mockResolvedValue({ automation_count: 1, results: [] });

      const second = await sweepMissedLifecycleEvents();

      expect(second.reviewsEmitted).toBe(0);
      expect(AutomationExecutor.processTrigger).not.toHaveBeenCalled();
    } finally {
      await cleanup({
        templateKeys: [templateKey], automationIds: [automationA, automationB], reviewIds: [reviewId], customerIds: [customerId],
      });
    }
  });

  test('click_auto exclusion: an unconfirmed click-tracking link never emits; the same review after manual confirmation does', async () => {
    const templateKey = await makeTemplate();
    const customerId = await makeCustomer();
    const automationId = await makeAutomation({ triggerEventKey: 'review.linked_5star', templateKey });
    const reviewId = randomUUID();
    await db('google_reviews').insert({
      id: reviewId, location_id: 'venice', star_rating: 5, customer_id: customerId, link_source: 'click_auto',
    });

    try {
      const firstPass = await sweepMissedLifecycleEvents();

      expect(firstPass.reviewsEmitted).toBe(0);
      expect(AutomationExecutor.processTrigger).not.toHaveBeenCalled();

      // Manual confirmation clears link_source, mirroring manualAttributeGoogleReview.
      await db('google_reviews').where({ id: reviewId }).update({ link_source: null, updated_at: new Date() });

      const secondPass = await sweepMissedLifecycleEvents();

      expect(secondPass.reviewsEmitted).toBe(1);
      expect(AutomationExecutor.processTrigger).toHaveBeenCalledWith(expect.objectContaining({
        triggerEventKey: 'review.linked_5star',
        entityId: reviewId,
      }));
    } finally {
      await cleanup({
        templateKeys: [templateKey], automationIds: [automationId], reviewIds: [reviewId], customerIds: [customerId],
      });
    }
  });
});
