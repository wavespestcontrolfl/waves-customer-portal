const cleanTemplateSeed = require('../models/migrations/20260514000002_tighten_sms_template_copy');
const migration = require('../models/migrations/20260615000002_remove_onetime_quote_followup_sms_template');

describe('remove one-time quote follow-up SMS template migration', () => {
  test('deletes the retired SMS row', async () => {
    const retiredKey = ['estimate', 'onetime', 'followup'].join('_');
    const query = {
      criteria: null,
      where(criteria) {
        query.criteria = criteria;
        return query;
      },
      del: jest.fn(async () => 1),
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

    expect(query.criteria).toEqual({ template_key: retiredKey });
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

  test('keeps retired SMS row out of the runtime default seed list', () => {
    const retiredKey = ['estimate', 'onetime', 'followup'].join('_');
    const defaultKeys = cleanTemplateSeed.TEMPLATES.map((template) => template.template_key);

    expect(defaultKeys).not.toContain(retiredKey);
  });
});
