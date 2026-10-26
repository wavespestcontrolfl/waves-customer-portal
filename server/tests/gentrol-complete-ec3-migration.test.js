const fs = require('fs');
const path = require('path');

const migration = require('../models/migrations/20261026070000_gentrol_complete_ec3_identity.js');

const MIGRATIONS = path.join(__dirname, '../models/migrations');

// A small in-memory knex stand-in: products_catalog and product_aliases are arrays of rows;
// where / whereNull filter them; update, insert, del, first and select act on the matches.
// Every call is also recorded, and the services rename is a recorded raw statement.
function fakeKnex({ product = true, aliases = [], targets = ['German cockroaches', 'American cockroaches'] } = {}) {
  const calls = { where: [], update: [], insert: [], del: [], raw: [], tables: [] };
  const db = {
    products_catalog: product ? [{ id: 'p-1', name: 'Gentrol IGR', epa_reg_number: '2724-351', target_pests: targets }] : [],
    product_aliases: aliases.map((alias, i) => ({ id: `a-${i}`, vendor_id: null, ...alias })),
  };
  const knex = (table) => {
    calls.tables.push(table);
    const rows = db[table];
    let matched = rows.slice();
    const builder = {
      where(cond) { calls.where.push({ table, cond }); matched = matched.filter((r) => Object.entries(cond).every(([k, v]) => r[k] === v)); return builder; },
      // Only the shape the migration uses: "(target_pests = ?::jsonb OR ...)" with JSON bindings.
      whereRaw(sql, bindings) { matched = matched.filter((r) => bindings.some((b) => JSON.stringify(r.target_pests) === b)); return builder; },
      whereNull(col) { matched = matched.filter((r) => r[col] == null); return builder; },
      select() { return Promise.resolve(matched.map((r) => ({ ...r }))); },
      first() { return Promise.resolve(matched[0] ? { ...matched[0] } : undefined); },
      update(values) { calls.update.push({ table, values }); matched.forEach((r) => Object.assign(r, values, typeof values.target_pests === 'string' ? { target_pests: JSON.parse(values.target_pests) } : {})); return Promise.resolve(matched.length); },
      insert(values) { calls.insert.push({ table, values }); rows.push({ id: `new-${rows.length}`, ...values }); return Promise.resolve([1]); },
      del() { calls.del.push({ table, ids: matched.map((r) => r.id) }); db[table] = rows.filter((r) => !matched.includes(r)); return Promise.resolve(matched.length); },
    };
    return builder;
  };
  knex.fn = { now: () => 'NOW()' };
  knex.schema = { hasTable: async () => true, hasColumn: async () => true };
  knex.raw = jest.fn(async (sql, bindings) => { calls.raw.push({ sql, bindings }); return { rowCount: 2 }; });
  return { knex, calls, db };
}

describe('20261026070000 Gentrol Complete EC3 identity', () => {
  let log;
  beforeEach(() => { log = jest.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { log.mockRestore(); });

  test('the old values it restores are what the seeding migrations wrote', () => {
    const batch1 = fs.readFileSync(path.join(MIGRATIONS, '20260528000002_inventory_product_data_completion_batch1.js'), 'utf8');
    const backfill = fs.readFileSync(path.join(MIGRATIONS, '20260712100000_catalog_label_rate_backfill.js'), 'utf8');
    // The live note is the batch 1 note, then the backfill's note appended with " | " (production value read 2026-10-26).
    const [batchNote, backfillNote] = migration.OLD.label_source_note.split(' | ');
    expect(batch1).toContain(batchNote);
    // The backfill source holds the second note JSON-escaped inside a JS string.
    expect(backfill).toContain(JSON.stringify(backfillNote).slice(1, -1));
    expect(batch1).toContain("epa_reg_number: '2724-351'");
    expect(batch1).toContain(`active_ingredient: '${migration.OLD.active_ingredient}'`);
    const display = fs.readFileSync(path.join(MIGRATIONS, '20260712000050_product_display_names_report_label_data.js'), 'utf8');
    expect(display).toContain(migration.OLD.reentry_summary);
  });

  test('up changes only the row that still reads Gentrol IGR with EPA 2724-351', async () => {
    const { knex, calls } = fakeKnex();
    await migration.up(knex);
    expect(calls.where[0]).toEqual({ table: 'products_catalog', cond: { name: 'Gentrol IGR', epa_reg_number: '2724-351' } });
    // The identity update, then the seed-only target_pests write.
    const catalogUpdates = calls.update.filter((u) => u.table === 'products_catalog' && !('target_pests' in u.values));
    expect(catalogUpdates).toHaveLength(1);
    expect(catalogUpdates[0].values).toMatchObject({
      name: 'Gentrol Complete EC3',
      active_ingredient: 'Lambda-cyhalothrin 1.5% + (S)-Hydroprene 1.5%',
      moa_group: 'Group 3A + 7A',
      formulation: 'emulsifiable concentrate',
      default_rate: '1.3',
      epa_reg_number: '89459-119',
    });
    // category and product_type are not touched: protocol matching and the visit email read the category.
    for (const column of ['category', 'product_type', 'target_pests', 'rei_hours']) {
      expect(catalogUpdates[0].values).not.toHaveProperty(column);
    }
    expect(calls.raw).toHaveLength(1);
    expect(calls.raw[0].bindings).toEqual(['Gentrol IGR', 'Gentrol Complete EC3', 'Gentrol IGR']);
  });

  test('up is a no-op when the row was already corrected or edited (no rename, no alias)', async () => {
    const { knex, calls } = fakeKnex({ product: false });
    await migration.up(knex);
    expect(calls.raw).toEqual([]);
    expect(calls.insert).toEqual([]);
  });

  test('up adds the old name as a vendor-less alias of the row, so exact-name lookups still find it', async () => {
    const { knex, calls, db } = fakeKnex();
    await migration.up(knex);
    expect(calls.insert).toEqual([{ table: 'product_aliases', values: { product_id: 'p-1', alias_name: 'Gentrol IGR', vendor_id: null } }]);
    // The alias is found by both exact-name lookups: the receipt matcher and the protocol default-product resolver.
    const { activeProductsForAlias } = require('../services/purchase-receipts/product-matcher');
    const aliasRows = db.product_aliases.map((a) => ({ ...a, id: a.product_id }));
    expect(activeProductsForAlias('gentrol  IGR', aliasRows).map((r) => r.id)).toEqual(['p-1']);
    const { resolveCatalogProductForName } = require('../services/completion-product-defaults');
    const catalog = [
      { id: 'p-1', name: 'Gentrol Complete EC3', aliases: db.product_aliases.map((a) => a.alias_name) },
      { id: 'p-2', name: 'Tekko Pro IGR', aliases: [] },
    ];
    expect(resolveCatalogProductForName('Gentrol IGR', catalog).id).toBe('p-1');
    // Without the alias the token-subset step cannot reach it ("IGR" is not a token of the new name).
    expect(resolveCatalogProductForName('Gentrol IGR', catalog.map((c) => ({ ...c, aliases: [] })))).toBeNull();
  });

  test('up adds no alias when one with the same normalized name already exists (any vendor, any product)', async () => {
    for (const existing of [
      { product_id: 'p-1', alias_name: 'gentrol igr' },
      { product_id: 'p-9', alias_name: 'GENTROL-IGR', vendor_id: 'v-1' },
    ]) {
      const { knex, calls } = fakeKnex({ aliases: [existing] });
      await migration.up(knex);
      expect(calls.insert).toEqual([]);
    }
  });

  test('down restores every changed column, only while the row holds the new identity', async () => {
    const { knex, calls, db } = fakeKnex();
    Object.assign(db.products_catalog[0], { name: 'Gentrol Complete EC3', epa_reg_number: '89459-119' });
    await migration.down(knex);
    const catalogUpdate = calls.update.find((u) => u.table === 'products_catalog' && 'name' in u.values);
    expect(catalogUpdate.values).toMatchObject({
      name: 'Gentrol IGR', epa_reg_number: '2724-351', default_rate: '1', moa_group: 'Group 7A', formulation: 'concentrate',
      label_source_note: migration.OLD.label_source_note,
    });
    expect(Object.keys(migration.OLD).sort()).toEqual(
      [...Object.keys(migration.NEW), 'label_verified_at'].sort(),
    );
    expect(calls.raw[0].bindings).toEqual(['Gentrol Complete EC3', 'Gentrol IGR', 'Gentrol Complete EC3']);
  });

  test('down leaves the alias in place (it may predate the migration, and is harmless on a row named Gentrol IGR)', async () => {
    const { knex, calls, db } = fakeKnex({
      aliases: [
        { product_id: 'p-1', alias_name: 'Gentrol IGR' },
        { product_id: 'p-1', alias_name: 'Zoecon 10578' },
      ],
    });
    Object.assign(db.products_catalog[0], { name: 'Gentrol Complete EC3', epa_reg_number: '89459-119' });
    await migration.down(knex);
    expect(calls.del).toEqual([]);
    expect(db.product_aliases.map((a) => a.alias_name)).toEqual(['Gentrol IGR', 'Zoecon 10578']);
    expect(db.products_catalog[0].name).toBe('Gentrol IGR');
  });

  test.each([
    ['the seed', ['German cockroaches', 'American cockroaches']],
    ['the seed in the other order', ['American cockroaches', 'German cockroaches']],
  ])('up sets target_pests to German cockroaches only when it is exactly %s', async (_label, targets) => {
    const { knex, db } = fakeKnex({ targets });
    await migration.up(knex);
    expect(db.products_catalog[0].target_pests).toEqual(['German cockroaches']);
  });

  test.each([
    ['an admin-customized list', ['German cockroaches', 'Drain flies']],
    ['a superset of the seed', ['German cockroaches', 'American cockroaches', 'Drain flies']],
    ['an empty list', []],
    ['null', null],
  ])('up leaves target_pests untouched when it is %s', async (_label, targets) => {
    const { knex, db } = fakeKnex({ targets });
    await migration.up(knex);
    expect(db.products_catalog[0].name).toBe('Gentrol Complete EC3');
    expect(db.products_catalog[0].target_pests).toEqual(targets);
  });

  test('down restores the seed targets only from exactly German cockroaches', async () => {
    for (const [targets, expected] of [
      [['German cockroaches'], ['German cockroaches', 'American cockroaches']],
      [['German cockroaches', 'Drain flies'], ['German cockroaches', 'Drain flies']],
      [['German cockroaches', 'American cockroaches'], ['German cockroaches', 'American cockroaches']],
    ]) {
      const { knex, db } = fakeKnex({ targets });
      Object.assign(db.products_catalog[0], { name: 'Gentrol Complete EC3', epa_reg_number: '89459-119' });
      await migration.down(knex);
      expect(db.products_catalog[0].target_pests).toEqual(expected);
      expect(db.products_catalog[0].name).toBe('Gentrol IGR');
    }
  });

  test('down is a no-op (rows and aliases) when the row no longer holds the new identity', async () => {
    const { knex, calls, db } = fakeKnex({ aliases: [{ product_id: 'p-1', alias_name: 'Gentrol IGR' }] });
    await migration.down(knex);
    expect(calls.del).toEqual([]);
    expect(calls.raw).toEqual([]);
    expect(db.products_catalog[0]).toMatchObject({ id: 'p-1', name: 'Gentrol IGR', epa_reg_number: '2724-351' });
    expect(db.product_aliases).toHaveLength(1);
  });

  test('the SQL carries no literal ? (a raw ? is a knex binding) and never touches past visit lines', async () => {
    const source = fs.readFileSync(path.join(MIGRATIONS, '20261026070000_gentrol_complete_ec3_identity.js'), 'utf8');
    for (const forbidden of ['service_products', 'vendor_pricing', 'inventory']) {
      expect(source).not.toMatch(new RegExp(`(?:knex\\(|FROM|UPDATE|INTO)\\s*['"\`]?${forbidden}`, 'i'));
    }
    const { knex, calls } = fakeKnex();
    await migration.up(knex);
    const sql = calls.raw[0].sql;
    // Three placeholders for three bindings, all followed by a cast, none a jsonb operator.
    expect((sql.match(/\?/g) || [])).toHaveLength(3);
    expect(sql.match(/\?(?!::text)/g)).toBeNull();
  });

  test('the new customer copy states only what the label says', () => {
    const { NEW } = migration;
    expect(NEW.service_report_summary).toBe(
      'An indoor insecticide combined with an insect growth regulator: it kills roaches and other listed pests that contact the treatment, and the growth regulator keeps young roaches from becoming adults that can breed, breaking the life cycle.',
    );
    expect(NEW.customer_precaution_summary).toBe('Per the product label: keep people and pets off treated surfaces until they have dried.');
    expect(NEW.reentry_summary).toBe('Do not let people or pets touch treated surfaces until they have dried.');
    // No residual period, no timeline.
    for (const text of [NEW.service_report_summary, NEW.customer_precaution_summary, NEW.reentry_summary]) {
      expect(text).not.toMatch(/\b\d+\s*(day|week|month|hour)s?\b|residual|lasts?\b/i);
    }
  });
});

describe('Gentrol Complete EC3 name is the one protocols.json and the service library resolve', () => {
  test('protocols.json names the new catalog row, never the old one', () => {
    const text = fs.readFileSync(path.join(__dirname, '../config/protocols.json'), 'utf8');
    expect(text).not.toContain('"Gentrol IGR"');
    expect((text.match(/"Gentrol Complete EC3"/g) || []).length).toBe(3);
  });
});
