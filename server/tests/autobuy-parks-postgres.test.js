// Automatic ordering: the alert of a request parked before the buy click, Cancel and Mark Ordered on it and
// after an ambiguous submit, and the open-over-7-days alert, against PostgreSQL (CI's DB-gated pass; locally
// set DATABASE_URL to a migrated scratch database). Fixture tables are LIKE copies in a unique schema that is
// dropped after the suite. The real order-dispatch, the real action writer, the real alert writer and the real
// SQL run; only the vendor adapter and the audit log are stand-ins. Fixtures are synthetic; nothing is sent to
// a vendor.
const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');

let mockConn;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockConn(...args);
  proxy.raw = (...args) => mockConn.raw(...args);
  proxy.transaction = (...args) => mockConn.transaction(...args);
  proxy.schema = { hasTable: (...args) => mockConn.schema.hasTable(...args) };
  proxy.fn = { now: () => mockConn.fn.now() };
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/audit-log', () => ({ auditVendorOrder: jest.fn(async () => 'audit-1') }));

const TABLES = ['products_catalog', 'product_restock_requests', 'vendor_orders', 'vendors', 'vendor_pricing', 'notifications', 'scheduled_services', 'customers'];
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date();
const ENV = { GATE_AUTO_ORDER: 'true', GATE_AUTO_ORDER_STICKERMULE: 'true', AUTO_ORDER_MAX_PER_ORDER_CENTS: '50000', AUTO_ORDER_MAX_MONTHLY_CENTS: '100000' };

jest.setTimeout(60000);
(SKIP ? describe.skip : describe)('pre-click parks, Mark Ordered and the open-request alert (PostgreSQL)', () => {
  const schema = `autobuy_parks_${randomUUID().replaceAll('-', '')}`;
  let dispatch;
  let inventory;
  let vendor;
  let seq = 0;

  beforeAll(async () => {
    mockConn = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema, 'public'], pool: { min: 0, max: 6 } });
    await mockConn.raw('CREATE SCHEMA ??', [schema]);
    for (const table of TABLES) await mockConn.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, table, table]);
    for (const [k, v] of Object.entries(ENV)) process.env[k] = v;
    dispatch = require('../services/procurement/order-dispatch');
    inventory = require('../services/inventory-operations');
  });
  beforeEach(async () => {
    [vendor] = await mockConn('vendors').insert({ name: 'Sticker Mule', code: 25, active: true }).returning('*');
  });
  afterEach(async () => {
    for (const table of TABLES) await mockConn.raw('TRUNCATE TABLE ??.??', [schema, table]);
  });
  afterAll(async () => {
    for (const k of Object.keys(ENV)) delete process.env[k];
    await mockConn.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await mockConn.destroy();
  });

  // An open automatic request for a low product, priced at the vendor; `ledger` parks it.
  async function fixture({ ledger = null, requestOver = {} } = {}) {
    seq += 1;
    const [product] = await mockConn('products_catalog').insert({
      name: `Synthetic Sticker ${seq}`, active: true, auto_reorder_enabled: true, inventory_on_hand: 40, low_stock_threshold: 100,
      auto_reorder_vendor_id: vendor.id, reorder_quantity: 500, inventory_unit: 'each',
    }).returning('*');
    await mockConn('vendor_pricing').insert({ product_id: product.id, vendor_id: vendor.id, price: 314, quantity: '500', vendor_sku: `SKU${seq}`, is_best_price: true, is_active: true, approval_status: 'approved' });
    const [request] = await mockConn('product_restock_requests').insert({
      product_id: product.id, status: 'open', requested_quantity: 500, unit: 'each', source: 'auto_reorder',
      created_at: new Date(NOW.getTime() - 2 * DAY), metadata: JSON.stringify({ vendorId: vendor.id, vendorSku: `SKU${seq}` }), ...requestOver,
    }).returning('*');
    let row = null;
    let note = null;
    if (ledger) {
      const at = new Date(NOW.getTime() - DAY);
      const v = 'v1';
      [row] = await mockConn('vendor_orders').insert({
        restock_request_id: request.id, adapter: 'stickermule', vendor_id: vendor.id, status: ledger.status || 'needs_review', error: `${ledger.reason || 'over_monthly_cap'}: parked`,
        amount_cents: ledger.amount ?? null, placed_at: ledger.placedAt || null, created_at: at, updated_at: at,
        evidence: JSON.stringify({ bell: { title: 'Auto-order needs review: x', body: 'parked', v }, bellAt: at.toISOString(), ...(ledger.evidence || {}) }),
      }).returning('*');
      [note] = await mockConn('notifications').insert({
        recipient_type: 'admin', category: 'system', title: 'Inventory - x parked', body: 'No order was sent', read_at: at,
        metadata: JSON.stringify({ dedupeKey: `auto-order:${row.id}:${v}` }),
      }).returning('*');
    }
    return { product, request, row, note };
  }
  const dispatchable = async () => (await dispatch.findDispatchable(mockConn)).map((r) => r.id);
  const adapter = (place) => ({ key: 'stickermule', preSubmitTotal: 'vendor', bindingQuote: jest.fn(async () => ({ cents: 31400, source: 'order SM-0' })), place: jest.fn(place || (async () => ({ externalOrderNumber: 'SM-1', amountCents: 31400, response: { ok: 1 }, evidence: {} }))) });
  const run = (request, a, extra = {}) => dispatch.dispatchRestockOrder(request.id, { conn: mockConn, adapters: { stickermule: a, siteone: {} }, now: NOW, env: ENV, ...extra });
  const refusal = (promise) => promise.then(() => { throw new Error('expected a refusal'); }, (e) => e);
  const notes = () => mockConn('notifications').orderBy('created_at');

  describe('a park before the buy click', () => {
    test('the alert says the robot stopped, and to buy it and press Mark Ordered or press Cancel; a park after the click still says do not re-order', async () => {
      const pre = await fixture();
      await run(pre.request, adapter(async () => { throw Object.assign(new Error('Sticker Mule item is not on the account.'), { refuse: 'item_not_found' }); }));
      const post = await fixture();
      await run(post.request, adapter(async () => { throw Object.assign(new Error('unknown outcome'), { ambiguous: true }); }));
      const all = await notes();
      const preAlert = all.find((n) => n.detail.includes('The robot stopped before buying'));
      expect(preAlert.detail).toContain('The robot stopped before buying: Sticker Mule item is not on the account. Buy it yourself and press Mark Ordered, or press Cancel and the next morning check opens a fresh request.');
      expect(preAlert.title).toMatch(/auto-order stopped/);
      const postAlert = all.find((n) => n.detail.includes('Do NOT re-order'));
      expect(postAlert.detail).not.toContain('Mark Ordered');
    });

    test('Cancel works on a pre-click parked request: it closes, the alert closes, and a fresh request for the product is claimed on its own', async () => {
      const { request, product, note } = await fixture({ ledger: { reason: 'over_monthly_cap', amount: 31400 } });
      await inventory.updateRestockRequest(request.id, { action: 'cancel' }, { actorId: null });
      expect((await mockConn('product_restock_requests').where({ id: request.id }).first()).status).toBe('cancelled');
      expect((await mockConn('notifications').where({ id: note.id }).first()).done_at).not.toBeNull();
      expect(await dispatchable()).toEqual([]);
      const [fresh] = await mockConn('product_restock_requests').insert({
        product_id: product.id, status: 'open', requested_quantity: 500, unit: 'each', source: 'auto_reorder', metadata: JSON.stringify({ vendorId: vendor.id }),
      }).returning('*');
      expect(await dispatchable()).toEqual([fresh.id]);
      expect(await run(fresh, adapter())).toMatchObject({ status: 'placed' });
    });

    test('Mark Ordered works on a pre-click park, the take-over the alert names', async () => {
      const { request } = await fixture({ ledger: { reason: 'item_not_found' } });
      await inventory.updateRestockRequest(request.id, { action: 'mark_ordered' }, { actorId: null });
      expect((await mockConn('product_restock_requests').where({ id: request.id }).first()).status).toBe('ordered');
    });

    test('nothing retries by itself: only a request with no ledger row or a dry-run park is dispatchable, however old the park', async () => {
      const fresh = await fixture();
      const dry = await fixture({ ledger: { reason: 'dry_run' } });
      for (const reason of ['over_monthly_cap', 'over_per_order_cap', 'sku_not_found', 'item_not_found', 'price_jump', 'no_price', 'no_binding_total']) {
        await fixture({ ledger: { reason } });
      }
      await fixture({ ledger: { reason: 'adapter_error', status: 'failed' } });
      await fixture({ ledger: { reason: 'ambiguous_after_submit', placedAt: new Date(NOW.getTime() - DAY) } });
      expect((await dispatchable()).sort()).toEqual([fresh.request.id, dry.request.id].sort());
    });
  });

  describe('Mark Ordered and Cancel while an order may be out', () => {
    test.each(['ambiguous_after_submit', 'stale_placing', 'persist_after_placement', 'no_final_total', 'placed_on_received_request'])('a %s park refuses Mark Ordered and Cancel, with or without placed_at', async (reason) => {
      for (const placedAt of [new Date(NOW.getTime() - DAY), null]) {
        const { request } = await fixture({ ledger: { reason, placedAt } });
        for (const action of ['mark_ordered', 'cancel']) {
          const err = await refusal(inventory.updateRestockRequest(request.id, { action }, { actorId: null })).catch((e) => { throw new Error(`${reason} ${action} placedAt=${!!placedAt}: ${e.message}`); });
          expect(err).toMatchObject({ statusCode: 409, code: 'auto_order_out' });
        }
        expect((await mockConn('product_restock_requests').where({ id: request.id }).first()).status).toBe('open');
      }
    });

    test('allowed again once the operator recorded the vendor cancellation', async () => {
      const { request } = await fixture({ ledger: { reason: 'ambiguous_after_submit', placedAt: new Date(NOW.getTime() - DAY) } });
      await mockConn('vendor_orders').where({ restock_request_id: request.id }).update({ evidence: JSON.stringify({ revokedAt: NOW.toISOString() }) });
      await inventory.updateRestockRequest(request.id, { action: 'mark_ordered' }, { actorId: null });
      expect((await mockConn('product_restock_requests').where({ id: request.id }).first()).status).toBe('ordered');
    });
  });

  describe('one outstanding-order rule: unrevoked and (placed_at set or a post-submit reason)', () => {
    // A post-submit park whose placed_at is missing is still an order that may exist.
    const noStamp = { reason: 'ambiguous_after_submit', placedAt: null };

    test('a closed gate does not hand a sibling request to the office while such an order may be out, and its alert stays open', async () => {
      const first = await fixture({ ledger: noStamp, requestOver: { status: 'cancelled' } });
      const [second] = await mockConn('product_restock_requests').insert({
        product_id: first.product.id, status: 'open', requested_quantity: 500, unit: 'each', source: 'auto_reorder', metadata: JSON.stringify({ vendorId: vendor.id }),
      }).returning('*');
      process.env.GATE_AUTO_ORDER = 'false';
      try {
        const out = await run(second, adapter());
        expect(out).toMatchObject({ skipped: 'gated', autoOrderLive: true });
      } finally { process.env.GATE_AUTO_ORDER = 'true'; }
      const all = await notes();
      expect(all.filter((n) => (n.metadata.dedupeKey || '').startsWith('auto-reorder:'))).toEqual([]); // no "order manually"
      expect(all.find((n) => n.id === first.note.id).done_at).toBeNull();
      expect(await dispatch.findLiveAutoOrder(mockConn, first.product.id)).toBeTruthy();
    });

    test('the product guards block a new claim, and a revoked row stops counting', async () => {
      const first = await fixture({ ledger: noStamp, requestOver: { status: 'cancelled' } });
      const [second] = await mockConn('product_restock_requests').insert({
        product_id: first.product.id, status: 'open', requested_quantity: 500, unit: 'each', source: 'auto_reorder', metadata: JSON.stringify({ vendorId: vendor.id }),
      }).returning('*');
      const a = adapter();
      expect(await run(second, a)).toMatchObject({ skipped: 'prior_order_unreconciled' });
      expect(a.place).not.toHaveBeenCalled();
      await mockConn('vendor_orders').where({ restock_request_id: first.request.id }).update({ evidence: JSON.stringify({ revokedAt: NOW.toISOString() }) });
      expect(await dispatch.findLiveAutoOrder(mockConn, first.product.id)).toBeUndefined();
      expect(await run(second, a)).toMatchObject({ status: 'placed' });
    });

    test('a CANCELLED request with such an order blocks sibling claims, and Record vendor cancellation (not a hand-written revokedAt) clears it', async () => {
      const first = await fixture({ ledger: noStamp, requestOver: { status: 'cancelled' } });
      const [second] = await mockConn('product_restock_requests').insert({
        product_id: first.product.id, status: 'open', requested_quantity: 500, unit: 'each', source: 'auto_reorder', metadata: JSON.stringify({ vendorId: vendor.id }),
      }).returning('*');
      const a = adapter();
      expect(await run(second, a)).toMatchObject({ skipped: 'prior_order_unreconciled' });
      // The Restock tab lists the blocked request (default queue), with the order marked outstanding.
      const { listRestockRequests } = require('../services/inventory-restock-queue');
      const listed = (await listRestockRequests({ status: 'active' })).requests.find((r) => r.id === first.request.id);
      expect(listed.order).toMatchObject({ outstanding: true, placedAt: null, id: first.row.id });
      const revoke = require('../services/procurement/order-revoke');
      const out = await revoke.recordVendorCancellation(first.request.id, { orderId: first.row.id, version: listed.order.version, actorId: null });
      expect(out).toEqual({ requestStatus: 'cancelled' });
      expect((await mockConn('product_restock_requests').where({ id: first.request.id }).first()).status).toBe('cancelled');
      expect((await mockConn('notifications').where({ id: first.note.id }).first()).done_at).not.toBeNull();
      expect((await listRestockRequests({ status: 'active' })).requests.find((r) => r.id === first.request.id)).toBeUndefined();
      expect(await run(second, a)).toMatchObject({ status: 'placed' });
    });

    test('the month\'s spend counts such an order too', async () => {
      await fixture({ ledger: { ...noStamp, amount: 31400, createdAt: NOW } });
      await mockConn('vendor_orders').update({ created_at: NOW });
      expect(await dispatch.monthlySpentCents(mockConn, { now: NOW })).toBe(31400);
    });

    test('Record vendor cancellation works on it: the row is revoked, the request closes, the alert closes', async () => {
      const { request, row, note } = await fixture({ ledger: noStamp });
      const revoke = require('../services/procurement/order-revoke');
      expect(revoke.revokeBlocker(row)).toBeNull();
      const out = await revoke.recordVendorCancellation(request.id, { orderId: row.id, version: revoke.versionOf(row), actorId: null });
      expect(out).toEqual({ requestStatus: 'cancelled' });
      const saved = await mockConn('vendor_orders').where({ id: row.id }).first();
      expect(saved.evidence.revokedAt).toBeTruthy();
      expect((await mockConn('product_restock_requests').where({ id: request.id }).first()).status).toBe('cancelled');
      expect((await mockConn('notifications').where({ id: note.id }).first()).done_at).not.toBeNull();
    });

    test('a pre-click park still has nothing to revoke', async () => {
      const { row } = await fixture({ ledger: { reason: 'item_not_found' } });
      expect(require('../services/procurement/order-revoke').revokeBlocker(row)).toMatchObject({ code: 'not_dispatched' });
    });

    test('isMaybePlaced / isOutstandingOrder follow the one rule', () => {
      expect(dispatch.isMaybePlaced({ placed_at: NOW, error: null })).toBe(true);
      expect(dispatch.isMaybePlaced({ placed_at: null, error: 'stale_placing: x' })).toBe(true);
      expect(dispatch.isMaybePlaced({ placed_at: null, error: 'item_not_found: x' })).toBe(false);
      expect(dispatch.isMaybePlaced({ placed_at: null, error: null })).toBe(false);
      expect(dispatch.isOutstandingOrder({ placed_at: NOW, evidence: { revokedAt: 'x' } })).toBe(false);
      expect(dispatch.isOutstandingOrder({ placed_at: null, error: 'no_final_total: x', evidence: {} })).toBe(true);
    });
  });

  describe('request open over 7 days', () => {
    const sync = (now) => require('../services/procurement/stale-request-alert').syncStaleRequestAlerts({ knex: mockConn, now });
    const alerts = () => mockConn('notifications').whereRaw("metadata->>'dedupeKey' LIKE 'restock-open:%'").orderBy('created_at');
    const old = (days) => new Date(NOW.getTime() - days * DAY);

    test('raises one alert for each automatic request older than 7 days, any status but received or cancelled', async () => {
      const open = await fixture({ requestOver: { created_at: old(9) } });
      const ordered = await fixture({ requestOver: { created_at: old(8), status: 'ordered' } });
      await fixture({ requestOver: { created_at: old(3) } });
      await fixture({ requestOver: { created_at: old(20), status: 'received' } });
      await fixture({ requestOver: { created_at: old(20), status: 'cancelled' } });
      await fixture({ requestOver: { created_at: old(20), source: 'manual' } });
      expect(await sync(NOW)).toEqual({ stale: 2, closed: 0 });
      const rows = await alerts();
      expect(rows.map((r) => r.metadata.dedupeKey).sort()).toEqual([`restock-open:${open.request.id}`, `restock-open:${ordered.request.id}`].sort());
      const row = rows.find((r) => r.metadata.dedupeKey.endsWith(open.request.id));
      expect(row.title).toMatch(/restock, open 9 days/);
      expect(row.body).toMatch(/^Open since [A-Z][a-z]{2} \d{1,2}; no order recorded, check the Sticker Mule account\.$/);
      expect(rows.find((r) => r.metadata.dedupeKey.endsWith(ordered.request.id)).body).toMatch(/marked ordered, nothing received/);
    });

    test('never says nothing was ordered: not for an ambiguous submit, not for a request with no ledger row', async () => {
      const unknown = await fixture({ requestOver: { created_at: old(9) }, ledger: { reason: 'ambiguous_after_submit', placedAt: old(8) } });
      const plain = await fixture({ requestOver: { created_at: old(9) } });
      await sync(NOW);
      for (const { request } of [unknown, plain]) {
        const row = (await alerts()).find((r) => r.metadata.dedupeKey.endsWith(request.id));
        expect(row.body).toContain('no order recorded, check the Sticker Mule account');
        expect(row.body).not.toMatch(/nothing ordered/i);
      }
    });

    test('a product or vendor name the alert copy rules refuse is left out, never failing the run', async () => {
      await mockConn('vendors').where({ id: vendor.id }).update({ name: 'Acme Inc. Retry [x]' });
      const bad = await fixture({ requestOver: { created_at: old(9) } });
      await mockConn('products_catalog').where({ id: bad.product.id }).update({ name: 'Bait [12 pack]' });
      const snake = await fixture({ requestOver: { created_at: old(120) } });
      await mockConn('products_catalog').where({ id: snake.product.id }).update({ name: 'pest_bait_12' });
      expect(await sync(NOW)).toEqual({ stale: 2, closed: 0 });
      const rows = await alerts();
      const badRow = rows.find((r) => r.metadata.dedupeKey.endsWith(bad.request.id));
      expect(badRow.title).toBe('Inventory — check an automatic restock request, open 9 days');
      expect(badRow.body).toBe(`Open since ${badRow.body.slice(11, badRow.body.indexOf(';'))}; no order recorded, check the vendor account.`);
      const longRow = rows.find((r) => r.metadata.dedupeKey.endsWith(snake.request.id));
      expect(longRow.title).toBe('Inventory — restock request open 120 days');
    });

    test('the alert links to its own request, so the tab loads that row', async () => {
      const { request } = await fixture({ requestOver: { created_at: old(9) } });
      await sync(NOW);
      const [row] = await alerts();
      expect(row.link).toBe(`/admin/inventory?tab=restock&requestId=${request.id}`);
    });

    test('the next day refreshes the same row quietly, and a read row stays read', async () => {
      const { request } = await fixture({ requestOver: { created_at: old(9) } });
      await sync(NOW);
      const [first] = await alerts();
      await mockConn('notifications').where({ id: first.id }).update({ read_at: NOW });
      await sync(new Date(NOW.getTime() + DAY));
      const rows = await alerts();
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(first.id);
      expect(rows[0].title).toMatch(/open 10 days/);
      expect(rows[0].read_at).not.toBeNull();
      expect(rows[0].metadata.dedupeKey).toBe(`restock-open:${request.id}`);
    });

    test('closes itself when the request closes', async () => {
      const { request } = await fixture({ requestOver: { created_at: old(9) } });
      await sync(NOW);
      await mockConn('product_restock_requests').where({ id: request.id }).update({ status: 'received' });
      expect((await sync(NOW)).closed).toBe(1);
      const [row] = await alerts();
      expect(row.done_at).not.toBeNull();
      expect(row.resolution).toMatch(/closed/);
      expect((await sync(NOW)).closed).toBe(0); // nothing left to close, nothing rewritten
    });
  });
});
