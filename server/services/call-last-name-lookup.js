'use strict';

/**
 * Last-name SUGGESTION for a phone caller who gave only a first name (owner
 * ruling 2026-10-08, reworked after a real-data test).
 *
 * Why: a caller who books with a first name and no surname leaves a customer
 * row with an empty last_name and a missing_last_name card for the office.
 * The surname is often one lookup away, but a real-data test on 300 customers
 * with a known last name showed the county rule disagreeing with the name on
 * file about 4 times in 100 answers (spelling, longer/shorter form, a
 * different surname) — too many to write automatically. So this module NEVER
 * writes customers.last_name: it posts ONE admin notification with what the
 * sources found, and the office saves the name from the customer page.
 *
 * Eligibility (every fact re-read from the DB inside the run): the call is
 * linked to the customer; the customer is live, has a first name and a blank
 * last name; the caller IS the customer (the call's contact phone and
 * customers.phone share one phone identity key); the V2 extraction is valid
 * and the caller gave no last name in it. Right before posting, the last name
 * is checked blank again.
 *
 * Sources — ALL run, each answer is collected, a source that throws or finds
 * nothing contributes nothing:
 *   1. County owner record, ONLY when the V2 relationship is owner (or the
 *      enum's unknown): the customer's coordinates -> parcel -> owner names;
 *      the caller's first name must match an owner's first name.
 *   2. Our own records: another live customer or lead with the same email or
 *      phone, the same first name and a last name.
 *   3. The caller's email: first.last@, first_last@, first-last@ only.
 *   4. Twilio caller name (Lookup v2 caller_name, about 1 cent a lookup, US
 *      numbers only; this path only runs for an already-eligible customer).
 * A realtor, tenant, buyer, family member or any other non-owner never gets
 * the county owner's name.
 *
 * One notification per customer (dedupe key), grouped by surname: several
 * sources agreeing is one suggestion; different surnames are all listed in the
 * full text and none is picked.
 *
 * Inert unless GATE_CALL_LAST_NAME_LOOKUP is on (callLastNameLookupLive).
 * Fire-and-forget: the call pipeline never waits on it and a failure here
 * never touches call processing. Logs carry ids and outcome codes only —
 * never a name, phone, email or address (AGENTS.md PII rule). The
 * notification text may name the customer: it is a staff-only surface.
 */

const db = require('../models/db');
const logger = require('./logger');
const { callLastNameLookupLive } = require('../config/feature-gates');
const { lookupCountyParcelByPoint } = require('./property-lookup/county-parcel-gis');
const { raiseAdminAlert, breaksAlertRules, cutAtWord, MAX_WHY_CHARS } = require('./admin-alert-compose');
const { fitAction } = require('./admin-alert-names');
const { nanpStoredPhoneClause } = require('./outbound-call-reason');
const { phoneIdentityKey, isValidNanpNumber, nanpNationalDigits } = require('../utils/phone');
const { sameFirstName, normalizeNamePart } = require('../utils/name-match');
const { surnameFromOwnerNames } = require('../utils/owner-name-parse');
const { surnameFromEmail } = require('../utils/email-surname-parse');
const { surnameFromCallerName } = require('../utils/caller-name-parse');

const LOG_PREFIX = '[call-last-name-lookup]';
// The V2 relationship values that may read the county owner record: the
// caller says they own the home, or the extraction could not tell.
const COUNTY_RELATIONSHIPS = new Set(['owner', 'unknown']);
const COUNTY_LOOKUP_TIMEOUT_MS = 8000;
const TWILIO_LOOKUP_TIMEOUT_MS = 8000;
const SOURCE_LABELS = {
  county: 'county record',
  records: 'our records',
  email: 'email address',
  twilio: 'Twilio caller name',
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

// Every eligibility fact, read fresh. Returns { customer, relationship } or a skip code.
async function loadEligible({ callLogId, customerId }) {
  const call = await db('call_log').where({ id: callLogId })
    .first('id', 'customer_id', 'direction', 'from_phone', 'to_phone', 'v2_extraction_status', 'ai_extraction_enriched', 'created_at');
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
  // Every source matches on the customer's first name, so the CALLER must be
  // that person: a call where nobody gave a first name, or a household member
  // gave their own, must not look a surname up (or pay for a Twilio lookup).
  const callerFirst = normalizeNamePart(extraction.caller?.first_name);
  if (!callerFirst || !sameFirstName(callerFirst, normalizeNamePart(customer.first_name))) return { skip: 'caller_first_name_differs' };
  return {
    customer,
    callCreatedAt: call.created_at,
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
// Only rows last written BEFORE this call: the call's own pipeline can fill a
// matching lead (or a sibling profile) from the legacy extraction, and reading
// that back would present the call's own unverified surname as a record.
async function surnameFromRecords({ customer, callCreatedAt }) {
  if (!callCreatedAt) return { skip: 'no_call_time' };
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
    .whereRaw("TRIM(COALESCE(last_name, '')) <> ''").where('updated_at', '<', callCreatedAt).where(sameContact).select(baseColumns);
  const leads = await db('leads').whereNull('deleted_at')
    .whereRaw("TRIM(COALESCE(last_name, '')) <> ''").where('updated_at', '<', callCreatedAt).where(sameContact).select(baseColumns);
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

// Twilio Lookup v2 caller_name for the customer's own number. The request URL
// carries the phone number, so nothing here ever logs or returns an error
// message or URL: only outcome codes.
async function surnameFromTwilio({ customer }) {
  if (!isValidNanpNumber(customer.phone)) return { skip: 'not_us_number' };
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return { skip: 'no_credentials' };
  const e164 = `+1${nanpNationalDigits(customer.phone)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TWILIO_LOOKUP_TIMEOUT_MS);
  try {
    const res = await fetch(`https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(e164)}?Fields=caller_name`, {
      headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}` },
      signal: controller.signal,
    });
    if (!res.ok) return { skip: `http_${res.status}` };
    const data = await res.json();
    const surname = surnameFromCallerName(
      { name: data?.caller_name?.caller_name, callerType: data?.caller_name?.caller_type },
      customer.first_name,
    );
    return surname ? { surname } : { skip: 'no_usable_name' };
  } finally {
    clearTimeout(timer);
  }
}

const SOURCES = [
  ['county', surnameFromCounty],
  ['records', surnameFromRecords],
  ['email', surnameFromEmailAddress],
  ['twilio', surnameFromTwilio],
];

// Runs EVERY source. A source that throws, or finds nothing, contributes
// nothing; `tried` holds one outcome code per source for the log.
async function collectAnswers(ctx) {
  const results = await Promise.all(SOURCES.map(async ([source, find]) => {
    try {
      const found = await find(ctx);
      return { source, surname: found.surname || null, code: found.surname ? 'answered' : found.skip };
    } catch (err) {
      return { source, surname: null, code: errId(err) };
    }
  }));
  return {
    answers: results.filter((r) => r.surname),
    tried: results.map((r) => `${r.source}:${r.code}`).join(','),
  };
}

// Answers grouped by surname (case-insensitive), in source order. The first
// spelling seen is the one shown.
function groupBySurname(answers) {
  const groups = new Map();
  for (const { source, surname } of answers) {
    const key = surname.toLowerCase();
    if (!groups.has(key)) groups.set(key, { surname, sources: [] });
    groups.get(key).sources.push(source);
  }
  return [...groups.values()];
}

const labelsOf = (sources) => sources.map((s) => SOURCE_LABELS[s]).join(' + ');

// The one-sentence why (110 characters, docs/admin-notifications.md): the
// longest wording that still fits and breaks no copy rule.
function whyFor(first, groups) {
  const candidates = groups.length === 1
    ? [
      `${first} may be ${first} ${groups[0].surname}, per ${labelsOf(groups[0].sources)}; open the customer to save it.`,
      `${first} may be ${first} ${groups[0].surname}; open the customer to save it.`,
      `${first} may be ${first} ${groups[0].surname}.`,
    ]
    : [`${groups.length} different answers for ${first}; open the full text and the customer.`, 'Different answers; open the full text and the customer.'];
  return candidates.find((c) => c.length <= MAX_WHY_CHARS && !breaksAlertRules(c))
    || cutAtWord(candidates[candidates.length - 1], MAX_WHY_CHARS);
}

function detailFor(first, groups) {
  const lines = groups.map((g) => `${first} ${g.surname}: ${labelsOf(g.sources)}`);
  return groups.length === 1
    ? `${lines[0]}\nOpen the customer to save the last name.`
    : `Different answers for ${first}'s last name (none is picked):\n${lines.join('\n')}\nOpen the customer and save the right one, or none.`;
}

// ONE admin notification per customer. needs-you + bell:true: the explicit
// site-level tag is the first decision in notification-bell-policy.js, so the
// dark-by-default category 'customer' still rings when GATE_ADMIN_BELL_POLICY
// is on. dedupeKey = one per customer, so a reprocess or a later call never
// posts it twice.
async function postSuggestion({ customer, callLogId }, answers) {
  const groups = groupBySurname(answers);
  const first = String(customer.first_name).trim();
  const link = `/admin/customers?customerId=${encodeURIComponent(customer.id)}`;
  return raiseAdminAlert('customer', {
    area: 'Customers',
    action: fitAction('Customers', first, [(n) => `review a last name for ${n}`, (n) => `${n}'s last name`]),
    why: whyFor(first, groups),
    severity: 'needs-you',
    link,
    subject: { type: 'customer', id: String(customer.id) },
    doneWhen: 'last_name_saved',
    who: 'person',
  }, {
    bell: true,
    dedupeKey: `call-last-name-suggestion:${customer.id}`,
    detail: detailFor(first, groups),
    metadata: { customerId: customer.id, callLogId, suggestions: groups.map((g) => ({ surname: g.surname, sources: g.sources })) },
  });
}

/**
 * Production entry is enqueueCallLastNameLookup. Never throws. Never writes
 * customers.
 * @returns {Promise<{skipped?: string, suggested?: boolean, outcome?: string, sources?: string[]}>}
 */
async function runCallLastNameLookup({ callLogId, customerId } = {}) {
  if (!callLastNameLookupLive()) return { skipped: 'gated' };
  if (!callLogId || !customerId) return { skipped: 'missing_ids' };
  try {
    const eligible = await loadEligible({ callLogId, customerId });
    if (eligible.skip) return { skipped: eligible.skip };
    const { answers, tried } = await collectAnswers(eligible);
    if (!answers.length) {
      logger.info(`${LOG_PREFIX} no suggestion`, { callLogId, customerId, outcome: tried });
      return { suggested: false, outcome: 'no_answer' };
    }
    const now = await db('customers').where({ id: customerId }).whereNull('deleted_at').first('id', 'last_name');
    if (!now || !blank(now.last_name)) return { suggested: false, outcome: 'last_name_appeared' };
    const posted = await postSuggestion({ ...eligible, callLogId }, answers);
    const sources = answers.map((a) => a.source);
    const outcome = posted?.id ? 'posted' : 'not_posted';
    logger.info(`${LOG_PREFIX} ${outcome}`, { callLogId, customerId, sources: sources.join(','), outcome: tried });
    return { suggested: outcome === 'posted', outcome, sources };
  } catch (err) {
    logger.warn(`${LOG_PREFIX} failed`, { callLogId, customerId, error: errId(err) });
    return { suggested: false, outcome: 'error' };
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
  _private: { callContactPhoneKey, leadingHouseNumber, cleanSurname, groupBySurname, whyFor },
};
