/**
 * 20260908000010 — widen customer_properties_occupancy_type_check with
 * 'family_occupied' (owner ruling 2026-09-08).
 */
const migration = require('../models/migrations/20260908000010_customer_properties_family_occupied');
const { OCCUPANCY_TYPES } = require('../services/customer-properties');

function fakeKnex({ hasTable = true, familyRows = 0 } = {}) {
  const raws = [];
  const knex = (table) => ({
    where: (cond) => ({
      first: async () => {
        expect(table).toBe('customer_properties');
        expect(cond).toEqual({ occupancy_type: 'family_occupied' });
        return familyRows > 0 ? { id: 'p1' } : undefined;
      },
    }),
  });
  knex.raw = async (sql) => { raws.push(sql); };
  knex.schema = { hasTable: async () => hasTable };
  return { knex, raws };
}

test('the widened list is exactly the service vocabulary (keeps CHECK and OCCUPANCY_TYPES in step)', () => {
  expect([...migration.WIDENED_OCCUPANCY_TYPES].sort()).toEqual([...OCCUPANCY_TYPES].sort());
  expect(migration.WIDENED_OCCUPANCY_TYPES).toContain('family_occupied');
  expect(migration.ORIGINAL_OCCUPANCY_TYPES).not.toContain('family_occupied');
});

test('up replaces the CHECK in one ALTER (no unconstrained window) with the seven values', async () => {
  const f = fakeKnex();
  await migration.up(f.knex);
  expect(f.raws).toHaveLength(1);
  expect(f.raws[0]).toMatch(/^ALTER TABLE customer_properties DROP CONSTRAINT IF EXISTS customer_properties_occupancy_type_check, ADD CONSTRAINT customer_properties_occupancy_type_check CHECK \(occupancy_type IN \('owner_occupied', 'family_occupied', 'rental_investment', 'commercial', 'seasonal', 'vacant', 'unknown'\)\)$/);
});

test('up is a no-op without the table', async () => {
  const f = fakeKnex({ hasTable: false });
  await migration.up(f.knex);
  expect(f.raws).toHaveLength(0);
});

test('down restores the six-value CHECK when no row carries family_occupied', async () => {
  const f = fakeKnex({ familyRows: 0 });
  await migration.down(f.knex);
  expect(f.raws).toHaveLength(1);
  expect(f.raws[0]).toMatch(/CHECK \(occupancy_type IN \('owner_occupied', 'rental_investment', 'commercial', 'seasonal', 'vacant', 'unknown'\)\)$/);
  expect(f.raws[0]).not.toMatch(/family_occupied/);
});

test('down refuses while a row carries family_occupied — never coerces office data', async () => {
  const f = fakeKnex({ familyRows: 1 });
  await expect(migration.down(f.knex)).rejects.toThrow(/re-point them before narrowing/);
  expect(f.raws).toHaveLength(0);
});
