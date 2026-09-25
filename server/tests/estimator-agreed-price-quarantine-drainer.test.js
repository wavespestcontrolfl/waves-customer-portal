/**
 * codex #4815 r2 P1: when invalidateDraftForCall exhausts its retries (the
 * block-marker write or the strict scan hits a transient DB outage), the
 * price_agreed_on_call skip queues a durable retry via markQuarantinePending
 * — but sweepPendingQuarantines (the scheduler's drainer for that queue)
 * only understood spam/voicemail/no_attribution/identity-conflict reasons.
 * A queued price_agreed_on_call marker fell into the generic rejection
 * branch, which checked callRejectedForDrafting — a function with NO
 * vocabulary for this reason, so it always answered "not rejected" and the
 * drainer read every such marker as "re-qualified", dropping the block
 * WITHOUT ever replaying the invalidation. The stale, differently-priced
 * draft would then stay sendable forever after the very first failed
 * attempt, no matter how many sweeps ran.
 *
 * The fix: sweepPendingQuarantines re-derives the agreed price with the
 * SAME resolveAgreedPriceForCall the engine entry itself checks, and only
 * treats the marker as stale when that now returns null (the extraction
 * was genuinely corrected on a later pass) — otherwise it replays the
 * scoped invalidation exactly like a fresh price_agreed_on_call skip would.
 *
 * Drives the REAL sweepPendingQuarantines + invalidateDraftForCall
 * production functions. Fixtures fictitious (call-1/est-1).
 */

let mockScanRows = [];
let mockCallRow = null;
let mockEstimateRow = null;
const mockUpdates = { call_log: [], estimates: [], leads: [] };

jest.mock('../models/db', () => {
  const makeBuilder = (table) => {
    const b = {};
    for (const m of ['where', 'whereRaw', 'orWhere', 'orWhereRaw', 'orWhereNull', 'whereNull', 'whereNotIn', 'orderBy', 'select', 'forUpdate', 'limit']) {
      b[m] = (...a) => {
        if (typeof a[0] === 'function') a[0].call(b, b);
        return b;
      };
    }
    b.first = async () => {
      if (table === 'call_log') return mockCallRow;
      if (table === 'estimates') return mockEstimateRow;
      return null;
    };
    b.update = async (row) => {
      mockUpdates[table]?.push(row);
      return 1;
    };
    b.then = (resolve, reject) => {
      let rows = [];
      if (table === 'call_log') rows = mockScanRows;
      else if (table === 'estimates') rows = mockEstimateRow ? [mockEstimateRow] : [];
      return Promise.resolve(rows).then(resolve, reject);
    };
    return b;
  };
  const db = (table) => makeBuilder(table);
  db.raw = (sql, bindings) => (bindings ? `${sql}||BIND||${JSON.stringify(bindings)}` : sql);
  db.transaction = async (fn) => fn(db);
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/estimator-engine/context-builder', () => ({
  buildCallContext: jest.fn(),
  existingDraftForCall: jest.fn(async () => null),
  _private: {
    // Mutable per-test — resolveAgreedPriceForCall reads this to decide
    // whether the call STILL carries an agreed price.
    extractionFromCall: jest.fn(() => ({ source: 'none', extraction: null })),
  },
}));

const { sweepPendingQuarantines } = require('../services/estimator-engine/index');
const { _private: contextBuilderPrivate } = require('../services/estimator-engine/context-builder');

function pendingRow() {
  return {
    id: 'call-1',
    metadata: {
      estimator_quarantine_pending: { reason: 'price_agreed_on_call', at: '2026-09-24T20:00:00.000Z' },
      estimator_draft_block: { reason: 'price_agreed_on_call', at: '2026-09-24T20:00:00.000Z', generation: 5 },
    },
  };
}

function settledLiveRow(overrides = {}) {
  return {
    id: 'call-1',
    processing_token: null,
    processing_status: 'processed',
    extraction_attempts: 0,
    created_at: '2026-09-24T19:00:00.000Z',
    processing_generation: 5,
    metadata: {},
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdates.call_log.length = 0;
  mockUpdates.estimates.length = 0;
  mockUpdates.leads.length = 0;
  mockScanRows = [pendingRow()];
  mockCallRow = settledLiveRow();
  mockEstimateRow = null;
  contextBuilderPrivate.extractionFromCall.mockReturnValue({ source: 'none', extraction: null });
});

describe('sweepPendingQuarantines — price_agreed_on_call revalidation (codex #4815 r2 P1)', () => {
  test('the call STILL carries an agreed price ⇒ the verdict stands and the invalidation replays (simulating a fake FAILING first attempt now succeeding on retry)', async () => {
    // The call's V2 extraction still shows the accepted price — same shape
    // resolveAgreedPriceForCall reads off a real call row.
    contextBuilderPrivate.extractionFromCall.mockReturnValue({
      source: 'enriched',
      extraction: { service_request: { price: { amount_usd: 300, accepted: true } } },
    });

    const cleared = await sweepPendingQuarantines();

    expect(cleared).toBe(1);
    // The block was RE-STAMPED (replayed), not dropped.
    const blockWrite = mockUpdates.call_log.find((u) => typeof u.metadata === 'string' && u.metadata.includes('estimator_draft_block'));
    expect(blockWrite).toBeTruthy();
    const marker = JSON.parse(JSON.parse(blockWrite.metadata.split('||BIND||')[1])[0]);
    expect(marker.reason).toBe('price_agreed_on_call');
    // The queue entry is drained only because the replay actually succeeded.
    const queueClear = mockUpdates.call_log.find((u) => typeof u.metadata === 'string' && u.metadata.includes("- 'estimator_quarantine_pending'"));
    expect(queueClear).toBeTruthy();
  });

  test('the replay is SCOPED to non-terminal drafts — never an accepted/declined/expired row, even on retry', async () => {
    contextBuilderPrivate.extractionFromCall.mockReturnValue({
      source: 'enriched',
      extraction: { service_request: { price: { amount_usd: 300, accepted: true } } },
    });
    mockEstimateRow = {
      id: 'est-1',
      status: 'accepted',
      archived_at: null,
      estimate_data: JSON.stringify({ estimatorEngine: { callLogId: 'call-1' } }),
    };

    await sweepPendingQuarantines();

    // The accepted estimate must never be archived by the replay.
    expect(mockUpdates.estimates).toHaveLength(0);
  });

  test('a LATER pass corrected the extraction — no agreed price anymore ⇒ genuinely re-qualified, block dropped WITHOUT replaying', async () => {
    contextBuilderPrivate.extractionFromCall.mockReturnValue({
      source: 'enriched',
      extraction: { service_request: { quote_requested: true } },
    });

    const cleared = await sweepPendingQuarantines();

    expect(cleared).toBe(0);
    const blockClear = mockUpdates.call_log.find((u) => typeof u.metadata === 'string' && u.metadata.includes("- 'estimator_draft_block'"));
    expect(blockClear).toBeTruthy();
    const queueClear = mockUpdates.call_log.find((u) => typeof u.metadata === 'string' && u.metadata.includes("- 'estimator_quarantine_pending'"));
    expect(queueClear).toBeTruthy();
    // No re-invalidation write was attempted — this is a pure drop.
    expect(mockUpdates.estimates).toHaveLength(0);
  });

  test('regression pin: a queued marker with an agreed price is REPLAYED even though callRejectedForDrafting (spam/voicemail/no_attribution/identity vocabulary only) would answer "not rejected" for it', async () => {
    // Prove the fix is not incidental: independently confirm the real
    // callRejectedForDrafting genuinely has nothing to say about this call
    // (a processed, non-spam, non-identity-conflict row) — if the drainer
    // were still routing this reason through it (the pre-fix bug), THIS
    // call would read "not rejected" and the sweep would drop the block
    // instead of replaying, contradicting the previous test's assertion.
    const { callRejectedForDrafting } = require('../services/admin-estimate-persistence');
    const rejection = await callRejectedForDrafting(require('../models/db'), 'call-1', { ignoreQueuedMarkers: true });
    expect(rejection).toBeNull();

    contextBuilderPrivate.extractionFromCall.mockReturnValue({
      source: 'enriched',
      extraction: { service_request: { price: { amount_usd: 300, accepted: true } } },
    });

    const cleared = await sweepPendingQuarantines();

    // Despite callRejectedForDrafting saying "not rejected" above, the
    // sweep still REPLAYED (not dropped) because it checked the agreed
    // price instead.
    expect(cleared).toBe(1);
  });
});
