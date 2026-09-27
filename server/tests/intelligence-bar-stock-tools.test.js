/**
 * Intelligence Bar stock tools (adjust_stock / create_restock_request /
 * update_restock_request) — behavior beyond the write-gate contract:
 * unit conversion, set_total physical-count seeding, double-receive guard,
 * and the exact mutations a confirmed call commits.
 *
 * Uses the same recording-knex-mock approach as
 * intelligence-bar-write-gate-contract.test.js.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.transaction = jest.fn();
  fn.raw = jest.fn();
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// resolveInventoryWriteTarget's operator-grounding fallback lazily requires
// this for its prior-turn lookup — stubbed here so the grounding-fallback
// tests below control threadsEnabled()/recentOperatorTurns() directly
// instead of touching a real thread.
jest.mock('../services/intelligence-bar/threads', () => ({
  threadsEnabled: jest.fn(() => false),
  recentOperatorTurns: jest.fn(async () => []),
}));
const dbMock = require('../models/db');
const { executeProcurementTool: executeRaw, resolveInventoryWriteTarget } = require('../services/intelligence-bar/procurement-tools');
const IbThreadsMock = require('../services/intelligence-bar/threads');

// Drive the server-owned preview/confirmation contract. A model-supplied
// confirmed flag alone is intentionally no longer an execution credential.
async function executeProcurementTool(name, input) {
  if (!input.confirmed) return executeRaw(name, input);
  const { confirmed, _verified_receive, ...fields } = input;
  const preview = await executeRaw(name, fields);
  if (preview.error) return preview;
  return executeRaw(name, { ...fields, product_id: preview.product?.id,
    _verified_inventory_version: _verified_receive ? 'stale-receive-version' : preview._version,
  }, { confirmed: true, isAdmin: true, technicianId: 'actor-1' });
}

function makeRecordingDb(seed = {}) {
  const mutations = [];
  const MUTATING_OPS = new Set(['insert', 'update', 'del', 'delete', 'increment', 'decrement', 'truncate', 'upsert']);
  const firstIndex = {};
  const tables = structuredClone(seed);
  let inserted = 0;

  function makeBuilder(table) {
    const rows = tables[table] || (tables[table] = []);
    const state = { single: false, result: null };
    const builder = new Proxy(function () {}, {
      get(_target, prop) {
        if (prop === 'then') {
          if (state.result) return resolve => resolve(state.result);
          if (state.single) {
            const i = firstIndex[table] || 0;
            firstIndex[table] = i + 1;
            return (resolve) => resolve(rows.length ? structuredClone(rows[i % rows.length]) : undefined);
          }
          return (resolve) => resolve(rows);
        }
        if (prop === 'first') {
          return () => { state.single = true; return builder; };
        }
        if (MUTATING_OPS.has(prop)) {
          return (...args) => {
            mutations.push({ table, op: String(prop), args });
            if (prop === 'insert') {
              const row = { id: `inserted-${++inserted}`, ...args[0] };
              rows.push(row); state.result = [structuredClone(row)];
            } else if (prop === 'update') {
              for (const row of rows) Object.assign(row, args[0]);
              state.result = structuredClone(rows);
            }
            return builder;
          };
        }
        return () => builder;
      },
    });
    return builder;
  }

  const db = (table) => makeBuilder(table);
  db.raw = (...args) => ({ __raw: args });
  db.transaction = async (cb) => { const trx = (table) => makeBuilder(table); trx.raw = db.raw; return cb(trx); };
  return { db, mutations };
}

function useDb(seed) {
  const { db, mutations } = makeRecordingDb(seed);
  dbMock.mockImplementation(db);
  dbMock.raw.mockImplementation(db.raw);
  dbMock.transaction.mockImplementation(db.transaction);
  return mutations;
}

const TRACKED_PRODUCT = {
  id: 'prod-1', name: 'Bifen XTS', category: 'insecticide',
  inventory_on_hand: 64, inventory_unit: 'fl_oz', low_stock_threshold: 32,
  best_vendor: 'SiteOne',
};
const UNTRACKED_PRODUCT = {
  id: 'prod-2', name: 'Prodiamine 65 WDG', category: 'herbicide',
  inventory_on_hand: null, inventory_unit: null, low_stock_threshold: null,
  best_vendor: null,
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('adjust_stock', () => {
  test('set_total physical count on an UNTRACKED product previews a seed (delta = full amount)', async () => {
    const mutations = useDb({ products_catalog: [UNTRACKED_PRODUCT] });
    const result = await executeProcurementTool('adjust_stock', {
      product_name: 'Prodiamine', movement_type: 'correction', set_total: 5, unit: 'lb',
    });
    expect(result.error).toBeUndefined();
    expect(result.preview).toBe(true);
    expect(result.was_untracked).toBe(true);
    expect(result.stock_before).toBe(0);
    expect(result.change).toBe(5);
    expect(result.stock_after).toBe(5);
    expect(result.unit).toBe('lb');
    expect(mutations).toEqual([]);
  });

  test('confirmed restock converts entered gallons into the fl_oz inventory unit and commits both writes', async () => {
    const mutations = useDb({ products_catalog: [TRACKED_PRODUCT] });
    const result = await executeProcurementTool('adjust_stock', {
      product_name: 'Bifen', movement_type: 'restock', quantity: 2, unit: 'gal', confirmed: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.stock_before).toBe(64);
    expect(result.change).toBe(256); // 2 gal = 256 fl_oz
    expect(result.stock_after).toBe(320);
    expect(result.unit).toBe('fl_oz');

    const update = mutations.find(m => m.table === 'products_catalog' && m.op === 'update');
    expect(update.args[0]).toMatchObject({ inventory_on_hand: 320, inventory_unit: 'fl_oz' });
    const movement = mutations.find(m => m.table === 'product_inventory_movements' && m.op === 'insert');
    expect(movement.args[0]).toMatchObject({
      product_id: 'prod-1', movement_type: 'restock', quantity: 256,
      unit: 'fl_oz', stock_before: 64, stock_after: 320,
    });
    expect(movement.args[0].metadata).toMatchObject({
      source: 'intelligence_bar_adjust_stock', enteredQuantity: 2, enteredUnit: 'gal',
    });
  });

  test('set_total 0 on an UNTRACKED product seeds tracking at zero (Codex P2)', async () => {
    const mutations = useDb({ products_catalog: [UNTRACKED_PRODUCT] });
    const result = await executeProcurementTool('adjust_stock', {
      product_name: 'Prodiamine', movement_type: 'correction', set_total: 0, unit: 'lb', confirmed: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.stock_after).toBe(0);

    const update = mutations.find(m => m.table === 'products_catalog' && m.op === 'update');
    expect(update.args[0]).toMatchObject({ inventory_on_hand: 0, inventory_unit: 'lb' });
    const movement = mutations.find(m => m.table === 'product_inventory_movements' && m.op === 'insert');
    expect(movement.args[0]).toMatchObject({ movement_type: 'correction', quantity: 0, stock_before: 0, stock_after: 0 });
  });

  test('a correction that lowers stock keeps its sign in the ledger quantity (Codex rd2 P2)', async () => {
    const mutations = useDb({ products_catalog: [TRACKED_PRODUCT] });
    const result = await executeProcurementTool('adjust_stock', {
      product_name: 'Bifen', movement_type: 'correction', set_total: 32, confirmed: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.stock_after).toBe(32);

    const movement = mutations.find(m => m.table === 'product_inventory_movements' && m.op === 'insert');
    expect(movement.args[0]).toMatchObject({
      movement_type: 'correction', quantity: -32, stock_before: 64, stock_after: 32,
    });
  });

  test('set_total equal to current stock on a TRACKED product is rejected as a no-op', async () => {
    const mutations = useDb({ products_catalog: [TRACKED_PRODUCT] });
    const result = await executeProcurementTool('adjust_stock', {
      product_name: 'Bifen', movement_type: 'correction', set_total: 64, confirmed: true,
    });
    expect(result.error).toMatch(/nothing to adjust/);
    expect(mutations).toEqual([]);
  });

  test('refuses a weight unit against a volume inventory unit', async () => {
    const mutations = useDb({ products_catalog: [TRACKED_PRODUCT] });
    const result = await executeProcurementTool('adjust_stock', {
      product_name: 'Bifen', movement_type: 'restock', quantity: 5, unit: 'lb',
    });
    expect(result.error).toMatch(/Cannot convert lb/);
    expect(mutations).toEqual([]);
  });

  test('rejects negative quantity for restock/damaged_lost and set_total outside correction', async () => {
    useDb({ products_catalog: [TRACKED_PRODUCT] });
    expect((await executeProcurementTool('adjust_stock', {
      product_name: 'Bifen', movement_type: 'restock', quantity: -3,
    })).error).toMatch(/positive/);
    expect((await executeProcurementTool('adjust_stock', {
      product_name: 'Bifen', movement_type: 'restock', set_total: 10,
    })).error).toMatch(/setTotal.*not allowed/);
    expect((await executeProcurementTool('adjust_stock', {
      product_name: 'Bifen', movement_type: 'correction', quantity: 4, set_total: 10,
    })).error).toMatch(/exclusive peers/);
  });

  test('ambiguous product name returns candidates without writing', async () => {
    const mutations = useDb({
      products_catalog: [
        TRACKED_PRODUCT,
        { ...TRACKED_PRODUCT, id: 'prod-3', name: 'Bifen IT' },
      ],
    });
    const result = await executeProcurementTool('adjust_stock', {
      product_name: 'Bifen', movement_type: 'restock', quantity: 32, confirmed: true,
    });
    expect(result.error).toMatch(/Multiple products match/);
    expect(result.candidates).toHaveLength(2);
    expect(mutations).toEqual([]);
  });
});

describe('query_stock', () => {
  test('zero on-hand counts as low stock even with no threshold set (Codex rd2 P2)', async () => {
    useDb({
      products_catalog: [
        { ...TRACKED_PRODUCT, id: 'prod-0', name: 'Talstar P', inventory_on_hand: 0, low_stock_threshold: null },
      ],
    });
    const result = await executeProcurementTool('query_stock', {});
    expect(result.error).toBeUndefined();
    const talstar = result.products.find(p => p.name === 'Talstar P');
    expect(talstar.tracked).toBe(true);
    expect(talstar.low_stock).toBe(true);
  });
});

describe('create_restock_request', () => {
  test('confirmed insert carries source intelligence_bar and defaults vendor/unit from the product', async () => {
    const mutations = useDb({ products_catalog: [TRACKED_PRODUCT] });
    const result = await executeProcurementTool('create_restock_request', {
      product_name: 'Bifen', quantity: 128, priority: 'high', confirmed: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    const insert = mutations.find(m => m.table === 'product_restock_requests' && m.op === 'insert');
    expect(insert.args[0]).toMatchObject({
      product_id: 'prod-1', status: 'open', priority: 'high',
      requested_quantity: 128, unit: 'fl_oz', vendor: 'SiteOne',
      source: 'intelligence_bar', current_stock: 64,
    });
  });

  test('a live request of any source (the sweep\'s here) under the product lock → reported, no twin inserted (Codex r9 P1)', async () => {
    const mutations = useDb({
      products_catalog: [TRACKED_PRODUCT],
      product_restock_requests: [{ id: 'req-auto', product_id: 'prod-1', status: 'open', source: 'auto_reorder', requested_quantity: 256, unit: 'fl_oz' }],
    });
    const result = await executeProcurementTool('create_restock_request', {
      product_name: 'Bifen', quantity: 128, priority: 'high', confirmed: true,
    });
    expect(result.error).toMatch(/already exists/);
    expect(result.existing_request).toMatchObject({ id: 'req-auto', source: 'auto_reorder', requested_quantity: 256 });
    expect(mutations.some(m => m.table === 'product_restock_requests' && m.op === 'insert')).toBe(false);
  });

  test('rejects a malformed needed_by date', async () => {
    const mutations = useDb({ products_catalog: [TRACKED_PRODUCT] });
    const result = await executeProcurementTool('create_restock_request', {
      product_name: 'Bifen', quantity: 128, needed_by: 'next tuesday',
    });
    expect(result.error).toMatch(/iso format/);
    expect(mutations).toEqual([]);
  });
});

describe('update_restock_request', () => {
  const OPEN_REQUEST = {
    id: 'req-1', product_id: 'prod-1', status: 'open', priority: 'normal',
    requested_quantity: 128, unit: 'fl_oz',
  };

  test('refuses to act on an already-received request (double-receive would double-add stock)', async () => {
    const mutations = useDb({
      products_catalog: [TRACKED_PRODUCT],
      product_restock_requests: [{ ...OPEN_REQUEST, status: 'received' }],
    });
    const result = await executeProcurementTool('update_restock_request', {
      request_id: 'req-1', action: 'receive', confirmed: true,
    });
    expect(result.error).toMatch(/already received/);
    expect(mutations).toEqual([]);
  });

  test('ONE more receive is admitted on a received request whose automatic order landed after that receipt — and settles the marker (Codex r27 P1)', async () => {
    const mutations = useDb({
      products_catalog: [TRACKED_PRODUCT],
      product_restock_requests: [{ ...OPEN_REQUEST, status: 'received' }],
      vendor_orders: [{ id: 'vo-9', status: 'needs_review', placed_at: new Date(), external_order_number: 'S1-9', evidence: { landedAfterReceive: '2026-09-05T01:00:00Z' } }],
    });
    const result = await executeProcurementTool('update_restock_request', {
      request_id: 'req-1', action: 'receive', confirmed: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.stock_after).toBe(192);
    const movement = mutations.find(m => m.table === 'product_inventory_movements' && m.op === 'insert');
    expect(movement.args[0].metadata).toMatchObject({ secondReceive: true });
    expect(mutations.some(m => m.table === 'vendor_orders' && m.op === 'update')).toBe(true); // evidence.landedAfterReceive comes off in the same transaction
  });

  test('a completed action retires the request\'s ledger bell; a refused receive (card amounts changed) keeps it (Codex r28 P2 + hook P1)', async () => {
    const ledger = { id: 'vo-3', status: 'needs_review', placed_at: null, evidence: {} };
    let mutations = useDb({ products_catalog: [TRACKED_PRODUCT], product_restock_requests: [OPEN_REQUEST], vendor_orders: [ledger] });
    let result = await executeProcurementTool('update_restock_request', { request_id: 'req-1', action: 'mark_ordered', confirmed: true });
    expect(result.success).toBe(true);
    expect(mutations.some(m => m.table === 'notifications' && m.op === 'update')).toBe(true);

    mutations = useDb({ products_catalog: [TRACKED_PRODUCT], product_restock_requests: [OPEN_REQUEST], vendor_orders: [ledger] });
    result = await executeProcurementTool('update_restock_request', { request_id: 'req-1', action: 'receive', confirmed: true, _verified_receive: { adds: 1, unit: 'fl_oz', stock_before: 64 } });
    expect(result.preview_changed).toBe(true);
    expect(mutations.some(m => m.table === 'notifications')).toBe(false);
  });

  test('a concurrent receive landing between pre-check and transaction is caught by the locked re-check (Codex P1)', async () => {
    // The rotating .first() mock serves the OPEN row to the unlocked
    // pre-check and the RECEIVED row to the in-transaction forUpdate
    // re-read — exactly the interleaving of two simultaneous confirms.
    const mutations = useDb({
      products_catalog: [TRACKED_PRODUCT],
      product_restock_requests: [OPEN_REQUEST, { ...OPEN_REQUEST, status: 'received' }],
    });
    const result = await executeProcurementTool('update_restock_request', {
      request_id: 'req-1', action: 'receive', confirmed: true,
    });
    expect(result.error).toMatch(/already received/);
    expect(mutations).toEqual([]);
  });

  test('confirmed receive adds stock, logs a restock movement, closes the request', async () => {
    const mutations = useDb({
      products_catalog: [TRACKED_PRODUCT],
      product_restock_requests: [OPEN_REQUEST],
    });
    const result = await executeProcurementTool('update_restock_request', {
      request_id: 'req-1', action: 'receive', confirmed: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.stock_before).toBe(64);
    expect(result.added).toBe(128);
    expect(result.stock_after).toBe(192);

    const productUpdate = mutations.find(m => m.table === 'products_catalog' && m.op === 'update');
    expect(productUpdate.args[0]).toMatchObject({ inventory_on_hand: 192, inventory_unit: 'fl_oz' });
    const movement = mutations.find(m => m.table === 'product_inventory_movements' && m.op === 'insert');
    expect(movement.args[0]).toMatchObject({
      movement_type: 'restock', quantity: 128, stock_before: 64, stock_after: 192,
    });
    expect(movement.args[0].metadata).toMatchObject({
      source: 'intelligence_bar_restock_receive', restockRequestId: 'req-1',
    });
    const requestUpdate = mutations.find(m => m.table === 'product_restock_requests' && m.op === 'update');
    expect(requestUpdate.args[0]).toMatchObject({ status: 'received' });

    expect(result).not.toHaveProperty('readiness_recheck');
    expect(mutations.some(m => m.table === 'admin_alerts')).toBe(false);
  });

  test('mark_ordered and cancel only touch the request row', async () => {
    const mutations = useDb({
      products_catalog: [TRACKED_PRODUCT],
      product_restock_requests: [OPEN_REQUEST],
    });
    const result = await executeProcurementTool('update_restock_request', {
      request_id: 'req-1', action: 'mark_ordered', confirmed: true,
    });
    expect(result.success).toBe(true);
    expect(result.status).toBe('ordered');
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toMatchObject({ table: 'product_restock_requests', op: 'update' });
  });
});

// ─── resolveInventoryWriteTarget: operator-grounding fallback ───────────
//
// Real voice-typed operator prompts from production (2026-09-25/26) miss the
// rigid grammar entirely ("We just bought a thing of Taurus... 78 ounces").
// This fallback still requires the OPERATOR's own words — this prompt, or
// (only when this prompt names nothing) their own recent prior turns on the
// same thread — to name exactly the product already in the preview. A
// dedicated db mock is used here (not makeRecordingDb, which ignores WHERE
// conditions) because these tests specifically assert active-only filtering.
describe('resolveInventoryWriteTarget: operator-grounding fallback', () => {
  // jest.clearAllMocks() (the file-level beforeEach) clears call history but
  // NOT a queued mockReturnValueOnce/mockResolvedValueOnce — a test whose
  // code path never reaches the thread check (update_restock_request, a
  // conflict, a non-bare follow-up, ...) leaves its queued "once" value
  // sitting there for a LATER test to consume by accident. Reset these two
  // back to a known default before every test in this block.
  beforeEach(() => {
    IbThreadsMock.threadsEnabled.mockReset().mockReturnValue(false);
    IbThreadsMock.recentOperatorTurns.mockReset().mockResolvedValue([]);
  });

  const TAURUS = { id: 'p-taurus', name: 'Taurus SC', active: true };
  const ALPINE = { id: 'p-alpine', name: 'Alpine WSG', active: true };
  const LESCO_FERTILIZER = { id: 'p-lesco-1', name: 'Lesco 24-5-11 Fertilizer', active: true };
  const LESCO_HERBICIDE = { id: 'p-lesco-2', name: 'Lesco Momentum FX2 Herbicide', active: true };
  const THREAD_ID = '11111111-1111-1111-1111-111111111111';

  // products_catalog needs to serve BOTH productsNamedIn's real ".where({
  // active: true }).select(...)" AND resolveProduct's exact/ILIKE lookup —
  // this mock actually implements the two predicates resolveProduct issues
  // (an exact lower/trim match, then a %contains% ILIKE) so a grammar match
  // that legitimately resolves does so directly, and a grammar match that
  // legitimately fails (e.g. a typo-mangled name) genuinely reaches the
  // fallback under test rather than an artifact of a dumb pass-through mock.
  function setGroundingDb({ products = [], aliases = [] } = {}) {
    function catalogBuilder() {
      let rows = [...products];
      let single = false;
      const api = {
        where(condOrCol, val) {
          if (condOrCol && typeof condOrCol === 'object') {
            rows = rows.filter((p) => Object.entries(condOrCol).every(([k, v]) => p[k] === v));
          } else if (arguments.length === 2) {
            rows = rows.filter((p) => p[condOrCol] === val);
          }
          return api;
        },
        whereRaw(sql, params) {
          if (/lower\(btrim\(name\)\)/i.test(sql)) {
            const target = String(params[0] || '').toLowerCase();
            rows = rows.filter((p) => String(p.name || '').trim().toLowerCase() === target);
          }
          return api;
        },
        whereILike(col, pattern) {
          const needle = String(pattern || '').replace(/^%|%$/g, '').toLowerCase();
          rows = rows.filter((p) => String(p[col] || '').toLowerCase().includes(needle));
          return api;
        },
        limit(n) { rows = rows.slice(0, n); return api; },
        first() { single = true; return api; },
        select() { return Promise.resolve(single ? rows[0] : rows.map((p) => ({ ...p }))); },
        then(resolve) { resolve(single ? rows[0] : rows.map((p) => ({ ...p }))); },
      };
      return api;
    }
    dbMock.mockImplementation((table) => {
      if (table === 'products_catalog') return catalogBuilder();
      if (table === 'product_aliases as pa') {
        return {
          join: () => ({
            where: (_col, activeVal) => ({
              select: async () => {
                const activeIds = new Set(products.filter((p) => p.active === activeVal).map((p) => p.id));
                return aliases.filter((a) => activeIds.has(a.product_id)).map((a) => ({ ...a }));
              },
            }),
          }),
        };
      }
      throw new Error(`Unhandled table in grounding-fallback mock: ${table}`);
    });
  }

  test('a real ungrammatical voice-typed prompt is allowed for the matching preview product (Taurus)', async () => {
    setGroundingDb({ products: [TAURUS, ALPINE] });
    const result = await resolveInventoryWriteTarget({
      toolName: 'adjust_stock',
      prompt: "We just bought a thing of Taurus as to add this to your inventory I think it's 78 ounces",
      preview: { product: { id: TAURUS.id, name: TAURUS.name } },
    });
    expect(result).toEqual({ productId: TAURUS.id });
  });

  test('a real ungrammatical voice-typed prompt is allowed for the matching preview product (Alpine WSG)', async () => {
    setGroundingDb({ products: [TAURUS, ALPINE] });
    const result = await resolveInventoryWriteTarget({
      toolName: 'adjust_stock',
      prompt: 'Could you add we added your purchase in the Alpine WSG can you add that to our inventory stock',
      preview: { product: { id: ALPINE.id, name: ALPINE.name } },
    });
    expect(result).toEqual({ productId: ALPINE.id });
  });

  test('a "Taurus ST" voice-typo grounds via the distinctive "taurus" token ("ST" is not a formulation code)', async () => {
    setGroundingDb({ products: [TAURUS, ALPINE] });
    const result = await resolveInventoryWriteTarget({
      toolName: 'adjust_stock',
      prompt: 'Can you add 12 fluid ounces of Taurus ST to our inventory',
      preview: { product: { id: TAURUS.id, name: TAURUS.name } },
    });
    expect(result).toEqual({ productId: TAURUS.id });
  });

  // "SE" IS a real formulation code (suspension emulsion), and the catalog
  // row is "Taurus SC" — so this is now a genuine formulation conflict, not
  // a typo to shrug off: the model should ask "did you mean Taurus SC?"
  // rather than silently ground a mistyped formulation onto the wrong one.
  test('"Taurus SE" refuses on a formulation conflict against the "Taurus SC" catalog row', async () => {
    setGroundingDb({ products: [TAURUS, ALPINE] });
    const result = await resolveInventoryWriteTarget({
      toolName: 'adjust_stock',
      prompt: 'Can you add 12 fluid ounces to the inventory of what we have on hand for Taurus SE',
      preview: { product: { id: TAURUS.id, name: TAURUS.name } },
    });
    expect(result).toMatchObject({ code: 'target_clarification_required' });
  });

  test('a follow-up naming nothing ("1 bottle") grounds off a recent prior OPERATOR turn', async () => {
    setGroundingDb({ products: [TAURUS, ALPINE] });
    IbThreadsMock.threadsEnabled.mockReturnValueOnce(true);
    IbThreadsMock.recentOperatorTurns.mockResolvedValueOnce([
      'Could you add we added your purchase in the Alpine WSG can you add that to our inventory stock',
    ]);
    const result = await resolveInventoryWriteTarget({
      toolName: 'adjust_stock', prompt: '1 bottle',
      preview: { product: { id: ALPINE.id, name: ALPINE.name } },
      actorId: 'actor-1', threadId: THREAD_ID,
    });
    expect(result).toEqual({ productId: ALPINE.id });
    expect(IbThreadsMock.recentOperatorTurns).toHaveBeenCalledWith('actor-1', THREAD_ID, { limit: 3, maxAgeMinutes: 30 });
  });

  test('a prior turn that only exists as ASSISTANT text never grounds (recentOperatorTurns already excludes it)', async () => {
    setGroundingDb({ products: [TAURUS, ALPINE] });
    IbThreadsMock.threadsEnabled.mockReturnValueOnce(true);
    // The real query filters role='user' — an assistant-only mention of
    // Alpine WSG never reaches this list (see intelligence-bar-threads-
    // operator-turns.test.js for the role filter itself).
    IbThreadsMock.recentOperatorTurns.mockResolvedValueOnce([]);
    const result = await resolveInventoryWriteTarget({
      toolName: 'adjust_stock', prompt: '1 bottle',
      preview: { product: { id: ALPINE.id, name: ALPINE.name } },
      actorId: 'actor-1', threadId: THREAD_ID,
    });
    expect(result).toMatchObject({ code: 'target_clarification_required' });
  });

  test('the current prompt naming a DIFFERENT product than the preview refuses as a mismatch', async () => {
    setGroundingDb({ products: [TAURUS, ALPINE] });
    const result = await resolveInventoryWriteTarget({
      toolName: 'adjust_stock',
      prompt: 'Add the Alpine WSG please',
      preview: { product: { id: TAURUS.id, name: TAURUS.name } },
    });
    expect(result).toMatchObject({ code: 'target_relationship_mismatch' });
  });

  test('the current prompt naming TWO products refuses as ambiguous (original clarification, unchanged)', async () => {
    setGroundingDb({ products: [TAURUS, ALPINE] });
    const result = await resolveInventoryWriteTarget({
      toolName: 'adjust_stock',
      prompt: 'We have Taurus SC and Alpine WSG here',
      preview: { product: { id: TAURUS.id, name: TAURUS.name } },
    });
    expect(result).toEqual({ error: 'Choose the exact product or restock request for this action.', code: 'target_clarification_required' });
  });

  test('"lesco" alone never resolves, even as the only word in the prompt (stoplisted, and shared by many products)', async () => {
    setGroundingDb({ products: [LESCO_FERTILIZER, LESCO_HERBICIDE] });
    const result = await resolveInventoryWriteTarget({
      toolName: 'adjust_stock',
      prompt: 'add some lesco to the inventory',
      preview: { product: { id: LESCO_FERTILIZER.id, name: LESCO_FERTILIZER.name } },
    });
    expect(result).toMatchObject({ code: 'target_clarification_required' });
  });

  test('an inactive product is never a valid grounding target, even naming it exactly', async () => {
    const inactiveTaurus = { ...TAURUS, active: false };
    setGroundingDb({ products: [inactiveTaurus, ALPINE] });
    const result = await resolveInventoryWriteTarget({
      toolName: 'adjust_stock',
      prompt: "We just bought a thing of Taurus... it's 78 ounces",
      preview: { product: { id: inactiveTaurus.id, name: inactiveTaurus.name } },
    });
    expect(result).toMatchObject({ code: 'target_clarification_required' });
  });

  test('update_restock_request stays strict: no fallback applies even with a thread available', async () => {
    setGroundingDb({ products: [ALPINE] });
    IbThreadsMock.threadsEnabled.mockReturnValueOnce(true);
    IbThreadsMock.recentOperatorTurns.mockResolvedValueOnce(['Alpine WSG']);
    const result = await resolveInventoryWriteTarget({
      toolName: 'update_restock_request',
      prompt: '1 bottle',
      preview: { product: { id: ALPINE.id, name: ALPINE.name }, request: { id: 'req-1' } },
      actorId: 'actor-1', threadId: THREAD_ID,
    });
    expect(result).toEqual({ error: 'Choose the exact product or restock request for this action.', code: 'target_clarification_required' });
    expect(IbThreadsMock.recentOperatorTurns).not.toHaveBeenCalled();
  });

  test('the existing rigid grammar still resolves directly with no fallback involved', async () => {
    setGroundingDb({ products: [TAURUS, ALPINE] });
    const result = await resolveInventoryWriteTarget({
      toolName: 'adjust_stock',
      prompt: 'restock Taurus SC',
      preview: { product: { id: TAURUS.id, name: TAURUS.name } },
    });
    expect(result).toEqual({ productId: TAURUS.id });
    expect(IbThreadsMock.recentOperatorTurns).not.toHaveBeenCalled();
  });

  test('a restock deadline that fails to split from the name refuses even when the prompt names the preview product (deadline branch never grounds)', async () => {
    setGroundingDb({ products: [TAURUS, ALPINE] });
    const result = await resolveInventoryWriteTarget({
      toolName: 'create_restock_request',
      prompt: 'request 2 lb of Taurus SC before next tuesday',
      preview: { product: { id: TAURUS.id, name: TAURUS.name } }, // no needed_by on the preview
    });
    expect(result).toEqual({ error: 'Choose the exact product or restock request for this action.', code: 'target_clarification_required' });
  });

  test('"Restock Unlisted Chemical" never borrows a prior turn\'s product (resolved.error site never allows prior turns)', async () => {
    setGroundingDb({ products: [TAURUS, ALPINE] });
    IbThreadsMock.threadsEnabled.mockReturnValueOnce(true);
    IbThreadsMock.recentOperatorTurns.mockResolvedValueOnce([
      'Could you add we added your purchase in the Alpine WSG can you add that to our inventory stock',
    ]);
    const result = await resolveInventoryWriteTarget({
      toolName: 'create_restock_request',
      prompt: 'Restock Unlisted Chemical',
      preview: { product: { id: ALPINE.id, name: ALPINE.name } },
      actorId: 'actor-1', threadId: THREAD_ID,
    });
    expect(result).toMatchObject({ code: 'target_clarification_required' });
    expect(IbThreadsMock.recentOperatorTurns).not.toHaveBeenCalled();
  });

  test('"we got a new jug of Unlisted Chemical" is not a bare follow-up, so it never borrows the prior turn either', async () => {
    setGroundingDb({ products: [TAURUS, ALPINE] });
    IbThreadsMock.threadsEnabled.mockReturnValueOnce(true);
    IbThreadsMock.recentOperatorTurns.mockResolvedValueOnce([
      'Could you add we added your purchase in the Alpine WSG can you add that to our inventory stock',
    ]);
    const result = await resolveInventoryWriteTarget({
      toolName: 'adjust_stock',
      prompt: 'we got a new jug of Unlisted Chemical',
      preview: { product: { id: ALPINE.id, name: ALPINE.name } },
      actorId: 'actor-1', threadId: THREAD_ID,
    });
    expect(result).toMatchObject({ code: 'target_clarification_required' });
    expect(IbThreadsMock.recentOperatorTurns).not.toHaveBeenCalled();
  });

  test('a bare "Yes" follow-up still grounds off a recent prior OPERATOR turn', async () => {
    setGroundingDb({ products: [TAURUS, ALPINE] });
    IbThreadsMock.threadsEnabled.mockReturnValueOnce(true);
    IbThreadsMock.recentOperatorTurns.mockResolvedValueOnce([
      'Could you add we added your purchase in the Alpine WSG can you add that to our inventory stock',
    ]);
    const result = await resolveInventoryWriteTarget({
      toolName: 'adjust_stock', prompt: 'Yes',
      preview: { product: { id: ALPINE.id, name: ALPINE.name } },
      actorId: 'actor-1', threadId: THREAD_ID,
    });
    expect(result).toEqual({ productId: ALPINE.id });
  });

  test('the deictic "this product" reference (no page context) never borrows a prior turn either', async () => {
    setGroundingDb({ products: [TAURUS, ALPINE] });
    IbThreadsMock.threadsEnabled.mockReturnValueOnce(true);
    IbThreadsMock.recentOperatorTurns.mockResolvedValueOnce([
      'Could you add we added your purchase in the Alpine WSG can you add that to our inventory stock',
    ]);
    const result = await resolveInventoryWriteTarget({
      toolName: 'adjust_stock',
      prompt: 'Add 2 lb of this product',
      pageData: { route: '/admin/customers' }, // not an inventory page — no page productId available
      preview: { product: { id: ALPINE.id, name: ALPINE.name } },
      actorId: 'actor-1', threadId: THREAD_ID,
    });
    expect(result).toMatchObject({ code: 'target_clarification_required' });
    expect(IbThreadsMock.recentOperatorTurns).not.toHaveBeenCalled();
  });

  // Concentration/formulation qualifiers: the catalog treats "10% SC" and
  // "20% SC" as different products, so a TOKEN or ALIAS match must not
  // ignore a qualifier the operator actually said. A full catalog-name match
  // is unaffected (it already has to include the qualifiers to match at
  // all) — only tested here at the token/alias sites.
  describe('concentration/formulation qualifiers', () => {
    const TAURUS_10 = { id: 'p-taurus-10', name: 'Taurus 10% SC', active: true };

    test('"Taurus 20% SC" refuses against a "Taurus 10% SC" catalog row (the audit regression case)', async () => {
      setGroundingDb({ products: [TAURUS_10, ALPINE] });
      const result = await resolveInventoryWriteTarget({
        toolName: 'adjust_stock',
        prompt: 'We bought Taurus 20% SC, add 12 oz',
        preview: { product: { id: TAURUS_10.id, name: TAURUS_10.name } },
      });
      expect(result).toMatchObject({ code: 'target_clarification_required' });
    });

    test('"Taurus 10% SC" grounds — the qualifier matches the catalog row exactly', async () => {
      setGroundingDb({ products: [TAURUS_10, ALPINE] });
      const result = await resolveInventoryWriteTarget({
        toolName: 'adjust_stock',
        prompt: 'We bought Taurus 10% SC, add 12 oz',
        preview: { product: { id: TAURUS_10.id, name: TAURUS_10.name } },
      });
      expect(result).toEqual({ productId: TAURUS_10.id });
    });

    test('a bare "Taurus" with no qualifier at all still grounds', async () => {
      setGroundingDb({ products: [TAURUS_10, ALPINE] });
      const result = await resolveInventoryWriteTarget({
        toolName: 'adjust_stock',
        prompt: 'we bought Taurus, add 12 oz',
        preview: { product: { id: TAURUS_10.id, name: TAURUS_10.name } },
      });
      expect(result).toEqual({ productId: TAURUS_10.id });
    });

    test('a bare number with no "%" is never a concentration ("Taurus 78 ounces")', async () => {
      setGroundingDb({ products: [TAURUS_10, ALPINE] });
      const result = await resolveInventoryWriteTarget({
        toolName: 'adjust_stock',
        prompt: 'Taurus 78 ounces',
        preview: { product: { id: TAURUS_10.id, name: TAURUS_10.name } },
      });
      expect(result).toEqual({ productId: TAURUS_10.id });
    });

    test('an ALIAS match followed by a conflicting formulation/concentration also refuses', async () => {
      setGroundingDb({
        products: [TAURUS, ALPINE], // "Taurus SC" — no concentration in the name at all
        aliases: [{ product_id: TAURUS.id, alias_name: 'Taurus Termiticide' }],
      });
      const result = await resolveInventoryWriteTarget({
        toolName: 'adjust_stock',
        prompt: 'We need Taurus Termiticide 20% SC for the job',
        preview: { product: { id: TAURUS.id, name: TAURUS.name } },
      });
      expect(result).toMatchObject({ code: 'target_clarification_required' });
    });

    test('a qualifier conflict found only in a prior turn also refuses a bare follow-up', async () => {
      setGroundingDb({ products: [TAURUS_10, ALPINE] });
      IbThreadsMock.threadsEnabled.mockReturnValueOnce(true);
      IbThreadsMock.recentOperatorTurns.mockResolvedValueOnce(['we bought Taurus 20% SC yesterday']);
      const result = await resolveInventoryWriteTarget({
        toolName: 'adjust_stock', prompt: '1 bottle',
        preview: { product: { id: TAURUS_10.id, name: TAURUS_10.name } },
        actorId: 'actor-1', threadId: THREAD_ID,
      });
      expect(result).toMatchObject({ code: 'target_clarification_required' });
    });
  });
});
