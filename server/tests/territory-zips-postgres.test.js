/**
 * territory_zips on real PostgreSQL (territory build 1): the migrated seed, the
 * technician key (SET NULL when a technician row goes) and territoryForZip against
 * real rows.
 *
 * DB-gated: skips without DATABASE_URL, runs in CI against the migrated database.
 * Every write happens inside a transaction that is rolled back, so the seed and the
 * synthetic technician never persist.
 */
const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;

jest.setTimeout(60000);
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { randomUUID } = require('node:crypto');
const db = require('../models/db');
const { territoryForZip } = require('../services/territory');

describeDb('territory_zips (Postgres)', () => {
  afterAll(async () => {
    await db.destroy();
  });

  test('the migration seeded 52 ZIPs in 7 areas', async () => {
    const rows = await db('territory_zips').select('zip', 'area');
    expect(rows).toHaveLength(52);
    expect(new Set(rows.map((row) => row.area)).size).toBe(7);
  });

  test('a ZIP reads its territory technician, and loses it when the technician row is deleted', async () => {
    const trx = await db.transaction();
    try {
      const techId = randomUUID();
      await trx('technicians').insert({
        id: techId, name: `Territory ${techId.slice(0, 8)}`, email: `${techId}@example.invalid`,
        password_hash: 'synthetic-not-a-login-hash', role: 'technician', active: true,
        employment_status: 'active', field_dispatchable: true,
      });
      await trx('territory_zips').where({ zip: '34293' }).update({ technician_id: techId });
      await expect(territoryForZip(trx, '34293')).resolves.toMatchObject({ area: 'venice', technicianId: techId });

      await trx('technicians').where({ id: techId }).del();
      await expect(territoryForZip(trx, '34293')).resolves.toMatchObject({ area: 'venice', technicianId: null });
    } finally {
      await trx.rollback();
    }
  });

  test('a ZIP outside the service area is not a territory', async () => {
    await expect(territoryForZip(db, '90210')).resolves.toBeNull();
  });
});
