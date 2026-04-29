/**
 * Close the scheduled_services tracking-token forward leak and TZ
 * inconsistency from 20260422000009.
 *
 * Three changes, all schema-layer so application code doesn't have to
 * remember to call into a token-generation helper:
 *
 *   1. Mopup any NULL track_view_token / track_token_expires_at rows
 *      for today/future customer-linked services that slipped through
 *      paths inserted between 20260422000009 and now (none of the 8
 *      INSERT callsites under server/ generate either column
 *      explicitly; the comment in slot-reservation.js claiming a DB
 *      default existed was wrong).
 *   2. Add a column DEFAULT for track_view_token so every future
 *      INSERT auto-generates one.
 *   3. Forward-fill TZ-correct expiry on INSERT via BEFORE-INSERT
 *      trigger. Trigger (not GENERATED column) because the cancel
 *      flow in track-transitions.cancel intentionally overrides expiry
 *      to NOW + 24h to give the customer a 24h grace window on the
 *      /track link, regardless of the original service date — which
 *      a GENERATED ALWAYS column would block (Postgres rejects writes
 *      to generated columns, would 500 the cancel endpoints). Trigger
 *      runs only when the writer left expiry NULL, leaving overrides
 *      intact.
 *
 *      Caveat: trigger doesn't fire on UPDATE, so reschedule paths
 *      that change scheduled_date won't auto-recompute expiry.
 *      Tracked as #488. Out of scope for this PR.
 */

exports.up = async function up(knex) {
  // 1. Mopup. Mirrors the original 20260422000009 backfill scope (today
  // and future) but adds the customer_id IS NOT NULL filter — open
  // availability slots and draft holds don't surface a customer-facing
  // /track link. Backfills BOTH columns to handle rows where one or
  // the other slipped through.
  await knex.raw(`
    UPDATE scheduled_services
       SET track_view_token = COALESCE(
             track_view_token,
             encode(gen_random_bytes(32), 'hex')
           ),
           track_token_expires_at = COALESCE(
             track_token_expires_at,
             ((scheduled_date::timestamp + COALESCE(window_end, TIME '23:59:59'))
              AT TIME ZONE 'America/New_York')
             + INTERVAL '1 day'
           )
     WHERE (track_view_token IS NULL OR track_token_expires_at IS NULL)
       AND scheduled_date >= CURRENT_DATE
       AND customer_id IS NOT NULL
  `);

  // 2. Forward-leak fix for the token. Every new row gets one via
  // column DEFAULT; no INSERT callsite has to remember to set it.
  await knex.raw(`
    ALTER TABLE scheduled_services
      ALTER COLUMN track_view_token
      SET DEFAULT encode(gen_random_bytes(32), 'hex')
  `);

  // 3. Forward-fill TZ-correct expiry via BEFORE-INSERT trigger. See
  // header docstring for why trigger and not GENERATED column.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION set_default_track_token_expiry()
    RETURNS trigger AS $$
    BEGIN
      IF NEW.track_token_expires_at IS NULL AND NEW.scheduled_date IS NOT NULL THEN
        NEW.track_token_expires_at :=
          ((NEW.scheduled_date::timestamp + COALESCE(NEW.window_end, TIME '23:59:59'))
           AT TIME ZONE 'America/New_York')
          + INTERVAL '1 day';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);

  await knex.raw(
    'DROP TRIGGER IF EXISTS scheduled_services_default_track_token_expiry ON scheduled_services'
  );
  await knex.raw(`
    CREATE TRIGGER scheduled_services_default_track_token_expiry
      BEFORE INSERT ON scheduled_services
      FOR EACH ROW EXECUTE FUNCTION set_default_track_token_expiry()
  `);
};

exports.down = async function down(knex) {
  // Reverse the schema additions cleanly. Mopup row updates are not
  // undone; the backfilled tokens are safe to keep regardless of
  // whether this migration is applied.
  await knex.raw(
    'DROP TRIGGER IF EXISTS scheduled_services_default_track_token_expiry ON scheduled_services'
  );
  await knex.raw('DROP FUNCTION IF EXISTS set_default_track_token_expiry()');
  await knex.raw(`
    ALTER TABLE scheduled_services
      ALTER COLUMN track_view_token DROP DEFAULT
  `);
};
