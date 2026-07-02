const migration = require('../models/migrations/20260702000003_seed_flea_prep_email_automation');

function knexStub({ hasTable = true, existingAutomation = null, template = { suppression_group_key: 'service_operational' } } = {}) {
  const inserted = [];
  const automationsQuery = {
    where: jest.fn(() => automationsQuery),
    first: jest.fn(async () => existingAutomation),
    insert: jest.fn(async (row) => {
      inserted.push(row);
      return [row];
    }),
    del: jest.fn(async () => 1),
  };
  const templatesQuery = {
    where: jest.fn(() => templatesQuery),
    first: jest.fn(async () => template),
  };
  const knex = jest.fn((table) => (table === 'email_templates' ? templatesQuery : automationsQuery));
  knex.schema = { hasTable: jest.fn(async () => hasTable) };
  return { knex, inserted, automationsQuery };
}

describe('seed flea prep email automation migration', () => {
  test('inserts an active prep.flea automation bound to appointment.booked', async () => {
    const { knex, inserted } = knexStub();

    await migration.up(knex);

    expect(inserted).toHaveLength(1);
    const row = inserted[0];
    expect(row.automation_key).toBe('prep.flea');
    expect(row.template_key).toBe('prep.flea');
    expect(row.trigger_event_key).toBe('appointment.booked');
    expect(row.status).toBe('active');
    expect(row.suppression_group_key).toBe('service_operational');
    expect(JSON.parse(row.conditions)).toEqual({ service_type_contains: ['flea'] });
    expect(JSON.parse(row.exit_conditions)).toEqual({ stop_if: ['appointment.cancelled'] });
    expect(row.idempotency_key_template).toBe('prep.flea:{scheduled_service_id}');
  });

  test('skips when the automation row already exists', async () => {
    const { knex, inserted } = knexStub({ existingAutomation: { automation_key: 'prep.flea' } });

    await migration.up(knex);

    expect(inserted).toHaveLength(0);
  });

  test('skips when the prep.flea template is missing', async () => {
    const { knex, inserted } = knexStub({ template: null });

    await migration.up(knex);

    expect(inserted).toHaveLength(0);
  });

  test('no-ops when email_template_automations does not exist', async () => {
    const { knex } = knexStub({ hasTable: false });

    await migration.up(knex);

    expect(knex).not.toHaveBeenCalled();
  });

  test('down removes the seeded row', async () => {
    const { knex, automationsQuery } = knexStub();

    await migration.down(knex);

    expect(automationsQuery.where).toHaveBeenCalledWith({ automation_key: 'prep.flea' });
    expect(automationsQuery.del).toHaveBeenCalledTimes(1);
  });
});
