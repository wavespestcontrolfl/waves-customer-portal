// Migration 20261120203000: the Onslaught Fastcap row's pack label '32 g' becomes '16 fl oz', the package its numbers
// (unit_size_oz 16, a fluid-ounce best_price) already describe. calculateInventoryCost reads the label's measure, so with
// '32 g' every fl oz use would book no cost.
const fs = require('fs');
const path = require('path');
const label = require('../models/migrations/20261120203000_onslaught_fastcap_pack_label');

// A fake for exactly the migration's queries: hasTable, the name + shape read, the guarded update and the audit insert.
function makeKnex(tables) {
  const knex = (table) => {
    const tests = [];
    const matching = () => tables[table].filter((row) => tests.every((t) => t(row)));
    const chain = {
      whereRaw(sql, bindings) {
        expect(sql).toBe('LOWER(name) = LOWER(?)');
        tests.push((row) => String(row.name).toLowerCase() === String(bindings[0]).toLowerCase());
        return chain;
      },
      where(match) {
        // A pg numeric column equals the number 16 whether it reads 16 or '16.00'.
        tests.push((row) => Object.entries(match).every(([column, value]) => (
          typeof value === 'number' ? Number(row[column]) === value : row[column] === value)));
        return chain;
      },
      select: async (...columns) => matching().map((row) => Object.fromEntries(columns.map((c) => [c, row[c]]))),
      update: async (patch) => {
        const hit = matching();
        hit.forEach((row) => Object.assign(row, patch));
        return hit.length;
      },
      insert: (row) => ({
        returning: async () => {
          const id = tables[table].length + 1;
          tables[table].push({ id, ...row });
          return [{ id }];
        },
      }),
    };
    return chain;
  };
  knex.tables = tables;
  knex.fn = { now: () => 'now()' };
  knex.schema = { hasTable: async (table) => Array.isArray(tables[table]) };
  return knex;
}

// Production's row (read 2026-11-20).
const productionRow = (over = {}) => ({
  id: 'p-ons', name: 'Onslaught Fastcap', container_size: '32 g', unit_size_oz: '16.00', inventory_unit: 'fl_oz', updated_at: 'before', ...over,
});
const snapshot = (knex) => JSON.parse(JSON.stringify(knex.tables));
const labelEvents = (knex) => knex.tables.audit_log.filter((e) => e.action === `migration:${label.MIGRATION}:label`);

describe('migration 20261120203000: Onslaught Fastcap\'s pack label matches its 16 fl oz package', () => {
  test('production\'s row becomes 16 fl oz with one audit row; another product, a re-run and down() change nothing', async () => {
    const gel = { id: 'p-gel', name: 'Synthetic Gel', container_size: '32 g', unit_size_oz: '1.13' };
    const knex = makeKnex({ products_catalog: [productionRow(), { ...gel }], audit_log: [] });
    await label.up(knex);
    expect(knex.tables.products_catalog[0]).toEqual(productionRow({ container_size: '16 fl oz', updated_at: 'now()' }));
    expect(knex.tables.products_catalog[1]).toEqual(gel);
    const events = labelEvents(knex);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor_type: 'system', actor_id: null, resource_type: 'products_catalog', resource_id: 'p-ons' });
    expect(events[0].action.length).toBeLessThanOrEqual(96); // audit_log.action is varchar(96)
    expect(events[0].metadata).toEqual({
      migration: label.MIGRATION,
      product: 'Onslaught Fastcap',
      unit_size_oz: 16,
      before: { container_size: '32 g' },
      after: { container_size: '16 fl oz' },
    });
    const after = snapshot(knex);
    await label.up(knex);
    await label.down(knex);
    expect(snapshot(knex)).toEqual(after);
  });

  test('the name matches in any letter case', async () => {
    const knex = makeKnex({ products_catalog: [productionRow({ name: 'Onslaught FastCap' })], audit_log: [] });
    await label.up(knex);
    expect(knex.tables.products_catalog[0].container_size).toBe('16 fl oz');
    expect(labelEvents(knex)).toHaveLength(1);
  });

  test('an office label, or the 1.13 oz size the import file built from 32 g, is left alone', async () => {
    const office = productionRow({ container_size: '1 gal', unit_size_oz: '128.00' });
    const imported = productionRow({ id: 'p-imp', unit_size_oz: '1.13' });
    const knex = makeKnex({ products_catalog: [office, imported], audit_log: [] });
    const before = snapshot(knex);
    await label.up(knex);
    expect(snapshot(knex)).toEqual(before);
  });

  test('no audit_log table: nothing is written', async () => {
    const knex = makeKnex({ products_catalog: [productionRow()] });
    const before = snapshot(knex);
    await label.up(knex);
    expect(snapshot(knex)).toEqual(before);
  });

  test('the import file carries the label the migration writes', () => {
    const csv = fs.readFileSync(path.join(__dirname, '../data/pricing.csv'), 'utf8');
    const lines = csv.split('\n').filter((line) => line.startsWith(`${label.PRODUCT},`));
    expect(lines).toHaveLength(1);
    // Product, Active Ingredient / Descriptor, Category Section, Category, Subcategory, Vendor, Size, ...
    expect(lines[0].split(',')[6]).toBe(label.NEW_LABEL);
  });
});
