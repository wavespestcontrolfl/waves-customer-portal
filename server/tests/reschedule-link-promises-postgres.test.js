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
const TABLES = ['customers', 'call_log', 'call_commitments', 'outbox_messages', 'system_settings', 'triage_items', 'audit_log', 'sms_templates', 'sms_log', 'scheduled_services'];
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
        await mockPg('call_log').insert({ id: callId, direction: 'inbound', processing_generation: 2 });
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
        // The existing review reason is left exactly as it was — only the
        // flag moves.
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
});
