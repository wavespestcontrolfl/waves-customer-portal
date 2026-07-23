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

// Send-path filter shared by every fanout loop (appointment reminders +
// the twilio.js en-route/arrived sends): drops service-contact recipients
// whose recipient_optin row is pending/declined. Primary rows and phones
// with no row pass through untouched. Fail-open: an opt-in lookup error
// must never block a send path.
async function filterRecipientsByOptin(contacts = []) {
  if (!isDoubleOptinEnabled()) return contacts;
  const { isServiceContactRole } = require('./customer-contact');
  const kept = [];
  for (const contact of contacts) {
    if (!isServiceContactRole(contact.role)) { kept.push(contact); continue; }
    try {
      const row = await getRecipientOptin(contact.phone);
      if (optinBlocksSend(row, true)) {
        logger.info(`[recipient-optin] holding send to unconfirmed recipient (${row.status})`);
        continue;
      }
    } catch { /* fail open */ }
    kept.push(contact);
  }
  return kept;
}

// Portal contacts-save hook: request confirmation from each NEWLY ADDED
// phone recipient (phones already stored on the row before this save are
// grandfathered and never asked). Skips silently (in order) when: gate
// off, phone missing/same as the account holder/already on the row, the
// template is inactive/missing, or another save already claimed the phone.
// The pending row is the CLAIM — inserted (onConflict ignore) before the
// Twilio dispatch so two concurrent saves can't both text the same phone;
// a blocked/failed send releases the claim so a later save can retry.
// Phase 1 — SYNCHRONOUS claim, called BEFORE the contact slots are written
// to the customers row: renders the template and inserts the pending rows
// (onConflict ignore = atomic one-ask-per-phone claim). Because the claim
// lands before the contact becomes visible to any fanout, there is no
// window where a brand-new phone reads as grandfathered (no row). Returns
// the claims for phase 2; template dark → no claims, nothing pends.
async function claimRecipientOptins({ customer, contacts = [], priorPhones = [], propertyAddress = '' }) {
  if (!isDoubleOptinEnabled()) return [];
  const accountKey = recipientPhoneKey(customer?.phone);
  const priorKeys = new Set(priorPhones.map(recipientPhoneKey).filter(Boolean));
  const claims = [];
  for (const contact of contacts) {
    const key = recipientPhoneKey(contact.phone);
    if (!key || key === accountKey || priorKeys.has(key)) continue;
    try {
      const { renderSmsTemplate } = require('./sms-template-renderer');
      const body = await renderSmsTemplate(OPTIN_TEMPLATE_KEY, {
        recipient_first_name: String(contact.firstName || contact.name || '').trim().split(/\s+/)[0] || 'there',
        account_first_name: String(customer?.first_name || '').trim() || 'Your account holder',
        property_address: String(propertyAddress || '').trim() || 'your service property',
      });
      if (!body) continue; // template dark — owner has not approved copy yet
      const claimed = await db('recipient_optin').insert({
        phone_key: key,
        phone_e164: String(contact.phone || '').trim(),
        status: 'pending',
        customer_id: customer?.id || null,
        requested_by: 'portal_contact_save',
        template_version: OPTIN_TEMPLATE_VERSION,
        requested_at: new Date(),
      }).onConflict('phone_key').ignore().returning('phone_key');
      if (!claimed || !claimed.length) continue; // row already exists — never re-text
      claims.push({ key, phone: contact.phone, body });
    } catch (err) {
      logger.warn(`[recipient-optin] claim failed for ***${key.slice(-4)}: ${err.message}`);
    }
  }
  return claims;
}

// Phase 2 — ASYNC dispatch of the claimed confirmation texts (the save
// response never waits on Twilio). A blocked/failed send releases the
// claim so the recipient isn't stranded pending without ever being asked.
async function dispatchRecipientOptins(claims = [], customer = null) {
  let requested = 0;
  for (const claim of claims) {
    try {
      const { sendCustomerMessage } = require('./messaging/send-customer-message');
      const result = await sendCustomerMessage({
        to: claim.phone,
        body: claim.body,
        channel: 'sms',
        audience: 'customer',
        purpose: 'appointment',
        customerId: customer?.id || null,
        identityTrustLevel: 'service_contact_authorized',
        metadata: { original_message_type: 'recipient_optin_request' },
      });
      if (result.blocked || result.sent === false) {
        await db('recipient_optin').where({ phone_key: claim.key, status: 'pending' }).del().catch(() => {});
        logger.warn(`[recipient-optin] request blocked for ***${claim.key.slice(-4)}: ${result.code || 'unknown'}`);
        continue;
      }
      requested += 1;
    } catch (err) {
      await db('recipient_optin').where({ phone_key: claim.key, status: 'pending' }).del().catch(() => {});
      logger.warn(`[recipient-optin] request failed for ***${claim.key.slice(-4)}: ${err.message}`);
    }
  }
  return { requested };
}

// Back-compat convenience for callers that can't split phases.
async function requestRecipientOptins(args) {
  const claims = await claimRecipientOptins(args);
  return dispatchRecipientOptins(claims, args.customer);
}

module.exports = {
  OPTIN_TEMPLATE_KEY,
  OPTIN_TEMPLATE_VERSION,
  isDoubleOptinEnabled,
  recipientPhoneKey,
  optinBlocksSend,
  getRecipientOptin,
  markRecipientOptin,
  filterRecipientsByOptin,
  claimRecipientOptins,
  dispatchRecipientOptins,
  requestRecipientOptins,
};
