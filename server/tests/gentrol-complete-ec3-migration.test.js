const fs = require('fs');
const path = require('path');

const migration = require('../models/migrations/20261026060000_gentrol_is_complete_ec3.js');

const MIGRATIONS = path.join(__dirname, '../models/migrations');

// A knex stand-in that records the guarded UPDATE on products_catalog and the raw
// services rename, and reports a configurable affected-row count.
function fakeKnex({ updated = 1 } = {}) {
  const calls = { where: [], update: [], raw: [], tables: [] };
  const knex = (table) => {
    calls.tables.push(table);
    return {
      where(cond) { calls.where.push(cond); return this; },
      update(values) { calls.update.push(values); return Promise.resolve(updated); },
    };
  };
  knex.fn = { now: () => 'NOW()' };
  knex.schema = {
    hasTable: async () => true,
    hasColumn: async () => true,
  };
  knex.raw = jest.fn(async (sql, bindings) => { calls.raw.push({ sql, bindings }); return { rowCount: 2 }; });
  return { knex, calls };
}

describe('20261026060000 Gentrol is Complete EC3', () => {
  let log;
  beforeEach(() => { log = jest.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { log.mockRestore(); });

  test('the old values it restores are what the seeding migrations wrote', () => {
    const batch1 = fs.readFileSync(path.join(MIGRATIONS, '20260528000002_inventory_product_data_completion_batch1.js'), 'utf8');
    expect(batch1).toContain(migration.OLD.label_source_note);
    expect(batch1).toContain("epa_reg_number: '2724-351'");
    expect(batch1).toContain(`active_ingredient: '${migration.OLD.active_ingredient}'`);
    const display = fs.readFileSync(path.join(MIGRATIONS, '20260712000050_product_display_names_report_label_data.js'), 'utf8');
    expect(display).toContain(migration.OLD.reentry_summary);
  });

  test('up changes only the row that still reads Gentrol IGR with EPA 2724-351', async () => {
    const { knex, calls } = fakeKnex();
    await migration.up(knex);
    expect(calls.tables).toEqual(['products_catalog']);
    expect(calls.where).toEqual([{ name: 'Gentrol IGR', epa_reg_number: '2724-351' }]);
    expect(calls.update[0]).toMatchObject({
      name: 'Gentrol Complete EC3',
      active_ingredient: 'Lambda-cyhalothrin 1.5% + (S)-Hydroprene 1.5%',
      moa_group: 'Group 3A + 7A',
      formulation: 'emulsifiable concentrate',
      default_rate: '1.3',
      epa_reg_number: '89459-119',
    });
    // category and product_type are not touched: protocol matching and the visit email read the category.
    expect(calls.update[0]).not.toHaveProperty('category');
    expect(calls.update[0]).not.toHaveProperty('product_type');
    expect(calls.update[0]).not.toHaveProperty('target_pests');
    expect(calls.update[0]).not.toHaveProperty('rei_hours');
    expect(calls.raw).toHaveLength(1);
    expect(calls.raw[0].bindings).toEqual(['Gentrol IGR', 'Gentrol Complete EC3', 'Gentrol IGR']);
  });

  test('up is a no-op when the row was already corrected or edited (nothing renamed in the service library)', async () => {
    const { knex, calls } = fakeKnex({ updated: 0 });
    await migration.up(knex);
    expect(calls.raw).toEqual([]);
  });

  test('down restores every changed column, only while the row holds the new identity', async () => {
    const { knex, calls } = fakeKnex();
    await migration.down(knex);
    expect(calls.where).toEqual([{ name: 'Gentrol Complete EC3', epa_reg_number: '89459-119' }]);
    expect(calls.update[0]).toMatchObject({
      name: 'Gentrol IGR', epa_reg_number: '2724-351', default_rate: '1', moa_group: 'Group 7A', formulation: 'concentrate',
    });
    expect(Object.keys(migration.OLD).sort()).toEqual(
      [...Object.keys(migration.NEW), 'label_verified_at'].sort(),
    );
    expect(calls.raw[0].bindings).toEqual(['Gentrol Complete EC3', 'Gentrol IGR', 'Gentrol Complete EC3']);
  });

  test('the SQL carries no literal ? (a raw ? is a knex binding) and never touches past visit lines', () => {
    const source = fs.readFileSync(path.join(MIGRATIONS, '20261026060000_gentrol_is_complete_ec3.js'), 'utf8');
    for (const forbidden of ['service_products', 'vendor_pricing', 'product_aliases', 'inventory']) {
      expect(source).not.toMatch(new RegExp(`(?:knex\\(|FROM|UPDATE|INTO)\\s*['"\`]?${forbidden}`, 'i'));
    }
    const { knex, calls } = fakeKnex();
    return migration.up(knex).then(() => {
      const sql = calls.raw[0].sql;
      // Three placeholders for three bindings, all followed by a cast, none a jsonb operator.
      expect((sql.match(/\?/g) || [])).toHaveLength(3);
      expect(sql.match(/\?(?!::text)/g)).toBeNull();
    });
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
