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
 * Pure helpers are exported for unit tests; the writers take a knex connection.
 * This file never decides the caller number is the account's: the caller is
 * saved as a service contact by the processor through persistCallSecondaryContact.
 */

const db = require('../models/db');
const logger = require('./logger');
const { whereLiveCustomer } = require('./customer-stages');
const { NOT_EXPLICITLY_UNLINKED_SQL } = require('../utils/call-link-override');

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
    .select('id', 'first_name', 'last_name', 'city');
}

// Link the unlinked call to the one matched customer. Same fences as the
// processor's own customer-create link: the processing token must still be
// ours, the row must still have no customer and no operator unlink, and the
// customer is re-read under a share lock so a merge or archive that retires the
// row between the search and the write makes this a no-op, never a link to a
// retired account. Returns 'linked' | 'customer_gone' | 'claim_lost'.
async function linkCallToCustomer({ callLogId, procToken, customer, holder, caller, conn = db }) {
  let outcome = 'claim_lost';
  await conn.transaction(async (trx) => {
    const live = await trx('customers')
      .modify(whereLiveCustomer)
      .where({ id: customer.id })
      .forShare()
      .first('id');
    if (!live) {
      outcome = 'customer_gone';
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
 *   { status: 'not_applicable' }  - no named holder
 *   { status: 'phone_on_file' }  - some live account carries the caller's number: not ours to link
 *   { status: 'customer_gone' | 'claim_lost' }
 * The processor files the cards (it owns buildTriageItem and the card context).
 */
async function resolveFamilyNameLink({
  callLogId, procToken, callerRelationship, caller, secondaryContacts, callerPhones = [], conn = db,
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
  const outcome = await linkCallToCustomer({ callLogId, procToken, customer, holder, caller, conn });
  if (outcome !== 'linked') {
    logger.warn(`[call-family-link] link not written for call ${callLogId}: ${outcome}`);
    return { status: outcome, holder };
  }
  return { status: 'linked', customer, holder };
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
  linkCallToCustomer,
  resolveFamilyNameLink,
};
