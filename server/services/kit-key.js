// A kit key names WHAT a tool is (moisture_meter, bg_sprayer), independent of
// the equipment row's name, so a service type's required tools (checklist items
// carrying the same key) match what a truck carries
// (docs/tool-inventory-tracker-scope.md, PR 2). Shared by the Assets dialog's
// writer (routes/admin-equipment.js) and the truck kit (services/truck-kit.js)
// so the two can never disagree on what a key looks like.
const KIT_KEY_RE = /^[a-z][a-z0-9_]{1,59}$/;

// Lowercase snake_case; blank is null. "Moisture Meter" and "moisture-meter"
// both become moisture_meter.
function normalizeKitKey(value) {
  if (value == null) return null;
  const key = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  return key || null;
}

const isValidKitKey = (key) => KIT_KEY_RE.test(String(key || ''));

module.exports = { KIT_KEY_RE, normalizeKitKey, isValidKitKey };
