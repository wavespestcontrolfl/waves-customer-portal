/**
 * 20261120020000: the rollback guard for the GPT-Live spend ledger. Its down() runs before the frozen 20261120010000
 * down() and always refuses, so a rollback never gives back billed spend or frees the $5 cap (no check-then-drop race).
 */
const guard = require('../models/migrations/20261120020000_voice_gpt_live_spend_rollback_guard');

describe('voice_gpt_live_spend rollback guard', () => {
  test('down() always refuses, with or without rows, and touches nothing', async () => {
    const knex = jest.fn();
    knex.schema = { hasTable: jest.fn(), dropTableIfExists: jest.fn() };
    await expect(guard.down(knex)).rejects.toThrow(/budget ledger and is permanent: roll forward, not back/);
    expect(knex).not.toHaveBeenCalled();
    expect(knex.schema.dropTableIfExists).not.toHaveBeenCalled();
  });

  test('up() changes nothing', async () => {
    const knex = jest.fn();
    knex.schema = { hasTable: jest.fn() };
    await guard.up(knex);
    expect(knex).not.toHaveBeenCalled();
    expect(knex.schema.hasTable).not.toHaveBeenCalled();
  });
});
