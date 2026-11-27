// Automatic ordering: pre-click parks retry, and the open-over-7-days alert, against PostgreSQL
// (CI's DB-gated pass; locally set DATABASE_URL to a migrated scratch database). Fixture tables are
// LIKE copies in a unique schema that is dropped after the suite. The real order-dispatch, the real
// alert writer and the real SQL run; only the vendor adapter and the audit log are stand-ins.
// Fixtures are synthetic; nothing is sent to a vendor.
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
// The code stamps its own clock (new Date()) on every park, so the fixtures are laid out around the real
// ET day: yesterday, earlier today (just after ET midnight) and last month, all relative to NOW.
const { etDateString, parseETDateTime, startOfETMonth } = require('../utils/datetime-et');
const NOW = new Date();
const DAY_START = parseETDateTime(`${etDateString(NOW)}T00:00`);
const YESTERDAY = new Date(DAY_START.getTime() - 60 * 60 * 1000);
const EARLIER_TODAY = new Date(DAY_START.getTime() + 1000);
const MONTH_START = startOfETMonth(NOW);
const LAST_MONTH = new Date(MONTH_START.getTime() - 60 * 60 * 1000);
const ENV = { GATE_AUTO_ORDER: 'true', GATE_AUTO_ORDER_STICKERMULE: 'true', AUTO_ORDER_MAX_PER_ORDER_CENTS: '50000', AUTO_ORDER_MAX_MONTHLY_CENTS: '100000' };

jest.setTimeout(60000);
(SKIP ? describe.skip : describe)('automatic ordering retries and the open-request alert (PostgreSQL)', () => {
  const schema = `autobuy_retry_${randomUUID().replaceAll('-', '')}`;
  let dispatch;
  let vendor;
  let seq = 0;

  beforeAll(async () => {
    mockConn = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema, 'public'], pool: { min: 0, max: 6 } });
    await mockConn.raw('CREATE SCHEMA ??', [schema]);
    for (const table of TABLES) await mockConn.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, table, table]);
    for (const [k, v] of Object.entries(ENV)) process.env[k] = v;
    dispatch = require('../services/procurement/order-dispatch');
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
  async function fixture({ ledger = null, requestOver = {}, bell = true } = {}) {
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
      const reason = ledger.reason || 'item_not_found';
      const at = ledger.at || YESTERDAY;
      const v = 'v1';
      [row] = await mockConn('vendor_orders').insert({
        restock_request_id: request.id, adapter: 'stickermule', vendor_id: vendor.id, status: ledger.status || 'needs_review', error: `${reason}: parked`,
        amount_cents: ledger.amount ?? null, placed_at: ledger.placedAt || null, created_at: ledger.createdAt || at, updated_at: at,
        evidence: JSON.stringify({ bell: { title: 'Auto-order needs review: x', body: 'The robot will try again', v }, ...(ledger.mark === false ? {} : { retryMark: 'v1' }), ...(bell ? { bellAt: at.toISOString() } : {}) }),
      }).returning('*');
      if (bell) {
        [note] = await mockConn('notifications').insert({
          recipient_type: 'admin', category: 'system', title: 'Inventory - order x by hand', body: 'No order was sent', read_at: at,
          metadata: JSON.stringify({ dedupeKey: `auto-order:${row.id}:${v}`, dedupeVersion: undefined }),
        }).returning('*');
      }
    }
    return { product, request, row, note };
  }
  const dispatchable = async (now = NOW) => (await dispatch.findDispatchable(mockConn, { now, env: ENV })).map((r) => r.id);
  const adapter = (place) => ({ key: 'stickermule', preSubmitTotal: 'vendor', bindingQuote: jest.fn(async () => ({ cents: 31400, source: 'order SM-0' })), place: jest.fn(place || (async () => ({ externalOrderNumber: 'SM-1', amountCents: 31400, response: { ok: 1 }, evidence: {} }))) });
  const retry = (request, a, extra = {}) => dispatch.dispatchRestockOrder(request.id, { conn: mockConn, adapters: { stickermule: a, siteone: {} }, now: NOW, env: ENV, ...extra });
  const refuse = (reason) => async () => { throw Object.assign(new Error(`${reason} again`), { refuse: reason }); };
  const ledgerOf = (request) => mockConn('vendor_orders').where({ restock_request_id: request.id }).first();
  const notes = () => mockConn('notifications').orderBy('created_at');

  describe('which parks come back', () => {
    test.each(['sku_not_found', 'item_not_found', 'unavailable', 'price_jump'])('%s retries on a later day, once a day', async (reason) => {
      const yesterday = await fixture({ ledger: { reason, at: YESTERDAY } });
      const today = await fixture({ ledger: { reason, at: EARLIER_TODAY } });
      expect(await dispatchable()).toEqual([yesterday.request.id]);
      expect(await dispatchable(new Date(NOW.getTime() + DAY))).toEqual(expect.arrayContaining([yesterday.request.id, today.request.id]));
    });

    test('a request with no ledger row and a dry-run park are dispatchable as before', async () => {
      const fresh = await fixture();
      const dry = await fixture({ ledger: { reason: 'dry_run', at: EARLIER_TODAY } });
      expect((await dispatchable()).sort()).toEqual([fresh.request.id, dry.request.id].sort());
    });

    test('over_monthly_cap retries when the ET month changed, with or without room', async () => {
      const lastMonth = await fixture({ ledger: { reason: 'over_monthly_cap', createdAt: LAST_MONTH, at: LAST_MONTH, amount: 99999999 } });
      expect(await dispatchable()).toEqual([lastMonth.request.id]);
    });

    test('over_monthly_cap in the same month retries on a later day only when the month now has room', async () => {
      // A pinned mid-month clock (the findDispatchable read takes `now`), so the test holds on the 1st of a month too.
      const pinned = new Date('2026-12-16T11:10:00Z');
      const earlier = new Date('2026-12-02T11:20:00Z');
      const yesterday = new Date('2026-12-15T11:20:00Z');
      const earlierToday = new Date('2026-12-16T10:30:00Z');
      const fits = await fixture({ ledger: { reason: 'over_monthly_cap', createdAt: earlier, at: yesterday, amount: 31400 } });
      await fixture({ ledger: { reason: 'over_monthly_cap', createdAt: earlier, at: yesterday, amount: 99000000 } });
      await fixture({ ledger: { reason: 'over_monthly_cap', createdAt: earlier, at: yesterday, amount: null } });
      await fixture({ ledger: { reason: 'over_monthly_cap', createdAt: earlier, at: earlierToday, amount: 100 } });
      expect(await dispatchable(pinned)).toEqual([fits.request.id]);
    });

    test('a month-rollover cap park restored by a run-level failure today waits for tomorrow, however old its created_at', async () => {
      const lastMonthPark = await fixture({ ledger: { reason: 'over_monthly_cap', createdAt: LAST_MONTH, at: LAST_MONTH, amount: 31400 } });
      const down = adapter(async () => { throw Object.assign(new Error('Chrome is down'), { runLevel: true }); });
      await expect(retry(lastMonthPark.request, down)).rejects.toThrow('Chrome is down');
      expect(new Date((await ledgerOf(lastMonthPark.request)).created_at).getTime()).toBe(LAST_MONTH.getTime()); // restored as it was
      expect(await dispatchable()).toEqual([]); // but today's attempt is spent
      expect(await dispatchable(new Date(Date.now() + DAY))).toEqual([lastMonthPark.request.id]);
    });

    test('a park from before this change (no retry mark; its alert said "order manually") is never retried', async () => {
      for (const reason of ['item_not_found', 'sku_not_found', 'over_monthly_cap']) {
        await fixture({ ledger: { reason, mark: false, at: LAST_MONTH, createdAt: LAST_MONTH, amount: 100 } });
      }
      expect(await dispatchable()).toEqual([]);
    });

    test('a park after the buy click, or with an unknown outcome, never comes back', async () => {
      for (const reason of ['ambiguous_after_submit', 'persist_after_placement', 'over_cap_after_placement', 'stale_placing', 'no_final_total', 'placed_on_received_request']) {
        await fixture({ ledger: { reason, at: LAST_MONTH, createdAt: LAST_MONTH, placedAt: LAST_MONTH } });
      }
      // Even a reason that retries elsewhere stays put once the click went out, and so does a plain failure.
      await fixture({ ledger: { reason: 'item_not_found', at: LAST_MONTH, placedAt: LAST_MONTH } });
      await fixture({ ledger: { reason: 'over_monthly_cap', at: LAST_MONTH, createdAt: LAST_MONTH, placedAt: LAST_MONTH } });
      await fixture({ ledger: { reason: 'adapter_error', status: 'failed', at: LAST_MONTH } });
      await fixture({ ledger: { reason: 'no_price', at: LAST_MONTH } });
      await fixture({ ledger: { reason: 'over_per_order_cap', at: LAST_MONTH } });
      await fixture({ ledger: { reason: 'no_vendor_confirmed_total', at: LAST_MONTH } });
      await fixture({ ledger: { reason: 'placed', status: 'placed', placedAt: LAST_MONTH, at: LAST_MONTH } });
      expect(await dispatchable()).toEqual([]);
    });
  });

  describe('a retried attempt', () => {
    test('same reason again: the one alert refreshes quietly, no new alert, the row is parked again today', async () => {
      const { request, row, note } = await fixture({ ledger: { reason: 'item_not_found' } });
      const a = adapter(refuse('item_not_found'));
      const out = await retry(request, a);
      expect(out).toMatchObject({ status: 'needs_review', reason: 'item_not_found' });
      expect(a.place).toHaveBeenCalledTimes(1);
      const saved = await ledgerOf(request);
      expect(saved.id).toBe(row.id);
      expect(saved.status).toBe('needs_review');
      expect(saved.placed_at).toBeNull();
      expect(new Date(saved.updated_at).getTime()).toBeGreaterThan(EARLIER_TODAY.getTime() - 1);
      expect(saved.evidence.bell.v).toBe('v1');
      expect(saved.evidence.bellAt).toBeTruthy();
      const all = await notes();
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe(note.id);
      expect(all[0].read_at).not.toBeNull(); // a ring would have cleared it
      expect(all[0].done_at).toBeNull();
      expect(all[0].detail).toContain('item_not_found again'); // the text refreshed, no ring
      // And the same day it is not tried a second time.
      expect(await dispatchable()).toEqual([]);
    });

    test('the park alert tells staff the robot retries and to press Mark Ordered before buying by hand', async () => {
      const { request } = await fixture();
      await retry(request, adapter(refuse('item_not_found')));
      const [alert] = await notes();
      expect(alert.detail).toMatch(/The robot will try again on [A-Z][a-z]{2} \d{1,2}\. To buy it yourself, press Mark Ordered on the Restock tab first, then buy it\./);
      expect(alert.detail).not.toMatch(/order manually/);
      expect(alert.title).toMatch(/auto-order parked, robot retries|auto-order retries/);
      expect((await ledgerOf(request)).evidence.retryMark).toBe('v1');
      // A cap park says when too, and a park after the click never carries the mark.
      const cap = await fixture();
      await retry(cap.request, adapter(async () => ({ externalOrderNumber: 'SM-9', amountCents: 31400, evidence: {} })), { env: { ...ENV, AUTO_ORDER_MAX_MONTHLY_CENTS: '100' } });
      expect((await notes()).map((n) => n.detail).join('\n')).toContain('when the month\'s order cap has room');
      const ambiguous = await fixture();
      await retry(ambiguous.request, adapter(async () => { throw Object.assign(new Error('unknown'), { ambiguous: true }); }));
      expect((await ledgerOf(ambiguous.request)).evidence.retryMark).toBeUndefined();
    });

    test('Mark Ordered (the take-over) stops every retry, and a retry never starts on a request marked ordered', async () => {
      const { request } = await fixture({ ledger: { reason: 'item_not_found' } });
      expect(await dispatchable()).toEqual([request.id]);
      const inventory = require('../services/inventory-operations');
      await inventory.updateRestockRequest(request.id, { action: 'mark_ordered' }, { actorId: null });
      expect(await dispatchable(new Date(Date.now() + 40 * DAY))).toEqual([]);
      const a = adapter();
      expect(await retry(request, a)).toMatchObject({ skipped: 'not_open_auto_request' });
      expect(a.place).not.toHaveBeenCalled();
    });

    test('a different reason rings a new alert and closes the old one', async () => {
      const { request, note } = await fixture({ ledger: { reason: 'item_not_found' } });
      await retry(request, adapter(refuse('sku_not_found')));
      const all = await notes();
      expect(all).toHaveLength(2);
      const old = all.find((n) => n.id === note.id);
      const fresh = all.find((n) => n.id !== note.id);
      expect(old.done_at).not.toBeNull();
      expect(fresh.read_at).toBeNull();
      expect(fresh.done_at).toBeNull();
      expect((await ledgerOf(request)).evidence.bell.v).not.toBe('v1');
    });

    test('a retry that buys places the order, orders the request and closes the old alert', async () => {
      const { request, note } = await fixture({ ledger: { reason: 'item_not_found' } });
      const out = await retry(request, adapter());
      expect(out).toMatchObject({ status: 'placed', externalOrderNumber: 'SM-1' });
      const saved = await ledgerOf(request);
      expect(saved.status).toBe('placed');
      expect(saved.placed_at).not.toBeNull();
      expect((await mockConn('product_restock_requests').where({ id: request.id }).first()).status).toBe('ordered');
      const all = await notes();
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe(note.id);
      expect(all[0].done_at).not.toBeNull();
    });

    test('a cap park from last month retries into the new month and counts against it', async () => {
      const { request } = await fixture({ ledger: { reason: 'over_monthly_cap', createdAt: LAST_MONTH, at: LAST_MONTH, amount: 31400 } });
      expect(await retry(request, adapter())).toMatchObject({ status: 'placed' });
      const saved = await ledgerOf(request);
      expect(new Date(saved.created_at).getTime()).toBeGreaterThanOrEqual(MONTH_START.getTime()); // re-stamped: this ET month
    });

    test('a run-level failure puts the parked row and its alert back as they were', async () => {
      const { request, row, note } = await fixture({ ledger: { reason: 'item_not_found', amount: 1234 } });
      const a = adapter(async () => { throw Object.assign(new Error('Chrome is down'), { runLevel: true }); });
      await expect(retry(request, a)).rejects.toThrow('Chrome is down');
      const saved = await ledgerOf(request);
      expect(saved).toMatchObject({ id: row.id, status: 'needs_review', amount_cents: 1234 });
      expect(saved.error).toBe('item_not_found: parked');
      expect(saved.evidence.bell.v).toBe('v1');
      expect(saved.evidence.bellAt).toBeTruthy();
      expect((await mockConn('notifications').where({ id: note.id }).first()).done_at).toBeNull();
      expect(await dispatchable()).toEqual([]); // that was today's attempt
    });

    test('an ambiguous submit during a retry becomes a do-not-reorder park and closes the old alert', async () => {
      const { request, note } = await fixture({ ledger: { reason: 'item_not_found' } });
      const a = adapter(async () => { throw Object.assign(new Error('clicked, outcome unknown'), { ambiguous: true }); });
      expect(await retry(request, a)).toMatchObject({ status: 'needs_review', reason: 'ambiguous_after_submit' });
      const saved = await ledgerOf(request);
      expect(saved.placed_at).not.toBeNull();
      expect((await mockConn('notifications').where({ id: note.id }).first()).done_at).not.toBeNull();
      expect(await dispatchable(new Date(NOW.getTime() + 40 * DAY))).toEqual([]); // never retried
    });

    test('a parked-after-click row is never claimed again, whatever the day', async () => {
      const { request } = await fixture({ ledger: { reason: 'ambiguous_after_submit', at: LAST_MONTH, createdAt: LAST_MONTH, placedAt: LAST_MONTH } });
      const a = adapter();
      expect(await retry(request, a)).toMatchObject({ skipped: 'already_claimed' });
      expect(a.place).not.toHaveBeenCalled();
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
      expect(row.body).toMatch(/^Open since [A-Z][a-z]{2} \d{1,2}; nothing ordered yet\.$/);
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

    test('an order that may exist is never called "nothing ordered"', async () => {
      const unknown = await fixture({ requestOver: { created_at: old(9) }, ledger: { reason: 'ambiguous_after_submit', placedAt: old(8), bell: false } });
      const plain = await fixture({ requestOver: { created_at: old(9) } });
      await sync(NOW);
      const rows = await alerts();
      const unknownRow = rows.find((r) => r.metadata.dedupeKey.endsWith(unknown.request.id));
      expect(unknownRow.body).toMatch(/^Open since [A-Z][a-z]{2} \d{1,2}; no order recorded, check the Sticker Mule account\.$/);
      expect(rows.find((r) => r.metadata.dedupeKey.endsWith(plain.request.id)).body).toMatch(/nothing ordered yet/);
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
