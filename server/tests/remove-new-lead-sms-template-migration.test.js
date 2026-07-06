const cleanTemplateSeed = require('../models/migrations/20260514000002_tighten_sms_template_copy');
const migration = require('../models/migrations/20260615000001_remove_new_lead_sms_template_and_rename_billing_reminder');

function createKnexMock({ tables = ['sms_templates', 'automation_templates'] } = {}) {
  const operations = [];
  const knex = jest.fn((table) => {
    const query = {
      criteria: null,
      columnInfo: jest.fn(async () => (
        table === 'sms_templates'
          ? { updated_at: {} }
          : { sms_template: {}, updated_at: {} }
      )),
      where(criteria) {
        query.criteria = criteria;
        return query;
      },
      async del() {
        operations.push({ table, action: 'delete', criteria: query.criteria });
        return 1;
      },
      async update(payload) {
        operations.push({ table, action: 'update', criteria: query.criteria, payload });
        return 1;
      },
    };
    return query;
  });
  knex.schema = {
    hasTable: jest.fn(async (table) => tables.includes(table)),
  };
  knex.operations = operations;
  return knex;
}

describe('remove new lead SMS template migration', () => {
  test('deletes the retired SMS row and clears legacy automation SMS copy', async () => {
    const retiredKey = ['auto', 'new', 'lead'].join('_');
    const knex = createKnexMock();

    await migration.up(knex);

    expect(knex.operations).toEqual([
      {
        table: 'sms_templates',
        action: 'delete',
        criteria: { template_key: retiredKey },
      },
      {
        table: 'automation_templates',
        action: 'update',
        criteria: { key: 'new_lead' },
        payload: { sms_template: null, updated_at: expect.any(Date) },
      },
      {
        table: 'sms_templates',
        action: 'update',
        criteria: { template_key: 'billing_reminder' },
        payload: {
          name: 'Billing Reminder (WaveGuard Monthly)',
          updated_at: expect.any(Date),
        },
      },
    ]);
  });

  test('does nothing when sms_templates does not exist', async () => {
    const knex = createKnexMock({ tables: [] });

    await migration.up(knex);

    expect(knex).not.toHaveBeenCalled();
  });

  test('keeps retired SMS row out of the runtime default seed list', () => {
    const retiredKey = ['auto', 'new', 'lead'].join('_');
    const defaultKeys = cleanTemplateSeed.TEMPLATES.map((template) => template.template_key);

    expect(defaultKeys).not.toContain(retiredKey);
    // billing_reminder (the row this migration renamed) was itself retired by
    // 20260706000010_sms_template_cleanup.js — it must stay out of the seed
    // too, or the boot seeder would resurrect it.
    expect(defaultKeys).not.toContain('billing_reminder');
  });
});
