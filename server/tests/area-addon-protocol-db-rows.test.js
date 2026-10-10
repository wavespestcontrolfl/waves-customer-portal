/**
 * The governed rates and limits of the five chemical add-ons are in the DB-backed protocol store AND the JSON program, and
 * the two cannot disagree (Codex round 9 on #6135, asked three times).
 *
 * The store is lawn_protocols / lawn_protocol_windows / lawn_protocol_products (rate_per_1000, rate_unit, gates,
 * annual_counter): the documented DB authority for a product's rate, gates and windows in a treatment (AGENTS.md "Lawn
 * protocol data fan-out"). The protocol audits and the readiness checks read it. The tables need a grass track and a
 * calendar month; a keyed one-time treatment has neither, so it is filed under the track 'area_addon' (no lawn lookup
 * filters by it) and month 0 = any month. The catalog default rates (Arena 0.29, Acelepryn 0.05) belong to the lawn
 * program and the migration never touches products_catalog.
 */
const fs = require('fs');
const path = require('path');
const protocols = require('../config/protocols.json');
const { AREA_ADDONS } = require('../services/pricing-engine/constants');
const migration = require('../models/migrations/20261010120000_area_addon_protocol_rows');

const program = protocols.area_addon;
const byServiceKey = Object.fromEntries(Object.values(AREA_ADDONS.items).map((cfg) => [cfg.serviceKey, cfg]));
const visitOf = (serviceKey) => program.visits.find((v) => v.visit === migration.ADDONS.find((a) => a.serviceKey === serviceKey).visit);

describe('the DB rows and the JSON program agree, add-on by add-on', () => {
  test('one row per chemical add-on, none for the web sweep, in the program\'s visit order', () => {
    const chemical = Object.values(AREA_ADDONS.items).filter((cfg) => cfg.maxPerYear !== null).map((cfg) => cfg.serviceKey);
    expect(migration.ADDONS.map((a) => a.serviceKey).sort()).toEqual(chemical.sort());
    expect(migration.ADDONS.map((a) => a.visit)).toEqual(program.visits.map((v) => v.visit));
  });

  test.each(migration.ADDONS.map((a) => [a.serviceKey, a]))('%s: product, rate, unit, yearly count, interval and grass equal the program and AREA_ADDONS', (serviceKey, row) => {
    const visit = visitOf(serviceKey);
    const facts = visit.labelFacts;
    const cfg = byServiceKey[serviceKey];
    expect(row.product).toBe(Object.values(visit.lineMeta)[0].catalogProductHints[0]);
    expect(row.product).toBe(cfg.limitProduct);
    expect(row.ratePer1000).toBe(facts.ratePer1000);
    expect(row.rateUnit).toBe(facts.rateUnit);
    expect(row.maxPerYear).toBe(cfg.maxPerYear);
    expect(row.minDaysApart).toBe(cfg.minDaysApart || null);
    expect(row.requiresGrass).toBe(facts.requiresGrass || null);
    expect(row.requiresGrass).toBe(cfg.requiresGrassTrack || null);
    expect(row.title).toBe(visit.visit_type);
    expect(row.goal).toBe(visit.main_goal);
    expect(migration.gatesOf(row)).toEqual({ trigger: 'area_addon_sold', addOnServiceKey: serviceKey, ...(row.requiresGrass ? { requiresGrass: row.requiresGrass } : {}) });
    expect(migration.counterOf(row)).toEqual({ maxApplications: cfg.maxPerYear, windowMonths: 12, ...(cfg.minDaysApart ? { minDaysApart: cfg.minDaysApart } : {}) });
  });

  test('the numbers the owner rulings fixed, spelled out', () => {
    const rows = Object.fromEntries(migration.ADDONS.map((a) => [a.product, [a.ratePer1000, a.rateUnit, a.maxPerYear, a.minDaysApart]]));
    expect(rows).toEqual({
      'Snapshot 2.5TG': [3.45, 'lb', 4, 60],
      'Arena 50 WDG': [0.147, 'oz', 2, 56],
      'Topchoice Granular Insecticide': [2, 'lb', 1, null],
      'Acelepryn Insecticide': [0.184, 'fl_oz', 1, null],
      'Roundup QuikPro SC': [16, 'fl_oz', 2, null],
    });
  });

  test('the migration never writes the catalog (Arena 0.29 and Acelepryn 0.05 stay the lawn program\'s) and is frozen to its own constants', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'models', 'migrations', '20261010120000_area_addon_protocol_rows.js'), 'utf8');
    expect(src).not.toMatch(/products_catalog'\)\s*\.(update|insert|del)/);
    expect(src).not.toMatch(/require\([^)]*(protocols\.json|pricing-engine)/);
  });
});

// A minimal in-memory knex: the tables as arrays; where(obj) / first / select / insert().returning / del.
function fakeKnex(seed = {}) {
  let n = 0;
  const tables = {
    lawn_protocols: [], lawn_protocol_windows: [], lawn_protocol_products: [], lawn_protocol_audit_log: [],
    products_catalog: [
      { id: 'p-snap', name: 'Snapshot 2.5TG', active: true }, { id: 'p-arena', name: 'Arena 50 WDG', active: true },
      { id: 'p-top', name: 'Topchoice Granular Insecticide', active: true }, { id: 'p-acel', name: 'Acelepryn Insecticide', active: true },
    ],
    product_aliases: [{ product_id: 'p-round', alias_name: 'Roundup QuikPro SC' }],
    ...seed,
  };
  const knex = (table) => {
    if (!tables[table]) throw new Error(`unexpected ${table}`);
    const preds = [];
    const q = {
      where(cond) { preds.push((r) => Object.entries(cond).every(([k, v]) => r[k] === v)); return q; },
      orderBy() { return q; },
      first() { return Promise.resolve(tables[table].find((r) => preds.every((p) => p(r)))); },
      select() { return Promise.resolve(tables[table].filter((r) => preds.every((p) => p(r)))); },
      then(resolve, reject) { return Promise.resolve(tables[table].filter((r) => preds.every((p) => p(r)))).then(resolve, reject); },
      insert(row) { const made = { id: `id-${n += 1}`, ...row }; tables[table].push(made); return { returning: async () => [{ id: made.id }] }; },
      async del() { const hit = tables[table].filter((r) => preds.every((p) => p(r))); for (const r of hit) tables[table].splice(tables[table].indexOf(r), 1); return hit.length; },
    };
    return q;
  };
  knex.schema = { hasTable: async (t) => !!tables[t] };
  knex.tables = tables;
  return knex;
}

describe('20261010120000: the rows in the store', () => {
  test('writes the protocol, one window per add-on and one governed product row each, with the numbers and gates of the program', async () => {
    const knex = fakeKnex();
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await migration.up(knex);
    log.mockRestore();
    const [protocol] = knex.tables.lawn_protocols;
    expect(knex.tables.lawn_protocols).toHaveLength(1);
    expect(protocol).toMatchObject({ protocol_key: 'area_addon', grass_track: 'area_addon', status: 'active', region: 'swfl' });
    expect(knex.tables.lawn_protocol_windows.map((w) => [w.window_key, w.month, w.visit_type])).toEqual(migration.ADDONS.map((a) => [a.serviceKey, 0, 'area_addon']));
    expect(knex.tables.lawn_protocol_products).toHaveLength(5);
    for (const product of knex.tables.lawn_protocol_products) {
      const a = migration.ADDONS.find((x) => x.product === product.product_name);
      expect(product).toMatchObject({ rate_per_1000: a.ratePer1000, rate_unit: a.rateUnit, role: 'area_addon', default_in_plan: false });
      expect(JSON.parse(product.gates)).toEqual(migration.gatesOf(a));
      expect(JSON.parse(product.annual_counter)).toEqual(migration.counterOf(a));
    }
    // the catalog product is linked by exact name, else alias (Roundup is only an alias here)
    expect(knex.tables.lawn_protocol_products.map((p) => p.product_id)).toEqual(['p-snap', 'p-arena', 'p-top', 'p-acel', 'p-round']);
    expect(knex.tables.lawn_protocol_audit_log).toHaveLength(1);
    expect(knex.tables.products_catalog.every((p) => p.default_rate_per_1000 === undefined)).toBe(true);
  });

  test('a second run writes nothing; a window or product row that exists is never touched', async () => {
    const knex = fakeKnex();
    await migration.up(knex);
    knex.tables.lawn_protocol_products[0].rate_per_1000 = 9;
    await migration.up(knex);
    expect(knex.tables.lawn_protocols).toHaveLength(1);
    expect(knex.tables.lawn_protocol_windows).toHaveLength(5);
    expect(knex.tables.lawn_protocol_products).toHaveLength(5);
    expect(knex.tables.lawn_protocol_products[0].rate_per_1000).toBe(9);
    expect(knex.tables.lawn_protocol_audit_log).toHaveLength(1);
  });

  test('down removes only what up wrote and leaves a product row that became a default selection', async () => {
    const knex = fakeKnex();
    await migration.up(knex);
    knex.tables.lawn_protocol_products[1].default_in_plan = true;
    await migration.down(knex);
    expect(knex.tables.lawn_protocol_products).toHaveLength(1);
    expect(knex.tables.lawn_protocol_windows).toHaveLength(1);
    expect(knex.tables.lawn_protocols).toHaveLength(1);
    knex.tables.lawn_protocol_products[0].default_in_plan = false;
    await migration.down(knex);
    await migration.up(knex);
    await migration.down(knex);
    expect(knex.tables.lawn_protocol_products).toHaveLength(1);
  });

  test('a missing table skips the whole migration', async () => {
    const knex = fakeKnex();
    knex.schema = { hasTable: async (t) => t !== 'lawn_protocol_audit_log' };
    await migration.up(knex);
    await migration.down(knex);
    expect(knex.tables.lawn_protocols).toEqual([]);
  });
});

describe('a protocol row\'s rate is the governed rate of that treatment; the catalog default stays the product\'s fallback', () => {
  // The established mechanism (waveguard-plan-engine productRatePer1000): a rate stated by the protocol wins
  // (source 'protocol_rate') and the catalog default is the fallback when the protocol states none. The area add-on
  // rows use it: the catalog defaults (Arena 0.29 oz, Acelepryn 0.05 fl oz) belong to the lawn program and are not edited.
  const fs = require('fs');
  const path = require('path');
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  test('the plan engine reads a protocol rate before the catalog default', () => {
    const src = read('services/waveguard-plan-engine.js');
    const protocolFirst = src.indexOf("source: 'protocol_rate'");
    const catalogFallback = src.indexOf("source: 'catalog_default_rate'");
    expect(protocolFirst).toBeGreaterThan(-1);
    expect(catalogFallback).toBeGreaterThan(protocolFirst);
  });

  // The catalog label range each governed rate must sit inside (products_catalog min / max label rate per 1,000 sq ft,
  // prod 2026-10-08; null = the catalog states no bound). A governed rate outside the label range is never valid.
  const CATALOG_LABEL_RANGE = {
    'Snapshot 2.5TG': { min: 2.3, max: 4.6, unit: 'lb' },
    'Arena 50 WDG': { min: null, max: 0.29, unit: 'oz' },
    'Topchoice Granular Insecticide': { min: null, max: 2, unit: 'lb' },
    'Acelepryn Insecticide': { min: 0.05, max: 0.37, unit: 'fl_oz' },
    'Roundup QuikPro SC': { min: null, max: 16, unit: 'fl_oz' },
  };

  test('every add-on protocol rate is in the catalog unit and inside the catalog label range', () => {
    const migration = require('../models/migrations/20261010120000_area_addon_protocol_rows');
    expect(migration.ADDONS.map((a) => a.product).sort()).toEqual(Object.keys(CATALOG_LABEL_RANGE).sort());
    for (const addOn of migration.ADDONS) {
      const range = CATALOG_LABEL_RANGE[addOn.product];
      expect(addOn.rateUnit).toBe(range.unit);
      if (range.min !== null) expect(addOn.ratePer1000).toBeGreaterThanOrEqual(range.min);
      expect(addOn.ratePer1000).toBeLessThanOrEqual(range.max);
    }
  });

  test('no migration of this PR edits a catalog default rate', () => {
    const dir = path.join(__dirname, '..', 'models', 'migrations');
    const mine = fs.readdirSync(dir).filter((f) => /area_addon/.test(f));
    expect(mine.length).toBeGreaterThanOrEqual(14);
    for (const file of mine) expect(fs.readFileSync(path.join(dir, file), 'utf8')).not.toMatch(/default_rate_per_1000\s*:/);
  });
});
