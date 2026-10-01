const migration = require('../models/migrations/20260930200000_lawn_watering_instruction_sms_template');

describe('lawn watering instruction SMS template migration', () => {
  function makeKnex({ existing = null, hasTable = true } = {}) {
    const calls = { inserted: null, deletedWhere: null };
    const query = {
      where: jest.fn((cond) => { calls.deletedWhere = cond; return query; }),
      first: jest.fn(async () => existing),
      insert: jest.fn(async (row) => { calls.inserted = row; return [1]; }),
      del: jest.fn(async () => 1),
    };
    const knex = jest.fn((table) => {
      expect(table).toBe('sms_templates');
      return query;
    });
    knex.schema = { hasTable: jest.fn(async () => hasTable) };
    return { knex, query, calls };
  }

  test('seeds the active template with the exact approved body and the watering_lines slot', async () => {
    const { knex, calls } = makeKnex();
    await migration.up(knex);
    expect(calls.inserted).toEqual(expect.objectContaining({
      template_key: 'lawn_watering_instruction',
      category: 'service',
      body: "Watering after today's visit: {watering_lines}",
      variables: JSON.stringify(['watering_lines']),
      is_active: true,
    }));
  });

  test('has no signature, sign-off, STOP line or emoji', async () => {
    const { knex, calls } = makeKnex();
    await migration.up(knex);
    const body = calls.inserted.body;
    expect(body).not.toMatch(/Waves/);
    expect(body).not.toMatch(/STOP/i);
    expect(body).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    expect(body.trim().endsWith('{watering_lines}')).toBe(true);
  });

  test('is idempotent: an existing (possibly admin-edited) row is never overwritten', async () => {
    const { knex, query, calls } = makeKnex({ existing: { id: 't-1' } });
    await migration.up(knex);
    expect(calls.inserted).toBeNull();
    expect(query.insert).not.toHaveBeenCalled();
  });

  test('no-ops when sms_templates does not exist yet', async () => {
    const { knex } = makeKnex({ hasTable: false });
    await migration.up(knex);
    await migration.down(knex);
    expect(knex).not.toHaveBeenCalled();
  });

  test('down removes only this key', async () => {
    const { knex, query, calls } = makeKnex();
    await migration.down(knex);
    expect(calls.deletedWhere).toEqual({ template_key: 'lawn_watering_instruction' });
    expect(query.del).toHaveBeenCalledTimes(1);
  });
});
