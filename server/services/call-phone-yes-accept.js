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
 * word in a caller turn of that call's transcript. "No yes heard" says only that: the card never claims a yes that did
 * not happen. The caller's billing_choice is never consent on its own (the extraction schema says so), so a person
 * decides every accept. Each sweep re-reads an open card's yes, so a call that is re-read or moved never leaves a stale
 * quote on it. Each card also records a shadow verdict for the later automatic step, as of its filing: would an
 * automatic accept go ahead, and if not, the first reason (the accept's own checks, then the caller's word).
 *
 * No card when the customer's latest word since the send is annual prepay (the prepay card owns it,
 * call-prepay-choice.js), a cancellation or a one-time visit; and none until every call since the send is read (the
 * processor's own retry rules). Only an estimate already sent when the call booked the visit counts. The card stays
 * open while an unlinked pest visit the call booked is on the calendar, also after the estimate expires. It closes
 * itself once none of its estimates is open or lapsed (each accepted or declined), no unlinked pest visit of the call
 * is left on the calendar, the call moves to another customer, or a later call takes the yes back.
 *
 * Dark behind GATE_CALL_PHONE_YES_ACCEPT; off = nothing here runs.
 */

const db = require('../models/db');
const logger = require('./logger');
const { lockTriageCall, syncCallReviewStatus } = require('../utils/triage-locks');

const REASON_CODE = 'call_phone_yes';
const MOOT_RULE = 'call_phone_yes_moot';
const LOOKBACK_DAYS = 3;
const SCAN_LIMIT = 200;
const MAX_CARDS_PER_RUN = 10;
const CHOICE_SCAN_LIMIT = 50;
const LIVE_VISIT_STATUSES = ['pending', 'confirmed'];
// A visit still on the calendar keeps the card: every status but cancelled and skipped. A visit waiting for its new
// slot (rescheduled) and a done visit keep it too (the plan was still never accepted), so the gap never closes by itself.
const CALENDAR_VISIT_STATUSES = ['pending', 'confirmed', 'rescheduled', 'en_route', 'on_site', 'completed'];
const OPEN_ESTIMATE_STATUSES = ['sent', 'viewed'];
// An estimate a card keeps naming: open, or lapsed (the office can extend it and accept).
const CARD_ESTIMATE_STATUSES = ['sent', 'viewed', 'expired'];
// The one one-time line a standard accept of a pest plan may carry: the setup fee, which the first visit bills by
// hand (estimate-accept-effects membershipFeeLine; one-time work rows never carry this name).
const MEMBERSHIP_FEE_LINE_NAME = 'WaveGuard membership fee';
const CALL_COLUMNS = ['id', 'customer_id', 'created_at', 'direction', 'processing_status', 'answered_by', 'v2_extraction_status', 'ai_extraction_enriched'];
// The extraction's evidence pointer for the caller's plan choice (JSON pointer; a dotted path in older rows).
const BILLING_CHOICE_PATHS = new Set(['/service_request/billing_choice', 'service_request.billing_choice']);
const CALLER_WORDS_CHARS = 200;
const PEST_FAMILY = new Set(['pest_control']);

// A call the pipeline still owes a read, by the processor's own rules (pendingCandidatesQuery, with the shared retry
// budget in config/call-extraction-retry): not started or queued with a recording to read, being read, or a failed
// transcription or extraction it will retry. A call with nothing to read (no recording) is never waited on.
function owedReadSql(t) {
  const { CALL_EXTRACTION_MAX_ATTEMPTS, EXTRACTION_RETRY_WINDOW_DAYS } = require('../config/call-extraction-retry');
  const underCap = `COALESCE(${t}.extraction_attempts, 0) < ${Number(CALL_EXTRACTION_MAX_ATTEMPTS)}`;
  const readable = `((COALESCE(${t}.recording_url, '') <> '' AND COALESCE(${t}.recording_duration_seconds, ${t}.duration_seconds, 0) > 10)`
    + ` OR (${t}.transcription_metadata ->> 'pan_detected') = 'true')`;
  return `(${t}.processing_status = 'processing'`
    + ` OR ((${t}.processing_status IS NULL OR ${t}.processing_status = 'pending') AND ${readable})`
    + ` OR (${t}.processing_status = 'no_transcription' AND ${underCap})`
    + ` OR (${t}.processing_status = 'extraction_failed' AND ${underCap}`
    + ` AND ${t}.created_at > now() - interval '${Number(EXTRACTION_RETRY_WINDOW_DAYS)} days'))`;
}

// `?.() === true`: a test's whole-module gate mock without this reader reads as off (the #7910 pattern).
const live = () => require('../config/feature-gates').callPhoneYesAcceptLive?.() === true;

// Plain words for each reason an accept would not go ahead. The card's shadow line reads "Auto would accept: no."
// and then the reason.
const REASONS = {
  no_yes_heard: 'No yes was heard on the call.',
  yes_without_words: "The call reader recorded a pay-per-application choice but saved none of the caller's own words.",
  more_than_one_estimate: 'The customer has more than one open estimate.',
  more_than_one_visit: 'The call booked more than one visit.',
  termite_estimate: 'The estimate has a termite line. Its notice and agreement are handled on the estimate.',
  commercial_estimate: 'The estimate is not a known residential quote (commercial, or no residential category).',
  newer_call: 'The customer called again later. Read that call before you accept.',
  yes_after_booking: 'The caller said yes on a later call than the one that booked the visit.',
  booking_call_unread: 'The call that booked the visit could not be read, so its last word is unknown.',
  group_estimate: 'The estimate is part of an estimate group.',
  no_recurring_price: 'The estimate has no recurring price.',
  not_pest_plan: 'The estimate is not one residential pest control plan.',
  one_time_items: 'The estimate has a one-time charge that the office must bill.',
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
};

const skip = (reason) => ({ card: false, reason });

const parseJson = (value) => {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
};

// The estimate's send time, the earliest moment a yes to it can count (a re-send moves it).
function sentAnchorOf(estimate) {
  const at = new Date(estimate.sent_at || estimate.created_at || 0);
  return Number.isNaN(at.getTime()) ? new Date(0) : at;
}
const earliestSentAnchor = (estimates) => new Date(Math.min(...estimates.map((e) => sentAnchorOf(e).getTime())));

async function openEstimatesOf(conn, customerId, now) {
  return conn('estimates')
    .where({ customer_id: customerId })
    .whereIn('status', OPEN_ESTIMATE_STATUSES)
    .where((qb) => qb.whereNull('expires_at').orWhere('expires_at', '>', now))
    .orderBy('created_at', 'desc')
    .select('*');
}

// The caller's own sentence choosing the plan: an evidence quote for billing_choice labeled as the caller's AND found
// word for word in a caller turn of the transcript (outbound labels oriented the way the triage flags read them),
// cut to fit; null when none is. An unlabeled or one-speaker transcript grounds nothing.
function callerWordsOf(extraction, { transcript, outbound = false } = {}) {
  const quotes = (Array.isArray(extraction?.evidence) ? extraction.evidence : [])
    .filter((e) => BILLING_CHOICE_PATHS.has(e?.field_path) && e.speaker === 'caller' && typeof e.quote === 'string' && e.quote.trim());
  if (!quotes.length) return null;
  const { parseTurns, turnsHolding } = require('./call-reschedule-agreement').groundingTools;
  const { orientTranscriptForOutbound } = require('./call-triage-flags');
  const turns = parseTurns(orientTranscriptForOutbound(transcript, outbound));
  if (!turns || new Set(turns.map((t) => t.agent)).size < 2) return null;
  const hit = quotes.find((e) => turnsHolding(turns, e.quote, 'caller').length > 0);
  if (!hit) return null;
  const words = hit.quote.replace(/\s+/g, ' ').trim();
  return words.length > CALLER_WORDS_CHARS ? `${words.slice(0, CALLER_WORDS_CHARS - 1).trimEnd()}…` : words;
}

// A later call with one of these intents takes back an earlier yes: the customer asked to cancel, or for a one-time
// visit instead of the plan (service_request.service_intent). It is the latest word even with no billing choice.
const CONTRARY_INTENTS = new Set(['cancellation_request', 'preventative_one_time']);

// The customer's latest word on a call since `since`, from the newest read, valid, two-party call that has one: a
// billing choice ({ choice, callLogId, at, quote }; quote = callerWordsOf, read from the call's transcript), a
// cancellation or one-time ask ({ contrary: true, callLogId, at }), or null when no call has either.
async function latestBillingChoice(conn, { customerId, since }) {
  const { parseExtraction, isRealConversation } = require('./call-held-visits');
  const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
  const { billingChoiceOf } = require('./call-prepay-choice');
  const rows = await conn('call_log')
    .where({ customer_id: customerId, v2_extraction_status: 'valid' })
    .where('created_at', '>=', since)
    .whereNotNull('processing_status')
    .whereRaw(`NOT ${owedReadSql('call_log')}`)
    .whereNotNull('ai_extraction_enriched')
    .modify((qb) => whereNotSandboxCall(qb))
    .orderBy('created_at', 'desc')
    .limit(CHOICE_SCAN_LIMIT)
    .select(CALL_COLUMNS);
  for (const row of rows) {
    const extraction = parseExtraction(row.ai_extraction_enriched);
    if (!extraction || !isRealConversation(row, extraction)) continue;
    // Checked before the choice: a call that both names a plan and asks to cancel or for a one-time visit is no yes.
    if (CONTRARY_INTENTS.has(extraction.service_request?.service_intent)) return { contrary: true, callLogId: row.id, at: row.created_at };
    const choice = billingChoiceOf(extraction);
    if (!choice) continue;
    const { transcription } = (await conn('call_log').where({ id: row.id }).first('transcription')) || {};
    const quote = callerWordsOf(extraction, { transcript: transcription, outbound: row.direction === 'outbound' });
    return { choice, callLogId: row.id, at: row.created_at, quote };
  }
  return null;
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
  if (!(Number(estimate.monthly_total) > 0)) return 'no_recurring_price';
  const EstimateConverter = require('./estimate-converter');
  const lines = require('../routes/estimate-public').acceptanceServiceLists(data).recurringSvcList || [];
  if (lines.length !== 1 || EstimateConverter.recurringServiceKey(lines[0]) !== 'pest_control') return 'not_pest_plan';
  const AcceptEffects = require('./estimate-accept-effects');
  const oneTime = AcceptEffects.oneTimeLineEffects(estimate, EstimateConverter, { billingTerm: 'standard' });
  if (oneTime.refusal || oneTime.lines.some((line) => line.name !== MEMBERSHIP_FEE_LINE_NAME)) return 'one_time_items';
  // A one-time total that no line itemizes (legacy quotes): the office must see the charge (the carded accept's rule).
  if (AcceptEffects.unitemizedOneTimeRefusal(estimate, oneTime.lines)) return 'one_time_items';
  if (await Manual.estimateLinkedVisitsQuery(conn, estimate.id).first('id')) return 'estimate_has_visits';
  return null;
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
// throws instead of reading as "no plan") or another live recurring visit. The accept would replace that billing.
async function existingPlan(conn, customerId, visitId) {
  if (await require('./waveguard-existing-services').isActivePlanCustomer(conn, customerId, { strict: true })) return true;
  return !!(await conn('scheduled_services')
    .where({ customer_id: customerId, is_recurring: true })
    .whereIn('status', LIVE_VISIT_STATUSES)
    .whereNot({ id: visitId })
    .first('id'));
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

// True when a call from the customer since `since` (the booking call included) still owes a read (owedReadSql): it
// may hold the yes or take it back. Sandbox calls do not count.
async function unreadCallSince(conn, { customerId, since }) {
  const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
  return !!(await conn('call_log')
    .where({ customer_id: customerId })
    .where('created_at', '>=', since)
    .whereRaw(owedReadSql('call_log'))
    .modify((qb) => whereNotSandboxCall(qb))
    .first('id'));
}

// What stands between the caller's word and the call that booked the visit (`booking`, a call_log row), or null:
//   yes_after_booking    the yes came on a later call than the booking (the visit was not booked for the plan);
//   booking_call_unread  the booking call's words were not read (a failed or invalid extraction may hide a no);
//   newer_call           another call from the customer came since the yes (or, with no yes, since the booking).
// Every call in the window is read by now (unreadCallSince). Sandbox calls do not count.
async function laterWordProblem(conn, { customerId, yes, booking }) {
  if (yes && new Date(yes.at) > new Date(booking.created_at)) return 'yes_after_booking';
  if (booking.v2_extraction_status !== 'valid') return 'booking_call_unread';
  const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
  const later = await conn('call_log')
    .where({ customer_id: customerId })
    .where('created_at', '>', yes ? yes.at : booking.created_at)
    .whereNotIn('id', [yes?.callLogId, booking.id].filter(Boolean))
    .modify((qb) => whereNotSandboxCall(qb))
    .first('id');
  return later ? 'newer_call' : null;
}

// The customer's word since the send, as the card reads it: a reason for no card (took_back, chose_annual_prepay), or
// the yes and, when there is none, why. A yes is the caller's pay-per-application choice WITH the caller's own words;
// a choice without them is no yes the card can show.
async function callerWord(conn, { customerId, since }) {
  const word = await latestBillingChoice(conn, { customerId, since });
  if (word?.contrary) return { skip: 'took_back' };
  if (word?.choice === 'annual_prepay') return { skip: 'chose_annual_prepay' };
  if (word?.choice !== 'per_application') return { yes: null, noYes: 'no_yes_heard' };
  if (!word.quote) return { yes: null, noYes: 'yes_without_words' };
  return { yes: { callLogId: word.callLogId, at: word.at, quote: word.quote }, noYes: null };
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
  const call = await conn('call_log').where({ id: callLogId, customer_id: customerId }).first(CALL_COLUMNS);
  if (!call) return skip('customer_changed');
  const visits = await require('./call-prepay-choice').liveVisitsOfCall(conn, callLogId, customerId);
  if (!visits.length) return skip('no_booked_visit');
  // The same visit must be both unlinked and pest (a linked pest visit beside an unlinked lawn visit is not one).
  if (!(await anyPestVisit(conn, visits.filter((v) => !v.source_estimate_id)))) return skip('no_pest_visit');
  // The card is about an estimate already sent when the call booked the visit (one sent later is not what the caller
  // answered); every open estimate still counts toward "more than one".
  const open = await openEstimatesOf(conn, customerId, now);
  const answerable = open.filter((e) => sentAnchorOf(e) <= new Date(call.created_at));
  if (!answerable.length) return skip('no_open_estimate');
  const since = earliestSentAnchor(answerable);
  // Every call since the send, the booking call included, is read first: an unread one may hold the yes or take it back.
  if (await unreadCallSince(conn, { customerId, since })) return skip('call_still_processing');
  const heard = await callerWord(conn, { customerId, since });
  if (heard.skip) return skip(heard.skip);
  const { yes } = heard;
  const later = await laterWordProblem(conn, { customerId, yes, booking: call });
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
    autoProblem: problem || later || heard.noYes,
  };
}

// The card's headline, by state. Only a yes the call reader recorded is called a yes.
function cardSummary({ yes }) {
  return yes
    ? 'Caller said yes to pay per application on the call. The estimate is not accepted yet.'
    : 'A call booked a pest visit while an estimate is open. No yes heard on the call. The estimate is not accepted yet.';
}

// The card's yes fields: the caller's pay-per-application choice with their own words, or none. The sweep keeps them
// current (cardState); the shadow verdict stays as filed.
function heardFields(yes) {
  return {
    yes_heard: !!yes,
    billing_choice: yes ? 'per_application' : null,
    yes_call_log_id: yes ? String(yes.callLogId) : null,
    yes_at: yes?.at ? new Date(yes.at).toISOString() : null,
    caller_words: yes?.quote || null,
  };
}

// The one card for a call. Idempotent: ANY row for (call, reason), open or closed, means it was filed.
async function fileCard({ call, extraction, evaluation }) {
  const { buildTriageItem } = require('./call-routing-gates');
  const { yes, estimate, visit, autoProblem } = evaluation;
  return db.transaction(async (trx) => {
    await lockTriageCall(trx, call.id);
    if (await trx('triage_items').where({ call_log_id: call.id, reason_code: REASON_CODE }).first('id')) return false;
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
  estimate_closed: 'No longer applies: the estimate was declined or is gone.',
  took_back: 'No longer applies: the customer asked to cancel or for a one-time visit on a later call.',
  chose_annual_prepay: 'No longer applies: the customer chose annual prepay on a later call.',
};

// The estimates a card names: its one estimate, or every estimate that was open when it was filed.
function cardEstimateIds(card) {
  if (card.related_estimate_id) return [String(card.related_estimate_id)];
  const ids = parseJson(card.payload).estimate_ids;
  return Array.isArray(ids) ? ids.map(String) : [];
}

// Why an open card closes ({ close: note }), its yes fields when they changed ({ refresh: yes }), or null to keep it
// as it is. The card holds while an unlinked pest visit its call booked is on the calendar and one of its estimates is
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
    ? await db('estimates').whereIn('id', ids).where({ customer_id: customerId }).select('id', 'status', 'sent_at', 'created_at')
    : [];
  const kept = estimates.filter((e) => CARD_ESTIMATE_STATUSES.includes(e.status));
  if (!kept.length) return { close: estimates.some((e) => e.status === 'accepted') ? MOOT_NOTES.estimate_accepted : MOOT_NOTES.estimate_closed };
  const since = earliestSentAnchor(kept);
  if (await unreadCallSince(db, { customerId, since })) return null;
  const heard = await callerWord(db, { customerId, since });
  if (heard.skip) return { close: MOOT_NOTES[heard.skip] };
  // The yes the card shows must still be the customer's latest word, from the same call with the same words.
  const p = parseJson(card.payload);
  const now = heardFields(heard.yes);
  const same = now.yes_call_log_id === (p.yes_call_log_id ?? null) && now.caller_words === (p.caller_words ?? null) && now.yes_heard === (p.yes_heard === true);
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
      payload: JSON.stringify({ ...parseJson(row.payload), ...heardFields(state.refresh) }),
      summary: cardSummary({ yes: state.refresh }),
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
 * @returns {{skipped?:true, scanned:number, filed:number, closed:number}}
 */
async function runCallPhoneYesSweep({ now = new Date() } = {}) {
  if (!live()) return { skipped: true, scanned: 0, filed: 0, closed: 0 };
  const { parseExtraction } = require('./call-held-visits');
  const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
  const { callCreatedSourceActions } = require('./call-prepay-choice');
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86400 * 1000);
  const calls = await db('call_log')
    .where('created_at', '>=', since)
    .whereNotNull('customer_id')
    .whereNotNull('processing_status')
    .whereRaw(`NOT ${owedReadSql('call_log')}`)
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
        .whereRaw('COALESCE(estimates.sent_at, estimates.created_at) <= call_log.created_at')
        .where((qb) => qb.whereNull('estimates.expires_at').orWhere('estimates.expires_at', '>', now));
    })
    .whereNotExists(function cardAlreadyFiled() {
      this.select(db.raw('1')).from('triage_items')
        .whereRaw('triage_items.call_log_id = call_log.id')
        .where('triage_items.reason_code', REASON_CODE);
    })
    .orderBy('created_at', 'desc')
    .limit(SCAN_LIMIT)
    .select('id', 'customer_id', 'ai_extraction_enriched');
  let filed = 0;
  for (const call of calls) {
    if (filed >= MAX_CARDS_PER_RUN) break;
    try {
      const evaluation = await evaluatePhoneYes({ callLogId: call.id, customerId: call.customer_id, now });
      if (evaluation.card && await fileCard({ call, extraction: parseExtraction(call.ai_extraction_enriched), evaluation })) {
        filed += 1;
        logger.info(`[call-phone-yes] card for call ${call.id}: ${evaluation.yes ? 'yes heard' : 'no yes heard'}, auto would accept: ${evaluation.autoProblem ? `no (${evaluation.autoProblem})` : 'yes'}`);
      }
    } catch (e) {
      logger.warn(`[call-phone-yes] skipped call ${call.id}: ${e.code || e.name || 'error'}`);
    }
  }
  let closed = 0;
  try {
    closed = await closeMootCards();
  } catch (e) {
    logger.warn(`[call-phone-yes] moot close pass failed: ${e.code || e.name || 'error'}`);
  }
  return { scanned: calls.length, filed, closed };
}

module.exports = {
  REASON_CODE,
  MOOT_RULE,
  REASONS,
  MEMBERSHIP_FEE_LINE_NAME,
  evaluatePhoneYes,
  latestBillingChoice,
  callerWordsOf,
  runCallPhoneYesSweep,
  closeMootCards,
  cardSummary,
};
