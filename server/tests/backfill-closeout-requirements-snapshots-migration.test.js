/**
 * 20260831000080 — closeout-requirements snapshot backfill. DB-backed
 * (self-skips without DATABASE_URL): the migration is raw-SQL-heavy (jsonb
 * merge + UPDATE...FROM with named bindings), so a fake knex would prove
 * nothing about the statements that actually run. Everything executes
 * inside a transaction that is rolled back.
 *
 * Pins: completed pre-freeze records gain a snapshot with HONEST provenance
 * (source 'backfilled_from_live_catalog', catalogSource preserved); an
 * existing freeze is untouched (idempotent re-run too); incomplete records
 * are out of scope; down() removes ONLY backfilled snapshots.
 */
const path = require('path');

const knexConfig = require(path.join(__dirname, '..', 'knexfile.js'));
const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

const migration = require('../models/migrations/20260831000080_backfill_closeout_requirements_snapshots');

describeOrSkip('20260831000080 closeout snapshot backfill (DB-backed)', () => {
  let knex;
  beforeAll(() => {
     
    knex = require('knex')(knexConfig[process.env.NODE_ENV === 'production' ? 'production' : 'development']);
  });
  afterAll(async () => { await knex.destroy(); });

  test('up() stamps completed pre-freeze records honestly; down() removes only backfilled stamps', async () => {
    await expect(knex.transaction(async (trx) => {
      const [cust] = await trx('customers').insert({
        first_name: 'Backfill',
        last_name: 'Proof',
        email: `backfill-proof-${Date.now()}@example.invalid`,
        phone: '+19410000000',
      }).returning('id');
      const customerId = cust.id || cust;

      const insertRecord = async (fields) => {
        const [row] = await trx('service_records').insert({
          customer_id: customerId,
          service_date: '2026-08-01',
          service_type: 'WDO Inspection Service',
          ...fields,
        }).returning('id');
        return row.id || row;
      };

      const preFreeze = await insertRecord({ status: 'completed', structured_notes: JSON.stringify({ visitOutcome: 'performed' }) });
      const emptyNotes = await insertRecord({ status: 'completed', structured_notes: null });
      const alreadyFrozen = await insertRecord({
        status: 'completed',
        structured_notes: JSON.stringify({
          closeoutRequirements: { requiresServiceReport: true, requiredPhotoCount: 7, source: 'manual', frozenAt: 'ORIGINAL' },
        }),
      });
      const incomplete = await insertRecord({ status: 'incomplete', structured_notes: null });

      await migration.up(trx);

      const notesOf = async (id) => {
        const row = await trx('service_records').where({ id }).first('structured_notes');
        const v = row.structured_notes;
        // structured_notes is jsonb — pg returns it parsed.
        return v == null ? null : (typeof v === 'string' ? JSON.parse(v) : v);
      };

      const stamped = await notesOf(preFreeze);
      // Existing keys preserved; snapshot added with honest provenance and
      // the inference verdict for a WDO inspection (2 photos, no app log).
      expect(stamped.visitOutcome).toBe('performed');
      expect(stamped.closeoutRequirements).toMatchObject({
        v: 1,
        source: 'backfilled_from_live_catalog',
        requiresServiceReport: true,
        requiresApplicationLog: false,
        requiredPhotoCount: 2,
      });
      expect(typeof stamped.closeoutRequirements.frozenAt).toBe('string');

      expect((await notesOf(emptyNotes)).closeoutRequirements).toMatchObject({ source: 'backfilled_from_live_catalog' });
      // A true completion-time freeze is untouched.
      expect((await notesOf(alreadyFrozen)).closeoutRequirements).toMatchObject({ requiredPhotoCount: 7, frozenAt: 'ORIGINAL', source: 'manual' });
      // Incomplete records are out of scope — their eventual completion
      // writes the real freeze.
      expect(await notesOf(incomplete)).toBeNull();

      // Idempotent re-run: the stamped snapshot (frozenAt) does not move.
      const firstStamp = stamped.closeoutRequirements.frozenAt;
      await migration.up(trx);
      expect((await notesOf(preFreeze)).closeoutRequirements.frozenAt).toBe(firstStamp);

      // down(): backfilled stamps removed, completion-time freeze kept,
      // sibling keys preserved.
      await migration.down(trx);
      const afterDown = await notesOf(preFreeze);
      expect(afterDown.closeoutRequirements).toBeUndefined();
      expect(afterDown.visitOutcome).toBe('performed');
      expect((await notesOf(alreadyFrozen)).closeoutRequirements).toMatchObject({ frozenAt: 'ORIGINAL' });

      throw new Error('rollback-on-purpose');
    })).rejects.toThrow('rollback-on-purpose');
  });
});
