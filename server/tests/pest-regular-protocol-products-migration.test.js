// Regular general-pest protocol products, migration 20261119120000 (owner 2026-11-19): general pest = LESCO Crosscheck Plus + Taurus SC
// (+ LESCO 90/10 Nonionic Surfactant); Atticus Antapex WSG + Gentrol are the cockroach-treatment products.
// Synthetic data only. No database: a small in-memory fake knex (tables as arrays; jsonb columns parse on write like pg). The retire
// and immutability triggers of protocol_templates are Postgres; the fake only records the legal two-step (retire, then activate).
//
// Pinned: the usage rows of Quarterly, Bi-Monthly and General Pest Perimeter are replaced only when they are exactly the rows read
// from production; any other value is skipped and logged; the cockroach rows and the unlisted services stay; default_products moves
// for the six services only while each holds its listed value (NULL included); the active template gets a v2 superseding v1, with
// v1's areas, aliases and non-apply actions, and v1 retires; a second run writes nothing; down restores usage and default_products
// exactly and puts v1's own content back as a new version (a retired row cannot be re-activated); down keeps anything edited since.
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
  knex.tables = tables;
  knex.locks = locks;
  return knex;
}

const usage = (id, serviceType, product, amount, unit, primary, notes = null) => ({
  id, service_type: serviceType, product_id: ID[product], usage_amount: amount, usage_unit: unit, usage_per_1000sf: null, is_primary: primary, notes,
});
const GENTROL_NOTE = 'Tank-mixed at 1 oz/gal with the Alpine gallon';
const DEMAND_LIST = ['Demand CS', 'Advion Gel', 'Gentrol Complete EC3'];
const HOUSE = ['Taurus SC', 'LESCO Crosscheck Plus', 'LESCO 90/10 Nonionic Surfactant'];
const baseTables = () => ({
  products_catalog: [
    { id: ID.taurus, name: 'Taurus SC' }, { id: ID.cross, name: 'LESCO Crosscheck Plus' }, { id: ID.surf, name: 'LESCO 90/10 Nonionic Surfactant' },
    { id: ID.antapex, name: 'Atticus Antapex WSG' }, { id: ID.demand, name: 'Demand CS' }, { id: ID.advionWdg, name: 'Advion WDG Granular' },
    { id: ID.gentrol, name: 'Gentrol Complete EC3' },
    { id: ID.oldGel, name: 'Advion Cockroach Gel Bait', active: false }, { id: ID.liveGel, name: 'Advion Evolution Cockroach Gel Bait', active: true },
  ],
  audit_log: [],
  technicians: [
    { id: 't-tech', role: 'technician', active: true, created_at: '2026-01-01' },
    { id: 't-old-admin', role: 'admin', active: true, created_at: '2026-02-01' },
    { id: 't-new-admin', role: 'admin', active: true, created_at: '2026-03-01' },
  ],
  service_product_usage: [
    usage('q1', 'Quarterly Pest Control', 'antapex', 5, 'g', true), usage('q2', 'Quarterly Pest Control', 'demand', 1.6, 'oz', true),
    usage('b1', 'Bi-Monthly Pest Control', 'antapex', 5, 'g', true), usage('b2', 'Bi-Monthly Pest Control', 'demand', 1.6, 'oz', true),
    usage('g1', 'General Pest Perimeter', 'demand', 1.6, 'oz', true),
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
  protocol_templates: [{
    id: 'tpl-v1', protocol_key: 'ext_gp_perim', version: 'v1', supersedes_protocol_template_id: null, display_name: 'Exterior General Pest Perimeter',
    service_type: 'General Pest Control', service_line: 'pest', is_deterministic: true, status: 'active', attestation_template: 'I performed {protocol_name}: {products} on {areas}.',
    attestation_template_version: '2026.05', notes: 'Standard recurring service.', created_at: 'c1', updated_at: 'u1',
  }],
  protocol_template_products: [
    { id: 'p1', protocol_template_id: 'tpl-v1', product_id: ID.demand, product_name_snapshot: 'Demand CS', rate_basis: 'label_compliant_default', rate: null, rate_unit: null, application_method: 'exterior perimeter band', sort_order: 1 },
    { id: 'p2', protocol_template_id: 'tpl-v1', product_id: ID.antapex, product_name_snapshot: 'Alpine WSG', rate_basis: 'label_compliant_default', rate: null, rate_unit: null, application_method: 'exterior perimeter band', sort_order: 2 },
    { id: 'p3', protocol_template_id: 'tpl-v1', product_id: ID.advionWdg, product_name_snapshot: 'Advion WDG Granular', rate_basis: 'label_compliant_default', rate: null, rate_unit: null, application_method: 'granular broadcast', sort_order: 3 },
  ],
  protocol_template_areas: [
    { id: 'a1', protocol_template_id: 'tpl-v1', area_key: 'perimeter', area_label: 'Perimeter', sort_order: 1 },
    { id: 'a2', protocol_template_id: 'tpl-v1', area_key: 'garage', area_label: 'Garage', sort_order: 2 },
  ],
  protocol_template_actions: [
    { id: 'x1', protocol_template_id: 'tpl-v1', action_key: 'apply_demand_cs', action_label: 'Applied insect control — Demand CS', required: true, sort_order: 1 },
    { id: 'x2', protocol_template_id: 'tpl-v1', action_key: 'apply_alpine_wsg', action_label: 'Applied insect control — Alpine WSG', required: true, sort_order: 2 },
    { id: 'x3', protocol_template_id: 'tpl-v1', action_key: 'apply_advion_wdg', action_label: 'Applied insect control — Advion WDG Granular', required: true, sort_order: 3 },
    { id: 'x4', protocol_template_id: 'tpl-v1', action_key: 'webster_sweep', action_label: 'Webster sweep', required: true, sort_order: 4 },
    { id: 'x5', protocol_template_id: 'tpl-v1', action_key: 'glue_boards_utility', action_label: 'Glue boards', required: false, sort_order: 5 },
  ],
  protocol_template_service_types: [
    { id: 'st1', protocol_template_id: 'tpl-v1', service_type: 'General Pest Control', notes: null },
    { id: 'st2', protocol_template_id: 'tpl-v1', service_type: 'General Pest Control (Monthly)', notes: null },
    { id: 'st3', protocol_template_id: 'tpl-v1', service_type: 'General Pest Control (Bi-Monthly)', notes: null },
  ],
});

const pestRows = (knex) => knex.tables.service_product_usage.filter((row) => Object.keys(migration.OLD_USAGE).includes(row.service_type));
const snapshot = (knex) => JSON.parse(JSON.stringify(knex.tables));
const names = (knex, rows) => rows.map((row) => knex.tables.products_catalog.find((p) => p.id === row.product_id).name);
const usageOf = (knex, serviceType) => knex.tables.service_product_usage.filter((row) => row.service_type === serviceType);
const serviceOf = (knex, key) => knex.tables.services.find((row) => row.service_key === key);
const templateOf = (knex, version) => knex.tables.protocol_templates.find((row) => row.version === version);
const childrenOf = (knex, table, version) => knex.tables[table].filter((row) => row.protocol_template_id === templateOf(knex, version).id);
const eventsOf = (knex, action) => knex.tables.audit_log.filter((row) => row.action === action);
const meta = (row) => (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata);

describe('pest regular protocol products migration: names', () => {
  test('the migration name and every audit action fit their column', () => {
    for (const step of Object.values(migration.STEPS)) {
      expect(migration.actionFor(step).length).toBeLessThanOrEqual(96);
      expect(migration.rollbackActionFor(step).length).toBeLessThanOrEqual(96);
    }
  });

  test('the house mix it writes is the close-out house mix the client already carries', () => {
    const fs = require('fs');
    const path = require('path');
    const mix = fs.readFileSync(path.join(__dirname, '../../client/src/lib/pest-default-mix.js'), 'utf8');
    // The client module is ESM, so the totals are read from its source: Taurus SC 4, Crosscheck 4, surfactant 0.25.
    expect([...mix.matchAll(/pattern: (\/[^,]+\/i), totalAmount: ([\d.]+)/g)].map((m) => Number(m[2]))).toEqual([4, 4, 0.25]);
    expect(mix).toMatch(/taurus/);
    expect(mix).toMatch(/cross-\?check/);
    expect(mix).toMatch(/nonionic|non-\?ionic/);
    expect(migration.HOUSE_MIX_USAGE.map((row) => [row.product, row.amount])).toEqual([['Taurus SC', 4], ['LESCO Crosscheck Plus', 4], ['LESCO 90/10 Nonionic Surfactant', 0.25]]);
  });
});

describe('pest regular protocol products migration: up', () => {
  let knex;
  let logSpy;
  beforeEach(() => { knex = makeKnex(baseTables()); logSpy = jest.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => logSpy.mockRestore());

  test('each listed service type takes Taurus SC 4, Crosscheck 4 (primary) and the surfactant 0.25 (not primary); old rows leave', async () => {
    await migration.up(knex);
    for (const serviceType of ['Quarterly Pest Control', 'Bi-Monthly Pest Control', 'General Pest Perimeter']) {
      const rows = usageOf(knex, serviceType);
      expect(names(knex, rows).sort()).toEqual(['LESCO 90/10 Nonionic Surfactant', 'LESCO Crosscheck Plus', 'Taurus SC']);
      for (const row of rows) {
        const want = migration.HOUSE_MIX_USAGE.find((mix) => mix.product === names(knex, [row])[0]);
        expect(Number(row.usage_amount)).toBe(want.amount);
        expect(row.usage_unit).toBe('fl_oz');
        expect(row.is_primary).toBe(want.primary);
        expect(row.usage_per_1000sf).toBeNull();
      }
    }
    // The roach Antapex row stays as it is (the roach gel and note rows move in their own step, below).
    expect(usageOf(knex, 'Cockroach Treatment').find((row) => row.id === 'c1')).toEqual(baseTables().service_product_usage.find((row) => row.id === 'c1'));
    // No row appears under a key no reader looks up.
    expect(new Set(knex.tables.service_product_usage.map((row) => row.service_type))).toEqual(new Set(['Quarterly Pest Control', 'Bi-Monthly Pest Control', 'General Pest Perimeter', 'Cockroach Treatment', 'German Roach Cleanout']));
  });

  test('a removed row goes whole into its audit event, and every change writes one event', async () => {
    await migration.up(knex);
    const removed = eventsOf(knex, migration.actionFor('usage')).filter((event) => meta(event).kind === 'removed');
    expect(removed).toHaveLength(5);
    expect(meta(removed.find((event) => event.resource_id === 'q1')).row).toMatchObject({ id: 'q1', service_type: 'Quarterly Pest Control', usage_amount: 5, usage_unit: 'g', is_primary: true });
    expect(eventsOf(knex, migration.actionFor('usage')).filter((event) => meta(event).kind === 'inserted')).toHaveLength(9);
    expect(eventsOf(knex, migration.actionFor('services'))).toHaveLength(6);
    expect(eventsOf(knex, migration.actionFor('template'))).toHaveLength(1);
  });

  test('a service type whose rows are not exactly the ones read is skipped and logged, and the others still change', async () => {
    const tables = baseTables();
    tables.service_product_usage.find((row) => row.id === 'q2').usage_amount = 2;
    tables.service_product_usage.push(usage('b3', 'Bi-Monthly Pest Control', 'gentrol', 1, 'oz', false));
    knex = makeKnex(tables);
    await migration.up(knex);
    expect(usageOf(knex, 'Quarterly Pest Control').map((row) => row.id).sort()).toEqual(['q1', 'q2']);
    expect(usageOf(knex, 'Bi-Monthly Pest Control')).toHaveLength(3);
    expect(names(knex, usageOf(knex, 'General Pest Perimeter')).sort()).toEqual(HOUSE.slice().sort());
    expect(logSpy.mock.calls.flat().join('\n')).toMatch(/"Quarterly Pest Control" usage rows are not the ones read/);
  });

  test('a changed unit, primary flag or per-1000 rate is not the value read: skipped', async () => {
    for (const patch of [{ usage_unit: 'fl_oz' }, { is_primary: false }, { usage_per_1000sf: 0.5 }]) {
      const tables = baseTables();
      Object.assign(tables.service_product_usage.find((row) => row.id === 'g1'), patch);
      const other = makeKnex(tables);
      await migration.up(other);
      expect(usageOf(other, 'General Pest Perimeter').map((row) => row.id)).toEqual(['g1']);
    }
  });

  test('a missing or duplicated house product leaves the usage rows alone', async () => {
    const tables = baseTables();
    tables.products_catalog.push({ id: 'dup', name: 'Taurus SC' });
    knex = makeKnex(tables);
    await migration.up(knex);
    expect(pestRows(knex)).toEqual(pestRows(makeKnex(baseTables())));
    tables.products_catalog = tables.products_catalog.filter((row) => row.id !== 'dup' && row.id !== ID.surf);
    knex = makeKnex(tables);
    await migration.up(knex);
    expect(pestRows(knex)).toEqual(pestRows(makeKnex(baseTables())));
  });

  test('the six services take the house list; the cockroach services never take it', async () => {
    await migration.up(knex);
    for (const key of Object.keys(migration.OLD_DEFAULTS)) expect(serviceOf(knex, key).default_products).toEqual(HOUSE);
    expect(serviceOf(knex, 'cockroach_control').default_products).not.toContain('Demand CS');
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
    expect(serviceOf(knex, 'pest_general_semiannual').default_products).toEqual(HOUSE);
    expect(serviceOf(knex, 'pest_re_service').default_products).toEqual(HOUSE);
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
    for (const id of ['c2', 'r1']) {
      expect(knex.tables.service_product_usage.find((row) => row.id === id)).toMatchObject({ product_id: ID.liveGel, usage_amount: 1, usage_unit: 'tube', is_primary: true });
    }
    for (const id of ['c3', 'r2']) expect(knex.tables.service_product_usage.find((row) => row.id === id)).toMatchObject({ product_id: ID.gentrol, notes: 'Tank-mixed at 1 oz/gal with the Antapex gallon' });
    expect(eventsOf(knex, migration.actionFor('roach_usage'))).toHaveLength(4);
  });

  test('a gel row or note that is not the value read is kept; two or no live gel rows skip the roach gel steps', async () => {
    const tables = baseTables();
    tables.service_product_usage.find((row) => row.id === 'c2').usage_amount = 2;
    tables.service_product_usage.find((row) => row.id === 'c3').notes = 'Tank-mixed at 1 oz/gal with the Alpine gallon.';
    knex = makeKnex(tables);
    await migration.up(knex);
    expect(knex.tables.service_product_usage.find((row) => row.id === 'c2').product_id).toBe(ID.oldGel);
    expect(knex.tables.service_product_usage.find((row) => row.id === 'c3').notes).toBe('Tank-mixed at 1 oz/gal with the Alpine gallon.');
    expect(knex.tables.service_product_usage.find((row) => row.id === 'r1').product_id).toBe(ID.liveGel);
    for (const mutate of [(t) => t.products_catalog.push({ id: 'dup-live', name: 'Advion Evolution Cockroach Gel Bait', active: true }), (t) => { t.products_catalog = t.products_catalog.filter((row) => row.id !== ID.liveGel); }]) {
      const t2 = baseTables();
      mutate(t2);
      const other = makeKnex(t2);
      await migration.up(other);
      expect(other.tables.service_product_usage.find((row) => row.id === 'r1').product_id).toBe(ID.oldGel);
      expect(serviceOf(other, 'german_roach').default_products).toEqual(['Advion Gel', 'Gentrol Complete EC3']);
    }
  });

  test('a service type that already maps the live gel keeps its old gel row (the cost would count twice)', async () => {
    const tables = baseTables();
    tables.service_product_usage.push(usage('r9', 'German Roach Cleanout', 'liveGel', 1, 'tube', true));
    knex = makeKnex(tables);
    await migration.up(knex);
    expect(knex.tables.service_product_usage.find((row) => row.id === 'r1').product_id).toBe(ID.oldGel);
  });

  test('the template gets v2 (Crosscheck + Taurus on the perimeter band) superseding v1, and v1 retires', async () => {
    await migration.up(knex);
    const v1 = templateOf(knex, 'v1');
    const v2 = templateOf(knex, 'v2');
    expect(v1.status).toBe('retired');
    expect(v1.retired_by).toBe('t-old-admin');
    expect(v2).toMatchObject({
      status: 'active', supersedes_protocol_template_id: 'tpl-v1', protocol_key: 'ext_gp_perim', is_deterministic: true,
      display_name: v1.display_name, service_type: v1.service_type, attestation_template: v1.attestation_template,
    });
    const products = childrenOf(knex, 'protocol_template_products', 'v2');
    expect(products.map((row) => [row.product_name_snapshot, row.product_id, row.application_method, row.rate, row.rate_basis]).sort()).toEqual([
      ['LESCO Crosscheck Plus', ID.cross, 'exterior perimeter band', null, 'label_compliant_default'],
      ['Taurus SC', ID.taurus, 'exterior perimeter band', null, 'label_compliant_default'],
    ]);
    expect(v2.notes).toContain('Standard recurring service.');
  });

  test('v2 keeps v1 areas and aliases, swaps the three old apply actions for two new ones, and v1 keeps its own rows', async () => {
    await migration.up(knex);
    expect(childrenOf(knex, 'protocol_template_areas', 'v2').map((row) => row.area_key)).toEqual(['perimeter', 'garage']);
    expect(childrenOf(knex, 'protocol_template_service_types', 'v2').map((row) => row.service_type).sort())
      .toEqual(['General Pest Control', 'General Pest Control (Bi-Monthly)', 'General Pest Control (Monthly)']);
    expect(childrenOf(knex, 'protocol_template_actions', 'v2').map((row) => row.action_key).sort())
      .toEqual(['apply_lesco_crosscheck_plus', 'apply_taurus_sc', 'glue_boards_utility', 'webster_sweep']);
    expect(childrenOf(knex, 'protocol_template_products', 'v1')).toHaveLength(3);
    expect(childrenOf(knex, 'protocol_template_actions', 'v1')).toHaveLength(5);
    expect(childrenOf(knex, 'protocol_template_service_types', 'v1')).toHaveLength(3);
  });

  test('the template step is skipped (logged) when v1 is not the single active row read, or its products differ, or no admin can retire it', async () => {
    const skip = async (change) => {
      const tables = baseTables();
      change(tables);
      const other = makeKnex(tables);
      await migration.up(other);
      expect(other.tables.protocol_templates.map((row) => `${row.version}:${row.status}`)).toEqual(tables.protocol_templates.map((row) => `${row.version}:${row.status}`));
    };
    await skip((t) => { t.protocol_templates[0].status = 'retired'; });
    await skip((t) => { t.protocol_templates.push({ id: 'tpl-x', protocol_key: 'ext_gp_perim', version: 'v2', status: 'draft' }); });
    await skip((t) => { t.protocol_template_products.pop(); });
    await skip((t) => { t.protocol_template_products[0].product_name_snapshot = 'Talstar P'; });
    await skip((t) => { t.technicians = [{ id: 't-tech', role: 'technician', active: true }]; });
    await skip((t) => { t.products_catalog = t.products_catalog.filter((row) => row.id !== ID.taurus); });
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

  test('the rows a step decides on are read FOR UPDATE', async () => {
    await migration.up(knex);
    expect(knex.locks).toEqual(expect.arrayContaining(['service_product_usage', 'services', 'protocol_templates']));
  });
});

describe('pest regular protocol products migration: down', () => {
  let knex;
  let logSpy;
  beforeEach(() => { knex = makeKnex(baseTables()); logSpy = jest.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => logSpy.mockRestore());
  const byId = (rows) => [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));

  test('usage rows and default_products come back exactly', async () => {
    await migration.up(knex);
    await migration.down(knex);
    expect(byId(knex.tables.service_product_usage)).toEqual(byId(baseTables().service_product_usage));
    expect(byId(knex.tables.services)).toEqual(byId(baseTables().services));
  });

  test('the roach gel rows, the Gentrol notes and the roach service lists come back exactly; an edited note or row is kept', async () => {
    await migration.up(knex);
    await migration.down(knex);
    expect(byId(knex.tables.service_product_usage)).toEqual(byId(baseTables().service_product_usage));
    expect(serviceOf(knex, 'german_roach').default_products).toEqual(['Advion Gel', 'Gentrol Complete EC3']);
    await migration.up(knex);
    knex.tables.service_product_usage.find((row) => row.id === 'c3').notes = 'edited';
    knex.tables.service_product_usage.find((row) => row.id === 'r1').product_id = ID.taurus;
    await migration.down(knex);
    expect(knex.tables.service_product_usage.find((row) => row.id === 'c3').notes).toBe('edited');
    expect(knex.tables.service_product_usage.find((row) => row.id === 'r1').product_id).toBe(ID.taurus);
    expect(knex.tables.service_product_usage.find((row) => row.id === 'c2').product_id).toBe(ID.oldGel);
  });

  test('the template: v2 retires and v1 content returns as a new active version superseding v2', async () => {
    await migration.up(knex);
    await migration.down(knex);
    const restored = templateOf(knex, 'v1-restored');
    expect(templateOf(knex, 'v2').status).toBe('retired');
    expect(restored).toMatchObject({ status: 'active', supersedes_protocol_template_id: templateOf(knex, 'v2').id, attestation_template: templateOf(knex, 'v1').attestation_template });
    expect(childrenOf(knex, 'protocol_template_products', 'v1-restored').map((row) => row.product_name_snapshot)).toEqual(['Demand CS', 'Alpine WSG', 'Advion WDG Granular']);
    expect(childrenOf(knex, 'protocol_template_actions', 'v1-restored').map((row) => row.action_key)).toEqual(['apply_demand_cs', 'apply_alpine_wsg', 'apply_advion_wdg', 'webster_sweep', 'glue_boards_utility']);
    expect(childrenOf(knex, 'protocol_template_service_types', 'v1-restored')).toHaveLength(3);
    expect(knex.tables.protocol_templates.filter((row) => row.status === 'active')).toHaveLength(1);
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
    serviceOf(knex, 'pest_general_quarterly').default_products = [...HOUSE, 'Tekko Pro IGR'];
    await migration.down(knex);
    expect(serviceOf(knex, 'pest_general_quarterly').default_products).toEqual([...HOUSE, 'Tekko Pro IGR']);
    expect(serviceOf(knex, 'pest_general_monthly').default_products).toEqual(['Demand CS', 'Advion Gel']);
    expect(logSpy.mock.calls.flat().join('\n')).toMatch(/default_products no longer holds what up\(\) wrote: kept/);
  });

  test('a usage row edited since keeps its service type on the new rows, and the old rows stay out (no double count)', async () => {
    await migration.up(knex);
    const edited = knex.tables.service_product_usage.find((row) => row.service_type === 'Quarterly Pest Control' && row.product_id === ID.taurus);
    edited.usage_amount = 6;
    await migration.down(knex);
    expect(names(knex, usageOf(knex, 'Quarterly Pest Control'))).toEqual(['Taurus SC']);
    expect(usageOf(knex, 'Quarterly Pest Control').map((row) => row.id)).toEqual([edited.id]);
    expect(usageOf(knex, 'Bi-Monthly Pest Control').map((row) => row.id).sort()).toEqual(['b1', 'b2']);
    expect(usageOf(knex, 'General Pest Perimeter').map((row) => row.id)).toEqual(['g1']);
  });

  test('an old row whose id was taken, or whose product is gone, stays out', async () => {
    await migration.up(knex);
    knex.tables.products_catalog = knex.tables.products_catalog.filter((row) => row.id !== ID.demand);
    await migration.down(knex);
    expect(usageOf(knex, 'General Pest Perimeter')).toEqual([]);
    expect(logSpy.mock.calls.flat().join('\n')).toMatch(/cannot go back/);
  });

  test('a template that was changed since (no longer active v2) is kept', async () => {
    await migration.up(knex);
    templateOf(knex, 'v2').status = 'retired';
    await migration.down(knex);
    expect(knex.tables.protocol_templates.map((row) => row.version)).toEqual(['v1', 'v2']);
  });
});

describe('pest regular protocol products: the protocol hints', () => {
  const hints = (raw) => protocols.pest.visits[0].lineMeta[raw].catalogProductHints;

  test('visit 1 perimeter lines name Crosscheck (both repellent lines) and Taurus SC (non-repellent line)', () => {
    expect(hints('Treated exterior perimeter band')).toEqual(['LESCO Crosscheck Plus']);
    expect(hints('Applied repellent solution with surfactant to perimeter')).toEqual(['LESCO Crosscheck Plus']);
    expect(hints('Applied non-repellent solution to perimeter (6-ft band + crack & crevice)')).toEqual(['Taurus SC']);
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
