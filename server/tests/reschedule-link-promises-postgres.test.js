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
const { applyHumanUpdate } = require('../services/call-commitments');
const { gates } = require('../config/feature-gates');
const rescheduleLinkPromisesMigration = require('../models/migrations/20260909000092_reschedule_link_promises');
const outboxLastScannedMigration = require('../models/migrations/20260911000020_outbox_messages_last_scanned_at');
const outboxCommitmentGenerationMigration = require('../models/migrations/20260911000030_outbox_messages_commitment_generation');

const connection = process.env.RESCHEDULE_LINK_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `reschedule_link_${randomUUID().replaceAll('-', '')}`;
const TABLES = ['customers', 'call_log', 'call_commitments', 'outbox_messages', 'system_settings', 'triage_items', 'audit_log', 'sms_templates', 'sms_log', 'scheduled_services', 'customer_properties', 'short_codes'];
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

  /**
   * codex #4293 P1 (this round): delivery uncertainty ("a provider may
   * already have accepted this attempt") and a context error ("we could not
   * evaluate this row right now") used to share the same last_error/status
   * fields, so an unrelated context error re-parking the row erased the
   * uncertainty underneath it. The fix stores uncertainty under its own
   * jsonb payload key, cleared ONLY by definitive provider evidence or an
   * explicit office verdict. These three tests exercise the real jsonb
   * merge (`COALESCE(payload, '{}'::jsonb) || ...`) and the real UPDATE
   * predicates end to end — a mocked knex would only prove the JS shape,
   * not that the merge actually survives a genuine Postgres round trip.
   */
  describe('delivery uncertainty survives context churn and is retired only by real provider evidence or an office verdict', () => {
    test('a stale_extraction context error does not clear the flag, and a fresh generation stays blocked', async () => {
      const priorGate = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE;
      const priorCallCommitments = gates.callCommitments;
      try {
        process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = 'true';
        gates.callCommitments = true;

        const callId = randomUUID();
        // last_seen_generation (1) deliberately mismatches call_log's
        // processing_generation (5) so contextFor deterministically returns
        // 'stale_extraction' on every pass — the exact reprocess churn that
        // used to overwrite last_error out from under an uncertain attempt.
        await mockPg('call_log').insert({ id: callId, direction: 'inbound', processing_generation: 5 });
        const [commitment] = await mockPg('call_commitments').insert({
          call_log_id: callId, commitment_key: 'send_reschedule_link:1', party: 'waves', kind: 'send_reschedule_link',
          description: 'send a reschedule link', source: 'ai', status: 'open', last_seen_generation: 1, processing_generation: 2,
        }).returning('id');
        const outboxId = randomUUID();
        // Generation 1's own attempt reached the provider with no persisted
        // trace — parked exactly as an earlier sweep would have left it.
        await mockPg('outbox_messages').insert({ id: outboxId, channel: 'sms', status: 'review', last_error: 'provider_outcome_unknown',
          payload: { delivery_outcome_uncertain: true }, commitment_id: commitment.id, commitment_generation: 1,
          related_call_log_id: callId, related_customer_id: randomUUID(), related_scheduled_service_id: randomUUID() });

        const row = await mockPg('outbox_messages').where({ id: outboxId }).first();
        await links.runOne(mockPg, row, { now: new Date() });

        const afterPark = await mockPg('outbox_messages').where({ id: outboxId }).first();
        // The unrelated context error DID overwrite last_error, as before —
        // but the flag underneath it must be untouched.
        expect(afterPark.status).toBe('review');
        expect(afterPark.last_error).toBe('stale_extraction');
        expect(afterPark.payload.delivery_outcome_uncertain).toBe(true);

        // upsertCommitments would bump processing_generation to 2 on a real
        // reprocess; it is already 2 here. A fresh dispatch must still be
        // held back — the older generation-1 attempt is still uncertain.
        const staged = await links.stagePromises(mockPg);
        expect(staged).toBe(0);
        const rows = await mockPg('outbox_messages').where({ commitment_id: commitment.id });
        expect(rows).toHaveLength(1);
      } finally {
        if (priorGate === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = priorGate;
        gates.callCommitments = priorCallCommitments;
      }
    });

    test('a real twilio_sid-bearing sms_log row proving the send failed clears the flag, and staging then proceeds', async () => {
      const priorGate = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE;
      const priorCallCommitments = gates.callCommitments;
      try {
        process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = 'true';
        gates.callCommitments = true;

        const callId = randomUUID();
        const customerId = randomUUID();
        const twilioSid = `SM${randomUUID().replaceAll('-', '').slice(0, 32)}`;
        await mockPg('call_log').insert({ id: callId, direction: 'inbound', processing_generation: 2 });
        const [commitment] = await mockPg('call_commitments').insert({
          call_log_id: callId, commitment_key: 'send_reschedule_link:1', party: 'waves', kind: 'send_reschedule_link',
          description: 'send a reschedule link', source: 'ai', status: 'open', last_seen_generation: 2, processing_generation: 2,
        }).returning('id');
        const outboxId = randomUUID();
        // Still 'sending' (no process-death gap needed for this test) with a
        // real provider id already on the row — reconcileAttempt owns it.
        await mockPg('outbox_messages').insert({ id: outboxId, channel: 'sms', status: 'sending', provider_message_id: twilioSid,
          sent_at: new Date(), payload: { delivery_outcome_uncertain: true }, commitment_id: commitment.id, commitment_generation: 1,
          related_call_log_id: callId, related_customer_id: customerId, related_scheduled_service_id: randomUUID() });
        await mockPg('sms_log').insert({ id: randomUUID(), customer_id: customerId, direction: 'outbound',
          from_phone: '+15555550100', to_phone: '+15555550199', twilio_sid: twilioSid, status: 'failed', message_body: 'reschedule link' });

        const row = await mockPg('outbox_messages').where({ id: outboxId }).first();
        await links.runOne(mockPg, row, { now: new Date() });

        const afterFailure = await mockPg('outbox_messages').where({ id: outboxId }).first();
        expect(afterFailure.status).toBe('review');
        expect(afterFailure.last_error).toBe('delivery_failed');
        // Real provider evidence — the ONLY thing besides an office verdict
        // allowed to clear the flag.
        expect(afterFailure.payload.delivery_outcome_uncertain).toBe(false);

        const staged = await links.stagePromises(mockPg);
        expect(staged).toBe(1);
        const rows = await mockPg('outbox_messages').where({ commitment_id: commitment.id }).orderBy('commitment_generation');
        expect(rows).toHaveLength(2);
        expect(rows[1]).toMatchObject({ commitment_generation: 2, status: 'pending' });
      } finally {
        if (priorGate === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = priorGate;
        gates.callCommitments = priorCallCommitments;
      }
    });

    test('an office verdict (the commitment closed) also clears the flag on the row it cancels', async () => {
      const priorGate = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE;
      const priorCallCommitments = gates.callCommitments;
      try {
        process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = 'true';
        gates.callCommitments = true;

        const callId = randomUUID();
        await mockPg('call_log').insert({ id: callId, direction: 'inbound', processing_generation: 1 });
        // human_state 'dismissed' is a genuinely terminal office verdict —
        // contextFor reads it straight off the commitment row as
        // 'promise_closed', independent of any generation bookkeeping.
        const [commitment] = await mockPg('call_commitments').insert({
          call_log_id: callId, commitment_key: 'send_reschedule_link:1', party: 'waves', kind: 'send_reschedule_link',
          description: 'send a reschedule link', source: 'ai', status: 'open', human_state: 'dismissed',
          last_seen_generation: 1, processing_generation: 1,
        }).returning('id');
        const outboxId = randomUUID();
        await mockPg('outbox_messages').insert({ id: outboxId, channel: 'sms', status: 'review', last_error: 'provider_outcome_unknown',
          payload: { delivery_outcome_uncertain: true }, commitment_id: commitment.id, commitment_generation: 1,
          related_call_log_id: callId, related_customer_id: randomUUID(), related_scheduled_service_id: randomUUID() });

        const row = await mockPg('outbox_messages').where({ id: outboxId }).first();
        await links.runOne(mockPg, row, { now: new Date() });

        const after = await mockPg('outbox_messages').where({ id: outboxId }).first();
        expect(after.status).toBe('cancelled');
        expect(after.payload.delivery_outcome_uncertain).toBe(false);
      } finally {
        if (priorGate === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = priorGate;
        gates.callCommitments = priorCallCommitments;
      }
    });

    test('a PARKED failed attempt still lets a later office verdict reconcile the commitment and clear its own exception card, without retrying the send (codex #4293 P1)', async () => {
      // reconcileAttempt's own 'else if (failed)' branch — the row is
      // ALREADY 'review' from an earlier delivery_failed park, so `unparked`
      // is false here. Before the fix this branch retired the flag and then
      // (via the function's shared `return true` fall-through) told runOne
      // "handled" — runOne returned immediately and never reached
      // contextFor, so an office dismissal recorded on the commitment
      // afterward could never close this row's own exception card.
      const priorGate = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE;
      const priorCallCommitments = gates.callCommitments;
      try {
        process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = 'true';
        gates.callCommitments = true;

        const callId = randomUUID();
        const customerId = randomUUID();
        const twilioSid = `SM${randomUUID().replaceAll('-', '').slice(0, 32)}`;
        await mockPg('call_log').insert({ id: callId, direction: 'inbound', processing_generation: 1 });
        // The office dismissed the commitment on the ledger AFTER this exact
        // SMS had already failed and parked — human_state 'dismissed' reads
        // as a terminal 'promise_closed' verdict in contextFor, independent
        // of any generation bookkeeping.
        const [commitment] = await mockPg('call_commitments').insert({
          call_log_id: callId, commitment_key: 'send_reschedule_link:1', party: 'waves', kind: 'send_reschedule_link',
          description: 'send a reschedule link', source: 'ai', status: 'open', human_state: 'dismissed',
          last_seen_generation: 1, processing_generation: 1,
        }).returning('id');
        const outboxId = randomUUID();
        // Already parked ('review') from an earlier pass's own
        // 'delivery_failed' park — a real twilio_sid-bearing sms_log row
        // still says 'failed', so every fresh sweep keeps landing back on
        // this exact branch.
        await mockPg('outbox_messages').insert({ id: outboxId, channel: 'sms', status: 'review', last_error: 'delivery_failed',
          provider_message_id: twilioSid, sent_at: new Date(), payload: { delivery_outcome_uncertain: true },
          commitment_id: commitment.id, commitment_generation: 1,
          related_call_log_id: callId, related_customer_id: customerId, related_scheduled_service_id: randomUUID() });
        await mockPg('sms_log').insert({ id: randomUUID(), customer_id: customerId, direction: 'outbound',
          from_phone: '+15555550100', to_phone: '+15555550199', twilio_sid: twilioSid, status: 'failed', message_body: 'reschedule link' });
        // The exception card the original delivery_failed park raised —
        // still open, still speaking for this one commitment.
        await mockPg('triage_items').insert({ call_log_id: callId, category: 'customer_followup', severity: 'advisory',
          reason_code: 'reschedule_link_promise', status: 'open', summary: 'A promised reschedule link needs attention.',
          payload: { reschedule_link_promise: { commitment_id: commitment.id, commitment_ids: [commitment.id], reason: 'delivery_failed' } } });

        const row = await mockPg('outbox_messages').where({ id: outboxId }).first();
        // No `send` stand-in is supplied — if this ever reached dispatch, the
        // missing real Twilio wiring would throw. It must not: the terminal
        // verdict is reconciled entirely through applyContextSkip's
        // promise_closed branch, never through a resend.
        await links.runOne(mockPg, row, { now: new Date() });

        const after = await mockPg('outbox_messages').where({ id: outboxId }).first();
        expect(after.status).toBe('cancelled');
        expect(after.payload.delivery_outcome_uncertain).toBe(false);
        const card = await mockPg('triage_items').where({ call_log_id: callId, reason_code: 'reschedule_link_promise' }).first();
        expect(card.status).toBe('resolved');
      } finally {
        if (priorGate === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = priorGate;
        gates.callCommitments = priorCallCommitments;
      }
    });

    test('a definitive failure receipt reconciles even after the attempt already sits parked for an unrelated reason (codex #4293 P1)', async () => {
      // The row parked for stale_extraction on an earlier pass — a
      // transient context error, unrelated to delivery. A REAL twilio_sid
      // sms_log row now proves the provider itself rejected THIS attempt.
      // That is exactly as conclusive as the still-live 'delivery_failed'
      // case above and must retire the flag too, or stagePromises blocks a
      // replacement generation forever despite proof delivery failed.
      const priorGate = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE;
      const priorCallCommitments = gates.callCommitments;
      try {
        process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = 'true';
        gates.callCommitments = true;

        const callId = randomUUID();
        const customerId = randomUUID();
        const twilioSid = `SM${randomUUID().replaceAll('-', '').slice(0, 32)}`;
        // last_seen_generation (2) deliberately mismatches call_log's
        // processing_generation (5) so contextFor deterministically
        // re-derives 'stale_extraction' on this very pass too (codex #4293
        // P1: reconcileAttempt's parked-failed branch now falls through to
        // contextFor instead of short-circuiting, so this reason is freshly
        // recomputed, not merely a leftover insert value).
        await mockPg('call_log').insert({ id: callId, direction: 'inbound', processing_generation: 5 });
        const [commitment] = await mockPg('call_commitments').insert({
          call_log_id: callId, commitment_key: 'send_reschedule_link:1', party: 'waves', kind: 'send_reschedule_link',
          description: 'send a reschedule link', source: 'ai', status: 'open', last_seen_generation: 2, processing_generation: 2,
        }).returning('id');
        const outboxId = randomUUID();
        // Already parked ('review') for a context error, not a delivery
        // outcome — the exact shape reconcileAttempt's pre-fix guard
        // ('failed && unparked') silently ignored.
        await mockPg('outbox_messages').insert({ id: outboxId, channel: 'sms', status: 'review', last_error: 'stale_extraction',
          provider_message_id: twilioSid, sent_at: new Date(), payload: { delivery_outcome_uncertain: true },
          commitment_id: commitment.id, commitment_generation: 1,
          related_call_log_id: callId, related_customer_id: customerId, related_scheduled_service_id: randomUUID() });
        await mockPg('sms_log').insert({ id: randomUUID(), customer_id: customerId, direction: 'outbound',
          from_phone: '+15555550100', to_phone: '+15555550199', twilio_sid: twilioSid, status: 'failed', message_body: 'reschedule link' });

        const row = await mockPg('outbox_messages').where({ id: outboxId }).first();
        await links.runOne(mockPg, row, { now: new Date() });

        const after = await mockPg('outbox_messages').where({ id: outboxId }).first();
        // The existing review reason reads exactly as it did — parkReview's
        // own reason-unchanged guard no-ops a same-status/same-reason write —
        // only the flag moves.
        expect(after.status).toBe('review');
        expect(after.last_error).toBe('stale_extraction');
        expect(after.payload.delivery_outcome_uncertain).toBe(false);

        // With the flag cleared, a replacement generation can finally stage.
        const staged = await links.stagePromises(mockPg);
        expect(staged).toBe(1);
      } finally {
        if (priorGate === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = priorGate;
        gates.callCommitments = priorCallCommitments;
      }
    });
  });

  describe('markLinkUsed clears the shared exception card only when the attempt still owns the current generation (codex #4293 P1)', () => {
    // markLinkUsed's own transaction reads the commitment row FRESH under
    // FOR UPDATE, exactly like fulfilPromise — a genuine Postgres lock read,
    // not a JS mock's in-memory state, is what actually proves the fence
    // reads the commitment as it stands NOW and not whatever the caller's
    // stale `row` snapshot implies.
    async function seedReopenedCommitment({ replacementReopened }) {
      const callId = randomUUID();
      const customerId = randomUUID();
      const visitId = randomUUID();
      await mockPg('call_log').insert({ id: callId, direction: 'inbound', processing_generation: replacementReopened ? 2 : 1 });
      const [commitment] = await mockPg('call_commitments').insert({
        call_log_id: callId, commitment_key: 'send_reschedule_link:1', party: 'waves', kind: 'send_reschedule_link',
        description: 'send a reschedule link', source: 'ai', status: 'open',
        last_seen_generation: replacementReopened ? 2 : 1, processing_generation: replacementReopened ? 2 : 1,
      }).returning('id');
      const outboxId = randomUUID();
      // Generation 1's own attempt reached the provider, then sat parked
      // waiting on a carrier receipt that never arrived — the shape
      // unreconciledPromiseRows admits ('review' with a provider id).
      await mockPg('outbox_messages').insert({ id: outboxId, channel: 'sms', status: 'review', last_error: 'provider_outcome_unknown',
        provider_message_id: `SM${randomUUID().replaceAll('-', '').slice(0, 32)}`,
        payload: { call_generation: 1, delivery_outcome_uncertain: true },
        commitment_id: commitment.id, commitment_generation: 1,
        related_call_log_id: callId, related_customer_id: customerId, related_scheduled_service_id: visitId });
      // The exception card this generation-1 attempt raised — still open,
      // still speaking for this one commitment_id.
      await mockPg('triage_items').insert({ call_log_id: callId, category: 'customer_followup', severity: 'advisory',
        reason_code: 'reschedule_link_promise', status: 'open', summary: 'A promised reschedule link needs attention.',
        payload: { reschedule_link_promise: { commitment_id: commitment.id, commitment_ids: [commitment.id], reason: 'provider_outcome_unknown' } } });
      const row = await mockPg('outbox_messages').where({ id: outboxId }).first();
      return { callId, commitment, row };
    }

    test('the customer using the OLDER attempt\'s link after a replacement recording reopened the commitment leaves the replacement\'s card intact', async () => {
      // A replacement recording reopened this SAME commitment_id to
      // generation 2 (a fresh, still-live obligation) between when
      // generation 1's link went out and when the customer finally clicked
      // it. Reconciling the OLD row must stamp it, but must NOT clear the
      // shared card the (still-open) generation-2 attempt also depends on.
      const { callId, row } = await seedReopenedCommitment({ replacementReopened: true });
      await links.markLinkUsed(mockPg, row);

      const afterRow = await mockPg('outbox_messages').where({ id: row.id }).first();
      // The customer really did use this link — that fact is always
      // recorded, whatever generation staged it.
      expect(afterRow.payload.link_used_reconciled_at).toBeTruthy();

      const card = await mockPg('triage_items').where({ call_log_id: callId, reason_code: 'reschedule_link_promise' }).first();
      // The office still has a live obligation to see — the card must not
      // have been resolved out from under the replacement generation.
      expect(card.status).toBe('open');
    });

    test('the customer using the link with no replacement generation in play clears the card exactly as before', async () => {
      const { callId, row } = await seedReopenedCommitment({ replacementReopened: false });
      await links.markLinkUsed(mockPg, row);

      const afterRow = await mockPg('outbox_messages').where({ id: row.id }).first();
      expect(afterRow.payload.link_used_reconciled_at).toBeTruthy();

      const card = await mockPg('triage_items').where({ call_log_id: callId, reason_code: 'reschedule_link_promise' }).first();
      expect(card.status).toBe('resolved');
    });
  });

  /**
   * codex #4293 P1 (pre-push audit on PR #4293): settleDelivery's identity
   * check (deliveryIdentityMatches) conflates two different questions —
   * "did the provider deliver THIS attempt" (an immutable fact about the
   * one outbox row a real twilio_sid names) and "may this delivery fulfil
   * the CURRENT commitment" (gated on generation, exactly like
   * fulfilPromise's own attemptOwnsCurrentGeneration check). Failing the
   * identity check because reprocessing advanced the generation used to
   * leave delivery_outcome_uncertain permanently true even though the
   * receipt just proved, definitively, that this attempt WAS delivered —
   * blocking stagePromises from ever staging the replacement generation.
   */
  test('a delivered receipt for a SUPERSEDED generation still retires this attempt\'s uncertainty, without fulfilling the replacement commitment (codex #4293 P1)', async () => {
    const priorGate = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE;
    const priorCallCommitments = gates.callCommitments;
    try {
      process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = 'true';
      gates.callCommitments = true;

      const callId = randomUUID();
      const customerId = randomUUID();
      const visitId = randomUUID();
      const phone = '+15555550100';
      const twilioSid = `SM${randomUUID().replaceAll('-', '').slice(0, 32)}`;
      await mockPg('customers').insert({ id: customerId, first_name: 'Pat', last_name: 'Customer', phone,
        address_line1: '1 Example St', city: 'Bradenton', zip: '34205' });
      await mockPg('scheduled_services').insert({ id: visitId, customer_id: customerId, scheduled_date: '2030-01-08', service_type: 'WaveGuard' });
      // Reprocessing (a replacement recording) has already bumped the call's
      // OWN generation to 2, and call-commitments.upsertCommitments carried
      // the commitment's last_seen_generation to 2 right along with it — all
      // BEFORE generation 1's own carrier receipt ever arrives.
      await mockPg('call_log').insert({ id: callId, customer_id: customerId, direction: 'inbound', from_phone: phone, processing_generation: 2 });
      const [commitment] = await mockPg('call_commitments').insert({
        call_log_id: callId, commitment_key: 'send_reschedule_link:1', party: 'waves', kind: 'send_reschedule_link',
        description: 'send a reschedule link', source: 'ai', status: 'open', last_seen_generation: 2, processing_generation: 2,
      }).returning('id');
      const outboxId = randomUUID();
      // This exact attempt was claimed and sent under generation 1 — still
      // 'sending' (no receipt yet) with delivery_outcome_uncertain true, the
      // window stagePromises must not stage a duplicate generation into.
      await mockPg('outbox_messages').insert({ id: outboxId, channel: 'sms', status: 'sending', provider_message_id: twilioSid,
        sent_at: new Date(), payload: { call_generation: 1, delivery_outcome_uncertain: true },
        commitment_id: commitment.id, commitment_generation: 1,
        related_call_log_id: callId, related_customer_id: customerId, related_scheduled_service_id: visitId });
      // The provider's own definitive record: THIS attempt really was
      // delivered — a fact about the message, independent of what the
      // commitment has since become.
      await mockPg('sms_log').insert({ id: randomUUID(), customer_id: customerId, direction: 'outbound',
        from_phone: '+15555550199', to_phone: phone, twilio_sid: twilioSid, status: 'delivered', message_body: 'Your reschedule link: https://example.com/x' });

      const row = await mockPg('outbox_messages').where({ id: outboxId }).first();
      await links.runOne(mockPg, row, { now: new Date() });

      const after = await mockPg('outbox_messages').where({ id: outboxId }).first();
      // deliveryIdentityMatches refused this receipt (generation 1 no longer
      // matches the commitment's current generation 2), so the row is
      // parked for the office to look at the scope change...
      expect(after.status).toBe('review');
      expect(after.last_error).toBe('delivery_scope_changed');
      // ...but the flag must retire regardless: the provider's own evidence
      // for THIS attempt is definitive and does not depend on what the
      // commitment has since become. Left true (the pre-fix behavior), this
      // exact row blocks stagePromises from ever staging generation 2's own
      // replacement send.
      expect(after.payload.delivery_outcome_uncertain).toBe(false);

      // The commitment itself is untouched — settling the ATTEMPT must never
      // fulfil the CURRENT commitment on a superseded generation's evidence;
      // that mutation stays gated on generation ownership exactly as before.
      const afterCommitment = await mockPg('call_commitments').where({ id: commitment.id }).first();
      expect(afterCommitment.status).toBe('open');
      expect(afterCommitment.fulfilled_at).toBeNull();

      // With the flag cleared, generation 2's own replacement send is no
      // longer blocked behind an attempt whose outcome is, in fact, known.
      const staged = await links.stagePromises(mockPg);
      expect(staged).toBe(1);
      const rows = await mockPg('outbox_messages').where({ commitment_id: commitment.id }).orderBy('commitment_generation');
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({ commitment_generation: 2, status: 'pending' });
    } finally {
      if (priorGate === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = priorGate;
      gates.callCommitments = priorCallCommitments;
    }
  });

  /**
   * codex #4293 P1 (pre-push audit on PR #4293, this round): the THIRD shape
   * clearing delivery uncertainty rode along on a foreign guard as a
   * passenger. settleDelivery's own scope-changed fallback threaded
   * `clearDeliveryUncertain` through parkReview as an option — but
   * parkReview's UPDATE also carries its own reason-unchanged no-op
   * optimisation (`status <> 'review' OR last_error IS DISTINCT FROM
   * reason`), meant only to stop a churny re-park from restamping
   * updated_at pointlessly. When the SAME sms attempt scope-changes TWICE
   * for the SAME reason — first while merely 'sent' (not yet definitive),
   * then again once the carrier confirms 'delivered' (now definitive) — the
   * second call's park reason ('delivery_scope_changed') matches the first
   * call's already-parked reason, so that guard skips the ENTIRE UPDATE,
   * including the payload merge the clear was piggybacking on. The flag
   * stays true forever and stagePromises never stages the replacement
   * generation, despite the carrier's own receipt having definitively
   * proven delivery. Only a real Postgres UPDATE evaluates that
   * IS-DISTINCT-FROM predicate against the row's actual, already-parked
   * state — a mock cannot honestly arbitrate whether the second call's
   * WHERE clause matches zero rows.
   *
   * codex #4293 P1 (this round): pass 2 here also exercises the sibling fix
   * to the finding above — an already-'review' row whose receipt scope-
   * changes AGAIN now reports reconcileAttempt's done: false, so runOne
   * reaches contextFor's own fresh read this same pass instead of returning
   * immediately (see reconcileAttempt's delivered/read branch).
   */
  test('a delivered receipt clears uncertainty even when it reconfirms the SAME already-parked scope-change reason (codex #4293 P1)', async () => {
    const priorGate = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE;
    const priorCallCommitments = gates.callCommitments;
    try {
      process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = 'true';
      gates.callCommitments = true;

      const callId = randomUUID();
      const customerId = randomUUID();
      const visitId = randomUUID();
      const phone = '+15555550100';
      const twilioSid = `SM${randomUUID().replaceAll('-', '').slice(0, 32)}`;
      await mockPg('customers').insert({ id: customerId, first_name: 'Pat', last_name: 'Customer', phone,
        address_line1: '1 Example St', city: 'Bradenton', zip: '34205' });
      await mockPg('scheduled_services').insert({ id: visitId, customer_id: customerId, scheduled_date: '2030-01-08', service_type: 'WaveGuard' });
      // Reprocessing has already bumped the call (and the commitment's
      // last_seen_generation right along with it) to generation 2 — exactly
      // like the superseded-generation test above — BEFORE this generation-1
      // attempt's own carrier receipts arrive at all.
      await mockPg('call_log').insert({ id: callId, customer_id: customerId, direction: 'inbound', from_phone: phone, processing_generation: 2 });
      const [commitment] = await mockPg('call_commitments').insert({
        call_log_id: callId, commitment_key: 'send_reschedule_link:1', party: 'waves', kind: 'send_reschedule_link',
        description: 'send a reschedule link', source: 'ai', status: 'open', last_seen_generation: 2, processing_generation: 2,
      }).returning('id');
      const outboxId = randomUUID();
      await mockPg('outbox_messages').insert({ id: outboxId, channel: 'sms', status: 'sending', provider_message_id: twilioSid,
        sent_at: new Date(), payload: { call_generation: 1, delivery_outcome_uncertain: true },
        commitment_id: commitment.id, commitment_generation: 1,
        related_call_log_id: callId, related_customer_id: customerId, related_scheduled_service_id: visitId });
      // Pass 1: the carrier has only accepted the message so far — 'sent',
      // not yet definitive proof either way.
      await mockPg('sms_log').insert({ id: randomUUID(), customer_id: customerId, direction: 'outbound',
        from_phone: '+15555550199', to_phone: phone, twilio_sid: twilioSid, status: 'sent', message_body: 'Your reschedule link: https://example.com/x' });

      const row1 = await mockPg('outbox_messages').where({ id: outboxId }).first();
      await links.runOne(mockPg, row1, { now: new Date() });

      const afterScopeChange = await mockPg('outbox_messages').where({ id: outboxId }).first();
      // Parked for the scope change, exactly like the superseded-generation
      // case — but NOT yet definitive, so the flag correctly stays true.
      expect(afterScopeChange.status).toBe('review');
      expect(afterScopeChange.last_error).toBe('delivery_scope_changed');
      expect(afterScopeChange.payload.delivery_outcome_uncertain).toBe(true);

      // Pass 2: the SAME message's carrier receipt now confirms delivery —
      // definitive evidence — and the row is already parked for the exact
      // scope-change reason this second pass's own settleDelivery call will
      // conclude too (still an identity mismatch: the generation gap never
      // closes). Unlike pass 1 — a FRESH transition into 'review', which
      // reconcileAttempt still defers to next pass exactly like the sibling
      // delivery_failed branch — a row that was ALREADY 'review' before this
      // call runs is precisely the case this round's fix stops
      // short-circuiting: runOne now continues on to contextFor's own fresh
      // read this SAME pass (codex #4293 P1, this round), which is what
      // lets a later office dismissal or hand-fulfilment close this card
      // instead of never revisiting it. Reaching contextFor at all this
      // pass is new; recomputing 'call_not_ready' off it is incidental to
      // THIS minimal fixture (no v2_extraction_status on call_log) — see the
      // parallel 'freshly recomputed' stale_extraction case above.
      await mockPg('sms_log').where({ twilio_sid: twilioSid }).update({ status: 'delivered' });
      const row2 = await mockPg('outbox_messages').where({ id: outboxId }).first();
      await links.runOne(mockPg, row2, { now: new Date() });

      const after = await mockPg('outbox_messages').where({ id: outboxId }).first();
      expect(after.status).toBe('review');
      expect(after.last_error).toBe('call_not_ready');
      // But the flag must retire regardless: the second receipt is
      // definitive provider evidence for THIS attempt, independent of
      // whether parkReview itself found anything to change.
      expect(after.payload.delivery_outcome_uncertain).toBe(false);

      // The commitment itself stays untouched — this is a superseded
      // generation, never fulfilled by this attempt's evidence.
      const afterCommitment = await mockPg('call_commitments').where({ id: commitment.id }).first();
      expect(afterCommitment.status).toBe('open');
      expect(afterCommitment.fulfilled_at).toBeNull();

      // With the flag finally cleared, generation 2's own replacement send
      // is no longer blocked behind an attempt whose outcome is, in fact,
      // known.
      const staged = await links.stagePromises(mockPg);
      expect(staged).toBe(1);
      const rows2 = await mockPg('outbox_messages').where({ commitment_id: commitment.id }).orderBy('commitment_generation');
      expect(rows2).toHaveLength(2);
      expect(rows2[1]).toMatchObject({ commitment_generation: 2, status: 'pending' });
    } finally {
      if (priorGate === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = priorGate;
      gates.callCommitments = priorCallCommitments;
    }
  });

  /**
   * codex #4293 P1 (pre-push audit on PR #4293, this round): the finding
   * this whole file's newest tests protect against, played all the way
   * through to the office-facing symptom. Before this round's fix,
   * reconcileAttempt's delivered/read branch reported "handled" (its old
   * unconditional true) on EVERY pass a scope-changed row's sms stayed
   * delivered/read — which is forever, since a real carrier receipt never
   * changes status again. runOne therefore returned immediately every
   * single sweep and never reached contextFor's own promise_closed check,
   * so a card raised for a stale generation's scope-changed receipt could
   * never close, even once staff dismissed or hand-fulfilled the
   * commitment on the ledger. This test fails without the fix: `after`
   * would still show status 'review' / last_error 'delivery_scope_changed'
   * and the card would still be 'open'.
   */
  test('a delivered receipt for a superseded generation parks scope-changed, then closing the commitment through the ledger lets the next sweep clear its card without resending (codex #4293 P1)', async () => {
    const priorGate = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE;
    const priorCallCommitments = gates.callCommitments;
    try {
      process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = 'true';
      gates.callCommitments = true;

      const callId = randomUUID();
      const customerId = randomUUID();
      const visitId = randomUUID();
      const phone = '+15555550100';
      const twilioSid = `SM${randomUUID().replaceAll('-', '').slice(0, 32)}`;
      await mockPg('customers').insert({ id: customerId, first_name: 'Pat', last_name: 'Customer', phone,
        address_line1: '1 Example St', city: 'Bradenton', zip: '34205' });
      await mockPg('scheduled_services').insert({ id: visitId, customer_id: customerId, scheduled_date: '2030-01-08', service_type: 'WaveGuard' });
      // A replacement recording already reopened this commitment under
      // generation 2 — exactly like the superseded-generation test above —
      // BEFORE generation 1's own carrier receipt ever arrives, and the
      // office has not yet acted on either generation.
      await mockPg('call_log').insert({ id: callId, customer_id: customerId, direction: 'inbound', from_phone: phone, processing_generation: 2 });
      const [commitment] = await mockPg('call_commitments').insert({
        call_log_id: callId, commitment_key: 'send_reschedule_link:1', party: 'waves', kind: 'send_reschedule_link',
        description: 'send a reschedule link', source: 'ai', status: 'open', human_state: null,
        last_seen_generation: 2, processing_generation: 2,
      }).returning('id');
      const outboxId = randomUUID();
      // This exact attempt was claimed and sent under generation 1 — still
      // 'sending' (no receipt yet), the window stagePromises must not stage
      // a duplicate generation into.
      await mockPg('outbox_messages').insert({ id: outboxId, channel: 'sms', status: 'sending', provider_message_id: twilioSid,
        sent_at: new Date(), payload: { call_generation: 1, delivery_outcome_uncertain: true },
        commitment_id: commitment.id, commitment_generation: 1,
        related_call_log_id: callId, related_customer_id: customerId, related_scheduled_service_id: visitId });
      // The provider's own definitive record: this generation-1 attempt
      // really was delivered.
      await mockPg('sms_log').insert({ id: randomUUID(), customer_id: customerId, direction: 'outbound',
        from_phone: '+15555550199', to_phone: phone, twilio_sid: twilioSid, status: 'delivered', message_body: 'Your reschedule link: https://example.com/x' });

      // A `send` stand-in that throws if ever invoked — neither pass below
      // may reach dispatch() at all: this row already carries a claimed
      // provider_message_id, so reconcileAttempt owns it on every pass, and
      // holdBeforeSend's own 'review' gate refuses a fresh send once parked.
      const mustNotSend = async () => { throw new Error('must not attempt a fresh send off an already-claimed, scope-changed row'); };

      // Sweep 1: the identity check refuses this receipt (generation 1 no
      // longer matches the commitment's current generation 2) and parks it
      // for the office — a FRESH transition, deferred one pass exactly like
      // the sibling delivery_failed branch, so this same sweep does not yet
      // reach contextFor.
      const row1 = await mockPg('outbox_messages').where({ id: outboxId }).first();
      await links.runOne(mockPg, row1, { now: new Date(), send: mustNotSend });

      const afterScopeChange = await mockPg('outbox_messages').where({ id: outboxId }).first();
      expect(afterScopeChange.status).toBe('review');
      expect(afterScopeChange.last_error).toBe('delivery_scope_changed');
      expect(afterScopeChange.payload.delivery_outcome_uncertain).toBe(false);
      const cardAfterPark = await mockPg('triage_items').where({ call_log_id: callId, reason_code: 'reschedule_link_promise' }).first();
      expect(cardAfterPark.status).toBe('open');

      // Between sweeps, staff dismiss the promise on the commitment ledger —
      // an office verdict contextFor reads straight off the commitment row
      // as 'promise_closed', independent of any generation bookkeeping.
      await mockPg('call_commitments').where({ id: commitment.id }).update({ human_state: 'dismissed' });

      // Sweep 2 ("the next sweep"): the SAME delivered receipt scope-changes
      // again — this row was ALREADY 'review' when this pass began, so
      // reconcileAttempt now reports done: false (the fix under test) and
      // runOne reaches contextFor's own fresh read this same pass, which
      // finds the commitment closed and hands off to applyContextSkip's
      // promise_closed cleanup.
      const row2 = await mockPg('outbox_messages').where({ id: outboxId }).first();
      await links.runOne(mockPg, row2, { now: new Date(), send: mustNotSend });

      const after = await mockPg('outbox_messages').where({ id: outboxId }).first();
      // Cancelled, not re-parked and not re-sent.
      expect(after.status).toBe('cancelled');
      expect(after.payload.delivery_outcome_uncertain).toBe(false);
      const cardAfterClose = await mockPg('triage_items').where({ call_log_id: callId, reason_code: 'reschedule_link_promise' }).first();
      expect(cardAfterClose.status).toBe('resolved');

      // The dismissal itself is untouched by any of this — applyContextSkip
      // reads the verdict, it never writes one.
      const afterCommitment = await mockPg('call_commitments').where({ id: commitment.id }).first();
      expect(afterCommitment.human_state).toBe('dismissed');
      expect(afterCommitment.fulfilled_at).toBeNull();
    } finally {
      if (priorGate === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = priorGate;
      gates.callCommitments = priorCallCommitments;
    }
  });

  /**
   * codex #4293 P1 (pre-push audit on PR #4293): clearDeliveryUncertainInReview
   * takes no transaction and no lock, and (pre-fix) replaced `payload` from
   * `row` — the caller's own pre-lock snapshot — instead of merging at the
   * database level. A concurrent markLinkUsed (the customer using this same
   * row's link) stamping link_used_reconciled_at DURING this function's own
   * sms_log lookup landed first, and the later blind replace erased that
   * stamp, leaving the promise silently un-reconciled for a later sweep to
   * re-park. Only a real Postgres race — two independently-timed writers on
   * the same jsonb column — demonstrates the lost update a mock cannot.
   */
  test('a concurrent markLinkUsed stamp survives clearDeliveryUncertainInReview\'s own payload write (codex #4293 P1)', async () => {
    const priorGate = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE;
    const priorCallCommitments = gates.callCommitments;
    try {
      process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = 'true';
      gates.callCommitments = true;

      const callId = randomUUID();
      const customerId = randomUUID();
      const visitId = randomUUID();
      const twilioSid = `SM${randomUUID().replaceAll('-', '').slice(0, 32)}`;
      await mockPg('call_log').insert({ id: callId, direction: 'inbound', processing_generation: 1 });
      const [commitment] = await mockPg('call_commitments').insert({
        call_log_id: callId, commitment_key: 'send_reschedule_link:1', party: 'waves', kind: 'send_reschedule_link',
        description: 'send a reschedule link', source: 'ai', status: 'open', last_seen_generation: 1, processing_generation: 1,
      }).returning('id');
      const outboxId = randomUUID();
      // Already parked for an unrelated reason (a missing carrier receipt on
      // an earlier pass) — the shape reconcileAttempt's `else if (failed)`
      // branch (clearDeliveryUncertainInReview) exists for.
      await mockPg('outbox_messages').insert({ id: outboxId, channel: 'sms', status: 'review', last_error: 'provider_outcome_unknown',
        provider_message_id: twilioSid, sent_at: new Date(), payload: { delivery_outcome_uncertain: true },
        commitment_id: commitment.id, commitment_generation: 1,
        related_call_log_id: callId, related_customer_id: customerId, related_scheduled_service_id: visitId });
      // A LATE definitive failure receipt arrives for this same attempt.
      await mockPg('sms_log').insert({ id: randomUUID(), customer_id: customerId, direction: 'outbound',
        from_phone: '+15555550100', to_phone: '+15555550199', twilio_sid: twilioSid, status: 'failed', message_body: 'reschedule link' });

      const row = await mockPg('outbox_messages').where({ id: outboxId }).first();

      // Delaying reconcileAttempt's own sms_log lookup — the exact
      // multi-round-trip gap between runOne's fresh row read and
      // clearDeliveryUncertainInReview's eventual UPDATE — guarantees the
      // concurrent markLinkUsed below (on the real, undelayed connection)
      // commits its stamp first, every time.
      const slowConn = delayTable(mockPg, 'sms_log', 300);

      await Promise.all([
        links.runOne(slowConn, row, { now: new Date() }),
        links.markLinkUsed(mockPg, row),
      ]);

      const after = await mockPg('outbox_messages').where({ id: outboxId }).first();
      // markLinkUsed's stamp must survive the later, unrelated payload write.
      expect(after.payload.link_used_reconciled_at).toBeTruthy();
      // clearDeliveryUncertainInReview's own write must still have landed —
      // this is a merge, not a race one writer wins outright.
      expect(after.payload.delivery_outcome_uncertain).toBe(false);
      // The row's status/last_error are exactly as clearDeliveryUncertainInReview
      // leaves them — untouched, still whatever context error parked it.
      expect(after.status).toBe('review');
      expect(after.last_error).toBe('provider_outcome_unknown');
    } finally {
      if (priorGate === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = priorGate;
      gates.callCommitments = priorCallCommitments;
    }
  });

  /**
   * codex #4293 P1, follow-up round on 189f53d7a: claimForDispatch marks
   * EVERY freshly-claimed attempt delivery_outcome_uncertain the instant it
   * claims the row — correctly so, since from that instant the process could
   * die before ever reaching Twilio. But the interlock-busy and quiet-hours
   * retry branches returned the row to 'pending' WITHOUT clearing that flag,
   * even though both fire strictly before dispatchToProvider ever runs (the
   * interlock rejects before sendCore is invoked at all; quiet hours/gate-off
   * are preDispatchCheck, which runs before the step-7 dispatch call) — no
   * request ever reached the provider, so there was nothing left uncertain.
   * A prior round deliberately left these two branches alone as "fail-safe
   * conservative"; Codex has since shown the flag then blocks stagePromises
   * from ever staging a replacement generation, which is an indefinite block,
   * not caution. Only a real dispatch()->claimForDispatch()->send() pass
   * against genuine Postgres rows proves the fix's UPDATE actually clears the
   * flag in the write that returns the row to pending, and that a REAL
   * reprocess-driven generation bump then lets stagePromises through.
   */
  describe('a send that never reached the provider retires delivery uncertainty in the same write that returns the row to pending (codex #4293 P1, follow-up round)', () => {
    const quote = 'I will text you a reschedule link for that appointment.';
    const promiseNow = new Date('2030-01-07T14:00:00Z'); // 9:00 AM ET — inside the send window

    // Full context: a real customer, a matched inbound call carrying the
    // agent's promise quote, and one self-service-eligible future visit —
    // exactly what contextFor's own candidates query and selectDiscussedVisit
    // need to resolve a clean context with no `reason`, so runOne actually
    // reaches dispatch() instead of short-circuiting on an earlier guard.
    async function seedClaimableRow() {
      const callId = randomUUID();
      const customerId = randomUUID();
      const visitId = randomUUID();
      const phone = '+15555550100';
      await mockPg('customers').insert({ id: customerId, first_name: 'Pat', last_name: 'Customer', phone,
        address_line1: '1 Example St', city: 'Bradenton', zip: '34205', active: true });
      await mockPg('scheduled_services').insert({ id: visitId, customer_id: customerId, scheduled_date: '2030-01-08',
        window_start: '09:00', window_end: '10:30', service_type: 'WaveGuard', status: 'confirmed', reschedule_token: 'token' });
      await mockPg('call_log').insert({ id: callId, customer_id: customerId, direction: 'inbound', from_phone: phone,
        v2_extraction_status: 'valid', processing_generation: 0, transcription: `Agent: ${quote}\nCaller: Thank you.` });
      const [commitment] = await mockPg('call_commitments').insert({
        call_log_id: callId, commitment_key: 'send_reschedule_link:1', party: 'waves', kind: 'send_reschedule_link',
        description: 'send a reschedule link', source: 'ai', status: 'open', confidence: 0.95,
        evidence: JSON.stringify([{ quote, speaker: 'agent' }]), last_seen_generation: 0, processing_generation: 0,
      }).returning('id');
      const outboxId = randomUUID();
      // Never claimed yet — the row stagePromises itself would have inserted.
      await mockPg('outbox_messages').insert({ id: outboxId, channel: 'sms', status: 'pending', payload: {},
        commitment_id: commitment.id, commitment_generation: 0,
        related_call_log_id: callId, related_customer_id: customerId, related_scheduled_service_id: visitId });
      return { commitment, row: await mockPg('outbox_messages').where({ id: outboxId }).first() };
    }

    // A stand-in send() that never invokes preDispatchCheck/preProviderCheck
    // at all — this test targets dispatch()'s own handling of the RESULT
    // send-customer-message hands back (which code path it takes for a given
    // `code`, and whether it clears the flag), not how check() itself would
    // have arrived at that result — check()'s own preDispatchCheck/
    // preProviderCheck wiring is exercised structurally by reading
    // send-customer-message.js and twilio-sms.js (see the block comment on
    // dispatch()'s blocked-branch handling); reproducing it here would need
    // short_codes/customer_properties join fixtures this suite does not
    // otherwise carry, for no additional coverage of the fix under test.
    const blockedSend = (code) => async () => ({ sent: false, blocked: true, code, retryable: true });
    const stubBuildLink = async () => ({ url: 'https://example.com/reschedule/token' });
    const stubRender = async () => 'Your reschedule link: https://example.com/reschedule/token';

    test.each([
      ['LINK_LOCK_BUSY', 'the interlock (withSendLock, before sendCore is ever invoked)'],
      ['LINK_QUIET_HOURS', "check()'s own preDispatchCheck, ahead of dispatchToProvider"],
      ['QUIET_HOURS_HOLD', 'the provider-handoff boundary recheck'],
      ['LINK_GATE_OFF', 'check()\'s own preDispatchCheck, ahead of dispatchToProvider'],
    ])('%s (%s) clears the flag in the same UPDATE that returns the row to pending, and a later generation bump can then stage', async (code) => {
      const priorGate = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE;
      const priorCallCommitments = gates.callCommitments;
      try {
        process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = 'true';
        gates.callCommitments = true;

        const { commitment, row } = await seedClaimableRow();
        await links.runOne(mockPg, row, { now: promiseNow, send: blockedSend(code), buildLink: stubBuildLink, render: stubRender });

        const afterBlock = await mockPg('outbox_messages').where({ id: row.id }).first();
        // The claim itself (claimForDispatch) really did run and set the flag
        // — this assertion would trivially pass on a row that was never
        // claimed at all, so proving the retry status confirms the claim
        // happened before asserting the flag is gone.
        expect(afterBlock.status).toBe('pending');
        expect(afterBlock.last_error).toBe(code);
        expect(afterBlock.payload.delivery_outcome_uncertain).toBe(false);

        // upsertCommitments would bump processing_generation on a real
        // reprocess; simulate that here without touching call_log — the
        // NOT EXISTS predicates in stagePromises only ever compare against
        // the COMMITMENT's own processing_generation.
        await mockPg('call_commitments').where({ id: commitment.id }).update({ processing_generation: 1 });

        // With delivery uncertainty correctly cleared, the replacement
        // generation is no longer blocked behind an attempt that in fact
        // never reached the provider at all.
        const staged = await links.stagePromises(mockPg);
        expect(staged).toBe(1);
        const rows = await mockPg('outbox_messages').where({ commitment_id: commitment.id }).orderBy('commitment_generation');
        expect(rows).toHaveLength(2);
        expect(rows[1]).toMatchObject({ commitment_generation: 1, status: 'pending' });
      } finally {
        if (priorGate === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = priorGate;
        gates.callCommitments = priorCallCommitments;
      }
    });

    test('a blocked code outside the retry allowlist (e.g. a changed source visit) still clears the flag via its own retireDeliveryUncertainty write before parkReview', async () => {
      // Not every blocked refusal is a short retry — LINK_SOURCE_CHANGED and
      // the other shared send-customer-message pipeline guards park the row
      // for the office (parkReview -> 'review') instead of retrying it. That
      // write only ever touches status/last_error (deliberately — threading
      // a clear through parkReview's own reason-unchanged no-op guard is
      // exactly what stranded this flag before), so the clear has to land as
      // its own independent write, the same shape reconcileAttempt's
      // delivery_failed branch already uses.
      const priorGate = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE;
      const priorCallCommitments = gates.callCommitments;
      try {
        process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = 'true';
        gates.callCommitments = true;

        const { commitment, row } = await seedClaimableRow();
        await links.runOne(mockPg, row, { now: promiseNow, send: blockedSend('LINK_SOURCE_CHANGED'), buildLink: stubBuildLink, render: stubRender });

        const afterBlock = await mockPg('outbox_messages').where({ id: row.id }).first();
        expect(afterBlock.status).toBe('review');
        expect(afterBlock.last_error).toBe('LINK_SOURCE_CHANGED');
        expect(afterBlock.payload.delivery_outcome_uncertain).toBe(false);

        await mockPg('call_commitments').where({ id: commitment.id }).update({ processing_generation: 1 });
        const staged = await links.stagePromises(mockPg);
        expect(staged).toBe(1);
      } finally {
        if (priorGate === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = priorGate;
        gates.callCommitments = priorCallCommitments;
      }
    });

    test('a genuinely ambiguous outcome (the provider was actually asked, or the SDK never confirmed) leaves the flag set', async () => {
      // The one shape that must NOT clear: `blocked` is not set at all —
      // either Twilio genuinely answered (result.success === false) or the
      // request threw crossing the SDK boundary. Both keep the row
      // conservatively uncertain, exactly as before this fix.
      const priorGate = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE;
      const priorCallCommitments = gates.callCommitments;
      try {
        process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = 'true';
        gates.callCommitments = true;

        const { commitment, row } = await seedClaimableRow();
        const ambiguousSend = async () => ({ sent: false, success: false, error: 'twilio rejected the number' });
        await links.runOne(mockPg, row, { now: promiseNow, send: ambiguousSend, buildLink: stubBuildLink, render: stubRender });

        const afterBlock = await mockPg('outbox_messages').where({ id: row.id }).first();
        expect(afterBlock.status).toBe('review');
        expect(afterBlock.payload.delivery_outcome_uncertain).toBe(true);

        // The still-uncertain older attempt correctly keeps blocking a fresh
        // generation from staging — the flag doing exactly the job it exists
        // for when the outcome really is unknown.
        await mockPg('call_commitments').where({ id: commitment.id }).update({ processing_generation: 1 });
        const staged = await links.stagePromises(mockPg);
        expect(staged).toBe(0);
      } finally {
        if (priorGate === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = priorGate;
        gates.callCommitments = priorCallCommitments;
      }
    });

    /**
     * codex #4293 P1, follow-up round on 7d0a11381: `blocked: false` with an
     * explicit `deliveryOutcome: 'not_sent'` is a THIRD shape carrying the
     * exact same certainty as the two already-handled cases above (a
     * definitive Twilio rejection surfacing through the non-blocked
     * provider-failure path, or a disabled template) — `blocked` alone can
     * never see it, so the flag was stranding a fourth time on proof that
     * nothing was sent. classifyDeliveryCertainty (send-customer-message.js)
     * reads deliveryOutcome directly instead of `blocked`, so this clears
     * the same way the blocked branches above do.
     */
    test('blocked: false with deliveryOutcome: not_sent clears the flag, and a later generation can stage', async () => {
      const priorGate = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE;
      const priorCallCommitments = gates.callCommitments;
      try {
        process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = 'true';
        gates.callCommitments = true;

        const { commitment, row } = await seedClaimableRow();
        // Not a thrown error and not `blocked: true` — the exact shape a
        // disabled template or a definitive non-blocked provider rejection
        // returns from send-customer-message.
        const notSentSend = async () => ({ sent: false, blocked: false, deliveryOutcome: 'not_sent', code: 'PROVIDER_FAILURE', error: 'template disabled' });
        await links.runOne(mockPg, row, { now: promiseNow, send: notSentSend, buildLink: stubBuildLink, render: stubRender });

        const afterBlock = await mockPg('outbox_messages').where({ id: row.id }).first();
        expect(afterBlock.status).toBe('review');
        expect(afterBlock.last_error).toBe('PROVIDER_FAILURE');
        expect(afterBlock.payload.delivery_outcome_uncertain).toBe(false);

        await mockPg('call_commitments').where({ id: commitment.id }).update({ processing_generation: 1 });
        const staged = await links.stagePromises(mockPg);
        expect(staged).toBe(1);
        const rows = await mockPg('outbox_messages').where({ commitment_id: commitment.id }).orderBy('commitment_generation');
        expect(rows).toHaveLength(2);
        expect(rows[1]).toMatchObject({ commitment_generation: 1, status: 'pending' });
      } finally {
        if (priorGate === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = priorGate;
        gates.callCommitments = priorCallCommitments;
      }
    });

    /**
     * The same 'not_sent' certainty can also arrive on a THROWN error's own
     * `.providerOutcome` — sendCustomerMessageCore tags every throw (e.g. a
     * downstream persistAudit failure) with the provider outcome it had
     * already observed. dispatch()'s catch block must read that the same
     * way it reads a normal return, not treat every throw as unknown.
     */
    test("deliveryOutcome: not_sent arriving via a thrown error's err.providerOutcome also clears the flag", async () => {
      const priorGate = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE;
      const priorCallCommitments = gates.callCommitments;
      try {
        process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = 'true';
        gates.callCommitments = true;

        const { commitment, row } = await seedClaimableRow();
        const thrownNotSentSend = async () => {
          const err = new Error('audit persist failed after a definitive provider rejection');
          err.providerOutcome = { sent: false, deliveryOutcome: 'not_sent', code: 'PROVIDER_FAILURE' };
          throw err;
        };
        await links.runOne(mockPg, row, { now: promiseNow, send: thrownNotSentSend, buildLink: stubBuildLink, render: stubRender });

        const afterBlock = await mockPg('outbox_messages').where({ id: row.id }).first();
        expect(afterBlock.status).toBe('review');
        expect(afterBlock.last_error).toBe('provider_outcome_unknown');
        expect(afterBlock.payload.delivery_outcome_uncertain).toBe(false);

        await mockPg('call_commitments').where({ id: commitment.id }).update({ processing_generation: 1 });
        const staged = await links.stagePromises(mockPg);
        expect(staged).toBe(1);
      } finally {
        if (priorGate === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = priorGate;
        gates.callCommitments = priorCallCommitments;
      }
    });

    /**
     * The genuinely unknown counterpart to the two tests above: a thrown SDK
     * error carrying NO providerOutcome at all (this pipeline has no known
     * fact to vouch for) must still leave the flag set — classifyDeliveryCertainty
     * must not read a throw as proof of anything by itself.
     */
    test('a thrown error with no providerOutcome at all leaves the flag set', async () => {
      const priorGate = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE;
      const priorCallCommitments = gates.callCommitments;
      try {
        process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = 'true';
        gates.callCommitments = true;

        const { commitment, row } = await seedClaimableRow();
        const thrownUnknownSend = async () => { throw new Error('ECONNRESET'); };
        await links.runOne(mockPg, row, { now: promiseNow, send: thrownUnknownSend, buildLink: stubBuildLink, render: stubRender });

        const afterBlock = await mockPg('outbox_messages').where({ id: row.id }).first();
        expect(afterBlock.status).toBe('review');
        expect(afterBlock.payload.delivery_outcome_uncertain).toBe(true);

        await mockPg('call_commitments').where({ id: commitment.id }).update({ processing_generation: 1 });
        const staged = await links.stagePromises(mockPg);
        expect(staged).toBe(0);
      } finally {
        if (priorGate === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = priorGate;
        gates.callCommitments = priorCallCommitments;
      }
    });
  });

  /**
   * codex #4293 P1 (pre-push audit on PR #4293, reschedule-link-promises.js:914):
   * an office Reopen on the commitment ledger restores status 'open' and
   * human_state 'confirmed' but — pre-fix — left processing_generation
   * untouched. upsertCommitments' own ON CONFLICT freezes that column the
   * moment ANY human_state is set (`CASE WHEN human_state IS NULL...`), so a
   * re-extraction of the same call can never bump it either: the cancelled
   * outbox row from the dismissed attempt sits at the SAME generation
   * stagePromises' own NOT EXISTS predicate reads, and the reopened promise
   * is excluded from every future sweep forever — the office's explicit
   * verdict is silently inert. Only real Postgres row state (a genuine
   * CHECK-constrained call_commitments row, a genuine partial-unique-index
   * outbox insert) proves the fix's generation bump actually re-admits
   * staging and that the delivery-dedup / stale-evidence decisions hold
   * under the exact predicates stagePromises and applyHumanUpdate use.
   */
  describe('an office Reopen renews the promise\'s own generation (codex #4293 P1)', () => {
    const quote = 'I will text you a reschedule link for that appointment.';
    const promiseNow = new Date('2030-01-07T14:00:00Z'); // 9:00 AM ET — inside the send window
    const stubBuildLink = async () => ({ url: 'https://example.com/reschedule/token' });
    const stubRender = async () => 'Your reschedule link: https://example.com/reschedule/token';

    test('dismissed promise -> staff Reopen -> the next sweep stages and sends a fresh attempt', async () => {
      const priorGate = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE;
      const priorCallCommitments = gates.callCommitments;
      const priorActivatedAt = process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT;
      try {
        process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = 'true';
        gates.callCommitments = true;
        // stagePromises stamps the FRESH row's payload with the commitment's
        // own created_at (unlike this test's hand-inserted first row, whose
        // payload starts `{}`) — the very first thing runOne checks on it is
        // isPreActivationRow, and this test's commitment is created well
        // after the gate goes live, not before it. Fixing the boundary in
        // the past is what every other test in this file with a live
        // dispatch pass avoids needing by never round-tripping a
        // stagePromises-produced row back through runOne — this one does,
        // to prove the renewed generation actually reaches a real send.
        process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT = '2000-01-01T00:00:00Z';

        const callId = randomUUID();
        const customerId = randomUUID();
        const visitId = randomUUID();
        const phone = '+15555550100';
        await mockPg('customers').insert({ id: customerId, first_name: 'Pat', last_name: 'Customer', phone,
          address_line1: '1 Example St', city: 'Bradenton', zip: '34205', active: true });
        await mockPg('scheduled_services').insert({ id: visitId, customer_id: customerId, scheduled_date: '2030-01-08',
          window_start: '09:00', window_end: '10:30', service_type: 'WaveGuard', status: 'confirmed', reschedule_token: 'token' });
        await mockPg('call_log').insert({ id: callId, customer_id: customerId, direction: 'inbound', from_phone: phone,
          v2_extraction_status: 'valid', processing_generation: 0, transcription: `Agent: ${quote}\nCaller: Thank you.` });
        const [commitment] = await mockPg('call_commitments').insert({
          call_log_id: callId, commitment_key: 'send_reschedule_link:1', party: 'waves', kind: 'send_reschedule_link',
          description: 'send a reschedule link', source: 'ai', status: 'open', confidence: 0.95,
          evidence: JSON.stringify([{ quote, speaker: 'agent' }]), last_seen_generation: 0, processing_generation: 0,
        }).returning('id');
        const outboxId = randomUUID();
        // Never claimed yet — exactly what stagePromises itself would have
        // inserted before the office ever touched the ledger.
        await mockPg('outbox_messages').insert({ id: outboxId, channel: 'sms', status: 'pending', payload: {},
          commitment_id: commitment.id, commitment_generation: 0,
          related_call_log_id: callId, related_customer_id: customerId, related_scheduled_service_id: visitId });

        // Staff dismiss on the ledger.
        await mockPg('call_commitments').where({ id: commitment.id }).update({ status: 'dismissed', human_state: 'dismissed' });
        // The next sweep notices — applyContextSkip's promise_closed branch
        // cancels the now-orphaned outbox row (the exact "its outbox row
        // becomes cancelled" step the finding names).
        const beforeReopenRow = await mockPg('outbox_messages').where({ id: outboxId }).first();
        await links.runOne(mockPg, beforeReopenRow, { now: promiseNow });
        const cancelled = await mockPg('outbox_messages').where({ id: outboxId }).first();
        expect(cancelled.status).toBe('cancelled');

        // Staff Reopen.
        const reopened = await applyHumanUpdate(mockPg, commitment.id, { action: 'reopen', reviewedBy: randomUUID() });
        expect(reopened.status).toBe('open');
        expect(reopened.human_state).toBe('confirmed');
        // The fix under test: a fresh generation, so stagePromises' own NOT
        // EXISTS predicate no longer finds the cancelled row "at or past"
        // this commitment's current generation.
        expect(Number(reopened.processing_generation)).toBe(1);

        const staged = await links.stagePromises(mockPg);
        expect(staged).toBe(1);
        const rows = await mockPg('outbox_messages').where({ commitment_id: commitment.id }).orderBy('commitment_generation');
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({ commitment_generation: 0, status: 'cancelled' });
        expect(rows[1]).toMatchObject({ commitment_generation: 1, status: 'pending' });

        // The next sweep actually sends the renewed attempt.
        const fakeSid = `SM${'0'.repeat(32)}`;
        const successfulSend = async () => ({ sent: true, providerMessageId: fakeSid });
        await links.runOne(mockPg, rows[1], { now: promiseNow, send: successfulSend, buildLink: stubBuildLink, render: stubRender });
        const sent = await mockPg('outbox_messages').where({ id: rows[1].id }).first();
        expect(sent.status).toBe('sent');
        expect(sent.provider_message_id).toBe(fakeSid);
      } finally {
        if (priorGate === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = priorGate;
        if (priorActivatedAt === undefined) delete process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT; else process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT = priorActivatedAt;
        gates.callCommitments = priorCallCommitments;
      }
    });

    test('reopen after a genuinely delivered attempt restores fulfilled instead of re-texting (dedup decision: delivery is not undone by a dismiss)', async () => {
      const priorGate = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE;
      const priorCallCommitments = gates.callCommitments;
      try {
        process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = 'true';
        gates.callCommitments = true;

        const callId = randomUUID();
        await mockPg('call_log').insert({ id: callId, direction: 'inbound', processing_generation: 0 });
        const [commitment] = await mockPg('call_commitments').insert({
          call_log_id: callId, commitment_key: 'send_reschedule_link:1', party: 'waves', kind: 'send_reschedule_link',
          description: 'send a reschedule link', source: 'ai', status: 'fulfilled', last_seen_generation: 0, processing_generation: 0,
          fulfilled_at: new Date('2030-01-01T14:05:00Z'),
          fulfillment: JSON.stringify({ kind: 'reschedule_link_delivered', strength: 'direct', record_type: 'sms_log', record_id: randomUUID(),
            matched_at: new Date('2030-01-01T14:05:00Z').toISOString(), basis: 'linked_visit_reschedule_link_delivered' }),
        }).returning('id');
        const outboxId = randomUUID();
        const twilioSid = `SM${randomUUID().replaceAll('-', '').slice(0, 32)}`;
        // The attempt that actually reached the customer — the provider's own
        // definitive, terminal record.
        await mockPg('outbox_messages').insert({ id: outboxId, channel: 'sms', status: 'delivered', provider_message_id: twilioSid,
          sent_at: new Date('2030-01-01T14:00:00Z'), payload: { call_generation: 0, delivery_outcome_uncertain: false },
          commitment_id: commitment.id, commitment_generation: 0, related_call_log_id: callId });

        // Office mistakenly dismisses the already-kept promise off the
        // ledger — the generic dismiss patch (call-commitments.js) never
        // touches fulfilled_at/fulfillment, only status/human_state.
        await mockPg('call_commitments').where({ id: commitment.id }).update({ status: 'dismissed', human_state: 'dismissed' });

        const reopened = await applyHumanUpdate(mockPg, commitment.id, { action: 'reopen', reviewedBy: randomUUID() });
        // A delivery is not undone by an office dismiss: Reopen surfaces
        // that fact — restoring 'fulfilled' — rather than reopening the
        // promise for a duplicate text.
        expect(reopened.status).toBe('fulfilled');
        expect(reopened.fulfillment).toMatchObject({ record_id: outboxId, basis: 'reopen_found_prior_delivery' });
        // No fresh generation is ever admitted — nothing left for a future
        // sweep to (re)send.
        expect(Number(reopened.processing_generation)).toBe(0);

        const staged = await links.stagePromises(mockPg);
        expect(staged).toBe(0);
        const rows = await mockPg('outbox_messages').where({ commitment_id: commitment.id });
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(outboxId);
      } finally {
        if (priorGate === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = priorGate;
        gates.callCommitments = priorCallCommitments;
      }
    });

    test('reopen after an attempt that only reached "sent" (no delivery confirmation) renews the generation instead of trusting ambiguous evidence as proof', async () => {
      const priorGate = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE;
      const priorCallCommitments = gates.callCommitments;
      try {
        process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = 'true';
        gates.callCommitments = true;

        const callId = randomUUID();
        const customerId = randomUUID();
        await mockPg('customers').insert({ id: customerId, first_name: 'Pat', last_name: 'Customer', phone: '+15555550100',
          address_line1: '1 Example St', city: 'Bradenton', zip: '34205', active: true });
        await mockPg('call_log').insert({ id: callId, customer_id: customerId, direction: 'inbound', processing_generation: 0 });
        const [commitment] = await mockPg('call_commitments').insert({
          call_log_id: callId, commitment_key: 'send_reschedule_link:1', party: 'waves', kind: 'send_reschedule_link',
          description: 'send a reschedule link', source: 'ai', status: 'open', last_seen_generation: 0, processing_generation: 0,
        }).returning('id');
        const outboxId = randomUUID();
        const twilioSid = `SM${randomUUID().replaceAll('-', '').slice(0, 32)}`;
        // Parked waiting on a carrier receipt that never arrived, and an
        // earlier office verdict already resolved this attempt's own
        // delivery_outcome_uncertain bookkeeping (unrelated to what this
        // test targets — an unresolved uncertain older attempt has its own,
        // separate stagePromises hold). A real, pre-reopen sms_log row still
        // exists, but its status ('sent') is never confirmed delivery.
        // Exactly the stale, ambiguous evidence a content/time scan (rather
        // than this exact commitment's own definitive delivery status)
        // could mistake for proof.
        await mockPg('outbox_messages').insert({ id: outboxId, channel: 'sms', status: 'review', last_error: 'delivery_receipt_unavailable',
          provider_message_id: twilioSid, sent_at: new Date('2030-01-01T14:00:00Z'), payload: { call_generation: 0, delivery_outcome_uncertain: false },
          commitment_id: commitment.id, commitment_generation: 0, related_call_log_id: callId, related_customer_id: customerId });
        await mockPg('sms_log').insert({ id: randomUUID(), customer_id: customerId, direction: 'outbound',
          from_phone: '+15555550199', to_phone: '+15555550100', twilio_sid: twilioSid, status: 'sent', message_body: 'Your reschedule link: https://example.com/x' });

        // The office dismisses without ever getting a delivery receipt.
        await mockPg('call_commitments').where({ id: commitment.id }).update({ status: 'dismissed', human_state: 'dismissed' });

        const reopened = await applyHumanUpdate(mockPg, commitment.id, { action: 'reopen', reviewedBy: randomUUID() });
        // Not silently declared kept off ambiguous, pre-reopen evidence...
        expect(reopened.status).toBe('open');
        expect(reopened.fulfilled_at).toBeNull();
        // ...and genuinely renewed, so the next sweep gets a real attempt.
        expect(Number(reopened.processing_generation)).toBe(1);

        const staged = await links.stagePromises(mockPg);
        expect(staged).toBe(1);
      } finally {
        if (priorGate === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = priorGate;
        gates.callCommitments = priorCallCommitments;
      }
    });
  });

  /**
   * codex #4293 P1 (pre-push audit on PR #4293, reschedule-link-promises.js:1019):
   * Editing an open promise sets human_state 'edited' — a genuinely
   * BLOCKING state per humanStateBlocksPromise, even though status stays
   * 'open' the whole time. The very next sweep sees the block
   * (contextFor -> promise_closed) and cancels the promise's own outbox row
   * at whatever generation it was sitting at — edit never bumps
   * processing_generation, only Reopen's own renewal did, pre-fix. A later
   * Confirm restores human_state to 'confirmed' (status was never anything
   * but 'open'), but with nothing having ever bumped the generation, the
   * cancelled attempt still occupies exactly the generation stagePromises'
   * own NOT EXISTS predicate reads: the renewed promise is excluded from
   * every future sweep, forever, identical in shape to the Reopen hole this
   * file's previous round fixed — under a different button. The fix routes
   * Confirm-from-'edited' through the SAME shared helper (now
   * renewPromiseOnOfficeVerdict) Reopen already uses.
   */
  describe('an office Confirm renews an edited-but-still-open promise\'s own generation (codex #4293 P1)', () => {
    const quote = 'I will text you a reschedule link for that appointment.';
    const promiseNow = new Date('2030-01-07T14:00:00Z'); // 9:00 AM ET — inside the send window
    const stubBuildLink = async () => ({ url: 'https://example.com/reschedule/token' });
    const stubRender = async () => 'Your reschedule link: https://example.com/reschedule/token';

    test('edited-while-open promise -> sweep cancels -> staff Confirm -> the next sweep stages and sends a fresh attempt', async () => {
      const priorGate = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE;
      const priorCallCommitments = gates.callCommitments;
      const priorActivatedAt = process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT;
      try {
        process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = 'true';
        gates.callCommitments = true;
        process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT = '2000-01-01T00:00:00Z';

        const callId = randomUUID();
        const customerId = randomUUID();
        const visitId = randomUUID();
        const phone = '+15555550100';
        await mockPg('customers').insert({ id: customerId, first_name: 'Pat', last_name: 'Customer', phone,
          address_line1: '1 Example St', city: 'Bradenton', zip: '34205', active: true });
        await mockPg('scheduled_services').insert({ id: visitId, customer_id: customerId, scheduled_date: '2030-01-08',
          window_start: '09:00', window_end: '10:30', service_type: 'WaveGuard', status: 'confirmed', reschedule_token: 'token' });
        await mockPg('call_log').insert({ id: callId, customer_id: customerId, direction: 'inbound', from_phone: phone,
          v2_extraction_status: 'valid', processing_generation: 0, transcription: `Agent: ${quote}\nCaller: Thank you.` });
        const [commitment] = await mockPg('call_commitments').insert({
          call_log_id: callId, commitment_key: 'send_reschedule_link:1', party: 'waves', kind: 'send_reschedule_link',
          description: 'send a reschedule link', source: 'ai', status: 'open', confidence: 0.95,
          evidence: JSON.stringify([{ quote, speaker: 'agent' }]), last_seen_generation: 0, processing_generation: 0,
        }).returning('id');
        const outboxId = randomUUID();
        // Never claimed yet — exactly what stagePromises itself would have
        // inserted before the office ever touched the ledger.
        await mockPg('outbox_messages').insert({ id: outboxId, channel: 'sms', status: 'pending', payload: {},
          commitment_id: commitment.id, commitment_generation: 0,
          related_call_log_id: callId, related_customer_id: customerId, related_scheduled_service_id: visitId });

        // Staff Edit — corrects the description, the office's own routine
        // touch-up. The generic ledger patch this rides (applyHumanUpdate)
        // sets human_state 'edited' regardless of kind; status stays 'open'
        // because it already was.
        const edited = await applyHumanUpdate(mockPg, commitment.id, { action: 'edit', description: 'send a reschedule link (confirmed date)', reviewedBy: randomUUID() });
        expect(edited.status).toBe('open');
        expect(edited.human_state).toBe('edited');
        expect(Number(edited.processing_generation)).toBe(0);

        // The next sweep notices — applyContextSkip's promise_closed branch
        // (humanStateBlocksPromise('edited') === true) cancels the
        // now-orphaned outbox row, exactly like a dismiss would.
        const beforeConfirmRow = await mockPg('outbox_messages').where({ id: outboxId }).first();
        await links.runOne(mockPg, beforeConfirmRow, { now: promiseNow });
        const cancelled = await mockPg('outbox_messages').where({ id: outboxId }).first();
        expect(cancelled.status).toBe('cancelled');

        // Staff Confirm — affirming the edited description is correct.
        const confirmed = await applyHumanUpdate(mockPg, commitment.id, { action: 'confirm', reviewedBy: randomUUID() });
        expect(confirmed.status).toBe('open');
        expect(confirmed.human_state).toBe('confirmed');
        // The fix under test: a fresh generation, so stagePromises' own NOT
        // EXISTS predicate no longer finds the cancelled row "at or past"
        // this commitment's current generation.
        expect(Number(confirmed.processing_generation)).toBe(1);

        const staged = await links.stagePromises(mockPg);
        expect(staged).toBe(1);
        const rows = await mockPg('outbox_messages').where({ commitment_id: commitment.id }).orderBy('commitment_generation');
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({ commitment_generation: 0, status: 'cancelled' });
        expect(rows[1]).toMatchObject({ commitment_generation: 1, status: 'pending' });

        // The next sweep actually sends the renewed attempt.
        const fakeSid = `SM${'1'.repeat(32)}`;
        const successfulSend = async () => ({ sent: true, providerMessageId: fakeSid });
        await links.runOne(mockPg, rows[1], { now: promiseNow, send: successfulSend, buildLink: stubBuildLink, render: stubRender });
        const sent = await mockPg('outbox_messages').where({ id: rows[1].id }).first();
        expect(sent.status).toBe('sent');
        expect(sent.provider_message_id).toBe(fakeSid);
      } finally {
        if (priorGate === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = priorGate;
        if (priorActivatedAt === undefined) delete process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT; else process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT = priorActivatedAt;
        gates.callCommitments = priorCallCommitments;
      }
    });

    test('confirm after a genuinely delivered attempt restores fulfilled instead of re-texting (same dedup decision as Reopen)', async () => {
      const priorGate = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE;
      const priorCallCommitments = gates.callCommitments;
      try {
        process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = 'true';
        gates.callCommitments = true;

        const callId = randomUUID();
        await mockPg('call_log').insert({ id: callId, direction: 'inbound', processing_generation: 0 });
        const [commitment] = await mockPg('call_commitments').insert({
          call_log_id: callId, commitment_key: 'send_reschedule_link:1', party: 'waves', kind: 'send_reschedule_link',
          description: 'send a reschedule link', source: 'ai', status: 'open', last_seen_generation: 0, processing_generation: 0,
        }).returning('id');
        const outboxId = randomUUID();
        const twilioSid = `SM${randomUUID().replaceAll('-', '').slice(0, 32)}`;
        // The attempt that actually reached the customer — the provider's
        // own definitive, terminal record — for the ORIGINAL description.
        await mockPg('outbox_messages').insert({ id: outboxId, channel: 'sms', status: 'delivered', provider_message_id: twilioSid,
          sent_at: new Date('2030-01-01T14:00:00Z'), payload: { call_generation: 0, delivery_outcome_uncertain: false },
          commitment_id: commitment.id, commitment_generation: 0, related_call_log_id: callId });

        // Office edits the description AFTER delivery already happened
        // (e.g. a typo fix) — human_state becomes 'edited', status stays
        // 'open' because it already was (delivery never touched the
        // commitment's own status here; this models a race where the edit
        // lands before fulfilPromise's own human_state-gated UPDATE ever
        // runs, so the commitment is left 'open'/'edited' with a real,
        // already-delivered attempt underneath it).
        const edited = await applyHumanUpdate(mockPg, commitment.id, { action: 'edit', description: 'send a reschedule link (typo fixed)', reviewedBy: randomUUID() });
        expect(edited.status).toBe('open');
        expect(edited.human_state).toBe('edited');

        const confirmed = await applyHumanUpdate(mockPg, commitment.id, { action: 'confirm', reviewedBy: randomUUID() });
        // A delivery is not undone by an office Edit: Confirm surfaces that
        // fact — restoring 'fulfilled' — rather than reviving the promise
        // for a duplicate text.
        expect(confirmed.status).toBe('fulfilled');
        expect(confirmed.fulfillment).toMatchObject({ record_id: outboxId, basis: 'confirm_found_prior_delivery' });
        // No fresh generation is ever admitted — nothing left for a future
        // sweep to (re)send.
        expect(Number(confirmed.processing_generation)).toBe(0);

        const staged = await links.stagePromises(mockPg);
        expect(staged).toBe(0);
        const rows = await mockPg('outbox_messages').where({ commitment_id: commitment.id });
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(outboxId);
      } finally {
        if (priorGate === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = priorGate;
        gates.callCommitments = priorCallCommitments;
      }
    });

    test('a plain Confirm from the never-touched (null) state stays a no-op — no spurious generation bump on the common path', async () => {
      const callId = randomUUID();
      await mockPg('call_log').insert({ id: callId, direction: 'inbound', processing_generation: 0 });
      const [commitment] = await mockPg('call_commitments').insert({
        call_log_id: callId, commitment_key: 'send_reschedule_link:1', party: 'waves', kind: 'send_reschedule_link',
        description: 'send a reschedule link', source: 'ai', status: 'open', last_seen_generation: 0, processing_generation: 0,
      }).returning('id');

      const confirmed = await applyHumanUpdate(mockPg, commitment.id, { action: 'confirm', reviewedBy: randomUUID() });
      expect(confirmed.status).toBe('open');
      expect(confirmed.human_state).toBe('confirmed');
      // Nothing was ever blocking this commitment, so nothing may renew it —
      // a spurious bump here would strand a not-yet-dispatched pending row
      // at a now-stale generation.
      expect(Number(confirmed.processing_generation)).toBe(0);
    });
  });

  /**
   * codex #4293 P1 (pre-push audit on PR #4293, reschedule-link-promises.js:755):
   * dismissing an UNCERTAIN attempt through the commitment ledger (not this
   * promise's own triage card) never touched the outbox row at all — only
   * the next SWEEP's applyContextSkip('promise_closed') branch retired that
   * flag, by finding the commitment no longer open. A staff Reopen landing
   * before that sweep ever runs bumps processing_generation the moment the
   * dismiss transaction commits, so the commitment reads 'open' again:
   * promise_closed stops applying (nothing is closed any more), and a row
   * with no provider_message_id is never handed to reconcileAttempt either.
   * Nothing is left to ever clear the flag — stagePromises' own
   * uncertain-attempt guard blocks the renewed generation forever, and the
   * old row's own commitment now reads open, so nothing ever revisits it.
   * Only a real Postgres run proves the fix actually lands atomically with
   * the ledger's own dismiss UPDATE (not a separate, racable write) and that
   * stagePromises' real NOT EXISTS predicate is satisfied afterward.
   */
  describe('a ledger dismiss reconciles delivery uncertainty atomically with the verdict (codex #4293 P1)', () => {
    const quote = 'I will text you a reschedule link for that appointment.';
    const promiseNow = new Date('2030-01-07T14:00:00Z'); // 9:00 AM ET — inside the send window
    const stubBuildLink = async () => ({ url: 'https://example.com/reschedule/token' });
    const stubRender = async () => 'Your reschedule link: https://example.com/reschedule/token';

    test('dismiss -> Reopen BEFORE any sweep, with an uncertain no-provider-id attempt -> the renewed promise stages and sends', async () => {
      const priorGate = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE;
      const priorCallCommitments = gates.callCommitments;
      const priorActivatedAt = process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT;
      try {
        process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = 'true';
        gates.callCommitments = true;
        process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT = '2000-01-01T00:00:00Z';

        const callId = randomUUID();
        const customerId = randomUUID();
        const visitId = randomUUID();
        const phone = '+15555550100';
        await mockPg('customers').insert({ id: customerId, first_name: 'Pat', last_name: 'Customer', phone,
          address_line1: '1 Example St', city: 'Bradenton', zip: '34205', active: true });
        await mockPg('scheduled_services').insert({ id: visitId, customer_id: customerId, scheduled_date: '2030-01-08',
          window_start: '09:00', window_end: '10:30', service_type: 'WaveGuard', status: 'confirmed', reschedule_token: 'token' });
        await mockPg('call_log').insert({ id: callId, customer_id: customerId, direction: 'inbound', from_phone: phone,
          v2_extraction_status: 'valid', processing_generation: 0, transcription: `Agent: ${quote}\nCaller: Thank you.` });
        const [commitment] = await mockPg('call_commitments').insert({
          call_log_id: callId, commitment_key: 'send_reschedule_link:1', party: 'waves', kind: 'send_reschedule_link',
          description: 'send a reschedule link', source: 'ai', status: 'open', confidence: 0.95,
          evidence: JSON.stringify([{ quote, speaker: 'agent' }]), last_seen_generation: 0, processing_generation: 0,
        }).returning('id');
        const outboxId = randomUUID();
        // Claimed but never reached the provider — the exact "no provider
        // id" shape the finding names: claimForDispatch's own claim already
        // stamped delivery_outcome_uncertain true, and the process died (or
        // is simply still mid-flight) before any provider_message_id was
        // ever recorded. reconcileAttempt is never even reached for a row
        // like this (runOne only calls it when row.provider_message_id is
        // set), so nothing but an explicit office verdict can ever retire
        // this flag once the commitment stops reading 'closed'.
        await mockPg('outbox_messages').insert({ id: outboxId, channel: 'sms', status: 'sending', attempts: 1,
          last_attempt_at: new Date('2030-01-07T13:55:00Z'),
          payload: { commitment_created_at: new Date('2030-01-01T00:00:00Z').toISOString(), call_generation: 0, delivery_outcome_uncertain: true },
          commitment_id: commitment.id, commitment_generation: 0,
          related_call_log_id: callId, related_customer_id: customerId, related_scheduled_service_id: visitId });

        // Staff dismiss on the LEDGER — not the triage card — with NO sweep
        // in between. This is the fix under test: the dismiss's own
        // transaction must retire the flag itself.
        const dismissed = await applyHumanUpdate(mockPg, commitment.id, { action: 'dismiss', reviewedBy: randomUUID() });
        expect(dismissed.status).toBe('dismissed');
        const afterDismiss = await mockPg('outbox_messages').where({ id: outboxId }).first();
        expect(afterDismiss.status).toBe('sending'); // untouched — dismiss never cancels the row itself
        expect(afterDismiss.payload.delivery_outcome_uncertain).toBe(false);

        // Staff Reopen, still before any sweep has ever run.
        const reopened = await applyHumanUpdate(mockPg, commitment.id, { action: 'reopen', reviewedBy: randomUUID() });
        expect(reopened.status).toBe('open');
        expect(Number(reopened.processing_generation)).toBe(1);

        // Pre-fix, the old row's flag would still read true here and
        // stagePromises' own uncertain-attempt NOT EXISTS predicate would
        // exclude this commitment forever — 0 staged, permanently.
        const staged = await links.stagePromises(mockPg);
        expect(staged).toBe(1);
        const rows = await mockPg('outbox_messages').where({ commitment_id: commitment.id }).orderBy('commitment_generation');
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({ id: outboxId, commitment_generation: 0, status: 'sending' });
        expect(rows[1]).toMatchObject({ commitment_generation: 1, status: 'pending' });

        // ...and sends: the renewed promise is not just admitted for
        // staging, it actually reaches the provider on its next sweep.
        const fakeSid = `SM${'0'.repeat(32)}`;
        const successfulSend = async () => ({ sent: true, providerMessageId: fakeSid });
        await links.runOne(mockPg, rows[1], { now: promiseNow, send: successfulSend, buildLink: stubBuildLink, render: stubRender });
        const sent = await mockPg('outbox_messages').where({ id: rows[1].id }).first();
        expect(sent.status).toBe('sent');
        expect(sent.provider_message_id).toBe(fakeSid);
      } finally {
        if (priorGate === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = priorGate;
        if (priorActivatedAt === undefined) delete process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT; else process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT = priorActivatedAt;
        gates.callCommitments = priorCallCommitments;
      }
    });

    test('dismiss through the ledger retires uncertainty for every non-terminal attempt, same as the triage-card path', async () => {
      const callId = randomUUID();
      await mockPg('call_log').insert({ id: callId, direction: 'inbound', processing_generation: 0 });
      const [commitment] = await mockPg('call_commitments').insert({
        call_log_id: callId, commitment_key: 'send_reschedule_link:1', party: 'waves', kind: 'send_reschedule_link',
        description: 'send a reschedule link', source: 'ai', status: 'open', last_seen_generation: 0, processing_generation: 0,
      }).returning('id');
      const outboxId = randomUUID();
      await mockPg('outbox_messages').insert({ id: outboxId, channel: 'sms', status: 'review', last_error: 'provider_outcome_unknown',
        payload: { delivery_outcome_uncertain: true }, commitment_id: commitment.id, commitment_generation: 0, related_call_log_id: callId });

      const dismissed = await applyHumanUpdate(mockPg, commitment.id, { action: 'dismiss', reviewedBy: randomUUID() });
      expect(dismissed.status).toBe('dismissed');
      const row = await mockPg('outbox_messages').where({ id: outboxId }).first();
      // Still parked (dismiss reconciles the flag, not the status — that
      // stays the sweep's own job), but no longer flagged uncertain.
      expect(row.status).toBe('review');
      expect(row.payload.delivery_outcome_uncertain).toBe(false);
    });
  });

  /**
   * codex #4293 P1: neither stagePromises nor runOne's own final check ever
   * read commitment.due_at — a grounded promise like "I'll text you the
   * link tomorrow morning" was staged with available_at = now and sent on
   * whatever sweep found it, a day early. A REQUESTED time ("tomorrow
   * morning") is a floor: do not send before it. A DEADLINE ("by Friday")
   * only bounds how late the send may be: sending earlier still keeps it.
   * The extractor does not persist which shape produced a given due_at
   * (see the doc comment on isPromisedFloor in reschedule-link-promises.js),
   * so the distinction is read back out of the grounding evidence quote —
   * these tests exercise that classification through the real staging and
   * dispatch path, against genuine Postgres rows.
   */
  describe('a stated delivery time is honoured as a floor, a deadline is not (codex #4293 P1)', () => {
    const fakeSid = `SM${'0'.repeat(32)}`;
    const stubBuildLink = async () => ({ url: 'https://example.com/reschedule/token' });
    const stubRender = async () => 'Your reschedule link: https://example.com/reschedule/token';
    const successfulSend = async () => ({ sent: true, providerMessageId: fakeSid });

    async function seedPromise({ quote, dueAt = null }) {
      const callId = randomUUID();
      const customerId = randomUUID();
      const visitId = randomUUID();
      const phone = '+15555550100';
      await mockPg('customers').insert({ id: customerId, first_name: 'Pat', last_name: 'Customer', phone,
        address_line1: '1 Example St', city: 'Bradenton', zip: '34205', active: true });
      await mockPg('scheduled_services').insert({ id: visitId, customer_id: customerId, scheduled_date: '2030-01-20',
        window_start: '09:00', window_end: '10:30', service_type: 'WaveGuard', status: 'confirmed', reschedule_token: 'token' });
      await mockPg('call_log').insert({ id: callId, customer_id: customerId, direction: 'inbound', from_phone: phone,
        v2_extraction_status: 'valid', processing_generation: 0, transcription: `Agent: ${quote}\nCaller: Thank you.` });
      const [commitment] = await mockPg('call_commitments').insert({
        call_log_id: callId, commitment_key: 'send_reschedule_link:1', party: 'waves', kind: 'send_reschedule_link',
        description: 'send a reschedule link', source: 'ai', status: 'open', confidence: 0.95,
        evidence: JSON.stringify([{ quote, speaker: 'agent' }]), last_seen_generation: 0, processing_generation: 0,
        due_at: dueAt, due_basis: dueAt ? 'stated' : null,
      }).returning('id');
      return commitment.id;
    }

    let priorGate;
    let priorActivatedAt;
    let priorCallCommitments;
    beforeEach(() => {
      priorGate = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE;
      priorActivatedAt = process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT;
      priorCallCommitments = gates.callCommitments;
      process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = 'true';
      // Every fixture visit here predates this fixed instant by construction
      // (the call/commitment rows are inserted after this line runs), so a
      // real activation-boundary write can never race the very row it is
      // meant to admit.
      process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT = '2000-01-01T00:00:00Z';
      gates.callCommitments = true;
    });
    afterEach(() => {
      if (priorGate === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = priorGate;
      if (priorActivatedAt === undefined) delete process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT; else process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT = priorActivatedAt;
      gates.callCommitments = priorCallCommitments;
    });

    test('"tomorrow morning" is not sent on today\'s sweep, and IS sent on tomorrow\'s', async () => {
      const dueAt = new Date('2030-01-08T14:00:00Z'); // 9:00 AM ET, Jan 8
      const todayNow = new Date('2030-01-07T14:00:00Z'); // 9:00 AM ET, Jan 7 — before due_at, inside the send window
      const tomorrowNow = new Date('2030-01-08T15:00:00Z'); // 10:00 AM ET, Jan 8 — after due_at, inside the send window

      const commitmentId = await seedPromise({ quote: 'I will text you the reschedule link tomorrow morning.', dueAt });

      // Staging: the row's available_at is the promised floor, not now.
      const staged = await links.stagePromises(mockPg);
      expect(staged).toBe(1);
      const afterStaging = await mockPg('outbox_messages').where({ commitment_id: commitmentId }).first();
      expect(new Date(afterStaging.available_at).getTime()).toBe(dueAt.getTime());

      // Today's pass (runOne, as an ordinary sweep tick would drive it):
      // due_at has not passed — nothing is sent.
      const sendSpy = jest.fn(successfulSend);
      await links.runOne(mockPg, afterStaging, { now: todayNow, send: sendSpy, buildLink: stubBuildLink, render: stubRender });
      expect(sendSpy).not.toHaveBeenCalled();
      const stillPending = await mockPg('outbox_messages').where({ commitment_id: commitmentId }).first();
      expect(stillPending.status).toBe('pending');

      // Tomorrow's pass: due_at has passed — the promise is kept.
      await links.runOne(mockPg, stillPending, { now: tomorrowNow, send: sendSpy, buildLink: stubBuildLink, render: stubRender });
      expect(sendSpy).toHaveBeenCalledTimes(1);
      const sent = await mockPg('outbox_messages').where({ commitment_id: commitmentId }).first();
      expect(sent.status).toBe('sent');
      expect(sent.provider_message_id).toBe(fakeSid);
    });

    test('"by Friday" is a deadline, not a floor — it may send on the very next sweep', async () => {
      const dueAt = new Date('2030-01-11T14:00:00Z'); // Friday, well after `now` below
      const now = new Date('2030-01-07T14:00:00Z'); // Monday, 9:00 AM ET

      const commitmentId = await seedPromise({ quote: 'I will text you the reschedule link by Friday.', dueAt });

      const staged = await links.stagePromises(mockPg);
      expect(staged).toBe(1);
      // Staging itself never delays a deadline promise past now.
      const afterStaging = await mockPg('outbox_messages').where({ commitment_id: commitmentId }).first();
      expect(new Date(afterStaging.available_at).getTime()).toBeLessThan(dueAt.getTime());

      await links.runOne(mockPg, afterStaging, { now, send: successfulSend, buildLink: stubBuildLink, render: stubRender });
      const sent = await mockPg('outbox_messages').where({ commitment_id: commitmentId }).first();
      expect(sent.status).toBe('sent');
    });

    test('no stated timing sends on the very next sweep, exactly as before this fix', async () => {
      const now = new Date('2030-01-07T14:00:00Z');
      const commitmentId = await seedPromise({ quote: 'I will text you a reschedule link for that appointment.' });

      const staged = await links.stagePromises(mockPg);
      expect(staged).toBe(1);
      const afterStaging = await mockPg('outbox_messages').where({ commitment_id: commitmentId }).first();
      await links.runOne(mockPg, afterStaging, { now, send: successfulSend, buildLink: stubBuildLink, render: stubRender });
      const sent = await mockPg('outbox_messages').where({ commitment_id: commitmentId }).first();
      expect(sent.status).toBe('sent');
    });

    test('a floor promise is rechecked fresh immediately before dispatch — a stale available_at cannot slip a still-future promise out early', async () => {
      // Simulates the commitment's due_at moving OUT after this row was
      // already staged (a human edit, a reopened generation): available_at
      // still says "due now," but the commitment's own due_at is later.
      // runOne's own recheck — not staging's one-time computation — is what
      // has to catch this.
      const dueAt = new Date('2030-01-08T14:00:00Z');
      const beforeDue = new Date('2030-01-07T14:00:00Z');
      const afterDue = new Date('2030-01-08T15:00:00Z');
      const commitmentId = await seedPromise({ quote: 'I will text you the reschedule link tomorrow morning.', dueAt });

      const staged = await links.stagePromises(mockPg);
      expect(staged).toBe(1);
      // Force the row to look immediately due, as if it had been staged
      // before due_at was ever set.
      await mockPg('outbox_messages').where({ commitment_id: commitmentId }).update({ available_at: beforeDue });
      const staleRow = await mockPg('outbox_messages').where({ commitment_id: commitmentId }).first();

      const sendSpy = jest.fn(successfulSend);
      await links.runOne(mockPg, staleRow, { now: beforeDue, send: sendSpy, buildLink: stubBuildLink, render: stubRender });
      expect(sendSpy).not.toHaveBeenCalled();
      const held = await mockPg('outbox_messages').where({ commitment_id: commitmentId }).first();
      expect(held.status).toBe('pending');
      // The recheck corrects available_at back to the real floor.
      expect(new Date(held.available_at).getTime()).toBe(dueAt.getTime());

      await links.runOne(mockPg, held, { now: afterDue, send: sendSpy, buildLink: stubBuildLink, render: stubRender });
      expect(sendSpy).toHaveBeenCalledTimes(1);
      const sent = await mockPg('outbox_messages').where({ commitment_id: commitmentId }).first();
      expect(sent.status).toBe('sent');
    });
  });
});
