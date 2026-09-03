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
 *   - canAutoOrder mirrors the gates + adapter map
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/vendor-credentials', () => ({ getVendorLoginCredentials: jest.fn(async () => ({ email: 'a@b.c', password: 'x', accountNumber: '123' })) }));
jest.mock('../services/audit-log', () => ({ auditVendorOrder: jest.fn(async () => 'audit-1') }));
jest.mock('../services/procurement/auto-reorder', () => ({ vendorPricingFor: jest.fn(async () => mockState.pricing) }));

const mockState = { request: null, vendor: null, product: null, pricing: null, ledgerRows: [], freshRequestStatus: 'open', monthly: 0, claimConflict: false, updates: [], deletes: [], sibling: null, stale: [] };

jest.mock('../models/db', () => {
  const mkChain = (table) => {
    const q = {};
    for (const m of ['join', 'leftJoin', 'where', 'whereIn', 'whereNot', 'whereNull', 'whereRaw', 'select', 'orderBy', 'forUpdate', 'modify']) q[m] = () => q;
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
    q.update = async (row) => { mockState.updates.push({ table, row }); return 1; };
    q.delete = async () => { mockState.deletes.push(table); return 1; };
    let row;
    const returning = async () => {
      if (mockState.claimConflict) return [];
      const saved = { id: `ledger-${mockState.ledgerRows.length + 1}`, ...row };
      mockState.ledgerRows.push(saved);
      return [saved];
    };
    q.insert = (r) => { row = r; return { onConflict: () => ({ ignore: () => ({ returning }) }), returning }; };
    q.then = (ok, err) => Promise.resolve(table.startsWith('vendor_orders') ? mockState.stale : []).then(ok, err);
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
const sticker = { id: 'prod-sticker', name: 'Yard sign sticker', siteone_sku: null };

function mockAdapter(overrides = {}) {
  return { key: 'stickermule', preSubmitTotal: 'vendor', bindingQuote: jest.fn(async () => ({ cents: 31400, source: 'order SM-0' })), place: jest.fn(async () => ({ externalOrderNumber: 'SM-1', amountCents: 31400, response: { ok: 1 }, evidence: { itemId: 4242 } })), ...overrides };
}

let notify;
beforeEach(() => {
  Object.assign(mockState, { request: baseRequest(), vendor: stickerMule, product: sticker, pricing: { vendor_sku: '4242', price: '314.00', quantity: '500' }, ledgerRows: [], freshRequestStatus: 'open', monthly: 0, claimConflict: false, updates: [], deletes: [], sibling: null, stale: [] });
  for (const k of Object.keys(ENV)) process.env[k] = ENV[k];
  notify = jest.fn(async () => ({ id: 'n1' }));
  auditVendorOrder.mockClear();
});
afterAll(() => { for (const k of Object.keys(ENV)) delete process.env[k]; });

const run = (adapter, opts = {}) => dispatch.dispatchRestockOrder('req-1', { notify, adapters: { stickermule: adapter, siteone: adapter }, ...opts });
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
  mockState.request = { ...baseRequest(), metadata: { vendorId: 'vend-s1' } };
  mockState.product = { id: 'prod-chem', name: 'Talstar', siteone_sku: 'S1-77' };
  mockState.pricing = null;
  const place = jest.fn(async ({ beforeSubmit, vendorSku, credentials }) => {
    expect(vendorSku).toBe('S1-77');
    expect(credentials.password).toBe('x');
    expect(await beforeSubmit(9900)).toEqual({ ok: true });
    expect((await beforeSubmit(999900)).reason).toBe('over_per_order_cap');
    return { dryRun: true, amountCents: 9900, externalOrderNumber: null, evidence: {} };
  });
  const r = await run({ key: 'siteone', quotesAtPlace: true, place });
  expect(r).toMatchObject({ status: 'needs_review', reason: 'dry_run' });
  expect(notify.mock.calls[0][1]).toMatch(/dry run/);
});

test('canAutoOrder mirrors gates + adapter map', async () => {
  expect(await dispatch.canAutoOrder({ vendor: stickerMule })).toBe(true);
  expect(await dispatch.canAutoOrder({ vendor: { id: 'g', name: 'Gemplers', code: 24 } })).toBe(false);
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
  const ledger = mockState.updates.filter((u) => u.table === 'vendor_orders').pop().row;
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
    const ledger = mockState.updates.filter((u) => u.table === 'vendor_orders').pop().row;
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
  const post = mockState.updates.filter((u) => u.table === 'vendor_orders').pop().row;
  expect(post.status).toBe('needs_review');
  expect(post.placed_at).toBeInstanceOf(Date);

  mockState.updates = [];
  process.env.AUTO_ORDER_MAX_PER_ORDER_CENTS = '10000';
  await run(mockAdapter());
  const pre = mockState.updates.filter((u) => u.table === 'vendor_orders').pop().row;
  expect(pre.status).toBe('needs_review');
  expect(pre.amount_cents).toBe(31400); // shown on the tab…
  expect(pre.placed_at).toBeUndefined(); // …but not counted against the month
});

test('monthly sum counts only placing reservations and dispatched rows', async () => {
  const dbFn = require('../models/db');
  const seen = [];
  const orig = dbFn.getMockImplementation();
  dbFn.mockImplementation((table) => { const q = orig(table); if (table === 'vendor_orders') { const w = q.where; q.where = (...a) => { seen.push(a); if (typeof a[0] === 'function') { const inner = { where: (...b) => { seen.push(['inner', ...b]); return inner; }, orWhereNotNull: (...b) => { seen.push(['inner', 'orWhereNotNull', ...b]); return inner; } }; a[0].call(inner); } return q; }; } return q; });
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
  const ledger = mockState.updates.filter((u) => u.table === 'vendor_orders').pop().row;
  expect(ledger.placed_at).toBeUndefined();
});

test('the real Sticker Mule adapter is history-total; the real SiteOne adapter is vendor-total', () => {
  expect(require('../services/procurement/adapters/stickermule').preSubmitTotal).toBe('history');
  expect(require('../services/procurement/adapters/siteone').preSubmitTotal).toBe('vendor');
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
