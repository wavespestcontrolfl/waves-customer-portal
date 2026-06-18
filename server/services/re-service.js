// server/services/re-service.js
//
// Re-service (callback) catalog rows — pest + lawn share ONE concept: a free
// callback visit between regular service intervals for active recurring /
// WaveGuard customers experiencing breakthrough pressure
// (`pest_re_service`, `lawn_re_service`).
//
// Centralised so the two places that must treat these jobs specially agree on
// what "a re-service" is:
//   1. the scheduler auto-flags the scheduled_service as a callback
//      (`is_callback`) — the new-appointment modal never sends the flag, and
//      downstream callback reporting/PDF copy reads the persisted column, not
//      the service name; and
//   2. the completion path suppresses the monthly-dues invoice fallback for
//      callbacks so a "free" re-service never bills a recurring customer's
//      monthly rate.
const RE_SERVICE_SERVICE_KEYS = new Set(['pest_re_service', 'lawn_re_service']);

// Matches the catalog name/type "... Re-Service" as a safety net when the
// service_key isn't available (e.g. free-text service type). Anchored so it
// can't false-positive on unrelated "... Service" names.
const RE_SERVICE_NAME_RE = /\bre-?service\b/i;

function isReService({ serviceKey, serviceName, serviceType } = {}) {
  if (serviceKey && RE_SERVICE_SERVICE_KEYS.has(String(serviceKey))) return true;
  return RE_SERVICE_NAME_RE.test(`${serviceName || ''} ${serviceType || ''}`);
}

module.exports = { RE_SERVICE_SERVICE_KEYS, isReService };
