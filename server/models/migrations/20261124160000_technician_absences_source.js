/**
 * technician_absences.source and system_cleared_at: explicit ownership for the technician days-off sync
 * (services/tech-birthday-absences.js, owner 2026-11-24).
 *
 *   source              NULL (every row that exists today, and every row the office or tech-out writes) or
 *                       'tech_days_off' (a row the daily sync wrote). The sync's reconcile reads ONLY rows with
 *                       this value, so no row of the office's can ever be cleared by it. A new source value needs a
 *                       new migration that widens the CHECK.
 *   system_cleared_at   set only when the sync itself cleared its own row (a corrected date of birth, a leaver).
 *                       An office clear (tech-out clearTechOut) never sets it, and records the office user in
 *                       cleared_by. The sync may reopen a row only while this is set, so a clear the office made
 *                       is never undone, even when its cleared_by is empty.
 *
 * Both columns are nullable with no default, and no reader of the table selects or filters them, so the migration
 * changes no behaviour by itself. No backfill: no row of the sync exists yet (the sync ships with this column).
 *
 * up() is idempotent. down() drops the CHECKs and both columns; the rows stay as plain absence rows, so the
 * sync's ownership markers are lost and a later up() starts them again from NULL.
 */
const TABLE = 'technician_absences';
const SOURCE_CHECK = 'technician_absences_source_check';
const SYSTEM_CLEAR_CHECK = 'technician_absences_system_cleared_check';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (!(await knex.schema.hasColumn(TABLE, 'source'))) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.text('source');
      t.timestamp('system_cleared_at', { useTz: true });
    });
  } else if (!(await knex.schema.hasColumn(TABLE, 'system_cleared_at'))) {
    await knex.schema.alterTable(TABLE, (t) => { t.timestamp('system_cleared_at', { useTz: true }); });
  }
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${SOURCE_CHECK}`);
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${SOURCE_CHECK} CHECK (source IS NULL OR source = 'tech_days_off')`);
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${SYSTEM_CLEAR_CHECK}`);
  await knex.raw(
    `ALTER TABLE ${TABLE} ADD CONSTRAINT ${SYSTEM_CLEAR_CHECK} `
    + 'CHECK (system_cleared_at IS NULL OR (source IS NOT NULL AND cleared_at IS NOT NULL))',
  );
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${SYSTEM_CLEAR_CHECK}`);
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${SOURCE_CHECK}`);
  if (await knex.schema.hasColumn(TABLE, 'system_cleared_at')) {
    await knex.schema.alterTable(TABLE, (t) => { t.dropColumn('system_cleared_at'); });
  }
  if (await knex.schema.hasColumn(TABLE, 'source')) {
    await knex.schema.alterTable(TABLE, (t) => { t.dropColumn('source'); });
  }
};
