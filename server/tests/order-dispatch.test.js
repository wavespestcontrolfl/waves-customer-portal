/**
 * procurement/order-dispatch.js — the auto-order dispatcher.
 *
 * Contract:
 *   - master gate off → {skipped:'gated'} before any DB read
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
 *   - a request closed while the vendor call was in flight stays closed,
 *     the ledger is still placed, and ONE reconcile bell rings
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
    q.first = async (...cols) => {
      if (cols[0] === 'vo.status') return mockState.liveAutoOrder; // assertNoLiveAutoOrder's aliased join
      if (cols[0] === 'vo.id') return mockState.priorUnreconciled; // the claim's prior-order belt
      if (cols[0] === 'request_payload') return mockState.dispatchedLedger; // orderedQuantityFor
      if (cols[0] === 'evidence' && table === 'vendor_orders') return { evidence: mockState.parkedEvidence || {} }; // attachLatePlacement
      if (table === 'product_restock_requests') {
        if (cols[0] === 'status') return { status: mockState.freshRequestStatus };
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
    q.update = async (row) => { mockState.updates.push({ table, row }); return table === 'vendor_orders' && mockState.ledgerSettled && (row.status || (row.amount_cents != null && row.external_order_number === undefined)) ? 0 : 1; };
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
  dbFn.raw = jest.fn(async (sql) => sql);
  dbFn.transaction = async (fn) => fn(dbFn);
  return dbFn;
});

const { auditVendorOrder } = require('../services/audit-log');
const dispatch = require('../services/procurement/order-dispatch');

const ENV = { GATE_AUTO_ORDER: 'true', GATE_AUTO_ORDER_STICKERMULE: 'true', GATE_AUTO_ORDER_SITEONE: 'true', AUTO_ORDER_MAX_PER_ORDER_CENTS: '50000', AUTO_ORDER_MAX_MONTHLY_CENTS: '100000' };
const baseRequest = () => ({ id: 'req-1', product_id: 'prod-sticker', status: 'open', source: 'auto_reorder', requested_quantity: '500', unit: 'each', metadata: { vendorId: 'vend-sm', vendorSku: '4242' } });
const stickerMule = { id: 'vend-sm', name: 'Sticker Mule', code: 25, active: true };
const sticker = { id: 'prod-sticker', name: 'Yard sign sticker', active: true, auto_reorder_enabled: true, inventory_on_hand: '40', low_stock_threshold: '100', auto_reorder_vendor_id: 'vend-sm', reorder_quantity: '500', inventory_unit: 'each' };
const talstar = { id: 'prod-chem', name: 'Talstar', active: true, auto_reorder_enabled: true, inventory_on_hand: '20', low_stock_threshold: '64', auto_reorder_vendor_id: 'vend-s1', reorder_quantity: '256', inventory_unit: 'fl_oz' };

function mockAdapter(overrides = {}) {
  return { key: 'stickermule', preSubmitTotal: 'vendor', bindingQuote: jest.fn(async () => ({ cents: 31400, source: 'order SM-0' })), place: jest.fn(async () => ({ externalOrderNumber: 'SM-1', amountCents: 31400, response: { ok: 1 }, evidence: { itemId: 4242 } })), ...overrides };
}

let notify;
beforeEach(() => {
  Object.assign(mockState, { request: baseRequest(), vendor: stickerMule, product: sticker, pricing: { vendor_sku: '4242', price: '314.00', quantity: '500' }, ledgerRows: [], freshRequestStatus: 'open', monthly: 0, claimConflict: false, updates: [], deletes: [], sibling: null, stale: [], pendingBells: [], ledgerSettled: false, liveAutoOrder: null, priorUnreconciled: null, dispatchedLedger: null });
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

test('master gate off → skipped before any claim', async () => {
  process.env.GATE_AUTO_ORDER = 'false';
  const a = mockAdapter();
  expect(await run(a)).toEqual({ requestId: 'req-1', skipped: 'gated' });
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

test('the monthly cap buckets by PURCHASE month (placed_at, else the reservation-stamped created_at) and the reservation re-stamps created_at (pre-push P0)', async () => {
  const dbFn = require('../models/db');
  const orig = dbFn.getMockImplementation();
  const raws = [];
  dbFn.mockImplementation((table) => { const q = orig(table); if (table === 'vendor_orders') { const w = q.whereRaw; q.whereRaw = (...a) => { raws.push(a); return w ? w.apply(q, a) : q; }; } return q; });
  const before = Date.now();
  expect(await run(mockAdapter())).toMatchObject({ status: 'placed' });
  dbFn.mockImplementation(orig);
  expect(raws.some((a) => /COALESCE\(placed_at, created_at\) >= \?/.test(String(a[0])))).toBe(true);
  const reservation = mockState.updates.find((u) => u.table === 'vendor_orders' && u.row.amount_cents === 31400 && u.row.created_at);
  expect(reservation).toBeTruthy();
  expect(reservation.row.created_at.getTime()).toBeGreaterThanOrEqual(before);
});

test('a request the claim finds undispatchable (vendor deactivated / gated after the sweep stood down) is handed off with the sweep\'s deduped bell (Codex r12 P2)', async () => {
  mockState.vendor = { ...mockState.vendor, active: false };
  const r = await run(mockAdapter());
  expect(r).toMatchObject({ skipped: 'no_adapter', belled: true });
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify.mock.calls[0][3].dedupeKey).toMatch(/^auto-reorder:/);
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

test('request closed mid-flight: ledger still placed, request untouched, one reconcile bell', async () => {
  mockState.freshRequestStatus = 'cancelled';
  const r = await run(mockAdapter());
  expect(r.status).toBe('placed');
  expect(ledgerStatus()).toBe('placed');
  expect(requestStatus()).toBeUndefined();
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify.mock.calls[0][1]).toMatch(/cancelled request/);
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

test('vendor total over cap after placement → needs_review, request ordered, bell says do NOT re-order', async () => {
  const a = mockAdapter({ place: jest.fn(async () => ({ externalOrderNumber: 'SM-2', amountCents: 60000, response: {}, evidence: { totalSource: 'vendor' } })) });
  const r = await run(a);
  expect(r).toMatchObject({ status: 'needs_review', reason: 'over_cap_after_placement' });
  expect(requestStatus()).toBe('ordered');
  const ledger = lastLedgerPatch();
  expect(ledger).toMatchObject({ status: 'needs_review', external_order_number: 'SM-2', amount_cents: 60000 });
  expect(ledger.placed_at).toBeInstanceOf(Date);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify.mock.calls[0][2]).toMatch(/Do NOT re-order/);
  expect(notify.mock.calls[0][2]).not.toMatch(/order manually/);
});

test('a DB failure after the vendor call parks as persist_after_placement, never failed', async () => {
  const dbFn = require('../models/db');
  const realTx = dbFn.transaction;
  // Transactions: 1 claim, 2 cap reservation, 3 the green-path write — make that one throw.
  let n = 0;
  dbFn.transaction = async (fn) => { n += 1; if (n === 3) throw new Error('audit insert lost connection'); return fn(dbFn); };
  try {
    const r = await run(mockAdapter());
    expect(r).toMatchObject({ status: 'needs_review', reason: 'persist_after_placement' });
    expect(ledgerStatus()).toBe('needs_review');
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
  expect(require('../services/procurement/adapters/siteone')).toMatchObject({ preSubmitTotal: 'vendor', packagedQuantity: true, loginRequired: true });
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
  const r = await run({ key: 'siteone', quotesAtPlace: true, packagedQuantity: true, loginRequired: true, place });
  expect(r).toMatchObject({ status: 'needs_review', reason: 'dry_run' });
  expect(place).toHaveBeenCalledTimes(1);
});

test('a credential lookup that THROWS is run-level: claim released, nothing parked failed, batch aborts (pre-push P1)', async () => {
  const { getVendorLoginCredentials } = require('../services/vendor-credentials');
  getVendorLoginCredentials.mockRejectedValueOnce(new Error('connection reset'));
  mockState.vendor = { id: 'vend-s1', name: 'SiteOne', code: 1, active: true };
  mockState.request = { ...baseRequest(), requested_quantity: '256', unit: 'fl_oz', metadata: { vendorId: 'vend-s1' } };
  mockState.product = talstar;
  mockState.pricing = { vendor_sku: 'S1-77', quantity: '1 gal' };
  const place = jest.fn();
  await expect(run({ key: 'siteone', quotesAtPlace: true, packagedQuantity: true, loginRequired: true, place })).rejects.toMatchObject({ runLevel: true, message: expect.stringMatching(/credential lookup failed/) });
  expect(place).not.toHaveBeenCalled();
  expect(mockState.deletes).toContain('vendor_orders'); // claim released
  expect(mockState.updates.filter((u) => u.table === 'vendor_orders' && u.row.status)).toHaveLength(0); // never parked
  expect(notify).not.toHaveBeenCalled();
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
