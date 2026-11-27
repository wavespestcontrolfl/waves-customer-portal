// Automatic ordering: the Restock tab's "Try again" on a request parked before the buy click, Mark Ordered
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

const TABLES = ['products_catalog', 'product_restock_requests', 'vendor_orders', 'vendors', 'vendor_pricing', 'notifications'];
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date();
const ENV = { GATE_AUTO_ORDER: 'true', GATE_AUTO_ORDER_STICKERMULE: 'true', AUTO_ORDER_MAX_PER_ORDER_CENTS: '50000', AUTO_ORDER_MAX_MONTHLY_CENTS: '100000' };

jest.setTimeout(60000);
(SKIP ? describe.skip : describe)('Try again, Mark Ordered and the open-request alert (PostgreSQL)', () => {
  const schema = `autobuy_try_again_${randomUUID().replaceAll('-', '')}`;
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
  const tryAgain = (request) => dispatch.tryAgainParkedRequest(request.id, { actorId: null });
  const refusal = (promise) => promise.then(() => { throw new Error('expected a refusal'); }, (e) => e);
  const ledgerOf = (request) => mockConn('vendor_orders').where({ restock_request_id: request.id }).first();
  const notes = () => mockConn('notifications').orderBy('created_at');

  describe('nothing retries by itself', () => {
    test('only a request with no ledger row or a dry-run park is dispatchable; no pre-click park comes back on its own, however old', async () => {
      const fresh = await fixture();
      const dry = await fixture({ ledger: { reason: 'dry_run' } });
      for (const reason of ['over_monthly_cap', 'over_per_order_cap', 'sku_not_found', 'item_not_found', 'price_jump', 'no_price', 'no_binding_total']) {
        await fixture({ ledger: { reason, createdAt: new Date(NOW.getTime() - 90 * DAY) } });
      }
      await fixture({ ledger: { reason: 'adapter_error', status: 'failed' } });
      await fixture({ ledger: { reason: 'ambiguous_after_submit', placedAt: new Date(NOW.getTime() - DAY) } });
      expect((await dispatchable()).sort()).toEqual([fresh.request.id, dry.request.id].sort());
    });
  });

  describe('Try again', () => {
    test.each(['over_monthly_cap', 'over_per_order_cap', 'sku_not_found', 'item_not_found', 'price_jump', 'no_price', 'no_binding_total'])('re-arms a %s park once: the next run claims it through the one claim, and the old alert closes', async (reason) => {
      const { request, row, note } = await fixture({ ledger: { reason } });
      expect(await dispatchable()).toEqual([]);
      await tryAgain(request);
      const queued = await ledgerOf(request);
      expect(queued.evidence.tryAgain).toMatchObject({ at: expect.any(String) });
      expect(queued).toMatchObject({ id: row.id, status: 'needs_review', placed_at: null });
      expect(await dispatchable()).toEqual([request.id]);
      // Pressed again while queued: refused, nothing written twice.
      expect((await refusal(tryAgain(request))).code).toBe('not_parked');
      const a = adapter();
      expect(await run(request, a)).toMatchObject({ status: 'placed', externalOrderNumber: 'SM-1' });
      expect(a.place).toHaveBeenCalledTimes(1);
      // The claim is single: a second run finds the placed order and calls nothing.
      expect(await run(request, a)).toMatchObject({ skipped: 'not_open_auto_request' });
      expect(a.place).toHaveBeenCalledTimes(1);
      expect((await ledgerOf(request)).id).toBe(row.id);
      expect((await mockConn('notifications').where({ id: note.id }).first()).done_at).not.toBeNull();
    });

    test('the cap reservation is unchanged: a Try again that is still over the monthly cap parks again and is not queued again', async () => {
      const { request } = await fixture({ ledger: { reason: 'over_monthly_cap', amount: 31400 } });
      await tryAgain(request);
      const a = adapter();
      expect(await run(request, a, { env: { ...ENV, AUTO_ORDER_MAX_MONTHLY_CENTS: '100' } })).toMatchObject({ status: 'needs_review', reason: 'over_monthly_cap' });
      expect(a.place).not.toHaveBeenCalled();
      const saved = await ledgerOf(request);
      expect(saved.evidence.tryAgain).toBeUndefined();
      expect(await dispatchable()).toEqual([]);
    });

    test('a park after the buy click is refused 409 and nothing is written', async () => {
      for (const reason of ['ambiguous_after_submit', 'stale_placing', 'persist_after_placement', 'no_final_total', 'over_cap_after_placement']) {
        const { request, row } = await fixture({ ledger: { reason, placedAt: new Date(NOW.getTime() - DAY) } });
        const err = await refusal(tryAgain(request));
        expect(err).toMatchObject({ statusCode: 409, code: 'auto_order_out' });
        expect((await ledgerOf(request)).evidence.tryAgain).toBeUndefined();
        expect((await ledgerOf(request)).id).toBe(row.id);
      }
      expect(await dispatchable()).toEqual([]);
    });

    test('a post-submit reason with no placed_at stamp is still refused', async () => {
      const { request } = await fixture({ ledger: { reason: 'ambiguous_after_submit' } });
      expect((await refusal(tryAgain(request))).code).toBe('not_parked');
    });

    test('refused when the request is not parked before the click', async () => {
      const none = await fixture();
      expect((await refusal(tryAgain(none.request))).code).toBe('not_parked');
      const ordered = await fixture({ ledger: { reason: 'item_not_found' }, requestOver: { status: 'ordered' } });
      expect((await refusal(tryAgain(ordered.request))).code).toBe('request_not_open');
      const failed = await fixture({ ledger: { reason: 'adapter_error', status: 'failed' } });
      expect((await refusal(tryAgain(failed.request))).code).toBe('not_parked');
      const dry = await fixture({ ledger: { reason: 'dry_run' } });
      expect((await refusal(tryAgain(dry.request))).code).toBe('not_parked');
      const placing = await fixture({ ledger: { reason: 'item_not_found', status: 'placing' } });
      expect((await refusal(tryAgain(placing.request))).code).toBe('auto_order_placing');
      const revoked = await fixture({ ledger: { reason: 'item_not_found', evidence: { revokedAt: NOW.toISOString() } } });
      expect((await refusal(tryAgain(revoked.request))).code).toBe('not_parked');
      const manual = await fixture({ ledger: { reason: 'item_not_found' }, requestOver: { source: 'manual' } });
      expect((await refusal(tryAgain(manual.request))).code).toBe('request_not_open');
      expect((await refusal(dispatch.tryAgainParkedRequest(randomUUID(), {}))).code).toBe('request_not_found');
    });

    test('refused while another automatic order for the product is live', async () => {
      const { request, product } = await fixture({ ledger: { reason: 'item_not_found' } });
      const [other] = await mockConn('product_restock_requests').insert({ product_id: product.id, status: 'ordered', requested_quantity: 1, unit: 'each', source: 'test_fixture' }).returning('*');
      await mockConn('vendor_orders').insert({ restock_request_id: other.id, adapter: 'stickermule', vendor_id: vendor.id, status: 'placed', placed_at: NOW, amount_cents: 100 });
      expect((await refusal(tryAgain(request))).code).toBe('auto_order_live');
    });

    test('Mark Ordered after a Try again is queued stops it: the claim needs an open request', async () => {
      const { request } = await fixture({ ledger: { reason: 'item_not_found' } });
      await tryAgain(request);
      await inventory.updateRestockRequest(request.id, { action: 'mark_ordered' }, { actorId: null });
      expect(await dispatchable()).toEqual([]);
      const a = adapter();
      expect(await run(request, a)).toMatchObject({ skipped: 'not_open_auto_request' });
      expect(a.place).not.toHaveBeenCalled();
    });

    test('the park alert says what to press, and a park after the click still says do not re-order', async () => {
      const pre = await fixture();
      await run(pre.request, adapter(async () => { throw Object.assign(new Error('Sticker Mule item is not on the account'), { refuse: 'item_not_found' }); }));
      const post = await fixture();
      await run(post.request, adapter(async () => { throw Object.assign(new Error('unknown outcome'), { ambiguous: true }); }));
      const all = await notes();
      const preAlert = all.find((n) => n.detail.includes('Press Try again'));
      expect(preAlert.detail).toContain('No order was sent and the request stays open. Press Try again on the Restock tab once the item is fixed, or buy it yourself and press Mark Ordered.');
      expect(preAlert.title).toMatch(/auto-order parked/);
      const postAlert = all.find((n) => n.detail.includes('Do NOT re-order'));
      expect(postAlert.detail).not.toContain('Try again');
    });

    test('isTryAgainPark: only a needs_review park before the click, not a dry run, not queued, not revoked', () => {
      const ok = { status: 'needs_review', error: 'item_not_found: x' };
      expect(dispatch.isTryAgainPark(ok)).toBe(true);
      expect(dispatch.isTryAgainPark({ ...ok, status: 'failed' })).toBe(false);
      expect(dispatch.isTryAgainPark({ ...ok, placedAt: NOW })).toBe(false);
      expect(dispatch.isTryAgainPark({ ...ok, revokedAt: 'x' })).toBe(false);
      expect(dispatch.isTryAgainPark({ ...ok, tryAgain: '{}' })).toBe(false);
      expect(dispatch.isTryAgainPark({ ...ok, error: 'dry_run: x' })).toBe(false);
      for (const reason of dispatch._internals.POST_SUBMIT_REASONS) expect(dispatch.isTryAgainPark({ ...ok, error: `${reason}: x` })).toBe(false);
    });
  });

  describe('Mark Ordered after an ambiguous submit', () => {
    test('is refused while the order may exist, and allowed once the operator recorded the vendor cancellation', async () => {
      const { request } = await fixture({ ledger: { reason: 'ambiguous_after_submit', placedAt: new Date(NOW.getTime() - DAY) } });
      const err = await refusal(inventory.updateRestockRequest(request.id, { action: 'mark_ordered' }, { actorId: null }));
      expect(err).toMatchObject({ statusCode: 409, code: 'auto_order_out' });
      expect((await mockConn('product_restock_requests').where({ id: request.id }).first()).status).toBe('open');
      // A revoked order is no longer out: the request can be handled by hand.
      await mockConn('vendor_orders').where({ restock_request_id: request.id }).update({ evidence: JSON.stringify({ revokedAt: NOW.toISOString() }) });
      await inventory.updateRestockRequest(request.id, { action: 'mark_ordered' }, { actorId: null });
      expect((await mockConn('product_restock_requests').where({ id: request.id }).first()).status).toBe('ordered');
    });

    test('still works on a pre-click park, the take-over staff are told to use', async () => {
      const { request } = await fixture({ ledger: { reason: 'item_not_found' } });
      await inventory.updateRestockRequest(request.id, { action: 'mark_ordered' }, { actorId: null });
      expect((await mockConn('product_restock_requests').where({ id: request.id }).first()).status).toBe('ordered');
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
