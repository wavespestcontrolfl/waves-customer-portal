/**
 * 20260828000002 — irrigation ON by default. The portal toggle is retired and
 * nothing else ever wrote false, so every legacy false (the old column
 * default) flips to true; the column default moves with it.
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
  test('up flips every non-true row (the false was the column default, not a customer statement), then moves the default', async () => {
    const knex = fakeKnex();
    await migration.up(knex);
    expect(knex.raw).toHaveBeenCalledTimes(2);
    const [update] = knex.raw.mock.calls[0];
    expect(update).toMatch(/UPDATE property_preferences/);
    expect(update).toMatch(/SET irrigation_system = true/);
    expect(update).toMatch(/WHERE irrigation_system IS DISTINCT FROM true\s*$/);
    expect(knex.raw.mock.calls[1][0]).toMatch(/ALTER COLUMN irrigation_system SET DEFAULT true/);
  });

  test('up is a no-op without the table or column', async () => {
    const noTable = fakeKnex({ hasTable: false });
    await migration.up(noTable);
    expect(noTable.raw).not.toHaveBeenCalled();
    const noColumn = fakeKnex({ hasColumn: false });
    await migration.up(noColumn);
    expect(noColumn.raw).not.toHaveBeenCalled();
  });

  test('down restores only the default (the data flip is not reversible)', async () => {
    const knex = fakeKnex();
    await migration.down(knex);
    expect(knex.raw).toHaveBeenCalledTimes(1);
    expect(knex.raw.mock.calls[0][0]).toMatch(/SET DEFAULT false/);
  });
});
