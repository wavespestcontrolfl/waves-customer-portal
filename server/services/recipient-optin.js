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

// True only when the opt-in rail can actually ASK a recipient: the double
// opt-in gate is on AND the recipient_optin_request template row exists and is
// active (the same lookup claimRecipientOptins uses to decide "dark"). The
// call pipeline's on-site ask needs this: with the rail dark nobody can be
// asked. A READ FAILURE throws (dark and broken are different, as in
// claimRecipientOptins): the call's processing pass fails and is retried,
// instead of finalizing as if the rail were intentionally dark.
async function isOptinRailLive() {
  if (!isDoubleOptinEnabled()) return false;
  const row = await db('sms_templates').where({ template_key: OPTIN_TEMPLATE_KEY }).first();
  return !!row && row.is_active !== false;
}

// The customer's service_preferences object (jsonb, or a JSON string from a
// raw read), {} when absent.
function prefsOf(customer) {
  const raw = customer?.service_preferences;
  return (typeof raw === 'string' ? JSON.parse(raw || '{}') : raw) || {};
}
// A root handle opens its own transaction (so the row lock holds and the steps
// commit together); a transaction handle nests a savepoint. On the webhook's
// transactional handle a failure is RETHROWN: the YES must not commit while
// its consent hold stays in place (the phone would stay held forever), so the
// transition fails and the webhook's fail-loud fallback retries it — the same
// rule markRecipientOptin applies to its own reads. A fire-and-forget caller
// keeps the best-effort null.
async function withSavepoint(dbh, fn) {
  try {
    if (dbh && typeof dbh.transaction === 'function') return await dbh.transaction(fn);
    return await fn(dbh);
  } catch (err) {
    if (dbh && dbh.isTransaction) throw err;
    logger.warn(`[recipient-optin] confirm/decline follow-up failed (${err.code || err.name || 'error'})`);
    return null;
  }
}

// Stamp the account's service-contact consent artifact from a recipient's own
// YES (owner redesign 2026-10-01: the call pipeline infers no consent; the
// on-site person's YES to the opt-in text IS the consent). The artifact is
// ACCOUNT-WIDE ("every slot phone is consented"), so it is stamped only when
// the confirmed phone sits in one of the customer's slots AND every OTHER slot
// phone is already covered: its own confirmed recipient_optin row, or a phone
// the previous stamp covered when an unconsented add cleared it
// (consent_covered_phone_keys). Otherwise it stays off and the review card
// says why. Returns { stamped, reason }.
async function stampConsentOnConfirm(h, customerId, phoneKey, customer) {
  if (customer.service_contacts_consent_at) return { stamped: true, reason: 'already_stamped' };
  const { SERVICE_CONTACT_SLOTS } = require('./customer-contact');
  const slotKeys = SERVICE_CONTACT_SLOTS.map((slot) => recipientPhoneKey(customer[slot.phone])).filter(Boolean);
  if (!slotKeys.includes(phoneKey)) return { stamped: false, reason: 'phone_not_in_a_slot' };
  const others = [...new Set(slotKeys.filter((k) => k !== phoneKey))];
  if (others.length) {
    const confirmed = await h('recipient_optin')
      .where({ customer_id: customerId, status: 'confirmed' })
      .whereIn('phone_key', others)
      .select('phone_key');
    const confirmedKeys = new Set((confirmed || []).map((r) => r.phone_key));
    const coveredKeys = new Set(prefsOf(customer).consent_covered_phone_keys || []);
    if (!others.every((k) => confirmedKeys.has(k) || coveredKeys.has(k))) return { stamped: false, reason: 'other_slot_phone_unconfirmed' };
  }
  // Bound to the slot phones just checked: a concurrent contact add/replace
  // changes a column and the stamp writes nothing (row_changed).
  let stampQuery = h('customers').where({ id: customerId }).whereNull('service_contacts_consent_at');
  for (const slot of SERVICE_CONTACT_SLOTS) {
    stampQuery = customer[slot.phone] ? stampQuery.where({ [slot.phone]: customer[slot.phone] }) : stampQuery.whereNull(slot.phone);
  }
  const wrote = await stampQuery
    .update({
      service_contacts_consent_at: new Date(),
      service_contacts_consent_source: 'recipient_optin_confirmed',
      service_contacts_consent_text_version: OPTIN_TEMPLATE_VERSION,
    });
  return wrote ? { stamped: true, reason: 'stamped' } : { stamped: false, reason: 'row_changed' };
}

// Breadcrumb on the open secondary_contact_captured review card for this
// recipient (matched by the contact phone in its payload): optin_result
// confirmed|declined, plus consent_stamp when the stamp was held. With a
// customerId, only that customer's calls' cards (each account's own outcome).
async function updateCaptureCard(h, phoneKey, patch, customerId = null) {
  let q = h('triage_items');
  if (customerId) q = q.whereIn('call_log_id', h('call_log').where({ customer_id: customerId }).select('id'));
  await q
    .where({ reason_code: 'secondary_contact_captured' })
    .whereIn('status', ['open', 'in_progress'])
    .whereRaw("right(regexp_replace(coalesce(payload #>> '{secondary_contact,phone}', ''), '\\D', '', 'g'), 10) = ?", [phoneKey])
    .update({
      payload: h.raw("(coalesce(payload, '{}'::jsonb)) || ?::jsonb", [JSON.stringify(patch)]),
      updated_at: new Date(),
    });
}

// A nonessential step (a review-card breadcrumb) in its own savepoint: its
// failure is logged and never rolls back the opt-in / opt-out transition it
// rides on.
async function bestEffort(dbh, fn) {
  try {
    if (dbh && typeof dbh.transaction === 'function') await dbh.transaction(fn);
    else await fn(dbh);
  } catch (err) {
    logger.warn(`[recipient-optin] review-card breadcrumb failed (${err.code || err.name || 'error'})`);
  }
}

// One customer's consent follow-up for a phone that has confirmed its opt-in
// (under that customer's row lock, so two recipients answering at once
// serialize): the phone leaves the account's unconsented list and the account
// consent artifact is stamped when the whole row is covered.
async function applyConfirmedPhone(h, customerId, phoneKey) {
  const customer = await h('customers').where({ id: customerId }).forUpdate().first();
  if (!customer) return null;
  await h('customers').where({ id: customerId })
    .whereRaw("COALESCE(service_preferences -> 'unconsented_slot_phone_keys', '[]'::jsonb) @> to_jsonb(ARRAY[?::text])", [phoneKey])
    .update({ service_preferences: h.raw("jsonb_set(service_preferences, '{unconsented_slot_phone_keys}', COALESCE((SELECT jsonb_agg(k) FROM jsonb_array_elements(service_preferences -> 'unconsented_slot_phone_keys') k WHERE k <> to_jsonb(?::text)), '[]'::jsonb))", [phoneKey]) });
  return stampConsentOnConfirm(h, customerId, phoneKey, customer);
}

// A YES confirmed this phone: for each customer with a confirmed row for it,
// apply the consent follow-up (durable: on the webhook's transaction a
// failure fails the transition), then record the outcome on that customer's
// review card (best-effort).
async function onRecipientConfirmed(phoneKey, { dbh = db } = {}) {
  const outcomes = [];
  await withSavepoint(dbh, async (h) => {
    const rows = await h('recipient_optin').where({ phone_key: phoneKey, status: 'confirmed' }).whereNotNull('customer_id').select('customer_id');
    for (const { customer_id: customerId } of rows || []) {
      const stamp = await applyConfirmedPhone(h, customerId, phoneKey);
      if (stamp) outcomes.push({ customerId, stamp });
    }
  });
  for (const { customerId, stamp } of outcomes) {
    await bestEffort(dbh, (h) => updateCaptureCard(h, phoneKey, {
      optin_result: 'confirmed',
      ...(stamp.stamped ? {} : { consent_stamp: `held:${stamp.reason}` }),
    }, customerId));
  }
}

// A phone that already confirmed its opt-in on this account was filed again
// (removed, then re-added by a later call): the same consent follow-up as its
// YES, so the account stamp an intervening contact edit cleared is restored
// when the whole row is covered. Best-effort.
async function restoreConfirmedPhone(customerId, phoneKey) {
  await bestEffort(db, (h) => applyConfirmedPhone(h, customerId, phoneKey));
}

// A NO / STOP declined this phone: the review card says so (best-effort — a
// card outage must never roll back an opt-out). The phone stays on any
// unconsented list (it never consented).
async function onRecipientDeclined(phoneKey, { dbh = db } = {}) {
  await bestEffort(dbh, (h) => updateCaptureCard(h, phoneKey, { optin_result: 'declined' }));
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
async function markRecipientOptin(phone, status, { dbh = db } = {}) {
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
    const q = dbh('recipient_optin').where({ phone_key: key });
    // A YES can only confirm rows whose ask actually went out: ask_failed
    // (delivery failed) and undispatched pending rows (claim committed,
    // dispatch not yet run/crashed) are excluded — the recovery sweep or
    // next save re-asks them. STOP still declines everything. DECLINED
    // rows confirm regardless of dispatched_at (codex #3495 r13): a
    // synchronous 21610 declines the row BEFORE dispatch stamps
    // dispatched_at, and no sweep re-asks a declined row — without this
    // carve-out the person's later explicit START+YES clears suppression
    // but can never unblock their appointment texts. An explicit inbound
    // YES from an already-declined person supersedes the carrier verdict,
    // exactly as it does for the callback path's dispatched declines.
    // Lock order (#5467): a YES writes the customer rows (consent stamp,
    // unconsented hold) after the recipient_optin rows, while a portal
    // contact save locks the customer first and then claims opt-in rows.
    // Take the customers FIRST, in id order, so the two never deadlock.
    if (status === 'confirmed' && dbh && dbh.isTransaction) {
      const customerIds = (await dbh('recipient_optin').where({ phone_key: key }).whereNotNull('customer_id').select('customer_id'))
        .map((r) => r.customer_id).sort();
      if (customerIds.length) await dbh('customers').whereIn('id', customerIds).orderBy('id').forUpdate().select('id');
    }
    if (status === 'confirmed') {
      q.whereNot({ status: 'ask_failed' }).where(function confirmable() {
        this.whereNotNull('dispatched_at').orWhere({ status: 'declined' });
      });
    }
    let updated = await q.update(stamp);
    // Marker-recovery window: Twilio accepted the ask but the dispatched_at
    // write crashed, and the person replied YES before the sweep
    // reconciled. If sms_log shows an accepted ask to this phone, honor
    // the YES for the still-pending rows (ask_failed stays excluded).
    // Runs regardless of the first update's count: property A's confirmed
    // row must not skip reconciling property B's accepted-but-unmarked ask.
    if (status === 'confirmed') {
      // Per-row reconciliation: only a row whose OWN property's ask was
      // accepted (customer-scoped sms_log) confirms — property B's
      // undispatched pending row stays pending when only A's ask went out.
      const pendingRows = await dbh('recipient_optin').where({ phone_key: key, status: 'pending' });
      for (const row of pendingRows) {
        const priorAskRow = await dbh('sms_log')
          .whereRaw("right(regexp_replace(coalesce(to_phone, ''), '\\D', '', 'g'), 10) = ?", [key])
          .where({ customer_id: row.customer_id })
          .where(function optinAsk() {
            this.where({ message_type: 'recipient_optin_request' })
              .orWhereRaw("metadata::text like '%recipient_optin_request%'");
          })
          .orderBy('created_at', 'desc')
          .first('id', 'twilio_sid', 'status')
          .catch((err) => {
            // On a transactional dbh Postgres has already ABORTED on this
            // error; swallowing it here can let COMMIT silently resolve as a
            // rollback when no later query trips 25P02 (hook #3495) — the
            // caller would report success with nothing persisted. Rethrow so
            // the outer catch returns FALSE and the webhook's fail-loud
            // guard runs its locked fallback. Fire-and-forget callers keep
            // the best-effort null.
            if (dbh && dbh.isTransaction) throw err;
            return null;
          });
        const { isFailureStatus } = require('./twilio-failure-alerts');
        if (priorAskRow && !isFailureStatus(priorAskRow.status)) {
          updated += await dbh('recipient_optin')
            .where({ phone_key: key, customer_id: row.customer_id, status: 'pending' })
            .update({
              ...stamp,
              dispatched_at: new Date(),
              ...(priorAskRow.twilio_sid ? { provider_sid: String(priorAskRow.twilio_sid).slice(0, 64) } : {}),
            });
        }
      }
    }
    if (updated) {
      if (status === 'confirmed') await onRecipientConfirmed(key, { dbh });
      else if (status === 'declined') await onRecipientDeclined(key, { dbh });
      logger.info(`[recipient-optin] ${status} recorded for ***${key.slice(-4)}`);
    }
    // Returns the UPDATED COUNT (0 = no recipient rows — the normal case
    // for most phones), reserving FALSE for the swallowed-error path below
    // so transactional callers can distinguish "nothing to decline" from
    // "the write failed and aborted my transaction" (codex #3495). Both are
    // falsy, so fire-and-forget callers behave exactly as before.
    return updated;
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
// visitId (optional): the booked visit an on-site ask is about (#5467). It is
// stored on the row (recipient_optin.visit_id) and rides the claim into a
// send-window-deferred ask: both the deferred replay and the undispatched-ask
// recovery sweep send it only while that visit is still confirmed and ahead.
// An on-site ask's dispatch lease (dispatch_lease_at) is live for 10 minutes;
// older means the dispatching process died and the row may be retried.
const LEASE_TTL_MS = 10 * 60 * 1000;
function leaseFree(q) {
  q.whereNull('dispatch_lease_at').orWhere('dispatch_lease_at', '<', new Date(Date.now() - LEASE_TTL_MS));
}

async function claimRecipientOptins({ customer, contacts = [], priorPhones = [], propertyAddress = '', trx = null, visitId = null }) {
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
                .where(leaseFree)
                .where('requested_at', '<', new Date(Date.now() - 10 * 60 * 1000));
            });
          // A newer booked visit supersedes an on-site ask still waiting
          // (undispatched) on an earlier visit — e.g. an office-review hold —
          // so the live booking is the one asked about. A dispatched ask is
          // never re-sent.
          if (visitId) {
            this.orWhere(function supersededVisitAsk() {
              this.where(leaseFree);
              this.where({ status: 'pending' })
                .whereNull('dispatched_at')
                .whereNotNull('visit_id')
                .whereNot({ visit_id: visitId });
            });
          }
        })
        .update({
          status: 'pending', requested_at: new Date(), dispatched_at: null, dispatch_lease_at: null, provider_sid: null, updated_at: new Date(),
          visit_id: visitId || null,
        });
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
          visit_id: visitId || null,
          requested_at: new Date(),
        }).onConflict(['customer_id', 'phone_key']).ignore().returning('phone_key');
        if (!claimed || !claimed.length) continue; // row already exists — never re-text
      }
      claims.push({ key, customerId: customer?.id || null, phone: contact.phone, body, visitId });
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
    // This claim's row, bound to its visit (an on-site ask) or to NO visit (a
    // portal / explicit-consent ask): a booking that rebound the row to a
    // visit is never touched by an older claim. With the lease taken, every
    // write is also scoped to THAT lease.
    let leaseAt = null;
    const claimRow = () => db('recipient_optin')
      .where({ phone_key: claim.key, customer_id: claim.customerId, status: 'pending' })
      .where((q) => { if (claim.visitId) q.where({ visit_id: claim.visitId }); else q.whereNull('visit_id'); })
      .where((q) => { if (leaseAt) q.where({ dispatch_lease_at: leaseAt }); });
    const markAttempted = () => claimRow()
      .update({ dispatched_at: new Date(), dispatch_lease_at: null, updated_at: new Date() })
      .catch(() => {});
    try {
      // Every ask takes a DISPATCH LEASE first (dispatch_lease_at, while
      // undispatched, bound to its visit or none, and not already leased): a
      // newer booking can no longer rebind it, and only one claim sends. The lease
      // is NOT dispatched_at — that stays the proof the provider accepted the
      // ask, so a YES can never confirm an ask still in flight. The visit is re-checked at
      // the provider boundary under the lease: dead releases the ask
      // (ask_failed); a hold or an unreadable check returns the lease (the
      // recovery sweep retries).
      const takenAt = new Date();
      const leased = await claimRow().whereNull('dispatched_at').where(leaseFree)
        .update({ dispatch_lease_at: takenAt, updated_at: new Date() });
      if (!leased) continue;
      leaseAt = takenAt;
      if (claim.visitId) {
        const asked = await visitAskState(claim.visitId, claim.customerId).catch(() => ({ state: 'unknown' }));
        if (asked.state !== 'live') {
          await claimRow().update({
            ...(asked.state === 'dead' ? { status: 'ask_failed' } : {}),
            dispatch_lease_at: null, updated_at: new Date(),
          }).catch(() => {});
          continue;
        }
      }
      const { sendCustomerMessage } = require('./messaging/send-customer-message');
      // An on-site ask re-checks its visit once more at the provider boundary
      // (after the sender's own consent / audit awaits), so a visit cancelled,
      // moved or under way meanwhile never gets an address-bearing ask.
      let boundaryState = null;
      const result = await sendCustomerMessage({
        ...(claim.visitId ? {
          preProviderCheck: async () => {
            // The phone must still occupy a service-contact slot: a contact
            // removed or replaced since the claim is never asked (dead).
            const inSlot = await db('customers').where({ id: claim.customerId })
              .first('service_contact_phone', 'service_contact2_phone', 'service_contact3_phone')
              .then((c) => (c ? [c.service_contact_phone, c.service_contact2_phone, c.service_contact3_phone]
                .some((ph) => recipientPhoneKey(ph) === claim.key) : false))
              .catch(() => null);
            const s = inSlot === false ? { state: 'dead' }
              : inSlot === null ? { state: 'unknown' }
                : await visitAskState(claim.visitId, claim.customerId).catch(() => ({ state: 'unknown' }));
            boundaryState = s.state;
            return s.state === 'live'
              ? { ok: true }
              : { ok: false, code: 'ONSITE_VISIT_NOT_LIVE', reason: `visit ${s.state}` };
          },
        } : {}),
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
      // Send-window hold: ask_failed is only re-claimed by a LATER contact
      // save, so a night hold would leave this recipient blocked from all
      // texts indefinitely. Queue the ask on the scheduled-SMS rail for
      // 8:00 AM instead — the queued row owns the ask, the row stays
      // pending (dispatched), and the recipient's YES reply flips it
      // through the normal inbound path.
      // The boundary visit check refused: dead releases the ask; a hold or an
      // unreadable check returns the lease for the recovery sweep.
      if (claim.visitId && result.blocked && boundaryState && boundaryState !== 'live') {
        await claimRow().update({
          ...(boundaryState === 'dead' ? { status: 'ask_failed' } : {}),
          dispatch_lease_at: null, updated_at: new Date(),
        }).catch(() => {});
        continue;
      }
      // An on-site visit ask never rides the deferred queue (owner 10-02): its
      // lease is returned and the row stays pending, so the recovery sweep
      // sends it for its visit once the window opens.
      if (claim.visitId && result.blocked && result.code === 'QUIET_HOURS_HOLD') {
        await claimRow().update({ dispatch_lease_at: null, updated_at: new Date() }).catch(() => {});
        logger.info(`[recipient-optin] on-site ask for ***${claim.key.slice(-4)} held outside the send window — the recovery sweep sends it later`);
        continue;
      }
      if (result.blocked
        && result.code === 'QUIET_HOURS_HOLD'
        && result.deferred
        && result.nextAllowedAt) {
        try {
          const TWILIO_NUMBERS = require('../config/twilio-numbers');
          // Queue row + dispatch marker commit ATOMICALLY: a committed
          // queue row with a failed dispatched_at write leaves the ask
          // pending-undispatched, and the 10-minute stale-pending recovery
          // (sweep + save-time reclaim) would re-ask while the queued row
          // still delivers at 8:00 AM — duplicate asks. Exactly one marked
          // row or the whole enqueue rolls back to the ask_failed release.
          await db.transaction(async (trx) => {
            await trx('sms_log').insert({
              customer_id: customer?.id || null,
              direction: 'outbound',
              from_phone: TWILIO_NUMBERS.getOutboundNumber(),
              to_phone: claim.phone,
              message_body: claim.body,
              status: 'scheduled',
              scheduled_for: new Date(result.nextAllowedAt),
              message_type: 'recipient_optin_request',
              metadata: JSON.stringify({
                entry_point: 'recipient_optin_deferred',
                original_block_code: result.code,
                replay_purpose: 'appointment',
                // Replay-time staleness recheck keys (deferred-replay
                // registry): the ask only sends if this row is still pending.
                optin_phone_key: claim.key,
                optin_customer_id: claim.customerId || null,
                optin_visit_id: claim.visitId || null,
                // from_phone above is the NOT NULL placeholder; replay on
                // the customer's location line like the immediate send.
                ...(customer?.id ? { resolve_from_by_customer: true } : {}),
              }),
            });
            const marked = await trx('recipient_optin')
              .where({ phone_key: claim.key, customer_id: claim.customerId, status: 'pending', dispatch_lease_at: leaseAt })
              .whereNull('visit_id')
              .update({ dispatched_at: new Date(), dispatch_lease_at: null, updated_at: new Date() });
            if (marked !== 1) {
              throw new Error(`dispatch marker update touched ${marked} rows (expected 1)`);
            }
          });
          requested += 1;
          logger.info(`[recipient-optin] ask for ***${claim.key.slice(-4)} held outside the 8AM-8PM ET send window — queued for ${result.nextAllowedAt}`);
          continue;
        } catch (queueErr) {
          logger.error(`[recipient-optin] held ask requeue failed for ***${claim.key.slice(-4)}: ${queueErr.message}`);
          // fall through to the ask_failed release below
        }
      }
      // A provider timeout resolves as UNCERTAIN: the ask may have gone out,
      // so it counts as ATTEMPTED — marked dispatched (no SID): the
      // recipient's YES is honored and no sweep re-sends it.
      if (result?.deliveryOutcome === 'uncertain') {
        await markAttempted();
        logger.warn(`[recipient-optin] ask for ***${claim.key.slice(-4)} has an uncertain outcome; marked attempted`);
        continue;
      }
      if (result.blocked || result.sent === false || result.suppressed === true || sentinelSid) {
        // They were never asked: keep a BLOCKING ask_failed row (texts
        // stay held) that the next consented save re-claims and retries —
        // deleting it would grandfather a phone that never got the ask.
        await claimRow().update({ status: 'ask_failed', dispatch_lease_at: null, updated_at: new Date() }).catch(() => {});
        logger.warn(`[recipient-optin] request blocked for ***${claim.key.slice(-4)}: ${result.code || 'unknown'}`);
        continue;
      }
      await claimRow()
        .update({
          dispatched_at: new Date(),
          dispatch_lease_at: null,
          // Provider context ON the row: the /status failure hook can flip
          // this ask to ask_failed even when the sms_log insert failed.
          provider_sid: String(result?.sid || result?.providerMessageId || '').slice(0, 64) || null,
          updated_at: new Date(),
        })
        .catch(() => {});
      requested += 1;
    } catch (err) {
      // The sender attaches its provider outcome to a post-handoff error: an
      // ACCEPTED ask is dispatched (a YES must confirm it, a reclaim must not
      // re-send it); an UNCERTAIN one stays pending — an on-site ask keeps its
      // lease until it goes stale — for the sweep's sms_log reconcile. Only a
      // send that never reached the provider is released to ask_failed.
      const outcome = err?.providerOutcome;
      if (outcome?.deliveryOutcome === 'accepted') {
        await claimRow().update({
          dispatched_at: new Date(),
          dispatch_lease_at: null,
          provider_sid: String(outcome.providerMessageId || outcome.sid || '').slice(0, 64) || null,
          updated_at: new Date(),
        }).catch(() => {});
        requested += 1;
        logger.warn(`[recipient-optin] ask accepted for ***${claim.key.slice(-4)} but the sender failed after: ${err.message}`);
        continue;
      }
      if (outcome?.deliveryOutcome === 'uncertain') {
        await markAttempted();
        logger.warn(`[recipient-optin] ask for ***${claim.key.slice(-4)} has an uncertain outcome; marked attempted: ${err.message}`);
        continue;
      }
      await claimRow().update({ status: 'ask_failed', dispatch_lease_at: null, updated_at: new Date() }).catch(() => {});
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
// Whether the visit an on-site ask is about can be asked about now (#5467):
//   'wait' — a street-level address hold still under office review (the shared,
//            source-aware hold predicate; a lookup error also reads as held);
//   'live' — status confirmed and its canonical arrival still ahead;
//   'dead' — gone, cancelled, under way, past, or never confirmed.
// Returns { state, visit }. Throws on any other read failure (callers retry).
async function visitAskState(visitId, customerId) {
  const { isStreetLevelHoldVisit } = require('./street-level-hold');
  if (await isStreetLevelHoldVisit(visitId)) return { state: 'wait', visit: null };
  const visit = await db('scheduled_services')
    .where({ id: visitId, customer_id: customerId, status: 'confirmed' })
    .first('id', 'service_address_line1', 'service_address_city');
  if (!visit) return { state: 'dead', visit: null };
  const at = await require('./appointment-reminders').scheduledServiceApptTime(visitId, { throwOnError: true });
  return at && at.getTime() > Date.now() ? { state: 'live', visit } : { state: 'dead', visit: null };
}

async function sweepUndispatchedOptins({ limit = 25 } = {}) {
  if (!isDoubleOptinEnabled()) return { swept: 0 };
  let rows = [];
  try {
    rows = await db('recipient_optin')
      .where({ status: 'pending' })
      .whereNull('dispatched_at')
      .where('requested_at', '<', new Date(Date.now() - 10 * 60 * 1000))
      // An on-site ask mid-dispatch is skipped; a stale lease (the process
      // died) is picked up, reconciled below, and re-leased by dispatch.
      .where(leaseFree)
      // Least-recently looked-at first: an on-site ask waiting out an office
      // review is touched each pass, so it never starves the rest.
      .orderBy('updated_at', 'asc')
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
        // Bound to the snapshot (same visit, still undispatched, no live
        // lease): a concurrent call that re-added the phone and rebound or
        // leased the row is never released.
        await db('recipient_optin')
          .where({ phone_key: row.phone_key, customer_id: row.customer_id, status: 'pending' })
          .where((q) => { if (row.visit_id) q.where({ visit_id: row.visit_id }); else q.whereNull('visit_id'); })
          .whereNull('dispatched_at')
          .where(leaseFree)
          .update({ status: 'ask_failed', updated_at: new Date() }).catch(() => {});
        continue;
      }
      // Reconcile before re-texting: if Twilio already accepted an ask to
      // this phone (crash landed between acceptance and the marker write),
      // just stamp dispatched_at — never send a duplicate confirmation.
      const priorSendRow = await db('sms_log')
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
        .orderBy('created_at', 'desc')
        .first('id', 'twilio_sid', 'status')
        .catch(() => ({ readFailed: true }));
      // An unreadable reconcile is not proof nothing was sent: leave the row
      // pending for the next sweep (never re-send or release on a guess).
      if (priorSendRow && priorSendRow.readFailed) continue;
      // Full failure set (mirrors the status webhook's isFailureStatus):
      // a busy/no-answer/canceled ask is NOT proof of delivery.
      const { isFailureStatus } = require('./twilio-failure-alerts');
      const priorSend = priorSendRow && !isFailureStatus(priorSendRow.status) ? priorSendRow : null;
      if (priorSend) {
        // Bound to the snapshot (same visit, still undispatched, no live
        // lease): a booking that rebound the row meanwhile is never marked
        // dispatched with this older ask's SID.
        await db('recipient_optin')
          .where({ phone_key: row.phone_key, customer_id: row.customer_id, status: 'pending' })
          .where((q) => { if (row.visit_id) q.where({ visit_id: row.visit_id }); else q.whereNull('visit_id'); })
          .whereNull('dispatched_at')
          .where(leaseFree)
          .update({
            dispatched_at: new Date(),
            dispatch_lease_at: null,
            // Copy the reconciled SID so a LATER failure callback can still
            // flip this row under the strict provider_sid match.
            ...(priorSend.twilio_sid ? { provider_sid: String(priorSend.twilio_sid).slice(0, 64) } : {}),
            updated_at: new Date(),
          }).catch(() => {});
        continue;
      }
      // An on-site visit ask (visit_id) not yet sent (its dispatch died, its
      // visit check was unreadable, or its visit is an office-review hold):
      // sent for that same visit once it is confirmed and ahead (quoting its
      // address), kept waiting while the hold is under review, and released
      // to ask_failed once the visit is gone — never sent for a dead visit.
      const asked = row.visit_id ? await visitAskState(row.visit_id, row.customer_id) : { state: 'live', visit: null };
      // Bound to the snapshot: the same visit, still undispatched — a
      // concurrent booking that rebound the row to another visit (and may
      // have sent its ask) is never touched.
      const snapshotRow = () => db('recipient_optin')
        .where({ phone_key: row.phone_key, customer_id: row.customer_id, status: 'pending', visit_id: row.visit_id })
        .whereNull('dispatched_at')
        .where(leaseFree);
      if (asked.state === 'wait') {
        await snapshotRow().update({ updated_at: new Date() }).catch(() => {});
        continue;
      }
      if (asked.state === 'dead') {
        await snapshotRow().update({ status: 'ask_failed', updated_at: new Date() }).catch(() => {});
        continue;
      }
      const { visit } = asked;
      const { renderSmsTemplate } = require('./sms-template-renderer');
      const visitAddress = visit ? [visit.service_address_line1, visit.service_address_city].filter(Boolean).join(', ') : '';
      const body = await renderSmsTemplate(OPTIN_TEMPLATE_KEY, {
        recipient_first_name: String(idx >= 0 ? slots[idx] || '' : '').trim().split(/\s+/)[0] || 'there',
        account_first_name: String(customer.first_name || '').trim() || 'Your account holder',
        property_address: visitAddress || [customer.address_line1, customer.city].filter(Boolean).join(', ') || 'your service property',
      });
      if (!body) continue; // template dark — leave pending-undispatched (held either way)
      const { requested } = await dispatchRecipientOptins(
        [{ key: row.phone_key, customerId: row.customer_id, phone: row.phone_e164 || row.phone_key, body, visitId: row.visit_id || null }],
        customer
      );
      swept += requested;
    } catch (err) {
      logger.warn(`[recipient-optin] sweep failed for ***${String(row.phone_key || '').slice(-4)}: ${err.message}`);
    }
  }
  if (swept) logger.info(`[recipient-optin] sweep dispatched ${swept} stale ask(s)`);
  // Second pass — early-failure race: a failure callback that arrived
  // BEFORE the SID/marker stamp couldn't identify its row; that row now
  // sits pending+dispatched while its logged ask actually failed. Flip
  // such rows to ask_failed so the next consented save (or this sweep's
  // reclaim) re-asks.
  try {
    const { isFailureStatus } = require('./twilio-failure-alerts');
    const dispatched = await db('recipient_optin')
      .where({ status: 'pending' })
      .whereNotNull('dispatched_at')
      .where('dispatched_at', '<', new Date(Date.now() - 30 * 60 * 1000))
      .limit(limit);
    for (const row of dispatched) {
      const lastAsk = await db('sms_log')
        .whereRaw("right(regexp_replace(coalesce(to_phone, ''), '\\D', '', 'g'), 10) = ?", [row.phone_key])
        .where({ customer_id: row.customer_id })
        .where(function optinAsk() {
          this.where({ message_type: 'recipient_optin_request' })
            .orWhereRaw("metadata::text like '%recipient_optin_request%'");
        })
        // Only THIS attempt's logs (since its claim): an older failed ask is
        // not evidence against a later retry (e.g. one marked attempted on an
        // uncertain handoff with no log of its own).
        .where('created_at', '>=', row.requested_at)
        .orderBy('created_at', 'desc')
        .first('status')
        .catch(() => null);
      if (lastAsk && isFailureStatus(lastAsk.status)) {
        await db('recipient_optin')
          .where({ phone_key: row.phone_key, customer_id: row.customer_id, status: 'pending', requested_at: row.requested_at })
          .update({ status: 'ask_failed', updated_at: new Date() }).catch(() => {});
      }
    }
  } catch { /* best-effort */ }
  return { swept };
}

module.exports = {
  OPTIN_TEMPLATE_KEY,
  OPTIN_TEMPLATE_VERSION,
  isDoubleOptinEnabled,
  isOptinRailLive,
  onRecipientConfirmed,
  onRecipientDeclined,
  restoreConfirmedPhone,
  visitAskState,
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
