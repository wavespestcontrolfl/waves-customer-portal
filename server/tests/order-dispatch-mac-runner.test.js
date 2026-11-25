/**
 * SiteOne orders from the Mac (SITEONE_ORDER_RUNNER=mac): the server claims no SiteOne request,
 * its watchdog hands a request the Mac missed to the office exactly once, the Mac never claims a
 * handed-off request, and the Mac's run dispatches only SiteOne requests and skips reconciliation.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/vendor-credentials', () => ({ getVendorLoginCredentials: jest.fn(async () => null) }));
jest.mock('../services/audit-log', () => ({ auditVendorOrder: jest.fn(async () => 'audit-1') }));
jest.mock('../services/procurement/auto-reorder', () => ({
  lockProductPricing: jest.fn(async () => {}),
  vendorPricingFor: jest.fn(async () => null),
  ringRestockBell: jest.fn(async ({ request }) => ({ id: `bell-${request.id}` })),
}));
jest.mock('../services/notification-service', () => ({
  _private: { openToCloser: (q) => q, doneColumns: () => ({}) },
}));
jest.mock('../models/db', () => ({}));

const autoReorder = require('../services/procurement/auto-reorder');
const dispatch = require('../services/procurement/order-dispatch');
const { run: macRun, withLiveSwitches, liveStopReason } = require('../scripts/siteone-mac-order-run');

const SITEONE = { id: 'v-siteone', name: 'SiteOne', code: 1, active: true, updated_at: new Date('2026-11-01T00:00:00Z') };
const STICKER = { id: 'v-sticker', name: 'Sticker Mule', code: 25, active: true, updated_at: new Date('2026-11-01T00:00:00Z') };
const NOW = new Date('2026-11-25T11:10:00Z');

// A small knex stand-in: every read goes through state.read(table, where, cols); writes are recorded.
function fakeConn(state) {
  const conn = (table) => {
    const q = { table, where: {}, raws: [] };
    const self = {
      where(w) { if (w && typeof w === 'object') Object.assign(q.where, w); return self; },
      whereIn() { return self; }, whereNot() { return self; }, whereNull() { return self; }, whereNotNull() { return self; },
      whereRaw(sql, b) { q.raws.push([sql, b]); return self; },
      leftJoin() { return self; }, join() { return self; }, select() { return self; }, orderBy() { return self; }, forUpdate() { return self; },
      first: async (...cols) => state.read(table, q, cols),
      update: async (row) => { state.updates.push({ table, where: q.where, raws: q.raws, row }); return state.updateCount ?? 1; },
      insert: (row) => { state.inserts.push({ table, row }); return { onConflict: () => ({ ignore: () => ({ returning: async () => [] }) }), returning: async () => [] }; },
      delete: async () => 0,
      then: (res, rej) => Promise.resolve(state.list ? state.list(table, q) : []).then(res, rej),
    };
    return self;
  };
  conn.transaction = async (fn) => fn(conn);
  conn.raw = (sql, b) => ({ sql, b });
  return conn;
}

function baseState({ request, ledger = null, vendors = { 'v-siteone': SITEONE, 'v-sticker': STICKER } }) {
  const state = { updates: [], inserts: [], requests: { [request.id]: request } };
  state.read = (table, q, cols) => {
    if (table === 'product_restock_requests') return state.requests[q.where.id] || null;
    if (table === 'vendors') return vendors[q.where.id] || null;
    if (cols[0] === 'vo.status') return null; // findLiveAutoOrder: no order out
    if (table === 'vendor_order_emails') return null;
    if (table === 'vendor_orders') {
      return ledger;
    }
    if (table === 'products_catalog') return { id: 'p1', name: 'LESCO Crosscheck Plus', active: true, auto_reorder_enabled: true, inventory_unit: 'gal', inventory_on_hand: state.onHand ?? '1.3', low_stock_threshold: '1.5', reorder_quantity: '2', auto_reorder_vendor_id: 'v-siteone', analysis_n: null, analysis_p: null, product_type: 'insecticide', category: 'insecticide' };
    return null;
  };
  return state;
}

const request = (over = {}) => ({ id: 'r1', product_id: 'p1', status: 'open', source: 'auto_reorder', requested_quantity: '2', unit: 'gal', created_at: new Date(NOW.getTime() - 2 * 3600e3), metadata: { vendorId: 'v-siteone' }, ...over });
const MAC_REGISTRY = { siteone: { remoteRunner: 'mac' } };

const MAC_ENV_KEYS = ['SITEONE_ORDER_RUNNER', 'SITEONE_CDP_URL'];
const withEnv = (vals) => { for (const k of MAC_ENV_KEYS) delete process.env[k]; Object.assign(process.env, vals); };
afterEach(() => { for (const k of MAC_ENV_KEYS) delete process.env[k]; });

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_AUTO_ORDER = 'true';
  process.env.GATE_AUTO_ORDER_SITEONE = 'true';
});

describe('server with SITEONE_ORDER_RUNNER=mac', () => {
  test('reads the switch exactly', () => {
    const { siteoneRunsOnMac } = dispatch._internals;
    expect(siteoneRunsOnMac({ SITEONE_ORDER_RUNNER: 'mac' })).toBe(true);
    expect(siteoneRunsOnMac({ SITEONE_ORDER_RUNNER: ' MAC ' })).toBe(true);
    expect(siteoneRunsOnMac({})).toBe(false);
    expect(siteoneRunsOnMac({ SITEONE_ORDER_RUNNER: 'server' })).toBe(false);
  });

  test('an unknown SITEONE_ORDER_RUNNER value never loads the server adapter: the request goes to the office', async () => {
    for (const typo of ['server', 'macc', 'true', '   ']) {
      jest.clearAllMocks();
      process.env.SITEONE_ORDER_RUNNER = typo;
      expect(await dispatch.canAutoOrder({ vendor: SITEONE })).toBe(false);
      const state = baseState({ request: request() });
      const out = await dispatch.dispatchRestockOrder('r1', { conn: fakeConn(state), now: NOW, env: {} });
      expect(out).toMatchObject({ requestId: 'r1', skipped: 'adapter_unconfigured' });
      expect(state.inserts).toHaveLength(0);
      expect(autoReorder.ringRestockBell).toHaveBeenCalledTimes(1);
    }
    delete process.env.SITEONE_ORDER_RUNNER;
  });

  test('a fresh SiteOne request is not claimed and rings nothing', async () => {
    const state = baseState({ request: request() });
    const out = await dispatch.dispatchRestockOrder('r1', { conn: fakeConn(state), adapters: MAC_REGISTRY, now: NOW, env: {} });
    expect(out).toEqual({ requestId: 'r1', skipped: 'remote_runner' });
    expect(state.inserts).toHaveLength(0);
    expect(state.updates).toHaveLength(0);
    expect(autoReorder.ringRestockBell).not.toHaveBeenCalled();
  });

  test('a request the Mac missed for 30 h is marked handed off, then belled', async () => {
    const state = baseState({ request: request({ created_at: new Date(NOW.getTime() - 31 * 3600e3) }) });
    const out = await dispatch.dispatchRestockOrder('r1', { conn: fakeConn(state), adapters: MAC_REGISTRY, now: NOW, env: {} });
    expect(out).toMatchObject({ skipped: 'remote_runner', macHandedOff: true, belled: true });
    const mark = state.updates.find((u) => u.table === 'product_restock_requests');
    expect(mark.where).toEqual({ id: 'r1', status: 'open' });
    expect(JSON.parse(mark.row.metadata)).toEqual({ vendorId: 'v-siteone', macHandedOffAt: NOW.toISOString() });
    expect(autoReorder.lockProductPricing).toHaveBeenCalledWith(expect.anything(), 'p1');
    expect(autoReorder.ringRestockBell).toHaveBeenCalledTimes(1);
  });

  test('SITEONE_MAC_STALE_HOURS moves the line; a bad value keeps 30 h', async () => {
    const { macStaleMs } = dispatch._internals;
    expect(macStaleMs({ SITEONE_MAC_STALE_HOURS: '40' })).toBe(40 * 3600e3);
    expect(macStaleMs({ SITEONE_MAC_STALE_HOURS: 'x' })).toBe(30 * 3600e3);
    expect(macStaleMs({ SITEONE_MAC_STALE_HOURS: '-1' })).toBe(30 * 3600e3);
  });

  test('yesterday\'s dry-run park by the Mac (~23.7 h old at the 6:10 run) counts as a touch', async () => {
    const ledger = { id: 'l1', status: 'needs_review', error: 'dry_run: dry run', updated_at: new Date(NOW.getTime() - 23.7 * 3600e3) };
    const state = baseState({ request: request({ created_at: new Date(NOW.getTime() - 72 * 3600e3) }), ledger });
    const out = await dispatch.dispatchRestockOrder('r1', { conn: fakeConn(state), adapters: MAC_REGISTRY, now: NOW, env: {} });
    expect(out).toEqual({ requestId: 'r1', skipped: 'remote_runner' });
    expect(autoReorder.ringRestockBell).not.toHaveBeenCalled();
  });

  test('handing off a stale dry-run park withdraws its dry-run bell first', async () => {
    const ledger = { id: 'l1', status: 'needs_review', error: 'dry_run: dry run', updated_at: new Date(NOW.getTime() - 31 * 3600e3) };
    const state = baseState({ request: request({ created_at: new Date(NOW.getTime() - 72 * 3600e3) }), ledger });
    const out = await dispatch.dispatchRestockOrder('r1', { conn: fakeConn(state), adapters: MAC_REGISTRY, now: NOW, env: {} });
    expect(out).toMatchObject({ macHandedOff: true, belled: true });
    const tables = state.updates.map((u) => u.table);
    expect(tables.indexOf('notifications')).toBeGreaterThanOrEqual(0);
    expect(tables.indexOf('vendor_orders')).toBeGreaterThan(tables.indexOf('notifications'));
    expect(tables.indexOf('product_restock_requests')).toBeGreaterThan(tables.indexOf('vendor_orders'));
  });

  test('an old ledger row that is not a dry-run park is never handed to the office', async () => {
    const ledger = { id: 'l1', status: 'needs_review', error: 'no_price: no eligible price row', updated_at: new Date(NOW.getTime() - 72 * 3600e3) };
    const state = baseState({ request: request({ created_at: new Date(NOW.getTime() - 72 * 3600e3) }), ledger });
    const out = await dispatch.dispatchRestockOrder('r1', { conn: fakeConn(state), adapters: MAC_REGISTRY, now: NOW, env: {} });
    expect(out).toEqual({ requestId: 'r1', skipped: 'remote_runner' });
    expect(state.updates).toHaveLength(0);
    expect(autoReorder.ringRestockBell).not.toHaveBeenCalled();
  });

  test('a need that is gone is cancelled at the hand-off, never belled', async () => {
    const state = baseState({ request: request({ created_at: new Date(NOW.getTime() - 31 * 3600e3) }) });
    state.onHand = '1.8'; // a hand buy landed: above the 1.5 order point
    const out = await dispatch.dispatchRestockOrder('r1', { conn: fakeConn(state), adapters: MAC_REGISTRY, now: NOW, env: {} });
    expect(out).toEqual({ requestId: 'r1', skipped: 'stock_no_longer_low', cancelled: true });
    const cancel = state.updates.find((u) => u.table === 'product_restock_requests' && u.row.status === 'cancelled');
    expect(cancel).toBeTruthy();
    expect(JSON.parse(cancel.row.metadata).macHandedOffAt).toBeUndefined();
    expect(autoReorder.ringRestockBell).not.toHaveBeenCalled();
  });

  test('a fertilizer blackout or an order already out never stamps the hand-off', async () => {
    const blackout = require('../services/procurement/fertilizer-blackout');
    const spy = jest.spyOn(blackout, 'fertilizerBlackoutHold').mockReturnValue(true);
    try {
      const state = baseState({ request: request({ created_at: new Date(NOW.getTime() - 31 * 3600e3) }) });
      const out = await dispatch.dispatchRestockOrder('r1', { conn: fakeConn(state), adapters: MAC_REGISTRY, now: NOW, env: {} });
      expect(out).toEqual({ requestId: 'r1', skipped: 'remote_runner', held: 'fertilizer_blackout' });
      expect(state.updates).toHaveLength(0);
    } finally { spy.mockRestore(); }
    const state = baseState({ request: request({ created_at: new Date(NOW.getTime() - 31 * 3600e3) }) });
    const read = state.read;
    state.read = (table, q, cols) => (cols[0] === 'vo.status' ? { status: 'placed' } : read(table, q, cols));
    const out = await dispatch.dispatchRestockOrder('r1', { conn: fakeConn(state), adapters: MAC_REGISTRY, now: NOW, env: {} });
    expect(out).toEqual({ requestId: 'r1', skipped: 'remote_runner', autoOrderLive: true });
    expect(state.updates).toHaveLength(0);
    expect(autoReorder.ringRestockBell).not.toHaveBeenCalled();
  });

  test('a sibling request (a manual order of the same product) is a hold, not a missed run', async () => {
    const state = baseState({ request: request({ created_at: new Date(NOW.getTime() - 31 * 3600e3) }) });
    const read = state.read;
    state.read = (table, q, cols) => (table === 'product_restock_requests' && q.where.product_id === 'p1' ? { id: 'r-manual', source: 'manual', status: 'ordered' } : read(table, q, cols));
    const out = await dispatch.dispatchRestockOrder('r1', { conn: fakeConn(state), adapters: MAC_REGISTRY, now: NOW, env: {} });
    expect(out).toMatchObject({ requestId: 'r1', skipped: 'sibling_live_request' });
    expect(state.updates).toHaveLength(0);
    expect(autoReorder.ringRestockBell).not.toHaveBeenCalled();
  });

  test('a HANDED-OFF request blocked by a sibling manual order withdraws its standing "order manually" bell', async () => {
    const state = baseState({ request: request({ metadata: { vendorId: 'v-siteone', macHandedOffAt: '2026-11-24T11:10:00.000Z' } }) });
    const read = state.read;
    state.read = (table, q, cols) => (table === 'product_restock_requests' && q.where.product_id === 'p1' ? { id: 'r-manual', source: 'manual', status: 'ordered' } : read(table, q, cols));
    const out = await dispatch.dispatchRestockOrder('r1', { conn: fakeConn(state), adapters: MAC_REGISTRY, now: NOW, env: {} });
    expect(out).toMatchObject({ requestId: 'r1', skipped: 'sibling_live_request', handOffBellWithdrawn: true });
    expect(state.updates.filter((u) => u.table === 'notifications')).toHaveLength(1);
    expect(state.updates.filter((u) => u.table === 'product_restock_requests')).toHaveLength(0); // the stamp stays
    expect(autoReorder.ringRestockBell).not.toHaveBeenCalled();
  });

  test('with the SiteOne gate now off, a handed-off request blocked by a sibling still keeps its bell withdrawn', async () => {
    process.env.GATE_AUTO_ORDER_SITEONE = 'false';
    const state = baseState({ request: request({ metadata: { vendorId: 'v-siteone', macHandedOffAt: '2026-11-24T11:10:00.000Z' } }) });
    const read = state.read;
    state.read = (table, q, cols) => (table === 'product_restock_requests' && q.where.product_id === 'p1' ? { id: 'r-manual', source: 'manual', status: 'ordered' } : read(table, q, cols));
    const out = await dispatch.dispatchRestockOrder('r1', { conn: fakeConn(state), now: NOW, env: {} });
    expect(out).toMatchObject({ requestId: 'r1', handOffBellWithdrawn: true }); // the watchdog's blocker names the reason
    expect(autoReorder.ringRestockBell).not.toHaveBeenCalled();
  });

  test('a handed-off request whose need is gone is cancelled, not re-belled', async () => {
    const state = baseState({ request: request({ metadata: { vendorId: 'v-siteone', macHandedOffAt: '2026-11-24T11:10:00.000Z' } }) });
    state.onHand = '3';
    const out = await dispatch.dispatchRestockOrder('r1', { conn: fakeConn(state), adapters: MAC_REGISTRY, now: NOW, env: {} });
    expect(out).toEqual({ requestId: 'r1', skipped: 'stock_no_longer_low', cancelled: true, handOffBellWithdrawn: true });
    expect(autoReorder.ringRestockBell).not.toHaveBeenCalled();
  });

  test('an emailed order stops the watchdog before any cancel, even when the need is gone', async () => {
    const state = baseState({ request: request({ created_at: new Date(NOW.getTime() - 31 * 3600e3) }) });
    state.onHand = '3';
    const read = state.read;
    state.read = (table, q, cols) => (table === 'vendor_order_emails' ? { po: 'P1', status: 'sending' } : read(table, q, cols));
    // The race: the email sender claimed between the remote_runner claim transaction and this one.
    const out = await dispatch._internals.macWatchdog(fakeConn(state), 'r1', null, NOW, {});
    expect(out).toEqual({ emailOrderOut: true });
    expect(state.updates).toHaveLength(0);
  });

  test('a request already handed off is re-belled (deduped) without a second mark', async () => {
    const state = baseState({ request: request({ metadata: { vendorId: 'v-siteone', macHandedOffAt: '2026-11-24T11:10:00.000Z' } }) });
    const out = await dispatch.dispatchRestockOrder('r1', { conn: fakeConn(state), adapters: MAC_REGISTRY, now: NOW, env: {} });
    expect(out).toMatchObject({ skipped: 'remote_runner', macHandedOff: true });
    expect(state.updates.filter((u) => u.table === 'product_restock_requests')).toHaveLength(0);
    expect(autoReorder.ringRestockBell).toHaveBeenCalledTimes(1);
  });
});

describe('the Mac run', () => {
  test('never claims a request the watchdog handed to the office, and re-rings its hand-off', async () => {
    const place = jest.fn();
    const state = baseState({ request: request({ metadata: { vendorId: 'v-siteone', macHandedOffAt: NOW.toISOString() } }) });
    const out = await dispatch.dispatchRestockOrder('r1', { conn: fakeConn(state), adapters: { siteone: { quotesAtPlace: true, packagedQuantity: true, configured: () => true, place } }, now: NOW, env: {} });
    expect(out).toMatchObject({ requestId: 'r1', skipped: 'handed_to_office', macHandedOff: true, belled: true });
    expect(place).not.toHaveBeenCalled();
    expect(state.inserts).toHaveLength(0);
    // The hand-off bell is re-rung (request-id deduped), so a bell that failed to land is not lost.
    expect(autoReorder.ringRestockBell).toHaveBeenCalledTimes(1);
  });

  test('onlyAdapters skips another vendor\'s request; reconcile:false runs no reconciliation', async () => {
    process.env.GATE_AUTO_ORDER = 'false'; // every visited request is handed off with its bell: a visible count
    const state = baseState({ request: request() });
    state.requests.r2 = request({ id: 'r2', metadata: { vendorId: 'v-sticker' } });
    state.list = (table) => (table === 'product_restock_requests as prr' ? [{ id: 'r1' }, { id: 'r2' }] : []);
    const out = await dispatch.runVendorOrderDispatch({ conn: fakeConn(state), adapters: { siteone: {} }, onlyAdapters: ['siteone'], reconcile: false, now: NOW, env: {} });
    expect(out.results.map((r) => r.requestId)).toEqual(['r1']);
    expect(out.bells).toEqual({ rung: [], pending: [] });
    expect(autoReorder.ringRestockBell).toHaveBeenCalledTimes(1);
    expect(autoReorder.ringRestockBell.mock.calls[0][0].request.id).toBe('r1');
  });

  test('the vendor scope is re-applied to the LOCKED vendor: an edit after the pre-filter is out of scope, no hand-off bell', async () => {
    const state = baseState({ request: request() });
    const read = state.read;
    let vendorReads = 0;
    // The unlocked pre-filter sees SiteOne; the vendor was re-mapped before the claim's locked read.
    state.read = (table, q, cols) => (table === 'vendors' ? ((vendorReads += 1) === 1 ? SITEONE : STICKER) : read(table, q, cols));
    state.list = (table) => (table === 'product_restock_requests as prr' ? [{ id: 'r1' }] : []);
    const place = jest.fn();
    const out = await dispatch.runVendorOrderDispatch({ conn: fakeConn(state), adapters: { siteone: { place, configured: () => true, quotesAtPlace: true } }, onlyAdapters: ['siteone'], reconcile: false, now: NOW, env: {} });
    expect(out.results).toEqual([expect.objectContaining({ requestId: 'r1', skipped: 'out_of_scope' })]);
    expect(place).not.toHaveBeenCalled();
    expect(autoReorder.ringRestockBell).not.toHaveBeenCalled();
    expect(state.inserts).toHaveLength(0);
  });

  test('the PO number is short, upper case and built from the ledger id', () => {
    expect(dispatch._internals.poNumberFor({ id: '5488075d-1234-4abc-9def-000000000000' })).toBe('WAVES-5488075D');
  });

  test('the script refuses without SITEONE_CDP_URL', async () => {
    withEnv({ SITEONE_ORDER_RUNNER: 'mac' });
    await expect(macRun({ adapters: {}, runExclusive: jest.fn(), dispatch: jest.fn() })).rejects.toThrow(/SITEONE_CDP_URL/);
  });

  test('the script claims nothing when the live env hands SiteOne back to the server', async () => {
    const runDispatch = jest.fn();
    const exclusive = jest.fn();
    withEnv({ SITEONE_CDP_URL: 'http://127.0.0.1:9222' });
    await expect(macRun({ adapters: {}, runExclusive: exclusive, dispatch: runDispatch })).rejects.toThrow(/SITEONE_ORDER_RUNNER/);
    expect(exclusive).not.toHaveBeenCalled();
    expect(runDispatch).not.toHaveBeenCalled();
  });

  test('the default registry is the Chrome adapter and it loads', async () => {
    const runDispatch = jest.fn(async () => ({ results: [] }));
    withEnv({ SITEONE_ORDER_RUNNER: 'mac', SITEONE_CDP_URL: 'http://127.0.0.1:9222' });
    const cdp = require('../services/procurement/adapters/siteone-cdp');
    const spy = jest.spyOn(cdp, 'configured').mockReturnValue(true);
    await macRun({ runExclusive: async (n, fn) => fn(), dispatch: runDispatch });
    spy.mockRestore();
    const used = runDispatch.mock.calls[0][0].adapters.siteone;
    // The Chrome adapter, wrapped so every cap check re-reads the live Railway switches.
    expect(used).not.toBe(cdp);
    expect(typeof used.configured).toBe("function");
    expect(used.key).toBe(cdp.key);
    expect(used.quotesAtPlace).toBe(true);
    expect(cdp.packagedQuantity).toBe(true);
    expect(cdp.acceptsPoNumber).toBe(true);
    expect(typeof cdp.place).toBe('function');
  });

  test('the script dispatches SiteOne only, with no reconciliation, under its own lease', async () => {
    const runDispatch = jest.fn(async () => ({ results: [] }));
    const exclusive = jest.fn(async (name, fn) => fn());
    withEnv({ SITEONE_ORDER_RUNNER: 'mac', SITEONE_CDP_URL: 'http://127.0.0.1:9222' });
    await macRun({ adapters: { siteone: {} }, runExclusive: exclusive, dispatch: runDispatch });
    expect(exclusive.mock.calls[0][0]).toBe('siteone-mac-order');
    // The one env the adapter reads too: process.env itself, never a caller's copy.
    expect(runDispatch).toHaveBeenCalledWith({ adapters: { siteone: {} }, onlyAdapters: ['siteone'], reconcile: false, env: process.env });
    expect(runDispatch.mock.calls[0][0].env).toBe(process.env);
  });

  test('an unconfigured Mac adapter fails the run before any claim (no un-stamped hand-off)', async () => {
    withEnv({ SITEONE_ORDER_RUNNER: 'mac', SITEONE_CDP_URL: 'http://127.0.0.1:9222' });
    const runDispatch = jest.fn();
    const exclusive = jest.fn(async (n, fn) => fn());
    await expect(macRun({ adapters: { siteone: { configured: () => false } }, runExclusive: exclusive, dispatch: runDispatch })).rejects.toThrow(/not configured/);
    expect(runDispatch).not.toHaveBeenCalled();
  });

  test('every cap check re-reads the live Railway switches; off or changed is a run-level stop before the check', async () => {
    const launch = { SITEONE_BOT_DRY_RUN: 'false' };
    const on = { GATE_AUTO_ORDER: 'true', GATE_AUTO_ORDER_SITEONE: 'true', SITEONE_ORDER_RUNNER: 'mac', SITEONE_BOT_DRY_RUN: 'false' };
    expect(liveStopReason(on, launch)).toBeNull();
    expect(liveStopReason({ ...on, GATE_AUTO_ORDER_SITEONE: 'false' }, launch)).toMatch(/gate is off/);
    expect(liveStopReason({ ...on, GATE_AUTO_ORDER: '' }, launch)).toMatch(/gate is off/);
    expect(liveStopReason({ ...on, SITEONE_ORDER_RUNNER: '' }, launch)).toMatch(/no longer mac/);
    expect(liveStopReason({ ...on, SITEONE_BOT_DRY_RUN: 'true' }, launch)).toMatch(/changed since launch/);
    expect(liveStopReason({ ...on, SITEONE_BOT_DRY_RUN: 'false ' }, launch)).toMatch(/changed since launch/); // a dry run now: no trim
    expect(liveStopReason({ ...on, SITEONE_CART_ISOLATED: 'true' }, launch)).toMatch(/SITEONE_CART_ISOLATED changed/);
    const capped = { ...launch, AUTO_ORDER_MAX_PER_ORDER_CENTS: '35000', AUTO_ORDER_MAX_MONTHLY_CENTS: '40000' };
    const liveCapped = { ...on, AUTO_ORDER_MAX_PER_ORDER_CENTS: '35000', AUTO_ORDER_MAX_MONTHLY_CENTS: '40000' };
    expect(liveStopReason(liveCapped, capped)).toBeNull();
    expect(liveStopReason({ ...liveCapped, AUTO_ORDER_MAX_MONTHLY_CENTS: '10000' }, capped)).toMatch(/AUTO_ORDER_MAX_MONTHLY_CENTS changed/);
    expect(liveStopReason({ ...liveCapped, AUTO_ORDER_MAX_PER_ORDER_CENTS: '5000' }, capped)).toMatch(/AUTO_ORDER_MAX_PER_ORDER_CENTS changed/);

    let live = on;
    const cap = jest.fn(async () => ({ ok: true }));
    const inner = { quotesAtPlace: true, place: async (args) => { await args.beforeSubmit(100); live = { ...on, GATE_AUTO_ORDER_SITEONE: 'false' }; await args.beforeSubmit(200); return { placed: true }; } };
    const wrapped = withLiveSwitches(inner, { readLive: async () => live, launch });
    const err = await wrapped.place({ beforeSubmit: cap }).catch((e) => e);
    expect(err.runLevel).toBe(true);
    expect(err.message).toMatch(/gate is off/);
    expect(cap).toHaveBeenCalledTimes(1); // the second (final) check never reached the cap reservation

    const unreadable = withLiveSwitches(inner, { readLive: async () => { throw new Error('railway down'); }, launch });
    await expect(unreadable.place({ beforeSubmit: cap })).rejects.toThrow(/railway down/);
  });

  test('a held lease is a failure, not a silent day', async () => {
    const exclusive = jest.fn(async () => ({ skipped: true, reason: 'lease_held' }));
    withEnv({ SITEONE_ORDER_RUNNER: 'mac', SITEONE_CDP_URL: 'http://127.0.0.1:9222' });
    await expect(macRun({ adapters: { siteone: {} }, runExclusive: exclusive, dispatch: jest.fn() })).rejects.toThrow(/lease_held/);
  });
});
