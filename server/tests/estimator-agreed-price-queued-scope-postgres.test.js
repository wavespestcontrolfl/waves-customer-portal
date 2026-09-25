/**
 * codex #4815 r7 (P0 + P1) — the QUEUED agreed-price quarantine, against
 * real jsonb.
 *
 * P0: when the pre-finalization invalidation failed, finalization queued
 * estimator_quarantine_pending; callDraftVerdict read that queued entry as
 * CALL-WIDE, so every estimate of the call — accepted and booking-linked
 * rows included, which the invalidation deliberately never touches —
 * 404'd on its public token until the drainer ran, and the detached
 * fallback sweep that LANDED the invalidation never retired the entry.
 * Now (a) a queued ROW-SCOPED entry follows the same scoping as the landed
 * verdict (never a terminal or booking-linked row; still every other row
 * and every new draft), and (b) the landed fallback retires its own
 * generation's entry.
 *
 * P1: a stale generation-N queue write landing after N+1 claimed planted
 * N's marker under N+1 and refused N+1's valid draft. The write now
 * carries the live-generation ownership predicate.
 *
 * Plus the drainer-replay residual: a same-generation replay no longer
 * un-supersedes a block the Waves Assessment exception superseded.
 *
 * Runs only with DATABASE_URL (a LOCAL database — never production); every
 * table lives in a throwaway schema. Fixtures fictitious.
 */

const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');

let mockDatabase = null;
jest.mock('../models/db', () => new Proxy(function mockDb() {}, {
  apply: (_t, _this, args) => mockDatabase(...args),
  get: (_t, prop) => {
    const value = mockDatabase[prop];
    return typeof value === 'function' ? value.bind(mockDatabase) : value;
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

jest.setTimeout(60000);

(SKIP ? describe.skip : describe)('queued agreed-price quarantine on PostgreSQL (codex #4815 r7)', () => {
  const schema = `agreed_queue_${randomUUID().replaceAll('-', '')}`;
  let engine;
  let persistence;
  let claimSql;

  beforeAll(async () => {
    mockDatabase = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 4 } });
    await mockDatabase.raw('CREATE SCHEMA ??', [schema]);
    await mockDatabase.raw(`CREATE TABLE ??.call_log (
      id text PRIMARY KEY, metadata jsonb, processing_generation integer, processing_token text,
      processing_status text, extraction_attempts integer DEFAULT 0, created_at timestamptz DEFAULT now(),
      twilio_call_sid text, updated_at timestamptz)`, [schema]);
    await mockDatabase.raw(`CREATE TABLE ??.estimates (
      id text PRIMARY KEY, status text, archived_at timestamptz, estimate_data jsonb,
      scheduled_at timestamptz, created_at timestamptz DEFAULT now(), updated_at timestamptz)`, [schema]);
    await mockDatabase.raw(`CREATE TABLE ??.leads (
      id text PRIMARY KEY, estimate_id text, twilio_call_sid text, deleted_at timestamptz,
      created_at timestamptz DEFAULT now())`, [schema]);
    engine = require('../services/estimator-engine');
    persistence = require('../services/admin-estimate-persistence');
    claimSql = require('../utils/estimate-claim-sql');
  });

  afterAll(async () => {
    if (!mockDatabase) return;
    await mockDatabase.raw('DROP SCHEMA ?? CASCADE', [schema]).catch(() => {});
    await mockDatabase.destroy();
  });

  const agreedQueue = (generation = 5) => ({ reason: 'price_agreed_on_call', at: '2026-09-25T07:00:00.000Z', generation });
  const callRow = async (metadata, { generation = 5 } = {}) => {
    const id = `call-${randomUUID()}`;
    await mockDatabase('call_log').insert({
      id, metadata: JSON.stringify(metadata), processing_generation: generation,
      processing_status: 'processed', processing_token: null,
    });
    return id;
  };
  const metadataOf = async (id) => (await mockDatabase('call_log').where({ id }).first('metadata')).metadata;
  const estimate = async (callLogId, { status = 'draft', extra = {} } = {}) => {
    const id = `est-${randomUUID()}`;
    const data = { estimatorEngine: { callLogId }, ...extra };
    await mockDatabase('estimates').insert({ id, status, estimate_data: JSON.stringify(data) });
    return { id, data };
  };
  const newDraftGuard = (callLogId) => mockDatabase.transaction(
    (trx) => persistence.callRejectedForDrafting(trx, callLogId, { lockCallRow: true }),
  );

  describe('P0 — a queued agreed-price entry never blocks a row the invalidation would not mark', () => {
    test.each(['accepted', 'declined', 'expired'])('an %s estimate keeps its token while the entry is queued', async (status) => {
      const callId = await callRow({ estimator_quarantine_pending: agreedQueue() });
      const { data } = await estimate(callId, { status });
      await expect(claimSql.callSideBlockForEstimateData(mockDatabase, data, { estimateStatus: status })).resolves.toBeNull();
      await expect(persistence.staleCallLinkageReason(mockDatabase, data, { estimateStatus: status })).resolves.toBeNull();
    });

    test('a booking-linked (assessment exception) estimate keeps its token while the entry is queued', async () => {
      const callId = await callRow({ estimator_quarantine_pending: agreedQueue() });
      const { data } = await estimate(callId, { status: 'sent', extra: { scheduled_service_id: 'svc-1' } });
      await expect(claimSql.callSideBlockForEstimateData(mockDatabase, data, { estimateStatus: 'sent' })).resolves.toBeNull();
      await expect(persistence.staleCallLinkageReason(mockDatabase, data, { estimateStatus: 'sent' })).resolves.toBeNull();
    });

    test('an ordinary non-terminal draft, a row of UNKNOWN status, and every NEW draft stay blocked (fail-safe)', async () => {
      const callId = await callRow({ estimator_quarantine_pending: agreedQueue() });
      const { data } = await estimate(callId, { status: 'sent' });
      await expect(claimSql.callSideBlockForEstimateData(mockDatabase, data, { estimateStatus: 'sent' })).resolves.toBe('price_agreed_on_call');
      await expect(persistence.staleCallLinkageReason(mockDatabase, data, { estimateStatus: 'sent' })).resolves.toBe('call_quarantine_pending');
      // A caller that does not pass the status cannot prove the row terminal.
      await expect(claimSql.callSideBlockForEstimateData(mockDatabase, data)).resolves.toBe('price_agreed_on_call');
      await expect(newDraftGuard(callId)).resolves.toBe('price_agreed_on_call');
    });

    test('a queued IDENTITY entry is still call-wide: accepted and booking-linked rows stay blocked', async () => {
      const callId = await callRow({ estimator_quarantine_pending: { reason: 'email_identity_conflict', at: 'x', generation: 5 } });
      const accepted = await estimate(callId, { status: 'accepted' });
      const linked = await estimate(callId, { status: 'sent', extra: { scheduled_service_id: 'svc-1' } });
      await expect(claimSql.callSideBlockForEstimateData(mockDatabase, accepted.data, { estimateStatus: 'accepted' }))
        .resolves.toBe('email_identity_conflict');
      await expect(persistence.staleCallLinkageReason(mockDatabase, linked.data, { estimateStatus: 'sent' }))
        .resolves.toBe('call_quarantine_pending');
      await expect(newDraftGuard(callId)).resolves.toBe('email_identity_conflict');
    });
  });

  describe('P0 — the fallback sweep that LANDS the invalidation retires its own queue entry', () => {
    test('sweep success at generation N, then the generation-matched clear: stale draft marked, entry gone, accepted row untouched', async () => {
      const callId = await callRow({ estimator_quarantine_pending: agreedQueue(5) });
      const stale = await estimate(callId, { status: 'sent' });
      const accepted = await estimate(callId, { status: 'accepted' });

      const outcome = await engine.invalidateDraftForCall(callId, {
        reason: 'price_agreed_on_call',
        scope: 'nonterminal_drafts',
        ownershipFence: { callLogId: callId, procToken: 'tok-5', procGeneration: 5 },
      });
      expect(outcome).toMatchObject({ ok: true, invalidated: true });
      expect(outcome.ownershipLost).toBeUndefined();
      await expect(engine.clearOwnQuarantinePending(callId, { reason: 'price_agreed_on_call', generation: 5 })).resolves.toBe(1);

      const md = await metadataOf(callId);
      expect(md.estimator_quarantine_pending).toBeUndefined();
      expect(md.estimator_draft_block).toMatchObject({ reason: 'price_agreed_on_call', generation: 5 });
      const staleRow = await mockDatabase('estimates').where({ id: stale.id }).first();
      expect(staleRow.estimate_data.estimatorEngine.linkage_invalidated_at).toBeTruthy();
      const acceptedRow = await mockDatabase('estimates').where({ id: accepted.id }).first();
      expect(acceptedRow.estimate_data.estimatorEngine.linkage_invalidated_at).toBeUndefined();
      await expect(claimSql.callSideBlockForEstimateData(mockDatabase, acceptedRow.estimate_data, { estimateStatus: 'accepted' }))
        .resolves.toBeNull();
    });

    test('the clear never removes a NEWER pass\'s entry, another verdict\'s entry, or a generation-less one', async () => {
      const newer = await callRow({ estimator_quarantine_pending: agreedQueue(6) }, { generation: 6 });
      await expect(engine.clearOwnQuarantinePending(newer, { reason: 'price_agreed_on_call', generation: 5 })).resolves.toBe(0);
      expect((await metadataOf(newer)).estimator_quarantine_pending).toMatchObject({ generation: 6 });

      const identity = await callRow({ estimator_quarantine_pending: { reason: 'email_identity_conflict', at: 'x', generation: 5 } });
      await expect(engine.clearOwnQuarantinePending(identity, { reason: 'price_agreed_on_call', generation: 5 })).resolves.toBe(0);
      expect((await metadataOf(identity)).estimator_quarantine_pending).toMatchObject({ reason: 'email_identity_conflict' });

      const legacy = await callRow({ estimator_quarantine_pending: { reason: 'price_agreed_on_call', at: 'x' } });
      await expect(engine.clearOwnQuarantinePending(legacy, { reason: 'price_agreed_on_call', generation: 5 })).resolves.toBe(0);
      await expect(engine.clearOwnQuarantinePending(legacy, { reason: 'price_agreed_on_call', generation: null })).resolves.toBe(0);
      expect((await metadataOf(legacy)).estimator_quarantine_pending).toMatchObject({ reason: 'price_agreed_on_call' });
    });
  });

  describe('P1 — the queue write carries the live-generation ownership predicate', () => {
    test('a stale generation-N write after N+1 claimed is refused as an ownership loss, and N+1\'s draft passes the creators\' guard', async () => {
      // N+1 (generation 6) claimed, re-qualified past the agreed price, and
      // superseded N's landed block before composing.
      const callId = await callRow({
        estimator_draft_block: { reason: 'price_agreed_on_call', at: 'x', generation: 5, superseded_at: 'y', superseded_by_generation: 6 },
      }, { generation: 6 });

      await expect(engine.markQuarantinePending(callId, 'price_agreed_on_call', { procGeneration: 5 })).resolves.toBe('ownership_lost');
      expect((await metadataOf(callId)).estimator_quarantine_pending).toBeUndefined();
      expect((await metadataOf(callId)).estimator_quarantine_queue).toBeUndefined();
      await expect(newDraftGuard(callId)).resolves.toBeNull();
    });

    test('the owning generation still queues (and its creators are then refused until drained)', async () => {
      const callId = await callRow({}, { generation: 6 });
      await expect(engine.markQuarantinePending(callId, 'price_agreed_on_call', { procGeneration: 6 })).resolves.toBe(true);
      // codex #4815 r8 P1: the entry now lives in the multi-entry queue,
      // keyed by its reason (the legacy single key is read-only).
      expect((await metadataOf(callId)).estimator_quarantine_queue).toMatchObject({
        price_agreed_on_call: { reason: 'price_agreed_on_call', generation: 6 },
      });
      await expect(newDraftGuard(callId)).resolves.toBe('price_agreed_on_call');
    });

    test('the finalization-transaction form is fenced the same way', async () => {
      const callId = await callRow({}, { generation: 6 });
      const result = await mockDatabase.transaction((trx) => engine.markQuarantinePending(
        callId, 'price_agreed_on_call', { procGeneration: 5, trx },
      ));
      expect(result).toBe('ownership_lost');
      expect((await metadataOf(callId)).estimator_quarantine_pending).toBeUndefined();
      expect((await metadataOf(callId)).estimator_quarantine_queue).toBeUndefined();
    });
  });

  describe('drainer-replay residual — a same-generation replay keeps the exception\'s supersession', () => {
    const supersededBlock = (generation) => ({
      reason: 'price_agreed_on_call', at: 'x', generation: 5, superseded_at: '2026-09-25T07:05:00.000Z', superseded_by_generation: generation,
    });

    test('the generation-N settled replay (drainer shape) marks the stale draft but leaves the block superseded', async () => {
      const callId = await callRow({ estimator_draft_block: supersededBlock(5), estimator_quarantine_pending: agreedQueue(5) });
      const stale = await estimate(callId, { status: 'draft' });
      const assessment = await estimate(callId, { status: 'sent', extra: { scheduled_service_id: 'svc-1' } });

      const outcome = await engine.invalidateDraftForCall(callId, {
        reason: 'price_agreed_on_call',
        scope: 'nonterminal_drafts',
        ownershipFence: { callLogId: callId, procGeneration: 5 },
      });
      expect(outcome).toMatchObject({ ok: true, invalidated: true });

      const md = await metadataOf(callId);
      expect(md.estimator_draft_block).toMatchObject({ superseded_at: '2026-09-25T07:05:00.000Z', superseded_by_generation: 5 });
      const staleRow = await mockDatabase('estimates').where({ id: stale.id }).first();
      expect(staleRow.estimate_data.estimatorEngine.linkage_invalidated_at).toBeTruthy();
      const assessmentRow = await mockDatabase('estimates').where({ id: assessment.id }).first();
      expect(assessmentRow.estimate_data.estimatorEngine.linkage_invalidated_at).toBeUndefined();
      await expect(claimSql.callSideBlockForEstimateData(mockDatabase, assessmentRow.estimate_data, { estimateStatus: 'sent' }))
        .resolves.toBeNull();
      // The archived stale draft stays dead through its own stamp.
      await expect(claimSql.callSideBlockForEstimateData(mockDatabase, staleRow.estimate_data, { estimateStatus: 'draft' }))
        .resolves.toBe('price_agreed_on_call');
    });

    test('a NEWER generation\'s verdict rewrites the marker and drops the supersession', async () => {
      const callId = await callRow({ estimator_draft_block: supersededBlock(5) }, { generation: 6 });
      const outcome = await engine.invalidateDraftForCall(callId, {
        reason: 'price_agreed_on_call',
        scope: 'nonterminal_drafts',
        ownershipFence: { callLogId: callId, procGeneration: 6 },
      });
      expect(outcome.ok).toBe(true);
      const md = await metadataOf(callId);
      expect(md.estimator_draft_block).toMatchObject({ reason: 'price_agreed_on_call', generation: 6 });
      expect(md.estimator_draft_block.superseded_at).toBeUndefined();
      await expect(newDraftGuard(callId)).resolves.toBe('price_agreed_on_call');
    });

    test('a standing CALL-WIDE marker is still never downgraded', async () => {
      const callId = await callRow({ estimator_draft_block: { reason: 'email_identity_conflict', at: 'x', generation: 5 } });
      await engine.invalidateDraftForCall(callId, {
        reason: 'price_agreed_on_call',
        scope: 'nonterminal_drafts',
        ownershipFence: { callLogId: callId, procGeneration: 5 },
      });
      expect((await metadataOf(callId)).estimator_draft_block).toMatchObject({ reason: 'email_identity_conflict' });
    });
  });
});
