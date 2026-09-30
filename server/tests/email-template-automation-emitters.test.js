jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql, bindings) => ({ __raw: sql, bindings }));
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
  INTENT_MAX_AGE_MS, MAX_INTENT_ATTEMPTS, emitEstimateExpired, emitReviewLinked5Star, emitVisitCompletedFirst, recordAutomationIntent, recordAutomationIntents, sweepMissedLifecycleEvents,
} = require('../services/email-template-automation-emitters');

beforeEach(() => {
  jest.clearAllMocks();
  // clearAllMocks keeps implementations — reset the executor stub so a
  // test's persistent mockRejectedValue/mockImplementation can't leak.
  AutomationExecutor.processTrigger.mockReset();
  AutomationExecutor.processTrigger.mockImplementation(async () => ({ automation_count: 1, results: [] }));
  isEnabled.mockReset();
  isEnabled.mockReturnValue(true);
  emailTemplateAutomationsMode.mockReset();
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
      orderBy: jest.fn((spec) => { order = spec; return q; }),
      limit: jest.fn((n) => { cap = n; return q; }),
      // Emulates Postgres UPDATE semantics for the two raw expressions this
      // module writes: every SET expression reads the PRE-update row, so the
      // status CASE and the attempts increment both start from the same
      // attempts value (the real-SQL proof is in the -postgres suite).
      update: jest.fn(async (patch) => {
        const [idArgs] = wheres;
        const id = idArgs && idArgs[0] && idArgs[0].id;
        const row = rows.find((r) => r.id === id);
        if (row) {
          const before = row.attempts || 0;
          const next = { ...patch };
          if (next.attempts && next.attempts.__raw) next.attempts = before + 1;
          if (next.status && next.status.__raw) {
            const [ceiling] = next.status.bindings;
            next.status = before + 1 >= ceiling ? 'unrecoverable' : 'pending';
          }
          Object.assign(row, next);
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
        if (order) {
          // Honors the (attempts asc, occurred_at asc) ORDER BY the sweep
          // declares — asserted against the declared spec in a test below.
          result = [...result].sort((a, b) => ((a.attempts || 0) - (b.attempts || 0))
            || (new Date(a.occurred_at) - new Date(b.occurred_at)));
        }
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

describe('emitVisitCompletedFirst (the email division\'s lc.first_visit_pest; no caller wired yet)', () => {
  test('hands the executor ids only, keyed per service record, for the customer recipient', async () => {
    await emitVisitCompletedFirst({ serviceRecordId: 'rec-1', customerId: 'cust-1' });
    expect(AutomationExecutor.processTrigger).toHaveBeenCalledWith({
      triggerEventKey: 'visit.completed_first',
      executeImmediately: true,
      triggerEventId: 'visit_completed_first:rec-1',
      entityType: 'service_record',
      entityId: 'rec-1',
      recipient: { type: 'customer', id: 'cust-1' },
      payload: { service_record_id: 'rec-1', customer_id: 'cust-1' },
    });
  });

  test('no record or no customer -> nothing emitted; gate off -> a no-op', async () => {
    expect(await emitVisitCompletedFirst({ serviceRecordId: 'rec-1' })).toBeNull();
    expect(await emitVisitCompletedFirst({ customerId: 'cust-1' })).toBeNull();
    isEnabled.mockReturnValue(false);
    expect(await emitVisitCompletedFirst({ serviceRecordId: 'rec-1', customerId: 'cust-1' })).toBeNull();
    expect(AutomationExecutor.processTrigger).not.toHaveBeenCalled();
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

describe('emitEstimateExpired expires_on (the per-expiry idempotency input)', () => {
  test('is the expiry\'s ET date, identical on a direct emit and on a marker replay', async () => {
    const row = { id: 'est-1', customer_id: 'cust-1', customer_email: 'sam@example.com', expires_at: '2026-09-21T02:00:00.000Z' };
    await emitEstimateExpired(row);
    await emitEstimateExpired({ ...row, expires_at: new Date(row.expires_at) });
    const payloads = AutomationExecutor.processTrigger.mock.calls.map(([args]) => args.payload.expires_on);
    expect(payloads).toEqual(['2026-09-20', '2026-09-20']); // 10 PM ET the evening before, not the UTC date
  });
});

describe('emitEstimateExpired with no expires_at (Rule 1 aged-out estimates)', () => {
  const flip = '2026-09-21T02:30:00.000Z'; // 10:30 PM ET on Sep 20
  const keyOf = () => AutomationExecutor.processTrigger.mock.calls.map(([args]) => args.payload.expires_on);

  test('the flip\'s own ET date stands in; a direct emit (row.updated_at) and a replay (marker flipped_at) give the SAME value', async () => {
    const base = { id: 'est-9', customer_id: 'cust-1', customer_email: 'sam@example.com', expires_at: null };
    await emitEstimateExpired({ ...base, updated_at: new Date(flip) });
    await emitEstimateExpired({ ...base, flipped_at: flip });
    expect(keyOf()).toEqual(['2026-09-20', '2026-09-20']);
    // The key template the automations use renders from it (no 400, no burnt replays).
    const { renderIdempotencyKey } = jest.requireActual('../services/email-template-automation-executor');
    const payload = AutomationExecutor.processTrigger.mock.calls[0][0].payload;
    expect(renderIdempotencyKey('nurture.expired_1:{estimate_id}:{expires_on}', payload)).toBe('nurture.expired_1:est-9:2026-09-20');
  });

  test('an explicit expires_at still wins over the flip time', async () => {
    await emitEstimateExpired({
      id: 'est-9', customer_email: 'sam@example.com', expires_at: '2026-09-18T16:00:00.000Z', updated_at: flip,
    });
    expect(keyOf()).toEqual(['2026-09-18']);
  });

  test('an estimate aged out EARLY (expires_at later than the actual flip) uses the flip date: effective = the earlier of the two, direct and replay alike', async () => {
    const base = { id: 'est-9', customer_email: 'sam@example.com', expires_at: '2026-10-20T16:00:00.000Z' };
    await emitEstimateExpired({ ...base, updated_at: new Date(flip) });
    await emitEstimateExpired({ ...base, flipped_at: flip });
    expect(keyOf()).toEqual(['2026-09-20', '2026-09-20']);
  });

  test('neither an expiry nor a flip time: settled unrecoverable on the first look, never replayed', async () => {
    const rows = mockIntentsTable([{ id: 'intent-1', status: 'pending' }]);
    await emitEstimateExpired({ id: 'est-9', customer_email: 'sam@example.com', expires_at: null }, 'intent-1');
    expect(AutomationExecutor.processTrigger).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ status: 'unrecoverable', last_error: 'marker payload has neither an expiry nor a flip time' });
  });
});

describe('replaying a legacy estimate.expired marker (written before flipped_at existed)', () => {
  test('a Rule 1 marker with no expires_at and no flipped_at is replayed with its occurred_at as the flip instant — not dropped', async () => {
    const occurred = new Date('2026-09-21T02:30:00.000Z'); // 10:30 PM ET on Sep 20
    const rows = mockIntentsTable([{
      id: 'intent-legacy', status: 'pending', trigger_event_key: 'estimate.expired', occurred_at: occurred,
      payload: { id: 'est-old', customer_id: 'cust-1', customer_email: 'sam@example.com', expires_at: null },
    }]);

    const swept = await sweepMissedLifecycleEvents();

    expect(swept.intentsRetried).toBe(1);
    expect(AutomationExecutor.processTrigger).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ estimate_id: 'est-old', expires_on: '2026-09-20' }),
    }));
    expect(rows[0].status).toBe('processed');
  });
});

describe('gate off is a blanket no-op', () => {
  test('every emitter no-ops without calling the executor or the db', async () => {
    isEnabled.mockReturnValue(false);
    await emitEstimateExpired({ id: 'est-1', customer_email: 'sam@example.com', expires_at: '2026-09-21T16:00:00.000Z' });
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

    await emitEstimateExpired({ id: 'est-1', customer_email: 'sam@example.com', expires_at: '2026-09-21T16:00:00.000Z' }, 'intent-1');

    expect(rows[0].status).toBe('processed');
  });

  test('a transient processTrigger failure keeps the marker pending, with last_error and an attempts bump', async () => {
    AutomationExecutor.processTrigger.mockRejectedValueOnce(new Error('connection reset'));
    const rows = mockIntentsTable([{ id: 'intent-1', status: 'pending', attempts: 2 }]);

    const result = await emitEstimateExpired({ id: 'est-1', customer_email: 'sam@example.com', expires_at: '2026-09-21T16:00:00.000Z' }, 'intent-1');

    expect(result).toBeNull();
    expect(rows[0].status).toBe('pending');
    expect(rows[0].attempts).toBe(3);
    expect(rows[0].last_error).toContain('connection reset');
  });

  // pre-push audit P1 — attempts ceiling: ANY persistent failure, not just
  // the recipient-email one, stops being retried at MAX_INTENT_ATTEMPTS.
  test('the failure that reaches MAX_INTENT_ATTEMPTS settles the marker unrecoverable', async () => {
    AutomationExecutor.processTrigger.mockRejectedValue(new Error('Connection terminated unexpectedly'));
    const rows = mockIntentsTable([{ id: 'intent-1', status: 'pending', attempts: MAX_INTENT_ATTEMPTS - 2 }]);

    await emitEstimateExpired({ id: 'est-1', customer_email: 'sam@example.com', expires_at: '2026-09-21T16:00:00.000Z' }, 'intent-1');
    expect(rows[0]).toMatchObject({ status: 'pending', attempts: MAX_INTENT_ATTEMPTS - 1 });

    await emitEstimateExpired({ id: 'est-1', customer_email: 'sam@example.com', expires_at: '2026-09-21T16:00:00.000Z' }, 'intent-1');
    expect(rows[0]).toMatchObject({ status: 'unrecoverable', attempts: MAX_INTENT_ATTEMPTS });
    expect(rows[0].last_error).toContain('Connection terminated');
    expect(MAX_INTENT_ATTEMPTS).toBeGreaterThan(1);
  });

  // pre-push audit P1 — PII in logs: a Postgres constraint error / Knex SQL
  // prefix can echo the email and phone it was handed. Neither the log line
  // nor the persisted last_error may carry them.
  test('the logged and persisted error text is PII-scrubbed', async () => {
    const logger = require('../services/logger');
    AutomationExecutor.processTrigger.mockRejectedValueOnce(new Error(
      "insert into \"email_template_automation_runs\" (\"recipient_email\") values ('sam@example.com') - duplicate key value violates unique constraint: Key (recipient_email)=(sam@example.com), phone +1 (941) 555-0142",
    ));
    const rows = mockIntentsTable([{ id: 'intent-1', status: 'pending' }]);

    await emitEstimateExpired({ id: 'est-1', customer_email: 'sam@example.com', expires_at: '2026-09-21T16:00:00.000Z' }, 'intent-1');

    expect(rows[0].last_error).toContain('duplicate key value');
    expect(rows[0].last_error).not.toContain('sam@example.com');
    expect(rows[0].last_error).not.toContain('555-0142');
    const logged = logger.warn.mock.calls.map((c) => c[0]).join('\n');
    expect(logged).toContain('estimate.expired emit failed');
    expect(logged).not.toContain('sam@example.com');
    expect(logged).not.toContain('555-0142');
  });

  test('the recipient-email-required error is classified by its CODE, independent of the message text and status', async () => {
    const err = new Error('some reworded message');
    err.code = 'AUTOMATION_RECIPIENT_EMAIL_REQUIRED';
    AutomationExecutor.processTrigger.mockRejectedValueOnce(err);
    const rows = mockIntentsTable([{ id: 'intent-1', status: 'pending' }]);

    await emitReviewLinked5Star({ reviewId: 'rev-1', customerId: 'cust-1', starRating: 5 }, 'intent-1');

    expect(rows[0].status).toBe('unrecoverable');
  });

  test('a marker whose payload fails the emitter guard is settled unrecoverable, never left pending', async () => {
    const rows = mockIntentsTable([
      { id: 'intent-1', status: 'pending' },
      { id: 'intent-2', status: 'pending' },
    ]);

    await emitEstimateExpired({}, 'intent-1');
    await emitReviewLinked5Star({ reviewId: 'rev-1', customerId: 'cust-1', starRating: 4 }, 'intent-2');

    expect(AutomationExecutor.processTrigger).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ status: 'unrecoverable', last_error: 'marker payload has no estimate id' });
    expect(rows[1]).toMatchObject({ status: 'unrecoverable', last_error: 'marker payload is not a linked 5-star review' });
  });

  test('the unresolvable-recipient error settles the marker unrecoverable (never retried) — codex P2: it must not pin the sweep batch', async () => {
    const err = new Error('recipient email is required for automation execution');
    err.status = 400;
    AutomationExecutor.processTrigger.mockRejectedValueOnce(err);
    const rows = mockIntentsTable([{ id: 'intent-1', status: 'pending' }]);

    await emitReviewLinked5Star({ reviewId: 'rev-1', customerId: 'cust-1', starRating: 5 }, 'intent-1');

    expect(rows[0].status).toBe('unrecoverable');
    expect(rows[0].last_error).toBe('recipient email is required for automation execution');
  });

  // codex P2 round 4 — every executor 400 is a deterministic
  // configuration/validation error (blank idempotency template, a key
  // variable the payload never provides, ...): retrying the same marker can
  // only fail the same way, so it terminalizes on the first failure.
  test.each([
    'automation xyz does not define an idempotency key template',
    'idempotency key missing variable(s): appointment_id',
  ])('a deterministic executor 400 (%s) settles the marker unrecoverable immediately', async (message) => {
    const err = new Error(message);
    err.status = 400;
    AutomationExecutor.processTrigger.mockRejectedValueOnce(err);
    const rows = mockIntentsTable([{ id: 'intent-1', status: 'pending' }]);

    await emitEstimateExpired({ id: 'est-1', customer_email: 'sam@example.com', expires_at: '2026-09-21T16:00:00.000Z' }, 'intent-1');

    expect(rows[0]).toMatchObject({ status: 'unrecoverable', attempts: 1, last_error: message });
  });

  // Per-automation isolation (pre-live fix): processTrigger visits every
  // automation before rethrowing, tagging the error with each failure. The
  // marker is shared, so a fixable automation-configuration 400 must leave it
  // pending (bounded retries) instead of terminalizing it for every automation.
  test('an automation-configuration 400 from processTrigger keeps the shared marker pending, naming the failing automation', async () => {
    const err = Object.assign(new Error('automation a.broken does not define an idempotency key template'), {
      status: 400,
      automationFailures: [{ automation_key: 'a.broken', status: 400, code: null, message: 'x' }],
    });
    AutomationExecutor.processTrigger.mockRejectedValueOnce(err);
    const rows = mockIntentsTable([{ id: 'intent-1', status: 'pending' }]);

    await emitEstimateExpired({ id: 'est-1', customer_email: 'sam@example.com', expires_at: '2026-09-21T16:00:00.000Z' }, 'intent-1');

    expect(rows[0]).toMatchObject({ status: 'pending', attempts: 1 });
    expect(rows[0].last_error).toContain('a.broken');
  });

  test('a mixed failure set (one config 400, one recipient error) still stays pending: the config one is fixable', async () => {
    const err = Object.assign(new Error('recipient email is required for automation execution'), {
      status: 400,
      code: 'AUTOMATION_RECIPIENT_EMAIL_REQUIRED',
      automationFailures: [
        { automation_key: 'a.recipient', status: 400, code: 'AUTOMATION_RECIPIENT_EMAIL_REQUIRED', message: 'x' },
        { automation_key: 'b.broken', status: 400, code: null, message: 'y' },
      ],
    });
    AutomationExecutor.processTrigger.mockRejectedValueOnce(err);
    const rows = mockIntentsTable([{ id: 'intent-1', status: 'pending' }]);

    await emitEstimateExpired({ id: 'est-1', customer_email: 'sam@example.com', expires_at: '2026-09-21T16:00:00.000Z' }, 'intent-1');

    expect(rows[0]).toMatchObject({ status: 'pending', attempts: 1 });
  });

  test('a failure set made entirely of the permanent recipient error still settles unrecoverable at once', async () => {
    const err = Object.assign(new Error('recipient email is required for automation execution'), {
      status: 400,
      code: 'AUTOMATION_RECIPIENT_EMAIL_REQUIRED',
      automationFailures: [
        { automation_key: 'a', status: 400, code: 'AUTOMATION_RECIPIENT_EMAIL_REQUIRED', message: 'x' },
        { automation_key: 'b', status: 400, code: 'AUTOMATION_RECIPIENT_EMAIL_REQUIRED', message: 'x' },
      ],
    });
    AutomationExecutor.processTrigger.mockRejectedValueOnce(err);
    const rows = mockIntentsTable([{ id: 'intent-1', status: 'pending' }]);

    await emitEstimateExpired({ id: 'est-1', customer_email: 'sam@example.com', expires_at: '2026-09-21T16:00:00.000Z' }, 'intent-1');

    expect(rows[0].status).toBe('unrecoverable');
  });

  test('a non-400 failure (no status, e.g. a DB hiccup) stays pending for another attempt', async () => {
    const err = new Error('Connection terminated unexpectedly');
    err.code = 'ECONNRESET';
    AutomationExecutor.processTrigger.mockRejectedValueOnce(err);
    const rows = mockIntentsTable([{ id: 'intent-1', status: 'pending' }]);

    await emitEstimateExpired({ id: 'est-1', customer_email: 'sam@example.com', expires_at: '2026-09-21T16:00:00.000Z' }, 'intent-1');

    expect(rows[0]).toMatchObject({ status: 'pending', attempts: 1 });
  });

  // codex P2 round 5 — the executor's recipient lookup FAILING (503,
  // AUTOMATION_RECIPIENT_LOOKUP_FAILED) is transient, unlike a customer that
  // resolves no address (400 / AUTOMATION_RECIPIENT_EMAIL_REQUIRED).
  test('a failed recipient lookup (503) keeps a review marker pending for the sweep', async () => {
    AutomationExecutor.processTrigger.mockRejectedValueOnce(Object.assign(
      new Error('recipient email lookup failed: connection terminated'),
      { status: 503, code: 'AUTOMATION_RECIPIENT_LOOKUP_FAILED', retryable: true },
    ));
    const rows = mockIntentsTable([{ id: 'intent-1', status: 'pending' }]);

    await emitReviewLinked5Star({ reviewId: 'rev-1', customerId: 'cust-1', locationId: 'venice', starRating: 5 }, 'intent-1');

    expect(rows[0]).toMatchObject({ status: 'pending', attempts: 1 });
  });

  // codex P1 round 4 — the executor's off-mode no-op evaluated nothing, so
  // it must never settle the marker 'processed' (covers a mode flip between
  // the emitter's gate read and the executor's own).
  test('an off-mode (disabled) executor result leaves the marker pending and untouched', async () => {
    AutomationExecutor.processTrigger.mockResolvedValueOnce({
      trigger_event_key: 'estimate.expired', automation_count: 0, results: [], disabled: true,
    });
    const rows = mockIntentsTable([{ id: 'intent-1', status: 'pending', attempts: 0 }]);

    const result = await emitEstimateExpired({ id: 'est-1', customer_email: 'sam@example.com', expires_at: '2026-09-21T16:00:00.000Z' }, 'intent-1');

    expect(result).toBeNull();
    expect(rows[0]).toMatchObject({ status: 'pending', attempts: 0 });
    expect(rows[0].last_error).toBeUndefined();
  });

  test('a LIVE zero-automation result (no disabled flag) still settles processed', async () => {
    AutomationExecutor.processTrigger.mockResolvedValueOnce({ trigger_event_key: 'estimate.expired', automation_count: 0, results: [] });
    const rows = mockIntentsTable([{ id: 'intent-1', status: 'pending' }]);

    await emitEstimateExpired({ id: 'est-1', customer_email: 'sam@example.com', expires_at: '2026-09-21T16:00:00.000Z' }, 'intent-1');

    expect(rows[0].status).toBe('processed');
  });

  // codex P1 round 4 — through the REAL gate reader: a non-prod explicit
  // kill switch makes the emitter a no-op that leaves its marker pending.
  test.each(['false', 'off'])('NODE_ENV=development + GATE_EMAIL_TEMPLATE_AUTOMATIONS=%s (real gate): the emitter leaves the marker pending and never reaches the executor', async (gateValue) => {
    const realGates = jest.requireActual('../config/feature-gates');
    const savedGate = process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS;
    const savedNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = gateValue;
    isEnabled.mockImplementation((gate) => realGates.isEnabled(gate));
    emailTemplateAutomationsMode.mockImplementation(() => realGates.emailTemplateAutomationsMode());
    try {
      const rows = mockIntentsTable([{ id: 'intent-1', status: 'pending', trigger_event_key: 'estimate.expired', occurred_at: new Date('2026-01-01T00:00:00Z'), payload: { id: 'est-1', customer_email: 'sam@example.com', expires_at: '2026-09-21T16:00:00.000Z' } }]);

      const direct = await emitEstimateExpired({ id: 'est-1', customer_email: 'sam@example.com', expires_at: '2026-09-21T16:00:00.000Z' }, 'intent-1');
      const sweep = await sweepMissedLifecycleEvents();

      expect(direct).toBeNull();
      expect(sweep).toEqual({ intentsRetried: 0 });
      expect(AutomationExecutor.processTrigger).not.toHaveBeenCalled();
      expect(db).not.toHaveBeenCalled();
      expect(rows[0]).toMatchObject({ status: 'pending', attempts: 0 });
    } finally {
      if (savedGate === undefined) delete process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS;
      else process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = savedGate;
      process.env.NODE_ENV = savedNodeEnv;
      isEnabled.mockReset();
      emailTemplateAutomationsMode.mockReset();
    }
  });

  test('gate off never touches the marker (left for a later replay once the gate is live/shadow)', async () => {
    isEnabled.mockReturnValue(false);
    const rows = mockIntentsTable([{ id: 'intent-1', status: 'pending' }]);

    await emitEstimateExpired({ id: 'est-1', customer_email: 'sam@example.com', expires_at: '2026-09-21T16:00:00.000Z' }, 'intent-1');

    expect(rows[0].status).toBe('pending');
    expect(db).not.toHaveBeenCalled();
  });

  test('no intentId (a caller with no marker) settles nothing and never queries the db', async () => {
    mockIntentsTable([]);

    const result = await emitEstimateExpired({ id: 'est-1', customer_email: 'sam@example.com', expires_at: '2026-09-21T16:00:00.000Z' });

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
  // pre-push audit P1 on 37af26ca7b — replay shelf life. The in-memory
  // table mock above ignores range predicates, so these pin the statements
  // themselves; the real-SQL proof is in the -postgres suite.
  function recordingBuilders({ updateError = null } = {}) {
    const builders = [];
    db.mockImplementation(() => {
      const b = { wheres: [], patch: null };
      b.where = jest.fn((...args) => { b.wheres.push(args); return b; });
      b.orderBy = jest.fn(() => b);
      b.limit = jest.fn(() => b);
      b.update = jest.fn(async (patch) => { b.patch = patch; if (updateError) throw updateError; return 0; });
      b.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
      builders.push(b);
      return b;
    });
    return builders;
  }

  test('settles markers past the 24h replay shelf life stale BEFORE reading the batch, and the batch excludes them', async () => {
    const builders = recordingBuilders();
    const before = Date.now();

    await sweepMissedLifecycleEvents();

    const [stale, batch] = builders;
    expect(INTENT_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
    expect(stale.wheres[0]).toEqual(['status', 'pending']);
    const [col, op, cutoff] = stale.wheres[1];
    expect([col, op]).toEqual(['occurred_at', '<']);
    expect(Math.abs(cutoff.getTime() - (before - INTENT_MAX_AGE_MS))).toBeLessThan(5000);
    expect(stale.patch).toEqual(expect.objectContaining({ status: 'unrecoverable', last_error: expect.stringMatching(/^stale/) }));
    expect(batch.wheres).toContainEqual(['occurred_at', '>=', cutoff]);
    expect(AutomationExecutor.processTrigger).not.toHaveBeenCalled();
  });

  test('a failed stale settle skips the tick (fail closed) — nothing is read or replayed', async () => {
    const builders = recordingBuilders({ updateError: new Error('db unavailable') });

    const result = await sweepMissedLifecycleEvents();

    expect(result).toEqual({ intentsRetried: 0 });
    expect(builders).toHaveLength(1);
    expect(AutomationExecutor.processTrigger).not.toHaveBeenCalled();
  });

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
        payload: JSON.stringify({ id: 'est-2', customer_email: 'later@example.com', expires_at: '2026-09-21T16:00:00.000Z' }),
      },
      {
        id: 'intent-1',
        trigger_event_key: 'estimate.expired',
        occurred_at: new Date('2026-01-01T00:00:00Z'),
        payload: JSON.stringify({ id: 'est-1', customer_email: 'earlier@example.com', expires_at: '2026-09-21T16:00:00.000Z' }),
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

  test('a marker for a trigger key this module has no replay logic for counts a failed attempt (never dropped outright, never counted)', async () => {
    const rows = mockIntentsTable([{
      id: 'intent-1',
      trigger_event_key: 'some.other.trigger',
      occurred_at: new Date('2026-01-01T00:00:00Z'),
      payload: JSON.stringify({}),
    }]);

    const result = await sweepMissedLifecycleEvents();

    expect(result.intentsRetried).toBe(0);
    expect(AutomationExecutor.processTrigger).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ status: 'pending', attempts: 1, last_error: 'no replay handler for trigger some.other.trigger' });
  });

  test('no query at all when the boolean gate is off (every replay would be a no-op)', async () => {
    isEnabled.mockReturnValue(false);
    mockIntentsTable([{ id: 'intent-1', trigger_event_key: 'estimate.expired' }]);

    const result = await sweepMissedLifecycleEvents();

    expect(result).toEqual({ intentsRetried: 0 });
    expect(db).not.toHaveBeenCalled();
  });

  test('orders the batch fewest-attempts first, oldest first within a tier', async () => {
    mockIntentsTable([]);

    await sweepMissedLifecycleEvents();

    // results[0] is the stale-marker settle (replay shelf life); [1] is the batch read.
    const query = db.mock.results[1].value;
    expect(query.orderBy).toHaveBeenCalledWith([
      { column: 'attempts', order: 'asc' },
      { column: 'occurred_at', order: 'asc' },
    ]);
  });

  // pre-push audit P1 — a persistently failing backlog bigger than the
  // LIMIT must not starve later markers: after one tick every failing row
  // carries attempts=1, so the next tick reaches the never-attempted marker
  // behind them; and a failing row stops being retried at the ceiling.
  test('a backlog of failing markers larger than the batch never starves a later marker, and each failing row settles at the ceiling', async () => {
    const failing = Array.from({ length: 100 }, (_, i) => ({
      id: `stuck-${i}`,
      trigger_event_key: 'estimate.expired',
      occurred_at: new Date(Date.UTC(2026, 0, 1, 0, i)),
      payload: { id: `est-stuck-${i}`, customer_email: 'stuck@example.com', expires_at: '2026-09-21T16:00:00.000Z' },
    }));
    const fresh = {
      id: 'fresh-1',
      trigger_event_key: 'estimate.expired',
      occurred_at: new Date('2026-01-02T00:00:00Z'),
      payload: { id: 'est-fresh', customer_email: 'fresh@example.com', expires_at: '2026-09-21T16:00:00.000Z' },
    };
    const rows = mockIntentsTable([...failing, fresh]);
    AutomationExecutor.processTrigger.mockImplementation(async ({ entityId }) => {
      if (String(entityId).startsWith('est-stuck-')) throw new Error('persistent failure');
      return { automation_count: 1, results: [] };
    });

    const first = await sweepMissedLifecycleEvents();
    expect(first.intentsRetried).toBe(0); // the 100 oldest filled the batch and all failed
    expect(rows.find((r) => r.id === 'fresh-1').status).toBe('pending');

    const second = await sweepMissedLifecycleEvents();
    expect(second.intentsRetried).toBe(1); // the fresh marker sorts ahead of every attempts=1 row
    expect(rows.find((r) => r.id === 'fresh-1').status).toBe('processed');

    for (let tick = 0; tick < MAX_INTENT_ATTEMPTS + 2; tick += 1) {
      await sweepMissedLifecycleEvents();
    }
    const stuck = rows.filter((r) => r.id.startsWith('stuck-'));
    expect(stuck.every((r) => r.status === 'unrecoverable' && r.attempts === MAX_INTENT_ATTEMPTS)).toBe(true);
    expect(stuck[0].last_error).toBe('persistent failure');

    AutomationExecutor.processTrigger.mockClear();
    await sweepMissedLifecycleEvents();
    expect(AutomationExecutor.processTrigger).not.toHaveBeenCalled(); // nothing left pending to pin anything
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
      payload: JSON.stringify({ id: 'est-1', customer_email: '', expires_at: '2026-09-21T16:00:00.000Z' }),
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
