/**
 * codex #4815 r1 P1 (finding 3): "invalidate drafts when a reprocess finds
 * an agreed price". reconcileDraftLinksForCall alone only re-links a
 * draft's lead — it does nothing when the lead is unchanged, so a
 * force-reprocess that newly finds an agreed price (owner ruling
 * 2026-09-24) left an existing, possibly differently-priced draft live and
 * sendable, with nothing refusing a detached composer's late insert.
 *
 * The fix (call-recording-processor.js, the price_agreed_on_call skip)
 * reuses the SAME forced-invalidation helper the identity-conflict
 * quarantine and the spam/voicemail terminal verdict already use:
 * invalidateDraftForCall (estimator-engine/index.js) stamps the call-level
 * estimator_draft_block FIRST, then archives every live estimator_engine
 * draft for the call. This test drives that REAL production function, plus
 * the REAL callRejectedForDrafting creator's in-lock fence
 * (admin-estimate-persistence.js) that every draft insert checks, to prove
 * both halves end to end:
 *   1. an existing draft is archived with an explicit reason, and the
 *      call-level block is stamped;
 *   2. once that block is on the call row, a late composer's own insert
 *      check (callRejectedForDrafting) refuses it.
 *
 * Fixtures fictitious (call-1/est-1); no real customer data.
 */

let mockCallRow;
let mockEstimateRow;
const mockUpdates = { call_log: [], estimates: [], leads: [] };

jest.mock('../models/db', () => {
  const makeBuilder = (table) => {
    const b = {};
    for (const m of ['where', 'whereRaw', 'orWhere', 'orWhereNull', 'whereNull', 'orderBy', 'select', 'forUpdate', 'limit']) {
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
      const rows = table === 'estimates' ? (mockEstimateRow ? [mockEstimateRow] : []) : [];
      return Promise.resolve(rows).then(resolve, reject);
    };
    return b;
  };
  const db = (table) => makeBuilder(table);
  // Bindings ride the string (same trick as call-processing-generation.test.js)
  // so assertions can reach the marker JSON without a real jsonb_set.
  db.raw = (sql, bindings) => (bindings ? `${sql}||BIND||${JSON.stringify(bindings)}` : sql);
  db.transaction = async (fn) => fn(db);
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { invalidateDraftForCall } = require('../services/estimator-engine/index');
const { callRejectedForDrafting } = require('../services/admin-estimate-persistence');
const db = require('../models/db');

function draftRow(overrides = {}) {
  return {
    id: 'est-1',
    status: 'draft',
    archived_at: null,
    estimate_data: JSON.stringify({
      estimatorEngine: { callLogId: 'call-1', lane: 'yellow' },
    }),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdates.call_log.length = 0;
  mockUpdates.estimates.length = 0;
  mockUpdates.leads.length = 0;
  mockCallRow = { id: 'call-1', processing_token: 'tok-a', processing_generation: 5, metadata: {} };
  mockEstimateRow = draftRow();
});

describe('invalidateDraftForCall(reason: price_agreed_on_call) — existing draft + reprocess', () => {
  test('archives the existing estimator_engine draft with an explicit reason', async () => {
    const out = await invalidateDraftForCall('call-1', {
      reason: 'price_agreed_on_call',
      ownershipFence: { callLogId: 'call-1', procToken: 'tok-a', procGeneration: 5 },
    });

    expect(out).toMatchObject({ ok: true, invalidated: true });
    expect(mockUpdates.estimates).toHaveLength(1);
    const write = mockUpdates.estimates[0];
    expect(write.archived_at).toBeTruthy();
    expect(write.status).toBe('draft');
    const data = JSON.parse(write.estimate_data);
    expect(data.estimatorEngine.linkage_invalidated_at).toBeTruthy();
    // Not an identity conflict — the audit reason lands in the plain key.
    expect(data.estimatorEngine.invalidation_reason).toBe('price_agreed_on_call');
    expect(data.estimatorEngine.identity_conflict).toBeUndefined();
  });

  test('stamps the call-level estimator_draft_block with the same reason', async () => {
    await invalidateDraftForCall('call-1', {
      reason: 'price_agreed_on_call',
      ownershipFence: { callLogId: 'call-1', procToken: 'tok-a', procGeneration: 5 },
    });

    const blockWrite = mockUpdates.call_log.find((u) => typeof u.metadata === 'string' && u.metadata.includes('estimator_draft_block'));
    expect(blockWrite).toBeTruthy();
    const marker = JSON.parse(JSON.parse(blockWrite.metadata.split('||BIND||')[1])[0]);
    expect(marker.reason).toBe('price_agreed_on_call');
  });

  test('a call with NO existing draft still gets the block stamped (pre-emptive — a fresh pass, nothing to archive yet)', async () => {
    mockEstimateRow = null;

    const out = await invalidateDraftForCall('call-1', {
      reason: 'price_agreed_on_call',
      ownershipFence: { callLogId: 'call-1', procToken: 'tok-a', procGeneration: 5 },
    });

    expect(out).toMatchObject({ ok: true, invalidated: false });
    expect(mockUpdates.estimates).toHaveLength(0);
    expect(mockUpdates.call_log.some((u) => typeof u.metadata === 'string' && u.metadata.includes('estimator_draft_block'))).toBe(true);
  });

  test('late composer insert AFTER the block is refused — callRejectedForDrafting reads the SAME marker the creator fence checks', async () => {
    await invalidateDraftForCall('call-1', {
      reason: 'price_agreed_on_call',
      ownershipFence: { callLogId: 'call-1', procToken: 'tok-a', procGeneration: 5 },
    });

    // Simulate the persisted state a later composer's own in-lock read
    // would see: the metadata this write produced now lives on the row.
    const blockWrite = mockUpdates.call_log.find((u) => typeof u.metadata === 'string' && u.metadata.includes('estimator_draft_block'));
    const marker = JSON.parse(JSON.parse(blockWrite.metadata.split('||BIND||')[1])[0]);
    mockCallRow = { ...mockCallRow, metadata: { estimator_draft_block: marker } };

    const rejection = await callRejectedForDrafting(db, 'call-1', { lockCallRow: true });

    // A truthy reason IS the refusal draft-builder.js and
    // commercial-proposal.js check for before every insert.
    expect(rejection).toBe('price_agreed_on_call');
  });
});
