/**
 * SMS Suggest Mode — Phase D of the SMS brand-voice loop.
 *
 * Per-intent graduation step between shadow and auto-send: when an intent
 * class is flipped to 'suggest' (sms_intent_modes), the house-voice draft is
 * published as an agent_decisions pending_review row, which the comms
 * composer already renders as an "Agent Review Draft" card with a Use Draft
 * button. A human still reads, optionally edits, and presses Send — nothing
 * here sends a message.
 *
 * Outcome telemetry rides the existing review plumbing:
 *   accepted   — staff sent the suggestion verbatim (comms send handler)
 *   corrected  — staff edited the suggestion before sending
 *   ignored    — staff sent their own reply while a suggestion was pending
 *   superseded — a newer inbound from the same customer replaced it
 *   expired    — nobody replied within EXPIRY_HOURS (nightly sweep)
 * Per-intent accepted/corrected/ignored rates are the graduation input for
 * Phase E, alongside the shadow-judge score history.
 *
 * HARD RULES (code, not config):
 *   - Escalation intents never become suggestions, whatever the mode row says.
 *   - scheduling_intent=true drafts never become suggestions in Phase D.
 *   - Fail closed: any lookup error resolves to 'shadow'.
 *
 * Suggested drafts get message_drafts status='suggested', which keeps them
 * out of the nightly judge (it queries status='shadow' only) — a suggestion
 * the human sends becomes the outbound itself, and judging a draft against
 * its own text would inflate scores.
 *
 * PII: never log message bodies or full phone numbers from this module.
 */
const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');

const VALID_MODES = ['shadow', 'suggest'];
const ESCALATION_INTENTS = new Set(['customer_issue_needs_review']);

const SUGGESTED_STATUS = 'suggested';
const SUGGEST_WORKFLOW = 'sms_house_voice_suggest';
const SUGGEST_AGENT_NAME = 'House Voice Drafter';
const SUGGEST_DECISION_VERSION = 'house_voice_suggest_v1';
const EXPIRY_HOURS = 48;

// Human-authored/approved outbounds that really left the system — the same
// ground-truth allowlists the shadow judge pairs against (sms-shadow-judge).
const HUMAN_REPLY_TYPES = ['manual', 'ai_approved', 'ai_revised'];
const SENT_STATUSES = ['queued', 'sent', 'delivered'];

function isEscalationIntent(intent) {
  return ESCALATION_INTENTS.has(String(intent || ''));
}

/**
 * Pure eligibility check — everything that must hold BEFORE the mode row is
 * even consulted. Suggestions need a customer and an inbound sms_log link
 * because the composer card and the send-handler ownership check both match
 * on them; without either, the card could never surface or be verified.
 */
function suggestionEligible({ reply, customerId, smsLogId, intent, schedulingIntent }) {
  if (!reply || !String(reply).trim()) return false;
  if (!customerId || !smsLogId) return false;
  if (schedulingIntent) return false;
  if (isEscalationIntent(intent)) return false;
  return true;
}

/** Pure validation for a mode flip — shared by the admin endpoint and tests. */
function validateModeChange(intent, mode) {
  const cleanIntent = String(intent || '').trim();
  if (!cleanIntent || cleanIntent.length > 50) {
    return { ok: false, error: 'intent must be a non-empty string of at most 50 chars' };
  }
  if (!VALID_MODES.includes(mode)) {
    return { ok: false, error: `mode must be one of: ${VALID_MODES.join(', ')}` };
  }
  if (mode !== 'shadow' && isEscalationIntent(cleanIntent)) {
    return { ok: false, error: 'escalation intents are locked to shadow and never graduate' };
  }
  return { ok: true, intent: cleanIntent };
}

/** Mode for one intent. Missing row or lookup error = 'shadow' (fail closed). */
async function getIntentMode(intent) {
  if (isEscalationIntent(intent)) return 'shadow';
  try {
    const row = await db('sms_intent_modes').where({ intent: String(intent || '') }).first('mode');
    return row && VALID_MODES.includes(row.mode) ? row.mode : 'shadow';
  } catch (err) {
    logger.warn(`[sms-suggest] intent mode lookup failed (${intent}): ${err.message}; resolving shadow`);
    return 'shadow';
  }
}

/**
 * Resolve the message_drafts status for a freshly parsed draft. One call
 * site in the shadow drafter; returns 'shadow' unless every gate passes.
 */
async function resolveDraftStatus({ reply, customerId, smsLogId, intent, schedulingIntent }) {
  if (!isEnabled('smsSuggestMode')) return 'shadow';
  if (!suggestionEligible({ reply, customerId, smsLogId, intent, schedulingIntent })) return 'shadow';
  const mode = await getIntentMode(intent);
  return mode === 'suggest' ? SUGGESTED_STATUS : 'shadow';
}

async function listIntentModes() {
  return db('sms_intent_modes').orderBy('intent', 'asc');
}

async function setIntentMode({ intent, mode, actor, reason }) {
  const check = validateModeChange(intent, mode);
  if (!check.ok) {
    const err = new Error(check.error);
    err.statusCode = 400;
    throw err;
  }
  const [row] = await db('sms_intent_modes')
    .insert({
      intent: check.intent,
      mode,
      updated_by: actor || 'admin',
      reason: reason || null,
      updated_at: new Date(),
    })
    .onConflict('intent')
    .merge(['mode', 'updated_by', 'reason', 'updated_at'])
    .returning('*');
  return row;
}

/**
 * Return unused suggestions' drafts to the judge pool. A suggestion that
 * ends pending_review WITHOUT being sent (ignored / superseded / expired)
 * leaves exactly the ground truth Phase C scores against — the human's own
 * reply, or silence — so its draft flips back to status='shadow' for the
 * nightly judge. Only accepted/corrected drafts stay 'suggested': there the
 * outbound IS the draft text, and judging it against itself would inflate
 * scores. Decisions store the draft as their entity (entity_type
 * 'message_draft'), which is what this resolves through.
 */
async function revertDraftsToShadow(trx, draftIds) {
  const ids = (draftIds || []).filter(Boolean);
  if (!ids.length) return 0;
  return trx('message_drafts').whereIn('id', ids).where({ status: SUGGESTED_STATUS }).update({ status: 'shadow' });
}

/**
 * Pure ordering decision for a publish attempt. Drafting is fire-and-forget
 * from the webhook, so two drafts for the same customer can finish out of
 * order — an OLDER inbound's draft completing later must not supersede the
 * newer card. Pending rows with a strictly newer inbound block this publish
 * entirely; rows with an older (or unknown) inbound get superseded.
 */
function splitPendingSuggestions(pending, inboundAt) {
  // new Date(null) is epoch zero, not NaN — reject missing anchors explicitly.
  const anchor = inboundAt ? new Date(inboundAt).getTime() : NaN;
  if (!Number.isFinite(anchor)) return { newerExists: true, supersede: [] };
  const newerExists = (pending || []).some((row) => {
    const t = new Date(row.inbound_at || 0).getTime();
    return Number.isFinite(t) && t > anchor;
  });
  return { newerExists, supersede: newerExists ? [] : (pending || []) };
}

/**
 * Publish one suggested draft into the comms composer: supersede any older
 * pending suggestion for the customer (one card per thread, newest inbound
 * wins — their drafts go back to the judge), then insert the pending_review
 * decision the composer card reads. Returns the decision id, or null when
 * not published (failure, or a newer suggestion is already up) — the caller
 * reverts the draft to shadow so the judge still covers it.
 */
async function publishSuggestion({ draftId, customerId, smsLogId, inboundMessage, reply, intent, confidence, model, promptVersion }) {
  try {
    return await db.transaction(async (trx) => {
      // Serialize publishes per customer: two fire-and-forget drafter jobs
      // can otherwise both pass the pending-suggestion read below before
      // either inserts, and the composer card query (latest created_at
      // wins) would surface whichever decision landed LAST — possibly the
      // staler inbound's. The xact lock releases at commit/rollback, so the
      // second publisher then sees the first one's committed row and the
      // inbound-ordering guard works. (Same two-key pattern as booking.js.)
      await trx.raw(
        'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
        ['sms_suggest_publish', customerId]
      );

      const inbound = await trx('sms_log').where({ id: smsLogId }).first('created_at');
      if (!inbound?.created_at) return null;

      // A fast human reply can land while the draft is still generating, and
      // the post-send ignore sweep can't resolve a decision row that doesn't
      // exist yet. If a human-authored outbound already answered this
      // inbound, don't publish: the draft stays shadow and the judge scores
      // it against that very reply.
      const answered = await trx('sms_log')
        .where({ customer_id: customerId, direction: 'outbound' })
        .whereIn('message_type', HUMAN_REPLY_TYPES)
        .whereIn('status', SENT_STATUSES)
        .where('created_at', '>', inbound.created_at)
        .first('id');
      if (answered) return null;

      const pending = await trx('agent_decisions as ad')
        .leftJoin('sms_log as s', 'ad.sms_log_id', 's.id')
        .where({ 'ad.workflow': SUGGEST_WORKFLOW, 'ad.status': 'pending_review', 'ad.customer_id': customerId })
        .select('ad.id', 'ad.entity_id', 's.created_at as inbound_at');

      const { newerExists, supersede } = splitPendingSuggestions(pending, inbound.created_at);
      if (newerExists) return null;

      if (supersede.length) {
        // Re-guard on pending_review and revert only rows actually changed:
        // the composer can mark one accepted/corrected between our SELECT
        // and this UPDATE, and a sent suggestion must keep its status and
        // stay out of the judge pool.
        const changed = await trx('agent_decisions')
          .whereIn('id', supersede.map((r) => r.id))
          .where({ status: 'pending_review' })
          .update({
            status: 'superseded',
            correction_note: 'Replaced by a suggestion for a newer inbound message.',
            updated_at: new Date(),
          })
          .returning(['id', 'entity_id']);
        await revertDraftsToShadow(trx, changed.map((r) => r.entity_id));
      }

      const numericConfidence = Number.isFinite(Number(confidence)) ? Number(confidence) : null;
      const [row] = await trx('agent_decisions')
        .insert({
          workflow: SUGGEST_WORKFLOW,
          agent_name: SUGGEST_AGENT_NAME,
          decision_version: SUGGEST_DECISION_VERSION,
          mode: 'suggest',
          status: 'pending_review',
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
          reasoning_summary: 'House-voice suggested reply (brand-voice loop Phase D). Review, edit if needed, and send.',
          model: model || null,
          prompt_version: promptVersion || null,
          idempotency_key: `${SUGGEST_WORKFLOW}:draft:${draftId}`,
        })
        .onConflict('idempotency_key')
        .ignore()
        .returning('id');
      return row?.id || null;
    });
  } catch (err) {
    logger.warn(`[sms-suggest] publish failed (draft ${draftId}): ${err.message}`);
    return null;
  }
}

/** Pure verdict for a send derived from a reviewed draft: verbatim or edited. */
function classifySendVerdict(sentBody, suggestedMessage) {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  return normalize(sentBody) === normalize(suggestedMessage) ? 'accepted' : 'corrected';
}

/**
 * Holding state while a reviewed draft waits in the scheduled-send queue.
 * 'scheduled' decisions are invisible to the composer card fetch and the
 * expiry sweep (both filter pending_review), so the same suggestion can't
 * be used twice and can't expire out from under a queued send. Reopened on
 * cancel/failure; resolved (accepted/corrected) when the send fires.
 */
async function markSuggestionScheduled({ decisionId, scheduledFor }) {
  return db('agent_decisions')
    .where({ id: decisionId, status: 'pending_review' })
    .update({
      status: 'scheduled',
      correction_note: `Reviewed draft scheduled from the SMS inbox for ${scheduledFor instanceof Date ? scheduledFor.toISOString() : scheduledFor}.`,
      updated_at: new Date(),
    });
}

/** Cancel/failure path: the customer was never answered — the card returns. */
async function reopenScheduledSuggestion({ decisionId, reason }) {
  if (!decisionId) return 0;
  try {
    return await db('agent_decisions')
      .where({ id: decisionId, status: 'scheduled' })
      .update({
        status: 'pending_review',
        correction_note: reason || 'Scheduled send did not go out — suggestion reopened.',
        updated_at: new Date(),
      });
  } catch (err) {
    logger.warn(`[sms-suggest] reopen failed (decision ${decisionId}): ${err.message}`);
    return 0;
  }
}

/**
 * Resolve a reviewed draft decision after its SCHEDULED send actually fired
 * (the immediate /sms route resolves inline; the 5-min dispatch cron calls
 * this). Guarded on pending_review — if the decision was already resolved
 * or expired while the send waited, this is a no-op. Works for any
 * workflow's decision: the schedule route only stashes ids it verified.
 */
async function resolveSuggestionAfterSend({ decisionId, sentBody, reviewedBy }) {
  try {
    // 'scheduled' is the expected state (set at schedule time);
    // pending_review covers rows scheduled before the holding state shipped.
    const RESOLVABLE = ['scheduled', 'pending_review'];
    const decision = await db('agent_decisions')
      .where({ id: decisionId })
      .whereIn('status', RESOLVABLE)
      .first('id', 'suggested_message');
    if (!decision) return null;

    const verdict = classifySendVerdict(sentBody, decision.suggested_message);
    const changed = await db('agent_decisions')
      .where({ id: decisionId })
      .whereIn('status', RESOLVABLE)
      .update({
        status: verdict,
        human_verdict: verdict,
        correction_note: verdict === 'accepted'
          ? 'Reviewed draft scheduled and sent from the SMS inbox.'
          : 'Reviewed draft edited, scheduled, and sent from the SMS inbox.',
        reviewed_by: reviewedBy || 'Admin',
        reviewed_at: new Date(),
        updated_at: new Date(),
      });
    return changed ? verdict : null;
  } catch (err) {
    logger.warn(`[sms-suggest] post-scheduled-send resolution failed (decision ${decisionId}): ${err.message}`);
    return null;
  }
}

/**
 * Nightly sweep: a suggestion nobody acted on within EXPIRY_HOURS is stale —
 * surfacing it days later under a dead thread is noise, and unresolved rows
 * would skew the ignored-rate graduation signal. Their drafts return to the
 * judge pool: human silence is the both_no_reply / human_no_reply signal.
 */
async function expireStaleSuggestions({ maxAgeHours = EXPIRY_HOURS } = {}) {
  const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);
  return db.transaction(async (trx) => {
    // Orphaned holding states first: a 'scheduled' decision whose queued
    // sms_log row no longer exists in a live state (cancelled outside the
    // cancel route, or stale-claim recovery marked it failed) would hang
    // forever — reopen it, and the created_at-keyed expiry below gives it a
    // terminal state if it's already past the window.
    const reopened = await trx('agent_decisions as ad')
      .where({ 'ad.workflow': SUGGEST_WORKFLOW, 'ad.status': 'scheduled' })
      .where('ad.updated_at', '<', cutoff)
      .whereRaw("NOT EXISTS (SELECT 1 FROM sms_log sl WHERE sl.metadata->>'agent_decision_id' = ad.id::text AND sl.status IN ('scheduled', 'sending'))")
      .update({
        status: 'pending_review',
        correction_note: 'Scheduled send never fired — suggestion reopened by the expiry sweep.',
        updated_at: new Date(),
      });
    if (reopened > 0) logger.info(`[sms-suggest] reopened ${reopened} orphaned scheduled suggestions`);

    // Single guarded UPDATE ... RETURNING — no SELECT-then-UPDATE window in
    // which the composer could resolve a row we then stomp to expired.
    const expired = await trx('agent_decisions')
      .where({ workflow: SUGGEST_WORKFLOW, status: 'pending_review' })
      .where('created_at', '<', cutoff)
      .update({
        status: 'expired',
        correction_note: `No staff action within ${maxAgeHours}h of the inbound.`,
        updated_at: new Date(),
      })
      .returning(['id', 'entity_id']);
    if (!expired.length) return 0;

    await revertDraftsToShadow(trx, expired.map((r) => r.entity_id));

    logger.info(`[sms-suggest] expired ${expired.length} stale suggestions`);
    return expired.length;
  });
}

module.exports = {
  VALID_MODES,
  ESCALATION_INTENTS,
  SUGGESTED_STATUS,
  SUGGEST_WORKFLOW,
  SUGGEST_AGENT_NAME,
  SUGGEST_DECISION_VERSION,
  EXPIRY_HOURS,
  isEscalationIntent,
  suggestionEligible,
  validateModeChange,
  splitPendingSuggestions,
  classifySendVerdict,
  getIntentMode,
  resolveDraftStatus,
  listIntentModes,
  setIntentMode,
  publishSuggestion,
  revertDraftsToShadow,
  markSuggestionScheduled,
  reopenScheduledSuggestion,
  resolveSuggestionAfterSend,
  expireStaleSuggestions,
};
