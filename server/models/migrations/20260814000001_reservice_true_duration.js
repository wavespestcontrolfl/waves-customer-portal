// Re-service callbacks are true 15–30 min visits (owner ruling 2026-08-13),
// but the catalog rows carried the generic 60-min default, which made the
// re-service link's route-aware slot search hunt for full-hour holes and
// offer dates days out while same/next-day gaps sat open. Set the two lane
// rows to 30. Guarded: only rows still at the seeded 60 move — an
// admin-edited duration is authoritative and stays (read-modify-write rule).
// Customer-facing arrival windows are unaffected (arrivalWindowRange derives
// from start time only).

const LANE_KEYS = ['pest_re_service', 'lawn_re_service'];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  await knex('services')
    .whereIn('service_key', LANE_KEYS)
    .where('default_duration_minutes', 60)
    .update({ default_duration_minutes: 30 });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  await knex('services')
    .whereIn('service_key', LANE_KEYS)
    .where('default_duration_minutes', 30)
    .update({ default_duration_minutes: 60 });
};
