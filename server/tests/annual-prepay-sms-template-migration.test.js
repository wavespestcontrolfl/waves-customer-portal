const migration = require('../models/migrations/20260526000017_seed_annual_prepay_sms_template');

describe('annual prepay SMS template migration', () => {
  test('serializes template variables for PostgreSQL JSON columns', async () => {
    let inserted;
    let merged;

    const query = {
      insert: jest.fn((row) => {
        inserted = row;
        return query;
      }),
      onConflict: jest.fn((column) => {
        expect(column).toBe('template_key');
        return query;
      }),
      merge: jest.fn(async (row) => {
        merged = row;
        return 1;
      }),
    };
    const knex = jest.fn((table) => {
      expect(table).toBe('sms_templates');
      return query;
    });
    knex.schema = {
      hasTable: jest.fn(async (table) => {
        expect(table).toBe('sms_templates');
        return true;
      }),
    };

    await migration.up(knex);

    expect(inserted.variables).toBe(JSON.stringify(['first_name', 'waveguard_tier', 'amount_text']));
    expect(merged.variables).toBe(JSON.stringify(['first_name', 'waveguard_tier', 'amount_text']));
  });
});
