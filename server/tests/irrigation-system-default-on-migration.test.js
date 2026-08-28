/**
 * 20260828000002 — irrigation ON by default. Flips irrigation_system to true
 * only where the customer already supplied irrigation inputs (a derived
 * figure the old toggle default was hiding); a bare false may be a deliberate
 * "no system" and is left alone. Column default moves to true.
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
  test('up flips only rows with irrigation inputs (never a bare false — it may be a deliberate "no system"), then moves the default', async () => {
    const knex = fakeKnex();
    await migration.up(knex);
    expect(knex.raw).toHaveBeenCalledTimes(2);
    const [update] = knex.raw.mock.calls[0];
    expect(update).toMatch(/SET irrigation_system = true/);
    expect(update).toMatch(/irrigation_system IS DISTINCT FROM true\s+AND \(/);
    for (const col of ['irrigation_run_minutes', 'irrigation_inches_per_week', 'watering_days', 'irrigation_system_type', 'irrigation_zones', 'irrigation_controller_location', 'irrigation_schedule_notes', 'irrigation_issues', 'rain_sensor']) {
      expect(update).toContain(col);
    }
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
