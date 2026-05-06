/**
 * Move the remaining status-change audit payload off service_status_log.
 *
 * job_status_history is the canonical transition log. These columns keep
 * the notes/GPS details that the admin dispatch and schedule routes accepted
 * while allowing runtime code to stop writing the legacy service_status_log
 * table.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('job_status_history', (t) => {
    t.decimal('lat', 10, 6);
    t.decimal('lng', 10, 6);
    t.text('notes');
  });

  if (await knex.schema.hasTable('service_status_log')) {
    await knex.raw(`
      WITH legacy AS (
        SELECT
          ssl.id,
          ssl.scheduled_service_id,
          ssl.status,
          COALESCE(ssl.created_at, NOW()) AS created_at,
          ssl.changed_by,
          ssl.lat,
          ssl.lng,
          ssl.notes
        FROM service_status_log ssl
        WHERE ssl.status IN (
          'pending',
          'confirmed',
          'rescheduled',
          'en_route',
          'on_site',
          'completed',
          'cancelled',
          'skipped'
        )
      ),
      matched AS (
        SELECT DISTINCT ON (legacy.id)
          legacy.id AS legacy_id,
          jsh.id AS history_id
        FROM legacy
        JOIN job_status_history jsh
          ON jsh.job_id = legacy.scheduled_service_id
         AND jsh.to_status = legacy.status
         AND jsh.transitioned_at BETWEEN legacy.created_at - INTERVAL '5 minutes'
                                     AND legacy.created_at + INTERVAL '5 minutes'
        ORDER BY
          legacy.id,
          ABS(EXTRACT(EPOCH FROM (jsh.transitioned_at - legacy.created_at)))
      ),
      updated AS (
        UPDATE job_status_history jsh
           SET lat = COALESCE(jsh.lat, legacy.lat),
               lng = COALESCE(jsh.lng, legacy.lng),
               notes = COALESCE(jsh.notes, legacy.notes),
               transitioned_by = COALESCE(jsh.transitioned_by, legacy.changed_by)
          FROM matched
          JOIN legacy ON legacy.id = matched.legacy_id
         WHERE jsh.id = matched.history_id
        RETURNING matched.legacy_id
      )
      INSERT INTO job_status_history (
        job_id,
        from_status,
        to_status,
        transitioned_at,
        transitioned_by,
        lat,
        lng,
        notes
      )
      SELECT
        legacy.scheduled_service_id,
        NULL,
        legacy.status,
        legacy.created_at,
        legacy.changed_by,
        legacy.lat,
        legacy.lng,
        legacy.notes
      FROM legacy
      WHERE NOT EXISTS (
        SELECT 1
        FROM matched
        WHERE matched.legacy_id = legacy.id
      )
    `);
  }
};

exports.down = async function (knex) {
  await knex.schema.alterTable('job_status_history', (t) => {
    t.dropColumn('lat');
    t.dropColumn('lng');
    t.dropColumn('notes');
  });
};
