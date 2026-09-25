/**
 * codex #4815 r8 — the multi-entry quarantine queue, the fail-closed state
 * that survives retry exhaustion, the assessment exception's durable
 * provenance, and bell retirement retried from the bell's own state —
 * against real jsonb.
 *
 * P1 (queue overwrite): the queue was ONE key rewritten by jsonb_set, so an
 * agreed-price retry REPLACED a queued identity-conflict verdict without
 * revalidating it — and since agreed-price is row-scoped, accepted and
 * booking-linked estimates then passed. The queue now holds one entry per
 * reason; readers see every entry, the drainer resolves each on its own
 * evidence, and the generation-matched clear removes only its own entry.
 *
 * P1 (exhaustion): when the invalidation AND its queue write failed, only
 * the retry lane kept the call's estimates blocked — and an exhausted (or
 * aged-out) lane reads as settled. The retry-lane push now writes the
 * verdict into the queue in the SAME statement, so exhaustion never
 * unblocks; the drainer resolves the entry once the call settles.
 *
 * P2 (provenance): an assessment exception draft whose visit died before
 * the linkage could land is stamped estimate_data.assessment_exception and
 * excluded from any later agreed-price cleanup.
 *
 * P2 (bell): staleDraftBellForCall reads the live bell's own state, so a
 * retirement whose notification update failed is retried by later passes.
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
jest.mock('../services/estimator-engine/context-builder', () => ({
  buildCallContext: jest.fn(),
  existingDraftForCall: jest.fn(async () => null),
  _private: { extractionFromCall: jest.fn(() => ({ source: 'none', extraction: null })) },
}));
jest.mock('../config/twilio-numbers', () => ({
  isInternalNumber: jest.fn(() => false),
  isOwnedNumber: jest.fn(() => false),
  findByNumber: jest.fn(() => null),
  getLeadSourceFromNumber: jest.fn(() => ({ source: 'phone_call' })),
}));

jest.setTimeout(60000);

(SKIP ? describe.skip : describe)('multi-entry quarantine queue on PostgreSQL (codex #4815 r8)', () => {
  const schema = `quarantine_r8_${randomUUID().replaceAll('-', '')}`;
  let engine;
  let persistence;
  let claimSql;
  let contextBuilder;
  let processorTest;
  let predraft;

  beforeAll(async () => {
    mockDatabase = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 4 } });
    await mockDatabase.raw('CREATE SCHEMA ??', [schema]);
    await mockDatabase.raw(`CREATE TABLE ??.call_log (
      id text PRIMARY KEY, metadata jsonb, processing_generation integer, processing_token text,
      processing_status text, extraction_attempts integer DEFAULT 0, created_at timestamptz DEFAULT now(),
      twilio_call_sid text, ai_extraction jsonb, ai_extraction_enriched jsonb, v2_extraction_status text,
      updated_at timestamptz)`, [schema]);
    await mockDatabase.raw(`CREATE TABLE ??.estimates (
      id text PRIMARY KEY, status text, archived_at timestamptz, estimate_data jsonb,
      scheduled_at timestamptz, created_at timestamptz DEFAULT now(), updated_at timestamptz)`, [schema]);
    await mockDatabase.raw(`CREATE TABLE ??.leads (
      id text PRIMARY KEY, estimate_id text, twilio_call_sid text, deleted_at timestamptz,
      created_at timestamptz DEFAULT now())`, [schema]);
    await mockDatabase.raw(`CREATE TABLE ??.notifications (
      id text PRIMARY KEY, metadata jsonb, created_at timestamptz DEFAULT now(),
      title text, body text, link text, read_at timestamptz)`, [schema]);
    engine = require('../services/estimator-engine');
    persistence = require('../services/admin-estimate-persistence');
    claimSql = require('../utils/estimate-claim-sql');
    contextBuilder = require('../services/estimator-engine/context-builder');
    processorTest = require('../services/call-recording-processor')._test;
    predraft = require('../services/estimator-engine/booking-predraft');
  });

  afterAll(async () => {
    if (!mockDatabase) return;
    await mockDatabase.raw('DROP SCHEMA ?? CASCADE', [schema]).catch(() => {});
    await mockDatabase.destroy();
  });

  beforeEach(() => {
    contextBuilder.buildCallContext.mockReset();
    contextBuilder._private.extractionFromCall.mockReset();
    contextBuilder._private.extractionFromCall.mockReturnValue({ source: 'none', extraction: null });
  });

  const identityEntry = (generation = 5) => ({ reason: 'email_identity_conflict', at: '2026-09-25T07:00:00.000Z', generation });
  const agreedEntry = (generation = 5) => ({ reason: 'price_agreed_on_call', at: '2026-09-25T07:01:00.000Z', generation });
  const callRow = async (metadata, { generation = 5, status = 'processed', attempts = 0, createdAt = null } = {}) => {
    const id = `call-${randomUUID()}`;
    await mockDatabase('call_log').insert({
      id, metadata: JSON.stringify(metadata), processing_generation: generation,
      processing_status: status, processing_token: null, extraction_attempts: attempts,
      ...(createdAt ? { created_at: createdAt } : {}),
    });
    return id;
  };
  const metadataOf = async (id) => (await mockDatabase('call_log').where({ id }).first('metadata')).metadata;
  const liveCall = (id) => mockDatabase('call_log').where({ id }).first();
  const estimate = async (callLogId, { status = 'draft', extra = {} } = {}) => {
    const id = `est-${randomUUID()}`;
    const data = { estimatorEngine: { callLogId }, ...extra };
    await mockDatabase('estimates').insert({ id, status, estimate_data: JSON.stringify(data) });
    return { id, data };
  };
  const estimateData = async (id) => (await mockDatabase('estimates').where({ id }).first('estimate_data')).estimate_data;
  const newDraftGuard = (callLogId) => mockDatabase.transaction(
    (trx) => persistence.callRejectedForDrafting(trx, callLogId, { lockCallRow: true }),
  );
  const AGREED_EXTRACTION = {
    source: 'enriched',
    extraction: { service_request: { price: { amount_usd: 300, accepted: true } } },
  };

  describe('P1 — an agreed-price retry never overwrites a queued call-wide verdict', () => {
    test('identity queued, then agreed-price queued: BOTH entries stand and accepted / booking-linked rows stay blocked', async () => {
      const callId = await callRow({}, { generation: 5 });
      await expect(engine.markQuarantinePending(callId, 'email_identity_conflict', { procGeneration: 5 })).resolves.toBe(true);
      await expect(engine.markQuarantinePending(callId, 'price_agreed_on_call', { procGeneration: 5 })).resolves.toBe(true);

      const md = await metadataOf(callId);
      expect(md.estimator_quarantine_queue).toMatchObject({
        email_identity_conflict: { reason: 'email_identity_conflict', generation: 5 },
        price_agreed_on_call: { reason: 'price_agreed_on_call', generation: 5 },
      });
      const accepted = await estimate(callId, { status: 'accepted' });
      const linked = await estimate(callId, { status: 'sent', extra: { scheduled_service_id: 'svc-1' } });
      await expect(claimSql.callSideBlockForEstimateData(mockDatabase, accepted.data, { estimateStatus: 'accepted' }))
        .resolves.toBe('email_identity_conflict');
      await expect(persistence.staleCallLinkageReason(mockDatabase, linked.data, { estimateStatus: 'sent' }))
        .resolves.toBe('call_quarantine_pending');
      await expect(newDraftGuard(callId)).resolves.toBe('email_identity_conflict');
    });

    test('the reverse order (agreed-price first) is equally safe — the call-wide verdict is reported', async () => {
      const callId = await callRow({}, { generation: 5 });
      await engine.markQuarantinePending(callId, 'price_agreed_on_call', { procGeneration: 5 });
      await engine.markQuarantinePending(callId, 'email_identity_conflict', { procGeneration: 5 });
      const accepted = await estimate(callId, { status: 'accepted' });
      await expect(claimSql.callSideBlockForEstimateData(mockDatabase, accepted.data, { estimateStatus: 'accepted' }))
        .resolves.toBe('email_identity_conflict');
    });

    test('clearOwnQuarantinePending removes ONLY its own reason + generation — the identity entry keeps blocking', async () => {
      const callId = await callRow({
        estimator_quarantine_queue: { email_identity_conflict: identityEntry(5), price_agreed_on_call: agreedEntry(5) },
      });
      await expect(engine.clearOwnQuarantinePending(callId, { reason: 'price_agreed_on_call', generation: 4 })).resolves.toBe(0);
      await expect(engine.clearOwnQuarantinePending(callId, { reason: 'price_agreed_on_call', generation: 5 })).resolves.toBe(1);
      const md = await metadataOf(callId);
      expect(md.estimator_quarantine_queue).toEqual({ email_identity_conflict: identityEntry(5) });
      const accepted = await estimate(callId, { status: 'accepted' });
      await expect(claimSql.callSideBlockForEstimateData(mockDatabase, accepted.data, { estimateStatus: 'accepted' }))
        .resolves.toBe('email_identity_conflict');
    });

    test('clearing the LAST entry drops the queue key entirely', async () => {
      const callId = await callRow({ estimator_quarantine_queue: { price_agreed_on_call: agreedEntry(5) } });
      await expect(engine.clearOwnQuarantinePending(callId, { reason: 'price_agreed_on_call', generation: 5 })).resolves.toBe(1);
      expect((await metadataOf(callId)).estimator_quarantine_queue).toBeUndefined();
    });

    test('a LEGACY single-key identity entry plus a new agreed-price entry: both are honored', async () => {
      const callId = await callRow({ estimator_quarantine_pending: identityEntry(5) });
      await engine.markQuarantinePending(callId, 'price_agreed_on_call', { procGeneration: 5 });
      const md = await metadataOf(callId);
      expect(md.estimator_quarantine_pending).toMatchObject({ reason: 'email_identity_conflict' });
      expect(md.estimator_quarantine_queue).toMatchObject({ price_agreed_on_call: { generation: 5 } });
      const accepted = await estimate(callId, { status: 'accepted' });
      await expect(claimSql.callSideBlockForEstimateData(mockDatabase, accepted.data, { estimateStatus: 'accepted' }))
        .resolves.toBe('email_identity_conflict');
    });
  });

  describe('P1 — the drainer resolves each queued verdict on its own evidence', () => {
    test('identity RE-QUALIFIED + agreed price STANDS: identity entry and its block retired, the agreed price replayed and drained', async () => {
      const callId = await callRow({
        estimator_draft_block: { reason: 'email_identity_conflict', at: '2026-09-25T07:00:00.000Z', generation: 5 },
        estimator_quarantine_queue: { email_identity_conflict: identityEntry(5), price_agreed_on_call: agreedEntry(5) },
      });
      const stale = await estimate(callId, { status: 'sent' });
      const accepted = await estimate(callId, { status: 'accepted' });
      contextBuilder.buildCallContext.mockResolvedValue({ call: { id: callId }, extraction: {} });
      contextBuilder._private.extractionFromCall.mockReturnValue(AGREED_EXTRACTION);

      // The shared schema carries earlier tests' rows, so the call's own
      // outcome is asserted rather than the sweep-wide count.
      await engine.sweepPendingQuarantines();

      const md = await metadataOf(callId);
      expect(md.estimator_quarantine_queue).toBeUndefined();
      // The replay re-stamped the (now row-scoped) agreed-price block.
      expect(md.estimator_draft_block).toMatchObject({ reason: 'price_agreed_on_call', generation: 5 });
      expect((await estimateData(stale.id)).estimatorEngine).toMatchObject({ invalidation_reason: 'price_agreed_on_call' });
      const acceptedData = await estimateData(accepted.id);
      expect(acceptedData.estimatorEngine.linkage_invalidated_at).toBeUndefined();
      await expect(claimSql.callSideBlockForEstimateData(mockDatabase, acceptedData, { estimateStatus: 'accepted' }))
        .resolves.toBeNull();
    });

    test('agreed price RE-QUALIFIED never retires a landed IDENTITY block, and a still-unresolved identity entry keeps blocking', async () => {
      const callId = await callRow({
        estimator_draft_block: { reason: 'email_identity_conflict', at: '2026-09-25T07:00:00.000Z', generation: 5 },
        estimator_quarantine_queue: { email_identity_conflict: identityEntry(5), price_agreed_on_call: agreedEntry(5) },
      });
      // Identity revalidation is inconclusive (defers); no agreed price any more.
      contextBuilder.buildCallContext.mockResolvedValue({ error: 'customer_lookup_unavailable' });
      contextBuilder._private.extractionFromCall.mockReturnValue({ source: 'enriched', extraction: { service_request: {} } });

      await engine.sweepPendingQuarantines();

      const md = await metadataOf(callId);
      expect(md.estimator_draft_block).toMatchObject({ reason: 'email_identity_conflict' });
      expect(md.estimator_quarantine_queue).toEqual({ email_identity_conflict: identityEntry(5) });
      const accepted = await estimate(callId, { status: 'accepted' });
      await expect(claimSql.callSideBlockForEstimateData(mockDatabase, accepted.data, { estimateStatus: 'accepted' }))
        .resolves.toBe('email_identity_conflict');
    });

    test('the pass-start call-wide clear retires nothing while a row-scoped entry is queued beside it', async () => {
      const { clearDraftBlockOnCall } = engine._private;
      const mixed = await callRow({
        estimator_quarantine_queue: { email_identity_conflict: identityEntry(5), price_agreed_on_call: agreedEntry(5) },
      });
      await clearDraftBlockOnCall(mixed, { notNewerThan: '2026-09-25T09:00:00.000Z', generation: 6, callWideOnly: true });
      expect(Object.keys((await metadataOf(mixed)).estimator_quarantine_queue).sort())
        .toEqual(['email_identity_conflict', 'price_agreed_on_call']);

      const callWide = await callRow({ estimator_quarantine_queue: { email_identity_conflict: identityEntry(5) } });
      await clearDraftBlockOnCall(callWide, { notNewerThan: '2026-09-25T09:00:00.000Z', generation: 6, callWideOnly: true });
      expect((await metadataOf(callWide)).estimator_quarantine_queue).toBeUndefined();
    });

    test('a clear never retires a queue entry NEWER than the clearing pass', async () => {
      const { clearDraftBlockOnCall } = engine._private;
      const callId = await callRow({ estimator_quarantine_queue: { email_identity_conflict: identityEntry(7) } }, { generation: 7 });
      await clearDraftBlockOnCall(callId, { notNewerThan: '2026-09-25T09:00:00.000Z', generation: 6 });
      expect((await metadataOf(callId)).estimator_quarantine_queue).toMatchObject({ email_identity_conflict: { generation: 7 } });
    });
  });

  describe('P1 — an exhausted retry lane never unblocks the stale draft', () => {
    const { CALL_EXTRACTION_MAX_ATTEMPTS } = require('../config/call-extraction-retry');

    test('the retry-lane push writes the verdict atomically; at the cap the call is SETTLED yet its draft stays blocked', async () => {
      const callId = await callRow({}, { generation: 7, attempts: CALL_EXTRACTION_MAX_ATTEMPTS - 1 });
      const stale = await estimate(callId, { status: 'sent' });

      await processorTest.pushCallToRetryLaneAfterQuarantineFailure({
        call: { id: callId }, callSid: 'CA-r8-1', procGeneration: 7, reason: 'price_agreed_on_call',
      });

      const live = await liveCall(callId);
      expect(live.processing_status).toBe('extraction_failed');
      expect(live.extraction_attempts).toBe(CALL_EXTRACTION_MAX_ATTEMPTS);
      expect(claimSql.callReprocessInFlight(live)).toBe(false);
      expect(live.metadata.estimator_quarantine_queue).toMatchObject({ price_agreed_on_call: { generation: 7 } });
      await expect(claimSql.callSideBlockForEstimateData(mockDatabase, stale.data, { estimateStatus: 'sent' }))
        .resolves.toBe('price_agreed_on_call');
      await expect(newDraftGuard(callId)).resolves.toBe('price_agreed_on_call');
    });

    test('an AGED-OUT call (past the 7-day window) stays blocked the same way, and an identity verdict stays call-wide', async () => {
      const callId = await callRow({}, { generation: 7, attempts: 0, createdAt: '2026-09-01T00:00:00.000Z' });
      const accepted = await estimate(callId, { status: 'accepted' });
      await processorTest.pushCallToRetryLaneAfterQuarantineFailure({
        call: { id: callId }, callSid: 'CA-r8-2', procGeneration: 7, reason: 'email_identity_conflict',
      });
      const live = await liveCall(callId);
      expect(claimSql.callReprocessInFlight(live)).toBe(false);
      await expect(claimSql.callSideBlockForEstimateData(mockDatabase, accepted.data, { estimateStatus: 'accepted' }))
        .resolves.toBe('email_identity_conflict');
    });

    test('a push fenced out by a newer generation writes NEITHER the retry lane NOR the verdict', async () => {
      const callId = await callRow({}, { generation: 8 });
      await processorTest.pushCallToRetryLaneAfterQuarantineFailure({
        call: { id: callId }, callSid: 'CA-r8-3', procGeneration: 7, reason: 'price_agreed_on_call',
      });
      const live = await liveCall(callId);
      expect(live.processing_status).toBe('processed');
      expect(live.metadata.estimator_quarantine_queue).toBeUndefined();
    });

    test('once exhausted, the drainer resolves the entry: the replay lands and the entry is retired', async () => {
      const callId = await callRow({}, { generation: 7, attempts: CALL_EXTRACTION_MAX_ATTEMPTS - 1 });
      const stale = await estimate(callId, { status: 'sent' });
      await processorTest.pushCallToRetryLaneAfterQuarantineFailure({
        call: { id: callId }, callSid: 'CA-r8-4', procGeneration: 7, reason: 'price_agreed_on_call',
      });
      contextBuilder._private.extractionFromCall.mockReturnValue(AGREED_EXTRACTION);

      // The shared schema carries earlier tests' rows, so the call's own
      // outcome is asserted rather than the sweep-wide count.
      await engine.sweepPendingQuarantines();

      expect((await metadataOf(callId)).estimator_quarantine_queue).toBeUndefined();
      const staleData = await estimateData(stale.id);
      expect(staleData.estimatorEngine.linkage_invalidated_at).toBeTruthy();
      await expect(claimSql.callSideBlockForEstimateData(mockDatabase, staleData, { estimateStatus: 'draft' }))
        .resolves.toBe('price_agreed_on_call');
    });
  });

  describe('P2 — assessment exception provenance survives a skipped linkage', () => {
    test('a provenance-stamped UNLINKED exception draft is never archived by a later agreed-price invalidation', async () => {
      const callId = await callRow({}, { generation: 6 });
      const exception = await estimate(callId, { status: 'draft' });
      const stale = await estimate(callId, { status: 'draft' });
      await expect(predraft.stampAssessmentException(exception.id, {
        callLogId: callId, generation: 5, scheduledServiceId: 'svc-dead',
      })).resolves.toBe(true);

      const outcome = await engine.invalidateDraftForCall(callId, {
        reason: 'price_agreed_on_call',
        scope: 'nonterminal_drafts',
        ownershipFence: { callLogId: callId, procGeneration: 6 },
      });
      expect(outcome).toMatchObject({ ok: true, invalidated: true });

      const exceptionData = await estimateData(exception.id);
      expect(exceptionData.assessment_exception).toMatchObject({ call_log_id: callId, generation: 5, scheduled_service_id: 'svc-dead' });
      expect(exceptionData.estimatorEngine.linkage_invalidated_at).toBeUndefined();
      expect((await mockDatabase('estimates').where({ id: exception.id }).first('archived_at')).archived_at).toBeNull();
      expect((await estimateData(stale.id)).estimatorEngine.linkage_invalidated_at).toBeTruthy();
      // And a QUEUED agreed-price verdict spares it too.
      await engine.markQuarantinePending(callId, 'price_agreed_on_call', { procGeneration: 6 });
      await expect(claimSql.callSideBlockForEstimateData(mockDatabase, exceptionData, { estimateStatus: 'draft' }))
        .resolves.toBeNull();
    });

    test('the first exception provenance is never overwritten by a replay', async () => {
      const callId = await callRow({});
      const exception = await estimate(callId, { status: 'draft' });
      await predraft.stampAssessmentException(exception.id, { callLogId: callId, generation: 5, scheduledServiceId: 'svc-1' });
      await predraft.stampAssessmentException(exception.id, { callLogId: callId, generation: 9, scheduledServiceId: 'svc-2' });
      expect((await estimateData(exception.id)).assessment_exception).toMatchObject({ generation: 5, scheduled_service_id: 'svc-1' });
    });
  });

  describe('P2 — bell retirement is retried from the bell\'s own state', () => {
    const bell = async (callSid, meta) => {
      await mockDatabase('notifications').insert({ id: `n-${randomUUID()}`, metadata: JSON.stringify({ callSid, ...meta }) });
    };

    test('a live engine bell still pointing at a draft the agreed price retired is reported stale', async () => {
      const callId = await callRow({});
      const retired = await estimate(callId, {
        status: 'draft',
        extra: { estimatorEngine: { callLogId: callId, linkage_invalidated_at: '2026-09-25T08:00:00.000Z', invalidation_reason: 'price_agreed_on_call' } },
      });
      await bell('CA-bell-1', { estimator_engine: true, quote_promised: false, estimateId: retired.id });
      await expect(engine.staleDraftBellForCall('CA-bell-1', { reason: 'price_agreed_on_call' })).resolves.toBe(retired.id);
    });

    test('a bell already retired (no estimateId), a bell on a LIVE draft, or another verdict\'s retirement is left alone', async () => {
      const callId = await callRow({});
      await bell('CA-bell-2', { estimator_engine: true, quote_promised: false, estimateId: null });
      await expect(engine.staleDraftBellForCall('CA-bell-2', { reason: 'price_agreed_on_call' })).resolves.toBeNull();

      const live = await estimate(callId, { status: 'draft' });
      await bell('CA-bell-3', { estimator_engine: true, quote_promised: true, estimateId: live.id });
      await expect(engine.staleDraftBellForCall('CA-bell-3', { reason: 'price_agreed_on_call' })).resolves.toBeNull();

      const identity = await estimate(callId, {
        status: 'draft',
        extra: { estimatorEngine: { callLogId: callId, linkage_invalidated_at: 'x', identity_conflict: 'email_identity_conflict' } },
      });
      await bell('CA-bell-4', { estimator_engine: true, quote_promised: false, estimateId: identity.id });
      await expect(engine.staleDraftBellForCall('CA-bell-4', { reason: 'price_agreed_on_call' })).resolves.toBeNull();
    });

    // codex #4815 r9 P2: a request-only earlier engine run, then a pass whose
    // extraction has quote_promised + an agreed price — the processor mints
    // a NEWER generic promised-quote bell before the invalidation. The
    // retirement must rewrite the engine bell that advertises the retired
    // draft, not the newest (generic) bell.
    test('retirement rewrites the bell that references the retired draft, not the newer generic bell (codex #4815 r9 P2)', async () => {
      const callId = await callRow({});
      const retired = await estimate(callId, {
        status: 'draft',
        extra: { estimatorEngine: { callLogId: callId, linkage_invalidated_at: '2026-09-25T08:00:00.000Z', invalidation_reason: 'price_agreed_on_call' } },
      });
      await mockDatabase('notifications').insert({
        id: 'n-engine-r9', title: 'Estimate draft ready', link: '/admin/estimates', created_at: '2026-09-25T07:00:00.000Z',
        read_at: '2026-09-25T07:30:00.000Z',
        metadata: JSON.stringify({ callSid: 'CA-bell-r9', estimator_engine: true, quote_promised: false, estimateId: retired.id }),
      });
      await mockDatabase('notifications').insert({
        id: 'n-generic-r9', title: 'Quote promised on call — send it', link: '/admin/leads', created_at: '2026-09-25T09:00:00.000Z',
        metadata: JSON.stringify({ callSid: 'CA-bell-r9', quote_promised: true }),
      });
      // The retry lookup sees past the newer generic bell too.
      await expect(engine.staleDraftBellForCall('CA-bell-r9', { reason: 'price_agreed_on_call' })).resolves.toBe(retired.id);

      await expect(engine.notify({
        call: { twilio_call_sid: 'CA-bell-r9' },
        title: 'Price agreed on call — send the promised quote',
        body: 'retired',
        estimateId: null,
        quotePromised: true,
        link: '/admin/customers/cust-1',
        forceUpdate: true,
        updateOnly: true,
        retiredByReason: 'price_agreed_on_call',
      })).resolves.toBe(true);

      const engineBell = await mockDatabase('notifications').where({ id: 'n-engine-r9' }).first();
      expect(engineBell.title).toBe('Price agreed on call — send the promised quote');
      expect(engineBell.link).toBe('/admin/customers/cust-1');
      expect(engineBell.read_at).toBeNull();
      expect(engineBell.metadata.estimateId).toBeNull();
      const generic = await mockDatabase('notifications').where({ id: 'n-generic-r9' }).first();
      expect(generic.title).toBe('Quote promised on call — send it');
      expect(generic.link).toBe('/admin/leads');
      // Idempotent: nothing still advertises the retired draft.
      await expect(engine.staleDraftBellForCall('CA-bell-r9', { reason: 'price_agreed_on_call' })).resolves.toBeNull();
    });
  });
});
