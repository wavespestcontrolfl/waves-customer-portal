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
const { runExclusive, wasLockSkipped } = require('../utils/cron-lock');

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

// Atomic claim of the row's prep page for this guide. A FRESH claim moves
// the key onto this guide only while it is unset (whereNull — two operators
// sending for one unkeyed visit both pass the read above; exactly one
// claims, GH Codex #3856 r3 P1). A key that already matches is owned but
// not fresh: some earlier attempt — possibly a concurrent same-guide send
// still in flight — made it, so this attempt may send on it but must never
// release it (pre-push Codex P1 on 87c0e9e95). Anything else is taken.
async function claimPrepPage(serviceId, templateKey) {
  const fresh = await db('scheduled_services')
    .where({ id: serviceId })
    .whereNull('prep_template_key')
    .update({ prep_template_key: templateKey });
  if (Number(fresh) > 0) return { owned: true, fresh: true };
  const row = await db('scheduled_services').where({ id: serviceId }).first('prep_template_key');
  if (row?.prep_template_key === templateKey) return { owned: true, fresh: false };
  return { owned: false, takenBy: row?.prep_template_key || null };
}

// A FRESH claim is PROVISIONAL until a channel delivers: when nothing went
// out, hand the page back so a failed first attempt neither blocks a later
// guide nor ties the visit to content the customer never received. Only
// our own key is released, and only while no delivery of it was ever
// stamped (markServicePrepSent sets prep_sent_at — the delivered key stays;
// pre-push Codex P1 on dde34633e). Callers release fresh claims only.
async function releasePrepPage(serviceId, templateKey) {
  try {
    await db('scheduled_services')
      .where({ id: serviceId, prep_template_key: templateKey })
      .whereNull('prep_sent_at')
      .update({ prep_template_key: null });
  } catch (err) {
    logger.warn(`[prep-guide-sender] prep page release failed for service ${serviceId}: ${err.message}`);
  }
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
  // Claim BEFORE the mint: ensureServicePrepToken initializes an unset key
  // itself, so a claim after it could never be fresh and a failed first
  // send would reserve the page forever (pre-push Codex P1 on cd6de743e).
  let claim = null;
  try {
    claim = await claimPrepPage(visit.id, config.emailTemplateKey);
    if (!claim.owned) {
      return {
        visit, prepUrl: null, ownsPage: false, linkReason: 'prep_page_taken',
        takenBy: guideLabelForTemplateKey(claim.takenBy),
      };
    }
    const token = await ensureServicePrepToken(visit.id, config.emailTemplateKey);
    return { visit, prepUrl: portalUrl(`/prep/${token}`), ownsPage: true, freshClaim: claim.fresh, linkReason: null };
  } catch (tokenErr) {
    // No token = no page to own: the email still goes out (portal link,
    // dated by the visit) but never stamps the row as a delivered guide
    // (pre-push Codex P1 on c3398fd21); a fresh claim is handed back.
    logger.warn(`[prep-guide-sender] prep token mint failed for service ${visit.id}: ${tokenErr.message}`);
    if (claim?.fresh) await releasePrepPage(visit.id, config.emailTemplateKey);
    return { visit, prepUrl: null, ownsPage: false, linkReason: 'prep_link_failed' };
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

// The email leg. Outcome { sent, uncertain }: the template library can throw
// AFTER SendGrid accepted (its post-dispatch bookkeeping) with no marker on
// the error, so a throw once dispatch was reached is uncertain — a kept
// claim costs an operator "email it instead"; a released page 404s a URL
// the customer may already hold (GH Codex #3856 r5 P1). onQueued fires
// immediately before the provider call: a throw BEFORE it (template
// missing/disabled, no active version) reached no one and is a plain
// failure (GH Codex #3856 r6 P2).
async function sendPrepEmail({ customer, recipient, firstName, config, visit, prepUrl, stampVisit }) {
  let dispatched = false;
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
      onQueued: () => { dispatched = true; },
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
    return { sent: !!result?.sent };
  } catch (err) {
    // Sanitized: never log err.message — provider errors can carry the email.
    logger.error(`[prep-guide-sender] email send failed for customer ${customer.id} (${err?.name || 'Error'}, dispatched=${dispatched})`);
    return { sent: false, uncertain: dispatched };
  }
}

// The SMS leg. Outcome { sent }. sendCustomerMessage swallows provider
// failures itself and throws in exactly two places: BEFORE the handoff
// (definite — nothing reached Twilio) or while persisting the final audit,
// carrying the KNOWN provider outcome on the error. So a throw is never
// uncertain: providerOutcome.sent === true is a send (the caller stamps the
// page and writes the tagger-compatible marker exactly as for a returned
// send), anything else a plain failure (GH Codex #3856 r9 P2).
async function sendPrepSms({ customer, firstName, phone, templateKey, vars, variant, pestType, actorId }) {
  let body;
  try {
    body = await renderSmsTemplate(templateKey, { first_name: firstName, ...vars }, {
      workflow: 'manual_prep_send', entity_type: 'customer', entity_id: customer.id,
    });
  } catch (err) {
    // Sanitized: renderer/provider errors can echo the phone or the body.
    logger.warn(`[prep-guide-sender] ${templateKey} render threw for customer ${customer.id} (${err?.name || 'Error'})`);
    return { sent: false };
  }
  if (!body) {
    logger.warn(`[prep-guide-sender] ${templateKey} template missing/disabled; SMS skipped for customer ${customer.id}`);
    return { sent: false };
  }
  let res;
  try {
    res = await sendCustomerMessage({
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
  } catch (err) {
    const accepted = err?.providerOutcome?.sent === true;
    logger.warn(`[prep-guide-sender] prep SMS wrapper threw for customer ${customer.id} (${err?.code || err?.name || 'Error'}, providerAccepted=${accepted})`);
    return { sent: accepted };
  }
  // sent:true with a suppression sentinel (gate off, template disabled, owner
  // SMS kill) means nothing left — never record that as a delivery.
  if (!isRealProviderSend(res)) {
    logger.warn(`[prep-guide-sender] prep SMS not sent for customer ${customer.id}: ${res.code || res.reason || res.providerMessageId || 'unknown'}`);
    return { sent: false };
  }
  return { sent: true };
}

// Who each channel greets: the email goes to the resolved recipient (which
// may be a service contact); the text goes to customer.phone — the primary's
// line — so it greets the customer's own first name, never the contact's.
// A chosen channel with nothing on file is an operator-facing refusal.
function resolvePrepContacts(customer, channel) {
  const recipient = resolveProjectEmailRecipient(customer);
  const firstWord = (v) => String(v || '').trim().split(/\s+/)[0] || 'there';
  const contacts = {
    recipient,
    emailFirstName: firstWord(recipient.name || customer.first_name),
    smsFirstName: firstWord(customer.first_name),
    phone: String(customer.phone || '').trim(),
    wantEmail: channel !== 'sms',
    wantSms: channel !== 'email',
    refusal: null,
  };
  if (contacts.wantEmail && !recipient.email) contacts.refusal = 'no_email';
  else if (contacts.wantSms && !contacts.phone) contacts.refusal = 'no_phone';
  return contacts;
}

// Text body: the guide-page link when the visit's page is ours, else the
// pest's inline-steps text, else nothing to text.
function planPrepSms(config, prepUrl) {
  if (prepUrl) {
    return { templateKey: SMS_GUIDE_LINK_KEY, vars: { prep_label: config.label, prep_url: prepUrl }, variant: 'guide_link' };
  }
  if (config.smsStandaloneKey) return { templateKey: config.smsStandaloneKey, vars: {}, variant: 'standalone' };
  return null;
}

// Runs the requested legs and settles the outcome on `result`: ok when either
// delivered; 'partial' (+ failedChannel) when Both delivered one; 'send_failed'
// when neither did — then the provisional page claim is handed back, unless
// the email leg is uncertain (GH Codex #3856 r4 P2 / r5 P1).
async function deliverPrep({ customer, config, contacts, page, smsPlan, pestType, actorId, result }) {
  const { visit, prepUrl, stampVisit } = page;
  let uncertain = false;
  if (contacts.wantEmail) {
    const email = await sendPrepEmail({
      customer, recipient: contacts.recipient, firstName: contacts.emailFirstName, config, visit, prepUrl, stampVisit,
    });
    result.emailSent = email.sent;
    result.emailUncertain = !!email.uncertain;
    uncertain = result.emailUncertain;
  }
  if (contacts.wantSms) {
    const sms = await sendPrepSms({
      customer, firstName: contacts.smsFirstName, phone: contacts.phone, pestType, actorId, ...smsPlan,
    });
    result.smsSent = sms.sent;
    if (sms.sent && smsPlan.variant === 'guide_link' && !result.emailSent) await stampPrepSent(stampVisit, config);
  }
  result.ok = result.emailSent || result.smsSent;
  if (!result.ok) {
    result.reason = 'send_failed';
    if (page.freshClaim && !uncertain) await releasePrepPage(stampVisit.id, config.emailTemplateKey);
  } else if (contacts.wantEmail && contacts.wantSms && result.emailSent !== result.smsSent) {
    // Both: one leg delivered, the other did not — say which, or the
    // operator reads a half-delivered ask as fully sent (GH Codex #3856 r2 P2).
    result.reason = 'partial';
    result.failedChannel = result.emailSent ? 'sms' : 'email';
  }
}

// When the SMS went out, write the SAME marker the appointment tagger's
// replay guard (hasSentPrepSms) looks for — sms_outbound + "<pestType> prep
// info sent" — so a later replay of onServiceScheduled (e.g. regenerate-
// brief) doesn't re-text prep this manual click already delivered.
// Email-only sends keep the descriptive manual subject.
async function logPrepInteraction({ customer, config, contacts, result, pestType, actorId }) {
  try {
    await db('customer_interactions').insert({
      customer_id: customer.id,
      interaction_type: result.smsSent ? 'sms_outbound' : 'email_outbound',
      admin_user_id: actorId || null,
      subject: result.smsSent ? `${pestType} prep info sent` : `${config.label} prep sent (manual)`,
      body: `Prep sent manually via Communications — ${[
        result.emailSent ? `email to ${contacts.recipient.email}` : null,
        result.smsSent ? `text to ${contacts.phone}` : null,
      ].filter(Boolean).join(' + ')}.`,
    });
  } catch (err) {
    logger.warn(`[prep-guide-sender] interaction log failed for customer ${customer.id}: ${err.message}`);
  }
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

  const contacts = resolvePrepContacts(customer, channel);
  const result = {
    ok: false,
    pestType,
    channel,
    label: config.label,
    emailSent: false,
    smsSent: false,
    emailAddress: contacts.recipient.email || null,
    phone: contacts.phone || null,
  };
  if (contacts.refusal) return { ...result, reason: contacts.refusal };

  // Per-customer exclusivity of claim → send → release/stamp, across
  // instances (a deploy overlaps two): two sends for this customer within
  // the same seconds are the only way a fresh claim's release can race a
  // sibling's reuse of the same key and un-guide the sibling's delivered
  // URL. The canonical session advisory lock (cron-lock.runExclusive,
  // request-scoped: no health row, non-blocking) serializes them; a held
  // lease is an operator-facing "try again", not a wait (pre-push Codex
  // P1s on 8dbc30cc1 + 87b4cee92).
  const outcome = await runExclusive(`prep-send:${customer.id}`, async () => {
    const page = await resolvePrepVisit(customer, config);
    // The stamp target: only a visit whose page this guide owns.
    page.stampVisit = page.ownsPage ? page.visit : null;
    const smsPlan = planPrepSms(config, page.prepUrl);
    // Refused with the link's own reason (no visit / page taken / link
    // failed), never a blanket "no visit".
    if (contacts.wantSms && !smsPlan) {
      return { ...result, reason: page.linkReason, ...(page.takenBy ? { takenBy: page.takenBy } : {}) };
    }

    await deliverPrep({ customer, config, contacts, page, smsPlan, pestType, actorId, result });
    if (result.ok) await logPrepInteraction({ customer, config, contacts, result, pestType, actorId });
    return result;
  }, { recordHealth: false, waitForSlot: false });
  if (wasLockSkipped(outcome)) return { ...result, reason: 'prep_send_busy' };
  return outcome;
}

module.exports = {
  sendPrepToCustomer, isSupportedPestType, isSupportedChannel, PREP_CONFIG, CHANNELS, SMS_GUIDE_LINK_KEY,
};
