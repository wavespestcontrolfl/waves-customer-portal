jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => true),
  emailTemplateAutomationsMode: jest.fn(() => 'live'),
}));
jest.mock('../services/email-template-automation-executor', () => ({
  processTrigger: jest.fn(async () => ({ automation_count: 1, results: [] })),
}));
jest.mock('../utils/cron-lock', () => ({
  runExclusive: jest.fn(async (_name, fn) => fn()),
}));

const db = require('../models/db');
const { isEnabled, emailTemplateAutomationsMode } = require('../config/feature-gates');
const AutomationExecutor = require('../services/email-template-automation-executor');
const {
  emitEstimateExpired, emitReviewLinked5Star, sweepMissedLifecycleEvents,
} = require('../services/email-template-automation-emitters');

beforeEach(() => {
  jest.clearAllMocks();
  isEnabled.mockReturnValue(true);
  emailTemplateAutomationsMode.mockReturnValue('live');
});

describe('emitReviewLinked5Star', () => {
  test('no-op below 5 stars', async () => {
    const result = await emitReviewLinked5Star({ reviewId: 'rev-1', customerId: 'cust-1', locationId: 'venice', starRating: 4 });
    expect(result).toBeNull();
    expect(AutomationExecutor.processTrigger).not.toHaveBeenCalled();
  });

  test('no-op without a linked customer', async () => {
    const result = await emitReviewLinked5Star({ reviewId: 'rev-1', customerId: null, locationId: 'venice', starRating: 5 });
    expect(result).toBeNull();
    expect(AutomationExecutor.processTrigger).not.toHaveBeenCalled();
  });

  test('fires review.linked_5star on a 5-star linked review', async () => {
    await emitReviewLinked5Star({ reviewId: 'rev-1', customerId: 'cust-1', locationId: 'venice', starRating: 5 });
    expect(AutomationExecutor.processTrigger).toHaveBeenCalledWith(expect.objectContaining({
      triggerEventKey: 'review.linked_5star',
      entityType: 'review',
      entityId: 'rev-1',
      recipient: { type: 'customer', id: 'cust-1' },
      payload: { review_id: 'rev-1', customer_id: 'cust-1', location_id: 'venice' },
    }));
  });
});

describe('emitEstimateExpired', () => {
  test('no-op without an id', async () => {
    const result = await emitEstimateExpired({});
    expect(result).toBeNull();
    expect(AutomationExecutor.processTrigger).not.toHaveBeenCalled();
  });

  test("fires estimate.expired with the flipped row's fields", async () => {
    await emitEstimateExpired({
      id: 'est-1', customer_id: 'cust-1', customer_email: 'sam@example.com',
      category: 'RESIDENTIAL', service_interest: 'Pest Control', expires_at: '2026-06-01',
    });
    expect(AutomationExecutor.processTrigger).toHaveBeenCalledWith(expect.objectContaining({
      triggerEventKey: 'estimate.expired',
      entityType: 'estimate',
      entityId: 'est-1',
      payload: expect.objectContaining({ estimate_id: 'est-1', category: 'RESIDENTIAL', service_interest: 'Pest Control' }),
    }));
  });
});

describe('gate off is a blanket no-op', () => {
  test('every emitter no-ops without calling the executor or the db', async () => {
    isEnabled.mockReturnValue(false);
    await emitEstimateExpired({ id: 'est-1', customer_email: 'sam@example.com' });
    await emitReviewLinked5Star({ reviewId: 'rev-1', customerId: 'cust-1', starRating: 5 });
    expect(AutomationExecutor.processTrigger).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
  });
});

describe('sweepMissedLifecycleEvents', () => {
  // A minimal builder keyed by table: email_template_automations answers
  // hasActiveAutomation from whichever trigger_event_key was where()'d;
  // estimates/google_reviews resolve (thenable) to the seeded rows —
  // the mock doesn't model whereNotExists' SQL, so "already has a run" is
  // expressed by simply not seeding that row in the first place.
  function mockDb({ activeKeys = [], estimateRows = [], reviewRows = [] } = {}) {
    db.mockImplementation((table) => {
      const wheres = [];
      const q = {
        where: jest.fn((arg) => { wheres.push(arg); return q; }),
        whereNotNull: jest.fn(() => q),
        whereNull: jest.fn(() => q),
        whereNotExists: jest.fn(() => q),
        select: jest.fn(() => q),
        limit: jest.fn(() => q),
        first: jest.fn(async () => {
          const cond = wheres.find((w) => w && typeof w === 'object' && w.trigger_event_key);
          const key = cond && cond.trigger_event_key;
          return activeKeys.includes(key) ? { id: `automation-${key}` } : null;
        }),
        then(resolve, reject) {
          const rows = table === 'estimates as e' ? estimateRows : table === 'google_reviews as g' ? reviewRows : [];
          return Promise.resolve(rows).then(resolve, reject);
        },
      };
      return q;
    });
  }

  test('no-op (no query at all) when the mode is off', async () => {
    emailTemplateAutomationsMode.mockReturnValue('off');
    mockDb();

    const result = await sweepMissedLifecycleEvents();

    expect(result).toEqual({ estimatesEmitted: 0, reviewsEmitted: 0 });
    expect(db).not.toHaveBeenCalled();
    expect(AutomationExecutor.processTrigger).not.toHaveBeenCalled();
  });

  test('does no work for a key with no active automation (zero entity query for that key)', async () => {
    mockDb({ activeKeys: [] });

    const result = await sweepMissedLifecycleEvents();

    expect(result).toEqual({ estimatesEmitted: 0, reviewsEmitted: 0 });
    expect(db).not.toHaveBeenCalledWith('estimates as e');
    expect(db).not.toHaveBeenCalledWith('google_reviews as g');
    expect(AutomationExecutor.processTrigger).not.toHaveBeenCalled();
  });

  test('emits estimate.expired for a missed expired estimate', async () => {
    mockDb({
      activeKeys: ['estimate.expired'],
      estimateRows: [{
        id: 'est-missed', customer_id: 'cust-1', customer_email: 'sam@example.com',
        category: 'RESIDENTIAL', service_interest: 'Pest Control', expires_at: '2026-06-01',
      }],
    });

    const result = await sweepMissedLifecycleEvents();

    expect(result.estimatesEmitted).toBe(1);
    expect(AutomationExecutor.processTrigger).toHaveBeenCalledWith(expect.objectContaining({
      triggerEventKey: 'estimate.expired',
      entityId: 'est-missed',
    }));
  });

  test('emits review.linked_5star for a missed five-star linked review', async () => {
    mockDb({
      activeKeys: ['review.linked_5star'],
      reviewRows: [{ id: 'rev-missed', customer_id: 'cust-1', location_id: 'venice', star_rating: 5 }],
    });

    const result = await sweepMissedLifecycleEvents();

    expect(result.reviewsEmitted).toBe(1);
    expect(AutomationExecutor.processTrigger).toHaveBeenCalledWith(expect.objectContaining({
      triggerEventKey: 'review.linked_5star',
      entityId: 'rev-missed',
    }));
  });

  test('emits nothing when no rows are missed (both keys active, nothing seeded)', async () => {
    mockDb({ activeKeys: ['estimate.expired', 'review.linked_5star'] });

    const result = await sweepMissedLifecycleEvents();

    expect(result).toEqual({ estimatesEmitted: 0, reviewsEmitted: 0 });
    expect(AutomationExecutor.processTrigger).not.toHaveBeenCalled();
  });

  test('runs under the exclusive lock', async () => {
    const { runExclusive } = require('../utils/cron-lock');
    mockDb();

    await sweepMissedLifecycleEvents();

    expect(runExclusive).toHaveBeenCalledWith('email-template-automation-lifecycle-sweep', expect.any(Function));
  });
});
