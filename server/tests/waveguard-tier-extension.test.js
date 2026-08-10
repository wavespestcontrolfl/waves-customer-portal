process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// applyFrozenExistingServiceExtension — the accept-time half of the
// existing-service tier extension (owner decision 2026-08-10, dark behind
// GATE_WAVEGUARD_EXTEND_EXISTING). Pins the money invariants:
//   - only the FROZEN snapshot plan applies (what the estimate displayed),
//   - upcoming non-prepaid rows reprice (frozen figure on an exact match,
//     proportional delta when the contracted price moved),
//   - unpriced rows stay NULL, prices only ever go DOWN,
//   - prepaid families credit the difference instead of repricing,
//   - the audit row commits with the writes,
//   - gate off / tier mismatch / rows from THIS estimate apply nothing.

let mockExtendExistingGate = true;
jest.mock('../config/feature-gates', () => ({
  isEnabled: (gate) => (gate === 'waveguardExtendExisting' ? mockExtendExistingGate : false),
  gateEnvValue: () => false,
}));

const mockRowsState = { rows: [] };
jest.mock('../services/waveguard-existing-services', () => ({
  loadExistingRecurringQualifyingRows: jest.fn(async () => mockRowsState.rows),
  qualifyingKeysForRow: jest.fn((row) => row.families || []),
}));

const mockPostCreditMovement = jest.fn(async () => ({ balanceAfter: 0, entry: {} }));
jest.mock('../services/customer-credit', () => ({
  postCreditMovement: (...args) => mockPostCreditMovement(...args),
}));

const { applyFrozenExistingServiceExtension } = require('../services/estimate-converter');

function fakeTrx() {
  const updates = [];
  const auditRows = [];
  const database = (table) => {
    if (table === 'scheduled_services') {
      return {
        where: (criteria) => ({
          update: async (patch) => {
            updates.push({ id: criteria.id, ...patch });
            return 1;
          },
        }),
      };
    }
    if (table === 'activity_log') {
      return { insert: async (row) => { auditRows.push(row); return [1]; } };
    }
    throw new Error(`unexpected table ${table}`);
  };
  database.isTransaction = true;
  return { database, updates, auditRows };
}

function frozenSnapshotData({ prepaid = false } = {}) {
  return {
    membershipSnapshot: {
      isExistingCustomer: true,
      tierLabel: 'Silver',
      existingServices: [{
        key: 'pest_control',
        keys: ['pest_control'],
        label: 'Pest Control',
        currentPerVisit: 55,
        extraDiscountPct: 10,
        perVisitSavings: 5.5,
        newPerVisit: 49.5,
        remainingVisits: 2,
        upcomingVisitDates: ['2099-10-28', '2100-01-27'],
        prepaid,
      }],
    },
  };
}

function pestRow(overrides = {}) {
  return {
    id: 'row-1',
    families: ['pest_control'],
    scheduled_date: '2099-10-28',
    estimated_price: 55,
    ...overrides,
  };
}

beforeEach(() => {
  mockExtendExistingGate = true;
  mockRowsState.rows = [];
  mockPostCreditMovement.mockClear();
});

describe('applyFrozenExistingServiceExtension', () => {
  test('gate off applies nothing', async () => {
    mockExtendExistingGate = false;
    const { database, updates, auditRows } = fakeTrx();
    mockRowsState.rows = [pestRow()];
    const summary = await applyFrozenExistingServiceExtension({
      database, customerId: 'c1', estimateId: 'e1',
      estimateData: frozenSnapshotData(), activatedTier: 'Silver',
    });
    expect(summary.applied).toBe(false);
    expect(updates).toEqual([]);
    expect(auditRows).toEqual([]);
  });

  test('frozen plan reprices matching upcoming rows to the displayed figure and audits atomically', async () => {
    const { database, updates, auditRows } = fakeTrx();
    mockRowsState.rows = [
      pestRow({ id: 'row-1', scheduled_date: '2099-10-28' }),
      pestRow({ id: 'row-2', scheduled_date: '2100-01-27' }),
    ];
    const summary = await applyFrozenExistingServiceExtension({
      database, customerId: 'c1', estimateId: 'e1',
      estimateData: frozenSnapshotData(), activatedTier: 'Silver',
    });
    expect(summary.applied).toBe(true);
    expect(summary.repricedRowCount).toBe(2);
    expect(summary.families).toEqual(['pest_control']);
    expect(updates).toEqual([
      { id: 'row-1', estimated_price: 49.5 },
      { id: 'row-2', estimated_price: 49.5 },
    ]);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ customer_id: 'c1', action: 'waveguard_tier_extension_applied' });
    expect(JSON.parse(auditRows[0].metadata)).toMatchObject({
      tier: 'Silver', repricedRowCount: 2, creditAmount: 0,
    });
    expect(mockPostCreditMovement).not.toHaveBeenCalled();
  });

  test('a drifted contracted price gets the proportional delta, never the stale frozen figure', async () => {
    const { database, updates } = fakeTrx();
    mockRowsState.rows = [pestRow({ estimated_price: 60 })];
    const summary = await applyFrozenExistingServiceExtension({
      database, customerId: 'c1', estimateId: 'e1',
      estimateData: frozenSnapshotData(), activatedTier: 'Silver',
    });
    expect(summary.repricedRowCount).toBe(1);
    expect(updates).toEqual([{ id: 'row-1', estimated_price: 54 }]);
  });

  test('unpriced rows stay NULL and prices never go up', async () => {
    const { database, updates } = fakeTrx();
    mockRowsState.rows = [
      pestRow({ id: 'null-price', estimated_price: null }),
      // A row already priced BELOW the frozen target must not be raised.
      pestRow({ id: 'already-low', estimated_price: 40 }),
    ];
    const summary = await applyFrozenExistingServiceExtension({
      database, customerId: 'c1', estimateId: 'e1',
      estimateData: frozenSnapshotData(), activatedTier: 'Silver',
    });
    // already-low still reprices proportionally (40 → 36) — down, never up;
    // the NULL row is untouched.
    expect(updates).toEqual([{ id: 'already-low', estimated_price: 36 }]);
    expect(summary.repricedRowCount).toBe(1);
  });

  test('rows created by THIS accept and past/callback rows are excluded', async () => {
    const { database, updates } = fakeTrx();
    mockRowsState.rows = [
      pestRow({ id: 'own', source_estimate_id: 'e1' }),
      pestRow({ id: 'past', scheduled_date: '2020-01-01' }),
      pestRow({ id: 'callback', is_callback: true }),
      pestRow({ id: 'live' }),
    ];
    const summary = await applyFrozenExistingServiceExtension({
      database, customerId: 'c1', estimateId: 'e1',
      estimateData: frozenSnapshotData(), activatedTier: 'Silver',
    });
    expect(updates).toEqual([{ id: 'live', estimated_price: 49.5 }]);
    expect(summary.repricedRowCount).toBe(1);
  });

  test('prepaid family credits the difference instead of repricing', async () => {
    const { database, updates } = fakeTrx();
    mockRowsState.rows = [
      pestRow({ id: 'pre-1', annual_prepay_term_id: 'term-1' }),
      pestRow({ id: 'pre-2', scheduled_date: '2100-01-27', annual_prepay_term_id: 'term-1' }),
    ];
    const summary = await applyFrozenExistingServiceExtension({
      database, customerId: 'c1', estimateId: 'e1',
      estimateData: frozenSnapshotData({ prepaid: true }), activatedTier: 'Silver',
    });
    expect(updates).toEqual([]);
    expect(summary.applied).toBe(true);
    expect(summary.creditAmount).toBe(11);
    expect(mockPostCreditMovement).toHaveBeenCalledTimes(1);
    const [payload, trx] = mockPostCreditMovement.mock.calls[0];
    expect(payload).toMatchObject({
      customerId: 'c1',
      delta: 11,
      source: 'adjustment',
      createdBy: 'system:waveguard_tier_extension',
    });
    expect(trx).toBe(database);
  });

  test('a stale snapshot whose tier disagrees with the activated tier applies nothing', async () => {
    const { database, updates } = fakeTrx();
    mockRowsState.rows = [pestRow()];
    const summary = await applyFrozenExistingServiceExtension({
      database, customerId: 'c1', estimateId: 'e1',
      estimateData: frozenSnapshotData(), activatedTier: 'Gold',
    });
    expect(summary.applied).toBe(false);
    expect(updates).toEqual([]);
  });

  test('monthly-lane members park a rate-review exception; families outside the plan are named for review', async () => {
    const { database } = fakeTrx();
    mockRowsState.rows = [pestRow()];
    const summary = await applyFrozenExistingServiceExtension({
      database, customerId: 'c1', estimateId: 'e1',
      estimateData: frozenSnapshotData(), activatedTier: 'Silver',
      monthlyLaneMember: true,
      priorQualifyingKeys: ['pest_control', 'tree_shrub'],
    });
    expect(summary.applied).toBe(true);
    expect(summary.monthlyRateReviewNeeded).toBe(true);
    expect(summary.reviewFamilies).toEqual(['tree_shrub']);
  });
});
