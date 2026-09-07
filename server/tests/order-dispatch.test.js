/**
 * procurement/order-dispatch.js — the auto-order dispatcher.
 *
 * Contract:
 *   - master gate off → {skipped:'gated', belled} — no claim, the request is handed off
 *   - vendor gate off / no adapter → skipped, NO ledger row
 *   - the ledger claim (status placing) is inserted BEFORE the adapter is
 *     called; a conflicting claim skips (already_claimed) with no call
 *   - no eligible price row (vendor SKU) → needs_review 'no_price', bell
 *   - no identical prior vendor order → needs_review 'no_binding_total'
 *   - caps: both env vars required; per-order and monthly (non-failed rows
 *     count) → needs_review, request stays open, bell; the monthly check is
 *     an advisory-locked reservation that writes amount_cents before the call
 *   - placed → ledger placed + request ordered + audit, NO bell
 *   - RefusedError → needs_review (reason = refuse code); ambiguous →
 *     needs_review 'ambiguous_after_submit'; other error → failed + bell
 *   - run-level error → claim released (row deleted), error propagates
 *   - a request cancelled while the vendor call was in flight goes back to
 *     ordered, the ledger is placed, and ONE reconcile bell rings
 *   - canAutoOrder mirrors the gates + adapter map + vendor active
 *   - the claim re-checks the sweep's eligibility (active, enabled, still
 *     low) and CANCELS a request the catalog no longer authorizes
 *   - every adapter needs the eligible price row; the vendor quantity is
 *     packages (SiteOne, pack size from the row) or a count (Sticker Mule)
 *   - a bell that fails to send is persisted (evidence.bell, bellAt null),
 *     reported, and re-rung by the next run
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/vendor-credentials', () => ({ getVendorLoginCredentials: jest.fn(async () => ({ email: 'a@b.c', password: 'x', accountNumber: '123' })) }));
jest.mock('../services/audit-log', () => ({ auditVendorOrder: jest.fn(async () => 'audit-1') }));
jest.mock('../services/procurement/auto-reorder', () => ({
  vendorPricingFor: jest.fn(async () => mockState.pricing),
  // The claim takes the product's pricing advisory lock FIRST (Codex r10 P1)
  // — recorded so the placed test can assert it precedes the row locks.
  lockProductPricing: jest.fn(async (trx, productId) => { mockState.advisoryLocks = [...(mockState.advisoryLocks || []), productId]; }),
  // The sweep's request-id-deduped bell, reused for the undispatchable hand-off (Codex r12 P2).
  ringRestockBell: jest.fn(async ({ notify, product, request }) => notify('system', `Restock: ${product.name} is low`, 'order manually', { bell: true, dedupeKey: `auto-reorder:${request.id}` })),
}));

const mockState = { request: null, vendor: null, product: null, pricing: null, ledgerRows: [], freshRequestStatus: 'open', monthly: 0, claimConflict: false, updates: [], deletes: [], sibling: null, stale: [], pendingBells: [], ledgerSettled: false, liveAutoOrder: null, priorUnreconciled: null, dispatchedLedger: null };

jest.mock('../models/db', () => {
  const mkChain = (table) => {
    const q = {};
    for (const m of ['join', 'leftJoin', 'where', 'whereNot', 'whereNull', 'whereNotNull', 'whereRaw', 'select', 'orderBy', 'forUpdate', 'modify']) q[m] = () => q;
    q.whereIn = (col) => { if (col === 'vo.status') q._pendingBells = true; return q; };
    q.where = (w) => { q._where = w; return q; };
    q.whereRaw = (sql, bindings) => { (q._raws = q._raws || []).push([sql, bindings]); return q; };
    q.first = async (...cols) => {
      if (cols[0] === 'vo.status') return mockState.liveAutoOrderAfterBell && mockState.bellRung ? mockState.liveAutoOrderAfterBell : mockState.liveAutoOrder; // findLiveAutoOrder's aliased join (a claim landing after the hand-off bell: liveAutoOrderAfterBell)
      if (table === 'vendor_orders' && cols[0] === 'id' && cols[1] === 'status') return { id: 'ledger-1', status: mockState.ledgerSettled ? 'needs_review' : 'placing' }; // recordPlaced's locked ledger read
      // deliverBell's locked version read: the row's CURRENT bell is the one being delivered (the park's / the pending row's), unless a test replaced it (bellStampMiss).
      if (table === 'vendor_orders' && cols[0] === 'id' && cols[1] === 'evidence') { const pending = mockState.pendingBells.find((r) => r.id === q._where?.id); return { id: q._where?.id, evidence: { bell: { v: mockState.bellStampMiss ? 'replaced' : (pending?.evidence?.bell?.v ?? mockState.currentBellV ?? null) } } }; }
      if (table === 'vendor_orders' && cols.length === 1 && cols[0] === 'id') return mockState.requestLedger || null; // settleRequestLedgerBells' row (null = the request has no ledger row); the lock-only reads ignore the value
      if (cols[0] === 'vo.id') return mockState.priorUnreconciled; // the claim's prior-order belt
      if (cols[0] === 'request_payload') return mockState.dispatchedLedger; // orderedQuantityFor
      if (cols[0] === 'evidence' && table === 'vendor_orders') return { evidence: mockState.parkedEvidence || {} }; // attachLatePlacement
      if (cols[0] === 'amount_cents' && table === 'vendor_orders') { const r = [...mockState.updates].reverse().find((u) => u.table === 'vendor_orders' && u.row.amount_cents != null); return { amount_cents: r ? r.row.amount_cents : null, created_at: mockState.reservedAt || null }; } // settledFinalCents: the reserved amount
      if (table === 'product_restock_requests') {
        if (cols[0] === 'status') return { status: mockState.freshRequestStatus, source: mockState.request?.source }; // the mid-flight re-reads (recordPlaced, bellUndispatchable's post-write re-check)
        if (cols[0] === 'id') return mockState.sibling; // the sibling live-request probe
        return mockState.request;
      }
      if (table === 'vendors') return mockState.vendor;
      if (table === 'products_catalog') return mockState.product;
      if (table === 'vendor_orders') return { total: mockState.monthly };
      return null;
    };
    q.sum = () => q;
    // A vendor_orders update returns 0 rows when the ledger row already left 'placing' (mockState.ledgerSettled).
    // (a status transition, or the cap reservation's amount-only write — the green path's order-facts attach carries external_order_number and still lands).
    q.update = async (row) => { if (table === 'notifications' && mockState.bellRetireThrows) throw new Error('bell retire lost connection'); if (table === 'vendor_orders' && row.status && mockState.parkThrowsOnce) { mockState.parkThrowsOnce = false; throw new Error('park lost connection'); } if (table === 'vendor_orders' && typeof row.evidence === 'string') { try { const v = JSON.parse(row.evidence).bell?.v; if (v) mockState.currentBellV = v; } catch { /* not a bell write */ } } mockState.updates.push({ table, row, ...(q._raws ? { raws: q._raws } : {}) }); if (table === 'vendor_orders' && mockState.bellStampMiss && row.evidence && !row.status) return 0; return table === 'vendor_orders' && mockState.ledgerSettled && (row.status || (row.amount_cents != null && row.external_order_number === undefined)) ? 0 : 1; };
    q.delete = async () => { mockState.deletes.push(table); return 1; };
    let row;
    const returning = async () => {
      if (mockState.claimConflict) return [];
      const saved = { id: `ledger-${mockState.ledgerRows.length + 1}`, ...row };
      mockState.ledgerRows.push(saved);
      return [saved];
    };
    q.insert = (r) => { row = r; return { onConflict: () => ({ ignore: () => ({ returning }), merge: () => ({ whereRaw: () => ({ returning }), returning }) }), returning }; };
    q.then = (ok, err) => Promise.resolve(table.startsWith('vendor_orders') ? (q._pendingBells ? mockState.pendingBells : mockState.stale) : (table.startsWith('product_restock_requests') ? (mockState.dispatchable || []) : [])).then(ok, err);
    return q;
  };
  const dbFn = jest.fn((table) => mkChain(String(table)));
  dbFn.raw = jest.fn(async (sql, bindings) => { try { const v = JSON.parse(bindings?.[0]).bell?.v; if (v) mockState.currentBellV = v; } catch { /* not a bell write */ } return sql; }); // the late-placement attach writes its bell through raw
  dbFn.transaction = async (fn) => fn(dbFn);
  return dbFn;
});

const { auditVendorOrder } = require('../services/audit-log');
const dispatch = require('../services/procurement/order-dispatch');

const ENV = { GATE_AUTO_ORDER: 'true', GATE_AUTO_ORDER_STICKERMULE: 'true', GATE_AUTO_ORDER_SITEONE: 'true', STICKERMULE_API_KEY: 'test-key', AUTO_ORDER_MAX_PER_ORDER_CENTS: '50000', AUTO_ORDER_MAX_MONTHLY_CENTS: '100000' };
const baseRequest = () => ({ id: 'req-1', product_id: 'prod-sticker', status: 'open', source: 'auto_reorder', requested_quantity: '500', unit: 'each', metadata: { vendorId: 'vend-sm', vendorSku: '4242' } });
const stickerMule = { id: 'vend-sm', name: 'Sticker Mule', code: 25, active: true };
const sticker = { id: 'prod-sticker', name: 'Yard sign sticker', active: true, auto_reorder_enabled: true, inventory_on_hand: '40', low_stock_threshold: '100', auto_reorder_vendor_id: 'vend-sm', reorder_quantity: '500', inventory_unit: 'each' };
const talstar = { id: 'prod-chem', name: 'Talstar', active: true, auto_reorder_enabled: true, inventory_on_hand: '20', low_stock_threshold: '64', auto_reorder_vendor_id: 'vend-s1', reorder_quantity: '256', inventory_unit: 'fl_oz' };

function mockAdapter(overrides = {}) {
  return { key: 'stickermule', preSubmitTotal: 'vendor', bindingQuote: jest.fn(async () => ({ cents: 31400, source: 'order SM-0' })), place: jest.fn(async () => ({ externalOrderNumber: 'SM-1', amountCents: 31400, response: { ok: 1 }, evidence: { itemId: 4242 } })), ...overrides };
}

let notify;
beforeEach(() => {
  Object.assign(mockState, { request: baseRequest(), vendor: stickerMule, product: sticker, pricing: { vendor_sku: '4242', price: '314.00', quantity: '500' }, ledgerRows: [], freshRequestStatus: 'open', monthly: 0, claimConflict: false, updates: [], deletes: [], sibling: null, stale: [], pendingBells: [], ledgerSettled: false, liveAutoOrder: null, priorUnreconciled: null, dispatchedLedger: null, currentBellV: null });
  for (const k of Object.keys(ENV)) process.env[k] = ENV[k];
  notify = jest.fn(async () => ({ id: 'n1' }));
  auditVendorOrder.mockClear();
});
afterAll(() => { for (const k of Object.keys(ENV)) delete process.env[k]; });

const run = (adapter, opts = {}) => dispatch.dispatchRestockOrder('req-1', { notify, adapters: { stickermule: adapter, siteone: adapter }, ...opts });
// The last ledger write with a status: the bellAt stamp that follows a bell is a separate evidence-only update.
const lastLedgerPatch = () => mockState.updates.filter((u) => u.table === 'vendor_orders' && u.row.status).pop().row;
const ledgerStatus = () => mockState.updates.filter((u) => u.table === 'vendor_orders').map((u) => u.row.status).filter(Boolean).pop();
const requestStatus = () => mockState.updates.filter((u) => u.table === 'product_restock_requests').map((u) => u.row.status).pop();

test('master gate off → no claim; the request is handed off with the sweep\'s deduped bell (Codex r18 P2)', async () => {
  process.env.GATE_AUTO_ORDER = 'false';
  const a = mockAdapter();
  expect(await run(a)).toEqual({ requestId: 'req-1', skipped: 'gated', belled: true });
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify.mock.calls[0][3].dedupeKey).toMatch(/^auto-reorder:/);
  expect(mockState.ledgerRows).toHaveLength(0);
  expect(a.place).not.toHaveBeenCalled();
});

test('vendor gate off → skipped, no ledger row', async () => {
  process.env.GATE_AUTO_ORDER_STICKERMULE = 'false';
  expect((await run(mockAdapter())).skipped).toBe('vendor_gated');
  expect(mockState.ledgerRows).toHaveLength(0);
});

test('vendor without an adapter → skipped, no ledger row', async () => {
  mockState.vendor = { id: 'vend-g', name: 'Gemplers', code: 24, active: true };
  expect((await run(mockAdapter())).skipped).toBe('no_adapter');
  expect(mockState.ledgerRows).toHaveLength(0);
});

test('a hand-off for a request received or cancelled since it was scanned rings NO bell — requestClosed, not bellLost (Codex r26 P2)', async () => {
  delete process.env.GATE_AUTO_ORDER;
  mockState.request = { ...baseRequest(), status: 'cancelled' };
  expect(await run(mockAdapter())).toEqual({ requestId: 'req-1', skipped: 'gated', requestClosed: true });
  expect(notify).not.toHaveBeenCalled();
  expect(mockState.updates.filter((u) => u.table === 'notifications')).toHaveLength(0);
});

test('placed: claim first, then ledger placed + request ordered + audit, no bell', async () => {
  mockState.advisoryLocks = [];
  const a = mockAdapter();
  const r = await run(a);
  expect(mockState.advisoryLocks).toHaveLength(1); // pricing advisory lock taken by the claim (Codex r10 P1)
  expect(r.status).toBe('placed');
  expect(r.externalOrderNumber).toBe('SM-1');
  expect(mockState.ledgerRows[0]).toMatchObject({ status: 'placing', adapter: 'stickermule', restock_request_id: 'req-1' });
  expect(a.bindingQuote).toHaveBeenCalledWith({ vendorSku: '4242', quantity: 500 });
  expect(a.place).toHaveBeenCalledWith(expect.objectContaining({ vendorSku: '4242', quantity: 500, quoteCents: 31400 }));
  expect(ledgerStatus()).toBe('placed');
  expect(requestStatus()).toBe('ordered');
  expect(auditVendorOrder).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'placed', amount_cents: 31400, external_order_number: 'SM-1' }));
  expect(notify).not.toHaveBeenCalled();
});

test('a conflicting claim skips without calling the adapter', async () => {
  mockState.claimConflict = true;
  const a = mockAdapter();
  expect((await run(a)).skipped).toBe('already_claimed');
  expect(a.place).not.toHaveBeenCalled();
});

test('no eligible price → needs_review no_price, adapter never called, one bell', async () => {
  mockState.pricing = null;
  const a = mockAdapter();
  const r = await run(a);
  expect(r).toMatchObject({ status: 'needs_review', reason: 'no_price' });
  expect(a.place).not.toHaveBeenCalled();
  expect(ledgerStatus()).toBe('needs_review');
  expect(requestStatus()).toBeUndefined();
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify.mock.calls[0][3]).toMatchObject({ bell: true, dedupeKey: expect.stringMatching(/^auto-order:ledger-1:[a-z0-9]+$/) }); // versioned (r3 P1)
});

test('caps unconfigured → needs_review, no order', async () => {
  delete process.env.AUTO_ORDER_MAX_MONTHLY_CENTS;
  const a = mockAdapter();
  expect(await run(a)).toMatchObject({ status: 'needs_review', reason: 'caps_unconfigured' });
  expect(a.place).not.toHaveBeenCalled();
});

test('over the per-order cap → needs_review, request stays open', async () => {
  process.env.AUTO_ORDER_MAX_PER_ORDER_CENTS = '10000';
  const a = mockAdapter();
  expect(await run(a)).toMatchObject({ status: 'needs_review', reason: 'over_per_order_cap' });
  expect(a.place).not.toHaveBeenCalled();
  expect(requestStatus()).toBeUndefined();
});

test('monthly cap counts non-failed rows already in the ledger', async () => {
  mockState.monthly = 80000;
  const a = mockAdapter();
  expect(await run(a)).toMatchObject({ status: 'needs_review', reason: 'over_monthly_cap' });
  expect(a.place).not.toHaveBeenCalled();
});

test('the monthly cap buckets by the RESERVATION-stamped created_at (fixed accounting month) and the reservation re-stamps created_at (pre-push P0, Codex r14 P1)', async () => {
  const dbFn = require('../models/db');
  const orig = dbFn.getMockImplementation();
  const raws = [];
  dbFn.mockImplementation((table) => { const q = orig(table); if (table === 'vendor_orders') { const w = q.whereRaw; q.whereRaw = (...a) => { raws.push(a); return w ? w.apply(q, a) : q; }; } return q; });
  const before = Date.now();
  expect(await run(mockAdapter())).toMatchObject({ status: 'placed' });
  dbFn.mockImplementation(orig);
  expect(raws.some((a) => /COALESCE\(placed_at, created_at\)/.test(String(a[0])))).toBe(false); // the bucket is the reservation stamp, never placed_at (Codex r14 P1)
  const reservation = mockState.updates.find((u) => u.table === 'vendor_orders' && u.row.amount_cents === 31400 && u.row.created_at);
  expect(reservation).toBeTruthy();
  expect(reservation.row.created_at.getTime()).toBeGreaterThanOrEqual(before);
});

test('the claim retires the request\'s manual bell in its own transaction; a failed retire aborts the claim — nothing ordered (Codex r20 P1)', async () => {
  const a = mockAdapter();
  expect(await run(a)).toMatchObject({ status: 'placed' });
  const retired = mockState.updates.filter((u) => u.table === 'notifications');
  expect(retired).toHaveLength(2); // the request's manual bell + the ledger's (dry-run) bell keyspace
  expect(retired.every((u) => u.row.read_at instanceof Date)).toBe(true);
  mockState.updates = []; mockState.ledgerRows = [];
  mockState.bellRetireThrows = true;
  const b = mockAdapter();
  try {
    await expect(run(b)).rejects.toThrow('bell retire lost connection');
    expect(b.place).not.toHaveBeenCalled();
    expect(mockState.ledgerRows).toHaveLength(0);
  } finally { mockState.bellRetireThrows = false; }
});

test('a claim another pod inserts while the hand-off bell is being written retires that bell after the write (Codex r29 P1)', async () => {
  process.env.GATE_AUTO_ORDER = 'false';
  mockState.liveAutoOrderAfterBell = { status: 'placing', external_order_number: null, vendor_name: 'Sticker Mule' };
  notify = jest.fn(async () => { mockState.bellRung = true; return { id: 'n1' }; });
  try {
    const r = await run(mockAdapter());
    expect(r).toEqual({ requestId: 'req-1', skipped: 'gated', autoOrderLive: true });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(mockState.updates.some((u) => u.table === 'notifications' && u.row.read_at instanceof Date)).toBe(true); // the just-written bell retired
  } finally { mockState.liveAutoOrderAfterBell = null; mockState.bellRung = false; }
});

test('stale recovery of a claim whose request an older pod received meanwhile parks WITH landedAfterReceive (Codex r29 P1)', async () => {
  mockState.stale = [{ id: 'ledger-old', adapter: 'stickermule', amount_cents: 31400, created_at: new Date(Date.now() - 3600e3), request_id: 'req-old', product_name: 'Sticker', vendor_id: 'vend-sm', vendor_name: 'Sticker Mule' }];
  mockState.freshRequestStatus = 'received'; // read under the park's locks, not from the scan (Codex r30 P1)
  const r = await dispatch.recoverStalePlacing({ notify });
  expect(r.recovered).toEqual(['ledger-old']);
  const patch = mockState.updates.find((u) => u.table === 'vendor_orders' && u.row.status).row;
  expect(patch.status).toBe('needs_review');
  expect(JSON.parse(patch.evidence).landedAfterReceive).toEqual(expect.any(String));
});

test('master gate off with an automatic order already OUT for the product → no "order manually" hand-off bell (hook r27 P0/P1)', async () => {
  process.env.GATE_AUTO_ORDER = 'false';
  mockState.liveAutoOrder = { status: 'needs_review', external_order_number: null, vendor_name: 'Sticker Mule' }; // an ambiguous-submit park left the request open
  const r = await run(mockAdapter());
  expect(r).toEqual({ requestId: 'req-1', skipped: 'gated', autoOrderLive: true });
  expect(notify).not.toHaveBeenCalled();
  expect(mockState.ledgerRows).toHaveLength(0);
});

test('a handback (gate off after the claim marked the bell read) reopens the deduped bell (Codex r20 P2)', async () => {
  mockState.vendor = { ...mockState.vendor, active: false };
  const r = await run(mockAdapter());
  expect(r).toMatchObject({ skipped: 'no_adapter', belled: true });
  const reopened = mockState.updates.find((u) => u.table === 'notifications' && u.row.read_at === null);
  expect(reopened).toBeTruthy();
});

test('an adapter without its credential does not own requests: canAutoOrder is false until STICKERMULE_API_KEY is set (Codex r20 P2)', async () => {
  const key = process.env.STICKERMULE_API_KEY;
  delete process.env.STICKERMULE_API_KEY;
  try {
    expect(await dispatch.canAutoOrder({ vendor: stickerMule })).toBe(false);
  } finally { process.env.STICKERMULE_API_KEY = key; }
  expect(await dispatch.canAutoOrder({ vendor: stickerMule })).toBe(true);
});

test('re-arming a dry-run row retires its "nothing was submitted" bell inside the claim (pre-push P0)', async () => {
  const dry = mockAdapter({ place: jest.fn(async () => ({ dryRun: true, amountCents: 31400, evidence: { dryRun: true } })) });
  expect(await run(dry)).toMatchObject({ status: 'needs_review', reason: 'dry_run' });
  mockState.updates = []; mockState.ledgerRows = [];
  expect(await run(mockAdapter())).toMatchObject({ status: 'placed' });
  const retired = mockState.updates.filter((u) => u.table === 'notifications' && u.row.read_at instanceof Date);
  expect(retired.length).toBeGreaterThanOrEqual(2); // the request's manual bell + the ledger's dry-run bell
});

test('an adapter without its credential does not CLAIM either: handed back with the bell, no ledger row, manual bell untouched (Codex r21 P2)', async () => {
  const a = { ...mockAdapter(), configured: () => false };
  const r = await dispatch.dispatchRestockOrder('req-1', { notify, adapters: { stickermule: a, siteone: a } });
  expect(r).toMatchObject({ skipped: 'adapter_unconfigured', belled: true });
  expect(mockState.ledgerRows).toHaveLength(0);
  expect(a.place).not.toHaveBeenCalled();
  expect(mockState.updates.filter((u) => u.table === 'notifications' && u.row.read_at instanceof Date)).toHaveLength(0);
});

test('the claim stamps the SKU + link it actually authorized onto the request when the eligible price row changed since the sweep (Codex r21 P2)', async () => {
  mockState.request = { ...baseRequest(), metadata: { vendorId: 'vend-sm', vendorSku: 'OLD-1', vendorProductUrl: 'https://old.example/1' } };
  mockState.pricing = { vendor_sku: '4242', price: '314.00', quantity: '500', vendor_product_url: 'https://stickermule.com/4242' };
  expect(await run(mockAdapter())).toMatchObject({ status: 'placed' });
  const stamped = mockState.updates.find((u) => u.table === 'product_restock_requests' && u.row.metadata);
  expect(JSON.parse(stamped.row.metadata)).toMatchObject({ vendorId: 'vend-sm', vendorSku: '4242', vendorProductUrl: 'https://stickermule.com/4242' });
  // …a row whose new SKU has no URL clears the old link (Codex r22 P2)
  mockState.updates = []; mockState.ledgerRows = [];
  mockState.request = { ...baseRequest(), metadata: { vendorId: 'vend-sm', vendorSku: 'OLD-1', vendorProductUrl: 'https://old.example/1' } };
  mockState.pricing = { vendor_sku: '4242', price: '314.00', quantity: '500', vendor_product_url: null };
  expect(await run(mockAdapter())).toMatchObject({ status: 'placed' });
  expect(JSON.parse(mockState.updates.find((u) => u.table === 'product_restock_requests' && u.row.metadata).row.metadata)).toMatchObject({ vendorSku: '4242', vendorProductUrl: null });
  // …and an unchanged row writes nothing
  mockState.updates = []; mockState.ledgerRows = [];
  mockState.pricing = { vendor_sku: '4242', price: '314.00', quantity: '500', vendor_product_url: 'https://stickermule.com/4242' };
  mockState.request = { ...baseRequest(), metadata: { vendorId: 'vend-sm', vendorSku: '4242', vendorProductUrl: 'https://stickermule.com/4242' } };
  expect(await run(mockAdapter())).toMatchObject({ status: 'placed' });
  expect(mockState.updates.find((u) => u.table === 'product_restock_requests' && u.row.metadata)).toBeUndefined();
});

test('a request the claim finds undispatchable (vendor deactivated / gated after the sweep stood down) is handed off with the sweep\'s deduped bell (Codex r12 P2)', async () => {
  mockState.vendor = { ...mockState.vendor, active: false };
  const r = await run(mockAdapter());
  expect(r).toMatchObject({ skipped: 'no_adapter', belled: true });
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify.mock.calls[0][3].dedupeKey).toMatch(/^auto-reorder:/);
});

test('a placed order with no confirmed total is recorded at the amount beforeSubmit reserved — never null over the reservation (pre-push P0)', async () => {
  const a = mockAdapter({ quotesAtPlace: true, bindingQuote: undefined, place: jest.fn(async ({ beforeSubmit }) => { await beforeSubmit(10593); return { externalOrderNumber: 'S1-9', amountCents: null, evidence: {} }; }) });
  expect(await run(a)).toMatchObject({ status: 'placed' });
  const placedRow = mockState.updates.find((u) => u.table === 'vendor_orders' && u.row.status === 'placed');
  expect(placedRow.row.amount_cents).toBe(10593);
});

test('a placed order with no positive total anywhere parks post-submit as no_final_total, request ordered (pre-push P0)', async () => {
  const a = mockAdapter({ quotesAtPlace: true, bindingQuote: undefined, place: jest.fn(async () => ({ externalOrderNumber: 'S1-9', amountCents: 0, evidence: {} })) });
  expect(await run(a)).toMatchObject({ status: 'needs_review', reason: 'no_final_total' });
  expect(mockState.updates.some((u) => u.table === 'product_restock_requests' && u.row.status === 'ordered')).toBe(true);
  const parked = mockState.updates.find((u) => u.table === 'vendor_orders' && u.row.status === 'needs_review');
  expect(parked.row.placed_at).toBeInstanceOf(Date); // post-submit: cap-counted, guarded, do-not-reorder bell
  expect(parked.row.amount_cents).toBe(50000); // ENV per-order cap: a placed order with no figure is never $0 against the month (Codex r23 P1)
  // The fallback reached the row under the cap lock BEFORE the park (Codex r24 P1): an amount-only write precedes the parked one.
  const amounts = mockState.updates.filter((u) => u.table === 'vendor_orders' && u.row.amount_cents === 50000).map((u) => !!u.row.status);
  expect(amounts).toEqual([false, true]);
  expect(require('../models/db').raw.mock.calls.some((c) => /pg_advisory_xact_lock/.test(c[0]) && c[1] && c[1][0] === 'vendor-order-caps')).toBe(true);
  expect(parked.row.error).toMatch(/counted against the monthly cap at the per-order cap/);
  expect(notify.mock.calls[0][2]).toMatch(/Do NOT re-order/);
});

test('adapter refusal → needs_review with the refuse code', async () => {
  const err = new Error('exactly one address required'); err.refuse = 'multiple_addresses';
  const r = await run(mockAdapter({ place: jest.fn(async () => { throw err; }) }));
  expect(r).toMatchObject({ status: 'needs_review', reason: 'multiple_addresses' });
  expect(notify).toHaveBeenCalledTimes(1);
});

test('an ambiguous submit that names the checkout total parks with THAT amount, not the (null) quote (pre-push P0)', async () => {
  const err = new Error('siteone submit outcome unknown'); err.ambiguous = true; err.cents = 10593;
  const r = await run(mockAdapter({ quotesAtPlace: true, bindingQuote: undefined, place: jest.fn(async () => { throw err; }) }));
  expect(r).toMatchObject({ status: 'needs_review', reason: 'ambiguous_after_submit' });
  const parked = mockState.updates.filter((u) => u.table === 'vendor_orders' && u.row.status === 'needs_review').map((u) => u.row.amount_cents);
  expect(parked).toContain(10593);
  // A KNOWN post-submit figure is reserved under the cap lock before the park too (hook P0).
  expect(mockState.updates.filter((u) => u.table === 'vendor_orders' && u.row.amount_cents === 10593).map((u) => !!u.row.status)).toEqual([false, true]);
});

test('an ambiguous submit whose claim was lost meanwhile (stale park + revoke) is attached as a late placement — marker replaced, request ordered, bell says it MAY exist (hook P0)', async () => {
  const dbFn = require('../models/db');
  dbFn.raw.mockClear();
  mockState.parkedEvidence = { bell: { title: 'x', body: 'y' }, bellAt: '2026-09-03T10:00:00Z', revokedAt: '2026-09-03T10:05:00Z' };
  const err = new Error('504 after POST'); err.ambiguous = true; err.cents = 10593;
  const r = await run(mockAdapter({ place: jest.fn(async () => { mockState.ledgerSettled = true; throw err; }) }));
  expect(r).toMatchObject({ status: 'needs_review', reason: 'placed_after_stale_park', externalOrderNumber: null, amountCents: 10593 });
  expect(dbFn.raw.mock.calls.some((c) => /- 'revokedAt'/.test(c[0]))).toBe(true); // the revoke marker is replaced, not left beside a possible order
  expect(mockState.updates.find((u) => u.table === 'product_restock_requests').row).toMatchObject({ status: 'ordered', closed_at: null });
  expect(auditVendorOrder.mock.calls[0][0]).toMatchObject({ outcome: 'placed_after_stale_park', amount_cents: 10593 });
  expect(auditVendorOrder.mock.calls[0][0].reason).toMatch(/may exist \(ambiguous submit\)/);
  expect(notify.mock.calls[0][1]).toMatch(/may have landed after revoke/);
  expect(notify.mock.calls[0][2]).toMatch(/MAY have been placed/);
});

test('an ambiguous submit with NO known total — no click figure, no quote, nothing reserved — parks at the per-order cap, never $0 (pre-push P1)', async () => {
  const err = new Error('siteone submit outcome unknown'); err.ambiguous = true;
  const r = await run(mockAdapter({ quotesAtPlace: true, bindingQuote: undefined, place: jest.fn(async () => { throw err; }) }));
  expect(r).toMatchObject({ status: 'needs_review', reason: 'ambiguous_after_submit' });
  const parkedRow = mockState.updates.filter((u) => u.table === 'vendor_orders' && u.row.status === 'needs_review').pop().row;
  expect(parkedRow.amount_cents).toBe(50000); // ENV per-order cap
  expect(parkedRow.error).toMatch(/counted against the monthly cap at the per-order cap/);
  expect(mockState.updates.filter((u) => u.table === 'vendor_orders' && u.row.amount_cents === 50000).map((u) => !!u.row.status)).toEqual([false, true]); // reserved under the lock, then parked (Codex r24 P1)
});

test('a placed order with no total whose claim was lost meanwhile lands as a late placement at the per-order cap (Codex r24 P1)', async () => {
  mockState.parkedEvidence = {};
  const a = mockAdapter({ quotesAtPlace: true, bindingQuote: undefined, place: jest.fn(async () => { mockState.ledgerSettled = true; return { externalOrderNumber: 'S1-9', amountCents: 0, evidence: {} }; }) });
  expect(await run(a)).toMatchObject({ status: 'needs_review', reason: 'placed_after_stale_park', externalOrderNumber: 'S1-9', amountCents: 50000 });
});

test('an ambiguous submit whose vendor response carried no order number persists that response as response_payload (Codex r23 P2)', async () => {
  const err = new Error('Sticker Mule accepted the order but returned no order number'); err.ambiguous = true; err.body = { status: 'queued', id: 'q-77' };
  const r = await run(mockAdapter({ place: jest.fn(async () => { throw err; }) }));
  expect(r).toMatchObject({ status: 'needs_review', reason: 'ambiguous_after_submit' });
  const parkedRow = mockState.updates.filter((u) => u.table === 'vendor_orders' && u.row.status === 'needs_review').pop().row;
  expect(JSON.parse(parkedRow.response_payload)).toEqual({ status: 'queued', id: 'q-77' });
  expect(parkedRow.external_order_number).toBeNull();
});

test('ambiguous post-submit error → needs_review, never retried', async () => {
  const err = new Error('504 after POST'); err.ambiguous = true;
  expect(await run(mockAdapter({ place: jest.fn(async () => { throw err; }) }))).toMatchObject({ status: 'needs_review', reason: 'ambiguous_after_submit' });
  expect(ledgerStatus()).toBe('needs_review');
});

test('definite adapter error → failed + bell', async () => {
  expect(await run(mockAdapter({ place: jest.fn(async () => { throw new Error('boom'); }) }))).toMatchObject({ status: 'failed', reason: 'adapter_error' });
  expect(ledgerStatus()).toBe('failed');
  expect(notify).toHaveBeenCalledTimes(1);
});

test('a run-level failure is scoped to its adapter: that adapter gets no more claims this run (no ledger row), the run still goes red (Codex #3853 r8 P1)', async () => {
  const err = new Error('siteone bot: DNS unavailable'); err.runLevel = true;
  const a = mockAdapter({ place: jest.fn(async () => { throw err; }) });
  mockState.dispatchable = [{ id: 'req-1' }, { id: 'req-2' }];
  await expect(dispatch.runVendorOrderDispatch({ notify, adapters: { stickermule: a, siteone: a } })).rejects.toThrow('DNS unavailable');
  expect(err.adapterKey).toBe('stickermule');
  expect(a.place).toHaveBeenCalledTimes(1); // the second request of the dead adapter was never claimed
  expect(mockState.deletes).toEqual(['vendor_orders']); // exactly one claim, released
  mockState.dispatchable = null;
  const ledgerRowsBefore = mockState.ledgerRows.length;
  expect(await run(mockAdapter(), { deadAdapters: new Set(['stickermule']) })).toMatchObject({ skipped: 'adapter_down' });
  expect(mockState.ledgerRows).toHaveLength(ledgerRowsBefore); // no claim written for a dead adapter
});

test('a rejected login parks its request with the bell AND takes the adapter out of the run — the same credential is never resubmitted for the next request (Codex #3853 r21 P1)', async () => {
  const rejected = new Error('SiteOne rejected the stored login'); rejected.refuse = 'login_rejected'; rejected.adapterDown = true;
  const a = mockAdapter({ place: jest.fn(async () => { throw rejected; }) });
  mockState.dispatchable = [{ id: 'req-1' }, { id: 'req-2' }];
  const r = await dispatch.runVendorOrderDispatch({ notify, adapters: { stickermule: a, siteone: a } }); // not run-level: the run does not go red
  expect(a.place).toHaveBeenCalledTimes(1); // the second request of the down adapter was never claimed
  expect(r.results[0]).toMatchObject({ status: 'needs_review', reason: 'login_rejected', adapterDown: 'stickermule' });
  expect(notify).toHaveBeenCalledTimes(1); // one bell, for the parked request
  mockState.dispatchable = null;
});

test('the adapter-down marker survives a park that THROWS: the second request is still not claimed (Codex #3853 r22 P2)', async () => {
  const rejected = new Error('SiteOne rejected the stored login'); rejected.refuse = 'login_rejected'; rejected.adapterDown = true;
  const a = mockAdapter({ place: jest.fn(async () => { throw rejected; }) });
  mockState.dispatchable = [{ id: 'req-1' }, { id: 'req-2' }];
  mockState.parkThrowsOnce = true; // the first park (the refusal) fails on a transient DB error; settleAfterError's fallback records dispatch_error
  try {
    await expect(dispatch.runVendorOrderDispatch({ notify, adapters: { stickermule: a, siteone: a } })).rejects.toThrow(/dispatch_error/); // the failed park makes the run red, as any dispatch_error does
    expect(a.place).toHaveBeenCalledTimes(1); // the second request of the down adapter was never claimed
  } finally { mockState.dispatchable = null; mockState.parkThrowsOnce = false; }
});

test('an unscoped run-level error after an adapter-scoped one replaces it and aborts the batch (Codex #3853 r11 P2)', async () => {
  const dbFn = require('../models/db');
  const origTransaction = dbFn.transaction;
  let scopedThrown = false;
  // The claim transaction of the NEXT request fails batch-wide (no adapterKey) once the first adapter died.
  dbFn.transaction = async (fn) => { if (scopedThrown) throw new Error('pool exhausted'); return origTransaction(fn); };
  try {
    const err = new Error('siteone bot: DNS unavailable'); err.runLevel = true;
    const a = mockAdapter({ place: jest.fn(async () => { scopedThrown = true; throw err; }) });
    mockState.dispatchable = [{ id: 'req-1' }, { id: 'req-2' }, { id: 'req-3' }];
    await expect(dispatch.runVendorOrderDispatch({ notify, adapters: { stickermule: a, siteone: a } })).rejects.toThrow('pool exhausted');
    expect(a.place).toHaveBeenCalledTimes(1);
  } finally {
    dbFn.transaction = origTransaction;
    mockState.dispatchable = null;
  }
});

test('run-level error releases the claim and propagates', async () => {
  const err = new Error('no browser'); err.runLevel = true;
  await expect(run(mockAdapter({ place: jest.fn(async () => { throw err; }) }))).rejects.toThrow('no browser');
  expect(mockState.deletes).toEqual(['vendor_orders']);
  expect(notify).not.toHaveBeenCalled();
});

test('cap reservation refuses once the claim is no longer placing — the adapter never submits after stale recovery parked it (pre-push P0)', async () => {
  const dbFn = require('../models/db');
  expect(await dispatch.reserveUnderCaps(dbFn, 'ledger-1', 9900)).toEqual({ ok: true });
  mockState.ledgerSettled = true;
  expect(await dispatch.reserveUnderCaps(dbFn, 'ledger-1', 9900)).toMatchObject({ ok: false, reason: 'claim_lost' });
  // End to end: the SiteOne adapter's final beforeSubmit sees the refusal and refuses; the park finds the row settled and stands down.
  mockState.vendor = { id: 'vend-s1', name: 'SiteOne', code: 1, active: true };
  mockState.request = { ...baseRequest(), requested_quantity: '256', unit: 'fl_oz', metadata: { vendorId: 'vend-s1' } };
  mockState.product = talstar;
  mockState.pricing = { vendor_sku: 'S1-77', quantity: '1 gal' };
  mockState.ledgerSettled = false;
  const place = jest.fn(async ({ beforeSubmit }) => {
    mockState.ledgerSettled = true; // stale recovery parks the claim mid-run
    const gate = await beforeSubmit(9900);
    expect(gate).toMatchObject({ ok: false, reason: 'claim_lost' });
    const err = new Error(gate.message); err.refuse = gate.reason; throw err;
  });
  const r = await run({ key: 'siteone', quotesAtPlace: true, packagedQuantity: true, place });
  expect(r).toMatchObject({ skipped: 'already_settled' });
  expect(auditVendorOrder).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();
});

test('vendor call outlives stale recovery: the parked row keeps needs_review, gains the order number, request goes ordered, no placed audit (pre-push P1)', async () => {
  const a = mockAdapter();
  const inner = a.place;
  a.place = jest.fn(async (...args) => { const out = await inner(...args); mockState.ledgerSettled = true; return out; }); // recoverStalePlacing parks the row while the vendor call is out, after the cap gate passed
  const r = await run(a);
  expect(r).toMatchObject({ status: 'needs_review', reason: 'placed_after_stale_park', externalOrderNumber: 'SM-1' });
  expect(mockState.updates.filter((u) => u.table === 'vendor_orders' && u.row.status === 'placed').length).toBe(1); // the conditional attempt only — returned 0 rows
  const attach = mockState.updates.filter((u) => u.table === 'vendor_orders' && !u.row.status && u.row.external_order_number !== undefined).pop().row; // the order-facts attach (the later evidence-only write is the bellAt stamp)
  expect(attach.external_order_number).toBe('SM-1');
  expect(requestStatus()).toBe('ordered');
  expect(auditVendorOrder).toHaveBeenCalledTimes(1);
  expect(auditVendorOrder.mock.calls[0][0].outcome).toBe('placed_after_stale_park');
  expect(notify).toHaveBeenCalledTimes(1); // the park's bell is superseded: the order exists
  expect(notify.mock.calls[0][1]).toMatch(/landed after stale recovery/);
});

test('vendor call outlives a stale park the operator already REVOKED and cancelled: marker replaced, request back to ordered, bell says so (pre-push P0)', async () => {
  mockState.parkedEvidence = { bell: { title: 'x', body: 'y' }, bellAt: '2026-09-03T10:00:00Z', revokedAt: '2026-09-03T10:05:00Z' };
  const a = mockAdapter();
  const inner = a.place;
  a.place = jest.fn(async (...args) => { const out = await inner(...args); mockState.ledgerSettled = true; return out; });
  const r = await run(a);
  expect(r).toMatchObject({ status: 'needs_review', reason: 'placed_after_stale_park' });
  const reopen = mockState.updates.find((u) => u.table === 'product_restock_requests').row;
  expect(reopen).toMatchObject({ status: 'ordered', closed_at: null });
  expect(auditVendorOrder.mock.calls[0][0].reason).toMatch(/and revoked/);
  expect(notify.mock.calls[0][1]).toMatch(/landed after revoke/);
  expect(notify.mock.calls[0][2]).toMatch(/record the revoke again/);
});

test('request cancelled mid-flight: ledger placed, request back to ordered (receive / revoke can close it), one reconcile bell (Codex r23 P1)', async () => {
  mockState.freshRequestStatus = 'cancelled';
  const r = await run(mockAdapter());
  expect(r.status).toBe('placed');
  expect(ledgerStatus()).toBe('placed');
  expect(mockState.updates.find((u) => u.table === 'product_restock_requests').row).toMatchObject({ status: 'ordered', closed_at: null });
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify.mock.calls[0][1]).toMatch(/cancelled request/);
  expect(notify.mock.calls[0][2]).toMatch(/back to ordered/);
});

test('an adapter with no static quote (quotesAtPlace) gets the cap check as beforeSubmit and a dry run parks', async () => {
  mockState.vendor = { id: 'vend-s1', name: 'SiteOne', code: 1, active: true };
  mockState.request = { ...baseRequest(), requested_quantity: '256', unit: 'fl_oz', metadata: { vendorId: 'vend-s1' } };
  mockState.product = talstar;
  mockState.pricing = { vendor_sku: 'S1-77', quantity: '1 gal' };
  const place = jest.fn(async ({ beforeSubmit, vendorSku, quantity }) => {
    expect(vendorSku).toBe('S1-77');
    expect(quantity).toBe(2); // 256 fl oz of a 1 gal jug = 2 packages
    expect(await beforeSubmit(9900)).toEqual({ ok: true });
    expect((await beforeSubmit(999900)).reason).toBe('over_per_order_cap');
    return { dryRun: true, amountCents: 9900, externalOrderNumber: null, evidence: {} };
  });
  const r = await run({ key: 'siteone', quotesAtPlace: true, packagedQuantity: true, place });
  expect(r).toMatchObject({ status: 'needs_review', reason: 'dry_run' });
  expect(notify.mock.calls[0][1]).toMatch(/dry run/);
  expect(JSON.parse(mockState.ledgerRows[0].request_payload)).toMatchObject({ vendorSku: 'S1-77', quantity: 256, unit: 'fl_oz', vendorQuantity: 2, packSize: '1 gal', orderedQuantity: 256 });
});

test('SiteOne with no eligible price row parks no_price even when the catalog carries a siteone_sku (r1 P1)', async () => {
  mockState.vendor = { id: 'vend-s1', name: 'SiteOne', code: 1, active: true };
  mockState.request = { ...baseRequest(), requested_quantity: '256', unit: 'fl_oz', metadata: { vendorId: 'vend-s1', vendorSku: 'S1-77' } };
  mockState.product = { ...talstar, siteone_sku: 'S1-77' };
  mockState.pricing = null;
  const place = jest.fn();
  expect(await run({ key: 'siteone', quotesAtPlace: true, packagedQuantity: true, place })).toMatchObject({ status: 'needs_review', reason: 'no_price' });
  expect(place).not.toHaveBeenCalled();
});

test('an unreadable pack size parks no_pack_size — never a raw inventory amount in the cart (r1 P1)', async () => {
  mockState.vendor = { id: 'vend-s1', name: 'SiteOne', code: 1, active: true };
  mockState.request = { ...baseRequest(), requested_quantity: '128', unit: 'fl_oz', metadata: { vendorId: 'vend-s1' } };
  mockState.product = { ...talstar, reorder_quantity: '128' };
  mockState.pricing = { vendor_sku: 'S1-77', quantity: null };
  const place = jest.fn();
  const r = await run({ key: 'siteone', quotesAtPlace: true, packagedQuantity: true, place });
  expect(r).toMatchObject({ status: 'needs_review', reason: 'no_pack_size' });
  expect(place).not.toHaveBeenCalled();
  expect(notify.mock.calls[0][2]).toMatch(/pack size/);
});

test('vendorOrderQuantity: packages by pack size in the same dimension; counts for a count vendor', () => {
  const s1 = { key: 'siteone', packagedQuantity: true };
  const sm = { key: 'stickermule', packagedQuantity: false };
  const q = (adapter, requested_quantity, unit, quantity) => dispatch.vendorOrderQuantity({ adapter, request: { requested_quantity, unit }, pricing: { quantity } });
  expect(q(s1, '256', 'fl_oz', '1 gal')).toEqual({ quantity: 2, packSize: '1 gal', orderedQuantity: 256 });
  expect(q(s1, '100', 'fl_oz', '1 gal')).toEqual({ quantity: 1, packSize: '1 gal', orderedQuantity: 128 }); // what actually arrives = the receive default (r2 P1)
  expect(q(s1, '2.5', 'gal', '2.5 gal')).toEqual({ quantity: 1, packSize: '2.5 gal', orderedQuantity: 2.5 });
  expect(q(s1, '40', 'lb', '16 lb')).toEqual({ quantity: 3, packSize: '16 lb', orderedQuantity: 48 });
  expect(q(s1, '250', 'each', '100 each')).toEqual({ quantity: 3, packSize: '100 each', orderedQuantity: 300 });
  expect(q(s1, '250', 'each', '100')).toEqual({ quantity: 3, packSize: '100 each', orderedQuantity: 300 });
  // noun-bearing count packs parse through the SHARED parsePackCount (Codex #3974 r6 P1); a container noun is not an item count
  expect(q(s1, '25', 'each', '10 stations')).toEqual({ quantity: 3, packSize: '10 each', orderedQuantity: 30 });
  expect(q(s1, '30', 'each', '20 tablets')).toEqual({ quantity: 2, packSize: '20 each', orderedQuantity: 40 });
  expect(q(s1, '5', 'each', '1 case').error).toBe('no_pack_size');
  expect(q(s1, '128', 'fl_oz', '16 lb').error).toBe('pack_unit_mismatch');
  expect(q(s1, '128', 'fl_oz', '').error).toBe('no_pack_size');
  expect(q(s1, '250', 'each', '1 gal').error).toBe('no_pack_size');
  expect(q(sm, '500', 'each', '500')).toEqual({ quantity: 500, packSize: null, orderedQuantity: 500 });
  expect(q(sm, '500', 'fl_oz', '500').error).toBe('count_unit_required');
  expect(q(s1, '0', 'fl_oz', '1 gal').error).toBe('no_quantity');
  expect(q(s1, '32', 'oz', '1 gal').error).toBe('ambiguous_unit'); // bare ounce: weight or volume is a human's call (r4 P1)
  expect(q(s1, '128', 'fl_oz', '16 oz').error).toBe('ambiguous_unit');
});

test.each([
  ['product_inactive', { active: false }],
  ['auto_reorder_disabled', { auto_reorder_enabled: false }],
  ['stock_no_longer_low', { inventory_on_hand: '150' }],
  ['stock_untracked', { inventory_on_hand: null }],
  // The request's cached vendor / quantity is NOT the configuration the
  // money is spent on — the product's current row is (pre-push P0).
  ['vendor_changed', { auto_reorder_vendor_id: 'vend-other' }],
  ['quantity_changed', { reorder_quantity: '750' }],
  ['quantity_changed', { inventory_unit: 'fl_oz' }],
])('claim re-checks eligibility: %s → request cancelled, no claim, no bell (r1 P1)', async (reason, patch) => {
  mockState.product = { ...sticker, ...patch };
  const a = mockAdapter();
  expect(await run(a)).toEqual({ requestId: 'req-1', skipped: reason, cancelled: true });
  expect(mockState.ledgerRows).toHaveLength(0);
  expect(a.place).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();
  const cancel = mockState.updates.find((u) => u.table === 'product_restock_requests').row;
  expect(cancel.status).toBe('cancelled');
  expect(cancel.closed_at).toBeInstanceOf(Date);
  expect(JSON.parse(cancel.metadata)).toMatchObject({ vendorId: 'vend-sm', autoOrderCancelled: reason });
  // The sweep's manual bell for the withdrawn need is retired with the cancel (Codex r24 P1).
  expect(mockState.updates.filter((u) => u.table === 'notifications' && u.row.read_at)).toHaveLength(1);
});

test('a claim-time cancel of a request with a re-claimable dry-run row retires that row\'s own bell too (Codex r30 P1)', async () => {
  mockState.product = { ...sticker, auto_reorder_enabled: false };
  mockState.requestLedger = { id: 'ledger-dry' };
  try {
    const r = await run(mockAdapter());
    expect(r).toMatchObject({ skipped: 'auto_reorder_disabled', cancelled: true });
    expect(mockState.updates.filter((u) => u.table === 'notifications' && u.row.read_at)).toHaveLength(2); // the sweep's request bell + the dry-run ledger bell
    expect(mockState.updates.some((u) => u.table === 'vendor_orders' && u.row.evidence && !u.row.status)).toBe(true); // evidence.bell stripped
  } finally { mockState.requestLedger = null; }
});

test('master gate off: the run still re-rings pending bells and recovers stale placing rows, places nothing (pre-push P0)', async () => {
  process.env.GATE_AUTO_ORDER = 'false';
  mockState.pendingBells = [{ id: 'ledger-p', evidence: { bell: { title: 'Auto-order needs review: x', body: 'y' } }, request_id: 'req-p', product_name: 'x', vendor_name: 'v' }];
  mockState.stale = [{ id: 'ledger-old', adapter: 'stickermule', amount_cents: 31400, created_at: new Date(Date.now() - 3600e3), request_id: 'req-old', product_name: 'Sticker', vendor_id: 'vend-sm', vendor_name: 'Sticker Mule' }];
  const a = mockAdapter();
  const r = await dispatch.runVendorOrderDispatch({ notify, adapters: { stickermule: a, siteone: a } });
  expect(r).toMatchObject({ skipped: 'gated', results: [], recovered: ['ledger-old'], bells: { rung: ['ledger-p'], pending: [] } });
  expect(a.place).not.toHaveBeenCalled();
  expect(mockState.ledgerRows).toHaveLength(0);
  expect(notify).toHaveBeenCalledTimes(2);
  expect(mockState.updates.find((u) => u.table === 'vendor_orders' && u.row.status).row).toMatchObject({ status: 'needs_review' });
});

test('canAutoOrder PROPAGATES a throwing credential lookup — an infrastructure failure is not "unconfigured" (no "order manually" bell beside a possible placement; Codex #3853 r17 P1)', async () => {
  const { getVendorLoginCredentials } = require('../services/vendor-credentials');
  getVendorLoginCredentials.mockRejectedValueOnce(new Error('ECONNRESET'));
  await expect(dispatch.canAutoOrder({ vendor: { id: 's1', name: 'SiteOne', code: 1, active: true } })).rejects.toThrow(/credential lookup for SiteOne failed: ECONNRESET/);
});

test('canAutoOrder mirrors gates + adapter map + loaded module + vendor active', async () => {
  expect(await dispatch.canAutoOrder({ vendor: stickerMule })).toBe(true);
  expect(await dispatch.canAutoOrder({ vendor: { id: 'g', name: 'Gemplers', code: 24 } })).toBe(false);
  // PR 3 ships the SiteOne module: with its gate set the vendor auto-orders.
  expect(await dispatch.canAutoOrder({ vendor: { id: 's1', name: 'SiteOne', code: 1, active: true } })).toBe(true);
  expect(await dispatch.canAutoOrder({ vendor: { ...stickerMule, active: false } })).toBe(false);
  mockState.vendor = { ...stickerMule, active: false };
  expect(await dispatch.canAutoOrder({ vendorId: 'vend-sm' })).toBe(false);
  process.env.GATE_AUTO_ORDER_STICKERMULE = 'false';
  expect(await dispatch.canAutoOrder({ vendor: stickerMule })).toBe(false);
  process.env.GATE_AUTO_ORDER_STICKERMULE = 'true';
  process.env.GATE_AUTO_ORDER = 'false';
  expect(await dispatch.canAutoOrder({ vendor: stickerMule })).toBe(false);
});

test('caps parse: unset / blank / non-integer are absent, never a passing comparison', () => {
  const { parseCents } = dispatch._internals;
  expect(parseCents(undefined)).toBeNull();
  expect(parseCents('')).toBeNull();
  expect(parseCents('12.5')).toBeNull();
  expect(parseCents('-1')).toBeNull();
  expect(parseCents('0')).toBe(0);
  expect(parseCents(' 25000 ')).toBe(25000);
});

// ---- pre-push audit P0s: caps must bind the amount actually charged, and
// ---- nothing after the vendor call may read as "failed — order manually".

test('no identical prior vendor order → needs_review no_binding_total, nothing sent', async () => {
  const a = mockAdapter({ bindingQuote: jest.fn(async () => null) });
  const r = await run(a);
  expect(r).toMatchObject({ status: 'needs_review', reason: 'no_binding_total' });
  expect(a.place).not.toHaveBeenCalled();
  expect(notify.mock.calls[0][2]).toMatch(/identical order by hand/);
});

test('a binding-total lookup error is a definite pre-submit failure', async () => {
  const a = mockAdapter({ bindingQuote: jest.fn(async () => { throw new Error('HTTP 500'); }) });
  expect(await run(a)).toMatchObject({ status: 'failed', reason: 'adapter_error' });
  expect(a.place).not.toHaveBeenCalled();
});

test('the cap check is an advisory-locked reservation written before the vendor call', async () => {
  const dbFn = require('../models/db');
  const a = mockAdapter({ place: jest.fn(async () => {
    // By the time the vendor is called, this row already carries its reserved amount.
    const reserved = mockState.updates.filter((u) => u.table === 'vendor_orders').map((u) => u.row.amount_cents).filter((v) => v != null);
    expect(reserved).toEqual([31400]);
    return { externalOrderNumber: 'SM-1', amountCents: 31400, response: {}, evidence: {} };
  }) });
  await run(a);
  expect(dbFn.raw).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext(?))', ['vendor-order-caps']);
  expect(a.place).toHaveBeenCalled();
});

test('a quotesAtPlace vendor whose confirmed total exceeds the reserved checkout figure past a cap parks post-submit, request ordered (pre-push P0)', async () => {
  const a = mockAdapter({ quotesAtPlace: true, bindingQuote: undefined, place: jest.fn(async ({ beforeSubmit }) => { expect(await beforeSubmit(9900)).toEqual({ ok: true }); return { externalOrderNumber: 'S1-11', amountCents: 60000, evidence: { totalSource: 'vendor' } }; }) });
  const r = await run(a);
  expect(r).toMatchObject({ status: 'needs_review', reason: 'over_cap_after_placement' });
  expect(requestStatus()).toBe('ordered');
});

test('a higher confirmed total re-checked after placement keeps the reservation’s cap-accounting month — created_at is not re-stamped (Codex r19 P2)', async () => {
  mockState.reservedAt = new Date('2026-08-31T23:30:00Z');
  const a = mockAdapter({ quotesAtPlace: true, bindingQuote: undefined, place: jest.fn(async ({ beforeSubmit }) => { await beforeSubmit(9900); return { externalOrderNumber: 'S1-14', amountCents: 12000, evidence: { totalSource: 'vendor' } }; }) });
  try {
    expect(await run(a)).toMatchObject({ status: 'placed', amountCents: 12000 });
    const reservations = mockState.updates.filter((u) => u.table === 'vendor_orders' && u.row.amount_cents != null && !u.row.status);
    expect(reservations.map((u) => u.row.amount_cents)).toEqual([9900, 12000]);
    expect(reservations[0].row.created_at).toBeInstanceOf(Date); // the initial reservation stamps the month
    expect(reservations[1].row.created_at).toBeUndefined(); // the re-check does not
  } finally { mockState.reservedAt = null; }
});

test('an adapter that gates more than once keeps the FIRST reservation\'s accounting month — later beforeSubmit calls pass it as accountingAt and never re-stamp created_at (Codex #3876 r3 P1)', async () => {
  mockState.reservedAt = new Date('2026-08-31T23:59:30Z');
  const a = mockAdapter({ quotesAtPlace: true, bindingQuote: undefined, place: jest.fn(async ({ beforeSubmit }) => { await beforeSubmit(9900); await beforeSubmit(10593); await beforeSubmit(11240); return { externalOrderNumber: 'S1-15', amountCents: 11240, evidence: { totalSource: 'vendor' } }; }) });
  try {
    expect(await run(a)).toMatchObject({ status: 'placed', amountCents: 11240 });
    const reservations = mockState.updates.filter((u) => u.table === 'vendor_orders' && u.row.amount_cents != null && !u.row.status);
    expect(reservations.map((u) => u.row.amount_cents)).toEqual([9900, 10593, 11240]);
    expect(reservations[0].row.created_at).toBeInstanceOf(Date); // the first reservation stamps the month
    expect(reservations[1].row.created_at).toBeUndefined(); // the checkout-total gate keeps it
    expect(reservations[2].row.created_at).toBeUndefined(); // so does the at-click gate
  } finally { mockState.reservedAt = null; }
});

test('a quotesAtPlace vendor whose confirmed total is at or under the reserved checkout figure is recorded placed', async () => {
  const a = mockAdapter({ quotesAtPlace: true, bindingQuote: undefined, place: jest.fn(async ({ beforeSubmit }) => { await beforeSubmit(9900); return { externalOrderNumber: 'S1-12', amountCents: 9900, evidence: {} }; }) });
  expect(await run(a)).toMatchObject({ status: 'placed' });
});

test('an over-cap confirmed total that lands after stale recovery parked the claim is attached as a late placement — number and amount recorded, request ordered (pre-push P0)', async () => {
  const a = mockAdapter({ quotesAtPlace: true, bindingQuote: undefined, place: jest.fn(async ({ beforeSubmit }) => { expect(await beforeSubmit(9900)).toEqual({ ok: true }); mockState.ledgerSettled = true; return { externalOrderNumber: 'S1-13', amountCents: 60000, evidence: { totalSource: 'vendor' } }; }) });
  const r = await run(a);
  expect(r).toMatchObject({ status: 'needs_review', reason: 'placed_after_stale_park', externalOrderNumber: 'S1-13', amountCents: 60000 });
  const late = mockState.updates.find((u) => u.table === 'vendor_orders' && u.row.external_order_number === 'S1-13' && !u.row.status);
  expect(late.row.amount_cents).toBe(60000);
  expect(mockState.updates.some((u) => u.table === 'product_restock_requests' && u.row.status === 'ordered')).toBe(true);
  expect(auditVendorOrder).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'placed_after_stale_park', amount_cents: 60000 }));
});

test('vendor total over cap after placement → needs_review, request ordered, bell says do NOT re-order', async () => {
  const a = mockAdapter({ place: jest.fn(async () => ({ externalOrderNumber: 'SM-2', amountCents: 60000, response: {}, evidence: { totalSource: 'vendor' } })) });
  const r = await run(a);
  expect(r).toMatchObject({ status: 'needs_review', reason: 'over_cap_after_placement' });
  // The ACTUAL charge is written under the cap lock before the park — no gap where a concurrent reservation reads the lower quote (pre-push P0).
  const amounts = mockState.updates.filter((u) => u.table === 'vendor_orders' && u.row.amount_cents != null).map((u) => ({ cents: u.row.amount_cents, parked: !!u.row.status }));
  expect(amounts).toEqual([{ cents: 31400, parked: false }, { cents: 60000, parked: false }, { cents: 60000, parked: true }]);
  expect(requestStatus()).toBe('ordered');
  const ledger = lastLedgerPatch();
  expect(ledger).toMatchObject({ status: 'needs_review', external_order_number: 'SM-2', amount_cents: 60000 });
  expect(ledger.placed_at).toBeInstanceOf(Date);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify.mock.calls[0][2]).toMatch(/Do NOT re-order/);
  expect(notify.mock.calls[0][2]).not.toMatch(/order manually/);
});

test('a higher final total whose post-placement re-check finds the claim lost lands as a late placement UNDER the cap lock, at the actual charge (Codex r23 P1)', async () => {
  const dbFn = require('../models/db');
  dbFn.raw.mockClear();
  mockState.parkedEvidence = { bell: { title: 'x', body: 'y' }, bellAt: '2026-09-03T10:00:00Z' };
  const a = mockAdapter({ place: jest.fn(async () => { mockState.ledgerSettled = true; return { externalOrderNumber: 'SM-2', amountCents: 60000, response: {}, evidence: { totalSource: 'vendor' } }; }) }); // stale recovery parked the row while the vendor call was out
  const r = await run(a);
  expect(r).toMatchObject({ status: 'needs_review', reason: 'placed_after_stale_park', externalOrderNumber: 'SM-2', amountCents: 60000 });
  const capLocks = dbFn.raw.mock.calls.filter((c) => /pg_advisory_xact_lock/.test(c[0]) && c[1] && c[1][0] === 'vendor-order-caps');
  expect(capLocks).toHaveLength(3); // the pre-submit reservation, the post-placement re-check, then the record transaction that attached the late placement
  const attached = mockState.updates.find((u) => u.table === 'vendor_orders' && u.row.external_order_number === 'SM-2' && u.row.amount_cents === 60000);
  expect(attached).toBeDefined();
  // The adapter's confirmed facts ride along into the retained evidence (Codex r24 P2).
  expect(dbFn.raw.mock.calls.some((c) => /revokedAt/.test(c[0]) && c[1] && String(c[1][0]).includes('"totalSource":"vendor"'))).toBe(true);
  expect(mockState.updates.find((u) => u.table === 'product_restock_requests').row).toMatchObject({ status: 'ordered', closed_at: null });
});

test('a DB failure inside the late-placement attachment (the row already left placing) is UNRECORDED, never a harmless skip (Codex r17 P1)', async () => {
  const dbFn = require('../models/db');
  const realTx = dbFn.transaction;
  let n = 0;
  dbFn.transaction = async (fn) => { n += 1; if (n >= 3) throw new Error('late placement audit lost connection'); return fn(dbFn); }; // the attachment AND the fallback's locked reservation (Codex r27 P1) both lose the connection
  try {
    const a = mockAdapter();
    const inner = a.place;
    a.place = jest.fn(async (...args) => { const out = await inner(...args); mockState.ledgerSettled = true; return out; }); // stale recovery parked the row while the vendor call was out
    const r = await run(a);
    expect(r).toMatchObject({ status: 'unrecorded', reason: 'persist_after_placement', externalOrderNumber: 'SM-1' });
    expect(r.skipped).toBeUndefined();
  } finally { dbFn.transaction = realTx; }
});

test('an undispatchable request whose hand-off bell was not persisted reports bellLost, never belled (Codex r17 P2)', async () => {
  mockState.vendor = { ...mockState.vendor, active: false };
  notify = jest.fn(async () => null);
  const r = await run(mockAdapter());
  expect(r).toMatchObject({ skipped: 'no_adapter', bellLost: true });
  expect(r.belled).toBeUndefined();
});

test('an order that lands after an OLDER pod received the request by hand parks placed_on_received_request, guards kept closed, request untouched (Codex r27 P1)', async () => {
  mockState.freshRequestStatus = 'received';
  const r = await run(mockAdapter());
  expect(r).toMatchObject({ status: 'needs_review', reason: 'placed_on_received_request' });
  const ledger = lastLedgerPatch();
  expect(ledger).toMatchObject({ status: 'needs_review', external_order_number: 'SM-1', amount_cents: 31400 });
  expect(ledger.placed_at).toBeInstanceOf(Date);
  expect(JSON.parse(ledger.evidence).landedAfterReceive).toEqual(expect.any(String)); // the marker every live-order guard reads
  expect(mockState.updates.filter((u) => u.table === 'product_restock_requests')).toHaveLength(0); // received stays received: its stock was counted
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify.mock.calls[0][2]).toMatch(/landed after the restock request was received by hand/);
  expect(notify.mock.calls[0][2]).toMatch(/Do NOT re-order/);
});

test('an order that lands after stale recovery parked the row AND an older pod received the request attaches as a late placement carrying landedAfterReceive — never already_settled (hook r27 P0)', async () => {
  const dbFn = require('../models/db');
  dbFn.raw.mockClear();
  mockState.freshRequestStatus = 'received';
  const a = mockAdapter({ place: jest.fn(async () => { mockState.ledgerSettled = true; return { externalOrderNumber: 'SM-3', amountCents: 31400, response: {}, evidence: { itemId: 4242 } }; }) });
  const r = await run(a);
  expect(r).toMatchObject({ status: 'needs_review', reason: 'placed_after_stale_park', externalOrderNumber: 'SM-3' });
  expect(r.skipped).toBeUndefined();
  const attached = mockState.updates.find((u) => u.table === 'vendor_orders' && u.row.external_order_number === 'SM-3');
  expect(attached).toBeDefined(); // the confirmed number + amount reach the parked row
  expect(dbFn.raw.mock.calls.some((c) => /revokedAt/.test(c[0]) && c[1] && String(c[1][0]).includes('"landedAfterReceive"'))).toBe(true); // the marker keeps the guards closed
  expect(mockState.updates.filter((u) => u.table === 'product_restock_requests')).toHaveLength(0); // received stays received
  expect(notify.mock.calls[0][2]).toMatch(/receive the request once more/);
});

test('a persist_after_placement park records the POSITIVE figure — the beforeSubmit reservation over a zero vendor total — never $0 over the reservation (Codex r31 P1)', async () => {
  const dbFn = require('../models/db');
  const realTx = dbFn.transaction;
  let n = 0;
  dbFn.transaction = async (fn) => { n += 1; if (n === 3) throw new Error('audit insert lost connection'); return fn(dbFn); };
  try {
    const a = mockAdapter({ quotesAtPlace: true, bindingQuote: undefined, place: jest.fn(async ({ beforeSubmit }) => { await beforeSubmit(10593); return { externalOrderNumber: 'S1-9', amountCents: 0, evidence: {} }; }) });
    const r = await run(a);
    expect(r).toMatchObject({ status: 'needs_review', reason: 'persist_after_placement' });
    expect(lastLedgerPatch().amount_cents).toBe(10593);
    expect(mockState.updates.some((u) => u.table === 'vendor_orders' && u.row.amount_cents === 0)).toBe(false);
  } finally { dbFn.transaction = realTx; }
});

test('a DB failure after the vendor call parks as persist_after_placement, never failed', async () => {
  const dbFn = require('../models/db');
  dbFn.raw.mockClear();
  const realTx = dbFn.transaction;
  // Transactions: 1 claim, 2 cap reservation, 3 the green-path write — make that one throw.
  let n = 0;
  dbFn.transaction = async (fn) => { n += 1; if (n === 3) throw new Error('audit insert lost connection'); return fn(dbFn); };
  try {
    const r = await run(mockAdapter());
    expect(r).toMatchObject({ status: 'needs_review', reason: 'persist_after_placement' });
    expect(ledgerStatus()).toBe('needs_review');
    expect(requestStatus()).toBe('ordered'); // the fallback park restores the request like the green path (Codex r24 P1)
    // The figure the park records reached the row under the cap lock first (Codex r27 P1): the pre-submit reservation, then the fallback's.
    expect(dbFn.raw.mock.calls.filter((c) => /pg_advisory_xact_lock/.test(c[0]) && c[1] && c[1][0] === 'vendor-order-caps')).toHaveLength(2);
    const ledger = lastLedgerPatch();
    expect(ledger.external_order_number).toBe('SM-1');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][2]).toMatch(/SM-1/);
    expect(notify.mock.calls[0][2]).toMatch(/Do NOT re-order/);
  } finally { dbFn.transaction = realTx; }
});

test('ambiguous post-submit bell also says do NOT re-order', async () => {
  const err = new Error('504 after POST'); err.ambiguous = true;
  await run(mockAdapter({ place: jest.fn(async () => { throw err; }) }));
  expect(notify.mock.calls[0][2]).toMatch(/Do NOT re-order/);
});

test('a definite pre-submit failure still parks as failed with the manual-order instruction', async () => {
  await run(mockAdapter({ place: jest.fn(async () => { throw new Error('DNS down'); }) }));
  expect(ledgerStatus()).toBe('failed');
  expect(notify.mock.calls[0][2]).toMatch(/order manually/);
});

test('placed_at marks a dispatched vendor call: set on post-submit parks, never on pre-submit parks', async () => {
  const err = new Error('504 after POST'); err.ambiguous = true;
  await run(mockAdapter({ place: jest.fn(async () => { throw err; }) }));
  const post = lastLedgerPatch();
  expect(post.status).toBe('needs_review');
  expect(post.placed_at).toBeInstanceOf(Date);

  mockState.updates = [];
  process.env.AUTO_ORDER_MAX_PER_ORDER_CENTS = '10000';
  await run(mockAdapter());
  const pre = lastLedgerPatch();
  expect(pre.status).toBe('needs_review');
  expect(pre.amount_cents).toBe(31400); // shown on the tab…
  expect(pre.placed_at).toBeUndefined(); // …but not counted against the month
});

test('monthly sum counts only placing reservations and dispatched rows', async () => {
  const dbFn = require('../models/db');
  const seen = [];
  const orig = dbFn.getMockImplementation();
  dbFn.mockImplementation((table) => { const q = orig(table); if (table === 'vendor_orders') { q.where = (...a) => { seen.push(a); if (typeof a[0] === 'function') { const inner = { where: (...b) => { seen.push(['inner', ...b]); return inner; }, orWhereNotNull: (...b) => { seen.push(['inner', 'orWhereNotNull', ...b]); return inner; } }; a[0].call(inner); } return q; }; } return q; });
  try {
    await dispatch.monthlySpentCents(dbFn, { now: new Date(), excludeId: 'x' });
    expect(seen).toEqual(expect.arrayContaining([['inner', 'status', 'placing'], ['inner', 'orWhereNotNull', 'placed_at']]));
  } finally { dbFn.mockImplementation(orig); }
});

test('an adapter without a vendor-confirmed pre-submit total never auto-places: parks with the history figure', async () => {
  const a = mockAdapter({ preSubmitTotal: 'history' });
  const r = await run(a);
  expect(r).toMatchObject({ status: 'needs_review', reason: 'no_vendor_confirmed_total' });
  expect(a.place).not.toHaveBeenCalled();
  expect(notify.mock.calls[0][2]).toMatch(/\$314\.00/);
  expect(notify.mock.calls[0][2]).toMatch(/item 4242 × 500/);
  const ledger = lastLedgerPatch();
  expect(ledger.placed_at).toBeUndefined();
});

test('the real Sticker Mule adapter is history-total + count quantity; the real SiteOne adapter is vendor-total + package quantity + login', () => {
  expect(require('../services/procurement/adapters/stickermule')).toMatchObject({ preSubmitTotal: 'history', packagedQuantity: false });
  expect(require('../services/procurement/adapters/siteone')).toMatchObject({ preSubmitTotal: 'vendor', packagedQuantity: true, loginRequired: true, loginConfigured: expect.any(Function) }); // a loginRequired adapter exports loginConfigured — the dispatcher calls it unconditionally
});

test('a bell that fails to send is persisted with the park, reported, and re-rung by the next run (r1 P1)', async () => {
  notify.mockRejectedValueOnce(new Error('bell down'));
  const err = new Error('timeout after POST'); err.ambiguous = true;
  const r = await run(mockAdapter({ place: jest.fn(async () => { throw err; }) }));
  expect(r).toMatchObject({ status: 'needs_review', reason: 'ambiguous_after_submit', bellPending: true });
  const parked = mockState.updates.filter((u) => u.table === 'vendor_orders' && u.row.status === 'needs_review').pop().row;
  const evidence = JSON.parse(parked.evidence);
  expect(evidence.bell.title).toMatch(/needs review/);
  expect(evidence.bell.body).toMatch(/Do NOT re-order/);
  expect(evidence.bellAt).toBeUndefined();
  // No bellAt stamp was written for the failed send.
  expect(mockState.updates.filter((u) => u.table === 'vendor_orders' && u.row.evidence && typeof u.row.evidence === 'string' && u.row.evidence.includes('bellAt'))).toHaveLength(0);

  // Next run: the pending row is re-rung first and stamped.
  mockState.updates = [];
  mockState.pendingBells = [{ id: 'ledger-1', evidence, request_id: 'req-1', product_name: 'Yard sign sticker', vendor_name: 'Sticker Mule' }];
  mockState.request = { ...baseRequest(), status: 'ordered' };
  const run2 = await dispatch.runVendorOrderDispatch({ notify, adapters: { stickermule: mockAdapter(), siteone: mockAdapter() } });
  expect(run2.bells).toEqual({ rung: ['ledger-1'], pending: [] });
  expect(notify).toHaveBeenLastCalledWith('system', evidence.bell.title, evidence.bell.body, expect.objectContaining({ dedupeKey: `auto-order:ledger-1:${evidence.bell.v}` }));
  expect(mockState.updates.some((u) => u.table === 'vendor_orders' && u.row.evidence)).toBe(true);
});

test('a delivered bell whose version stamp hits zero rows (the bell was replaced meanwhile) is NOT a delivery — the replacement stays pending, run red (hook P1)', async () => {
  mockState.bellStampMiss = true;
  mockState.pendingBells = [{ id: 'ledger-9', evidence: { bell: { title: 'Auto-order needs review: x', body: 'y', v: 'v1' } }, request_id: 'req-9', product_name: 'x', vendor_name: 'v' }];
  mockState.request = { ...baseRequest(), status: 'ordered' };
  await expect(dispatch.runVendorOrderDispatch({ notify, adapters: { stickermule: mockAdapter(), siteone: mockAdapter() } })).rejects.toThrow(/1 bell\(s\) not delivered.*ledger-9/);
  mockState.bellStampMiss = false;
  // ONLY the just-inserted v1 notification is retired — staff never read v1's instructions beside v2 (Codex r23 P1) — and v2's own notification is untouched: a delayed
  // v1 delivery must never retire the current bell, whose row is already stamped and would never re-ring (hook r31 P1).
  const retired = mockState.updates.filter((u) => u.table === 'notifications' && u.row.read_at);
  expect(retired).toHaveLength(1);
  expect(retired[0].raws).toEqual([[expect.stringContaining("dedupeKey' = ?"), ['auto-order:ledger-9:v1']]]);
});

test('a bell delivery retires the row\'s earlier bell versions BEFORE its stamp; a retire that fails leaves the bell pending — re-rung, and the retire retried, next run (Codex r31 P1)', async () => {
  const evidence = { bell: { title: 'Auto-order needs review: x', body: 'v2 text', v: 'v2' } };
  mockState.pendingBells = [{ id: 'ledger-7', evidence, request_id: 'req-7', product_name: 'x', vendor_name: 'v' }];
  mockState.request = { ...baseRequest(), status: 'ordered' };
  const r = await dispatch.runVendorOrderDispatch({ notify, adapters: { stickermule: mockAdapter(), siteone: mockAdapter() } });
  expect(r.bells).toEqual({ rung: ['ledger-7'], pending: [] });
  const order = mockState.updates.map((u) => u.table);
  expect(order.indexOf('notifications')).toBeGreaterThanOrEqual(0);
  expect(order.indexOf('notifications')).toBeLessThan(order.indexOf('vendor_orders')); // retire, then the bellAt stamp — one transaction under the row lock (hook r31 P1)
  const retire = mockState.updates.find((u) => u.table === 'notifications');
  expect(retire.raws.map((r) => r[1])).toEqual([['auto-order:ledger-7', 'auto-order:ledger-7:%'], ['auto-order:ledger-7:v2']]); // every other version of THIS row's bell, never v2 itself
  mockState.updates = [];
  mockState.bellRetireThrows = true;
  try {
    await expect(dispatch.runVendorOrderDispatch({ notify, adapters: { stickermule: mockAdapter(), siteone: mockAdapter() } })).rejects.toThrow(/1 bell\(s\) not delivered.*ledger-7/);
    expect(mockState.updates.some((u) => u.table === 'vendor_orders')).toBe(false); // no stamp: the next run re-rings v2 (a dedupe refresh) and retries the retire
  } finally { mockState.bellRetireThrows = false; }
});

test('the run goes red while a bell is undelivered', async () => {
  notify.mockRejectedValue(new Error('bell down'));
  mockState.pendingBells = [{ id: 'ledger-9', evidence: { bell: { title: 'Auto-order needs review: x', body: 'y' } }, request_id: 'req-9', product_name: 'x', vendor_name: 'v' }];
  mockState.request = { ...baseRequest(), status: 'ordered' };
  await expect(dispatch.runVendorOrderDispatch({ notify, adapters: { stickermule: mockAdapter(), siteone: mockAdapter() } })).rejects.toThrow(/1 bell\(s\) not delivered.*ledger-9/);
});

test('a loginRequired adapter places with the vendor row\'s stored login on top of the generic place args', async () => {
  mockState.vendor = { id: 'vend-s1', name: 'SiteOne', code: 1, active: true };
  mockState.request = { ...baseRequest(), requested_quantity: '256', unit: 'fl_oz', metadata: { vendorId: 'vend-s1' } };
  mockState.product = talstar;
  mockState.pricing = { vendor_sku: 'S1-77', quantity: '1 gal' };
  const place = jest.fn(async ({ beforeSubmit, vendorSku, quantity, credentials }) => {
    expect(vendorSku).toBe('S1-77');
    expect(quantity).toBe(2);
    expect(credentials).toMatchObject({ password: 'x', accountNumber: '123' });
    expect(await beforeSubmit(9900)).toEqual({ ok: true });
    return { dryRun: true, amountCents: 9900, externalOrderNumber: null, evidence: {} };
  });
  const r = await run({ key: 'siteone', quotesAtPlace: true, packagedQuantity: true, loginRequired: true, loginConfigured: () => true, place });
  expect(r).toMatchObject({ status: 'needs_review', reason: 'dry_run' });
  expect(place).toHaveBeenCalledTimes(1);
});

test('a login-required vendor without its stored login is handed back before any claim — no ledger row, the sweep bell rings, retryable once configured (Codex #3853 r12 P2)', async () => {
  const { getVendorLoginCredentials } = require('../services/vendor-credentials');
  getVendorLoginCredentials.mockResolvedValueOnce(null);
  mockState.vendor = { id: 'vend-s1', name: 'SiteOne', code: 1, active: true };
  mockState.request = { ...baseRequest(), requested_quantity: '256', unit: 'fl_oz', metadata: { vendorId: 'vend-s1' } };
  mockState.product = talstar;
  mockState.pricing = { vendor_sku: 'S1-77', quantity: '1 gal' };
  const place = jest.fn();
  // The decrypt's wrong-key fallback must not run inside the claim transaction (r13 P0): a distinct trx sentinel proves the lookup got the POOL connection
  const dbFn = require('../models/db');
  const origTransaction = dbFn.transaction;
  const trxSentinel = Object.assign((t) => dbFn(t), { raw: dbFn.raw });
  const transaction = jest.fn(async (fn) => fn(trxSentinel));
  dbFn.transaction = transaction;
  let r;
  try { r = await run({ key: 'siteone', quotesAtPlace: true, packagedQuantity: true, loginRequired: true, loginConfigured: (c) => !!(c && c.password && c.accountNumber), place }); }
  finally { dbFn.transaction = origTransaction; }
  expect(r).toMatchObject({ skipped: 'adapter_unconfigured', belled: true });
  expect(getVendorLoginCredentials).toHaveBeenLastCalledWith(dbFn, 'vend-s1');
  expect(getVendorLoginCredentials).not.toHaveBeenCalledWith(trxSentinel, expect.anything());
  // ...and BEFORE the claim transaction opens: the pool floor is 2 and the scheduled path already holds the lease + the transaction (pre-push P1)
  expect(getVendorLoginCredentials.mock.invocationCallOrder.at(-1)).toBeLessThan(transaction.mock.invocationCallOrder[0]);
  expect(place).not.toHaveBeenCalled();
  expect(mockState.ledgerRows).toHaveLength(0);
  // canAutoOrder makes the same call, so the sweep never stands down its bell for that vendor
  getVendorLoginCredentials.mockResolvedValueOnce(null);
  expect(await dispatch.canAutoOrder({ vendor: mockState.vendor })).toBe(false);
  expect(await dispatch.canAutoOrder({ vendor: mockState.vendor })).toBe(true); // the default mock login is complete
});

test('a vendor row that changed between the login prefetch and the locked claim is not claimed on the stale login — skipped, no bell, no ledger row (Codex #3853 r15 P1)', async () => {
  const { getVendorLoginCredentials } = require('../services/vendor-credentials');
  mockState.vendor = { id: 'vend-s1', name: 'SiteOne', code: 1, active: true, updated_at: '2026-09-05T00:00:00.000Z' };
  mockState.request = { ...baseRequest(), requested_quantity: '256', unit: 'fl_oz', metadata: { vendorId: 'vend-s1' } };
  mockState.product = talstar;
  mockState.pricing = { vendor_sku: 'S1-77', quantity: '1 gal' };
  // The password is rotated while the prefetch is reading it: the row the claim locks is newer than the one the login came from.
  getVendorLoginCredentials.mockImplementationOnce(async () => { mockState.vendor = { ...mockState.vendor, updated_at: '2026-09-05T00:00:01.000Z' }; return { email: 'a@b.c', password: 'old', accountNumber: '123' }; });
  const place = jest.fn();
  const r = await run({ key: 'siteone', quotesAtPlace: true, packagedQuantity: true, loginRequired: true, loginConfigured: () => true, place });
  expect(r).toEqual({ requestId: 'req-1', skipped: 'vendor_changed_at_claim' });
  expect(place).not.toHaveBeenCalled();
  expect(mockState.ledgerRows).toHaveLength(0);
  expect(notify).not.toHaveBeenCalled();
  // Same row version → the claim proceeds on the prefetched login (dry run parks as before)
  const place2 = jest.fn(async () => ({ dryRun: true, amountCents: 9900, externalOrderNumber: null, evidence: {} }));
  expect(await run({ key: 'siteone', quotesAtPlace: true, packagedQuantity: true, loginRequired: true, loginConfigured: () => true, place: place2 })).toMatchObject({ status: 'needs_review', reason: 'dry_run' });
});

test('a credential lookup that THROWS is run-level: nothing claimed, nothing parked failed, the adapter is dead for the run (pre-push P1)', async () => {
  const { getVendorLoginCredentials } = require('../services/vendor-credentials');
  getVendorLoginCredentials.mockRejectedValueOnce(new Error('connection reset'));
  mockState.vendor = { id: 'vend-s1', name: 'SiteOne', code: 1, active: true };
  mockState.request = { ...baseRequest(), requested_quantity: '256', unit: 'fl_oz', metadata: { vendorId: 'vend-s1' } };
  mockState.product = talstar;
  mockState.pricing = { vendor_sku: 'S1-77', quantity: '1 gal' };
  const place = jest.fn();
  await expect(run({ key: 'siteone', quotesAtPlace: true, packagedQuantity: true, loginRequired: true, loginConfigured: () => true, place })).rejects.toMatchObject({ runLevel: true, adapterKey: 'siteone', message: expect.stringMatching(/credential lookup failed/) });
  expect(place).not.toHaveBeenCalled();
  expect(mockState.ledgerRows).toHaveLength(0); // the lookup precedes the claim: nothing to release
  expect(mockState.updates.filter((u) => u.table === 'vendor_orders' && u.row.status)).toHaveLength(0); // never parked
  expect(notify).not.toHaveBeenCalled();
});

test('a login-driven adapter already dead this run is skipped adapter_down WITHOUT another credential lookup (Codex #3853 r24 P2)', async () => {
  const { getVendorLoginCredentials } = require('../services/vendor-credentials');
  mockState.vendor = { id: 'vend-s1', name: 'SiteOne', code: 1, active: true };
  mockState.request = { ...baseRequest(), requested_quantity: '256', unit: 'fl_oz', metadata: { vendorId: 'vend-s1' } };
  mockState.product = talstar;
  mockState.pricing = { vendor_sku: 'S1-77', quantity: '1 gal' };
  const calls = getVendorLoginCredentials.mock.calls.length;
  const place = jest.fn();
  expect(await run({ key: 'siteone', quotesAtPlace: true, packagedQuantity: true, loginRequired: true, loginConfigured: () => true, place }, { deadAdapters: new Set(['siteone']) })).toMatchObject({ skipped: 'adapter_down' });
  expect(getVendorLoginCredentials.mock.calls).toHaveLength(calls);
  expect(place).not.toHaveBeenCalled();
});

test('a bell notifyAdmin swallowed (null return) is NOT delivered: bellPending, no bellAt stamp, re-rung next run (r2 P1)', async () => {
  notify = jest.fn(async () => null); // notification-service returns null when its insert/dedupe failed
  mockState.pricing = null;
  const r = await run(mockAdapter());
  expect(r).toMatchObject({ status: 'needs_review', reason: 'no_price', bellPending: true });
  expect(mockState.updates.some((u) => u.table === 'vendor_orders' && typeof u.row.evidence === 'string' && u.row.evidence.includes('bellAt'))).toBe(false);
});

test('vendor call ran but neither the record nor the park could be written → status unrecorded, and the run goes red on it (r2 P1)', async () => {
  const dbFn = require('../models/db');
  const realTx = dbFn.transaction;
  let n = 0;
  dbFn.transaction = async (fn) => { n += 1; if (n >= 3) throw new Error('db gone'); return fn(dbFn); }; // claim + cap reservation land, record + park do not
  try {
    const r = await run(mockAdapter());
    expect(r).toMatchObject({ status: 'unrecorded', reason: 'persist_after_placement' });
    expect(r.error).toMatch(/db gone.*park failed/);
  } finally { dbFn.transaction = realTx; }
});

test('a stale placing row whose park fails keeps the run red (r2 P1)', async () => {
  const dbFn = require('../models/db');
  const realTx = dbFn.transaction;
  dbFn.transaction = async () => { throw new Error('ledger write failed'); };
  mockState.stale = [{ id: 'ledger-old', adapter: 'stickermule', amount_cents: 31400, created_at: new Date(Date.now() - 3600e3), request_id: 'req-old', product_name: 'Sticker', vendor_id: 'vend-sm', vendor_name: 'Sticker Mule' }];
  try {
    const a = mockAdapter();
    await expect(dispatch.runVendorOrderDispatch({ notify, adapters: { stickermule: a, siteone: a } })).rejects.toThrow(/1 stale placing row\(s\) could not be parked \(ledger ledger-old\)/);
  } finally { dbFn.transaction = realTx; }
});

test('stale recovery parks only when the heartbeat observed at scan time is still old — the conditional write carries the cutoff (r5 P1)', async () => {
  const dbFn = require('../models/db');
  const seen = [];
  const orig = dbFn.getMockImplementation();
  dbFn.mockImplementation((table) => { const q = orig(table); if (table === 'vendor_orders') { const w = q.where; q.where = (...a) => { seen.push(a); return w.apply(q, a); }; } return q; });
  mockState.stale = [{ id: 'ledger-old', adapter: 'stickermule', amount_cents: 31400, created_at: new Date(Date.now() - 3600e3), updated_at: new Date(Date.now() - 3600e3), request_id: 'req-old', product_name: 'Sticker', vendor_id: 'vend-sm', vendor_name: 'Sticker Mule' }];
  try {
    const a = mockAdapter();
    await dispatch.runVendorOrderDispatch({ notify, adapters: { stickermule: a, siteone: a } });
    expect(seen.some((args) => args[0] === 'updated_at' && args[1] === '<' && args[2] instanceof Date)).toBe(true);
  } finally { dbFn.mockImplementation(orig); }
});

test('orderedQuantityFor: the dispatched claim payload, in the request unit; null without a dispatched order (r2 P1)', async () => {
  const dbFn = require('../models/db');
  mockState.dispatchedLedger = null;
  expect(await dispatch.orderedQuantityFor(dbFn, 'req-1')).toBeNull();
  mockState.dispatchedLedger = { request_payload: JSON.stringify({ quantity: 130, unit: 'fl_oz', vendorQuantity: 2, packSize: '128 fl oz', orderedQuantity: 256 }) };
  expect(await dispatch.orderedQuantityFor(dbFn, 'req-1')).toBe(256);
});

test('a prior dispatched order for the product that is neither received nor revoked blocks the claim — no second order on top of stock that may be on its way (pre-push P0)', async () => {
  mockState.priorUnreconciled = { id: 'ledger-prior' };
  const a = mockAdapter();
  expect(await run(a)).toMatchObject({ skipped: 'prior_order_unreconciled' });
  expect(mockState.ledgerRows).toHaveLength(0);
  expect(a.place).not.toHaveBeenCalled();
});

test('a live manual/forecast request for the same product blocks the claim — staff are ordering', async () => {
  mockState.sibling = { id: 'req-manual', source: 'manual', status: 'open' };
  const a = mockAdapter();
  expect((await run(a)).skipped).toBe('sibling_live_request');
  expect(mockState.ledgerRows).toHaveLength(0);
  expect(a.place).not.toHaveBeenCalled();
});

test('the claim heartbeat touches only a row still placing, every 60 s, and stops with the vendor call (pre-push P0)', async () => {
  jest.useFakeTimers();
  try {
    const dbFn = require('../models/db');
    const { startClaimHeartbeat, HEARTBEAT_MS } = dispatch._internals;
    const stop = startClaimHeartbeat(dbFn, 'ledger-1');
    expect(HEARTBEAT_MS).toBe(60 * 1000);
    jest.advanceTimersByTime(HEARTBEAT_MS * 2 + 10);
    await Promise.resolve();
    const beats = mockState.updates.filter((u) => u.table === 'vendor_orders' && u.row.updated_at && Object.keys(u.row).length === 1);
    expect(beats).toHaveLength(2);
    stop();
    jest.advanceTimersByTime(HEARTBEAT_MS * 3);
    expect(mockState.updates.filter((u) => u.table === 'vendor_orders' && Object.keys(u.row).length === 1)).toHaveLength(2);
  } finally { jest.useRealTimers(); }
});

test('a placing row older than 30 minutes is parked needs_review with a do-not-re-order bell, never retried', async () => {
  mockState.stale = [{ id: 'ledger-old', adapter: 'stickermule', amount_cents: 31400, created_at: new Date(Date.now() - 3600e3), request_id: 'req-old', product_name: 'Sticker', vendor_id: 'vend-sm', vendor_name: 'Sticker Mule' }];
  const a = mockAdapter();
  const r = await dispatch.runVendorOrderDispatch({ notify, adapters: { stickermule: a, siteone: a } });
  expect(r.recovered).toEqual(['ledger-old']);
  const row = mockState.updates.find((u) => u.table === 'vendor_orders').row;
  expect(row).toMatchObject({ status: 'needs_review' });
  expect(row.placed_at).toBeInstanceOf(Date);
  expect(row.error).toMatch(/stale_placing/);
  expect(notify.mock.calls[0][2]).toMatch(/Do NOT re-order/);
  expect(a.place).not.toHaveBeenCalled();
});

test('stale recovery of a claim whose request an older pod CANCELLED meanwhile restores the request to ordered — the possibly-placed order stays reconcilable (Codex r31 P1)', async () => {
  mockState.stale = [{ id: 'ledger-old', adapter: 'stickermule', amount_cents: 31400, created_at: new Date(Date.now() - 3600e3), request_id: 'req-old', product_name: 'Sticker', vendor_id: 'vend-sm', vendor_name: 'Sticker Mule' }];
  mockState.freshRequestStatus = 'cancelled';
  const a = mockAdapter();
  const r = await dispatch.runVendorOrderDispatch({ notify, adapters: { stickermule: a, siteone: a } });
  expect(r.recovered).toEqual(['ledger-old']);
  const reopen = mockState.updates.find((u) => u.table === 'product_restock_requests');
  expect(reopen.row).toMatchObject({ status: 'ordered', closed_at: null });
  const row = mockState.updates.find((u) => u.table === 'vendor_orders').row;
  expect(JSON.parse(row.evidence).reopenedFromCancelledAt).toEqual(expect.any(String));
  expect(row.status).toBe('needs_review');
  // An open request is left open, as before.
  mockState.updates = []; mockState.freshRequestStatus = 'open';
  await dispatch.runVendorOrderDispatch({ notify, adapters: { stickermule: a, siteone: a } });
  expect(mockState.updates.filter((u) => u.table === 'product_restock_requests')).toHaveLength(0);
});

test('assertNoLiveAutoOrder: a placing or dispatched auto claim refuses a staff request with a 409 that names the tab (pre-push P0)', async () => {
  const dbFn = require('../models/db');
  await expect(dispatch.assertNoLiveAutoOrder(dbFn, 'prod-sticker')).resolves.toBeUndefined();
  mockState.liveAutoOrder = { status: 'placing', external_order_number: null, vendor_name: 'Sticker Mule' };
  await expect(dispatch.assertNoLiveAutoOrder(dbFn, 'prod-sticker')).rejects.toMatchObject({ statusCode: 409, code: 'auto_order_live', message: expect.stringMatching(/Sticker Mule order.*being placed.*Restock tab/) });
  mockState.liveAutoOrder = { status: 'placed', external_order_number: 'SM-1', vendor_name: 'Sticker Mule' };
  await expect(dispatch.assertNoLiveAutoOrder(dbFn, 'prod-sticker')).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/\(SM-1\).*already out.*receive it or revoke it/) });
});

test('stale recovery that loses the race to the live dispatcher leaves the settled row alone — no overwrite, no audit, no bell (pre-push P1)', async () => {
  mockState.stale = [{ id: 'ledger-old', adapter: 'stickermule', amount_cents: 31400, created_at: new Date(Date.now() - 3600e3), request_id: 'req-old', product_name: 'Sticker', vendor_id: 'vend-sm', vendor_name: 'Sticker Mule' }];
  mockState.ledgerSettled = true; // the row went 'placed' between the scan and the park
  const a = mockAdapter();
  const r = await dispatch.runVendorOrderDispatch({ notify, adapters: { stickermule: a, siteone: a } });
  expect(r.recovered).toEqual([]);
  expect(auditVendorOrder).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();
  expect(mockState.updates.filter((u) => u.table === 'product_restock_requests')).toHaveLength(0);
});
