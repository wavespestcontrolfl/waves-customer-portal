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

async function getRecipientOptin(phone, customerId = null) {
  const key = recipientPhoneKey(phone);
  if (!key) return null;
  try {
    const q = db('recipient_optin').where({ phone_key: key });
    if (customerId) q.where({ customer_id: customerId });
    return await q.first() || null;
  } catch (err) {
    // Split by failure type: a missing relation (42P01 — un-migrated env)
    // is the documented pre-opt-in state and fails OPEN to the #2955
    // row-level consent layer. Any OTHER error rethrows so
    // filterRecipientsByOptin's catch HOLDS the service contact — a live
    // DB blip must not text a possibly-declined recipient; held-and-
    // alerted (no-reachable-channel path) beats silently sent.
    if (err && err.code === '42P01') {
      logger.warn('[recipient-optin] table missing — failing open to row-level consent');
      return null;
    }
    logger.warn(`[recipient-optin] lookup failed (${err.message}) — holding via filter`);
    throw err;
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
    // Phone-wide by design: the reply comes from the person, and rows only
    // exist for properties that actually sent them an ask — a YES confirms
    // every DELIVERED ask to that person; a STOP declines them all.
    // ask_failed rows are excluded from confirmation (that property's ask
    // never reached them — the save-triggered retry must still run) but ARE
    // declined on STOP (they said stop; never re-ask).
    const q = db('recipient_optin').where({ phone_key: key });
    // A YES can only confirm rows whose ask actually went out: ask_failed
    // (delivery failed) and undispatched pending rows (claim committed,
    // dispatch not yet run/crashed) are excluded — the recovery sweep or
    // next save re-asks them. STOP still declines everything.
    if (status === 'confirmed') q.whereNot({ status: 'ask_failed' }).whereNotNull('dispatched_at');
    let updated = await q.update(stamp);
    // Marker-recovery window: Twilio accepted the ask but the dispatched_at
    // write crashed, and the person replied YES before the sweep
    // reconciled. If sms_log shows an accepted ask to this phone, honor
    // the YES for the still-pending rows (ask_failed stays excluded).
    if (!updated && status === 'confirmed') {
      // Per-row reconciliation: only a row whose OWN property's ask was
      // accepted (customer-scoped sms_log) confirms — property B's
      // undispatched pending row stays pending when only A's ask went out.
      const pendingRows = await db('recipient_optin').where({ phone_key: key, status: 'pending' });
      for (const row of pendingRows) {
        const priorAsk = await db('sms_log')
          .whereRaw("right(regexp_replace(coalesce(to_phone, ''), '\\D', '', 'g'), 10) = ?", [key])
          .where({ customer_id: row.customer_id })
          .where(function optinAsk() {
            this.where({ message_type: 'recipient_optin_request' })
              .orWhereRaw("metadata::text like '%recipient_optin_request%'");
          })
          .whereNotIn('status', ['failed', 'undelivered'])
          .first('id')
          .catch(() => null);
        if (priorAsk) {
          updated += await db('recipient_optin')
            .where({ phone_key: key, customer_id: row.customer_id, status: 'pending' })
            .update({ ...stamp, dispatched_at: new Date() });
        }
      }
    }
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
async function filterRecipientsByOptin(contacts = [], customerId = null) {
  if (!isDoubleOptinEnabled()) return contacts;
  const { isServiceContactRole } = require('./customer-contact');
  const kept = [];
  for (const contact of contacts) {
    if (!isServiceContactRole(contact.role)) { kept.push(contact); continue; }
    try {
      const row = await getRecipientOptin(contact.phone, customerId);
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
      // Retryable states: ask_failed (delivery failed) and STALE pending
      // with no dispatch marker (claim committed but the process died or a
      // later step failed before the ask went out). dispatched_at is the
      // durable marker — an asked-but-unanswered recipient is never
      // re-texted.
      const reclaimed = templateDark ? 0 : await dbc('recipient_optin')
        .where({ phone_key: key, customer_id: customer?.id || null })
        .where(function retryable() {
          this.where({ status: 'ask_failed' })
            .orWhere(function stalePending() {
              this.where({ status: 'pending' })
                .whereNull('dispatched_at')
                .where('requested_at', '<', new Date(Date.now() - 10 * 60 * 1000));
            });
        })
        .update({ status: 'pending', requested_at: new Date(), dispatched_at: null, provider_sid: null, updated_at: new Date() });
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
        }).onConflict(['customer_id', 'phone_key']).ignore().returning('phone_key');
        if (!claimed || !claimed.length) continue; // row already exists — never re-text
      }
      claims.push({ key, customerId: customer?.id || null, phone: contact.phone, body });
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
      // Success-shaped sentinels (gate-blocked / template-disabled /
      // internal-redirect / suppressed) mean NO confirmation text reached
      // the recipient — no Twilio status callback will ever flip the row,
      // so treat them as failed asks and release to ask_failed for the
      // save-triggered retry (#2956 r4).
      const sentinelSid = /^(gate|template|internal|owner)-/.test(String(result?.sid || result?.providerMessageId || ''));
      if (result.blocked || result.sent === false || result.suppressed === true || sentinelSid) {
        // They were never asked: keep a BLOCKING ask_failed row (texts
        // stay held) that the next consented save re-claims and retries —
        // deleting it would grandfather a phone that never got the ask.
        await db('recipient_optin').where({ phone_key: claim.key, customer_id: claim.customerId, status: 'pending' }).update({ status: 'ask_failed', updated_at: new Date() }).catch(() => {});
        logger.warn(`[recipient-optin] request blocked for ***${claim.key.slice(-4)}: ${result.code || 'unknown'}`);
        continue;
      }
      await db('recipient_optin')
        .where({ phone_key: claim.key, customer_id: claim.customerId, status: 'pending' })
        .update({
          dispatched_at: new Date(),
          // Provider context ON the row: the /status failure hook can flip
          // this ask to ask_failed even when the sms_log insert failed.
          provider_sid: String(result?.sid || result?.providerMessageId || '').slice(0, 64) || null,
          updated_at: new Date(),
        })
        .catch(() => {});
      requested += 1;
    } catch (err) {
      await db('recipient_optin').where({ phone_key: claim.key, customer_id: claim.customerId, status: 'pending' }).update({ status: 'ask_failed', updated_at: new Date() }).catch(() => {});
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

// Automatic recovery (cron): pending claims whose dispatch never happened
// (dispatched_at NULL, >10 min old — deploy/crash between claim commit and
// the fire-and-forget dispatch) get their ask sent now. Renders per row's
// customer; a dark template or send failure releases the row to ask_failed
// via the normal dispatch path. Bounded batch; no-op when the gate is off.
async function sweepUndispatchedOptins({ limit = 25 } = {}) {
  if (!isDoubleOptinEnabled()) return { swept: 0 };
  let rows = [];
  try {
    rows = await db('recipient_optin')
      .where({ status: 'pending' })
      .whereNull('dispatched_at')
      .where('requested_at', '<', new Date(Date.now() - 10 * 60 * 1000))
      .limit(limit);
  } catch { return { swept: 0 }; }
  let swept = 0;
  for (const row of rows) {
    try {
      const customer = row.customer_id
        ? await db('customers').where({ id: row.customer_id }).first()
        : null;
      if (!customer) continue;
      const slots = [customer.service_contact_name, customer.service_contact2_name, customer.service_contact3_name];
      const phones = [customer.service_contact_phone, customer.service_contact2_phone, customer.service_contact3_phone];
      const idx = phones.findIndex((ph) => recipientPhoneKey(ph) === row.phone_key);
      // Contact removed/replaced since the claim: they are no longer an
      // appointment recipient for this property — release to ask_failed
      // (re-adding them re-claims and asks) instead of texting a stranger.
      if (idx < 0) {
        await db('recipient_optin')
          .where({ phone_key: row.phone_key, customer_id: row.customer_id, status: 'pending' })
          .update({ status: 'ask_failed', updated_at: new Date() }).catch(() => {});
        continue;
      }
      // Reconcile before re-texting: if Twilio already accepted an ask to
      // this phone (crash landed between acceptance and the marker write),
      // just stamp dispatched_at — never send a duplicate confirmation.
      const priorSend = await db('sms_log')
        .whereRaw("right(regexp_replace(coalesce(to_phone, ''), '\\D', '', 'g'), 10) = ?", [row.phone_key])
        // Scoped to THIS property's customer: property A's delivered ask is
        // not proof property B's ask went out.
        .where({ customer_id: row.customer_id })
        .where(function optinAsk() {
          this.where({ message_type: 'recipient_optin_request' })
            // metadata is JSONB — cast before LIKE or the query errors and
            // the catch defeats reconciliation entirely.
            .orWhereRaw("metadata::text like '%recipient_optin_request%'");
        })
        .whereNotIn('status', ['failed', 'undelivered'])
        .first('id')
        .catch(() => null);
      if (priorSend) {
        await db('recipient_optin')
          .where({ phone_key: row.phone_key, customer_id: row.customer_id, status: 'pending' })
          .update({ dispatched_at: new Date(), updated_at: new Date() }).catch(() => {});
        continue;
      }
      const { renderSmsTemplate } = require('./sms-template-renderer');
      const body = await renderSmsTemplate(OPTIN_TEMPLATE_KEY, {
        recipient_first_name: String(idx >= 0 ? slots[idx] || '' : '').trim().split(/\s+/)[0] || 'there',
        account_first_name: String(customer.first_name || '').trim() || 'Your account holder',
        property_address: [customer.address_line1, customer.city].filter(Boolean).join(', ') || 'your service property',
      });
      if (!body) continue; // template dark — leave pending-undispatched (held either way)
      const { requested } = await dispatchRecipientOptins(
        [{ key: row.phone_key, customerId: row.customer_id, phone: row.phone_e164 || row.phone_key, body }],
        customer
      );
      swept += requested;
    } catch (err) {
      logger.warn(`[recipient-optin] sweep failed for ***${String(row.phone_key || '').slice(-4)}: ${err.message}`);
    }
  }
  if (swept) logger.info(`[recipient-optin] sweep dispatched ${swept} stale ask(s)`);
  return { swept };
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
  sweepUndispatchedOptins,
};
