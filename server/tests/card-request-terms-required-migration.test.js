// 20261102180000_card_request_terms_required: additive, idempotent, reversible
// (appointment_card_requests.in_person_terms_required boolean NOT NULL default false).
const migration = require('../models/migrations/20261102180000_card_request_terms_required');

function fakeKnex({ table = true, column = false } = {}) {
  const added = [];
  const dropped = [];
  const knex = {
    schema: {
      hasTable: jest.fn(async () => table),
      hasColumn: jest.fn(async () => column),
      alterTable: jest.fn(async (_name, cb) => {
        cb({
          boolean: (name) => { const chain = { notNullable: () => chain, defaultTo: (v) => { added.push([name, v]); return chain; } }; return chain; },
          dropColumn: (name) => dropped.push(name),
        });
      }),
    },
  };
  return { knex, added, dropped };
}

test('up adds a NOT NULL boolean defaulting to false', async () => {
  const { knex, added } = fakeKnex();
  await migration.up(knex);
  expect(added).toEqual([['in_person_terms_required', false]]);
});

test('up is a no-op when the column exists or the table is missing', async () => {
  for (const state of [{ column: true }, { table: false }]) {
    const { knex, added } = fakeKnex(state);
    await migration.up(knex);
    expect(added).toEqual([]);
  }
});

test('down drops only an existing column', async () => {
  let ctx = fakeKnex({ column: true });
  await migration.down(ctx.knex);
  expect(ctx.dropped).toEqual(['in_person_terms_required']);
  ctx = fakeKnex({ column: false });
  await migration.down(ctx.knex);
  expect(ctx.dropped).toEqual([]);
});
