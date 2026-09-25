/**
 * SMS Auto-Send Executor — Phase E of the SMS brand-voice loop.
 *
 * The top rung of the ladder shadow → suggest → auto_send. When an intent is
 * flipped to 'auto_send' (sms_intent_modes), a VERIFIED house-voice draft for
 * an inbound on that intent is sent to the customer automatically — no human
 * in the loop. This module is the only place a draft turns into an autonomous
 * outbound, and it is built to be the security boundary: it re-verifies every
 * precondition itself rather than trusting the drafter that called it.
 *
 * Defense in depth, in order (the same order as autoSendPreflight):
 *   1. A lane-specific explicit gate — GATE_SMS_AUTO_SEND for ordinary
 *      intents, GATE_SMS_GRATITUDE_REPLIES for gratitude-only replies.
 *   2. Base eligibility — reply present, customer + inbound link, NOT a
 *      scheduling-intent message, NOT an escalation intent (suggestionEligible).
 *   3. Intent mode is actually 'auto_send' (fail-closed lookup → 'shadow').
 *   4. Server-enforced graduation eligibility — the suggest → auto_send rung is
 *      re-evaluated from LIVE judge + outcome data on EVERY send, so a quality
 *      regression after the manual flip stops auto-send (fail closed).
 *   5. Thread guard-gauntlet under the shared advisory lock — never auto-send
 *      onto a thread a human already answered, a staff reply is queued for, or
 *      that has a newer inbound (stale context).
 *   6. Claim-before-send — an idempotency-keyed agent_decisions row makes the
 *      FIRST inserter the sole sender; a retry/concurrent run aborts.
 *   7. Send through the SAME policy-checked provider path the inbox uses
 *      (consent, suppression, identity trust all enforced).
 *
 * Crash safety: the draft is NOT flipped off 'shadow' until the provider
 * confirms the send. A crash anywhere before that leaves a judge-safe shadow
 * draft and an inert 'sending' claim; the nightly reconcileAutoSendClaims
 * resolves a claim whose outbound did go out and fails one whose send never
 * confirmed. A blocked/failed send reverts nothing (the draft was never
 * touched) — the thread simply stays in the inbox for a human.
 *
 * PII: never log message bodies or full phone numbers from this module.
 */
const db = require('../models/db');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');
const { ASK_SPACING_MS } = require('./review-ask-history');
const {
  GRATITUDE_INTENT,
  GRATITUDE_POLICY_VERSION,
  QUIET_WINDOW_MS,
  MAX_REPLY_AGE_MS,
  gratitudeTimingReason,
} = require('./sms-gratitude');
const {
  jsonObject,
  gratitudeActivation,
  pendingGratitudeWork,
  readGratitudeContext,
  gratitudeThreadAdvanced,
  gratitudeRolloutSettled,
} = require('./sms-gratitude-context');

const AUTOSEND_WORKFLOW = 'sms_house_voice_auto_send';
const AUTOSEND_AGENT_NAME = 'House Voice Auto-Send';
const AUTOSEND_DECISION_VERSION = 'house_voice_auto_send_v1';
const AUTOSEND_MODE = 'auto_send';

// Distinct outbound message_type so an auto-sent reply is never mistaken for a
// human-authored one (it is deliberately NOT in sms-suggest-mode's
// HUMAN_REPLY_TYPES, which answers "did a HUMAN reply?").
const AUTOSEND_MESSAGE_TYPE = 'ai_autosent';

// agent_decisions.status lifecycle for a claim: claimed → sent / failed.
const CLAIM_STATUS = 'sending';
const SENT_STATUS = 'auto_sent';
const FAILED_STATUS = 'auto_send_failed';

// How long reconcileAutoSendClaims protects a claim armed
// provider_outcome_uncertain before treating it as an ordinary orphan (codex
// #4338 P1). With no Twilio SID, the sent-linked sweep above can never
// resolve it — protecting it indefinitely left the claim in CLAIM_STATUS
// forever, which also kept its reservation row alive (reservationsCleared
// below only clears once every linked decision reaches a terminal status)
// and the draft out of the normal shadow/judge flow. Bounded instead: the
// claim still holds while recent, but past this window fails like any other
// orphan — failClaim leaves the draft 'shadow', so it re-enters ordinary
// drafting rather than staying invisibly stuck.
// One source of truth with the readers' hide window (review-ask-reservation).
const {
  REPLY_RESERVATION_HOLD_HOURS: UNCERTAIN_CLAIM_HOLD_HOURS,
  preserveSoleAcceptedReplyReceipts,
} = require('./messaging/review-ask-reservation');
// message_drafts.status once the send is confirmed (out of the judge pool).
const DRAFT_SENT_STATUS = 'auto_sent';

// The ONLY intended_action type safe to send with no human. Every other type
// the drafter can emit (escalate, book_appointment, send_*_link) names a
// follow-up the executor does NOT perform — auto-sending the text alone would
// promise an action that never happens, so those drafts are routed to a human.
const SAFE_AUTO_SEND_ACTION = 'none';

// sendCustomerMessage / TwilioService.sendSMS report sent:true for upstream
// SUPPRESSION paths (feature gate off, template disabled, owner-SMS kill
// switch) where no customer SMS actually leaves — surfaced as a sentinel
// providerMessageId, not a real Twilio sid. Treating those as delivered would
// silently drop the reply AND pull the draft out of the human path, so the
// executor must read them as not-sent.
const SUPPRESSION_SENTINELS = new Set([
  'gate-blocked',
  'template-disabled',
  'owner-silence',
  'owner-sms-disabled',
  'internal-admin-notification',
  'internal-admin-notification-undelivered',
  'internal-admin-notification-error',
]);

/**
 * Did a real customer SMS actually leave? sent:true is necessary but not
 * sufficient — an upstream suppression returns sent:true with a sentinel id
 * (or none). Require a truthy, non-sentinel provider message id.
 */
function isRealProviderSend(result) {
  if (!result || result.sent !== true) return false;
  if (result.deliveryOutcome && result.deliveryOutcome !== 'accepted') return false;
  const id = result.providerMessageId;
  if (!id) return false;
  return !SUPPRESSION_SENTINELS.has(id);
}

/**
 * Does a send-once owner need to retain its claim because delivery is
 * unresolved? Canonical outcomes are authoritative. The retryable/deferred
 * fallback remains only for callers that have not reached that contract yet.
 */
/**
 * sendCustomerMessage reports sent:true for upstream SUPPRESSION paths where
 * no customer SMS actually left — the provider id is a sentinel (the
 * admin-sms-templates kill switch returns sid 'template-disabled', a closed
 * gate returns 'gate-blocked', and so on), not a provider sid. Returns that
 * sentinel id, or null for a real send. Every owner that decides what a
 * sent:true means has to make this distinction, so it lives here with
 * SUPPRESSION_SENTINELS rather than being re-derived per caller.
 */
function suppressedSendSentinel(result) {
  const id = result && result.providerMessageId;
  return id && SUPPRESSION_SENTINELS.has(id) ? id : null;
}

function isAmbiguousProviderOutcome(result) {
  if (!result) return false;
  if (result.deliveryOutcome === 'uncertain') return true;
  if (result.deliveryOutcome === 'accepted' || result.deliveryOutcome === 'not_sent') return false;
  if (result.deliveryOutcome != null) return true;
  return result.sent !== true && !result.blocked && Boolean(result.retryable || result.deferred);
}

/**
 * Pure: is this draft's action set safe to send with no human? The prompt
 * contract REQUIRES an intended_actions array, and it is the only signal that a
 * draft needs follow-up (escalate / book / link). So safe ONLY when the field
 * is a well-formed array that is empty or contains nothing but 'none'. Anything
 * else fails closed: an ABSENT field (null/undefined — a malformed response
 * that dropped the contract), a non-array payload (e.g. a raw
 * `{type:'send_payment_link'}` that would later sanitize to []), or any
 * actionable/unknown type. Tolerates {type} objects or bare strings in the
 * array.
 */
function autoSendActionsSafe(intendedActions) {
  if (!Array.isArray(intendedActions)) return false; // absent or malformed → unsafe
  if (intendedActions.length === 0) return true;
  return intendedActions.every((a) => {
    const type = typeof a === 'string' ? a : a && a.type;
    return type === SAFE_AUTO_SEND_ACTION;
  });
}

/**
 * Pure precondition ordering for an auto-send attempt — the gate/eligibility
 * decision tree with no DB, for exhaustive unit coverage. Returns the reason
 * the attempt stops, or null when every precondition is clear. maybeAutoSend
 * evaluates these same checks lazily (so the expensive eligibility query never
 * runs when the gate is off or the draft is ineligible); this is the contract
 * they share.
 */
function autoSendPreflight({ gateOn, baseEligible, mode, actionsSafe, eligible }) {
  if (!gateOn) return 'gate_off';
  if (!baseEligible) return 'ineligible_base';
  if (mode !== AUTOSEND_MODE) return 'mode_not_autosend';
  if (!actionsSafe) return 'action_required';
  if (!eligible) return 'not_eligible';
  return null;
}

/**
 * Claim a draft for auto-send under the shared thread lock, after re-running
 * the guard-gauntlet. Returns { decisionId, toPhone, fromNumber } when the
 * claim is ours, or null when the thread is guarded or another path already
 * claimed this draft. Does NOT send and does NOT touch the draft row — the
 * claim is purely the idempotency-keyed decision insert.
 */
async function claimAutoSend({ draftId, customerId, smsLogId, inboundMessage, reply, intent, confidence, model, promptVersion }) {
  const suggest = require('./sms-suggest-mode');
  return db.transaction(async (trx) => {
    // The inbound row is immutable — its phone IS the thread/lock key, and its
    // to_phone is the Waves number to reply FROM.
    const inbound = await trx('sms_log').where({ id: smsLogId }).first('created_at', 'from_phone', 'to_phone');
    if (!inbound?.created_at) return null;

    const threadLast10 = String(inbound.from_phone || '').replace(/\D/g, '').slice(-10) || null;
    const toPhone = inbound.from_phone || null; // the customer
    if (!toPhone) return null;
    // The Waves line they texted — unless it is a per-tech line: automated
    // texts never originate from one (#4053); null → the location default.
    const fromNumber = inbound.to_phone && !TWILIO_NUMBERS.isTechLine(inbound.to_phone) ? inbound.to_phone : null;

    await suggest.lockSuggestThread(trx, threadLast10 || customerId);

    if (await suggest.threadHasLiveAnswer(trx, { threadLast10, customerId, inboundCreatedAt: inbound.created_at, inboundSmsLogId: smsLogId })) {
      return null;
    }

    // Interlock against OTHER auto-sends on the thread: a second draft (e.g. a
    // rapid second inbound) must not claim while a prior auto-send is still
    // mid-provider-call — that would fire duplicate / out-of-order autonomous
    // replies. Under the same lock as the prior claim's commit, so they
    // serialize: one autonomous reply in flight per thread at a time.
    if (await hasActiveAutoSendClaim(trx, { threadLast10, customerId })) {
      return null;
    }

    const numericConfidence = Number.isFinite(Number(confidence)) ? Number(confidence) : null;
    const [row] = await trx('agent_decisions')
      .insert({
        workflow: AUTOSEND_WORKFLOW,
        agent_name: AUTOSEND_AGENT_NAME,
        decision_version: AUTOSEND_DECISION_VERSION,
        mode: AUTOSEND_MODE,
        status: CLAIM_STATUS,
        entity_type: 'message_draft',
        entity_id: draftId,
        customer_id: customerId,
        source_channel: 'sms',
        sms_log_id: smsLogId,
        detected_intent: intent || 'GENERAL',
        confidence: numericConfidence,
        confidence_label: numericConfidence === null
          ? null
          : numericConfidence >= 0.85 ? 'high' : numericConfidence >= 0.6 ? 'medium' : 'low',
        input_snapshot: JSON.stringify({ sms: { body: inboundMessage }, draft_id: draftId }),
        suggested_message: reply,
        reasoning_summary: 'House-voice reply auto-sent by the brand-voice loop executor (Phase E).',
        model: model || null,
        prompt_version: promptVersion || null,
        // Scope idempotency to the INBOUND, not the draft: message_drafts are
        // not unique per sms_log_id, so the same inbound can be drafted twice
        // (webhook retry, backfill overlap). Keying on draftId would let the
        // second draft auto-send a duplicate after the first resolved. One
        // autonomous reply per inbound, period.
        idempotency_key: `${AUTOSEND_WORKFLOW}:inbound:${smsLogId}`,
      })
      .onConflict('idempotency_key')
      .ignore()
      .returning('id');
    if (!row?.id) return null;

    // Park every OTHER pending house-voice suggestion on this thread, exactly
    // as the manual/scheduled send paths do: an autonomous reply answers the
    // thread, so a stale Agent Review card must not stay clickable and send a
    // second, out-of-context reply. Same lock → atomic with the claim. The ids
    // are carried into the send metadata below, so the EXISTING suggestion
    // recovery sweep reconciles them on a crash (ignored behind the sent row,
    // reopened if the send never lands) — no auto-send-specific recovery needed
    // for the parked rows.
    const parkedIds = threadLast10
      ? await suggest.parkThreadSuggestions({ phoneLast10: threadLast10 }, trx)
      : [];

    // Persist the linkage in the SAME transaction as the claim and parks. If
    // this insert fails, the transaction rolls back and no provider handoff is
    // allowed. It starts as an ordinary in-flight marker; the executor arms it
    // as uncertain immediately before entering the provider pipeline.
    const reservationId = await suggest.createReplyHoldingReservation(trx, {
      to: toPhone,
      customerId,
      fromNumber: fromNumber || TWILIO_NUMBERS.getOutboundNumber(),
      body: reply,
      agentDecisionId: row.id,
      parkedDecisionIds: parkedIds,
      reservationKind: 'auto',
    });
    if (!reservationId) throw new Error('Auto-send holding reservation was not created');

    return { decisionId: row.id, toPhone, fromNumber, threadLast10, parkedIds, reservationId };
  });
}

/**
 * Gratitude claim variant. It shares the ordinary thread/advisory lock and
 * send-once decision key, but never parks or resolves another suggestion.
 * Any open request/card is a reason to abstain because a courtesy closer must
 * not conceal operational work.
 */
async function claimGratitudeSend({ draftId, smsLogId, confidence, now = new Date() }) {
  // Process-local, so it needs no lock: see GRATITUDE_ROLLOUT_SETTLE_MS.
  if (!gratitudeRolloutSettled()) return null;
  const suggest = require('./sms-suggest-mode');
  return db.transaction(async (trx) => {
    const anchor = await trx('sms_log').where({ id: smsLogId, direction: 'inbound' })
      .first('from_phone');
    const threadLast10 = String(anchor?.from_phone || '').replace(/\D/g, '').slice(-10);
    if (!threadLast10) return null;
    await suggest.lockSuggestThread(trx, threadLast10);

    // Gate, epoch, timing, immutable rows, live customer, exact endpoints,
    // complete context and fixed reply are all re-read inside the lock.
    if (!isEnabled('smsGratitudeReplies')) return null;
    const checked = await readGratitudeContext({ draftId, smsLogId, now, activatedAt: gratitudeActivation(), dbh: trx, expectedPromptVersion: require('./sms-shadow-drafter').PROMPT_VERSION });
    if (!checked.ok) return null;
    const { inbound, customer, draft, expectedReply } = checked;
    const modeRow = await trx('sms_intent_modes').where({ intent: GRATITUDE_INTENT }).first('mode');
    if (modeRow?.mode !== AUTOSEND_MODE) return null;

    if (await suggest.threadHasLiveAnswer(trx, {
      threadLast10,
      customerId: customer.id,
      inboundCreatedAt: inbound.created_at,
      inboundSmsLogId: inbound.id,
    })) return null;
    if (await hasActiveAutoSendClaim(trx, { threadLast10, customerId: customer.id })) return null;

    const numericConfidence = Number.isFinite(Number(confidence)) ? Number(confidence) : null;
    const [row] = await trx('agent_decisions')
      .insert({
        workflow: AUTOSEND_WORKFLOW,
        agent_name: AUTOSEND_AGENT_NAME,
        decision_version: AUTOSEND_DECISION_VERSION,
        mode: AUTOSEND_MODE,
        status: CLAIM_STATUS,
        entity_type: 'message_draft',
        entity_id: draft.id,
        customer_id: customer.id,
        source_channel: 'sms',
        sms_log_id: inbound.id,
        detected_intent: GRATITUDE_INTENT,
        confidence: numericConfidence,
        confidence_label: numericConfidence === null
          ? null
          : numericConfidence >= 0.85 ? 'high' : numericConfidence >= 0.6 ? 'medium' : 'low',
        input_snapshot: JSON.stringify({ sms: { body: inbound.message_body }, draft_id: draft.id }),
        suggested_message: expectedReply,
        reasoning_summary: 'Delayed gratitude-only reply auto-sent after live thread revalidation.',
        model: draft.model,
        prompt_version: draft.prompt_version,
        idempotency_key: `${AUTOSEND_WORKFLOW}:inbound:${inbound.id}`,
      })
      .onConflict('idempotency_key')
      .ignore()
      .returning('id');
    if (!row?.id) return null;

    const fromNumber = inbound.to_phone && !TWILIO_NUMBERS.isTechLine(inbound.to_phone)
      ? inbound.to_phone : null;
    const reservationId = await suggest.createReplyHoldingReservation(trx, {
      to: inbound.from_phone,
      customerId: customer.id,
      fromNumber: fromNumber || TWILIO_NUMBERS.getOutboundNumber(),
      body: expectedReply,
      agentDecisionId: row.id,
      parkedDecisionIds: [],
      reservationKind: 'auto',
    });
    if (!reservationId) throw new Error('Gratitude auto-send holding reservation was not created');
    return {
      decisionId: row.id,
      toPhone: inbound.from_phone,
      fromNumber,
      customerId: customer.id,
      reply: expectedReply,
      inboundCreatedAt: inbound.created_at,
      inboundId: inbound.id,
      inboundFromPhone: inbound.from_phone,
      inboundToPhone: inbound.to_phone,
      threadKey: checked.threadKey,
      threadLast10,
      parkedIds: [],
      reservationId,
    };
  });
}

/** Mark a confirmed send: resolve the claim and take the draft out of the judge pool. */
async function resolveSent({ decisionId, draftId, providerMessageId }) {
  return db.transaction(async (trx) => {
    const resolved = await trx('agent_decisions')
      .where({ id: decisionId, status: CLAIM_STATUS })
      .update({
        status: SENT_STATUS,
        human_verdict: null, // no human reviewed it — that is the whole point
        reviewed_by: 'auto',
        reviewed_at: new Date(),
        correction_note: providerMessageId
          ? `Auto-sent by the house-voice executor (Phase E). Provider message ${providerMessageId}.`
          : 'Auto-sent by the house-voice executor (Phase E).',
        updated_at: new Date(),
      });
    if (!resolved) return false;
    // Guarded on 'shadow' so a racing path can't double-flip; the outbound IS
    // the draft text now, so it must leave the shadow judge pool.
    await trx('message_drafts').where({ id: draftId, status: 'shadow' }).update({ status: DRAFT_SENT_STATUS });
    return true;
  });
}

// How long an ordinary auto-send claim counts as "in flight" for cross-path
// reservation checks. A provider-uncertain reservation extends that fence for
// the shared bounded reconciliation window below.
const ACTIVE_CLAIM_MINUTES = 5;

/**
 * Is an auto-send mid-flight to this thread right now? A claim sits in
 * 'sending' only for the provider window (then resolves to auto_sent /
 * auto_send_failed). The manual/scheduled send paths call this UNDER the shared
 * thread lock before dispatching, so an autonomous reply and a human reply
 * can't both reach the customer in the same window: whichever takes the lock
 * first commits its claim/park, the other sees it and backs off. An ordinary
 * claim is scoped to RECENT activity so an orphan cannot block indefinitely;
 * an explicitly provider-uncertain auto reservation stays active for the same
 * bounded 24-hour window reconciliation protects. Promoted/terminal receipts
 * are not in-flight fences. Thread scope = customer phone (last 10), with a
 * customer_id fallback.
 */
async function hasActiveAutoSendClaim(dbh, { threadLast10, customerId, recentMinutes = ACTIVE_CLAIM_MINUTES } = {}) {
  if (!threadLast10 && !customerId) return false;
  const cutoff = new Date(Date.now() - recentMinutes * 60 * 1000);
  const uncertainCutoff = new Date(Date.now() - UNCERTAIN_CLAIM_HOLD_HOURS * 60 * 60 * 1000);
  const q = dbh('agent_decisions as ad')
    .where({ 'ad.workflow': AUTOSEND_WORKFLOW, 'ad.status': CLAIM_STATUS })
    .where(function recentOrProviderUncertain() {
      this.where('ad.updated_at', '>', cutoff)
        .orWhereExists(function linkedUncertainReservation() {
          this.select(dbh.raw('1'))
            .from('sms_log as reservation')
            .where({ 'reservation.direction': 'outbound', 'reservation.status': 'sending' })
            .whereRaw("reservation.metadata->>'auto_send_reservation' = 'true'")
            .whereRaw("reservation.metadata->>'provider_outcome_uncertain' = 'true'")
            .where('reservation.updated_at', '>=', uncertainCutoff)
            .whereRaw("reservation.metadata->>'agent_decision_id' = ad.id::text");
        });
    });
  if (threadLast10) {
    q.leftJoin('sms_log as s', 'ad.sms_log_id', 's.id')
      .whereRaw("RIGHT(REGEXP_REPLACE(COALESCE(s.from_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [threadLast10]);
  } else {
    q.where('ad.customer_id', customerId);
  }
  return Boolean(await q.first('ad.id'));
}

/** Mark a claim whose send was blocked/failed/errored. The draft stays 'shadow'. */
async function failClaim(decisionId, reason) {
  try {
    await db('agent_decisions')
      .where({ id: decisionId, status: CLAIM_STATUS })
      .update({
        status: FAILED_STATUS,
        correction_note: `Auto-send did not go out: ${String(reason || 'unknown').slice(0, 280)}`,
        updated_at: new Date(),
      });
  } catch (err) {
    logger.warn(`[sms-auto-send] failClaim errored (decision ${decisionId}): ${err.message}`);
  }
}

/**
 * Attempt to auto-send a freshly verified house-voice draft. Called by the
 * shadow drafter ONLY when its delivery mode resolved to 'auto_send' and the
 * verify loop converged — but this function re-checks everything itself.
 * Returns { sent, reason?, decisionId?, providerMessageId? }. Never throws:
 * a shadow/auto-send miss must never affect the inbound webhook path.
 */
async function maybeAutoSend(params = {}) {
  const gratitudeLane = params.intent === GRATITUDE_INTENT;
  try {
    const ready = await autoSendReadiness(params, gratitudeLane);
    if (ready.reason) return { sent: false, reason: ready.reason };

    // (5)+(6) Claim under the lock + guard-gauntlet. The ordinary lane parks
    // sibling cards; gratitude refuses them and leaves them untouched.
    const claim = gratitudeLane
      ? await claimGratitudeSend({ draftId: params.draftId, smsLogId: params.smsLogId, confidence: params.confidence })
      : await claimAutoSend({ ...params, customerId: ready.customerId });
    if (!claim) return { sent: false, reason: 'guarded_or_claimed' };
    return await dispatchClaimedSend({
      claim,
      gratitudeLane,
      eligibilityPin: { voiceProfileVersion: ready.voiceProfileVersion, sourceDigest: params.gratitudeSourceDigest },
      draftId: params.draftId,
      intent: params.intent,
      reply: gratitudeLane ? claim.reply : params.reply,
      customerId: gratitudeLane ? claim.customerId : ready.customerId,
    });
  } catch (err) {
    logger.error(`[sms-auto-send] unexpected failure (draft ${params.draftId}): ${err.message}`);
    return { sent: false, reason: 'error' };
  }
}

/**
 * Steps (1)–(4) for one draft, cheapest first so the eligibility query never
 * runs for a draft that is already refused. Returns { reason } on refusal,
 * otherwise { customerId } — for gratitude, the reloaded durable customer.
 */
async function autoSendReadiness(params, gratitudeLane) {
  const {
    customer, smsLogId, reply, intent, intendedActions = null,
    actionsVerifiedSafe = false, schedulingIntent = false,
  } = params;
  // (1) Gate.
  if (!isEnabled(gratitudeLane ? 'smsGratitudeReplies' : 'smsAutoSend')) return { reason: 'gate_off' };

  const suggest = require('./sms-suggest-mode');
  const callerCustomerId = customer?.id || null;
  // (2) Base eligibility (same hard rules as a suggestion).
  if (!suggest.suggestionEligible({ reply, customerId: callerCustomerId, smsLogId, intent, schedulingIntent })) {
    return { reason: 'ineligible_base' };
  }
  const caller = gratitudeLane
    ? await reloadGratitudeCaller(params)
    : { customerId: callerCustomerId };
  if (caller.reason) return caller;

  // (3) Intent must actually be flipped to auto_send.
  if (await suggest.getIntentMode(intent) !== AUTOSEND_MODE) return { reason: 'mode_not_autosend' };

  // (3.5) A draft whose safety contract records a follow-up action
  //       (escalate / book / send a link) must reach a HUMAN — auto-sending
  //       the text alone would promise something the executor never does.
  //       Two layers: (a) actionsVerifiedSafe is the parser's RAW-output flag
  //       (the only place unknown/dropped action types are visible — defaults
  //       false, so a caller that omits it fails closed); (b) the executor
  //       independently re-checks the sanitized list. Both must hold.
  if (actionsVerifiedSafe !== true || !autoSendActionsSafe(intendedActions)) return { reason: 'action_required' };

  // (3.6) Defense in depth at the autonomy boundary: never send a reply that
  //       carries a redaction placeholder ([name], [phone], …) copied from a
  //       few-shot exemplar. Deterministic, independent of the LLM verifier.
  if (suggest.hasRedactionPlaceholder(reply)) {
    logger.warn(`[sms-auto-send] reply carries a redaction placeholder — refusing auto-send (intent=${intent})`);
    return { reason: 'redaction_placeholder' };
  }

  const profile = await pinDraftVoiceProfile(params);
  if (profile.reason) return profile;

  // (3.7) Amount-bearing drafts never AUTO-send. Owner ruling 2026-07-30
  //       allows real amounts in texts, and the suggest lane now delivers
  //       them (a human reviews before send) — but at the autonomy
  //       boundary a wrong figure sent with nobody looking is the
  //       worst-case failure, so this lane stays refused until an explicit
  //       owner call relaxes it. Deterministic, independent of the LLM
  //       verifier.
  if (suggest.hasPriceQuote(reply)) {
    logger.warn(`[sms-auto-send] reply quotes a price — refusing auto-send (intent=${intent})`);
    return { reason: 'price_quote' };
  }

  // (4) Server-enforced graduation eligibility — re-checked live every send.
  const elig = await require('./sms-graduation').evaluateAutoSendEligibility({
    intent,
    voiceProfileVersion: profile.version,
    gratitudeSourceDigest: params.gratitudeSourceDigest,
  });
  if (!elig.eligible) {
    logger.info(`[sms-auto-send] intent=${intent} not eligible; blockers: ${(elig.blockers || []).join(' | ')}`);
    return { reason: 'not_eligible' };
  }
  return { customerId: caller.customerId, voiceProfileVersion: profile.version };
}

/**
 * Gratitude never trusts the drafter call's copies of source/customer/text.
 * Reload the durable rows now; the claim repeats the same read under the lock
 * immediately before provider entry.
 */
async function reloadGratitudeCaller({
  draftId, smsLogId, customer, inboundMessage, reply, model = null, promptVersion = null,
}) {
  const context = await readGratitudeContext({ draftId, smsLogId, dbh: db, expectedPromptVersion: require('./sms-shadow-drafter').PROMPT_VERSION });
  if (!context.ok) return { reason: context.reason };
  const matches = (customer?.id || null) === context.customer.id
    && inboundMessage === context.inbound.message_body
    && reply === context.expectedReply
    && model === context.draft.model
    && promptVersion === context.draft.prompt_version;
  return matches ? { customerId: context.customer.id } : { reason: 'caller_draft_mismatch' };
}

/**
 * (3.65) Voice-profile pin at the autonomy boundary (Codex r4): the readiness
 * evidence the eligibility check consults belongs to the CURRENTLY effective
 * profile, but THIS draft may have been shaped by a different one — the
 * drafting-path fetch fails safe to the base prompt, and an approval can land
 * mid-generation. Resolve the effective profile ONCE (fail closed on error),
 * require the draft's stamp to match it, and hand the SAME pin to the
 * eligibility queries so gate and evidence can never disagree.
 */
async function pinDraftVoiceProfile({ intent, voiceProfileVersion = null }) {
  let effective;
  try {
    effective = (await require('./sms-shadow-drafter').resolveEffectiveVoiceProfile())?.version ?? null;
  } catch (err) {
    logger.warn(`[sms-auto-send] voice-profile resolution failed (${err.message}) — refusing auto-send (intent=${intent})`);
    return { reason: 'voice_profile_unresolved' };
  }
  if (voiceProfileVersion !== effective) {
    logger.warn(`[sms-auto-send] draft profile (${voiceProfileVersion ?? 'none'}) != effective profile (${effective ?? 'none'}) — refusing auto-send (intent=${intent})`);
    return { reason: 'voice_profile_mismatch' };
  }
  return { version: effective };
}

/**
 * Gratitude's provider-boundary predicate. Run after Twilio's final awaited
 * guard, using its held connection when present, so earlier provider
 * preparation cannot stale this read. Everything readiness decided from
 * shared state (gate, intent mode, qualification under the pinned voice
 * profile and source digest) is decided again here, not a subset.
 */
function gratitudeHandoffCheck(claim, eligibilityPin = {}) {
  return async ({ dbi = db } = {}) => {
    // Shared readiness first; the mutable thread reads are the LAST awaits
    // before provider entry, because inbound webhooks do not take the lock.
    const modeRow = await dbi('sms_intent_modes').where({ intent: GRATITUDE_INTENT }).first('mode');
    const elig = await require('./sms-graduation').evaluateAutoSendEligibility({
      intent: GRATITUDE_INTENT,
      dbi,
      voiceProfileVersion: eligibilityPin.voiceProfileVersion ?? null,
      gratitudeSourceDigest: eligibilityPin.sourceDigest,
    });
    const pendingWork = await pendingGratitudeWork(dbi, {
      customerId: claim.customerId,
      threadKey: claim.threadKey,
      excludeDecisionId: claim.decisionId,
    });
    const advanced = await gratitudeThreadAdvanced(dbi, {
      inboundId: claim.inboundId,
      fromPhone: claim.inboundFromPhone,
      toPhone: claim.inboundToPhone,
      skipReservationId: claim.reservationId,
    });
    const timing = gratitudeTimingReason({
      inboundCreatedAt: claim.inboundCreatedAt,
      now: new Date(),
      activatedAt: gratitudeActivation(),
    });
    const reason = pendingWork ? 'pending_work'
      : advanced ? 'thread_advanced'
      : timing || (!isEnabled('smsGratitudeReplies') ? 'gate_off' : null)
        || (modeRow?.mode !== AUTOSEND_MODE ? 'mode_not_autosend' : null)
        || (elig?.eligible !== true ? 'not_eligible' : null);
    return reason ? { ok: false, code: reason, reason } : { ok: true };
  };
}

/** The lane-specific sendCustomerMessage input for a claimed reply. */
function autoSendMessage({ claim, gratitudeLane, reply, customerId, checkHandoff }) {
  const parkedIds = claim.parkedIds || [];
  const laneFields = gratitudeLane ? {
    providerPreSendCheck: checkHandoff,
    // Generic sends publish their holding row under this same lock.
    // Keep it through the final checks and SDK call so publication
    // cannot slip between a clear-thread verdict and the handoff.
    withSmsHandoff: dispatch => db.transaction(async (trx) => {
      await require('./sms-suggest-mode').lockSuggestThread(trx, claim.threadLast10);
      await dispatch(trx);
      return { ok: true };
    }),
    providerHandoffReservation: null,
  } : {
    providerHandoffReservation: require('./messaging/provider-handoff-reservation')
      .borrowProviderHandoffReservation({
        reservationId: claim.reservationId,
        to: claim.toPhone,
        fromNumber: claim.fromNumber || TWILIO_NUMBERS.getOutboundNumber(),
        body: reply,
        messageType: AUTOSEND_MESSAGE_TYPE,
      }),
  };
  return {
    to: claim.toPhone,
    body: reply,
    channel: 'sms',
    audience: 'customer',
    purpose: 'conversational',
    customerId,
    identityTrustLevel: 'phone_matches_customer',
    entryPoint: 'sms_auto_send_executor',
    ...laneFields,
    // Send-window inbound-reply provenance: the auto-send executor only
    // dispatches green-judged replies to a message the customer just
    // texted into an active thread — the send class the window
    // deliberately never defers.
    conversationalContext: true,
    metadata: {
      original_message_type: gratitudeLane ? 'ai_gratitude' : AUTOSEND_MESSAGE_TYPE,
      ...(gratitudeLane ? { gratitude_policy_version: GRATITUDE_POLICY_VERSION } : {}),
      agentDecisionId: claim.decisionId,
      parkedDecisionIds: parkedIds.length ? parkedIds : undefined,
      fromNumber: claim.fromNumber || undefined,
    },
  };
}

/**
 * (7) Send a claimed reply via the policy-checked provider path (consent,
 * suppression, identity trust all enforced upstream) and settle the claim.
 * A blocked/failed/errored send means the customer was NOT answered — the
 * parked sibling cards must come back. A confirmed send means the thread WAS
 * answered autonomously — they resolve as ignored (drafts return to the
 * judge), exactly like the manual send's post-send sweep.
 */
async function dispatchClaimedSend({ claim, gratitudeLane, eligibilityPin, draftId, intent, reply, customerId }) {
  const suggest = require('./sms-suggest-mode');
  const parkedIds = claim.parkedIds || [];
  const reopenParked = async (reason) => {
    if (parkedIds.length) await suggest.reopenScheduledSuggestions({ decisionIds: parkedIds, reason });
  };
  const notSent = async (reason, settleReason = reason) => {
    await suggest.settleReplyHoldingReservation({ reservationId: claim.reservationId });
    await failClaim(claim.decisionId, settleReason);
    return { sent: false, reason };
  };

  // Arm before provider entry. A timeout followed by a DB outage still has
  // durable uncertainty evidence; if this write misses, fail closed before
  // any customer communication.
  if (!await suggest.settleReplyHoldingReservation({ reservationId: claim.reservationId, uncertain: true })) {
    await failClaim(claim.decisionId, 'could not arm provider-outcome reservation');
    await reopenParked('Auto-send reservation failed before delivery — suggestion reopened.');
    return { sent: false, reason: 'reservation_failed' };
  }
  const checkHandoff = gratitudeLane ? gratitudeHandoffCheck(claim, eligibilityPin) : undefined;
  let result;
  try {
    const verdict = checkHandoff ? await checkHandoff() : { ok: true };
    if (!verdict.ok) return await notSent(verdict.reason);
    const { sendCustomerMessage } = require('./messaging/send-customer-message');
    result = await sendCustomerMessage(autoSendMessage({ claim, gratitudeLane, reply, customerId, checkHandoff }));
  } catch (err) {
    if (!isRealProviderSend(err?.providerOutcome) && !isAmbiguousProviderOutcome(err?.providerOutcome)) {
      const outcome = await notSent('send_error', `send threw: ${err.message}`);
      await reopenParked('Auto-send errored before delivery — suggestion reopened.');
      logger.warn(`[sms-auto-send] send threw (decision ${claim.decisionId}): ${err.message}`);
      return outcome;
    }
    result = err.providerOutcome;
  }
  return settleAutoSendOutcome({ claim, result, draftId, intent, customerId, reopenParked });
}

/** Settle a claim from the provider's verdict on a reply that reached it. */
async function settleAutoSendOutcome({ claim, result, draftId, intent, customerId, reopenParked }) {
  // sent:true is not enough — an upstream suppression (gate off, template
  // disabled, owner kill switch) reports sent with a sentinel id but nothing
  // reached the customer. Only a real provider message finalizes the draft.
  if (isRealProviderSend(result)) {
    await recordAcceptedAutoSend({ claim, draftId, providerMessageId: result.providerMessageId, acceptedResult: result });
    logger.info(`[sms-auto-send] SENT customer=${customerId || 'unknown'} intent=${intent} decision=${claim.decisionId} sid=${result.providerMessageId || 'n/a'}`);
    return { sent: true, decisionId: claim.decisionId, providerMessageId: result.providerMessageId || null };
  }

  if (isAmbiguousProviderOutcome(result)) {
    logger.warn(`[sms-auto-send] provider outcome uncertain (decision ${claim.decisionId}) — claim retained for reconciliation`);
    return { sent: false, reason: 'provider_uncertain', ambiguous: true, decisionId: claim.decisionId };
  }

  const notSentReason = result?.sent ? `suppressed:${result.providerMessageId || 'unknown'}` : (result?.code || 'not_sent');
  await require('./sms-suggest-mode').settleReplyHoldingReservation({ reservationId: claim.reservationId });
  await failClaim(claim.decisionId, result?.reason || notSentReason);
  await reopenParked('Auto-send did not go out — suggestion reopened.');
  logger.info(`[sms-auto-send] NOT sent customer=${customerId || 'unknown'} intent=${intent} reason=${notSentReason}`);
  return { sent: false, reason: notSentReason };
}

/**
 * The customer HAS been texted. Post-send bookkeeping must never flip this
 * back to sent:false — that would let the drafter republish the
 * already-delivered draft as a suggestion (a duplicate reply). If the
 * bookkeeping update throws, the claim stays 'sending' with a sent sms_log row
 * and reconcileAutoSendClaims settles it (resolve + flip).
 */
async function recordAcceptedAutoSend({ claim, draftId, providerMessageId, acceptedResult }) {
  const suggest = require('./sms-suggest-mode');
  const parkedIds = claim.parkedIds || [];
  try {
    // The reservation itself becomes accepted evidence before any later
    // bookkeeping. If Twilio's sms_log insert and these writes both fail,
    // recovery still has one durable sent row linking used + parked ids.
    if (!await suggest.settleReplyHoldingReservation({ reservationId: claim.reservationId, acceptedResult })) {
      throw new Error('accepted reservation was not promoted');
    }
    if (!await resolveSent({ decisionId: claim.decisionId, draftId, providerMessageId })) {
      throw new Error('auto-send claim was not resolved');
    }
    if (parkedIds.length) {
      const ignored = await suggest.ignoreParkedSuggestions({ decisionIds: parkedIds, reviewedBy: 'auto' });
      if (ignored !== parkedIds.length) throw new Error('parked suggestions were not fully resolved');
    }
    await suggest.settleReplyHoldingReservation({ reservationId: claim.reservationId });
  } catch (bookErr) {
    logger.warn(`[sms-auto-send] post-send bookkeeping failed (decision ${claim.decisionId}); reconcile sweep will settle: ${bookErr.message}`);
  }
}

// Refusals that apply to every gratitude candidate alike, so the rest of the
// sweep would only repeat them.
const SWEEP_WIDE_REFUSALS = new Set(['gate_off', 'mode_not_autosend', 'not_eligible', 'voice_profile_unresolved']);
const SWEEP_PAGE_SIZE = 100;

/**
 * One page of due gratitude drafts after the (inbound time, inbound id)
 * cursor. The inbound clock owns both eligibility and the ten-minute
 * deadline, so pages run oldest thread first; for duplicate drafts on one
 * inbound, the latest generated copy leads and id makes an exact timestamp
 * tie stable. Inbounds that already hold the send-once decision key can
 * never be claimed again and are excluded.
 */
function gratitudeCandidatePage({ activatedAt, now, cursor, pageSize }) {
  const q = db('message_drafts as md')
    .join('sms_log as s', 'md.sms_log_id', 's.id')
    .where({
      'md.status': 'shadow',
      'md.intent': GRATITUDE_INTENT,
      'md.prompt_version': require('./sms-shadow-drafter').PROMPT_VERSION,
      's.direction': 'inbound',
    })
    .whereNotNull('md.model')
    .where('s.created_at', '>', activatedAt)
    .where('s.created_at', '>=', new Date(now.getTime() - MAX_REPLY_AGE_MS))
    .where('s.created_at', '<=', new Date(now.getTime() - QUIET_WINDOW_MS))
    // A draft is written after its inbound, so the same floor bounds the
    // draft side too (served by the message_drafts created_at index).
    .where('md.created_at', '>=', new Date(now.getTime() - MAX_REPLY_AGE_MS))
    .whereRaw("md.intended_actions::jsonb->'gratitude'->>'source' = 'live_webhook'")
    .whereRaw("md.intended_actions::jsonb->'gratitude'->>'policy_version' = ?", [GRATITUDE_POLICY_VERSION])
    .whereRaw("md.intended_actions::jsonb->'gratitude'->>'actions_verified_safe' = 'true'")
    .whereRaw("md.intended_actions::jsonb->'gratitude'->>'verifier_enabled' = 'true'")
    .whereRaw("md.intended_actions::jsonb->'verify'->>'converged' = 'true'")
    .whereNotExists(function alreadyClaimed() {
      this.select(db.raw('1'))
        .from('agent_decisions as prior')
        .whereRaw('prior.idempotency_key = ? || s.id::text', [`${AUTOSEND_WORKFLOW}:inbound:`]);
    });
  // The cursor re-reads its own timestamp: a JS Date would drop PostgreSQL's
  // microseconds and re-match the cursor row.
  if (cursor) {
    q.whereRaw('(s.created_at, s.id) > ((SELECT created_at FROM sms_log WHERE id = ?), ?)', [cursor, cursor]);
  }
  return q
    .orderBy('s.created_at', 'asc')
    .orderBy('s.id', 'asc')
    .orderBy('md.created_at', 'desc')
    .orderBy('md.id', 'asc')
    .limit(pageSize)
    .select(
      'md.id', 'md.sms_log_id', 'md.customer_id', 'md.inbound_message', 'md.draft_response',
      'md.intent', 'md.intent_confidence', 'md.model', 'md.prompt_version',
      'md.intended_actions', 'md.scheduling_intent'
    );
}

/** Hand one scanned draft to the fully revalidating executor. */
function attemptGratitudeCandidate(row, metadata, gratitudeSourceDigest) {
  return maybeAutoSend({
    draftId: row.id,
    customer: { id: row.customer_id },
    smsLogId: row.sms_log_id,
    inboundMessage: row.inbound_message,
    reply: row.draft_response,
    intent: row.intent,
    intendedActions: metadata.actions,
    actionsVerifiedSafe: true,
    confidence: row.intent_confidence,
    model: row.model,
    promptVersion: row.prompt_version,
    schedulingIntent: row.scheduling_intent === true,
    voiceProfileVersion: metadata.voice_profile_version ?? null,
    gratitudeSourceDigest,
  });
}

/**
 * Use a scheduler tick as delay storage: scan recent live-webhook gratitude
 * shadow drafts and hand each inbound's latest draft to the same fully
 * revalidating executor. No queue state is created here.
 *
 * Nothing can starve a candidate: the sweep pages through the WHOLE eligible
 * window (the eight-minute window is the bound), each inbound is evaluated at
 * most once per sweep, and claims are one-shot per inbound. It stops early
 * only on a refusal that applies to every candidate.
 */
async function processGratitudeAutoSendCandidates({ now = new Date(), pageSize = SWEEP_PAGE_SIZE } = {}) {
  if (!isEnabled('smsGratitudeReplies')) return { scanned: 0, attempted: 0, sent: 0, reason: 'gate_off' };
  const activatedAt = gratitudeActivation();
  if (!activatedAt || activatedAt.getTime() > now.getTime()) {
    return { scanned: 0, attempted: 0, sent: 0, reason: 'activation_unset' };
  }
  if (!gratitudeRolloutSettled()) return { scanned: 0, attempted: 0, sent: 0, reason: 'rollout_settling' };
  const totals = { scanned: 0, attempted: 0, sent: 0 };
  const seenInbounds = new Set();
  let gratitudeSourceDigest = null;
  let cursor = null;
  for (;;) {
    const rows = await gratitudeCandidatePage({ activatedAt, now, cursor, pageSize });
    totals.scanned += rows.length;
    for (const row of rows) {
      if (seenInbounds.has(row.sms_log_id)) continue;
      seenInbounds.add(row.sms_log_id);
      const metadata = jsonObject(row.intended_actions);
      // Shape/provenance filtering above is only a cheap scan optimization. The
      // executor reloads the name and checks the exact persisted reply.
      if (!metadata || !Array.isArray(metadata.actions)) continue;
      // Deployed sources cannot change within one sweep: hash them once.
      gratitudeSourceDigest = gratitudeSourceDigest || require('./sms-gratitude-qualification').sourceSha256();
      totals.attempted += 1;
      const result = await attemptGratitudeCandidate(row, metadata, gratitudeSourceDigest);
      if (result.sent) totals.sent += 1;
      if (SWEEP_WIDE_REFUSALS.has(result.reason)) return totals;
    }
    if (rows.length < pageSize) return totals;
    cursor = rows[rows.length - 1].sms_log_id;
  }
}

/**
 * Nightly crash-recovery for auto-send claims stuck in 'sending'. Idempotent
 * and guarded, so racing a live attempt double-resolves to the same verdict.
 *   (a) a claim whose outbound already went out (crash between send and
 *       resolve) → resolve it and flip the draft (the customer WAS texted);
 *   (b) a claim older than orphanMinutes with no live/sent outbound and no
 *       explicit uncertainty reservation younger than uncertainReconciliationHours
 *       → fail it (the draft stays shadow, re-entering ordinary drafting).
 */
async function reconcileAutoSendClaims({ orphanMinutes = 30, uncertainReconciliationHours = UNCERTAIN_CLAIM_HOLD_HOURS } = {}) {
  const cutoff = new Date(Date.now() - orphanMinutes * 60 * 1000);
  const uncertainCutoff = new Date(Date.now() - uncertainReconciliationHours * 60 * 60 * 1000);
  let resolved = 0;
  let failed = 0;

  try {
    const sentLinked = await db('agent_decisions as ad')
      .joinRaw("JOIN sms_log sl ON sl.metadata->>'agent_decision_id' = ad.id::text AND sl.status IN ('queued','sent','delivered')")
      .where({ 'ad.workflow': AUTOSEND_WORKFLOW, 'ad.status': CLAIM_STATUS })
      .distinct('ad.id', 'ad.entity_id');
    for (const row of sentLinked) {
      await resolveSent({ decisionId: row.id, draftId: row.entity_id, providerMessageId: null });
      resolved += 1;
    }
  } catch (err) {
    logger.warn(`[sms-auto-send] sent-linked reconcile failed: ${err.message}`);
  }

  try {
    failed = await db('agent_decisions')
      .where({ workflow: AUTOSEND_WORKFLOW, status: CLAIM_STATUS })
      .where('updated_at', '<', cutoff)
      .whereRaw(`NOT EXISTS (
        SELECT 1 FROM sms_log sl
        WHERE sl.status IN ('queued','sent','delivered','scheduled','sending')
          AND sl.metadata->>'agent_decision_id' = agent_decisions.id::text
          AND (
            sl.metadata->>'auto_send_reservation' IS DISTINCT FROM 'true'
            OR sl.created_at >= ?
            OR (sl.metadata->>'provider_outcome_uncertain' = 'true' AND sl.updated_at >= ?)
            OR sl.status IN ('queued','sent','delivered')
          )
      )`, [cutoff, uncertainCutoff])
      .update({
        status: FAILED_STATUS,
        correction_note: 'Auto-send claim never confirmed a provider send — reconciled by the recovery sweep.',
        updated_at: new Date(),
      });
  } catch (err) {
    logger.warn(`[sms-auto-send] orphan reconcile failed: ${err.message}`);
  }

  // Sweep settled reply reservations. Linked decisions in a holding state make
  // the marker live: they may represent a provider outcome that still needs
  // reconciliation, so age alone can never release them. Once sent evidence or
  // an operator verdict settles every linked decision, the marker is removable.
  let reservationsCleared = 0;
  try {
    reservationsCleared = await db('sms_log')
      .where({ direction: 'outbound' })
      .whereIn('status', ['sending', 'sent', 'delivered', 'failed', 'undelivered', 'canceled'])
      .where(function replyReservation() {
        this.whereRaw("metadata->>'manual_send_reservation' = 'true'")
          .orWhereRaw("metadata->>'auto_send_reservation' = 'true'")
          .orWhereRaw("metadata->>'provider_handoff_reservation' = 'true'");
      })
      .whereRaw("COALESCE(metadata->>'review_ask_reservation', 'false') != 'true'")
      .where('created_at', '<', cutoff)
      // Wrapper-managed no-card sends have no linked decision to keep their
      // uncertain reservation alive. Preserve that narrow marker for the
      // same bounded 24-hour window the retry interlock observes.
      .whereRaw(`NOT (
        status = 'sending'
        AND COALESCE(metadata->>'provider_outcome_uncertain', 'false') = 'true'
        AND (COALESCE(metadata->>'manual_wrapper_reservation', 'false') = 'true'
          OR COALESCE(metadata->>'provider_handoff_reservation', 'false') = 'true')
        AND created_at >= ?
      )`, [uncertainCutoff])
      .where(function settledOrOrdinaryReservation() {
        this.whereRaw("metadata->>'provider_outcome_uncertain' IS DISTINCT FROM 'true'")
          .orWhereNotExists(function liveLinkedDecision() {
            this.select(db.raw('1'))
              .from('agent_decisions as held')
              .whereIn('held.status', ['scheduled', CLAIM_STATUS])
              .whereRaw(`(
                held.id::text = sms_log.metadata->>'agent_decision_id'
                OR jsonb_exists(COALESCE(sms_log.metadata->'parked_decision_ids', '[]'::jsonb), held.id::text)
              )`);
          });
      })
      .modify(preserveSoleAcceptedReplyReceipts)
      .del();
  } catch (err) {
    logger.warn(`[sms-auto-send] reservation sweep failed: ${err.message}`);
  }

  // Sweep stale review-ask reservations. review-ask-history's lastManualAskAt
  // only reads sms_log back to the 72-hour ask-spacing window, so a row still
  // stuck at 'sending' past that window (an uncertain provider attempt, a
  // process crash, or a failed delivery-stamp cleanup in settleReviewReservation)
  // can no longer serve as spacing evidence either way — it is now orphaned.
  // A row already resolved to 'sent'/'delivered' is real: settleReviewReservation
  // either deletes it as a confirmed duplicate or promotes it to the durable
  // sent record when no separate provider log exists, so it must stay out of
  // this sweep regardless of age.
  //
  // scheduled_for IS NULL is the positive marker for "synthetic placeholder":
  // review-request.js#reserveReviewSms never sets it. A real scheduled row
  // (scheduled-sms-delivery.js stamps the same marker on it before its
  // provider call) always carries a scheduled_for from its original queueing
  // and keeps it for life — nothing ever nulls it. Age alone can't tell them
  // apart: claimDueScheduledSms flips a due retry to 'sending' without
  // touching created_at, so a freshly reclaimed real row can sit exactly at
  // this cutoff and must never be eligible here (codex P1, review-ask-queued
  // #4334) — losing it strands its retry and terminal-hook obligations.
  let reviewReservationsExpired = 0;
  try {
    const reviewCutoff = new Date(Date.now() - ASK_SPACING_MS);
    reviewReservationsExpired = await db('sms_log')
      .where({ direction: 'outbound', status: 'sending' })
      .whereRaw("metadata->>'review_ask_reservation' = 'true'")
      .whereNull('scheduled_for')
      .where('created_at', '<', reviewCutoff)
      .del();
  } catch (err) {
    logger.warn(`[sms-auto-send] review reservation sweep failed: ${err.message}`);
  }

  if (resolved || failed || reservationsCleared || reviewReservationsExpired) {
    logger.info(`[sms-auto-send] reconcile: resolved ${resolved} sent-but-unresolved, failed ${failed} orphaned claims, cleared ${reservationsCleared} stale reservations, expired ${reviewReservationsExpired} stale review reservations`);
  }
  return { resolved, failed, reservationsCleared, reviewReservationsExpired };
}

module.exports = {
  AUTOSEND_WORKFLOW,
  AUTOSEND_AGENT_NAME,
  AUTOSEND_DECISION_VERSION,
  AUTOSEND_MODE,
  AUTOSEND_MESSAGE_TYPE,
  CLAIM_STATUS,
  SENT_STATUS,
  FAILED_STATUS,
  DRAFT_SENT_STATUS,
  SAFE_AUTO_SEND_ACTION,
  SUPPRESSION_SENTINELS,
  isRealProviderSend,
  isAmbiguousProviderOutcome,
  suppressedSendSentinel,
  autoSendActionsSafe,
  autoSendPreflight,
  hasActiveAutoSendClaim,
  claimAutoSend,
  claimGratitudeSend,
  resolveSent,
  failClaim,
  maybeAutoSend,
  processGratitudeAutoSendCandidates,
  reconcileAutoSendClaims,
};
