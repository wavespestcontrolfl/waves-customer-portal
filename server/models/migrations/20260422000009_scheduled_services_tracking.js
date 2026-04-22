/**
 * Phase 1 tracking lifecycle on scheduled_services.
 *
 * Re-ship of the reverted PR #52 with the en-route-only SMS model.
 *
 * Reality check on prod state:
 *   PR #52's migration (20260422000007) ran against prod on merge; PR
 *   #53 reverted the git history but the DB state persisted. So prod
 *   still has the #52 columns on scheduled_services (varchar track_state
 *   with a CHECK constraint, plus a bunch of track_* timestamps with
 *   slightly different names than we settled on). The first deploy of
 *   this migration failed healthcheck because ALTER TABLE ADD COLUMN
 *   collided with those orphaned columns. This version cleans them up
 *   before adding the new shape. IF EXISTS / IF NOT EXISTS guards
 *   throughout so the migration is also safe on a clean DB (preview /
 *   fresh env that never saw #52).
 *
 * Final shape:
 *   - track_state: real Postgres ENUM (not CHECK). Worth the one-time
 *     ALTER TYPE cost later if we add a state; the string-column drift
 *     that bit other tables costs more.
 *   - Simple timestamp names (completed_at, cancelled_at, arrived_at,
 *     en_route_at) — collision grep against current migrations clean.
 *   - Backfill covers scheduled_date >= CURRENT_DATE; expiry = window_end
 *     + 1 day (end-of-day fallback when window_end is NULL).
 */
exports.up = async function (knex) {
  // 1. Drop orphaned PR #52 artifacts if present. All idempotent — no-op
  // on a clean DB.
  await knex.raw('DROP INDEX IF EXISTS idx_scheduled_services_track_state_window');
  await knex.raw(
    'ALTER TABLE scheduled_services DROP CONSTRAINT IF EXISTS scheduled_services_track_state_check'
  );

  const orphanColumns = [
    'track_view_token',
    'track_state',
    'en_route_at',
    'arrived_at',
    'track_completed_at',
    'track_cancelled_at',
    'track_cancellation_reason',
    'track_sms_sent_at',
    'late_sms_sent_at',
    'track_token_expires_at',
  ];
  for (const col of orphanColumns) {
    // CASCADE so any lingering dependency we didn't explicitly drop above
    // (implicit unique constraints, multi-column indexes we don't know the
    // exact name of) gets cleaned up with the column.
    await knex.raw(`ALTER TABLE scheduled_services DROP COLUMN IF EXISTS ${col} CASCADE`);
  }

  // 2. (Re)create the enum type. DROP first in case a prior failed run
  // left a stale type; CASCADE in case some column/function we missed
  // still references it.
  await knex.raw('DROP INDEX IF EXISTS idx_scheduled_services_track_token');
  await knex.raw('DROP TYPE IF EXISTS track_state CASCADE');
  await knex.raw(`
    CREATE TYPE track_state AS ENUM (
      'scheduled','en_route','on_property','complete','cancelled'
    )
  `);

  // 3. Add the Phase 1 shape. IF NOT EXISTS on each column so a
  // partially-applied prior run doesn't re-collide.
  const addCols = [
    "ADD COLUMN IF NOT EXISTS track_view_token       varchar(64)",
    "ADD COLUMN IF NOT EXISTS track_state            track_state NOT NULL DEFAULT 'scheduled'",
    "ADD COLUMN IF NOT EXISTS en_route_at            timestamptz",
    "ADD COLUMN IF NOT EXISTS arrived_at             timestamptz",
    "ADD COLUMN IF NOT EXISTS completed_at           timestamptz",
    "ADD COLUMN IF NOT EXISTS cancelled_at           timestamptz",
    "ADD COLUMN IF NOT EXISTS cancellation_reason    text",
    "ADD COLUMN IF NOT EXISTS track_sms_sent_at      timestamptz",
    "ADD COLUMN IF NOT EXISTS track_token_expires_at timestamptz",
  ];
  for (const clause of addCols) {
    await knex.raw(`ALTER TABLE scheduled_services ${clause}`);
  }

  // 4. Unique partial index on the token. Legacy NULL rows aren't forced
  // into uniqueness they can't satisfy.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_services_track_token
      ON scheduled_services (track_view_token)
      WHERE track_view_token IS NOT NULL
  `);

  // 5. Backfill. scheduled_date >= CURRENT_DATE captures today-and-future
  // rows. Token expiry composes from scheduled_date + window_end so a
  // completed service stays live for 24h post-service (customer revisits
  // the summary card). NULL window_end falls back to end-of-day.
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
