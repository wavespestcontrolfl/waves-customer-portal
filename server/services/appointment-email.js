/**
 * Appointment email fallback.
 *
 * Appointment notifications are SMS-first (see services/appointment-reminders.js
 * and services/twilio.js sendTechEnRoute). When the SMS cannot be delivered —
 * landline / carrier-undeliverable / no mobile on file / blocked — these helpers
 * send the same information by email instead so the customer is not left with no
 * notice at all.
 *
 * Templates (seeded by 20260616000002_seed_appointment_email_templates.js):
 *   appointment.confirmation
 *   appointment.reminder_72h
 *   appointment.reminder_24h
 *   appointment.en_route
 *
 * All four are required transactional notices (suppression group
 * transactional_required) so appointment info reaches the customer even if they
 * have unsubscribed from marketing email. Mirrors account-membership-email.js.
 */

const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const EmailTemplateLibrary = require('./email-template-library');
const { getPrimaryContact, getAppointmentContacts, getServiceContactSlots, SERVICE_CONTACT_COLUMNS } = require('./customer-contact');
const { portalUrl: buildPortalUrl } = require('../utils/portal-url');
const { WAVES_SUPPORT_PHONE_DISPLAY } = require('../constants/business');
const { formatETDay, formatETDate, formatETTime } = require('../utils/datetime-et');

const CONTACT_EMAIL = 'contact@wavespestcontrol.com';
const TRANSACTIONAL_GROUP = 'transactional_required';

function clean(value) {
  return String(value || '').trim();
}

function firstToken(value) {
  return clean(value).split(/\s+/)[0] || '';
}

function isEmailLike(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(value).toLowerCase());
}

function fullName(customer = {}) {
  return [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim()
    || clean(customer.company_name)
    || clean(customer.first_name)
    || 'Waves customer';
}

function propertyLabel(customer = {}) {
  const label = clean(customer.profile_label);
  if (label) return label;
  // Full address incl. state + zip (owner call 07-06).
  const cityStateZip = [customer.city, [customer.state, customer.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const address = [customer.address_line1, cityStateZip].filter(Boolean).join(', ');
  return address || 'Service property';
}

function portalTabUrl(tab = 'visits') {
  return buildPortalUrl(`/?tab=${encodeURIComponent(tab || 'visits')}`);
}

async function loadCustomer(customerId) {
  if (!customerId) return null;
  return db('customers')
    .where({ id: customerId })
    .select(
      'id',
      'first_name',
      'last_name',
      'company_name',
      'email',
      'phone',
      'address_line1',
      'city',
      'state',
      'zip',
      'profile_label',
      // Service-contact slots so the email fallback can reach the same recipients
      // the appointment SMS targets (getAppointmentContacts reads these).
      ...SERVICE_CONTACT_COLUMNS,
    )
    .first();
}

// Resolve the email recipients for an appointment notice. Mirrors the SMS
// recipients: the appointment contacts (service contacts and/or primary, per
// getAppointmentContacts + notification_prefs.appointment_notify_primary), using
// each contact's own email (service_contact_email, falling back to the primary
// email inside getAppointmentContacts). De-duplicated by address. When there are
// no appointment phone contacts at all (e.g. email-only customer), falls back to
// the primary customer email so they still get the notice.
async function resolveRecipients(customer) {
  const prefs = await db('notification_prefs').where({ customer_id: customer.id }).first().catch(() => null);
  const seen = new Set();
  const recipients = [];
  const add = (email, name) => {
    const value = clean(email);
    const key = value.toLowerCase();
    if (isEmailLike(value) && !seen.has(key)) {
      seen.add(key);
      recipients.push({ email: value, name });
    }
  };
  // The SMS appointment recipients first (service contacts and/or primary).
  // A service contact's email inside getAppointmentContacts falls back to the
  // PRIMARY email when their slot has none — keep that delivery fallback (the
  // primary mailbox still gets the notice) but under the PRIMARY's name: a
  // greeting with the service contact's name on the primary's address
  // mislabels the email (phone-only buyer/tenant slots made this common).
  const primary = getPrimaryContact(customer);
  const slotEmailByRole = new Map(getServiceContactSlots(customer).map((s) => [s.role, s.email]));
  for (const c of getAppointmentContacts(customer, prefs || {})) {
    const ownEmail = slotEmailByRole.has(c.role) ? slotEmailByRole.get(c.role) : c.email;
    if (ownEmail) add(ownEmail, c.name);
    else add(primary.email, primary.name);
  }
  // A service-contact slot can carry an email WITHOUT a phone, so it never appears
  // in the SMS contact list above — include those addresses too so an email-only
  // service contact can still receive the notice.
  for (const slot of getServiceContactSlots(customer)) add(slot.email, slot.name);
  // Last resort: the primary customer email (e.g. email-only customer with no
  // appointment phone contacts at all).
  if (!recipients.length) {
    add(primary.email, primary.name);
  }
  return recipients;
}

async function logEmailAttempt({ customerId, templateKey, eventType, status, providerMessageId = null, sentAt = null, failureReason = null, metadata = {} }) {
  try {
    await db('customer_interactions').insert({
      customer_id: customerId,
      interaction_type: 'email_outbound',
      subject: `${eventType} email ${status}`,
      body: failureReason
        ? `${eventType} email ${status}: ${failureReason}`
        : `${eventType} email ${status}.`,
      metadata: JSON.stringify({
        customer_id: customerId,
        template_key: templateKey,
        channel: 'email',
        event_type: eventType,
        provider_message_id: providerMessageId,
        status,
        sent_at: sentAt,
        failure_reason: failureReason,
        ...metadata,
      }),
    });
  } catch (err) {
    logger.warn(`[appointment-email] audit log failed for ${eventType}/${customerId}: ${err.message}`);
  }
}

/**
 * Send a templated appointment email to the appointment contacts (the same
 * recipients the appointment SMS targets — service contacts and/or primary, each
 * using their own email). Fans out to every distinct address.
 * Returns:
 *   { ok: true, messageId }                        — sent to at least one recipient
 *   { ok: false, skipped: true, reason }           — no customer / no email on file
 *   { ok: false, blocked: true, reason }           — all recipients suppressed
 *   { ok: false, error }                           — threw
 */
async function sendTemplate({ customerId, templateKey, eventType, payload = {}, idempotencyKey, categories = [], triggerEventId, metadata = {}, recipientFilter = null }) {
  const customer = await loadCustomer(customerId);
  if (!customer) return { ok: false, skipped: true, reason: 'customer_not_found' };

  let recipients = await resolveRecipients(customer);
  // Optional allowlist of addresses: the call-booking confirmation fan-out
  // targets ONLY email-only service-contact slots (a phone-channel customer's
  // primary must not receive an email their channel choice didn't ask for) —
  // still resolved through resolveRecipients so names/dedup/suppression
  // semantics stay identical to a full send.
  if (Array.isArray(recipientFilter)) {
    const allow = new Set(recipientFilter.map((e) => String(e || '').trim().toLowerCase()).filter(Boolean));
    recipients = recipients.filter((r) => allow.has(r.email.toLowerCase()));
  }
  if (!recipients.length) {
    await logEmailAttempt({ customerId: customer.id, templateKey, eventType, status: 'skipped', failureReason: 'missing_email', metadata });
    return { ok: false, skipped: true, reason: 'missing_email' };
  }

  const builtCategories = [
    eventType.split('.')[0],
    eventType.replace(/[^a-zA-Z0-9_-]/g, '_'),
    ...categories,
  ];

  const outcomes = [];
  for (const recipient of recipients) {
    const firstName = firstToken(recipient.name) || firstToken(customer.first_name) || 'there';
    const finalPayload = {
      first_name: firstName,
      customer_name: fullName(customer),
      customer_portal_url: portalTabUrl('visits'),
      company_phone: WAVES_SUPPORT_PHONE_DISPLAY,
      company_email: CONTACT_EMAIL,
      property_label: propertyLabel(customer),
      ...payload,
    };
    // Per-recipient idempotency so a second recipient is not deduped against the
    // first. Hash the address to a bounded token — appending a full email could
    // exceed email_messages.idempotency_key (varchar 260) for long addresses.
    const recipientToken = crypto.createHash('sha256').update(recipient.email.toLowerCase()).digest('hex').slice(0, 16);
    const recipientKey = idempotencyKey ? `${idempotencyKey}:${recipientToken}` : undefined;
    try {
      const result = await EmailTemplateLibrary.sendTemplate({
        templateKey,
        to: recipient.email,
        payload: finalPayload,
        recipientType: 'customer',
        recipientId: customer.id,
        triggerEventId: triggerEventId || `${eventType}:${customer.id}`,
        idempotencyKey: recipientKey,
        categories: builtCategories,
        suppressionGroupKey: TRANSACTIONAL_GROUP,
      });
      outcomes.push(result);
      if (!result.deduped) {
        const status = result.sent ? 'sent' : result.blocked ? 'blocked' : 'failed';
        await logEmailAttempt({
          customerId: customer.id,
          templateKey,
          eventType,
          status,
          providerMessageId: result.message?.provider_message_id || null,
          sentAt: result.message?.sent_at || null,
          failureReason: result.sent ? null : result.reason || result.message?.error_message || 'email_not_sent',
          metadata,
        });
      }
    } catch (err) {
      outcomes.push({ error: err.message });
      await logEmailAttempt({ customerId: customer.id, templateKey, eventType, status: 'failed', failureReason: err.message, metadata });
      logger.error(`[appointment-email] ${eventType} failed for ${customer.id}: ${err.message}`);
    }
  }

  const sent = outcomes.find((o) => o?.sent);
  if (sent) return { ok: true, messageId: sent.message?.provider_message_id || null };
  if (outcomes.some((o) => o?.blocked)) return { ok: false, blocked: true, reason: 'suppressed' };
  const errored = outcomes.find((o) => o?.error);
  if (errored) return { ok: false, error: errored.error };
  return { ok: false, reason: outcomes.find((o) => o?.reason)?.reason || 'email_not_sent' };
}

function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  // Guard falsy values explicitly: new Date(null)/new Date(0) are valid 1970
  // dates, which would render a bogus "January 1, 1970" when an appointment row
  // can't be reconstructed. Treat missing as missing so the fields stay blank.
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// A token for the specific appointment instance (time), so a reschedule that
// re-arms the same scheduled_service_id produces a new idempotency key and the
// updated email is not deduped against the prior send.
function apptStamp(apptTime) {
  return apptTime ? String(apptTime.getTime()) : 'na';
}

async function sendAppointmentConfirmationEmail({ customerId, scheduledServiceId, appointmentTime, serviceLabel, rescheduleUrl, idempotencyKey, recipientFilter = null } = {}) {
  const apptTime = toDate(appointmentTime);
  return sendTemplate({
    customerId,
    recipientFilter,
    templateKey: 'appointment.confirmation',
    eventType: 'appointment.confirmation',
    payload: {
      service_type: clean(serviceLabel) || 'service',
      appointment_day: apptTime ? formatETDay(apptTime) : '',
      appointment_date: apptTime ? formatETDate(apptTime) : '',
      appointment_time: apptTime ? formatETTime(apptTime) : '',
      // Empty string hides the template's "Reschedule appointment" CTA block
      // (renderBlocks skips a cta with no href) — never a broken button.
      reschedule_url: clean(rescheduleUrl),
    },
    idempotencyKey: idempotencyKey || `appointment.confirmation:${scheduledServiceId || customerId}:${apptStamp(apptTime)}`,
    categories: ['appointment_confirmation'],
    triggerEventId: `appointment.confirmation:${scheduledServiceId || customerId}`,
    metadata: { scheduled_service_id: scheduledServiceId || null },
  });
}

// Assigned tech's first name for the reminder details card — self-contained
// lookup so callers don't need to thread it; '' (suppressed row) when the
// visit is unassigned or the lookup fails.
async function technicianFirstName(scheduledServiceId) {
  if (!scheduledServiceId) return '';
  try {
    const row = await db('scheduled_services')
      .where({ 'scheduled_services.id': scheduledServiceId })
      .leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
      .first('technicians.name as tech_name');
    return firstToken(row?.tech_name);
  } catch {
    return '';
  }
}

// kind: '72h' | '24h'
async function sendAppointmentReminderEmail({ customerId, scheduledServiceId, appointmentTime, serviceLabel, kind, rescheduleUrl, idempotencyKey } = {}) {
  const apptTime = toDate(appointmentTime);
  const techName = await technicianFirstName(scheduledServiceId);
  const is72 = String(kind) === '72h';
  const templateKey = is72 ? 'appointment.reminder_72h' : 'appointment.reminder_24h';
  // Empty reschedule_url hides the template's "Reschedule appointment" CTA
  // block (renderBlocks skips a cta with no href) — never a broken button.
  const payload = is72
    ? {
      service_type: clean(serviceLabel) || 'service',
      appointment_day: apptTime ? formatETDay(apptTime) : '',
      appointment_date: apptTime ? formatETDate(apptTime) : '',
      appointment_time: apptTime ? formatETTime(apptTime) : '',
      technician_name: techName,
      reschedule_url: clean(rescheduleUrl),
    }
    : {
      service_type: clean(serviceLabel) || 'service',
      appointment_time: apptTime ? formatETTime(apptTime) : '',
      // The details card lists Date above Scheduled start (owner call
      // 2026-07-06 — if we show the start time, show the date too).
      appointment_date: apptTime ? formatETDate(apptTime) : '',
      // Composed clause for the 24h opening sentence (migration
      // 20260705010020): "…scheduled for tomorrow{{appointment_when}}."
      // Composed HERE so fallback sends with no reconstructable
      // appointment time degrade to the clean "…tomorrow." sentence
      // instead of stranding empty per-field variables in prose.
      appointment_when: apptTime
        ? `, ${formatETDay(apptTime)}, ${formatETDate(apptTime)}, starting at ${formatETTime(apptTime)}`
        : '',
      technician_name: techName,
      reschedule_url: clean(rescheduleUrl),
    };
  return sendTemplate({
    customerId,
    templateKey,
    eventType: templateKey,
    payload,
    idempotencyKey: idempotencyKey || `${templateKey}:${scheduledServiceId || customerId}:${apptStamp(apptTime)}`,
    categories: [is72 ? 'appointment_reminder_72h' : 'appointment_reminder_24h'],
    triggerEventId: `${templateKey}:${scheduledServiceId || customerId}`,
    metadata: { scheduled_service_id: scheduledServiceId || null },
  });
}

async function sendTechEnRouteEmail({ customerId, scheduledServiceId, techName, etaMinutes, trackUrl, idempotencyKey } = {}) {
  const eta = Number.parseInt(etaMinutes, 10);
  return sendTemplate({
    customerId,
    templateKey: 'appointment.en_route',
    eventType: 'appointment.en_route',
    payload: {
      tech_name: clean(techName) || 'Your technician',
      eta_minutes: Number.isFinite(eta) && eta > 0 ? String(eta) : 'a few',
      track_url: clean(trackUrl) || portalTabUrl('visits'),
    },
    idempotencyKey: idempotencyKey || `appointment.en_route:${scheduledServiceId || customerId}`,
    categories: ['appointment_en_route'],
    triggerEventId: `appointment.en_route:${scheduledServiceId || customerId}`,
    metadata: { scheduled_service_id: scheduledServiceId || null },
  });
}

// Email twin of the tech_arrived SMS — sent when the customer's Tech Arrived
// delivery channel is email/both (template seeded by 20260707000050).
async function sendTechArrivedEmail({ customerId, scheduledServiceId, techName, idempotencyKey } = {}) {
  return sendTemplate({
    customerId,
    templateKey: 'appointment.tech_arrived',
    eventType: 'appointment.tech_arrived',
    payload: {
      tech_name: clean(techName) || 'Your technician',
    },
    idempotencyKey: idempotencyKey || `appointment.tech_arrived:${scheduledServiceId || customerId}`,
    categories: ['appointment_tech_arrived'],
    triggerEventId: `appointment.tech_arrived:${scheduledServiceId || customerId}`,
    metadata: { scheduled_service_id: scheduledServiceId || null },
  });
}

/**
 * Missed-visit (no-show) email — the email twin of the appointment_no_show
 * SMS, fired from AppointmentReminders.handleNoShow. missedWhen arrives
 * pre-composed by the caller (same-day "today" vs "on Tuesday, July 8" for
 * back-dated marks — the SMS path already computes it). The charge line is
 * composed HERE from the fee outcome the dispatch route passes through, so
 * the email never claims "no charge" to a customer whose card hold was
 * charged the no-show fee.
 */
async function sendAppointmentNoShowEmail({
  customerId,
  scheduledServiceId,
  serviceLabel,
  missedWhen,
  noShowReason,
  feeOutcome,
  idempotencyKey,
} = {}) {
  // 'review' = the charge attempt hit an ambiguous Stripe error and was
  // parked for reconciliation — the fee may still have been accepted, so
  // neither "was charged" nor "no charge" is safe to claim.
  const chargeLine = feeOutcome === 'charged'
    ? 'Per your booking terms, the missed-visit fee was charged to your card on file — it will show on your emailed receipt.'
    : feeOutcome === 'review'
      ? 'If a missed-visit fee applies under your booking terms, it will appear on an emailed receipt.'
      : 'There’s no charge for the attempted visit.';
  return sendTemplate({
    customerId,
    templateKey: 'appointment.no_show',
    eventType: 'appointment.no_show',
    payload: {
      service_type: clean(serviceLabel) || 'service',
      missed_when: clean(missedWhen) || 'recently',
      no_show_reason: clean(noShowReason),
      charge_line: chargeLine,
      rebook_url: portalTabUrl('visits'),
    },
    idempotencyKey: idempotencyKey || `appointment.no_show:${scheduledServiceId || customerId}`,
    categories: ['appointment_no_show'],
    triggerEventId: `appointment.no_show:${scheduledServiceId || customerId}`,
    metadata: { scheduled_service_id: scheduledServiceId || null },
  });
}

module.exports = {
  sendAppointmentConfirmationEmail,
  sendAppointmentReminderEmail,
  sendAppointmentNoShowEmail,
  sendTechEnRouteEmail,
  sendTechArrivedEmail,
  _private: { sendTemplate, loadCustomer, resolveRecipients, isEmailLike, propertyLabel },
};
