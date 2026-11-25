/**
 * The day-only decisions read on one snapshot (owner 2026-11-24 *snapshot*, told-visits readSnapshot): on real Postgres the
 * transaction is REPEATABLE READ and READ ONLY, so every query of one decision sees the same moment and none can write.
 */
const SKIP = !process.env.DATABASE_URL;

(SKIP ? describe.skip : describe)('readSnapshot on real PG', () => {
  let db;
  beforeAll(() => { db = require('../models/db'); });
  afterAll(async () => { if (db) await db.destroy(); });

  test('the snapshot is repeatable read and read only, and the reader runs on it', async () => {
    const { readSnapshot, resolvePromises } = require('../services/auto-dispatch/told-visits');
    const state = await readSnapshot(db, async (trx) => ({
      isolation: (await trx.raw('SHOW transaction_isolation')).rows[0].transaction_isolation,
      readOnly: (await trx.raw('SHOW transaction_read_only')).rows[0].transaction_read_only,
    }));
    expect(state).toEqual({ isolation: 'repeatable read', readOnly: 'on' });
    const none = await resolvePromises(db, ['00000000-0000-0000-0000-000000000000'], new Date(), { sameDateOnly: true });
    expect(none.get('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  test('a write inside the snapshot is refused', async () => {
    const { readSnapshot } = require('../services/auto-dispatch/told-visits');
    await expect(readSnapshot(db, (trx) => trx.raw('CREATE TEMP TABLE snapshot_probe (x int)'))).rejects.toThrow(/read-only/);
  });
});
