process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// applyFrozenExistingServiceExtension — the accept-time half of the
// existing-service tier extension (owner decision 2026-08-10, dark behind
// GATE_WAVEGUARD_EXTEND_EXISTING). Pins the money invariants:
//   - only the FROZEN snapshot plan applies (what the estimate displayed),
//   - upcoming non-prepaid rows reprice to the exact frozen figure; a price
//     that moved (or blanked) after save parks as drift — never a write the
//     customer did not see, never $0 onto a NULL,
//   - visits with add-ons or an already-minted invoice park (a netted price
//     cannot take a family discount; a minted invoice keeps billing),
//   - prepaid families credit the FROZEN per-application savings, and only
//     while the paid allocation still equals the frozen basis,
//   - partially-honored families land in dirtyFamilies (the committed recap
//     projects only fully-honored families — codex #3338 r26),
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
  // Literal duplicates of the real constants (the mock can't requireActual
  // without dragging the db pool in); the grant-identity test below pins
  // them against drift.
  WAVEGUARD_EXTENSION_CREDIT_BY: 'system:waveguard_tier_extension',
  WAVEGUARD_EXTENSION_REVERSAL_BY: 'system:waveguard_tier_extension_reversal',
}));

const { applyFrozenExistingServiceExtension } = require('../services/estimate-converter');

function fakeTrx({
  concurrentPrices = {}, addonLinks = [], invoiceLinks = [], probeThrows = false,
  invoiceLinksLateMint = [], concurrentPrepaid = {}, lockThrows = false,
  priorExtensionAudits = [], auditProbeThrows = false, familyLockThrows = false,
  prepayTerms = [],
} = {}) {
  const updates = [];
  const auditRows = [];
  // Prices this transaction already wrote — the frozen-price and revert
  // predicates must see our own writes, the way pg does inside one txn.
  const writtenPrices = {};
  const writtenPrimary = {};
  let invoiceProbeCalls = 0;
  // The live row the way pg would see it: our own prior writes win, then a
  // concurrent override, then the fixture row.
  const liveRow = (key) => {
    const base = mockRowsState.rows.find((r) => String(r.id) === key);
    if (!base) return null;
    const row = { ...base };
    if (Object.prototype.hasOwnProperty.call(concurrentPrices, key)) {
      row.estimated_price = concurrentPrices[key];
    }
    if (Object.prototype.hasOwnProperty.call(writtenPrices, key)) {
      row.estimated_price = writtenPrices[key];
    }
    if (Object.prototype.hasOwnProperty.call(writtenPrimary, key)) {
      row.primary_line_price = writtenPrimary[key];
    }
    return row;
  };
  const database = (table) => {
    if (table === 'scheduled_services') {
      return {
        where: (criteria) => ({
          update: async (patch) => {
            // Honor the frozen-price predicate the way pg would (codex
            // #3338 r14) — both price columns when the CAS pins both.
            const id = String(criteria.id);
            const live = liveRow(id) || {};
            if (criteria.estimated_price !== undefined
              && Number(live.estimated_price) !== Number(criteria.estimated_price)) {
              return 0;
            }
            if (criteria.primary_line_price !== undefined
              && Number(live.primary_line_price) !== Number(criteria.primary_line_price)) {
              return 0;
            }
            writtenPrices[id] = patch.estimated_price;
            if (patch.primary_line_price !== undefined) {
              writtenPrimary[id] = patch.primary_line_price;
            }
            updates.push({ id: criteria.id, ...patch });
            return 1;
          },
        }),
        // Two FOR-UPDATE chains live here, routed by select columns:
        //  - family lock: whereIn().orderBy().forUpdate().select('id',
        //    'estimated_price', 'primary_line_price') — the authoritative
        //    price read (mint-serialization fast-follow);
        //  - prepaid allocation lock: whereIn().forUpdate().select('id',
        //    'prepaid_amount', ...) — concurrentPrepaid overrides simulate
        //    an annual-prepay writer racing the accept (a partial object
        //    patches the row, null means it vanished).
        whereIn: (col, ids) => {
          const lockChain = {
            forUpdate: () => ({
              select: async (...cols) => {
                const isFamilyLock = cols.includes('estimated_price');
                if (isFamilyLock && familyLockThrows) throw new Error('lock timeout');
                if (!isFamilyLock && lockThrows) throw new Error('lock timeout');
                return ids.map((id) => {
                  const key = String(id);
                  if (isFamilyLock) return liveRow(key);
                  const base = mockRowsState.rows.find((r) => String(r.id) === key);
                  if (!base) return null;
                  if (Object.prototype.hasOwnProperty.call(concurrentPrepaid, key)) {
                    const override = concurrentPrepaid[key];
                    return override === null ? null : { ...base, ...override };
                  }
                  return base;
                }).filter(Boolean);
              },
            }),
          };
          return { ...lockChain, orderBy: () => lockChain };
        },
      };
    }
    if (table === 'annual_prepay_terms') {
      // The per-term grant's prepay-invoice anchor lookup.
      return {
        whereIn: (col, ids) => ({
          select: async () => prepayTerms.filter((t) => ids.map(String).includes(String(t.id))),
        }),
      };
    }
    // Composite/pre-minted-invoice probes (codex #3338 r24+r25).
    if (table === 'scheduled_service_addons') {
      return {
        whereIn: () => ({
          select: async () => {
            if (probeThrows) throw new Error('relation does not exist');
            return addonLinks.map((id) => ({ scheduled_service_id: id }));
          },
        }),
      };
    }
    if (table === 'invoices') {
      return {
        whereIn: (col, ids) => ({
          whereNot: () => ({
            select: async () => {
              if (probeThrows) throw new Error('relation does not exist');
              // The mint-race tests add invoiceLinksLateMint from the
              // second probe on — the pre-probe misses them, the
              // post-write re-probe sees them (codex #3338 r7).
              invoiceProbeCalls += 1;
              const links = invoiceProbeCalls === 1
                ? invoiceLinks
                : [...invoiceLinks, ...invoiceLinksLateMint];
              const queried = ids.map(String);
              return links.filter((id) => queried.includes(String(id)))
                .map((id) => ({ scheduled_service_id: id }));
            },
          }),
        }),
      };
    }
    if (table === 'activity_log') {
      return {
        insert: async (row) => { auditRows.push(row); return [1]; },
        // Prior-extension at-most-once probe (codex #3338 r7 dedup).
        where: () => ({
          select: async () => {
            if (auditProbeThrows) throw new Error('relation does not exist');
            return priorExtensionAudits;
          },
        }),
      };
    }
    throw new Error(`unexpected table ${table}`);
  };
  database.isTransaction = true;
  // Nested savepoints (family lock, anchor lookup) re-enter with the same
  // client, the way knex hands the parent trx a savepoint-scoped clone.
  database.transaction = async (cb) => cb(database);
  return { database, updates, auditRows };
}

function frozenSnapshotData({ prepaid = false, rowIds = ['row-1', 'row-2'], svc = {} } = {}) {
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
        ...svc,
      }],
    },
  };
}

// A prepaid family freezes the PAID allocation as its basis (the snapshot
// builder's uniform-allocation rule) — Silver 10% off a $49 slice.
function prepaidSnapshotData({ rowIds = ['pre-1', 'pre-2'] } = {}) {
  return frozenSnapshotData({
    prepaid: true,
    rowIds,
    svc: { currentPerVisit: 49, newPerVisit: 44.1, perVisitSavings: 4.9 },
  });
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
      tier: 'Silver',
      repricedRowCount: 2,
      creditAmount: 0,
      // The dedup key a later accept intersects against (codex #3338 r8).
      appliedRowIds: ['row-1', 'row-2'],
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
    expect(summary.dirtyFamilies).toEqual(['pest_control']);
  });

  test('a blanked price parks as drift beside a matching sibling — the NULL is never overwritten', async () => {
    const { database, updates } = fakeTrx();
    mockRowsState.rows = [
      // Frozen rows were priced AT the basis when the card displayed them —
      // a NULL now means the price moved after save (codex #3338 r26: a
      // silently skipped appointment must not leave its family reading as
      // fully repriced). The NULL itself still never takes a write.
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
      'Pest Control (2 visits priced differently than quoted — apply manually)',
    ]);
    expect(summary.dirtyFamilies).toEqual(['pest_control']);
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

  test('prepaid family credits the FROZEN per-application savings off the paid allocation, never the list price', async () => {
    const { database, updates } = fakeTrx();
    mockRowsState.rows = [
      // prepaid_amount is the DISCOUNTED splitCoverageAmount slice (codex
      // #3338 r21): $49 paid on a $55 list row. The snapshot froze the
      // allocation as its basis, and the credit is the frozen $4.90
      // savings per covered application — the exact figure the card
      // displayed, never recomputed pct math (whose half-cent rounding can
      // land a penny off the display) and never 10% of the $55 list price.
      pestRow({ id: 'pre-1', annual_prepay_term_id: 'term-1', prepaid_amount: 49 }),
      pestRow({ id: 'pre-2', scheduled_date: '2100-01-27', annual_prepay_term_id: 'term-1', prepaid_amount: 49 }),
    ];
    const summary = await applyFrozenExistingServiceExtension({
      database, customerId: 'c1', estimateId: 'e1',
      estimateData: prepaidSnapshotData(), activatedTier: 'Silver',
    });
    expect(updates).toEqual([]);
    expect(summary.applied).toBe(true);
    expect(summary.creditAmount).toBe(9.8);
    expect(summary.dirtyFamilies).toEqual([]);
    expect([...summary.appliedRowIds].sort()).toEqual(['pre-1', 'pre-2']);
    expect(summary.creditLines).toEqual([
      'Pest Control $9.80 (2 prepaid applications × $4.90/application off the paid allocation)',
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
      estimateData: prepaidSnapshotData(), activatedTier: 'Silver',
    });
    expect(summary.creditAmount).toBe(4.9);
    expect(summary.reviewFamilies).toEqual([
      'Pest Control (1 prepaid visit without a usable paid allocation — credit manually)',
    ]);
    // Partially credited → the committed recap must not show this family
    // as covered (codex #3338 r26).
    expect(summary.dirtyFamilies).toEqual(['pest_control']);
  });

  test('a prepaid allocation that changed since the estimate parks — the frozen figure no longer describes the paid slice', async () => {
    const { database } = fakeTrx();
    mockRowsState.rows = [
      // Term re-split after save: this application's paid slice is now $45,
      // not the $49 the card's math rode on. Same doctrine as price drift
      // on the reprice path: frozen figure or nothing.
      pestRow({ id: 'pre-1', annual_prepay_term_id: 'term-1', prepaid_amount: 45 }),
      pestRow({ id: 'pre-2', scheduled_date: '2100-01-27', annual_prepay_term_id: 'term-1', prepaid_amount: 49 }),
    ];
    const summary = await applyFrozenExistingServiceExtension({
      database, customerId: 'c1', estimateId: 'e1',
      estimateData: prepaidSnapshotData(), activatedTier: 'Silver',
    });
    expect(summary.creditAmount).toBe(4.9);
    expect(summary.reviewFamilies).toEqual([
      'Pest Control (1 prepaid visit whose paid allocation changed since the estimate — credit manually)',
    ]);
    expect(summary.dirtyFamilies).toEqual(['pest_control']);
  });

  test('a visit with add-ons parks; clean siblings still apply (netted price cannot take the family discount)', async () => {
    const { database, updates } = fakeTrx({ addonLinks: ['row-2'] });
    mockRowsState.rows = [
      pestRow({ id: 'row-1' }),
      pestRow({ id: 'row-2', scheduled_date: '2100-01-27' }),
    ];
    const summary = await applyFrozenExistingServiceExtension({
      database, customerId: 'c1', estimateId: 'e1',
      estimateData: frozenSnapshotData(), activatedTier: 'Silver',
    });
    // codex #3338 r24: row-2 nets primary + add-ons into one
    // estimated_price — repricing it would discount the add-ons too.
    expect(updates).toEqual([{ id: 'row-1', estimated_price: 49.5 }]);
    expect(summary.applied).toBe(true);
    expect(summary.reviewFamilies).toEqual([
      'Pest Control (1 visit with add-ons or an already-minted invoice — apply manually)',
    ]);
    expect(summary.dirtyFamilies).toEqual(['pest_control']);
  });

  test('a visit whose invoice was already minted parks — a row-only reprice would keep billing the old amount', async () => {
    const { database, updates } = fakeTrx({ invoiceLinks: ['row-1'] });
    mockRowsState.rows = [
      pestRow({ id: 'row-1' }),
      pestRow({ id: 'row-2', scheduled_date: '2100-01-27' }),
    ];
    const summary = await applyFrozenExistingServiceExtension({
      database, customerId: 'c1', estimateId: 'e1',
      estimateData: frozenSnapshotData(), activatedTier: 'Silver',
    });
    // codex #3338 r25: the shared mint path REUSES an existing invoice, so
    // repricing only the row leaves the minted invoice at the old figure.
    expect(updates).toEqual([{ id: 'row-2', estimated_price: 49.5 }]);
    expect(summary.dirtyFamilies).toEqual(['pest_control']);
  });

  test('probe failure parks the whole family fail-closed — never a write the probe would have blocked', async () => {
    const { database, updates, auditRows } = fakeTrx({ probeThrows: true });
    mockRowsState.rows = [
      pestRow({ id: 'row-1' }),
      pestRow({ id: 'row-2', scheduled_date: '2100-01-27' }),
    ];
    const summary = await applyFrozenExistingServiceExtension({
      database, customerId: 'c1', estimateId: 'e1',
      estimateData: frozenSnapshotData(), activatedTier: 'Silver',
    });
    expect(updates).toEqual([]);
    expect(auditRows).toEqual([]);
    expect(summary.applied).toBe(false);
    expect(summary.reviewFamilies).toEqual([
      'Pest Control (could not verify add-ons/invoices — apply manually)',
    ]);
    expect(summary.dirtyFamilies).toEqual(['pest_control']);
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

  test('a family already extended by a prior accept parks — never a second credit for the same applications', async () => {
    // Two tier-raising estimates saved while Bronze; the first accept
    // credited the prepaid pest term. The second accept must park, not
    // re-credit the same applications (codex #3338 r7 dedup).
    const { database, updates } = fakeTrx({
      priorExtensionAudits: [{ metadata: JSON.stringify({ estimateId: 'e0', families: ['pest_control'] }) }],
    });
    mockRowsState.rows = [
      pestRow({ id: 'pre-1', annual_prepay_term_id: 'term-1', prepaid_amount: 49 }),
      pestRow({ id: 'pre-2', scheduled_date: '2100-01-27', annual_prepay_term_id: 'term-1', prepaid_amount: 49 }),
    ];
    const summary = await applyFrozenExistingServiceExtension({
      database, customerId: 'c1', estimateId: 'e1',
      estimateData: prepaidSnapshotData(), activatedTier: 'Silver',
    });
    expect(summary.applied).toBe(false);
    expect(summary.creditAmount).toBe(0);
    expect(updates).toEqual([]);
    expect(mockPostCreditMovement).not.toHaveBeenCalled();
    expect(summary.reviewFamilies).toEqual([
      'Pest Control (already extended via estimate #e0 — verify before applying again)',
    ]);
    expect(summary.dirtyFamilies).toEqual(['pest_control']);
    // An audit row from THIS estimate is not a prior extension — the
    // exclusion keeps re-entrant shapes from self-parking.
    const { database: ownDb, updates: ownUpdates } = fakeTrx({
      priorExtensionAudits: [{ metadata: JSON.stringify({ estimateId: 'e1', families: ['pest_control'] }) }],
    });
    mockRowsState.rows = [pestRow({ id: 'row-1' })];
    const ownSummary = await applyFrozenExistingServiceExtension({
      database: ownDb, customerId: 'c1', estimateId: 'e1',
      estimateData: frozenSnapshotData({ rowIds: ['row-1'] }), activatedTier: 'Silver',
    });
    expect(ownSummary.applied).toBe(true);
    expect(ownUpdates).toEqual([{ id: 'row-1', estimated_price: 49.5 }]);
  });

  test('audit probe failure parks every family — at-most-once cannot be verified', async () => {
    const { database, updates } = fakeTrx({ auditProbeThrows: true });
    mockRowsState.rows = [pestRow({ id: 'row-1' })];
    const summary = await applyFrozenExistingServiceExtension({
      database, customerId: 'c1', estimateId: 'e1',
      estimateData: frozenSnapshotData({ rowIds: ['row-1'] }), activatedTier: 'Silver',
    });
    expect(summary.applied).toBe(false);
    expect(updates).toEqual([]);
    expect(summary.reviewFamilies).toEqual([
      'Pest Control (could not verify prior extensions — apply manually)',
    ]);
    expect(summary.dirtyFamilies).toEqual(['pest_control']);
  });

  test('a frozen visit missing from the live set dirties the family; the matched sibling still applies', async () => {
    const { database, updates } = fakeTrx();
    // row-2 was cancelled after the estimate was saved — the card
    // advertised it, the apply cannot honor it (codex #3338 r7, r26
    // sibling): partial family, must not project as fully covered.
    mockRowsState.rows = [pestRow({ id: 'row-1' })];
    const summary = await applyFrozenExistingServiceExtension({
      database, customerId: 'c1', estimateId: 'e1',
      estimateData: frozenSnapshotData(), activatedTier: 'Silver',
    });
    expect(updates).toEqual([{ id: 'row-1', estimated_price: 49.5 }]);
    expect(summary.applied).toBe(true);
    expect(summary.reviewFamilies).toEqual([
      'Pest Control (1 frozen visit no longer eligible — verify manually)',
    ]);
    expect(summary.dirtyFamilies).toEqual(['pest_control']);
  });

  test('an invoice minted during the apply reverts that visit and parks it (mint race)', async () => {
    const { database, updates, auditRows } = fakeTrx({ invoiceLinksLateMint: ['row-1'] });
    mockRowsState.rows = [
      pestRow({ id: 'row-1' }),
      pestRow({ id: 'row-2', scheduled_date: '2100-01-27' }),
    ];
    const summary = await applyFrozenExistingServiceExtension({
      database, customerId: 'c1', estimateId: 'e1',
      estimateData: frozenSnapshotData(), activatedTier: 'Silver',
    });
    // Both reprice; the post-write re-probe catches row-1's mid-apply
    // invoice and reverts exactly that row (codex #3338 r7 mint race).
    expect(updates).toEqual([
      { id: 'row-1', estimated_price: 49.5 },
      { id: 'row-2', estimated_price: 49.5 },
      { id: 'row-1', estimated_price: 55 },
    ]);
    expect(summary.repricedRowCount).toBe(1);
    expect(summary.applied).toBe(true);
    expect(summary.familyLines).toEqual(['Pest Control $55.00 → $49.50/application (1 upcoming)']);
    expect(summary.reviewFamilies).toEqual([
      'Pest Control (1 visit invoiced during apply — reverted, adjust manually)',
    ]);
    expect(summary.dirtyFamilies).toEqual(['pest_control']);
    // The reverted visit is NOT a covered appointment — a later accept's
    // dedup must not treat it as already extended (codex #3338 r8).
    expect(JSON.parse(auditRows[0].metadata).appliedRowIds).toEqual(['row-2']);
  });

  test('dedup is by covered appointments: a disjoint same-family plan at another property still applies', async () => {
    // A prior accept extended property A's pest visits; this plan freezes
    // property B's — same family key, completely disjoint row ids. It must
    // apply, not park (codex #3338 r8 refinement of the r7 family-level
    // at-most-once).
    const { database, updates } = fakeTrx({
      priorExtensionAudits: [{
        metadata: JSON.stringify({
          estimateId: 'e0', families: ['pest_control'], appliedRowIds: ['propA-1', 'propA-2'],
        }),
      }],
    });
    mockRowsState.rows = [pestRow({ id: 'row-1' })];
    const summary = await applyFrozenExistingServiceExtension({
      database, customerId: 'c1', estimateId: 'e1',
      estimateData: frozenSnapshotData({ rowIds: ['row-1'] }), activatedTier: 'Silver',
    });
    expect(summary.applied).toBe(true);
    expect(updates).toEqual([{ id: 'row-1', estimated_price: 49.5 }]);
    expect(summary.reviewFamilies).toEqual([]);
    // Overlapping identities still park — the double-credit case.
    const { database: overlapDb, updates: overlapUpdates } = fakeTrx({
      priorExtensionAudits: [{
        metadata: JSON.stringify({
          estimateId: 'e0', families: ['pest_control'], appliedRowIds: ['row-1'],
        }),
      }],
    });
    mockRowsState.rows = [pestRow({ id: 'row-1' })];
    const overlap = await applyFrozenExistingServiceExtension({
      database: overlapDb, customerId: 'c1', estimateId: 'e1',
      estimateData: frozenSnapshotData({ rowIds: ['row-1'] }), activatedTier: 'Silver',
    });
    expect(overlap.applied).toBe(false);
    expect(overlapUpdates).toEqual([]);
    expect(overlap.reviewFamilies).toEqual([
      'Pest Control (already extended via estimate #e0 — verify before applying again)',
    ]);
    expect(overlap.dirtyFamilies).toEqual(['pest_control']);
  });

  test('a prepaid allocation changed between read and credit parks (locked re-read)', async () => {
    const { database } = fakeTrx({ concurrentPrepaid: { 'pre-1': { prepaid_amount: 30 } } });
    mockRowsState.rows = [
      pestRow({ id: 'pre-1', annual_prepay_term_id: 'term-1', prepaid_amount: 49 }),
      pestRow({ id: 'pre-2', scheduled_date: '2100-01-27', annual_prepay_term_id: 'term-1', prepaid_amount: 49 }),
    ];
    const summary = await applyFrozenExistingServiceExtension({
      database, customerId: 'c1', estimateId: 'e1',
      estimateData: prepaidSnapshotData(), activatedTier: 'Silver',
    });
    expect(summary.creditAmount).toBe(4.9);
    expect(summary.reviewFamilies).toEqual([
      'Pest Control (1 prepaid visit whose paid allocation changed since the estimate — credit manually)',
    ]);
    expect(summary.dirtyFamilies).toEqual(['pest_control']);
    // A term cleared (refund) or row deleted concurrently — same park,
    // nothing credited.
    mockPostCreditMovement.mockClear();
    const { database: clearedDb } = fakeTrx({
      concurrentPrepaid: { 'pre-1': { annual_prepay_term_id: null }, 'pre-2': null },
    });
    const cleared = await applyFrozenExistingServiceExtension({
      database: clearedDb, customerId: 'c1', estimateId: 'e1',
      estimateData: prepaidSnapshotData(), activatedTier: 'Silver',
    });
    expect(cleared.applied).toBe(false);
    expect(cleared.creditAmount).toBe(0);
    expect(mockPostCreditMovement).not.toHaveBeenCalled();
    expect(cleared.dirtyFamilies).toEqual(['pest_control']);
  });

  test('one-cent drift is drift: price and allocation matches are exact cents', async () => {
    // Price side: a $55.01 row is NOT the quoted $55 basis (codex #3338
    // r9) — under the old ±$0.01 tolerance it would have been repriced.
    const { database, updates } = fakeTrx();
    mockRowsState.rows = [pestRow({ id: 'row-1', estimated_price: 55.01 })];
    const summary = await applyFrozenExistingServiceExtension({
      database, customerId: 'c1', estimateId: 'e1',
      estimateData: frozenSnapshotData({ rowIds: ['row-1'] }), activatedTier: 'Silver',
    });
    expect(updates).toEqual([]);
    expect(summary.reviewFamilies).toEqual([
      'Pest Control (1 visit priced differently than quoted — apply manually)',
    ]);
    // Allocation side: a $49.01 slice is NOT the frozen $49 basis — under
    // the old > $0.01 check it would have been credited the frozen $4.90.
    const { database: allocDb } = fakeTrx();
    mockRowsState.rows = [
      pestRow({ id: 'pre-1', annual_prepay_term_id: 'term-1', prepaid_amount: 49.01 }),
    ];
    const alloc = await applyFrozenExistingServiceExtension({
      database: allocDb, customerId: 'c1', estimateId: 'e1',
      estimateData: prepaidSnapshotData({ rowIds: ['pre-1'] }), activatedTier: 'Silver',
    });
    expect(alloc.creditAmount).toBe(0);
    expect(mockPostCreditMovement).not.toHaveBeenCalled();
    expect(alloc.reviewFamilies).toEqual([
      'Pest Control (1 prepaid visit whose paid allocation changed since the estimate — credit manually)',
    ]);
  });

  test('locked allocation read failure parks the family uncredited', async () => {
    const { database } = fakeTrx({ lockThrows: true });
    mockRowsState.rows = [
      pestRow({ id: 'pre-1', annual_prepay_term_id: 'term-1', prepaid_amount: 49 }),
    ];
    const summary = await applyFrozenExistingServiceExtension({
      database, customerId: 'c1', estimateId: 'e1',
      estimateData: prepaidSnapshotData({ rowIds: ['pre-1'] }), activatedTier: 'Silver',
    });
    expect(summary.applied).toBe(false);
    expect(summary.creditAmount).toBe(0);
    expect(mockPostCreditMovement).not.toHaveBeenCalled();
    expect(summary.reviewFamilies).toEqual([
      'Pest Control (could not verify paid allocations — credit manually)',
    ]);
    expect(summary.dirtyFamilies).toEqual(['pest_control']);
  });

  // Refund-clawback fast-follow: grants mint one ledger movement PER TERM,
  // each carrying the "(term <id>, estimate <id>)" marker the annual-prepay
  // reversal selects and dedupes by, and invoice_id anchored to the term's
  // prepay invoice for the sweep recovery leg.
  test('credits spanning two prepay terms mint one marker-carrying grant per term', async () => {
    const { database } = fakeTrx({
      prepayTerms: [
        { id: 'term-1', prepay_invoice_id: 'inv-t1' },
        { id: 'term-2', prepay_invoice_id: 'inv-t2' },
      ],
    });
    mockRowsState.rows = [
      pestRow({ id: 'pre-1', annual_prepay_term_id: 'term-1', prepaid_amount: 49 }),
      pestRow({ id: 'pre-2', scheduled_date: '2100-01-27', annual_prepay_term_id: 'term-2', prepaid_amount: 49 }),
    ];
    const summary = await applyFrozenExistingServiceExtension({
      database, customerId: 'c1', estimateId: 'e1',
      estimateData: prepaidSnapshotData(), activatedTier: 'Silver',
    });
    expect(summary.creditAmount).toBe(9.8);
    expect(mockPostCreditMovement).toHaveBeenCalledTimes(2);
    const payloads = mockPostCreditMovement.mock.calls.map(([p]) => p);
    expect(payloads).toEqual([
      expect.objectContaining({
        customerId: 'c1',
        delta: 4.9,
        source: 'adjustment',
        invoiceId: 'inv-t1',
        note: expect.stringContaining('(term term-1, estimate e1)'),
        createdBy: 'system:waveguard_tier_extension',
      }),
      expect.objectContaining({
        delta: 4.9,
        invoiceId: 'inv-t2',
        note: expect.stringContaining('(term term-2, estimate e1)'),
        createdBy: 'system:waveguard_tier_extension',
      }),
    ]);
    // Marker must satisfy the reversal's LIKE '%term <id>,%' selector.
    expect(payloads[0].note).toContain('term term-1,');
  });

  test('a missing prepay-invoice anchor still grants — marker only, no anchor', async () => {
    // The anchor is best-effort: an unresolvable term lookup must not park
    // a credit the customer is owed — the marker alone still supports the
    // in-line clawback.
    const { database } = fakeTrx();
    mockRowsState.rows = [
      pestRow({ id: 'pre-1', annual_prepay_term_id: 'term-1', prepaid_amount: 49 }),
    ];
    const summary = await applyFrozenExistingServiceExtension({
      database, customerId: 'c1', estimateId: 'e1',
      estimateData: prepaidSnapshotData({ rowIds: ['pre-1'] }), activatedTier: 'Silver',
    });
    expect(summary.creditAmount).toBe(4.9);
    expect(mockPostCreditMovement).toHaveBeenCalledTimes(1);
    expect(mockPostCreditMovement.mock.calls[0][0]).toMatchObject({
      delta: 4.9,
      invoiceId: null,
      note: expect.stringContaining('(term term-1, estimate e1)'),
    });
  });

  // Mint-serialization fast-follow: primary_line_price is the figure
  // invoice lines PREFER, so a reprice moves it in lockstep — or parks
  // when it disagrees with the contracted price.
  test('a set primary_line_price that matches the contracted price is co-repriced', async () => {
    const { database, updates } = fakeTrx();
    mockRowsState.rows = [pestRow({ id: 'row-1', primary_line_price: 55 })];
    const summary = await applyFrozenExistingServiceExtension({
      database, customerId: 'c1', estimateId: 'e1',
      estimateData: frozenSnapshotData({ rowIds: ['row-1'] }), activatedTier: 'Silver',
    });
    expect(summary.applied).toBe(true);
    expect(updates).toEqual([
      { id: 'row-1', estimated_price: 49.5, primary_line_price: 49.5 },
    ]);
  });

  test('a set primary_line_price that DISAGREES with the contracted price parks as drift', async () => {
    const { database, updates } = fakeTrx();
    mockRowsState.rows = [pestRow({ id: 'row-1', primary_line_price: 40 })];
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

  test('family row lock failure parks the family before any probe or write', async () => {
    const { database, updates, auditRows } = fakeTrx({ familyLockThrows: true });
    mockRowsState.rows = [pestRow({ id: 'row-1' })];
    const summary = await applyFrozenExistingServiceExtension({
      database, customerId: 'c1', estimateId: 'e1',
      estimateData: frozenSnapshotData({ rowIds: ['row-1'] }), activatedTier: 'Silver',
    });
    expect(updates).toEqual([]);
    expect(auditRows).toEqual([]);
    expect(summary.applied).toBe(false);
    expect(summary.reviewFamilies).toEqual([
      'Pest Control (could not lock appointments — apply manually)',
    ]);
    expect(summary.dirtyFamilies).toEqual(['pest_control']);
  });
});
