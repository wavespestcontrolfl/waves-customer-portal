exports.up = async function (knex) {
  const hasServices = await knex.schema.hasTable('scheduled_services');
  if (!hasServices) return;

  const hasTechStatus = await knex.schema.hasTable('tech_status');
  const hasAuditLog = await knex.schema.hasTable('audit_log');
  const hasTrackTokenExpiresAt = await knex.schema.hasColumn('scheduled_services', 'track_token_expires_at');

  const currentJobsCte = hasTechStatus
    ? 'SELECT DISTINCT current_job_id FROM tech_status WHERE current_job_id IS NOT NULL'
    : 'SELECT NULL::uuid AS current_job_id WHERE false';

  const expirePastTokenSql = hasTrackTokenExpiresAt
    ? `,
      track_token_expires_at = CASE
        WHEN s.scheduled_date < (NOW() AT TIME ZONE 'America/New_York')::date
          THEN LEAST(COALESCE(s.track_token_expires_at, NOW()), NOW())
        ELSE s.track_token_expires_at
      END`
    : '';

  await knex.transaction(async (trx) => {
    await trx.raw(`
      CREATE TEMP TABLE stale_en_route_cleanup ON COMMIT DROP AS
      WITH current_jobs AS (${currentJobsCte})
      SELECT
        s.id,
        s.track_state AS previous_track_state,
        s.status AS previous_status,
        s.scheduled_date,
        s.technician_id,
        s.customer_id
      FROM scheduled_services s
      LEFT JOIN current_jobs cj ON cj.current_job_id = s.id
      WHERE (s.track_state = 'en_route' OR s.status = 'en_route')
        AND (
          s.scheduled_date < (NOW() AT TIME ZONE 'America/New_York')::date
          OR cj.current_job_id IS NULL
        )
    `);

    await trx.raw(`
      UPDATE scheduled_services s
      SET
        track_state = CASE WHEN s.track_state = 'en_route' THEN 'scheduled' ELSE s.track_state END,
        status = CASE WHEN s.status = 'en_route' THEN 'confirmed' ELSE s.status END,
        updated_at = NOW()
        ${expirePastTokenSql}
      FROM stale_en_route_cleanup t
      WHERE s.id = t.id
    `);

    if (hasTechStatus) {
      await trx.raw(`
        UPDATE tech_status ts
        SET
          status = CASE WHEN ts.status = 'en_route' THEN 'idle' ELSE ts.status END,
          current_job_id = NULL,
          updated_at = NOW()
        FROM stale_en_route_cleanup t
        WHERE ts.current_job_id = t.id
      `);
    }

    if (hasAuditLog) {
      await trx.raw(`
        INSERT INTO audit_log (actor_type, action, resource_type, resource_id, metadata)
        SELECT
          'system:gps-arrival-cleanup',
          'tracking.stale_en_route_reset',
          'scheduled_service',
          id,
          jsonb_build_object(
            'previous_track_state', previous_track_state,
            'previous_status', previous_status,
            'scheduled_date', scheduled_date,
            'technician_id', technician_id,
            'customer_id', customer_id,
            'migration', '20260521000002_cleanup_stale_en_route_tracking'
          )
        FROM stale_en_route_cleanup
      `);
    }
  });
};

exports.down = async function () {
  // Data cleanup is intentionally not reversible.
};
