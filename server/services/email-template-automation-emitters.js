/**
 * Small event → email_template_automation trigger emitters.
 *
 * Each direct emitter is a thin, NEVER-THROWING adapter from a real product
 * event to AutomationExecutor.processTrigger — a no-op whenever the
 * emailTemplateAutomations gate is off, so a producer that calls one of
 * these pays nothing when the whole catalog is dark. Only ids and the
 * minimal fields each trigger's condition/exit rules and idempotency key
 * need are passed; recipient EMAIL resolution is centralized in the
 * executor (processTrigger's resolveEmailForTrigger), not duplicated here.
 *
 * visit.completed_first and customer.churned are intentionally NOT wired
 * here yet — see the PR body for why (deferred to a follow-up PR).
 *
 * codex round 3 on #5154 — STRUCTURAL rewrite of the recovery sweep. Round 2
 * re-derived "missed events" by guessing from entity timestamps
 * (estimates.updated_at / google_reviews.updated_at), which turned out to be
 * inherently ambiguous: a staff repair of an already-linked review, or an
 * admin archiving an old expired estimate, both bump updated_at with no new
 * automation owed, and both looked exactly like a fresh event the sweep had
 * missed. Recovery now comes from a durable INTENT MARKER
 * (email_template_automation_intents, migration
 * 20260928120000_email_template_automation_intents.js) written in the SAME
 * transaction as the transition that earns it — the estimate-expiry flip
 * (estimate-expiration.js's flipExpiredBatch) and the review-attribution
 * writes (google-business.js's two sync paths, review-incentives.js's
 * manual-attribution branch) — never inferred afterwards from a timestamp.
 * The direct emitters still fire immediately after that same transaction
 * commits (low latency, unchanged UX); recordAutomationIntent(s) hands them
 * the marker's id so a success/failure settles that SAME row instead of the
 * sweep having to guess. retryPendingIntents (the new sweep) only replays
 * 'pending' markers past a short grace window — it never queries
 * estimates/google_reviews again. A marker fans out to every ACTIVE
 * automation on its trigger for free: processTrigger's own per-automation
 * idempotency-key dedupe (createRunUnlocked) means calling it again for a
 * trigger that already has SOME but not all of its automations' runs simply
 * creates the missing ones and dedupes the rest — no separate per-automation
 * correlation needed on this side (that was round 2's now-superseded
 * anti-join design).
 */
const db = require('../models/db');
const logger = require('./logger');
const { isEnabled, emailTemplateAutomationsMode } = require('../config/feature-gates');
const { scrubSentryText } = require('../utils/sentry-scrub');

// Every error text this module logs or persists (intents.last_error) goes
// through the shared PII scrubber first (pre-push audit P1): a Postgres
// constraint error or a provider error can echo the email/phone values it
// was handed, and Knex prefixes the failing SQL (quoted literals included)
// onto err.message. Classification never reads this text — it matches on
// the raw error's code (see isRecipientEmailRequired) — only what leaves
// the process is scrubbed.
function safeErrorText(err) {
  return scrubSentryText(err && err.message ? err.message : err);
}

// The one error recipientFor throws when no resolvable recipient email
// exists at all (executor.js) — a business-permanent condition (a
// phone-only lead/estimate with no email on file), not a transient one.
// Retrying this exact marker would only let it pin an ordered, limited
// sweep batch (codex P2 round 3) — so this error settles a marker
// 'unrecoverable' on its FIRST failure; every other failure is retried up to
// MAX_INTENT_ATTEMPTS below.
// Matched on the executor's error CODE first (a stable machine token), with
// the message as a fallback for any thrower that predates the code.
const RECIPIENT_EMAIL_REQUIRED_CODE = 'AUTOMATION_RECIPIENT_EMAIL_REQUIRED';
const RECIPIENT_EMAIL_REQUIRED_MESSAGE = 'recipient email is required for automation execution';
function isRecipientEmailRequired(err) {
  return Boolean(err) && (err.code === RECIPIENT_EMAIL_REQUIRED_CODE || err.message === RECIPIENT_EMAIL_REQUIRED_MESSAGE);
}

// Attempts ceiling for a marker (pre-push audit P1): every failed dispatch
// of a marker — the direct emit right after its transition AND each sweep
// replay — counts one attempt. A marker that fails for ANY reason (not just
// the recipient-email-required case above) settles 'unrecoverable' with its
// scrubbed last_error on its MAX_INTENT_ATTEMPTS-th failure, so no
// persistent failure can keep a row 'pending' forever. 10 = the direct
// attempt plus nine 15-minute sweep ticks, ~2h15m of retrying: long enough
// to ride out a deploy, a DB failover or a provider incident, short enough
// that a genuinely broken marker stops costing sweep work the same
// afternoon. The sweep ALSO orders by attempts first (retryPendingIntents),
// so even before the ceiling a repeatedly failing row sorts behind every
// fresher marker instead of pinning the head of the LIMIT batch.
const MAX_INTENT_ATTEMPTS = 10;

async function settleIntent(intentId, patch) {
  if (!intentId) return;
  try {
    await db('email_template_automation_intents').where({ id: intentId }).update({ ...patch, updated_at: new Date() });
  } catch (err) {
    logger.warn(`[email-template-automation-emitters] failed to settle intent ${intentId}: ${safeErrorText(err)}`);
  }
}

// One failed dispatch attempt: bump attempts and keep the marker 'pending'
// for another try, or settle it 'unrecoverable' once this failure reaches
// MAX_INTENT_ATTEMPTS. Decided in ONE statement (Postgres evaluates every
// SET expression against the pre-update row, so the CASE sees the same
// attempts value the increment starts from) — no read-modify-write race
// between a direct emit and a concurrent sweep replay of the same marker.
async function recordFailedAttempt(intentId, errorText) {
  await settleIntent(intentId, {
    status: db.raw("CASE WHEN attempts + 1 >= ? THEN 'unrecoverable' ELSE 'pending' END", [MAX_INTENT_ATTEMPTS]),
    last_error: String(errorText || '').slice(0, 2000),
    attempts: db.raw('attempts + 1'),
  });
}

// A marker whose own payload fails the emitter's eligibility guard can never
// dispatch on any retry — settle it now (gate-independent: this is a fact
// about the stored payload, not about the rollout). No-op without a marker,
// so a plain direct call with an ineligible event still touches nothing.
async function settleUndispatchable(intentId, reason) {
  if (!intentId) return;
  await settleIntent(intentId, { status: 'unrecoverable', last_error: reason, attempts: db.raw('attempts + 1') });
}

// intentId is optional (a caller with no marker — e.g. a future direct
// emitter that hasn't adopted the outbox yet — behaves exactly as before).
async function emitTrigger(eventKey, args, intentId = null) {
  if (!isEnabled('emailTemplateAutomations')) return null; // gate off: any marker stays 'pending' — replayed once the gate is live/shadow
  try {
    const AutomationExecutor = require('./email-template-automation-executor');
    const result = await AutomationExecutor.processTrigger({ triggerEventKey: eventKey, executeImmediately: true, ...args });
    await settleIntent(intentId, { status: 'processed' });
    return result;
  } catch (err) {
    const errorText = safeErrorText(err);
    if (isRecipientEmailRequired(err)) {
      await settleIntent(intentId, { status: 'unrecoverable', last_error: errorText, attempts: db.raw('attempts + 1') });
    } else {
      await recordFailedAttempt(intentId, errorText);
    }
    logger.warn(`[email-template-automation-emitters] ${eventKey} emit failed: ${errorText}`);
    return null;
  }
}

// estimate.expired — fired once per row estimate-expiration.js's
// flipExpiredBatch flips, immediately after that row's own transaction
// (which also recorded the intent marker below) commits.
async function emitEstimateExpired({ id, customer_id: customerId, customer_email: customerEmail, category, service_interest: serviceInterest, expires_at: expiresAt } = {}, intentId = null) {
  if (!id) {
    // A marker whose payload can never be dispatched is settled, never left
    // pending to pin the sweep batch.
    await settleUndispatchable(intentId, 'marker payload has no estimate id');
    return null;
  }
  return emitTrigger('estimate.expired', {
    triggerEventId: `estimate_expired:${id}`,
    entityType: 'estimate',
    entityId: id,
    recipient: { type: customerId ? 'customer' : 'lead', id: customerId || '', email: customerEmail || '' },
    payload: {
      estimate_id: id,
      customer_id: customerId || '',
      customer_email: customerEmail || '',
      category: category || '',
      service_interest: serviceInterest || '',
      expires_at: expiresAt || null,
    },
  }, intentId);
}

// review.linked_5star — fired at both google-business.js review-attribution
// sites (the hourly GBP feed sync and the Places fallback sync) and
// review-incentives.js's manual-attribution branch, 5-star only, on the same
// "just attributed to a customer" moment the shared enrollReviewThankYou
// thank-you sequence fires on. Every call site records its own intent
// marker inside the SAME transaction as the attribution write and passes
// its id through.
async function emitReviewLinked5Star({ reviewId, customerId, locationId, starRating }, intentId = null) {
  if (!customerId || !reviewId || Number(starRating) !== 5) {
    await settleUndispatchable(intentId, 'marker payload is not a linked 5-star review');
    return null;
  }
  return emitTrigger('review.linked_5star', {
    triggerEventId: `review_linked_5star:${reviewId}`,
    entityType: 'review',
    entityId: reviewId,
    recipient: { type: 'customer', id: customerId },
    payload: { review_id: reviewId, customer_id: customerId, location_id: locationId || '' },
  }, intentId);
}

// Records ONE durable intent marker for a transition — called by a
// transition's OWN transaction (conn = that trx), before any further
// processing, so a rollback of the transition rolls back the marker too.
// onConflict/ignore is defensive only: the (trigger_event_key, entity_id,
// occurred_at) values a real caller passes are unique per call in practice
// (occurred_at is that call's own `now`), so a genuine conflict only means
// the exact same transition was already durably recorded.
async function recordAutomationIntent(conn, {
  triggerEventKey, entityType, entityId, occurredAt, payload,
}) {
  try {
    const rows = await conn('email_template_automation_intents')
      .insert({
        trigger_event_key: triggerEventKey,
        entity_type: entityType,
        entity_id: String(entityId),
        occurred_at: occurredAt || new Date(),
        payload: JSON.stringify(payload || {}),
      })
      .onConflict(['trigger_event_key', 'entity_id', 'occurred_at'])
      .ignore()
      .returning(['id', 'entity_id']);
    return (rows && rows[0]) || null;
  } catch (err) {
    logger.warn(`[email-template-automation-emitters] failed to record intent for ${triggerEventKey}/${entityId}: ${safeErrorText(err)}`);
    return null;
  }
}

// Batch version — estimate-expiration.js flips many rows in one statement;
// this records all of their markers in that SAME transaction in one insert.
async function recordAutomationIntents(conn, entries) {
  if (!entries || !entries.length) return [];
  try {
    return await conn('email_template_automation_intents')
      .insert(entries.map((e) => ({
        trigger_event_key: e.triggerEventKey,
        entity_type: e.entityType,
        entity_id: String(e.entityId),
        occurred_at: e.occurredAt || new Date(),
        payload: JSON.stringify(e.payload || {}),
      })))
      .onConflict(['trigger_event_key', 'entity_id', 'occurred_at'])
      .ignore()
      .returning(['id', 'entity_id']);
  } catch (err) {
    logger.warn(`[email-template-automation-emitters] failed to record intents: ${safeErrorText(err)}`);
    return [];
  }
}

// A marker gets this much grace before the sweep will retry it — long
// enough that the direct emitter called right after the SAME transition's
// transaction has certainly already run (that call is synchronous, not
// queued), short enough that a genuinely missed event (the direct call
// never ran at all — process crash between commit and the emit call) is
// still recovered well inside the trigger's own delay/condition windows.
// Correctness does not depend on this value: processTrigger's own
// idempotency-key dedupe makes a redundant concurrent retry harmless either
// way (see the file banner) — this is purely to avoid the sweep racing an
// emit call that is still in flight.
const INTENT_MIN_AGE_MS = 5 * 60 * 1000;
const INTENT_ROW_LIMIT = 100;

// The retry safety net (codex P2 x2 round 2, restructured P1 x3 + P2 round
// 3, attempts ceiling pre-push audit P1): replays 'pending' intent markers.
// No row can pin the LIMIT window: every marker the loop visits leaves it
// either settled (processed / unrecoverable) or with attempts + 1 — an
// unknown trigger key and an unexpected throw count as failed attempts too —
// and the ORDER BY puts the fewest-attempted markers first (oldest first
// within a tier), so a repeatedly failing row falls behind every fresher
// marker on the very next tick and leaves 'pending' altogether at
// MAX_INTENT_ATTEMPTS.
async function retryPendingIntents() {
  // Mirrors emitTrigger's own gate read: with the boolean gate off every
  // replay would be a no-op that settles nothing, so don't query at all.
  if (!isEnabled('emailTemplateAutomations')) return 0;
  let markers;
  try {
    markers = await db('email_template_automation_intents')
      .where('status', 'pending')
      .where('occurred_at', '<=', new Date(Date.now() - INTENT_MIN_AGE_MS))
      .orderBy([{ column: 'attempts', order: 'asc' }, { column: 'occurred_at', order: 'asc' }])
      .limit(INTENT_ROW_LIMIT);
  } catch (err) {
    logger.warn(`[email-template-automation-emitters] pending-intent query failed: ${safeErrorText(err)}`);
    return 0;
  }
  let retried = 0;
  for (const marker of markers) {
    try {
      const payload = typeof marker.payload === 'string' ? JSON.parse(marker.payload) : (marker.payload || {});
      let result = null;
      if (marker.trigger_event_key === 'estimate.expired') {
        result = await emitEstimateExpired(payload, marker.id);
      } else if (marker.trigger_event_key === 'review.linked_5star') {
        result = await emitReviewLinked5Star({
          reviewId: payload.review_id, customerId: payload.customer_id, locationId: payload.location_id, starRating: payload.star_rating,
        }, marker.id);
      } else {
        // A marker for a trigger key this module has no replay logic for
        // (e.g. written by a newer build mid rolling deploy) — counted as a
        // failed attempt rather than dropped outright, so a build that DOES
        // know the key still gets its window; the attempts ceiling settles
        // it if none ever does, and it never pins the batch meanwhile.
        await recordFailedAttempt(marker.id, `no replay handler for trigger ${marker.trigger_event_key}`);
        continue;
      }
      if (result) retried += 1;
    } catch (err) {
      const errorText = safeErrorText(err);
      await recordFailedAttempt(marker.id, errorText);
      logger.warn(`[email-template-automation-emitters] pending-intent retry failed for ${marker.id}: ${errorText}`);
    }
  }
  return retried;
}

// Scheduler entry point (every 15 min, runExclusive-wrapped by the caller
// or here — wrapped HERE so a direct test/manual call gets the same
// single-flight guarantee as the cron tick). No-op, no query at all, when
// the mode is 'off' — matches every other reader's off-mode contract; a
// marker recorded while off simply accumulates until the gate is live or
// shadow, then replays.
async function sweepMissedLifecycleEvents() {
  if (emailTemplateAutomationsMode() === 'off') return { intentsRetried: 0 };
  const { runExclusive } = require('../utils/cron-lock');
  return runExclusive('email-template-automation-lifecycle-sweep', async () => {
    const intentsRetried = await retryPendingIntents();
    return { intentsRetried };
  });
}

module.exports = {
  MAX_INTENT_ATTEMPTS,
  emitEstimateExpired,
  emitReviewLinked5Star,
  recordAutomationIntent,
  recordAutomationIntents,
  sweepMissedLifecycleEvents,
};
