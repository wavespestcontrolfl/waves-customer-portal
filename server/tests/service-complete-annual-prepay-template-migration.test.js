const migration = require('../models/migrations/20260709000050_service_complete_annual_prepay_template');

function buildKnex({ existingRow = null } = {}) {
  const state = { inserted: [] };
  const query = {
    where(criteria) {
      query.__where = criteria;
      return query;
    },
    first: jest.fn(async () => existingRow),
    insert: jest.fn(async (row) => {
      state.inserted.push(row);
    }),
    del: jest.fn(async () => (existingRow ? 1 : 0)),
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
  return { knex, query, state };
}

describe('service_complete_annual_prepay template migration', () => {
  test('inserts the annual-prepay completion template when missing', async () => {
    const { knex, state } = buildKnex();

    await migration.up(knex);

    expect(state.inserted).toHaveLength(1);
    const row = state.inserted[0];
    expect(row.template_key).toBe('service_complete_annual_prepay');
    expect(row.is_active).toBe(true);
    expect(JSON.parse(row.variables)).toEqual(['first_name', 'service_type', 'portal_url']);
    // The whole point of the template: an annual-prepay-covered visit moved
    // no money today, so the copy must not thank the customer for a payment.
    expect(row.body).not.toMatch(/payment/i);
    expect(row.body).toContain('annual prepaid plan');
    expect(row.body).toContain('{portal_url}');
    // Library-wide copy rule (20260706000010): every template carries the
    // opt-out notice.
    expect(row.body).toMatch(/reply stop/i);
  });

  test('is idempotent — skips the insert when the row already exists', async () => {
    const { knex, query } = buildKnex({ existingRow: { id: 'row-1' } });

    await migration.up(knex);

    expect(query.insert).not.toHaveBeenCalled();
  });

  test('does nothing when sms_templates does not exist', async () => {
    const knex = jest.fn();
    knex.schema = { hasTable: jest.fn(async () => false) };

    await migration.up(knex);

    expect(knex).not.toHaveBeenCalled();
  });

  test('down deletes the seeded row', async () => {
    const { knex, query } = buildKnex({ existingRow: { id: 'row-1' } });

    await migration.down(knex);

    expect(query.__where).toEqual({ template_key: 'service_complete_annual_prepay' });
    expect(query.del).toHaveBeenCalledTimes(1);
  });
});
