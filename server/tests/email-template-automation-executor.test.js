jest.mock('../models/db', () => jest.fn());
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
// The per-customer prep-send lease (the manual sender's and the composer's):
// pass-through by default; a test flips it to "held elsewhere".
jest.mock('../utils/cron-lock', () => ({
  runExclusive: jest.fn(async (_name, fn) => fn()),
  wasLockSkipped: jest.requireActual('../utils/cron-lock').wasLockSkipped,
}));

const db = require('../models/db');
const EmailTemplates = require('../services/email-template-library');
const AutomationExecutor = require('../services/email-template-automation-executor');

function chain({ result = [], first, returning } = {}) {
  const q = {};
  [
    'where',
    'whereIn',
    'whereRaw',
    'whereNot',
    'whereNull',
    'whereNotNull',
    'leftJoin',
    'select',
    'orderBy',
    'limit',
    'onConflict',
    'ignore',
  ].forEach((method) => {
    q[method] = jest.fn(() => q);
  });
  q.modify = jest.fn((fn) => { if (typeof fn === 'function') fn(q); return q; });
  q.insert = jest.fn(() => q);
  q.update = jest.fn(() => q);
  q.first = jest.fn(async () => first);
  q.returning = jest.fn(async () => returning || []);
  q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(result).catch(reject);
  return q;
}

// Shared queue source. `db` and a transaction's `trx` both draw from it,
// but through SEPARATE entry points, so a test can tell which connection a
// table was touched through (r14: writes inside the locked transaction must
// use trx, never the global pool — the run_events FK to an uncommitted
// parent deadlocks otherwise).
let takeFromQueue = () => { throw new Error('setDbQueues not called'); };
function setDbQueues(queues) {
  const tableQueues = new Map(Object.entries(queues));
  takeFromQueue = (table) => {
    const queue = tableQueues.get(table);
    if (!queue || !queue.length) throw new Error(`Unexpected db table ${table}`);
    return queue.shift();
  };
  db.mockImplementation((table) => {
    globalDbAccesses.push(table);
    return takeFromQueue(table);
  });
}
// Tables accessed through the GLOBAL db connection (not through a trx).
const globalDbAccesses = [];

function automation(overrides = {}) {
  return {
    id: 'automation-1',
    automation_key: 'estimate.extension_notice',
    trigger_event_key: 'estimate.auto_renewed',
    template_key: 'estimate.extension_notice',
    delay_minutes: 0,
    audience: 'lead',
    status: 'active',
    active_version_id: 'version-1',
    idempotency_key_template: 'estimate.extension_notice:{estimate_id}:{new_expires_at}',
    conditions: JSON.stringify({ renewal_count_gt: 0 }),
    exit_conditions: JSON.stringify({ stop_if: ['estimate.accepted', 'estimate.archived'] }),
    retry_policy: JSON.stringify({ max_attempts: 2, backoff_minutes: [15, 60] }),
    ...overrides,
  };
}

function run(overrides = {}) {
  return {
    id: 'run-1',
    automation_id: 'automation-1',
    automation_key: 'estimate.extension_notice',
    trigger_event_key: 'estimate.auto_renewed',
    trigger_event_id: 'estimate_auto_renew:est-1',
    entity_type: 'estimate',
    entity_id: 'est-1',
    template_key: 'estimate.extension_notice',
    template_version_id: 'version-1',
    recipient_type: 'lead',
    recipient_id: 'cust-1',
    recipient_email: 'sam@example.com',
    idempotency_key: 'estimate.extension_notice:est-1:2026-06-01',
    status: 'queued',
    attempts: 0,
    max_attempts: 2,
    payload: JSON.stringify({
      estimate_id: 'est-1',
      customer_id: 'cust-1',
      customer_email: 'sam@example.com',
      first_name: 'Sam',
      estimate_url: 'https://example.com/estimate/est-1',
      new_expires_at: '2026-06-01',
      renewal_count: 1,
      status: 'sent',
    }),
    ...overrides,
  };
}

describe('email template automation executor', () => {
  // createRun wraps its insert in a transaction that first takes the
  // per-customer comms advisory lock (serializing against a customer-merge
  // undo probing this recipient's queued sends). The trx delegates table
  // calls back to db so the per-table queues keep working; raw() captures
  // the lock for the pin below.
  const advisoryLockCalls = [];
  // Ordered trace of lock acquisitions vs table reads/writes inside
  // createRun — the lock MUST come first (r11: resolving recipient state
  // before locking lets a writer that waited on an in-flight undo write its
  // pre-undo read afterwards, where the probe can never see it).
  const opTrace = [];
  beforeEach(() => {
    jest.clearAllMocks();
    advisoryLockCalls.length = 0;
    opTrace.length = 0;
    globalDbAccesses.length = 0;
    db.transaction = jest.fn(async (fn) => {
      // Draws from the same queues as db, but WITHOUT going through the
      // global connection — so globalDbAccesses stays a true record.
      const trx = (table) => { opTrace.push(`table:${table}`); return takeFromQueue(table); };
      trx.raw = jest.fn(async (...args) => {
        opTrace.push('lock');
        advisoryLockCalls.push(args);
        return { rows: [] };
      });
      return fn(trx);
    });
  });

  test('maps a trigger to an immediate send with a durable idempotency key', async () => {
    const queuedRun = run();
    const sentRun = { ...queuedRun, status: 'sent', email_message_id: 'message-1' };
    const existingRunQuery = chain({ first: null });
    const insertRunQuery = chain({ returning: [queuedRun] });
    const runningRunQuery = chain({ returning: [{ ...queuedRun, status: 'running', attempts: 1 }] });
    const sentRunQuery = chain({ returning: [sentRun] });
    const queuedLogQuery = chain({ returning: [{ id: 'event-1' }] });
    const attemptLogQuery = chain({ returning: [{ id: 'event-2' }] });
    const sentLogQuery = chain({ returning: [{ id: 'event-3' }] });

    setDbQueues({
      'email_template_automations as a': [chain({ result: [automation({ suppression_group_key: 'service_operational' })] })],
      // The under-lock recipient re-read (r12): a live, non-retired row
      // keeps the payload's attribution.
      customers: [chain({ first: { id: 'cust-1', deleted_at: null } })],
      email_template_automation_runs: [
        existingRunQuery,
        insertRunQuery,
        runningRunQuery,
        sentRunQuery,
      ],
      email_template_automation_run_events: [
        queuedLogQuery,
        attemptLogQuery,
        sentLogQuery,
      ],
      estimates: [chain({ first: null })],
    });
    EmailTemplates.sendTemplate.mockResolvedValue({
      sent: true,
      message: { id: 'message-1', provider_message_id: 'sg-message-1' },
    });

    const result = await AutomationExecutor.processTrigger({
      triggerEventKey: 'estimate.auto_renewed',
      triggerEventId: 'estimate_auto_renew:est-1',
      payload: {
        estimate_id: 'est-1',
        customer_id: 'cust-1',
        customer_email: 'Sam@Example.com',
        first_name: 'Sam',
        estimate_url: 'https://example.com/estimate/est-1',
        new_expires_at: '2026-06-01',
        renewal_count: 1,
        status: 'sent',
      },
      now: new Date('2026-05-18T12:00:00.000Z'),
    });

    expect(result.automation_count).toBe(1);
    expect(result.results[0].run.status).toBe('sent');
    expect(insertRunQuery.insert).toHaveBeenCalledWith(expect.objectContaining({
      automation_key: 'estimate.extension_notice',
      entity_type: 'estimate',
      entity_id: 'est-1',
      recipient_email: 'sam@example.com',
      idempotency_key: 'estimate.extension_notice:est-1:2026-06-01',
    }));
    // The insert ran inside a transaction that first took the per-customer
    // comms advisory lock — the same key customer-dedupe.js's revertMerge
    // takes before probing queued sends, so a run created here can never
    // race an in-flight undo of this customer.
    expect(advisoryLockCalls.some(([sql, bindings]) => String(sql).includes('pg_advisory_xact_lock')
      && Array.isArray(bindings) && bindings[0] === 'customer-comms:cust-1')).toBe(true);
    // ORDERING (r11): the lock is the FIRST thing the transaction does —
    // before the idempotency read and before the insert. A writer that
    // resolved recipient state first would blow past an in-flight undo.
    expect(opTrace[0]).toBe('lock');
    expect(opTrace.indexOf('lock'))
      .toBeLessThan(opTrace.indexOf('table:email_template_automation_runs'));
    // ORDERING (r12): the recipient's customer row is READ under the lock,
    // and that read precedes the insert — the attribution the row is
    // written with therefore comes from inside the lock, not from the
    // payload snapshot the trigger was built from.
    expect(opTrace.indexOf('lock')).toBeLessThan(opTrace.indexOf('table:customers'));
    expect(opTrace.indexOf('table:customers'))
      .toBeLessThan(opTrace.indexOf('table:email_template_automation_runs'));
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'estimate.extension_notice',
      versionId: 'version-1',
      to: 'sam@example.com',
      recipientType: 'lead',
      recipientId: 'cust-1',
      automationRunId: 'run-1',
      triggerEventId: 'estimate_auto_renew:est-1',
      idempotencyKey: 'estimate.extension_notice:est-1:2026-06-01',
      suppressionGroupKey: 'service_operational',
    }));
    expect(sentRunQuery.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'sent',
      email_message_id: 'message-1',
    }));
  });

  test('no GLOBAL db access happens inside the locked transaction (run events ride the trx — FK deadlock)', async () => {
    // email_template_automation_run_events.run_id references the parent run
    // (20260518000002). Logging the event through the global pool while the
    // parent is still uncommitted in OUR transaction deadlocks: the pooled
    // connection waits on our row, we wait on it. Every write inside the
    // transaction must therefore go through trx.
    const queuedRun = run();
    const existingRunQuery = chain({ first: null });
    const insertRunQuery = chain({ returning: [queuedRun] });
    const eventQuery = chain({ returning: [{ id: 'event-1' }] });
    setDbQueues({
      'email_template_automations as a': [chain({ result: [automation({ delay_minutes: 60 })] })],
      customers: [chain({ first: { id: 'cust-1', email: 'sam@example.com', deleted_at: null } })],
      email_template_automation_runs: [existingRunQuery, insertRunQuery],
      email_template_automation_run_events: [eventQuery],
    });

    await AutomationExecutor.processTrigger({
      triggerEventKey: 'estimate.auto_renewed',
      triggerEventId: 'estimate_auto_renew:est-1',
      payload: {
        estimate_id: 'est-1',
        customer_id: 'cust-1',
        customer_email: 'sam@example.com',
        first_name: 'Sam',
        estimate_url: 'https://example.com/estimate/est-1',
        new_expires_at: '2026-06-01',
        renewal_count: 1,
        status: 'sent',
      },
      now: new Date('2026-05-18T12:00:00.000Z'),
    });

    // The run row was inserted, and its 'queued' event was logged...
    expect(insertRunQuery.insert).toHaveBeenCalled();
    expect(eventQuery.insert).toHaveBeenCalled();
    // ...but the event table was NEVER touched through the global db —
    // only through the transaction (opTrace records trx accesses).
    expect(globalDbAccesses).not.toContain('email_template_automation_run_events');
    expect(opTrace).toContain('table:email_template_automation_run_events');
  });

  test('a failing best-effort run-event insert inside the locked transaction is savepoint-scoped — the run row still commits', async () => {
    // Postgres semantics modeled faithfully (r17 pre-push P1): logRunEvent
    // swallows its insert error in JS, but WITHOUT a savepoint the failed
    // statement has already aborted the enclosing transaction — the
    // eventual COMMIT then fails and the just-inserted run row is silently
    // rolled back. With the event insert wrapped in a nested transaction
    // (SAVEPOINT), its failure rolls back only the savepoint and the run
    // commits. The stub aborts the trx whenever the failing insert runs
    // OUTSIDE a savepoint, and the transaction wrapper refuses to commit an
    // aborted trx — so a regression to a bare best-effort insert fails this
    // test the same way it loses runs in production.
    const queuedRun = run();
    let savepointDepth = 0;
    let trxAborted = false;
    const existingRunQuery = chain({ first: null });
    const insertRunQuery = chain({ returning: [queuedRun] });
    const eventQuery = chain({});
    eventQuery.returning = jest.fn(async () => {
      if (savepointDepth === 0) trxAborted = true;
      throw new Error('null value in column "metadata" violates not-null constraint');
    });
    setDbQueues({
      'email_template_automations as a': [chain({ result: [automation({ delay_minutes: 60 })] })],
      customers: [chain({ first: { id: 'cust-1', email: 'sam@example.com', deleted_at: null } })],
      email_template_automation_runs: [existingRunQuery, insertRunQuery],
      email_template_automation_run_events: [eventQuery],
    });
    // Transaction wrapper that models the aborted-trx COMMIT failure and
    // provides the nested-transaction (savepoint) entry point.
    db.transaction = jest.fn(async (fn) => {
      const trx = (table) => { opTrace.push(`table:${table}`); return takeFromQueue(table); };
      trx.isTransaction = true;
      trx.raw = jest.fn(async (...args) => {
        advisoryLockCalls.push(args);
        return { rows: [] };
      });
      trx.transaction = jest.fn(async (spFn) => {
        savepointDepth += 1;
        try {
          return await spFn(trx);
        } finally {
          savepointDepth -= 1;
        }
      });
      const result = await fn(trx);
      if (trxAborted) {
        const err = new Error('current transaction is aborted, commands ignored until end of transaction block');
        err.code = '25P02';
        throw err;
      }
      return result;
    });

    const result = await AutomationExecutor.processTrigger({
      triggerEventKey: 'estimate.auto_renewed',
      triggerEventId: 'estimate_auto_renew:est-1',
      payload: {
        estimate_id: 'est-1',
        customer_id: 'cust-1',
        customer_email: 'sam@example.com',
        first_name: 'Sam',
        estimate_url: 'https://example.com/estimate/est-1',
        new_expires_at: '2026-06-01',
        renewal_count: 1,
        status: 'sent',
      },
      now: new Date('2026-05-18T12:00:00.000Z'),
    });

    // The run committed despite the failed audit event.
    expect(result.results[0].run.id).toBe('run-1');
    expect(result.results[0].deduped).toBe(false);
    expect(insertRunQuery.insert).toHaveBeenCalled();
    // The event insert was attempted — inside a savepoint — and its
    // failure never aborted the outer transaction.
    expect(eventQuery.returning).toHaveBeenCalled();
    expect(trxAborted).toBe(false);
  });

  test('a trigger replay racing the insert inside the locked transaction recovers the existing run WITHOUT aborting the trx', async () => {
    // Postgres semantics modeled faithfully (r16): a raised unique
    // violation ABORTS the enclosing transaction — every later statement on
    // it fails 25P02 ("current transaction is aborted") until rollback. The
    // r14 conversion of createRun to a locked transaction therefore broke
    // the old catch-23505-then-select recovery on this path: the catch's
    // replay .first() and its 'deduped' audit insert both ran on the
    // aborted trx and could never succeed. The insert must not RAISE at
    // all — ON CONFLICT (idempotency_key) DO NOTHING resolves to zero rows
    // and the replay fetch runs on a healthy transaction. The stub raises
    // real 23505/25P02 behavior whenever the insert lacks the ON CONFLICT
    // clause, so a regression to a raising insert fails this test the same
    // way it fails in production.
    const existingRun = run();
    let trxAborted = false;
    const abortedTrxError = () => {
      const err = new Error('current transaction is aborted, commands ignored until end of transaction block');
      err.code = '25P02';
      return err;
    };
    const existingRunQuery = chain({ first: null }); // pre-insert idempotency read: not there yet
    const insertRunQuery = chain({});
    insertRunQuery.returning = jest.fn(async () => {
      // A concurrent replay committed the row between the read and the
      // insert. With ON CONFLICT DO NOTHING the conflict is swallowed
      // (zero rows back); without it, Postgres raises and the trx aborts.
      if (insertRunQuery.onConflict.mock.calls.length && insertRunQuery.ignore.mock.calls.length) return [];
      trxAborted = true;
      const err = new Error('duplicate key value violates unique constraint "email_template_automation_runs_idempotency_key_unique"');
      err.code = '23505';
      throw err;
    });
    const guardAborted = (fn) => jest.fn(async (...args) => {
      if (trxAborted) throw abortedTrxError();
      return fn(...args);
    });
    const replayQuery = chain({});
    replayQuery.first = guardAborted(async () => existingRun);
    const dedupedLogQuery = chain({});
    dedupedLogQuery.returning = guardAborted(async () => [{ id: 'event-1' }]);

    setDbQueues({
      'email_template_automations as a': [chain({ result: [automation({ delay_minutes: 60 })] })],
      customers: [chain({ first: { id: 'cust-1', email: 'sam@example.com', deleted_at: null } })],
      email_template_automation_runs: [existingRunQuery, insertRunQuery, replayQuery],
      email_template_automation_run_events: [dedupedLogQuery],
    });

    const result = await AutomationExecutor.processTrigger({
      triggerEventKey: 'estimate.auto_renewed',
      triggerEventId: 'estimate_auto_renew:est-1',
      payload: {
        estimate_id: 'est-1',
        customer_id: 'cust-1',
        customer_email: 'sam@example.com',
        first_name: 'Sam',
        estimate_url: 'https://example.com/estimate/est-1',
        new_expires_at: '2026-06-01',
        renewal_count: 1,
        status: 'sent',
      },
      now: new Date('2026-05-18T12:00:00.000Z'),
    });

    expect(result.results[0].deduped).toBe(true);
    expect(result.results[0].run.id).toBe('run-1');
    // The conflict was absorbed by the insert itself, never raised.
    expect(insertRunQuery.onConflict).toHaveBeenCalledWith('idempotency_key');
    expect(insertRunQuery.ignore).toHaveBeenCalled();
    // The race-recovery audit event landed on the (healthy) transaction.
    expect(dedupedLogQuery.insert).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'deduped',
    }));
  });

  test('a stale pre-undo recipient address (now owned by another live customer) is recorded SKIPPED, never queued', async () => {
    // Post-undo shape: the payload carries the merged-in address, which the
    // undo has handed back to the restored customer. Sending it would mail
    // a winner-owned message to the restored loser's mailbox.
    const insertRunQuery = chain({ returning: [run({ status: 'skipped' })] });
    setDbQueues({
      'email_template_automations as a': [chain({ result: [automation()] })],
      customers: [
        // The recipient's live email is NO LONGER the payload address...
        chain({ first: { id: 'cust-1', email: 'winner.new@example.com', deleted_at: null } }),
        // ...and another LIVE customer now owns it.
        chain({ first: { id: 'cust-restored' } }),
      ],
      email_template_automation_runs: [chain({ first: null }), insertRunQuery],
      email_template_automation_run_events: [chain({ returning: [{ id: 'event-1' }] })],
    });

    await AutomationExecutor.processTrigger({
      triggerEventKey: 'estimate.auto_renewed',
      triggerEventId: 'estimate_auto_renew:est-1',
      payload: {
        estimate_id: 'est-1',
        customer_id: 'cust-1',
        customer_email: 'sam@example.com',
        first_name: 'Sam',
        estimate_url: 'https://example.com/estimate/est-1',
        new_expires_at: '2026-06-01',
        renewal_count: 1,
        status: 'sent',
      },
      now: new Date('2026-05-18T12:00:00.000Z'),
    });

    const inserted = insertRunQuery.insert.mock.calls[0][0];
    // Recorded for audit, but SKIPPED — a skipped row fails executeRun's
    // status claim, so no delivery to the stale address can follow.
    expect(inserted.status).toBe('skipped');
    expect(inserted.exit_reason).toMatch(/restored to the merged-away customer/);
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
  });

  test('an address that differs BY DESIGN (nobody else owns it) still queues normally', async () => {
    // Tenant-under-landlord: the estimate mails the tenant, whose address is
    // not a customer record at all. This must keep working.
    const insertRunQuery = chain({ returning: [run()] });
    setDbQueues({
      'email_template_automations as a': [chain({ result: [automation({ delay_minutes: 60 })] })],
      customers: [
        chain({ first: { id: 'cust-1', email: 'landlord@example.com', deleted_at: null } }),
        chain({ first: null }), // no other live customer owns the tenant address
      ],
      email_template_automation_runs: [chain({ first: null }), insertRunQuery],
      email_template_automation_run_events: [chain({ returning: [{ id: 'event-1' }] })],
    });

    await AutomationExecutor.processTrigger({
      triggerEventKey: 'estimate.auto_renewed',
      triggerEventId: 'estimate_auto_renew:est-1',
      payload: {
        estimate_id: 'est-1',
        customer_id: 'cust-1',
        customer_email: 'tenant@example.com',
        first_name: 'Sam',
        estimate_url: 'https://example.com/estimate/est-1',
        new_expires_at: '2026-06-01',
        renewal_count: 1,
        status: 'sent',
      },
      now: new Date('2026-05-18T12:00:00.000Z'),
    });

    const inserted = insertRunQuery.insert.mock.calls[0][0];
    expect(inserted.status).toBe('scheduled'); // queued as normal, not skipped
    expect(inserted.recipient_email).toBe('tenant@example.com');
    expect(inserted.exit_reason).toBeFalsy();
  });

  test('a LEAD-backed run keeps its id — customer revalidation never strips non-customer identifiers', async () => {
    // The payload names only lead_id: the id provably came from a lead key,
    // so a customer-merge undo cannot affect it. It must take the lock-free
    // path and be written with its lead id intact — no customers read at
    // all (a customer lookup for a lead id would "find nothing" and, pre-
    // r15, strip the id).
    const insertRunQuery = chain({ returning: [run({ recipient_id: 'lead-9' })] });
    setDbQueues({
      'email_template_automations as a': [chain({ result: [automation({ delay_minutes: 60 })] })],
      email_template_automation_runs: [chain({ first: null }), insertRunQuery],
      email_template_automation_run_events: [chain({ returning: [{ id: 'event-1' }] })],
    });

    await AutomationExecutor.processTrigger({
      triggerEventKey: 'estimate.auto_renewed',
      triggerEventId: 'estimate_auto_renew:est-1',
      payload: {
        estimate_id: 'est-1',
        lead_id: 'lead-9', // no customer_id anywhere
        customer_email: 'sam@example.com',
        first_name: 'Sam',
        estimate_url: 'https://example.com/estimate/est-1',
        new_expires_at: '2026-06-01',
        renewal_count: 1,
        status: 'sent',
      },
      now: new Date('2026-05-18T12:00:00.000Z'),
    });

    const inserted = insertRunQuery.insert.mock.calls[0][0];
    expect(inserted.recipient_id).toBe('lead-9');
    expect(inserted.status).toBe('scheduled'); // never skipped by revalidation
    // Lock-free path: no advisory lock, no customers read.
    expect(advisoryLockCalls).toHaveLength(0);
    expect(opTrace).not.toContain('table:customers');
  });

  test('a recipient whose customer row was retired since the trigger is written UNLINKED (under-lock re-read)', async () => {
    // The payload named cust-1, but the under-lock read finds it
    // soft-deleted (merged away). The run must not be pinned to a retired
    // row — the value written comes from the read, not the payload.
    const queuedRun = run({ recipient_id: null });
    const existingRunQuery = chain({ first: null });
    const insertRunQuery = chain({ returning: [queuedRun] });
    setDbQueues({
      'email_template_automations as a': [chain({ result: [automation({ delay_minutes: 60 })] })],
      customers: [chain({ first: { id: 'cust-1', deleted_at: '2026-07-30T04:40:00Z' } })],
      email_template_automation_runs: [existingRunQuery, insertRunQuery],
      email_template_automation_run_events: [chain({ returning: [{ id: 'event-1' }] })],
    });

    await AutomationExecutor.processTrigger({
      triggerEventKey: 'estimate.auto_renewed',
      triggerEventId: 'estimate_auto_renew:est-1',
      payload: {
        estimate_id: 'est-1',
        customer_id: 'cust-1',
        customer_email: 'sam@example.com',
        first_name: 'Sam',
        estimate_url: 'https://example.com/estimate/est-1',
        new_expires_at: '2026-06-01',
        renewal_count: 1,
        status: 'sent',
      },
      now: new Date('2026-05-18T12:00:00.000Z'),
    });

    // Locked on the payload's id (it is the lock KEY)...
    expect(advisoryLockCalls.some(([, bindings]) => bindings[0] === 'customer-comms:cust-1')).toBe(true);
    // ...but attributed from the under-lock read: retired → unlinked.
    expect(insertRunQuery.insert).toHaveBeenCalledWith(expect.objectContaining({
      recipient_id: null,
      recipient_email: 'sam@example.com', // delivery semantics untouched
    }));
  });

  test('dedupes trigger replays before sending', async () => {
    const existing = run({ status: 'sent' });
    const dedupeLogQuery = chain({ returning: [{ id: 'event-1' }] });
    setDbQueues({
      'email_template_automations as a': [chain({ result: [automation()] })],
      email_template_automation_runs: [chain({ first: existing })],
      email_template_automation_run_events: [dedupeLogQuery],
    });

    const result = await AutomationExecutor.processTrigger({
      triggerEventKey: 'estimate.auto_renewed',
      payload: {
        estimate_id: 'est-1',
        customer_email: 'sam@example.com',
        new_expires_at: '2026-06-01',
        renewal_count: 1,
        status: 'sent',
      },
    });

    expect(result.results[0].deduped).toBe(true);
    expect(result.results[0].run.id).toBe('run-1');
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
    expect(dedupeLogQuery.insert).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'deduped',
    }));
  });

  test('records skipped runs when exit conditions are already met', async () => {
    const skippedRun = run({ status: 'skipped', exit_reason: 'estimate already accepted' });
    const insertRunQuery = chain({ returning: [skippedRun] });
    setDbQueues({
      'email_template_automations as a': [chain({
        result: [automation({
          conditions: '{}',
          exit_conditions: JSON.stringify({ stop_if: ['estimate.accepted'] }),
        })],
      })],
      email_template_automation_runs: [
        chain({ first: null }),
        insertRunQuery,
      ],
      email_template_automation_run_events: [chain({ returning: [{ id: 'event-1' }] })],
    });

    const result = await AutomationExecutor.processTrigger({
      triggerEventKey: 'estimate.auto_renewed',
      payload: {
        estimate_id: 'est-1',
        customer_email: 'sam@example.com',
        new_expires_at: '2026-06-01',
        status: 'accepted',
      },
    });

    expect(result.results[0].run.status).toBe('skipped');
    expect(insertRunQuery.insert).toHaveBeenCalledWith(expect.objectContaining({
      status: 'skipped',
      exit_reason: 'estimate already accepted',
    }));
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
  });

  test('treats omitted estimate viewed state as unviewed', () => {
    expect(AutomationExecutor.conditionFailureFor(
      { estimate_viewed: false, estimate_status: ['sent', 'viewed'] },
      { status: 'sent', estimate_id: 'est-1' },
    )).toBeNull();
  });

  test('treats viewed estimate status as viewed without viewed_at', () => {
    expect(AutomationExecutor.conditionFailureFor(
      { estimate_viewed: false, estimate_status: ['sent', 'viewed'] },
      { estimate_status: 'viewed', estimate_id: 'est-1' },
    )).toBe('estimate_viewed must be false');
    expect(AutomationExecutor.exitReasonFor(
      { stop_if: ['estimate.viewed'] },
      { status: 'viewed', estimate_id: 'est-1' },
    )).toBe('estimate already viewed');
  });

  test('allows viewed estimate status during delayed follow-up rechecks', async () => {
    const queuedRun = run({
      automation_key: 'estimate.viewed_followup',
      trigger_event_key: 'estimate.viewed',
      template_key: 'estimate.viewed_followup',
      idempotency_key: 'estimate.viewed_followup:est-1',
      payload: JSON.stringify({
        estimate_id: 'est-1',
        customer_id: 'cust-1',
        customer_email: 'sam@example.com',
        first_name: 'Sam',
        estimate_url: 'https://example.com/estimate/est-1',
        status: 'sent',
        estimate_viewed: true,
      }),
    });
    const sentRun = { ...queuedRun, status: 'sent', email_message_id: 'message-1' };
    const sentRunQuery = chain({ returning: [sentRun] });
    setDbQueues({
      email_template_automation_runs: [
        chain({ returning: [{ ...queuedRun, status: 'running', attempts: 1 }] }),
        sentRunQuery,
      ],
      email_template_automation_run_events: [
        chain({ returning: [{ id: 'event-1' }] }),
        chain({ returning: [{ id: 'event-2' }] }),
      ],
      estimates: [chain({
        first: {
          id: 'est-1',
          status: 'viewed',
          viewed_at: new Date('2026-05-18T12:05:00.000Z'),
        },
      })],
    });
    EmailTemplates.sendTemplate.mockResolvedValue({
      sent: true,
      message: { id: 'message-1', provider_message_id: 'sg-message-1' },
    });

    const result = await AutomationExecutor.executeRun(queuedRun, {
      automation: automation({
        automation_key: 'estimate.viewed_followup',
        trigger_event_key: 'estimate.viewed',
        template_key: 'estimate.viewed_followup',
        idempotency_key_template: 'estimate.viewed_followup:{estimate_id}',
        conditions: JSON.stringify({ estimate_viewed: true, estimate_status: ['sent', 'viewed'] }),
        exit_conditions: JSON.stringify({ stop_if: ['estimate.accepted', 'estimate.expired'] }),
      }),
      now: new Date('2026-05-18T12:00:00.000Z'),
    });

    expect(result.status).toBe('sent');
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        estimate_status: 'viewed',
        estimate_viewed: true,
      }),
    }));
    expect(sentRunQuery.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'sent',
    }));
  });

  test('schedules retries using the automation retry policy', async () => {
    const queuedRun = run({ attempts: 0 });
    const retryRun = {
      ...queuedRun,
      status: 'retry_scheduled',
      attempts: 1,
      run_after: new Date('2026-05-18T12:15:00.000Z'),
    };
    const retryUpdateQuery = chain({ returning: [retryRun] });
    setDbQueues({
      email_template_automation_runs: [
        chain({ returning: [{ ...queuedRun, status: 'running', attempts: 1 }] }),
        retryUpdateQuery,
      ],
      email_template_automation_run_events: [
        chain({ returning: [{ id: 'event-1' }] }),
        chain({ returning: [{ id: 'event-2' }] }),
      ],
      estimates: [chain({ first: null })],
    });
    EmailTemplates.sendTemplate.mockRejectedValue(new Error('provider timeout'));

    const result = await AutomationExecutor.executeRun(queuedRun, {
      automation: automation(),
      now: new Date('2026-05-18T12:00:00.000Z'),
    });

    expect(result.status).toBe('retry_scheduled');
    expect(retryUpdateQuery.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'retry_scheduled',
      next_retry_at: new Date('2026-05-18T12:15:00.000Z'),
      run_after: new Date('2026-05-18T12:15:00.000Z'),
      last_error: 'provider timeout',
    }));
  });

  test('keeps queued guard values when a live row omits optional columns', async () => {
    const queuedRun = run({ attempts: 0 });
    const sentRun = { ...queuedRun, status: 'sent', email_message_id: 'message-1' };
    const sentRunQuery = chain({ returning: [sentRun] });
    setDbQueues({
      email_template_automation_runs: [
        chain({ returning: [{ ...queuedRun, status: 'running', attempts: 1 }] }),
        sentRunQuery,
      ],
      email_template_automation_run_events: [
        chain({ returning: [{ id: 'event-1' }] }),
        chain({ returning: [{ id: 'event-2' }] }),
      ],
      estimates: [chain({ first: { id: 'est-1', status: 'sent' } })],
    });
    EmailTemplates.sendTemplate.mockResolvedValue({
      sent: true,
      message: { id: 'message-1', provider_message_id: 'sg-message-1' },
    });

    const result = await AutomationExecutor.executeRun(queuedRun, {
      automation: automation(),
      now: new Date('2026-05-18T12:00:00.000Z'),
    });

    expect(result.status).toBe('sent');
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        renewal_count: 1,
        status: 'sent',
      }),
    }));
    expect(EmailTemplates.sendTemplate.mock.calls[0][0].suppressionGroupKey).toBeUndefined();
    expect(sentRunQuery.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'sent',
    }));
  });

  test('skips queued runs when the automation has been paused', async () => {
    const queuedRun = run({ attempts: 0 });
    const skipUpdateQuery = chain({ returning: [{ ...queuedRun, status: 'skipped', exit_reason: 'automation status is paused' }] });
    setDbQueues({
      email_template_automation_runs: [skipUpdateQuery],
      email_template_automation_run_events: [chain({ returning: [{ id: 'event-1' }] })],
    });

    const result = await AutomationExecutor.executeRun(queuedRun, {
      automation: automation({ status: 'paused' }),
      now: new Date('2026-05-18T12:00:00.000Z'),
    });

    expect(result.status).toBe('skipped');
    expect(skipUpdateQuery.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'skipped',
      exit_reason: 'automation status is paused',
    }));
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
  });

  test('does not send a due run if another worker already claimed it', async () => {
    const queuedRun = run({ attempts: 0 });
    const runningRun = run({ status: 'running', attempts: 1 });
    setDbQueues({
      email_template_automation_runs: [
        chain({ returning: [] }),
        chain({ first: runningRun }),
      ],
    });

    const result = await AutomationExecutor.executeRun(queuedRun, {
      automation: automation(),
      now: new Date('2026-05-18T12:00:00.000Z'),
    });

    expect(result.status).toBe('running');
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
  });

  test('rejects idempotency templates with missing variables', () => {
    expect(() => AutomationExecutor.renderIdempotencyKey(
      'estimate.delivery:{estimate_id}:{trigger_event_id}',
      { estimate_id: 'est-1' },
    )).toThrow(/trigger_event_id/);
  });

  test('idempotency key is stable across template republishes', async () => {
    const automationV1 = automation({ active_version_id: 'version-1' });
    const automationV2 = automation({ active_version_id: 'version-2' });
    const insertRunV1 = chain({ returning: [run({ template_version_id: 'version-1' })] });
    const insertRunV2 = chain({ returning: [run({ template_version_id: 'version-2' })] });
    setDbQueues({
      'email_template_automations as a': [
        chain({ result: [automationV1] }),
        chain({ result: [automationV2] }),
      ],
      email_template_automation_runs: [
        chain({ first: null }), insertRunV1, chain({ returning: [run()] }), chain({ returning: [run()] }),
        chain({ first: null }), insertRunV2, chain({ returning: [run()] }), chain({ returning: [run()] }),
      ],
      email_template_automation_run_events: Array.from({ length: 6 }, () => chain({ returning: [{ id: 'evt' }] })),
      estimates: [chain({ first: null }), chain({ first: null })],
    });
    EmailTemplates.sendTemplate.mockResolvedValue({ sent: true, message: { id: 'm', provider_message_id: 'sg' } });

    const payload = {
      estimate_id: 'est-1', customer_id: 'cust-1', customer_email: 'sam@example.com',
      first_name: 'Sam', estimate_url: 'https://example.com/e/est-1',
      new_expires_at: '2026-06-01', renewal_count: 1, status: 'sent',
    };
    await AutomationExecutor.processTrigger({ triggerEventKey: 'estimate.auto_renewed', payload });
    await AutomationExecutor.processTrigger({ triggerEventKey: 'estimate.auto_renewed', payload });

    const keyV1 = insertRunV1.insert.mock.calls[0][0].idempotency_key;
    const keyV2 = insertRunV2.insert.mock.calls[0][0].idempotency_key;
    expect(keyV1).toBe(keyV2);
    expect(keyV1).not.toMatch(/version-/);
  });

  test('a prep guide run that actually sends stamps prep_sent_at + delivered key on the visit', async () => {
    const prepAutomation = automation({
      id: 'automation-prep',
      automation_key: 'prep.flea',
      template_key: 'prep.flea',
      trigger_event_key: 'appointment.booked',
      idempotency_key_template: 'prep.flea:{scheduled_service_id}',
      conditions: JSON.stringify({ service_type_contains: ['flea'] }),
      exit_conditions: JSON.stringify({ stop_if: ['appointment.cancelled', 'appointment.closed', 'appointment.past'] }),
    });
    const queuedRun = run({
      id: 'run-prep',
      automation_id: 'automation-prep',
      automation_key: 'prep.flea',
      template_key: 'prep.flea',
      trigger_event_key: 'appointment.booked',
      trigger_event_id: 'appointment_booked:svc-1',
      entity_type: 'scheduled_service',
      entity_id: 'svc-1',
      idempotency_key: 'prep.flea:svc-1',
      recipient_type: 'customer',
      payload: JSON.stringify({
        scheduled_service_id: 'svc-1',
        customer_email: 'sam@example.com',
        first_name: 'Sam',
        service_type: 'Flea Control Service',
        service_date_ymd: '2199-01-01',
      }),
    });
    const sentRun = { ...queuedRun, status: 'sent', email_message_id: 'message-1' };
    const stampQuery = chain({});

    setDbQueues({
      'email_template_automations as a': [chain({ result: [prepAutomation] })],
      email_template_automation_runs: [
        chain({ first: null }),
        chain({ returning: [queuedRun] }),
        chain({ returning: [{ ...queuedRun, status: 'running', attempts: 1 }] }),
        chain({ returning: [sentRun] }),
      ],
      email_template_automation_run_events: [
        chain({ returning: [{ id: 'e1' }] }),
        chain({ returning: [{ id: 'e2' }] }),
        chain({ returning: [{ id: 'e3' }] }),
      ],
      // 1st: live-payload refresh of the visit row; 2nd: the pre-dispatch
      // FRESH page claim (unkeyed → this guide); 3rd: the
      // markServicePrepSent confirmed-delivery stamp.
      scheduled_services: [
        chain({ first: { id: 'svc-1', status: 'scheduled', service_type: 'Flea Control Service', scheduled_date: '2199-01-01', customer_id: null } }),
        chain({ returning: [{ id: 'svc-1' }] }),
        stampQuery,
      ],
    });
    db.fn = { now: jest.fn(() => 'NOW()') };
    EmailTemplates.sendTemplate.mockResolvedValue({
      sent: true,
      message: { id: 'message-1', provider_message_id: 'sg-message-1' },
    });

    const result = await AutomationExecutor.processTrigger({
      triggerEventKey: 'appointment.booked',
      triggerEventId: 'appointment_booked:svc-1',
      payload: {
        scheduled_service_id: 'svc-1',
        customer_email: 'sam@example.com',
        first_name: 'Sam',
        service_type: 'Flea Control Service',
        service_date_ymd: '2199-01-01',
      },
      now: new Date('2026-07-14T12:00:00.000Z'),
    });

    expect(result.results[0].run.status).toBe('sent');
    expect(stampQuery.update).toHaveBeenCalledWith(expect.objectContaining({
      prep_template_key: 'prep.flea',
      prep_sent_at: 'NOW()',
    }));
  });

  test('a blocked prep guide run never stamps the visit', async () => {
    const prepAutomation = automation({
      id: 'automation-prep',
      automation_key: 'prep.flea',
      template_key: 'prep.flea',
      trigger_event_key: 'appointment.booked',
      idempotency_key_template: 'prep.flea:{scheduled_service_id}',
      conditions: JSON.stringify({ service_type_contains: ['flea'] }),
      exit_conditions: JSON.stringify({}),
    });
    const queuedRun = run({
      id: 'run-prep',
      automation_id: 'automation-prep',
      automation_key: 'prep.flea',
      template_key: 'prep.flea',
      trigger_event_key: 'appointment.booked',
      trigger_event_id: 'appointment_booked:svc-1',
      entity_type: 'scheduled_service',
      entity_id: 'svc-1',
      idempotency_key: 'prep.flea:svc-1',
      recipient_type: 'customer',
      payload: JSON.stringify({
        scheduled_service_id: 'svc-1',
        customer_email: 'sam@example.com',
        first_name: 'Sam',
        service_type: 'Flea Control Service',
        service_date_ymd: '2199-01-01',
      }),
    });
    const blockedRun = { ...queuedRun, status: 'blocked' };
    const releaseQuery = chain({});

    setDbQueues({
      'email_template_automations as a': [chain({ result: [prepAutomation] })],
      email_template_automation_runs: [
        chain({ first: null }),
        chain({ returning: [queuedRun] }),
        chain({ returning: [{ ...queuedRun, status: 'running', attempts: 1 }] }),
        chain({ returning: [blockedRun] }),
      ],
      email_template_automation_run_events: [
        chain({ returning: [{ id: 'e1' }] }),
        chain({ returning: [{ id: 'e2' }] }),
        chain({ returning: [{ id: 'e3' }] }),
      ],
      // The live-payload read, the FRESH page claim, then — blocked, nothing
      // delivered — the claim's release. NO stamp query is queued; a stamp
      // attempt would throw "Unexpected db table" and fail this test.
      scheduled_services: [
        chain({ first: { id: 'svc-1', status: 'scheduled', service_type: 'Flea Control Service', scheduled_date: '2199-01-01', customer_id: null } }),
        chain({ returning: [{ id: 'svc-1' }] }),
        releaseQuery,
      ],
    });
    EmailTemplates.sendTemplate.mockResolvedValue({ blocked: true, reason: 'suppressed' });

    const result = await AutomationExecutor.processTrigger({
      triggerEventKey: 'appointment.booked',
      triggerEventId: 'appointment_booked:svc-1',
      payload: {
        scheduled_service_id: 'svc-1',
        customer_email: 'sam@example.com',
        first_name: 'Sam',
        service_type: 'Flea Control Service',
        service_date_ymd: '2199-01-01',
      },
      now: new Date('2026-07-14T12:00:00.000Z'),
    });

    expect(result.results[0].run.status).toBe('blocked');
    // A fresh claim on a blocked send is handed back, fenced on delivery/view.
    expect(releaseQuery.update).toHaveBeenCalledWith({ prep_template_key: null });
    expect(releaseQuery.whereNull).toHaveBeenCalledWith('prep_sent_at');
    expect(releaseQuery.whereNull).toHaveBeenCalledWith('prep_first_viewed_at');
  });

  test('a prep guide run whose visit page is keyed to ANOTHER guide is skipped before dispatch — one page per visit across lanes (GH Codex #3856 r19 P0)', async () => {
    const prepAutomation = automation({
      id: 'automation-prep',
      automation_key: 'prep.flea',
      template_key: 'prep.flea',
      trigger_event_key: 'appointment.booked',
      idempotency_key_template: 'prep.flea:{scheduled_service_id}',
      conditions: JSON.stringify({ service_type_contains: ['flea'] }),
      exit_conditions: JSON.stringify({ stop_if: ['appointment.cancelled', 'appointment.closed', 'appointment.past'] }),
    });
    const queuedRun = run({
      id: 'run-prep',
      automation_id: 'automation-prep',
      automation_key: 'prep.flea',
      template_key: 'prep.flea',
      trigger_event_key: 'appointment.booked',
      trigger_event_id: 'appointment_booked:svc-1',
      entity_type: 'scheduled_service',
      entity_id: 'svc-1',
      idempotency_key: 'prep.flea:svc-1',
      recipient_type: 'customer',
      payload: JSON.stringify({
        scheduled_service_id: 'svc-1',
        customer_email: 'sam@example.com',
        first_name: 'Sam',
        service_type: 'Flea Control Service',
        service_date_ymd: '2199-01-01',
      }),
    });
    const skippedRun = { ...queuedRun, status: 'skipped', exit_reason: 'prep page owned by another guide' };

    setDbQueues({
      'email_template_automations as a': [chain({ result: [prepAutomation] })],
      email_template_automation_runs: [
        chain({ first: null }),
        chain({ returning: [queuedRun] }),
        chain({ returning: [{ ...queuedRun, status: 'running', attempts: 1 }] }),
        chain({ returning: [skippedRun] }),
      ],
      email_template_automation_run_events: [
        chain({ returning: [{ id: 'e1' }] }),
        chain({ returning: [{ id: 'e2' }] }),
        chain({ returning: [{ id: 'e3' }] }),
      ],
      // The live-payload read; the FRESH claim matches nothing (keyed
      // meanwhile) and the same-key ownership read finds another guide's.
      scheduled_services: [
        chain({ first: { id: 'svc-1', status: 'scheduled', service_type: 'Flea Control Service', scheduled_date: '2199-01-01', customer_id: null } }),
        chain({ returning: [] }),
        chain({ first: undefined }),
      ],
    });

    const result = await AutomationExecutor.processTrigger({
      triggerEventKey: 'appointment.booked',
      triggerEventId: 'appointment_booked:svc-1',
      payload: {
        scheduled_service_id: 'svc-1',
        customer_email: 'sam@example.com',
        first_name: 'Sam',
        service_type: 'Flea Control Service',
        service_date_ymd: '2199-01-01',
      },
      now: new Date('2026-07-14T12:00:00.000Z'),
    });

    expect(result.results[0].run.status).toBe('skipped');
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
  });

  test('a prep run claims, sends and settles under the per-customer prep-send lock; a held lease (a manual or composer prep send mid-flight) retries later without claiming (pre-push Codex P1 on d5c33f299)', async () => {
    const { runExclusive } = require('../utils/cron-lock');
    const prepAutomation = automation({
      id: 'automation-prep',
      automation_key: 'prep.flea',
      template_key: 'prep.flea',
      trigger_event_key: 'appointment.booked',
      idempotency_key_template: 'prep.flea:{scheduled_service_id}',
      conditions: JSON.stringify({ service_type_contains: ['flea'] }),
      exit_conditions: JSON.stringify({}),
      retry_policy: JSON.stringify({ max_attempts: 2, backoff_minutes: [15] }),
    });
    const queuedRun = run({
      id: 'run-prep',
      automation_id: 'automation-prep',
      automation_key: 'prep.flea',
      template_key: 'prep.flea',
      trigger_event_key: 'appointment.booked',
      trigger_event_id: 'appointment_booked:svc-1',
      entity_type: 'scheduled_service',
      entity_id: 'svc-1',
      idempotency_key: 'prep.flea:svc-1',
      recipient_type: 'customer',
      recipient_id: 'cust-1',
      max_attempts: 2,
      payload: JSON.stringify({
        scheduled_service_id: 'svc-1',
        customer_email: 'sam@example.com',
        first_name: 'Sam',
        service_type: 'Flea Control Service',
        service_date_ymd: '2199-01-01',
      }),
    });
    const trigger = () => AutomationExecutor.processTrigger({
      triggerEventKey: 'appointment.booked',
      triggerEventId: 'appointment_booked:svc-1',
      payload: { scheduled_service_id: 'svc-1', customer_email: 'sam@example.com', first_name: 'Sam', service_type: 'Flea Control Service', service_date_ymd: '2199-01-01' },
      now: new Date('2026-07-14T12:00:00.000Z'),
    });

    // Sent: the claim, the provider call and the stamp all run inside the lease.
    const stampQuery = chain({});
    setDbQueues({
      'email_template_automations as a': [chain({ result: [prepAutomation] })],
      email_template_automation_runs: [
        chain({ first: null }),
        chain({ returning: [queuedRun] }),
        chain({ returning: [{ ...queuedRun, status: 'running', attempts: 1 }] }),
        chain({ returning: [{ ...queuedRun, status: 'sent' }] }),
      ],
      email_template_automation_run_events: [chain({ returning: [{ id: 'e1' }] }), chain({ returning: [{ id: 'e2' }] }), chain({ returning: [{ id: 'e3' }] })],
      scheduled_services: [
        chain({ first: { id: 'svc-1', status: 'scheduled', service_type: 'Flea Control Service', scheduled_date: '2199-01-01', customer_id: null } }),
        chain({ returning: [{ id: 'svc-1' }] }),
        stampQuery,
      ],
    });
    db.fn = { now: jest.fn(() => 'NOW()') };
    const lockReleased = jest.fn();
    runExclusive.mockImplementation(async (key, fn) => { const out = await fn(); lockReleased(key); return out; });
    EmailTemplates.sendTemplate.mockResolvedValue({ sent: true, message: { id: 'message-1' } });
    expect((await trigger()).results[0].run.status).toBe('sent');
    expect(runExclusive).toHaveBeenCalledWith('prep-send:cust-1', expect.any(Function), { recordHealth: false, waitForSlot: false });
    const lockTaken = runExclusive.mock.invocationCallOrder[runExclusive.mock.calls.findIndex(([key]) => key === 'prep-send:cust-1')];
    expect(lockTaken).toBeLessThan(EmailTemplates.sendTemplate.mock.invocationCallOrder[0]);
    expect(stampQuery.update.mock.invocationCallOrder[0]).toBeLessThan(lockReleased.mock.invocationCallOrder[0]);

    // Held elsewhere: no claim, no provider call — deferred a minute out
    // WITHOUT consuming the attempt (contention is not a delivery attempt;
    // r27 P2).
    const deferQuery = chain({ returning: [{ ...queuedRun, status: 'retry_scheduled', attempts: 0 }] });
    setDbQueues({
      'email_template_automations as a': [chain({ result: [prepAutomation] })],
      email_template_automation_runs: [
        chain({ first: null }),
        chain({ returning: [queuedRun] }),
        chain({ returning: [{ ...queuedRun, status: 'running', attempts: 1 }] }),
        deferQuery,
      ],
      email_template_automation_run_events: [chain({ returning: [{ id: 'e1' }] }), chain({ returning: [{ id: 'e2' }] }), chain({ returning: [{ id: 'e3' }] })],
      // Only the live-payload read: a claim or release would throw "Unexpected db table".
      scheduled_services: [
        chain({ first: { id: 'svc-1', status: 'scheduled', service_type: 'Flea Control Service', scheduled_date: '2199-01-01', customer_id: null } }),
      ],
    });
    EmailTemplates.sendTemplate.mockClear();
    runExclusive.mockImplementation(async () => ({ skipped: true, reason: 'lease_held' }));
    expect((await trigger()).results[0].run.status).toBe('retry_scheduled');
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
    expect(deferQuery.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'retry_scheduled', attempts: 0, run_after: expect.any(Date) }));
    runExclusive.mockImplementation(async (_name, fn) => fn());
  });

  test('a prep run whose first attempt fails before dispatch hands its fresh claim back BEFORE the retry — the retry re-claims, so a conclusive final failure cannot pin the page (GH Codex #3856 r24 P2)', async () => {
    const prepAutomation = automation({
      id: 'automation-prep',
      automation_key: 'prep.flea',
      template_key: 'prep.flea',
      trigger_event_key: 'appointment.booked',
      idempotency_key_template: 'prep.flea:{scheduled_service_id}',
      conditions: JSON.stringify({ service_type_contains: ['flea'] }),
      exit_conditions: JSON.stringify({}),
      retry_policy: JSON.stringify({ max_attempts: 2, backoff_minutes: [15] }),
    });
    const queuedRun = run({
      id: 'run-prep',
      automation_id: 'automation-prep',
      automation_key: 'prep.flea',
      template_key: 'prep.flea',
      trigger_event_key: 'appointment.booked',
      trigger_event_id: 'appointment_booked:svc-1',
      entity_type: 'scheduled_service',
      entity_id: 'svc-1',
      idempotency_key: 'prep.flea:svc-1',
      recipient_type: 'customer',
      max_attempts: 2,
      payload: JSON.stringify({
        scheduled_service_id: 'svc-1',
        customer_email: 'sam@example.com',
        first_name: 'Sam',
        service_type: 'Flea Control Service',
        service_date_ymd: '2199-01-01',
      }),
    });
    const retryRun = { ...queuedRun, status: 'retry_scheduled', attempts: 1 };
    const releaseQuery = chain({});
    setDbQueues({
      'email_template_automations as a': [chain({ result: [prepAutomation] })],
      email_template_automation_runs: [
        chain({ first: null }),
        chain({ returning: [queuedRun] }),
        chain({ returning: [{ ...queuedRun, status: 'running', attempts: 1 }] }),
        chain({ returning: [retryRun] }),
      ],
      email_template_automation_run_events: [
        chain({ returning: [{ id: 'e1' }] }),
        chain({ returning: [{ id: 'e2' }] }),
        chain({ returning: [{ id: 'e3' }] }),
      ],
      // Live read, FRESH claim, then — pre-dispatch throw, retry ahead — the
      // release: the page is not carried into the retry.
      scheduled_services: [
        chain({ first: { id: 'svc-1', status: 'scheduled', service_type: 'Flea Control Service', scheduled_date: '2199-01-01', customer_id: null } }),
        chain({ returning: [{ id: 'svc-1' }] }),
        releaseQuery,
      ],
    });
    EmailTemplates.sendTemplate.mockRejectedValue(new Error('template missing'));

    const result = await AutomationExecutor.processTrigger({
      triggerEventKey: 'appointment.booked',
      triggerEventId: 'appointment_booked:svc-1',
      payload: { scheduled_service_id: 'svc-1', customer_email: 'sam@example.com', first_name: 'Sam', service_type: 'Flea Control Service', service_date_ymd: '2199-01-01' },
      now: new Date('2026-07-14T12:00:00.000Z'),
    });
    expect(result.results[0].run.status).toBe('retry_scheduled');
    expect(releaseQuery.update).toHaveBeenCalledWith({ prep_template_key: null });
    expect(releaseQuery.whereNull).toHaveBeenCalledWith('prep_sent_at');

    // A post-dispatch ambiguous throw before a retry keeps the page (a
    // release would throw "Unexpected db table" here).
    setDbQueues({
      'email_template_automations as a': [chain({ result: [prepAutomation] })],
      email_template_automation_runs: [
        chain({ first: null }),
        chain({ returning: [queuedRun] }),
        chain({ returning: [{ ...queuedRun, status: 'running', attempts: 1 }] }),
        chain({ returning: [retryRun] }),
      ],
      email_template_automation_run_events: [chain({ returning: [{ id: 'e1' }] }), chain({ returning: [{ id: 'e2' }] }), chain({ returning: [{ id: 'e3' }] })],
      scheduled_services: [
        chain({ first: { id: 'svc-1', status: 'scheduled', service_type: 'Flea Control Service', scheduled_date: '2199-01-01', customer_id: null } }),
        chain({ returning: [{ id: 'svc-1' }] }),
      ],
    });
    EmailTemplates.sendTemplate.mockImplementation(async (opts) => { await opts.onQueued({ id: 'em-1' }); throw new Error('post-dispatch bookkeeping'); });
    expect((await AutomationExecutor.processTrigger({
      triggerEventKey: 'appointment.booked',
      triggerEventId: 'appointment_booked:svc-1',
      payload: { scheduled_service_id: 'svc-1', customer_email: 'sam@example.com', first_name: 'Sam', service_type: 'Flea Control Service', service_date_ymd: '2199-01-01' },
      now: new Date('2026-07-14T12:00:00.000Z'),
    })).results[0].run.status).toBe('retry_scheduled');
  });

  test('a same-guide page already stamped delivered (a manual or composer send landed after the run was queued) skips the run as already delivered — never a second send (GH Codex #3856 r26 P1)', async () => {
    const prepAutomation = automation({
      id: 'automation-prep',
      automation_key: 'prep.flea',
      template_key: 'prep.flea',
      trigger_event_key: 'appointment.booked',
      idempotency_key_template: 'prep.flea:{scheduled_service_id}',
      conditions: JSON.stringify({ service_type_contains: ['flea'] }),
      exit_conditions: JSON.stringify({}),
    });
    const queuedRun = run({
      id: 'run-prep',
      automation_id: 'automation-prep',
      automation_key: 'prep.flea',
      template_key: 'prep.flea',
      trigger_event_key: 'appointment.booked',
      trigger_event_id: 'appointment_booked:svc-1',
      entity_type: 'scheduled_service',
      entity_id: 'svc-1',
      idempotency_key: 'prep.flea:svc-1',
      recipient_type: 'customer',
      payload: JSON.stringify({ scheduled_service_id: 'svc-1', customer_email: 'sam@example.com', first_name: 'Sam', service_type: 'Flea Control Service', service_date_ymd: '2199-01-01' }),
    });
    const skippedRun = { ...queuedRun, status: 'skipped', exit_reason: 'prep guide already delivered for this visit' };
    const skipQuery = chain({ returning: [skippedRun] });
    setDbQueues({
      'email_template_automations as a': [chain({ result: [prepAutomation] })],
      email_template_automation_runs: [
        chain({ first: null }),
        chain({ returning: [queuedRun] }),
        chain({ returning: [{ ...queuedRun, status: 'running', attempts: 1 }] }),
        skipQuery,
      ],
      email_template_automation_run_events: [chain({ returning: [{ id: 'e1' }] }), chain({ returning: [{ id: 'e2' }] }), chain({ returning: [{ id: 'e3' }] })],
      // Live read; the fresh claim matches nothing (already keyed); the
      // same-key read finds OUR key — stamped delivered.
      scheduled_services: [
        chain({ first: { id: 'svc-1', status: 'scheduled', service_type: 'Flea Control Service', scheduled_date: '2199-01-01', customer_id: null } }),
        chain({ returning: [] }),
        chain({ first: { id: 'svc-1', prep_sent_at: new Date() } }),
      ],
    });
    const result = await AutomationExecutor.processTrigger({
      triggerEventKey: 'appointment.booked',
      triggerEventId: 'appointment_booked:svc-1',
      payload: { scheduled_service_id: 'svc-1', customer_email: 'sam@example.com', first_name: 'Sam', service_type: 'Flea Control Service', service_date_ymd: '2199-01-01' },
      now: new Date('2026-07-14T12:00:00.000Z'),
    });
    expect(result.results[0].run.status).toBe('skipped');
    expect(skipQuery.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'skipped', exit_reason: 'prep guide already delivered for this visit' }));
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
  });

  test('a prep run that finally FAILS before dispatch hands its fresh page claim back; a post-dispatch throw keeps it (pre-push Codex P1 on e493a0711)', async () => {
    const prepAutomation = automation({
      id: 'automation-prep',
      automation_key: 'prep.flea',
      template_key: 'prep.flea',
      trigger_event_key: 'appointment.booked',
      idempotency_key_template: 'prep.flea:{scheduled_service_id}',
      conditions: JSON.stringify({ service_type_contains: ['flea'] }),
      exit_conditions: JSON.stringify({ stop_if: ['appointment.cancelled', 'appointment.closed', 'appointment.past'] }),
      retry_policy: JSON.stringify({ max_attempts: 1, backoff_minutes: [] }),
    });
    const queuedRun = run({
      id: 'run-prep',
      automation_id: 'automation-prep',
      automation_key: 'prep.flea',
      template_key: 'prep.flea',
      trigger_event_key: 'appointment.booked',
      trigger_event_id: 'appointment_booked:svc-1',
      entity_type: 'scheduled_service',
      entity_id: 'svc-1',
      idempotency_key: 'prep.flea:svc-1',
      recipient_type: 'customer',
      max_attempts: 1,
      payload: JSON.stringify({
        scheduled_service_id: 'svc-1',
        customer_email: 'sam@example.com',
        first_name: 'Sam',
        service_type: 'Flea Control Service',
        service_date_ymd: '2199-01-01',
      }),
    });
    const failedRun = { ...queuedRun, status: 'failed' };
    const trigger = () => AutomationExecutor.processTrigger({
      triggerEventKey: 'appointment.booked',
      triggerEventId: 'appointment_booked:svc-1',
      payload: { scheduled_service_id: 'svc-1', customer_email: 'sam@example.com', first_name: 'Sam', service_type: 'Flea Control Service', service_date_ymd: '2199-01-01' },
      now: new Date('2026-07-14T12:00:00.000Z'),
    });
    const queues = (scheduledServices) => ({
      'email_template_automations as a': [chain({ result: [prepAutomation] })],
      email_template_automation_runs: [
        chain({ first: null }),
        chain({ returning: [queuedRun] }),
        chain({ returning: [{ ...queuedRun, status: 'running', attempts: 1 }] }),
        chain({ returning: [failedRun] }),
      ],
      email_template_automation_run_events: [
        chain({ returning: [{ id: 'e1' }] }),
        chain({ returning: [{ id: 'e2' }] }),
        chain({ returning: [{ id: 'e3' }] }),
      ],
      scheduled_services: scheduledServices,
    });

    // Pre-dispatch throw (onQueued never fired): live read, fresh claim, release.
    const releaseQuery = chain({});
    setDbQueues(queues([
      chain({ first: { id: 'svc-1', status: 'scheduled', service_type: 'Flea Control Service', scheduled_date: '2199-01-01', customer_id: null } }),
      chain({ returning: [{ id: 'svc-1' }] }),
      releaseQuery,
    ]));
    EmailTemplates.sendTemplate.mockRejectedValue(new Error('template missing'));
    expect((await trigger()).results[0].run.status).toBe('failed');
    expect(releaseQuery.update).toHaveBeenCalledWith({ prep_template_key: null });
    expect(releaseQuery.whereNull).toHaveBeenCalledWith('prep_first_viewed_at');

    // Post-dispatch throw: the page may have been delivered — no release
    // (a release attempt would throw "Unexpected db table" here).
    setDbQueues(queues([
      chain({ first: { id: 'svc-1', status: 'scheduled', service_type: 'Flea Control Service', scheduled_date: '2199-01-01', customer_id: null } }),
      chain({ returning: [{ id: 'svc-1' }] }),
    ]));
    EmailTemplates.sendTemplate.mockImplementation(async (opts) => { await opts.onQueued({ id: 'em-1' }); throw new Error('post-dispatch bookkeeping'); });
    expect((await trigger()).results[0].run.status).toBe('failed');

    // Post-dispatch DEFINITE provider rejection (SendGrid 4xx from the shared
    // classifier): the payload was conclusively not accepted, so the fresh
    // claim is handed back — otherwise the failed email_messages row would
    // pin the visit's page to a guide nobody received (GH Codex #3856 r22 P2).
    const rejectedRelease = chain({});
    setDbQueues(queues([
      chain({ first: { id: 'svc-1', status: 'scheduled', service_type: 'Flea Control Service', scheduled_date: '2199-01-01', customer_id: null } }),
      chain({ returning: [{ id: 'svc-1' }] }),
      rejectedRelease,
    ]));
    EmailTemplates.sendTemplate.mockImplementation(async (opts) => {
      await opts.onQueued({ id: 'em-1' });
      const err = new Error('SendGrid 400: bad address');
      err.status = 400;
      throw err;
    });
    expect((await trigger()).results[0].run.status).toBe('failed');
    expect(rejectedRelease.update).toHaveBeenCalledWith({ prep_template_key: null });

    // A 408 / 5xx stays ambiguous — the page is kept (a release would throw
    // "Unexpected db table" here).
    setDbQueues(queues([
      chain({ first: { id: 'svc-1', status: 'scheduled', service_type: 'Flea Control Service', scheduled_date: '2199-01-01', customer_id: null } }),
      chain({ returning: [{ id: 'svc-1' }] }),
    ]));
    EmailTemplates.sendTemplate.mockImplementation(async (opts) => {
      await opts.onQueued({ id: 'em-1' });
      const err = new Error('SendGrid 503');
      err.status = 503;
      throw err;
    });
    expect((await trigger()).results[0].run.status).toBe('failed');
  });

  describe('processDueRuns preview mode', () => {
    const dueRows = [
      { id: 'run-1', recipient_email: 'a@example.com', automation_key: 'k1', template_key: 't1', status: 'pending', run_after: new Date('2026-07-14T00:00:00.000Z') },
      { id: 'run-2', recipient_email: 'b@example.com', automation_key: 'k2', template_key: 't2', status: 'pending', run_after: new Date('2026-07-14T00:00:00.000Z') },
    ];

    test('preview returns the due runs WITHOUT sending', async () => {
      setDbQueues({ email_template_automation_runs: [chain({ result: dueRows })] });

      const result = await AutomationExecutor.processDueRuns({ preview: true });

      expect(result).toEqual({
        preview: true,
        dueCount: 2,
        runs: [
          { id: 'run-1', recipient_email: 'a@example.com', automation_key: 'k1', template_key: 't1', status: 'pending', run_after: dueRows[0].run_after },
          { id: 'run-2', recipient_email: 'b@example.com', automation_key: 'k2', template_key: 't2', status: 'pending', run_after: dueRows[1].run_after },
        ],
      });
      expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
    });

    test('preview with nothing due reports zero and sends nothing', async () => {
      setDbQueues({ email_template_automation_runs: [chain({ result: [] })] });

      const result = await AutomationExecutor.processDueRuns({ preview: true });

      expect(result).toEqual({ preview: true, dueCount: 0, runs: [] });
      expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
    });

    test('a confirmed send restricts the due query to the previewed run ids', async () => {
      const dueQuery = chain({ result: [] });
      setDbQueues({ email_template_automation_runs: [dueQuery] });

      await AutomationExecutor.processDueRuns({ runIds: ['run-1', 'run-2'] });

      // .modify runs the callback with the same builder, which calls whereIn('id', ...)
      expect(dueQuery.whereIn).toHaveBeenCalledWith('id', ['run-1', 'run-2']);
    });

    test('an empty runIds is fail-closed: sends nothing and never queries', async () => {
      db.mockClear();

      const result = await AutomationExecutor.processDueRuns({ runIds: [] });

      expect(result).toEqual({ processed: 0, results: [] });
      expect(db).not.toHaveBeenCalled();
      expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
    });

    test('empty runIds in preview mode reports zero due', async () => {
      db.mockClear();

      const result = await AutomationExecutor.processDueRuns({ preview: true, runIds: [] });

      expect(result).toEqual({ preview: true, dueCount: 0, runs: [] });
      expect(db).not.toHaveBeenCalled();
    });

    test('undefined runIds (scheduler path) runs the full unscoped batch', async () => {
      const dueQuery = chain({ result: [] });
      setDbQueues({ email_template_automation_runs: [dueQuery] });

      await AutomationExecutor.processDueRuns();

      expect(dueQuery.whereIn).not.toHaveBeenCalledWith('id', expect.anything());
    });
  });
});
