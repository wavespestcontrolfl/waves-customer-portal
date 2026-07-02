const migration = require('../models/migrations/20260702000002_activate_pest_prep_email_automations');

function knexStub({ hasTable = true, rows = [] } = {}) {
  const updates = [];
  const query = {
    whereIn: jest.fn(async (column, keys) => {
      expect(column).toBe('automation_key');
      expect(keys).toEqual(['prep.bed_bug', 'prep.cockroach']);
      return rows;
    }),
    where: jest.fn((criteria) => ({
      update: jest.fn(async (values) => {
        updates.push({ criteria, values });
        return 1;
      }),
    })),
  };
  const knex = jest.fn(() => query);
  knex.fn = { now: jest.fn(() => 'NOW()') };
  knex.schema = { hasTable: jest.fn(async () => hasTable) };
  return { knex, updates };
}

describe('activate pest prep email automations migration', () => {
  test('flips draft rows active and merges the send-time exit conditions', async () => {
    const { knex, updates } = knexStub({
      rows: [{
        automation_key: 'prep.bed_bug',
        status: 'draft',
        exit_conditions: JSON.stringify({ stop_if: ['appointment.cancelled'] }),
      }],
    });

    await migration.up(knex);

    expect(updates).toHaveLength(1);
    expect(updates[0].criteria).toEqual({ automation_key: 'prep.bed_bug' });
    expect(updates[0].values.status).toBe('active');
    expect(JSON.parse(updates[0].values.exit_conditions)).toEqual({
      stop_if: ['appointment.cancelled', 'appointment.closed', 'appointment.past'],
    });
  });

  test('preserves an operator-set status while still merging exit conditions', async () => {
    const { knex, updates } = knexStub({
      rows: [{
        automation_key: 'prep.cockroach',
        status: 'paused',
        exit_conditions: JSON.stringify({ stop_if: ['appointment.cancelled'], custom: true }),
      }],
    });

    await migration.up(knex);

    expect(updates).toHaveLength(1);
    expect(updates[0].values.status).toBeUndefined();
    const exit = JSON.parse(updates[0].values.exit_conditions);
    expect(exit.custom).toBe(true);
    expect(exit.stop_if).toEqual(['appointment.cancelled', 'appointment.closed', 'appointment.past']);
  });

  test('no-ops rows that already carry the status and exit conditions', async () => {
    const { knex, updates } = knexStub({
      rows: [{
        automation_key: 'prep.bed_bug',
        status: 'active',
        exit_conditions: JSON.stringify({
          stop_if: ['appointment.cancelled', 'appointment.closed', 'appointment.past'],
        }),
      }],
    });

    await migration.up(knex);

    expect(updates).toHaveLength(0);
  });

  test('no-ops when email_template_automations does not exist', async () => {
    const { knex } = knexStub({ hasTable: false });

    await migration.up(knex);

    expect(knex).not.toHaveBeenCalled();
  });

  test('down is a no-op (never disables rows the migration did not activate)', async () => {
    const { knex } = knexStub();

    await migration.down(knex);

    expect(knex).not.toHaveBeenCalled();
  });
});
