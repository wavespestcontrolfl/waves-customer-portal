// reconcileExistingDraftLinks — concurrent-reconciliation safety (PR #3304).
// The cleanup must key off the LOCKED row's linkage: with two concurrent
// reconciles, the loser's pre-transaction snapshot lead is stale, and
// unlinking by it would leave two leads pointing at one estimate.

const mockUpdates = [];
let mockFreshEstimate = null;
let mockCallRow = null;

jest.mock('../models/db', () => {
  const makeBuilder = (table) => {
    const b = { _wheres: [] };
    for (const m of ['where', 'whereNull', 'orWhere', 'orWhereExists', 'whereExists', 'whereRaw', 'from', 'forUpdate', 'orderBy', 'limit', 'select']) {
      b[m] = (...a) => {
        if (typeof a[0] === 'function') a[0].call(b);
        b._wheres.push([m, ...a]);
        return b;
      };
    }
    b.first = async () => {
      if (table === 'estimates') return mockFreshEstimate;
      if (table === 'call_log') return mockCallRow;
      return null;
    };
    b.update = async (row) => { mockUpdates.push({ table, wheres: b._wheres.slice(), row }); return 1; };
    b.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
    return b;
  };
  const db = (table) => makeBuilder(table);
  db.raw = (sql) => sql;
  db.transaction = async (fn) => fn(db);
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/estimator-engine/context-builder', () => ({
  buildCallContext: jest.fn(),
  existingDraftForCall: jest.fn(),
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

const { _reconcileExistingDraftLinks } = require('../services/estimator-engine/index');

beforeEach(() => {
  mockUpdates.length = 0;
  mockFreshEstimate = null;
  // Live call row: the in-transaction revalidation reads the CURRENT
  // stamp — default it to the repoint target the tests intend.
  mockCallRow = { twilio_call_sid: 'CA-call-1', metadata: { lead_id: 'lead-C' } };
});

describe('reconcileExistingDraftLinks keys cleanup off the LOCKED row', () => {
  test('a durable repoint INVALIDATES the draft, keyed off the FRESH (locked) lead', async () => {
    // Snapshot says lead-A; a concurrent reconcile already moved the draft
    // to lead-B. This run repoints to lead-C — the draft's content was
    // composed from the OLD lead, so it is invalidated (never silently
    // repointed), cleanup targets B, and NO destination claim is made.
    const existing = {
      id: 'est-1',
      estimate_data: JSON.stringify({ lead_id: 'lead-A', lead_linkage: 'stamp' }),
    };
    mockFreshEstimate = {
      id: 'est-1',
      status: 'draft',
      estimate_data: JSON.stringify({ lead_id: 'lead-B', lead_linkage: 'stamp' }),
    };
    const context = {
      lead: { id: 'lead-C' },
      leadIsForThisCall: true,
      leadLinkage: 'stamp',
      call: { id: 'call-1', metadata: {} },
    };

    const outcome = await _reconcileExistingDraftLinks(existing, context);

    expect(outcome).toBe('invalidated');
    const leadUpdates = mockUpdates.filter((u) => u.table === 'leads');
    const unlink = leadUpdates.find((u) => u.row.estimate_id === null);
    expect(unlink.wheres).toContainEqual(['where', { id: 'lead-B', estimate_id: 'est-1' }]);
    // NO destination claim — the rebuilt draft links lead-C itself.
    expect(leadUpdates.filter((u) => u.row.estimate_id === 'est-1')).toHaveLength(0);
    const estimateWrite = mockUpdates.find((u) => u.table === 'estimates');
    const written = JSON.parse(estimateWrite.row.estimate_data);
    expect(written.lead_id).toBeUndefined();
    expect(written.estimatorEngine.linkage_invalidated_from).toBe('lead-B');
    expect(written.estimatorEngine.linkage_invalidated_to).toBe('lead-C');
  });

  test('a peer that already reconciled to the same target makes this run a no-op', async () => {
    const existing = {
      id: 'est-1',
      estimate_data: JSON.stringify({ lead_id: 'lead-A', lead_linkage: 'stamp' }),
    };
    mockFreshEstimate = {
      id: 'est-1',
      status: 'draft',
      estimate_data: JSON.stringify({ lead_id: 'lead-C', lead_linkage: 'stamp' }),
    };
    const context = {
      lead: { id: 'lead-C' }, leadIsForThisCall: true, leadLinkage: 'stamp',
      call: { id: 'call-1', metadata: {} },
    };

    await _reconcileExistingDraftLinks(existing, context);

    expect(mockUpdates).toHaveLength(0);
  });

  test('a money-bearing terminal gets a MARKER-ONLY invalidation — status/archive/money preserved, public token dies (r26)', async () => {
    const existing = {
      id: 'est-1',
      estimate_data: JSON.stringify({ lead_id: 'lead-A', lead_linkage: 'stamp' }),
    };
    mockFreshEstimate = {
      id: 'est-1',
      status: 'accepted',
      estimate_data: JSON.stringify({ lead_id: 'lead-A', lead_linkage: 'stamp' }),
    };
    const context = {
      lead: { id: 'lead-C' }, leadIsForThisCall: true, leadLinkage: 'stamp',
      call: { id: 'call-1', metadata: {} },
    };

    const outcome = await _reconcileExistingDraftLinks(existing, context);

    expect(outcome).toBe('invalidated');
    const estimateWrite = mockUpdates.find((u) => u.table === 'estimates');
    // Marker lands; status, archive state, and money fields untouched.
    expect(estimateWrite.row.archived_at).toBeUndefined();
    expect(estimateWrite.row.status).toBeUndefined();
    expect(estimateWrite.row.scheduled_at).toBeUndefined();
    const written = JSON.parse(estimateWrite.row.estimate_data);
    expect(written.estimatorEngine.linkage_invalidated_at).toBeTruthy();
    expect(written.lead_id).toBeUndefined();
    // Old lead unlinked (guarded).
    const unlink = mockUpdates.find((u) => u.table === 'leads' && u.row.estimate_id === null);
    expect(unlink.wheres).toContainEqual(['where', { id: 'lead-A', estimate_id: 'est-1' }]);
  });

  test('a FRESH delivery claim defers invalidation: durable PENDING marker, no archive, error outcome', async () => {
    // sendEstimateNow stamped delivering_at under this same row lock and is
    // between its verdict read and the provider handoff — committing the
    // archive now would land after the verdict while the delivery still
    // runs. The due invalidation is recorded as a pending marker the send's
    // claim release consumes; the row itself stays the send flow's.
    const existing = {
      id: 'est-1',
      estimate_data: JSON.stringify({ lead_id: 'lead-A', lead_linkage: 'stamp' }),
    };
    mockFreshEstimate = {
      id: 'est-1',
      status: 'sending',
      estimate_data: JSON.stringify({
        lead_id: 'lead-B',
        lead_linkage: 'stamp',
        estimatorEngine: { delivering_at: new Date().toISOString(), delivering_token: 'tok-1' },
      }),
    };
    const context = {
      lead: { id: 'lead-C' }, leadIsForThisCall: true, leadLinkage: 'stamp',
      call: { id: 'call-1', metadata: {} },
    };

    const outcome = await _reconcileExistingDraftLinks(existing, context);

    expect(outcome).toBe('error');
    expect(mockUpdates).toHaveLength(1);
    const write = mockUpdates[0];
    expect(write.table).toBe('estimates');
    // estimate_data only — no archive, no status change, claim untouched.
    expect(write.row.archived_at).toBeUndefined();
    expect(write.row.status).toBeUndefined();
    const written = JSON.parse(write.row.estimate_data);
    expect(written.estimatorEngine.invalidation_pending_at).toBeTruthy();
    expect(written.estimatorEngine.invalidation_pending_from).toBe('lead-B');
    expect(written.estimatorEngine.invalidation_pending_to).toBe('lead-C');
    expect(written.estimatorEngine.linkage_invalidated_at).toBeUndefined();
    expect(written.estimatorEngine.delivering_token).toBe('tok-1');
    expect(written.lead_id).toBe('lead-B');
  });

  test('a STALE delivery claim (crashed send, past TTL) does not block invalidation', async () => {
    const staleAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    const existing = {
      id: 'est-1',
      estimate_data: JSON.stringify({ lead_id: 'lead-A', lead_linkage: 'stamp' }),
    };
    mockFreshEstimate = {
      id: 'est-1',
      status: 'send_failed',
      estimate_data: JSON.stringify({
        lead_id: 'lead-B',
        lead_linkage: 'stamp',
        estimatorEngine: { delivering_at: staleAt, delivering_token: 'tok-dead' },
      }),
    };
    const context = {
      lead: { id: 'lead-C' }, leadIsForThisCall: true, leadLinkage: 'stamp',
      call: { id: 'call-1', metadata: {} },
    };

    const outcome = await _reconcileExistingDraftLinks(existing, context);

    expect(outcome).toBe('invalidated');
    const estimateWrite = mockUpdates.find((u) => u.table === 'estimates');
    const written = JSON.parse(estimateWrite.row.estimate_data);
    expect(written.estimatorEngine.linkage_invalidated_from).toBe('lead-B');
  });
});
