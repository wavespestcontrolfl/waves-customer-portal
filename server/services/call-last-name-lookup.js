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
const { splitStreetLineUnit } = require('../utils/address-normalizer');

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

// The number the customer is reached on, from the call pipeline's OWN resolver
// (a web-form callback's lead phone, an accepted spoken callback number, the
// dialed or the calling line): no second phone-selection rule lives here.
// Required lazily: the processor requires this module.
function callContactPhoneKey(call) {
  const { resolveCallContactPhone } = require('./call-recording-processor');
  return phoneIdentityKey(resolveCallContactPhone(call, parseJson(call.ai_extraction)?.phone || null) || '');
}

const SUGGESTION_KEY = (customerId) => `call-last-name-suggestion:${customerId}`;

// One suggestion per customer, ever (the notification's dedupe key). When it
// stands, a reprocess or a later call must not pay for the lookups again.
async function alreadySuggested(customerId) {
  const row = await db('notifications').where({ recipient_type: 'admin' })
    .whereRaw("metadata->>'dedupeKey' = ?", [SUGGESTION_KEY(customerId)]).first('id');
  return !!row;
}

// The facts every source matched on. Staff can edit the customer while the
// county and Twilio requests run; answers for the earlier identity or
// property must not be posted on the edited record.
const IDENTITY_COLUMNS = ['first_name', 'phone', 'email', 'address_line1', 'address_line2', 'latitude', 'longitude'];
function sameIdentity(before, now) {
  return IDENTITY_COLUMNS.every((col) => String(before[col] ?? '') === String(now[col] ?? ''));
}

// Every eligibility fact, read fresh. Returns { customer, relationship } or a skip code.
async function loadEligible({ callLogId, customerId }) {
  const call = await db('call_log').where({ id: callLogId })
    .first('id', 'customer_id', 'direction', 'from_phone', 'to_phone', 'source', 'metadata', 'ai_extraction', 'v2_extraction_status', 'ai_extraction_enriched', 'created_at');
  if (!call || String(call.customer_id) !== String(customerId)) return { skip: 'call_not_linked' };
  const customer = await db('customers').where({ id: customerId }).whereNull('deleted_at')
    .first('id', 'first_name', 'last_name', 'phone', 'email', 'latitude', 'longitude', 'address_line1', 'address_line2');
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
  // The coordinates may sit on a neighbour's lot, also one on another street
  // with the same number: the parcel must be the customer's own house on the
  // customer's own street, by the pipeline's street-identity rule (St ==
  // Street, N == North, with or without the suffix). Required lazily, like the
  // processor: that module is large.
  const { sameHouseNumberStreet } = require('./call-triage-flags');
  if (!sameHouseNumberStreet(parcel.situsAddress, customer.address_line1)) return { skip: 'parcel_address_mismatch' };
  // sameHouseNumberStreet ignores units: a separately assessed unit at the
  // same street address is another household. When either side names a unit,
  // both must, and they must be the same one.
  const parcelUnit = unitKey(splitStreetLineUnit(parcel.situsAddress).unit);
  const customerUnit = unitKey(splitStreetLineUnit(customer.address_line1).unit || customer.address_line2);
  if (parcelUnit !== customerUnit) return { skip: 'parcel_unit_mismatch' };
  const surname = surnameFromOwnerNames(parcel.ownerNames, customer.first_name, parcel.county);
  return surname ? { surname } : { skip: 'no_single_owner_match' };
}

// "Apt 4", "#4", "Unit 4" -> "4"; '' when there is none.
function unitKey(value) {
  return String(value || '').toLowerCase().replace(/\b(?:apartment|apt|unit|suite|ste|number|no)\b\.?/g, '').replace(/[^a-z0-9]/g, '');
}

// Stored values that stand in for "no last name": the placeholders
// customer-dedupe.js treats as missing (unknown, n/a, na), the artifacts
// estimate-contact-gaps.js names (customer, undefined, null), and the other
// fillers a form or an import leaves. Compared on letters only. One of these
// as the sole suggestion would also use up the customer's one notification.
const PLACEHOLDER_SURNAMES = new Set([
  'unknown', 'na', 'none', 'null', 'undefined', 'customer', 'client', 'test', 'tbd', 'noname', 'nolastname',
  'lastname', 'surname', 'name', 'resident', 'homeowner', 'owner', 'tenant', 'occupant', 'business', 'company',
]);
function cleanSurname(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text || !/^[\p{L}][\p{L}' -]*$/u.test(text)) return null;
  const letters = text.toLowerCase().replace(/[^\p{L}]/gu, '');
  // A single letter is an initial, not a surname.
  return letters.length < 2 || PLACEHOLDER_SURNAMES.has(letters) ? null : text;
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
  // An international identity is the full number: matched on its exact digits.
  const intlDigits = !nanpKey && /^\+\d{8,15}$/.test(phoneKey || '') ? phoneKey.slice(1) : null;
  if (!email && !nanpKey && !intlDigits) return { skip: 'no_identifier' };
  const sameContact = (q) => {
    if (email) q.whereRaw('LOWER(TRIM(email)) = ?', [email]);
    if (nanpKey) q.orWhereRaw(nanpStoredPhoneClause('phone'), [nanpKey]);
    if (intlDigits) q.orWhereRaw("regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = ?", [intlDigits]);
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
    dedupeKey: SUGGESTION_KEY(customer.id),
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
    if (await alreadySuggested(customerId)) return { skipped: 'already_suggested' };
    const { answers, tried } = await collectAnswers(eligible);
    if (!answers.length) {
      logger.info(`${LOG_PREFIX} no suggestion`, { callLogId, customerId, outcome: tried });
      return { suggested: false, outcome: 'no_answer' };
    }
    // The lookups ran for seconds on a snapshot. Every eligibility fact is read
    // again: the call may have been relinked or reprocessed, the customer
    // named, deleted or edited. Anything but the same eligible state posts nothing.
    const again = await loadEligible({ callLogId, customerId });
    if (again.skip) return { suggested: false, outcome: again.skip === 'has_last_name' || again.skip === 'customer_gone' ? 'last_name_appeared' : `recheck_${again.skip}` };
    if (!sameIdentity(eligible.customer, again.customer) || again.relationship !== eligible.relationship) return { suggested: false, outcome: 'customer_changed' };
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
  _private: { callContactPhoneKey, cleanSurname, groupBySurname, whyFor },
};
