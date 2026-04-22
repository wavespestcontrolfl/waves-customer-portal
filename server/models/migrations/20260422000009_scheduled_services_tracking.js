/**
 * Phase 1 tracking lifecycle on scheduled_services.
 *
 * Re-ship of the reverted PR #52 with the en-route-only SMS model:
 *   - no morning-of SMS cron
 *   - customer only gets the track link when the tech flips en_route
 *   - track_sms_sent_at is the idempotency guard against retaps
 *
 * Five-state enum lives as a real Postgres ENUM (track_state) not a CHECK
 * constraint. State list is stable; we'd rather pay ALTER TYPE costs once
 * later than live with the string-column drift that bit other tables.
 *
 * Columns added: track_view_token, track_state, en_route_at, arrived_at,
 * completed_at, cancelled_at, cancellation_reason, track_sms_sent_at,
 * track_token_expires_at. Collision grep against existing migrations came
 * back clean on the four simple timestamp names.
 *
 * Backfill: every row with scheduled_date >= CURRENT_DATE gets a token so
 * in-flight services pick up the feature day-one. track_token_expires_at
 * is composed from scheduled_date + window_end + 1 day so a completed
 * service keeps its token live for a day post-service (same UX pattern
 * as /pay/:token staying live post-payment). NULL window_end falls back
 * to end-of-day on scheduled_date.
 */
exports.up = async function (knex) {
  await knex.raw(`
    CREATE TYPE track_state AS ENUM (
      'scheduled','en_route','on_property','complete','cancelled'
    )
  `);

  await knex.raw(`
    ALTER TABLE scheduled_services
      ADD COLUMN track_view_token       varchar(64),
      ADD COLUMN track_state            track_state NOT NULL DEFAULT 'scheduled',
      ADD COLUMN en_route_at            timestamptz,
      ADD COLUMN arrived_at             timestamptz,
      ADD COLUMN completed_at           timestamptz,
      ADD COLUMN cancelled_at           timestamptz,
      ADD COLUMN cancellation_reason    text,
      ADD COLUMN track_sms_sent_at      timestamptz,
      ADD COLUMN track_token_expires_at timestamptz
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX idx_scheduled_services_track_token
      ON scheduled_services (track_view_token)
      WHERE track_view_token IS NOT NULL
  `);

  // Backfill tokens + expiry for today + future rows. window_end can be
  // NULL (time-TBD services) — fall back to end-of-day so the token still
  // expires predictably.
  await knex.raw(`
    UPDATE scheduled_services
       SET track_view_token = encode(gen_random_bytes(32), 'hex'),
           track_token_expires_at =
             (scheduled_date + COALESCE(window_end, TIME '23:59:59'))::timestamptz
             + INTERVAL '1 day'
     WHERE track_view_token IS NULL
       AND scheduled_date >= CURRENT_DATE
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_scheduled_services_track_token');
  await knex.raw(`
    ALTER TABLE scheduled_services
      DROP COLUMN IF EXISTS track_view_token,
      DROP COLUMN IF EXISTS track_state,
      DROP COLUMN IF EXISTS en_route_at,
      DROP COLUMN IF EXISTS arrived_at,
      DROP COLUMN IF EXISTS completed_at,
      DROP COLUMN IF EXISTS cancelled_at,
      DROP COLUMN IF EXISTS cancellation_reason,
      DROP COLUMN IF EXISTS track_sms_sent_at,
      DROP COLUMN IF EXISTS track_token_expires_at
  `);
  await knex.raw('DROP TYPE IF EXISTS track_state');
};
