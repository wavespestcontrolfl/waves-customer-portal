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
 *   1. GATE_SMS_AUTO_SEND — the path is locked off entirely until opted in.
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
 *      (quiet hours, consent, suppression, identity trust all enforced).
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
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');

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
// message_drafts.status once the send is confirmed (out of the judge pool).
const DRAFT_SENT_STATUS = 'auto_sent';

/**
 * Pure precondition ordering for an auto-send attempt — the gate/eligibility
 * decision tree with no DB, for exhaustive unit coverage. Returns the reason
 * the attempt stops, or null when every precondition is clear. maybeAutoSend
 * evaluates these same checks lazily (so the expensive eligibility query never
 * runs when the gate is off or the draft is ineligible); this is the contract
 * they share.
 */
function autoSendPreflight({ gateOn, baseEligible, mode, eligible }) {
  if (!gateOn) return 'gate_off';
  if (!baseEligible) return 'ineligible_base';
  if (mode !== AUTOSEND_MODE) return 'mode_not_autosend';
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
    const fromNumber = inbound.to_phone || null; // the Waves line they texted

    await suggest.lockSuggestThread(trx, threadLast10 || customerId);

    if (await suggest.threadHasLiveAnswer(trx, { threadLast10, customerId, inboundCreatedAt: inbound.created_at })) {
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
        idempotency_key: `${AUTOSEND_WORKFLOW}:draft:${draftId}`,
      })
      .onConflict('idempotency_key')
      .ignore()
      .returning('id');
    if (!row?.id) return null;

    return { decisionId: row.id, toPhone, fromNumber, threadLast10 };
  });
}

/** Mark a confirmed send: resolve the claim and take the draft out of the judge pool. */
async function resolveSent({ decisionId, draftId, providerMessageId }) {
  await db.transaction(async (trx) => {
    await trx('agent_decisions')
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
    // Guarded on 'shadow' so a racing path can't double-flip; the outbound IS
    // the draft text now, so it must leave the shadow judge pool.
    await trx('message_drafts').where({ id: draftId, status: 'shadow' }).update({ status: DRAFT_SENT_STATUS });
  });
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
  const {
    draftId, customer, smsLogId, inboundMessage, reply, intent,
    confidence = null, model = null, promptVersion = null, schedulingIntent = false,
  } = params;
  const customerId = customer?.id || null;

  try {
    // (1) Gate.
    if (!isEnabled('smsAutoSend')) return { sent: false, reason: 'gate_off' };

    const suggest = require('./sms-suggest-mode');
    // (2) Base eligibility (same hard rules as a suggestion).
    if (!suggest.suggestionEligible({ reply, customerId, smsLogId, intent, schedulingIntent })) {
      return { sent: false, reason: 'ineligible_base' };
    }
    // (3) Intent must actually be flipped to auto_send.
    const mode = await suggest.getIntentMode(intent);
    if (mode !== AUTOSEND_MODE) return { sent: false, reason: 'mode_not_autosend' };

    // (4) Server-enforced graduation eligibility — re-checked live every send.
    const graduation = require('./sms-graduation');
    const elig = await graduation.evaluateAutoSendEligibility({ intent });
    if (!elig.eligible) {
      logger.info(`[sms-auto-send] intent=${intent} not eligible; blockers: ${(elig.blockers || []).join(' | ')}`);
      return { sent: false, reason: 'not_eligible' };
    }

    // (5)+(6) Claim under the lock + guard-gauntlet.
    const claim = await claimAutoSend({ draftId, customerId, smsLogId, inboundMessage, reply, intent, confidence, model, promptVersion });
    if (!claim) return { sent: false, reason: 'guarded_or_claimed' };

    // (7) Send via the policy-checked provider path (quiet hours, consent,
    //     suppression, identity trust all enforced upstream).
    const { sendCustomerMessage } = require('./messaging/send-customer-message');
    let result;
    try {
      result = await sendCustomerMessage({
        to: claim.toPhone,
        body: reply,
        channel: 'sms',
        audience: 'customer',
        purpose: 'conversational',
        customerId,
        identityTrustLevel: 'phone_matches_customer',
        entryPoint: 'sms_auto_send_executor',
        metadata: {
          original_message_type: AUTOSEND_MESSAGE_TYPE,
          agentDecisionId: claim.decisionId,
          fromNumber: claim.fromNumber || undefined,
        },
      });
    } catch (err) {
      await failClaim(claim.decisionId, `send threw: ${err.message}`);
      logger.warn(`[sms-auto-send] send threw (decision ${claim.decisionId}): ${err.message}`);
      return { sent: false, reason: 'send_error' };
    }

    if (result?.sent) {
      await resolveSent({ decisionId: claim.decisionId, draftId, providerMessageId: result.providerMessageId });
      logger.info(`[sms-auto-send] SENT customer=${customerId || 'unknown'} intent=${intent} decision=${claim.decisionId} sid=${result.providerMessageId || 'n/a'}`);
      return { sent: true, decisionId: claim.decisionId, providerMessageId: result.providerMessageId || null };
    }

    await failClaim(claim.decisionId, result?.reason || result?.code || 'provider did not send');
    logger.info(`[sms-auto-send] NOT sent customer=${customerId || 'unknown'} intent=${intent} reason=${result?.code || 'not_sent'}`);
    return { sent: false, reason: result?.code || 'not_sent' };
  } catch (err) {
    logger.error(`[sms-auto-send] unexpected failure (draft ${draftId}): ${err.message}`);
    return { sent: false, reason: 'error' };
  }
}

/**
 * Nightly crash-recovery for auto-send claims stuck in 'sending'. Idempotent
 * and guarded, so racing a live attempt double-resolves to the same verdict.
 *   (a) a claim whose outbound already went out (crash between send and
 *       resolve) → resolve it and flip the draft (the customer WAS texted);
 *   (b) a claim older than orphanMinutes with no live/sent outbound → fail it
 *       (the provider send never confirmed; the draft is still 'shadow').
 */
async function reconcileAutoSendClaims({ orphanMinutes = 30 } = {}) {
  const cutoff = new Date(Date.now() - orphanMinutes * 60 * 1000);
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
      )`)
      .update({
        status: FAILED_STATUS,
        correction_note: 'Auto-send claim never confirmed a provider send — reconciled by the recovery sweep.',
        updated_at: new Date(),
      });
  } catch (err) {
    logger.warn(`[sms-auto-send] orphan reconcile failed: ${err.message}`);
  }

  if (resolved || failed) {
    logger.info(`[sms-auto-send] reconcile: resolved ${resolved} sent-but-unresolved, failed ${failed} orphaned claims`);
  }
  return { resolved, failed };
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
  autoSendPreflight,
  claimAutoSend,
  resolveSent,
  failClaim,
  maybeAutoSend,
  reconcileAutoSendClaims,
};
