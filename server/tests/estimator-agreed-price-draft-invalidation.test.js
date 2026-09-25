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
const mockWhereNotInCalls = [];

jest.mock('../models/db', () => {
  const makeBuilder = (table) => {
    const b = {};
    for (const m of ['where', 'whereRaw', 'orWhere', 'orWhereNull', 'whereNull', 'orderBy', 'select', 'forUpdate', 'limit']) {
      b[m] = (...a) => {
        if (typeof a[0] === 'function') a[0].call(b, b);
        return b;
      };
    }
    // whereNotIn tracked separately (codex #4815 r2 P0 — the scope query
    // filter) so a test can assert both that it was called with the
    // right column/values AND that unscoped callers never call it at all.
    b.whereNotIn = (...a) => { mockWhereNotInCalls.push({ table, args: a }); return b; };
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
const { estimateOffCustomerSurface } = require('../utils/estimate-claim-sql');
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
  mockWhereNotInCalls.length = 0;
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

  test('the ORIGINAL (unscoped) callers never filter by status at the query level — every row is still scanned', async () => {
    await invalidateDraftForCall('call-1', {
      reason: 'email_identity_conflict',
      identityConflict: true,
      ownershipFence: { callLogId: 'call-1', procToken: 'tok-a', procGeneration: 5 },
    });
    expect(mockWhereNotInCalls).toHaveLength(0);
  });
});

// codex #4815 r2 P0: invalidateDraftForCall deliberately touches ACCEPTED
// rows for its two ORIGINAL callers (identity conflict / spam-voicemail
// terminal rejection) — the whole call's identity or workability is in
// question there, so an acceptance built on it must die too. An
// agreed-price cleanup is NOT that kind of verdict: estimateOffCustomerSurface
// reads estimatorEngine.linkage_invalidated_at BEFORE the accepted/declined
// early-allow in isEstimateCustomerViewable, so stamping it on an accepted
// row would revoke a customer's PERMANENT access to an estimate they
// already accepted (or the office manually accepted/declined on their
// behalf) — regardless of a price also being agreed on the call. scope:
// 'nonterminal_drafts' must exclude accepted/declined/expired rows
// entirely from this reason's invalidation.
describe('invalidateDraftForCall(reason: price_agreed_on_call, scope: nonterminal_drafts) — P0 terminal-row exclusion', () => {
  test('a DRAFT row is archived exactly as before — scope does not narrow the ordinary case', async () => {
    const out = await invalidateDraftForCall('call-1', {
      reason: 'price_agreed_on_call',
      scope: 'nonterminal_drafts',
      ownershipFence: { callLogId: 'call-1', procToken: 'tok-a', procGeneration: 5 },
    });

    expect(out).toMatchObject({ ok: true, invalidated: true });
    expect(mockUpdates.estimates).toHaveLength(1);
    expect(JSON.parse(mockUpdates.estimates[0].estimate_data).estimatorEngine.linkage_invalidated_at).toBeTruthy();
  });

  test('the scan itself excludes accepted/declined/expired at the SQL level (whereNotIn), not only the per-row re-check', async () => {
    await invalidateDraftForCall('call-1', {
      reason: 'price_agreed_on_call',
      scope: 'nonterminal_drafts',
      ownershipFence: { callLogId: 'call-1', procToken: 'tok-a', procGeneration: 5 },
    });

    const call = mockWhereNotInCalls.find((c) => c.table === 'estimates');
    expect(call).toBeTruthy();
    const [column, statuses] = call.args;
    expect(column).toBe('status');
    expect([...statuses].sort()).toEqual(['accepted', 'declined', 'expired']);
  });

  test.each(['accepted', 'declined', 'expired'])('an %s estimate is left COMPLETELY untouched — no update, no linkage_invalidated_at, token still viewable', async (status) => {
    const originalEstimateData = { estimatorEngine: { callLogId: 'call-1', lane: 'green' }, lead_id: 'lead-1' };
    mockEstimateRow = draftRow({ status, estimate_data: JSON.stringify(originalEstimateData) });

    const out = await invalidateDraftForCall('call-1', {
      reason: 'price_agreed_on_call',
      scope: 'nonterminal_drafts',
      ownershipFence: { callLogId: 'call-1', procToken: 'tok-a', procGeneration: 5 },
    });

    // Nothing archived — the customer's already-accepted/declined estimate
    // and its lead link are exactly as they were.
    expect(out).toMatchObject({ ok: true, invalidated: false });
    expect(mockUpdates.estimates).toHaveLength(0);
    expect(mockUpdates.leads).toHaveLength(0);

    // The call-level block still lands (a fresh composer is still refused)
    // — only the EXISTING estimate row is protected.
    expect(mockUpdates.call_log.some((u) => typeof u.metadata === 'string' && u.metadata.includes('estimator_draft_block'))).toBe(true);

    // The customer's public token is UNAFFECTED: estimateOffCustomerSurface
    // (the exact predicate isEstimateCustomerViewable checks before its
    // accepted/declined early-allow) still reads clean on the untouched row.
    expect(estimateOffCustomerSurface({ estimate_data: originalEstimateData })).toBe(false);
  });

  test('a concurrent accept between the scan and the per-row lock is re-checked and still refused (defense in depth)', async () => {
    // The initial scan (mocked via .then()) sees a still-draft row, but the
    // per-row locked read (.forUpdate().first()) observes it as freshly
    // accepted — e.g. the customer accepted in the instant between the two
    // reads. The in-transaction re-check must catch this race too.
    mockEstimateRow = draftRow({ status: 'accepted' });

    const out = await invalidateDraftForCall('call-1', {
      reason: 'price_agreed_on_call',
      scope: 'nonterminal_drafts',
      ownershipFence: { callLogId: 'call-1', procToken: 'tok-a', procGeneration: 5 },
    });

    expect(out).toMatchObject({ ok: true, invalidated: false });
    expect(mockUpdates.estimates).toHaveLength(0);
  });
});

// codex #4815 r5 P2: 'nonterminal_drafts' must ALSO exclude a row already
// linked to a live booking via estimate_data.scheduled_service_id — the
// assessment pre-draft exception's own stamp (linkEstimateToBooking). A
// force-reprocess otherwise archived a PRIOR pass's valid assessment draft
// on every replay, because this scope only ever filtered on estimate
// STATUS, never on booking linkage.
describe('invalidateDraftForCall(reason: price_agreed_on_call, scope: nonterminal_drafts) — booking-linked exclusion', () => {
  test('a draft already linked to a booking (scheduled_service_id) is left COMPLETELY untouched', async () => {
    const originalEstimateData = {
      estimatorEngine: { callLogId: 'call-1', lane: 'yellow' },
      scheduled_service_id: 'svc-9',
    };
    mockEstimateRow = draftRow({ status: 'draft', estimate_data: JSON.stringify(originalEstimateData) });

    const out = await invalidateDraftForCall('call-1', {
      reason: 'price_agreed_on_call',
      scope: 'nonterminal_drafts',
      ownershipFence: { callLogId: 'call-1', procToken: 'tok-a', procGeneration: 5 },
    });

    // Nothing archived — the assessment booking's own quote stands.
    expect(out).toMatchObject({ ok: true, invalidated: false });
    expect(mockUpdates.estimates).toHaveLength(0);
    expect(mockUpdates.leads).toHaveLength(0);
    // The call-level block still lands, same as the terminal-row exclusion
    // above — only the linked estimate row itself is protected.
    expect(mockUpdates.call_log.some((u) => typeof u.metadata === 'string' && u.metadata.includes('estimator_draft_block'))).toBe(true);
  });

  test('a booking-predraft linkage that lands between the scan and the per-row lock is re-checked and still refused (defense in depth)', async () => {
    // Same shape as the concurrent-accept race above: the per-row locked
    // read (.forUpdate().first(), mocked to the same live row) observes
    // the linkage even though a bare initial scan would not have excluded
    // it yet.
    mockEstimateRow = draftRow({
      status: 'draft',
      estimate_data: JSON.stringify({
        estimatorEngine: { callLogId: 'call-1', lane: 'yellow' },
        scheduled_service_id: 'svc-9',
      }),
    });

    const out = await invalidateDraftForCall('call-1', {
      reason: 'price_agreed_on_call',
      scope: 'nonterminal_drafts',
      ownershipFence: { callLogId: 'call-1', procToken: 'tok-a', procGeneration: 5 },
    });

    expect(out).toMatchObject({ ok: true, invalidated: false });
    expect(mockUpdates.estimates).toHaveLength(0);
  });

  test('an UNSCOPED caller (identity conflict / rejection) still archives a booking-linked row — the exclusion is price-agreed-only', async () => {
    const originalEstimateData = {
      estimatorEngine: { callLogId: 'call-1', lane: 'yellow' },
      scheduled_service_id: 'svc-9',
    };
    mockEstimateRow = draftRow({ status: 'draft', estimate_data: JSON.stringify(originalEstimateData) });

    const out = await invalidateDraftForCall('call-1', {
      reason: 'email_identity_conflict',
      identityConflict: true,
      ownershipFence: { callLogId: 'call-1', procToken: 'tok-a', procGeneration: 5 },
    });

    expect(out).toMatchObject({ ok: true, invalidated: true });
    expect(mockUpdates.estimates).toHaveLength(1);
  });
});
