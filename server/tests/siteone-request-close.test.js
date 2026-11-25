/**
 * purchase-receipts/siteone-request-close.js — the rule that lets a logged
 * SiteOne invoice line close the robot's own request. The predicates run for
 * real; the transaction is scripted. The SQL, the locks and the ledger-bell
 * settle run on PostgreSQL in purchase-receipts-postgres.test.js.
 */
// poNumberFor stands in for order-dispatch's own (the Mac adapter's PO); the closer must defer to it, never rebuild it.
const mockOrderDispatch = {
  orderedQuantityFor: jest.fn(), settleRequestLedgerBells: jest.fn(async () => {}),
  _internals: { poNumberFor: jest.fn((ledger) => `PO-OF-${ledger.id}`) },
};
jest.mock('../services/procurement/order-dispatch', () => mockOrderDispatch);

const {
  closeRequestCoveredByLine, isRobotOrderedRequest, ledgerPlacedBefore, lineCoversOrder, purchaseOrderMatches,
} = require('../services/purchase-receipts/siteone-request-close');

const RECEIVED = '2026-11-20T15:00:00Z';
const PLACED = '2026-11-20T13:00:00Z';

describe('predicates', () => {
  test('only an ordered request the auto-reorder sweep raised is the robot\'s', () => {
    expect(isRobotOrderedRequest({ status: 'ordered', source: 'auto_reorder' })).toBe(true);
    expect(isRobotOrderedRequest({ status: 'open', source: 'auto_reorder' })).toBe(false);
    expect(isRobotOrderedRequest({ status: 'ordered', source: 'manual' })).toBe(false);
    expect(isRobotOrderedRequest(null)).toBe(false);
  });

  test.each([
    ['a placed SiteOne order dated before the email', { status: 'placed', adapter: 'siteone', placed_at: PLACED }, true],
    ['an order placed after the email', { status: 'placed', adapter: 'siteone', placed_at: '2026-11-20T16:00:00Z' }, false],
    ['an order placed at the same instant', { status: 'placed', adapter: 'siteone', placed_at: RECEIVED }, false],
    ['no placed_at', { status: 'placed', adapter: 'siteone', placed_at: null }, false],
    ['a parked order', { status: 'needs_review', adapter: 'siteone', placed_at: PLACED }, false],
    ['another vendor\'s order', { status: 'placed', adapter: 'stickermule', placed_at: PLACED }, false],
    ['a revoked order', { status: 'placed', adapter: 'siteone', placed_at: PLACED, evidence: { revokedAt: RECEIVED } }, false],
    ['a revoked order whose evidence is JSON text', { status: 'placed', adapter: 'siteone', placed_at: PLACED, evidence: JSON.stringify({ revokedAt: RECEIVED }) }, false],
    ['no ledger row', null, false],
  ])('ledger: %s', (_label, ledger, expected) => {
    expect(ledgerPlacedBefore(ledger, RECEIVED)).toBe(expected);
  });

  test('ledger: an unreadable email time never matches', () => {
    expect(ledgerPlacedBefore({ status: 'placed', adapter: 'siteone', placed_at: PLACED }, 'not a date')).toBe(false);
  });

  test.each([
    [78, 78, true], [156, 78, true], [77.9, 78, false], [0, 78, false], [78, 0, false], [78, null, false], [78, NaN, false],
  ])('a line of %s against an order of %s', (line, ordered, expected) => {
    expect(lineCoversOrder(line, ordered)).toBe(expected);
  });
});

describe('purchaseOrderMatches', () => {
  test.each([
    ['the exact PO', 'PO-OF-v1', true],
    ['the PO in other case, padded', '  po-of-v1 ', true],
    ['a different PO', 'PO-OF-v2', false],
    ['a PO that merely contains it', 'PO-OF-v1-X', false],
    ['a blank PO', '   ', false],
    ['no PO', null, false],
    ['a non-string PO', 42, false],
  ])('%s', (_label, printed, expected) => {
    expect(purchaseOrderMatches({ id: 'v1' }, printed)).toBe(expected);
  });
  test('no ledger row never matches', () => {
    expect(purchaseOrderMatches(null, 'PO-OF-v1')).toBe(false);
  });
});

// A scripted transaction: reads return what the test sets; writes are recorded.
// lockHeld makes a NOWAIT lock fail the way Postgres does.
function scriptedTrx({ live = [], ledger, request, lockHeld = false }) {
  const calls = { updates: [], locks: [] };
  const trx = (table) => {
    const q = { table };
    q.where = (cond) => { q.cond = cond; return q; };
    q.whereIn = () => q;
    q.select = async () => live;
    q.forUpdate = () => { q.locking = true; return q; };
    q.noWait = () => { calls.locks.push(table); return q; };
    q.first = async () => {
      if (q.locking && lockHeld) throw Object.assign(new Error('could not obtain lock on row'), { code: '55P03' });
      return table === 'vendor_orders' ? ledger : request;
    };
    q.update = async (patch) => { calls.updates.push({ table, cond: q.cond, patch }); return 1; };
    return q;
  };
  return { trx, calls };
}

describe('closeRequestCoveredByLine', () => {
  const args = {
    vendor: 'siteone', productId: 'p1', product: { inventory_unit: 'fl_oz' }, email: { id: 'e1', received_at: RECEIVED },
    orderNumber: 'INV-1', lineNo: 2, movementId: 'm1', receivedQty: 78, receivedUnit: 'fl_oz', purchaseOrder: 'PO-OF-v1',
  };
  const robot = { id: 'r1', status: 'ordered', source: 'auto_reorder', requested_quantity: '78', unit: 'fl_oz', metadata: { keep: 1 } };
  const placed = { id: 'v1', status: 'placed', adapter: 'siteone', placed_at: PLACED, evidence: {} };

  beforeEach(() => {
    mockOrderDispatch.orderedQuantityFor.mockReset().mockResolvedValue(78);
    mockOrderDispatch.settleRequestLedgerBells.mockClear();
  });

  test('closes the one candidate, keeps its metadata, and settles the ledger bells', async () => {
    const { trx, calls } = scriptedTrx({ live: [robot], ledger: placed, request: robot });
    expect(await closeRequestCoveredByLine(trx, args)).toBe('r1');
    expect(calls.locks).toEqual(['vendor_orders', 'product_restock_requests']);
    expect(calls.updates).toHaveLength(1);
    expect(calls.updates[0].patch).toMatchObject({
      status: 'received', closed_by: null,
      metadata: { keep: 1, closedByReceipt: { emailId: 'e1', orderNumber: 'INV-1', lineNo: 2, movementId: 'm1', purchaseOrder: 'PO-OF-v1' } },
    });
    expect(mockOrderDispatch.settleRequestLedgerBells).toHaveBeenCalledWith(trx, 'r1');
  });

  test('the PO is the ledger row\'s own, from order-dispatch', async () => {
    const { trx } = scriptedTrx({ live: [robot], ledger: placed, request: robot });
    await closeRequestCoveredByLine(trx, args);
    expect(mockOrderDispatch._internals.poNumberFor).toHaveBeenCalledWith(placed);
  });

  test('a ledger that recorded no dispatched quantity closes nothing, whatever requested_quantity says', async () => {
    mockOrderDispatch.orderedQuantityFor.mockResolvedValue(null);
    const { trx, calls } = scriptedTrx({ live: [robot], ledger: placed, request: robot });
    expect(await closeRequestCoveredByLine(trx, args)).toBeNull();
    expect(calls.updates).toEqual([]);
  });

  test('the ordered quantity is converted to the line\'s unit', async () => {
    const gallon = { ...robot, unit: 'gal' };
    mockOrderDispatch.orderedQuantityFor.mockResolvedValue(1);
    const { trx } = scriptedTrx({ live: [gallon], ledger: placed, request: gallon });
    // 1 gal = 128 fl oz: a 78 fl oz line is short, a 128 fl oz line covers it.
    expect(await closeRequestCoveredByLine(trx, args)).toBeNull();
    expect(await closeRequestCoveredByLine(trx, { ...args, receivedQty: 128 })).toBe('r1');
  });

  test('an unconvertible unit closes nothing', async () => {
    const odd = { ...robot, unit: 'bag' };
    const { trx, calls } = scriptedTrx({ live: [odd], ledger: placed, request: odd });
    expect(await closeRequestCoveredByLine(trx, args)).toBeNull();
    expect(calls.updates).toEqual([]);
  });

  test('the matched request held by another transaction throws, so the line rolls back and retries', async () => {
    const { trx, calls } = scriptedTrx({ live: [robot], ledger: placed, request: robot, lockHeld: true });
    await expect(closeRequestCoveredByLine(trx, args)).rejects.toThrow(/held by another action.*retries on the next sweep/);
    expect(calls.updates).toEqual([]);
  });

  test('a lock failure that is not a held row is rethrown as is', async () => {
    const { trx } = scriptedTrx({ live: [robot], ledger: placed, request: robot });
    const boom = Object.assign(new Error('connection lost'), { code: '08006' });
    const broken = (table) => { const q = trx(table); q.first = async () => { throw boom; }; return q; };
    await expect(closeRequestCoveredByLine(broken, args)).rejects.toBe(boom);
  });

  test.each([
    ['an Amazon line', { vendor: 'amazon' }, { live: [robot], ledger: placed, request: robot }],
    ['an invoice with no PO', { purchaseOrder: null }, { live: [robot], ledger: placed, request: robot }],
    ['an invoice with another order\'s PO', { purchaseOrder: 'PO-OF-v9' }, { live: [robot], ledger: placed, request: robot }],
    ['no live request', {}, { live: [], ledger: placed, request: robot }],
    ['two live requests', {}, { live: [robot, { id: 'r2', status: 'open', source: 'manual' }], ledger: placed, request: robot }],
    ['a hand-raised request', {}, { live: [{ ...robot, source: 'manual' }], ledger: placed, request: robot }],
    ['an open request', {}, { live: [{ ...robot, status: 'open' }], ledger: placed, request: robot }],
    ['no ledger row', {}, { live: [robot], ledger: undefined, request: robot }],
    ['a request that changed after the pre-check', {}, { live: [robot], ledger: placed, request: { ...robot, status: 'received' } }],
    ['an order placed after the email', {}, { live: [robot], ledger: { ...placed, placed_at: '2026-11-20T16:00:00Z' }, request: robot }],
    ['a short line', { receivedQty: 77 }, { live: [robot], ledger: placed, request: robot }],
  ])('leaves it alone for %s', async (_label, override, script) => {
    const { trx, calls } = scriptedTrx(script);
    expect(await closeRequestCoveredByLine(trx, { ...args, ...override })).toBeNull();
    expect(calls.updates).toEqual([]);
    expect(mockOrderDispatch.settleRequestLedgerBells).not.toHaveBeenCalled();
  });
});
