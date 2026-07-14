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
 * The Communications route allow-lists every PREP_CONFIG pest (flea, bed
 * bug, cockroach) — see admin-communications.js. Wire a new pest by adding
 * its config here.
 */

const db = require('../models/db');
const logger = require('./logger');
const EmailTemplateLibrary = require('./email-template-library');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { renderSmsTemplate } = require('./sms-template-renderer');
const { resolveProjectEmailRecipient, ensureServicePrepToken } = require('./project-email');
const { portalUrl } = require('../utils/portal-url');
const { formatDisplayDate } = require('../utils/date-only');
const { etDateString } = require('../utils/datetime-et');
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
// date" row references the real appointment and the prep token can hang off
// the visit row. Null when there is no matching upcoming visit.
async function nextUpcomingVisit(customerId, serviceKeyword) {
  try {
    const row = await db('scheduled_services')
      .where({ customer_id: customerId })
      .whereRaw('LOWER(service_type) LIKE ?', [`%${serviceKeyword}%`])
      .whereNotIn('status', ['cancelled', 'completed', 'rescheduled', 'skipped', 'no_show'])
      // ET, not CURRENT_DATE: the DB session runs UTC, so between ~8pm and
      // midnight ET "today's" visit would fall before the UTC date and the
      // email would say "To be confirmed" despite a real upcoming appointment.
      .where('scheduled_date', '>=', etDateString())
      .orderBy('scheduled_date', 'asc')
      .first('id', 'scheduled_date');
    return row || null;
  } catch (err) {
    logger.warn(`[prep-guide-sender] next-visit lookup failed for customer ${customerId}: ${err.message}`);
    return null;
  }
}

async function sendPrepEmail({ customer, recipient, firstName, config }) {
  try {
    const portalVisitsUrl = portalUrl('/?tab=visits');
    const address = [customer.address_line1, customer.city, customer.state, customer.zip]
      .map((v) => String(v || '').trim()).filter(Boolean).join(', ');
    // service_date is a REQUIRED prep-template var (PREP_REQUIRED in
    // 20260526000014) — sendTemplate rejects an empty one. Fall back to a
    // non-empty placeholder when the customer has no matching upcoming visit.
    const visit = await nextUpcomingVisit(customer.id, config.serviceKeyword);
    const serviceDate = (visit?.scheduled_date
      ? formatDisplayDate(visit.scheduled_date, { fallback: '' }) : '') || 'To be confirmed';
    // Tokened public prep page when a real visit exists to hang it on; a
    // customer with no matching upcoming visit keeps the portal link (there
    // is no appointment for the page to describe). Mint fails soft.
    let prepUrl = portalVisitsUrl;
    if (visit?.id) {
      try {
        prepUrl = portalUrl(`/prep/${await ensureServicePrepToken(visit.id, config.emailTemplateKey)}`);
      } catch (tokenErr) {
        logger.warn(`[prep-guide-sender] prep token mint failed for service ${visit.id}: ${tokenErr.message}`);
      }
    }
    const result = await EmailTemplateLibrary.sendTemplate({
      templateKey: config.emailTemplateKey,
      to: recipient.email,
      recipientType: 'customer',
      recipientId: customer.id,
      suppressionGroupKey: SERVICE_GROUP,
      categories: ['project_prep', 'manual_prep', `prep_${config.emailTemplateKey.replace(/\./g, '_')}`],
      triggerEventId: `manual_prep:${customer.id}:${config.emailTemplateKey}`,
      // Provider rejections can echo the recipient address; keep the raw
      // SendGrid body out of the logs (email addresses in logs are a P1).
      suppressProviderErrorLog: true,
      payload: {
        first_name: firstName,
        customer_name: [customer.first_name, customer.last_name].map((v) => String(v || '').trim()).filter(Boolean).join(' '),
        project_type: config.label,
        service_date: serviceDate,
        property_address: address,
        customer_portal_url: portalVisitsUrl,
        prep_url: prepUrl,
        company_phone: WAVES_SUPPORT_PHONE_DISPLAY,
        company_email: CONTACT_EMAIL,
      },
    });
    if (result?.sent && visit?.id) {
      // The track page gates its prep link on prep_sent_at — the token is
      // minted before this send, so only a confirmed send stamps it.
      await db('scheduled_services')
        .where({ id: visit.id })
        .update({ prep_sent_at: db.fn.now() })
        .catch((stampErr) => logger.warn(`[prep-guide-sender] prep_sent_at stamp failed for service ${visit.id}: ${stampErr.message}`));
    }
    return !!result?.sent;
  } catch (err) {
    // Sanitized: never log err.message — provider errors can carry the email.
    logger.error(`[prep-guide-sender] email send failed for customer ${customer.id} (${err?.name || 'Error'})`);
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
      // adminUserId is the key the Twilio send path forwards into
      // sms_log.admin_user_id — keeps the manual send attributed to the
      // operator instead of reading as system-authored.
      adminUserId: actorId || undefined,
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
  // The email greets the resolved recipient (which may be a service contact);
  // the SMS greets the phone owner — customer.phone is the primary's line — so
  // it must use the customer's own first name, not the service contact's.
  const emailFirstName = String(recipient.name || customer.first_name || '').trim().split(/\s+/)[0] || 'there';
  const smsFirstName = String(customer.first_name || '').trim().split(/\s+/)[0] || 'there';
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
    result.emailSent = await sendPrepEmail({ customer, recipient, firstName: emailFirstName, config });
    if (phone) {
      // The companion text claims "we emailed your guide" — only send it when
      // the email actually went out. If the email was suppressed or failed,
      // fall back to the self-contained steps so the customer still gets real
      // prep instructions instead of a text pointing at a guide that never came.
      const templateKey = result.emailSent ? config.smsCompanionKey : config.smsStandaloneKey;
      result.smsSent = await sendPrepSms({ customer, firstName: smsFirstName, phone, templateKey, pestType, actorId });
    }
  } else if (phone) {
    result.smsSent = await sendPrepSms({ customer, firstName: smsFirstName, phone, templateKey: config.smsStandaloneKey, pestType, actorId });
  } else {
    return { ...result, reason: 'no_email_or_phone' };
  }

  result.ok = result.emailSent || result.smsSent;
  if (!result.ok) result.reason = 'send_failed';

  if (result.ok) {
    try {
      // When the SMS went out, write the SAME marker the appointment tagger's
      // replay guard (hasSentPrepSms) looks for — sms_outbound +
      // "<pestType> prep info sent" — so a later replay of onServiceScheduled
      // (e.g. regenerate-brief) doesn't re-text prep this manual click already
      // delivered. Email-only sends keep the descriptive manual subject.
      await db('customer_interactions').insert({
        customer_id: customer.id,
        interaction_type: result.smsSent ? 'sms_outbound' : 'email_outbound',
        admin_user_id: actorId || null,
        subject: result.smsSent ? `${pestType} prep info sent` : `${config.label} prep sent (manual)`,
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
