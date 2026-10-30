/**
 * Call prepay choice (GATE_CALL_PREPAY_CHOICE, owner 2026-10-29).
 *
 * A caller with an open estimate sometimes chooses ANNUAL PREPAY on the call. Nothing in the app used to
 * read that choice, so the office re-entered it by hand in the New appointment form. The V2 extraction now
 * carries it as service_request.billing_choice ('annual_prepay' | 'per_application' | null). This module
 * is the half for calls the pipeline (or the Phone agent) BOOKED: the visit is already on the calendar, so
 * the office needs one tap that accepts the customer's open estimate as annual prepay, exactly as the New
 * appointment form does when "Billing on acceptance: Annual prepay" is picked (admin-schedule.js, the
 * accept-on-book block: markEstimateManuallyAccepted with billingTerm 'prepay_annual',
 * annualPrepayTermStart = the booked date, annualPrepayCoverage from the booked series, then the booked
 * rows are linked to the estimate).
 *
 *   runCallPrepayChoiceSweep  every 10 minutes: files ONE advisory, admin-only card per call (reason
 *                             call_prepay_choice) when the call's customer has a live visit from the call
 *                             and a newest open estimate that is prepay-eligible; closes an open card that
 *                             stopped being true (estimate accepted or expired, visit gone).
 *   evaluateCallPrepay        the one read both the sweep, the list and the accept use. It runs
 *                             prepayBookingEligibility (the same guard the form's preflight and the accept
 *                             run) and derives the coverage from the booked visits.
 *   acceptCallPrepayChoice    the tap. Re-reads everything, refuses with a plain message, runs the accept.
 *
 * The pipeline NEVER accepts, invoices or texts: the sweep only files a card. The accept creates a DRAFT
 * annual prepay invoice (not sent) and a payment_pending term; visits bill per application until it is
 * paid. Dark behind GATE_CALL_PREPAY_CHOICE; off = nothing here runs.
 */

const db = require('../models/db');
const logger = require('./logger');
const { lockTriageCall, syncCallReviewStatus } = require('../utils/triage-locks');
const { visitsPerYearForCadence, prepayCoverageCadenceForPattern } = require('./prepay-cadence');

const REASON_CODE = 'call_prepay_choice';
const MOOT_RULE = 'call_prepay_choice_moot';
const LOOKBACK_DAYS = 3;
const SCAN_LIMIT = 200;
const MAX_CARDS_PER_RUN = 25;
// A visit from the call that is still ahead of us: on the calendar, not started, not moved or cancelled.
const LIVE_VISIT_STATUSES = ['pending', 'confirmed'];
const OPEN_ESTIMATE_STATUSES = ['sent', 'viewed'];
const BILLING_CHOICES = new Set(['annual_prepay', 'per_application']);

const live = () => require('../config/feature-gates').callPrepayChoiceLive();

// The plan the CALLER chose, from a valid V2 extraction. Absence (an older extraction, a field the model
// left out) is null, never a guess.
function billingChoiceOf(extraction) {
  const choice = extraction?.service_request?.billing_choice;
  return BILLING_CHOICES.has(choice) ? choice : null;
}

const parseJson = (value) => {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
};

const dateOnly = (value) => {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
};

// Plain words for every reason the accept cannot run. Same facts the schedule form's downgrade messages
// give, without the "booked as standard" wording (the visit is already booked).
const REFUSALS = {
  no_customer: 'This call has no linked customer, so there is no estimate to accept.',
  customer_changed: 'The call was linked to a different customer after this card was filed. Review the card.',
  no_booked_visit: 'The visit from this call is no longer on the calendar. Nothing was accepted.',
  no_open_estimate: 'This customer has no open estimate to accept. Nothing was accepted.',
  estimate_not_open: 'That estimate is no longer open for this customer (it was accepted, declined, expired or moved). Nothing was accepted.',
  visit_already_linked: 'A visit from this call is already linked to an estimate. Nothing was accepted.',
  mixed_services: 'The call booked more than one kind of visit, so one prepay term cannot cover them. Accept it from the estimate.',
  property_mismatch: 'The visit is at a different property than the estimate. Accept it from the estimate.',
  setup_fee_stamped: 'The visit carries a setup fee. Accept it from the estimate so the setup is billed once.',
  visit_prepaid: 'The visit already has a payment recorded. Annual prepay cannot be combined with it. Accept it from the estimate.',
  has_addons: 'The visit has add-on lines. Annual prepay cannot cover them. Accept it from the estimate.',
  existing_customer: 'This customer already has a live plan, so annual prepay is not offered. Nothing was accepted.',
  live_plan_unknown: 'The system could not confirm the customer’s plan just now. Try again in a minute.',
  one_time_items: 'The estimate has a one-time charge that a prepay accept would not schedule or invoice. Accept it from the estimate.',
  manager_approval_pending: 'The estimate still needs manager approval before it can be accepted.',
  commercial_risk_review: 'The estimate needs its commercial business type set first.',
  multi_service: 'Annual prepay covers one recurring service and this estimate has more than one.',
  status_not_acceptable: 'Only a sent or viewed estimate can be accepted.',
  expired: 'The estimate has expired. Revive it on the Estimates page first.',
  no_recurring_annual: 'The estimate has no recurring annual price.',
  not_eligible: 'This estimate is not eligible for annual prepay. Nothing was accepted.',
  cadence_unknown: 'The estimate’s visit cadence could not be read, so the prepay coverage cannot be checked. Accept it from the estimate.',
  cadence_unsupported: 'Annual prepay does not support this visit cadence. Accept it from the estimate.',
  booked_cadence_differs: 'The booked visits repeat on a different cadence than the estimate. Accept it from the estimate.',
  service_mismatch: 'The booked visit is not the service the estimate quoted. Accept it from the estimate.',
  term_overlap: 'This customer already has an annual prepay term covering this date. Nothing was accepted.',
  already_accepted: 'Someone already accepted this estimate. Nothing was accepted.',
  changed_since_check: 'The estimate or the booked visit changed while this was being accepted. Nothing was accepted. Try again.',
  preview_changed: 'The estimate, the price or the visit changed since this card was shown. Reload to see the new terms. Nothing was accepted.',
  choice_changed: 'The call no longer shows the caller choosing annual prepay (it was re-read). Nothing was accepted.',
  termite_estimate: 'This estimate has a termite line. Accept it from the estimate, where the termite notice and agreement are handled.',
  call_reprocessing: 'The call is being re-read right now. Try again in a minute.',
  accept_failed: 'The accept did not go through. Nothing was accepted.',
};
const refusal = (reason, extra = {}) => ({ ok: false, reason, message: REFUSALS[reason] || REFUSALS.not_eligible, ...extra });

// The quote's single recurring service name and visit cadence, read the way admin-schedule.js's prepay
// preflight reads them (the quoted plan is what the invoice prices). Null parts when unreadable.
function quotePlanOf(estimate) {
  try {
    const data = parseJson(estimate.estimate_data);
    const { acceptanceServiceLists } = require('../routes/estimate-public');
    const converter = require('./estimate-converter');
    const svc = (acceptanceServiceLists(data).recurringSvcList || [])[0] || {};
    const pestSelectionCadence = converter.recurringServiceKey(svc) === 'pest_control'
      ? prepayCoverageCadenceForPattern(data.customerSelection?.frequency)
      : null;
    const rawLineVisits = Number(svc.visitsPerYear ?? svc.visits_per_year ?? svc.visits ?? svc.apps);
    const rawLineCadence = [svc.frequency, svc.frequencyKey, svc.frequency_key, svc.recurringPattern, svc.recurring_pattern]
      .map((value) => prepayCoverageCadenceForPattern(value))
      .find(Boolean)
      || (rawLineVisits === 9 ? 'every_6_weeks' : null);
    return {
      name: svc.name || svc.serviceName || svc.service_name || svc.service || svc.label || null,
      cadence: pestSelectionCadence || rawLineCadence || prepayCoverageCadenceForPattern(converter.explicitServiceCadence(svc)),
    };
  } catch {
    return { name: null, cadence: null };
  }
}

// The cadence a booked recurring row repeats on, in the coverage vocabulary (a 42-day custom series is the
// every-6-weeks plan, as the form books it).
function bookedCadenceOf(row) {
  if (!row.is_recurring) return null;
  const pattern = row.recurring_pattern === 'custom' && Number(row.recurring_interval_days) === 42 ? 'every_6_weeks' : row.recurring_pattern;
  return prepayCoverageCadenceForPattern(pattern) || 'unsupported';
}

// The coverage config the accept needs, from the booked visits and the quoted plan. Pure.
// { ok: true, coverage, termStart, bookedIds } or a refusal. The covered-visit count is FIXED by the cadence
// (the invoice prices the quoted plan), never taken from the booking.
// Per-row rules, in order: the first rule any booked visit breaks names the refusal. Property: the shared
// estimate-vs-visit compare (property ids when both carry one, else the quote's address against the visit's
// stamped service address; an unknown address is a mismatch). Prepaid: a payment recorded on the visit (cash,
// Zelle, another term) cannot be combined with annual invoicing, as on the New appointment form.
const BOOKED_ROW_RULES = [
  ['property_mismatch', (r, estimate) => !require('./completion-pricing').propertyMatches(r, estimate)],
  ['visit_prepaid', (r) => Number(r.prepaid_amount) > 0 || !!r.prepaid_method || !!r.annual_prepay_term_id],
  ['setup_fee_stamped', (r) => Number(r.pending_setup_fee) > 0],
];

function derivePrepayCoverage({ estimate, rows, hasAddons = false }) {
  const serviceTypes = [...new Set(rows.map((r) => String(r.service_type || '').trim().toLowerCase()))];
  if (serviceTypes.length !== 1 || !serviceTypes[0]) return refusal('mixed_services');
  const broken = BOOKED_ROW_RULES.find(([, breaks]) => rows.some((r) => breaks(r, estimate)));
  if (broken) return refusal(broken[0]);
  if (hasAddons) return refusal('has_addons');
  const quote = quotePlanOf(estimate);
  if (!quote.cadence) return refusal(quote.name ? 'cadence_unsupported' : 'cadence_unknown');
  const visitCount = visitsPerYearForCadence(quote.cadence);
  if (!visitCount) return refusal('cadence_unsupported');
  const recurringCadences = [...new Set(rows.map(bookedCadenceOf).filter(Boolean))];
  if (recurringCadences.some((c) => c !== quote.cadence)) return refusal('booked_cadence_differs');
  const { serviceMatchesCoverage } = require('./annual-prepay-renewals');
  if (quote.name && !serviceMatchesCoverage({ service_type: rows[0].service_type }, quote.name)) return refusal('service_mismatch');
  const termStart = rows.map((r) => dateOnly(r.scheduled_date)).filter(Boolean).sort()[0];
  if (!termStart) return refusal('no_booked_visit');
  return {
    ok: true,
    termStart,
    bookedIds: rows.map((r) => r.id),
    coverage: {
      coverageServiceType: String(rows[0].service_type).slice(0, 100),
      coverageVisitCount: visitCount,
      coverageCadence: quote.cadence,
    },
  };
}

// The source_action a CALL itself writes on a visit it creates: the auto-booking ('ai_call_pipeline', a literal in
// call-recording-processor.js, as ops-scoreboard.js keeps it), its follow-up visit, the package follow-up, and the
// voice agent's and an outbound callback's pending bookings. Read at call time (the package module is heavy).
function callCreatedSourceActions() {
  const { CALL_FOLLOWUP_SOURCE_ACTION, VOICE_AGENT_BOOKING_SOURCE_ACTION, CALL_OUTBOUND_REVIEW_SOURCE_ACTION } = require('./call-booking-source-actions');
  return ['ai_call_pipeline', CALL_FOLLOWUP_SOURCE_ACTION, require('./package-followup-booking').PACKAGE_FOLLOWUP_SOURCE_ACTION,
    VOICE_AGENT_BOOKING_SOURCE_ACTION, CALL_OUTBOUND_REVIEW_SOURCE_ACTION];
}

// The visits this call BOOKED: the call's id AND a source_action only a call writes. The attach paths
// (findAttachableCallAppointment, a reschedule's make-up move) stamp source_call_log_id only where it is NULL,
// so a call-created visit always names the call that created it. A visit that existed before, or that a person
// or the customer booked during the call, keeps its own source_action when attached: it stays in the
// existing-plan check, so a live plan is never mistaken for a new booking (Codex #7050 r2, r4).
async function liveVisitsOfCall(conn, callLogId, customerId) {
  return conn('scheduled_services')
    .where({ source_call_log_id: callLogId, customer_id: customerId })
    .whereIn('source_action', callCreatedSourceActions())
    .whereIn('status', LIVE_VISIT_STATUSES)
    .orderBy([{ column: 'scheduled_date' }, { column: 'window_start' }, { column: 'id' }])
    .select('*');
}

// The customer's open (sent or viewed, not lapsed) estimate that the customer owns: the card's own estimate
// when it names one, else the newest. An unowned quote is never picked: attaching one is the form's job.
async function openEstimateFor(conn, customerId, now, estimateId = null) {
  return conn('estimates')
    .where({ customer_id: customerId })
    .modify((qb) => { if (estimateId) qb.where({ id: estimateId }); })
    .whereIn('status', OPEN_ESTIMATE_STATUSES)
    .where((qb) => qb.whereNull('expires_at').orWhere('expires_at', '>', now))
    .orderBy('created_at', 'desc')
    .first();
}

async function termOverlap(conn, customerId, termStart) {
  try {
    return await conn('annual_prepay_terms')
      .where({ customer_id: customerId })
      .where(function overlapStatus() {
        this.whereIn('status', ['payment_pending', 'active', 'renewal_pending', 'renewed', 'switch_plan'])
          .orWhere(function lapsedStillInTerm() { this.where('status', 'cancelled').andWhere('renewal_decision', 'cancel'); });
      })
      .andWhere('term_end', '>=', termStart)
      .first('id');
  } catch (e) {
    // A table or column this environment lacks: the accept transaction's own overlap guard still runs.
    logger.warn(`[call-prepay-choice] term overlap read skipped: ${e.code || e.name || 'error'}`);
    return null;
  }
}

/**
 * Can this call's visit(s) and the customer's estimate be accepted as annual prepay right now?
 * @returns {{ok:true, estimate, rows, amount, coverage, termStart, bookedIds}|{ok:false, reason, message}}
 */
// Whether the call STILL shows the caller choosing annual prepay, read the way the sweep files on it: a settled
// valid extraction of a real two-party call with billing_choice annual_prepay. A reprocess that re-read the plan
// (per application, none) or failed the extraction makes the card obsolete ('choice_changed', moot); a pass
// still running is only a wait ('call_reprocessing'), so the card stays.
const CALL_CHOICE_COLUMNS = ['id', 'customer_id', 'processing_status', 'answered_by', 'v2_extraction_status', 'ai_extraction_enriched'];
// What is wrong with the call for this card, or null: it moved to another customer, it is being re-read, or
// it no longer shows the annual prepay choice. The evaluation and the accept's last step ask the same.
function callRefusal(call, customerId) {
  if (!call || String(call.customer_id || '') !== String(customerId)) return 'customer_changed';
  const state = choiceStateOf(call);
  return state === 'ok' ? null : state;
}

function choiceStateOf(call) {
  const { parseExtraction, isRealConversation } = require('./call-held-visits');
  if (!call) return 'choice_changed';
  if (!call.processing_status || call.processing_status === 'processing') return 'call_reprocessing';
  const extraction = call.v2_extraction_status === 'valid' ? parseExtraction(call.ai_extraction_enriched) : null;
  const still = !!extraction && isRealConversation(call, extraction) && billingChoiceOf(extraction) === 'annual_prepay';
  return still ? 'ok' : 'choice_changed';
}

// The accept's last step (its beforeCommit), inside its transaction: lock the call row, then the booked visits
// (both held only until the commit), re-check that the call still belongs to this customer and still shows the
// annual prepay choice, that the visits still match what was checked with no add-on line, then link them to the
// estimate. A change committed before a lock rolls the whole accept back (no invoice, no term); one that waits
// on a lock lands after the commit, an ordinary later edit. The locks are taken last on purpose: settlement
// takes a visit FOR UPDATE NOWAIT, so the window it can collide in stays as short as any visit edit.
function lastStepInAccept({ callLogId, customerId, bookedRows }) {
  const { bookedVisitsPinOf, bookedVisitsHaveAddons, BOOKED_VISIT_PIN_FIELDS } = require('./estimate-manual-acceptance');
  const ids = bookedRows.map((r) => String(r.id));
  const pin = bookedVisitsPinOf(bookedRows);
  const stop = (reason) => Object.assign(new Error(REFUSALS[reason] || REFUSALS.not_eligible), { callPrepayRefusal: reason });
  return async (trx, { estimate }) => {
    const callProblem = callRefusal(await trx('call_log').where({ id: callLogId }).forShare().first(CALL_CHOICE_COLUMNS), customerId);
    if (callProblem) throw stop(callProblem);
    const rows = await trx('scheduled_services').whereIn('id', ids).forUpdate().select(BOOKED_VISIT_PIN_FIELDS);
    if (rows.length !== ids.length || bookedVisitsPinOf(rows) !== pin) throw stop('changed_since_check');
    if (await bookedVisitsHaveAddons(trx, ids)) throw stop('changed_since_check');
    await trx('scheduled_services').whereIn('id', ids).update({ source_estimate_id: estimate.id });
  };
}

async function evaluateCallPrepay({ callLogId, customerId, estimateId = null, conn = db, now = new Date() }) {
  if (!customerId) return refusal('no_customer');
  const call = await conn('call_log').where({ id: callLogId }).first(CALL_CHOICE_COLUMNS);
  const callProblem = callRefusal(call, customerId);
  if (callProblem) return refusal(callProblem);
  const rows = await liveVisitsOfCall(conn, callLogId, customerId);
  if (!rows.length) return refusal('no_booked_visit');
  const estimate = await openEstimateFor(conn, customerId, now, estimateId);
  if (!estimate) return refusal(estimateId ? 'estimate_not_open' : 'no_open_estimate');
  if (termiteEstimate(estimate)) return refusal('termite_estimate', { estimate });
  if (rows.some((r) => r.source_estimate_id)) return refusal('visit_already_linked');
  const { prepayBookingEligibility, bookedVisitsHaveAddons } = require('./estimate-manual-acceptance');
  const rowIds = rows.map((r) => r.id);
  const eligibility = await prepayBookingEligibility(estimate, conn, customerId, rowIds);
  if (!eligibility.eligible) return refusal(REFUSALS[eligibility.reason] ? eligibility.reason : 'not_eligible', { estimate });
  const derived = derivePrepayCoverage({ estimate, rows, hasAddons: await bookedVisitsHaveAddons(conn, rowIds) });
  if (!derived.ok) return { ...derived, estimate };
  if (await termOverlap(conn, customerId, derived.termStart)) return refusal('term_overlap', { estimate });
  return {
    ok: true, estimate, rows, amount: eligibility.invoiceTotal, coverage: derived.coverage, termStart: derived.termStart, bookedIds: derived.bookedIds,
  };
}

// A termite estimate gets no card (Codex #7050 r1). Its accept can message the customer: the state termite
// notice (consumer_notice, GATE_MANUAL_ACCEPT_CONSUMER_NOTICE_SEND) and the program agreement for e-signature
// (termite_agreement, GATE_TERMITE_PROGRAM_AGREEMENT_AUTOSEND). The office accepts those from the estimate,
// where both are handled. Every other annual prepay accept sends nothing: the manual accept skips the welcome
// text and the membership email. The same two reads the accept's plan uses; an unreadable estimate counts as
// termite, so the card never promises "nothing is sent" on a guess.
function termiteEstimate(estimate) {
  try {
    if (require('./estimate-consumer-notice').estimateNeedsConsumerNotice(estimate)) return true;
    const data = typeof estimate.estimate_data === 'string' ? JSON.parse(estimate.estimate_data) : (estimate.estimate_data || {});
    return require('./termite-program-agreement').collectTermiteFacts(data)?.hasProgram === true;
  } catch {
    return true;
  }
}

const money = (n) => (Number.isFinite(Number(n)) ? `$${Number(n).toFixed(2).replace(/\.00$/, '')}` : null);

function cardSummary(amount) {
  const price = money(amount);
  return `Caller chose annual prepay on the call.${price ? ` Accept as annual prepay (${price}) to bill the open estimate that way.` : ''} The invoice is a draft. Nothing is sent to the customer.`;
}

// The one card for a call. Idempotent: ANY row for (call, reason), open or closed, means it was filed.
async function fileCard({ call, extraction, evaluation }) {
  const { buildTriageItem } = require('./call-routing-gates');
  return db.transaction(async (trx) => {
    await lockTriageCall(trx, call.id);
    const existing = await trx('triage_items').where({ call_log_id: call.id, reason_code: REASON_CODE }).first('id');
    if (existing) return false;
    const item = buildTriageItem({
      callLogId: call.id,
      flag: REASON_CODE,
      extraction,
      severity: 'advisory',
      extraPayload: {
        billing_choice: 'annual_prepay',
        customer_id: String(call.customer_id),
        estimate_id: String(evaluation.estimate.id),
        scheduled_service_ids: evaluation.bookedIds.map(String),
        first_visit_date: evaluation.termStart,
        service_type: evaluation.coverage.coverageServiceType,
        cadence: evaluation.coverage.coverageCadence,
        covered_visits: evaluation.coverage.coverageVisitCount,
        invoice_total: Number.isFinite(Number(evaluation.amount)) ? Number(evaluation.amount) : null,
      },
    });
    const inserted = await trx('triage_items')
      .insert({
        ...item,
        summary: cardSummary(evaluation.amount),
        related_customer_id: call.customer_id,
        related_estimate_id: evaluation.estimate.id,
        related_scheduled_service_id: evaluation.rows[0].id,
      })
      .onConflict(trx.raw("(call_log_id, reason_code) WHERE status IN ('open', 'in_progress')"))
      .ignore()
      .returning('id');
    if (!inserted.length) return false;
    await syncCallReviewStatus(trx, call.id);
    return true;
  });
}

// Closes an OPEN card that stopped being true: the estimate was accepted or lapsed, or the visit is gone.
// Dismissed, not resolved (nobody acted on it). A card that is merely ineligible right now stays: the
// office sees the reason on it.
const MOOT_REASONS = new Set(['estimate_not_open', 'no_booked_visit', 'visit_already_linked', 'no_customer', 'choice_changed', 'customer_changed']);
async function closeMootCards({ now }) {
  const open = await db('triage_items as t')
    .join('call_log as c', 'c.id', 't.call_log_id')
    .where('t.reason_code', REASON_CODE)
    .where('t.status', 'open')
    .select('t.id', 't.call_log_id', 't.payload', 'c.customer_id');
  let closed = 0;
  for (const card of open) {
    const payload = parseJson(card.payload);
    let evaluation;
    try {
      // The card's own customer: a call relinked since reads customer_changed, which is moot.
      evaluation = await evaluateCallPrepay({ callLogId: card.call_log_id, customerId: payload.customer_id || card.customer_id, estimateId: payload.estimate_id || null, now });
    } catch (e) {
      logger.warn(`[call-prepay-choice] moot check skipped for card ${card.id}: ${e.code || e.name || 'error'}`);
      continue;
    }
    if (evaluation.ok || !MOOT_REASONS.has(evaluation.reason)) continue;
    await db.transaction(async (trx) => {
      await lockTriageCall(trx, card.call_log_id);
      const stamp = new Date();
      const n = await trx('triage_items').where({ id: card.id, status: 'open' }).update({
        status: 'dismissed', resolution_source: 'auto', resolution_rule: MOOT_RULE,
        resolution_note: 'No longer applies: the estimate was accepted or closed, the visit is gone, or the call no longer shows the choice.',
        resolved_at: stamp, updated_at: stamp,
      });
      if (n) {
        await syncCallReviewStatus(trx, card.call_log_id, 'dismissed');
        closed += 1;
      }
    });
  }
  return closed;
}

/**
 * Files the cards. Dark behind GATE_CALL_PREPAY_CHOICE. Never accepts, invoices or texts.
 * @returns {{skipped?:true, scanned:number, filed:number, closed:number}}
 */
async function runCallPrepayChoiceSweep({ now = new Date() } = {}) {
  if (!live()) return { skipped: true, scanned: 0, filed: 0, closed: 0 };
  const { parseExtraction, isRealConversation } = require('./call-held-visits');
  const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86400 * 1000);
  const calls = await db('call_log')
    .where('created_at', '>=', since)
    .where({ v2_extraction_status: 'valid' })
    .whereNotNull('customer_id')
    .whereRaw("processing_status IS NOT NULL AND processing_status <> 'processing'")
    .whereNotNull('ai_extraction_enriched')
    .modify((qb) => whereNotSandboxCall(qb))
    // Both storage eras of the extraction (jsonb and stringified JSON) carry the value text; JS decides.
    .whereRaw("ai_extraction_enriched::text LIKE '%annual_prepay%'")
    .whereNotExists(function cardAlreadyFiled() {
      this.select(db.raw('1')).from('triage_items')
        .whereRaw('triage_items.call_log_id = call_log.id')
        .where('triage_items.reason_code', REASON_CODE);
    })
    .orderBy('created_at', 'desc')
    .limit(SCAN_LIMIT)
    .select('id', 'customer_id', 'created_at', 'processing_status', 'answered_by', 'ai_extraction_enriched');
  let filed = 0;
  for (const call of calls) {
    if (filed >= MAX_CARDS_PER_RUN) break;
    const extraction = parseExtraction(call.ai_extraction_enriched);
    if (!extraction || !isRealConversation(call, extraction) || billingChoiceOf(extraction) !== 'annual_prepay') continue;
    try {
      const evaluation = await evaluateCallPrepay({ callLogId: call.id, customerId: call.customer_id, now });
      if (!evaluation.ok) continue;
      if (await fileCard({ call, extraction, evaluation })) filed += 1;
    } catch (e) {
      logger.warn(`[call-prepay-choice] card skipped for call ${call.id}: ${e.code || e.name || 'error'}`);
    }
  }
  let closed = 0;
  try {
    closed = await closeMootCards({ now });
  } catch (e) {
    logger.warn(`[call-prepay-choice] moot close pass failed: ${e.code || e.name || 'error'}`);
  }
  return { scanned: calls.length, filed, closed };
}

// The booked rows this evaluation derived the term start and coverage from.
function bookedRowsOf(evaluation) {
  const ids = new Set(evaluation.bookedIds.map(String));
  return evaluation.rows.filter((r) => ids.has(String(r.id)));
}

// What the card showed, as one opaque token: the estimate row version, the booked visits, the amount, the
// coverage and the term start. The list stamps it and the tap sends it back.
function previewTokenOf(evaluation) {
  const { estimateRowPin, bookedVisitsPinOf } = require('./estimate-manual-acceptance');
  const facts = [
    estimateRowPin(evaluation.estimate), bookedVisitsPinOf(bookedRowsOf(evaluation)), evaluation.amount,
    evaluation.coverage, evaluation.termStart,
  ];
  return require('crypto').createHash('sha256').update(JSON.stringify(facts)).digest('hex').slice(0, 32);
}

/**
 * The tap on an open card. The caller (the route) has checked the gate, the admin, the card and its version.
 * Re-reads the call, the visits and the estimate, then runs the same accept the form runs. Sends no invoice and
 * no message (termite estimates, whose accept can, get no card).
 * @returns {{ok:true, invoiceId, amount, warnings}|{ok:false, reason, message}}
 */
async function acceptCallPrepayChoice({ item, adminUserId = null, previewToken = null, now = new Date() }) {
  const payload = parseJson(item.payload);
  const evaluation = await evaluateCallPrepay({ callLogId: item.call_log_id, customerId: payload.customer_id || null, estimateId: payload.estimate_id || null, now });
  if (!evaluation.ok) return evaluation;
  // The card the admin tapped must still show these terms: a price, cadence or visit change since the list
  // loaded asks for a fresh look rather than accepting terms nobody saw.
  if (previewToken !== previewTokenOf(evaluation)) return refusal('preview_changed');

  const { markEstimateManuallyAccepted, estimateRowPin, bookedVisitsPinOf } = require('./estimate-manual-acceptance');
  const bookedRows = bookedRowsOf(evaluation);
  let result;
  try {
    result = await markEstimateManuallyAccepted({
      estimateId: evaluation.estimate.id,
      // Pins checked inside the accept's own transaction: the estimate row and the booked visits this
      // evaluation derived the term start and coverage from, still with no add-on line. An edit, reschedule
      // or cancel since refuses (preview_changed) before any invoice or term exists.
      expected: {
        ...estimateRowPin(evaluation.estimate),
        bookedVisits: { ids: evaluation.bookedIds, pin: bookedVisitsPinOf(bookedRows), noAddons: true },
      },
      beforeCommit: lastStepInAccept({ callLogId: item.call_log_id, customerId: payload.customer_id, bookedRows }),
      bookedAppointmentIds: evaluation.bookedIds,
      adminUserId,
      source: 'verbal_annual_prepay_booking',
      billingTerm: 'prepay_annual',
      // The term starts at the booked visit, as the form anchors it (a future-dated visit must not renew before it is served).
      annualPrepayTermStart: evaluation.termStart,
      annualPrepayCoverage: evaluation.coverage,
      agreementStartDate: /termite/i.test(evaluation.coverage.coverageServiceType) ? evaluation.termStart : null,
    });
  } catch (err) {
    // The accept and its invoice and term are one transaction: nothing is half-applied.
    logger.warn(`[call-prepay-choice] accept failed for estimate ${evaluation.estimate.id}: ${err.code || err.name || 'error'}`);
    return acceptErrorRefusal(err);
  }
  // Another session accepted it between our read and the accept: the short-circuit made no invoice and no term.
  if (result?.alreadyAccepted) return refusal('already_accepted');
  // The accept linked the booked visits inside its own transaction (lastStepInAccept). The property link
  // stays best-effort, as on the form.
  await require('./estimate-property-linkage').linkAcceptedEstimateProperty({
    estimateId: evaluation.estimate.id, customerId: payload.customer_id, onlyServiceIds: evaluation.bookedIds,
  }).catch((e) => logger.warn(`[call-prepay-choice] property link skipped for estimate ${evaluation.estimate.id}: ${e.code || e.name || 'error'}`));
  return { ok: true, invoiceId: result?.conversion?.draftInvoiceId || null, amount: evaluation.amount, warnings: Array.isArray(result?.warnings) ? result.warnings : [] };
}

// What a failed accept tells the office: a refusal the card's own step or a pin raised, else the accept's
// own 4xx message, else a plain failure. Nothing was accepted in every case.
const ACCEPT_ERROR_REASONS = { preview_changed: 'changed_since_check' };
function acceptErrorRefusal(err) {
  const reason = err.callPrepayRefusal || (err.annualPrepayOverlap ? 'term_overlap' : ACCEPT_ERROR_REASONS[err.code]);
  if (reason) return refusal(reason);
  const message = err.statusCode && err.statusCode < 500 && err.message ? `${err.message} Nothing was accepted.` : REFUSALS.accept_failed;
  return { ok: false, reason: 'accept_failed', message };
}

module.exports = {
  REASON_CODE,
  MOOT_RULE,
  REFUSALS,
  billingChoiceOf,
  quotePlanOf,
  derivePrepayCoverage,
  evaluateCallPrepay,
  runCallPrepayChoiceSweep,
  acceptCallPrepayChoice,
  closeMootCards,
  cardSummary,
  previewTokenOf,
  lastStepInAccept,
};
