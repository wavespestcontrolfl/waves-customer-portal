const TRACK_TOKEN_EXPIRY_SQL =
  "((?::date + COALESCE(?::time, TIME '23:59:59')) AT TIME ZONE 'America/New_York') + INTERVAL '1 day'";

function scheduledServiceTrackTokenExpiry(knex, scheduledDate, windowEnd) {
  if (!knex || typeof knex.raw !== 'function') {
    throw new Error('scheduledServiceTrackTokenExpiry requires a knex instance');
  }
  return knex.raw(TRACK_TOKEN_EXPIRY_SQL, [scheduledDate, windowEnd || null]);
}

module.exports = {
  TRACK_TOKEN_EXPIRY_SQL,
  scheduledServiceTrackTokenExpiry,
};
