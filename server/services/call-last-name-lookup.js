'use strict';

/**
 * Last-name fill for a phone caller who gave only a first name (owner ruling
 * 2026-10-08).
 *
 * Why: a caller who books with a first name and no surname leaves a customer
 * row with an empty last_name and a missing_last_name card for the office.
 * The surname is often one lookup away, so the call pipeline looks it up and
 * saves it. This only FILLS an empty last_name: an existing last name, the
 * first name, phone, email and account link are never touched.
 *
 * Eligibility (every fact re-read from the DB inside the run): the call is
 * linked to the customer; the customer is live, has a first name and a blank
 * last name; the caller IS the customer (the call's contact phone and
 * customers.phone share one phone identity key); the V2 extraction is valid
 * and the caller gave no last name in it.
 *
 * Sources, in order; the first that yields exactly ONE surname wins:
 *   1. County owner record, ONLY when the V2 relationship is owner (or the
 *      enum's unknown): the customer's coordinates -> parcel -> owner names;
 *      the caller's first name must match an owner's first name.
 *   2. Our own records: another live customer or lead with the same email or
 *      phone, the same first name and a last name.
 *   3. The caller's email: first.last@, first_last@, first-last@ only.
 * A realtor, tenant, buyer, family member or any other non-owner never gets
 * the county owner's name.
 *
 * Inert unless GATE_CALL_LAST_NAME_LOOKUP is on (callLastNameLookupLive).
 * Fire-and-forget: the call pipeline never waits on it and a failure here
 * never touches call processing. Logs carry ids and outcome codes only —
 * never a name, phone, email or address (AGENTS.md PII rule).
 */

const db = require('../models/db');
const logger = require('./logger');
const { callLastNameLookupLive } = require('../config/feature-gates');
const { lookupCountyParcelByPoint } = require('./property-lookup/county-parcel-gis');
const { appendWithProvenance } = require('./call-profile-enrichment');
const { nanpStoredPhoneClause } = require('./outbound-call-reason');
const { phoneIdentityKey } = require('../utils/phone');
const { etDateString } = require('../utils/datetime-et');
const { sameFirstName, normalizeNamePart } = require('../utils/name-match');
const { surnameFromOwnerNames } = require('../utils/owner-name-parse');
const { surnameFromEmail } = require('../utils/email-surname-parse');

const LOG_PREFIX = '[call-last-name-lookup]';
// The V2 relationship values that may read the county owner record: the
// caller says they own the home, or the extraction could not tell.
const COUNTY_RELATIONSHIPS = new Set(['owner', 'unknown']);
const COUNTY_LOOKUP_TIMEOUT_MS = 8000;
const NOTE_BY_SOURCE = {
  county: 'Last name added by the call agent from the county owner record.',
  records: 'Last name added by the call agent from another record with the same email or phone.',
  email: 'Last name added by the call agent from the caller\'s email address.',
};

const errId = (err) => err?.code || err?.name || 'error';
const blank = (v) => String(v ?? '').trim() === '';

function parseJson(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

// The number the customer is reached on: the dialed line on an outbound call,
// the caller's line on an inbound one.
function callContactPhoneKey(call) {
  const outbound = String(call.direction || '').toLowerCase().startsWith('outbound');
  return phoneIdentityKey(outbound ? call.to_phone : call.from_phone);
}

function leadingHouseNumber(address) {
  return (String(address || '').trim().match(/^(\d+)/) || [])[1] || null;
}

// Every eligibility fact, read fresh. Returns { customer, caller } or a skip code.
async function loadEligible({ callLogId, customerId }) {
  const call = await db('call_log').where({ id: callLogId })
    .first('id', 'customer_id', 'direction', 'from_phone', 'to_phone', 'created_at', 'v2_extraction_status', 'ai_extraction_enriched');
  if (!call || String(call.customer_id) !== String(customerId)) return { skip: 'call_not_linked' };
  const customer = await db('customers').where({ id: customerId }).whereNull('deleted_at')
    .first('id', 'first_name', 'last_name', 'phone', 'email', 'latitude', 'longitude', 'address_line1');
  if (!customer) return { skip: 'customer_gone' };
  if (!blank(customer.last_name)) return { skip: 'has_last_name' };
  if (blank(customer.first_name)) return { skip: 'no_first_name' };
  const callerKey = callContactPhoneKey(call);
  if (!callerKey || callerKey !== phoneIdentityKey(customer.phone || '')) return { skip: 'caller_not_customer' };
  const extraction = call.v2_extraction_status === 'valid' ? parseJson(call.ai_extraction_enriched) : null;
  if (!extraction) return { skip: 'no_valid_extraction' };
  if (!blank(extraction.caller?.last_name)) return { skip: 'caller_gave_last_name' };
  return {
    customer,
    callDay: etDateString(new Date(call.created_at || Date.now())),
    relationship: String(extraction.caller?.relationship_to_property || '').toLowerCase(),
  };
}

async function surnameFromCounty({ customer, relationship }) {
  if (!COUNTY_RELATIONSHIPS.has(relationship)) return { skip: 'not_owner' };
  const lat = Number(customer.latitude);
  const lng = Number(customer.longitude);
  if (customer.latitude == null || customer.longitude == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return { skip: 'no_coordinates' };
  const parcel = await lookupCountyParcelByPoint(lat, lng, { includeOwners: true, timeoutMs: COUNTY_LOOKUP_TIMEOUT_MS });
  if (!parcel?.ownerNames?.length) return { skip: 'no_owner_names' };
  // The coordinates may sit on a neighbour's lot: the parcel's house number
  // must be the customer's own.
  const parcelNumber = leadingHouseNumber(parcel.situsAddress);
  if (!parcelNumber || parcelNumber !== leadingHouseNumber(customer.address_line1)) return { skip: 'parcel_address_mismatch' };
  const surname = surnameFromOwnerNames(parcel.ownerNames, customer.first_name, parcel.county);
  return surname ? { surname } : { skip: 'no_single_owner_match' };
}

function cleanSurname(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text && /^[\p{L}][\p{L}' -]*$/u.test(text) ? text : null;
}

// Another live customer or lead on the same email or phone with the same
// first name and a last name; exactly one distinct surname or nothing.
async function surnameFromRecords({ customer }) {
  const email = String(customer.email || '').trim().toLowerCase();
  const phoneKey = phoneIdentityKey(customer.phone || '');
  const nanpKey = /^\d{10}$/.test(phoneKey || '') ? phoneKey : null;
  if (!email && !nanpKey) return { skip: 'no_identifier' };
  const sameContact = (q) => {
    if (email) q.whereRaw('LOWER(TRIM(email)) = ?', [email]);
    if (nanpKey) q.orWhereRaw(nanpStoredPhoneClause('phone'), [nanpKey]);
  };
  const baseColumns = ['first_name', 'last_name'];
  const customers = await db('customers').whereNot({ id: customer.id }).whereNull('deleted_at')
    .whereRaw("TRIM(COALESCE(last_name, '')) <> ''").where(sameContact).select(baseColumns);
  const leads = await db('leads').whereNull('deleted_at')
    .whereRaw("TRIM(COALESCE(last_name, '')) <> ''").where(sameContact).select(baseColumns);
  const wanted = normalizeNamePart(customer.first_name);
  const found = new Map();
  for (const row of [...(customers || []), ...(leads || [])]) {
    const surname = cleanSurname(row.last_name);
    const key = surname?.toLowerCase();
    if (surname && !found.has(key) && sameFirstName(normalizeNamePart(row.first_name), wanted)) found.set(key, surname);
  }
  return found.size === 1 ? { surname: [...found.values()][0] } : { skip: 'no_single_record_match' };
}

async function surnameFromEmailAddress({ customer }) {
  const surname = surnameFromEmail(customer.email, customer.first_name);
  return surname ? { surname } : { skip: 'no_email_pattern' };
}

const SOURCES = [
  ['county', surnameFromCounty],
  ['records', surnameFromRecords],
  ['email', surnameFromEmailAddress],
];

// First source with exactly one surname wins. A source that throws is skipped.
async function findSurname(ctx) {
  const tried = [];
  for (const [source, find] of SOURCES) {
    try {
      const found = await find(ctx);
      if (found.surname) return { source, surname: found.surname };
      tried.push(`${source}:${found.skip}`);
    } catch (err) {
      tried.push(`${source}:${errId(err)}`);
    }
  }
  return { tried };
}

// One transaction: lock the row, re-check it is still blank, fill it.
async function saveLastName({ customer, callDay }, { source, surname }) {
  return db.transaction(async (trx) => {
    const current = await trx('customers').where({ id: customer.id }).whereNull('deleted_at').forUpdate()
      .first('id', 'first_name', 'last_name', 'crm_notes');
    if (!current || !blank(current.last_name) || current.first_name !== customer.first_name) return false;
    await trx('customers').where({ id: customer.id }).update({
      last_name: surname,
      crm_notes: appendWithProvenance(current.crm_notes, NOTE_BY_SOURCE[source], callDay, '\n\n'),
      updated_at: new Date(),
    });
    return true;
  });
}

/**
 * Production entry is enqueueCallLastNameLookup. Never throws.
 * @returns {Promise<{skipped?: string, filled?: boolean, source?: string, outcome?: string}>}
 */
async function runCallLastNameLookup({ callLogId, customerId } = {}) {
  if (!callLastNameLookupLive()) return { skipped: 'gated' };
  if (!callLogId || !customerId) return { skipped: 'missing_ids' };
  try {
    const eligible = await loadEligible({ callLogId, customerId });
    if (eligible.skip) return { skipped: eligible.skip };
    const found = await findSurname(eligible);
    if (!found.surname) {
      logger.info(`${LOG_PREFIX} no surname`, { callLogId, customerId, outcome: found.tried.join(',') });
      return { filled: false, outcome: 'no_surname' };
    }
    const saved = await saveLastName(eligible, found);
    logger.info(`${LOG_PREFIX} ${saved ? 'filled' : 'raced'}`, { callLogId, customerId, source: found.source });
    return saved ? { filled: true, source: found.source } : { filled: false, outcome: 'changed_meanwhile' };
  } catch (err) {
    logger.warn(`${LOG_PREFIX} failed`, { callLogId, customerId, error: errId(err) });
    return { filled: false, outcome: 'error' };
  }
}

// Fire-and-forget from the call pipeline: off the call's own tick, nothing awaited.
function enqueueCallLastNameLookup({ callLogId, customerId } = {}) {
  if (!callLastNameLookupLive() || !callLogId || !customerId) return;
  setImmediate(() => {
    runCallLastNameLookup({ callLogId, customerId }).catch((err) => {
      logger.warn(`${LOG_PREFIX} failed`, { callLogId, customerId, error: errId(err) });
    });
  });
}

module.exports = {
  runCallLastNameLookup,
  enqueueCallLastNameLookup,
  _private: { callContactPhoneKey, leadingHouseNumber, cleanSurname, NOTE_BY_SOURCE },
};
