'use strict';

// GATE_NEW_CALLER_BOOKING, the call-recording agent's link step (owner plan
// 2026-10-25, decision page 2CGso96J). The office booked a NEW caller's visit
// by address while the call was live (new-caller-visit.js: no customer, the
// call stamped on the visit). Once the processor's token-fenced checkpoint has
// written the call's customer, this links the visit to that customer (D1; D6:
// a new address becomes one of the customer's properties), sets up its
// reminders and confirmation (D3), and rings the office when there is
// something to look at:
//  - D4(a): the pass left the visit with no customer (the call has none, or
//    the link was refused). Key new-caller-visit:<id>; a link closes it.
//  - After a link, one check bell: the caller gave a different address (D2)
//    or time (D7), the confirmation text was held or has not gone out, or
//    the reminders failed. Key new-caller-visit-check:<id>, its own: the link
//    has just closed the first key, and a closed row still answers that
//    key's dedupe.
// The visit keeps the address and time the office booked (D2, D7). Never
// throws: the call pass goes on whatever happens here.

const db = require('../../models/db');
const { isEnabled } = require('../../config/feature-gates');
const logger = require('../logger');
const {
  canonicalizeScopeAddress, stripTrailingUnit, unitKey, streetEmbeddedUnitKey, normalizeZip,
} = require('../customer-property-address-keys');
const { raiseAdminAlert } = require('../admin-alert-compose');
const { fitAction, lookupCustomerName } = require('../admin-alert-names');
const { checkTcpaConsent } = require('../call-routing-gates');
const {
  NEW_CALLER_SOURCE_ACTION, linkNewCallerVisit, armLinkedVisitComms, newCallerVisitAlertKey,
  slotWords, bookedSlot, newCallerVisitLink: visitLink, raiseWhileVisitWaits,
} = require('./new-caller-visit');

// The owner can silence it in Settings → Notifications (bellDefault, below).
const CATEGORY = 'schedule';
const AREA = 'Schedule';
const checkAlertKey = (visitId) => `new-caller-visit-check:${visitId}`;
// The extractor's preferred_date_time: Eastern wall clock, YYYY-MM-DDTHH:MM.
const SPOKEN_SLOT = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?$/;
const lastTen = (value) => String(value || '').replace(/\D/g, '').slice(-10);

// D7: the time the call agreed, only in the extractor's own format; anything
// vaguer is no check.
function spokenSlot(extracted = {}) {
  if (!extracted || extracted.appointment_confirmed !== true) return null;
  const m = SPOKEN_SLOT.exec(String(extracted.preferred_date_time || '').trim());
  return m ? { date: m[1], time: m[2] } : null;
}

// D2, small differences ignored: the street compares with spelling, suffix and
// directional forms evened out, and a ZIP or a unit counts only when both
// sides give one.
function addressParts({ address_line1, address_line2, zip }) {
  const line1 = String(address_line1 || '');
  return {
    street: canonicalizeScopeAddress(stripTrailingUnit(line1)).replace(/[^a-z0-9]/g, ''),
    unit: unitKey(address_line2) || streetEmbeddedUnitKey(line1),
    zip: normalizeZip(zip),
  };
}
function addressDiffers(spoken, booked) {
  const a = addressParts(spoken);
  const b = addressParts(booked);
  if (!a.street || !b.street) return false;
  return a.street !== b.street || Boolean(a.zip && b.zip && a.zip !== b.zip) || Boolean(a.unit && b.unit && a.unit !== b.unit);
}

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

// Rings only while the visit still waits (raiseWhileVisitWaits): the office
// may have linked or cancelled it since this pass read it.
async function ringUnlinked(conn, visit, reason, refusal = '') {
  const { day } = slotWords(bookedSlot(visit).date, '');
  const detail = reason === 'no_customer'
    ? 'The call recording was processed, but the call gave no customer to link: the caller may share a phone with an account, or the call named no one.'
    : `The call named a customer, but the link was refused. ${refusal}`;
  return raiseWhileVisitWaits(conn, visit.id, (trx) => raiseAdminAlert(CATEGORY, {
    area: AREA,
    action: day ? `link the new caller's visit on ${day}` : "link the new caller's visit",
    why: UNLINKED_WHY[reason],
    severity: 'needs-you',
    link: visitLink(visit),
    subject: { type: 'visit', id: String(visit.id) },
    doneWhen: 'visit_linked',
    who: 'person',
  }, {
    trx,
    dedupeKey: newCallerVisitAlertKey(visit.id),
    bellDefault: true,
    detail: `${detail.trim()}\nOpen the visit on Dispatch and use Link customer. The reminders and the confirmation go out then.`,
    metadata: { scheduled_service_id: visit.id, call_log_id: visit.source_call_log_id || null, reason },
  }));
}

const unlinkedOutcome = ({ waits }, visit) => ({ outcome: waits ? 'unlinked' : 'settled', visitId: visit.id });

// A refused or failed link. An operational refusal carries a sentence for
// staff; anything else may echo SQL.
async function ringIfStillUnlinked(conn, visit, err) {
  return unlinkedOutcome(await ringUnlinked(conn, visit, 'refused', err?.isOperational ? err.message : 'An error stopped it.'), visit);
}

// Each check: the noun for a list, its own why, and its line in the detail.
// A held text is text_<held>, from textDecision.
const CHECKS = {
  address: {
    noun: 'a different address',
    why: 'The caller gave a different address than the one booked; the visit keeps the booked address.',
    detail: () => 'Address: the address on the call differs from the booked one. The visit keeps the booked address; the customer\'s account now lists both, the call\'s as its home. Check which one is right.',
  },
  time: {
    noun: 'a different time',
    why: 'The call mentions a different time than the one booked; the visit keeps the booked time.',
    detail: ({ spoken, booked }) => {
      const said = slotWords(spoken.date, spoken.time);
      const kept = slotWords(booked.date, booked.time);
      return `Time: the call says ${said.day} at ${said.time}; the visit stays at ${kept.day}${kept.time ? ` at ${kept.time}` : ''}, as booked. The confirmation names the booked time.`;
    },
  },
  reminders: {
    noun: 'no reminders',
    why: 'The reminders were not set up and no confirmation went out, so the customer has no word of the visit.',
    detail: () => 'Reminders: they were not set up, and no confirmation went out.',
  },
  text_consent: {
    noun: 'no confirmation text',
    why: 'The confirmation text was not sent because the call gives no consent to text this customer.',
    detail: () => 'Confirmation: not sent. The call gives no consent to text this customer, or the number is on hold. The reminders are set up.',
  },
  text_other_number: {
    noun: 'no confirmation text',
    why: 'The confirmation text was not sent because the consent covers only the number that called.',
    detail: () => 'Confirmation: not sent. The caller consented by calling, which covers only the number that called, and the customer\'s phone on file is another number. The reminders are set up.',
  },
  text_unknown: {
    noun: 'no confirmation text',
    why: 'The confirmation text was not sent because the customer\'s phone could not be read.',
    detail: () => 'Confirmation: not sent. The customer\'s phone could not be read to check the consent. The reminders are set up.',
  },
  text_failed: {
    noun: 'no confirmation text',
    why: 'The confirmation text has not gone out, so check the visit.',
    detail: () => 'Confirmation: it has not gone out. It may be held until the morning, or the number may not take texts. The reminders are set up.',
  },
};

function listWords(nouns) {
  return nouns.length < 2 ? nouns.join('') : `${nouns.slice(0, -1).join(', ')} and ${nouns[nouns.length - 1]}`;
}

async function ringCheck(conn, visit, checks, context) {
  const name = await lookupCustomerName(conn, visit.customer_id);
  const { day } = slotWords(context.booked.date, '');
  const on = day ? ` on ${day}` : '';
  return raiseAdminAlert(CATEGORY, {
    area: AREA,
    action: name
      ? fitAction(AREA, name, [(who) => `check ${who}'s visit${on}`, (who) => `check ${who}'s visit`])
      : `check the new caller's visit${on}`,
    why: checks.length === 1 ? CHECKS[checks[0]].why : `Check ${checks.length} things on this visit: ${listWords(checks.map((c) => CHECKS[c].noun))}.`,
    severity: 'needs-you',
    link: visitLink(visit),
    subject: { type: 'visit', id: String(visit.id) },
    doneWhen: 'visit_checked',
    who: 'person',
  }, {
    dedupeKey: checkAlertKey(visit.id),
    bellDefault: true,
    detail: ['The call recording linked this visit, booked by address, to its customer.', ...checks.map((c) => `- ${CHECKS[c].detail(context)}`)].join('\n'),
    metadata: { scheduled_service_id: visit.id, call_log_id: visit.source_call_log_id || null, checks },
  });
}

async function checkLinkedVisit(conn, { visit, extracted, createdCustomerId, decision, comms }) {
  const checks = [];
  // Only a customer this call created carries the call's address; an older
  // customer at a new address is D6 (one more property), not a difference.
  if (createdCustomerId && String(createdCustomerId) === String(visit.customer_id)) {
    const customer = await conn('customers').where({ id: visit.customer_id }).first('address_line1', 'address_line2', 'zip');
    const booked = { address_line1: visit.service_address_line1, address_line2: visit.service_address_line2, zip: visit.service_address_zip };
    if (customer && addressDiffers(customer, booked)) checks.push('address');
  }
  const spoken = spokenSlot(extracted);
  const booked = bookedSlot(visit);
  if (spoken && (spoken.date !== booked.date || (booked.time && spoken.time !== booked.time))) checks.push('time');
  if (!comms.remindersArmed) checks.push('reminders');
  else if (!decision.send) checks.push(`text_${decision.held}`);
  else if (!comms.confirmationSent) checks.push('text_failed');
  if (checks.length) await ringCheck(conn, visit, checks, { spoken, booked });
  return checks;
}

/**
 * The processor calls this right after its token-fenced customer checkpoint.
 *   call, procToken   the call row and this pass's processing claim
 *   text              { passBlocked, extraction, impliedConsent, callerPhone }: the pass's SMS
 *                     block, its v2 extraction, its implied-consent eligibility, the caller's number
 *   extracted         the pass's extraction (appointment_confirmed, preferred_date_time: D7)
 *   createdCustomerId the customer this pass created, if any (D2 compares its address)
 * Returns { outcome } (off | none | claim_lost | unlinked | settled | linked | error); a linked
 * outcome adds remindersArmed, confirmationSent, heldText (why the text was held, or null) and
 * checks (what the check bell named).
 */
async function linkOfficeVisitFromCall({ call, procToken, text = {}, extracted = {}, createdCustomerId = null, conn = db } = {}) {
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
    if (!owned.customer_id) return unlinkedOutcome(await ringUnlinked(conn, visit, 'no_customer'), visit);
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
    const checks = await checkLinkedVisit(conn, { visit: linked.visit, extracted, createdCustomerId, decision, comms });
    logger.info(`[new-caller] call ${call.id} linked visit ${linked.visit.id}: reminders ${comms.remindersArmed}, confirmation ${comms.confirmationSent}, checks [${checks.join(' ')}]`);
    return { outcome: 'linked', visitId: linked.visit.id, ...comms, heldText, checks };
  } catch (err) {
    logger.error(`[new-caller] agent link step failed for call ${call.id}: ${err.code || err.name || 'error'}`);
    if (visit) await ringIfStillUnlinked(conn, visit, err).catch(() => {});
    return { outcome: 'error' };
  }
}

module.exports = {
  linkOfficeVisitFromCall,
  checkAlertKey,
  _private: { textDecision, spokenSlot, addressDiffers, UNLINKED_WHY, CHECKS },
};
