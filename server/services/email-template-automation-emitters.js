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
 * 20260928220000_email_template_automation_intents.js) written in the SAME
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
// the raw error's status/code (see isDeterministicAutomationError) — only
// what leaves the process is scrubbed.
function safeErrorText(err) {
  return scrubSentryText(err && err.message ? err.message : err);
}

// Deterministic (non-retryable) processTrigger failures settle a marker
// 'unrecoverable' on their FIRST occurrence — retrying the same marker
// against the same automation config can only fail the same way, and would
// just cost sweep work until the attempts ceiling (codex P2 rounds 3 + 4).
// Classified on the raw error's machine fields, never its message text:
//  - status 400: every validation/configuration error the executor throws
//    (recipientFor's no-resolvable-recipient-email error — a phone-only
//    lead/estimate, or a soft-deleted customer — a blank idempotency key
//    template, an idempotency key variable the payload never provides, a
//    malformed rendered key, a blank trigger key);
//  - the recipient error's code, as belt-and-braces should its status ever
//    change.
// Anything else (DB/connection/provider hiccups) is retried up to
// MAX_INTENT_ATTEMPTS below.
const RECIPIENT_EMAIL_REQUIRED_CODE = 'AUTOMATION_RECIPIENT_EMAIL_REQUIRED';
function isDeterministicAutomationError(err) {
  if (!err) return false;
  // Per-automation isolation (pre-live fix): processTrigger visits EVERY
  // automation on the trigger before rethrowing, tagging the error with each
  // automation's own failure. A failure of an automation's own CONFIGURATION
  // (blank/invalid idempotency template, a key variable the payload never
  // provides) is fixable in the admin editor, and the marker is SHARED by
  // every automation on the event — settling it 'unrecoverable' on the first
  // such 400 would leave the fixed automation (and any that failed
  // transiently) unable to ever replay the event. So it stays 'pending' for
  // the bounded retry budget (MAX_INTENT_ATTEMPTS, then the 24h shelf life);
  // only a failure set made ENTIRELY of the permanent recipient error (a
  // payload fact no automation edit can change) terminalizes immediately.
  if (Array.isArray(err.automationFailures) && err.automationFailures.length) {
    return err.automationFailures.every((f) => f && f.code === RECIPIENT_EMAIL_REQUIRED_CODE);
  }
  return err.code === RECIPIENT_EMAIL_REQUIRED_CODE || Number(err.status) === 400;
}

// Attempts ceiling for a marker (pre-push audit P1): every failed dispatch
// of a marker — the direct emit right after its transition AND each sweep
// replay — counts one attempt. A marker that keeps failing for ANY reason
// (not just the deterministic ones above) settles 'unrecoverable' with its
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
  if (!isEnabled('emailTemplateAutomations')) return null; // gate off: any marker stays 'pending' — replayed once the gate is live/shadow (within INTENT_MAX_AGE_MS)
  try {
    const AutomationExecutor = require('./email-template-automation-executor');
    const result = await AutomationExecutor.processTrigger({ triggerEventKey: eventKey, executeImmediately: true, ...args });
    // The executor's own off-mode no-op (codex P1 round 4): nothing was
    // evaluated, so the marker is NOT processed — leave it pending,
    // untouched (no attempt counted), for a replay once the mode is on.
    // Covers a mode flip between the gate read above and the executor's.
    if (result && result.disabled) return null;
    await settleIntent(intentId, { status: 'processed' });
    return result;
  } catch (err) {
    const failedKeys = Array.isArray(err && err.automationFailures)
      ? err.automationFailures.map((f) => f.automation_key).filter(Boolean)
      : [];
    const errorText = safeErrorText(err) + (failedKeys.length ? ` [automations: ${failedKeys.join(', ')}]` : '');
    if (isDeterministicAutomationError(err)) {
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

// Best-effort marker insert, isolated from the caller's transaction (codex
// P1 round 5 on #5154). In Postgres a failed statement aborts the WHOLE
// enclosing transaction even when the JS error is caught — so a bare insert
// that failed here (the intents table unavailable mid-rollout, a constraint
// surprise) would either roll back the caller's lifecycle transition (the
// estimate-expiry flip, the review attribution) at COMMIT, or leave the
// caller running further statements on an aborted transaction. A nested
// knex transaction is a SAVEPOINT: a failure rolls back only the marker
// insert and the caller's transition commits normally — the same isolation
// logRunEvent (email-template-automation-executor.js) already uses for its
// best-effort event rows.
//
// Losing a marker this way is a DELIBERATE, logged degradation, not a silent
// one: the marker is only the RECOVERY record. The direct emitter still runs
// right after the caller's commit (with no marker id, exactly as a caller
// with no outbox behaves), so the event is still delivered on the normal
// path; what is lost is only the sweep's retry should that direct emit ALSO
// fail. Failing the business transition (an estimate that never expires, a
// review that never attributes) over its automation bookkeeping would be the
// worse outcome — the automation catalog ships dark and is a secondary
// consumer of these transitions.
async function insertIntentRows(conn, rows) {
  const insert = (c) => c('email_template_automation_intents')
    .insert(rows)
    .onConflict(['trigger_event_key', 'entity_id', 'occurred_at'])
    .ignore()
    .returning(['id', 'entity_id']);
  if (conn && conn.isTransaction) return conn.transaction((sp) => insert(sp));
  return insert(conn || db);
}

function intentRow({ triggerEventKey, entityType, entityId, occurredAt, payload }) {
  return {
    trigger_event_key: triggerEventKey,
    entity_type: entityType,
    entity_id: String(entityId),
    occurred_at: occurredAt || new Date(),
    payload: JSON.stringify(payload || {}),
  };
}

// Records ONE durable intent marker for a transition — called by a
// transition's OWN transaction (conn = that trx), before any further
// processing, so a rollback of the transition rolls back the marker too.
// onConflict/ignore is defensive only: the (trigger_event_key, entity_id,
// occurred_at) values a real caller passes are unique per call in practice
// (occurred_at is that call's own `now`), so a genuine conflict only means
// the exact same transition was already durably recorded.
async function recordAutomationIntent(conn, entry) {
  try {
    const rows = await insertIntentRows(conn, intentRow(entry));
    return (rows && rows[0]) || null;
  } catch (err) {
    logger.warn(`[email-template-automation-emitters] failed to record intent for ${entry.triggerEventKey}/${entry.entityId}: ${safeErrorText(err)}`);
    return null;
  }
}

// Batch version — estimate-expiration.js flips many rows in one statement;
// this records all of their markers in that SAME transaction in one insert
// (one savepoint: a failure loses the batch's markers, never the flip).
async function recordAutomationIntents(conn, entries) {
  if (!entries || !entries.length) return [];
  try {
    return await insertIntentRows(conn, entries.map(intentRow));
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

// Replay shelf life (pre-push audit P1 on 37af26ca7b): a marker still
// 'pending' this long after its transition is never replayed — a lifecycle
// email days or weeks after the event (the backlog a mode flip off → live
// would otherwise release all at once: markers keep accumulating while the
// mode is 'off', and estimate.expired's only replay-time revalidation is
// status === 'expired', which stays true forever) is worse than none. Same
// precedent as the first-touch hold shelf life (FIRST_TOUCH_HOLD_MAX_AGE_DAYS:
// a first touch weeks late is never sent). 24h comfortably covers the whole
// retry budget (MAX_INTENT_ATTEMPTS ≈ 2h15m of 15-minute ticks) plus a
// deploy or an overnight outage. Such markers settle 'unrecoverable' with a
// 'stale' last_error (the status set stays pending | processed |
// unrecoverable) in ONE statement before the replay batch is read.
const INTENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STALE_INTENT_ERROR = 'stale: pending past the 24h replay shelf life — not replayed';

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
  const staleCutoff = new Date(Date.now() - INTENT_MAX_AGE_MS);
  try {
    await db('email_template_automation_intents')
      .where('status', 'pending')
      .where('occurred_at', '<', staleCutoff)
      .update({ status: 'unrecoverable', last_error: STALE_INTENT_ERROR, updated_at: new Date() });
  } catch (err) {
    // Fail closed: without the stale settle the batch below could replay a
    // weeks-old marker. Skip this tick; the next one tries again.
    logger.warn(`[email-template-automation-emitters] stale-intent settle failed: ${safeErrorText(err)}`);
    return 0;
  }
  let markers;
  try {
    markers = await db('email_template_automation_intents')
      .where('status', 'pending')
      .where('occurred_at', '>=', staleCutoff)
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
// marker recorded while off accumulates until the gate is live or shadow,
// then replays only while inside the 24h replay shelf life
// (INTENT_MAX_AGE_MS); older ones settle stale, never sent.
async function sweepMissedLifecycleEvents() {
  if (emailTemplateAutomationsMode() === 'off') return { intentsRetried: 0 };
  const { runExclusive } = require('../utils/cron-lock');
  return runExclusive('email-template-automation-lifecycle-sweep', async () => {
    const intentsRetried = await retryPendingIntents();
    return { intentsRetried };
  });
}

module.exports = {
  INTENT_MAX_AGE_MS,
  MAX_INTENT_ATTEMPTS,
  emitEstimateExpired,
  emitReviewLinked5Star,
  recordAutomationIntent,
  recordAutomationIntents,
  sweepMissedLifecycleEvents,
};
