/**
 * Real-PostgreSQL regression coverage for two codex #4293 P1 findings that a
 * mocked knex cannot reproduce, because both hinge on genuine Postgres
 * semantics — the transaction-start clock and the atomic-UPDATE predicate
 * evaluating against whatever the row looks like AT WRITE TIME, not at some
 * earlier read.
 *
 * 1. persistedActivationBoundary must persist the DATABASE's own transaction
 *    timestamp, not a JS `new Date()` sampled inside the transaction — a
 *    JS clock read is a wall-clock sample taken strictly AFTER the
 *    transaction already opened, so it can land after the CURRENT_TIMESTAMP
 *    a later INSERT in that SAME transaction will stamp on the very
 *    commitment establishing the boundary, silently cancelling it as
 *    pre_activation. Only a real Postgres transaction demonstrates this —
 *    a mock's "transaction" has no fixed-at-BEGIN clock to get wrong.
 *
 * 2. parkReview's atomic UPDATE must reject a row a concurrent markLinkUsed
 *    has already reconciled, even though runOne's own "already settled"
 *    check ran on an earlier, staler read of the row. Reproducing this
 *    needs two real, independently-timed writers racing over the same row
 *    under a real advisory lock — not something a hand-rolled query-builder
 *    mock can honestly arbitrate.
 */
jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

const knex = require('knex');
const { randomUUID } = require('node:crypto');
const links = require('../services/reschedule-link-promises');
const { gates } = require('../config/feature-gates');
const rescheduleLinkPromisesMigration = require('../models/migrations/20260909000092_reschedule_link_promises');
const outboxLastScannedMigration = require('../models/migrations/20260911000020_outbox_messages_last_scanned_at');
const outboxCommitmentGenerationMigration = require('../models/migrations/20260911000030_outbox_messages_commitment_generation');

const connection = process.env.RESCHEDULE_LINK_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `reschedule_link_${randomUUID().replaceAll('-', '')}`;
const TABLES = ['customers', 'call_log', 'call_commitments', 'outbox_messages', 'system_settings', 'triage_items', 'audit_log', 'sms_templates'];
let admin;
let mockPg;
jest.setTimeout(30000);

// Wraps a real knex/transaction connection so a query against ONE named
// table resolves only after an artificial delay — the stand-in for the real
// wall-clock gap a multi-round-trip contextFor lookup takes in production,
// long enough to guarantee a genuinely concurrent write (started AFTER this
// call began) can complete first every time, without relying on lucky
// scheduling.
function delayTable(base, table, ms) {
  const wrapped = (name, ...args) => {
    const qb = base(name, ...args);
    if (name !== table) return qb;
    const originalThen = qb.then.bind(qb);
    qb.then = (onFulfilled, onRejected) => originalThen(
      (result) => new Promise((resolve) => setTimeout(() => resolve(result), ms)),
    ).then(onFulfilled, onRejected);
    return qb;
  };
  wrapped.transaction = (...args) => base.transaction(...args);
  wrapped.raw = (...args) => base.raw(...args);
  wrapped.fn = base.fn;
  return wrapped;
}

postgres('reschedule-link-promises against PostgreSQL', () => {
  beforeAll(async () => {
    if (!/^\/(waves_test|waves_qa_[a-f0-9]+)$/.test(new URL(connection).pathname)) {
      throw new Error('Use an explicitly selected synthetic Waves QA database');
    }
    admin = knex({ client: 'pg', connection });
    await admin.schema.createSchema(schema);
    mockPg = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 5 } });
    // Clone the MIGRATED public schema, never application records — catches
    // real column/type/CHECK drift instead of a hand-written stand-in.
    // CREATE TABLE LIKE never copies foreign keys regardless of INCLUDING
    // ALL, so omitting FK-only reference tables here is safe.
    for (const table of TABLES) {
      await admin.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, table, table]);
    }
    // Bring this isolated clone forward by whatever this branch's newest
    // outbox_messages/call_commitments columns are, exactly like the SMS
    // postgres suite does for its own trailing migrations — idempotent
    // (hasColumn-guarded) so this is a no-op wherever public is already current.
    await rescheduleLinkPromisesMigration.up(mockPg);
    await outboxLastScannedMigration.up(mockPg);
    await outboxCommitmentGenerationMigration.up(mockPg);
  });
  afterAll(async () => {
    if (mockPg) await mockPg.destroy();
    if (admin) { await admin.schema.dropSchemaIfExists(schema, true); await admin.destroy(); }
  });
  beforeEach(async () => {
    for (const table of TABLES) await mockPg(table).delete();
  });

  test('the persisted activation boundary uses the DATABASE transaction clock, not a JS wall-clock sample — a commitment written in the SAME transaction is never before its own boundary (codex #4293 P1)', async () => {
    const priorGate = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE;
    const priorActivatedAt = process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT;
    const priorCallCommitments = gates.callCommitments;
    try {
      process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = 'true';
      delete process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT;
      gates.callCommitments = true;

      const callId = randomUUID();
      await mockPg('call_log').insert({ id: callId, direction: 'inbound', processing_generation: 1 });

      let boundary;
      let commitmentCreatedAt;
      await mockPg.transaction(async (trx) => {
        // call-commitments.upsertCommitments calls recordLiveActivation
        // FIRST, inside the very same transaction that later inserts the
        // commitment row this boundary must admit. Model the real gap
        // between that call and the later INSERT — dedup lookups, row
        // shaping, the ownership-fence check — so a JS `new Date()` read
        // (the pre-fix bug) lands measurably AFTER the transaction's own
        // fixed start instant instead of tying with it at millisecond
        // resolution by luck.
        await new Promise((resolve) => setTimeout(resolve, 25));
        await links.recordLiveActivation(trx);
        const stored = await trx('system_settings').where({ key: 'reschedule_link_promise_activated_at' }).first('value');
        boundary = new Date(stored.value);
        const [inserted] = await trx('call_commitments').insert({
          call_log_id: callId, commitment_key: 'send_reschedule_link:1', party: 'waves', kind: 'send_reschedule_link',
          description: 'send a reschedule link', source: 'ai', status: 'open',
        }).returning('created_at');
        commitmentCreatedAt = inserted.created_at;
      });

      // created_at defaults to CURRENT_TIMESTAMP, fixed at transaction start
      // regardless of how much real time the transaction has already spent —
      // so the commitment that (in production) establishes this very
      // boundary must never read as older than it.
      expect(commitmentCreatedAt.getTime()).toBeGreaterThanOrEqual(boundary.getTime());
    } finally {
      if (priorGate === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = priorGate;
      if (priorActivatedAt === undefined) delete process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT; else process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT = priorActivatedAt;
      gates.callCommitments = priorCallCommitments;
    }
  });

  test('a row markLinkUsed reconciles WHILE a stale sweep pass is still working it cannot be re-parked (codex #4293 P1)', async () => {
    const priorGate = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE;
    const priorCallCommitments = gates.callCommitments;
    try {
      process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = 'true';
      gates.callCommitments = true;

      const callId = randomUUID();
      const customerId = randomUUID();
      const visitId = randomUUID();
      // processing_generation deliberately mismatches last_seen_generation
      // below so contextFor deterministically returns 'stale_extraction' —
      // an ordinary, unrelated reason runOne parks for — without needing a
      // fully modeled visit-matching setup.
      await mockPg('call_log').insert({ id: callId, direction: 'inbound', processing_generation: 5 });
      const [commitment] = await mockPg('call_commitments').insert({
        call_log_id: callId, commitment_key: 'send_reschedule_link:1', party: 'waves', kind: 'send_reschedule_link',
        description: 'send a reschedule link', source: 'ai', status: 'open', last_seen_generation: 1,
      }).returning('id');
      const outboxId = randomUUID();
      await mockPg('outbox_messages').insert({ id: outboxId, channel: 'sms', payload: {}, status: 'sent',
        commitment_id: commitment.id, related_call_log_id: callId, related_customer_id: customerId, related_scheduled_service_id: visitId });

      // The exact snapshot runOne's own top-of-function refetch would see —
      // taken BEFORE the concurrent public reschedule (markLinkUsed) stamps
      // the row — with no card raised for it yet.
      const staleRow = await mockPg('outbox_messages').where({ id: outboxId }).first();
      expect(staleRow.payload.link_used_reconciled_at).toBeUndefined();

      // contextFor's SECOND query (the call_log lookup, right after the
      // call_commitments read) is the real multi-round-trip gap runOne
      // spends between its own fresh row-read and its eventual parkReview
      // call. Delaying it here guarantees the concurrent markLinkUsed below
      // — issued on the real, undelayed connection — commits well before
      // parkReview's UPDATE runs, every time.
      const slowConn = delayTable(mockPg, 'call_log', 300);

      await Promise.all([
        links.runOne(slowConn, staleRow, { now: new Date() }),
        links.markLinkUsed(mockPg, staleRow),
      ]);

      const after = await mockPg('outbox_messages').where({ id: outboxId }).first();
      // markLinkUsed's own stamp landed...
      expect(after.payload.link_used_reconciled_at).toBeTruthy();
      // ...and the stale sweep's parkReview must NOT have re-opened this
      // promise: status is untouched (still 'sent', never flipped to
      // 'review'), and no exception card exists to reopen the call.
      expect(after.status).toBe('sent');
      expect(after.last_error).toBeFalsy();
      const cards = await mockPg('triage_items').where({ call_log_id: callId, reason_code: 'reschedule_link_promise' });
      expect(cards).toEqual([]);
    } finally {
      if (priorGate === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = priorGate;
      gates.callCommitments = priorCallCommitments;
    }
  });
});
