// reconcileExistingDraftLinks — concurrent-reconciliation safety (PR #3304).
// The cleanup must key off the LOCKED row's linkage: with two concurrent
// reconciles, the loser's pre-transaction snapshot lead is stale, and
// unlinking by it would leave two leads pointing at one estimate.

const mockUpdates = [];
let mockFreshEstimate = null;
let mockCallRow = null;
let mockDestinationClaimFails = false;

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
    b.update = async (row) => {
      // The destination claim is the leads write that SETS estimate_id;
      // simulate an occupied destination by zero-rowing it.
      if (mockDestinationClaimFails && table === 'leads' && row.estimate_id) return 0;
      mockUpdates.push({ table, wheres: b._wheres.slice(), row });
      return 1;
    };
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
  mockDestinationClaimFails = false;
});

describe('reconcileExistingDraftLinks keys cleanup off the LOCKED row', () => {
  test('a peer-moved draft unlinks the FRESH lead, never the stale snapshot lead', async () => {
    // Snapshot says lead-A; a concurrent reconcile already moved the draft
    // to lead-B. This run repoints to lead-C — cleanup must target B.
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

    await _reconcileExistingDraftLinks(existing, context);

    const leadUpdates = mockUpdates.filter((u) => u.table === 'leads');
    const unlink = leadUpdates.find((u) => u.row.estimate_id === null);
    expect(unlink.wheres).toContainEqual(['where', { id: 'lead-B', estimate_id: 'est-1' }]);
    const link = leadUpdates.find((u) => u.row.estimate_id === 'est-1');
    expect(link.wheres).toContainEqual(['where', { id: 'lead-C' }]);
    const estimateWrite = mockUpdates.find((u) => u.table === 'estimates');
    expect(JSON.parse(estimateWrite.row.estimate_data).lead_id).toBe('lead-C');
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

  test('an OCCUPIED destination no-ops the whole reconcile (claim-first)', async () => {
    // The destination lead already points at a newer estimate — nothing
    // may change: no mirror write, no old-lead unlink (pre-push P0).
    mockDestinationClaimFails = true;
    const existing = {
      id: 'est-1',
      estimate_data: JSON.stringify({ lead_id: 'lead-A', lead_linkage: 'stamp' }),
    };
    mockFreshEstimate = {
      id: 'est-1',
      status: 'draft',
      estimate_data: JSON.stringify({ lead_id: 'lead-A', lead_linkage: 'stamp' }),
    };
    const context = {
      lead: { id: 'lead-C' }, leadIsForThisCall: true, leadLinkage: 'stamp',
      call: { id: 'call-1', metadata: {} },
    };

    await _reconcileExistingDraftLinks(existing, context);

    expect(mockUpdates.filter((u) => u.table === 'estimates')).toHaveLength(0);
    expect(mockUpdates.filter((u) => u.table === 'leads' && u.row.estimate_id === null)).toHaveLength(0);
  });

  test('a non-draft status is never touched', async () => {
    const existing = {
      id: 'est-1',
      estimate_data: JSON.stringify({ lead_id: 'lead-A', lead_linkage: 'stamp' }),
    };
    mockFreshEstimate = {
      id: 'est-1',
      status: 'sent',
      estimate_data: JSON.stringify({ lead_id: 'lead-A', lead_linkage: 'stamp' }),
    };
    const context = {
      lead: { id: 'lead-C' }, leadIsForThisCall: true, leadLinkage: 'stamp',
      call: { id: 'call-1', metadata: {} },
    };

    await _reconcileExistingDraftLinks(existing, context);

    expect(mockUpdates).toHaveLength(0);
  });
});
