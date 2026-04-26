/**
 * Relax the scheduled_services.status CHECK constraint.
 *
 * The initial schema (20260401000001) created `status` via Knex's
 * `t.enu('status', ['pending','confirmed','rescheduled','cancelled','completed'])`.
 * In Postgres, Knex implements that as a CHECK constraint named
 * `scheduled_services_status_check`. The app code, however, has long
 * written 'en_route', 'on_site', and 'skipped' through both the dispatch
 * route and the schedule route — values the constraint rejects with
 * "new row for relation \"scheduled_services\" violates check constraint",
 * which surfaces in the UI as "En route failed: Internal server error".
 *
 * Drop the old constraint and recreate it with the full set of statuses
 * the application actually emits. IF EXISTS / IF NOT EXISTS guards make
 * this safe to re-run on a partially-applied DB.
 *
 * track_state (the canonical customer-visible state machine) lives on a
 * separate Postgres ENUM owned by 20260422000009 and is unaffected.
 */
exports.up = async function (knex) {
  await knex.raw(
    'ALTER TABLE scheduled_services DROP CONSTRAINT IF EXISTS scheduled_services_status_check'
  );
  await knex.raw(`
    ALTER TABLE scheduled_services
      ADD CONSTRAINT scheduled_services_status_check
      CHECK (status IN (
        'pending',
        'confirmed',
        'rescheduled',
        'en_route',
        'on_site',
        'completed',
        'cancelled',
        'skipped'
      ))
  `);
};

exports.down = async function (knex) {
  await knex.raw(
    'ALTER TABLE scheduled_services DROP CONSTRAINT IF EXISTS scheduled_services_status_check'
  );
  await knex.raw(`
    ALTER TABLE scheduled_services
      ADD CONSTRAINT scheduled_services_status_check
      CHECK (status IN ('pending','confirmed','rescheduled','cancelled','completed'))
  `);
};
