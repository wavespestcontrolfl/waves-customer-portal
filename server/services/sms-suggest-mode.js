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
 * Publish one suggested draft into the comms composer: supersede any older
 * pending suggestion for the customer (one card per thread, newest inbound
 * wins — their drafts go back to the judge), then insert the pending_review
 * decision the composer card reads. Returns the decision id, or null on
 * failure (caller reverts the draft to shadow so the judge still covers it).
 */
async function publishSuggestion({ draftId, customerId, smsLogId, inboundMessage, reply, intent, confidence, model, promptVersion }) {
  try {
    return await db.transaction(async (trx) => {
      const superseded = await trx('agent_decisions')
        .where({ workflow: SUGGEST_WORKFLOW, status: 'pending_review', customer_id: customerId })
        .select('id', 'entity_id');
      if (superseded.length) {
        await trx('agent_decisions')
          .whereIn('id', superseded.map((r) => r.id))
          .update({
            status: 'superseded',
            correction_note: 'Replaced by a suggestion for a newer inbound message.',
            updated_at: new Date(),
          });
        await revertDraftsToShadow(trx, superseded.map((r) => r.entity_id));
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

/**
 * Nightly sweep: a suggestion nobody acted on within EXPIRY_HOURS is stale —
 * surfacing it days later under a dead thread is noise, and unresolved rows
 * would skew the ignored-rate graduation signal. Their drafts return to the
 * judge pool: human silence is the both_no_reply / human_no_reply signal.
 */
async function expireStaleSuggestions({ maxAgeHours = EXPIRY_HOURS } = {}) {
  const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);
  return db.transaction(async (trx) => {
    const stale = await trx('agent_decisions')
      .where({ workflow: SUGGEST_WORKFLOW, status: 'pending_review' })
      .where('created_at', '<', cutoff)
      .select('id', 'entity_id');
    if (!stale.length) return 0;

    await trx('agent_decisions')
      .whereIn('id', stale.map((r) => r.id))
      .update({
        status: 'expired',
        correction_note: `No staff action within ${maxAgeHours}h of the inbound.`,
        updated_at: new Date(),
      });
    await revertDraftsToShadow(trx, stale.map((r) => r.entity_id));

    logger.info(`[sms-suggest] expired ${stale.length} stale suggestions`);
    return stale.length;
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
  getIntentMode,
  resolveDraftStatus,
  listIntentModes,
  setIntentMode,
  publishSuggestion,
  revertDraftsToShadow,
  expireStaleSuggestions,
};
