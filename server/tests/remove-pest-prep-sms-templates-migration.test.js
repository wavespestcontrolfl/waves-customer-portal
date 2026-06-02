const cleanTemplateSeed = require('../models/migrations/20260514000002_tighten_sms_template_copy');
const migration = require('../models/migrations/20260602000002_remove_pest_prep_sms_templates');

describe('remove pest prep SMS templates migration', () => {
  test('deletes cockroach and bed bug prep SMS templates', async () => {
    const deletedKeys = [];
    const query = {
      whereIn(column, keys) {
        expect(column).toBe('template_key');
        deletedKeys.push(...keys);
        return query;
      },
      del: jest.fn(async () => 2),
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

    expect(deletedKeys).toEqual([
      'pest_prep_cockroach',
      'pest_prep_bed_bug',
    ]);
    expect(query.del).toHaveBeenCalledTimes(1);
  });

  test('does nothing when sms_templates does not exist', async () => {
    const knex = jest.fn();
    knex.schema = {
      hasTable: jest.fn(async () => false),
    };

    await migration.up(knex);

    expect(knex).not.toHaveBeenCalled();
  });

  test('keeps removed prep templates out of the runtime default seed list', () => {
    const defaultKeys = cleanTemplateSeed.TEMPLATES.map((template) => template.template_key);

    expect(defaultKeys).not.toContain('pest_prep_cockroach');
    expect(defaultKeys).not.toContain('pest_prep_bed_bug');
  });
});
