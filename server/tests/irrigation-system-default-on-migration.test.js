/**
 * 20260828000002 — irrigation ON by default. Moves ONLY the column default.
 * No row may be rewritten: a stored false is indistinguishable from a
 * deliberate "off" (the retired toggle never cleared the schedule fields, so
 * retained inputs prove nothing either — GH codex P0 on #3557).
 */
const migration = require('../models/migrations/20260828000002_irrigation_system_default_on');

function fakeKnex({ hasTable = true, hasColumn = true } = {}) {
  const raw = jest.fn().mockResolvedValue(undefined);
  return {
    raw,
    schema: {
      hasTable: jest.fn().mockResolvedValue(hasTable),
      hasColumn: jest.fn().mockResolvedValue(hasColumn),
    },
  };
}

describe('irrigation_system default-on migration', () => {
  test('up moves the column default and touches no row', async () => {
    const knex = fakeKnex();
    await migration.up(knex);
    expect(knex.raw).toHaveBeenCalledTimes(1);
    expect(knex.raw.mock.calls[0][0]).toMatch(/ALTER COLUMN irrigation_system SET DEFAULT true/);
    expect(knex.raw.mock.calls[0][0]).not.toMatch(/UPDATE/i);
  });

  test('up is a no-op without the table or column', async () => {
    const noTable = fakeKnex({ hasTable: false });
    await migration.up(noTable);
    expect(noTable.raw).not.toHaveBeenCalled();
    const noColumn = fakeKnex({ hasColumn: false });
    await migration.up(noColumn);
    expect(noColumn.raw).not.toHaveBeenCalled();
  });

  test('down restores the old default', async () => {
    const knex = fakeKnex();
    await migration.down(knex);
    expect(knex.raw).toHaveBeenCalledTimes(1);
    expect(knex.raw.mock.calls[0][0]).toMatch(/SET DEFAULT false/);
  });
});
