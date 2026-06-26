/**
 * Arrival-SMS idempotency guard on scheduled_services.
 *
 * Mirrors track_sms_sent_at (the en-route guard from
 * 20260422000009_scheduled_services_tracking.js). track-transitions
 * markOnProperty() is the sole owner of the customer arrival SMS fire;
 * this column lets it stay idempotent across the two webhook paths that
 * both converge on markOnProperty (geofence userGeozone + gps-arrival
 * detector) and across manual retaps. NULL = arrival SMS not yet sent.
 *
 * IF NOT EXISTS so a partially-applied prior run can't re-collide.
 */
exports.up = async function up(knex) {
  await knex.raw(
    'ALTER TABLE scheduled_services ADD COLUMN IF NOT EXISTS arrival_sms_sent_at timestamptz'
  );
};

exports.down = async function down(knex) {
  await knex.raw(
    'ALTER TABLE scheduled_services DROP COLUMN IF EXISTS arrival_sms_sent_at'
  );
};
