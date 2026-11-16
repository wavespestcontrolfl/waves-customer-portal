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
  const made = { products_catalog: [], product_restock_requests: [], vendor_orders: [], notifications: [] };
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
  });
  afterAll(async () => {
    if (made.vendor_orders.length) await db('audit_log').where({ resource_type: 'vendor_order' }).whereIn('resource_id', made.vendor_orders).del();
    if (made.notifications.length) await db('notifications').whereIn('id', made.notifications).del();
    if (made.product_restock_requests.length) {
      await db('vendor_orders').whereIn('restock_request_id', made.product_restock_requests).del();
      await db('product_restock_requests').whereIn('id', made.product_restock_requests).del();
    }
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
});
