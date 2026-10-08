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
const { knownCallerPhoneExists } = require('../utils/known-caller-phone');
const { lockTriageCall, syncCallReviewStatus } = require('../utils/triage-locks');
const { canonicalV2Secondary, mapSecondaryContactsToLegacy } = require('../utils/extraction-compat');

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

const CARD_REASON = 'Confirm, then link the call to this account. A customer record and visit may exist under the caller: move the visit to the account holder when you link.';

const CARD_REASON_CODE = 'family_account_candidates';
const RETIRE_RULE = 'family_suggestion_gone';
const RETIRE_NOTE = 'Superseded: a reprocess no longer finds a family caller naming a live account.';

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

/**
 * The suggestion that earns a NEW card: the match, plus the call state. No card for a call already linked
 * (an operator's link, or this pass's own customer for the caller) or for a number some live account
 * already knows (the canonical known-caller lookup, for every number the caller used).
 */
async function suggestFamilyAccounts({ phones = [], ...args }) {
  const match = await matchFamilyAccounts(args);
  if (!match || args.call.customer_id) return null;
  for (const phone of phones) {
    if (await knownCallerPhoneExists(args.conn || db, phone)) return null;
  }
  return match;
}

function cardPayload({ suggestion, extracted, call, phone }) {
  return {
    account_holder_name: displayName(suggestion.holder),
    caller_name: [extracted.first_name, extracted.last_name].filter(Boolean).join(' ') || null,
    caller_phone: call.from_phone || null,
    caller_callback_phone: phone && phone !== call.from_phone ? phone : null,
    holder_candidates: suggestion.candidates,
    more_accounts: suggestion.more_accounts,
    customer_ids: suggestion.candidates.map((c) => c.id),
    reason: CARD_REASON,
  };
}

// An operator already closed this call's card (resolved or dismissed by hand): a reprocess must not reopen
// it. A card the sweep below retired is not an operator's decision.
async function operatorClosedCard(trx, callLogId) {
  const row = await trx('triage_items')
    .where({ call_log_id: callLogId, reason_code: CARD_REASON_CODE })
    .whereIn('status', ['resolved', 'dismissed'])
    .whereRaw("COALESCE(resolution_source, '') <> 'auto'")
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
      const match = await matchFamilyAccounts(args);
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
  suggestFamilyAccounts,
  fileFamilyAccountCard,
};
