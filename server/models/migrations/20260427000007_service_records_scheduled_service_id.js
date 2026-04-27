/**
 * Add a direct FK from service_records.scheduled_service_id →
 * scheduled_services.id. Closes the ambiguity Codex P1 caught on
 * PR #340: photo upload (and any other code) was looking up
 * service_records by (customer_id, technician_id, service_date),
 * which collides when a single tech has two visits for the same
 * customer on the same day.
 *
 * Nullable because old records (pre-this-migration) don't have a
 * back-link. New writes from POST /api/admin/dispatch/:serviceId/complete
 * (PR #330) populate it. Old records stay NULL and aren't
 * photo-attachable via the tech-track route — they're completed
 * historical visits that don't need new photos.
 *
 * Indexed because the photo upload lookup queries by this column
 * on every request.
 *
 * No CHECK / NOT NULL added — old rows already exist and we don't
 * want a backfill in this PR. Future cleanup: backfill old rows
 * via the (customer_id, technician_id, service_date) match where
 * unambiguous, then add a NOT NULL constraint.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasColumn('service_records', 'scheduled_service_id'))) {
    await knex.schema.alterTable('service_records', (t) => {
      t.uuid('scheduled_service_id')
        .references('id').inTable('scheduled_services').onDelete('SET NULL');
    });
  }
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS idx_service_records_scheduled_service_id ON service_records(scheduled_service_id)'
  );
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_service_records_scheduled_service_id');
  if (await knex.schema.hasColumn('service_records', 'scheduled_service_id')) {
    await knex.schema.alterTable('service_records', (t) => {
      t.dropColumn('scheduled_service_id');
    });
  }
};
