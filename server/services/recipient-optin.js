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
  } catch (err) {
    // Fail CLOSED while the gate is on: a transient lookup failure must
    // hold the send rather than treat a possibly-pending/declined phone as
    // grandfathered. Callers see a row-like sentinel whose status is never
    // 'confirmed'. (Migrations run pre-deploy, so a missing table only
    // occurs on an un-migrated dev DB.)
    logger.warn(`[recipient-optin] lookup failed (${err.message}) — failing closed`);
    return { status: 'lookup_error' };
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
// whose recipient_optin row is not confirmed. Primary rows and phones with
// no row pass through untouched. Fail-CLOSED: while the gate is on, a
// lookup error holds the service contact's text.
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
    } catch (err) {
      // Fail closed: with the gate on, an error must hold this service
      // contact's text, never default to sending.
      logger.warn(`[recipient-optin] filter error (${err.message}) — holding send`);
      continue;
    }
    kept.push(contact);
  }
  return kept;
}

// Phase 1 — SYNCHRONOUS claim, called BEFORE the contact slots are written
// to the customers row: renders the template and inserts the pending rows
// (onConflict ignore = atomic one-ask-per-phone claim). Because the claim
// lands before the contact becomes visible to any fanout, there is no
// window where a brand-new phone reads as grandfathered (no row). Returns
// the claims for phase 2; template dark → no claims, nothing pends.
async function claimRecipientOptins({ customer, contacts = [], priorPhones = [], propertyAddress = '', trx = null }) {
  if (!isDoubleOptinEnabled()) return [];
  const dbc = trx || db;
  const accountKey = recipientPhoneKey(customer?.phone);
  const priorKeys = new Set(priorPhones.map(recipientPhoneKey).filter(Boolean));

  // Dark-vs-broken distinction (fail closed on broken): a missing or
  // deactivated template row is the INTENTIONAL dark state — skip quietly.
  // An ACTIVE row that then fails to render is infrastructure failure and
  // must throw (the save fails) rather than silently grandfather phones.
  let templateRow = null;
  try {
    templateRow = await dbc('sms_templates').where({ template_key: OPTIN_TEMPLATE_KEY }).first();
  } catch (err) {
    logger.error(`[recipient-optin] template lookup failed: ${err.message}`);
    throw err;
  }
  const templateDark = !templateRow || templateRow.is_active === false;

  const claims = [];
  for (const contact of contacts) {
    const key = recipientPhoneKey(contact.phone);
    if (!key || key === accountKey) continue;
    try {
      // Save-triggered retry: an ask_failed phone (ask never delivered)
      // re-claims on the next consented save even though the phone is
      // already stored — priorPhones only grandfathers phones that were
      // never routed through the ask flow.
      const reclaimed = templateDark ? 0 : await dbc('recipient_optin')
        .where({ phone_key: key, status: 'ask_failed' })
        .update({ status: 'pending', requested_at: new Date(), updated_at: new Date() });
      const retryClaim = reclaimed > 0;
      if (templateDark) continue;
      if (!retryClaim && priorKeys.has(key)) continue;
      const { renderSmsTemplate } = require('./sms-template-renderer');
      const body = await renderSmsTemplate(OPTIN_TEMPLATE_KEY, {
        recipient_first_name: String(contact.firstName || contact.name || '').trim().split(/\s+/)[0] || 'there',
        account_first_name: String(customer?.first_name || '').trim() || 'Your account holder',
        property_address: String(propertyAddress || '').trim() || 'your service property',
      });
      // Active template that fails to render = infrastructure failure.
      if (!body) throw new Error('active recipient_optin_request template failed to render');
      if (!retryClaim) {
        const claimed = await dbc('recipient_optin').insert({
          phone_key: key,
          phone_e164: String(contact.phone || '').trim(),
          status: 'pending',
          customer_id: customer?.id || null,
          requested_by: 'portal_contact_save',
          template_version: OPTIN_TEMPLATE_VERSION,
          requested_at: new Date(),
        }).onConflict('phone_key').ignore().returning('phone_key');
        if (!claimed || !claimed.length) continue; // row already exists — never re-text
      }
      claims.push({ key, phone: contact.phone, body });
    } catch (err) {
      // Fail CLOSED: a claim error must fail the contact save — silently
      // proceeding would store a phone with no row (grandfathered) and
      // quietly disable the consent boundary.
      logger.error(`[recipient-optin] claim failed for ***${key.slice(-4)}: ${err.message}`);
      throw err;
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
        // They were never asked: keep a BLOCKING ask_failed row (texts
        // stay held) that the next consented save re-claims and retries —
        // deleting it would grandfather a phone that never got the ask.
        await db('recipient_optin').where({ phone_key: claim.key, status: 'pending' }).update({ status: 'ask_failed', updated_at: new Date() }).catch(() => {});
        logger.warn(`[recipient-optin] request blocked for ***${claim.key.slice(-4)}: ${result.code || 'unknown'}`);
        continue;
      }
      requested += 1;
    } catch (err) {
      await db('recipient_optin').where({ phone_key: claim.key, status: 'pending' }).update({ status: 'ask_failed', updated_at: new Date() }).catch(() => {});
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
