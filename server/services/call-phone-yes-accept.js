/**
 * Call phone yes, step 1 (GATE_CALL_PHONE_YES_ACCEPT, owner 2026-11-18 "ok go": a person taps the accept).
 *
 * A caller with an open estimate sometimes says yes on a call and chooses pay per application. The call pipeline
 * books the visit, but nothing accepts the estimate: the visit stays a one-off with no price and no link to the
 * estimate, and the plan never starts (2026-11-12). This module files ONE admin card (call_phone_yes) for each call
 * that booked a pest visit while the customer had an open estimate, so a person accepts it. It accepts nothing and
 * sends nothing: the booking text keeps the estimate's accept link, and the customer can still accept alone.
 *
 * The card has two states. "Caller said yes" carries the caller's own words: service_request.billing_choice is
 * per_application on that call or an earlier one since the estimate was sent, and its evidence quote is found word for
 * word in a caller turn of that call's recording transcript; the card shows the caller's whole latest turn that says it.
 * "No yes heard" says only that: the card never claims a yes that did not happen. The caller's word is read by
 * call-phone-yes-word.js (one copy, shared with the later steps); it judges no words, the call reader does. A call
 * that began after a newer estimate was sent (one sent after the booking call) gives the card no word: it may be about
 * that estimate. The caller's billing_choice is never consent on its own (the extraction schema says so), so a person
 * decides every accept. Each sweep re-reads an open card's yes, so a call that is re-read or moved never leaves a stale
 * quote on it.
 * Each card also records a shadow verdict for the later automatic step, as of its filing: would an automatic accept go
 * ahead, and if not, the first reason (the accept's own checks, then the caller's word).
 *
 * No card when the customer's latest word since the send is annual prepay (the prepay card owns it,
 * call-prepay-choice.js), a cancellation or a one-time visit; and none while a call since the send still owes a read
 * (call-phone-yes-word.js owedReadSql). Only an estimate already sent when the call began counts, and never an
 * archived one. "Sent" is the estimate's first real handoff (deliveryState.firstDeliveredAt, which a resend never
 * moves), else sent_at. The card stays open while an unlinked pest visit the call booked is on the calendar, also after the
 * estimate expires. It closes itself once none of its estimates is open or lapsed (each accepted, declined or
 * archived), no unlinked pest visit of the call is left on the calendar, the call moves to another customer, or a later
 * call takes the yes back.
 *
 * Dark behind GATE_CALL_PHONE_YES_ACCEPT; off = nothing here runs.
 */

const db = require('../models/db');
const logger = require('./logger');
const { lockTriageCall, syncCallReviewStatus } = require('../utils/triage-locks');
const { callStartedAt } = require('../utils/call-timeline');
const Word = require('./call-phone-yes-word');

const REASON_CODE = 'call_phone_yes';
const MOOT_RULE = 'call_phone_yes_moot';
const LOOKBACK_DAYS = 3;
const SCAN_LIMIT = 200;
const MAX_CARDS_PER_RUN = 10;
const LIVE_VISIT_STATUSES = ['pending', 'confirmed'];
// A visit still on the calendar keeps the card: every status but cancelled and skipped. A visit waiting for its new
// slot (rescheduled) and a done visit keep it too (the plan was still never accepted), so the gap never closes by itself.
const CALENDAR_VISIT_STATUSES = ['pending', 'confirmed', 'rescheduled', 'en_route', 'on_site', 'completed'];
const OPEN_ESTIMATE_STATUSES = ['sent', 'viewed'];
// An estimate a card keeps naming: open, lapsed (the office can extend it and accept), or being sent again (a resend
// claims 'sending' and then restores its status, admin-estimates.js; a sweep in between must not close the card).
const CARD_ESTIMATE_STATUSES = ['sent', 'viewed', 'expired', 'sending'];
// The one one-time line a standard accept of a pest plan may carry: the setup fee, which the first visit bills by
// hand (estimate-accept-effects membershipFeeLine; one-time work rows never carry this name).
const MEMBERSHIP_FEE_LINE_NAME = 'WaveGuard membership fee';
const PEST_FAMILY = new Set(['pest_control']);

// `?.() === true`: a test's whole-module gate mock without this reader reads as off (the #7910 pattern).
const live = () => require('../config/feature-gates').callPhoneYesAcceptLive?.() === true;

// Plain words for each reason an accept would not go ahead. The card's shadow line reads "Auto would accept: no."
// and then the reason.
const REASONS = {
  no_yes_heard: 'No yes was heard on the call.',
  yes_without_words: "The call reader recorded a pay-per-application choice, but the caller's own words for it are not in the call's recording.",
  caller_not_account_holder: "The caller is not shown to be the account holder's side (a tenant, a relative, or a caller on a phone that is not theirs), so their word is not the customer's yes.",
  caller_declined_price: 'The caller said no to the price on the call.',
  more_than_one_estimate: 'The customer has more than one open estimate.',
  more_than_one_visit: 'The call booked more than one visit.',
  termite_estimate: 'The estimate has a termite line. Its notice and agreement are handled on the estimate.',
  commercial_estimate: 'The estimate is not a known residential quote (commercial, or no residential category).',
  newer_call: 'The customer called again later. Read that call before you accept.',
  yes_after_booking: 'The caller said yes on a later call than the one that booked the visit.',
  yes_maybe_other_estimate: 'When the caller said yes, the customer had another estimate open too, so the yes may be about that one.',
  booking_call_unread: 'The call that booked the visit could not be read, so its last word is unknown.',
  group_estimate: 'The estimate is part of an estimate group.',
  no_recurring_price: 'The estimate has no recurring price.',
  not_pest_plan: 'The estimate is not one residential pest control plan.',
  one_time_items: 'The estimate has a one-time charge that the office must bill.',
  accept_refused: "The estimate's own accept refuses it now (for example, it still needs a manager's approval). Open the estimate to see why.",
  estimate_has_visits: 'A visit is already linked to the estimate.',
  visit_already_linked: 'The booked visit is already linked to an estimate.',
  visit_not_one_off: 'The booked visit is already part of a series or a reservation.',
  not_a_plan_visit: 'The booked visit is a callback or an assessment, not a plan visit.',
  service_mismatch: 'The booked visit is not the service the estimate quoted.',
  property_mismatch: 'The booked visit is at a different property than the estimate.',
  setup_fee_stamped: 'The booked visit carries a setup fee.',
  visit_prepaid: 'The booked visit already has a payment recorded.',
  has_addons: 'The booked visit has add-on lines.',
  visit_priced: 'The booked visit has a price that is not the plan price.',
  visit_in_past: 'The booked visit date has passed. It may be done but not closed out.',
  existing_plan: 'The customer already has a live plan or a WaveGuard membership.',
  estimate_not_delivered: 'The estimate shows no delivery to the customer (each send was held back or failed), and they have not opened it.',
};

const skip = (reason) => ({ card: false, reason });

const parseJson = (value) => {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
};

// When the customer was sent an estimate: its FIRST real handoff when the send path recorded one
// (deliveryState.firstDeliveredAt, kept across resends: call-commitments' FIRST_HANDOFF_SQL), else sent_at. A resend
// moves sent_at, never this. Null for an estimate never sent. SQL over the unaliased `estimates` table.
const handoffSql = () => `LEAST(${require('./call-commitments').FIRST_HANDOFF_SQL}, estimates.sent_at)`;

// The estimate's send time, the earliest moment a yes to it can count (the loaders read handoffSql as handoff_at).
function sentAnchorOf(estimate) {
  const at = new Date(estimate.handoff_at || estimate.sent_at || estimate.created_at || 0);
  return Number.isNaN(at.getTime()) ? new Date(0) : at;
}
const earliestSentAnchor = (estimates) => new Date(Math.min(...estimates.map((e) => sentAnchorOf(e).getTime())));

// True when, as the call began, the customer had another estimate open: sent by then and not yet accepted, declined,
// archived or expired (a lawn quote accepted later still counts: it was open then). A yes on that call may be about
// the other estimate, so the shadow verdict cannot count it (the card still shows the words).
async function otherEstimateOpenAt(conn, { customerId, cardIds, callLogId }) {
  const startOfCall = `(SELECT ${require('./sms-pending-conversations').callStartedAtSql('anchor')} FROM call_log anchor WHERE anchor.id = ?)`;
  const openThen = (column) => (qb) => qb.whereNull(column).orWhereRaw(`${column} > ${startOfCall}`, [callLogId]);
  return !!(await conn('estimates')
    .where({ customer_id: customerId })
    .whereNotIn('id', cardIds)
    .whereRaw(`${handoffSql()} <= ${startOfCall}`, [callLogId])
    .where(openThen('accepted_at'))
    .where(openThen('declined_at'))
    .where(openThen('archived_at'))
    .where(openThen('expires_at'))
    .first('id'));
}

// When the customer was first sent an estimate the card does not name after the booking call began (timestamptz as
// text, or null). From then on a call may be about that newer estimate, so its word is not this card's: a yes to it
// never shows here and a cancel of it never closes this card (callerWord's `until`). An estimate settled before the
// booking call (a lawn quote accepted online) bounds nothing: the call booked the visit with the card's ones open.
async function newerEstimateSentAt(conn, { customerId, cardIds, bookingCallId }) {
  const startOfBooking = `(SELECT ${require('./sms-pending-conversations').callStartedAtSql('anchor')} FROM call_log anchor WHERE anchor.id = ?)`;
  const row = await conn('estimates')
    .where({ customer_id: customerId })
    .whereNotIn('id', cardIds)
    .whereRaw(`${handoffSql()} > ${startOfBooking}`, [bookingCallId])
    .first(conn.raw(`min(${handoffSql()})::text AS at`));
  return row?.at || null;
}

// An archived estimate keeps its status but is closed to the customer (the public routes refuse it): never open here.
async function openEstimatesOf(conn, customerId, now) {
  return conn('estimates')
    .where({ customer_id: customerId })
    .whereIn('status', OPEN_ESTIMATE_STATUSES)
    .whereNull('archived_at')
    .where((qb) => qb.whereNull('expires_at').orWhere('expires_at', '>', now))
    .orderBy('created_at', 'desc')
    .select('*', conn.raw(`${handoffSql()} AS handoff_at`));
}

// The visit's catalog row joined in, so the family matchers classify it by what it IS (an unlinked visit by its label).
async function withCatalog(conn, visit) {
  const catalog = (visit.service_id && await conn('services').where({ id: visit.service_id }).first('service_key', 'name')) || {};
  return { ...visit, catalog_service_key: catalog.service_key, catalog_service_name: catalog.name };
}

// True when one of the call's booked visits is a pest visit (assessments never are).
async function anyPestVisit(conn, visits) {
  const { appointmentMatchesEstimateFamily } = require('../routes/estimate-public');
  for (const visit of visits) {
    if (appointmentMatchesEstimateFamily(await withCatalog(conn, visit), PEST_FAMILY)) return true;
  }
  return false;
}

// What is wrong with the estimate for an accept from the call, or null.
async function estimateProblem(conn, estimate) {
  const { termiteEstimate } = require('./call-prepay-choice');
  const Manual = require('./estimate-manual-acceptance');
  const data = parseJson(estimate.estimate_data);
  if (termiteEstimate(estimate)) return 'termite_estimate';
  // KNOWN residential only: category RESIDENTIAL, not commercial auto-priced, no authored commercial proposal.
  if (!require('./estimate-before-you-book').isKnownResidential(estimate, data.proposal)) return 'commercial_estimate';
  if (estimate.estimate_group_id) return 'group_estimate';
  if (neverDelivered(estimate, data)) return 'estimate_not_delivered';
  if (!(Number(estimate.monthly_total) > 0)) return 'no_recurring_price';
  const EstimateConverter = require('./estimate-converter');
  if (!onePestLine(data, EstimateConverter)) return 'not_pest_plan';
  const AcceptEffects = require('./estimate-accept-effects');
  const oneTime = AcceptEffects.oneTimeLineEffects(estimate, EstimateConverter, { billingTerm: 'standard' });
  if (oneTime.refusal || oneTime.lines.some((line) => line.name !== MEMBERSHIP_FEE_LINE_NAME)) return 'one_time_items';
  // A one-time total that no line itemizes (legacy quotes): the office must see the charge (the carded accept's rule).
  if (AcceptEffects.unitemizedOneTimeRefusal(estimate, oneTime.lines)) return 'one_time_items';
  if (await Manual.estimateLinkedVisitsQuery(conn, estimate.id).first('id')) return 'estimate_has_visits';
  if (await acceptRefused(conn, estimate, data)) return 'accept_refused';
  return null;
}

// Every send the send path made was held back or failed (its deliveryState records no real handoff) and the customer
// never opened the estimate: they may never have seen it. A row with no deliveryState (an older send) counts as delivered.
function neverDelivered(estimate, data) {
  const delivery = data.deliveryState;
  return !!delivery && typeof delivery === 'object' && !Number.isFinite(Date.parse(delivery.firstDeliveredAt)) && !estimate.viewed_at;
}

// One recurring line, and it is pest control. Two separately priced pest lines coalesce into that one row; each list
// that holds lines tells them apart: the engine's own lines (the duplicate rule acceptanceServiceLists applies with
// preserveDuplicates) and each mapped recurring list. Each list is counted on its own, so one row mirrored in two lists
// is still one line.
function onePestLine(data, EstimateConverter) {
  const lines = require('../routes/estimate-public').acceptanceServiceLists(data).recurringSvcList || [];
  if (lines.length !== 1 || EstimateConverter.recurringServiceKey(lines[0]) !== 'pest_control') return false;
  const source = data.result || data.engineResult || data;
  const pestRows = (rows) => (Array.isArray(rows) ? rows : []).filter((row) => EstimateConverter.recurringServiceKey(row) === 'pest_control').length;
  return ![source.lineItems, source.recurring?.services, source.results?.recurring?.services].some((rows) => pestRows(rows) > 1);
}

// True when the estimate's own manual accept refuses it, read as the Intelligence Bar's accept card reads it
// (estimate-accept-tools.js pageRefusal; the manual accept throws the same under its locks): a manager's
// approval still owed, a gated add-on, a one-time option or invoice mode, a re-price hold, or a call-linkage quarantine.
async function acceptRefused(conn, estimate, data) {
  const Manual = require('./estimate-manual-acceptance');
  if (Manual.oneTapPurchaseRefusal(estimate) || Manual.manualAcceptRowRefusal(estimate) || Manual.manualAcceptLockedRowRefusal(estimate)) return true;
  const eng = data.estimatorEngine;
  if (require('./estimate-clarify-asks').repricePendingActive(eng)) return true;
  if (eng?.callLogId && (eng.linkage_invalidated_at || eng.invalidation_pending_at)) return true;
  const { callSideBlockForEstimateData } = require('../utils/estimate-claim-sql');
  return !!(await callSideBlockForEstimateData(conn, data, { estimateStatus: estimate.status }));
}

// What is wrong with the booked visit for an accept from the call, or null.
async function visitProblem(conn, visit, estimate, now) {
  if (visit.source_estimate_id) return 'visit_already_linked';
  if (visit.is_recurring || visit.recurring_parent_id || visit.reservation_expires_at) return 'visit_not_one_off';
  const { isAssessmentVisit } = require('./assessment-booking');
  if (visit.is_callback === true || isAssessmentVisit(visit)) return 'not_a_plan_visit';
  // A past visit may be done but not closed out: the office decides how to bill it.
  const { etDateString, dateOnlyString } = require('../utils/datetime-et');
  if (dateOnlyString(visit.scheduled_date) < etDateString(now)) return 'visit_in_past';
  // A call booking against an open estimate lands unpriced (#3814); any price is not the plan's.
  if (visit.estimated_price != null) return 'visit_priced';
  const { estimateFamilyKeysForAdoption, appointmentMatchesEstimateFamily } = require('../routes/estimate-public');
  const families = estimateFamilyKeysForAdoption(estimate, parseJson(estimate.estimate_data), { serviceMode: 'recurring' });
  if (!families.size || !appointmentMatchesEstimateFamily(await withCatalog(conn, visit), families)) return 'service_mismatch';
  if (!require('./completion-pricing').propertyMatches(visit, estimate)) return 'property_mismatch';
  if (Number(visit.pending_setup_fee) > 0) return 'setup_fee_stamped';
  if (Number(visit.prepaid_amount) > 0 || visit.prepaid_method || visit.annual_prepay_term_id) return 'visit_prepaid';
  if (await require('./estimate-manual-acceptance').bookedVisitsHaveAddons(conn, [visit.id])) return 'has_addons';
  return null;
}

// The customer already holds a plan: a WaveGuard membership (tier or legacy monthly rate; strict, so a failed read
// throws instead of reading as "no plan") or another live recurring obligation, by the shared reader
// (loadLiveRecurringObligationRows: a visit en route or on site counts, a past phantom row, a callback or a one-time
// booking does not; a failed catalog join throws). The accept would replace that billing.
async function existingPlan(conn, customerId, visitId) {
  const Existing = require('./waveguard-existing-services');
  if (await Existing.isActivePlanCustomer(conn, customerId, { strict: true })) return true;
  const rows = await Existing.loadLiveRecurringObligationRows(conn, customerId);
  return rows.some((row) => String(row.id) !== String(visitId));
}

// The first check an accept from this call fails, or null: one estimate, one booked visit, then the estimate, the
// visit and the customer's plan. This is the accept's part of the shadow verdict.
async function acceptProblem(conn, { estimate, visit, customerId, now }) {
  if (!estimate) return 'more_than_one_estimate';
  if (!visit) return 'more_than_one_visit';
  return (await estimateProblem(conn, estimate))
    || (await visitProblem(conn, visit, estimate, now))
    || ((await existingPlan(conn, customerId, visit.id)) ? 'existing_plan' : null);
}

/**
 * Does this call get a card, and what does it say?
 * @returns {{card:false, reason}|{card:true, yes:{callLogId, at, quote}|null, estimate, visit, estimateIds,
 *   acceptProblem, autoProblem}}
 *   estimate / visit: the one open estimate and the one booked visit, or null when there are more.
 *   estimateIds: the open estimates already sent when the call booked the visit (the ones the card is about).
 *   acceptProblem: the first check an accept from this call fails, or null.
 *   autoProblem: why an automatic accept would not go ahead (acceptProblem, then the caller's word), or null.
 *   yes: the caller's pay-per-application choice with their own words (the evidence quote), or null.
 */
async function evaluatePhoneYes({ callLogId, customerId, conn = db, now = new Date() }) {
  // The call must still belong to this customer (a relinked call reads as gone).
  const call = await conn('call_log').where({ id: callLogId, customer_id: customerId }).first(Word.CALL_COLUMNS);
  if (!call) return skip('customer_changed');
  const visits = await require('./call-prepay-choice').liveVisitsOfCall(conn, callLogId, customerId);
  if (!visits.length) return skip('no_booked_visit');
  // The same visit must be both unlinked and pest (a linked pest visit beside an unlinked lawn visit is not one).
  if (!(await anyPestVisit(conn, visits.filter((v) => !v.source_estimate_id)))) return skip('no_pest_visit');
  // The card is about an estimate already sent when the call began (one sent later is not what the caller answered);
  // every open estimate still counts toward "more than one".
  const open = await openEstimatesOf(conn, customerId, now);
  const answerable = open.filter((e) => sentAnchorOf(e) <= callStartedAt(call));
  if (!answerable.length) return skip('no_open_estimate');
  const since = earliestSentAnchor(answerable);
  // Every call since the send, the booking call included, is read first: an unread one may hold the yes or take it back.
  if (await Word.unreadCallSince(conn, { customerId, since })) return skip('call_still_processing');
  const until = await newerEstimateSentAt(conn, { customerId, cardIds: answerable.map((e) => e.id), bookingCallId: callLogId });
  const heard = await Word.callerWord(conn, { customerId, since, until });
  if (heard.skip) return skip(heard.skip);
  const { yes } = heard;
  const later = await Word.laterWordProblem(conn, { customerId, yes, booking: call });
  const shared = yes && (await otherEstimateOpenAt(conn, { customerId, cardIds: answerable.map((e) => e.id), callLogId: yes.callLogId }))
    ? 'yes_maybe_other_estimate' : null;
  const estimate = open.length === 1 ? open[0] : null;
  const visit = visits.length === 1 ? visits[0] : null;
  const problem = await acceptProblem(conn, { estimate, visit, customerId, now });
  return {
    card: true,
    yes,
    estimate,
    visit,
    estimateIds: answerable.map((e) => String(e.id)),
    acceptProblem: problem,
    autoProblem: problem || later || shared || heard.noYes,
  };
}

// The card's headline, by state. Only a yes the call reader recorded is called a yes; while the call that gave it is
// read again, the card says so instead of showing words it cannot check.
function cardSummary({ yes, rechecking = false }) {
  if (yes) return 'Caller said yes to pay per application on the call. The estimate is not accepted yet.';
  if (rechecking) return 'A call booked a pest visit while an estimate is open. The call with the yes is being read again. The estimate is not accepted yet.';
  return 'A call booked a pest visit while an estimate is open. No yes heard on the call. The estimate is not accepted yet.';
}

// The card's yes fields: the caller's pay-per-application choice with their own words, none, or (rechecking) the call
// that gave the yes while it is read again, with no words. The sweep keeps them current (cardState); the shadow
// verdict stays as filed.
function heardFields(yes, { recheckingCallId = null } = {}) {
  return {
    yes_heard: !!yes,
    yes_rechecking: !yes && !!recheckingCallId,
    billing_choice: yes ? 'per_application' : null,
    yes_call_log_id: yes ? String(yes.callLogId) : (recheckingCallId ? String(recheckingCallId) : null),
    yes_at: yes?.at ? new Date(yes.at).toISOString() : null,
    caller_words: yes?.quote || null,
  };
}

// The call a card's yes came from, read again: 'gone' (no longer this customer's), 'owed' (being read again),
// 'changed' (its words no longer hold), 'read' (a re-read finished; the full pass decides), 'same', or 'none' (the card
// shows no yes).
async function yesCallState(payload, customerId) {
  if (!payload.yes_call_log_id || (payload.yes_heard !== true && payload.yes_rechecking !== true)) return 'none';
  const row = await db('call_log').where({ id: payload.yes_call_log_id, customer_id: customerId })
    .first([...Word.WORD_COLUMNS, db.raw(`${Word.owedReadSql()} AS owed_read`)]);
  if (!row) return 'gone';
  if (row.owed_read) return 'owed';
  if (payload.yes_rechecking === true) return 'read';
  const word = Word.wordOfCall(row);
  return word?.choice === 'per_application' && word.quote && word.quote === payload.caller_words ? 'same' : 'changed';
}

// The one card for a call. Idempotent: ANY row for (call, reason), open or closed, means it was filed.
async function fileCard({ call, extraction, evaluation }) {
  const { buildTriageItem } = require('./call-routing-gates');
  const { yes, estimate, visit, autoProblem } = evaluation;
  return db.transaction(async (trx) => {
    await lockTriageCall(trx, call.id);
    if (await trx('triage_items').where({ call_log_id: call.id, reason_code: REASON_CODE }).first('id')) return false;
    // The call must still be this customer's under the lock: a card filed for a call relinked since the check would be
    // closed as moved, and its row would block the right customer's card for good. Read again next run instead.
    if (!(await trx('call_log').where({ id: call.id, customer_id: call.customer_id }).forUpdate().first('id'))) return false;
    const item = buildTriageItem({
      callLogId: call.id,
      flag: REASON_CODE,
      extraction,
      severity: 'advisory',
      extraPayload: {
        customer_id: String(call.customer_id),
        estimate_id: estimate ? String(estimate.id) : null,
        estimate_ids: evaluation.estimateIds,
        scheduled_service_id: visit ? String(visit.id) : null,
        ...heardFields(yes),
        // The shadow verdict for the later automatic step, as of the card's filing. Nothing acts on it.
        auto_would_accept: !autoProblem,
        auto_reason: autoProblem,
        auto_message: autoProblem ? REASONS[autoProblem] : null,
      },
    });
    const inserted = await trx('triage_items')
      .insert({
        ...item,
        summary: cardSummary(evaluation),
        related_customer_id: call.customer_id,
        related_estimate_id: estimate?.id || null,
        related_scheduled_service_id: visit?.id || null,
      })
      .onConflict(trx.raw("(call_log_id, reason_code) WHERE status IN ('open', 'in_progress')"))
      .ignore()
      .returning('id');
    if (!inserted.length) return false;
    await syncCallReviewStatus(trx, call.id);
    return true;
  });
}

// Why an open card stopped being true.
const MOOT_NOTES = {
  customer_changed: 'No longer applies: the call is no longer linked to this customer.',
  no_booked_visit: 'No longer applies: the visits the call booked are off the calendar.',
  no_pest_visit: 'No longer applies: no pest visit the call booked is left on the calendar.',
  visit_linked: 'No longer applies: the visit the call booked is linked to an estimate now.',
  estimate_accepted: 'No longer applies: the estimate was accepted.',
  estimate_closed: 'No longer applies: the estimate was declined, archived or is gone.',
  took_back: 'No longer applies: the customer asked to cancel or for a one-time visit on a later call.',
  chose_annual_prepay: 'No longer applies: the customer chose annual prepay on a later call.',
};

// The estimates a card names: its one estimate, or every estimate that was open when it was filed.
function cardEstimateIds(card) {
  if (card.related_estimate_id) return [String(card.related_estimate_id)];
  const ids = parseJson(card.payload).estimate_ids;
  return Array.isArray(ids) ? ids.map(String) : [];
}

// Why an open card closes ({ close: note }), what changed ({ refresh: yes, rechecking? } for its yes fields, keepYes
// when only its estimate links changed, estimateIds when they did), or null to keep it as it is. The card holds while an unlinked pest visit its call booked is on the calendar and one of its estimates is
// still open or lapsed: an expiry alone never closes it, and neither does another estimate's accept (the card may
// still be about the one left open). While a call in its window still owes a read, the card waits as it is.
async function cardState(card) {
  const customerId = card.related_customer_id;
  if (!(await db('call_log').where({ id: card.call_log_id, customer_id: customerId }).first('id'))) return { close: MOOT_NOTES.customer_changed };
  const onCalendar = await db('scheduled_services')
    .where({ source_call_log_id: card.call_log_id, customer_id: customerId })
    .whereIn('source_action', require('./call-prepay-choice').callCreatedSourceActions())
    .whereIn('status', CALENDAR_VISIT_STATUSES)
    .select('*');
  if (!onCalendar.length) return { close: MOOT_NOTES.no_booked_visit };
  if (!(await anyPestVisit(db, onCalendar.filter((v) => !v.source_estimate_id)))) {
    return { close: onCalendar.some((v) => v.source_estimate_id) ? MOOT_NOTES.visit_linked : MOOT_NOTES.no_pest_visit };
  }
  const ids = cardEstimateIds(card);
  const estimates = ids.length
    ? await db('estimates').whereIn('id', ids).where({ customer_id: customerId })
      .select('id', 'status', 'sent_at', 'created_at', 'archived_at', db.raw(`${handoffSql()} AS handoff_at`))
    : [];
  const kept = estimates.filter((e) => CARD_ESTIMATE_STATUSES.includes(e.status) && !e.archived_at);
  if (!kept.length) return { close: estimates.some((e) => e.status === 'accepted') ? MOOT_NOTES.estimate_accepted : MOOT_NOTES.estimate_closed };
  // A card with more than one estimate links only the ones still open or lapsed, in the card's own order (a set
  // compare: a row order that differs is no change, so the card's version moves only when an estimate leaves).
  const keptSet = new Set(kept.map((e) => String(e.id)));
  const keptIds = ids.filter((id) => keptSet.has(id));
  const linksChanged = !card.related_estimate_id && keptIds.length !== ids.length;
  const state = await yesState(card, { customerId, ids, since: earliestSentAnchor(kept) });
  if (state?.close || !linksChanged) return state;
  return { ...(state || { keepYes: true }), estimateIds: keptIds };
}

// The card's yes fields, read again: { close: note }, { refresh: yes, rechecking? } when they changed, or null.
async function yesState(card, { customerId, ids, since }) {
  // The yes the card shows, checked first, also while other calls are read: never words that no longer hold.
  const p = parseJson(card.payload);
  const yesCall = await yesCallState(p, customerId);
  if (yesCall === 'owed') return p.yes_rechecking === true ? null : { refresh: null, rechecking: p.yes_call_log_id };
  // Words that no longer hold are cleared at once; the latest word is then read in the same pass when no call owes a read.
  const stale = yesCall === 'gone' || yesCall === 'changed';
  if (await Word.unreadCallSince(db, { customerId, since })) return stale ? { refresh: null } : null;
  const until = await newerEstimateSentAt(db, { customerId, cardIds: ids, bookingCallId: card.call_log_id });
  const heard = await Word.callerWord(db, { customerId, since, until });
  if (heard.skip) return { close: MOOT_NOTES[heard.skip] };
  // The yes the card shows must be the customer's latest word, from the same call with the same words.
  const now = heardFields(heard.yes);
  const same = !stale && ['yes_heard', 'yes_rechecking', 'yes_call_log_id', 'caller_words']
    .every((k) => now[k] === (typeof now[k] === 'boolean' ? p[k] === true : (p[k] ?? null)));
  return same ? null : { refresh: heard.yes };
}

// Closes a card that stopped being true (dismissed, as the prepay card does), or rewrites its yes fields and headline.
// Both under the call's triage lock, and only while the card is still open.
async function applyCardState(card, state) {
  return db.transaction(async (trx) => {
    await lockTriageCall(trx, card.call_log_id);
    const row = await trx('triage_items').where({ id: card.id, status: 'open' }).first('payload');
    if (!row) return false;
    const stamp = new Date();
    if (state.close) {
      await trx('triage_items').where({ id: card.id, status: 'open' }).update({
        status: 'dismissed', resolution_source: 'auto', resolution_rule: MOOT_RULE, resolution_note: state.close,
        resolved_at: stamp, updated_at: stamp,
      });
      await syncCallReviewStatus(trx, card.call_log_id, 'dismissed');
      return true;
    }
    await trx('triage_items').where({ id: card.id, status: 'open' }).update({
      payload: JSON.stringify({
        ...parseJson(row.payload),
        ...(state.keepYes ? {} : heardFields(state.refresh, { recheckingCallId: state.rechecking })),
        ...(state.estimateIds ? { estimate_ids: state.estimateIds } : {}),
      }),
      ...(state.keepYes ? {} : { summary: cardSummary({ yes: state.refresh, rechecking: !!state.rechecking }) }),
      updated_at: stamp,
    });
    return false;
  });
}

// Each open card, read again: closed when it stopped being true, its yes rewritten when it changed.
async function closeMootCards() {
  const open = await db('triage_items').where({ reason_code: REASON_CODE, status: 'open' })
    .select('id', 'call_log_id', 'related_customer_id', 'related_estimate_id', 'payload');
  let closed = 0;
  for (const card of open) {
    try {
      const state = await cardState(card);
      if (state && await applyCardState(card, state)) closed += 1;
    } catch (e) {
      // A failed read keeps the card as it is (read again next run).
      logger.warn(`[call-phone-yes] card check skipped for card ${card.id}: ${e.code || e.name || 'error'}`);
    }
  }
  return closed;
}

/**
 * Files the cards and closes the ones that stopped being true. Dark behind GATE_CALL_PHONE_YES_ACCEPT.
 * Reads every candidate in the lookback, newest first, in pages of `pageSize`: a call that gets no card (a lawn visit,
 * a taken-back yes) is read again next run, so it must never fill the scan and keep an older booking from its card.
 * @returns {{skipped?:true, scanned:number, filed:number, closed:number}}
 */
async function runCallPhoneYesSweep({ now = new Date(), pageSize = SCAN_LIMIT } = {}) {
  if (!live()) return { skipped: true, scanned: 0, filed: 0, closed: 0 };
  const { parseExtraction } = require('./call-held-visits');
  let filed = 0;
  let scanned = 0;
  for (let after = null; filed < MAX_CARDS_PER_RUN;) {
    const calls = await sweepCandidates({ now, after, pageSize });
    scanned += calls.length;
    for (const call of calls) {
      if (filed >= MAX_CARDS_PER_RUN) break;
      if (await fileFor(call, now, parseExtraction)) filed += 1;
    }
    if (calls.length < pageSize) break;
    after = calls[calls.length - 1];
  }
  let closed = 0;
  try {
    closed = await closeMootCards();
  } catch (e) {
    logger.warn(`[call-phone-yes] moot close pass failed: ${e.code || e.name || 'error'}`);
  }
  return { scanned, filed, closed };
}

// One call's card, filed when the call earns one. True when a card was filed.
async function fileFor(call, now, parseExtraction) {
  try {
    const evaluation = await evaluatePhoneYes({ callLogId: call.id, customerId: call.customer_id, now });
    if (!evaluation.card || !(await fileCard({ call, extraction: parseExtraction(call.ai_extraction_enriched), evaluation }))) return false;
    logger.info(`[call-phone-yes] card for call ${call.id}: ${evaluation.yes ? 'yes heard' : 'no yes heard'}, auto would accept: ${evaluation.autoProblem ? `no (${evaluation.autoProblem})` : 'yes'}`);
    return true;
  } catch (e) {
    logger.warn(`[call-phone-yes] skipped call ${call.id}: ${e.code || e.name || 'error'}`);
    return false;
  }
}

// One page of candidate calls, newest first, after the call `after` (keyset on the exact created_at text and id: a
// JS Date drops microseconds).
async function sweepCandidates({ now, after, pageSize }) {
  const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
  const { callCreatedSourceActions } = require('./call-prepay-choice');
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86400 * 1000);
  return db('call_log')
    .where('created_at', '>=', since)
    .whereNotNull('customer_id')
    // Read, or past its bounded wait (owedReadSql): a booking call no pass reads still files, as booking_call_unread.
    .whereRaw(`NOT ${Word.owedReadSql()}`)
    .modify((qb) => whereNotSandboxCall(qb))
    // A live, still-unlinked visit this call booked.
    .whereExists(function bookedVisit() {
      this.select(db.raw('1')).from('scheduled_services')
        .whereRaw('scheduled_services.source_call_log_id = call_log.id')
        .whereRaw('scheduled_services.customer_id = call_log.customer_id')
        .whereIn('scheduled_services.source_action', callCreatedSourceActions())
        .whereIn('scheduled_services.status', LIVE_VISIT_STATUSES)
        .whereNull('scheduled_services.source_estimate_id');
    })
    .whereExists(function openEstimate() {
      this.select(db.raw('1')).from('estimates')
        .whereRaw('estimates.customer_id = call_log.customer_id')
        .whereIn('estimates.status', OPEN_ESTIMATE_STATUSES)
        .whereNull('estimates.archived_at')
        // Sent by the time the call began (callStartedAtSql's default alias is this call_log row).
        .whereRaw(`COALESCE(${handoffSql()}, estimates.created_at) <= ${require('./sms-pending-conversations').callStartedAtSql()}`)
        .where((qb) => qb.whereNull('estimates.expires_at').orWhere('estimates.expires_at', '>', now));
    })
    .whereNotExists(function cardAlreadyFiled() {
      this.select(db.raw('1')).from('triage_items')
        .whereRaw('triage_items.call_log_id = call_log.id')
        .where('triage_items.reason_code', REASON_CODE);
    })
    .modify((qb) => { if (after) qb.whereRaw('(call_log.created_at, call_log.id) < (?::timestamptz, ?::uuid)', [after.created_key, after.id]); })
    .orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }])
    .limit(pageSize)
    .select('id', 'customer_id', 'ai_extraction_enriched', db.raw('created_at::text AS created_key'));
}

module.exports = {
  REASON_CODE,
  MOOT_RULE,
  REASONS,
  MEMBERSHIP_FEE_LINE_NAME,
  evaluatePhoneYes,
  runCallPhoneYesSweep,
  closeMootCards,
  cardSummary,
  // Tests only: filing under the lock, without the sweep's own check.
  _private: { fileCardForTest: fileCard },
};
