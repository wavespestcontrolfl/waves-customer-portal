// House bifenthrin swap, migration 20261119010000 (owner 2026-11-18): Atticus Talak 7.9 F -> LESCO Crosscheck Plus for new work.
// Synthetic data only. No database: a small in-memory fake knex (tables as arrays; jsonb columns parse on write like pg).
//
// Pinned: protocol rows move link + name only; services.default_products swaps in place (order kept); aliases move or are added
// only where the spelling does not already resolve; the Crosscheck catalog row fills only NULL columns, and its old EPA number
// 279-3206-10404 becomes 10404-120; the Talak row and every price and cost column stay untouched (cost_per_unit would override
// package costing); service_product_usage rows on Talak move to Crosscheck, and where the service type already maps Crosscheck the
// Talak row is removed (its whole row in the audit event) so the cost counts once; a second run changes nothing; down restores
// exactly what up wrote and keeps anything edited since, guarded in the write itself; a missing product makes the dependent steps
// a no-op; every audit action fits its column; audit_log is append-only (down appends one rollback event per reversed up event
// and deletes none).
const { isDeepStrictEqual } = require('util');
const migration = require('../models/migrations/20261119010000_house_bifenthrin_crosscheck');

const TALAK = 'aaaaaaaa-0000-4000-8000-000000000001';
const CROSS = 'bbbbbbbb-0000-4000-8000-000000000002';
const OTHER = 'cccccccc-0000-4000-8000-000000000003';
const JSON_COLUMNS = {
  services: ['default_products'], products_catalog: ['application_zones', 'target_pests', 'service_lines'], lawn_protocol_products: ['gates'],
};

// `defaults`: column defaults an insert takes, as Postgres applies them (production's products_catalog defaults, read 2026-11-18).
function makeKnex(initial, { columns = {}, defaults = {} } = {}) {
  const tables = JSON.parse(JSON.stringify(initial));
  let counter = 0;
  // A JSON string compared with a parsed jsonb value matches by content, as jsonb equality does in Postgres.
  const sameJson = (value, text) => { try { return isDeepStrictEqual(value, JSON.parse(text)); } catch { return false; } };
  const eq = (value, v) => (value && typeof value === 'object' && typeof v === 'string' ? sameJson(value, v) : String(value) === String(v) || value === v);
  const matches = (row, filters) => filters.every((f) => {
    if (f.type === 'eq') return Object.entries(f.obj).every(([k, v]) => (v == null ? row[k] == null : eq(row[k], v)));
    if (f.type === 'in') return f.values.map(String).includes(String(row[f.col]));
    return row[f.col] == null;
  });
  const coerce = (table, patch) => {
    const out = { ...patch };
    for (const col of JSON_COLUMNS[table] || []) if (typeof out[col] === 'string') out[col] = JSON.parse(out[col]);
    return out;
  };
  const clone = (row) => JSON.parse(JSON.stringify(row));
  // Every FOR UPDATE read, as [table, filters]: the reads that decide a delete or a move must lock what they read.
  const locks = [];
  // The product_id foreign keys, as Postgres enforces them: a write naming a catalog row that does not exist throws.
  const FK_TABLES = new Set(['lawn_protocol_products', 'product_aliases', 'service_product_usage']);
  const checkForeignKey = (table, values) => {
    if (!FK_TABLES.has(table) || values.product_id == null) return;
    if (!(tables.products_catalog || []).some((row) => String(row.id) === String(values.product_id))) {
      throw new Error(`insert or update on table "${table}" violates foreign key constraint (product_id ${values.product_id})`);
    }
  };
  function builder(table) {
    const filters = [];
    const rows = () => (tables[table] || []).filter((row) => matches(row, filters));
    const b = {
      where(a, v) { filters.push({ type: 'eq', obj: typeof a === 'object' ? a : { [a]: v } }); return b; },
      whereIn(col, values) { filters.push({ type: 'in', col, values }); return b; },
      whereNull(col) { filters.push({ type: 'null', col }); return b; },
      select() { return b; },
      forUpdate() { locks.push([table, JSON.parse(JSON.stringify(filters))]); return b; },
      first() { return Promise.resolve(rows().map(clone)[0]); },
      then(resolve, reject) { return Promise.resolve(rows().map(clone)).then(resolve, reject); },
      update(patch) {
        const hit = rows();
        if (hit.length) checkForeignKey(table, patch);
        hit.forEach((row) => Object.assign(row, coerce(table, patch)));
        return Promise.resolve(hit.length);
      },
      del() { const hit = rows(); tables[table] = tables[table].filter((row) => !hit.includes(row)); return Promise.resolve(hit.length); },
      insert(row) {
        checkForeignKey(table, row);
        counter += 1;
        const made = { id: `gen-${counter}`, ...(defaults[table] || {}), ...coerce(table, row) };
        tables[table].push(made);
        const done = Promise.resolve([made.id]);
        done.returning = () => Promise.resolve([{ id: made.id }]);
        return done;
      },
    };
    return b;
  }
  const knex = (table) => builder(table);
  knex.schema = {
    hasTable: async (table) => Object.prototype.hasOwnProperty.call(tables, table),
    hasColumn: async (table, column) => (columns[table] ? columns[table].includes(column) : (tables[table] || []).some((row) => column in row)),
  };
  knex.fn = { now: () => 'now()' };
  knex.tables = tables;
  knex.locks = locks;
  return knex;
}

const baseCatalog = () => [
  { id: TALAK, name: 'Atticus Talak 7.9 F', best_price: 41.57, cost_per_unit: 0.43, public_summary: 'talak summary', approved_for_public_page: true },
  {
    id: CROSS, name: 'LESCO Crosscheck Plus', best_price: 57.17, needs_pricing: false, inventory_on_hand: 12, formulation: 'SC',
    reentry_text: null, pet_kid_guidance_text: null, customer_safety_summary: null, common_name: null, public_summary: null, portal_summary: null,
    application_zones: null, customer_visibility: null, content_status: null, product_type: null, signal_word: null,
    cost_per_unit: null, cost_unit: null, inventory_unit: null, low_stock_threshold: null, default_rate_per_1000: '0.1800',
    approved_for_estimate_packet: false, approved_for_public_page: false,
    // The number migration 20260712100000 backfills on a repo-built catalog; production holds 10404-120.
    epa_reg_number: '279-3206-10404',
  },
  { id: OTHER, name: 'Taurus SC' },
];
const baseTables = () => ({
  products_catalog: baseCatalog(),
  lawn_protocols: [{ id: 'p1' }, { id: 'p2' }],
  lawn_protocol_windows: [
    { id: 'w1', lawn_protocol_id: 'p1' }, { id: 'w2', lawn_protocol_id: 'p1' }, { id: 'w3', lawn_protocol_id: 'p2' },
  ],
  lawn_protocol_products: [
    { id: 'r1', lawn_protocol_window_id: 'w1', product_id: TALAK, product_name: 'Atticus Talak 7.9 F', role: 'insecticide_spot', rate_per_1000: 1, updated_at: 't0' },
    { id: 'r2', lawn_protocol_window_id: 'w2', product_id: TALAK, product_name: 'Atticus Talak 7.9 F', role: 'insect_curative', rate_per_1000: 0.5, updated_at: 't0' },
    { id: 'r3', lawn_protocol_window_id: 'w3', product_id: TALAK, product_name: 'Atticus Talak 7.9 F', role: 'insecticide_spot', rate_per_1000: 1, updated_at: 't0' },
    { id: 'r4', lawn_protocol_window_id: 'w3', product_id: OTHER, product_name: 'Taurus SC', role: 'x', rate_per_1000: 2, updated_at: 't0' },
  ],
  lawn_protocol_audit_log: [],
  audit_log: [],
  services: [
    { id: 's1', name: 'Monthly Mosquito Control Service', default_products: ['Scion Insecticide', 'Atticus Talak 7.9 F', 'Tekko Pro IGR'] },
    { id: 's2', name: 'Slab Pre-Treat Termite Service', default_products: ['Atticus Talak 7.9 F'] },
    { id: 's3', name: 'Already Listed Service', default_products: ['LESCO Crosscheck Plus', 'Atticus Talak 7.9 F'] },
    { id: 's4', name: 'Lawn Service', default_products: ['Celsius WG'] },
    { id: 's5', name: 'No Products Service', default_products: null },
  ],
  product_aliases: [
    { id: 'a1', product_id: TALAK, alias_name: 'Talstar P', vendor_id: null },
    { id: 'a2', product_id: TALAK, alias_name: 'Bifen I/T', vendor_id: null },
    { id: 'a3', product_id: TALAK, alias_name: 'bifen it', vendor_id: null },
    { id: 'a4', product_id: TALAK, alias_name: 'Bifen I/T 7.9%', vendor_id: null },
    { id: 'a5', product_id: TALAK, alias_name: 'Talak 7.9 F', vendor_id: null },
    { id: 'a6', product_id: OTHER, alias_name: 'Cross Check Plus', vendor_id: null },
  ],
  service_product_usage: [
    { id: 'u1', product_id: TALAK, service_type: 'Mosquito', usage_amount: 1 },
    { id: 'u2', product_id: TALAK, service_type: 'Already Mapped', usage_amount: 2 },
    { id: 'u3', product_id: CROSS, service_type: 'Already Mapped', usage_amount: 2 },
    { id: 'u4', product_id: OTHER, service_type: 'Mosquito', usage_amount: 3 },
  ],
});
const snapshot = (knex) => JSON.parse(JSON.stringify(knex.tables));
// Row order is not data: a row down() inserts back lands at the end of its table.
const byIdOrder = (tables) => Object.fromEntries(Object.entries(tables).map(([table, rows]) => [table, [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)))]));
const byId = (knex, table, id) => knex.tables[table].find((row) => row.id === id);
const meta = (row) => (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata);
const eventsOf = (knex, action) => knex.tables.audit_log.filter((row) => row.action === action);
const rollbacksOf = (knex, step) => eventsOf(knex, migration.rollbackActionFor(step));

describe('house bifenthrin crosscheck migration: names', () => {
  test('the migration name and every audit action fit their columns', () => {
    expect(migration.MIGRATION.length).toBeLessThanOrEqual(57);
    expect(migration.LAWN_ACTION.length).toBeLessThanOrEqual(40);
    for (const step of Object.values(migration.STEPS)) {
      expect(migration.actionFor(step).length).toBeLessThanOrEqual(96);
      expect(migration.rollbackActionFor(step).length).toBeLessThanOrEqual(96);
    }
  });
});

describe('house bifenthrin crosscheck migration: up', () => {
  let knex;
  let logSpy;
  beforeEach(() => { knex = makeKnex(baseTables()); logSpy = jest.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => logSpy.mockRestore());

  test('protocol rows take the Crosscheck link and name and nothing else; one audit row per protocol', async () => {
    await migration.up(knex);
    for (const id of ['r1', 'r2', 'r3']) {
      const row = byId(knex, 'lawn_protocol_products', id);
      expect(row.product_id).toBe(CROSS);
      expect(row.product_name).toBe('LESCO Crosscheck Plus');
      expect(row.updated_at).toBe('t0');
    }
    expect(byId(knex, 'lawn_protocol_products', 'r1')).toMatchObject({ role: 'insecticide_spot', rate_per_1000: 1 });
    expect(byId(knex, 'lawn_protocol_products', 'r4')).toMatchObject({ product_id: OTHER, product_name: 'Taurus SC' });
    const logs = knex.tables.lawn_protocol_audit_log;
    expect(logs.map((log) => log.lawn_protocol_id).sort()).toEqual(['p1', 'p2']);
    expect(logs.every((log) => log.action === migration.LAWN_ACTION)).toBe(true);
  });

  test('services.default_products swaps in place, keeps order, and never duplicates an existing Crosscheck', async () => {
    await migration.up(knex);
    expect(byId(knex, 'services', 's1').default_products).toEqual(['Scion Insecticide', 'LESCO Crosscheck Plus', 'Tekko Pro IGR']);
    expect(byId(knex, 'services', 's2').default_products).toEqual(['LESCO Crosscheck Plus']);
    expect(byId(knex, 'services', 's3').default_products).toEqual(['LESCO Crosscheck Plus']);
    expect(byId(knex, 'services', 's4').default_products).toEqual(['Celsius WG']);
    expect(byId(knex, 'services', 's5').default_products).toBeNull();
    const events = eventsOf(knex, migration.actionFor('services'));
    expect(events).toHaveLength(3);
    expect(events.find((row) => row.resource_id === 's1')).toMatchObject({ actor_type: 'system', resource_type: 'services' });
    expect(meta(events.find((row) => row.resource_id === 's1'))).toMatchObject({
      migration: migration.MIGRATION,
      before: ['Scion Insecticide', 'Atticus Talak 7.9 F', 'Tekko Pro IGR'],
      after: ['Scion Insecticide', 'LESCO Crosscheck Plus', 'Tekko Pro IGR'],
    });
  });

  test('services: an array edited after the read is not overwritten', async () => {
    const original = makeKnex(baseTables());
    // Simulate an office edit landing between the read and the write: the guarded update must match nothing.
    const wrapped = (table) => {
      const b = original(table);
      if (table !== 'services') return b;
      const update = b.update.bind(b);
      b.update = (patch) => { byId(original, 'services', 's2').default_products = ['Office Pick']; return update(patch); };
      return b;
    };
    Object.assign(wrapped, { schema: original.schema, fn: original.fn, tables: original.tables });
    await migration.up(wrapped);
    expect(byId(original, 'services', 's2').default_products).toEqual(['Office Pick']);
    expect(eventsOf(original, migration.actionFor('services')).map((row) => row.resource_id)).not.toContain('s2');
  });

  test('aliases: one audit event per moved or added alias', async () => {
    await migration.up(knex);
    const events = eventsOf(knex, migration.actionFor('aliases'));
    expect(events.map((row) => meta(row).kind).sort()).toEqual(['inserted', 'moved', 'moved', 'moved', 'moved']);
    expect(events.every((row) => row.resource_type === 'product_aliases')).toBe(true);
    expect(meta(events.find((row) => row.resource_id === 'a1'))).toMatchObject({ kind: 'moved', alias_name: 'Talstar P', from: TALAK, to: CROSS });
  });

  test('aliases: the four office names move, Talak-named stay, only unresolved spellings are added', async () => {
    await migration.up(knex);
    for (const id of ['a1', 'a2', 'a3', 'a4']) expect(byId(knex, 'product_aliases', id).product_id).toBe(CROSS);
    expect(byId(knex, 'product_aliases', 'a5').product_id).toBe(TALAK);
    expect(byId(knex, 'product_aliases', 'a6').product_id).toBe(OTHER);
    const added = knex.tables.product_aliases.filter((row) => !['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].includes(row.id));
    // 'Cross Check Plus' already resolves (another product); 'CrossCheck Plus' equals 'Crosscheck Plus' and 'LESCO CrossCheck Plus'
    // equals the catalog name when compared the way readers compare.
    expect(added.map((row) => row.alias_name)).toEqual(['Crosscheck Plus']);
    expect(added[0]).toMatchObject({ product_id: CROSS, vendor_id: null });
  });

  test('an office name both products carry: the Talak row goes, whole, into its event, so one name resolves to one product', async () => {
    const tables = baseTables();
    tables.product_aliases.push({ id: 'a7', product_id: CROSS, alias_name: 'Talstar P', vendor_id: null });
    knex = makeKnex(tables);
    await migration.up(knex);
    expect(byId(knex, 'product_aliases', 'a1')).toBeUndefined();
    expect(knex.tables.product_aliases.filter((row) => row.alias_name === 'Talstar P').map((row) => row.product_id)).toEqual([CROSS]);
    expect(byId(knex, 'product_aliases', 'a2').product_id).toBe(CROSS);
    const removed = eventsOf(knex, migration.actionFor(migration.STEPS.aliases)).find((row) => meta(row).kind === 'removed');
    expect(removed.resource_id).toBe('a1');
    expect(meta(removed).row).toEqual({ id: 'a1', product_id: TALAK, alias_name: 'Talstar P', vendor_id: null });
    // down() puts it back on Talak, exactly as it was.
    await migration.down(knex);
    expect(byId(knex, 'product_aliases', 'a1')).toEqual({ id: 'a1', product_id: TALAK, alias_name: 'Talstar P', vendor_id: null });
  });

  test('the reads that decide a move or a delete lock what they read (FOR UPDATE), each scoped to the two products', async () => {
    await migration.up(knex);
    const locked = Object.fromEntries(knex.locks.map(([table, filters]) => [table, filters]));
    expect(Object.keys(locked).sort()).toEqual(['lawn_protocol_products', 'product_aliases', 'service_product_usage']);
    expect(locked.service_product_usage).toEqual([{ type: 'in', col: 'product_id', values: [TALAK, CROSS] }]);
    expect(locked.product_aliases).toEqual([{ type: 'in', col: 'product_id', values: [TALAK, CROSS] }]);
    expect(locked.lawn_protocol_products).toEqual([{ type: 'eq', obj: { product_id: TALAK } }]);
  });

  test('catalog: fills only NULL columns on the Crosscheck row; prices, cost, stock and the Talak row stay', async () => {
    await migration.up(knex);
    const row = byId(knex, 'products_catalog', CROSS);
    expect(row).toMatchObject({
      reentry_text: 'People and pets are kept off treated surfaces until the spray has dried.',
      pet_kid_guidance_text: 'Keep people and pets off treated areas until dry.',
      common_name: 'Bifenthrin perimeter insecticide',
      application_zones: ['exterior perimeter', 'foundation', 'lawn edge'],
      customer_visibility: 'portal_only',
      content_status: 'approved_for_portal',
      product_type: 'pesticide',
      signal_word: 'CAUTION',
      // Never filled: inventory-cost.js prices by cost_per_unit before best_price / unit_size_oz.
      cost_per_unit: null,
      cost_unit: null,
      epa_reg_number: '10404-120',
      inventory_unit: 'fl_oz',
      low_stock_threshold: 128,
      default_rate_per_1000: 0.5,
      approved_for_estimate_packet: true,
      approved_for_public_page: true,
      formulation: 'SC',
      best_price: 57.17,
      needs_pricing: false,
      inventory_on_hand: 12,
    });
    expect(byId(knex, 'products_catalog', TALAK)).toEqual(baseCatalog()[0]);
  });

  test('catalog: a column that already holds a value is left alone', async () => {
    const tables = baseTables();
    Object.assign(tables.products_catalog[1], { public_summary: 'office wording', default_rate_per_1000: '0.2500', cost_per_unit: 0.3, cost_unit: 'oz', approved_for_public_page: true });
    knex = makeKnex(tables);
    await migration.up(knex);
    expect(byId(knex, 'products_catalog', CROSS)).toMatchObject({
      public_summary: 'office wording', default_rate_per_1000: '0.2500', cost_per_unit: 0.3, cost_unit: 'oz', approved_for_public_page: true, approved_for_estimate_packet: true,
    });
  });

  test('catalog: a column the table does not have is skipped, and the cost columns stay empty where they exist', async () => {
    knex = makeKnex(baseTables(), { columns: { products_catalog: ['id', 'name', 'reentry_text', 'best_price', 'cost_per_unit', 'cost_unit'], services: ['id', 'name', 'default_products'] } });
    await migration.up(knex);
    const row = byId(knex, 'products_catalog', CROSS);
    expect(row.reentry_text).toBe('People and pets are kept off treated surfaces until the spray has dried.');
    expect(row.signal_word).toBeNull();
    expect(row.cost_per_unit).toBeNull();
    expect(row.cost_unit).toBeNull();
  });

  test('catalog: only the old EPA number 279-3206-10404 changes; 10404-120 and any other value stay', async () => {
    for (const held of ['10404-120', 'office typed', null]) {
      const tables = baseTables();
      tables.products_catalog[1].epa_reg_number = held;
      knex = makeKnex(tables);
      await migration.up(knex);
      expect(byId(knex, 'products_catalog', CROSS).epa_reg_number).toBe(held);
      const [event] = eventsOf(knex, migration.actionFor('catalog'));
      expect(Object.keys(meta(event).changes)).not.toContain('epa_reg_number');
    }
    knex = makeKnex(baseTables());
    await migration.up(knex);
    const [event] = eventsOf(knex, migration.actionFor('catalog'));
    expect(meta(event).changes.epa_reg_number).toEqual({ before: '279-3206-10404', after: '10404-120' });
  });

  test('service_product_usage: a Talak row moves to Crosscheck; where the service type already maps Crosscheck the Talak row goes, so the cost counts once', async () => {
    await migration.up(knex);
    expect(byId(knex, 'service_product_usage', 'u1')).toMatchObject({ product_id: CROSS, service_type: 'Mosquito', usage_amount: 1 });
    expect(byId(knex, 'service_product_usage', 'u2')).toBeUndefined();
    expect(knex.tables.service_product_usage.filter((row) => row.service_type === 'Already Mapped').map((row) => row.id)).toEqual(['u3']);
    expect(byId(knex, 'service_product_usage', 'u4').product_id).toBe(OTHER);
    const audits = eventsOf(knex, migration.actionFor('usage'));
    expect(audits.map((row) => row.resource_id).sort()).toEqual(['u1', 'u2']);
    expect(audits.every((row) => row.resource_type === 'service_product_usage')).toBe(true);
    expect(meta(audits.find((row) => row.resource_id === 'u1'))).toMatchObject({ kind: 'moved', service_type: 'Mosquito', from: TALAK, to: CROSS });
    // The whole row, so down() can put it back exactly.
    expect(meta(audits.find((row) => row.resource_id === 'u2'))).toMatchObject({
      kind: 'removed', service_type: 'Already Mapped', row: { id: 'u2', product_id: TALAK, service_type: 'Already Mapped', usage_amount: 2 },
    });
  });

  test('a second run changes nothing', async () => {
    await migration.up(knex);
    const after = snapshot(knex);
    await migration.up(knex);
    expect(snapshot(knex)).toEqual(after);
  });

  test('a repo-built catalog names the bottle Atticus Talak: the fallback name is found', async () => {
    const tables = baseTables();
    tables.products_catalog[0].name = 'Atticus Talak';
    tables.services[0].default_products = ['Atticus Talak'];
    knex = makeKnex(tables);
    await migration.up(knex);
    expect(byId(knex, 'lawn_protocol_products', 'r1').product_id).toBe(CROSS);
    expect(byId(knex, 'services', 's1').default_products).toEqual(['LESCO Crosscheck Plus']);
  });

  test('a repo-built catalog with both Talak names: the links on each move, and down returns each to its own row', async () => {
    const SHORT = 'dddddddd-0000-4000-8000-000000000004';
    const tables = baseTables();
    tables.products_catalog.push({ id: SHORT, name: 'Atticus Talak' });
    tables.lawn_protocol_products.push({ id: 'r5', lawn_protocol_window_id: 'w1', product_id: SHORT, product_name: 'Atticus Talak', role: 'x', rate_per_1000: 1, updated_at: 't0' });
    tables.services.push({ id: 's6', name: 'Mosquito Seed Service', default_products: ['Atticus Talak', 'Scion Insecticide'] });
    tables.product_aliases.push({ id: 'a7', product_id: SHORT, alias_name: 'Talstar P', vendor_id: null });
    tables.service_product_usage.push(
      { id: 'u5', product_id: SHORT, service_type: 'Mosquito Treatment - Essential Barrier', usage_amount: 1 },
      { id: 'u6', product_id: SHORT, service_type: 'Mosquito', usage_amount: 1 },
    );
    knex = makeKnex(tables);
    const start = snapshot(knex);
    await migration.up(knex);
    expect(byId(knex, 'lawn_protocol_products', 'r5')).toMatchObject({ product_id: CROSS, product_name: 'LESCO Crosscheck Plus' });
    expect(byId(knex, 'services', 's6').default_products).toEqual(['LESCO Crosscheck Plus', 'Scion Insecticide']);
    expect(byId(knex, 'product_aliases', 'a7')).toBeUndefined(); // 'Talstar P' already moved from the long-name row
    expect(byId(knex, 'service_product_usage', 'u5').product_id).toBe(CROSS);
    expect(byId(knex, 'service_product_usage', 'u6')).toBeUndefined(); // Mosquito already maps Crosscheck (moved from u1)
    for (const table of ['lawn_protocol_products', 'product_aliases', 'service_product_usage']) {
      expect(knex.tables[table].filter((row) => row.product_id === TALAK || row.product_id === SHORT)
        .filter((row) => table !== 'product_aliases' || row.alias_name !== 'Talak 7.9 F')).toEqual([]);
    }
    await migration.down(knex);
    const { audit_log: _auditLog, ...rest } = snapshot(knex);
    const { audit_log: _startLog, ...startRest } = start;
    expect(byIdOrder(rest)).toEqual(byIdOrder(startRest));
  });
});

describe('house bifenthrin crosscheck migration: missing products and tables', () => {
  let logSpy;
  beforeEach(() => { logSpy = jest.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => logSpy.mockRestore());

  test('no Talak row: links, defaults and aliases stay; the Crosscheck row still fills; nothing throws', async () => {
    const tables = baseTables();
    tables.products_catalog.splice(0, 1);
    const knex = makeKnex(tables);
    await expect(migration.up(knex)).resolves.toBeUndefined();
    expect(byId(knex, 'lawn_protocol_products', 'r1').product_id).toBe(TALAK);
    expect(byId(knex, 'services', 's1').default_products).toContain('Atticus Talak 7.9 F');
    expect(byId(knex, 'product_aliases', 'a1').product_id).toBe(TALAK);
    expect(byId(knex, 'service_product_usage', 'u1').product_id).toBe(TALAK);
    expect(knex.tables.lawn_protocol_audit_log).toHaveLength(0);
    expect(byId(knex, 'products_catalog', CROSS).signal_word).toBe('CAUTION');
  });

  test('a repo-built catalog (Talak, no Crosscheck): up() adds Crosscheck, price pending, and the links follow; down() moves them back and keeps the row', async () => {
    const tables = baseTables();
    tables.products_catalog.splice(1, 1);
    const columns = ['id', 'name', 'category', 'active_ingredient', 'formulation', 'container_size', 'unit_size_oz', 'epa_reg_number',
      'default_rate_per_1000', 'rate_unit', 'active', 'needs_pricing', 'label_source_note', 'created_at', 'updated_at', 'best_price',
      'cost_per_unit', 'public_summary', 'approved_for_public_page'];
    const knex = makeKnex(tables, { columns: { products_catalog: columns } });
    await migration.up(knex);
    const added = knex.tables.products_catalog.filter((row) => row.name === 'LESCO Crosscheck Plus');
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      category: 'insecticide', active_ingredient: '7.9% Bifenthrin', container_size: '1 gal', unit_size_oz: 128, epa_reg_number: '10404-120',
      default_rate_per_1000: 0.5, rate_unit: 'fl oz', active: true, needs_pricing: true,
    });
    expect(added[0].best_price).toBeUndefined(); // price pending: never a price or cost
    expect(added[0].cost_per_unit).toBeUndefined();
    expect(added[0].public_summary).toBeTruthy(); // step 4 filled it
    expect(knex.tables.lawn_protocol_products.filter((row) => row.product_id === added[0].id).map((row) => row.id).sort()).toEqual(['r1', 'r2', 'r3']);
    expect(knex.tables.audit_log.filter((e) => e.action === `migration:${migration.MIGRATION}:seed`)).toHaveLength(1);
    const afterUp = snapshot(knex);
    await migration.up(knex);
    expect(snapshot(knex)).toEqual(afterUp); // a second run adds nothing
    await migration.down(knex);
    expect(knex.tables.lawn_protocol_products.filter((row) => row.product_id === TALAK).map((row) => row.id).sort()).toEqual(['r1', 'r2', 'r3']);
    expect(knex.tables.products_catalog.filter((row) => row.name === 'LESCO Crosscheck Plus')).toHaveLength(1); // kept, as the v13 seed keeps its rows
  });

  test.each([
    ['two rows named Crosscheck', (tables) => tables.products_catalog.push({ ...tables.products_catalog[1], id: 'dddddddd-0000-4000-8000-000000000009' })],
    ['no Crosscheck row and no Talak row', (tables) => tables.products_catalog.splice(0, 2)],
  ])('%s: nothing changes at all', async (_name, edit) => {
    const tables = baseTables();
    edit(tables);
    const knex = makeKnex(tables);
    const before = snapshot(knex);
    await expect(migration.up(knex)).resolves.toBeUndefined();
    expect(snapshot(knex)).toEqual(before);
  });

  test('an empty database (no tables) is a no-op in both directions', async () => {
    const knex = makeKnex({});
    await expect(migration.up(knex)).resolves.toBeUndefined();
    await expect(migration.down(knex)).resolves.toBeUndefined();
  });

  test('no audit_log table: no snapshot, so no change', async () => {
    const tables = baseTables();
    delete tables.audit_log;
    const knex = makeKnex(tables);
    const before = snapshot(knex);
    await migration.up(knex);
    expect(snapshot(knex)).toEqual(before);
  });
});

describe('house bifenthrin crosscheck migration: down', () => {
  let logSpy;
  beforeEach(() => { logSpy = jest.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => logSpy.mockRestore());

  test('restores exactly what up wrote: every table but audit_log equals its starting state', async () => {
    const knex = makeKnex(baseTables());
    const start = snapshot(knex);
    await migration.up(knex);
    const upEvents = knex.tables.audit_log.length;
    await migration.down(knex);
    const { audit_log: auditLog, ...rest } = snapshot(knex);
    const { audit_log: startLog, ...startRest } = start;
    // The removed usage row u2 is back with its own id and values (old EPA number, empty cost columns and all).
    expect(byIdOrder(rest)).toEqual(byIdOrder(startRest));
    expect(startLog).toEqual([]);
    // Append-only: every up event stays, and each one gets exactly one rollback event naming it.
    expect(auditLog).toHaveLength(upEvents * 2);
    const upIds = auditLog.filter((row) => !row.action.endsWith(':rollback')).map((row) => row.id).sort();
    const named = auditLog.filter((row) => row.action.endsWith(':rollback')).map((row) => meta(row).from_audit_id).sort();
    expect(named).toEqual(upIds);
  });

  // The up event id for a usage row, and the usage rows whose up event a rollback event names.
  const usageEventId = (knex, rowId) => String(eventsOf(knex, migration.actionFor('usage')).find((row) => row.resource_id === rowId).id);
  const reversedUsage = (knex) => rollbacksOf(knex, 'usage').map((row) => meta(row).from_audit_id);

  test('a usage row pointed elsewhere since up is kept: its up event stays and gets no rollback event', async () => {
    const knex = makeKnex(baseTables());
    await migration.up(knex);
    byId(knex, 'service_product_usage', 'u1').product_id = OTHER;
    await migration.down(knex);
    expect(byId(knex, 'service_product_usage', 'u1').product_id).toBe(OTHER);
    expect(eventsOf(knex, migration.actionFor('usage'))).toHaveLength(2);
    expect(reversedUsage(knex)).toEqual([usageEventId(knex, 'u2')]);
  });

  test('a removed usage row comes back only while its id is free and its product still exists', async () => {
    const taken = makeKnex(baseTables());
    await migration.up(taken);
    taken.tables.service_product_usage.push({ id: 'u2', product_id: OTHER, service_type: 'Office Row', usage_amount: 9 });
    await migration.down(taken);
    expect(taken.tables.service_product_usage.filter((row) => row.id === 'u2')).toEqual([{ id: 'u2', product_id: OTHER, service_type: 'Office Row', usage_amount: 9 }]);
    expect(reversedUsage(taken)).not.toContain(usageEventId(taken, 'u2'));

    const tables = baseTables();
    tables.lawn_protocol_products = []; // nothing else in this case depends on the Talak row
    const gone = makeKnex(tables);
    await migration.up(gone);
    gone.tables.products_catalog = gone.tables.products_catalog.filter((row) => row.id !== TALAK);
    await migration.down(gone);
    expect(byId(gone, 'service_product_usage', 'u2')).toBeUndefined();
    expect(reversedUsage(gone)).not.toContain(usageEventId(gone, 'u2'));
  });

  test('Talak deleted after up: down finishes, every moved link stays on Crosscheck and keeps its up event (the foreign key would fail it)', async () => {
    const knex = makeKnex(baseTables());
    await migration.up(knex);
    const upEvents = knex.tables.audit_log.length;
    knex.tables.products_catalog = knex.tables.products_catalog.filter((row) => row.id !== TALAK);
    await expect(migration.down(knex)).resolves.toBeUndefined();
    expect(['r1', 'r2', 'r3'].map((id) => byId(knex, 'lawn_protocol_products', id).product_id)).toEqual([CROSS, CROSS, CROSS]);
    expect(knex.tables.lawn_protocol_audit_log).toHaveLength(2); // kept: its rows were not restored
    expect(['a1', 'a2', 'a3', 'a4'].map((id) => byId(knex, 'product_aliases', id).product_id)).toEqual([CROSS, CROSS, CROSS, CROSS]);
    expect(byId(knex, 'service_product_usage', 'u1').product_id).toBe(CROSS);
    expect(byId(knex, 'service_product_usage', 'u2')).toBeUndefined();
    // Only what could go back did: the added aliases, the services and the catalog columns. No moved link has a rollback event.
    expect(rollbacksOf(knex, migration.STEPS.usage)).toEqual([]);
    expect(rollbacksOf(knex, migration.STEPS.aliases).map((row) => meta(row).from_audit_id).sort())
      .toEqual(eventsOf(knex, migration.actionFor(migration.STEPS.aliases)).filter((row) => meta(row).kind === 'inserted').map((row) => String(row.id)).sort());
    expect(knex.tables.audit_log.length).toBeGreaterThan(upEvents);
  });

  test('catalog: a column edited between down\'s start and its write is kept, guarded in the UPDATE itself', async () => {
    const original = makeKnex(baseTables());
    await migration.up(original);
    // Simulate an office edit landing just before each catalog write of down(): the guarded update must match nothing.
    const wrapped = (table) => {
      const b = original(table);
      if (table !== 'products_catalog') return b;
      const update = b.update.bind(b);
      b.update = (patch) => { byId(original, 'products_catalog', CROSS).signal_word = 'Office Word'; return update(patch); };
      return b;
    };
    Object.assign(wrapped, { schema: original.schema, fn: original.fn, tables: original.tables });
    await migration.down(wrapped);
    expect(byId(original, 'products_catalog', CROSS).signal_word).toBe('Office Word');
    const [catalogRollback] = rollbacksOf(original, 'catalog');
    expect(meta(catalogRollback).restored).not.toContain('signal_word');
    expect(meta(catalogRollback).restored).toContain('common_name');
  });

  test('keeps a row, service, alias and column edited since up, and keeps its audit row', async () => {
    const knex = makeKnex(baseTables());
    await migration.up(knex);
    byId(knex, 'lawn_protocol_products', 'r1').product_name = 'Renamed By Office';
    byId(knex, 'services', 's2').default_products = ['LESCO Crosscheck Plus', 'Taurus SC'];
    byId(knex, 'product_aliases', 'a1').product_id = OTHER;
    byId(knex, 'products_catalog', CROSS).common_name = 'Office wording';
    await migration.down(knex);
    expect(byId(knex, 'service_product_usage', 'u1').product_id).toBe(TALAK);

    expect(byId(knex, 'lawn_protocol_products', 'r1')).toMatchObject({ product_id: CROSS, product_name: 'Renamed By Office' });
    expect(byId(knex, 'lawn_protocol_products', 'r2')).toMatchObject({ product_id: TALAK, product_name: 'Atticus Talak 7.9 F' });
    expect(byId(knex, 'services', 's2').default_products).toEqual(['LESCO Crosscheck Plus', 'Taurus SC']);
    expect(byId(knex, 'services', 's1').default_products).toEqual(['Scion Insecticide', 'Atticus Talak 7.9 F', 'Tekko Pro IGR']);
    expect(byId(knex, 'product_aliases', 'a1').product_id).toBe(OTHER);
    expect(byId(knex, 'product_aliases', 'a2').product_id).toBe(TALAK);
    expect(byId(knex, 'products_catalog', CROSS)).toMatchObject({ common_name: 'Office wording', signal_word: null, cost_per_unit: null });
    expect(knex.tables.lawn_protocol_audit_log).toHaveLength(1);
    // No rollback event for the kept service or alias; the catalog rollback lists every column but the edited one.
    expect(rollbacksOf(knex, 'services').map((row) => row.resource_id).sort()).toEqual(['s1', 's3']);
    const aliasUp = new Map(eventsOf(knex, migration.actionFor('aliases')).map((row) => [String(row.id), row.resource_id]));
    expect(rollbacksOf(knex, 'aliases').map((row) => aliasUp.get(meta(row).from_audit_id))).not.toContain('a1');
    expect(rollbacksOf(knex, 'aliases')).toHaveLength(4);
    const [catalogRollback] = rollbacksOf(knex, 'catalog');
    expect(meta(catalogRollback).restored).not.toContain('common_name');
    expect(meta(catalogRollback).restored).toContain('signal_word');
  });

  test('an added alias the office gave a vendor since up is kept: down deletes only the global row it inserted', async () => {
    const knex = makeKnex(baseTables());
    await migration.up(knex);
    const [added] = eventsOf(knex, migration.actionFor(migration.STEPS.aliases)).filter((row) => meta(row).kind === 'inserted');
    byId(knex, 'product_aliases', added.resource_id).vendor_id = OTHER;
    await migration.down(knex);
    expect(byId(knex, 'product_aliases', added.resource_id)).toMatchObject({ product_id: CROSS, vendor_id: OTHER });
    expect(rollbacksOf(knex, migration.STEPS.aliases).map((row) => meta(row).from_audit_id)).not.toContain(String(added.id));
    // The moved office names still go back to Talak.
    expect(['a1', 'a2', 'a3', 'a4'].map((id) => byId(knex, 'product_aliases', id).product_id)).toEqual([TALAK, TALAK, TALAK, TALAK]);
  });

  test('a later down finishes an item that holds what up wrote again, and never repeats a reversed one', async () => {
    const knex = makeKnex(baseTables());
    await migration.up(knex);
    byId(knex, 'service_product_usage', 'u1').product_id = OTHER;
    await migration.down(knex);
    expect(reversedUsage(knex)).toEqual([usageEventId(knex, 'u2')]);
    byId(knex, 'service_product_usage', 'u1').product_id = CROSS;
    const servicesRollbacks = rollbacksOf(knex, 'services').length;
    await migration.down(knex);
    expect(byId(knex, 'service_product_usage', 'u1').product_id).toBe(TALAK);
    // u2 was put back by the first down and is not inserted a second time.
    expect(reversedUsage(knex).sort()).toEqual([usageEventId(knex, 'u1'), usageEventId(knex, 'u2')].sort());
    expect(knex.tables.service_product_usage.filter((row) => row.id === 'u2')).toHaveLength(1);
    expect(rollbacksOf(knex, 'services')).toHaveLength(servicesRollbacks);
  });

  test('a second down after the first is a no-op', async () => {
    const knex = makeKnex(baseTables());
    await migration.up(knex);
    await migration.down(knex);
    const after = snapshot(knex);
    await migration.down(knex);
    expect(snapshot(knex)).toEqual(after);
  });
});

// Follow-up 20261119010100: migration 20261027190000 wrote the label holds on the Crosscheck row that existed then; the row
// step 0 adds on a repo-built catalog gets the same entry of that migration's FILL list, each column only while empty.
describe('follow-up 20261119010100: the Crosscheck row gets the 10-27 label holds', () => {
  const holds = require('../models/migrations/20261119010100_crosscheck_seeded_row_holds');
  const fill = require('../models/migrations/20261027190000_watering_rule_lawn_label_pass_2').FILL.find((item) => item.name === 'LESCO Crosscheck Plus');
  const COLUMNS = ['id', 'name', 'category', 'active_ingredient', 'formulation', 'container_size', 'unit_size_oz', 'epa_reg_number',
    'default_rate_per_1000', 'rate_unit', 'active', 'needs_pricing', 'label_source_note', 'created_at', 'updated_at',
    'post_application_watering', 'mow_hold_days'];
  const holdEvents = (knex) => knex.tables.audit_log.filter((e) => String(e.action).startsWith(`migration:${holds.MIGRATION}:`));

  test('the row step 0 added: the 24 h label hold and the 1-day mow hold, one audit row each; a re-run and down() change nothing', async () => {
    const tables = baseTables();
    tables.products_catalog.splice(1, 1);
    const knex = makeKnex(tables, { columns: { products_catalog: COLUMNS } });
    await migration.up(knex);
    await holds.up(knex);
    const row = knex.tables.products_catalog.find((r) => r.name === 'LESCO Crosscheck Plus');
    expect(fill.rule).toMatchObject({ mode: 'hold', source: 'label', hold_hours: 24 });
    expect(JSON.parse(row.post_application_watering)).toEqual(fill.rule);
    expect(row.mow_hold_days).toBe(1);
    expect(holdEvents(knex).map((e) => e.action).sort()).toEqual([
      `migration:${holds.MIGRATION}:mow_hold_seeded`, `migration:${holds.MIGRATION}:seeded`,
    ]);
    for (const e of holdEvents(knex)) expect(e.action.length).toBeLessThanOrEqual(96);
    const after = snapshot(knex);
    await holds.up(knex);
    await holds.down(knex);
    expect(snapshot(knex)).toEqual(after);
  });

  test('a row that already holds both (production, read 2026-11-18) or an admin edit is never touched', async () => {
    const tables = baseTables();
    Object.assign(tables.products_catalog[1], { post_application_watering: JSON.stringify({ mode: 'none', source: 'owner' }), mow_hold_days: 2 });
    const knex = makeKnex(tables, { columns: { products_catalog: COLUMNS } });
    const before = snapshot(knex);
    await holds.up(knex);
    expect(snapshot(knex)).toEqual(before);
  });

  test('no audit_log table: nothing is written', async () => {
    const tables = baseTables();
    delete tables.audit_log;
    const knex = makeKnex(tables, { columns: { products_catalog: COLUMNS } });
    const before = snapshot(knex);
    await holds.up(knex);
    expect(snapshot(knex)).toEqual(before);
  });
});

// Follow-up 20261119010200: the Crosscheck row gets production's label and copy fields. Any Crosscheck row: NULL columns only.
// The row step 0 added: also the columns that hold a Postgres default or the seed's spelling (never another row's office choice).
describe('follow-up 20261119010200: the Crosscheck row gets production\'s label and copy fields', () => {
  const holds = require('../models/migrations/20261119010100_crosscheck_seeded_row_holds');
  const fill = require('../models/migrations/20261119010200_crosscheck_catalog_label_fill');
  const PG_DEFAULTS = {
    products_catalog: {
      active: true, needs_pricing: true, restricted_use: false, customer_visibility: 'internal_only', content_status: 'draft',
      best_price_status: 'needs_mapping', rate_public_visibility: 'hidden', local_rule_sensitivity: false, approved_for_public_page: false,
      approved_for_estimate_packet: false, approved_for_service_report: false, auto_reorder_enabled: false, bid_list: false,
    },
  };
  const FILLED = Object.fromEntries(fill.FILL_IF_NULL);
  const COLUMNS = ['id', 'name', 'category', 'active_ingredient', 'formulation', 'container_size', 'unit_size_oz', 'epa_reg_number',
    'default_rate_per_1000', 'rate_unit', 'active', 'needs_pricing', 'label_source_note', 'created_at', 'updated_at',
    ...Object.keys(PG_DEFAULTS.products_catalog), ...fill.FILL_IF_NULL.map(([c]) => c), ...fill.SEEDED_ROW.map(([c]) => c),
    'reentry_text', 'pet_kid_guidance_text', 'customer_safety_summary', 'common_name', 'public_summary', 'portal_summary',
    'application_zones', 'product_type', 'signal_word', 'inventory_unit', 'low_stock_threshold', 'post_application_watering', 'mow_hold_days'];
  const fillEvents = (knex) => knex.tables.audit_log.filter((e) => e.action === `migration:${fill.MIGRATION}:fill`);
  const crosscheckRow = (knex) => knex.tables.products_catalog.find((r) => r.name === 'LESCO Crosscheck Plus');
  // Production's Crosscheck row after 20261119010000 step 4 (read 2026-11-18): every FILL_IF_NULL value is there.
  const productionRow = () => ({
    ...baseCatalog()[1], ...FILLED, epa_reg_number: '10404-120', rate_unit: 'fl_oz', customer_visibility: null, content_status: null,
    approved_for_service_report: true, label_verified_at: '2026-07-12T17:55:44.589Z', label_verified_by: 'label-rate-backfill-2026-07-12',
  });

  test('a repo-built catalog: the seeded row ends as production\'s, one audit row; a re-run and down() change nothing', async () => {
    const tables = baseTables();
    tables.products_catalog.splice(1, 1);
    const knex = makeKnex(tables, { columns: { products_catalog: COLUMNS }, defaults: PG_DEFAULTS });
    await migration.up(knex);
    await holds.up(knex);
    expect(crosscheckRow(knex)).toMatchObject({ customer_visibility: 'internal_only', content_status: 'draft', approved_for_service_report: false, rate_unit: 'fl oz' });
    await fill.up(knex);
    const row = crosscheckRow(knex);
    expect(row).toMatchObject({
      ...FILLED, rate_unit: 'fl_oz', customer_visibility: 'portal_only', content_status: 'approved_for_portal',
      approved_for_service_report: true, approved_for_public_page: true, approved_for_estimate_packet: true,
      label_verified_at: '2026-11-18T12:00:00.000Z', label_verified_by: 'label-check-2026-11-18', mow_hold_days: 1,
    });
    expect(row.target_pests).toEqual(['Fire ants', 'Big-headed ants', 'Southern chinch bugs', 'Fleas', 'Ticks']);
    expect(row.service_lines).toEqual(['pest', 'lawn']);
    const events = fillEvents(knex);
    expect(events).toHaveLength(1);
    expect(events[0].resource_id).toBe(String(row.id));
    expect(events[0].metadata.before).toMatchObject({ moa_group: null, rate_unit: 'fl oz', customer_visibility: 'internal_only', approved_for_service_report: false });
    expect(events[0].action.length).toBeLessThanOrEqual(96);
    const after = snapshot(knex);
    await fill.up(knex);
    await fill.down(knex);
    expect(snapshot(knex)).toEqual(after);
  });

  test('production\'s row (every value set) is never touched', async () => {
    const tables = baseTables();
    tables.products_catalog[1] = productionRow();
    const knex = makeKnex(tables, { columns: { products_catalog: COLUMNS } });
    const before = snapshot(knex);
    await fill.up(knex);
    expect(snapshot(knex)).toEqual(before);
  });

  test('a row step 0 did not add: NULL columns fill (a NULL EPA number among them); its visibility and approval stand', async () => {
    const tables = baseTables();
    Object.assign(tables.products_catalog[1], {
      epa_reg_number: null, moa_group: null, rate_unit: 'fl oz', customer_visibility: 'internal_only', content_status: 'draft',
      approved_for_service_report: false, label_verified_at: null, label_verified_by: null, label_url: 'https://example.test/office-label.pdf',
    });
    const knex = makeKnex(tables, { columns: { products_catalog: COLUMNS } });
    await migration.up(knex);
    await fill.up(knex);
    const row = byId(knex, 'products_catalog', CROSS);
    expect(row).toMatchObject({
      epa_reg_number: '10404-120', moa_group: 'Group 3A', max_label_rate_per_1000: 1, label_url: 'https://example.test/office-label.pdf',
      rate_unit: 'fl oz', customer_visibility: 'internal_only', content_status: 'draft', approved_for_service_report: false,
      label_verified_at: null, label_verified_by: null,
    });
    expect(Object.keys(fillEvents(knex)[0].metadata.after)).not.toContain('label_url');
  });

  test('an office edit on the seeded row after step 0 stands', async () => {
    const tables = baseTables();
    tables.products_catalog.splice(1, 1);
    const knex = makeKnex(tables, { columns: { products_catalog: COLUMNS }, defaults: PG_DEFAULTS });
    await migration.up(knex);
    Object.assign(crosscheckRow(knex), { content_status: 'archived', moa_group: 'Office Group' });
    await fill.up(knex);
    expect(crosscheckRow(knex)).toMatchObject({ content_status: 'archived', moa_group: 'Office Group', customer_visibility: 'portal_only' });
  });

  test('no audit_log table: nothing is written', async () => {
    const tables = baseTables();
    delete tables.audit_log;
    tables.products_catalog[1].moa_group = null;
    const knex = makeKnex(tables, { columns: { products_catalog: COLUMNS } });
    const before = snapshot(knex);
    await fill.up(knex);
    expect(snapshot(knex)).toEqual(before);
  });
});

// Follow-up 20261119010300: Crosscheck's tags gain the lines 20261119010000 links it to (mosquito services, Slab Pre-Treat).
describe('follow-up 20261119010300: the Crosscheck row is tagged mosquito and termite too', () => {
  const holds = require('../models/migrations/20261119010100_crosscheck_seeded_row_holds');
  const fill = require('../models/migrations/20261119010200_crosscheck_catalog_label_fill');
  const tags = require('../models/migrations/20261119010300_crosscheck_service_line_tags');
  const tagEvents = (knex) => knex.tables.audit_log.filter((e) => e.action === `migration:${tags.MIGRATION}:tags`);
  const withTags = (serviceLines) => {
    const tables = baseTables();
    tables.products_catalog[1].service_lines = serviceLines;
    return makeKnex(tables);
  };

  test('a repo-built catalog: pest, lawn, mosquito, termite; one audit row; a re-run and down() change nothing', async () => {
    const tables = baseTables();
    tables.products_catalog.splice(1, 1);
    const columns = ['id', 'name', 'category', 'active_ingredient', 'formulation', 'container_size', 'unit_size_oz', 'default_rate_per_1000',
      'active', 'needs_pricing', 'label_source_note', 'created_at', 'updated_at', ...fill.FILL_IF_NULL.map(([c]) => c), ...fill.SEEDED_ROW.map(([c]) => c)];
    const knex = makeKnex(tables, { columns: { products_catalog: columns } });
    for (const step of [migration, holds, fill, tags]) await step.up(knex);
    const row = knex.tables.products_catalog.find((r) => r.name === 'LESCO Crosscheck Plus');
    expect(row.service_lines).toEqual(['pest', 'lawn', 'mosquito', 'termite']);
    expect(tagEvents(knex)).toHaveLength(1);
    expect(tagEvents(knex)[0].metadata).toMatchObject({ before: { service_lines: ['pest', 'lawn'] }, after: { service_lines: ['pest', 'lawn', 'mosquito', 'termite'] } });
    expect(tagEvents(knex)[0].action.length).toBeLessThanOrEqual(96);
    const after = snapshot(knex);
    await tags.up(knex);
    await tags.down(knex);
    expect(snapshot(knex)).toEqual(after);
  });

  test.each([
    ['production\'s tags', ['pest', 'lawn'], ['pest', 'lawn', 'mosquito', 'termite']],
    ['an office tag stays, first', ['rodent', 'pest', 'lawn'], ['rodent', 'pest', 'lawn', 'mosquito', 'termite']],
    ['one of the two is there', ['pest', 'lawn', 'termite'], ['pest', 'lawn', 'termite', 'mosquito']],
  ])('%s: the missing lines are added after the kept ones', async (_label, before, expected) => {
    const knex = withTags(before);
    await tags.up(knex);
    expect(byId(knex, 'products_catalog', CROSS).service_lines).toEqual(expected);
    expect(tagEvents(knex)).toHaveLength(1);
  });

  test.each([
    ['already tagged with both', ['pest', 'lawn', 'mosquito', 'termite']],
    ['untagged (the category decides)', null],
    ['not a tag list', { lawn: true }],
  ])('%s: nothing changes', async (_label, serviceLines) => {
    const knex = withTags(serviceLines);
    const before = snapshot(knex);
    await tags.up(knex);
    expect(snapshot(knex)).toEqual(before);
  });

  test('an edit between the read and the write stands', async () => {
    const knex = withTags(['pest', 'lawn']);
    const original = knex;
    const wrapped = (table) => {
      const b = original(table);
      const { update } = b;
      b.update = (patch) => { byId(original, 'products_catalog', CROSS).service_lines = ['lawn']; return update(patch); };
      return b;
    };
    Object.assign(wrapped, { schema: original.schema, fn: original.fn, tables: original.tables });
    await tags.up(wrapped);
    expect(byId(knex, 'products_catalog', CROSS).service_lines).toEqual(['lawn']);
    expect(tagEvents(knex)).toHaveLength(0);
  });

  test('no audit_log table: nothing is written', async () => {
    const tables = baseTables();
    delete tables.audit_log;
    tables.products_catalog[1].service_lines = ['pest', 'lawn'];
    const knex = makeKnex(tables);
    const before = snapshot(knex);
    await tags.up(knex);
    expect(snapshot(knex)).toEqual(before);
  });
});

// Follow-up 20261119010400: a repo-built database links the older bifenthrin products (Talstar P, Bifen I/T) from earlier
// seeds; those links follow to Crosscheck too. Production has none (read 2026-11-18).
describe('follow-up 20261119010400: links to Talstar P and Bifen I/T follow to Crosscheck', () => {
  const legacy = require('../models/migrations/20261119010400_legacy_bifenthrin_links');
  const BIFEN = 'dddddddd-0000-4000-8000-000000000004';
  const TALSTAR = 'eeeeeeee-0000-4000-8000-000000000005';
  const legacyTables = () => {
    const tables = baseTables();
    tables.products_catalog.push({ id: BIFEN, name: 'Bifen I/T', active: true }, { id: TALSTAR, name: 'Talstar P', active: false });
    tables.lawn_protocol_products.push(
      { id: 'r5', lawn_protocol_window_id: 'w1', product_id: BIFEN, product_name: 'Bifen I/T', role: 'insect_curative', rate_per_1000: 0.25, updated_at: 't0' },
      { id: 'r6', lawn_protocol_window_id: 'w3', product_id: null, product_name: 'Talstar P', role: 'insect_curative', rate_per_1000: 1, updated_at: 't0' },
      { id: 'r7', lawn_protocol_window_id: 'w2', product_id: TALSTAR, product_name: 'Talstar P', role: 'insect_curative', rate_per_1000: 1, updated_at: 't0' },
    );
    tables.services.push(
      { id: 's6', name: 'Seeded Mosquito Monthly', default_products: ['Bifen I/T', 'Tekko Pro IGR', 'Scion Insecticide'] },
      { id: 's7', name: 'Both Listed', default_products: ['LESCO Crosscheck Plus', 'Bifen I/T', 'Talstar P'] },
    );
    tables.service_product_usage.push(
      { id: 'u5', product_id: BIFEN, service_type: 'Mosquito Treatment - Essential Barrier', usage_amount: 3 },
      { id: 'u6', product_id: TALSTAR, service_type: 'Already Mapped', usage_amount: 2 },
      { id: 'u7', product_id: TALSTAR, service_type: 'Mosquito Treatment - Essential Barrier', usage_amount: 1 },
    );
    return tables;
  };
  const events = (knex, step) => knex.tables.audit_log.filter((e) => e.action === legacy.actionFor(step));
  const withoutAudit = (tables) => { const { audit_log: _log, ...rest } = tables; return byIdOrder(rest); };

  test('up: rows, defaults and usage on either product move to Crosscheck; duplicates go whole into the audit; a re-run changes nothing', async () => {
    const knex = makeKnex(legacyTables());
    await migration.up(knex);
    await legacy.up(knex);
    for (const id of ['r5', 'r6', 'r7']) {
      expect(byId(knex, 'lawn_protocol_products', id)).toMatchObject({ product_id: CROSS, product_name: 'LESCO Crosscheck Plus', role: 'insect_curative' });
    }
    expect(byId(knex, 'lawn_protocol_products', 'r4')).toMatchObject({ product_id: OTHER, product_name: 'Taurus SC' });
    const lawnLogs = knex.tables.lawn_protocol_audit_log.filter((log) => log.action === legacy.LAWN_ACTION);
    expect(lawnLogs.map((log) => log.lawn_protocol_id).sort()).toEqual(['p1', 'p2']);
    expect(byId(knex, 'services', 's6').default_products).toEqual(['LESCO Crosscheck Plus', 'Tekko Pro IGR', 'Scion Insecticide']);
    expect(byId(knex, 'services', 's7').default_products).toEqual(['LESCO Crosscheck Plus']);
    expect(byId(knex, 'service_product_usage', 'u5')).toMatchObject({ product_id: CROSS });
    expect(byId(knex, 'service_product_usage', 'u6')).toBeUndefined();
    expect(byId(knex, 'service_product_usage', 'u7')).toBeUndefined();
    expect(events(knex, legacy.STEPS.usage).map((e) => e.metadata.kind).sort()).toEqual(['moved', 'removed', 'removed']);
    expect(events(knex, legacy.STEPS.usage).find((e) => e.resource_id === 'u6').metadata.row).toMatchObject({ id: 'u6', product_id: TALSTAR });
    expect(events(knex, legacy.STEPS.services)).toHaveLength(2);
    expect(knex.locks.map(([table]) => table)).toEqual(expect.arrayContaining(['lawn_protocol_products', 'service_product_usage']));
    for (const e of knex.tables.audit_log) expect(e.action.length).toBeLessThanOrEqual(96);
    expect(legacy.rollbackActionFor(legacy.STEPS.services).length).toBeLessThanOrEqual(96);
    expect(legacy.LAWN_ACTION.length).toBeLessThanOrEqual(40);
    const after = snapshot(knex);
    await legacy.up(knex);
    expect(snapshot(knex)).toEqual(after);
  });

  test('down: every link goes back to its own product (a row with no product stays with none); audit_log is only appended to', async () => {
    const knex = makeKnex(legacyTables());
    await migration.up(knex);
    const start = snapshot(knex);
    await legacy.up(knex);
    const upEvents = knex.tables.audit_log.length - start.audit_log.length;
    await legacy.down(knex);
    expect(withoutAudit(snapshot(knex))).toEqual(withoutAudit(start));
    expect(byId(knex, 'lawn_protocol_products', 'r6')).toMatchObject({ product_id: null, product_name: 'Talstar P' });
    expect(knex.tables.audit_log.slice(0, start.audit_log.length)).toEqual(start.audit_log);
    expect(knex.tables.audit_log.filter((e) => String(e.action).endsWith(':rollback') && e.action.includes(legacy.MIGRATION))).toHaveLength(upEvents);
    const rolledBack = snapshot(knex);
    await legacy.down(knex);
    expect(snapshot(knex)).toEqual(rolledBack);
  });

  test('down keeps a row edited since up() and a link whose old product is gone', async () => {
    const knex = makeKnex(legacyTables());
    await migration.up(knex);
    await legacy.up(knex);
    byId(knex, 'services', 's6').default_products = ['Office Pick'];
    byId(knex, 'service_product_usage', 'u5').product_id = OTHER;
    knex.tables.products_catalog = knex.tables.products_catalog.filter((row) => row.id !== TALSTAR);
    await legacy.down(knex);
    expect(byId(knex, 'services', 's6').default_products).toEqual(['Office Pick']);
    expect(byId(knex, 'service_product_usage', 'u5')).toMatchObject({ product_id: OTHER });
    expect(byId(knex, 'lawn_protocol_products', 'r7')).toMatchObject({ product_id: CROSS });
    expect(byId(knex, 'lawn_protocol_products', 'r5')).toMatchObject({ product_id: BIFEN, product_name: 'Bifen I/T' });
    expect(byId(knex, 'service_product_usage', 'u6')).toBeUndefined();
  });

  test.each([
    ['production: the older products link nothing', (tables) => tables],
    ['two catalog rows named Crosscheck', (tables) => { tables.products_catalog.push({ id: 'cross-2', name: 'LESCO Crosscheck Plus' }); return tables; }],
  ])('%s: nothing changes', async (_label, shape) => {
    const tables = baseTables();
    tables.products_catalog.push({ id: BIFEN, name: 'Bifen I/T', active: false }, { id: TALSTAR, name: 'Talstar P', active: false });
    const knex = makeKnex(shape(tables));
    await migration.up(knex);
    const before = snapshot(knex);
    await legacy.up(knex);
    expect(snapshot(knex)).toEqual(before);
  });
});

// Follow-up 20261119010500: the rows the swap moved keep Talak's gates; Crosscheck's label has a 25 ft ground setback from water (page 7).
describe('follow-up 20261119010500: Crosscheck protocol rows carry the label\'s 25 ft water setback', () => {
  const setback = require('../models/migrations/20261119010500_crosscheck_water_setback_gate');
  const gatedTables = () => {
    const tables = baseTables();
    const gates = { r1: { trigger: 'chinch_bugs', delayWateringHours: 24 }, r2: { maxLabelRate: 1, trigger: 'fire_ants' }, r3: { minDistanceFromWaterFt: 10 }, r4: { applyAlone: true } };
    for (const row of tables.lawn_protocol_products) row.gates = gates[row.id];
    tables.lawn_protocol_products.push({ id: 'r8', lawn_protocol_window_id: 'w3', product_id: CROSS, product_name: 'LESCO Crosscheck Plus', role: 'insecticide_spot', rate_per_1000: 1, gates: { minDistanceFromWaterFt: 50 }, updated_at: 't0' });
    return tables;
  };
  const gatesOf = (knex, id) => byId(knex, 'lawn_protocol_products', id).gates;
  const setbackLogs = (knex) => knex.tables.lawn_protocol_audit_log.filter((log) => log.action === setback.LAWN_ACTION);
  let logSpy;
  beforeEach(() => { logSpy = jest.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => logSpy.mockRestore());

  test('up: a missing or narrower setback becomes 25 ft, a wider one stays, the other gates stay; one audit row per protocol; a re-run changes nothing', async () => {
    const knex = makeKnex(gatedTables());
    await migration.up(knex);
    knex.locks.length = 0;
    await setback.up(knex);
    expect(gatesOf(knex, 'r1')).toEqual({ trigger: 'chinch_bugs', delayWateringHours: 24, minDistanceFromWaterFt: 25 });
    expect(gatesOf(knex, 'r2')).toEqual({ maxLabelRate: 1, trigger: 'fire_ants', minDistanceFromWaterFt: 25 });
    expect(gatesOf(knex, 'r3')).toEqual({ minDistanceFromWaterFt: 25 });
    expect(gatesOf(knex, 'r8')).toEqual({ minDistanceFromWaterFt: 50 });
    expect(gatesOf(knex, 'r4')).toEqual({ applyAlone: true });
    expect(setbackLogs(knex).map((log) => log.lawn_protocol_id).sort()).toEqual(['p1', 'p2']);
    const p2 = setbackLogs(knex).find((log) => log.lawn_protocol_id === 'p2');
    expect(JSON.parse(p2.before_snapshot).rows).toEqual([{ rowId: 'r3', gates: { minDistanceFromWaterFt: 10 } }]);
    expect(JSON.parse(p2.after_snapshot).rows).toEqual([{ rowId: 'r3', gates: { minDistanceFromWaterFt: 25 } }]);
    expect(knex.locks.map(([table]) => table)).toContain('lawn_protocol_products');
    expect(setback.LAWN_ACTION.length).toBeLessThanOrEqual(40);
    expect(knex.tables.audit_log.filter((e) => String(e.action).includes(setback.MIGRATION))).toHaveLength(0);
    const after = snapshot(knex);
    await setback.up(knex);
    expect(snapshot(knex)).toEqual(after);
  });

  test('down: every row gets its old setback back (none: the gate comes off) and the audit rows go; a second down changes nothing', async () => {
    const knex = makeKnex(gatedTables());
    await migration.up(knex);
    const start = snapshot(knex);
    await setback.up(knex);
    await setback.down(knex);
    expect(snapshot(knex)).toEqual(start);
    expect(gatesOf(knex, 'r3')).toEqual({ minDistanceFromWaterFt: 10 });
    await setback.down(knex);
    expect(snapshot(knex)).toEqual(start);
  });

  test('down keeps a row whose setback changed since up(), with its audit row; the other rows go back', async () => {
    const knex = makeKnex(gatedTables());
    await migration.up(knex);
    await setback.up(knex);
    byId(knex, 'lawn_protocol_products', 'r1').gates = { trigger: 'chinch_bugs', delayWateringHours: 24, minDistanceFromWaterFt: 30 };
    byId(knex, 'lawn_protocol_products', 'r2').gates = { maxLabelRate: 1, trigger: 'fire_ants', minDistanceFromWaterFt: 25, applyAlone: true };
    await setback.down(knex);
    expect(gatesOf(knex, 'r1')).toMatchObject({ minDistanceFromWaterFt: 30 });
    expect(gatesOf(knex, 'r2')).toEqual({ maxLabelRate: 1, trigger: 'fire_ants', applyAlone: true });
    expect(gatesOf(knex, 'r3')).toEqual({ minDistanceFromWaterFt: 10 });
    expect(setbackLogs(knex).map((log) => log.lawn_protocol_id)).toEqual(['p1']);
  });

  test.each([
    ['two catalog rows named Crosscheck', (tables) => { tables.products_catalog.push({ id: 'cross-2', name: 'LESCO Crosscheck Plus' }); }],
    ['gates that are not an object', (tables) => { for (const row of tables.lawn_protocol_products) row.gates = row.id === 'r1' ? ['x'] : 'not json'; tables.lawn_protocol_products.pop(); }],
  ])('%s: nothing changes', async (_label, shape) => {
    const tables = gatedTables();
    shape(tables);
    const knex = makeKnex(tables);
    await migration.up(knex);
    const before = snapshot(knex);
    await setback.up(knex);
    expect(snapshot(knex)).toEqual(before);
  });
});

// Follow-up 20261119010600: two Talak usage rows on one service type both move in 20261119010000; one stays.
describe('follow-up 20261119010600: each service type keeps one Crosscheck usage row from the swap', () => {
  const onePerType = require('../models/migrations/20261119010600_crosscheck_usage_one_per_type');
  const usageTables = () => {
    const tables = baseTables();
    tables.service_product_usage.push(
      { id: 'u5', product_id: TALAK, service_type: 'Mosquito', usage_amount: 4 },
      { id: 'u8', product_id: CROSS, service_type: 'Office Pair', usage_amount: 1 },
      { id: 'u9', product_id: CROSS, service_type: 'Office Pair', usage_amount: 1 },
    );
    return tables;
  };
  const usage = (knex, id) => byId(knex, 'service_product_usage', id);
  const withoutAudit = (tables) => { const { audit_log: _log, ...rest } = tables; return byIdOrder(rest); };
  let logSpy;
  beforeEach(() => { logSpy = jest.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => logSpy.mockRestore());

  test('up: the lower id stays, the other is removed whole into its audit event; rows the swap did not move stay; a re-run changes nothing', async () => {
    const knex = makeKnex(usageTables());
    await migration.up(knex);
    expect(usage(knex, 'u5')).toMatchObject({ product_id: CROSS });
    knex.locks.length = 0;
    await onePerType.up(knex);
    expect(usage(knex, 'u1')).toMatchObject({ product_id: CROSS, service_type: 'Mosquito', usage_amount: 1 });
    expect(usage(knex, 'u5')).toBeUndefined();
    const events = eventsOf(knex, onePerType.ACTION);
    expect(events).toHaveLength(1);
    expect(meta(events[0])).toMatchObject({ kind: 'removed', service_type: 'Mosquito', kept: 'u1', row: { id: 'u5', product_id: CROSS, usage_amount: 4 } });
    for (const id of ['u3', 'u4', 'u8', 'u9']) expect(usage(knex, id)).toBeDefined();
    expect(knex.locks.map(([table]) => table)).toContain('service_product_usage');
    expect(onePerType.ROLLBACK_ACTION.length).toBeLessThanOrEqual(96);
    const after = snapshot(knex);
    await onePerType.up(knex);
    expect(snapshot(knex)).toEqual(after);
  });

  test('down, then the swap\'s down: every usage row is back as it was; audit_log is only appended to', async () => {
    const knex = makeKnex(usageTables());
    const start = snapshot(knex);
    await migration.up(knex);
    await onePerType.up(knex);
    const beforeDown = snapshot(knex).audit_log;
    await onePerType.down(knex);
    expect(usage(knex, 'u5')).toMatchObject({ product_id: CROSS, usage_amount: 4 });
    expect(eventsOf(knex, onePerType.ROLLBACK_ACTION)).toHaveLength(1);
    expect(knex.tables.audit_log.slice(0, beforeDown.length)).toEqual(beforeDown);
    await onePerType.down(knex);
    expect(eventsOf(knex, onePerType.ROLLBACK_ACTION)).toHaveLength(1);
    await migration.down(knex);
    expect(withoutAudit(snapshot(knex))).toEqual(withoutAudit(start));
  });

  test('a move the swap rolled back is not counted, and down() keeps a row whose id was taken', async () => {
    const knex = makeKnex(usageTables());
    await migration.up(knex);
    const moved = eventsOf(knex, 'migration:20261119010000_house_bifenthrin_crosscheck:usage').find((e) => e.resource_id === 'u5');
    knex.tables.audit_log.push({ id: 'rb-1', action: 'migration:20261119010000_house_bifenthrin_crosscheck:usage:rollback', metadata: { from_audit_id: String(moved.id) } });
    const before = snapshot(knex);
    await onePerType.up(knex);
    expect(snapshot(knex)).toEqual(before);
    knex.tables.audit_log.pop();
    await onePerType.up(knex);
    expect(usage(knex, 'u5')).toBeUndefined();
    knex.tables.service_product_usage.push({ id: 'u5', product_id: OTHER, service_type: 'Office', usage_amount: 9 });
    await onePerType.down(knex);
    expect(usage(knex, 'u5')).toMatchObject({ product_id: OTHER, usage_amount: 9 });
    expect(eventsOf(knex, onePerType.ROLLBACK_ACTION)).toHaveLength(0);
  });

  test.each([
    ['production: one Talak usage row', (tables) => tables],
    ['two catalog rows named Crosscheck', (tables) => { tables.products_catalog.push({ id: 'cross-2', name: 'LESCO Crosscheck Plus' }); return tables; }],
  ])('%s: nothing changes', async (_label, shape) => {
    const knex = makeKnex(shape(baseTables()));
    await migration.up(knex);
    const before = snapshot(knex);
    await onePerType.up(knex);
    expect(snapshot(knex)).toEqual(before);
  });
});
