/**
 * 20261023000020_equipment_kit_key — keys the seeded checklist items while
 * preserving admin edits: a row is read-modify-written, an item is keyed only
 * when its text matches exactly and it has no key yet, an unchanged row is not
 * rewritten, and each rewrite leaves an audit row. down() keeps the keys.
 * knex is a recording fake; no Postgres.
 */
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => {}) }));
const { recordAuditEvent } = require('../services/audit-log');
const migration = require('../models/migrations/20261023000020_equipment_kit_key');

function fakeKnex({ rows, hasKitKey = false }) {
  const calls = { alter: [], updates: [] };
  const knex = (table) => {
    const c = { table, where: null };
    c.whereIn = () => c;
    c.where = (cond) => { c.where = cond; return c; };
    c.update = async (patch) => { calls.updates.push({ table, id: c.where.id, patch }); return 1; };
    c.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
    return c;
  };
  knex.schema = {
    hasTable: async () => true,
    hasColumn: async (t, col) => col === 'kit_key' ? hasKitKey : true,
    alterTable: async (table, fn) => {
      const builder = { string: (name, len) => { calls.alter.push(['string', name, len]); const col = {}; col.nullable = () => col; col.index = () => col; return col; }, dropColumn: (name) => calls.alter.push(['drop', name]) };
      fn(builder);
    },
  };
  knex.fn = { now: () => 'NOW()' };
  knex.calls = calls;
  return knex;
}

const seeded = (id, line, items) => ({ id, service_line: line, checklist_items: JSON.stringify([{ category: 'Inspection', items }]) });

beforeEach(() => jest.clearAllMocks());

test('keys unchanged seeded items, leaves edited or already-keyed ones alone, and audits each rewrite', async () => {
  const rows = [
    seeded('termite-row', 'termite', [{ item: 'Moisture meter', required: true }, { item: 'Flashlight and probe/screwdriver', required: true }]),
    // The owner reworded one item and keyed another by hand: both stand.
    seeded('pest-row', 'pest', [{ item: 'Flashlight (headlamp)', required: true }, { item: 'Bait gun', required: true, kit_key: 'gel_gun' }]),
    seeded('lawn-row', 'lawn', [{ item: 'Coffee can (chinch test)', required: true }]),
  ];
  const knex = fakeKnex({ rows });
  await migration.up(knex);
  expect(knex.calls.alter).toEqual([['string', 'kit_key', 60]]);
  expect(knex.calls.updates).toHaveLength(1);
  expect(knex.calls.updates[0].id).toBe('termite-row');
  expect(JSON.parse(knex.calls.updates[0].patch.checklist_items)[0].items).toEqual([
    { item: 'Moisture meter', required: true, kit_key: 'moisture_meter' },
    { item: 'Flashlight and probe/screwdriver', required: true, kit_key: 'flashlight' },
  ]);
  expect(recordAuditEvent).toHaveBeenCalledTimes(1);
  expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ resource_type: 'equipment_checklists', resource_id: 'termite-row', action: 'truck_kit_key_seed' }));
});

test('a second run adds no column and rewrites nothing', async () => {
  const rows = [seeded('termite-row', 'termite', [{ item: 'Moisture meter', required: true, kit_key: 'moisture_meter' }])];
  const knex = fakeKnex({ rows, hasKitKey: true });
  await migration.up(knex);
  expect(knex.calls.alter).toEqual([]);
  expect(knex.calls.updates).toEqual([]);
});

test('down drops only the column', async () => {
  const knex = fakeKnex({ rows: [], hasKitKey: true });
  await migration.down(knex);
  expect(knex.calls.alter).toEqual([['drop', 'kit_key']]);
  expect(knex.calls.updates).toEqual([]);
});
