const migration = require('../models/migrations/20260701000004_voicemail_quote_link_sms_template');

describe('voicemail quote-link SMS template migration', () => {
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

  test('seeds the template active with serialized variables and the prefill link slot', async () => {
    const { knex, calls } = makeKnex();
    await migration.up(knex);

    expect(calls.inserted).toEqual(expect.objectContaining({
      template_key: 'voicemail_quote_link',
      is_active: true,
      variables: JSON.stringify(['first_name', 'service_label', 'quote_url']),
    }));
    expect(calls.inserted.body).toContain('{first_name}');
    expect(calls.inserted.body).toContain('{service_label}');
    expect(calls.inserted.body).toContain('{quote_url}');
    // Compliance shape: identifies the business and offers a human reply path.
    expect(calls.inserted.body).toMatch(/Waves Pest Control/);
    expect(calls.inserted.body).toMatch(/reply/i);
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
});
