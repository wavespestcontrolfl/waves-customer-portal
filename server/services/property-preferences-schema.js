'use strict';

/**
 * Shared field schemas + validation for `property_preferences`, used by
 * BOTH the customer portal writer (server/routes/property.js) and the
 * admin writer (PUT /api/admin/customers/:id/property-preferences in
 * server/routes/admin-customers.js). Single source of truth so the two
 * routes can never drift on what a field accepts — extracted unchanged
 * from property.js (2026-09-27), which keeps its own re-exports under
 * `_private` for its existing test coverage.
 *
 * Callers own: authentication, which fields are additionally allowed
 * (e.g. the admin route's staff-only chemical-sensitivity fields), any
 * customer-facing notification, and the actual DB transaction/locking.
 */

const Joi = require('joi');
const { hasLawnServiceEvidence, hasIrrigationEmailOptIn } = require('./irrigation-weekly-email');

// Default free-text cap for fields with no real column-width constraint
// (the DB-enforced enum columns — preferredDay/preferredTime/
// contactPreference — validate on VALUE, not length, so 200 is just an
// app-level sanity cap for them, not a column width).
const shortText = Joi.string().trim().allow('', null).max(200);
// Column-width-matched short text (codex P2): several PREFS_FIELD_SCHEMAS
// entries used the generic 200-char `shortText` even though their real
// `property_preferences` column is a narrower varchar (access codes are
// varchar(100), hoa_phone varchar(30), …) — a value between the column
// width and 200 chars validated fine here and then 500'd on the INSERT/
// UPDATE as a Postgres 22001 "value too long" error instead of a clean
// field-level rejection. Every column width below is read directly off
// the migrations that created it (see the comment on each field).
function shortTextMax(max) {
  return Joi.string().trim().allow('', null).max(max);
}
const longText = Joi.string().trim().allow('', null).max(2000);
function enumOrNull(values) {
  return Joi.string().trim().valid(...values).allow(null).empty('').default(null);
}
// Date-or-clear (codex P1): blackoutStart/blackoutEnd are real Postgres
// `date` columns. `.allow(null, '')` alone still passes '' straight
// through as the literal string '' (Joi's allow-list bypasses the type
// check entirely for an exact match), and Postgres 22007s on an empty
// string bound to a date column — belt-and-braces here even though the
// client is now fixed to send null, never '', to clear the field.
// `.empty('')` treats '' as "not provided" pre-validation, and
// `.default(null)` then supplies null for that now-absent value.
function dateOrNull() {
  return Joi.date().iso().allow(null).empty('').default(null);
}
const petSchema = Joi.object({
  name: Joi.string().trim().allow('', null).max(60),
  species: Joi.string().trim().allow('', null).max(40),
  breed: Joi.string().trim().allow('', null).max(60),
  friendly: Joi.boolean(),
  secured: Joi.boolean(),
  notes: Joi.string().trim().allow('', null).max(300),
}).unknown(true);

const PREFS_FIELD_SCHEMAS = {
  // Access codes: 20260401000005_property_preferences.js — varchar(100).
  neighborhoodGateCode: shortTextMax(100),
  propertyGateCode: shortTextMax(100),
  garageCode: shortTextMax(100),
  lockboxCode: shortTextMax(100),
  parkingNotes: longText,
  // 20260401000084_property_prefs_expanded.js — varchar(200).
  sideGateAccess: shortTextMax(200),
  petCount: Joi.number().integer().min(0).max(20),
  petDetails: longText,
  petsSecuredPlan: longText,
  petsStructured: Joi.array().items(petSchema).max(20),
  // Postgres ENUM columns (20260401000005_property_preferences.js) —
  // validated on VALUE so an off-list value is a per-field rejection, not
  // a database error that rolls back the whole save. '' clears to null.
  preferredDay: enumOrNull(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'no_preference']),
  preferredTime: enumOrNull(['early_morning', 'morning', 'midday', 'afternoon', 'no_preference']),
  contactPreference: enumOrNull(['call', 'text', 'email']),
  blackoutStart: dateOrNull(),
  blackoutEnd: dateOrNull(),
  // 20260401000005_property_preferences.js — varchar(200).
  irrigationControllerLocation: shortTextMax(200),
  irrigationZones: Joi.number().integer().min(0).max(100).allow(null),
  irrigationInchesPerWeek: Joi.number().min(0).max(5).precision(2).allow(null),
  // Minutes each zone runs on a watering day — the natural-unit schedule
  // @waves/irrigation-runtime converts to inches (× days × head type).
  // 1–240 with null-to-clear: the runtime treats <= 0 as missing, so a
  // persisted 0 would show in the portal while the email claims no minutes
  // are on file. Zero is not a schedule — clearing is.
  irrigationRunMinutes: Joi.number().integer().min(1).max(240).allow(null),
  irrigationScheduleNotes: longText,
  // Same seven keys the pills emit — mirrors mowingDays below. A length-only
  // check would persist "Monday" with a 200, and @waves/irrigation-runtime
  // normalizes against the canonical keys, so the day would silently vanish
  // from the derivation and the email would claim the days are missing.
  wateringDays: Joi.array().items(Joi.string().valid('Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun')).unique().max(7),
  // Customers can have multiple sprinkler types on one property. Accept an
  // array (current client) or a legacy scalar string for backward compat;
  // the route normalizes to an array before storage. Vocabulary is the three
  // types the portal pills emit and @waves/irrigation-runtime has rates or
  // rules for — an unknown type would persist fine and then derail the
  // derivation into unknown_head_type copy. Legacy rows keep whatever they
  // hold; only new writes are restricted.
  irrigationSystemType: Joi.alternatives().try(
    Joi.array().items(Joi.string().valid('spray', 'drip', 'rotor')).unique().max(3),
    Joi.string().valid('spray', 'drip', 'rotor', '')
  ).allow(null),
  rainSensor: Joi.boolean(),
  irrigationIssues: longText,
  // Same seven keys the pills emit. A length-only check would persist
  // "Monday" with a 200, and both the portal summary and mowingAlertText
  // filter against the canonical keys — so the day would silently vanish
  // from the customer's view AND the technician's alert.
  mowingDays: Joi.array()
    .items(Joi.string().valid('Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'))
    .unique()
    .max(7),
  // Controlled vocabulary, not free text: the column is varchar(30), so a
  // longer value would turn a client mistake into a Postgres 22001 → 500.
  // The four keys mirror the portal's Typical Time pills.
  mowingTimeOfDay: Joi.string().trim().valid('', 'morning', 'midday', 'afternoon', 'varies').allow(null),
  mowingNotes: longText,
  // HOA varchar widths: 20260401000005_property_preferences.js (hoa_name)
  // and 20260401000084_property_prefs_expanded.js (the rest).
  hoaName: shortTextMax(150),
  hoaRestrictions: longText,
  hoaCompany: shortTextMax(200),
  hoaPhone: shortTextMax(30),
  // hoa_email is varchar(100) — .email() alone allows up to 254 (RFC 5321),
  // which validated fine here and then 500'd as a Postgres 22001 on save.
  hoaEmail: Joi.string().trim().allow('', null).email().max(100),
  hoaLawnHeight: shortTextMax(100),
  hoaSignageRules: longText,
  hoaTimingRestrictions: longText,
  hoaInspectionPeriod: shortTextMax(100),
  accessNotes: longText,
  specialInstructions: longText,
};

const ALLOWED_FIELDS = [
  'neighborhood_gate_code', 'property_gate_code', 'garage_code', 'lockbox_code',
  'parking_notes', 'side_gate_access',
  'pet_count', 'pet_details', 'pets_secured_plan', 'pets_structured',
  'preferred_day', 'preferred_time', 'contact_preference',
  'blackout_start', 'blackout_end',
  'irrigation_system', 'irrigation_controller_location', 'irrigation_zones',
  'irrigation_inches_per_week', 'irrigation_run_minutes', 'irrigation_schedule_notes', 'watering_days', 'irrigation_system_type',
  'rain_sensor', 'irrigation_issues',
  'mowing_days', 'mowing_time_of_day', 'mowing_notes',
  'hoa_name', 'hoa_restrictions', 'hoa_company', 'hoa_phone', 'hoa_email',
  'hoa_lawn_height', 'hoa_signage_rules', 'hoa_timing_restrictions',
  'hoa_inspection_period',
  'access_notes', 'special_instructions',
];

// JSON (jsonb) columns that must be stringified before a knex insert/update
// when the caller hands them a JS array (node-pg's jsonb text protocol
// wants JSON text, not an object) — and that come back already parsed on
// read, since node-pg parses jsonb columns for us.
const JSON_FIELDS = ['watering_days', 'pets_structured', 'irrigation_system_type', 'mowing_days'];

// Validates each field in the body INDEPENDENTLY so one permanently-invalid
// field (e.g. a badly typed HOA email) can never reject every OTHER valid
// field in the same batch — the 2026-09-11 prod incident: a half-typed
// hoaEmail 400'd 8 consecutive portal autosaves while everything else the
// customer typed was silently discarded. Returns the coerced value for every
// field that validated, plus a `rejected` list of { field, message } for
// every field present in the body that did not — same message text the
// combined-schema validator produced (label(key) reproduces the "<key> ..."
// phrasing). Unknown keys are silently dropped, not reported as rejected.
//
// `schemas` is a plain { camelCaseField: JoiSchema } map — the portal route
// passes PREFS_FIELD_SCHEMAS as-is; the admin route passes it merged with
// its own staff-only additions, so both share this one implementation
// without the admin route being able to widen what the PORTAL accepts.
function validatePrefsBody(schemas, body) {
  const source = body && typeof body === 'object' ? body : {};
  const value = {};
  const rejected = [];
  let presentCount = 0;
  for (const [key, raw] of Object.entries(source)) {
    // OWN keys only (codex r1 P2): `constructor` / `toString` / `__proto__`
    // in the JSON body would otherwise resolve to an inherited
    // Object.prototype member, and calling .label() on it throws a 500
    // instead of stripping the unknown key.
    const fieldSchema = Object.prototype.hasOwnProperty.call(schemas, key)
      ? schemas[key]
      : null;
    if (!fieldSchema) continue; // unknown field — stripped, not reported
    presentCount += 1;
    const { value: fieldValue, error: fieldError } = fieldSchema.label(key).validate(raw);
    if (fieldError) {
      rejected.push({ field: key, message: fieldError.message });
    } else {
      value[key] = fieldValue;
    }
  }
  return { value, rejected, presentCount };
}

function camelToSnake(str) {
  return str.replace(/[A-Z]/g, l => `_${l.toLowerCase()}`);
}

function snakeToCamel(str) {
  return str.replace(/_([a-z])/g, (_, l) => l.toUpperCase());
}

function transformKeys(obj, fn) {
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    result[fn(k)] = v;
  }
  return result;
}

function customerHasLawnCare(customer = {}) {
  const tier = String(customer.waveguard_tier || customer.tier || '').trim();
  return ['Silver', 'Gold', 'Platinum'].includes(tier) || !!String(customer.lawn_type || '').trim();
}

// Weekly Inches eligibility. The tier / lawn_type shortcut misses standalone
// lawn-plan customers with no turf type on file, so fall back to live
// lawn-service evidence (any live lawn-flavored visit in the trailing window
// — see hasLawnServiceEvidence). Used by every writer of
// irrigation_inches_per_week so the field can never render (portal GET) or
// be silently written (any PUT) for a customer who wouldn't otherwise see
// it. THROWS on a lookup failure — the caller decides whether to fail soft
// (a GET/render) or fail the write (a false here would delete the
// customer's inches with a 200 — GH codex P2 on #3557).
async function customerQualifiesForLawnInches(customer = {}) {
  if (customerHasLawnCare(customer)) return true;
  if (await hasLawnServiceEvidence(customer.id)) return true;
  // Opted into the Monday irrigation email without lawn service (owner
  // 2026-09-28): that email asks for their schedule and links the plan here.
  return hasIrrigationEmailOptIn(customer.id);
}

// Normalizes a snake_case `updates` object (already filtered to an allowed-
// fields list) for storage: irrigation_system_type coerced to an array
// (accepts a legacy scalar), and every JSON_FIELDS value stringified
// so knex sends JSON text rather than a bound object. Mutates and returns
// the same object; order matters (type coercion before stringification).
function normalizeUpdatesForStorage(updates) {
  if ('irrigation_system_type' in updates) {
    const v = updates.irrigation_system_type;
    updates.irrigation_system_type = Array.isArray(v) ? v : (v ? [v] : []);
  }
  for (const jf of JSON_FIELDS) {
    if (jf in updates && typeof updates[jf] !== 'string') {
      updates[jf] = JSON.stringify(updates[jf]);
    }
  }
  return updates;
}

module.exports = {
  shortText,
  shortTextMax,
  longText,
  dateOrNull,
  petSchema,
  PREFS_FIELD_SCHEMAS,
  ALLOWED_FIELDS,
  JSON_FIELDS,
  validatePrefsBody,
  camelToSnake,
  snakeToCamel,
  transformKeys,
  customerHasLawnCare,
  customerQualifiesForLawnInches,
  normalizeUpdatesForStorage,
};
