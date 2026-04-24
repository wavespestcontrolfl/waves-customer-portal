/**
 * SMS lead-intake state machine.
 *
 * Runs when a new lead replies to the "What are you interested in?"
 * auto-reply sent by lead-webhook.js. Drives a two-step capture:
 *
 *   awaiting_service  →  (classify pest/lawn/one_time)  →  awaiting_address
 *                                                           ↓
 *                             (address extracted)   →  estimate_drafted
 *
 * On reaching estimate_drafted we create (or update) a draft estimate
 * on the `estimates` table and SMS Adam at ADAM_NOTIFY_PHONE so he
 * knows a quote is waiting to be priced. Estimate creation is blocked
 * until an address is on file — the owner's hard requirement.
 *
 *   handleIntakeReply(customer, body) -> { handled: boolean, next?: string }
 *
 * Returns handled=false when the reply can't be routed (unknown intent,
 * empty body). The webhook caller should fall through to the normal
 * AI-draft / human-inbox path in that case.
 */

const db = require('../models/db');
const crypto = require('crypto');
const logger = require('./logger');
const TwilioService = require('./twilio');
const smsTemplatesRouter = require('../routes/admin-sms-templates');
const { classifyServiceIntent } = require('./sms-service-intent');

const ADAM_NOTIFY_PHONE = '+19415993489';

const SERVICE_LABEL = {
  pest: 'Pest Control',
  lawn: 'Lawn Care',
  one_time: 'One-Time Service',
};

const SERVICE_TEMPLATE_KEY = {
  pest: 'lead_service_pest',
  lawn: 'lead_service_lawn',
  one_time: 'lead_service_one_time',
};

async function renderTemplate(templateKey, vars, fallback) {
  try {
    if (typeof smsTemplatesRouter.getTemplate === 'function') {
      const body = await smsTemplatesRouter.getTemplate(templateKey, vars);
      if (body) return body;
    }
  } catch { /* fall through */ }
  return fallback;
}

// Heuristic address match: something that starts with a digit + space +
// letter OR contains a recognizable street suffix. Keeps v1 simple — if
// the customer sends anything address-shaped we save the whole message
// body as address_line1 and let Adam/Virginia clean it up at pricing time.
const STREET_SUFFIX_RE = /\b(st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|ln|lane|way|ct|court|pl|place|ter|terrace|cir|circle|pkwy|parkway|trl|trail|hwy|highway|loop)\b/i;
const LEADING_NUMBER_RE = /^\s*\d{1,6}\s+[A-Za-z]/;

function looksLikeAddress(body) {
  if (!body || typeof body !== 'string') return false;
  const trimmed = body.trim();
  if (trimmed.length < 6 || trimmed.length > 300) return false;
  if (LEADING_NUMBER_RE.test(trimmed)) return true;
  if (/\d/.test(trimmed) && STREET_SUFFIX_RE.test(trimmed)) return true;
  return false;
}

async function sendBranchReply(customer, interest) {
  const templateKey = SERVICE_TEMPLATE_KEY[interest];
  const firstName = customer.first_name || 'there';
  const fallback = interest === 'one_time'
    ? `Got it, ${firstName} — one-time service it is. Send me the service address and a quick note on what needs attention, and I'll put a quote together.`
    : `Great, ${firstName} — putting together a ${SERVICE_LABEL[interest].toLowerCase()} quote now. Just need to confirm the service address — can you text it over?`;
  const body = await renderTemplate(templateKey, { first_name: firstName }, fallback);
  try {
    await TwilioService.sendSMS(customer.phone, body, {
      customerId: customer.id,
      messageType: 'auto_reply',
    });
  } catch (e) {
    logger.error(`[lead-intake] Branch reply send failed: ${e.message}`);
  }
}

async function sendAddressNudge(customer) {
  const firstName = customer.first_name || 'there';
  const fallback = `Just need the service address to finish your quote, ${firstName}.`;
  const body = await renderTemplate('lead_address_needed', { first_name: firstName }, fallback);
  try {
    await TwilioService.sendSMS(customer.phone, body, {
      customerId: customer.id,
      messageType: 'auto_reply',
    });
  } catch (e) {
    logger.error(`[lead-intake] Address nudge send failed: ${e.message}`);
  }
}

async function createOrUpdateDraftEstimate(customer, interest) {
  const existingDraft = await db('estimates')
    .where({ customer_id: customer.id, status: 'draft' })
    .orderBy('created_at', 'desc')
    .first();

  const serviceLabel = SERVICE_LABEL[interest] || interest;
  const customerName = `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || 'Lead';

  if (existingDraft) {
    const updates = {
      service_interest: serviceLabel,
    };
    if (!existingDraft.address && customer.address_line1) updates.address = customer.address_line1;
    if (!existingDraft.customer_phone && customer.phone) updates.customer_phone = customer.phone;
    if (!existingDraft.customer_email && customer.email) updates.customer_email = customer.email;
    await db('estimates').where({ id: existingDraft.id }).update(updates);
    return existingDraft;
  }

  const shortId = crypto.randomBytes(4).toString('hex');
  const nameSlug = customerName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const token = `${nameSlug || 'lead'}-${shortId}`;
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  const [estimate] = await db('estimates').insert({
    customer_id: customer.id,
    customer_name: customerName,
    customer_phone: customer.phone,
    customer_email: customer.email || null,
    address: customer.address_line1 || '',
    status: 'draft',
    source: 'sms_intake',
    service_interest: serviceLabel,
    lead_source: customer.lead_source || null,
    lead_source_detail: customer.lead_source_detail || null,
    token,
    expires_at: expiresAt,
    notes: `Auto-created from SMS intake. Customer selected: ${serviceLabel}. Pricing TBD.`,
  }).returning('*');

  return estimate;
}

async function notifyAdam(customer, interest, estimate) {
  const serviceLabel = SERVICE_LABEL[interest] || interest;
  const name = `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || 'Lead';
  const address = customer.address_line1 || '(no address)';
  const portalUrl = process.env.CLIENT_URL || 'https://portal.wavespestcontrol.com';
  const estimateUrl = estimate ? `${portalUrl}/admin/estimates` : portalUrl;

  const message = `🟢 New SMS lead ready to price!\n${name}\n📞 ${customer.phone}\n📍 ${address}\nService: ${serviceLabel}\nEstimate: ${estimateUrl}`;

  try {
    await TwilioService.sendSMS(ADAM_NOTIFY_PHONE, message, { messageType: 'internal_alert' });
  } catch (e) {
    logger.error(`[lead-intake] Adam notification failed: ${e.message}`);
  }
}

async function handleIntakeReply(customer, body) {
  if (!customer || !body || typeof body !== 'string') return { handled: false };
  const status = customer.lead_intake_status;
  if (!status || status === 'estimate_drafted') return { handled: false };

  // ── State: awaiting_service ────────────────────────────────────────
  if (status === 'awaiting_service') {
    const cls = await classifyServiceIntent(body);
    if (!cls || !cls.interest) {
      // Couldn't classify — fall through to AI draft / human inbox.
      return { handled: false };
    }

    await db('customers').where({ id: customer.id }).update({
      lead_service_interest: cls.interest,
    });
    customer.lead_service_interest = cls.interest;

    await sendBranchReply(customer, cls.interest);

    const hasAddress = !!(customer.address_line1 && String(customer.address_line1).trim());
    if (hasAddress) {
      // Address already on file — create draft + notify immediately.
      const estimate = await createOrUpdateDraftEstimate(customer, cls.interest);
      await db('customers').where({ id: customer.id }).update({
        lead_intake_status: 'estimate_drafted',
      });
      await notifyAdam(customer, cls.interest, estimate);
      logger.info(`[lead-intake] Drafted estimate for ${customer.first_name} (${cls.interest}) — classifier=${cls.method}`);
      return { handled: true, next: 'estimate_drafted' };
    }

    await db('customers').where({ id: customer.id }).update({
      lead_intake_status: 'awaiting_address',
    });
    logger.info(`[lead-intake] Awaiting address from ${customer.first_name} after selecting ${cls.interest}`);
    return { handled: true, next: 'awaiting_address' };
  }

  // ── State: awaiting_address ────────────────────────────────────────
  if (status === 'awaiting_address') {
    if (!looksLikeAddress(body)) {
      await sendAddressNudge(customer);
      return { handled: true, next: 'awaiting_address' };
    }

    const address = body.trim();
    await db('customers').where({ id: customer.id }).update({
      address_line1: address,
    });
    customer.address_line1 = address;

    const interest = customer.lead_service_interest;
    if (!interest) {
      // Shouldn't normally happen, but guard against it — fall through.
      return { handled: false };
    }

    const estimate = await createOrUpdateDraftEstimate(customer, interest);
    await db('customers').where({ id: customer.id }).update({
      lead_intake_status: 'estimate_drafted',
      updated_at: new Date(),
    });
    await notifyAdam(customer, interest, estimate);
    logger.info(`[lead-intake] Drafted estimate for ${customer.first_name} (${interest}) after address capture`);
    return { handled: true, next: 'estimate_drafted' };
  }

  return { handled: false };
}

module.exports = { handleIntakeReply };
