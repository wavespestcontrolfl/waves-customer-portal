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

// A link that needs a REAL expiry: a missing one is refused, where isTrackTokenLive keeps legacy holder links alive.
// The visit text recipient's link (GATE_CALL_GIVEN_VISIT_TEXTS) is issued and served only on this rule.
function isTrackTokenLiveWithExpiry(expiresAt) {
  if (!expiresAt) return false;
  const expiresMs = new Date(expiresAt).getTime();
  return Number.isFinite(expiresMs) && expiresMs >= Date.now();
}

module.exports = {
  isTrackTokenLive,
  isTrackTokenLiveWithExpiry,
  TRACK_TOKEN_EXPIRY_SQL,
  scheduledServiceTrackTokenExpiry,
};
