/**
 * Family-member call -> suggested account(s) for the office, by spoken full name
 * (owner ruling 2026-10-08: SUGGEST ONLY; the earlier auto-link was dropped).
 *
 * The audited case: a daughter called for her mother by full name from a number no
 * account carried; the call linked to no account, the accepted visit was never
 * booked and address cards were filed. The extraction already carries the account
 * holder: the caller's relationship is `family_member` and the named parent is the
 * call's V2 `secondary_contact`.
 *
 * This module only READS. When a family caller names a holder and at least one LIVE
 * customer (whereLiveCustomer: customer stage, active, not soft-deleted, so
 * merged-away rows never match) has that exact first and last name (case and
 * whitespace ignored, no fuzzy match), it files ONE advisory `family_account_candidates`
 * card listing each candidate with an "address matches" mark when the stated address
 * is that account's. Staff confirm, then link the call with the existing call relink
 * action. Nothing is linked, saved, texted or enrolled here, so the call behaves
 * exactly as it did before, plus the card. A reprocess refreshes the open card from the new extraction
 * and retires it (auto-dismissed) when the suggestion is gone.
 *
 * The caller's OWN account (2026-10-10 call audit, owner 2026-10-12; same suggest-only card).
 * Three callers reached Waves from a number no account carried and the call linked to no
 * account: a property manager whose phone number had changed, a relative calling about a
 * booked visit under a different last name, and a caller who gave a first name only. When
 * the family rule above suggests nothing, the same card lists the account the caller looks
 * like, on ONE of three bases, tried in this order (matchCallerOwnAccounts):
 *   1. caller_full_name: live customers with the caller's own exact first and last name.
 *   2. caller_first_name_recent_visit: an existing-customer call (the model's call_nature);
 *      customers with the caller's first name who have a visit on the calendar within
 *      RECENT_DAYS days of the call, either side.
 *   3. caller_first_name_city_recent: the caller gave no last name; customers with that
 *      first name in the city stated on the call (never one address validation filled in)
 *      whose record was created within RECENT_DAYS days
 *      before the call.
 * Replayed on 60 days of stored calls each basis found exactly one account every time it
 * fired (about five cards in all). A basis that finds more than MAX_OWN_CANDIDATES accounts
 * suggests nothing: a common first name is not evidence.
 *
 * A phone number the caller gave for another person (2026-10-12 call audit; same suggest-only
 * card, basis contact_phone_on_account). A caller on an unknown number asked for service for
 * the homeowner and gave the homeowner's number; that number was the phone on an existing
 * account, and the call became a new lead. When the family rule suggests nothing, the card
 * lists the active accounts whose OWN phone (phone or secondary_phone, never a service-contact
 * slot: an agent's number sits in many accounts' slots) is a number the caller gave for someone
 * else. More than MAX_OWN_CANDIDATES accounts suggests nothing. This basis is tried before the
 * caller's-own-account bases: a spoken number is stronger evidence than a first name.
 *
 * No card: the caller is not a family member, no full name was named, a voicemail
 * (a one-sided transcription never names an account), an outbound call, a call that
 * is already linked or was unlinked on purpose, a number some live account already
 * knows, or no live name match.
 */

const db = require('../models/db');
const logger = require('./logger');
const { whereLiveCustomer } = require('./customer-stages');
const { sameHouseNumberStreet } = require('./call-triage-flags');
const { unitAnywhereOnLine } = require('../utils/address-normalizer');
const { findKnownCallerCustomer, customerPhoneLookupKey } = require('../utils/known-caller-phone');
const { lockTriageCall, syncCallReviewStatus } = require('../utils/triage-locks');
const { canonicalV2Secondary, mapSecondaryContactsToLegacy } = require('../utils/extraction-compat');
const { etDateString, addETDays } = require('../utils/datetime-et');

// Roles the model may give the person the family caller names. A named person the model
// tagged as an arranger, tenant, buyer, lender and so on is someone else, never the holder.
const HOLDER_ROLES = new Set(['family_member', 'spouse_partner', 'other', 'unknown', '']);

// How many candidates a card lists.
const MAX_CANDIDATES = 5;

function normName(value) {
  return String(value || '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function fullNameKey(contact) {
  const first = normName(contact && contact.first_name);
  const last = normName(contact && contact.last_name);
  return first && last ? `${first}|${last}` : null;
}

function displayName(contact) {
  return [contact && contact.first_name, contact && contact.last_name]
    .map((v) => String(v || '').trim()).filter(Boolean).join(' ');
}

/**
 * The account holder the family caller named, or null. Exactly one distinct full name must
 * qualify; two different named relatives is ambiguous and suggests nothing.
 */
function pickNamedAccountHolder({ callerRelationship, caller = {}, secondaryContacts = [] } = {}) {
  if (String(callerRelationship || '').trim().toLowerCase() !== 'family_member') return null;
  const callerKey = fullNameKey(caller);
  const byKey = new Map();
  for (const contact of Array.isArray(secondaryContacts) ? secondaryContacts : []) {
    const key = fullNameKey(contact);
    if (!key || !HOLDER_ROLES.has(String(contact.role || '').trim().toLowerCase())) continue;
    // The model sometimes copies the caller into the second-person slot.
    if (callerKey && key === callerKey) continue;
    if (!byKey.has(key)) {
      byKey.set(key, { first_name: String(contact.first_name).trim(), last_name: String(contact.last_name).trim(), key });
    }
  }
  return byKey.size === 1 ? [...byKey.values()][0] : null;
}

// Live customers whose first AND last name equal the spoken name, compared in SQL on trimmed,
// whitespace-collapsed, lower-cased text.
async function findLiveCustomersByFullName(conn, holder, { limit = MAX_CANDIDATES } = {}) {
  const squash = (col) => `lower(btrim(regexp_replace(COALESCE(${col}, ''), '\\s+', ' ', 'g')))`;
  return conn('customers')
    .modify(whereLiveCustomer)
    .whereRaw(`${squash('first_name')} = ?`, [normName(holder.first_name)])
    .whereRaw(`${squash('last_name')} = ?`, [normName(holder.last_name)])
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .limit(limit)
    .select('id', 'first_name', 'last_name', 'city', 'address_line1', 'address_line2', 'zip');
}

// Does the call's stated address (as originally spoken, before Google correction) match the
// account's on-file address? House number and street (the existing sameHouseNumberStreet key),
// ZIP and city when the call stated them, and the unit, fail closed: a stated unit needs the same
// unit on file, read in either position (address_line2, trailing, or the legacy unit-first form).
function statedAddressCorroborates(stated, customer) {
  const street = String((stated && stated.street_line_1) || '').trim();
  const onFile = String((customer && customer.address_line1) || '').trim();
  if (!street || !onFile || !sameHouseNumberStreet(street, onFile)) return false;
  const zip5 = (v) => (String(v || '').match(/\d{5}/) || [''])[0];
  const cityKey = (v) => String(v || '').toLowerCase().replace(/[^a-z]/g, '');
  const statedZip = zip5(stated.postal_code);
  if (statedZip && zip5(customer.zip) && statedZip !== zip5(customer.zip)) return false;
  const statedCity = cityKey(stated.city);
  if (statedCity && cityKey(customer.city) && statedCity !== cityKey(customer.city)) return false;
  const unitKey = (v) => String(v || '').toLowerCase().replace(/\b(apartment|apt|unit|suite|ste|number|no|bldg|building|lot|#)\b/g, '').replace(/[^a-z0-9]/g, '');
  const statedUnit = unitKey(stated.street_line_2 || stated.unit || unitAnywhereOnLine(street));
  const onFileUnit = unitKey(customer.address_line2 || unitAnywhereOnLine(onFile));
  return !(statedUnit && statedUnit !== onFileUnit);
}

// The caller's own account: how far from the call a visit or a new record still counts, and
// how many accounts a first-name basis may find before it stops being evidence.
const RECENT_DAYS = 14;
const MAX_OWN_CANDIDATES = 3;
const OWN_VISIT_STATUSES = ['pending', 'confirmed', 'en_route', 'on_site', 'completed'];
const OWN_ACCOUNT_REASONS = {
  caller_full_name: 'An account carries this caller\'s exact name under another phone number. Confirm it is the same person, then link the call. A customer record may exist under the caller: merge it on the Duplicates page.',
  caller_first_name_recent_visit: 'An account with this caller\'s first name has a visit on the calendar close to this call. Confirm it is the same household, then link the call.',
  contact_phone_on_account: 'The caller gave a phone number for another person, and an account carries that number. Confirm the caller is calling for this account, then link the call. A lead or customer record may exist under the caller: merge it on the Duplicates page.',
  caller_first_name_city_recent: 'The caller gave a first name only. An account created in the last two weeks has that first name in the same city. Confirm it is the same person, then link the call. A customer record may exist under the caller: merge it on the Duplicates page.',
};

const CARD_REASON = 'Confirm, then link the call to this account. A customer record and visit may exist under the caller: move the visit to the account holder when you link.';

const CARD_REASON_CODE = 'family_account_candidates';
const RETIRE_RULE = 'family_suggestion_gone';
const RETIRE_NOTE = 'Superseded: a reprocess no longer finds an account to suggest for this caller.';

/**
 * The accounts a family caller's words point at, from the extraction alone: { holder, more_accounts,
 * candidates } or null. Pure of call state, so a reprocess can tell "the suggestion is gone" from
 * "this pass created a customer for the caller".
 */
async function matchFamilyAccounts({
  call, extracted, v2CanonicalExtraction, statedAddress, isOutbound = false, conn = db,
}) {
  if (isOutbound || extracted.is_voicemail) return null;
  const holder = pickNamedAccountHolder({
    callerRelationship: v2CanonicalExtraction?.caller?.relationship_to_property,
    caller: { first_name: extracted.first_name, last_name: extracted.last_name },
    secondaryContacts: [canonicalV2Secondary(v2CanonicalExtraction), ...mapSecondaryContactsToLegacy(v2CanonicalExtraction?.secondary_contacts)].filter(Boolean),
  });
  if (!holder) return null;
  // One more than the card lists, so a truncated list can say so.
  const found = await findLiveCustomersByFullName(conn, holder, { limit: MAX_CANDIDATES + 1 });
  if (!found.length) return null;
  return {
    holder,
    more_accounts: found.length > MAX_CANDIDATES,
    candidates: found.slice(0, MAX_CANDIDATES).map((m) => ({
      id: String(m.id),
      name: displayName(m),
      city: m.city || null,
      address_matches: statedAddressCorroborates(statedAddress, m),
    })),
  };
}

const squashSql = (col) => `lower(btrim(regexp_replace(COALESCE(${col}, ''), '\\s+', ' ', 'g')))`;
const ownCandidate = (m) => ({ id: String(m.id), name: displayName(m), city: m.city || null, address_matches: false });

// Basis 2: customers with this first name (active, not soft-deleted; any stage, because a booked
// customer can still sit at a lead stage and the visit is the evidence) who have a visit on the
// calendar within RECENT_DAYS days of the call.
function findByFirstNameAndRecentVisit(conn, first, callAt, limit) {
  // scheduled_date is an Eastern calendar date: count the days in ET, from the call's ET day.
  const from = etDateString(addETDays(callAt, -RECENT_DAYS));
  const to = etDateString(addETDays(callAt, RECENT_DAYS));
  return conn('customers as cu')
    .where('cu.active', true)
    .whereNull('cu.deleted_at')
    .whereRaw(`${squashSql('cu.first_name')} = ?`, [first])
    .whereExists(function recentVisit() {
      this.select(conn.raw('1')).from('scheduled_services as s')
        .whereRaw('s.customer_id = cu.id')
        .whereIn('s.status', OWN_VISIT_STATUSES)
        .whereRaw('s.scheduled_date BETWEEN ?::date AND ?::date', [from, to]);
    })
    .orderBy('cu.created_at', 'asc').orderBy('cu.id', 'asc').limit(limit)
    .select('cu.id', 'cu.first_name', 'cu.last_name', 'cu.city');
}

// Basis 3: customers with this first name and a last name on file, in the stated city, whose
// record was created within RECENT_DAYS days before the call.
function findByFirstNameCityRecent(conn, first, city, callAt, limit) {
  const from = new Date(callAt.getTime() - RECENT_DAYS * 86400000);
  return conn('customers')
    .where('active', true)
    .whereNull('deleted_at')
    .whereRaw(`${squashSql('first_name')} = ?`, [first])
    .whereRaw(`${squashSql('city')} = ?`, [city])
    .whereRaw(`btrim(COALESCE(last_name, '')) <> ''`)
    .where('created_at', '<', callAt)
    .where('created_at', '>=', from)
    .orderBy('created_at', 'asc').orderBy('id', 'asc').limit(limit)
    .select('id', 'first_name', 'last_name', 'city');
}

/**
 * The account the CALLER looks like (see the module comment): { basis, candidates, more_accounts }
 * or null. Read-only. The customer this very call created for the caller is never its own match.
 */
async function matchCallerOwnAccounts({ call, extracted, v2CanonicalExtraction, statedAddress, isOutbound = false, conn = db }) {
  if (isOutbound || extracted.is_voicemail) return null;
  const first = normName(extracted.first_name);
  if (!first) return null;
  const last = normName(extracted.last_name);
  const own = createdCustomerId(call);
  const others = (rows) => rows.filter((r) => String(r.id) !== own && String(r.id) !== String(call.customer_id || ''));
  const callAt = call.created_at ? new Date(call.created_at) : null;
  const dated = callAt && !Number.isNaN(callAt.getTime());
  const limit = MAX_OWN_CANDIDATES + 2; // room for the call's own record plus one over the cap

  if (last) {
    const found = others(await findLiveCustomersByFullName(conn, { first_name: first, last_name: last }, { limit: MAX_CANDIDATES + 2 }));
    if (found.length) {
      return { basis: 'caller_full_name', more_accounts: found.length > MAX_CANDIDATES, candidates: found.slice(0, MAX_CANDIDATES).map(ownCandidate) };
    }
  }
  const firstNameBasis = (basis, rows) => {
    const found = others(rows);
    return found.length && found.length <= MAX_OWN_CANDIDATES ? { basis, more_accounts: false, candidates: found.map(ownCandidate) } : null;
  };
  const nature = String(v2CanonicalExtraction?.call_nature || '');
  if (dated && nature.startsWith('existing_customer')) {
    const byVisit = firstNameBasis('caller_first_name_recent_visit', await findByFirstNameAndRecentVisit(conn, first, callAt, limit));
    if (byVisit) return byVisit;
  }
  // The city as SPOKEN on the call (statedAddress, frozen before address validation): the merged
  // record's city can be one Google filled in or corrected, which nobody said.
  const city = normName(statedAddress && statedAddress.city);
  if (dated && !last && city) {
    return firstNameBasis('caller_first_name_city_recent', await findByFirstNameCityRecent(conn, first, city, callAt, limit));
  }
  return null;
}

// The 10-digit keys of the numbers the caller gave for OTHER people (the V2 second-person slots),
// without the caller's own line or callback number. Pure.
function contactPhoneKeys({ call, extracted, v2CanonicalExtraction }) {
  const own = new Set([call && call.from_phone, extracted && extracted.phone].map(customerPhoneLookupKey).filter(Boolean));
  const contacts = [canonicalV2Secondary(v2CanonicalExtraction), ...mapSecondaryContactsToLegacy(v2CanonicalExtraction?.secondary_contacts)].filter(Boolean);
  const keys = contacts.map((c) => customerPhoneLookupKey(c.phone)).filter((k) => k.length === 10 && !own.has(k));
  return [...new Set(keys)];
}

// Active, not soft-deleted customers whose own phone or secondary phone is one of the keys.
function findCustomersByOwnPhone(conn, keys, limit) {
  const forms = keys.flatMap((k) => [k, `1${k}`]);
  const digits = (col) => `regexp_replace(COALESCE(${col}, ''), '[^0-9]', '', 'g')`;
  const marks = forms.map(() => '?').join(', ');
  return conn('customers')
    .where('active', true)
    .whereNull('deleted_at')
    .whereRaw(`(${digits('phone')} IN (${marks}) OR ${digits('secondary_phone')} IN (${marks}))`, [...forms, ...forms])
    .orderBy('created_at', 'asc').orderBy('id', 'asc').limit(limit)
    .select('id', 'first_name', 'last_name', 'city', 'address_line1', 'address_line2', 'zip');
}

/**
 * The account a number the caller gave for another person belongs to (see the module comment):
 * { basis, candidates, more_accounts } or null. Read-only.
 */
async function matchContactPhoneAccounts({ call, extracted, v2CanonicalExtraction, statedAddress, isOutbound = false, conn = db }) {
  if (isOutbound || extracted.is_voicemail) return null;
  const keys = contactPhoneKeys({ call, extracted, v2CanonicalExtraction });
  if (!keys.length) return null;
  const own = createdCustomerId(call);
  const found = (await findCustomersByOwnPhone(conn, keys, MAX_OWN_CANDIDATES + 2))
    .filter((r) => String(r.id) !== own && String(r.id) !== String(call.customer_id || ''));
  if (!found.length || found.length > MAX_OWN_CANDIDATES) return null;
  return {
    basis: 'contact_phone_on_account',
    more_accounts: false,
    candidates: found.map((m) => ({ ...ownCandidate(m), address_matches: statedAddressCorroborates(statedAddress, m) })),
  };
}

// What the card suggests for this call: the family rule first, then a number the caller gave for
// another person, else the caller's own account.
async function matchSuggestedAccounts(args) {
  return (await matchFamilyAccounts(args)) || (await matchContactPhoneAccounts(args)) || matchCallerOwnAccounts(args);
}

/**
 * The suggestion that earns a NEW card: the match, plus the call state. No card for a call already linked
 * (an operator's link, or this pass's own customer for the caller) or for a number some live account
 * already knows (the canonical known-caller lookup, for every number the caller used).
 */
async function suggestFamilyAccounts({ phones = [], ...args }) {
  const match = await matchSuggestedAccounts(args);
  const own = createdCustomerId(args.call);
  const linkedElsewhere = args.call.customer_id && String(args.call.customer_id) !== own;
  if (!match || linkedElsewhere) return null;
  // The customer THIS call created for the caller (an earlier pass) carries the caller's own number; it
  // must not hide the suggestion on a reprocess of the same call.
  const knownElsewhere = own ? (table) => (args.conn || db)(table).whereNot('id', own) : (args.conn || db);
  for (const phone of phones) {
    if (await findKnownCallerCustomer(knownElsewhere, phone, ['id'])) return null;
  }
  return match;
}

// The customer a processing pass created from this very call (the call-creation provenance stamp).
function createdCustomerId(call) {
  try {
    const raw = call && call.metadata;
    return String(((typeof raw === 'string' ? JSON.parse(raw) : raw) || {}).created_customer_id || '');
  } catch {
    return '';
  }
}

function cardPayload({ suggestion, extracted, call, phone }) {
  return {
    account_holder_name: suggestion.holder ? displayName(suggestion.holder) : null,
    // Set only for a suggestion of the caller's OWN account (matchCallerOwnAccounts).
    match_basis: suggestion.basis || null,
    caller_name: [extracted.first_name, extracted.last_name].filter(Boolean).join(' ') || null,
    caller_phone: call.from_phone || null,
    caller_callback_phone: phone && phone !== call.from_phone ? phone : null,
    holder_candidates: suggestion.candidates,
    more_accounts: suggestion.more_accounts,
    customer_ids: suggestion.candidates.map((c) => c.id),
    reason: suggestion.basis ? OWN_ACCOUNT_REASONS[suggestion.basis] : CARD_REASON,
  };
}

// An operator already closed this call's card (resolved or dismissed by hand: the triage transitions stamp
// resolution_source 'human'): a reprocess must not reopen it. A card the sweep below retired ('auto'), or
// one a recording swap closed (no source), is not an operator's decision, so the suggestion comes back.
async function operatorClosedCard(trx, callLogId) {
  const row = await trx('triage_items')
    .where({ call_log_id: callLogId, reason_code: CARD_REASON_CODE })
    .whereIn('status', ['resolved', 'dismissed'])
    .where({ resolution_source: 'human' })
    .first('id');
  return Boolean(row);
}

async function retireOpenCard(trx, callLogId) {
  const now = new Date();
  const retired = await trx('triage_items')
    .where({ call_log_id: callLogId, reason_code: CARD_REASON_CODE, status: 'open' })
    .update({
      status: 'dismissed', resolution_source: 'auto', resolution_rule: RETIRE_RULE, resolution_note: RETIRE_NOTE, resolved_at: now, updated_at: now,
    });
  if (retired) await syncCallReviewStatus(trx, callLogId, 'dismissed');
}

/**
 * File, refresh or retire the card for one processed call (derived purely from the extraction, so a
 * reprocess keeps it true). Runs under the per-call triage lock and the processing-token fence; an
 * in_progress card (an operator is on it) is never touched. Fail-open: an error leaves the call exactly as
 * it was.
 */
async function fileFamilyAccountCard({
  call, procToken = null, extracted, v2CanonicalExtraction, statedAddress, phone, isOutbound, conn = db,
}) {
  try {
    let suggestion = null;
    await conn.transaction(async (trx) => {
      await lockTriageCall(trx, call.id);
      if (procToken && !(await trx('call_log').where({ id: call.id, processing_token: procToken }).forUpdate().first('id'))) return;
      const args = { call, extracted, v2CanonicalExtraction, statedAddress, isOutbound, conn: trx };
      const match = await matchSuggestedAccounts(args);
      const open = await trx('triage_items').where({ call_log_id: call.id, reason_code: CARD_REASON_CODE, status: 'open' }).first('id');
      if (!match) {
        if (open) await retireOpenCard(trx, call.id);
        return;
      }
      if (!open && !(await suggestFamilyAccounts({ ...args, phones: [phone, call.from_phone] }))) return;
      if (!open && await operatorClosedCard(trx, call.id)) return;
      suggestion = match;
      const { buildTriageItem } = require('./call-routing-gates');
      const item = buildTriageItem({
        callLogId: call.id,
        flag: CARD_REASON_CODE,
        extraction: v2CanonicalExtraction || undefined,
        severity: 'advisory',
        extraPayload: cardPayload({ suggestion: match, extracted, call, phone }),
      });
      await trx('triage_items')
        .insert(item)
        .onConflict(trx.raw("(call_log_id, reason_code) WHERE status IN ('open', 'in_progress')"))
        .merge({ payload: item.payload, updated_at: new Date() })
        .where('triage_items.status', 'open');
      // The call counts as review-open while this card is open (nothing else in the pass opens it).
      await syncCallReviewStatus(trx, call.id);
    });
    return suggestion;
  } catch (e) {
    logger.warn(`[call-family-link] card skipped for call ${call.id}: ${e.code || e.name || 'error'}`);
    return null;
  }
}

module.exports = {
  HOLDER_ROLES,
  MAX_CANDIDATES,
  CARD_REASON,
  normName,
  fullNameKey,
  displayName,
  pickNamedAccountHolder,
  findLiveCustomersByFullName,
  statedAddressCorroborates,
  RETIRE_RULE,
  matchFamilyAccounts,
  matchCallerOwnAccounts,
  matchContactPhoneAccounts,
  contactPhoneKeys,
  RECENT_DAYS,
  MAX_OWN_CANDIDATES,
  OWN_ACCOUNT_REASONS,
  suggestFamilyAccounts,
  fileFamilyAccountCard,
};
