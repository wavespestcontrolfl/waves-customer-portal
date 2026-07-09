/**
 * Re-assert the flat 60-minute default duration across the service library.
 *
 * Owner directive (2026-07-03): every service call defaults to 60 minutes
 * unless a tech changes it on the appointment. The 2026-04-15 reset
 * (20260415000012) already set default_duration_minutes = 60 for every
 * service, but rows inserted by later migrations came in at 45/90/120, so
 * admin bookings and estimate-converter combined rewrites picked those up.
 *
 * Exception (same directive): WaveGuard membership is a billing construct,
 * not a visit — its duration is 0. (Booking code treats 0 as unset and still
 * falls back to 60 if a membership row is ever booked as an appointment.)
 */
exports.up = async function (knex) {
  await knex('services')
    .whereNot({ service_key: 'waveguard_membership' })
    .where((qb) => qb.whereNot({ default_duration_minutes: 60 }).orWhereNull('default_duration_minutes'))
    .update({
      default_duration_minutes: 60,
      updated_at: knex.fn.now(),
    });

  await knex('services')
    .where({ service_key: 'waveguard_membership' })
    .update({
      default_duration_minutes: 0,
      updated_at: knex.fn.now(),
    });
};

exports.down = async function () {
  // No-op — original per-service values are not preserved.
};
