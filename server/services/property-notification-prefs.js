/**
 * Appointment texts per SAVED PROPERTY (app property scope, PR 3 of 4).
 *
 * The customer's notification_prefs row keeps deciding every appointment text
 * for the PRIMARY property and for unstamped visits — byte-for-byte today's
 * behavior. A visit stamped with a NON-primary saved property resolves its
 * five appointment toggles (+ "send these to me too") from that property:
 * its property_notification_prefs row where a toggle was chosen, else the
 * ruling-R1 default (own_home / family_home / unrecorded inherit the customer
 * row; rental_owned / managed_for_client start OFF). Delivery channels,
 * App-first choices and quiet hours stay on the customer row (#4057).
 *
 * Two gates, read at call time:
 *   GATE_APP_PROPERTY_SCOPE  — off: this module never reads the new table and
 *                              every resolver answers the customer row.
 *   GATE_APP_PROPERTY_TEXTS  — off (ruling R5): shadow mode. The property
 *                              decision is computed and recorded in
 *                              property_text_decisions next to the customer
 *                              decision; the customer decision is what sends.
 *                              on: the property decision is enforced.
 *
 * Failure posture: a property lookup that FAILS (not "no property") answers
 * the customer row in shadow mode (today's behavior, logged) and THROWS under
 * enforcement — a sender must hold rather than text a rental whose toggles it
 * could not read. The shadow-log write is best-effort and never throws.
 */
const db = require('../models/db');
const logger = require('./logger');
const { gateEnvValue } = require('../config/feature-gates');
const { appPropertyScopeEnabled } = require('./account-properties');

const APPOINTMENT_TOGGLES = Object.freeze([
  'appointment_confirmation',
  'service_reminder_72h',
  'service_reminder_24h',
  'tech_en_route',
  'tech_arrived',
]);
const PROPERTY_PREF_COLUMNS = Object.freeze([...APPOINTMENT_TOGGLES, 'appointment_notify_primary']);
// Ruling R1: relationships whose appointment texts start OFF (mirrors the
// 2026-09-06 "rentals default off" ruling for sibling profiles).
const QUIET_RELATIONSHIPS = Object.freeze(['rental_owned', 'managed_for_client']);

function propertyTextsEnforced() {
  return appPropertyScopeEnabled() && gateEnvValue('GATE_APP_PROPERTY_TEXTS');
}

function isQuietRelationship(relationship) {
  return QUIET_RELATIONSHIPS.includes(String(relationship || ''));
}

// The ruling-R1 default for every column, from the CUSTOMER row (a missing
// row = the table defaults, every toggle on).
function defaultPropertyToggles(property, customerPrefs = {}) {
  const quiet = isQuietRelationship(property?.relationship);
  const out = {};
  for (const col of APPOINTMENT_TOGGLES) out[col] = quiet ? false : customerPrefs?.[col] !== false;
  out.appointment_notify_primary = customerPrefs?.appointment_notify_primary !== false;
  return out;
}

// A chosen toggle (non-null on the property row) wins; NULL = the default.
function effectivePropertyToggles(property, row, customerPrefs = {}) {
  const defaults = defaultPropertyToggles(property, customerPrefs);
  const out = {};
  for (const col of PROPERTY_PREF_COLUMNS) {
    out[col] = row && typeof row[col] === 'boolean' ? row[col] : defaults[col];
  }
  return out;
}

// The customer row's answer for the same columns, for the shadow comparison.
function customerToggles(customerPrefs = {}) {
  const out = {};
  for (const col of PROPERTY_PREF_COLUMNS) out[col] = customerPrefs?.[col] !== false;
  return out;
}

// The NON-primary saved property a visit is stamped with, when it belongs to
// this customer and is active. null = unstamped, primary, foreign, retired,
// or no such visit — every one of those keeps the customer row.
async function visitProperty(customerId, scheduledServiceId, knex = db) {
  if (!customerId || !scheduledServiceId) return null;
  const visit = await knex('scheduled_services')
    .where({ id: scheduledServiceId, customer_id: customerId })
    .first('property_id');
  if (!visit || !visit.property_id) return null;
  const property = await knex('customer_properties')
    .where({ id: visit.property_id, customer_id: customerId })
    .first('id', 'customer_id', 'is_primary', 'active', 'relationship', 'label', 'address_line1', 'city');
  if (!property || property.active === false || property.is_primary === true) return null;
  return property;
}

async function propertyPrefsRow(propertyId, knex = db) {
  return knex('property_notification_prefs').where({ property_id: propertyId }).first(...PROPERTY_PREF_COLUMNS);
}

async function recordDecision({ customerId, property, scheduledServiceId, source, customer, effective, enforced }, knex = db) {
  const agreed = PROPERTY_PREF_COLUMNS.every((col) => customer[col] === effective[col]);
  try {
    await knex('property_text_decisions').insert({
      customer_id: customerId,
      property_id: property.id,
      scheduled_service_id: scheduledServiceId || null,
      source: String(source || 'unknown').slice(0, 40),
      relationship: property.relationship || null,
      customer_decisions: JSON.stringify(customer),
      property_decisions: JSON.stringify(effective),
      agreed,
      enforced,
    });
  } catch (err) {
    // Best-effort WRITE: the shadow log must never decide a send.
    logger.warn(`[property-texts] shadow log write failed for property ${property.id}: ${err.message}`);
  }
  return agreed;
}

/**
 * Resolve the appointment toggles that apply to ONE visit.
 *
 * @param {object} args
 * @param {string} args.customerId
 * @param {string|null} args.scheduledServiceId — the visit; null = customer row
 * @param {object|null} args.prefs — the customer's notification_prefs row
 *   (null/undefined = no row: table defaults)
 * @param {string} args.source — the sender seam, for the shadow log
 * @returns {{ prefs: object, property: object|null, propertyDecided: boolean,
 *   propertyToggles: object|null }} `prefs` is the row to READ toggles from:
 *   the customer row (unchanged object) or, under enforcement for a non-
 *   primary saved property, a copy with the six columns overlaid.
 */
async function resolveAppointmentPrefs({ customerId, scheduledServiceId = null, prefs = null, source = 'unknown' }, knex = db) {
  const unchanged = { prefs, property: null, propertyDecided: false, propertyToggles: null };
  if (!appPropertyScopeEnabled() || !scheduledServiceId || !customerId) return unchanged;
  const enforced = propertyTextsEnforced();
  let property;
  let row;
  try {
    property = await visitProperty(customerId, scheduledServiceId, knex);
    if (!property) return unchanged;
    row = await propertyPrefsRow(property.id, knex);
  } catch (err) {
    if (enforced) throw err;
    logger.warn(`[property-texts] property lookup failed for visit ${scheduledServiceId} (shadow mode, customer row kept): ${err.message}`);
    return unchanged;
  }
  const customer = customerToggles(prefs || {});
  const effective = effectivePropertyToggles(property, row, prefs || {});
  await recordDecision({ customerId, property, scheduledServiceId, source, customer, effective, enforced }, knex);
  if (!enforced) return { ...unchanged, property, propertyToggles: effective };
  return { prefs: { ...(prefs || {}), ...effective }, property, propertyDecided: true, propertyToggles: effective };
}

// Convenience for the senders that hold a prefs row and a visit id: the row
// to read toggles from. Same failure posture as resolveAppointmentPrefs.
async function prefsForVisit(prefs, customerId, scheduledServiceId, source, knex = db) {
  const resolved = await resolveAppointmentPrefs({ customerId, scheduledServiceId, prefs, source }, knex);
  return resolved.prefs;
}

module.exports = {
  APPOINTMENT_TOGGLES,
  PROPERTY_PREF_COLUMNS,
  QUIET_RELATIONSHIPS,
  propertyTextsEnforced,
  isQuietRelationship,
  defaultPropertyToggles,
  effectivePropertyToggles,
  customerToggles,
  visitProperty,
  propertyPrefsRow,
  resolveAppointmentPrefs,
  prefsForVisit,
};
