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

function fakeTrx({ concurrentPrices = {} } = {}) {
  const updates = [];
  const auditRows = [];
  const database = (table) => {
    if (table === 'scheduled_services') {
      return {
        where: (criteria) => ({
          update: async (patch) => {
            // Honor the frozen-price predicate the way pg would: the live
            // price is the mocked row's — or a concurrent override, for the
            // read-to-write race tests (codex #3338 r14).
            const live = Object.prototype.hasOwnProperty.call(concurrentPrices, String(criteria.id))
              ? concurrentPrices[String(criteria.id)]
              : mockRowsState.rows.find((r) => String(r.id) === String(criteria.id))?.estimated_price;
            if (criteria.estimated_price !== undefined
              && Number(live) !== Number(criteria.estimated_price)) {
              return 0;
            }
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

function frozenSnapshotData({ prepaid = false, rowIds = ['row-1', 'row-2'] } = {}) {
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
        rowIds,
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
  test('gate off with a frozen plan: no writes, but the plan parks for review (open-tab flip)', async () => {
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
    // codex #3338 r15: a rendered page can still promise the extension
    // after the flip — the accept must page staff, never go silent.
    expect(summary.reviewFamilies).toEqual([
      'Pest Control (extension gate off at accept — not applied)',
    ]);
  });

  test('gate off with NO frozen plan stays a silent no-op (every legacy accept)', async () => {
    mockExtendExistingGate = false;
    const { database, updates } = fakeTrx();
    mockRowsState.rows = [pestRow()];
    const summary = await applyFrozenExistingServiceExtension({
      database, customerId: 'c1', estimateId: 'e1',
      estimateData: {}, activatedTier: 'Silver',
    });
    expect(summary.applied).toBe(false);
    expect(summary.reviewFamilies).toEqual([]);
    expect(updates).toEqual([]);
  });

  test('a price changed between read and write loses the race and parks as drift (predicate-guarded update)', async () => {
    const { database, updates } = fakeTrx({ concurrentPrices: { 'row-1': 61 } });
    mockRowsState.rows = [pestRow({ id: 'row-1' })];
    const summary = await applyFrozenExistingServiceExtension({
      database, customerId: 'c1', estimateId: 'e1',
      estimateData: frozenSnapshotData({ rowIds: ['row-1'] }), activatedTier: 'Silver',
    });
    expect(updates).toEqual([]);
    expect(summary.applied).toBe(false);
    expect(summary.reviewFamilies).toEqual([
      'Pest Control (1 visit priced differently than quoted — apply manually)',
    ]);
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
    // "/application" is the one price unit on every rendered discount
    // (owner 2026-08-10) — the bell/audit copy follows the customer card.
    expect(summary.familyLines).toEqual(['Pest Control $55.00 → $49.50/application (2 upcoming)']);
    expect(mockPostCreditMovement).not.toHaveBeenCalled();
  });

  test('a drifted contracted price parks for review — never a write the customer did not see', async () => {
    const { database, updates } = fakeTrx();
    mockRowsState.rows = [
      pestRow({ id: 'drift-up', estimated_price: 60 }),
      // Below-frozen drift is drift all the same — the frozen figure could
      // undo a legitimate post-save price change in either direction.
      pestRow({ id: 'drift-down', scheduled_date: '2100-01-27', estimated_price: 40 }),
    ];
    const summary = await applyFrozenExistingServiceExtension({
      database, customerId: 'c1', estimateId: 'e1',
      estimateData: frozenSnapshotData({ rowIds: ['drift-up', 'drift-down'] }), activatedTier: 'Silver',
    });
    expect(updates).toEqual([]);
    expect(summary.applied).toBe(false);
    expect(summary.repricedRowCount).toBe(0);
    expect(summary.reviewFamilies).toEqual([
      'Pest Control (2 visits priced differently than quoted — apply manually)',
    ]);
  });

  test('unpriced rows stay NULL; matching rows apply beside a drifted sibling', async () => {
    const { database, updates } = fakeTrx();
    mockRowsState.rows = [
      pestRow({ id: 'null-price', estimated_price: null }),
      pestRow({ id: 'matches', scheduled_date: '2100-01-27', estimated_price: 55 }),
      pestRow({ id: 'drifted', scheduled_date: '2100-04-27', estimated_price: 60 }),
    ];
    const summary = await applyFrozenExistingServiceExtension({
      database, customerId: 'c1', estimateId: 'e1',
      estimateData: frozenSnapshotData({ rowIds: ['null-price', 'matches', 'drifted'] }), activatedTier: 'Silver',
    });
    expect(updates).toEqual([{ id: 'matches', estimated_price: 49.5 }]);
    expect(summary.repricedRowCount).toBe(1);
    expect(summary.reviewFamilies).toEqual([
      'Pest Control (1 visit priced differently than quoted — apply manually)',
    ]);
  });

  test('a same-family visit created after the estimate was saved is never touched (ID-pinned apply)', async () => {
    const { database, updates } = fakeTrx();
    mockRowsState.rows = [
      pestRow({ id: 'row-1' }),
      // Same family, matching price, upcoming — but absent from the frozen
      // plan the customer saw (codex #3338 r10).
      pestRow({ id: 'added-after-save', scheduled_date: '2100-04-27' }),
    ];
    const summary = await applyFrozenExistingServiceExtension({
      database, customerId: 'c1', estimateId: 'e1',
      estimateData: frozenSnapshotData(), activatedTier: 'Silver',
    });
    expect(updates).toEqual([{ id: 'row-1', estimated_price: 49.5 }]);
    expect(summary.repricedRowCount).toBe(1);
  });

  test('a frozen plan without appointment identities parks for review instead of family-wide matching', async () => {
    const { database, updates } = fakeTrx();
    mockRowsState.rows = [pestRow()];
    const summary = await applyFrozenExistingServiceExtension({
      database, customerId: 'c1', estimateId: 'e1',
      estimateData: frozenSnapshotData({ rowIds: [] }), activatedTier: 'Silver',
    });
    expect(updates).toEqual([]);
    expect(summary.applied).toBe(false);
    expect(summary.reviewFamilies).toEqual([
      'Pest Control (no frozen appointment identities — apply manually)',
    ]);
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
      estimateData: frozenSnapshotData({ rowIds: ['own', 'past', 'callback', 'live'] }), activatedTier: 'Silver',
    });
    expect(updates).toEqual([{ id: 'live', estimated_price: 49.5 }]);
    expect(summary.repricedRowCount).toBe(1);
  });

  test('prepaid family credits the tier pct of the PAID allocation, never the list price', async () => {
    const { database, updates } = fakeTrx();
    mockRowsState.rows = [
      // prepaid_amount is the DISCOUNTED splitCoverageAmount slice (codex
      // #3338 r21): $49 paid on a $55 list row — the credit is 10% of $49,
      // not 10% of $55.
      pestRow({ id: 'pre-1', annual_prepay_term_id: 'term-1', prepaid_amount: 49 }),
      pestRow({ id: 'pre-2', scheduled_date: '2100-01-27', annual_prepay_term_id: 'term-1', prepaid_amount: 49 }),
    ];
    const summary = await applyFrozenExistingServiceExtension({
      database, customerId: 'c1', estimateId: 'e1',
      estimateData: frozenSnapshotData({ prepaid: true, rowIds: ['pre-1', 'pre-2'] }), activatedTier: 'Silver',
    });
    expect(updates).toEqual([]);
    expect(summary.applied).toBe(true);
    expect(summary.creditAmount).toBe(9.8);
    expect(summary.creditLines).toEqual([
      'Pest Control $9.80 (2 prepaid applications × 10% of the paid allocation)',
    ]);
    expect(mockPostCreditMovement).toHaveBeenCalledTimes(1);
    const [payload, trx] = mockPostCreditMovement.mock.calls[0];
    expect(payload).toMatchObject({
      customerId: 'c1',
      delta: 9.8,
      source: 'adjustment',
      createdBy: 'system:waveguard_tier_extension',
    });
    expect(trx).toBe(database);
  });

  test('a prepaid visit without a usable paid allocation parks instead of a guessed credit', async () => {
    const { database } = fakeTrx();
    mockRowsState.rows = [
      pestRow({ id: 'pre-1', annual_prepay_term_id: 'term-1', prepaid_amount: 49 }),
      pestRow({ id: 'pre-2', scheduled_date: '2100-01-27', annual_prepay_term_id: 'term-1', prepaid_amount: null }),
    ];
    const summary = await applyFrozenExistingServiceExtension({
      database, customerId: 'c1', estimateId: 'e1',
      estimateData: frozenSnapshotData({ prepaid: true, rowIds: ['pre-1', 'pre-2'] }), activatedTier: 'Silver',
    });
    expect(summary.creditAmount).toBe(4.9);
    expect(summary.reviewFamilies).toEqual([
      'Pest Control (1 prepaid visit without a usable paid allocation — credit manually)',
    ]);
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

  test('monthly-lane members: NO writes at all — the whole plan parks as a rate review before any mutation', async () => {
    const { database, updates, auditRows } = fakeTrx();
    mockRowsState.rows = [pestRow()];
    const summary = await applyFrozenExistingServiceExtension({
      database, customerId: 'c1', estimateId: 'e1',
      estimateData: frozenSnapshotData(), activatedTier: 'Silver',
      monthlyLaneMember: true,
      priorQualifyingKeys: ['pest_control', 'tree_shrub'],
    });
    // codex #3338 r9: row repricing never lowers a monthly member's
    // scalar charge, so nothing may mutate — review-only summary.
    expect(summary.applied).toBe(false);
    expect(summary.monthlyRateReviewNeeded).toBe(true);
    expect(updates).toEqual([]);
    expect(auditRows).toEqual([]);
    expect(mockPostCreditMovement).not.toHaveBeenCalled();
    expect(summary.reviewFamilies).toEqual([
      'tree_shrub',
      'Pest Control (monthly-billed — adjust the monthly rate manually)',
    ]);
  });
});
