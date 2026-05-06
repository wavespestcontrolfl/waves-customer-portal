/**
 * Keep customer tracking-token expiry aligned with schedule edits.
 *
 * 20260429000002 added an INSERT trigger for track_token_expires_at but
 * intentionally called out that UPDATE paths changing scheduled_date would
 * not recompute expiry. Public /track/:token and socket auth enforce this
 * timestamp, so admin reschedules could leave a valid future visit behind an
 * expired public token. Replace the trigger with one that also runs when the
 * date or window end changes.
 */

exports.up = async function up(knex) {
  await knex.raw(`
    CREATE OR REPLACE FUNCTION set_default_track_token_expiry()
    RETURNS trigger AS $$
    BEGIN
      IF NEW.scheduled_date IS NOT NULL THEN
        IF TG_OP = 'INSERT' AND NEW.track_token_expires_at IS NULL THEN
          NEW.track_token_expires_at :=
            ((NEW.scheduled_date + COALESCE(NEW.window_end, TIME '23:59:59'))
             AT TIME ZONE 'America/New_York')
            + INTERVAL '1 day';
        ELSIF TG_OP = 'UPDATE'
              AND NEW.track_state IN ('scheduled', 'en_route', 'on_property')
              AND (
                NEW.scheduled_date IS DISTINCT FROM OLD.scheduled_date
                OR NEW.window_end IS DISTINCT FROM OLD.window_end
              ) THEN
          NEW.track_token_expires_at :=
            ((NEW.scheduled_date + COALESCE(NEW.window_end, TIME '23:59:59'))
             AT TIME ZONE 'America/New_York')
            + INTERVAL '1 day';
        END IF;
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
      BEFORE INSERT OR UPDATE OF scheduled_date, window_end ON scheduled_services
      FOR EACH ROW EXECUTE FUNCTION set_default_track_token_expiry()
  `);

  await knex.raw(`
    UPDATE scheduled_services
       SET track_token_expires_at =
             ((scheduled_date + COALESCE(window_end, TIME '23:59:59'))
              AT TIME ZONE 'America/New_York')
             + INTERVAL '1 day'
     WHERE track_view_token IS NOT NULL
       AND scheduled_date >= (NOW() AT TIME ZONE 'America/New_York')::date
       AND track_state IN ('scheduled', 'en_route', 'on_property')
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    CREATE OR REPLACE FUNCTION set_default_track_token_expiry()
    RETURNS trigger AS $$
    BEGIN
      IF NEW.track_token_expires_at IS NULL AND NEW.scheduled_date IS NOT NULL THEN
        NEW.track_token_expires_at :=
          ((NEW.scheduled_date + COALESCE(NEW.window_end, TIME '23:59:59'))
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
