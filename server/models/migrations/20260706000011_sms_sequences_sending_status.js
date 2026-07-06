/**
 * Broaden the sms_sequences.status CHECK to every status the code writes.
 *
 * The table was created with knex t.enu(...) — a CHECK limited to
 * active/completed/cancelled/paused (20260401000025_workflows.js) — but:
 *   - 'sending': the new-recurring welcome sweep claims rows before
 *     dispatch (active → sending) so a crash after the provider accepts
 *     can't leave the row due and double-text on the next tick.
 *   - 'converted' / 'escalated': cancellation-save (kept in full, owner
 *     directive 2026-07-06) has always written these terminal statuses —
 *     they would violate the original CHECK the moment that workflow is
 *     reactivated. Same defect class, fixed in the same constraint.
 *
 * The constraint is dropped by looking up its live name in pg_constraint
 * rather than assuming the knex-generated one: DROP IF EXISTS on a guessed
 * name would silently no-op and leave the old constraint enforcing.
 */
const BROADENED = ['active', 'completed', 'cancelled', 'paused', 'sending', 'converted', 'escalated'];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_sequences'))) return;

  const { rows } = await knex.raw(`
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'sms_sequences'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%status%'
  `);
  for (const row of rows) {
    await knex.raw(`ALTER TABLE sms_sequences DROP CONSTRAINT "${row.conname}"`);
  }
  await knex.raw(`
    ALTER TABLE sms_sequences
    ADD CONSTRAINT sms_sequences_status_check
    CHECK (status IN (${BROADENED.map((s) => `'${s}'`).join(', ')}))
  `);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sms_sequences'))) return;
  // Settle statuses the narrow constraint doesn't permit before
  // re-tightening, or the ADD CONSTRAINT itself would fail. In-flight
  // claims release to active; converted/escalated map to the nearest
  // original terminal state.
  await knex('sms_sequences').where({ status: 'sending' }).update({ status: 'active' });
  await knex('sms_sequences').whereIn('status', ['converted', 'escalated']).update({ status: 'completed' });
  await knex.raw('ALTER TABLE sms_sequences DROP CONSTRAINT IF EXISTS sms_sequences_status_check');
  await knex.raw(`
    ALTER TABLE sms_sequences
    ADD CONSTRAINT sms_sequences_status_check
    CHECK (status IN ('active', 'completed', 'cancelled', 'paused'))
  `);
};
