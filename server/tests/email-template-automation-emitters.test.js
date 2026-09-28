jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql) => ({ __raw: sql }));
  return fn;
});
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
  emitEstimateExpired, emitReviewLinked5Star, recordAutomationIntent, recordAutomationIntents, sweepMissedLifecycleEvents,
} = require('../services/email-template-automation-emitters');

beforeEach(() => {
  jest.clearAllMocks();
  isEnabled.mockReturnValue(true);
  emailTemplateAutomationsMode.mockReturnValue('live');
});

// Minimal in-memory table mock for email_template_automation_intents — the
// ONLY table this module touches directly since codex round 3 on #5154's
// marker rewrite (hasActiveAutomation / estimates / google_reviews queries
// are gone; the sweep no longer reads either entity table).
function mockIntentsTable(seedRows = []) {
  const rows = seedRows.map((r) => ({ attempts: 0, status: 'pending', ...r }));
  db.mockImplementation((table) => {
    if (table !== 'email_template_automation_intents') throw new Error(`unexpected table ${table}`);
    const wheres = [];
    let order = null;
    let cap = null;
    const q = {
      where: jest.fn((...args) => {
        wheres.push(args);
        return q;
      }),
      orderBy: jest.fn(() => { order = true; return q; }),
      limit: jest.fn((n) => { cap = n; return q; }),
      update: jest.fn(async (patch) => {
        const [idArgs] = wheres;
        const id = idArgs && idArgs[0] && idArgs[0].id;
        const row = rows.find((r) => r.id === id);
        if (row) {
          Object.assign(row, patch);
          if (patch.attempts && patch.attempts.__raw) row.attempts = (row.attempts || 0) + 1;
        }
        return row ? 1 : 0;
      }),
      insert: jest.fn((recordOrRecords) => ({
        onConflict: () => ({
          ignore: () => ({
            returning: async (cols) => {
              const records = Array.isArray(recordOrRecords) ? recordOrRecords : [recordOrRecords];
              const inserted = records.map((record) => {
                const row = { id: `intent-${rows.length + 1}`, ...record };
                rows.push(row);
                return row;
              });
              return inserted.map((row) => Object.fromEntries(cols.map((c) => [c, row[c]])));
            },
          }),
        }),
      })),
      then(resolve, reject) {
        let result = rows.filter((r) => r.status === 'pending');
        if (order) result = [...result].sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at));
        if (cap != null) result = result.slice(0, cap);
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return q;
  });
  return rows;
}

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

// codex round 3 on #5154 — the marker settlement contract emitTrigger now
// enforces: processed on success, pending-with-last_error on a transient
// failure (so the sweep retries it), unrecoverable on the ONE
// permanently-unresolvable-recipient error (so it never pins the sweep
// batch). This is the "fan-out" unit coverage the round-3 assignment asked
// for: a marker's retry re-invokes the direct emitter, which re-invokes
// processTrigger, which fans out over every active automation and dedupes
// per automation's own idempotency key (proven separately in
// email-template-automation-executor.test.js's idempotency describe block)
// — so a redundant concurrent retry of the SAME marker is always safe.
describe('marker settlement (emitTrigger / settleIntent)', () => {
  test('a successful emit settles its marker to processed', async () => {
    const rows = mockIntentsTable([{ id: 'intent-1', status: 'pending' }]);

    await emitEstimateExpired({ id: 'est-1', customer_email: 'sam@example.com' }, 'intent-1');

    expect(rows[0].status).toBe('processed');
  });

  test('a transient processTrigger failure keeps the marker pending, with last_error and an attempts bump', async () => {
    AutomationExecutor.processTrigger.mockRejectedValueOnce(new Error('connection reset'));
    const rows = mockIntentsTable([{ id: 'intent-1', status: 'pending', attempts: 2 }]);

    const result = await emitEstimateExpired({ id: 'est-1', customer_email: 'sam@example.com' }, 'intent-1');

    expect(result).toBeNull();
    expect(rows[0].status).toBe('pending');
    expect(rows[0].last_error).toContain('connection reset');
  });

  test('the ONE unresolvable-recipient error settles the marker unrecoverable (never retried) — codex P2: it must not pin the sweep batch', async () => {
    const err = new Error('recipient email is required for automation execution');
    err.status = 400;
    AutomationExecutor.processTrigger.mockRejectedValueOnce(err);
    const rows = mockIntentsTable([{ id: 'intent-1', status: 'pending' }]);

    await emitReviewLinked5Star({ reviewId: 'rev-1', customerId: 'cust-1', starRating: 5 }, 'intent-1');

    expect(rows[0].status).toBe('unrecoverable');
    expect(rows[0].last_error).toBe('recipient email is required for automation execution');
  });

  test('a DIFFERENT 400 error (not the recipient-email message) stays pending, not unrecoverable', async () => {
    const err = new Error('automation xyz does not define an idempotency key template');
    err.status = 400;
    AutomationExecutor.processTrigger.mockRejectedValueOnce(err);
    const rows = mockIntentsTable([{ id: 'intent-1', status: 'pending' }]);

    await emitEstimateExpired({ id: 'est-1', customer_email: 'sam@example.com' }, 'intent-1');

    expect(rows[0].status).toBe('pending');
  });

  test('gate off never touches the marker (left for a later replay once the gate is live/shadow)', async () => {
    isEnabled.mockReturnValue(false);
    const rows = mockIntentsTable([{ id: 'intent-1', status: 'pending' }]);

    await emitEstimateExpired({ id: 'est-1', customer_email: 'sam@example.com' }, 'intent-1');

    expect(rows[0].status).toBe('pending');
    expect(db).not.toHaveBeenCalled();
  });

  test('no intentId (a caller with no marker) settles nothing and never queries the db', async () => {
    mockIntentsTable([]);

    const result = await emitEstimateExpired({ id: 'est-1', customer_email: 'sam@example.com' });

    expect(result).not.toBeNull();
    expect(db).not.toHaveBeenCalled();
  });
});

describe('recordAutomationIntent / recordAutomationIntents', () => {
  test('records one marker and returns its id', async () => {
    const rows = mockIntentsTable([]);

    const intent = await recordAutomationIntent(db, {
      triggerEventKey: 'review.linked_5star', entityType: 'review', entityId: 'rev-1', occurredAt: new Date(), payload: { review_id: 'rev-1' },
    });

    expect(intent.id).toBe('intent-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].trigger_event_key).toBe('review.linked_5star');
    expect(rows[0].entity_id).toBe('rev-1');
  });

  test('batch-records one marker per entry', async () => {
    mockIntentsTable([]);

    const intents = await recordAutomationIntents(db, [
      { triggerEventKey: 'estimate.expired', entityType: 'estimate', entityId: 'est-1', occurredAt: new Date(), payload: {} },
      { triggerEventKey: 'estimate.expired', entityType: 'estimate', entityId: 'est-2', occurredAt: new Date(), payload: {} },
    ]);

    expect(intents.map((i) => i.entity_id)).toEqual(['est-1', 'est-2']);
  });

  test('an empty batch is a no-op (no query)', async () => {
    mockIntentsTable([]);

    const intents = await recordAutomationIntents(db, []);

    expect(intents).toEqual([]);
    expect(db).not.toHaveBeenCalled();
  });
});

describe('sweepMissedLifecycleEvents / retryPendingIntents', () => {
  test('no-op (no query at all) when the mode is off', async () => {
    emailTemplateAutomationsMode.mockReturnValue('off');
    mockIntentsTable([{ id: 'intent-1', trigger_event_key: 'estimate.expired' }]);

    const result = await sweepMissedLifecycleEvents();

    expect(result).toEqual({ intentsRetried: 0 });
    expect(db).not.toHaveBeenCalled();
    expect(AutomationExecutor.processTrigger).not.toHaveBeenCalled();
  });

  test('replays a pending estimate.expired marker through the direct emitter, oldest first', async () => {
    mockIntentsTable([
      {
        id: 'intent-2',
        trigger_event_key: 'estimate.expired',
        occurred_at: new Date('2026-01-01T00:10:00Z'),
        payload: JSON.stringify({ id: 'est-2', customer_email: 'later@example.com' }),
      },
      {
        id: 'intent-1',
        trigger_event_key: 'estimate.expired',
        occurred_at: new Date('2026-01-01T00:00:00Z'),
        payload: JSON.stringify({ id: 'est-1', customer_email: 'earlier@example.com' }),
      },
    ]);

    const result = await sweepMissedLifecycleEvents();

    expect(result.intentsRetried).toBe(2);
    const calls = AutomationExecutor.processTrigger.mock.calls.map((c) => c[0].entityId);
    expect(calls).toEqual(['est-1', 'est-2']); // oldest occurred_at first
  });

  test('replays a pending review.linked_5star marker through the direct emitter', async () => {
    mockIntentsTable([{
      id: 'intent-1',
      trigger_event_key: 'review.linked_5star',
      occurred_at: new Date('2026-01-01T00:00:00Z'),
      payload: JSON.stringify({ review_id: 'rev-1', customer_id: 'cust-1', location_id: 'venice', star_rating: 5 }),
    }]);

    const result = await sweepMissedLifecycleEvents();

    expect(result.intentsRetried).toBe(1);
    expect(AutomationExecutor.processTrigger).toHaveBeenCalledWith(expect.objectContaining({
      triggerEventKey: 'review.linked_5star', entityId: 'rev-1',
    }));
  });

  test('a marker for a trigger key this module has no replay logic for is left pending, never counted', async () => {
    mockIntentsTable([{
      id: 'intent-1',
      trigger_event_key: 'some.other.trigger',
      occurred_at: new Date('2026-01-01T00:00:00Z'),
      payload: JSON.stringify({}),
    }]);

    const result = await sweepMissedLifecycleEvents();

    expect(result.intentsRetried).toBe(0);
    expect(AutomationExecutor.processTrigger).not.toHaveBeenCalled();
  });

  test('nothing pending is a no-op result', async () => {
    mockIntentsTable([]);

    const result = await sweepMissedLifecycleEvents();

    expect(result).toEqual({ intentsRetried: 0 });
    expect(AutomationExecutor.processTrigger).not.toHaveBeenCalled();
  });

  test('runs under the exclusive lock', async () => {
    const { runExclusive } = require('../utils/cron-lock');
    mockIntentsTable([]);

    await sweepMissedLifecycleEvents();

    expect(runExclusive).toHaveBeenCalledWith('email-template-automation-lifecycle-sweep', expect.any(Function));
  });

  // codex P2 round 3 — the unrecoverable path must not pin the batch: an
  // unrecoverable row is settled OUT of 'pending' the moment it fails
  // (mockIntentsTable's `then()` only ever returns 'pending' rows, exactly
  // mirroring the real WHERE status = 'pending' clause), so a SECOND sweep
  // pass never re-selects it and always reaches whatever comes after it.
  test('an unrecoverable marker never resurfaces on a later sweep pass (real-Postgres proof of the same behavior lives in the -postgres suite)', async () => {
    const err = new Error('recipient email is required for automation execution');
    err.status = 400;
    AutomationExecutor.processTrigger.mockRejectedValueOnce(err);
    const rows = mockIntentsTable([{
      id: 'intent-1',
      trigger_event_key: 'estimate.expired',
      occurred_at: new Date('2026-01-01T00:00:00Z'),
      payload: JSON.stringify({ id: 'est-1', customer_email: '' }),
    }]);

    const first = await sweepMissedLifecycleEvents();
    expect(first.intentsRetried).toBe(0); // emitEstimateExpired returned null (the failure)
    expect(rows[0].status).toBe('unrecoverable');

    AutomationExecutor.processTrigger.mockClear();
    const second = await sweepMissedLifecycleEvents();
    expect(second.intentsRetried).toBe(0);
    expect(AutomationExecutor.processTrigger).not.toHaveBeenCalled();
  });
});
