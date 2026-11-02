/**
 * 20261102120000_projects_sent_outside: additive, nullable, no backfill,
 * idempotent via per-column hasColumn guards; down drops only what is there.
 */
const migration = require('../models/migrations/20261102120000_projects_sent_outside');

function fakeKnex(existing = []) {
  const calls = [];
  const colBuilder = (name) => {
    const b = {
      nullable: jest.fn(() => { calls.push(['nullable', name]); return b; }),
      references: jest.fn((col) => { calls.push(['references', name, col]); return b; }),
      inTable: jest.fn((tbl) => { calls.push(['inTable', name, tbl]); return b; }),
    };
    return b;
  };
  const table = {
    timestamp: jest.fn((name, opts) => { calls.push(['timestamp', name, opts]); return colBuilder(name); }),
    uuid: jest.fn((name) => { calls.push(['uuid', name]); return colBuilder(name); }),
    text: jest.fn((name) => { calls.push(['text', name]); return colBuilder(name); }),
    dropColumn: jest.fn((name) => calls.push(['dropColumn', name])),
  };
  return {
    calls,
    raw: jest.fn(),
    schema: {
      hasTable: jest.fn(async () => true),
      hasColumn: jest.fn(async (_t, name) => existing.includes(name)),
      alterTable: jest.fn(async (name, cb) => { calls.push(['alterTable', name]); cb(table); }),
    },
  };
}

const ALL = ['sent_outside_portal_at', 'sent_outside_portal_by', 'sent_outside_portal_note'];

test('up adds three nullable columns, the actor as a technicians FK, and no backfill', async () => {
  const knex = fakeKnex();
  await migration.up(knex);
  expect(knex.calls).toEqual([
    ['alterTable', 'projects'],
    ['timestamp', 'sent_outside_portal_at', { useTz: true }],
    ['nullable', 'sent_outside_portal_at'],
    ['uuid', 'sent_outside_portal_by'],
    ['nullable', 'sent_outside_portal_by'],
    ['references', 'sent_outside_portal_by', 'id'],
    ['inTable', 'sent_outside_portal_by', 'technicians'],
    ['text', 'sent_outside_portal_note'],
    ['nullable', 'sent_outside_portal_note'],
  ]);
  expect(knex.raw).not.toHaveBeenCalled();
});

test('up is idempotent: all columns present does nothing', async () => {
  const knex = fakeKnex(ALL);
  await migration.up(knex);
  expect(knex.schema.alterTable).not.toHaveBeenCalled();
});

test('up adds only the missing columns after a partial run', async () => {
  const knex = fakeKnex(['sent_outside_portal_at']);
  await migration.up(knex);
  const added = knex.calls.filter((c) => ['timestamp', 'uuid', 'text'].includes(c[0])).map((c) => c[1]);
  expect(added).toEqual(['sent_outside_portal_by', 'sent_outside_portal_note']);
});

test('down drops the columns that exist, and nothing when none do', async () => {
  const present = fakeKnex(ALL);
  await migration.down(present);
  expect(present.calls).toEqual([
    ['alterTable', 'projects'],
    ['dropColumn', 'sent_outside_portal_at'],
    ['dropColumn', 'sent_outside_portal_by'],
    ['dropColumn', 'sent_outside_portal_note'],
  ]);
  const absent = fakeKnex([]);
  await migration.down(absent);
  expect(absent.schema.alterTable).not.toHaveBeenCalled();
});
