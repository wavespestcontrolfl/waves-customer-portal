/**
 * The customer's re-service pest chips — one-tap buttons above the /reservice
 * picker's optional details box (owner-approved, GATE_RESERVICE_PEST_CHIPS),
 * plus the normalizer that turns a posted chip selection into the
 * scheduled_services.customer_request_pests column
 * (server/models/migrations/20260927100000_scheduled_services_customer_request.js).
 *
 * Kept intentionally small: this module owns the choice lists and the two
 * pure functions every caller (reservice-public.js, ScheduleFlowPage.jsx via
 * its own copy of the labels, dispatch text) shares.
 */

const RESERVICE_PEST_CHOICES = Object.freeze({
  pest: Object.freeze([
    Object.freeze({ key: 'ants', label: 'Ants' }),
    Object.freeze({ key: 'roaches', label: 'Roaches' }),
    Object.freeze({ key: 'spiders', label: 'Spiders' }),
    Object.freeze({ key: 'wasps', label: 'Wasps' }),
    Object.freeze({ key: 'other', label: 'Something else' }),
  ]),
  lawn: Object.freeze([
    Object.freeze({ key: 'weeds', label: 'Weeds' }),
    Object.freeze({ key: 'lawn_insects', label: 'Bugs in the lawn' }),
    Object.freeze({ key: 'brown_patches', label: 'Brown or dead patches' }),
    Object.freeze({ key: 'other', label: 'Something else' }),
  ]),
});

// De-duplicated, canonical-order, lane-valid pest keys — or null when
// nothing valid survives. Anything that isn't an array of strings (wrong
// type entirely, or a non-string entry) is ignored rather than thrown on;
// the result can never exceed the lane's own choice count.
function normalizeRequestPests(input, lane) {
  const choices = RESERVICE_PEST_CHOICES[lane];
  if (!choices || !Array.isArray(input)) return null;
  const validKeys = new Set(choices.map((c) => c.key));
  const selected = new Set();
  for (const item of input) {
    if (typeof item !== 'string') continue;
    if (!validKeys.has(item)) continue;
    selected.add(item);
    if (selected.size >= choices.length) break;
  }
  if (selected.size === 0) return null;
  return choices.map((c) => c.key).filter((key) => selected.has(key));
}

// Labels for dispatch/customer-notes text, in the same canonical order
// normalizeRequestPests returns. Unknown keys (a lane mismatch, a stale
// client) are silently dropped rather than surfacing as "undefined".
function pestLabels(keys, lane) {
  const choices = RESERVICE_PEST_CHOICES[lane];
  if (!choices || !Array.isArray(keys)) return [];
  const labelByKey = new Map(choices.map((c) => [c.key, c.label]));
  return keys.map((key) => labelByKey.get(key)).filter(Boolean);
}

module.exports = { RESERVICE_PEST_CHOICES, normalizeRequestPests, pestLabels };
