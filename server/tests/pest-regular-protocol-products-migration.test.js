// Regular general-pest settings, migration 20261119120000 (owner 2026-11-19): general pest = LESCO Crosscheck Plus (+ Taurus SC where the
// plan fits its label: 0.03% is allowed 4 a year) + LESCO 90/10 Nonionic Surfactant; Atticus Antapex WSG + Gentrol are the cockroach-treatment products.
// Synthetic data only. No database: a small in-memory fake knex (tables as arrays; jsonb columns parse on write like pg).
//
// Pinned: the usage rows of Quarterly, Bi-Monthly and General Pest Perimeter are replaced only when they are exactly the rows read from
// production (every column, notes included); any other value is skipped and logged; only the Quarterly mapping names Taurus (1.6 fl_oz); all six service lists name it; the cockroach rows and the unlisted services stay; a second run writes nothing; down
// restores a usage service type WHOLE or not at all (every written field is checked, rows read FOR UPDATE, an old row that cannot go
// back keeps the current mapping), restores default_products and the roach rows exactly, and keeps anything edited since.
const { isDeepStrictEqual } = require('util');
const migration = require('../models/migrations/20261119120000_pest_regular_protocol_products');
const protocols = require('../config/protocols.json');

const ID = {
  taurus: 'aaaaaaaa-0000-4000-8000-000000000001', cross: 'aaaaaaaa-0000-4000-8000-000000000002', surf: 'aaaaaaaa-0000-4000-8000-000000000003',
  antapex: 'aaaaaaaa-0000-4000-8000-000000000004', demand: 'aaaaaaaa-0000-4000-8000-000000000005', advionWdg: 'aaaaaaaa-0000-4000-8000-000000000006',
  gentrol: 'aaaaaaaa-0000-4000-8000-000000000007', oldGel: 'aaaaaaaa-0000-4000-8000-000000000008', liveGel: 'aaaaaaaa-0000-4000-8000-000000000009',
};
const JSON_COLUMNS = { services: ['default_products'] };

function makeKnex(initial) {
  const tables = JSON.parse(JSON.stringify(initial));
  let counter = 0;
  const sameJson = (value, text) => { try { return isDeepStrictEqual(value, JSON.parse(text)); } catch { return false; } };
  const eq = (value, v) => (value && typeof value === 'object' && typeof v === 'string' ? sameJson(value, v) : String(value) === String(v));
  const matches = (row, filters) => filters.every((f) => {
    if (f.type === 'eq') return Object.entries(f.obj).every(([k, v]) => (v == null ? row[k] == null : row[k] != null && eq(row[k], v)));
    if (f.type === 'in') return f.values.map(String).includes(String(row[f.col]));
    return row[f.col] == null;
  });
  const coerce = (table, patch) => {
    const out = { ...patch };
    for (const col of JSON_COLUMNS[table] || []) if (typeof out[col] === 'string') out[col] = JSON.parse(out[col]);
    return out;
  };
  const clone = (row) => JSON.parse(JSON.stringify(row));
  const locks = [];
  function builder(table) {
    const filters = [];
    const orders = [];
    const rows = () => {
      const hit = (tables[table] || []).filter((row) => matches(row, filters));
      for (const [col, dir] of [...orders].reverse()) hit.sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (dir === 'desc' ? -1 : 1));
      return hit;
    };
    const b = {
      where(a, v) { filters.push({ type: 'eq', obj: typeof a === 'object' ? a : { [a]: v } }); return b; },
      whereIn(col, values) { filters.push({ type: 'in', col, values }); return b; },
      whereNull(col) { filters.push({ type: 'null', col }); return b; },
      select() { return b; },
      orderBy(col, dir = 'asc') { orders.push([col, dir]); return b; },
      forUpdate() { locks.push(table); return b; },
      first() { return Promise.resolve(rows().map(clone)[0]); },
      then(resolve, reject) { return Promise.resolve(rows().map(clone)).then(resolve, reject); },
      update(patch) { const hit = rows(); hit.forEach((row) => Object.assign(row, coerce(table, patch))); return Promise.resolve(hit.length); },
      del() { const hit = rows(); tables[table] = tables[table].filter((row) => !hit.includes(row)); return Promise.resolve(hit.length); },
      insert(input) {
        const made = (Array.isArray(input) ? input : [input]).map((row) => {
          counter += 1;
          const next = { id: `gen-${counter}`, ...coerce(table, row) };
          tables[table].push(next);
          return next;
        });
        const done = Promise.resolve(made.map((row) => row.id));
        done.returning = () => Promise.resolve(made.map(clone));
        return done;
      },
    };
    return b;
  }
  const knex = (table) => builder(table);
  knex.schema = {
    hasTable: async (table) => Object.prototype.hasOwnProperty.call(tables, table),
    hasColumn: async () => true,
  };
  knex.fn = { now: () => 'now()' };
  knex.raws = [];
  knex.raw = async (sql) => { knex.raws.push(sql); };
  knex.tables = tables;
  knex.locks = locks;
  return knex;
}

const usage = (id, serviceType, product, amount, unit, primary, notes = null, per1000 = null) => ({
  id, service_type: serviceType, product_id: ID[product], usage_amount: amount, usage_unit: unit, usage_per_1000sf: per1000, is_primary: primary, notes,
});
const GENTROL_NOTE = 'Tank-mixed at 1 oz/gal with the Alpine gallon';
const DEMAND_LIST = ['Demand CS', 'Advion Gel', 'Gentrol Complete EC3'];
const FULL = ['Taurus SC', 'LESCO Crosscheck Plus', 'LESCO 90/10 Nonionic Surfactant'];
const baseTables = () => ({
  products_catalog: [
    { id: ID.taurus, name: 'Taurus SC', active: true }, { id: ID.cross, name: 'LESCO Crosscheck Plus', active: true }, { id: ID.surf, name: 'LESCO 90/10 Nonionic Surfactant', active: true },
    { id: ID.antapex, name: 'Atticus Antapex WSG', active: true }, { id: ID.demand, name: 'Demand CS', active: true }, { id: ID.advionWdg, name: 'Advion WDG Granular', active: true },
    { id: ID.gentrol, name: 'Gentrol Complete EC3', active: true },
    { id: ID.oldGel, name: 'Advion Cockroach Gel Bait', active: false }, { id: ID.liveGel, name: 'Advion Evolution Cockroach Gel Bait', active: true },
  ],
  audit_log: [],
  service_product_usage: [
    usage('q1', 'Quarterly Pest Control', 'antapex', 5, 'g', true, 'Interior baseboards + entry points (0.5 x 10 g label dose)'),
    usage('q2', 'Quarterly Pest Control', 'demand', 1.6, 'oz', true, 'Exterior perimeter band', 0.4),
    usage('b1', 'Bi-Monthly Pest Control', 'antapex', 5, 'g', true, 'Interior treatment (0.5 x 10 g label dose)'),
    usage('b2', 'Bi-Monthly Pest Control', 'demand', 1.6, 'oz', true, 'Exterior perimeter band', 0.4),
    usage('g1', 'General Pest Perimeter', 'demand', 1.6, 'oz', true, 'Exterior general pest perimeter band; use existing recurring pest pricing logic for customer price.', 0.4),
    usage('c1', 'Cockroach Treatment', 'antapex', 10, 'g', true),
    usage('c2', 'Cockroach Treatment', 'oldGel', 1, 'tube', true), usage('c3', 'Cockroach Treatment', 'gentrol', 1, 'oz', false, GENTROL_NOTE),
    usage('r1', 'German Roach Cleanout', 'oldGel', 1, 'tube', true), usage('r2', 'German Roach Cleanout', 'gentrol', 1, 'oz', false, GENTROL_NOTE),
  ],
  services: [
    { id: 's-q', service_key: 'pest_general_quarterly', name: 'Quarterly', default_products: DEMAND_LIST },
    { id: 's-s', service_key: 'pest_general_semiannual', name: 'Semiannual', default_products: DEMAND_LIST },
    { id: 's-m', service_key: 'pest_general_monthly', name: 'Monthly', default_products: ['Demand CS', 'Advion Gel'] },
    { id: 's-b', service_key: 'pest_general_bimonthly', name: 'Bi-Monthly', default_products: ['Demand CS', 'Advion Gel'] },
    { id: 's-o', service_key: 'one_time_pest_control', name: 'One-time', default_products: null },
    { id: 's-r', service_key: 'pest_re_service', name: 'Re-service', default_products: null },
    { id: 's-roach', service_key: 'cockroach_control', name: 'Cockroach', default_products: ['Atticus Antapex WSG', 'Advion Gel', 'Gentrol Complete EC3'] },
    { id: 's-german', service_key: 'german_roach', name: 'German roach', default_products: ['Advion Gel', 'Gentrol Complete EC3'] },
    { id: 's-vaddon', service_key: 'vehicle_roach_addon', name: 'Vehicle roach add-on', default_products: ['Advion Gel', 'Gentrol Complete EC3'] },
    { id: 's-vgerman', service_key: 'vehicle_german_roach', name: 'Vehicle German roach', default_products: ['Atticus Antapex WSG', 'Advion Gel', 'Gentrol Complete EC3'] },
  ],
});

const PEST_TYPES = ['Quarterly Pest Control', 'Bi-Monthly Pest Control', 'General Pest Perimeter'];
const pestRows = (knex) => knex.tables.service_product_usage.filter((row) => PEST_TYPES.includes(row.service_type));
const snapshot = (knex) => JSON.parse(JSON.stringify(knex.tables));
const names = (knex, rows) => rows.map((row) => knex.tables.products_catalog.find((p) => p.id === row.product_id).name);
const usageOf = (knex, serviceType) => knex.tables.service_product_usage.filter((row) => row.service_type === serviceType);
const rowOf = (knex, id) => knex.tables.service_product_usage.find((row) => row.id === id);
const serviceOf = (knex, key) => knex.tables.services.find((row) => row.service_key === key);
const eventsOf = (knex, action) => knex.tables.audit_log.filter((row) => row.action === action);
const meta = (row) => (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata);
const byId = (rows) => [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
const logged = (spy) => spy.mock.calls.flat().join('\n');

describe('pest regular protocol products migration: names', () => {
  test('the migration name and every audit action fit their column', () => {
    for (const step of Object.values(migration.STEPS)) {
      expect(migration.actionFor(step).length).toBeLessThanOrEqual(96);
      expect(migration.rollbackActionFor(step).length).toBeLessThanOrEqual(96);
    }
  });

  test('the template step is gone: no protocol_templates writes, no template audit step', () => {
    expect(Object.values(migration.STEPS)).not.toContain('template');
    const fs = require('fs');
    const path = require('path');
    const code = fs.readFileSync(path.join(__dirname, '../models/migrations/20261119120000_pest_regular_protocol_products.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//, '');
    expect(code).not.toMatch(/knex\('protocol_template/);
  });

  test('Taurus SC (1.6 fl_oz, 0.03%) is on the Quarterly usage mapping only (4 visits a year); Bi-Monthly and General Pest Perimeter name Crosscheck + the surfactant; all six lists name all three', () => {
    expect(Object.keys(migration.NEW_USAGE)).toEqual(['Quarterly Pest Control', 'Bi-Monthly Pest Control', 'General Pest Perimeter']);
    expect(migration.NEW_USAGE['Quarterly Pest Control'].map((row) => [row.product, row.amount, row.unit, row.primary])).toEqual([
      ['Taurus SC', 1.6, 'fl_oz', true], ['LESCO Crosscheck Plus', 4, 'fl_oz', true], ['LESCO 90/10 Nonionic Surfactant', 0.25, 'fl_oz', false],
    ]);
    for (const serviceType of ['Bi-Monthly Pest Control', 'General Pest Perimeter']) {
      expect(migration.NEW_USAGE[serviceType].map((row) => [row.product, row.amount, row.unit, row.primary])).toEqual([
        ['LESCO Crosscheck Plus', 4, 'fl_oz', true], ['LESCO 90/10 Nonionic Surfactant', 0.25, 'fl_oz', false],
      ]);
    }
    expect(Object.keys(migration.NEW_DEFAULTS).sort()).toEqual(Object.keys(migration.OLD_DEFAULTS).sort());
    for (const list of Object.values(migration.NEW_DEFAULTS)) expect(list).toEqual(FULL);
  });

  test('the amounts match the close-out house mix the client carries (Taurus 1.6, Crosscheck 4, surfactant 0.25)', () => {
    const fs = require('fs');
    const path = require('path');
    const mix = fs.readFileSync(path.join(__dirname, '../../client/src/lib/pest-default-mix.js'), 'utf8');
    // The client module is ESM, so the totals are read from its source.
    expect([...mix.matchAll(/pattern: (\/[^,]+\/i), totalAmount: ([\d.]+)/g)].map((m) => Number(m[2]))).toEqual([1.6, 4, 0.25]);
  });
});

describe('pest regular protocol products migration: up', () => {
  let knex;
  let logSpy;
  beforeEach(() => { knex = makeKnex(baseTables()); logSpy = jest.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => logSpy.mockRestore());

  test('Quarterly takes Taurus 1.6 + Crosscheck 4 + surfactant 0.25 fl_oz; Bi-Monthly and General Pest Perimeter take Crosscheck 4 + surfactant 0.25 and no Taurus', async () => {
    await migration.up(knex);
    for (const [serviceType, expected] of Object.entries(migration.NEW_USAGE)) {
      const rows = usageOf(knex, serviceType);
      expect(names(knex, rows).sort()).toEqual(expected.map((row) => row.product).sort());
      for (const row of rows) {
        const want = expected.find((mix) => mix.product === names(knex, [row])[0]);
        expect(Number(row.usage_amount)).toBe(want.amount);
        expect(row.usage_unit).toBe('fl_oz');
        expect(row.is_primary).toBe(want.primary);
        expect(row.usage_per_1000sf).toBeNull();
        expect(row.notes).toMatch(/at most 4 visits a year/);
      }
    }
    expect(names(knex, usageOf(knex, 'Bi-Monthly Pest Control'))).not.toContain('Taurus SC');
    expect(names(knex, usageOf(knex, 'General Pest Perimeter'))).not.toContain('Taurus SC');
    expect(rowOf(knex, 'c1')).toEqual(baseTables().service_product_usage.find((row) => row.id === 'c1'));
    // No row appears under a key no reader looks up.
    expect(new Set(knex.tables.service_product_usage.map((row) => row.service_type))).toEqual(new Set([...PEST_TYPES, 'Cockroach Treatment', 'German Roach Cleanout']));
  });

  test('a removed row goes whole into its audit event, and every change writes one event', async () => {
    await migration.up(knex);
    const removed = eventsOf(knex, migration.actionFor('usage')).filter((event) => meta(event).kind === 'removed');
    expect(removed).toHaveLength(5);
    expect(meta(removed.find((event) => event.resource_id === 'q1')).row).toMatchObject({
      id: 'q1', service_type: 'Quarterly Pest Control', usage_amount: 5, usage_unit: 'g', is_primary: true, notes: 'Interior baseboards + entry points (0.5 x 10 g label dose)',
    });
    expect(eventsOf(knex, migration.actionFor('usage')).filter((event) => meta(event).kind === 'inserted')).toHaveLength(7);
    expect(eventsOf(knex, migration.actionFor('services'))).toHaveLength(6);
  });

  test('every column read from production must match: a changed amount, unit, per-1000 rate, primary flag or note skips that service type', async () => {
    for (const patch of [{ usage_amount: 2 }, { usage_unit: 'fl_oz' }, { usage_per_1000sf: 0.5 }, { usage_per_1000sf: null }, { is_primary: false }, { notes: 'edited' }, { notes: null }]) {
      const tables = baseTables();
      Object.assign(tables.service_product_usage.find((row) => row.id === 'g1'), patch);
      const other = makeKnex(tables);
      await migration.up(other);
      expect(usageOf(other, 'General Pest Perimeter').map((row) => row.id)).toEqual(['g1']);
      expect(usageOf(other, 'Quarterly Pest Control')).toHaveLength(3);
    }
  });

  test('a service type with an extra or missing row is skipped and logged; the others still change', async () => {
    const tables = baseTables();
    tables.service_product_usage.push(usage('b3', 'Bi-Monthly Pest Control', 'gentrol', 1, 'oz', false));
    tables.service_product_usage = tables.service_product_usage.filter((row) => row.id !== 'q2');
    knex = makeKnex(tables);
    await migration.up(knex);
    expect(usageOf(knex, 'Quarterly Pest Control').map((row) => row.id)).toEqual(['q1']);
    expect(usageOf(knex, 'Bi-Monthly Pest Control')).toHaveLength(3);
    expect(names(knex, usageOf(knex, 'General Pest Perimeter')).sort()).toEqual(['LESCO 90/10 Nonionic Surfactant', 'LESCO Crosscheck Plus']);
    expect(logged(logSpy)).toMatch(/"Quarterly Pest Control" usage rows are not the ones read/);
  });

  test('a missing, duplicated or inactive house product leaves the usage rows AND the six service lists alone', async () => {
    const breaks = [
      (t) => t.products_catalog.push({ id: 'dup', name: 'LESCO Crosscheck Plus', active: true }),
      (t) => { t.products_catalog = t.products_catalog.filter((row) => row.id !== ID.surf); },
      (t) => { t.products_catalog.find((row) => row.id === ID.taurus).active = false; },
    ];
    for (const change of breaks) {
      const tables = baseTables();
      change(tables);
      const other = makeKnex(tables);
      await migration.up(other);
      expect(pestRows(other)).toEqual(pestRows(makeKnex(tables)));
      for (const key of Object.keys(migration.OLD_DEFAULTS)) expect(serviceOf(other, key).default_products).toEqual(serviceOf(makeKnex(baseTables()), key).default_products);
      // The roach steps do not need the house products and still run.
      expect(serviceOf(other, 'german_roach').default_products).toEqual(['Atticus Antapex WSG', migration.GEL_LIVE, 'Gentrol Complete EC3']);
    }
  });

  test('all six general-pest services take Taurus + Crosscheck + surfactant; the cockroach services never do', async () => {
    await migration.up(knex);
    for (const key of Object.keys(migration.OLD_DEFAULTS)) expect(serviceOf(knex, key).default_products).toEqual(FULL);
    for (const key of ['cockroach_control', 'german_roach', 'vehicle_roach_addon', 'vehicle_german_roach']) {
      expect(serviceOf(knex, key).default_products).not.toContain('Taurus SC');
      expect(serviceOf(knex, key).default_products).not.toContain('Demand CS');
    }
  });

  test('a service whose list is not the one read (changed order, an added product, a value where NULL was) is kept', async () => {
    const tables = baseTables();
    tables.services.find((row) => row.id === 's-q').default_products = ['Advion Gel', 'Demand CS', 'Gentrol Complete EC3'];
    tables.services.find((row) => row.id === 's-m').default_products = ['Demand CS', 'Advion Gel', 'Tekko Pro IGR'];
    tables.services.find((row) => row.id === 's-o').default_products = ['Demand CS'];
    knex = makeKnex(tables);
    await migration.up(knex);
    expect(serviceOf(knex, 'pest_general_quarterly').default_products).toEqual(['Advion Gel', 'Demand CS', 'Gentrol Complete EC3']);
    expect(serviceOf(knex, 'pest_general_monthly').default_products).toEqual(['Demand CS', 'Advion Gel', 'Tekko Pro IGR']);
    expect(serviceOf(knex, 'one_time_pest_control').default_products).toEqual(['Demand CS']);
    expect(serviceOf(knex, 'pest_general_semiannual').default_products).toEqual(FULL);
    expect(serviceOf(knex, 'pest_re_service').default_products).toEqual(FULL);
  });

  test('the roach services name the live gel in place of "Advion Gel"; german_roach also gains Atticus Antapex WSG', async () => {
    await migration.up(knex);
    expect(serviceOf(knex, 'cockroach_control').default_products).toEqual(['Atticus Antapex WSG', migration.GEL_LIVE, 'Gentrol Complete EC3']);
    expect(serviceOf(knex, 'german_roach').default_products).toEqual(['Atticus Antapex WSG', migration.GEL_LIVE, 'Gentrol Complete EC3']);
    expect(serviceOf(knex, 'vehicle_roach_addon').default_products).toEqual([migration.GEL_LIVE, 'Gentrol Complete EC3']);
    expect(serviceOf(knex, 'vehicle_german_roach').default_products).toEqual(['Atticus Antapex WSG', migration.GEL_LIVE, 'Gentrol Complete EC3']);
    expect(eventsOf(knex, migration.actionFor('roach_services'))).toHaveLength(4);
  });

  test('a roach service list that is not the one read is kept; german_roach needs its exact list', async () => {
    const tables = baseTables();
    tables.services.find((row) => row.id === 's-german').default_products = ['Advion Gel', 'Gentrol Complete EC3', 'Tekko Pro IGR'];
    tables.services.find((row) => row.id === 's-vaddon').default_products = ['Advion Gel', 'Advion Gel'];
    tables.services.find((row) => row.id === 's-roach').default_products = ['Atticus Antapex WSG', 'Gentrol Complete EC3'];
    knex = makeKnex(tables);
    await migration.up(knex);
    expect(serviceOf(knex, 'german_roach').default_products).toEqual(['Advion Gel', 'Gentrol Complete EC3', 'Tekko Pro IGR']);
    expect(serviceOf(knex, 'vehicle_roach_addon').default_products).toEqual(['Advion Gel', 'Advion Gel']);
    expect(serviceOf(knex, 'cockroach_control').default_products).toEqual(['Atticus Antapex WSG', 'Gentrol Complete EC3']);
    expect(serviceOf(knex, 'vehicle_german_roach').default_products).toEqual(['Atticus Antapex WSG', migration.GEL_LIVE, 'Gentrol Complete EC3']);
  });

  test('the 1-tube primary gel rows of both roach services point at the live gel; the Gentrol note says Antapex', async () => {
    await migration.up(knex);
    for (const id of ['c2', 'r1']) expect(rowOf(knex, id)).toMatchObject({ product_id: ID.liveGel, usage_amount: 1, usage_unit: 'tube', is_primary: true });
    for (const id of ['c3', 'r2']) expect(rowOf(knex, id)).toMatchObject({ product_id: ID.gentrol, notes: 'Tank-mixed at 1 oz/gal with the Antapex gallon' });
    expect(eventsOf(knex, migration.actionFor('roach_usage'))).toHaveLength(4);
  });

  test('a gel row with any other unit, amount, per-area rate or primary flag is not repointed (its quantity would carry into the live product)', async () => {
    for (const patch of [{ usage_unit: 'g' }, { usage_unit: 'oz' }, { usage_amount: 2 }, { usage_per_1000sf: 0.5 }, { is_primary: false }]) {
      const tables = baseTables();
      Object.assign(tables.service_product_usage.find((row) => row.id === 'c2'), patch);
      const other = makeKnex(tables);
      await migration.up(other);
      expect(rowOf(other, 'c2').product_id).toBe(ID.oldGel);
      expect(rowOf(other, 'r1').product_id).toBe(ID.liveGel);
    }
  });

  test('a Gentrol note that is not exactly the text read is kept; two or no live gel rows skip the roach gel steps', async () => {
    const tables = baseTables();
    tables.service_product_usage.find((row) => row.id === 'c3').notes = 'Tank-mixed at 1 oz/gal with the Alpine gallon.';
    knex = makeKnex(tables);
    await migration.up(knex);
    expect(rowOf(knex, 'c3').notes).toBe('Tank-mixed at 1 oz/gal with the Alpine gallon.');
    for (const mutate of [(t) => t.products_catalog.push({ id: 'dup-live', name: 'Advion Evolution Cockroach Gel Bait', active: true }), (t) => { t.products_catalog = t.products_catalog.filter((row) => row.id !== ID.liveGel); }]) {
      const t2 = baseTables();
      mutate(t2);
      const other = makeKnex(t2);
      await migration.up(other);
      expect(rowOf(other, 'r1').product_id).toBe(ID.oldGel);
      expect(serviceOf(other, 'german_roach').default_products).toEqual(['Advion Gel', 'Gentrol Complete EC3']);
    }
  });

  test('two old gel rows on one service type are both left alone (the live product would record two tubes)', async () => {
    const tables = baseTables();
    tables.service_product_usage.push(usage('r8', 'German Roach Cleanout', 'oldGel', 1, 'tube', true));
    knex = makeKnex(tables);
    await migration.up(knex);
    expect(rowOf(knex, 'r1').product_id).toBe(ID.oldGel);
    expect(rowOf(knex, 'r8').product_id).toBe(ID.oldGel);
    expect(rowOf(knex, 'c2').product_id).toBe(ID.liveGel);
    expect(logged(logSpy)).toMatch(/has 2 old gel rows/);
  });

  test('a service type that already maps the live gel keeps its old gel row (the cost would count twice)', async () => {
    const tables = baseTables();
    tables.service_product_usage.push(usage('r9', 'German Roach Cleanout', 'liveGel', 1, 'tube', true));
    knex = makeKnex(tables);
    await migration.up(knex);
    expect(rowOf(knex, 'r1').product_id).toBe(ID.oldGel);
  });

  test('a second run changes nothing', async () => {
    await migration.up(knex);
    const once = snapshot(knex);
    await migration.up(knex);
    expect(snapshot(knex)).toEqual(once);
  });

  test('without the tables it does nothing and does not throw', async () => {
    const bare = makeKnex({ audit_log: [] });
    await expect(migration.up(bare)).resolves.toBeUndefined();
    await expect(migration.down(bare)).resolves.toBeUndefined();
  });

  test('the rows a step decides on are read FOR UPDATE, and the usage table is locked against concurrent writers first', async () => {
    await migration.up(knex);
    expect(knex.locks).toEqual(expect.arrayContaining(['service_product_usage', 'services']));
    expect(knex.raws.length).toBeGreaterThanOrEqual(2);
    for (const sql of knex.raws) expect(sql).toMatch(/^LOCK TABLE service_product_usage IN SHARE ROW EXCLUSIVE MODE$/);
  });
});

describe('pest regular protocol products migration: down', () => {
  let knex;
  let logSpy;
  beforeEach(() => { knex = makeKnex(baseTables()); logSpy = jest.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => logSpy.mockRestore());
  const newRowId = (serviceType, productId) => usageOf(knex, serviceType).find((row) => row.product_id === productId).id;

  test('usage rows, default_products, the roach gel rows and the Gentrol notes come back exactly', async () => {
    await migration.up(knex);
    await migration.down(knex);
    expect(byId(knex.tables.service_product_usage)).toEqual(byId(baseTables().service_product_usage));
    expect(byId(knex.tables.services)).toEqual(byId(baseTables().services));
  });

  test('up, down, up again applies the new mapping again', async () => {
    await migration.up(knex);
    const first = snapshot(knex).service_product_usage.map(({ id, ...rest }) => rest);
    await migration.down(knex);
    await migration.up(knex);
    expect(snapshot(knex).service_product_usage.map(({ id, ...rest }) => rest).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
      .toEqual(first.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
    expect(serviceOf(knex, 'pest_general_semiannual').default_products).toEqual(FULL);
    expect(serviceOf(knex, 'pest_general_quarterly').default_products).toEqual(FULL);
  });

  test('audit_log is append-only: one rollback event per reversed event, none deleted, and a second down adds none', async () => {
    await migration.up(knex);
    const ups = knex.tables.audit_log.length;
    await migration.down(knex);
    expect(knex.tables.audit_log).toHaveLength(ups * 2);
    for (const step of Object.values(migration.STEPS)) {
      const upIds = eventsOf(knex, migration.actionFor(step)).map((row) => String(row.id)).sort();
      expect(eventsOf(knex, migration.rollbackActionFor(step)).map((row) => String(meta(row).from_audit_id)).sort()).toEqual(upIds);
    }
    await migration.down(knex);
    expect(knex.tables.audit_log).toHaveLength(ups * 2);
  });

  test('a default_products list edited since is kept', async () => {
    await migration.up(knex);
    serviceOf(knex, 'pest_general_semiannual').default_products = [...FULL, 'Tekko Pro IGR'];
    await migration.down(knex);
    expect(serviceOf(knex, 'pest_general_semiannual').default_products).toEqual([...FULL, 'Tekko Pro IGR']);
    expect(serviceOf(knex, 'pest_general_monthly').default_products).toEqual(['Demand CS', 'Advion Gel']);
    expect(logged(logSpy)).toMatch(/default_products no longer holds what up\(\) wrote: kept/);
  });

  test('an edit to ANY written field (amount, unit, per-1000 rate, primary flag, notes, service type, product) keeps that service type whole', async () => {
    const edits = [
      { usage_amount: 6 }, { usage_unit: 'oz' }, { usage_per_1000sf: 0.3 }, { is_primary: false }, { notes: 'office note' }, { service_type: 'Somewhere Else' }, { product_id: ID.taurus },
    ];
    for (const patch of edits) {
      const k = makeKnex(baseTables());
      await migration.up(k);
      const before = byId(usageOf(k, 'Quarterly Pest Control'));
      const target = before.find((row) => row.product_id === ID.cross);
      Object.assign(target, patch);
      const frozen = snapshot(k).service_product_usage;
      await migration.down(k);
      // Nothing of the Quarterly mapping (the new rows, the edited one included) was deleted, and no old row was put back.
      expect(snapshot(k).service_product_usage.filter((row) => ['q1', 'q2'].includes(row.id))).toEqual([]);
      expect(byId(snapshot(k).service_product_usage.filter((row) => frozen.some((f) => f.id === row.id && (f.service_type === 'Quarterly Pest Control' || f.id === target.id)))))
        .toEqual(byId(frozen.filter((row) => row.service_type === 'Quarterly Pest Control' || row.id === target.id)));
      // The other service types still reverse.
      expect(usageOf(k, 'Bi-Monthly Pest Control').map((row) => row.id).sort()).toEqual(['b1', 'b2']);
      expect(usageOf(k, 'General Pest Perimeter').map((row) => row.id)).toEqual(['g1']);
    }
  });

  test('the rows are read FOR UPDATE, and the usage table is locked against concurrent writers, before the rollback decides', async () => {
    await migration.up(knex);
    knex.locks.length = 0;
    knex.raws.length = 0;
    await migration.down(knex);
    expect(knex.locks).toContain('service_product_usage');
    expect(knex.raws.length).toBeGreaterThanOrEqual(1);
    expect(knex.raws[0]).toMatch(/LOCK TABLE service_product_usage IN SHARE ROW EXCLUSIVE MODE/);
  });

  test('an old row that cannot go back (its product is gone) keeps that service type\'s whole current mapping, never a part of it', async () => {
    await migration.up(knex);
    knex.tables.products_catalog = knex.tables.products_catalog.filter((row) => row.id !== ID.demand);
    const generalBefore = byId(usageOf(knex, 'General Pest Perimeter'));
    const quarterlyBefore = byId(usageOf(knex, 'Quarterly Pest Control'));
    await migration.down(knex);
    expect(byId(usageOf(knex, 'General Pest Perimeter'))).toEqual(generalBefore);
    expect(byId(usageOf(knex, 'Quarterly Pest Control'))).toEqual(quarterlyBefore);
    expect(usageOf(knex, 'General Pest Perimeter')).toHaveLength(2);
    expect(logged(logSpy)).toMatch(/cannot go back/);
    // Rolling back later, once the product exists, still works for the service types left whole.
    knex.tables.products_catalog.push({ id: ID.demand, name: 'Demand CS' });
    await migration.down(knex);
    expect(usageOf(knex, 'General Pest Perimeter').map((row) => row.id)).toEqual(['g1']);
  });

  test('a row the office added since (Demand CS again, under a fresh id) keeps that service type whole: the old row does not come back beside it', async () => {
    await migration.up(knex);
    knex.tables.service_product_usage.push(usage('fresh-demand', 'General Pest Perimeter', 'demand', 1.6, 'oz', true, null, 0.4));
    const generalBefore = byId(usageOf(knex, 'General Pest Perimeter'));
    await migration.down(knex);
    expect(byId(usageOf(knex, 'General Pest Perimeter'))).toEqual(generalBefore);
    expect(usageOf(knex, 'General Pest Perimeter').map((row) => row.id)).not.toContain('g1');
    expect(logged(logSpy)).toMatch(/was added since up\(\)/);
    expect(usageOf(knex, 'Bi-Monthly Pest Control').map((row) => row.id).sort()).toEqual(['b1', 'b2']);
  });

  test('an old row whose id was taken keeps that service type whole', async () => {
    await migration.up(knex);
    knex.tables.service_product_usage.push(usage('q1', 'Quarterly Pest Control', 'taurus', 9, 'oz', false));
    const quarterlyBefore = byId(usageOf(knex, 'Quarterly Pest Control'));
    await migration.down(knex);
    expect(byId(usageOf(knex, 'Quarterly Pest Control'))).toEqual(quarterlyBefore);
  });

  test('a new row deleted by the office before the rollback keeps the service type whole as it is (nothing partial put back)', async () => {
    await migration.up(knex);
    knex.tables.service_product_usage = knex.tables.service_product_usage.filter((row) => row.id !== newRowId('General Pest Perimeter', ID.surf));
    const generalBefore = byId(usageOf(knex, 'General Pest Perimeter'));
    await migration.down(knex);
    expect(byId(usageOf(knex, 'General Pest Perimeter'))).toEqual(generalBefore);
    expect(usageOf(knex, 'General Pest Perimeter').map((row) => row.id)).not.toContain('g1');
  });

  test('a roach row the office reassigned since (another service type or product, same id) is kept: neither the gel nor the note is rolled back onto it', async () => {
    await migration.up(knex);
    rowOf(knex, 'c2').service_type = 'Somewhere Else';
    rowOf(knex, 'c3').product_id = ID.taurus;
    await migration.down(knex);
    expect(rowOf(knex, 'c2')).toMatchObject({ service_type: 'Somewhere Else', product_id: ID.liveGel });
    expect(rowOf(knex, 'c3')).toMatchObject({ product_id: ID.taurus, notes: 'Tank-mixed at 1 oz/gal with the Antapex gallon' });
    expect(rowOf(knex, 'r1').product_id).toBe(ID.oldGel);
    expect(rowOf(knex, 'r2').notes).toBe(GENTROL_NOTE);
  });

  test('a roach gel row edited since, or a note edited since, is kept', async () => {
    await migration.up(knex);
    rowOf(knex, 'c3').notes = 'edited';
    rowOf(knex, 'r1').product_id = ID.taurus;
    await migration.down(knex);
    expect(rowOf(knex, 'c3').notes).toBe('edited');
    expect(rowOf(knex, 'r1').product_id).toBe(ID.taurus);
    expect(rowOf(knex, 'c2').product_id).toBe(ID.oldGel);
    expect(rowOf(knex, 'r2').notes).toBe(GENTROL_NOTE);
  });
});

describe('pest regular protocol products: the protocol hints', () => {
  const hints = (raw) => protocols.pest.visits[0].lineMeta[raw].catalogProductHints;

  test('visit 1 perimeter lines name Crosscheck (both repellent lines) and Taurus SC (non-repellent line)', () => {
    expect(hints('Treated exterior perimeter band')).toEqual(['LESCO Crosscheck Plus']);
    expect(hints('Applied repellent solution with surfactant to perimeter')).toEqual(['LESCO Crosscheck Plus']);
    expect(hints('Applied non-repellent solution to foundation perimeter (1 ft up + 1 ft out; 18-in band at openings) + crack & crevice')).toEqual(['Taurus SC']);
  });

  test('the Taurus SC line says what its label allows (1 ft up + 1 ft out; 18-in band at openings), in the checklist and the lineMeta key alike', () => {
    const visit = protocols.pest.visits[0];
    const line = 'Applied non-repellent solution to foundation perimeter (1 ft up + 1 ft out; 18-in band at openings) + crack & crevice';
    expect(visit.primary.split('\n')).toContain(line);
    expect(Object.keys(visit.lineMeta)).toContain(line);
    expect(JSON.stringify(protocols)).not.toMatch(/6-ft/);
  });

  test('the interior crack and crevice line stays on Atticus Antapex WSG (roach activity on a regular visit is an open owner question)', () => {
    expect(hints('Treated interior cracks & crevices (activity present)')).toEqual(['Atticus Antapex WSG']);
  });

  test('the roach settings name the live gel (the old gel row is inactive) and the house bifenthrin', () => {
    const roach1 = protocols.cockroach.visits.find((v) => v.visit === 1);
    const roach2 = protocols.cockroach.visits.find((v) => v.visit === 2);
    expect(roach1.completionDefaultProducts).toEqual(['Atticus Antapex WSG', 'Gentrol Complete EC3', 'Advion Evolution Cockroach Gel Bait']);
    expect(roach1.lineMeta['Apply cockroach gel bait in targeted placements']).toMatchObject({ catalogProductHints: ['Advion Evolution Cockroach Gel Bait'], completionApplicationMethod: 'bait_placement' });
    expect(roach2.lineMeta['Treat exterior perimeter, cracks, crevices, and harborage zones where label allows'].catalogProductHints).toEqual(['LESCO Crosscheck Plus', 'Atticus Antapex WSG']);
    expect(JSON.stringify(protocols)).not.toMatch(/Advion Cockroach Gel Bait|Talstar P/);
  });

  test('visits 2 to 6 keep their hints', () => {
    const hintsByVisit = protocols.pest.visits.slice(1).map((visit) => Object.values(visit.lineMeta || {}).map((m) => m.catalogProductHints || null));
    expect(hintsByVisit).toEqual([
      [['Advion Evolution Cockroach Gel Bait'], ['Atticus Antapex WSG'], ['Gentrol Complete EC3']],
      [['Advion Ant Gel'], ['Atticus Antapex WSG'], null],
      [],
      [['Contrac Blox']],
      [],
    ]);
  });
});
