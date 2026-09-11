/**
 * property_text_decisions — one row per (property, visit, seam): the
 * resolver writes with ON CONFLICT DO NOTHING on this key, so a held reminder
 * re-scanned every 15 minutes, or the three seams one en-route event crosses,
 * do not inflate the ruling-R5 review counts. Rows are only written with a
 * visit id (the resolver requires one).
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('property_text_decisions'))) return;
  await knex.raw(
    'CREATE UNIQUE INDEX IF NOT EXISTS property_text_decisions_property_visit_source_uidx '
    + 'ON property_text_decisions (property_id, scheduled_service_id, source)',
  );
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('property_text_decisions'))) return;
  await knex.raw('DROP INDEX IF EXISTS property_text_decisions_property_visit_source_uidx');
};
