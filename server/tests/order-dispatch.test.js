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
jest.mock('../services/procurement/auto-reorder', () => ({ vendorPricingFor: jest.fn(async () => mockState.pricing) }));

const mockState = { request: null, vendor: null, product: null, pricing: null, ledgerRows: [], freshRequestStatus: 'open', monthly: 0, claimConflict: false, updates: [], deletes: [], sibling: null, stale: [], pendingBells: [], ledgerSettled: false };

jest.mock('../models/db', () => {
  const mkChain = (table) => {
    const q = {};
    for (const m of ['join', 'leftJoin', 'where', 'whereNot', 'whereNull', 'whereRaw', 'select', 'orderBy', 'forUpdate', 'modify']) q[m] = () => q;
    q.whereIn = (col) => { if (col === 'vo.status') q._pendingBells = true; return q; };
    q.first = async (...cols) => {
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
    q.update = async (row) => { mockState.updates.push({ table, row }); return table === 'vendor_orders' && mockState.ledgerSettled && row.status ? 0 : 1; };
    q.delete = async () => { mockState.deletes.push(table); return 1; };
    let row;
    const returning = async () => {
      if (mockState.claimConflict) return [];
      const saved = { id: `ledger-${mockState.ledgerRows.length + 1}`, ...row };
      mockState.ledgerRows.push(saved);
      return [saved];
    };
    q.insert = (r) => { row = r; return { onConflict: () => ({ ignore: () => ({ returning }) }), returning }; };
    q.then = (ok, err) => Promise.resolve(table.startsWith('vendor_orders') ? (q._pendingBells ? mockState.pendingBells : mockState.stale) : []).then(ok, err);
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
  Object.assign(mockState, { request: baseRequest(), vendor: stickerMule, product: sticker, pricing: { vendor_sku: '4242', price: '314.00', quantity: '500' }, ledgerRows: [], freshRequestStatus: 'open', monthly: 0, claimConflict: false, updates: [], deletes: [], sibling: null, stale: [], pendingBells: [], ledgerSettled: false });
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
  const a = mockAdapter();
  const r = await run(a);
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
  expect(notify.mock.calls[0][3]).toMatchObject({ bell: true, dedupeKey: 'auto-order:ledger-1' });
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

test('adapter refusal → needs_review with the refuse code', async () => {
  const err = new Error('exactly one address required'); err.refuse = 'multiple_addresses';
  const r = await run(mockAdapter({ place: jest.fn(async () => { throw err; }) }));
  expect(r).toMatchObject({ status: 'needs_review', reason: 'multiple_addresses' });
  expect(notify).toHaveBeenCalledTimes(1);
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

test('run-level error releases the claim and propagates', async () => {
  const err = new Error('no browser'); err.runLevel = true;
  await expect(run(mockAdapter({ place: jest.fn(async () => { throw err; }) }))).rejects.toThrow('no browser');
  expect(mockState.deletes).toEqual(['vendor_orders']);
  expect(notify).not.toHaveBeenCalled();
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

test('SiteOne: no static quote, the cap check runs through beforeSubmit and a dry run parks', async () => {
  mockState.vendor = { id: 'vend-s1', name: 'SiteOne', code: 1, active: true };
  mockState.request = { ...baseRequest(), requested_quantity: '256', unit: 'fl_oz', metadata: { vendorId: 'vend-s1' } };
  mockState.product = talstar;
  mockState.pricing = { vendor_sku: 'S1-77', quantity: '1 gal' };
  const place = jest.fn(async ({ beforeSubmit, vendorSku, quantity, credentials }) => {
    expect(vendorSku).toBe('S1-77');
    expect(quantity).toBe(2); // 256 fl oz of a 1 gal jug = 2 packages
    expect(credentials.password).toBe('x');
    expect(await beforeSubmit(9900)).toEqual({ ok: true });
    expect((await beforeSubmit(999900)).reason).toBe('over_per_order_cap');
    return { dryRun: true, amountCents: 9900, externalOrderNumber: null, evidence: {} };
  });
  const r = await run({ key: 'siteone', quotesAtPlace: true, packagedQuantity: true, place });
  expect(r).toMatchObject({ status: 'needs_review', reason: 'dry_run' });
  expect(notify.mock.calls[0][1]).toMatch(/dry run/);
  expect(JSON.parse(mockState.ledgerRows[0].request_payload)).toMatchObject({ vendorSku: 'S1-77', quantity: 256, unit: 'fl_oz', vendorQuantity: 2, packSize: '1 gal' });
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
  expect(q(s1, '256', 'fl_oz', '1 gal')).toEqual({ quantity: 2, packSize: '1 gal' });
  expect(q(s1, '100', 'fl_oz', '1 gal')).toEqual({ quantity: 1, packSize: '1 gal' });
  expect(q(s1, '2.5', 'gal', '2.5 gal')).toEqual({ quantity: 1, packSize: '2.5 gal' });
  expect(q(s1, '40', 'lb', '16 lb')).toEqual({ quantity: 3, packSize: '16 lb' });
  expect(q(s1, '250', 'each', '100 each')).toEqual({ quantity: 3, packSize: '100 each' });
  expect(q(s1, '250', 'each', '100')).toEqual({ quantity: 3, packSize: '100 each' });
  expect(q(s1, '128', 'fl_oz', '16 lb').error).toBe('pack_unit_mismatch');
  expect(q(s1, '128', 'fl_oz', '').error).toBe('no_pack_size');
  expect(q(s1, '250', 'each', '1 gal').error).toBe('no_pack_size');
  expect(q(sm, '500', 'each', '500')).toEqual({ quantity: 500, packSize: null });
  expect(q(sm, '500', 'fl_oz', '500').error).toBe('count_unit_required');
  expect(q(s1, '0', 'fl_oz', '1 gal').error).toBe('no_quantity');
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

test('canAutoOrder mirrors gates + adapter map + vendor active', async () => {
  expect(await dispatch.canAutoOrder({ vendor: stickerMule })).toBe(true);
  expect(await dispatch.canAutoOrder({ vendor: { id: 'g', name: 'Gemplers', code: 24 } })).toBe(false);
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

test('the real Sticker Mule adapter is history-total + count quantity; the real SiteOne adapter is vendor-total + package quantity', () => {
  expect(require('../services/procurement/adapters/stickermule')).toMatchObject({ preSubmitTotal: 'history', packagedQuantity: false });
  expect(require('../services/procurement/adapters/siteone')).toMatchObject({ preSubmitTotal: 'vendor', packagedQuantity: true });
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
  expect(notify).toHaveBeenLastCalledWith('system', evidence.bell.title, evidence.bell.body, expect.objectContaining({ dedupeKey: 'auto-order:ledger-1' }));
  expect(mockState.updates.some((u) => u.table === 'vendor_orders' && u.row.evidence)).toBe(true);
});

test('the run goes red while a bell is undelivered', async () => {
  notify.mockRejectedValue(new Error('bell down'));
  mockState.pendingBells = [{ id: 'ledger-9', evidence: { bell: { title: 'Auto-order needs review: x', body: 'y' } }, request_id: 'req-9', product_name: 'x', vendor_name: 'v' }];
  mockState.request = { ...baseRequest(), status: 'ordered' };
  await expect(dispatch.runVendorOrderDispatch({ notify, adapters: { stickermule: mockAdapter(), siteone: mockAdapter() } })).rejects.toThrow(/1 bell\(s\) not delivered.*ledger-9/);
});

test('a live manual/forecast request for the same product blocks the claim — staff are ordering', async () => {
  mockState.sibling = { id: 'req-manual', source: 'manual', status: 'open' };
  const a = mockAdapter();
  expect((await run(a)).skipped).toBe('sibling_live_request');
  expect(mockState.ledgerRows).toHaveLength(0);
  expect(a.place).not.toHaveBeenCalled();
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
