/**
 * Family-member call -> account holder's customer link, by spoken full name
 * (GATE_CALL_FAMILY_NAME_LINK, owner ruling 2026-10-07, option A).
 *
 * The audited case: a daughter called for her mother by full name from a number
 * no account carries. The call linked to no account, the accepted visit was
 * never booked, and address cards were filed. The extraction already carries the
 * account holder: the caller's relationship is `family_member` and the named
 * parent is the call's `secondary_contact` (V1 and V2 both capture it).
 *
 * Rule, in order:
 *   1. The caller is a family member (schema-valid V2 relationship_to_property)
 *      and the extraction names exactly ONE other person with a first AND last
 *      name whose role could be the account holder.
 *   2. Look for LIVE customers (whereLiveCustomer: customer stage, active, not
 *      soft-deleted, which also drops merged-away rows) whose first and last
 *      name equal the spoken name, ignoring case and whitespace. No fuzzy match.
 *   3. Exactly one -> link the call (token-fenced, in one transaction that
 *      re-reads the customer under a share lock) and file an advisory FYI card.
 *      Zero or 2+ -> link nothing and file an advisory card with the candidates.
 *
 * The caller is NOT saved on the holder's account (no service contact, no opt-in
 * ask): the FYI card shows the caller's name and number and the office adds them if
 * that is right. A voicemail never links. The call's own texts never go out on a
 * family link (the caller's consent is not the holder's).
 *
 * linkFamilyCall is the one entry point the processor calls; the decisions live here.
 * Pure helpers are exported for unit tests; the writers take a knex connection.
 */

const db = require('../models/db');
const logger = require('./logger');
const { whereLiveCustomer } = require('./customer-stages');
const { NOT_EXPLICITLY_UNLINKED_SQL } = require('../utils/call-link-override');
const { sameHouseNumberStreet } = require('./call-triage-flags');
const { unitAnywhereOnLine } = require('../utils/address-normalizer');

// Roles the model may give the person the family caller names. A named person
// the model tagged as an arranger, tenant, buyer, lender and so on is someone
// else, never the account holder.
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
 * The account holder the family caller named, or null. `secondaryContacts` is
 * the processor's resolved list (resolveCallSecondaryContacts), `caller` the
 * caller's own spoken name. Exactly one distinct full name must qualify; two
 * different named relatives is ambiguous and links nothing.
 */
function pickNamedAccountHolder({ callerRelationship, caller = {}, secondaryContacts = [] } = {}) {
  if (String(callerRelationship || '').trim().toLowerCase() !== 'family_member') return null;
  const callerKey = fullNameKey(caller);
  const byKey = new Map();
  for (const contact of Array.isArray(secondaryContacts) ? secondaryContacts : []) {
    const key = fullNameKey(contact);
    if (!key) continue;
    if (!HOLDER_ROLES.has(String(contact.role || '').trim().toLowerCase())) continue;
    // The model sometimes copies the caller into the second-person slot.
    if (callerKey && key === callerKey) continue;
    if (!byKey.has(key)) {
      byKey.set(key, { first_name: String(contact.first_name).trim(), last_name: String(contact.last_name).trim(), key });
    }
  }
  return byKey.size === 1 ? [...byKey.values()][0] : null;
}

// Live customers whose first AND last name equal the spoken name. Compared in
// SQL on trimmed, whitespace-collapsed, lower-cased text: no fuzzy matching.
async function findLiveCustomersByFullName(conn, holder, { limit = MAX_CANDIDATES + 1 } = {}) {
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

// Corroboration (owner ruling 2026-10-07 after the PR #6110 security review): a name alone
// proves nothing, since any caller can claim to be family and say a stranger's name. The
// call must also STATE the service address the matched account has on file: house number and
// street (the existing sameHouseNumberStreet key), and where the call stated a ZIP or a city
// it must equal the account's. No stated street, or a different one, is not corroborated.
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
  // sameHouseNumberStreet strips the unit on purpose, so the unit is judged here, fail closed. The
  // unit is read in either position (unitAnywhereOnLine: trailing "100 Main St Apt 4B" or the legacy
  // unit-first "Apt 4B, 100 Main St") besides address_line2. A stated unit needs the same unit on
  // file; a stated unit against a record with no parseable unit is not corroborated.
  const unitKey = (v) => String(v || '').toLowerCase().replace(/\b(apartment|apt|unit|suite|ste|number|no|bldg|building|lot|#)\b/g, '').replace(/[^a-z0-9]/g, '');
  const statedUnit = unitKey(stated.street_line_2 || stated.unit || unitAnywhereOnLine(street));
  const onFileUnit = unitKey(customer.address_line2 || unitAnywhereOnLine(onFile));
  if (statedUnit && statedUnit !== onFileUnit) return false;
  return true;
}

// Link the unlinked call to the one matched customer. Same fences as the
// processor's own customer-create link: the processing token must still be
// ours, the row must still have no customer and no operator unlink, and the
// customer is re-read under a share lock so a merge or archive that retires the
// row between the search and the write makes this a no-op, never a link to a
// retired account. Returns 'linked' | 'customer_gone' | 'claim_lost'.
async function linkCallToCustomer({ callLogId, procToken, customer, holder, caller, statedAddress = null, conn = db }) {
  let outcome = 'claim_lost';
  await conn.transaction(async (trx) => {
    // The match is re-judged HERE, under the customer row lock, not trusted from the earlier
    // read: a rename, merge or archive between the search and this write must not link the
    // wrong or a dead account. The name and the address corroboration must still hold.
    const live = await trx('customers')
      .modify(whereLiveCustomer)
      .where({ id: customer.id })
      .forShare()
      .first('id', 'first_name', 'last_name', 'city', 'address_line1', 'address_line2', 'zip');
    if (!live) {
      outcome = 'customer_gone';
      return;
    }
    if (fullNameKey(live) !== fullNameKey(holder) || !statedAddressCorroborates(statedAddress, live)) {
      outcome = 'no_longer_matches';
      return;
    }
    const marker = {
      customer_id: String(customer.id),
      holder_name: displayName(holder),
      holder_first_name: holder.first_name,
      holder_last_name: holder.last_name,
      caller_name: displayName(caller) || null,
    };
    const linked = await trx('call_log')
      .where({ id: callLogId })
      .where('processing_token', procToken)
      .whereNull('customer_id')
      .whereRaw(NOT_EXPLICITLY_UNLINKED_SQL)
      .update({
        customer_id: customer.id,
        metadata: trx.raw(
          "jsonb_set(COALESCE(metadata, '{}'::jsonb), '{family_name_link}', ?::jsonb, true)",
          [JSON.stringify(marker)],
        ),
        updated_at: new Date(),
      });
    outcome = linked ? 'linked' : 'claim_lost';
  });
  return outcome;
}

// Is this number on ANY live account, as the primary phone or in a service-contact slot?
// findCustomerForCallContact returns null for a number it matched but would not link (a
// service-contact slot match whose role or address checks fail), which is not "no account
// carries this number". The family link runs only when nothing carries it, so it never
// competes with the phone, shared-phone, household or relink paths.
async function phoneOnAnyLiveAccount(conn, phone) {
  const ten = String(phone || '').replace(/\D/g, '').slice(-10);
  if (ten.length !== 10) return false;
  const { SERVICE_CONTACT_SLOTS } = require('./customer-contact');
  const cols = ['phone', ...SERVICE_CONTACT_SLOTS.map((slot) => slot.phone)];
  const sql = cols
    .map((col) => `RIGHT(regexp_replace(COALESCE(??, ''), '[^0-9]', '', 'g'), 10) = ?`)
    .join(' OR ');
  const row = await conn('customers')
    .whereNull('deleted_at')
    .whereRaw(`(${sql})`, cols.flatMap((col) => [col, ten]))
    .first('id');
  return !!row;
}

/**
 * The whole linking step. Returns
 *   { status: 'linked', customer, holder }  - call_log now carries the customer
 *   { status: 'candidates', holder, candidates } - zero or 2+ matches, nothing linked
 *   { status: 'uncorroborated', holder, candidates } - one name match but the call stated no
 *     matching address: nothing linked or saved, the one candidate rides the card
 *   { status: 'not_applicable' }  - no named holder
 *   { status: 'phone_on_file' }  - some live account carries the caller's number: not ours to link
 *   { status: 'customer_gone' | 'claim_lost' }
 * The processor files the cards (it owns buildTriageItem and the card context).
 */
async function resolveFamilyNameLink({
  callLogId, procToken, callerRelationship, caller, secondaryContacts, callerPhones = [], statedAddress = null, allowLink = true, conn = db,
}) {
  const holder = pickNamedAccountHolder({ callerRelationship, caller, secondaryContacts });
  if (!holder) return { status: 'not_applicable' };
  for (const callerPhone of callerPhones) {
    if (await phoneOnAnyLiveAccount(conn, callerPhone)) return { status: 'phone_on_file', holder };
  }
  const matches = await findLiveCustomersByFullName(conn, holder);
  if (matches.length !== 1) {
    return {
      status: 'candidates',
      holder,
      candidates: matches.slice(0, MAX_CANDIDATES).map((m) => ({
        customer_id: String(m.id),
        name: displayName(m),
        city: m.city || null,
      })),
    };
  }
  const customer = matches[0];
  // One name match without a matching stated address: nothing is linked or saved. The card
  // names the likely account so the office can confirm it.
  if (!statedAddressCorroborates(statedAddress, customer)) {
    return {
      status: 'uncorroborated',
      holder,
      candidates: [{ customer_id: String(customer.id), name: displayName(customer), city: customer.city || null }],
    };
  }
  // A voicemail (one-sided, lossy) never establishes identity: the card only.
  if (!allowLink) {
    return {
      status: 'voicemail',
      holder,
      candidates: [{ customer_id: String(customer.id), name: displayName(customer), city: customer.city || null }],
    };
  }
  const outcome = await linkCallToCustomer({ callLogId, procToken, customer, holder, caller, statedAddress, conn });
  if (outcome === 'no_longer_matches') {
    // Changed under us: link nothing and let the candidates card show what matches now.
    const now = await findLiveCustomersByFullName(conn, holder);
    return {
      status: 'candidates',
      holder,
      candidates: now.slice(0, MAX_CANDIDATES).map((m) => ({ customer_id: String(m.id), name: displayName(m), city: m.city || null })),
    };
  }
  if (outcome !== 'linked') {
    logger.warn(`[call-family-link] link not written for call ${callLogId}: ${outcome}`);
    return { status: outcome, holder };
  }
  return { status: 'linked', customer, holder };
}


function fileCard(callLogId, flag, extraction, extraPayload, conn) {
  const { buildTriageItem } = require('./call-routing-gates');
  return conn('triage_items')
    .insert(buildTriageItem({ callLogId, flag, extraction: extraction || undefined, severity: 'advisory', extraPayload }))
    .onConflict(conn.raw("(call_log_id, reason_code) WHERE status IN ('open', 'in_progress')"))
    .ignore();
}

const CANDIDATE_REASONS = Object.freeze({
  candidates: 'The caller named a family member. Zero or more than one live account has that name, so nothing was linked. Pick the right account.',
  uncorroborated: 'The caller named this account but gave no matching address. Confirm before linking.',
  voicemail: 'The caller named this account in a voicemail. A voicemail never links a call to an account. Confirm before linking.',
});

// The one entry point for the processor's Step 3. Returns null when nothing was linked, else
// { customer, context } (context = what the later steps need to protect the holder's record).
// Fail-open: an error leaves the call exactly as it was without the gate.
async function linkFamilyCall({
  call, procToken, extracted, v2CanonicalExtraction, statedAddress, secondaryContacts, phone,
  v2Primary, isOutbound, conn = db,
}) {
  try {
    if (!require('../config/feature-gates').callFamilyNameLinkLive() || !v2Primary || isOutbound) return null;
    const callerName = [extracted.first_name, extracted.last_name].filter(Boolean).join(' ') || null;
    const result = await resolveFamilyNameLink({
      callLogId: call.id,
      procToken,
      callerRelationship: v2CanonicalExtraction?.caller?.relationship_to_property,
      caller: { first_name: extracted.first_name, last_name: extracted.last_name },
      secondaryContacts,
      // Both numbers: the dictated callback number AND the inbound caller ID.
      callerPhones: [phone, call.from_phone],
      statedAddress,
      allowLink: !extracted.is_voicemail,
      conn,
    });
    const caller = {
      caller_name: callerName,
      caller_phone: call.from_phone || null,
      caller_callback_phone: phone && phone !== call.from_phone ? phone : null,
    };
    if (CANDIDATE_REASONS[result.status]) {
      await fileCard(call.id, 'family_account_candidates', v2CanonicalExtraction, {
        account_holder_name: displayName(result.holder),
        ...caller,
        candidates: result.candidates,
        reason: CANDIDATE_REASONS[result.status],
      }, conn);
      return null;
    }
    if (result.status !== 'linked') return null;
    logger.info(`[call-family-link] linked call ${call.id} to customer ${result.customer.id} by the spoken account-holder name`);
    await fileCard(call.id, 'family_account_linked', v2CanonicalExtraction, {
      linked_customer_id: String(result.customer.id),
      account_holder_name: displayName(result.holder),
      ...caller,
      reason: 'The caller said they were calling for a family member, gave that person\'s full name and the address on file. Exactly one live account matches. The caller was not saved on the account and no confirmation text was sent. Add them as a contact on this account if that is right. Relink the call if this is the wrong account.',
    }, conn).catch((err) => logger.warn(`[call-family-link] card insert failed for call ${call.id}: ${err.code || err.name || 'db_error'}`));
    return { customer: result.customer, context: contextFor(result.customer.id, result.holder) };
  } catch (e) {
    logger.warn(`[call-family-link] skipped for call ${call.id}: ${e.code || e.name || 'error'}`);
    return null;
  }
}

// What the later steps need: the holder's name key (never filed as a contact on their own
// account). Structured, never a re-split display name ("Mary Ann" + "Testerson").
function contextFor(customerId, holder) {
  return { customerId, holderName: displayName(holder), holderKey: fullNameKey(holder) };
}

// The protective context on a reprocess, from the call row's persisted marker, whatever the gate
// says now: the holder's record still never takes the caller's identity.
function familyLinkContextFromCall(call, customerId) {
  const marker = call && call.metadata && call.metadata.family_name_link;
  if (!marker || String(marker.customer_id || '') !== String(customerId) || !marker.holder_first_name || !marker.holder_last_name) return null;
  return contextFor(customerId, { first_name: marker.holder_first_name, last_name: marker.holder_last_name });
}

// Candidate staging must not carry the caller's own identity onto the holder's record.
function scrubCallerIdentity(extracted, v2Extraction) {
  const scrubbedV1 = extracted ? { ...extracted, first_name: null, last_name: null, phone: null, email: null } : extracted;
  const scrubbedV2 = v2Extraction && v2Extraction.caller
    ? {
      ...v2Extraction,
      caller: {
        ...v2Extraction.caller, first_name: null, last_name: null, name_full: null, email: null, phone_e164: null, phone_raw_spoken: null,
      },
    }
    : v2Extraction;
  return { extracted: scrubbedV1, v2Extraction: scrubbedV2 };
}

module.exports = {
  HOLDER_ROLES,
  MAX_CANDIDATES,
  normName,
  fullNameKey,
  displayName,
  pickNamedAccountHolder,
  findLiveCustomersByFullName,
  phoneOnAnyLiveAccount,
  statedAddressCorroborates,
  linkCallToCustomer,
  resolveFamilyNameLink,
  linkFamilyCall,
  familyLinkContextFromCall,
  scrubCallerIdentity,
  CANDIDATE_REASONS,
};
