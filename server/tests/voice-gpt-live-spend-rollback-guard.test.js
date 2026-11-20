/**
 * 20261120020000: the rollback guard for the GPT-Live spend ledger. Its down() runs before the frozen 20261120010000
 * down() and refuses while the ledger holds a row, so a rollback never gives back billed spend or frees the $5 cap.
 */
const guard = require('../models/migrations/20261120020000_voice_gpt_live_spend_rollback_guard');

function fakeKnex({ hasTable = true, rows = [] } = {}) {
  const knex = jest.fn(() => ({ first: jest.fn(async () => rows[0]) }));
  knex.schema = { hasTable: jest.fn(async () => hasTable) };
  return knex;
}

describe('voice_gpt_live_spend rollback guard', () => {
  test('refuses to roll back while the ledger holds a reservation or a settled cost', async () => {
    await expect(guard.down(fakeKnex({ rows: [{ call_sid: 'CA-1' }] }))).rejects.toThrow(/refusing to roll back the budget ledger/);
  });

  test('an empty or missing ledger rolls back as before', async () => {
    await expect(guard.down(fakeKnex({ rows: [] }))).resolves.toBeUndefined();
    const missing = fakeKnex({ hasTable: false });
    await expect(guard.down(missing)).resolves.toBeUndefined();
    expect(missing).not.toHaveBeenCalled();
  });

  test('up() changes nothing', async () => {
    const knex = fakeKnex();
    await guard.up(knex);
    expect(knex).not.toHaveBeenCalled();
    expect(knex.schema.hasTable).not.toHaveBeenCalled();
  });
});
