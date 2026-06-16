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

const db = require('../models/db');
const logger = require('./logger');
const EmailTemplateLibrary = require('./email-template-library');
const { getPrimaryContact } = require('./customer-contact');
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
  const address = [customer.address_line1, customer.city].filter(Boolean).join(', ');
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
    )
    .first();
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
 * Send a templated appointment email to the customer's primary contact.
 * Returns:
 *   { ok: true, messageId }                        — sent
 *   { ok: false, skipped: true, reason }           — no customer / no email on file
 *   { ok: false, blocked: true, reason }           — suppressed / not sent
 *   { ok: false, error }                           — threw
 */
async function sendTemplate({ customerId, templateKey, eventType, payload = {}, idempotencyKey, categories = [], triggerEventId, metadata = {} }) {
  const customer = await loadCustomer(customerId);
  if (!customer) return { ok: false, skipped: true, reason: 'customer_not_found' };

  const contact = getPrimaryContact(customer);
  if (!isEmailLike(contact.email)) {
    await logEmailAttempt({ customerId: customer.id, templateKey, eventType, status: 'skipped', failureReason: 'missing_email', metadata });
    return { ok: false, skipped: true, reason: 'missing_email' };
  }

  const firstName = firstToken(contact.name) || firstToken(customer.first_name) || 'there';
  const finalPayload = {
    first_name: firstName,
    customer_name: fullName(customer),
    customer_portal_url: portalTabUrl('visits'),
    company_phone: WAVES_SUPPORT_PHONE_DISPLAY,
    company_email: CONTACT_EMAIL,
    property_label: propertyLabel(customer),
    ...payload,
  };

  try {
    const result = await EmailTemplateLibrary.sendTemplate({
      templateKey,
      to: contact.email,
      payload: finalPayload,
      recipientType: 'customer',
      recipientId: customer.id,
      triggerEventId: triggerEventId || `${eventType}:${customer.id}`,
      idempotencyKey,
      categories: [
        eventType.split('.')[0],
        eventType.replace(/[^a-zA-Z0-9_-]/g, '_'),
        ...categories,
      ],
      suppressionGroupKey: TRANSACTIONAL_GROUP,
    });

    if (result.deduped) {
      return { ok: !!result.sent, deduped: true, blocked: !!result.blocked, messageId: result.message?.provider_message_id || null };
    }

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

    return result.sent
      ? { ok: true, messageId: result.message?.provider_message_id || null }
      : { ok: false, blocked: !!result.blocked, reason: result.reason || 'email_not_sent' };
  } catch (err) {
    await logEmailAttempt({ customerId: customer.id, templateKey, eventType, status: 'failed', failureReason: err.message, metadata });
    logger.error(`[appointment-email] ${eventType} failed for ${customer.id}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

function toDate(value) {
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function sendAppointmentConfirmationEmail({ customerId, scheduledServiceId, appointmentTime, serviceLabel, idempotencyKey } = {}) {
  const apptTime = toDate(appointmentTime);
  return sendTemplate({
    customerId,
    templateKey: 'appointment.confirmation',
    eventType: 'appointment.confirmation',
    payload: {
      service_type: clean(serviceLabel) || 'service',
      appointment_day: apptTime ? formatETDay(apptTime) : '',
      appointment_date: apptTime ? formatETDate(apptTime) : '',
      appointment_time: apptTime ? formatETTime(apptTime) : '',
    },
    idempotencyKey: idempotencyKey || `appointment.confirmation:${scheduledServiceId || customerId}`,
    categories: ['appointment_confirmation'],
    triggerEventId: `appointment.confirmation:${scheduledServiceId || customerId}`,
    metadata: { scheduled_service_id: scheduledServiceId || null },
  });
}

// kind: '72h' | '24h'
async function sendAppointmentReminderEmail({ customerId, scheduledServiceId, appointmentTime, serviceLabel, kind, idempotencyKey } = {}) {
  const apptTime = toDate(appointmentTime);
  const is72 = String(kind) === '72h';
  const templateKey = is72 ? 'appointment.reminder_72h' : 'appointment.reminder_24h';
  const payload = is72
    ? {
      service_type: clean(serviceLabel) || 'service',
      appointment_day: apptTime ? formatETDay(apptTime) : '',
      appointment_date: apptTime ? formatETDate(apptTime) : '',
      appointment_time: apptTime ? formatETTime(apptTime) : '',
    }
    : {
      service_type: clean(serviceLabel) || 'service',
      appointment_time: apptTime ? formatETTime(apptTime) : '',
    };
  return sendTemplate({
    customerId,
    templateKey,
    eventType: templateKey,
    payload,
    idempotencyKey: idempotencyKey || `${templateKey}:${scheduledServiceId || customerId}`,
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

module.exports = {
  sendAppointmentConfirmationEmail,
  sendAppointmentReminderEmail,
  sendTechEnRouteEmail,
  _private: { sendTemplate, loadCustomer, isEmailLike, propertyLabel },
};
