// customers.service_preferences is a jsonb blob that two customer-facing
// writers rebuild wholesale (PUT /api/service-preferences, estimate accept).
// These keys are written only by the server (call pipeline / recipient opt-in,
// #5467) and must survive those rebuilds: booking-confirmation replay
// obligations, applied caller demotions, and the per-phone consent boundary.
const SERVER_OWNED_PREF_KEYS = [
  'demote_primary_on_optin',
  'demote_primary_applied',
  'consent_covered_phone_keys',
  'unconsented_slot_phone_keys',
];

// `next` with every server-owned key carried over from `raw` (the stored blob).
function withServerOwnedPrefs(raw, next) {
  const out = { ...next };
  if (!raw || typeof raw !== 'object') return out;
  for (const key of SERVER_OWNED_PREF_KEYS) {
    if (raw[key] !== undefined) out[key] = raw[key];
  }
  return out;
}

module.exports = { SERVER_OWNED_PREF_KEYS, withServerOwnedPrefs };
