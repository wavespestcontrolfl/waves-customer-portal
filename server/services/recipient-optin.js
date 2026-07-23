// Recipient double opt-in (#2948 follow-up, owner-authorized 2026-07-23).
//
// When the account holder adds an on-location contact in the portal, that
// third party gets ONE confirmation text ("Reply YES…") and appointment
// texts to them hold until they confirm. Layered on the existing rails:
// the Twilio webhook already treats YES as opt-in and STOP as suppression;
// this module just records per-recipient state and answers "may we text
// this service contact yet?".
//
// Grandfather rule: a phone with NO recipient_optin row is allowed (every
// pre-existing contact predates this flow and already carries the row-level
// consent artifact from 20260723000003). Only phones the flow has touched
// (status pending/declined) hold texts.
//
// Dark by default: nothing sends unless BOTH the GATE_RECIPIENT_DOUBLE_OPTIN
// gate is on AND the recipient_optin_request template row is activated by
// the owner (renderSmsTemplate returns null while is_active=false, and no
// pending row is written when the template doesn't render).
const db = require('../models/db');
const logger = require('./logger');

const OPTIN_TEMPLATE_KEY = 'recipient_optin_request';
const OPTIN_TEMPLATE_VERSION = 'portal-2026-07-23';

function isDoubleOptinEnabled() {
  const { isEnabled } = require('../config/feature-gates');
  return isEnabled('recipientDoubleOptin');
}

// Same last-10 convention as the webhook's phoneLookupKey.
function recipientPhoneKey(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

// True when appointment texts to this service contact must hold. `row` is
// the recipient_optin row (or null). Absence of a row = legacy allowed.
function optinBlocksSend(row, gateOn = isDoubleOptinEnabled()) {
  if (!gateOn || !row) return false;
  return row.status !== 'confirmed';
}

async function getRecipientOptin(phone) {
  const key = recipientPhoneKey(phone);
  if (!key) return null;
  try {
    return await db('recipient_optin').where({ phone_key: key }).first() || null;
  } catch {
    // Missing table (pre-migration env) must never block a send path.
    return null;
  }
}

// Webhook hook: the sender replied YES (status 'confirmed') or STOP
// ('declined'). No-op when the phone has no row — a plain customer opt-in/
// opt-out is not recipient state.
async function markRecipientOptin(phone, status) {
  const key = recipientPhoneKey(phone);
  if (!key) return false;
  try {
    const stamp = status === 'confirmed'
      ? { status, confirmed_at: new Date(), updated_at: new Date() }
      : { status, declined_at: new Date(), updated_at: new Date() };
    const updated = await db('recipient_optin').where({ phone_key: key }).update(stamp);
    if (updated) logger.info(`[recipient-optin] ${status} recorded for ***${key.slice(-4)}`);
    return updated > 0;
  } catch (err) {
    logger.warn(`[recipient-optin] mark ${status} failed: ${err.message}`);
    return false;
  }
}

// Portal contacts-save hook: request confirmation from each newly saved
// phone recipient. Skips silently (in order) when: gate off, phone missing/
// same as the account holder, a row already exists (any status — never
// re-text), or the template is inactive/missing. Only inserts the pending
// row when a confirmation text actually went out, so a dark template can
// never strand recipients in "pending" without ever being asked.
async function requestRecipientOptins({ customer, contacts = [], propertyAddress = '' }) {
  if (!isDoubleOptinEnabled()) return { requested: 0 };
  const accountKey = recipientPhoneKey(customer?.phone);
  let requested = 0;
  for (const contact of contacts) {
    const key = recipientPhoneKey(contact.phone);
    if (!key || key === accountKey) continue;
    try {
      const existing = await db('recipient_optin').where({ phone_key: key }).first();
      if (existing) continue;
      const { renderSmsTemplate } = require('./sms-template-renderer');
      const body = await renderSmsTemplate(OPTIN_TEMPLATE_KEY, {
        recipient_first_name: String(contact.firstName || contact.name || '').trim().split(/\s+/)[0] || 'there',
        account_first_name: String(customer?.first_name || '').trim() || 'Your account holder',
        property_address: String(propertyAddress || '').trim() || 'your service property',
      });
      if (!body) continue; // template dark — owner has not approved copy yet
      const { sendCustomerMessage } = require('./messaging/send-customer-message');
      const result = await sendCustomerMessage({
        to: contact.phone,
        body,
        channel: 'sms',
        audience: 'customer',
        purpose: 'appointment',
        customerId: customer?.id || null,
        identityTrustLevel: 'service_contact_authorized',
        metadata: { original_message_type: 'recipient_optin_request' },
      });
      if (result.blocked || result.sent === false) {
        logger.warn(`[recipient-optin] request blocked for ***${key.slice(-4)}: ${result.code || 'unknown'}`);
        continue;
      }
      await db('recipient_optin').insert({
        phone_key: key,
        phone_e164: String(contact.phone || '').trim(),
        status: 'pending',
        customer_id: customer?.id || null,
        requested_by: 'portal_contact_save',
        template_version: OPTIN_TEMPLATE_VERSION,
        requested_at: new Date(),
      }).onConflict('phone_key').ignore();
      requested += 1;
    } catch (err) {
      logger.warn(`[recipient-optin] request failed for ***${key.slice(-4)}: ${err.message}`);
    }
  }
  return { requested };
}

module.exports = {
  OPTIN_TEMPLATE_KEY,
  OPTIN_TEMPLATE_VERSION,
  isDoubleOptinEnabled,
  recipientPhoneKey,
  optinBlocksSend,
  getRecipientOptin,
  markRecipientOptin,
  requestRecipientOptins,
};
