// Report text to on-location contacts (GATE_CONTACT_REPORT_TEXT, owner
// 2026-10-03).
//
// The visit-complete text goes to ONE person: the account holder. It can
// carry a pay link or a review ask, so it is never copied to a contact. When
// that text goes out (sent, or queued for the send window), each confirmed
// on-location contact gets one plain text with the report link instead.
//
// "Confirmed" is the appointment-text rule, unchanged: a consent-stamped slot
// phone that is not the account holder's own number, is not on the account's
// unconsented list, and is not held by an unconfirmed opt-in ask
// (customer-contact.js getAppointmentContacts + the recipient-optin.js hold,
// read through optinHeldPhoneKeys so a failed read retries).
//
// Delivery rides the existing scheduled-SMS rail, the same one a held
// appointment notice for a contact uses (appointment-reminders.js
// queueHeldNoticeContacts): one sms_log row per contact, status 'scheduled',
// the contact's phone and the rendered body frozen at the queue. The
// scheduled-SMS executor sends it: claims, retries, the send window and an
// unknown delivery are its rules, not this module's. The registry entry
// contact_report_ready_deferred (messaging/deferred-replay-registry.js) runs
// recheckContactReportText before the send, and again under the customer row
// lock held through the provider request (its smsHandoff).
//
// One text per contact per report: the queue runs under the customer row
// lock and skips a contact_report_key that already has a row.
const db = require('../models/db');
const logger = require('./logger');

const TEMPLATE_KEY = 'contact_report_ready';
const MESSAGE_TYPE = 'contact_report_ready';
const ENTRY_POINT = 'contact_report_ready_deferred';
// A report older than this is not announced any more.
const EXPIRE_MS = 24 * 60 * 60 * 1000;

function enabled() {
  return require('../config/feature-gates').contactReportTextLive();
}

function phoneKey(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

// The customer row the contact rule reads. A secondary profile with no phone
// of its own takes the account primary's, so the account holder's number in a
// contact slot is still recognized as the holder's and never texted twice.
// An unreadable account primary throws (the caller retries).
async function loadCustomer(customerId, conn = db, { forUpdate = false } = {}) {
  const query = conn('customers').where({ id: customerId }).whereNull('deleted_at');
  if (forUpdate) query.forUpdate();
  const row = await query.first();
  if (!row) return null;
  return require('./customer-contact').withAccountPrimaryContact(row, { db: conn, rethrow: true });
}

// The consent-stamped slot contacts of this customer row. The account holder
// is never in this list.
function slotContacts(customer) {
  const { getAppointmentContacts, isServiceContactRole } = require('./customer-contact');
  return getAppointmentContacts(customer, { appointment_notify_primary: false })
    .filter((c) => isServiceContactRole(c.role));
}

// The contacts who get the report text, by the appointment-text rule. An
// opt-in read that fails THROWS (filterRecipientsByOptin would drop the
// contact, which reads the same as a contact who is not confirmed): the
// caller retries instead of deciding on an unknown.
async function confirmedContacts(customer, conn = db) {
  const slots = slotContacts(customer);
  if (!slots.length) return [];
  const { optinHeldPhoneKeys } = require('./recipient-optin');
  const held = (await optinHeldPhoneKeys([customer.id], { dbh: conn })).get(String(customer.id));
  return held ? slots.filter((c) => !held.has(phoneKey(c.phone))) : slots;
}

// The street the report is about: the visit's own address when it has one,
// else the profile's. A failed read throws (the wrong property's street on a
// valid link is worse than a retry).
async function streetAddress(conn, scheduledServiceId, customer) {
  if (scheduledServiceId) {
    const svc = await conn('scheduled_services').where({ id: scheduledServiceId }).first('service_address_line1');
    if (svc?.service_address_line1) return String(svc.service_address_line1).trim();
  }
  return String(customer.address_line1 || '').trim() || 'your property';
}

// Queue one scheduled text per confirmed contact. Returns how many rows were
// queued. Throws on a failed read or write (notifyContactsReportReady retries).
// `sourceKey`: `record:<service_records.id>` or `visit:<service_visits.id>`.
// `excludePhone`: the number the visit-complete text itself went to. It never
// gets the report text too (the combined-stop summary falls back to Contact 1
// when the account holder has no phone).
// `source`: what the link points at, for the send-time recheck:
// { visitId, summaryTokenHash } for a combined-stop summary.
async function queueContactReportTexts({ customerId, sourceKey, reportUrl, scheduledServiceId = null, notBefore = null, excludePhone = null, source = {} }) {
  if (!enabled() || !customerId || !sourceKey || !reportUrl) return 0;
  // The body is rendered BEFORE the transaction: the template read uses the
  // root pool, and a held transaction must never wait on a second connection.
  // The street comes from the visit and the profile row, which a contact save
  // does not change.
  const profile = await loadCustomer(customerId);
  if (!profile || !slotContacts(profile).length) return 0;
  const { renderSmsTemplate } = require('./sms-template-renderer');
  const { firstNameFrom, getServiceContactSlots } = require('./customer-contact');
  // The slot's OWN name: the contact list falls back to the account holder's
  // name for a nameless slot, and a contact must not be greeted by it.
  const slotName = (phone) => getServiceContactSlots(profile).find((slot) => phoneKey(slot.phone) === phoneKey(phone))?.name || '';
  const street = await streetAddress(db, scheduledServiceId, profile);
  // One body per slot contact (the greeting names the CONTACT, never the
  // account holder), keyed by phone. A template read that fails throws; a
  // missing or inactive row, or an edited body that lost {report_url}, is
  // "off" (the link is the message).
  const bodyByPhone = new Map();
  for (const contact of slotContacts(profile)) {
    const body = await renderSmsTemplate(TEMPLATE_KEY, {
      first_name: firstNameFrom(slotName(contact.phone)) || 'there',
      street_address: street,
      report_url: reportUrl,
    }, { workflow: TEMPLATE_KEY, entity_type: 'customer', entity_id: customerId }, { throwOnError: true, requiredVars: ['report_url'] });
    if (!body || !body.includes(reportUrl)) return 0;
    bodyByPhone.set(phoneKey(contact.phone), body);
  }
  return db.transaction(async (trx) => {
    // The contact-save lock (routes/notifications.js): the contact list
    // cannot change between this read and the queue rows.
    const customer = await loadCustomer(customerId, trx, { forUpdate: true });
    if (!customer) return 0;
    const contacts = (await confirmedContacts(customer, trx))
      .filter((c) => phoneKey(c.phone) && phoneKey(c.phone) !== phoneKey(excludePhone));
    if (!contacts.length) return 0;
    const fromPhone = require('../config/twilio-numbers').getOutboundNumber();
    let queued = 0;
    for (const contact of contacts) {
      // A contact added after the bodies were rendered has none: skipped
      // (they were not a contact when this visit's text went out).
      const body = bodyByPhone.get(phoneKey(contact.phone));
      if (!body) continue;
      const reportKey = `${sourceKey}:${phoneKey(contact.phone)}`;
      const existing = await trx('sms_log')
        .where({ customer_id: customerId, message_type: MESSAGE_TYPE })
        .whereRaw("metadata->>'contact_report_key' = ?", [reportKey])
        .first('id');
      if (existing) continue;
      await trx('sms_log').insert({
        customer_id: customerId,
        direction: 'outbound',
        from_phone: fromPhone,
        // The row belongs to the CONTACT's phone, frozen here: no
        // refresh_customer_phone (a send-time swap to the account holder
        // would misdeliver). The recheck proves the phone is still a
        // confirmed contact.
        to_phone: contact.phone,
        message_body: body,
        status: 'scheduled',
        scheduled_for: notBefore ? new Date(notBefore) : new Date(),
        message_type: MESSAGE_TYPE,
        metadata: JSON.stringify({
          entry_point: ENTRY_POINT,
          // A worker that does not know this entry refuses the row
          // (dispatchDeferredReplay) instead of sending it unchecked.
          requires_registered_dispatch: true,
          contact_report_key: reportKey,
          contact_report_source: String(sourceKey),
          contact_report_queued_at: new Date().toISOString(),
          ...(source.visitId ? { visit_id: source.visitId, summary_token_hash: source.summaryTokenHash || null } : {}),
          ...(scheduledServiceId ? { scheduled_service_id: scheduledServiceId } : {}),
          template_key: TEMPLATE_KEY,
          appointment_contact_role: contact.role || null,
          replay_purpose: 'service_completion',
          resolve_from_by_customer: true,
        }),
      });
      queued += 1;
    }
    return queued;
  });
}

// The hook for a visit-complete text that went out. Never throws. The queue
// write is the durable intent, so a failed one is retried here (the report
// key makes a repeat safe). The closeout has already recorded its own text
// and will not come back: if every try fails, the contact text for this
// report is lost and the error log says so.
const QUEUE_RETRY_DELAYS_MS = [250, 1000];
async function notifyContactsReportReady(args, { delaysMs = QUEUE_RETRY_DELAYS_MS } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await queueContactReportTexts(args);
    } catch (err) {
      // Ids and an error code only: a query error can carry the bound phone
      // and the bearer report link.
      if (attempt >= delaysMs.length) {
        logger.error(`[contact-report-text] queue failed for ${args?.sourceKey || 'unknown'} after ${attempt + 1} tries (${err.code || err.name || 'error'}); contact report text not sent`);
        return 0;
      }
      await new Promise((resolve) => { setTimeout(resolve, delaysMs[attempt]); });
    }
  }
}

// Is this queued text still right to send? Run by the scheduled-SMS executor
// before the send and again at the provider boundary (registry entry
// contact_report_ready_deferred). `meta` carries the row's customer_id and
// to_phone (the executor merges them in). A failed read THROWS: the registry
// maps that to a bounded retry, never to a send or a permanent drop.
async function recheckContactReportText(meta = {}, { conn = db } = {}) {
  if (!enabled()) return { eligible: false, reason: 'contact-report-gate-off' };
  const queuedAt = Date.parse(meta.contact_report_queued_at || '');
  if (Number.isFinite(queuedAt) && Date.now() - queuedAt > EXPIRE_MS) return { eligible: false, reason: 'contact-report-expired' };
  if (!meta.customer_id || !meta.to_phone) return { eligible: false, reason: 'contact-report-recipient-missing' };
  // A combined-stop summary link: the summary must still be the one issued
  // and not revoked (the predicate its own queued text uses).
  if (meta.visit_id) {
    // In the locked handoff the visit row is held FOR SHARE through the
    // provider request, as the summary's own handoff holds it: a revoke
    // either commits first (refused here) or waits for the request.
    const visitQuery = conn('service_visits')
      .where({ id: meta.visit_id, summary_token_hash: meta.summary_token_hash || null })
      .whereNull('summary_token_revoked_at');
    if (conn.isTransaction) visitQuery.forShare();
    const visit = await visitQuery.first('id');
    if (!visit) return { eligible: false, reason: 'contact-report-summary-revoked' };
  }
  const customer = await loadCustomer(meta.customer_id, conn);
  if (!customer) return { eligible: false, reason: 'customer-missing' };
  const stillConfirmed = (await confirmedContacts(customer, conn)).some((c) => phoneKey(c.phone) === phoneKey(meta.to_phone));
  if (!stillConfirmed) return { eligible: false, reason: 'contact-removed' };
  return { eligible: true };
}

module.exports = {
  TEMPLATE_KEY,
  MESSAGE_TYPE,
  ENTRY_POINT,
  enabled,
  confirmedContacts,
  queueContactReportTexts,
  notifyContactsReportReady,
  recheckContactReportText,
};
