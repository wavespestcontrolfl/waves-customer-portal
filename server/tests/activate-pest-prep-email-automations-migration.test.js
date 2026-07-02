const migration = require('../models/migrations/20260702000002_activate_pest_prep_email_automations');

function knexStub({ hasTable = true } = {}) {
  const calls = { whereIn: null, where: null, update: null };
  const query = {
    whereIn: jest.fn((column, keys) => {
      calls.whereIn = { column, keys };
      return query;
    }),
    where: jest.fn((criteria) => {
      calls.where = criteria;
      return query;
    }),
    update: jest.fn(async (values) => {
      calls.update = values;
      return 2;
    }),
  };
  const knex = jest.fn(() => query);
  knex.fn = { now: jest.fn(() => 'NOW()') };
  knex.schema = { hasTable: jest.fn(async () => hasTable) };
  return { knex, query, calls };
}

describe('activate pest prep email automations migration', () => {
  test('up flips only draft prep automations to active', async () => {
    const { knex, calls } = knexStub();

    await migration.up(knex);

    expect(calls.whereIn).toEqual({
      column: 'automation_key',
      keys: ['prep.bed_bug', 'prep.cockroach'],
    });
    expect(calls.where).toEqual({ status: 'draft' });
    expect(calls.update).toMatchObject({ status: 'active' });
  });

  test('down reverts active rows back to draft', async () => {
    const { knex, calls } = knexStub();

    await migration.down(knex);

    expect(calls.where).toEqual({ status: 'active' });
    expect(calls.update).toMatchObject({ status: 'draft' });
  });

  test('no-ops when email_template_automations does not exist', async () => {
    const { knex } = knexStub({ hasTable: false });

    await migration.up(knex);

    expect(knex).not.toHaveBeenCalled();
  });
});
