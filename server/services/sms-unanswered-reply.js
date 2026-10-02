/**
 * Unanswered-text reply — the AI answers a customer text nobody answered.
 *
 * Owner ruling 2026-10-02 ("OK 2 HRS IS FINE"): when a customer's text has sat
 * for two hours with no reply from a person, the house-voice reply that was
 * already drafted, verified and shown to staff as a suggestion goes out on its
 * own. Ordinary questions only. Dark behind GATE_SMS_UNANSWERED_REPLY.
 *
 * This is NOT the auto_send rung of the ladder (sms-graduation.js): no intent
 * mode changes, and a suggestion stays a suggestion for its first two hours.
 * It is a narrower path that reuses the Phase E executor (sms-auto-send.js) as
 * the only place a draft becomes an outbound: the same claim under the thread
 * lock, the same send-once key per inbound, the same send-time rechecks, the
 * same policy-checked provider path. What differs is what earns the send:
 *
 *   - the suggestion is still pending after 120 minutes of OPEN time (the
 *     8 AM–8 PM ET clock the follow-up SLA uses, closed days skipped);
 *   - it is sent the same ET day its facts were read, inside the send window,
 *     so "today" / "tomorrow" in the reply still mean what they said;
 *   - the intent is on the ordinary-question allowlist;
 *   - the draft was stamped at draft time (only while the gate was on) as
 *     verified, action-free, lint-clean and not owed a person's review;
 *   - the autonomy checks of the executor hold (no action, no placeholder, no
 *     price, no unowned follow-up promise, the draft's voice profile is the
 *     effective one);
 *   - the judge backstop is populated and clean for the intent (graduation's
 *     shared gate; the evidence paths of the ladder are NOT required);
 *   - nothing happened on the thread since: no person replied, no reply is in
 *     flight, the customer did not text again, nobody called, and none of the
 *     customer's visits changed after the facts were read.
 *
 * Any miss leaves the suggestion exactly where it was, for a person.
 *
 * PII: never log message bodies or full phone numbers from this module.
 */
const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');
const { isWithinSendWindowET } = require('./messaging/send-window');
const { jsonObject } = require('./sms-gratitude-context');

// Open (8 AM–8 PM ET, closed days skipped) minutes a text waits for a person.
const WAIT_OPEN_MINUTES = 120;
// Query floor only: the same-ET-day rule below is the real age bound.
const LOOKBACK_MS = 24 * 60 * 60 * 1000;
const SWEEP_LIMIT = 100;
// Pages one sweep may read: refused rows stay pending, so the sweep walks past
// them (keyset on inbound time + id) instead of re-reading the same oldest page.
const SWEEP_MAX_PAGES = 10;
const STAMP_VERSION = 'unanswered_reply_v1';
// Bookkeeping retries only reach back this far; older rows are history.
const SETTLE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
// A claim this fresh may still be inside its own post-send bookkeeping.
const SETTLE_GRACE_MS = 2 * 60 * 1000;

// "Ordinary questions" (owner ruling): the two live intents that hold
// unanswered everyday texts. Money, cancellations, complaints, photos,
// customer lookups and unclassified texts are not on it and stay with staff.
const ORDINARY_INTENTS = Object.freeze([
  'general_customer_sms_needs_review',
  'customer_nudge_needs_reply',
]);

// The answered suggestion's terminal status. human_verdict stays NULL: no
// person decided anything, so it is never a graduation outcome or a correction.
const ANSWERED_STATUS = 'auto_answered';

function unansweredReplyLive() {
  return require('../config/feature-gates').smsUnansweredReplyLive();
}

/**
 * What the drafter records on a draft so a later sweep can decide without
 * re-deriving it. Written ONLY while the gate is on (off → {} and the stored
 * JSON is byte-identical to before), which also fences the lane to texts
 * drafted after it was switched on.
 */
function draftStamp({ autoSendSafe, requireReview, lintPass, verifierEnabled } = {}) {
  if (!unansweredReplyLive()) return {};
  return {
    unanswered: {
      policy_version: STAMP_VERSION,
      actions_verified_safe: autoSendSafe === true,
      require_review: requireReview !== false,
      lint_pass: lintPass === true,
      verifier_enabled: verifierEnabled === true,
    },
  };
}

/**
 * Pending suggestions old enough to look at, oldest inbound first. `after` is
 * the last row of the previous page ({ createdAt, smsLogId }).
 */
function candidatePage({ now, limit = SWEEP_LIMIT, after = null }) {
  const { SUGGEST_WORKFLOW } = require('./sms-suggest-mode');
  const { AUTOSEND_WORKFLOW } = require('./sms-auto-send');
  return db('agent_decisions as ad')
    .join('message_drafts as md', 'md.id', 'ad.entity_id')
    .join('sms_log as s', 's.id', 'ad.sms_log_id')
    .where({
      'ad.workflow': SUGGEST_WORKFLOW,
      'ad.status': 'pending_review',
      'md.status': 'suggested',
      's.direction': 'inbound',
    })
    .whereIn('ad.detected_intent', ORDINARY_INTENTS)
    .whereNotNull('ad.customer_id')
    .where('s.created_at', '>=', new Date(now.getTime() - LOOKBACK_MS))
    .where('s.created_at', '<=', new Date(now.getTime() - WAIT_OPEN_MINUTES * 60 * 1000))
    .whereRaw("md.intended_actions->'unanswered'->>'policy_version' = ?", [STAMP_VERSION])
    // One send-once key per inbound: an inbound that ever held a claim (sent,
    // failed or in flight) is never tried again.
    .whereNotExists(function alreadyClaimed() {
      this.select(db.raw('1'))
        .from('agent_decisions as prior')
        .whereRaw('prior.idempotency_key = ? || s.id::text', [`${AUTOSEND_WORKFLOW}:inbound:`]);
    })
    .modify((q) => {
      if (after) q.whereRaw('(s.created_at, s.id) > (?, ?)', [after.createdAt, after.smsLogId]);
    })
    .orderBy('s.created_at', 'asc')
    .orderBy('s.id', 'asc')
    .limit(limit)
    .select(
      'ad.id as decision_id', 'ad.customer_id', 'ad.sms_log_id', 'ad.detected_intent',
      'ad.suggested_message', 'ad.input_snapshot', 'ad.confidence',
      'md.id as draft_id', 'md.draft_response', 'md.inbound_message', 'md.intent as draft_intent',
      'md.intended_actions', 'md.scheduling_intent', 'md.model', 'md.prompt_version',
      'md.created_at as draft_created_at',
      's.created_at as inbound_created_at',
    );
}

/**
 * Pure: why this candidate is not sent, or null. Everything here is decided
 * from the stored suggestion and draft; the live thread and readiness checks
 * come after it (readinessRefusal, claimGuard, handoffCheck).
 */
function candidateRefusal({ row, meta, snapshot, now, dueAt }) {
  const suggest = require('./sms-suggest-mode');
  const { autoSendActionsSafe } = require('./sms-auto-send');
  const reply = row.suggested_message;
  if (!meta || !snapshot) return 'unreadable_draft';
  if (!suggest.suggestionEligible({
    reply, customerId: row.customer_id, smsLogId: row.sms_log_id,
    intent: row.detected_intent, schedulingIntent: row.scheduling_intent === true,
  })) return 'ineligible_base';
  // The card a person would have sent must be the verified draft, word for word.
  if (reply !== row.draft_response) return 'draft_mismatch';
  if (!ORDINARY_INTENTS.includes(row.detected_intent) || row.draft_intent !== row.detected_intent) return 'intent_not_ordinary';

  const stamp = jsonObject(meta.unanswered);
  if (!stamp || stamp.policy_version !== STAMP_VERSION) return 'not_stamped';
  if (stamp.verifier_enabled !== true || jsonObject(meta.verify)?.converged !== true) return 'not_verified';
  if (stamp.require_review !== false) return 'review_required';
  if (stamp.lint_pass !== true || (Array.isArray(snapshot.comms_lint) && snapshot.comms_lint.length)) return 'lint_flagged';
  if (stamp.actions_verified_safe !== true || !autoSendActionsSafe(meta.actions)) return 'action_required';
  if (suggest.hasRedactionPlaceholder(reply)) return 'redaction_placeholder';
  if (suggest.hasPriceQuote(reply)) return 'price_quote';
  const followupSla = require('./sms-followup-sla');
  if (followupSla.realAnswersGateOn() && followupSla.replyPromisesFollowup(reply)) return 'unowned_followup';

  if (!(dueAt instanceof Date) || Number.isNaN(dueAt.getTime()) || dueAt.getTime() > now.getTime()) return 'not_due';
  // Same ET day as the facts the reply was written from: a reply drafted
  // yesterday evening says "tomorrow" about today.
  const factsAt = factsReadAt(row, snapshot);
  if (!factsAt || etDateString(factsAt) !== etDateString(now)) return 'not_same_day';
  return null;
}

function factsReadAt(row, snapshot) {
  const stated = snapshot?.facts_generated_at ? new Date(snapshot.facts_generated_at) : null;
  const at = stated && !Number.isNaN(stated.getTime()) ? stated : new Date(row.draft_created_at);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * The live checks that need a read but no lock: the draft's voice profile is
 * the effective one, the judge backstop is clear for the intent, and none of
 * the customer's visits changed after the facts were read. Fail closed.
 */
async function readinessRefusal({ row, meta, snapshot }) {
  const autoSend = require('./sms-auto-send');
  const profile = await autoSend.pinDraftVoiceProfile({
    intent: row.detected_intent,
    voiceProfileVersion: meta.voice_profile_version ?? null,
  });
  if (profile.reason) return { reason: profile.reason };

  const backstop = await require('./sms-graduation').evaluateJudgeBackstop({
    intent: row.detected_intent,
    voiceProfileVersion: profile.version,
  });
  if (!backstop.clear) return { reason: 'backstop_not_clear' };

  const factsAt = factsReadAt(row, snapshot);
  const changedVisit = await db('scheduled_services')
    .where({ customer_id: row.customer_id })
    .where('updated_at', '>', factsAt)
    .first('id');
  if (changedVisit) return { reason: 'visit_changed' };
  return { reason: null };
}

/** Did anyone call this customer, or the customer call in, since the text? */
async function callSinceInbound(dbh, { threadLast10, customerId, smsLogId }) {
  if (!threadLast10 && !customerId) return true; // no thread identity → cannot rule a call out
  const q = dbh('call_log')
    .whereRaw('created_at > (SELECT created_at FROM sms_log WHERE id = ?)', [smsLogId])
    // Sandy's test line never carries a real customer conversation.
    .whereRaw("COALESCE(source, '') <> 'voice_relay_sandbox'")
    .where(function thread() {
      if (customerId) this.where({ customer_id: customerId });
      if (threadLast10) {
        const last10 = (column) => `RIGHT(REGEXP_REPLACE(COALESCE(${column}, ''), '[^0-9]', '', 'g'), 10) = ?`;
        this.orWhereRaw(last10('from_phone'), [threadLast10]).orWhereRaw(last10('to_phone'), [threadLast10]);
      }
    });
  return Boolean(await q.first('id'));
}

/**
 * Extra claim guards for this lane, run by claimAutoSend INSIDE its locked
 * transaction after the shared thread gauntlet. Returns a refusal reason or
 * null. The suggestion row is locked so a person's Use Draft and this claim
 * serialize on it as well as on the thread.
 */
async function claimGuard(trx, { suggestionId, draftId, smsLogId, threadLast10, customerId }) {
  if (!unansweredReplyLive()) return 'gate_off';
  const { SUGGEST_WORKFLOW } = require('./sms-suggest-mode');
  const card = await trx('agent_decisions')
    .where({ id: suggestionId, workflow: SUGGEST_WORKFLOW, status: 'pending_review', entity_id: draftId, sms_log_id: smsLogId })
    .forUpdate()
    .first('id');
  if (!card) return 'suggestion_moved';
  if (await callSinceInbound(trx, { threadLast10, customerId, smsLogId })) return 'call_since_inbound';
  return null;
}

/**
 * Provider-boundary predicate for this lane: the last read before the text
 * leaves. Inbound webhooks and call writers take no thread lock, so a text or
 * a call that landed after the claim is caught here. A pure state read, so it
 * is repeatable after the sender's attempt marker.
 */
function handoffCheck(claim) {
  const check = async ({ dbi = db } = {}) => {
    if (!unansweredReplyLive()) return { ok: false, code: 'gate_off', reason: 'gate_off' };
    // The executor's sends are conversational, so the shared validator never
    // defers them: a sweep that started at 7:58 PM must not deliver at 8:01.
    if (!isWithinSendWindowET(new Date())) return { ok: false, code: 'outside_send_window', reason: 'outside_send_window' };
    const { threadLast10, customerId, smsLogId } = claim.unanswered;
    const newerInbound = await dbi('sms_log')
      .where({ direction: 'inbound' })
      .whereRaw("COALESCE(message_type, '') NOT LIKE 'job\\_%'")
      .whereRaw('created_at > (SELECT created_at FROM sms_log WHERE id = ?)', [smsLogId])
      .whereNot('id', smsLogId)
      .where(function thread() {
        if (threadLast10) {
          this.whereRaw("RIGHT(REGEXP_REPLACE(COALESCE(from_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [threadLast10]);
        } else {
          this.where({ customer_id: customerId });
        }
      })
      .first('id');
    if (newerInbound) return { ok: false, code: 'newer_inbound', reason: 'newer_inbound' };
    if (await callSinceInbound(dbi, { threadLast10, customerId, smsLogId })) {
      return { ok: false, code: 'call_since_inbound', reason: 'call_since_inbound' };
    }
    return { ok: true };
  };
  return require('./agent-decision-send-checks').markRepeatable(check);
}

/**
 * Label what an accepted send answered: the suggestion becomes auto_answered
 * (no human verdict) and its draft leaves the judge pool as auto_sent. The
 * executor's own bookkeeping parks the suggestion with the thread's other
 * cards and resolves parked cards as ignored; this is the step that says the
 * card was ANSWERED, not passed over. Idempotent and driven from the sent
 * claim row, so a crash between the send and this write is repaired by the
 * next sweep. Returns how many suggestions were labeled.
 */
async function settleAnsweredSuggestions({ decisionId = null, now = new Date() } = {}) {
  const { SUGGEST_WORKFLOW } = require('./sms-suggest-mode');
  const { AUTOSEND_WORKFLOW, SENT_STATUS, DRAFT_SENT_STATUS } = require('./sms-auto-send');
  const claims = db('agent_decisions as c')
    .join('agent_decisions as card', function answeredCard() {
      this.on(db.raw("card.id::text = c.input_snapshot->'unanswered_reply'->>'suggestion_id'"));
    })
    .join('message_drafts as md', 'md.id', 'card.entity_id')
    .where({ 'c.workflow': AUTOSEND_WORKFLOW, 'c.status': SENT_STATUS, 'card.workflow': SUGGEST_WORKFLOW })
    .where(function unsettled() {
      this.whereIn('card.status', ['scheduled', 'ignored']).orWhereIn('md.status', ['suggested', 'shadow']);
    })
    .select('c.id as claim_id', 'card.id as card_id', 'md.id as draft_id');
  if (decisionId) {
    claims.where('c.id', decisionId);
  } else {
    claims
      .where('c.updated_at', '>=', new Date(now.getTime() - SETTLE_LOOKBACK_MS))
      .where('c.updated_at', '<', new Date(now.getTime() - SETTLE_GRACE_MS));
  }
  let settled = 0;
  for (const row of await claims) {
    await db.transaction(async (trx) => {
      settled += await trx('agent_decisions')
        .where({ id: row.card_id, workflow: SUGGEST_WORKFLOW })
        .whereIn('status', ['scheduled', 'ignored'])
        .update({
          status: ANSWERED_STATUS,
          human_verdict: null,
          reviewed_by: 'auto',
          reviewed_at: new Date(),
          correction_note: `No reply from a person within ${WAIT_OPEN_MINUTES / 60} open hours, so the drafted reply was sent (decision ${row.claim_id}).`,
          updated_at: new Date(),
        });
      await trx('message_drafts')
        .where({ id: row.draft_id })
        .whereIn('status', ['suggested', 'shadow'])
        .update({ status: DRAFT_SENT_STATUS });
    });
  }
  return settled;
}

/** Hand one due candidate to the executor's claim and send. */
async function attemptCandidate({ row, meta, snapshot }) {
  const autoSend = require('./sms-auto-send');
  const factsAt = snapshot.facts_generated_at ? new Date(snapshot.facts_generated_at) : null;
  const claim = await autoSend.claimAutoSend({
    draftId: row.draft_id,
    customerId: row.customer_id,
    smsLogId: row.sms_log_id,
    inboundMessage: row.inbound_message,
    reply: row.suggested_message,
    intent: row.detected_intent,
    confidence: row.confidence,
    model: row.model,
    promptVersion: row.prompt_version,
    // The same send-time snapshots the reviewer-send seam would recheck.
    openTimesSnapshot: snapshot.open_times_snapshot || null,
    labelFactsSnapshot: snapshot.label_facts_snapshot || null,
    factsGeneratedAt: factsAt && !Number.isNaN(factsAt.getTime()) ? factsAt : null,
    reserviceBookedSnapshot: snapshot.reservice_booked_snapshot || null,
    liveEtaSnapshot: snapshot.live_eta_snapshot || null,
    techNames: snapshot.tech_names || null,
    visitLoopCommitmentIds: snapshot.visit_loop_commitment_ids || null,
    visitLoopStatus: snapshot.visit_loop_status || null,
    unanswered: { suggestionId: row.decision_id, waitOpenMinutes: WAIT_OPEN_MINUTES },
  });
  if (!claim) return { sent: false, reason: 'guarded_or_claimed' };
  const result = await autoSend.dispatchClaimedSend({
    claim,
    gratitudeLane: false,
    draftId: row.draft_id,
    intent: row.detected_intent,
    reply: row.suggested_message,
    customerId: row.customer_id,
  });
  if (result.sent) {
    try {
      await settleAnsweredSuggestions({ decisionId: claim.decisionId });
    } catch (err) {
      // The customer has been answered; the next sweep labels the card.
      logger.warn(`[sms-unanswered] answered-card label failed (decision ${claim.decisionId}): ${err.message}`);
    }
  }
  return result;
}

/**
 * The sweep: one pass over pending suggestions that have waited long enough.
 * No queue state is created; a scheduler tick is the delay. Every candidate
 * is judged on its own and a refusal leaves its suggestion untouched.
 */
async function processUnansweredReplyCandidates({ now = new Date() } = {}) {
  const totals = { scanned: 0, attempted: 0, sent: 0, refused: {} };
  if (!unansweredReplyLive()) return { ...totals, reason: 'gate_off' };
  // The executor marks its sends conversational (never deferred), so the
  // 8 AM–8 PM ET window is enforced here.
  if (!isWithinSendWindowET(now)) return { ...totals, reason: 'outside_send_window' };

  try {
    await settleAnsweredSuggestions({ now });
  } catch (err) {
    logger.warn(`[sms-unanswered] answered-card repair failed: ${err.message}`);
  }

  const sla = require('./followup-sla-watcher');
  const refuse = (reason) => { totals.refused[reason] = (totals.refused[reason] || 0) + 1; };
  const seenInbounds = new Set();
  let calendar = null;
  let after = null;
  for (let page = 0; page < SWEEP_MAX_PAGES; page += 1) {
    const rows = await candidatePage({ now, after });
    if (!rows.length) break;
    totals.scanned += rows.length;
    const last = rows[rows.length - 1];
    after = { createdAt: last.inbound_created_at, smsLogId: last.sms_log_id };
    if (!calendar) {
      try {
        calendar = await sla.loadSlaCalendar(db, new Date(rows[0].inbound_created_at), now);
      } catch (err) {
        logger.warn(`[sms-unanswered] office calendar unreadable (${err.message}); nothing sent this run`);
        return { ...totals, reason: 'calendar_unavailable' };
      }
    }
    // Real clock, not `now`: a long sweep stops at closing time.
    if (!isWithinSendWindowET(new Date())) return { ...totals, reason: 'outside_send_window' };
    await sweepPage({ rows, now, calendar, sla, refuse, seenInbounds, totals });
    if (rows.length < SWEEP_LIMIT) break;
  }
  return totals;
}

async function sweepPage({ rows, now, calendar, sla, refuse, seenInbounds, totals }) {
  for (const row of rows) {
    if (seenInbounds.has(row.sms_log_id)) continue;
    seenInbounds.add(row.sms_log_id);
    try {
      const meta = jsonObject(row.intended_actions);
      const snapshot = jsonObject(row.input_snapshot);
      let dueAt = null;
      try {
        dueAt = sla.followUpDueAt(row.inbound_created_at, calendar, WAIT_OPEN_MINUTES);
      } catch {
        dueAt = null; // no open day found → not due
      }
      const refusal = candidateRefusal({ row, meta, snapshot, now, dueAt });
      if (refusal) { refuse(refusal); continue; }
      const readiness = await readinessRefusal({ row, meta, snapshot });
      if (readiness.reason) { refuse(readiness.reason); continue; }

      totals.attempted += 1;
      const result = await attemptCandidate({ row, meta, snapshot });
      if (result.sent) {
        totals.sent += 1;
        logger.info(`[sms-unanswered] SENT customer=${row.customer_id} intent=${row.detected_intent} suggestion=${row.decision_id}`);
      } else {
        refuse(result.reason || 'not_sent');
      }
    } catch (err) {
      refuse('error');
      logger.warn(`[sms-unanswered] candidate failed (suggestion ${row.decision_id}): ${err.message}`);
    }
  }
}

module.exports = {
  WAIT_OPEN_MINUTES,
  SWEEP_LIMIT,
  ORDINARY_INTENTS,
  STAMP_VERSION,
  ANSWERED_STATUS,
  unansweredReplyLive,
  draftStamp,
  candidatePage,
  candidateRefusal,
  readinessRefusal,
  callSinceInbound,
  claimGuard,
  handoffCheck,
  settleAnsweredSuggestions,
  processUnansweredReplyCandidates,
};
