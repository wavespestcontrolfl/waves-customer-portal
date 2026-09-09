const TRACK_TOKEN_EXPIRY_SQL =
  "((?::date + COALESCE(?::time, TIME '23:59:59')) AT TIME ZONE 'America/New_York') + INTERVAL '1 day'";

function scheduledServiceTrackTokenExpiry(knex, scheduledDate, windowEnd) {
  if (!knex || typeof knex.raw !== 'function') {
    throw new Error('scheduledServiceTrackTokenExpiry requires a knex instance');
  }
  return knex.raw(TRACK_TOKEN_EXPIRY_SQL, [scheduledDate, windowEnd || null]);
}

function isTrackTokenLive(expiresAt) {
  if (!expiresAt) return true;
  const expiresMs = new Date(expiresAt).getTime();
  return Number.isFinite(expiresMs) && expiresMs >= Date.now();
}

module.exports = {
  isTrackTokenLive,
  TRACK_TOKEN_EXPIRY_SQL,
  scheduledServiceTrackTokenExpiry,
};
