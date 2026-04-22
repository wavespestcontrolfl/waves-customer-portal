/**
 * Public tracking — Phase 1 schema on scheduled_services.
 *
 * Adds the columns the spec (/track/:token) needs: public token, five-state
 * lifecycle, per-transition timestamps, SMS idempotency flags, token expiry.
 *
 * Deliberate deviations from the literal spec:
 *   - No scheduled_window_start / scheduled_window_end columns. The table
 *     already carries scheduled_date (date) + window_start / window_end
 *     (time) and the appointment-reminders cron composes the full window
 *     from them. Two sources of truth would drift. API composes on read.
 *   - track_state expressed as a CHECK constraint rather than a Knex enu()
 *     so future states (e.g. 'rescheduled_visible') can be added without
 *     ALTER TYPE pain on PostgreSQL.
 *   - Backfills track_view_token for existing non-terminal rows so links
 *     already in SMS threads / calendar invites keep working.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('scheduled_services', (t) => {
    t.string('track_view_token', 64).unique();
    t.string('track_state', 16).notNullable().defaultTo('scheduled');
    t.timestamp('en_route_at');
    t.timestamp('arrived_at');
    t.timestamp('track_completed_at');
    t.timestamp('track_cancelled_at');
    t.text('track_cancellation_reason');
    t.timestamp('track_sms_sent_at');
    t.timestamp('late_sms_sent_at');
    t.timestamp('track_token_expires_at');
  });

  // Note: the service-level `status` column is a separate concept (the
  // dispatch-level outcome: pending/confirmed/rescheduled/cancelled/
  // completed, plus no_show via PR #36). track_state is the
  // customer-visible state machine. Keeping them distinct is intentional.
  await knex.raw(
    "ALTER TABLE scheduled_services ADD CONSTRAINT scheduled_services_track_state_check " +
    "CHECK (track_state IN ('scheduled','en_route','on_property','complete','cancelled'))"
  );

  await knex.raw(
    'CREATE INDEX idx_scheduled_services_track_state_window ' +
    'ON scheduled_services (track_state, scheduled_date, window_start)'
  );

  // Backfill tokens for any active upcoming service without one, so existing
  // rows get a working /track/:token link.
  await knex.raw(`
    UPDATE scheduled_services
    SET track_view_token = encode(gen_random_bytes(32), 'hex')
    WHERE track_view_token IS NULL
      AND status NOT IN ('cancelled', 'completed')
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_scheduled_services_track_state_window');
  await knex.raw('ALTER TABLE scheduled_services DROP CONSTRAINT IF EXISTS scheduled_services_track_state_check');
  await knex.schema.alterTable('scheduled_services', (t) => {
    t.dropColumn('track_view_token');
    t.dropColumn('track_state');
    t.dropColumn('en_route_at');
    t.dropColumn('arrived_at');
    t.dropColumn('track_completed_at');
    t.dropColumn('track_cancelled_at');
    t.dropColumn('track_cancellation_reason');
    t.dropColumn('track_sms_sent_at');
    t.dropColumn('late_sms_sent_at');
    t.dropColumn('track_token_expires_at');
  });
};
