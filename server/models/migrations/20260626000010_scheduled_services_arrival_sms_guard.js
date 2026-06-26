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
 *
 * Rollout backfill: the column lands NULL for every existing row, including
 * jobs that are ALREADY on-property when this deploys (the feature is dark
 * behind GATE_TECH_ARRIVED_SMS at deploy). Once the gate is flipped on, an
 * idempotent markOnProperty() for one of those already-arrived jobs (a
 * same-job geofence repeat or a manual on-site retap) hits the
 * already-on_property branch, reads the NULL guard as a never-sent/failed
 * retry, and fires a STALE "has arrived" text for an arrival that happened
 * before the feature existed. Stamp the guard for rows that have already
 * arrived so only genuinely-new arrivals can send. arrived_at is the
 * canonical arrival timestamp, so use it as the stamp (now() fallback for any
 * on_property row missing it). Bounded by `arrival_sms_sent_at IS NULL`, so
 * it's a no-op on re-run.
 */
exports.up = async function up(knex) {
  await knex.raw(
    'ALTER TABLE scheduled_services ADD COLUMN IF NOT EXISTS arrival_sms_sent_at timestamptz'
  );
  await knex.raw(`
    UPDATE scheduled_services
       SET arrival_sms_sent_at = COALESCE(arrived_at, now())
     WHERE arrival_sms_sent_at IS NULL
       AND (track_state = 'on_property' OR arrived_at IS NOT NULL)
  `);
};

exports.down = async function down(knex) {
  await knex.raw(
    'ALTER TABLE scheduled_services DROP COLUMN IF EXISTS arrival_sms_sent_at'
  );
};
