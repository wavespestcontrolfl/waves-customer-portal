/**
 * "Record vendor cancellation" on the Restock tab, and the revoke it shares
 * with ops/agents/auto-order-revoke.js (services/procurement/order-revoke.js),
 * against live Postgres. The tab sends back the order it showed (restock queue
 * order.id + order.version). A refusal writes nothing, and the order keeps
 * blocking a duplicate (findLiveAutoOrder) until the record succeeds.
 * Fixtures are synthetic; nothing is sent to a vendor.
 */
const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const crypto = require('crypto');

maybeDescribe('order-revoke (live Postgres)', () => {
  let db;
  let revoke;
  let queue;
  let dispatch;
  let policySvc;
  const made = { products_catalog: [], product_restock_requests: [], vendor_orders: [], notifications: [], vendor_pricing: [], settingKeys: [] };
  const ACTOR = crypto.randomUUID();

  // A placed SiteOne order (its bell rung) for an ordered request.
  async function fixture({ request = {}, order = {}, evidence = {} } = {}) {
    const id = crypto.randomUUID();
    const [product] = await db('products_catalog').insert({
      id, name: `Fixture Herbicide ${id.slice(0, 8)}`, category: 'herbicide', inventory_unit: 'gal', inventory_on_hand: 1,
    }).returning('*');
    made.products_catalog.push(product.id);
    const [req] = await db('product_restock_requests').insert({
      id: crypto.randomUUID(), product_id: product.id, status: 'ordered', priority: 'normal', requested_quantity: 4, unit: 'gal', source: 'test_fixture', ...request,
    }).returning('*');
    made.product_restock_requests.push(req.id);
    const [vo] = await db('vendor_orders').insert({
      restock_request_id: req.id, adapter: 'siteone', status: 'placed', external_order_number: 'SO-FIXTURE-1', amount_cents: 4200, placed_at: new Date(),
      evidence: JSON.stringify({ bell: { title: 'Fixture bell' }, bellAt: new Date().toISOString(), ...evidence }), ...order,
    }).returning('*');
    made.vendor_orders.push(vo.id);
    const [bell] = await db('notifications').insert({
      recipient_type: 'admin', category: 'procurement', title: 'Fixture auto-order bell', metadata: JSON.stringify({ dedupeKey: `auto-order:${vo.id}` }),
    }).returning('*');
    made.notifications.push(bell.id);
    return { product, request: req, order: vo, bell };
  }

  // The order as the Restock tab shows it, and the tab's POST.
  const shown = async (requestId, status = 'all') => {
    const { requests } = await queue.listRestockRequests({ status, officeDetail: true, showSpend: true, requestId });
    return requests[0] ? requests[0].order : null;
  };
  const record = (requestId, order) => revoke.recordVendorCancellation(requestId, { orderId: order.id, version: order.version, actorId: ACTOR });
  const reject = (promise) => promise.then(() => { throw new Error('expected a refusal'); }, (e) => e);
  const audits = (orderId) => db('audit_log').where({ resource_type: 'vendor_order', resource_id: orderId });

  // A refusal changed nothing: the ledger row, the request, the bell, no audit row,
  // and the order still blocks a duplicate.
  async function expectUntouched({ product, request, order, bell }) {
    const vo = await db('vendor_orders').where({ id: order.id }).first();
    expect(vo).toMatchObject({ status: order.status, error: order.error });
    expect(vo.evidence).toEqual(order.evidence);
    expect(new Date(vo.updated_at).toISOString()).toBe(new Date(order.updated_at).toISOString());
    expect(await db('product_restock_requests').where({ id: request.id }).first('status')).toEqual({ status: request.status });
    expect(await db('notifications').where({ id: bell.id }).first('read_at', 'done_at')).toEqual({ read_at: null, done_at: null });
    expect(await audits(order.id)).toHaveLength(0);
    expect(await dispatch.findLiveAutoOrder(db, product.id)).toBeTruthy();
  }

  beforeAll(async () => {
    db = require('../models/db');
    revoke = require('../services/procurement/order-revoke');
    queue = require('../services/inventory-restock-queue');
    dispatch = require('../services/procurement/order-dispatch');
    policySvc = require('../services/procurement/history-order-policy');
  });
  afterAll(async () => {
    if (made.settingKeys.length) {
      await db('audit_log').where({ resource_type: 'system_settings', action: 'procurement.history_order_policy.updated' }).whereRaw("metadata->>'key' = ANY(?)", [made.settingKeys]).del();
      await db('system_settings').whereIn('key', made.settingKeys).del();
    }
    if (made.vendor_orders.length) await db('audit_log').where({ resource_type: 'vendor_order' }).whereIn('resource_id', made.vendor_orders).del();
    if (made.notifications.length) await db('notifications').whereIn('id', made.notifications).del();
    if (made.product_restock_requests.length) {
      await db('vendor_orders').whereIn('restock_request_id', made.product_restock_requests).del();
      await db('product_restock_requests').whereIn('id', made.product_restock_requests).del();
    }
    if (made.vendor_pricing.length) await db('vendor_pricing').whereIn('id', made.vendor_pricing).del();
    if (made.products_catalog.length) await db('products_catalog').whereIn('id', made.products_catalog).del();
    await db.destroy();
  }, 120000);

  test('records the cancellation of the order the tab showed, and the product can be ordered again', async () => {
    const f = await fixture();
    const order = await shown(f.request.id);
    expect(order).toMatchObject({ id: f.order.id, status: 'placed', revokedAt: null });
    expect(await dispatch.findLiveAutoOrder(db, f.product.id)).toBeTruthy();

    expect(await record(f.request.id, order)).toEqual({ requestStatus: 'cancelled' });

    const vo = await db('vendor_orders').where({ id: f.order.id }).first();
    expect(vo.status).toBe('needs_review');
    expect(vo.error).toMatch(/^revoked: operator revoke .* \(was placed\)$/);
    expect(vo.evidence.revokedAt).toEqual(expect.any(String));
    expect(vo.evidence).not.toHaveProperty('bell');
    expect(vo.evidence).not.toHaveProperty('bellAt');
    const req = await db('product_restock_requests').where({ id: f.request.id }).first();
    expect(req.status).toBe('cancelled');
    expect(req.closed_at).not.toBeNull();
    expect(req.metadata).toMatchObject({ autoOrderCancelled: 'revoked_vendor_order', revokedVendorOrderId: f.order.id });
    // The bell closes done (a system retire never only marks it read).
    const bell = await db('notifications').where({ id: f.bell.id }).first();
    expect(bell).toMatchObject({ done_by: 'procurement', resolution: 'The vendor cancellation of this order was recorded' });
    expect(bell.done_at).not.toBeNull();
    expect(bell.read_at).not.toBeNull();
    const rows = await audits(f.order.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'procurement.vendor_order.revoked', actor_type: 'technician', actor_id: ACTOR });
    // The revoked order no longer blocks a replacement, and the tab shows it revoked.
    expect(await dispatch.findLiveAutoOrder(db, f.product.id)).toBeUndefined();
    expect((await shown(f.request.id)).revokedAt).toBe(vo.evidence.revokedAt);
  });

  test('a second record is refused and writes no second audit row', async () => {
    const f = await fixture();
    const order = await shown(f.request.id);
    await record(f.request.id, order);
    // A double click sends the version the tab loaded; a reload sends the new one.
    expect(await reject(record(f.request.id, order))).toMatchObject({ statusCode: 409, code: 'order_changed' });
    const again = await reject(record(f.request.id, await shown(f.request.id)));
    expect(again).toMatchObject({ statusCode: 409, code: 'already_revoked', message: 'This order\'s vendor cancellation is already recorded. Reload the Restock tab.' });
    expect(await audits(f.order.id)).toHaveLength(1);
  });

  test('an order that changed after the tab loaded is refused and nothing is written', async () => {
    const f = await fixture();
    const order = await shown(f.request.id);
    // Any write since the tab loaded (here a re-rung bell) moves the version.
    const [changed] = await db('vendor_orders').where({ id: f.order.id }).update({ updated_at: new Date(Date.now() + 5000) }).returning('*');
    const err = await reject(record(f.request.id, order));
    expect(err).toMatchObject({ statusCode: 409, code: 'order_changed', message: 'This order changed after the Restock tab loaded. Reload it and check the order again.' });
    await expectUntouched({ ...f, order: changed });
  });

  test('an order that belongs to another request is refused and nothing is written', async () => {
    const a = await fixture();
    const b = await fixture();
    const err = await reject(record(a.request.id, await shown(b.request.id)));
    expect(err).toMatchObject({ statusCode: 409, code: 'order_changed' });
    await expectUntouched(a);
    await expectUntouched(b);
  });

  test('an order still being placed is refused: the vendor call may be in flight', async () => {
    const f = await fixture({ order: { status: 'placing', placed_at: null, external_order_number: null, amount_cents: null } });
    const err = await reject(record(f.request.id, await shown(f.request.id)));
    expect(err).toMatchObject({ statusCode: 409, code: 'placing', message: 'This order is still being placed. Wait until the Restock tab shows it placed or needing review, then try again.' });
    await expectUntouched(f);
  });

  test('stock already received for the request is refused: no order is out', async () => {
    const f = await fixture({ request: { status: 'received', closed_at: new Date() } });
    const err = await reject(record(f.request.id, await shown(f.request.id)));
    expect(err).toMatchObject({ statusCode: 409, code: 'request_not_in_flight', message: 'The stock for this request was already received, so there is no order out to cancel. Reload the Restock tab.' });
    const vo = await db('vendor_orders').where({ id: f.order.id }).first();
    expect(vo.status).toBe('placed');
    expect(vo.evidence).not.toHaveProperty('revokedAt');
    expect(await audits(f.order.id)).toHaveLength(0);
  });

  test('a late order that landed after a hand receive is revoked and its request stays received', async () => {
    const f = await fixture({
      request: { status: 'received', closed_at: new Date() },
      order: { status: 'needs_review', error: 'placed_on_received_request: fixture' },
      evidence: { landedAfterReceive: new Date().toISOString() },
    });
    const order = await shown(f.request.id, 'active');
    expect(order).toMatchObject({ id: f.order.id, landedAfterReceive: true });

    expect(await record(f.request.id, order)).toEqual({ requestStatus: 'received' });

    const vo = await db('vendor_orders').where({ id: f.order.id }).first();
    expect(vo.evidence.revokedAt).toEqual(expect.any(String));
    expect(vo.evidence).not.toHaveProperty('landedAfterReceive');
    expect(vo.error).toMatch(/\(was needs_review\)$/);
    expect((await db('product_restock_requests').where({ id: f.request.id }).first('status')).status).toBe('received');
    // The row leaves the active queue, and the order no longer blocks one.
    expect(await shown(f.request.id, 'active')).toBeNull();
    expect(await dispatch.findLiveAutoOrder(db, f.product.id)).toBeUndefined();
  });

  test('a call without the order id or version is a 400', async () => {
    const f = await fixture();
    const order = await shown(f.request.id);
    for (const body of [{ version: order.version }, { orderId: order.id }, { orderId: 'not-a-uuid', version: order.version }]) {
      const err = await reject(revoke.recordVendorCancellation(f.request.id, body));
      expect(err).toMatchObject({ statusCode: 400, code: 'bad_request' });
    }
    await expectUntouched(f);
  });

  // The dispatcher itself, with a scripted vendor: an order that may exist on a request that
  // changed while the vendor call ran. Each run dispatches ONE fixture request by its id.
  describe('a post-submit park on a request that changed during the vendor call', () => {
    const GATES = { GATE_AUTO_ORDER: 'true', GATE_AUTO_ORDER_STICKERMULE: 'true' };
    let gatesBefore;
    beforeAll(() => { gatesBefore = Object.fromEntries(Object.keys(GATES).map((k) => [k, process.env[k]])); Object.assign(process.env, GATES); });
    afterAll(() => { for (const [k, v] of Object.entries(gatesBefore)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

    // An open automatic reorder of 500 of one vendor item (the vendor row is the migration's, code 25).
    async function autoRequest() {
      const vendor = await db('vendors').where({ code: 25 }).first();
      const id = crypto.randomUUID();
      const sku = `item-${id.slice(0, 8)}`;
      const [product] = await db('products_catalog').insert({
        id, name: `Fixture sticker ${id.slice(0, 8)}`, category: 'supplies', inventory_unit: 'each', inventory_on_hand: 40, low_stock_threshold: 100,
        auto_reorder_enabled: true, auto_reorder_vendor_id: vendor.id, reorder_quantity: 500,
      }).returning('*');
      made.products_catalog.push(product.id);
      const [price] = await db('vendor_pricing').insert({ product_id: product.id, vendor_id: vendor.id, price: 314, quantity: '500', unit: 'each', vendor_sku: sku, approval_status: 'approved', is_active: true }).returning('id');
      made.vendor_pricing.push(price.id);
      const [request] = await db('product_restock_requests').insert({
        id: crypto.randomUUID(), product_id: product.id, status: 'open', priority: 'normal', requested_quantity: 500, unit: 'each', source: 'auto_reorder', metadata: JSON.stringify({ vendorId: vendor.id, vendorSku: sku }),
      }).returning('*');
      made.product_restock_requests.push(request.id);
      return { request, ledger: () => db('vendor_orders').where({ restock_request_id: request.id }).first() };
    }
    // A vendor that confirms its total before the order, so the dispatcher calls place(). The call
    // ends with no answer (the order may exist) after the request changed under it.
    const lostCallAfter = (fx, change) => ({
      key: 'stickermule', preSubmitTotal: 'vendor', packagedQuantity: false, configured: () => true,
      bindingQuote: async () => ({ cents: 31400, source: 'order SM-0' }),
      place: jest.fn(async () => {
        await db('product_restock_requests').where({ id: fx.request.id }).update(change);
        throw Object.assign(new Error('timeout after POST'), { ambiguous: true });
      }),
    });
    // The monthly cap is out of reach of every other row in the database; the notifier lands nothing.
    const env = { AUTO_ORDER_MAX_PER_ORDER_CENTS: '50000', AUTO_ORDER_MAX_MONTHLY_CENTS: '2000000000' };
    const dispatchWith = (fx, adapter) => dispatch.dispatchRestockOrder(fx.request.id, { conn: db, notify: jest.fn(async () => null), adapters: { stickermule: adapter }, env });

    test('received during the call: the order stays live and no replacement can be ordered', async () => {
      const fx = await autoRequest();
      const adapter = lostCallAfter(fx, { status: 'received', closed_at: new Date() });
      expect(await dispatchWith(fx, adapter)).toMatchObject({ status: 'needs_review', reason: 'ambiguous_after_submit', bellPending: true });
      expect(adapter.place).toHaveBeenCalledTimes(1);
      const vo = await fx.ledger();
      made.vendor_orders.push(vo.id);
      expect(vo).toMatchObject({ status: 'needs_review', amount_cents: 31400 });
      expect(vo.placed_at).not.toBeNull();
      expect(vo.evidence).toMatchObject({ landedAfterReceive: expect.any(String), bell: { body: expect.stringMatching(/the order MAY exist at Sticker Mule.*Do NOT re-order/) } });
      expect(await db('product_restock_requests').where({ id: fx.request.id }).first('status')).toEqual({ status: 'received' });
      // The received request does not settle this row: the product stays blocked.
      expect(await dispatch.findLiveAutoOrder(db, fx.request.product_id)).toBeTruthy();
      expect(await dispatch.landedAfterReceiveFor(db, fx.request.id)).toBe(true);
    });

    test('cancelled during the call: the request goes back to ordered', async () => {
      const fx = await autoRequest();
      const adapter = lostCallAfter(fx, { status: 'cancelled', closed_at: new Date() });
      expect(await dispatchWith(fx, adapter)).toMatchObject({ status: 'needs_review', reason: 'ambiguous_after_submit' });
      const vo = await fx.ledger();
      made.vendor_orders.push(vo.id);
      expect(vo.evidence).toMatchObject({ reopenedFromCancelledAt: expect.any(String) });
      expect(vo.evidence).not.toHaveProperty('landedAfterReceive');
      expect(await db('product_restock_requests').where({ id: fx.request.id }).first('status', 'closed_at')).toEqual({ status: 'ordered', closed_at: null });
      expect(await dispatch.findLiveAutoOrder(db, fx.request.product_id)).toBeTruthy();
    });

    test('still open after the call: the request is left as it is', async () => {
      const fx = await autoRequest();
      const adapter = lostCallAfter(fx, { updated_at: new Date() });
      expect(await dispatchWith(fx, adapter)).toMatchObject({ status: 'needs_review', reason: 'ambiguous_after_submit' });
      const vo = await fx.ledger();
      made.vendor_orders.push(vo.id);
      expect(vo.evidence).not.toHaveProperty('landedAfterReceive');
      expect(vo.evidence).not.toHaveProperty('reopenedFromCancelledAt');
      expect(await db('product_restock_requests').where({ id: fx.request.id }).first('status')).toEqual({ status: 'open' });
      expect(await dispatch.findLiveAutoOrder(db, fx.request.product_id)).toBeTruthy();
    });
  });

  // Live Postgres coverage of history-order cap hold settlement, 35-day expiry, and DB-backed Sticker Mule dispatch.
  describe('history-order cap hold settlement and DB policy dispatch (live Postgres)', () => {
    const GATES = { GATE_AUTO_ORDER: 'true', GATE_AUTO_ORDER_STICKERMULE: 'true' };
    let gatesBefore;
    beforeAll(() => {
      gatesBefore = Object.fromEntries(Object.keys(GATES).map((k) => [k, process.env[k]]));
      Object.assign(process.env, GATES);
    });
    afterAll(() => {
      for (const [k, v] of Object.entries(gatesBefore)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    const row = (fx) => db('vendor_orders').where({ id: fx.order.id }).first();
    const received = { status: 'received', closed_at: new Date() };
    const noBell = { bell: undefined, bellAt: undefined };
    const checkBell = { title: 'Auto-order needs review: Fixture (Sticker Mule)', body: 'Sticker Mule order was placed with no paid total yet. Do NOT re-order.', v: 'v0' };
    const heldOrder = (extra = {}) => ({
      adapter: 'stickermule',
      status: 'needs_review',
      external_order_number: `SM-H-${crypto.randomUUID().slice(0, 8)}`,
      amount_cents: 50000,
      error: 'history_total_check: total could not be read back',
      ...extra,
    });
    // Scope table scans to only rows created by this test file so concurrent DB rows never interfere.
    const ownOrders = () => new Proxy(db, {
      apply(target, thisArg, args) {
        const q = target.apply(thisArg, args);
        if (args[0] === 'vendor_orders as vo') return q.whereIn('vo.id', made.vendor_orders);
        return q;
      },
    });
    const ringOnly = (...only) => jest.fn(async (_cat, _h, _w, opts) => (only.some((f) => f.order.id === opts?.metadata?.vendorOrderId) ? { id: 'n-ok' } : null));
    const rering = (notify) => dispatch.reringPendingBells({ conn: ownOrders(), notify });
    const scan = (readCharge, now) => dispatch.settleHistoryHolds({ conn: ownOrders(), registry: { stickermule: { readCharge } }, now });
    const settle = (charges, now) => scan(async (n) => (Object.prototype.hasOwnProperty.call(charges, n) ? charges[n] : null), now);

    async function autoRequest() {
      const vendor = await db('vendors').where({ code: 25 }).first();
      const id = crypto.randomUUID();
      const sku = `item-${id.slice(0, 8)}`;
      const [product] = await db('products_catalog').insert({
        id, name: `Fixture sticker ${id.slice(0, 8)}`, category: 'supplies', inventory_unit: 'each', inventory_on_hand: 40, low_stock_threshold: 100,
        auto_reorder_enabled: true, auto_reorder_vendor_id: vendor.id, reorder_quantity: 500,
      }).returning('*');
      made.products_catalog.push(product.id);
      const [price] = await db('vendor_pricing').insert({ product_id: product.id, vendor_id: vendor.id, price: 314, quantity: '500', unit: 'each', vendor_sku: sku, approval_status: 'approved', is_active: true }).returning('id');
      made.vendor_pricing.push(price.id);
      const [request] = await db('product_restock_requests').insert({
        id: crypto.randomUUID(), product_id: product.id, status: 'open', priority: 'normal', requested_quantity: 500, unit: 'each', source: 'auto_reorder', metadata: JSON.stringify({ vendorId: vendor.id, vendorSku: sku }),
      }).returning('*');
      made.product_restock_requests.push(request.id);
      return { sku, product, vendor, request, ledger: () => db('vendor_orders').where({ restock_request_id: request.id }).first() };
    }

    function newPolicyKey() {
      const key = `test.hist_policy.${crypto.randomUUID().slice(0, 12)}`;
      made.settingKeys.push(key);
      return key;
    }

    async function savePolicy(key, { enabled = true, approvedItems = [], maxPerOrderCents = 50000, maxMonthlyCents = 10000000, expectedRevision = 0 } = {}) {
      return policySvc.saveHistoryOrderPolicy(
        db,
        { enabled, approvedItems, maxPerOrderCents, maxMonthlyCents },
        { actorId: ACTOR, expectedRevision, key }
      );
    }

    const adapterCharging = (cents, seen = {}) => ({
      key: 'stickermule',
      preSubmitTotal: 'history',
      packagedQuantity: false,
      configured: () => true,
      bindingQuote: async () => ({ cents: 31400, source: 'order SM-0' }),
      place: jest.fn(async ({ beforeSubmit }) => {
        seen.heldAtPost = (await seen.ledger()).amount_cents;
        seen.lastCheck = await beforeSubmit();
        if (!seen.lastCheck.ok) {
          const err = new Error(seen.lastCheck.message);
          err.refuse = seen.lastCheck.reason;
          if (seen.lastCheck.evidence) err.evidence = seen.lastCheck.evidence;
          throw err;
        }
        return { externalOrderNumber: `SM-P-${crypto.randomUUID().slice(0, 8)}`, amountCents: null, response: {}, evidence: { totalSource: 'none' } };
      }),
      readCharge: jest.fn(async () => { seen.atChargeRead = await seen.ledger(); return cents; }),
    });

    test('settleHistoryHolds replaces holds, preserves overHoldAt past receipt, and expires unconfirmed holds after 35 ET days', async () => {
      const a = await fixture({ order: heldOrder(), evidence: { totalSource: 'none', bell: checkBell } });
      const b = await fixture({ request: received, order: heldOrder(), evidence: { totalSource: 'none', ...noBell } });
      const placedLongAgo = new Date(Date.now() - 36 * 24 * 60 * 60 * 1000);
      const c = await fixture({ request: received, order: heldOrder({ placed_at: placedLongAgo }), evidence: { totalSource: 'none', ...noBell } });
      const revoked = await fixture({ order: heldOrder({ placed_at: placedLongAgo }), evidence: { totalSource: 'none', revokedAt: new Date().toISOString() } });

      const written = await settle({
        [a.order.external_order_number]: 31400,
        [b.order.external_order_number]: 62000,
      });
      expect(written).toEqual(expect.arrayContaining([a.order.id, b.order.id, c.order.id]));
      expect(written).not.toContain(revoked.order.id);

      const ra = await row(a);
      expect(ra).toMatchObject({ amount_cents: 31400, status: 'needs_review' });
      expect(ra.evidence).toMatchObject({ totalSource: 'vendor', holdSettledAt: expect.any(String) });
      expect(ra.evidence).not.toHaveProperty('overHoldAt');

      const rb = await row(b);
      expect(rb.amount_cents).toBe(62000);
      expect(rb.evidence).toMatchObject({ totalSource: 'vendor', overHoldAt: expect.any(String) });
      expect(rb.evidence).not.toHaveProperty('bellAt');
      expect((await rering(ringOnly(b))).rung).toContain(b.order.id);

      const rc = await row(c);
      expect(rc.amount_cents).toBe(50000);
      expect(rc.evidence).toMatchObject({ totalSource: 'none', holdExpiredAt: expect.any(String) });
      expect((await audits(c.order.id)).map((x) => x.action)).toContain('procurement.vendor_order.charge_unconfirmed');
      // Receipt cleanup does not close an expired hold alert; re-ring delivers it on a received request.
      await db.transaction((trx) => dispatch.settleRequestLedgerBells(trx, c.request.id));
      expect((await rering(ringOnly(c))).rung).toContain(c.order.id);
    });

    test('DB-backed policy places silently at confirmed charge while holding DB per-order cap (ignoring empty Railway cap env)', async () => {
      const key = newPolicyKey();
      const fx = await autoRequest();
      await savePolicy(key, { enabled: true, approvedItems: [`stickermule:${fx.sku}`], maxPerOrderCents: 50000, maxMonthlyCents: 10000000 });
      const seen = { ledger: fx.ledger };
      const adapter = adapterCharging(31400, seen);
      const notify = ringOnly();
      const res = await dispatch.dispatchRestockOrder(fx.request.id, { conn: db, notify, adapters: { stickermule: adapter }, env: { AUTO_ORDER_HISTORY_POLICY_KEY: key } });
      expect(res).toMatchObject({ status: 'placed', amountCents: 31400 });
      const vo = await fx.ledger();
      made.vendor_orders.push(vo.id);
      expect(seen.heldAtPost).toBe(50000);
      expect(seen.atChargeRead).toMatchObject({ status: 'placing', external_order_number: vo.external_order_number, amount_cents: 50000, placed_at: null });
      expect(vo).toMatchObject({ status: 'placed', amount_cents: 31400 });
      expect(vo.evidence).toMatchObject({ historyCents: 31400, holdCents: 50000, totalSource: 'vendor' });
      expect(notify).not.toHaveBeenCalled();
    });

    test('charge above DB cap hold at placement stamps overHoldAt and receipt rewrites alert wording to charge-review only', async () => {
      const key = newPolicyKey();
      const fx = await autoRequest();
      await savePolicy(key, { enabled: true, approvedItems: [`stickermule:${fx.sku}`], maxPerOrderCents: 50000, maxMonthlyCents: 10000000 });
      const seen = { ledger: fx.ledger };
      const adapter = adapterCharging(62000, seen);
      const res = await dispatch.dispatchRestockOrder(fx.request.id, { conn: db, notify: ringOnly(), adapters: { stickermule: adapter }, env: { AUTO_ORDER_HISTORY_POLICY_KEY: key } });
      expect(res).toMatchObject({ status: 'needs_review', reason: 'over_cap_after_placement', amountCents: 62000, bellPending: true });
      let vo = await fx.ledger();
      made.vendor_orders.push(vo.id);
      expect(vo.evidence).toMatchObject({ overHoldAt: expect.any(String), historyCents: 31400, totalSource: 'vendor' });

      await db('product_restock_requests').where({ id: fx.request.id }).update({ status: 'received', closed_at: new Date() });
      await db.transaction((trx) => dispatch.settleRequestLedgerBells(trx, fx.request.id));
      const kept = await fx.ledger();
      expect(kept.evidence.bell.v).not.toBe(vo.evidence.bell.v);
      expect(kept.evidence.bell.body).toMatch(/Do NOT re-order: the stock was received, so only the charge is left: check it on the Sticker Mule account \(order SM-P-.*\), then mark this alert done\./);
      expect(kept.evidence.bell.body).not.toMatch(/receive the stock|Record vendor cancellation/);
      const f = { order: { id: vo.id } };
      expect((await rering(ringOnly(f))).rung).toContain(vo.id);
      vo = await row(f);
      expect(vo.evidence.bellAt).toEqual(expect.any(String));
    });

    test('turning the DB switch OFF or changing spend limits mid-flight stops placement before POST', async () => {
      // 1) Owner flips DB switch OFF between bindingQuote and POST -> approval_withdrawn.
      const keyOff = newPolicyKey();
      const fxOff = await autoRequest();
      await savePolicy(keyOff, { enabled: true, approvedItems: [`stickermule:${fxOff.sku}`], maxPerOrderCents: 50000, maxMonthlyCents: 10000000 });
      const adapterOff = {
        ...adapterCharging(31400, { ledger: fxOff.ledger }),
        place: jest.fn(async ({ beforeSubmit }) => {
          await savePolicy(keyOff, { enabled: false, approvedItems: [], maxPerOrderCents: null, maxMonthlyCents: null, expectedRevision: 1 });
          const verdict = await beforeSubmit();
          const err = new Error(verdict.message); err.refuse = verdict.reason; throw err;
        }),
      };
      const rOff = await dispatch.dispatchRestockOrder(fxOff.request.id, { conn: db, notify: ringOnly(), adapters: { stickermule: adapterOff }, env: { AUTO_ORDER_HISTORY_POLICY_KEY: keyOff } });
      expect(rOff).toMatchObject({ status: 'needs_review', reason: 'approval_withdrawn' });
      const voOff = await fxOff.ledger();
      made.vendor_orders.push(voOff.id);
      expect(voOff).toMatchObject({ status: 'needs_review', amount_cents: 31400, placed_at: null, external_order_number: null });

      // 2) Owner changes spend limits while still above quote -> claim released (approval_changed), request stays open.
      const keyCaps = newPolicyKey();
      const fxCaps = await autoRequest();
      await savePolicy(keyCaps, { enabled: true, approvedItems: [`stickermule:${fxCaps.sku}`], maxPerOrderCents: 50000, maxMonthlyCents: 10000000 });
      const adapterCaps = {
        ...adapterCharging(31400, { ledger: fxCaps.ledger }),
        place: jest.fn(async ({ beforeSubmit }) => {
          await savePolicy(keyCaps, { enabled: true, approvedItems: [`stickermule:${fxCaps.sku}`], maxPerOrderCents: 40000, maxMonthlyCents: 10000000, expectedRevision: 1 });
          const verdict = await beforeSubmit();
          const err = new Error(verdict.message); err.refuse = verdict.reason; throw err;
        }),
      };
      const rCaps = await dispatch.dispatchRestockOrder(fxCaps.request.id, { conn: db, notify: ringOnly(), adapters: { stickermule: adapterCaps }, env: { AUTO_ORDER_HISTORY_POLICY_KEY: keyCaps } });
      expect(rCaps).toEqual({ requestId: fxCaps.request.id, skipped: 'approval_changed' });
      expect(await fxCaps.ledger()).toBeUndefined();
      expect(await db('product_restock_requests').where({ id: fxCaps.request.id }).first('status')).toEqual({ status: 'open' });
    });

    test('stopped worker during readCharge: stale recovery preserves order number and settleTakenClaim applies late charge', async () => {
      const key = newPolicyKey();
      const fx = await autoRequest();
      await savePolicy(key, { enabled: true, approvedItems: [`stickermule:${fx.sku}`], maxPerOrderCents: 50000, maxMonthlyCents: 10000000 });
      let reached;
      let resumeCharge;
      const atRead = new Promise((resolve) => { reached = resolve; });
      const adapter = {
        ...adapterCharging(null, { ledger: fx.ledger }),
        readCharge: jest.fn((number) => new Promise((resolve) => { resumeCharge = resolve; reached(number); })),
      };
      const pendingRun = dispatch.dispatchRestockOrder(fx.request.id, { conn: db, notify: ringOnly(), adapters: { stickermule: adapter }, env: { AUTO_ORDER_HISTORY_POLICY_KEY: key } });
      const number = await atRead;
      let vo = await fx.ledger();
      made.vendor_orders.push(vo.id);
      expect(vo).toMatchObject({ status: 'placing', external_order_number: number, amount_cents: 50000, placed_at: null });

      const recovered = await dispatch.recoverStalePlacing({ conn: ownOrders(), notify: ringOnly(), now: new Date(Date.now() + 31 * 60 * 1000) });
      expect(recovered.recovered).toContain(vo.id);
      vo = await fx.ledger();
      expect(vo).toMatchObject({ status: 'needs_review', external_order_number: number, amount_cents: 50000 });
      expect(vo.placed_at).not.toBeNull();
      expect(await db('product_restock_requests').where({ id: fx.request.id }).first('status')).toEqual({ status: 'ordered' });

      resumeCharge(62000);
      expect(await pendingRun).toMatchObject({ status: 'needs_review', reason: 'placed_after_stale_park', externalOrderNumber: number, amountCents: 62000, bellPending: true });
      vo = await fx.ledger();
      expect(vo).toMatchObject({ status: 'needs_review', amount_cents: 62000 });
      expect(vo.evidence).toMatchObject({ totalSource: 'vendor', holdSettledAt: expect.any(String), overHoldAt: expect.any(String) });
    });

    test('deliveryEvidence excludes manually received parked requests, revoked orders, and landedAfterReceive orders', async () => {
      const fx = await autoRequest();
      const productId = fx.request.product_id;
      const vendorId = fx.vendor.id;
      const mkHist = async (orderPatch) => {
        const [r] = await db('product_restock_requests').insert({ id: crypto.randomUUID(), product_id: productId, status: 'received', priority: 'normal', source: 'auto_reorder', requested_quantity: 500, unit: 'each', closed_at: new Date(), metadata: JSON.stringify({ vendorId }) }).returning('*');
        made.product_restock_requests.push(r.id);
        const [v] = await db('vendor_orders').insert({ restock_request_id: r.id, vendor_id: vendorId, adapter: 'stickermule', ...orderPatch }).returning('*');
        made.vendor_orders.push(v.id);
      };
      await mkHist({ status: 'needs_review', placed_at: null, external_order_number: null, evidence: JSON.stringify({ outstandingOrder: { number: 'SM-PARK-99', why: 'coming' } }) });
      await mkHist({ status: 'placed', placed_at: new Date(), external_order_number: 'SM-PORTAL-1', amount_cents: 31400, evidence: JSON.stringify({ totalSource: 'vendor' }) });
      await mkHist({ status: 'needs_review', placed_at: new Date(), external_order_number: 'SM-REVOKED-3', amount_cents: 31400, evidence: JSON.stringify({ totalSource: 'vendor', revokedAt: new Date().toISOString() }) });
      await mkHist({ status: 'needs_review', placed_at: new Date(), external_order_number: 'SM-LATE-2', amount_cents: 31400, evidence: JSON.stringify({ totalSource: 'vendor', landedAfterReceive: new Date().toISOString() }) });

      const direct = await dispatch._internals.deliveryEvidence(db, { productId, vendorId });
      expect(direct.receivedOrders).toContain('SM-PORTAL-1');
      expect(direct.receivedOrders).not.toContain('SM-PARK-99');
      expect(direct.receivedOrders).not.toContain('SM-REVOKED-3');
      expect(direct.receivedOrders).not.toContain('SM-LATE-2');
    });

    test('disabling policy while an already-authorized order is mid-POST reports inFlightOrders atomically inside CAPS_LOCK_KEY', async () => {
      const key = newPolicyKey();
      const fx = await autoRequest();
      await savePolicy(key, { enabled: true, approvedItems: [`stickermule:${fx.sku}`], maxPerOrderCents: 50000, maxMonthlyCents: 10000000 });
      let atPost;
      let finishPost;
      const reachedPost = new Promise((r) => { atPost = r; });
      const adapter = {
        key: 'stickermule',
        preSubmitTotal: 'history',
        packagedQuantity: false,
        configured: () => true,
        bindingQuote: async () => ({ cents: 31400, source: 'order SM-0' }),
        place: jest.fn(async ({ beforeSubmit }) => {
          const v = await beforeSubmit();
          expect(v).toEqual({ ok: true });
          atPost();
          await new Promise((r) => { finishPost = r; });
          return { externalOrderNumber: `SM-IF-${crypto.randomUUID().slice(0, 6)}`, amountCents: null, response: {}, evidence: { totalSource: 'none' } };
        }),
        readCharge: jest.fn(async () => 31400),
      };
      const pending = dispatch.dispatchRestockOrder(fx.request.id, { conn: db, notify: ringOnly(), adapters: { stickermule: adapter }, env: { AUTO_ORDER_HISTORY_POLICY_KEY: key } });
      await reachedPost;
      const voMid = await fx.ledger();
      made.vendor_orders.push(voMid.id);
      expect(voMid.evidence.postAuthorizedAt).toEqual(expect.any(String));
      // Owner disables the switch right after beforeSubmit committed: save succeeds immediately AND reports the in-flight order.
      const disabled = await savePolicy(key, { enabled: false, approvedItems: [], maxPerOrderCents: null, maxMonthlyCents: null, expectedRevision: 1 });
      expect(disabled.policy.enabled).toBe(false);
      expect(disabled.inFlightOrders).toEqual(expect.arrayContaining([
        expect.objectContaining({ ledgerId: voMid.id, requestId: fx.request.id, vendorSku: fx.sku }),
      ]));
      finishPost();
      expect(await pending).toMatchObject({ status: 'placed', amountCents: 31400 });
    });

    test('two active catalog products mapped to the same Sticker Mule SKU are rejected on enable and serialized at submission', async () => {
      const key = newPolicyKey();
      const a = await autoRequest();
      // Create a second active auto-reorder product mapped to the exact same Sticker Mule SKU.
      const bId = crypto.randomUUID();
      const [prodB] = await db('products_catalog').insert({
        id: bId, name: `Fixture sticker B ${bId.slice(0, 8)}`, category: 'supplies', inventory_unit: 'each', inventory_on_hand: 10, low_stock_threshold: 100,
        auto_reorder_enabled: true, auto_reorder_vendor_id: a.vendor.id, reorder_quantity: 500,
      }).returning('*');
      made.products_catalog.push(prodB.id);
      const [priceB] = await db('vendor_pricing').insert({ product_id: prodB.id, vendor_id: a.vendor.id, price: 314, quantity: '500', unit: 'each', vendor_sku: a.sku, approval_status: 'approved', is_active: true }).returning('id');
      made.vendor_pricing.push(priceB.id);

      // 1) Policy save rejects enabling a SKU shared across multiple active auto-reorder products.
      await expect(savePolicy(key, { enabled: true, approvedItems: [`stickermule:${a.sku}`], maxPerOrderCents: 50000, maxMonthlyCents: 10000000 }))
        .rejects.toMatchObject({ statusCode: 400, code: 'duplicate_sku_mapping', duplicateItems: [`stickermule:${a.sku}`] });

      // 2) Even if product B is enabled LATER (after policy was saved) with NO live order yet,
      // authorizeHistoryOrder withholds purchase unsent via duplicate_sku_mapping and raises a fix-mapping alert.
      await db('products_catalog').where({ id: prodB.id }).update({ auto_reorder_enabled: false });
      await savePolicy(key, { enabled: true, approvedItems: [`stickermule:${a.sku}`], maxPerOrderCents: 50000, maxMonthlyCents: 10000000 });
      await db('products_catalog').where({ id: prodB.id }).update({ auto_reorder_enabled: true });
      const [reqBDup] = await db('product_restock_requests').insert({
        id: crypto.randomUUID(), product_id: prodB.id, status: 'open', priority: 'normal', requested_quantity: 500, unit: 'each', source: 'auto_reorder', metadata: JSON.stringify({ vendorId: a.vendor.id, vendorSku: a.sku }),
      }).returning('*');
      made.product_restock_requests.push(reqBDup.id);
      const dupNotices = [];
      const captureNotify = async (cat, title, message, opts) => { dupNotices.push({ title, message, opts }); return { id: 'n-cap' }; };
      const resDup = await dispatch.dispatchRestockOrder(reqBDup.id, { conn: db, notify: captureNotify, adapters: { stickermule: adapterCharging(31400, { ledger: () => db('vendor_orders').where({ restock_request_id: reqBDup.id }).first() }) }, env: { AUTO_ORDER_HISTORY_POLICY_KEY: key } });
      expect(resDup).toMatchObject({ status: 'needs_review', reason: 'duplicate_sku_mapping' });
      const voDup = await db('vendor_orders').where({ restock_request_id: reqBDup.id }).first();
      made.vendor_orders.push(voDup.id);
      expect(voDup.placed_at).toBeNull();
      expect(dupNotices).toHaveLength(1);
      expect(dupNotices[0].title).toMatch(/fix duplicate/i);
      expect(dupNotices[0].title).not.toMatch(/order .* by hand/i);
      expect(dupNotices[0].message).toMatch(/fix the mapping before buying/i);

      // 3) Product A places while Product B is disabled, then Product B is re-enabled with a fresh request:
      // authorizeHistoryOrder blocks Product B unsent via vendor_sku_order_live with a wait-for-reconciliation headline.
      await db('products_catalog').where({ id: prodB.id }).update({ auto_reorder_enabled: false });
      const resA = await dispatch.dispatchRestockOrder(a.request.id, { conn: db, notify: ringOnly(), adapters: { stickermule: adapterCharging(31400, { ledger: a.ledger }) }, env: { AUTO_ORDER_HISTORY_POLICY_KEY: key } });
      expect(resA).toMatchObject({ status: 'placed' });
      const voA = await a.ledger();
      made.vendor_orders.push(voA.id);

      await db('product_restock_requests').where({ id: reqBDup.id }).update({ status: 'cancelled', closed_at: new Date() });
      await db('products_catalog').where({ id: prodB.id }).update({ auto_reorder_enabled: true });
      const [reqB] = await db('product_restock_requests').insert({
        id: crypto.randomUUID(), product_id: prodB.id, status: 'open', priority: 'normal', requested_quantity: 500, unit: 'each', source: 'auto_reorder', metadata: JSON.stringify({ vendorId: a.vendor.id, vendorSku: a.sku }),
      }).returning('*');
      made.product_restock_requests.push(reqB.id);
      const liveNotices = [];
      const captureLive = async (cat, title, message, opts) => { liveNotices.push({ title, message, opts }); return { id: 'n-live' }; };
      const adapterB = adapterCharging(31400, { ledger: () => db('vendor_orders').where({ restock_request_id: reqB.id }).first() });
      const resB = await dispatch.dispatchRestockOrder(reqB.id, { conn: db, notify: captureLive, adapters: { stickermule: adapterB }, env: { AUTO_ORDER_HISTORY_POLICY_KEY: key } });
      expect(resB).toMatchObject({ status: 'needs_review', reason: 'vendor_sku_order_live' });
      const voB = await db('vendor_orders').where({ restock_request_id: reqB.id }).first();
      made.vendor_orders.push(voB.id);
      expect(voB.placed_at).toBeNull();
      expect(voB.evidence).toMatchObject({
        outstandingOrder: { number: voA.external_order_number, why: 'coming' },
        competingOrder: { ledgerId: voA.id, requestId: a.request.id },
      });
      // vendor_sku_order_live must NEVER tell staff to buy by hand (headline, reason, or detail).
      expect(liveNotices).toHaveLength(1);
      expect(liveNotices[0].title).toMatch(/wait on/i);
      expect(liveNotices[0].title).not.toMatch(/order .* by hand|buy/i);
      expect(liveNotices[0].message).toMatch(/wait for it to settle before buying/i);
      expect(voB.evidence.bell.body).toContain(a.request.id);
      expect(voB.evidence.bell.body).toMatch(/Do NOT order by hand/i);
      expect(voB.evidence.bell.body).not.toMatch(/order what is missing by hand|order manually/i);
    });

    test('immediate drift within hold stamps driftAlertAt and survives receipt; cancelled-mid-flight alert rewrites cleanly on receipt', async () => {
      // 1) Immediate charge $350 vs $314 history within $400 hold -> stamps driftAlertAt on placement; bell delivery fails initially, stock is received, and reringPendingBells still delivers the rewritten charge-review alert.
      const key = newPolicyKey();
      const a = await autoRequest();
      await savePolicy(key, { enabled: true, approvedItems: [`stickermule:${a.sku}`], maxPerOrderCents: 40000, maxMonthlyCents: 10000000 });
      const failNotify = async () => null;
      const res = await dispatch.dispatchRestockOrder(a.request.id, {
        conn: db,
        notify: failNotify,
        adapters: { stickermule: adapterCharging(35000, { ledger: a.ledger }) },
        env: { AUTO_ORDER_HISTORY_POLICY_KEY: key },
      });
      expect(res).toMatchObject({ status: 'needs_review', reason: 'history_total_check', bellPending: true });
      const vo = await a.ledger();
      made.vendor_orders.push(vo.id);
      expect(vo.evidence).toMatchObject({ totalSource: 'vendor', driftAlertAt: expect.any(String) });
      // Receive the request before the failed bell re-rings: driftAlertAt must keep the bell alive and rewrite its body.
      await db.transaction(async (trx) => {
        await trx('product_restock_requests').where({ id: a.request.id }).update({ status: 'received', updated_at: new Date() });
        await dispatch.settleRequestLedgerBells(trx, a.request.id);
      });
      const afterRecv = await a.ledger();
      expect(afterRecv.evidence.bell.body).toMatch(/Do NOT re-order: the stock was received, so only the charge is left/);
      expect(afterRecv.evidence.bell.body).not.toMatch(/receive the stock|Record vendor cancellation/i);
      expect((await rering(ringOnly({ order: vo }))).rung).toContain(vo.id);

      // 2) Cancelled-mid-flight over-hold alert (without "again") that WAS ALREADY DELIVERED:
      // receipt immediately retires the obsolete open notification row AND queues the rewritten charge-review bell.
      const cancelMidFx = await fixture({
        request: received,
        order: heldOrder({ amount_cents: 62000, error: 'history_total_check: fixture' }),
        evidence: {
          totalSource: 'vendor',
          overHoldAt: new Date().toISOString(),
          bellAt: new Date().toISOString(),
          bell: {
            v: 'v-cancel-mid',
            title: 'Auto-order placed on a cancelled request: Fixture',
            body: 'Sticker Mule order SM-CM-1 ($620.00) landed after the restock request was marked cancelled. The request is back to ordered — receive the stock when it arrives, or cancel with the vendor and then use Record vendor cancellation on the Restock tab. Also: Sticker Mule order SM-CM-1 was placed at $620.00; the last identical order was $314.00. That is MORE than was held against the caps.',
          },
        },
      });
      const oldDedupe = `auto-order:${cancelMidFx.order.id}:v-cancel-mid`;
      const [oldNotif] = await db('notifications').insert({
        recipient_type: 'admin',
        category: 'system',
        title: 'Inventory — reconcile order',
        body: 'Stale pre-receipt instruction',
        metadata: JSON.stringify({ dedupeKey: oldDedupe }),
      }).returning('id');
      made.notifications.push(oldNotif.id);
      await db.transaction(async (trx) => dispatch.settleRequestLedgerBells(trx, cancelMidFx.request.id));
      const retiredNotif = await db('notifications').where({ id: oldNotif.id }).first('done_at', 'resolution');
      expect(retiredNotif.done_at).not.toBeNull();
      expect(retiredNotif.resolution).toMatch(/Stock received/i);
      const rcm = await row(cancelMidFx);
      expect(rcm.evidence.bellAt).toBeUndefined();
      expect(rcm.evidence.bell.v).not.toBe('v-cancel-mid');
      expect(rcm.evidence.bell.body).toMatch(/Do NOT re-order: the stock was received, so only the charge is left/);
      expect(rcm.evidence.bell.body).not.toMatch(/receive the stock when it arrives|Record vendor cancellation/i);
    });

    test('late price drift within the cap hold after stock receipt still raises and delivers a charge-review bell; second receipt rewrites late-receive cap alert', async () => {
      // 1) Stock received before charge read-back (placement bell stripped), then read-back returns $420 (within $500 hold, >5% and >$2 above $314 history).
      const driftedFx = await fixture({
        request: received,
        order: heldOrder(),
        evidence: { totalSource: 'none', historyCents: 31400, holdCents: 50000, ...noBell },
      });
      expect(await settle({ [driftedFx.order.external_order_number]: 42000 })).toContain(driftedFx.order.id);
      let rd = await row(driftedFx);
      expect(rd.amount_cents).toBe(42000);
      expect(rd.evidence).toMatchObject({ totalSource: 'vendor', driftAlertAt: expect.any(String), bell: { body: expect.stringMatching(/charged \$420\.00.*last identical order was \$314\.00.*stock was received, so only the charge is left/) } });
      expect((await rering(ringOnly(driftedFx))).rung).toContain(driftedFx.order.id);
      rd = await row(driftedFx);
      expect(rd.evidence.bellAt).toEqual(expect.any(String));

      // 2) Order landed after a receipt (landedAfterReceive + overHoldAt), then second receipt runs settleLandedAfterReceive + settleRequestLedgerBells.
      const lateFx = await fixture({
        request: received,
        order: heldOrder({ amount_cents: 62000, error: 'placed_on_received_request: fixture' }),
        evidence: {
          totalSource: 'vendor',
          overHoldAt: new Date().toISOString(),
          landedAfterReceive: new Date().toISOString(),
          bellAt: undefined,
          bell: {
            v: 'v-late',
            title: 'Auto-order needs review: Fixture (Sticker Mule)',
            body: 'Sticker Mule charged $620.00 for order SM-LATE-CAP, read back after placement: more than the $500.00 held against the caps. Do NOT re-order: the stock counted at the receipt was not this order: receive the request once more when it arrives (the tab allows it for this order), or cancel with the vendor and then use Record vendor cancellation on the Restock tab.',
          },
        },
      });
      await db.transaction(async (trx) => {
        await dispatch.settleLandedAfterReceive(trx, lateFx.request.id);
        await dispatch.settleRequestLedgerBells(trx, lateFx.request.id);
      });
      const rl = await row(lateFx);
      expect(rl.evidence).not.toHaveProperty('landedAfterReceive');
      expect(rl.evidence.bell.v).not.toBe('v-late');
      expect(rl.evidence.bell.body).toMatch(/Do NOT re-order: the stock was received, so only the charge is left: check it on the .+ account \(order SM-H-.*\), then mark this alert done\./);
      expect(rl.evidence.bell.body).not.toMatch(/receive the request once more|Record vendor cancellation/i);
    });
  });
});
