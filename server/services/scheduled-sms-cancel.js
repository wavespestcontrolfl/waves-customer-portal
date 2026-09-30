/**
 * Cancel a still-scheduled sms_log row — the single writer both the admin
 * SMS inbox (DELETE /admin/communications/scheduled/:id) and the
 * Intelligence Bar's cancel_queued_message tool use.
 *
 * Extracted verbatim from admin-communications.js (Codex round 1 on #5224,
 * P1): a bare status flip on this row is NOT a safe cancel — it can strand
 * a queued review-ask's 72h ask-spacing evidence (the row IS the evidence),
 * a recruiting applicant's comms_history entry (left 'deferred' forever),
 * or a parked sms-suggest decision (never reopened onto the composer).
 * Every one of those obligations is threaded through here so a second
 * writer can never reintroduce the bug this extraction fixes.
 *
 * `expectedScheduledFor`, `expectedToPhone` and `expectedBodyDigest` (md5
 * of the full message_body) are optional CAS pins: when
 * provided, both the DELETE and the fallback UPDATE additionally require
 * the row's CURRENT scheduled_for / to_phone to equal the pinned value, so
 * a caller whose preview pinned one scheduled time or recipient refuses
 * instead of cancelling a row that was reclaimed, rescheduled, or
 * retargeted since (customer-contact-fanout.js rewrites a still-'scheduled'
 * row's to_phone on a phone edit without touching status or scheduled_for
 * — Codex round 3 on #5224, P2). Omitted (undefined), the admin-inbox
 * route's original unconditional-on-status behavior is preserved exactly.
 *
 * `refuseWorkflowOwned` (found during #5224, pre-push audit on the inbox
 * delete route): this writer reconciles recruiting texts, review-ask
 * reservations and parked Agent Review decisions, but it does NOT run any
 * other workflow's cleanup — the deferred-replay registry's onTerminal/
 * finalize handling only runs inside the scheduled-sms executor
 * (scheduler.js), and many producers (deposit receipts, referral nudges,
 * invoice follow-ups, review asks, ...) keep obligations elsewhere. Deleting
 * such a row would strand that workflow (an invoice_send_deferred row keeps
 * its invoice's send claim; an onTerminal hook never releases a claim / arms
 * a fallback sender). No shared cleanup hook clearly handles a STAFF cancel
 * for every workflow, so the inbox refuses instead (rule: cleanup only if
 * every hook handles it, otherwise refuse). Ownership is any of:
 * metadata.entry_point (any value, registry-owned or not — several
 * non-registry producers such as estimate_deposit_receipt_requeue and
 * referral_nudge_deferred also park scheduled rows), metadata.replay_purpose,
 * or metadata.bundled_review_request_id. Exemptions: a never-attempted
 * `recruiting_comms_deferred` row, which this writer already reconciles
 * inline (reconcileCancelledRecruitingText) to the SAME 'blocked' outcome
 * that entry point's onTerminal would produce, and STATELESS_ENTRY_POINTS,
 * which hold nothing outside the row. The Intelligence Bar's
 * cancel_queued_message reaches the same refusal via `simpleOnly`.
 * Enforced in the SAME statement that cancels (both the DELETE and the
 * fallback UPDATE), so a row that becomes workflow-owned between read and
 * write is never deleted or cancelled.
 */
const db = require('../models/db');
const { isRecruitingMessageType } = require('../utils/recruiting-thread-scope');
const {
  HUMAN_REPLY_TYPES,
  reopenScheduledSuggestions,
  ignoreParkedSuggestions,
  lockSuggestThread,
} = require('./sms-suggest-mode');
const { excludeUnresolvedSendReservations } = require('./messaging/review-ask-reservation');

// The one deferred-replay entry point this writer already reconciles
// inline (see reconcileCancelledRecruitingText below) — exempt from the
// refuseWorkflowOwned predicate, but ONLY while the row was never attempted:
// the inline reconcile maps just 'deferred' → 'blocked', so a finalize_only
// or provider-retry row (ledger entry at 'handoff') would strand the ledger.
const RECRUITING_COMMS_DEFERRED_ENTRY_POINT = 'recruiting_comms_deferred';
// Entry points that hold no state outside the row itself (no registry hooks,
// nothing to strand): deleting them is always safe, and refusing them would
// leave no cancel path at all (the IB tool refuses them as non-simple).
// twilio-webhook.js queues the AI auto-reply provider retry under this one.
const STATELESS_ENTRY_POINTS = new Set(['twilio_inbound_ai_assistant_retry']);

function metaText(value) {
  return value == null ? '' : String(value);
}

function priorAttemptOf(m) {
  const finalizeOnly = metaText(m.finalize_only);
  if (finalizeOnly !== '' && finalizeOnly !== 'false') return true;
  return Object.keys(m).some((k) => PRIOR_ATTEMPT_KEY_RE.test(k));
}

// Non-null (a human-readable owner name) only when this row's metadata marks
// it as owned by an automated workflow this writer does not clean up after.
// MUST stay in lockstep with workflowOwnedWhere's SQL below.
function workflowOwnerOf(meta) {
  const m = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {};
  const entryPoint = metaText(m.entry_point);
  if (STATELESS_ENTRY_POINTS.has(entryPoint)) return null;
  if (entryPoint === RECRUITING_COMMS_DEFERRED_ENTRY_POINT) {
    return priorAttemptOf(m) ? entryPoint : null;
  }
  if (entryPoint) return entryPoint;
  if (metaText(m.replay_purpose) !== '') return metaText(m.replay_purpose);
  if (metaText(m.bundled_review_request_id) !== '') return 'review request';
  return null;
}

function phoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizePhoneLast10(value) {
  const digits = phoneDigits(value);
  return digits.length >= 10 ? digits.slice(-10) : null;
}

function parseJson(value, fallback = {}) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// A queued recruiting text cancelled here never reaches the replay rail's
// onTerminal, so its comms_history entry would stay 'deferred' and the
// recruiting queue would keep promising an automatic send (Codex #4623 r17).
// Same never-downgrade posture as onTerminal: a never-attempted row is
// proven undelivered → 'blocked'.
async function reconcileCancelledRecruitingText(meta, trx) {
  if (!meta || meta.entry_point !== 'recruiting_comms_deferred' || !meta.job_application_id || !meta.ledger_entry_id) return;
  const { reconcileCommsHistoryEntryByOutcome } = require('./recruiting-comms');
  await reconcileCommsHistoryEntryByOutcome(meta.job_application_id, meta.ledger_entry_id, {
    deferred: { outcome: 'blocked', code: 'cancelled_by_admin', finalized_at: new Date().toISOString() },
  }, trx);
}

function pinnedScheduledFor(query, expectedScheduledFor) {
  if (expectedScheduledFor === undefined) return query;
  return expectedScheduledFor === null
    ? query.whereNull('scheduled_for')
    : query.where({ scheduled_for: expectedScheduledFor });
}

function pinnedToPhone(query, expectedToPhone) {
  if (expectedToPhone === undefined) return query;
  return expectedToPhone === null
    ? query.whereNull('to_phone')
    : query.where({ to_phone: expectedToPhone });
}

// md5 of the COMPLETE body, matching comms-tools.js bodyDigest (Codex round 5
// on #5224, P2) — an edit anywhere in the body, not just the previewed
// prefix, refuses the cancel.
function pinnedBodyDigest(query, expectedBodyDigest) {
  if (expectedBodyDigest === undefined) return query;
  return expectedBodyDigest === null
    ? query.whereNull('message_body')
    : query.whereRaw("md5(convert_to(message_body, 'UTF8')) = ?", [expectedBodyDigest]);
}

// The Intelligence Bar's simple-only rule (Codex round 6 on #5224, P1),
// enforced in the SAME statement that cancels: never claimed by a send
// worker and carrying no Agent Review decisions, so nothing past the row
// itself changes. Off (the inbox route) = unchanged behavior.
// Any metadata key in the prior-send-attempt family: a worker claim
// (scheduled_sms_claimed_at), a stale-claim recovery
// (scheduled_sms_recovered_at), or any producer's provider-retry marker
// (scheduler.js provider_retry_at/_code, twilio-webhook.js provider_retry).
// Matched by key NAME so a producer's variant spelling is still caught.
const PRIOR_ATTEMPT_KEY_RE = /^(provider_retry|scheduled_sms_(claimed|recovered)_at$)/;
// One source of truth: the SQL `~` match uses the SAME pattern text (the
// syntax is valid in both JS and Postgres POSIX regex).
const PRIOR_ATTEMPT_KEY_SQL = PRIOR_ATTEMPT_KEY_RE.source;

// The only metadata a staff-scheduled inbox text may carry and still be
// "simple" (admin-communications.js POST /send-sms schedule branch writes
// human_authored; its decision keys are refused separately).
const SIMPLE_SMS_META_KEYS = new Set(['human_authored']);

function simpleOnlyWhere(query, simpleOnly) {
  if (!simpleOnly) return query;
  return query
    .whereNotNull('admin_user_id')
    .whereRaw(
      "NOT EXISTS (SELECT 1 FROM jsonb_object_keys(CASE WHEN jsonb_typeof(metadata) = 'object' THEN metadata ELSE '{}'::jsonb END) AS k WHERE k <> ALL(?::text[]))",
      [[...SIMPLE_SMS_META_KEYS]],
    )
    .whereRaw(
      "NOT EXISTS (SELECT 1 FROM jsonb_object_keys(CASE WHEN jsonb_typeof(metadata) = 'object' THEN metadata ELSE '{}'::jsonb END) AS k WHERE k ~ ?)",
      [PRIOR_ATTEMPT_KEY_SQL],
    )
    .whereRaw("COALESCE(metadata->>'agent_decision_id', '') = ''")
    .whereRaw("COALESCE(metadata->'parked_decision_ids', '[]'::jsonb) IN ('[]'::jsonb, 'null'::jsonb)");
}

// Customer ownership (Codex round 8 on #5224, P2): customer-dedupe.js can
// repoint sms_log.customer_id on a merge or merge reversal without touching
// schedule, phone or body.
function pinnedCustomer(query, expectedCustomerId) {
  return expectedCustomerId === undefined ? query : query.where({ customer_id: expectedCustomerId });
}

// SQL twin of workflowOwnerOf: the row is matchable only when it is a
// stateless entry point, a never-attempted recruiting row, or carries none of
// the workflow-ownership markers.
function workflowOwnedWhere(query, refuseWorkflowOwned) {
  if (!refuseWorkflowOwned) return query;
  return query.whereRaw(
    `(COALESCE(metadata->>'entry_point', '') = ANY(?::text[])
      OR (COALESCE(metadata->>'entry_point', '') = ?
          AND COALESCE(metadata->>'finalize_only', '') IN ('', 'false')
          AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(CASE WHEN jsonb_typeof(metadata) = 'object' THEN metadata ELSE '{}'::jsonb END) AS k WHERE k ~ ?))
      OR (COALESCE(metadata->>'entry_point', '') = ''
          AND COALESCE(metadata->>'replay_purpose', '') = ''
          AND COALESCE(metadata->>'bundled_review_request_id', '') = ''))`,
    [[...STATELESS_ENTRY_POINTS], RECRUITING_COMMS_DEFERRED_ENTRY_POINT, PRIOR_ATTEMPT_KEY_SQL],
  );
}

function pinned(query, {
  expectedScheduledFor, expectedToPhone, expectedBodyDigest, expectedCustomerId, simpleOnly, refuseWorkflowOwned,
}) {
  return simpleOnlyWhere(
    workflowOwnedWhere(
      pinnedCustomer(
        pinnedBodyDigest(pinnedToPhone(pinnedScheduledFor(query, expectedScheduledFor), expectedToPhone), expectedBodyDigest),
        expectedCustomerId,
      ),
      refuseWorkflowOwned,
    ),
    simpleOnly,
  );
}

/**
 * @returns {Promise<{outcome: 'not_found'|'forbidden'|'workflow_owned'|'ok', cancelled: boolean, row: object|null, workflow?: string}>}
 *   `outcome` mirrors the admin-inbox route's response branches
 *   ('not_found' and 'ok' both mean "200 success" to that route — it never
 *   distinguished a genuine cancel from a race that found nothing to do).
 *   `workflow_owned` (only with `refuseWorkflowOwned: true`) means the row's
 *   metadata marks it as owned by an automated workflow and this
 *   writer refused to touch it; `workflow` names it for the caller's error
 *   message. `cancelled` is the precise signal a CAS-sensitive caller needs:
 *   true only when THIS call actually neutralized the row (deleted it, or
 *   flipped it to 'canceled' in place).
 */
async function cancelScheduledSmsRow({
  id, techRole, technicianId, expectedScheduledFor, expectedToPhone, expectedBodyDigest, expectedCustomerId,
  simpleOnly = false, refuseWorkflowOwned = false,
} = {}) {
  const pins = { expectedScheduledFor, expectedToPhone, expectedBodyDigest, expectedCustomerId, simpleOnly, refuseWorkflowOwned };
  const peek = await db('sms_log').where({ id, status: 'scheduled' }).first('id', 'to_phone', 'metadata');
  if (!peek) return { outcome: 'not_found', cancelled: false, row: null };
  if (techRole !== 'admin') {
    // Queued recruiting texts are owner-only (utils/recruiting-thread-scope.js).
    const typed = await excludeUnresolvedSendReservations(db('sms_log')).where({ id: peek.id }).first('message_type');
    if (typed && isRecruitingMessageType(typed.message_type)) {
      return { outcome: 'forbidden', cancelled: false, row: null };
    }
  }
  if (refuseWorkflowOwned) {
    const owned = workflowOwnerOf(parseJson(peek.metadata, {}));
    if (owned) return { outcome: 'workflow_owned', cancelled: false, row: null, workflow: owned };
  }
  const threadLast10 = normalizePhoneLast10(peek.to_phone);

  let cancelledRow = null;
  let workflowOwnedRace = null;
  // Lock the thread BEFORE deleting, and resolve the decisions before the
  // lock releases — see the original route's comment (admin-communications.js
  // history) for the full race this protects against.
  await db.transaction(async (trx) => {
    if (threadLast10) await lockSuggestThread(trx, threadLast10);

    // A queued review-ask retry (scheduled-sms-delivery.js's uncertain-send
    // hold) carries the review_ask_reservation marker as the ONLY evidence
    // that attempt ever happened. Deleting it would let the next ask bypass
    // the 72-hour spacing hold, so cancel it in place — a canceled row with
    // that marker is still an unresolved reservation to review-ask-history's
    // lastManualAskAt, which reads it regardless of status. Every other
    // scheduled row cancels the existing way: physically deleted.
    //
    // Neither branch below reads the marker first and acts on that
    // snapshot: a plain SELECT here, followed by a separate DELETE/UPDATE,
    // left a window where the dispatch cron's claim (scheduler.js's
    // claimDueScheduledSms, a single conditional UPDATE WHERE status =
    // 'scheduled', on its own connection) could flip the row to 'sending',
    // attempt delivery, and requeue it back to 'scheduled' with the marker
    // now set, after this had already decided to delete. Matching the
    // cron's own shape instead closes it: the DELETE only fires when the
    // marker is NOT present in the SAME statement that checks status, and
    // the fallback UPDATE only matches a row the DELETE's own WHERE just
    // excluded (still status = 'scheduled', so the marker must be why) —
    // no instant where either statement acts on a snapshot the other could
    // have invalidated.
    let row = (await pinned(
      trx('sms_log').where({ id, status: 'scheduled' }),
      pins,
    )
      .whereRaw("COALESCE(metadata->>'review_ask_reservation', '') <> 'true'")
      .del(['id', 'metadata', 'created_at']))?.[0];
    if (!row) {
      // Either no matching row at all (claimed by the cron, already
      // resolved by another request, or rescheduled/retargeted past the
      // pinned CAS), or one that matched status = 'scheduled' (and the CAS
      // pins, if any) but carries the marker right now — the DELETE's own
      // WHERE excluded it for that reason. Cancel it in place instead of
      // deleting: a canceled row with the marker is still an unresolved
      // reservation to review-ask-history's lastManualAskAt, so the
      // 72-hour spacing hold survives.
      row = (await pinned(
        trx('sms_log').where({ id, status: 'scheduled' }),
        pins,
      )
        .update({ status: 'canceled', updated_at: new Date() }, ['id', 'metadata', 'created_at']))?.[0];
    }
    if (!row) {
      // Neither statement matched. With refuseWorkflowOwned, that can mean
      // a concurrent writer stamped a workflow-ownership marker onto this row
      // between the pre-check above and this transaction's own CAS
      // exclusion — surface that distinctly rather than reading as an
      // ordinary "nothing to do" race (the row is still left untouched
      // either way).
      if (refuseWorkflowOwned) {
        const current = await trx('sms_log').where({ id, status: 'scheduled' }).first('metadata');
        const owned = current && workflowOwnerOf(parseJson(current.metadata, {}));
        if (owned) workflowOwnedRace = owned;
      }
      return;
    }
    cancelledRow = row;

    const meta = parseJson(row.metadata, {});
    await reconcileCancelledRecruitingText(meta, trx);
    const decisionIds = [
      meta.agent_decision_id,
      ...(Array.isArray(meta.parked_decision_ids) ? meta.parked_decision_ids : []),
    ].filter(Boolean);
    if (!decisionIds.length) return;

    if (threadLast10) {
      // Another queued staff reply on this thread will still answer the
      // customer — reopening now would put an actionable card on top of
      // it. Re-park the decisions behind the surviving row: its fire
      // ignores them, its cancel/failure reopens them. Prefer a
      // still-'scheduled' sibling: a 'sending' one has been claimed by the
      // cron, which re-reads metadata after every terminal update — so a
      // transfer onto it still resolves, but an unclaimed row avoids even
      // that window. HUMAN_REPLY_TYPES includes 'manual', which a manual
      // send OR review-ask reservation also carries while 'sending' —
      // exclude reservations so a synthetic in-flight placeholder is never
      // mistaken for the surviving reply.
      const sibling = await excludeUnresolvedSendReservations(
        trx('sms_log')
          .whereIn('status', ['scheduled', 'sending'])
          .whereIn('message_type', HUMAN_REPLY_TYPES)
          .whereRaw("RIGHT(REGEXP_REPLACE(COALESCE(to_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [threadLast10]),
      )
        .orderByRaw("CASE WHEN status = 'scheduled' THEN 0 ELSE 1 END")
        .orderBy('scheduled_for', 'asc')
        .first('id');
      if (sibling) {
        await trx('sms_log')
          .where({ id: sibling.id })
          .update({
            metadata: trx.raw(
              `jsonb_set(COALESCE(metadata, '{}'::jsonb), '{parked_decision_ids}', COALESCE(metadata->'parked_decision_ids', '[]'::jsonb) || ?::jsonb)`,
              [JSON.stringify(decisionIds)],
            ),
          });
        return;
      }

      // No live sibling — but one may have JUST flipped sending→sent while
      // this cancel ran. The thread was answered since these decisions
      // were parked, so they resolve as ignored (drafts back to the
      // judge), not reopened onto an answered thread.
      const sentSibling = await trx('sms_log')
        .where({ direction: 'outbound' })
        .whereIn('status', ['queued', 'sent', 'delivered'])
        .whereIn('message_type', HUMAN_REPLY_TYPES)
        .whereRaw("RIGHT(REGEXP_REPLACE(COALESCE(to_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [threadLast10])
        .where('created_at', '>', row.created_at)
        .first('id');
      if (sentSibling) {
        await ignoreParkedSuggestions({ decisionIds, reviewedBy: technicianId || 'Admin' });
        return;
      }
    }

    // No surviving or just-sent reply — the customer was never answered,
    // the cards return to the composer.
    await reopenScheduledSuggestions({
      decisionIds,
      reason: 'Scheduled send cancelled from the SMS inbox — suggestion reopened.',
    });
  });

  if (workflowOwnedRace) return { outcome: 'workflow_owned', cancelled: false, row: null, workflow: workflowOwnedRace };
  return { outcome: 'ok', cancelled: !!cancelledRow, row: cancelledRow };
}

module.exports = {
  cancelScheduledSmsRow,
  PRIOR_ATTEMPT_KEY_RE,
  SIMPLE_SMS_META_KEYS,
  workflowOwnerOf,
};
