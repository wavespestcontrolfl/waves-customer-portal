// sweepWedgedPendingInvalidations — the crash-recovery half of the
// deferred-invalidation protocol (codex P1, PR #3304 GH r7).
//
// The reconciler records `invalidation_pending_*` when a delivery claim is
// live, and the send's claim release completes it. A crash between the two
// leaves the estimate wedged: every send aborts on the pending marker with
// a non-matching claim token, the former lead stays linked, and no
// corrected rebuild exists. The scheduler's stale-claim recovery calls this
// sweep to finish the transition once the claim ages past its TTL.

let candidateRows = [];
let lockedRow = null;
// Per-table .first() overrides for the linkage-obsolescence re-resolution
// (call_log + leads); estimates always answers with lockedRow.
let firstByTable = {};
const estimateUpdates = [];
const leadUpdates = [];

const mockDb = jest.fn((table) => {
  const b = {};
  for (const m of ['where', 'whereRaw', 'whereNull', 'forUpdate', 'select', 'orderBy', 'limit']) {
    b[m] = jest.fn(() => b);
  }
  b.first = jest.fn(async () => {
    if (table === 'estimates') return lockedRow;
    return firstByTable[table] !== undefined ? firstByTable[table] : null;
  });
  b.update = jest.fn(async (row) => {
    (table === 'leads' ? leadUpdates : estimateUpdates).push(row);
    return 1;
  });
  b.then = (res, rej) => Promise.resolve(table === 'estimates' ? candidateRows : []).then(res, rej);
  return b;
});
mockDb.fn = { now: () => 'NOW()' };
mockDb.transaction = jest.fn(async (fn) => fn(mockDb));
mockDb.raw = jest.fn((sql) => sql);

jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { sweepWedgedPendingInvalidations, ESTIMATE_DELIVERY_CLAIM_TTL_MS } = require('../services/admin-estimate-persistence');

const NOW = Date.parse('2026-08-09T04:00:00.000Z');
const STALE_CLAIM = new Date(NOW - ESTIMATE_DELIVERY_CLAIM_TTL_MS - 60000).toISOString();
const FRESH_CLAIM = new Date(NOW - 30000).toISOString();

function pendingRow({ status = 'sent', claimAt = STALE_CLAIM } = {}) {
  return {
    id: 'est-1',
    status,
    archived_at: null,
    estimate_data: JSON.stringify({
      lead_id: 'lead-A',
      lead_linkage: 'stamp',
      estimatorEngine: {
        callLogId: 'call-1',
        delivering_at: claimAt,
        delivering_token: 'tok-dead',
        invalidation_pending_at: '2026-08-09T03:40:00.000Z',
        invalidation_pending_from: 'lead-A',
        invalidation_pending_to: 'lead-C',
      },
    }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  candidateRows = [{ id: 'est-1' }];
  lockedRow = pendingRow();
  firstByTable = {};
  estimateUpdates.length = 0;
  leadUpdates.length = 0;
});

describe('sweepWedgedPendingInvalidations', () => {
  test('a DEAD claim finalizes the invalidation: marker, archive, unlink', async () => {
    const finalized = await sweepWedgedPendingInvalidations(NOW);

    expect(finalized).toBe(1);
    const write = estimateUpdates[estimateUpdates.length - 1];
    const data = JSON.parse(write.estimate_data);
    expect(data.estimatorEngine.linkage_invalidated_at).toBeTruthy();
    expect(data.estimatorEngine.linkage_invalidated_from).toBe('lead-A');
    expect(data.estimatorEngine.invalidation_pending_at).toBeUndefined();
    expect(data.estimatorEngine.delivering_token).toBeUndefined();
    expect(data.lead_id).toBeUndefined();
    expect(write.archived_at).toBeTruthy();
    expect(write.status).toBe('draft');
    expect(leadUpdates).toContainEqual({ estimate_id: null });
  });

  test('a FRESH claim is left alone — the owning send still finalizes it', async () => {
    lockedRow = pendingRow({ claimAt: FRESH_CLAIM });

    const finalized = await sweepWedgedPendingInvalidations(NOW);

    expect(finalized).toBe(0);
    expect(estimateUpdates).toHaveLength(0);
  });

  test('a money-bearing terminal keeps its status and archive state — marker only', async () => {
    lockedRow = pendingRow({ status: 'accepted' });

    const finalized = await sweepWedgedPendingInvalidations(NOW);

    expect(finalized).toBe(1);
    const write = estimateUpdates[estimateUpdates.length - 1];
    expect(write.archived_at).toBeUndefined();
    expect(write.status).toBeUndefined();
    expect(JSON.parse(write.estimate_data).estimatorEngine.linkage_invalidated_at).toBeTruthy();
  });

  test('an already-invalidated row is skipped (idempotent across sweeps)', async () => {
    const row = pendingRow();
    const data = JSON.parse(row.estimate_data);
    data.estimatorEngine.linkage_invalidated_at = '2026-08-09T03:50:00.000Z';
    lockedRow = { ...row, estimate_data: JSON.stringify(data) };

    const finalized = await sweepWedgedPendingInvalidations(NOW);

    expect(finalized).toBe(0);
    expect(estimateUpdates).toHaveLength(0);
  });
});

describe('forced quarantines are never discarded as obsolete (codex P0, PR #3304 GH r8b)', () => {
  function forcedRow(engineExtra) {
    return {
      id: 'est-1',
      status: 'sent',
      archived_at: null,
      estimate_data: JSON.stringify({
        lead_id: 'lead-A',
        lead_linkage: 'stamp',
        estimatorEngine: {
          callLogId: 'call-1',
          delivering_at: STALE_CLAIM,
          delivering_token: 'tok-dead',
          invalidation_pending_at: '2026-08-09T03:40:00.000Z',
          ...engineExtra,
        },
      }),
    };
  }

  test('a spam/voicemail rejection finalizes even though the linkage never moved', async () => {
    // The verdict is about the CALL, not about which lead it points at —
    // an unchanged linkage must not read as "nothing to do", or the
    // rejected draft stays public and sendable.
    lockedRow = forcedRow({ invalidation_pending_reason: 'call_rejected_spam' });

    const finalized = await sweepWedgedPendingInvalidations(NOW);

    expect(finalized).toBe(1);
    const write = estimateUpdates[estimateUpdates.length - 1];
    const data = JSON.parse(write.estimate_data);
    expect(data.estimatorEngine.linkage_invalidated_at).toBeTruthy();
    expect(data.estimatorEngine.invalidation_reason).toBe('call_rejected_spam');
    expect(write.archived_at).toBeTruthy();
  });

  test('an identity conflict finalizes with its audit reason intact', async () => {
    lockedRow = forcedRow({ invalidation_pending_conflict: 'email_identity_conflict' });

    const finalized = await sweepWedgedPendingInvalidations(NOW);

    expect(finalized).toBe(1);
    const data = JSON.parse(estimateUpdates[estimateUpdates.length - 1].estimate_data);
    expect(data.estimatorEngine.linkage_invalidated_at).toBeTruthy();
    expect(data.estimatorEngine.identity_conflict).toBe('email_identity_conflict');
  });

  test('a pure linkage repoint whose target came back IS discarded as obsolete', async () => {
    lockedRow = forcedRow({
      invalidation_pending_from: 'lead-A',
      invalidation_pending_to: 'lead-C',
    });
    // The live call linkage still names lead-A (a later retry restored it).
    firstByTable.call_log = {
      twilio_call_sid: null,
      metadata: JSON.stringify({ lead_id: 'lead-A' }),
      processing_token: null,
      processing_status: 'processed',
      extraction_attempts: 0,
    };
    firstByTable.leads = { id: 'lead-A' };

    const finalized = await sweepWedgedPendingInvalidations(NOW);

    expect(finalized).toBe(0);
    const write = estimateUpdates[estimateUpdates.length - 1];
    const data = JSON.parse(write.estimate_data);
    expect(data.estimatorEngine.linkage_invalidated_at).toBeUndefined();
    expect(data.estimatorEngine.invalidation_pending_at).toBeUndefined();
    expect(data.lead_id).toBe('lead-A');
    expect(write.archived_at).toBeUndefined();
  });
});
