/**
 * Call phone yes, step 1 (GATE_CALL_PHONE_YES_ACCEPT, owner 2026-11-18 "ok go": a person taps the accept).
 *
 * A caller with an open estimate sometimes says yes on a call and chooses pay per application. The call pipeline
 * books the visit, but nothing accepts the estimate: the visit stays a one-off with no price and no link to the
 * estimate, and the plan never starts (2026-11-12). This module files ONE admin card (call_phone_yes) for each call
 * that booked a pest visit while the customer had an open estimate, so a person accepts it. Filing accepts nothing and
 * sends nothing: the booking text keeps the estimate's accept link, and the customer can still accept alone. The
 * card's tap, "Accept as pay per application" (acceptPhoneYesCard), runs the office's own accept and books the plan
 * from the visit the call booked; it sends what the office's Mark accepted sends (the membership email), nothing more.
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
 * The caller's word decides the card's state, never whether it exists: a later cancel, one-time ask or annual prepay
 * choice is no yes, named on the card. The one exception is an annual prepay choice on the booking call itself: the
 * prepay card owns that call (call-prepay-choice.js). No card while a call since the send still owes a read
 * (call-phone-yes-word.js owedReadSql) or while one of the customer's estimates is being sent. Only an estimate already
 * sent when the call began counts, and never an archived one. "Sent" is the estimate's first real handoff
 * (deliveryState.firstDeliveredAt, which a resend never moves), else sent_at. The card stays open while an unlinked
 * pest visit the call booked is on the calendar, also after the estimate expires. It closes itself only on evidence that
 * answers its ask (AGENTS.md): none of its estimates is left (each declined, archived or deleted; any other status,
 * also send_failed during a re-send, keeps the card, and an accept that leaves the visit unlinked keeps it, saying so),
 * no unlinked pest visit of the call is left on the calendar, or the call moves to another customer.
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
// How long a card waits on an estimate claimed 'sending' before it reads the claim as a send that died.
const SEND_SETTLE_MS = 15 * 60 * 1000;
const LIVE_VISIT_STATUSES = ['pending', 'confirmed'];
// A visit still on the calendar keeps the card: every status but cancelled and skipped. A visit waiting for its new
// slot (rescheduled) and a done visit keep it too (the plan was still never accepted), so the gap never closes by itself.
const CALENDAR_VISIT_STATUSES = ['pending', 'confirmed', 'rescheduled', 'en_route', 'on_site', 'completed'];
const OPEN_ESTIMATE_STATUSES = ['sent', 'viewed'];
// The statuses that settle an estimate for good (with an archive or a deleted row). Any other status keeps the card
// naming it: open, lapsed (the office can extend it and accept), being sent again (a resend claims 'sending' and then
// restores its status, admin-estimates.js), or held back as send_failed until the office re-sends it (a re-price hold
// during a send parks it there). An accepted estimate keeps the card only while the call's visit is unlinked.
const SETTLED_ESTIMATE_STATUSES = ['accepted', 'declined'];
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
  caller_took_back: "The customer's latest word asks to cancel or for a one-time visit, not a plan.",
  caller_chose_annual_prepay: "The customer's latest word chooses annual prepay, not pay per application.",
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
  terms_may_differ: 'The estimate may not show the terms the caller heard: its prices changed after it was last sent, or it was sent again after the yes.',
};

const skip = (reason) => ({ card: false, reason });

const parseJson = (value) => {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
};

// When the customer was sent an estimate. A row the send path recorded (a deliveryState object): its FIRST real
// handoff (deliveryState.firstDeliveredAt, kept across resends: call-commitments' FIRST_HANDOFF_SQL) or the first view,
// whichever came first, and null while every send was held back or failed (the send path stamps sent_at even then).
// A row with no deliveryState (an older send): sent_at. A resend moves sent_at, never this. Null for an estimate never
// sent. SQL over the unaliased `estimates` table.
const handoffSql = () => `(CASE WHEN jsonb_typeof(estimates.estimate_data -> 'deliveryState') = 'object'
  THEN LEAST(${require('./call-commitments').FIRST_HANDOFF_SQL}, estimates.viewed_at) ELSE estimates.sent_at END)`;

// The estimate's send time, the earliest moment a yes to it can count (the loaders read handoffSql as handoff_at). An
// estimate whose every send was held back counts from that attempt, as the candidate query reads it, so its card still
// files (its shadow line says it was never delivered); as another estimate it bounds nothing and was open to no one.
function sentAnchorOf(estimate) {
  const at = new Date(estimate.handoff_at || estimate.sent_at || estimate.created_at || 0);
  return Number.isNaN(at.getTime()) ? new Date(0) : at;
}
const earliestSentAnchor = (estimates) => new Date(Math.min(...estimates.map((e) => sentAnchorOf(e).getTime())));

// True when the estimate may not show the terms the caller heard, by the send path's delivery stamp
// (sendSnapshot.priced, moved only by a real handoff; estimate-updated-wording's pricedContent and canonicalJson): its
// prices changed after its last delivery, or it was delivered again after the yes (only the last delivery's terms are
// kept, so the yes may be about other ones). A row with no stamp (sent before the stamp existed) reads as unchanged, as
// the shared offerChangedSinceDelivery reads it.
function termsMayDiffer(estimate, yesAt) {
  const UW = require('./estimate-updated-wording');
  const data = parseJson(estimate.estimate_data);
  const stamped = data.sendSnapshot?.priced;
  if (stamped && typeof stamped === 'object' && UW.canonicalJson(stamped) !== UW.canonicalJson(UW.pricedContent(estimate))) return true;
  const last = Date.parse(data.deliveryState?.lastDeliveredAt);
  return Number.isFinite(last) && yesAt instanceof Date && last > yesAt.getTime();
}

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
// One of the customer's estimates is being sent now: a 'sending' claim younger than SEND_SETTLE_MS (an older one is a
// send that died mid-flight).
function estimateBeingSent(conn, customerId, now) {
  return conn('estimates').where({ customer_id: customerId, status: 'sending' }).whereNull('archived_at')
    .where('updated_at', '>', new Date(now.getTime() - SEND_SETTLE_MS)).first('id');
}

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
  // A send in flight claims 'sending' and then restores the status (admin-estimates.js): which estimates are open is
  // known only once it settles, so the card waits (a send takes seconds). A claim older than SEND_SETTLE_MS is a send
  // that died mid-flight (nothing restores it): the card no longer waits on it.
  if (await estimateBeingSent(conn, customerId, now)) return skip('estimate_being_sent');
  const since = earliestSentAnchor(answerable);
  // Every call since the send, the booking call included, is read first: an unread one may hold the yes or take it back.
  if (await Word.unreadCallSince(conn, { customerId, since })) return skip('call_still_processing');
  const until = await newerEstimateSentAt(conn, { customerId, cardIds: answerable.map((e) => e.id), bookingCallId: callLogId });
  const heard = await Word.callerWord(conn, { customerId, since, until });
  // An annual prepay choice on the booking call itself is the prepay card's (call-prepay-choice.js files one per booked
  // call). Any other later word files this card with no yes, the word named.
  if (heard.noYes === 'caller_chose_annual_prepay' && String(heard.callLogId) === String(callLogId)) return skip('chose_annual_prepay');
  const { yes } = heard;
  const estimate = open.length === 1 ? open[0] : null;
  // One visit: the call booked no other one still on the calendar (one en route, on site or done counts too).
  const visit = visits.length === 1 && (await callVisitsOnCalendar(conn, callLogId, customerId)).length === 1 ? visits[0] : null;
  const problem = await acceptProblem(conn, { estimate, visit, customerId, now });
  const cardIds = answerable.map((e) => e.id);
  return {
    card: true,
    yes,
    estimate,
    visit,
    estimateIds: cardIds.map(String),
    noYes: heard.noYes,
    // The window the caller's word was read in, so the tap can read it again under its lock.
    wordSince: since,
    wordUntil: until,
    acceptProblem: problem,
    autoProblem: problem || (await yesProblem(conn, { customerId, yes, call, cardIds, estimate })) || heard.noYes,
  };
}

// What stands between the yes and an automatic accept beyond the accept's own checks: the yes came after the booking
// call, the booking call is unread or a later call followed (laterWordProblem); another estimate was open when the
// caller said yes; or the estimate may not show the terms the caller heard.
async function yesProblem(conn, { customerId, yes, call, cardIds, estimate }) {
  const later = await Word.laterWordProblem(conn, { customerId, yes, booking: call });
  if (later || !yes) return later;
  if (await otherEstimateOpenAt(conn, { customerId, cardIds, callLogId: yes.callLogId })) return 'yes_maybe_other_estimate';
  return estimate && termsMayDiffer(estimate, yes.at) ? 'terms_may_differ' : null;
}

// The card's headline, by state. Only a yes the call reader recorded is called a yes; while the call that gave it is
// read again, the card says so instead of showing words it cannot check.
const ACCEPTED_SUMMARY = 'An estimate on this card was accepted, but the visit this call booked is not linked to it yet.';

// The headline for a card's fields as they now stand.
function summaryOf(p) {
  if (p.estimate_accepted === true) return ACCEPTED_SUMMARY;
  return cardSummary({ yes: p.yes_heard === true, rechecking: p.yes_rechecking === true });
}

function cardSummary({ yes, rechecking = false }) {
  if (yes) return 'Caller said yes to pay per application on the call. The estimate is not accepted yet.';
  if (rechecking) return 'A call booked a pest visit while an estimate is open. The call with the yes is being read again. The estimate is not accepted yet.';
  return 'A call booked a pest visit while an estimate is open. No yes heard on the call. The estimate is not accepted yet.';
}

// The card's yes fields: the caller's pay-per-application choice with their own words, none, or (rechecking) the call
// that gave the yes while it is read again, with no words. The sweep keeps them current (cardState); the shadow
// verdict stays as filed.
function heardFields(yes, { recheckingCallId = null, noYes = null } = {}) {
  const why = !yes && !recheckingCallId ? noYes || null : null;
  return {
    yes_heard: !!yes,
    yes_rechecking: !yes && !!recheckingCallId,
    billing_choice: yes ? 'per_application' : null,
    yes_call_log_id: yes ? String(yes.callLogId) : (recheckingCallId ? String(recheckingCallId) : null),
    yes_at: yes?.at ? new Date(yes.at).toISOString() : null,
    caller_words: yes?.quote || null,
    // Why there is no yes (a later cancel, an annual choice, a tenant's word...), shown to the office.
    no_yes_reason: why,
    no_yes_message: why ? REASONS[why] || null : null,
  };
}

// The call a card's yes came from, read again: 'gone' (no longer this customer's), 'owed' (being read again),
// 'changed' (its words no longer hold), 'read' (a re-read finished; the full pass decides), 'same', or 'none' (the card
// shows no yes).
async function yesCallState(payload, customerId, conn = db) {
  if (!payload.yes_call_log_id || (payload.yes_heard !== true && payload.yes_rechecking !== true)) return 'none';
  const row = await conn('call_log').where({ id: payload.yes_call_log_id, customer_id: customerId })
    .first([...Word.WORD_COLUMNS, conn.raw(`${Word.owedReadSql()} AS owed_read`)]);
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
        ...heardFields(yes, { noYes: evaluation.noYes }),
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
  estimate_closed: 'No longer applies: the estimate was declined, archived or is gone.',
};

// The estimates a card names: its one estimate, or every estimate that was open when it was filed.
function cardEstimateIds(card) {
  if (card.related_estimate_id) return [String(card.related_estimate_id)];
  const ids = parseJson(card.payload).estimate_ids;
  return Array.isArray(ids) ? ids.map(String) : [];
}

// Why an open card closes ({ close: note }), what changed ({ refresh: yes, rechecking? } for its yes fields, keepYes
// when they did not, estimateIds when its estimate links changed, estimateAccepted when its accepted state did), or
// null to keep it as it is. The card holds while an unlinked pest visit its call booked is on the calendar and one of
// its estimates is not yet declined, archived or deleted: an expiry, a held-back re-send or an accept alone never
// closes it (the visit is still unlinked). While a call in its window still owes a read, the card shows nothing new.
// Every visit the call booked that is still on the calendar (any status but cancelled or skipped: also one en route, on
// site or done), by the call's id and a source_action only a call writes.
function callVisitsOnCalendar(conn, callLogId, customerId) {
  return conn('scheduled_services')
    .where({ source_call_log_id: callLogId, customer_id: customerId })
    .whereIn('source_action', require('./call-prepay-choice').callCreatedSourceActions())
    .whereIn('status', CALENDAR_VISIT_STATUSES)
    .select('*');
}

// `conn`: the global handle, or the close's own transaction when it reads the card again under the lock (a cron job
// holds one pool connection for its lock, so a read inside the transaction must not take a third).
async function cardState(card, conn = db) {
  const customerId = card.related_customer_id;
  if (!(await conn('call_log').where({ id: card.call_log_id, customer_id: customerId }).first('id'))) return { close: MOOT_NOTES.customer_changed };
  const onCalendar = await callVisitsOnCalendar(conn, card.call_log_id, customerId);
  if (!onCalendar.length) return { close: MOOT_NOTES.no_booked_visit };
  if (!(await anyPestVisit(conn, onCalendar.filter((v) => !v.source_estimate_id)))) {
    return { close: onCalendar.some((v) => v.source_estimate_id) ? MOOT_NOTES.visit_linked : MOOT_NOTES.no_pest_visit };
  }
  const ids = cardEstimateIds(card);
  const estimates = ids.length
    ? await conn('estimates').whereIn('id', ids).where({ customer_id: customerId })
      .select('id', 'status', 'sent_at', 'created_at', 'archived_at', conn.raw(`${handoffSql()} AS handoff_at`))
    : [];
  // An archived estimate is closed to the customer, whatever its status.
  const live = estimates.filter((e) => !e.archived_at);
  const kept = live.filter((e) => !SETTLED_ESTIMATE_STATUSES.includes(e.status));
  // An accepted estimate keeps the card while a pest visit this call booked is unlinked (checked above): the office's
  // Mark accepted links no visit (skipAutoSchedule), so the visit still lacks the plan. The accept answers only half of
  // the card's ask, so the card stays, says so and keeps that estimate's link.
  const accepted = live.filter((e) => e.status === 'accepted');
  if (!kept.length && !accepted.length) return { close: MOOT_NOTES.estimate_closed };
  // A card with more than one estimate links the ones still open, lapsed or accepted, in the card's own order (a set
  // compare: a row order that differs is no change, so the card's version moves only when an estimate leaves).
  const stays = [...kept, ...accepted];
  const staySet = new Set(stays.map((e) => String(e.id)));
  const keptIds = ids.filter((id) => staySet.has(id));
  const linksChanged = !card.related_estimate_id && keptIds.length !== ids.length;
  const acceptedChanged = (accepted.length > 0) !== (parseJson(card.payload).estimate_accepted === true);
  // The yes is read again in every state, an accepted one too: the card never shows words that no longer hold.
  const state = await yesState(card, { customerId, ids, since: earliestSentAnchor(stays) }, conn);
  if (state?.close || (!linksChanged && !acceptedChanged)) return state;
  return {
    ...(state || { keepYes: true }),
    ...(linksChanged ? { estimateIds: keptIds } : {}),
    ...(acceptedChanged ? { estimateAccepted: accepted.length > 0 } : {}),
  };
}

// The card's yes fields, read again: { close: note }, { refresh: yes, rechecking? } when they changed, or null.
async function yesState(card, { customerId, ids, since }, conn = db) {
  // The yes the card shows, checked first, also while other calls are read: never words that no longer hold.
  const p = parseJson(card.payload);
  const yesCall = await yesCallState(p, customerId, conn);
  if (yesCall === 'owed') return p.yes_rechecking === true ? null : { refresh: null, rechecking: p.yes_call_log_id };
  // Words that no longer hold are cleared at once. A later word never closes the card (AGENTS.md: an owed ask closes
  // only on evidence answering it); it shows as no yes, the word named.
  const stale = yesCall === 'gone' || yesCall === 'changed';
  const until = await newerEstimateSentAt(conn, { customerId, cardIds: ids, bookingCallId: card.call_log_id });
  const heard = await Word.callerWord(conn, { customerId, since, until });
  if (await Word.unreadCallSince(conn, { customerId, since })) {
    // A call still owes a read, so nothing new is shown yet; but a yes the read calls no longer back is cleared now.
    const backed = p.yes_heard !== true || (heard.yes && String(heard.yes.callLogId) === String(p.yes_call_log_id) && heard.yes.quote === p.caller_words);
    return stale || !backed ? { refresh: null, noYes: heard.yes ? null : heard.noYes } : null;
  }
  // The yes the card shows must be the customer's latest word, from the same call with the same words.
  const now = heardFields(heard.yes, { noYes: heard.noYes });
  const same = !stale && ['yes_heard', 'yes_rechecking', 'yes_call_log_id', 'caller_words', 'no_yes_reason']
    .every((k) => now[k] === (typeof now[k] === 'boolean' ? p[k] === true : (p[k] ?? null)));
  return same ? null : { refresh: heard.yes, noYes: heard.noYes };
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
      // A dismissed card is never filed again, so the close is read again under the lock: evidence that changed since
      // the first read (a re-read that dropped a cancel, a visit put back) keeps the card, and the next run reads it.
      const again = await cardState({ ...card, payload: row.payload }, trx);
      if (!again?.close) return false;
      await trx('triage_items').where({ id: card.id, status: 'open' }).update({
        status: 'dismissed', resolution_source: 'auto', resolution_rule: MOOT_RULE, resolution_note: again.close,
        resolved_at: stamp, updated_at: stamp,
      });
      await syncCallReviewStatus(trx, card.call_log_id, 'dismissed');
      return true;
    }
    const payload = {
      ...parseJson(row.payload),
      ...(state.keepYes ? {} : heardFields(state.refresh, { recheckingCallId: state.rechecking, noYes: state.noYes })),
      ...(state.estimateIds ? { estimate_ids: state.estimateIds } : {}),
      ...(state.estimateAccepted === undefined ? {} : { estimate_accepted: state.estimateAccepted }),
    };
    await trx('triage_items').where({ id: card.id, status: 'open' })
      .update({ payload: JSON.stringify(payload), summary: summaryOf(payload), updated_at: stamp });
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
        .whereRaw(`COALESCE(${handoffSql()}, estimates.sent_at, estimates.created_at) <= ${require('./sms-pending-conversations').callStartedAtSql()}`)
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

// ── The tap: "Accept as pay per application" ──
//
// A person accepts the estimate from the card, the way the office's Mark accepted does (markEstimateManuallyAccepted,
// standard billing), and the visit the call booked becomes the plan's first visit. The accept links that visit to the
// estimate before the conversion (beforeConvert), so the converter books the plan from it (its reserved-visit path) and
// seeds the next visits; its last step before the commit checks that series and prices it at the plan's per-visit
// amount. The accept, the link, the series and the prices are one transaction: a refusal at any step changes nothing.
// The tap needs no yes: the card shows the evidence, and the person decides.

const ACCEPT_SOURCE = 'call_phone_yes';
const cents = (n) => Math.round(Number(n) * 100);

// Why the tap cannot accept, in plain words. The list shows it on the card before any tap; a refused tap leads with
// "Nothing was accepted." A reason from the accept's own checks (REASONS) reads the same way.
const TAP_UNAVAILABLE = {
  changed_since_check: 'The estimate, the visit or the call changed since the card loaded. Reload and look again.',
  series_not_booked: 'The plan could not be booked from the visit. Accept it from the estimate instead.',
  price_unresolved: "The plan's per-visit price could not be set. Accept it from the estimate instead.",
  customer_changed: 'The call no longer belongs to this customer.',
  no_booked_visit: 'The visits the call booked are off the calendar.',
  no_pest_visit: 'No unlinked pest visit the call booked is left on the calendar.',
  no_open_estimate: 'The customer has no open estimate that was sent before the call.',
  estimate_being_sent: "One of the customer's estimates is being sent. Reload in a minute.",
  call_still_processing: 'A call since the estimate was sent is still being read. Reload in a few minutes.',
  chose_annual_prepay: 'The caller chose annual prepay on the booking call. Use the annual prepay card.',
  estimate_not_on_card: 'The estimate it would accept is not one this card names. Accept it from the estimate.',
  card_out_of_date: "The card's details changed since it was last updated. It updates within 10 minutes. Reload then.",
  card_changed: 'The card changed or was closed since it loaded. Reload and look again.',
  word_changed: "The caller's word changed since the card loaded. Reload and look again.",
  word_not_current: "The caller's words on the card are not the latest word about this estimate. Reload in 10 minutes, or accept it from the estimate.",
  accept_failed: 'The accept failed. Try again, or accept it from the estimate.',
};
const whyNot = (reason) => TAP_UNAVAILABLE[reason] || REASONS[reason] || TAP_UNAVAILABLE.accept_failed;
// The message of a refused tap, by reason.
const TAP_REFUSALS = {
  ...Object.fromEntries(Object.entries(TAP_UNAVAILABLE).map(([k, why]) => [k, `Nothing was accepted. ${why}`])),
  already_accepted: 'The estimate is already accepted. Nothing changed.',
};
function tapRefusal(reason) {
  return { ok: false, reason, message: TAP_REFUSALS[reason] || `Nothing was accepted. ${whyNot(reason)}` };
}
const stop = (reason) => Object.assign(new Error(reason), { phoneYesRefusal: reason });

// What the card showed, as one opaque token: the estimate and its row version, and the booked visit as read. The list
// stamps it (tapStateOf) and the tap sends it back, so an edit or a reschedule since asks for a fresh look.
function tapPreviewTokenOf(evaluation) {
  const Manual = require('./estimate-manual-acceptance');
  const facts = [
    String(evaluation.estimate.id), Manual.estimateRowPin(evaluation.estimate),
    String(evaluation.visit.id), Manual.bookedVisitsPinOf([evaluation.visit]),
  ];
  return require('crypto').createHash('sha256').update(JSON.stringify(facts)).digest('hex').slice(0, 32);
}

// The caller's word as one comparable string: the card's yes fields (the ones the sweep compares, yesState).
const WORD_FIELDS = ['yes_heard', 'yes_rechecking', 'yes_call_log_id', 'caller_words', 'no_yes_reason'];
const wordKeyOf = (f) => JSON.stringify(WORD_FIELDS.map((k) => (k === 'yes_heard' || k === 'yes_rechecking' ? f[k] === true : (f[k] ?? null))));
// The word the evaluation read, and its window, for the tap to read again under its lock.
function tapWordOf(evaluation) {
  return { since: evaluation.wordSince, until: evaluation.wordUntil, key: wordKeyOf(heardFields(evaluation.yes, { noYes: evaluation.noYes })) };
}

// What the list stamp and the tap both check first. { ok: true, evaluation, customerId }, or { ok: false, reason, note }
// (note: the card's text before any tap). No tap has run yet, so a note never says "Nothing was accepted" (the office
// may have accepted the estimate by hand).
async function tapCheck(shown, { now }) {
  const note = (why) => `The tap cannot accept this one. ${why}`;
  // A list row carries the card's payload and version as shown, but not its links (the customer and the estimate it was
  // filed for, which the sweep never rewrites): those come from the card's own row.
  const links = 'related_customer_id' in shown && 'related_estimate_id' in shown ? shown
    : await db('triage_items').where({ id: shown.id }).first('related_customer_id', 'related_estimate_id');
  if (!links) return { ok: false, reason: 'card_changed', note: note(TAP_UNAVAILABLE.card_changed) };
  const card = { ...shown, related_customer_id: links.related_customer_id, related_estimate_id: links.related_estimate_id };
  const customerId = parseJson(card.payload).customer_id || card.related_customer_id || null;
  const evaluation = await evaluatePhoneYes({ callLogId: card.call_log_id, customerId, now });
  if (!evaluation.card) return { ok: false, reason: evaluation.reason, note: note(whyNot(evaluation.reason)) };
  if (evaluation.acceptProblem) {
    const why = REASONS[evaluation.acceptProblem] || 'The accept would not go ahead.';
    return { ok: false, reason: evaluation.acceptProblem, note: note(`${why} Accept it from the estimate.`) };
  }
  // The estimate the accept would take must be one the card names: an estimate that reopened since is not.
  if (!cardEstimateIds(card).includes(String(evaluation.estimate.id))) {
    return { ok: false, reason: 'estimate_not_on_card', note: note(TAP_UNAVAILABLE.estimate_not_on_card) };
  }
  // The booking call's own billing choice, read from that call alone: annual prepay leaves it to the prepay card, also
  // when a later call (a cancel, a one-time ask) is the customer's latest word.
  const booking = await db('call_log').where({ id: card.call_log_id, customer_id: customerId }).first(Word.CALL_COLUMNS);
  if (!booking) return { ok: false, reason: 'customer_changed', note: note(whyNot('customer_changed')) };
  if (Word.choseAnnualPrepay(booking)) return { ok: false, reason: 'chose_annual_prepay', note: note(whyNot('chose_annual_prepay')) };
  // The words the card shows must be the latest word about THIS estimate (read in its window): a card that names a
  // lapsed estimate too can show a yes given before this estimate was sent.
  if (wordKeyOf(parseJson(card.payload)) !== tapWordOf(evaluation).key) {
    return { ok: false, reason: 'word_not_current', note: note(TAP_UNAVAILABLE.word_not_current) };
  }
  // The card must show what the sweep would show now (cardState: nothing to rewrite or close): the caller's word, the
  // estimate links and the accepted state as they stand. A tap never acts on words the card no longer holds.
  if (await cardState(card)) return { ok: false, reason: 'card_out_of_date', note: note(TAP_UNAVAILABLE.card_out_of_date) };
  return { ok: true, evaluation, customerId };
}

/**
 * What the tap on an open card can do now, read live: the server decides, so the screen holds no copy of the rule.
 * @returns {{can_accept:true, preview_token, estimate_id, visit_id, visit_date, message:null}
 *   |{can_accept:false, preview_token:null, message}}
 */
async function tapStateOf(card, { now = new Date() } = {}) {
  const check = await tapCheck(card, { now });
  if (!check.ok) return { can_accept: false, preview_token: null, message: check.note };
  const { evaluation } = check;
  const { dateOnlyString } = require('../utils/datetime-et');
  return {
    can_accept: true,
    preview_token: tapPreviewTokenOf(evaluation),
    estimate_id: String(evaluation.estimate.id),
    visit_id: String(evaluation.visit.id),
    visit_date: dateOnlyString(evaluation.visit.scheduled_date),
    message: null,
  };
}

// Step 1, inside the accept's transaction before the conversion: lock and read again every fact the tap read outside it
// (the card, the call and the caller's word, the booked visit and the call's other visits, the estimate's links, the
// customer's other open estimates and plan), then link the visit to the estimate.
function linkVisitStep({ visit, customerId, bookingCallId, cardId, expectedUpdatedAt, word }) {
  const Manual = require('./estimate-manual-acceptance');
  const pin = Manual.bookedVisitsPinOf([visit]);
  return async (trx, { estimate }) => {
    // The global lock order: property-preferences advisory, then customer-comms (the accept holds both already: they
    // are reentrant), then the customers row, then the call's triage lock (admin-triage.js: the customer row before the
    // call lock). The converter takes property-preferences again later in this transaction, so the row must not come
    // before it. Under the triage lock no sweep rewrites or closes the card, and no other action settles it, until
    // this accept commits or rolls back.
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', ['property-preferences', String(customerId)]);
    await require('../utils/customer-comms-lock').lockCustomerComms(trx, customerId);
    await trx('customers').where({ id: customerId }).forUpdate().first('id');
    await lockTriageCall(trx, bookingCallId);
    // FOR UPDATE, as the sweep's filing takes it: no read of the call changes until the commit, and the card's Resolve
    // (transitionCore, same transaction) needs no lock upgrade.
    const booking = await trx('call_log').where({ id: bookingCallId, customer_id: customerId }).forUpdate().first(Word.CALL_COLUMNS);
    if (!booking) throw stop('customer_changed');
    if (Word.choseAnnualPrepay(booking)) throw stop('chose_annual_prepay');
    // The card, locked: still open, the version the office saw, and naming this estimate.
    const card = await trx('triage_items').where({ id: cardId }).forUpdate().first('status', 'updated_at', 'related_estimate_id', 'payload');
    if (!card || !['open', 'in_progress'].includes(card.status) || !expectedUpdatedAt
      || new Date(card.updated_at).getTime() !== new Date(expectedUpdatedAt).getTime()) throw stop('card_changed');
    if (!cardEstimateIds(card).includes(String(estimate.id))) throw stop('estimate_not_on_card');
    // The words the locked card shows are still the ones checked (the latest word about this estimate).
    if (wordKeyOf(parseJson(card.payload)) !== word.key) throw stop('word_changed');
    // The caller's word, read again under the lock in the same window: a call still being read, or any change since
    // the check (a later cancel, a re-read) refuses.
    if (await Word.unreadCallSince(trx, { customerId, since: word.since })) throw stop('call_still_processing');
    const heard = await Word.callerWord(trx, { customerId, since: word.since, until: word.until });
    if (wordKeyOf(heardFields(heard.yes, { noYes: heard.noYes })) !== word.key) throw stop('word_changed');
    // A send that started since the check: which estimates are open is known only once it settles.
    if (await estimateBeingSent(trx, customerId, new Date())) throw stop('estimate_being_sent');
    // The locked visit passes the evaluation's own visit checks again (family, property, price, add-ons, series and
    // assessment flags), not only the pin.
    const row = await trx('scheduled_services').where({ id: visit.id }).forUpdate().first();
    if (!row || Manual.bookedVisitsPinOf([row]) !== pin || await visitProblem(trx, row, estimate, new Date())) throw stop('changed_since_check');
    // The call still booked exactly this one visit: the only live one, and the only one on the calendar.
    const live = await require('./call-prepay-choice').liveVisitsOfCall(trx, bookingCallId, customerId);
    const onCalendar = await callVisitsOnCalendar(trx, bookingCallId, customerId);
    if (live.map((v) => String(v.id)).join() !== String(visit.id) || onCalendar.length !== 1) throw stop('changed_since_check');
    if (await Manual.estimateLinkedVisitsQuery(trx, estimate.id).first('id')) throw stop('estimate_has_visits');
    // The accept claimed this estimate (no longer open): any open estimate left is another one.
    if ((await openEstimatesOf(trx, customerId, new Date())).some((e) => String(e.id) !== String(estimate.id))) throw stop('more_than_one_estimate');
    if (await existingPlan(trx, customerId, visit.id)) throw stop('existing_plan');
    const n = await trx('scheduled_services').where({ id: visit.id }).whereNull('source_estimate_id')
      .update({ source_estimate_id: estimate.id, updated_at: new Date() });
    if (Number(n) !== 1) throw stop('changed_since_check');
  };
}

// Step 2, the accept's last step before the commit: check the series the converter booked from the visit, and price
// it. The per-visit price is this acceptance's own per-application amount (the converter's figure, the one the
// customer-level fee carries), never a guess. The label stays as booked (the converter never relabels service_type).
function priceSeriesStep({ customerId, visit, seen }) {
  return async (trx, { estimate, conversion }) => {
    const amount = Number(conversion?.membershipEmail?.perApplicationAmount);
    const customer = await trx('customers').where({ id: customerId, billing_mode: 'per_application' }).first('per_application_fee');
    if (!(amount > 0) || cents(customer?.per_application_fee) !== cents(amount)) throw stop('price_unresolved');
    // The series: the visit as a recurring parent linked to the estimate on a pest cadence catalog row, its next visits
    // on the same row, and no other visit linked to the estimate.
    const { PEST_CADENCE_CATALOG_KEYS } = require('./estimate-converter');
    const parent = await trx('scheduled_services as s')
      .join('services as c', 'c.id', 's.service_id')
      .where({ 's.id': visit.id, 's.is_recurring': true, 's.source_estimate_id': estimate.id })
      .whereNull('s.recurring_parent_id').whereNotNull('s.recurring_pattern')
      .whereIn('c.service_key', Object.values(PEST_CADENCE_CATALOG_KEYS))
      .first('s.id', 's.service_id', 's.estimated_price');
    if (!parent) throw stop('series_not_booked');
    const children = await trx('scheduled_services').where({ recurring_parent_id: parent.id }).select('id', 'service_id', 'estimated_price');
    const series = [parent, ...children];
    const seriesIds = new Set(series.map((r) => String(r.id)));
    const linked = await require('./estimate-manual-acceptance').estimateLinkedVisitsQuery(trx, estimate.id).select('id');
    const sameSeries = linked.length === seriesIds.size && linked.every((r) => seriesIds.has(String(r.id)));
    if (!children.length || !sameSeries || children.some((c) => c.service_id !== parent.service_id)) throw stop('series_not_booked');
    if (series.some((r) => r.estimated_price != null && cents(r.estimated_price) !== cents(amount))) throw stop('visit_priced');
    await trx('scheduled_services').whereIn('id', [...seriesIds]).update({ estimated_price: amount, updated_at: new Date() });
    Object.assign(seen, { seriesIds: [...seriesIds], amount });
  };
}

// What a failed accept tells the office: a step's own reason, a pin that moved, the accept's own 4xx message, or a
// plain failure. Nothing was accepted in every case.
function tapErrorRefusal(err) {
  if (err.phoneYesRefusal) return tapRefusal(err.phoneYesRefusal);
  if (err.code === 'preview_changed') return tapRefusal('changed_since_check');
  if (err.statusCode && err.statusCode < 500 && err.message) return { ok: false, reason: 'accept_refused', message: `Nothing was accepted. ${err.message}` };
  return tapRefusal('accept_failed');
}

/**
 * The tap on an open card. The caller (the route) has checked the gate, the admin, the card and its version, and hands
 * in the card's Resolve (resolveCard(trx) -> 'ok' | another outcome), which runs inside the accept's transaction.
 * Reads the card's call again, checks the token, then runs the office's own accept with the two steps above.
 * @returns {{ok:true, estimateId, visitId, seriesIds, amount, warnings}|{ok:false, reason, message}}
 */
async function acceptPhoneYesCard({ item, adminUserId = null, previewToken = null, expectedUpdatedAt = null, resolveCard = null, now = new Date() }) {
  const check = await tapCheck(item, { now });
  if (!check.ok) return tapRefusal(check.reason);
  const { evaluation, customerId } = check;
  if (!previewToken || previewToken !== tapPreviewTokenOf(evaluation)) return tapRefusal('changed_since_check');
  const Manual = require('./estimate-manual-acceptance');
  const { estimate, visit } = evaluation;
  const seen = {};
  let result;
  try {
    result = await Manual.markEstimateManuallyAccepted({
      estimateId: estimate.id,
      // Checked inside the accept's transaction before the claim: the estimate row and the booked visit as read, with
      // no add-on line. A change since refuses (preview_changed) before anything is written.
      expected: { ...Manual.estimateRowPin(estimate), bookedVisits: { ids: [visit.id], pin: Manual.bookedVisitsPinOf([visit]), noAddons: true } },
      beforeConvert: linkVisitStep({
        visit, customerId, bookingCallId: item.call_log_id, cardId: item.id, expectedUpdatedAt, word: tapWordOf(evaluation),
      }),
      beforeCommit: async (trx, ctx) => {
        await priceSeriesStep({ customerId, visit, seen })(trx, ctx);
        // The card closes with the accept, in its transaction: a card another admin closed or changed since rolls the
        // whole accept back.
        if (resolveCard && (await resolveCard(trx)) !== 'ok') throw stop('card_changed');
      },
      bookedAppointmentIds: [visit.id],
      adminUserId,
      source: ACCEPT_SOURCE,
      billingTerm: 'standard',
    });
  } catch (err) {
    logger.warn(`[call-phone-yes] tap accept refused for estimate ${estimate.id}: ${err.phoneYesRefusal || err.code || err.name || 'error'}`);
    return tapErrorRefusal(err);
  }
  // Another session accepted it between the read and the accept: the short-circuit changed nothing.
  if (result?.alreadyAccepted) return tapRefusal('already_accepted');
  return {
    ok: true, estimateId: String(estimate.id), visitId: String(visit.id), seriesIds: seen.seriesIds || [], amount: seen.amount ?? null,
    warnings: Array.isArray(result?.warnings) ? result.warnings : [],
  };
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
  ACCEPT_SOURCE,
  TAP_REFUSALS,
  tapStateOf,
  tapPreviewTokenOf,
  acceptPhoneYesCard,
  // Tests only: the two writes under the lock, without the sweep's own reads first.
  _private: {
    fileCardForTest: fileCard, applyCardStateForTest: applyCardState,
    // The tap's two steps inside the accept, driven directly.
    linkVisitStepForTest: linkVisitStep, priceSeriesStepForTest: priceSeriesStep, tapWordOfForTest: tapWordOf,
  },
};
