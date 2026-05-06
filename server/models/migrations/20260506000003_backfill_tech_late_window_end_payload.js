exports.up = async function (knex) {
  await knex.raw(`
    UPDATE dispatch_alerts AS a
    SET payload = jsonb_set(
      COALESCE(a.payload, '{}'::jsonb),
      '{window_end}',
      to_jsonb(s.window_end::text),
      true
    )
    FROM scheduled_services AS s
    WHERE a.type = 'tech_late'
      AND a.job_id = s.id
      AND NOT (COALESCE(a.payload, '{}'::jsonb) \\? 'window_end')
      AND s.window_end IS NOT NULL
  `);
};

exports.down = async function () {
  // Data backfill only. Preserve payload audit history on rollback.
};
