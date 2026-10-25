// Codex #6593 security P2: a notification_prefs row that predates the explicit stamp may hold
// a deliberate Text choice, so the backfill marks every existing row explicit and leaves false
// only for rows created after the cutover. down() is a documented no-op.
const migration = require('../models/migrations/20261024230000_confirmation_channel_explicit_backfill');

function buildKnex({ hasTable = true, hasColumn = true } = {}) {
  const updates = [];
  const knex = jest.fn((table) => ({
    update: jest.fn(async (row) => { updates.push({ table, row }); return 1589; }),
  }));
  knex.schema = {
    hasTable: jest.fn(async () => hasTable),
    hasColumn: jest.fn(async () => hasColumn),
  };
  return { knex, updates };
}

describe('confirmation channel explicit backfill migration', () => {
  test('up: every existing row counts as an explicit choice', async () => {
    const { knex, updates } = buildKnex();
    await migration.up(knex);
    expect(knex.schema.hasColumn).toHaveBeenCalledWith('notification_prefs', 'appointment_confirmation_channel_explicit');
    expect(updates).toEqual([{ table: 'notification_prefs', row: { appointment_confirmation_channel_explicit: true } }]);
  });

  test('up writes nothing without the table or the column', async () => {
    for (const shape of [{ hasTable: false }, { hasColumn: false }]) {
      const { knex, updates } = buildKnex(shape);
      await migration.up(knex);
      expect(updates).toEqual([]);
    }
  });

  test('down is a no-op: a backfilled true cannot be told apart from a later customer stamp', async () => {
    const { knex, updates } = buildKnex();
    await migration.down(knex);
    expect(knex).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });
});
