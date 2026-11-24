'use strict';

// Caller-given text consent (GATE_CALL_GIVEN_CONTACT_CONSENT, owner ruling 2026-10-29): a phone a caller gives on a call for
// another person counts as consent to text that person APPOINTMENT AND SERVICE messages. The scope lives here, in one place, and
// every reader asks it: the call pipeline write (call-recording-processor persistCallSecondaryContact and its call site), contact
// login (customer-contact contactSlotMayLogIn refuses these phones), and review asks (getServiceContactSmsRecipient with
// excludeCallGiven). The per-phone provenance is service_preferences.call_given_phone_keys, written in the same UPDATE as the
// stamp. STOP, do-not-contact, suppression and a disclaimed number are not decided here: the send layer enforces them.

const db = require('../models/db');

// The consent stamp is ACCOUNT-WIDE, so a caller-given phone may
// stamp (or ride) it only when no other contact phone on the row is left uncovered: the row has no contact phones yet, or it is
// already stamped. A row with other unstamped contact phones keeps today's hold and Reply-YES ask.
const CALL_GIVEN_CONSENT_SOURCE = 'call_caller_provided';
const CALL_GIVEN_CONSENT_TEXT_VERSION = 'owner-ruling-2026-10-29';
function callGivenConsentRowCovered(customer, slots) {
  return !!customer.service_contacts_consent_at
    || !slots.some((slot) => String(customer[slot.phone] || '').trim());
}
// What a caller-given phone changes in persistCallSecondaryContact's write, in one place. Given (the caller decided it from its
// own read; re-checked here on the row this write sees): the row stamp describes the phone (a row with none gets it, an existing
// stamp is left exactly as it is and never cleared), nothing holds the phone, and the explicit-consent stamp rule is not used.
// Not given: the options pass through untouched, so the write is today's.
// The write also records the phone in service_preferences.call_given_phone_keys, in the same UPDATE: that per-phone provenance
// is the committed outcome the call site reads back (a retry keeps the phone's status), and contactSlotMayLogIn refuses these
// phones for portal login unless the holder's own save attested them. `guard` pins the UPDATE to the coverage this decision used
// (the stamp present or absent, and every contact phone exactly as read), so a concurrent admin edit makes it a 0-row no-op.
function callGivenConsentWrite({ callGivenConsent, contact, customer, slots, consentAt, smsConsentExplicit, holdPhone, keepConsentStamp, conn }) {
  if (callGivenConsent !== true || !contact.phone || !callGivenConsentRowCovered(customer, slots)) {
    return { opts: { smsConsentExplicit, holdPhone, keepConsentStamp }, stamp: {}, guard: (q) => q };
  }
  const stamped = !!customer.service_contacts_consent_at;
  const givenKey = String(contact.phone).replace(/\D/g, '').slice(-10);
  return {
    opts: { smsConsentExplicit: false, holdPhone: false, keepConsentStamp: true },
    stamp: {
      ...(stamped ? {} : {
        service_contacts_consent_at: consentAt instanceof Date ? consentAt : new Date(),
        service_contacts_consent_source: CALL_GIVEN_CONSENT_SOURCE,
        service_contacts_consent_text_version: CALL_GIVEN_CONSENT_TEXT_VERSION,
      }),
      service_preferences: conn.raw(
        // Same UPDATE: record the provenance AND drop this phone from login_attested_phone_keys, so a stale holder attestation
        // left by a contact that was removed can never grant login to the phone this call re-adds (a fresh holder save is needed).
        "COALESCE(service_preferences, '{}'::jsonb) || jsonb_build_object('call_given_phone_keys', (SELECT COALESCE(jsonb_agg(DISTINCT k), '[]'::jsonb) FROM jsonb_array_elements(COALESCE(service_preferences -> 'call_given_phone_keys', '[]'::jsonb) || to_jsonb(?::text)) k)) || CASE WHEN jsonb_typeof(service_preferences -> 'login_attested_phone_keys') = 'array' THEN jsonb_build_object('login_attested_phone_keys', (SELECT COALESCE(jsonb_agg(k), '[]'::jsonb) FROM jsonb_array_elements(service_preferences -> 'login_attested_phone_keys') k WHERE k <> to_jsonb(?::text))) ELSE '{}'::jsonb END",
        [givenKey, givenKey],
      ),
    },
    guard: (q) => slots.reduce(
      (out, slot) => out.whereRaw('?? IS NOT DISTINCT FROM ?', [slot.phone, customer[slot.phone] ?? null]),
      q.whereRaw(stamped ? 'service_contacts_consent_at IS NOT NULL' : 'service_contacts_consent_at IS NULL'),
    ),
  };
}
// A phone the call site expected to consent that the writer saved WITHOUT the consent (the row's coverage changed between the
// read and the write) takes today's fail-closed path: a blocking opt-in row and the unconsented list, until its own YES.
async function holdCallGivenFallback(customerId, phone, conn = db) {
  const key = String(phone || '').replace(/\D/g, '').slice(-10);
  if (!key) return;
  await conn('recipient_optin').insert({
    phone_key: key, phone_e164: String(phone || '').trim(), status: 'ask_failed',
    customer_id: customerId, requested_by: 'call_pipeline', requested_at: new Date(),
  }).onConflict(['customer_id', 'phone_key']).ignore();
  // One statement: a YES that landed since the pending read leaves a confirmed row, and the phone is then not put back on the list.
  await conn('customers').where({ id: customerId })
    .whereRaw("NOT EXISTS (SELECT 1 FROM recipient_optin WHERE customer_id = ? AND phone_key = ? AND status = 'confirmed')", [customerId, key])
    .update({
    service_preferences: conn.raw(
      "jsonb_set(COALESCE(service_preferences, '{}'::jsonb), '{unconsented_slot_phone_keys}', COALESCE(service_preferences -> 'unconsented_slot_phone_keys', '[]'::jsonb) || to_jsonb(?::text))",
      [key],
    ),
  });
}
const lastTen = (value) => String(value || '').replace(/\D/g, '').slice(-10);

// An opt-in row for this phone on this account: no row, or a confirmed one, lets caller-given consent stand. Any other row
// (declined, pending, ask_failed) keeps today's path: filterRecipientsByOptin blocks every non-confirmed row, so consenting
// over it would leave the phone blocked while both ask paths were skipped. A decline stays blocked; a failed or pending ask
// stays recoverable through the old ask. Fail closed: an unreadable table reads as a row (a missing table is no row).
async function optinRowAllowsCallGiven(customerId, phone, conn = db) {
  const key = lastTen(phone);
  if (!customerId || !key) return false;
  try {
    const row = await conn('recipient_optin').where({ customer_id: customerId, phone_key: key }).first('status');
    return !row || row.status === 'confirmed';
  } catch (err) {
    return !!err && err.code === '42P01';
  }
}

// The committed outcome of a caller-given consent: the phone sits in the row's call_given_phone_keys, the row is stamped, no
// later hold (the unconsented list) names it, and no non-confirmed opt-in row blocks it. Read from the rows, never from a
// decision made before the write.
async function callGivenConsentPersisted(customerId, phone, conn = db) {
  const { callGivenPhoneKeys, unconsentedSlotPhoneKeys } = require('./customer-contact');
  const row = await conn('customers').where({ id: customerId }).first('service_preferences', 'service_contacts_consent_at');
  const key = lastTen(phone);
  if (!(row && row.service_contacts_consent_at && key && callGivenPhoneKeys(row).has(key) && !unconsentedSlotPhoneKeys(row).has(key))) return false;
  return optinRowAllowsCallGiven(customerId, phone, conn);
}

// May this appointment contact also get the same-call booking confirmation? Without the caller's own explicit SMS consent, only a
// phone the caller gave on this call (owner ruling 2026-10-29) does. The contact is deduplicated against the number the primary
// confirmation ACTUALLY went to: when implied consent redirected it to the inbound caller (smsRecipient), a caller-given contact
// that is the resolved customer phone (smsPhone) never received it and still gets its own. Every other contact keeps the
// original comparison against smsPhone, so the gate off is unchanged. A claim-failed phone fails closed (no row is not
// grandfathered here).
function confirmationFanOutKeep(contact, { smsPhone, smsRecipient, v2SmsConsentExplicit, callGivenConsentPhones, optinClaimFailedPhones }) {
  const key = lastTen(contact.phone);
  if (!key) return false;
  const given = callGivenConsentPhones.has(key);
  if (key === lastTen(given ? smsRecipient : smsPhone)) return false;
  return (v2SmsConsentExplicit || given) && !optinClaimFailedPhones.has(key);
}

module.exports = {
  confirmationFanOutKeep,
  CALL_GIVEN_CONSENT_SOURCE,
  CALL_GIVEN_CONSENT_TEXT_VERSION,
  callGivenConsentRowCovered,
  callGivenConsentWrite,
  holdCallGivenFallback,
  optinRowAllowsCallGiven,
  callGivenConsentPersisted,
};
