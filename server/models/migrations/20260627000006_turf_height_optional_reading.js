/**
 * Make the turf-height reading OPTIONAL.
 *
 * The gauge-reading capture became fully optional: a tech may close a lawn visit
 * with no numeric height and/or just an on-site lawn-length photo. A photo-only
 * row therefore needs a null `manual_height_in` (and, with no height, a null
 * `range_status`). The existing CHECK (manual_height_in BETWEEN 0.5 AND 8.0)
 * already passes for NULL (UNKNOWN is not a violation), so only the NOT NULL
 * constraints change. `target_min_in` / `target_max_in` stay NOT NULL — the band
 * is snapshotted from the grass type regardless of whether a reading was entered.
 */
exports.up = async function up(knex) {
  const exists = await knex.schema.hasTable('turf_height_readings');
  if (!exists) return;
  await knex.raw('ALTER TABLE turf_height_readings ALTER COLUMN manual_height_in DROP NOT NULL');
  await knex.raw('ALTER TABLE turf_height_readings ALTER COLUMN range_status DROP NOT NULL');
};

exports.down = async function down(knex) {
  const exists = await knex.schema.hasTable('turf_height_readings');
  if (!exists) return;
  // Best-effort restore. Backfill photo-only rows so the NOT NULL can re-apply
  // without failing on pre-existing nulls; only re-assert manual_height_in's
  // NOT NULL when no height-less rows remain (else leave it nullable rather than
  // fail the down).
  await knex.raw("UPDATE turf_height_readings SET range_status = 'in_range' WHERE range_status IS NULL");
  await knex.raw('ALTER TABLE turf_height_readings ALTER COLUMN range_status SET NOT NULL');
  const { rows } = await knex.raw('SELECT COUNT(*)::int AS n FROM turf_height_readings WHERE manual_height_in IS NULL');
  if (!rows[0].n) {
    await knex.raw('ALTER TABLE turf_height_readings ALTER COLUMN manual_height_in SET NOT NULL');
  }
};
