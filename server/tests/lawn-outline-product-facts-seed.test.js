const migration = require('../models/migrations/20260530000022_lawn_outline_product_facts_seed');

function fakeKnex({ existingByAlias = {} } = {}) {
  const inserted = [];
  const updated = [];
  const knex = jest.fn((table) => {
    if (table !== 'products_catalog') throw new Error(`Unexpected table ${table}`);
    return {
      whereRaw: jest.fn((_sql, values = []) => ({
        first: jest.fn(async () => {
          const pattern = String(values[0] || '').replace(/%/g, '').toLowerCase();
          return existingByAlias[pattern] || null;
        }),
      })),
      where: jest.fn((criteria) => ({
        update: jest.fn(async (row) => {
          updated.push({ criteria, row });
          return 1;
        }),
      })),
      insert: jest.fn(async (row) => {
        inserted.push(row);
        return [row.id];
      }),
    };
  });
  knex.fn = { now: jest.fn(() => 'NOW') };
  knex.inserted = inserted;
  knex.updated = updated;
  return knex;
}

describe('lawn outline product fact seed', () => {
  test('does not insert null EPA registration values for non-pesticide support products', async () => {
    const knex = fakeKnex();

    await migration.up(knex);

    expect(knex.inserted.length).toBeGreaterThan(0);
    expect(knex.inserted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: expect.stringContaining('CarbonPro-L'),
        product_type: 'biostimulant',
        epa_reg_number: 'N/A',
      }),
      expect.objectContaining({
        name: 'Hydretain Liquid',
        product_type: 'wetting_agent',
        epa_reg_number: 'N/A',
      }),
    ]));
    expect(knex.inserted.every((row) => String(row.epa_reg_number || '').trim())).toBe(true);
  });

  test('preserves an existing non-null EPA placeholder when updating support products', async () => {
    const knex = fakeKnex({
      existingByAlias: {
        hydretain: {
          id: 'existing-hydretain',
          name: 'Hydretain Liquid',
          category: 'adjuvant',
          epa_reg_number: 'Not EPA-registered fertilizer',
        },
      },
    });

    await migration.up(knex);

    expect(knex.updated).toEqual(expect.arrayContaining([
      expect.objectContaining({
        criteria: { id: 'existing-hydretain' },
        row: expect.objectContaining({
          epa_reg_number: 'Not EPA-registered fertilizer',
        }),
      }),
    ]));
  });
});
