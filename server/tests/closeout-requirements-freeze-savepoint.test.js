/**
 * SAVEPOINT semantics of the completion-time requirements freeze — the
 * property a fake knex cannot reproduce (waves-db §5b): Postgres aborts the
 * WHOLE transaction after any failed statement, so a best-effort lookup on
 * the caller's trx must be savepoint-wrapped or its failure takes down the
 * completion hosting it (the inspection-credit #3178 r4 / accept-path
 * #3328 r1 failure class).
 *
 * Proven against a real Postgres: the `services` table is renamed away
 * INSIDE a transaction (rolled back at the end), the freeze probe fails,
 * and the transaction must still accept statements.
 *
 * DB-backed; self-skips without DATABASE_URL (same pattern as
 * accept-path-service-identity.test.js).
 */
const path = require('path');

// Load the knexfile BEFORE deciding to skip — it resolves the Railway
// fallbacks into process.env.DATABASE_URL.
const knexConfig = require(path.join(__dirname, '..', 'knexfile.js'));
const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

const {
  resolveCloseoutRequirementsSnapshotForCompletion,
} = require('../services/service-closeout-requirements');

describeOrSkip('closeout requirements freeze — SAVEPOINT semantics (DB-backed)', () => {
  let knex;
  beforeAll(() => {
     
    knex = require('knex')(knexConfig[process.env.NODE_ENV === 'production' ? 'production' : 'development']);
  });
  afterAll(async () => { await knex.destroy(); });

  test('a failed catalog lookup freezes nothing AND leaves the completion trx usable', async () => {
    const marker = `savepoint-proof-${Date.now()}`;
    await expect(knex.transaction(async (trx) => {
      // Make the strict lookup fail mid-transaction.
      await trx.raw('ALTER TABLE services RENAME TO services_savepoint_proof_gone');
      const snap = await resolveCloseoutRequirementsSnapshotForCompletion({
        trx,
        serviceId: 'ss-savepoint-proof',
        catalogServiceId: null,
        serviceType: 'Quarterly Pest Control',
      });
      // Lookup failed ⇒ freeze NOTHING (never freeze fallback inference as
      // if the catalog had answered).
      expect(snap).toBeNull();
      // The transaction is still usable — without the SAVEPOINT this SELECT
      // throws `current transaction is aborted`.
      const { rows } = await trx.raw('SELECT ? AS marker', [marker]);
      expect(rows[0].marker).toBe(marker);
      // Roll the rename back.
      throw new Error('rollback-on-purpose');
    })).rejects.toThrow('rollback-on-purpose');

    // The rename never escaped the transaction.
    expect(await knex.schema.hasTable('services')).toBe(true);
    expect(await knex.schema.hasTable('services_savepoint_proof_gone')).toBe(false);
  });

  test('happy path inside a real trx: resolves and freezes without disturbing the transaction', async () => {
    await expect(knex.transaction(async (trx) => {
      const snap = await resolveCloseoutRequirementsSnapshotForCompletion({
        trx,
        serviceId: 'ss-savepoint-proof-2',
        catalogServiceId: null,
        serviceType: 'A Service Name That Matches No Catalog Row',
      });
      // No catalog row ⇒ the fallback-inference verdict IS frozen (that is
      // what the tooling showed at completion time).
      expect(snap).toMatchObject({ v: 1, source: 'fallback_inference' });
      const { rows } = await trx.raw('SELECT 1 AS ok');
      expect(rows[0].ok).toBe(1);
      throw new Error('rollback-on-purpose');
    })).rejects.toThrow('rollback-on-purpose');
  });
});
