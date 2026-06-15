const cleanTemplateSeed = require('../models/migrations/20260514000002_tighten_sms_template_copy');
const migration = require('../models/migrations/20260615000004_remove_dead_legacy_sms_templates');

const RETIRED_KEY_PARTS = [
  ['lead', 'auto', 'reply', 'after', 'hours'],
  ['lead', 'service', 'lawn'],
  ['lead', 'service', 'one', 'time'],
  ['lead', 'address', 'needed'],
  ['lead', 'safe', 'ack'],
  ['estimate', 'accepted', 'office'],
  ['admin', 'new', 'lead'],
  ['autopay', 'authorization', 'request'],
  ['autopay', 'authorization', 'cancelled'],
  ['auto', 'renewal', '30', '60', 'day', 'notice'],
];

const RETIRED_KEYS = RETIRED_KEY_PARTS.map((parts) => parts.join('_'));

describe('remove dead legacy SMS templates migration', () => {
  test('deletes retired SMS rows', async () => {
    const query = {
      column: null,
      keys: null,
      whereIn(column, keys) {
        query.column = column;
        query.keys = keys;
        return query;
      },
      del: jest.fn(async () => RETIRED_KEYS.length),
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

    expect(query.column).toBe('template_key');
    expect(query.keys).toEqual(RETIRED_KEYS);
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

  test('keeps retired rows out of the runtime default seed list', () => {
    const defaultKeys = cleanTemplateSeed.TEMPLATES.map((template) => template.template_key);

    for (const key of RETIRED_KEYS) {
      expect(defaultKeys).not.toContain(key);
    }
  });
});
