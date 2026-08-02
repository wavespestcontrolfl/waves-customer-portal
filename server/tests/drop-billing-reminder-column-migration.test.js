/**
 * 20260802000001 — phase 2: drop notification_prefs.billing_reminder.
 *
 * Owner ruling 2026-08-01: billing notices carry no per-purpose opt-out.
 * The column defaulted FALSE and the backfill wrote FALSE for billing while
 * writing TRUE for every other category, so 1,164 of 1,174 rows were muted
 * without any customer choosing anything. sms_enabled (STOP) remains the
 * master kill switch; billing_channel still routes delivery.
 */
const migration = require('../models/migrations/20260802000001_drop_billing_reminder_column');

function buildKnex({ hasColumn = true } = {}) {
  const state = { dropped: [], added: [] };
  const table = {
    dropColumn: (col) => state.dropped.push(col),
    boolean: (col) => {
      state.added.push(col);
      return { defaultTo: (v) => state.addedDefault = v };
    },
  };
  const knex = {
    schema: {
      hasTable: jest.fn(async () => true),
      hasColumn: jest.fn(async () => hasColumn),
      alterTable: jest.fn(async (_name, fn) => fn(table)),
    },
  };
  return { knex, state };
}

describe('drop billing_reminder opt-out', () => {
  test('up() drops the column', async () => {
    const { knex, state } = buildKnex();
    await migration.up(knex);
    expect(state.dropped).toEqual(['billing_reminder']);
  });

  test('up() is a no-op when the column is already gone (re-run safety)', async () => {
    const { knex, state } = buildKnex({ hasColumn: false });
    await migration.up(knex);
    expect(state.dropped).toEqual([]);
    expect(knex.schema.alterTable).not.toHaveBeenCalled();
  });

  test('down() restores the original schema shape — boolean defaulting FALSE', async () => {
    // Faithful restore of 20260401000001: old code expects the muted-by-
    // default column, so a rollback recreates exactly that.
    const { knex, state } = buildKnex({ hasColumn: false });
    await migration.down(knex);
    expect(state.added).toEqual(['billing_reminder']);
    expect(state.addedDefault).toBe(false);
  });

  test('down() is a no-op when the column still exists', async () => {
    const { knex, state } = buildKnex({ hasColumn: true });
    await migration.down(knex);
    expect(state.added).toEqual([]);
  });
});
