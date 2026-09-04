/**
 * Manual prep-guide send (admin Communications page "Send flea prep" button).
 *
 * Mirrors the automated appointment-tagger prep, but deliberately bypasses the
 * first-time-only and booking-dedupe guards: an operator clicking the button
 * wants prep sent NOW for this customer, regardless of prior visits or whether
 * an automated send already fired. It is the manual escape hatch for the case
 * where the automated prep was skipped (e.g. a phone-only booking).
 *
 * Channel is the operator's choice (owner ruling 2026-09-03: text only,
 * email only, or both — replaces the 2026-07-11 smart channel):
 *   • email → the formatted prep guide email (prep.* template).
 *   • sms   → when a matching upcoming visit exists, a short text carrying
 *             the tokened /prep/:token guide page (auto_prep_guide_link —
 *             the same content as the email, with a PDF download);
 *             otherwise the pest's self-contained inline-steps text
 *             (auto_*_no_email, three pests) or reason no_upcoming_visit.
 *   • both  → email + the text above.
 *
 * The Communications route allow-lists every PREP_CONFIG pest — the eight
 * live prep.* guides (prep.wildlife stays archived: wildlife is a prohibited
 * Waves service, migration 20260707000002). Wire a new pest by adding its
 * config here.
 */

const db = require('../models/db');
const logger = require('./logger');
const EmailTemplateLibrary = require('./email-template-library');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { isRealProviderSend } = require('./sms-auto-send');
const { renderSmsTemplate } = require('./sms-template-renderer');
const { resolveProjectEmailRecipient, ensureServicePrepToken, markServicePrepSent } = require('./project-email');
const { portalUrl } = require('../utils/portal-url');
const { formatDisplayDate } = require('../utils/date-only');
const { etDateString } = require('../utils/datetime-et');
const { WAVES_SUPPORT_PHONE_DISPLAY } = require('../constants/business');

const CONTACT_EMAIL = 'contact@wavespestcontrol.com';
const SERVICE_GROUP = 'service_operational';

const PREP_CONFIG = Object.freeze({
  flea: {
    label: 'Flea Treatment',
    serviceKeywords: ['flea'],
    emailTemplateKey: 'prep.flea',
    smsStandaloneKey: 'auto_flea_no_email',
  },
  bed_bug: {
    label: 'Bed Bug Treatment Service',
    serviceKeywords: ['bed bug'],
    emailTemplateKey: 'prep.bed_bug',
    smsStandaloneKey: 'auto_bed_bug_no_email',
  },
  cockroach: {
    label: 'Cockroach Treatment Service',
    serviceKeywords: ['roach'],
    emailTemplateKey: 'prep.cockroach',
    smsStandaloneKey: 'auto_cockroach_no_email',
  },
  // The six guides below have no inline-steps text: their text channel is
  // the guide-page link, which needs an upcoming visit to hang the token on.
  // Service-family keywords mirror VISIT_FAMILY_KEYWORDS in prep-public.js.
  interior_pest: {
    label: 'Interior Pest Treatment',
    serviceKeywords: ['pest'],
    emailTemplateKey: 'prep.interior_pest',
    smsStandaloneKey: null,
  },
  lawn: {
    label: 'Lawn Treatment',
    serviceKeywords: ['lawn'],
    emailTemplateKey: 'prep.lawn',
    smsStandaloneKey: null,
  },
  mosquito: {
    label: 'Mosquito Treatment',
    serviceKeywords: ['mosquito'],
    emailTemplateKey: 'prep.mosquito',
    smsStandaloneKey: null,
  },
  rodent: {
    label: 'Rodent Service',
    serviceKeywords: ['rodent'],
    emailTemplateKey: 'prep.rodent',
    smsStandaloneKey: null,
  },
  termite: {
    label: 'Termite Service',
    serviceKeywords: ['termite'],
    emailTemplateKey: 'prep.termite',
    smsStandaloneKey: null,
  },
});

// The text that carries the tokened guide page — one template for every
// pest; {prep_label} names the guide, {prep_url} is the /prep/:token link.
const SMS_GUIDE_LINK_KEY = 'auto_prep_guide_link';

const CHANNELS = Object.freeze(['email', 'sms', 'both']);

function isSupportedPestType(pestType) {
  return Object.prototype.hasOwnProperty.call(PREP_CONFIG, pestType);
}

function isSupportedChannel(channel) {
  return CHANNELS.includes(channel);
}

// Soonest upcoming visit of this pest family, so the emailed guide's "Service
// date" row references the real appointment and the prep token can hang off
// the visit row. Null when there is no matching upcoming visit; throws on a
// lookup error (the caller reports it apart from "no visit").
async function nextUpcomingVisit(customerId, serviceKeywords) {
  const row = await db('scheduled_services')
    .where({ customer_id: customerId })
    .where(function familyMatch() {
      for (const kw of serviceKeywords) this.orWhereRaw('LOWER(service_type) LIKE ?', [`%${kw}%`]);
    })
    .whereNotIn('status', ['cancelled', 'completed', 'rescheduled', 'skipped', 'no_show'])
    // ET, not CURRENT_DATE: the DB session runs UTC, so between ~8pm and
    // midnight ET "today's" visit would fall before the UTC date and the
    // email would say "To be confirmed" despite a real upcoming appointment.
    .where('scheduled_date', '>=', etDateString())
    .orderBy('scheduled_date', 'asc')
    .first('id', 'scheduled_date', 'prep_template_key');
  return row || null;
}

function guideLabelForTemplateKey(templateKey) {
  const match = Object.values(PREP_CONFIG).find((c) => c.emailTemplateKey === templateKey);
  return match ? match.label : String(templateKey || '').replace(/^prep\./, '');
}

// Atomic claim of the row's prep page for this guide: the key moves onto
// this guide only while it is unset or already ours. 0 rows = another
// guide owns the page (two operators sending different guides for one
// unkeyed combined visit both pass the read above — only one can claim;
// GH Codex #3856 r3 P1).
async function claimPrepPage(serviceId, templateKey) {
  const claimed = await db('scheduled_services')
    .where({ id: serviceId })
    .where(function ownable() {
      this.whereNull('prep_template_key').orWhere('prep_template_key', templateKey);
    })
    .update({ prep_template_key: templateKey });
  return Number(claimed) > 0;
}

// The visit the guide hangs on, plus its tokened page URL. A visit row holds
// ONE prep token, and /prep/:token renders the row's prep_template_key — so
// a row that already carries a DIFFERENT guide (a combined "Pest + Lawn"
// visit whose page went out as interior pest) is never re-keyed or linked
// for this guide: every URL already delivered would flip to the new guide
// (GH Codex #3856 r2 P1). The read below is the cheap early-out; the
// conditional claim after the mint is the gate. Such a row still dates the
// email but is not linked or stamped. linkReason says why prepUrl is null:
//   no_upcoming_visit — nothing for a page to describe
//   prep_page_taken   — the row's page belongs to another guide (takenBy)
//   prep_link_failed  — visit lookup or token mint threw (retryable)
async function resolvePrepVisit(customer, config) {
  let visit;
  try {
    visit = await nextUpcomingVisit(customer.id, config.serviceKeywords);
  } catch (err) {
    logger.warn(`[prep-guide-sender] next-visit lookup failed for customer ${customer.id}: ${err.message}`);
    return { visit: null, prepUrl: null, ownsPage: false, linkReason: 'prep_link_failed' };
  }
  if (!visit?.id) return { visit: null, prepUrl: null, ownsPage: false, linkReason: 'no_upcoming_visit' };
  if (visit.prep_template_key && visit.prep_template_key !== config.emailTemplateKey) {
    return {
      visit, prepUrl: null, ownsPage: false, linkReason: 'prep_page_taken',
      takenBy: guideLabelForTemplateKey(visit.prep_template_key),
    };
  }
  try {
    const token = await ensureServicePrepToken(visit.id, config.emailTemplateKey);
    if (!(await claimPrepPage(visit.id, config.emailTemplateKey))) {
      const now = await db('scheduled_services').where({ id: visit.id }).first('prep_template_key');
      return {
        visit, prepUrl: null, ownsPage: false, linkReason: 'prep_page_taken',
        takenBy: guideLabelForTemplateKey(now?.prep_template_key),
      };
    }
    return { visit, prepUrl: portalUrl(`/prep/${token}`), ownsPage: true, linkReason: null };
  } catch (tokenErr) {
    logger.warn(`[prep-guide-sender] prep token mint failed for service ${visit.id}: ${tokenErr.message}`);
    return { visit, prepUrl: null, ownsPage: true, linkReason: 'prep_link_failed' };
  }
}

// Confirmed delivery of the guide (either channel): stamp the tracker's
// prep_sent_at proof and align the rendered guide to what was delivered.
// Only for a visit whose page this guide owns (resolvePrepVisit.ownsPage).
async function stampPrepSent(visit, config) {
  if (!visit?.id) return;
  try {
    await markServicePrepSent(visit.id, config.emailTemplateKey);
  } catch (stampErr) {
    logger.warn(`[prep-guide-sender] prep_sent_at stamp failed for service ${visit.id}: ${stampErr.message}`);
  }
}

async function sendPrepEmail({ customer, recipient, firstName, config, visit, prepUrl, stampVisit }) {
  try {
    const portalVisitsUrl = portalUrl('/?tab=visits');
    const address = [customer.address_line1, customer.city, customer.state, customer.zip]
      .map((v) => String(v || '').trim()).filter(Boolean).join(', ');
    // service_date is a REQUIRED prep-template var (PREP_REQUIRED in
    // 20260526000014) — sendTemplate rejects an empty one. Fall back to a
    // non-empty placeholder when the customer has no matching upcoming visit.
    const serviceDate = (visit?.scheduled_date
      ? formatDisplayDate(visit.scheduled_date, { fallback: '' }) : '') || 'To be confirmed';
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
        // No visit to hang the page on → the portal's visits tab.
        prep_url: prepUrl || portalVisitsUrl,
        company_phone: WAVES_SUPPORT_PHONE_DISPLAY,
        company_email: CONTACT_EMAIL,
      },
    });
    if (result?.sent) await stampPrepSent(stampVisit, config);
    return !!result?.sent;
  } catch (err) {
    // Sanitized: never log err.message — provider errors can carry the email.
    logger.error(`[prep-guide-sender] email send failed for customer ${customer.id} (${err?.name || 'Error'})`);
    return false;
  }
}

async function sendPrepSms({ customer, firstName, phone, templateKey, vars, variant, pestType, actorId }) {
  const body = await renderSmsTemplate(templateKey, { first_name: firstName, ...vars }, {
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
    // Sole caller is the admin send-prep route — an operator-clicked send,
    // exempt from the send window (allowlisted entry point).
    entryPoint: 'admin_prep_guide_send',
    metadata: {
      original_message_type: 'prep_info',
      pest_type: pestType,
      prep_variant: variant,
      manual: true,
      // adminUserId is the key the Twilio send path forwards into
      // sms_log.admin_user_id — keeps the manual send attributed to the
      // operator instead of reading as system-authored.
      adminUserId: actorId || undefined,
    },
  });
  // sent:true with a suppression sentinel (gate off, template disabled, owner
  // SMS kill) means nothing left — never record that as a delivery.
  if (!isRealProviderSend(res)) {
    logger.warn(`[prep-guide-sender] prep SMS not sent for customer ${customer.id}: ${res.code || res.reason || res.providerMessageId || 'unknown'}`);
    return false;
  }
  return true;
}

// Sends prep to a customer on the operator-chosen channel. Returns a
// structured result the route turns into an operator-facing message. Never
// throws — every failure surfaces as { ok: false, reason }.
async function sendPrepToCustomer({ customerId, pestType = 'flea', channel = 'both', actorId = null } = {}) {
  const config = PREP_CONFIG[pestType];
  if (!config) return { ok: false, reason: 'unsupported_pest_type', pestType };
  if (!isSupportedChannel(channel)) return { ok: false, reason: 'unsupported_channel', pestType, channel };

  const customer = await db('customers').where({ id: customerId }).whereNull('deleted_at').first();
  if (!customer) return { ok: false, reason: 'customer_not_found', pestType };

  const recipient = resolveProjectEmailRecipient(customer);
  // The email greets the resolved recipient (which may be a service contact);
  // the SMS greets the phone owner — customer.phone is the primary's line — so
  // it must use the customer's own first name, not the service contact's.
  const emailFirstName = String(recipient.name || customer.first_name || '').trim().split(/\s+/)[0] || 'there';
  const smsFirstName = String(customer.first_name || '').trim().split(/\s+/)[0] || 'there';
  const phone = String(customer.phone || '').trim();
  const wantEmail = channel !== 'sms';
  const wantSms = channel !== 'email';

  const result = {
    ok: false,
    pestType,
    channel,
    label: config.label,
    emailSent: false,
    smsSent: false,
    emailAddress: recipient.email || null,
    phone: phone || null,
  };

  // Contact checks first — a chosen channel with nothing on file is an
  // operator-facing refusal, not a silent skip.
  if (wantEmail && !recipient.email) return { ...result, reason: 'no_email' };
  if (wantSms && !phone) return { ...result, reason: 'no_phone' };

  const { visit, prepUrl, ownsPage, linkReason, takenBy } = await resolvePrepVisit(customer, config);
  // The stamp target: only a visit whose page this guide owns.
  const stampVisit = ownsPage ? visit : null;
  // Text body: the guide-page link when a visit exists, else the pest's
  // inline-steps text, else nothing to text — refused with the link's own
  // reason (no visit / page taken / link failed), never a blanket "no visit".
  const smsPlan = prepUrl
    ? { templateKey: SMS_GUIDE_LINK_KEY, vars: { prep_label: config.label, prep_url: prepUrl }, variant: 'guide_link' }
    : config.smsStandaloneKey
      ? { templateKey: config.smsStandaloneKey, vars: {}, variant: 'standalone' }
      : null;
  if (wantSms && !smsPlan) return { ...result, reason: linkReason, ...(takenBy ? { takenBy } : {}) };

  if (wantEmail) {
    result.emailSent = await sendPrepEmail({
      customer, recipient, firstName: emailFirstName, config, visit, prepUrl, stampVisit,
    });
  }
  if (wantSms) {
    result.smsSent = await sendPrepSms({
      customer, firstName: smsFirstName, phone, pestType, actorId, ...smsPlan,
    });
    if (result.smsSent && smsPlan.variant === 'guide_link' && !result.emailSent) await stampPrepSent(stampVisit, config);
  }

  result.ok = result.emailSent || result.smsSent;
  if (!result.ok) {
    result.reason = 'send_failed';
  } else if (wantEmail && wantSms && result.emailSent !== result.smsSent) {
    // Both: one leg delivered, the other did not — say which, or the
    // operator reads a half-delivered ask as fully sent (GH Codex #3856 r2 P2).
    result.reason = 'partial';
    result.failedChannel = result.emailSent ? 'sms' : 'email';
  }

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

module.exports = {
  sendPrepToCustomer, isSupportedPestType, isSupportedChannel, PREP_CONFIG, CHANNELS, SMS_GUIDE_LINK_KEY,
};
