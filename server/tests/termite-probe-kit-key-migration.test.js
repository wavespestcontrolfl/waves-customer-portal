/**
 * 20261023000030_termite_probe_kit_key — splits the seeded termite item
 * "Flashlight and probe/screwdriver" (keyed flashlight by 20261023000020)
 * into Flashlight (flashlight) and Probe or screwdriver (probe), preserving
 * admin edits and auditing each rewrite. down() is a no-op. knex is a
 * recording fake; no Postgres.
 */
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => {}) }));
const { recordAuditEvent } = require('../services/audit-log');
const migration = require('../models/migrations/20261023000030_termite_probe_kit_key');

function fakeKnex(rows) {
  const calls = { updates: [] };
  const knex = (table) => {
    const c = { table, cond: null };
    c.where = (cond) => { c.cond = cond; return c; };
    c.update = async (patch) => { calls.updates.push({ table, id: c.cond.id, patch }); return 1; };
    c.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
    return c;
  };
  knex.schema = { hasTable: async () => true };
  knex.fn = { now: () => 'NOW()' };
  knex.calls = calls;
  return knex;
}

const row = (id, items) => ({ id, service_line: 'termite', checklist_items: JSON.stringify([{ category: 'Inspection', items }]) });

beforeEach(() => jest.clearAllMocks());

test('splits the seeded item into two keyed requirements and audits the rewrite', async () => {
  const knex = fakeKnex([row('t1', [
    { item: 'Flashlight and probe/screwdriver', required: true, kit_key: 'flashlight' },
    { item: 'Moisture meter', required: true, kit_key: 'moisture_meter' },
  ])]);
  await migration.up(knex);
  expect(knex.calls.updates).toHaveLength(1);
  expect(JSON.parse(knex.calls.updates[0].patch.checklist_items)[0].items).toEqual([
    { item: 'Flashlight', required: true, kit_key: 'flashlight' },
    { item: 'Probe or screwdriver', required: true, kit_key: 'probe' },
    { item: 'Moisture meter', required: true, kit_key: 'moisture_meter' },
  ]);
  expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ resource_id: 't1', action: 'truck_kit_key_seed' }));
});

test('an edited, re-keyed or already split item is left alone, and a second run rewrites nothing', async () => {
  const knex = fakeKnex([
    row('edited', [{ item: 'Flashlight and probe/screwdriver (headlamp)', required: true, kit_key: 'flashlight' }]),
    row('rekeyed', [{ item: 'Flashlight and probe/screwdriver', required: true, kit_key: 'termite_kit' }]),
    row('split', [{ item: 'Flashlight', required: true, kit_key: 'flashlight' }, { item: 'Probe or screwdriver', required: true, kit_key: 'probe' }]),
  ]);
  await migration.up(knex);
  expect(knex.calls.updates).toEqual([]);
  expect(recordAuditEvent).not.toHaveBeenCalled();
});

test('down changes nothing', async () => {
  const knex = fakeKnex([row('t1', [{ item: 'Flashlight', required: true, kit_key: 'flashlight' }])]);
  await migration.down(knex);
  expect(knex.calls.updates).toEqual([]);
});
