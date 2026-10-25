'use strict';

// GATE_NEW_CALLER_BOOKING, the call-recording agent's link step (owner plan
// 2026-10-25, decision page 2CGso96J). The office booked a NEW caller's visit
// by address while the call was live (new-caller-visit.js: no customer, the
// call stamped on the visit). Once the processor's token-fenced checkpoint has
// written the call's customer, this links the visit to that customer (D1; D6:
// a new address becomes one of the customer's properties) and sets up its
// reminders and confirmation (D3). A pass that leaves the visit with no
// customer (the call has none, or the link was refused) rings the visit's
// bell (D4a, key new-caller-visit:<id>), which a link closes. Never throws:
// the call pass goes on whatever happens here.

const db = require('../../models/db');
const { isEnabled } = require('../../config/feature-gates');
const logger = require('../logger');
const { dateOnlyString, parseETDateTime } = require('../../utils/datetime-et');
const { raiseAdminAlert } = require('../admin-alert-compose');
const { checkTcpaConsent } = require('../call-routing-gates');
const {
  NEW_CALLER_SOURCE_ACTION, linkNewCallerVisit, armLinkedVisitComms, newCallerVisitAlertKey,
} = require('./new-caller-visit');

// The owner can silence it in Settings → Notifications (bellDefault, below).
const CATEGORY = 'schedule';
const lastTen = (value) => String(value || '').replace(/\D/g, '').slice(-10);

// "Tue Nov 3", the day a person would say.
function dayWords(visit) {
  const date = dateOnlyString(visit.scheduled_date);
  const at = parseETDateTime(`${date}T12:00`);
  if (!date || Number.isNaN(at.getTime())) return '';
  return at.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' }).replace(',', '');
}

const visitLink = (visit) => `/admin/dispatch?tab=schedule&date=${dateOnlyString(visit.scheduled_date)}&appointment=${encodeURIComponent(visit.id)}`;

// The confirmation text follows the pass's own rules for its confirmation:
// nothing while the pass blocks texts (consent in enforce routing, a
// disclaimed or no-text number); the consent check runs whatever the routing
// mode, fail-closed, as the outbound booking recompute does; and implied
// consent covers only the number that called, while this confirmation goes
// to the customer's phone on file.
async function textDecision(conn, customerId, text = {}) {
  if (text.passBlocked !== false) return { send: false, held: 'consent' };
  let consent;
  try {
    consent = checkTcpaConsent(text.extraction || null, { impliedConsent: text.impliedConsent === true });
  } catch {
    consent = { canSms: false };
  }
  if (!consent.canSms) return { send: false, held: 'consent' };
  if (consent.reason !== 'implied_consent_inbound') return { send: true };
  const customer = await conn('customers').where({ id: customerId }).first('phone');
  const phone = lastTen(customer?.phone);
  return phone.length === 10 && phone === lastTen(text.callerPhone) ? { send: true } : { send: false, held: 'other_number' };
}

const UNLINKED_WHY = {
  no_customer: 'The call recording named no customer, so the visit has no reminders or confirmation yet.',
  refused: 'The call recording could not link the visit to its customer, so it has no reminders or confirmation yet.',
};

async function ringUnlinked(visit, reason, refusal = '') {
  const day = dayWords(visit);
  const detail = reason === 'no_customer'
    ? 'The call recording was processed, but the call gave no customer to link: the caller may share a phone with an account, or the call named no one.'
    : `The call named a customer, but the link was refused. ${refusal}`;
  return raiseAdminAlert(CATEGORY, {
    area: 'Schedule',
    action: day ? `link the new caller's visit on ${day}` : "link the new caller's visit",
    why: UNLINKED_WHY[reason],
    severity: 'needs-you',
    link: visitLink(visit),
    subject: { type: 'visit', id: String(visit.id) },
    doneWhen: 'visit_linked',
    who: 'person',
  }, {
    dedupeKey: newCallerVisitAlertKey(visit.id),
    bellDefault: true,
    detail: `${detail.trim()}\nOpen the visit on Dispatch and use Link customer. The reminders and the confirmation go out then.`,
    metadata: { scheduled_service_id: visit.id, call_log_id: visit.source_call_log_id || null, reason },
  });
}

// A refused or failed link rings only while the visit still waits: the
// office may have linked it meanwhile, or cancelled it.
async function ringIfStillUnlinked(conn, visit, err) {
  const now = await conn('scheduled_services').where({ id: visit.id }).first('customer_id', 'status');
  if (!now || now.customer_id || ['cancelled', 'rescheduled'].includes(now.status)) return { outcome: 'settled', visitId: visit.id };
  // An operational refusal carries a sentence for staff; anything else may echo SQL.
  await ringUnlinked(visit, 'refused', err?.isOperational ? err.message : 'An error stopped it.');
  return { outcome: 'unlinked', visitId: visit.id };
}

/**
 * The processor calls this right after its token-fenced customer checkpoint.
 *   call, procToken   the call row and this pass's processing claim
 *   text              { passBlocked, extraction, impliedConsent, callerPhone }: the pass's SMS
 *                     block, its v2 extraction, its implied-consent eligibility, the caller's number
 * Returns { outcome } (off | none | claim_lost | unlinked | settled | linked | error); a linked
 * outcome adds remindersArmed, confirmationSent and heldText (why the text was held, or null).
 */
async function linkOfficeVisitFromCall({ call, procToken, text = {}, conn = db } = {}) {
  if (!isEnabled('newCallerBooking') || !call?.id || !procToken) return { outcome: 'off' };
  let visit = null;
  try {
    visit = await conn('scheduled_services')
      .where({ source_call_log_id: call.id, source_action: NEW_CALLER_SOURCE_ACTION })
      .whereNull('customer_id')
      .whereNull('parent_service_id')
      .whereNotIn('status', ['cancelled', 'rescheduled'])
      .orderBy('created_at', 'asc')
      .first();
    if (!visit) return { outcome: 'none' };
    // The customer the checkpoint wrote (an operator's relink wins there), under this pass's claim.
    const owned = await conn('call_log').where({ id: call.id, processing_token: procToken }).first('customer_id');
    if (!owned) return { outcome: 'claim_lost' };
    if (!owned.customer_id) {
      await ringUnlinked(visit, 'no_customer');
      return { outcome: 'unlinked', visitId: visit.id };
    }
    let linked;
    try {
      linked = await linkNewCallerVisit({
        visitId: visit.id, customerId: owned.customer_id, propertySource: 'call_pipeline', claimFence: { callLogId: call.id, procToken }, conn,
      });
    } catch (err) {
      // A peer pass took the claim: it links the visit.
      if (err.code === 'call_claim_lost') return { outcome: 'claim_lost' };
      return await ringIfStillUnlinked(conn, visit, err);
    }
    // The link has committed: the reminders and the confirmation follow it
    // even if a peer takes the claim now, since a later pass reuses the
    // linked visit and sends nothing. A failed phone read holds the text only.
    const decision = await textDecision(conn, linked.visit.customer_id, text)
      .catch(() => ({ send: false, held: 'unknown' }));
    const comms = await armLinkedVisitComms({ visit: linked.visit, sendConfirmation: decision.send })
      .catch((err) => {
        logger.warn(`[new-caller] reminders for visit ${linked.visit.id} failed after the link: ${err.code || err.name || 'error'}`);
        return { remindersArmed: false, confirmationSent: false };
      });
    const heldText = decision.held || null;
    logger.info(`[new-caller] call ${call.id} linked visit ${linked.visit.id}: reminders ${comms.remindersArmed}, confirmation ${comms.confirmationSent}, text held [${heldText}]`);
    return { outcome: 'linked', visitId: linked.visit.id, ...comms, heldText };
  } catch (err) {
    logger.error(`[new-caller] agent link step failed for call ${call.id}: ${err.code || err.name || 'error'}`);
    if (visit) await ringIfStillUnlinked(conn, visit, err).catch(() => {});
    return { outcome: 'error' };
  }
}

module.exports = {
  linkOfficeVisitFromCall,
  _private: { textDecision, UNLINKED_WHY },
};
