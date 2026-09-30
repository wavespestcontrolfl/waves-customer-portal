/**
 * neighborhood_pressure_aggregates.score_scale: which Pest Pressure scale the
 * window's average was computed on ('technician_rating' | 'blended').
 *
 * #4741 (2026-09-24) made a technician's tap the score directly while older
 * scores - and customer-submitted ratings, still - are blended, so an average
 * over mixed readings is on no scale at all. The builder now averages ONE
 * scale per window, by score-row provenance, and records it here; the reader
 * only charts windows of one scale together. Rows built before this column
 * exist are NULL and are read conservatively (blended only when the window
 * ended before the cutover, otherwise suppressed).
 *
 * Nullable, additive, no backfill: existing rows keep working.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('neighborhood_pressure_aggregates'))) return;
  if (await knex.schema.hasColumn('neighborhood_pressure_aggregates', 'score_scale')) return;
  await knex.schema.alterTable('neighborhood_pressure_aggregates', (t) => {
    t.string('score_scale', 20);
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('neighborhood_pressure_aggregates'))) return;
  if (!(await knex.schema.hasColumn('neighborhood_pressure_aggregates', 'score_scale'))) return;
  await knex.schema.alterTable('neighborhood_pressure_aggregates', (t) => {
    t.dropColumn('score_scale');
  });
};
