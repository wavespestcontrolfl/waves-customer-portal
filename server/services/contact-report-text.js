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
// (customer-contact.js getAppointmentContacts + recipient-optin.js
// filterRecipientsByOptin).
//
// contact_report_texts is the ledger: UNIQUE (source_key, phone_key) makes it
// one text per contact per report. A row is claimed by a 10-minute lease
// before the send, and send_started_at is stamped just before the sender
// call. A claim that died before that stamp is retried; one that died after
// it, like any ambiguous provider failure, settles as unknown_delivery and is
// never retried (the provider may hold the text).
const db = require('../models/db');
const logger = require('./logger');

const TEMPLATE_KEY = 'contact_report_ready';
const LEASE_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
// A report older than this is not announced any more.
const EXPIRE_MS = 24 * 60 * 60 * 1000;

function enabled() {
  return require('../config/feature-gates').contactReportTextLive();
}

function phoneKey(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

// The contacts who get the report text for this customer row, by the
// appointment-text rule. The account holder is never in this list.
async function confirmedContacts(customer) {
  const { getAppointmentContacts, isServiceContactRole } = require('./customer-contact');
  const { filterRecipientsByOptin } = require('./recipient-optin');
  const slots = getAppointmentContacts(customer, { appointment_notify_primary: false })
    .filter((c) => isServiceContactRole(c.role));
  if (!slots.length) return [];
  return filterRecipientsByOptin(slots, customer.id);
}

// The customer row the contact rule reads. A secondary profile with no phone
// of its own takes the account primary's, so the account holder's number in a
// contact slot is still recognized as the holder's and never texted twice.
// An unreadable account primary throws (the caller retries).
async function loadCustomer(customerId) {
  const row = await db('customers').where({ id: customerId }).whereNull('deleted_at').first();
  if (!row) return null;
  return require('./customer-contact').withAccountPrimaryContact(row, { rethrow: true });
}

// Record one pending text per confirmed contact. Returns the new row ids.
// `sourceKey`: `record:<service_records.id>` or `visit:<service_visits.id>`.
async function queueContactReportTexts({ customerId, sourceKey, reportUrl, scheduledServiceId = null, notBefore = null }) {
  if (!enabled() || !customerId || !sourceKey || !reportUrl) return [];
  const customer = await loadCustomer(customerId);
  if (!customer) return [];
  const contacts = await confirmedContacts(customer);
  const ids = [];
  for (const contact of contacts) {
    const key = phoneKey(contact.phone);
    if (!key) continue;
    const inserted = await db('contact_report_texts').insert({
      customer_id: customerId,
      source_key: String(sourceKey).slice(0, 80),
      scheduled_service_id: scheduledServiceId || null,
      phone_key: key,
      phone_e164: String(contact.phone).trim().slice(0, 20),
      report_url: reportUrl,
      not_before: notBefore || null,
    }).onConflict(['source_key', 'phone_key']).ignore().returning('id');
    for (const row of inserted || []) ids.push(row.id || row);
  }
  return ids;
}

// Every write after the claim is fenced to it (pending, same claimed_at): a
// dispatch that stalled past its lease writes nothing over the dispatch that
// took the row since.
function claimedRow(row) {
  return db('contact_report_texts').where({ id: row.id, status: 'pending', claimed_at: row.claimed_at });
}

async function settle(row, status, reason = null, extra = {}) {
  await claimedRow(row).update({
    status, status_reason: reason ? String(reason).slice(0, 80) : null, claimed_at: null, updated_at: new Date(), ...extra,
  });
}

// Back to pending for a later sweep (a retryable block, or the send window).
// Only for an outcome that proves the provider got nothing.
async function release(row, reason, notBefore = null) {
  if (row.attempts >= MAX_ATTEMPTS) return settle(row, 'failed', `retries_exhausted:${reason}`);
  return settle(row, 'pending', reason, { not_before: notBefore || null, send_started_at: null });
}

async function streetAddress(row, customer) {
  if (row.scheduled_service_id) {
    const svc = await db('scheduled_services').where({ id: row.scheduled_service_id }).first('service_address_line1').catch(() => null);
    if (svc?.service_address_line1) return String(svc.service_address_line1).trim();
  }
  return String(customer.address_line1 || '').trim() || 'your property';
}

// Claim one pending row and send it. Never throws.
async function dispatchContactReportText(id) {
  let row = null;
  let handedToSender = false;
  try {
    const now = new Date();
    const claimed = await db('contact_report_texts')
      .where({ id, status: 'pending' })
      // A row whose earlier claim reached the sender is not sendable again.
      .whereNull('send_started_at')
      .where((q) => q.whereNull('claimed_at').orWhere('claimed_at', '<', new Date(now.getTime() - LEASE_MS)))
      .where((q) => q.whereNull('not_before').orWhere('not_before', '<=', now))
      .update({ claimed_at: now, attempts: db.raw('attempts + 1'), updated_at: now })
      .returning('*');
    row = claimed && claimed[0];
    if (!row) return { state: 'not_claimed' };

    if (!enabled()) { await settle(row, 'suppressed', 'gate_off'); return { state: 'suppressed' }; }
    if (now.getTime() - new Date(row.created_at).getTime() > EXPIRE_MS) {
      await settle(row, 'suppressed', 'expired');
      return { state: 'suppressed' };
    }
    // The contact list is read again at the send: a contact removed, or one
    // who replied STOP to the opt-in ask since the queue, gets nothing.
    const customer = await loadCustomer(row.customer_id);
    const stillConfirmed = customer
      && (await confirmedContacts(customer)).some((c) => phoneKey(c.phone) === row.phone_key);
    if (!stillConfirmed) { await settle(row, 'suppressed', 'contact_not_confirmed'); return { state: 'suppressed' }; }

    const { renderSmsTemplate } = require('./sms-template-renderer');
    const body = await renderSmsTemplate(TEMPLATE_KEY, {
      street_address: await streetAddress(row, customer),
      report_url: row.report_url,
      // A template read that fails throws (the row is released for a retry);
      // only a missing or inactive row reads as off.
    }, { workflow: TEMPLATE_KEY, entity_type: 'customer', entity_id: row.customer_id }, { throwOnError: true });
    if (!body) { await settle(row, 'suppressed', 'template_off'); return { state: 'suppressed' }; }

    // Stamped under the claim, before the provider can be reached. A claim
    // lost to another dispatch (lease expired meanwhile) sends nothing.
    const started = await claimedRow(row).update({ send_started_at: new Date(), updated_at: new Date() });
    if (!started) return { state: 'not_claimed' };
    handedToSender = true;
    const result = await require('./messaging/send-customer-message').sendCustomerMessage({
      channel: 'sms', audience: 'customer', purpose: 'service_completion',
      to: row.phone_e164, customerId: row.customer_id,
      ...(row.scheduled_service_id ? { appointmentId: row.scheduled_service_id } : {}),
      body,
      identityTrustLevel: 'service_contact_authorized', entryPoint: 'contact_report_text',
      // Its own message type: no push routing, and the office reads what it is.
      metadata: { original_message_type: 'contact_report_ready', templateKey: TEMPLATE_KEY, contact_report_text_id: row.id },
    });
    if (result?.sent) {
      await settle(row, 'sent', null, { sent_at: new Date() });
      return { state: 'sent' };
    }
    if (result?.code === 'QUIET_HOURS_HOLD' && result.nextAllowedAt) {
      // The send window: the row waits; this attempt does not count.
      await claimedRow(row).update({
        status: 'pending', status_reason: 'send_window', claimed_at: null, send_started_at: null, attempts: db.raw('GREATEST(attempts - 1, 0)'),
        not_before: new Date(result.nextAllowedAt), updated_at: new Date(),
      });
      return { state: 'deferred' };
    }
    if (result?.blocked) {
      // Refused before the provider request: safe to retry when retryable.
      if (result.retryable || result.code === 'CONSENT_LOOKUP_FAILED') {
        await release(row, result.code || 'retryable_block');
        return { state: 'retry' };
      }
      await settle(row, 'suppressed', result.code || result.reason || 'blocked');
      return { state: 'suppressed' };
    }
    if (result?.terminal === true) {
      // A definitive provider rejection: nothing was accepted.
      await settle(row, 'failed', result.providerErrorCode || result.code || 'provider_rejected');
      return { state: 'failed' };
    }
    await settle(row, 'unknown_delivery', result?.providerErrorCode || result?.code || 'provider_failure');
    return { state: 'unknown_delivery' };
  } catch (err) {
    // Ids and an error code only: a query error can carry the bound phone and
    // the bearer report link.
    logger.warn(`[contact-report-text] dispatch failed for row ${id} (${err.code || err.name || 'error'})`);
    if (row) {
      // Past the sender call the provider may hold the text: never retry.
      await (handedToSender ? settle(row, 'unknown_delivery', 'sender_threw') : release(row, 'dispatch_error')).catch(() => {});
    }
    return { state: 'error' };
  }
}

// The hook for a visit-complete text that went out. Never throws and never
// blocks the closeout on a provider call: the texts dispatch in the
// background, and the sweep picks up what a restart drops.
async function notifyContactsReportReady(args) {
  try {
    const ids = await queueContactReportTexts(args);
    if (ids.length) {
      void (async () => { for (const id of ids) await dispatchContactReportText(id); })();
    }
    return ids.length;
  } catch (err) {
    logger.warn(`[contact-report-text] queue failed for ${args?.sourceKey || 'unknown'} (${err.code || err.name || 'error'})`);
    return 0;
  }
}

// Cron sweep: pending rows no live dispatch owns.
async function sweepContactReportTexts({ limit = 25 } = {}) {
  if (!enabled()) return { dispatched: 0 };
  const now = new Date();
  // A claim that reached the sender and then died: the provider may hold the
  // text, so it settles for the office and is never sent again.
  await db('contact_report_texts')
    .where({ status: 'pending' })
    .whereNotNull('send_started_at')
    .where('claimed_at', '<', new Date(now.getTime() - LEASE_MS))
    .update({ status: 'unknown_delivery', status_reason: 'dispatch_interrupted', claimed_at: null, updated_at: now });
  const rows = await db('contact_report_texts')
    .where({ status: 'pending' })
    .whereNull('send_started_at')
    .where((q) => q.whereNull('claimed_at').orWhere('claimed_at', '<', new Date(now.getTime() - LEASE_MS)))
    .where((q) => q.whereNull('not_before').orWhere('not_before', '<=', now))
    .orderBy('created_at', 'asc')
    .limit(limit)
    .select('id');
  let dispatched = 0;
  for (const row of rows) {
    const outcome = await dispatchContactReportText(row.id);
    if (outcome.state !== 'not_claimed') dispatched += 1;
  }
  return { dispatched };
}

module.exports = {
  TEMPLATE_KEY,
  enabled,
  confirmedContacts,
  queueContactReportTexts,
  dispatchContactReportText,
  notifyContactsReportReady,
  sweepContactReportTexts,
};
