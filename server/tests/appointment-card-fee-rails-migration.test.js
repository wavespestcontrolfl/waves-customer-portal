const migration = require('../models/migrations/20260801400000_appointment_card_fee_rails');

const FEE_COLUMNS = [
  'no_show_fee_amount',
  'cancel_window_hours',
  'fee_agreed_at',
  'fee_status',
  'no_show_payment_intent_id',
  'fee_charged_amount',
  'fee_charged_at',
];

function buildKnex({ hasTable = true, existingColumns = [] } = {}) {
  const state = { added: [], dropped: [] };
  const knex = {
    schema: {
      hasTable: jest.fn(async () => hasTable),
      hasColumn: jest.fn(async (t, col) => existingColumns.includes(col)),
      alterTable: jest.fn(async (t, cb) => {
        expect(t).toBe('appointment_card_requests');
        const add = (name) => { state.added.push(name); };
        cb({
          decimal: add,
          integer: add,
          timestamp: add,
          string: add,
          dropColumn: (name) => { state.dropped.push(name); },
        });
      }),
    },
  };
  return { knex, state };
}

describe('appointment card fee-rails migration', () => {
  test('up adds all fee columns when missing', async () => {
    const { knex, state } = buildKnex();
    await migration.up(knex);
    expect(state.added).toEqual(FEE_COLUMNS);
  });

  test('up is idempotent — existing columns are left alone', async () => {
    const { knex, state } = buildKnex({ existingColumns: FEE_COLUMNS });
    await migration.up(knex);
    expect(state.added).toEqual([]);
    expect(knex.schema.alterTable).not.toHaveBeenCalled();
  });

  test('up no-ops when the table does not exist', async () => {
    const { knex } = buildKnex({ hasTable: false });
    await migration.up(knex);
    expect(knex.schema.hasColumn).not.toHaveBeenCalled();
  });

  test('down drops exactly the fee columns, symmetrically', async () => {
    const { knex, state } = buildKnex({ existingColumns: FEE_COLUMNS });
    await migration.down(knex);
    expect(state.dropped).toEqual(FEE_COLUMNS);
  });

  test('down is idempotent when columns are already gone', async () => {
    const { knex, state } = buildKnex({ existingColumns: [] });
    await migration.down(knex);
    expect(state.dropped).toEqual([]);
  });
});
