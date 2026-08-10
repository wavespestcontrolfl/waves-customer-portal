/**
 * processing_generation — the per-call monotonic pass counter (PR #3304).
 *
 * A cleared processing_token cannot distinguish "my own pass finalized
 * normally" (the detached composer legitimately keeps writing) from "a
 * NEWER pass claimed and finalized since" (my writes are stale). The claim
 * write bumps call_log.processing_generation; ownership fences compare
 * generations instead of interpreting token-NULL:
 *  - invalidateDraftForCall / markDraftBlockOnCall: fence = token match OR
 *    same generation (legacy fences without one keep the token-NULL arm);
 *  - staleCallLinkageReason: ownedByCaller has the same generation arm;
 *  - callSideBlockForEstimateData: rejects a LIVE token and compares live
 *    linkage (the estimate-side fallback guard's two markers alone miss a
 *    verdict that is mid-write);
 *  - sweepPendingReconciles: durable retry for reconcile-only failures;
 *  - callPassStillOwned: the every-call-origin-insert fence — lead-less
 *    and phone_touched composers (residential + commercial) compare pass
 *    identity too, and slot reservation locks the call row through its
 *    verdict + hold commit.
 */

const mockUpdates = [];
let mockCallRow = null;
let mockEstimateRows = [];
let mockScanRows = [];
let mockReconcilePendingRows = [];

jest.mock('../models/db', () => {
  const makeBuilder = (table) => {
    const b = { _calls: [] };
    for (const m of ['where', 'whereNull', 'orWhere', 'orWhereNull', 'whereRaw', 'orWhereRaw', 'whereIn', 'whereNot', 'from', 'forUpdate', 'orderBy', 'limit', 'select']) {
      b[m] = (...a) => {
        if (typeof a[0] === 'function') a[0].call(b, b);
        b._calls.push([m, ...a]);
        return b;
      };
    }
    b.first = async () => {
      if (table === 'call_log') return mockCallRow;
      return null;
    };
    b.update = async (row) => {
      mockUpdates.push({ table, calls: b._calls.slice(), row });
      // The fence predicate is enforced by the harness: a call_log write
      // whose fence cannot match the mock row reports 0 rows, like PG.
      if (table === 'call_log' && mockCallRow?.__fenceMiss) return 0;
      return 1;
    };
    b.then = (resolve, reject) => {
      const rows = table === 'estimates' ? mockEstimateRows
        : table === 'call_log' ? mockScanRows : [];
      return Promise.resolve(rows).then(resolve, reject);
    };
    return b;
  };
  const db = (table) => makeBuilder(table);
  // Bindings ride the string so assertions can reach the marker JSON.
  db.raw = (sql, bindings) => (bindings ? `${sql}||BIND||${JSON.stringify(bindings)}` : sql);
  db.transaction = async (fn) => fn(db);
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/estimator-engine/context-builder', () => ({
  buildCallContext: jest.fn(),
  existingDraftForCall: jest.fn(async () => null),
  loadCustomerByPhone: jest.fn(),
  loadPriorEstimates: jest.fn(),
  loadSmsThread: jest.fn(),
  _private: {},
}));
jest.mock('../services/estimator-engine/source-arbitration', () => ({ resolvePropertyFacts: jest.fn(), normalizeParcelView: jest.fn() }));
jest.mock('../services/estimator-engine/intent-composer', () => ({ composeIntent: jest.fn() }));
jest.mock('../services/estimator-engine/draft-builder', () => ({
  LANES: { GREEN: 'green', YELLOW: 'yellow', RED: 'red' },
  buildEngineInput: jest.fn(),
  deriveTotals: jest.fn(),
  compsBand: jest.fn(),
  calibrationWarnings: jest.fn(),
  classifyLane: jest.fn(),
  createDraftEstimate: jest.fn(),
}));

const { invalidateDraftForCall, sweepPendingReconciles, sweepPendingQuarantines } = require('../services/estimator-engine/index');
const { callSideBlockForEstimateData } = require('../utils/estimate-claim-sql');

const fenceUpdateFor = (marker) => mockUpdates.find((u) => u.table === 'call_log'
  && typeof u.row?.metadata === 'string' && u.row.metadata.includes(marker));

const fencePredicates = (update) => update.calls
  .filter(([m]) => ['where', 'orWhere', 'orWhereNull', 'whereNull'].includes(m))
  .map((c) => c.slice(0, 3));

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdates.length = 0;
  mockCallRow = { id: 'call-1', processing_token: null, processing_generation: 7, metadata: {} };
  mockEstimateRows = [];
  mockScanRows = [];
  mockReconcilePendingRows = [];
});

describe('invalidateDraftForCall ownership fence (generation arm)', () => {
  test('a fence WITH a generation swaps the token-NULL arm for the generation compare', async () => {
    const out = await invalidateDraftForCall('call-1', {
      reason: 'call_rejected_spam',
      ownershipFence: { callLogId: 'call-1', procToken: 'tok-a', procGeneration: 7 },
    });

    expect(out.ok).toBe(true);
    const blockWrite = fenceUpdateFor('estimator_draft_block');
    expect(blockWrite).toBeTruthy();
    const preds = fencePredicates(blockWrite);
    expect(preds).toContainEqual(['where', 'processing_token', 'tok-a']);
    expect(preds).toContainEqual(['orWhere', 'processing_generation', 7]);
    expect(preds).not.toContainEqual(['orWhereNull', 'processing_token']);
    // The marker records its writer's generation.
    const markerBindings = JSON.parse(blockWrite.row.metadata.split('||BIND||')[1] || '[]');
    expect(JSON.parse(markerBindings[0] || '{}')).toMatchObject({ reason: 'call_rejected_spam', generation: 7 });
  });

  test('a legacy fence (no generation) keeps the token-NULL arm', async () => {
    await invalidateDraftForCall('call-1', {
      reason: 'call_rejected_spam',
      ownershipFence: { callLogId: 'call-1', procToken: 'tok-a' },
    });

    const blockWrite = fenceUpdateFor('estimator_draft_block');
    const preds = fencePredicates(blockWrite);
    expect(preds).toContainEqual(['orWhereNull', 'processing_token']);
    expect(preds.some(([m, col]) => m === 'orWhere' && col === 'processing_generation')).toBe(false);
  });

  test('a stale worker (fence misses — newer generation claimed since) is refused as ownershipLost', async () => {
    mockCallRow.__fenceMiss = true;

    const out = await invalidateDraftForCall('call-1', {
      reason: 'email_identity_conflict',
      identityConflict: true,
      ownershipFence: { callLogId: 'call-1', procToken: 'tok-stale', procGeneration: 6 },
    });

    expect(out).toMatchObject({ ok: true, invalidated: false, ownershipLost: true });
  });
});

describe('sweepPendingReconciles', () => {
  const PENDING_ROW = () => ({
    id: 'call-1',
    metadata: { estimator_reconcile_pending: { at: '2026-08-10T01:00:00.000Z' } },
  });

  test('an in-flight call defers — the live pass owns the reconcile', async () => {
    mockScanRows = [PENDING_ROW()];
    mockCallRow = { id: 'call-1', processing_token: 'tok-live', processing_status: 'processing', metadata: {} };

    const cleared = await sweepPendingReconciles();

    expect(cleared).toBe(0);
    expect(mockUpdates.filter((u) => u.table === 'call_log')).toHaveLength(0);
  });

  test('a settled call re-runs the reconcile and clears the marker on a non-error outcome', async () => {
    mockScanRows = [PENDING_ROW()];
    // Settled: token null, terminal status. The reconcile itself finds no
    // draft (existingDraftForCall mocked null) — a valid, complete outcome.
    mockCallRow = {
      id: 'call-1', processing_token: null, processing_status: 'processed',
      extraction_attempts: 0, created_at: '2026-08-01T00:00:00.000Z', metadata: {},
    };

    const cleared = await sweepPendingReconciles();

    expect(cleared).toBe(1);
    const clearWrite = mockUpdates.find((u) => u.table === 'call_log'
      && typeof u.row?.metadata === 'string' && u.row.metadata.includes("- 'estimator_reconcile_pending'"));
    expect(clearWrite).toBeTruthy();
    // CAS on the stamped instant — a marker replaced by a newer failure
    // is not cleared by this drain.
    expect(clearWrite.calls).toContainEqual(
      ['whereRaw', "metadata->'estimator_reconcile_pending'->>'at' = ?", ['2026-08-10T01:00:00.000Z']],
    );
  });
});

describe('sweepPendingQuarantines re-qualification clears the draft block too', () => {
  test('rejection → requalification retires BOTH markers with the live generation', async () => {
    // A queued spam quarantine whose call was since re-qualified: the
    // sweep must not clear only its own queue entry — the durable
    // estimator_draft_block written alongside the rejection would keep
    // every draft creator and public-estimate guard failing closed
    // forever (pre-push P1, PR #3304).
    mockScanRows = [{
      id: 'call-1',
      metadata: {
        estimator_quarantine_pending: { reason: 'call_rejected_spam', at: '2026-08-10T01:00:00.000Z' },
        estimator_draft_block: { reason: 'call_rejected_spam', at: '2026-08-10T01:00:00.000Z', generation: 8 },
      },
    }];
    // Settled + re-qualified: token null, terminal 'processed', no
    // no_attribution marker — callRejectedForDrafting returns null.
    mockCallRow = {
      id: 'call-1', processing_token: null, processing_status: 'processed',
      extraction_attempts: 0, created_at: '2026-08-01T00:00:00.000Z',
      processing_generation: 9, metadata: {},
    };

    await sweepPendingQuarantines();

    const blockClear = mockUpdates.find((u) => u.table === 'call_log'
      && typeof u.row?.metadata === 'string' && u.row.metadata.includes("- 'estimator_draft_block'"));
    expect(blockClear).toBeTruthy();
    // The clear rode the call's LIVE generation, so the gen-8 marker is
    // clearable while a hypothetical newer one would survive.
    expect(blockClear.calls.some(([m, , bindings]) => m === 'whereRaw'
      && Array.isArray(bindings) && bindings[0] === 9)).toBe(true);
    const queueClear = mockUpdates.find((u) => u.table === 'call_log'
      && typeof u.row?.metadata === 'string' && u.row.metadata.includes("- 'estimator_quarantine_pending'"));
    expect(queueClear).toBeTruthy();
  });

  const IDENTITY_PENDING_ROW = () => ({
    id: 'call-1',
    metadata: {
      estimator_quarantine_pending: { reason: 'email_identity_conflict', at: '2026-08-10T01:00:00.000Z' },
    },
  });
  const SETTLED_LIVE_ROW = () => ({
    id: 'call-1', processing_token: null, processing_status: 'processed',
    extraction_attempts: 0, created_at: '2026-08-01T00:00:00.000Z',
    processing_generation: 9, metadata: {},
  });

  test('identity conflict + TRANSIENT revalidation failure DEFERS — the obsolete verdict is never replayed', async () => {
    // A newer pass may have re-qualified the call; a context failure like
    // customer_lookup_unavailable proves nothing about the conflict, and
    // replaying the queued verdict would archive the valid replacement
    // draft. The queue entry itself keeps every guard failing closed
    // until a sweep can actually re-verify.
    mockScanRows = [IDENTITY_PENDING_ROW()];
    mockCallRow = SETTLED_LIVE_ROW();
    const { buildCallContext } = require('../services/estimator-engine/context-builder');
    buildCallContext.mockResolvedValue({ error: 'customer_lookup_unavailable' });

    const cleared = await sweepPendingQuarantines();

    expect(cleared).toBe(0);
    expect(mockUpdates.filter((u) => u.table === 'call_log')).toHaveLength(0);
  });

  test('a RE-OBSERVED identity conflict still replays the forced invalidation and drains the queue', async () => {
    mockScanRows = [IDENTITY_PENDING_ROW()];
    mockCallRow = SETTLED_LIVE_ROW();
    const { buildCallContext } = require('../services/estimator-engine/context-builder');
    buildCallContext.mockResolvedValue({ error: 'email_identity_conflict', call: { id: 'call-1' } });

    const cleared = await sweepPendingQuarantines();

    expect(cleared).toBe(1);
    expect(fenceUpdateFor('estimator_draft_block')).toBeTruthy();
    const queueClear = mockUpdates.find((u) => u.table === 'call_log'
      && typeof u.row?.metadata === 'string' && u.row.metadata.includes("- 'estimator_quarantine_pending'"));
    expect(queueClear).toBeTruthy();
  });
});

describe('callSideBlockForEstimateData (live token + linkage compare)', () => {
  const dbcFor = ({ callRow, sidLead = null, stampLead = null, throwOnCall = false }) => (table) => {
    const b = { _wheres: [] };
    for (const m of ['where', 'whereNull', 'orderBy']) {
      b[m] = (...a) => { b._wheres.push([m, ...a]); return b; };
    }
    b.first = async () => {
      if (throwOnCall) throw new Error('db down');
      if (table === 'call_log') return callRow;
      if (table === 'leads') {
        const bySid = b._wheres.find(([m, a]) => m === 'where' && a && typeof a === 'object' && 'twilio_call_sid' in a);
        if (bySid) return sidLead;
        return stampLead;
      }
      return null;
    };
    return b;
  };
  const DATA = (over = {}) => ({
    lead_id: 'lead-B',
    lead_linkage: 'stamp',
    estimatorEngine: { callLogId: 'call-1' },
    ...over,
  });

  test('a persisted marker wins first, unchanged', async () => {
    const dbc = dbcFor({ callRow: { metadata: { estimator_draft_block: { reason: 'email_identity_conflict' } }, processing_token: 'tok' } });
    expect(await callSideBlockForEstimateData(dbc, DATA())).toBe('email_identity_conflict');
  });

  test('a LIVE processing_token fails closed — the verdict is mid-decision', async () => {
    const dbc = dbcFor({ callRow: { metadata: {}, processing_token: 'tok-live', twilio_call_sid: null } });
    expect(await callSideBlockForEstimateData(dbc, DATA())).toBe('call_reprocessing');
  });

  test('a QUEUED retry (token NULL, budgeted extraction_failed) is in-flight, not settled', async () => {
    // The queue-to-claim window: the retry that will claim this row can
    // change the call's identity and linkage — public reads and the
    // deposit confirm must fail closed through it (pre-push P0).
    const dbc = dbcFor({
      callRow: {
        metadata: {}, processing_token: null, twilio_call_sid: null,
        processing_status: 'extraction_failed', extraction_attempts: 0,
        created_at: new Date().toISOString(),
      },
    });
    expect(await callSideBlockForEstimateData(dbc, DATA())).toBe('call_reprocessing');
  });

  test('an EXHAUSTED retry row is settled — the linkage compare decides', async () => {
    const dbc = dbcFor({
      callRow: {
        metadata: { lead_id: 'lead-B' }, processing_token: null, twilio_call_sid: null,
        processing_status: 'extraction_failed', extraction_attempts: 99,
        created_at: new Date().toISOString(),
      },
      stampLead: { id: 'lead-B' },
    });
    expect(await callSideBlockForEstimateData(dbc, DATA())).toBeNull();
  });

  test('a durably linked draft whose call now resolves a DIFFERENT lead is blocked', async () => {
    const dbc = dbcFor({
      callRow: { metadata: { lead_id: 'lead-C' }, processing_token: null, twilio_call_sid: null },
      stampLead: { id: 'lead-C' },
    });
    expect(await callSideBlockForEstimateData(dbc, DATA())).toBe('call_linkage_changed');
  });

  test('the sid-owned lead outranks the stamp — same precedence as the canonical loader', async () => {
    const dbc = dbcFor({
      callRow: { metadata: { lead_id: 'lead-B' }, processing_token: null, twilio_call_sid: 'CA-1' },
      sidLead: { id: 'lead-A' },
      stampLead: { id: 'lead-B' },
    });
    expect(await callSideBlockForEstimateData(dbc, DATA())).toBe('call_linkage_changed');
  });

  test('a matching live linkage passes', async () => {
    const dbc = dbcFor({
      callRow: { metadata: { lead_id: 'lead-B' }, processing_token: null, twilio_call_sid: null },
      stampLead: { id: 'lead-B' },
    });
    expect(await callSideBlockForEstimateData(dbc, DATA())).toBeNull();
  });

  test('a lead-less / non-durable draft skips the linkage compare', async () => {
    const dbc = dbcFor({ callRow: { metadata: {}, processing_token: null, twilio_call_sid: null } });
    expect(await callSideBlockForEstimateData(dbc, DATA({ lead_id: null, lead_linkage: null }))).toBeNull();
  });

  test('a transient error still fails closed', async () => {
    const dbc = dbcFor({ callRow: null, throwOnCall: true });
    expect(await callSideBlockForEstimateData(dbc, DATA())).toBe('call_verdict_unavailable');
  });
});

describe('callPassStillOwned — the every-call-origin-insert fence', () => {
  const dbcFor = (callRow) => (table) => {
    const b = {};
    b.where = () => b;
    b.first = async () => (table === 'call_log' ? callRow : null);
    return b;
  };
  const ROW = (generation, token = null) => ({ processing_token: token, processing_generation: generation });

  test('no pass identity at all = nothing to compare — owned (legacy entry points)', async () => {
    const { callPassStillOwned } = require('../utils/estimate-claim-sql');
    expect(await callPassStillOwned(dbcFor(ROW(7)), 'call-1', {})).toBe(true);
  });

  test('a live token match is in-flight me — owned', async () => {
    const { callPassStillOwned } = require('../utils/estimate-claim-sql');
    expect(await callPassStillOwned(dbcFor(ROW(7, 'tok-a')), 'call-1', {
      ownerProcToken: 'tok-a', ownerProcGeneration: null,
    })).toBe(true);
  });

  test('same generation with the token gone = my own finalization — still owned', async () => {
    const { callPassStillOwned } = require('../utils/estimate-claim-sql');
    expect(await callPassStillOwned(dbcFor(ROW(7)), 'call-1', {
      ownerProcToken: 'tok-gone', ownerProcGeneration: 7,
    })).toBe(true);
  });

  test('a NEWER generation = a later pass claimed since — not owned', async () => {
    const { callPassStillOwned } = require('../utils/estimate-claim-sql');
    expect(await callPassStillOwned(dbcFor(ROW(8)), 'call-1', {
      ownerProcToken: 'tok-gone', ownerProcGeneration: 7,
    })).toBe(false);
  });

  test('a missing call row is never owned — no provenance to insert against', async () => {
    const { callPassStillOwned } = require('../utils/estimate-claim-sql');
    expect(await callPassStillOwned(dbcFor(null), 'call-1', {
      ownerProcToken: 'tok-a', ownerProcGeneration: 7,
    })).toBe(false);
  });
});

describe('generation fence + call-lock wiring (source pins)', () => {
  // The creators' fences and the reservation's call lock live inside heavily
  // mocked transactions no unit suite executes end-to-end — pin the wiring in
  // source. Full-source indexOf ordering, never slices (a 600-char slice
  // truncated a predicate pin in a prior round and silently pinned nothing).
  const fs = require('fs');
  const path = require('path');
  const src = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

  test('createDraftEstimate fences EVERY call-origin insert, before the sid/stamp branch', () => {
    const source = src('../services/estimator-engine/draft-builder.js');
    const fenceAt = source.indexOf('callPassStillOwned(trx, call.id');
    expect(fenceAt).toBeGreaterThan(-1);
    expect(source).toContain("reason: 'stale_processing_generation'");
    // After the rejected check (whose lockCallRow holds the row for the
    // compare), before the sid/stamp-only linkage branch — matched FROM the
    // fence (the same predicate string appears earlier in the guarded
    // lead-link writer).
    expect(source.indexOf('callRejectedForDrafting(trx, call.id')).toBeLessThan(fenceAt);
    expect(source.indexOf("['sid', 'stamp'].includes(context?.leadLinkage)", fenceAt)).toBeGreaterThan(fenceAt);
  });

  test('the commercial scaffold carries the same fence', () => {
    const source = src('../services/estimator-engine/commercial-proposal.js');
    const fenceAt = source.indexOf('callPassStillOwned(trx, call.id');
    expect(fenceAt).toBeGreaterThan(-1);
    expect(source).toContain("staleLinkage: 'stale_processing_generation'");
    expect(source.indexOf('callRejectedForDrafting(trx, call.id')).toBeLessThan(fenceAt);
    expect(source.indexOf("['sid', 'stamp'].includes(context?.leadLinkage)", fenceAt)).toBeGreaterThan(fenceAt);
  });

  test('slot reservation locks the call row FOR UPDATE before its verdict and holds it through the commit', () => {
    const source = src('../services/slot-reservation.js');
    const lockAt = source.indexOf("trx('call_log').where({ id: eng.callLogId }).forUpdate()");
    expect(lockAt).toBeGreaterThan(-1);
    expect(lockAt).toBeLessThan(source.indexOf('callSideBlockForEstimateData(trx, reservationData)'));
  });

  test('the reconcile-only entry enumerates EVERY live same-call draft', () => {
    // Historical races can leave several uninvalidated estimates carrying
    // one callLogId; a singular lookup reconciled one arbitrary row and
    // left the rest with live public tokens.
    const source = src('../services/estimator-engine/index.js');
    const entryAt = source.indexOf('async function reconcileDraftLinksForCall');
    expect(entryAt).toBeGreaterThan(-1);
    expect(source.indexOf('strictExistingDraftForCall(callLogId)', entryAt)).toBeGreaterThan(entryAt);
    expect(source.indexOf('reconcileAllDraftLinks(existingRows', entryAt)).toBeGreaterThan(entryAt);
    // ANY row's 'error' keeps the caller's durable retry marker.
    expect(source).toContain("if (rowOutcome === 'error') outcome = 'error'");
  });

  test('the booking pre-draft delegation carries a pass identity', () => {
    const processor = src('../services/call-recording-processor.js');
    const hookAt = processor.indexOf('maybePreDraftForBooking(preDraftBookingId, {');
    expect(hookAt).toBeGreaterThan(-1);
    expect(processor.indexOf('ownerProcGeneration: procGeneration', hookAt)).toBeGreaterThan(hookAt);
  });
});

describe('staleCallLinkageReason ownedByCaller generation arm', () => {
  // Required lazily so the shared db mock above satisfies its module load.
  const { staleCallLinkageReason } = require('../services/admin-estimate-persistence');

  const dbcFor = (callRow) => (table) => {
    const b = {};
    for (const m of ['where', 'whereNull', 'orderBy', 'forUpdate']) {
      b[m] = () => b;
    }
    b.first = async () => (table === 'call_log' ? callRow : null);
    return b;
  };
  // In-flight shape WITHOUT a token: a budgeted extraction_failed retry —
  // exactly the state where token comparison says nothing and only the
  // generation can prove ownership.
  const RETRY_ROW = (generation) => ({
    twilio_call_sid: null,
    metadata: {},
    processing_token: null,
    processing_status: 'extraction_failed',
    extraction_attempts: 0,
    created_at: new Date().toISOString(),
    processing_generation: generation,
  });
  const DATA = { estimatorEngine: { callLogId: 'call-1' } };

  test('same generation = owned — the reprocessing gate does not fire', async () => {
    const reason = await staleCallLinkageReason(dbcFor(RETRY_ROW(7)), DATA, {
      ownerProcToken: 'tok-gone', ownerProcGeneration: 7,
    });
    expect(reason).toBeNull();
  });

  test('a newer generation = not owned — fails closed on the in-flight retry', async () => {
    const reason = await staleCallLinkageReason(dbcFor(RETRY_ROW(8)), DATA, {
      ownerProcToken: 'tok-gone', ownerProcGeneration: 7,
    });
    expect(reason).toBe('call_reprocessing_before_delivery');
  });

  test('no owner claim at all keeps the existing fail-closed behavior', async () => {
    const reason = await staleCallLinkageReason(dbcFor(RETRY_ROW(7)), DATA, {});
    expect(reason).toBe('call_reprocessing_before_delivery');
  });
});
