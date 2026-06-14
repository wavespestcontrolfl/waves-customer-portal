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

// The graduation ladder. 'auto_send' is the top rung — its delivery path
// lives in sms-auto-send.js and only fires behind GATE_SMS_AUTO_SEND with a
// server-enforced eligibility re-check. Escalation intents never leave shadow.
const VALID_MODES = ['shadow', 'suggest', 'auto_send'];
const AUTO_SEND_MODE = 'auto_send';
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

const THREAD_LOCK_NS = 'sms_suggest_thread';

/**
 * One advisory xact lock per SMS thread, SHARED by every path that creates
 * or resolves suggestions: drafter publish, the post-send ignore sweep, and
 * the schedule park+queue transaction. Without a common lock a publish can
 * pass its answered/in-flight guards before a staff reply commits, then
 * insert an actionable card the staff path's sweep never saw. Keyed on the
 * thread phone (last 10) — the identity every path has; falls back to the
 * customer id. Releases at commit/rollback. (Two-key pattern per booking.js.)
 */
async function lockSuggestThread(trx, key) {
  await trx.raw(
    'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
    [THREAD_LOCK_NS, String(key)]
  );
}

/**
 * Shared thread guard-gauntlet for any path that would put a fresh house-voice
 * reply on a thread — the suggest publish AND the auto-send executor. Returns
 * a blocker reason, or null when the thread is clear. Reads committed state
 * only: call it INSIDE the locked transaction so a concurrent staff reply or
 * newer inbound can't slip past between the check and the write.
 *   human_answered  — a human-authored outbound already answered this inbound
 *   reply_in_flight — a human reply for this thread is queued/sending
 *   newer_inbound   — a newer inbound exists; this reply's context is stale
 * Thread scope is the customer phone (last 10); customer_id is the fallback
 * when the inbound carried no phone. (Auto-sent outbounds use their own
 * message_type, deliberately NOT in HUMAN_REPLY_TYPES — "did a HUMAN answer?"
 * is the question, and a newer auto-send always implies a newer inbound, which
 * the newer_inbound guard already catches.)
 */
async function threadHasLiveAnswer(trx, { threadLast10, customerId, inboundCreatedAt }) {
  const byThread = (phoneColumn) => function matchThread() {
    if (threadLast10) {
      this.whereRaw(
        `RIGHT(REGEXP_REPLACE(COALESCE(${phoneColumn}, ''), '[^0-9]', '', 'g'), 10) = ?`,
        [threadLast10]
      );
    } else {
      this.where({ customer_id: customerId });
    }
  };

  const answered = await trx('sms_log')
    .where({ direction: 'outbound' })
    .where(byThread('to_phone'))
    .whereIn('message_type', HUMAN_REPLY_TYPES)
    .whereIn('status', SENT_STATUSES)
    .where('created_at', '>', inboundCreatedAt)
    .first('id');
  if (answered) return 'human_answered';

  const replyInFlight = await trx('sms_log')
    .where({ direction: 'outbound' })
    .where(byThread('to_phone'))
    .whereIn('message_type', HUMAN_REPLY_TYPES)
    .whereIn('status', ['scheduled', 'sending'])
    .where('created_at', '>', inboundCreatedAt)
    .first('id');
  if (replyInFlight) return 'reply_in_flight';

  const newerInbound = await trx('sms_log')
    .where({ direction: 'inbound' })
    .where(byThread('from_phone'))
    .where('created_at', '>', inboundCreatedAt)
    .first('id');
  if (newerInbound) return 'newer_inbound';

  return null;
}

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
 * Resolve the delivery target for a freshly parsed draft — the single source
 * of truth the drafter branches on. Returns the ladder rung the draft should
 * take: 'shadow' (silent), 'suggest' (composer card), or 'auto_send'
 * (executor sends it). Fail closed at every step:
 *   - ineligible (no reply / no customer+inbound / scheduling / escalation) → shadow
 *   - intent mode 'auto_send' → auto_send only if GATE_SMS_AUTO_SEND is on;
 *     otherwise gracefully DEGRADE to a human-reviewed suggestion (never a
 *     silent drop) when suggest is available, else shadow
 *   - intent mode 'suggest' → suggest only if GATE_SMS_SUGGEST_MODE is on
 *   - anything else → shadow
 * The executor independently re-verifies all of this before sending; this is
 * the drafter-side resolution, not the security boundary.
 */
async function resolveDeliveryMode({ reply, customerId, smsLogId, intent, schedulingIntent }) {
  if (!suggestionEligible({ reply, customerId, smsLogId, intent, schedulingIntent })) return 'shadow';
  const mode = await getIntentMode(intent); // 'shadow' | 'suggest' | 'auto_send'; escalation forced shadow
  if (mode === AUTO_SEND_MODE) {
    if (isEnabled('smsAutoSend')) return AUTO_SEND_MODE;
    return isEnabled('smsSuggestMode') ? 'suggest' : 'shadow';
  }
  if (mode === 'suggest') return isEnabled('smsSuggestMode') ? 'suggest' : 'shadow';
  return 'shadow';
}

/**
 * Back-compat: the message_drafts STATUS for a freshly parsed draft. The draft
 * row is always inserted as 'shadow'; only a published suggestion flips it to
 * 'suggested'. Auto-send drafts also insert as 'shadow' (the executor flips
 * them to 'auto_sent' after the send confirms), so this maps every non-suggest
 * rung to 'shadow'.
 */
async function resolveDraftStatus(args) {
  return (await resolveDeliveryMode(args)) === 'suggest' ? SUGGESTED_STATUS : 'shadow';
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
      // The inbound row is immutable — safe to read before the lock; the
      // thread phone it carries IS the lock key.
      const inbound = await trx('sms_log').where({ id: smsLogId }).first('created_at', 'from_phone');
      if (!inbound?.created_at) return null;

      // Thread identity = the customer phone this inbound arrived from.
      // Every guard below scopes to THIS thread, not the whole customer: a
      // multi-phone customer (service contacts carry three slots) can have
      // parallel conversations, and an answer or newer inbound on one
      // thread must not block or supersede the card on another. Phone-only
      // admin sends (customer_id null) match through the same phone scope;
      // customer_id is only the fallback when the inbound has no phone.
      const threadLast10 = String(inbound.from_phone || '').replace(/\D/g, '').slice(-10) || null;

      // Serializes against other publishers AND the staff send/queue paths
      // (same lock in the /sms ignore sweep and the schedule transaction):
      // every guard below reads committed state, and anything we insert is
      // visible to the next locked path.
      await lockSuggestThread(trx, threadLast10 || customerId);

      // Shared guard-gauntlet (mirrored by the auto-send executor): a human
      // reply already out, a staff reply queued/in-flight, or a newer inbound
      // whose own draft is still generating all mean this draft's context is
      // stale. Any hit → leave the draft shadow for the judge. The pending-
      // suggestion ordering check below catches the published-card case the
      // newer-inbound scan can't yet see.
      if (await threadHasLiveAnswer(trx, { threadLast10, customerId, inboundCreatedAt: inbound.created_at })) {
        return null;
      }

      // Same thread scope as the guards: supersede/ordering must only see
      // cards for THIS conversation — a multi-phone customer's other thread
      // keeps its own card.
      const pending = await trx('agent_decisions as ad')
        .leftJoin('sms_log as s', 'ad.sms_log_id', 's.id')
        .where({ 'ad.workflow': SUGGEST_WORKFLOW, 'ad.status': 'pending_review' })
        .where(function pendingThreadScope() {
          if (threadLast10) {
            this.whereRaw("RIGHT(REGEXP_REPLACE(COALESCE(s.from_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [threadLast10]);
          } else {
            this.where('ad.customer_id', customerId);
          }
        })
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
      if (!row?.id) return null;

      // Atomic with the decision insert (and under the thread lock): the
      // draft only leaves the judge pool once its composer card exists. The
      // drafter inserts every draft as shadow first — a crash anywhere
      // before this commit leaves a judged shadow row, never an orphaned
      // 'suggested' draft with no card.
      await trx('message_drafts')
        .where({ id: draftId, status: 'shadow' })
        .update({ status: SUGGESTED_STATUS });

      return row.id;
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
async function markSuggestionScheduled({ decisionId, scheduledFor }, dbh = db) {
  return dbh('agent_decisions')
    .where({ id: decisionId, status: 'pending_review' })
    .update({
      status: 'scheduled',
      correction_note: `Reviewed draft scheduled from the SMS inbox for ${scheduledFor instanceof Date ? scheduledFor.toISOString() : scheduledFor}.`,
      updated_at: new Date(),
    });
}

/**
 * Park every OTHER pending house-voice suggestion on the thread while a
 * scheduled reply waits in the queue — otherwise the composer keeps the
 * card actionable and the suggestion can be sent on top of the queued
 * reply. Phone-scoped like the post-send ignore sweep; returns the parked
 * decision ids so the scheduled row can record them (fire = ignored,
 * cancel/failure = reopened).
 */
async function parkThreadSuggestions({ phoneLast10, excludeDecisionId }, dbh = db) {
  if (!phoneLast10) return [];
  // Suggest-workflow decisions always link the INBOUND sms_log row, where
  // from_phone is the customer and to_phone is the Waves line — matching
  // to_phone would park every suggestion that arrived on that line.
  const pendingQuery = dbh('agent_decisions as ad')
    .leftJoin('sms_log as s', 'ad.sms_log_id', 's.id')
    .where({ 'ad.workflow': SUGGEST_WORKFLOW, 'ad.status': 'pending_review' })
    .whereRaw("RIGHT(REGEXP_REPLACE(COALESCE(s.from_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [phoneLast10]);
  if (excludeDecisionId) pendingQuery.whereNot('ad.id', excludeDecisionId);
  const pending = await pendingQuery.select('ad.id');
  if (!pending.length) return [];

  const parked = await dbh('agent_decisions')
    .whereIn('id', pending.map((r) => r.id))
    .where({ status: 'pending_review' })
    .update({
      status: 'scheduled',
      correction_note: 'A staff reply to this thread is queued or in flight — suggestion parked.',
      updated_at: new Date(),
    })
    .returning('id');
  return parked.map((r) => r.id);
}

/** Cancel/failure path: the customer was never answered — the cards return. */
async function reopenScheduledSuggestions({ decisionIds, reason }) {
  const ids = (Array.isArray(decisionIds) ? decisionIds : [decisionIds]).filter(Boolean);
  if (!ids.length) return 0;
  try {
    return await db('agent_decisions')
      .whereIn('id', ids)
      .where({ status: 'scheduled' })
      .update({
        status: 'pending_review',
        correction_note: reason || 'Scheduled send did not go out — suggestion reopened.',
        updated_at: new Date(),
      });
  } catch (err) {
    logger.warn(`[sms-suggest] reopen failed (${ids.length} decisions): ${err.message}`);
    return 0;
  }
}

/**
 * A fired scheduled reply answers the thread: suggestions parked behind it
 * resolve as ignored — the operator chose their own (or another) reply —
 * and their drafts return to the judge pool, exactly like the immediate
 * send path's ignore sweep.
 */
async function ignoreParkedSuggestions({ decisionIds, reviewedBy }) {
  const ids = (Array.isArray(decisionIds) ? decisionIds : [decisionIds]).filter(Boolean);
  if (!ids.length) return 0;
  try {
    return await db.transaction(async (trx) => {
      const ignored = await trx('agent_decisions')
        .whereIn('id', ids)
        .where({ status: 'scheduled' })
        .update({
          status: 'ignored',
          human_verdict: 'ignored',
          correction_note: 'A staff reply to this thread was sent.',
          reviewed_by: reviewedBy || 'Admin',
          reviewed_at: new Date(),
          updated_at: new Date(),
        })
        .returning(['id', 'entity_id']);
      await revertDraftsToShadow(trx, ignored.map((r) => r.entity_id));
      return ignored.length;
    });
  } catch (err) {
    logger.warn(`[sms-suggest] parked-ignore failed (${ids.length} decisions): ${err.message}`);
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
/**
 * Crash recovery for the 'scheduled' holding state — runs UNGATED in the
 * nightly cron: the composer claim/park paths put ANY SMS Agent Review
 * decision (lead workflows included) into 'scheduled' regardless of the
 * suggest-mode gate, and a post-claim crash must never strand those rows
 * invisible.
 */
async function recoverSuggestionHoldingStates({ orphanMinutes = 30 } = {}) {
  // Short window on purpose: an immediate-send claim has NO backing sms_log
  // row, so a crash mid-send leaves the card hidden until this reopens it —
  // 30 minutes bounds that, and the NOT EXISTS live-row check below keeps
  // genuinely queued sends untouched however long they wait. Runs from the
  // 5-min scheduled-SMS cron as well as the nightly sweep.
  const cutoff = new Date(Date.now() - orphanMinutes * 60 * 1000);

  // Sent-linked first: a 'scheduled' decision whose queued row already went
  // SENT means the cron crashed between its sent-update and resolution. The
  // customer WAS texted — reopening would resurface a card on an answered
  // thread (and house-voice rows would later miscount as expired). Resolve
  // the used decision against the sent body; ignore the parked ones. Both
  // helpers are guarded, so racing a live cron iteration double-resolves to
  // the same verdict.
  try {
    // Status allowlist matches SENT_STATUSES: a delivery callback can flip
    // a sent row to 'delivered' before this sweep runs.
    const sentUsed = await db('agent_decisions as ad')
      .joinRaw("JOIN sms_log sl ON sl.metadata->>'agent_decision_id' = ad.id::text AND sl.status IN ('queued', 'sent', 'delivered')")
      .where({ 'ad.status': 'scheduled', 'ad.source_channel': 'sms' })
      .select('ad.id', 'sl.message_body', 'sl.admin_user_id');
    for (const row of sentUsed) {
      await resolveSuggestionAfterSend({
        decisionId: row.id,
        sentBody: row.message_body,
        reviewedBy: row.admin_user_id || 'Admin',
      });
    }

    const sentParked = await db('agent_decisions as ad')
      .joinRaw("JOIN sms_log sl ON jsonb_exists(COALESCE(sl.metadata->'parked_decision_ids', '[]'::jsonb), ad.id::text) AND sl.status IN ('queued', 'sent', 'delivered')")
      .where({ 'ad.status': 'scheduled', 'ad.source_channel': 'sms' })
      .distinct('ad.id')
      .pluck('ad.id');
    if (sentParked.length) {
      await ignoreParkedSuggestions({ decisionIds: sentParked, reviewedBy: 'Admin' });
    }
    if (sentUsed.length || sentParked.length) {
      logger.info(`[sms-suggest] recovered ${sentUsed.length} used + ${sentParked.length} parked decisions behind already-sent rows`);
    }
  } catch (recoverErr) {
    logger.warn(`[sms-suggest] sent-linked recovery failed: ${recoverErr.message}`);
  }

  // Then orphans: a 'scheduled' decision whose queued sms_log row no longer
  // exists in a live state (cancelled outside the cancel route, stale-claim
  // recovery marked it failed, or the process died mid-immediate-send)
  // would hang forever — reopen it into its own workflow's lifecycle; for
  // house-voice rows the created_at-keyed expiry gives it a terminal state
  // if it's already past the window.
  const reopened = await db('agent_decisions as ad')
    .where({ 'ad.source_channel': 'sms', 'ad.status': 'scheduled' })
    .where('ad.updated_at', '<', cutoff)
    .whereRaw(`NOT EXISTS (
      SELECT 1 FROM sms_log sl
      WHERE sl.status IN ('scheduled', 'sending')
        AND (
          sl.metadata->>'agent_decision_id' = ad.id::text
          OR jsonb_exists(COALESCE(sl.metadata->'parked_decision_ids', '[]'::jsonb), ad.id::text)
        )
    )`)
    .update({
      status: 'pending_review',
      correction_note: 'Scheduled send never fired — suggestion reopened by the recovery sweep.',
      updated_at: new Date(),
    });
  if (reopened > 0) logger.info(`[sms-suggest] reopened ${reopened} orphaned scheduled suggestions`);
  return reopened;
}

async function expireStaleSuggestions({ maxAgeHours = EXPIRY_HOURS } = {}) {
  const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);
  return db.transaction(async (trx) => {
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
  AUTO_SEND_MODE,
  ESCALATION_INTENTS,
  SUGGESTED_STATUS,
  SUGGEST_WORKFLOW,
  SUGGEST_AGENT_NAME,
  SUGGEST_DECISION_VERSION,
  EXPIRY_HOURS,
  HUMAN_REPLY_TYPES,
  SENT_STATUSES,
  isEscalationIntent,
  suggestionEligible,
  validateModeChange,
  splitPendingSuggestions,
  classifySendVerdict,
  getIntentMode,
  threadHasLiveAnswer,
  resolveDeliveryMode,
  resolveDraftStatus,
  listIntentModes,
  setIntentMode,
  publishSuggestion,
  revertDraftsToShadow,
  markSuggestionScheduled,
  parkThreadSuggestions,
  reopenScheduledSuggestions,
  ignoreParkedSuggestions,
  resolveSuggestionAfterSend,
  recoverSuggestionHoldingStates,
  expireStaleSuggestions,
  lockSuggestThread,
};
