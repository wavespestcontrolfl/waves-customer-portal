/**
 * Manual prep-guide send (admin Communications page "Send flea prep" button).
 *
 * Mirrors the automated appointment-tagger prep, but deliberately bypasses the
 * first-time-only and booking-dedupe guards: an operator clicking the button
 * wants prep sent NOW for this customer, regardless of prior visits or whether
 * an automated send already fired. It is the manual escape hatch for the case
 * where the automated prep was skipped (e.g. a phone-only booking).
 *
 * Smart channel (owner directive 2026-07-11):
 *   • customer has an email on file → email the formatted prep guide AND the
 *     companion text (matches the automated first-time experience).
 *   • no email → send the self-contained prep text that carries the steps
 *     inline (auto_*_no_email), so phone-only customers still get prep.
 *
 * "Flea only for now": PREP_CONFIG carries bed bug / cockroach too (their
 * templates already exist), but the Communications route allow-lists flea —
 * enabling another pest is a one-line change there.
 */

const db = require('../models/db');
const logger = require('./logger');
const EmailTemplateLibrary = require('./email-template-library');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { renderSmsTemplate } = require('./sms-template-renderer');
const { resolveProjectEmailRecipient } = require('./project-email');
const { portalUrl } = require('../utils/portal-url');
const { formatDisplayDate } = require('../utils/date-only');
const { WAVES_SUPPORT_PHONE_DISPLAY } = require('../constants/business');

const CONTACT_EMAIL = 'contact@wavespestcontrol.com';
const SERVICE_GROUP = 'service_operational';

const PREP_CONFIG = Object.freeze({
  flea: {
    label: 'Flea Treatment',
    serviceKeyword: 'flea',
    emailTemplateKey: 'prep.flea',
    smsCompanionKey: 'auto_flea',
    smsStandaloneKey: 'auto_flea_no_email',
  },
  bed_bug: {
    label: 'Bed Bug Treatment',
    serviceKeyword: 'bed bug',
    emailTemplateKey: 'prep.bed_bug',
    smsCompanionKey: 'auto_bed_bug',
    smsStandaloneKey: 'auto_bed_bug_no_email',
  },
  cockroach: {
    label: 'Cockroach Treatment',
    serviceKeyword: 'roach',
    emailTemplateKey: 'prep.cockroach',
    smsCompanionKey: 'auto_cockroach',
    smsStandaloneKey: 'auto_cockroach_no_email',
  },
});

function isSupportedPestType(pestType) {
  return Object.prototype.hasOwnProperty.call(PREP_CONFIG, pestType);
}

// Soonest upcoming visit of this pest family, so the emailed guide's "Service
// date" row references the real appointment. Blank (optional field) when there
// is no matching upcoming visit.
async function nextServiceDate(customerId, serviceKeyword) {
  try {
    const row = await db('scheduled_services')
      .where({ customer_id: customerId })
      .whereRaw('LOWER(service_type) LIKE ?', [`%${serviceKeyword}%`])
      .whereNotIn('status', ['cancelled', 'completed', 'rescheduled', 'skipped', 'no_show'])
      .where('scheduled_date', '>=', db.raw('CURRENT_DATE'))
      .orderBy('scheduled_date', 'asc')
      .first('scheduled_date');
    return row?.scheduled_date ? formatDisplayDate(row.scheduled_date, { fallback: '' }) : '';
  } catch (err) {
    logger.warn(`[prep-guide-sender] next-visit lookup failed for customer ${customerId}: ${err.message}`);
    return '';
  }
}

async function sendPrepEmail({ customer, recipient, firstName, config }) {
  try {
    const portalVisitsUrl = portalUrl('/?tab=visits');
    const address = [customer.address_line1, customer.city, customer.state, customer.zip]
      .map((v) => String(v || '').trim()).filter(Boolean).join(', ');
    const serviceDate = await nextServiceDate(customer.id, config.serviceKeyword);
    const result = await EmailTemplateLibrary.sendTemplate({
      templateKey: config.emailTemplateKey,
      to: recipient.email,
      recipientType: 'customer',
      recipientId: customer.id,
      suppressionGroupKey: SERVICE_GROUP,
      categories: ['project_prep', 'manual_prep', `prep_${config.emailTemplateKey.replace(/\./g, '_')}`],
      triggerEventId: `manual_prep:${customer.id}:${config.emailTemplateKey}`,
      payload: {
        first_name: firstName,
        customer_name: [customer.first_name, customer.last_name].map((v) => String(v || '').trim()).filter(Boolean).join(' '),
        project_type: config.label,
        service_date: serviceDate,
        property_address: address,
        customer_portal_url: portalVisitsUrl,
        prep_url: portalVisitsUrl,
        company_phone: WAVES_SUPPORT_PHONE_DISPLAY,
        company_email: CONTACT_EMAIL,
      },
    });
    return !!result?.sent;
  } catch (err) {
    logger.error(`[prep-guide-sender] email send failed for customer ${customer.id}: ${err.message}`);
    return false;
  }
}

async function sendPrepSms({ customer, firstName, phone, templateKey, pestType, actorId }) {
  const body = await renderSmsTemplate(templateKey, { first_name: firstName }, {
    workflow: 'manual_prep_send', entity_type: 'customer', entity_id: customer.id,
  });
  if (!body) {
    logger.warn(`[prep-guide-sender] ${templateKey} template missing/disabled; SMS skipped for customer ${customer.id}`);
    return false;
  }
  const res = await sendCustomerMessage({
    to: phone,
    body,
    channel: 'sms',
    audience: 'customer',
    purpose: 'appointment',
    customerId: customer.id,
    identityTrustLevel: 'phone_matches_customer',
    metadata: {
      original_message_type: 'prep_info',
      pest_type: pestType,
      prep_variant: templateKey.endsWith('_no_email') ? 'standalone' : 'companion',
      manual: true,
      actor_id: actorId || undefined,
    },
  });
  if (!res.sent) {
    logger.warn(`[prep-guide-sender] prep SMS not sent for customer ${customer.id}: ${res.code || res.reason || 'unknown'}`);
    return false;
  }
  return true;
}

// Sends prep to a customer via the smart channel. Returns a structured result
// the route turns into an operator-facing message. Never throws — every failure
// surfaces as { ok: false, reason }.
async function sendPrepToCustomer({ customerId, pestType = 'flea', actorId = null } = {}) {
  const config = PREP_CONFIG[pestType];
  if (!config) return { ok: false, reason: 'unsupported_pest_type', pestType };

  const customer = await db('customers').where({ id: customerId }).whereNull('deleted_at').first();
  if (!customer) return { ok: false, reason: 'customer_not_found', pestType };

  const recipient = resolveProjectEmailRecipient(customer);
  const firstName = String(recipient.name || customer.first_name || '').trim().split(/\s+/)[0] || 'there';
  const phone = String(customer.phone || '').trim();

  const result = {
    ok: false,
    pestType,
    label: config.label,
    emailSent: false,
    smsSent: false,
    emailAddress: recipient.email || null,
    phone: phone || null,
  };

  if (recipient.email) {
    result.emailSent = await sendPrepEmail({ customer, recipient, firstName, config });
    if (phone) {
      result.smsSent = await sendPrepSms({ customer, firstName, phone, templateKey: config.smsCompanionKey, pestType, actorId });
    }
  } else if (phone) {
    result.smsSent = await sendPrepSms({ customer, firstName, phone, templateKey: config.smsStandaloneKey, pestType, actorId });
  } else {
    return { ...result, reason: 'no_email_or_phone' };
  }

  result.ok = result.emailSent || result.smsSent;
  if (!result.ok) result.reason = 'send_failed';

  if (result.ok) {
    try {
      await db('customer_interactions').insert({
        customer_id: customer.id,
        interaction_type: result.emailSent ? 'email_outbound' : 'sms_outbound',
        subject: `${config.label} prep sent (manual)`,
        body: `Prep sent manually via Communications — ${[
          result.emailSent ? `email to ${recipient.email}` : null,
          result.smsSent ? `text to ${phone}` : null,
        ].filter(Boolean).join(' + ')}.`,
      });
    } catch (err) {
      logger.warn(`[prep-guide-sender] interaction log failed for customer ${customer.id}: ${err.message}`);
    }
  }

  return result;
}

module.exports = { sendPrepToCustomer, isSupportedPestType, PREP_CONFIG };
