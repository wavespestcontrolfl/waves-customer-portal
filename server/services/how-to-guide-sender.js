/**
 * Manual how-to guide email (Quick Links "How-to guides" group).
 *
 * An operator picks a guide and a customer, and the howto.* email template
 * goes to the customer's email on file (owner 2026-11-20). Email only: a
 * guide has no public page for a text to link to, so the text path stays the
 * pasted steps in the composer. Unlike a prep guide it hangs on no visit, and
 * unlike the sprinkler timer guide it can be sent again, since a customer
 * who asks twice gets it twice.
 *
 * The templates are seeded by 20261120200000; `path` is the portal screen the
 * email's button opens after sign-in (LoginPage honors ?next=).
 */

const db = require('../models/db');
const logger = require('./logger');
const EmailTemplateLibrary = require('./email-template-library');
const { portalUrl } = require('../utils/portal-url');
const { WAVES_SUPPORT_PHONE_DISPLAY } = require('../constants/business');

const CONTACT_EMAIL = 'contact@wavespestcontrol.com';
const SERVICE_GROUP = 'service_operational';

const HOW_TO_GUIDES = Object.freeze({
  add_contact: { label: 'Add another contact', path: '/?tab=visits' },
  autopay: { label: 'Set up Auto Pay or change your card', path: '/?tab=billing&focus=payment-methods' },
  notifications: { label: 'Choose how we notify you', path: '/?tab=visits' },
  get_app: { label: 'Get the app and turn on notifications', path: '/?tab=visits' },
  alerts_iphone: { label: 'Make app alerts show on iPhone', path: '/?tab=visits' },
  alerts_android: { label: 'Make app alerts show on Android', path: '/?tab=visits' },
  documents: { label: 'Find your service reports and invoices', path: '/?tab=documents' },
  reschedule: { label: 'Reschedule or request a visit', path: '/?tab=visits' },
  access_notes: { label: 'Update gate code and access notes', path: '/?tab=property' },
  add_property: { label: 'Add another property', path: '/?tab=visits' },
  refer: { label: 'Refer a friend', path: '/?tab=refer' },
});

function isSupportedGuide(guideKey) {
  return Object.prototype.hasOwnProperty.call(HOW_TO_GUIDES, guideKey);
}

// Sends one guide email. Never throws: every failure is { ok: false, reason }.
// `emailUncertain` marks a throw after the provider call began, when the
// email may have gone out and a retry could send it twice.
async function sendHowToGuideToCustomer({ customerId, guideKey, actorId = null } = {}) {
  const guide = HOW_TO_GUIDES[guideKey];
  if (!guide) return { ok: false, reason: 'unsupported_guide' };
  const customer = await db('customers').where({ id: customerId }).whereNull('deleted_at').first();
  if (!customer) return { ok: false, reason: 'customer_not_found' };

  const email = String(customer.email || '').trim();
  const result = { ok: false, guideKey, label: guide.label, emailAddress: email || null };
  if (!email) return { ...result, reason: 'no_email' };

  // The portal's "Email messages" switch stops every email (PortalPage's own
  // promise); the suppression list the template library checks is separate.
  // Fail closed, like the welcome sender: an unreadable preference sends nothing.
  let prefs;
  try {
    prefs = await db('notification_prefs').where({ customer_id: customer.id }).first('email_enabled');
  } catch (err) {
    logger.warn(`[how-to-guide-sender] email preference lookup failed for customer ${customer.id}: ${err.name} (code=${err.code})`);
    return { ...result, reason: 'prefs_unavailable' };
  }
  if (prefs?.email_enabled === false) return { ...result, reason: 'email_opted_out' };

  const templateKey = `howto.${guideKey}`;
  let dispatched = false;
  try {
    const sent = await EmailTemplateLibrary.sendTemplate({
      templateKey,
      to: email,
      recipientType: 'customer',
      recipientId: customer.id,
      suppressionGroupKey: SERVICE_GROUP,
      categories: ['manual_how_to', `how_to_${guideKey}`],
      // Provider rejections can echo the recipient address; keep it out of logs.
      suppressProviderErrorLog: true,
      onQueued: async () => { dispatched = true; return true; },
      payload: {
        first_name: String(customer.first_name || '').trim().split(/\s+/)[0] || 'there',
        guide_url: portalUrl(`/login?next=${encodeURIComponent(guide.path)}`),
        company_phone: WAVES_SUPPORT_PHONE_DISPLAY,
        company_email: CONTACT_EMAIL,
      },
    });
    if (!sent?.sent) return { ...result, reason: sent?.blocked ? 'email_blocked' : 'send_failed' };
  } catch (err) {
    const { isDefiniteRejection } = require('./sendgrid-mail');
    const uncertain = dispatched && !isDefiniteRejection(err);
    logger.error(`[how-to-guide-sender] ${templateKey} send failed for customer ${customer.id} (${err?.name || 'Error'}, dispatched=${dispatched}, uncertain=${uncertain})`);
    return { ...result, reason: 'send_failed', emailUncertain: uncertain };
  }

  try {
    await db('customer_interactions').insert({
      customer_id: customer.id,
      interaction_type: 'email_outbound',
      admin_user_id: actorId || null,
      subject: `${guide.label} guide sent (manual)`,
      body: `How-to guide emailed from Quick Links to ${email}.`,
    });
  } catch (err) {
    logger.warn(`[how-to-guide-sender] interaction log failed for customer ${customer.id}: ${err.name} (code=${err.code})`);
  }
  return { ...result, ok: true };
}

module.exports = { sendHowToGuideToCustomer, isSupportedGuide, HOW_TO_GUIDES };
