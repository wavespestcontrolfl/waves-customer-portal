const migration = require('../models/migrations/20260923000020_lead_consultation_link_sms_template');

describe('lead consultation-link SMS template migration', () => {
  function makeKnex({ existing = null } = {}) {
    const calls = { inserted: null };
    const query = {
      where: jest.fn(() => query),
      first: jest.fn(async () => existing),
      insert: jest.fn(async (row) => { calls.inserted = row; return [1]; }),
      del: jest.fn(async () => 1),
    };
    const knex = jest.fn((table) => {
      expect(table).toBe('sms_templates');
      return query;
    });
    knex.schema = { hasTable: jest.fn(async () => true) };
    return { knex, query, calls };
  }

  test('seeds the template active, in the leads category, with the consultation link slot', async () => {
    const { knex, calls } = makeKnex();
    await migration.up(knex);

    expect(calls.inserted).toEqual(expect.objectContaining({
      template_key: 'lead_consultation_link',
      category: 'leads',
      is_active: true,
      variables: JSON.stringify(['first_name', 'consultation_url']),
    }));
    expect(calls.inserted.body).toContain('{first_name}');
    expect(calls.inserted.body).toContain('{consultation_url}');
    // Compliance shape: sender is "Waves" (never "Waves Pest Control" or a
    // person's name), and this is a first text to a not-yet-customer lead —
    // docs/sms-stop-line-policy.md test 2 keeps the disclosure.
    expect(calls.inserted.body).toMatch(/it's Waves\./);
    expect(calls.inserted.body).not.toMatch(/Waves Pest Control/);
    expect(calls.inserted.body).toMatch(/Reply STOP to opt out\./);
  });

  test('is idempotent — an existing row is never re-inserted or overwritten', async () => {
    const { knex, query, calls } = makeKnex({ existing: { id: 't-1' } });
    await migration.up(knex);
    expect(calls.inserted).toBeNull();
    expect(query.insert).not.toHaveBeenCalled();
  });

  test('no-ops when sms_templates does not exist yet', async () => {
    const { knex } = makeKnex();
    knex.schema.hasTable = jest.fn(async () => false);
    await migration.up(knex);
    expect(knex).not.toHaveBeenCalled();
  });

  test('down() is a documented no-op — never deletes the (possibly admin-edited) row', async () => {
    const { knex, query } = makeKnex({ existing: { id: 't-1' } });
    await migration.down(knex);
    expect(query.del).not.toHaveBeenCalled();
  });
});
