const cron = require('node-cron');
const db = require('../models/db');
// Boundary-rotation generation guard (codex #3233 r37/r38): captured at
// process startup, NOT at query-build time — a marker stamped after this
// instant belongs to a newer gate-on pod and must never be deleted.
const PROCESS_BOOT_AT = new Date();
const TwilioService = require('./twilio');
const logger = require('./logger');
const { etDateString, addETDays, etParts, parseETDateTime } = require('../utils/datetime-et');
const { dateOnlyString } = require('../utils/date-only');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { isEnabled, gateEnvValue } = require('../config/feature-gates');
const { runExclusive } = require('../utils/cron-lock');

const SCHEDULED_SMS_CLAIM_LIMIT = 20;
const SCHEDULED_SMS_STALE_CLAIM_MS = 30 * 60 * 1000;
const SCHEDULED_SMS_MAX_ATTEMPTS = 3;
const SCHEDULED_ESTIMATE_CLAIM_LIMIT = 20;
const SCHEDULED_ESTIMATE_STALE_CLAIM_MS = 30 * 60 * 1000;
const SCHEDULED_ESTIMATE_MAX_ATTEMPTS = 3;
const SCHEDULED_ESTIMATE_RETRY_DELAY_MS = 5 * 60 * 1000;
const CONTENT_REGISTRY_LIVE_STATUSES = ['matched', 'db_changed_since_sync', 'conflict', 'db_published_missing_astro'];
const CONTENT_REGISTRY_LIVE_LIMIT = 300;

function purposeForScheduledMessageType(messageType, { hasCustomer = true } = {}) {
  const type = String(messageType || '').toLowerCase();
  // Deposit receipts requeued from a quiet-hours hold must replay under the
  // same policy the immediate send enforced: payment_receipt (prefs-gated)
  // for customer-linked rows; lead rows have no customerId so they replay
  // under the transactional-grade conversational policy with the forwarded
  // consent basis — payment_receipt would hard-require a customerId.
  if (type === 'deposit_receipt') return hasCustomer ? 'payment_receipt' : 'conversational';
  // Deferred completion texts (service_complete*, service_report_v1*) replay
  // under the appointment purpose the immediate dispatch send enforced.
  // Checked BEFORE the billing branch: service_complete_with_invoice would
  // otherwise match includes('invoice') and replay under the wrong policy.
  if (type.includes('service_complete') || type.includes('service_report')) return 'appointment';
  if (type.includes('billing') || type.includes('payment') || type.includes('invoice')) return 'billing';
  if (type.includes('review')) return 'review_request';
  if (type.includes('referral')) return 'referral';
  if (type.includes('retention') || type.includes('renewal') || type.includes('save')) return 'retention';
  if (type.includes('marketing') || type.includes('seasonal') || type.includes('promo')) return 'marketing';
  // 'prep' covers prep_info — the deferred booking-time prep text requeued
  // from a quiet-hours hold replays under the same appointment policy the
  // immediate send enforced.
  if (type.includes('appointment') || type.includes('reminder') || type.includes('confirmation') || type.includes('en_route') || type.includes('prep')) return 'appointment';
  // Deferred voicemail text-back (voicemail_quote_link) must re-send under its
  // own purpose, not fall through to conversational, so the policy re-check at
  // dispatch keeps a re-queued row honest.
  if (type.includes('voicemail') || type.includes('missed_call')) return 'missed_call_followup';
  // Quiet-hours-held estimate follow-up legs replay under the same purpose
  // the immediate dual-channel send enforced.
  if (type.includes('estimate')) return 'estimate_followup';
  return 'conversational';
}

// Rows queued with refresh_customer_phone (deposit-receipt retries) re-read
// the customer's CURRENT phone at send time — the queued number was frozen at
// hold time, and the phone_matches_customer trust the cron asserts for
// customer rows must ride a number that still comes from the customer row,
// not a snapshot the customer may have since changed. Returns null when the
// refresh is required but the current phone can't be verified (lookup error
// or the customer no longer has one) — falling back to the snapshot would
// reintroduce exactly the staleness the flag exists to prevent, so the cron
// retries the row instead of sending.
async function resolveScheduledRecipient(msg, claimMeta) {
  // Rows whose refresh-vs-freeze decision could not be made at enqueue
  // (transient identity-lookup failure, codex #3259 r24) re-run it here:
  // send only when the live account phone still matches the snapshot
  // (refresh semantics); ambiguity or another lookup failure returns null
  // onto the bounded-retry-then-terminal rail — never a guess that could
  // hand a bearer link to the wrong person.
  if (claimMeta?.recipient_identity_unverified === true && msg.customer_id) {
    const { resolveUnverifiedRecipient } = require('./messaging/deferred-recipient-identity');
    const resolved = await resolveUnverifiedRecipient({
      customerId: msg.customer_id,
      snapshotPhone: msg.to_phone,
      label: 'scheduled-sms',
    });
    return resolved.phone;
  }
  if (claimMeta?.refresh_customer_phone !== true || !msg.customer_id) return msg.to_phone;
  try {
    const freshCustomer = await db('customers').where({ id: msg.customer_id }).first('phone');
    return String(freshCustomer?.phone || '').trim() || null;
  } catch {
    return null;
  }
}

// Deposit-receipt replays re-check payment_receipt_channel at send time —
// the immediate send honors the channel choice, and a customer who switches
// to email-only between the hold and scheduled_for must not be texted by the
// retry. Fail-open to 'sms' on a lookup error, matching the immediate path's
// default. Non-receipt rows and lead rows pass through untouched.
async function scheduledDepositReceiptAllowed(msg) {
  if (!msg.customer_id || String(msg.message_type || '').toLowerCase() !== 'deposit_receipt') return true;
  try {
    const prefs = await db('notification_prefs')
      .where({ customer_id: msg.customer_id })
      .first('payment_receipt_channel');
    const channel = prefs?.payment_receipt_channel || 'sms';
    return channel === 'sms' || channel === 'both';
  } catch {
    return true;
  }
}

// Outcome classification for the deposit-receipt replay email handoff:
//   'handled'      — the email carried the receipt (or the customer opted out
//                    of receipts entirely): block the queued text.
//   'sms_fallback' — the email leg is DETERMINISTICALLY undeliverable: the
//                    queued text proceeds, mirroring the immediate path's
//                    undeliverable-email SMS fallback (the send pipeline
//                    re-checks every current opt-out itself).
//   'retry'        — transient (prefs lookup blip / provider error): keep the
//                    row on the bounded retry rail so the handoff reruns.
function classifyDepositReplayFallback(fb = {}) {
  if (fb.sent === true || fb.reason === 'receipt_opted_out') return 'handled';
  if (['email_opted_out', 'no_recipient_email', 'sendgrid_not_configured', 'no_received_deposit', 'estimate_not_found', 'no_estimate_ref'].includes(fb.reason)) {
    return 'sms_fallback';
  }
  return 'retry';
}

function scheduledSmsAttemptSql() {
  return `
    CASE
      WHEN COALESCE(metadata->>'scheduled_sms_attempts', '') ~ '^[0-9]+$'
        THEN (metadata->>'scheduled_sms_attempts')::int
      ELSE 0
    END
  `;
}

async function recoverStaleScheduledSmsClaims(now) {
  const staleBefore = new Date(now.getTime() - SCHEDULED_SMS_STALE_CLAIM_MS);
  const attemptsSql = scheduledSmsAttemptSql();
  const { DURABLE_FINALIZE_ENTRY_POINTS, TERMINAL_HOOK_ENTRY_POINTS } = require('./messaging/deferred-replay-registry');
  const DURABLE_FINALIZE_PLACEHOLDERS = DURABLE_FINALIZE_ENTRY_POINTS.map(() => '?').join(', ') || "''";
  const TERMINAL_HOOK_PLACEHOLDERS = TERMINAL_HOOK_ENTRY_POINTS.map(() => '?').join(', ') || "''";

  // Settle stale claims whose send PROVABLY happened first: the provider
  // path writes a sibling sms_log row tagged with scheduled_sms_log_id when
  // Twilio accepts. Blindly re-scheduling those would double-text the
  // customer, and failing them would reopen Agent Review decisions on an
  // answered thread. Mirrors the normal sent path (created_at re-stamped to
  // send time, queued_at preserved).
  const settled = await db.raw(`
    UPDATE sms_log AS s
    SET status = 'sent',
        created_at = ?,
        updated_at = ?,
        metadata = COALESCE(s.metadata, '{}'::jsonb) || jsonb_build_object(
          'queued_at', s.created_at,
          'scheduled_sms_recovered_sent_at', ?::timestamptz
        )
        -- Deferred replays settled here crashed BETWEEN Twilio's accept and
        -- the normal settlement, so their delivery-time finalization
        -- (invoice flip, review mark, lead stamps, claim settlement) never
        -- ran and the normal path's finalize_pending stamp was never
        -- written. Stamp it now so the stranded-finalization sweep converts
        -- them to finalize_only retries. The entry-point list comes from
        -- the deferred-replay registry (durableFinalize entries). The
        -- provider row's accepted SID rides along: finalizers that settle
        -- once-ever claims key on it, and a SID-less retry would release
        -- a claim for a message Twilio already accepted.
        || CASE
          WHEN s.metadata->>'entry_point' IN (${DURABLE_FINALIZE_PLACEHOLDERS})
            THEN jsonb_build_object('finalize_pending', true, 'provider_message_id', (
              SELECT p.twilio_sid FROM sms_log p
              WHERE p.metadata->>'scheduled_sms_log_id' = s.id::text
                AND p.direction = 'outbound'
                AND p.status IN ('queued', 'sent', 'delivered')
              ORDER BY p.created_at DESC
              LIMIT 1
            ))
          ELSE '{}'::jsonb
        END
    WHERE s.status = 'sending'
      AND s.scheduled_for IS NOT NULL
      AND s.scheduled_for <= ?
      AND s.updated_at <= ?
      AND EXISTS (
        SELECT 1 FROM sms_log p
        WHERE p.metadata->>'scheduled_sms_log_id' = s.id::text
          AND p.direction = 'outbound'
          AND p.status IN ('queued', 'sent', 'delivered')
      )
    RETURNING s.id, s.metadata, s.message_body, s.admin_user_id
  `, [now, now, now, ...DURABLE_FINALIZE_ENTRY_POINTS, now, staleBefore]);

  const settledRows = settled.rows || [];
  if (settledRows.length > 0) {
    logger.warn(`[scheduled-sms] Settled ${settledRows.length} stale claim(s) whose provider send already happened`);
    const { resolveSuggestionAfterSend, ignoreParkedSuggestions } = require('./sms-suggest-mode');
    for (const row of settledRows) {
      let meta = row.metadata;
      if (typeof meta === 'string') {
        try { meta = JSON.parse(meta); } catch { meta = {}; }
      }
      meta = meta || {};
      if (meta.agent_decision_id) {
        await resolveSuggestionAfterSend({
          decisionId: meta.agent_decision_id,
          sentBody: row.message_body,
          reviewedBy: row.admin_user_id || 'Admin',
        });
      }
      if (Array.isArray(meta.parked_decision_ids) && meta.parked_decision_ids.length) {
        await ignoreParkedSuggestions({
          decisionIds: meta.parked_decision_ids,
          reviewedBy: row.admin_user_id || 'Admin',
        });
      }
    }
  }

  const result = await db.raw(`
    UPDATE sms_log
    SET status = CASE
          WHEN ${attemptsSql} >= ? THEN 'failed'
          ELSE 'scheduled'
        END,
        updated_at = ?,
        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
          'scheduled_sms_recovered_at', ?::timestamptz
        )
        -- terminal_pending rides the failed flip ATOMICALLY (same contract
        -- as finalize_pending above): the terminal hook runs right after
        -- this recovery, and a crash/throwing hook must leave a durable
        -- obligation the terminal-hook sweep can find. Entry-point list =
        -- registry entries with an onTerminal hook.
        || CASE
          WHEN ${attemptsSql} >= ? AND COALESCE(metadata->>'entry_point', '') IN (${TERMINAL_HOOK_PLACEHOLDERS})
            THEN jsonb_build_object('terminal_pending', true)
          ELSE '{}'::jsonb
        END
    WHERE status = 'sending'
      AND scheduled_for IS NOT NULL
      AND scheduled_for <= ?
      AND updated_at <= ?
    RETURNING id, status, metadata
  `, [SCHEDULED_SMS_MAX_ATTEMPTS, now, now, SCHEDULED_SMS_MAX_ATTEMPTS, ...TERMINAL_HOOK_ENTRY_POINTS, now, staleBefore]);

  const recovered = result.rows || [];
  if (recovered.length > 0) {
    const retryCount = recovered.filter(row => row.status === 'scheduled').length;
    const failedCount = recovered.filter(row => row.status === 'failed').length;
    logger.warn(`[scheduled-sms] Recovered ${recovered.length} stale claim(s): ${retryCount} retried, ${failedCount} failed`);

    // Rows that exhausted their attempts will never send — any Agent Review
    // decisions parked behind them must return to the composer now, not
    // after the 48h expiry sweep, and any deferred-replay obligation must
    // hand off per its registry terminal hook (release once-ever claims,
    // arm review fallbacks, flip referral/report state into the admin
    // lane — otherwise those stay falsely successful forever). Retried
    // rows keep their decisions parked and their obligations queued.
    const decisionIds = [];
    for (const row of recovered) {
      if (row.status !== 'failed') continue;
      let meta = row.metadata;
      if (typeof meta === 'string') {
        try { meta = JSON.parse(meta); } catch { meta = {}; }
      }
      meta = meta || {};
      if (meta.agent_decision_id) decisionIds.push(meta.agent_decision_id);
      if (Array.isArray(meta.parked_decision_ids)) decisionIds.push(...meta.parked_decision_ids);
      if (meta.entry_point) {
        const { runTerminalHookDurably } = require('./messaging/deferred-replay-registry');
        await runTerminalHookDurably(row.id, meta.entry_point, meta);
      }
    }
    if (decisionIds.length) {
      await require('./sms-suggest-mode').reopenScheduledSuggestions({
        decisionIds,
        reason: 'Scheduled send failed after repeated claim timeouts — suggestion reopened.',
      });
    }
  }
}

async function claimDueScheduledSms(now) {
  const result = await db.raw(`
    WITH due AS (
      SELECT id
      FROM sms_log
      WHERE status = 'scheduled'
        AND scheduled_for IS NOT NULL
        AND scheduled_for <= ?
      ORDER BY scheduled_for ASC, created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ?
    )
    UPDATE sms_log AS s
    SET status = 'sending',
        updated_at = ?,
        metadata = COALESCE(s.metadata, '{}'::jsonb) || jsonb_build_object(
          'scheduled_sms_claimed_at', ?::timestamptz,
          'scheduled_sms_attempts',
          CASE
            WHEN COALESCE(s.metadata->>'scheduled_sms_attempts', '') ~ '^[0-9]+$'
              THEN (s.metadata->>'scheduled_sms_attempts')::int + 1
            ELSE 1
          END
        )
    FROM due
    WHERE s.id = due.id
    RETURNING s.*
  `, [now, SCHEDULED_SMS_CLAIM_LIMIT, now, now]);

  return result.rows || [];
}

async function recoverStaleScheduledEstimateClaims(now) {
  const staleBefore = new Date(now.getTime() - SCHEDULED_ESTIMATE_STALE_CLAIM_MS);
  const result = await db.raw(`
    UPDATE estimates
    SET status = CASE
          WHEN COALESCE(scheduled_send_attempts, 0) >= ? THEN 'send_failed'
          ELSE 'scheduled'
        END,
        last_send_error = COALESCE(last_send_error, 'Scheduled estimate send claim timed out'),
        updated_at = ?
    WHERE status = 'sending'
      AND scheduled_at IS NOT NULL
      AND updated_at <= ?
    RETURNING status
  `, [SCHEDULED_ESTIMATE_MAX_ATTEMPTS, now, staleBefore]);

  const recovered = result.rows || [];
  if (recovered.length > 0) {
    const retryCount = recovered.filter(row => row.status === 'scheduled').length;
    const failedCount = recovered.filter(row => row.status === 'send_failed').length;
    logger.warn(`[scheduled-estimates] Recovered ${recovered.length} stale claim(s): ${retryCount} retried, ${failedCount} failed`);
  }

  // Immediate sends (POST /:id/send) claim the row as `sending` for the
  // duration of the send and release it in the route, but a hard crash between
  // the claim and the release would strand the estimate as `sending` — with no
  // scheduled_at, the sweep above never touches it. An immediate send completes
  // in seconds, so any `sending` row with no scheduled_at older than the stale
  // window is a crashed send; surface it as `send_failed` so it stays editable
  // and re-sendable rather than permanently locked.
  //
  // EXCLUDE lead-auto-send claims: they reuse the same row shape
  // (source='lead_webhook', status='sending', no scheduled_at) but have their
  // OWN recovery that returns an unattempted claim to `draft` for retry. Leave
  // a row that still has an unattempted autoSend claim to that recovery so a
  // crashed auto-send isn't downgraded to a manual `send_failed`.
  const immediate = await db.raw(`
    UPDATE estimates
    SET status = 'send_failed',
        last_send_error = COALESCE(last_send_error, 'Immediate estimate send was interrupted'),
        updated_at = ?
    WHERE status = 'sending'
      AND scheduled_at IS NULL
      AND updated_at <= ?
      AND NOT (
        source = 'lead_webhook'
        AND COALESCE(
          estimate_data->'automation'->'autoSend'->>'claimedAt',
          estimate_data->'automation'->'autoSend'->>'claimed_at'
        ) IS NOT NULL
        AND estimate_data->'automation'->'autoSend'->>'attemptedAt' IS NULL
        AND estimate_data->'automation'->'autoSend'->>'attempted_at' IS NULL
        AND estimate_data->'automation'->'autoSend'->>'blockedAt' IS NULL
        AND estimate_data->'automation'->'autoSend'->>'blocked_at' IS NULL
      )
    RETURNING id
  `, [now, staleBefore]);
  const immediateRows = immediate.rows || [];
  if (immediateRows.length > 0) {
    logger.warn(`[scheduled-estimates] Recovered ${immediateRows.length} stale immediate send claim(s) to send_failed`);
  }

  // Wedged DEFERRED invalidations (codex P1, PR #3304): when a linkage
  // correction lands during a live delivery claim, the reconciler records
  // `invalidation_pending_*` and the send's claim release completes it. A
  // crash between the two leaves the estimate permanently stuck — every
  // send aborts on the pending marker with a non-matching claim token, the
  // former lead stays linked, and no corrected rebuild exists. The status
  // recoveries above don't touch estimate_data, so finish the transition
  // here once the claim is past its TTL. Best-effort: a failure logs and
  // the next sweep retries.
  try {
    const { sweepWedgedPendingInvalidations } = require('./admin-estimate-persistence');
    await sweepWedgedPendingInvalidations(now.getTime());
  } catch (err) {
    logger.warn(`[scheduled-estimates] wedged pending-invalidation sweep failed: ${err.message}`);
  }

  // Queued draft QUARANTINES (codex P0, PR #3304): when an identity
  // conflict or a rejected-call verdict could not persist its invalidation
  // — a transient DB outage during a fire-and-forget estimator pass — the
  // processor stamps the call and this drains the queue until the marker
  // lands. Without it the unmarked draft keeps a live public token.
  try {
    const { sweepPendingQuarantines, sweepPendingReconciles } = require('./estimator-engine');
    await sweepPendingQuarantines();
    // Reconcile-retry queue (local audit P0, PR #3304): reconcile-only
    // failures on settled calls have no other retry path.
    await sweepPendingReconciles();
  } catch (err) {
    logger.warn(`[scheduled-estimates] pending-quarantine sweep failed: ${err.message}`);
  }
}

async function claimDueScheduledEstimates(now) {
  // One claim per estimate GROUP per batch (codex #3244 r2): sending any
  // group member publishes its siblings with ONE customer message, so
  // claiming two due siblings in the same batch would deliver two messages —
  // and pre-claiming both to 'sending' would also hide each from the other's
  // group pre-flight. DISTINCT ON keeps only the earliest-due member of each
  // group in the claim; its send flips the still-'scheduled' siblings to
  // published, so they never come due on their own.
  const result = await db.raw(`
    WITH ranked AS (
      SELECT id,
             row_number() OVER (
               PARTITION BY COALESCE(estimate_group_id::text, id::text)
               ORDER BY scheduled_at ASC, created_at ASC
             ) AS rn
      FROM estimates AS c
      WHERE status = 'scheduled'
        AND scheduled_at IS NOT NULL
        -- Archived rows never send (codex P0, PR #3304): linkage
        -- invalidation archives stale wrong-lead drafts, and the cron
        -- must not claim one scheduled before that commit.
        AND archived_at IS NULL
        AND scheduled_at <= ?
        -- Cross-process guard (codex #3244 r3): once any member of a group is
        -- mid-send (another pod's batch), the whole group is spoken for — its
        -- send publishes the rest. Claiming a second member here would only
        -- burn attempts against the pre-flight 409.
        AND NOT EXISTS (
          SELECT 1 FROM estimates s
          WHERE c.estimate_group_id IS NOT NULL
            AND s.estimate_group_id = c.estimate_group_id
            AND s.status = 'sending'
        )
    ), due AS (
      SELECT e.id
      FROM estimates e
      JOIN ranked r ON r.id = e.id AND r.rn = 1
      WHERE e.status = 'scheduled'
        AND e.scheduled_at IS NOT NULL
        -- Repeated at every stage (codex P1, PR #3304): ranked's snapshot
        -- can predate a concurrent archive, and EvalPlanQual re-evaluates
        -- the locked row against THIS stage's predicate — without the
        -- guard here (and on the final UPDATE) an archiving that landed
        -- mid-claim would still deliver the invalidated content.
        AND e.archived_at IS NULL
        AND e.scheduled_at <= ?
      ORDER BY e.scheduled_at ASC, e.created_at ASC
      FOR UPDATE OF e SKIP LOCKED
      LIMIT ?
    )
    UPDATE estimates AS e
    SET status = 'sending',
        scheduled_send_attempts = COALESCE(e.scheduled_send_attempts, 0) + 1,
        last_send_error = NULL,
        updated_at = ?
    FROM due
    WHERE e.id = due.id
      AND e.archived_at IS NULL
    RETURNING e.*
  `, [now, now, SCHEDULED_ESTIMATE_CLAIM_LIMIT, now]);

  return result.rows || [];
}

async function markScheduledEstimateSendFailure(est, errorMessage, { retry = false, now = new Date() } = {}) {
  const attempts = Number(est.scheduled_send_attempts || 0);
  const shouldRetry = retry && attempts < SCHEDULED_ESTIMATE_MAX_ATTEMPTS;
  await db('estimates')
    .where({ id: est.id, status: 'sending' })
    .update({
      status: shouldRetry ? 'scheduled' : 'send_failed',
      scheduled_at: shouldRetry ? new Date(now.getTime() + SCHEDULED_ESTIMATE_RETRY_DELAY_MS) : null,
      last_send_error: String(errorMessage || 'Scheduled estimate send failed').slice(0, 1000),
      updated_at: db.fn.now(),
    });
}

function parseListEnv(value, fallback) {
  const items = String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : fallback;
}

function parsePositiveEnvInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function runContentRegistryMaintenance({
  registry = require('./content/content-registry'),
  liveStatus = require('./content/content-registry-live-status'),
} = {}) {
  const contentType = String(process.env.CONTENT_REGISTRY_MAINTENANCE_CONTENT_TYPE || '').trim() || null;
  const syncResult = await registry.runContentRegistrySync({
    astroSource: 'github',
    githubRef: process.env.CONTENT_REGISTRY_GITHUB_REF || process.env.GITHUB_ASTRO_DEFAULT_BRANCH || null,
    contentType,
    commit: true,
  });
  if (!syncResult.ok) {
    throw new Error(`sync failed: ${syncResult.error || 'unknown error'}`);
  }

  const statuses = parseListEnv(process.env.CONTENT_REGISTRY_LIVE_STATUS_STATUSES, CONTENT_REGISTRY_LIVE_STATUSES);
  const limit = parsePositiveEnvInt(process.env.CONTENT_REGISTRY_LIVE_STATUS_LIMIT, CONTENT_REGISTRY_LIVE_LIMIT);
  const liveResult = await liveStatus.runContentRegistryLiveStatusCheck({
    statuses,
    limit,
    commit: true,
  });
  if (!liveResult.ok) {
    throw new Error(`live status failed: ${liveResult.error || 'unknown error'}`);
  }

  return {
    sync: syncResult.summary,
    live: liveResult.summary,
    sync_run_id: syncResult.sync_run_id,
    statuses,
    limit,
  };
}

async function runAutonomousOpportunityMining({
  miner = require('./seo/gsc-opportunity-miner'),
} = {}) {
  const periodDays = parsePositiveEnvInt(process.env.AUTONOMOUS_OPPORTUNITY_MINE_PERIOD_DAYS, 28);
  const result = await miner.mineAll({ periodDays, persist: true });
  logger.info(`[autonomous-opportunity-miner] mined period=${periodDays}d persisted=${result.persisted || 0}`);
  return result;
}

function initScheduledJobs() {
  const { isEnabled, logGateStatus } = require('../config/feature-gates');
  logGateStatus();

  // Cancel-notice late-claim rollout boundary (codex #3233 r35): stamped
  // at BOOT when the hook gate is on, so the boundary necessarily
  // predates every gated cancellation this deploy processes — a cancel
  // whose in-trx claim failed before the first 15-minute sweep tick is
  // still inside the late-claim window. Idempotent (first stamp wins);
  // the sweep keeps its own stamp as a backstop. Fail-soft: a miss here
  // only narrows recovery to the sweep's stamp.
  if (isEnabled('cancelNoticeHook')) {
    db('ops_email_send_state')
      // Stamped with this pod's BOOT time, same as the sweep-side stamp
      // (codex #3233 r39/r41): a late fire-and-forget insert must not
      // look newer than a gate-off pod's boot and survive its guards.
      .insert({ email_key: 'cancel-notice-hook-enabled-at', last_sent_at: PROCESS_BOOT_AT, updated_at: db.fn.now() })
      .onConflict('email_key')
      .ignore()
      .catch((err) => logger.warn(`[scheduler] cancel-notice boundary stamp failed: ${err.message}`));
    // Replace a boundary from a PREVIOUS enable interval (older than the
    // newest observed disable) instead of ignoring it (codex r42).
    db.raw(
      "UPDATE ops_email_send_state SET last_sent_at = ?, updated_at = now() WHERE email_key = 'cancel-notice-hook-enabled-at' AND last_sent_at < COALESCE((SELECT ds.last_sent_at FROM ops_email_send_state ds WHERE ds.email_key = 'cancel-notice-hook-disabled-at'), '-infinity'::timestamptz)",
      [PROCESS_BOOT_AT],
    ).catch((err) => logger.warn(`[scheduler] cancel-notice boundary refresh failed: ${err.message}`));
  } else {
    // Gate OFF: clear the boundary so a later re-enable stamps a FRESH
    // one (codex #3233 r36) — cancellations made while the gate was off
    // must never backfill claims on re-enable. Env gates only change
    // across a restart, so this boot-time clear segments every enable
    // interval; the sweep repeats it as a backstop.
    db('ops_email_send_state')
      .where({ email_key: 'cancel-notice-hook-enabled-at' })
      // Generation guard (codex #3233 r37/r38): never delete a marker
      // stamped after this process booted — it belongs to a newer
      // gate-on pod.
      .where('last_sent_at', '<', PROCESS_BOOT_AT)
      .del()
      .catch((err) => logger.warn(`[scheduler] cancel-notice boundary clear failed: ${err.message}`));
    // Durable disable record (codex r42) — survives a draining gate-on
    // pod recreating the boundary after this one-shot clear.
    db.raw(
      "INSERT INTO ops_email_send_state (email_key, last_sent_at, updated_at) VALUES ('cancel-notice-hook-disabled-at', ?, now()) ON CONFLICT (email_key) DO UPDATE SET last_sent_at = GREATEST(ops_email_send_state.last_sent_at, EXCLUDED.last_sent_at), updated_at = now()",
      [PROCESS_BOOT_AT],
    ).catch((err) => logger.warn(`[scheduler] cancel-notice disable stamp failed: ${err.message}`));
  }

  // Boundary maintenance runs BEFORE this early return (codex r40):
  // disabling scheduled tasks must not preserve a stale feature interval.
  if (!isEnabled('cronJobs')) {
    logger.info('[feature-gates] Cron jobs DISABLED — skipping all scheduled tasks');
    return;
  }

  // BOOT (+60s, then EVERY 6H at :23) — SMS draft-route canary: probes the
  // routed reply-drafting providers (gpt mini default / Sonnet save-the-sale)
  // and alerts Adam the moment one stops answering (bad model ID, revoked key,
  // access/rate-limit denial). Without this, a dead route only shows up as
  // fall-back-to-FLAGSHIP warnings buried under live traffic. runExclusive so
  // a deploy overlap doesn't double-probe/double-alert.
  const smsDraftCanaryTick = async () => {
    try {
      await runExclusive('sms-draft-canary', () => require('./sms-draft-canary').runSmsDraftCanary());
    } catch (err) {
      logger.error(`[sms-draft-canary] tick failed: ${err.message}`);
    }
  };
  setTimeout(smsDraftCanaryTick, 60 * 1000);
  cron.schedule('23 */6 * * *', smsDraftCanaryTick, { timezone: 'America/New_York' });

  // BOOT (+90s, then EVERY 6H at :37) — booking-funnel conversion canary:
  // alerts Adam when real /book visitors keep entering the funnel but ZERO
  // bookings confirm across a whole window (the July slot_sig outage ran 8
  // days unnoticed exactly because this signal had no alarm). Dark until
  // GATE_BOOKING_FUNNEL_CANARY=true (feature-gates registry); read-only on
  // booking_intents.
  const bookingFunnelCanaryTick = async () => {
    try {
      await runExclusive('booking-funnel-canary', () => require('./booking-funnel-canary').runBookingFunnelCanary());
    } catch (err) {
      logger.error(`[booking-funnel-canary] tick failed: ${err.message}`);
    }
  };
  setTimeout(bookingFunnelCanaryTick, 90 * 1000);
  cron.schedule('37 */6 * * *', bookingFunnelCanaryTick, { timezone: 'America/New_York' });

  // EVERY 5 MIN — mark deploy-killed SEO pipeline/site-audit runs as failed.
  cron.schedule('*/5 * * * *', async () => {
    try {
      const { reapStaleSeoRuns } = require('./seo/seo-pipeline-runs');
      const result = await reapStaleSeoRuns();
      if (result.reaped > 0) {
        logger.warn(`[seo-pipeline] reaped ${result.reaped} stale running run(s) older than ${result.staleMinutes} minutes`);
      }
    } catch (err) {
      logger.error(`[seo-pipeline] stale-run reaper failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // HOURLY :20 — geocode backstop. Several customer-create paths never call
  // ensureCustomerGeocoded (and the ones that do swallow transient Google
  // failures), leaving latitude/longitude NULL — which silently drops those
  // stops from route optimization. Sweep fills any gap within the hour.
  cron.schedule('20 * * * *', async () => {
    try {
      const { runExclusive } = require('../utils/cron-lock');
      const { sweepUngeocodedCustomers } = require('./geocoder');
      await runExclusive('geocoder-backstop', () => sweepUngeocodedCustomers());
    } catch (err) {
      logger.error(`[geocoder] backstop sweep failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 2:40AM — Knowledge-index sync (hybrid knowledge search, lane A2):
  // re-reads every corpus connector, upserts changed chunks, embeds pending
  // ones (paid OpenAI embedding calls — pennies; gate-controlled). Gate off
  // → no-op. Missing OPENAI_API_KEY → chunks sync for full-text and stay
  // pending for embedding. runExclusive records job_health.
  // =========================================================================
  // Inspection-credit redemption recovery. The at-booking call is a fast
  // path, not the guarantee: scheduled_services is written from many
  // surfaces and a transient claim/ledger failure there must not lose a
  // promise permanently (Codex #3175 P0). This re-derives redemption from
  // persisted state — any open offer whose customer has since made a live
  // booking — and is idempotent, so a promise already redeemed is a no-op.
  // Hourly, not nightly: the credit should be on the account before the
  // invoice for that booking goes out.
  cron.schedule('12 * * * *', async () => {
    // NOT gated here (Codex #3178 r5 P0): the sweep's reversal half must
    // keep running through a kill-switch period so a credit whose booking
    // was cancelled while dark can't stay spendable. The service gates its
    // own crediting half internally.
    try {
      await runExclusive('inspection-credit-sweep', async () => {
        await require('./inspection-credit').sweepInspectionCreditRedemptions();
      });
    } catch (err) {
      logger.error(`[inspection-credit] hourly sweep failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // Legacy outbound-review activation backstop (PR #3361, Codex r5/r7 P1):
  // drains the whole pre-hold-removal review population — worked rows whose
  // post-commit activation was lost to a process exit, moved rows still
  // carrying 'pending', and untouched pending holds alike (the hold was
  // removed collectively; new bookings land live, so legacy ones activate
  // to parity). Not gated: it is a correctness backstop for a removed lane,
  // the query is tiny, and the legacy population only shrinks (runs become
  // free no-ops once it drains).
  cron.schedule('18 * * * *', async () => {
    try {
      await runExclusive('legacy-outbound-activation-sweep', async () => {
        await require('./outbound-review-confirm').sweepStrandedLegacyOutboundActivations();
      });
    } catch (err) {
      logger.error(`[legacy-activation-sweep] hourly sweep failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // Voice-filed re-service tickets whose owner page never went out (process
  // exit between the ticket commit and the alert). The page is the owner-ruled
  // escape hatch from the ticket queue's documented black hole, so a missing
  // receipt is swept rather than waiting on a second call that may never come.
  // Bounded and self-terminating: rows stamp owner_alerted_at on success.
  cron.schedule('24 * * * *', async () => {
    try {
      await runExclusive('voice-reservice-alert-sweep', async () => {
        await require('./voice-agent/relay-reservice').sweepUnalertedVoiceReservices();
        // Same cadence, same rationale: a hot-lead page whose process died
        // between the claim and the send has no live-call retry left.
        await require('./voice-agent/relay-alert').sweepAbandonedHotAlerts();
        // And a lifecycle customer's stated contact instruction whose ONLY
        // artifact (the admin feed row) failed to persist on the live call.
        await require('./lead-from-extraction').sweepUnsurfacedContactInstructions();
      });
    } catch (err) {
      logger.error(`[voice-reservice-alert-sweep] hourly sweep failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  cron.schedule('40 2 * * *', async () => {
    if (!isEnabled('hybridKnowledge')) return;
    try {
      await runExclusive('knowledge-index-sync', async () => {
        // Map fresh call/visit resolutions first so the same night's corpus
        // sync chunks + embeds them. Isolated: a resolution-sweep failure
        // must not cost the curated corpora their nightly sync/embeds.
        try {
          await require('./knowledge-index/resolution-sync').syncResolutionArtifacts();
        } catch (err) {
          logger.error(`[knowledge-index] resolution sweep failed (corpus sync continues): ${err.message}`);
        }
        await require('./knowledge-index/ingest').syncKnowledgeIndex();
      });
    } catch (err) {
      logger.error(`[knowledge-index] nightly sync failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 3:15AM — Data Hygiene deterministic normalization scan
  // =========================================================================
  cron.schedule('15 3 * * *', async () => {
    if (!isEnabled('dataHygieneScanner')) return;
    logger.info('Running: Data Hygiene normalization scan');
    try {
      const result = await require('./data-hygiene').runScan({
        mode: 'cron',
        phases: ['normalization'],
      });
      logger.info(`[data-hygiene] scheduled normalization scan finished with status=${result.status}, run_id=${result.run_id}`);
    } catch (err) {
      logger.error(`Data Hygiene normalization scan failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 3:35AM — Data Hygiene auto-apply (green normalization proposals
  // only; exceptions stay pending for review). Runs after the 3:15 scan so
  // fresh proposals apply same-night. Gate is opt-in in EVERY environment
  // (auto-writer pattern); kill = unset GATE_DATA_HYGIENE_AUTO_APPLY.
  // =========================================================================
  cron.schedule('35 3 * * *', async () => {
    if (!isEnabled('dataHygieneAutoApply')) return;
    logger.info('Running: Data Hygiene auto-apply sweep');
    try {
      await runExclusive('data-hygiene-auto-apply', () =>
        require('./data-hygiene/auto-apply').runAutoApplySweep());
    } catch (err) {
      logger.error(`Data Hygiene auto-apply sweep failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 3:40AM — Vision delta scoring sweep (before/after photo pairs on
  // treatment_outcomes → VISION-tier visual-change verdict). Bounded (25/run),
  // idempotent (vision_scored_at is terminal), and entirely inert unless
  // GATE_VISION_DELTA is set (canonical gateEnvValue parse; registered as
  // visionDelta in config/feature-gates.js) — the gate check lives inside the service
  // (single source of truth), so this leg is a no-op beyond the gated early
  // return. runExclusive: read-then-act — a deploy overlap must not
  // double-score (and double-bill) the same photo pairs.
  // =========================================================================
  cron.schedule('40 3 * * *', async () => {
    try {
      const res = await runExclusive('vision-delta-sweep', () =>
        require('./vision-delta').sweepUnscoredOutcomes());
      if (res && !res.skipped) {
        logger.info(`Vision delta sweep: ${res.scored}/${res.candidates} scored`);
      }
    } catch (err) {
      logger.error(`Vision delta sweep failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // NIGHTLY 3:55AM ET — Property-enrichment backfill: up to
  // PROPERTY_BACKFILL_BATCH (default 20) existing NULL customer_properties
  // rows of real customers get the full property lookup + COALESCE
  // fill-only patch (lat/lng/property_type), upcoming-visit rows first.
  // Inert unless GATE_PROPERTY_ENRICH_BACKFILL is set (checked inside the
  // sweep — single source of truth; independent of the per-call
  // GATE_CALL_PROPERTY_LOOKUP lane). Real nightly LLM spend — the batch
  // cap is the budget. runExclusive: a deploy overlap must not double-buy
  // the same batch.
  // =========================================================================
  cron.schedule('55 3 * * *', async () => {
    try {
      const res = await runExclusive('property-enrich-backfill', () =>
        require('./call-property-lookup').sweepUnenrichedProperties());
      if (res && !res.skipped) {
        logger.info(`Property-enrich ${res.mode === 'call_time_recovery' ? 'call-time recovery' : 'backfill'}: ${res.enriched}/${res.processed} enriched (${res.cooledDown} cooled, ${res.parked} parked, ${res.failed} failed)`);
      }
    } catch (err) {
      logger.error(`Property-enrich backfill failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // WEEKLY MON 4:05AM ET — Manatee permit sync (public ACA CSV reports →
  // pool_permit_records + construction_permit_records). Pool report =
  // closed-permit backstop for the pool-facts lookup (the live GIS layer
  // drops permits when they close and the assessment roll lags a finished
  // pool by up to a year); construction reports = under-construction /
  // new-build evidence (stale-imagery signal). Inert unless
  // GATE_PERMIT_SYNC is set (checked inside syncPermits — single source of
  // truth); first enabled run on empty tables backfills, then
  // trailing-window refreshes. runExclusive: a deploy overlap must not run
  // two ACA report sessions at once.
  // =========================================================================
  cron.schedule('5 4 * * 1', async () => {
    try {
      const res = await runExclusive('permit-sync', () =>
        require('./property-lookup/manatee-permit-sync').syncPermits());
      if (res && !res.skipped) {
        const part = (r) => (r ? `${r.written}/${r.fetched} rows` : 'failed');
        logger.info(`Permit sync: pool ${part(res.pool)}; construction ${part(res.construction)}${res.errors.length ? `; errors: ${res.errors.join(' | ')}` : ''}`);
      }
    } catch (err) {
      logger.error(`Permit sync failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 3:45AM — Inventory unit alias auto-fix (pure spelling/plural
  // renames from the unit-review queue only: "Gallons" -> gal at factor 1;
  // missing-unit and ambiguous-oz rows stay parked for review). Gate is
  // opt-in in EVERY environment (auto-writer pattern); kill = unset
  // GATE_INVENTORY_UNIT_AUTOFIX. Every fix leaves a movement audit row.
  // =========================================================================
  cron.schedule('45 3 * * *', async () => {
    if (!isEnabled('inventoryUnitAutofix')) return;
    logger.info('Running: Inventory unit alias auto-fix sweep');
    try {
      await runExclusive('inventory-unit-autofix', () =>
        require('./inventory-unit-review').runInventoryUnitAutofixSweep());
    } catch (err) {
      logger.error(`Inventory unit autofix sweep failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // Point-in-time MRR snapshot — keeps the MRR Trend honest: past months read
  // their real recorded MRR instead of being recomputed at today's prices.
  //  - DAILY 6:05AM ET: refresh the CURRENT month's row (in-progress month stays
  //    live; it freezes once the month rolls over and is no longer the current).
  //  - 11:50PM ET on the month's LAST day: capture the month at (near) its end so
  //    it freezes at a true month-end value rather than the 6:05am-on-the-final-
  //    day value. recordMrrSnapshot() always records the CURRENT month, so a
  //    closed month is never overwritten with next-month customer state.
  // =========================================================================
  cron.schedule('5 6 * * *', async () => {
    try {
      // runExclusive: a deploy overlap must not double-write the same month.
      await runExclusive('mrr-monthly-snapshot', async () => {
        const { recordMrrSnapshot } = require('./mrr-snapshot');
        await recordMrrSnapshot();
      });
    } catch (err) {
      logger.error(`[mrr-snapshot] cron failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // DAILY 6:25AM ET — LLM dispatch exception digest: aggregates yesterday's
  // llm_dispatch_log rows and emails the company inbox ONLY when a policy
  // degraded (all-providers-failed, fallback-rate spike, or gone silent);
  // green days send nothing. Dark until GATE_LLM_DISPATCH_METRICS=true
  // (stats + email no-op while off; the retention prune still runs so
  // accumulated rows age out after a gate-off). runExclusive so a deploy
  // overlap doesn't double-email the same day.
  cron.schedule('25 6 * * *', async () => {
    try {
      const metrics = require('./llm-dispatch-metrics');
      const res = await runExclusive('llm-dispatch-digest', () => metrics.runLlmDispatchDigest());
      // runExclusive returns { skipped, reason } WITHOUT calling the job when
      // it cannot acquire a DB connection — so on a full database outage the
      // digest never runs and its own DB-failure alert never fires. Alert from
      // here instead, over SMTP, touching no database. 'lease_held' is a
      // normal overlap and is not an outage.
      if (res && res.skipped && res.reason === 'no_connection') {
        await metrics.alertRecorderUnreachable(res.reason);
      }
    } catch (err) {
      logger.error(`[llm-dispatch-metrics] cron failed: ${err.message}`);
      // runExclusive can also THROW before invoking the job — e.g. the pool
      // hands out a connection but the pg_try_advisory_lock query dies as the
      // DB goes down (codex #3123 r8, accepted residual then, fixed here).
      // Alert unless the digest already emailed for this failure
      // (err.alerted); alertRecorderUnreachable's independent-connection
      // probe stands down on transient blips, so this cannot false-alarm a
      // healthy database.
      if (!err.alerted) {
        try {
          const { alertRecorderUnreachable } = require('./llm-dispatch-metrics');
          await alertRecorderUnreachable(`digest tick threw: ${err.message}`);
        } catch (alertErr) {
          logger.error(`[llm-dispatch-metrics] unreachable-alert itself failed: ${alertErr.message}`);
        }
      }
    }
  }, { timezone: 'America/New_York' });

  // HOURLY at :50 — LLM dispatch recorder heartbeat. Writes one row through
  // the same insert path real recording uses, so the digest can tell a
  // genuinely quiet day (heartbeats present, no dispatches) from a day the
  // recorder was dead (no heartbeats at all). A probe at digest time cannot:
  // a write path broken all day but recovered overnight would pass it while
  // the whole lost day reported clean. No runExclusive — a duplicate
  // heartbeat on deploy overlap is harmless, and skipping one is not; the
  // digest counts DISTINCT HOURS, so replica duplicates cannot inflate
  // coverage. No-ops while GATE_LLM_DISPATCH_METRICS is unset.
  cron.schedule('50 * * * *', async () => {
    try {
      await require('./llm-dispatch-metrics').recordHeartbeat();
    } catch (err) {
      logger.error(`[llm-dispatch-metrics] heartbeat failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // Month-end capture: fire on days 28–31 at 11:50pm ET, but only on the ACTUAL
  // final day (tomorrow ET is the 1st). Records the current (ending) month so it
  // freezes near its true end, capturing same-final-day conversions/churn/rate
  // changes the 6:05am run missed.
  cron.schedule('50 23 28-31 * *', async () => {
    const { etDateString, addETDays } = require('./../utils/datetime-et');
    if (!etDateString(addETDays(new Date(), 1)).endsWith('-01')) return;
    try {
      await runExclusive('mrr-monthly-snapshot', async () => {
        const { recordMrrSnapshot } = require('./mrr-snapshot');
        await recordMrrSnapshot();
      });
    } catch (err) {
      logger.error(`[mrr-snapshot] month-end cron failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 11:45PM ET — Core KPI snapshot. Records the day's live month-to-date
  // value of every dashboard Core KPI (one row per metric) into kpi_snapshots so
  // a later PR can draw trend sparklines. Runs near end-of-day ET (offset a few
  // minutes from the 11:50pm mrr month-end run so they don't collide). Reads the
  // same computeCoreKpis() the live tiles use, so the trend and tiles agree.
  // =========================================================================
  cron.schedule('45 23 * * *', async () => {
    try {
      // runExclusive: a deploy overlap must not double-write the same day.
      await runExclusive('kpi-daily-snapshot', async () => {
        const { recordKpiSnapshot } = require('./kpi-snapshot');
        await recordKpiSnapshot();
      });
    } catch (err) {
      logger.error(`[kpi-snapshot] cron failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 4:10AM — Auto-Dispatch: optimize FUTURE recurring visits more than
  // 14 days out (route proximity + customer scheduling preferences). Double-
  // gated (cronJobs AND autoDispatch). Runs in the configured mode — dry_run
  // by default; it only applies moves when AUTO_DISPATCH_MODE=apply.
  // =========================================================================
  cron.schedule('10 4 * * *', async () => {
    if (!isEnabled('autoDispatch')) return;
    logger.info('Running: Auto-Dispatch recurring optimizer');
    try {
      // runExclusive: read-then-act job — a Railway deploy overlap or a slow
      // prior tick must not double-run and bypass the per-run change cap.
      await runExclusive('auto-dispatch-recurring', async () => {
        const { runAutoDispatch } = require('./auto-dispatch');
        const result = await runAutoDispatch({ triggeredBy: 'cron' });
        logger.info(`[auto-dispatch] cron run ${result.runId} ${result.status}: evaluated=${result.evaluated} recommended=${result.recommended} changed=${result.changed} skipped=${result.skipped} failed=${result.failed}`);
        // completed_with_errors (guard-read outage or failed applies) and
        // failed must FAIL job health — the run row already records the
        // detail; a degraded night must not read as a green
        // auto-dispatch-recurring (same guard as the 4:20 reorder cron).
        if (result.status !== 'completed') {
          throw new Error(`auto-dispatch run ${result.runId} unhealthy: status=${result.status} failed=${result.failed}`);
        }
      });
    } catch (err) {
      logger.error(`Auto-Dispatch run failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 4:20AM — ROUTE-TIERS nightly intra-day reorder (tier 3: 72h–7d
  // band). Rewrites route_order per tech-day via the shared optimizer when
  // savings clear the floor; NEVER moves a visit's date/window/tech, skips any
  // day containing a frozen visit (<72h or 72h reminder sent), never touches
  // >25-stop tech-days (Google cap — logged, not truncated). Double-gated
  // (cronJobs AND routeReorder); the tier day-moves themselves ride the 4:10
  // auto-dispatch run above (its eligibility is tier-aware when
  // GATE_ROUTE_TIERS is on). Zero customer comms by construction.
  // =========================================================================
  cron.schedule('20 4 * * *', async () => {
    // Call-time read (NOT the baked isEnabled snapshot) so a Railway var flip
    // takes effect on the next tick without a redeploy — matching the
    // documented gate contract and the service's own internal check.
    if (!gateEnvValue('GATE_ROUTE_REORDER')) return;
    logger.info('Running: Route-Tiers nightly reorder');
    try {
      // runExclusive x2: 'route-tiers-nightly' guards against deploy-overlap
      // double-runs of THIS job; nesting inside 'auto-dispatch-recurring'
      // serializes the two autonomous schedule WRITERS — auto-dispatch's
      // apply pass can land moves onto reorder-band days (destination floor
      // is 5 days out, band is 1–6), and SERIALIZABLE isolation alone cannot
      // fence a concurrent writer running at weaker isolation. If the 4:10
      // run is still holding the lock, tonight's reorder tick is skipped
      // (advisory lock is non-blocking) and picked up tomorrow.
      await runExclusive('route-tiers-nightly', async () => {
        const { runRouteReorderIfEnabled, recordSkippedTick } = require('./route-reorder');
        // recordHealth:false — this invocation only BORROWS the writer lock;
        // recording it would stamp a fresh 4:20 success under the 4:10 job's
        // name, clearing real failures and falsifying last_success_at.
        const inner = await runExclusive('auto-dispatch-recurring', async () => runRouteReorderIfEnabled(), { recordHealth: false });
        // STRICT boolean — a completed run returns skipped as a NUMERIC
        // count of skipped tech-days (frozen days are routine), and a
        // truthy check would ledger a false skipped tick + fail job health
        // on any normal night with one skip. Only runExclusive's
        // lock-contention shape ({ skipped: true, reason }) means the tick
        // itself never ran (uncapped audit r27 P1).
        if (inner && inner.skipped === true) {
          // The 4:10 job still held the writer lock — the tick did NOT run.
          // Ledger it as skipped so job health / the dispatch card never show
          // a lock-starved night as a successful run with no output.
          logger.warn(`[route-reorder] tick skipped (${inner.reason}) — auto-dispatch still holds the writer lock`);
          const tickId = await recordSkippedTick(inner.reason);
          // recordSkippedTick swallows insert errors and returns null — a
          // lost skip ledger must fail job health like any lost ledger, or
          // the night is invisible everywhere.
          if (tickId == null) {
            throw new Error(`route-reorder skipped tick (${inner.reason}) could not be ledgered`);
          }
          // Ledgered — but the night still had NO reorder pass. Returning
          // normally would let the outer runExclusive stamp
          // 'route-tiers-nightly' as a fresh SUCCESS, hiding the missed run
          // from job health (uncapped audit r20 P1). Fail loud like every
          // other not-fully-successful night; the ledger row keeps the
          // dispatch card accurate either way.
          throw new Error(`route-reorder tick skipped (${inner.reason}) — no reorder ran (ledger ${tickId})`);
        }
        const result = inner || {};
        logger.info(`[route-reorder] cron run ${result.status}: applied=${result.applied ?? 0} skipped=${result.skipped ?? 0} failed=${result.failed ?? 0} ledger=${result.ledgerId ?? 'none'}`);
        // Anything short of a fully-successful, ledgered run must FAIL job
        // health — a guard outage (completed_with_errors) or a lost ledger
        // otherwise reads as a healthy night with no visible output.
        if (result.status !== 'gate_off' && (result.status !== 'completed' || result.ledgerId == null)) {
          throw new Error(`route-reorder run unhealthy: status=${result.status ?? 'unknown'} ledger=${result.ledgerId ?? 'none'}`);
        }
      });
    } catch (err) {
      logger.error(`Route-Tiers reorder run failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // Customer duplicate auto-merge — 4:40 AM daily. Green-tier only (shell
  // rows: same phone, compatible identity, zero billing/portal artifacts);
  // everything ambiguous stays in the /admin/customers/duplicates review
  // queue. Double-gated (cronJobs AND customerDedupeAutoMerge, the latter
  // opt-in in every environment). Every merge is journaled + admin-notified.
  // Same tick, own gate (customerDedupeAutoDismissRed): after the merge
  // pass, red-tier pairs — the detector's own "two different people sharing
  // a phone" verdict, which can never be merged — get the same "not a
  // duplicate" dismissal an operator would click ('auto:red-tier').
  // =========================================================================
  cron.schedule('40 4 * * *', async () => {
    const mergeOn = isEnabled('customerDedupeAutoMerge');
    const dismissRedOn = isEnabled('customerDedupeAutoDismissRed');
    if (!mergeOn && !dismissRedOn) return;
    logger.info('Running: Customer duplicate auto-merge sweep');
    try {
      // runExclusive: read-then-act — an overlapping tick could pick the same
      // loser row before the first merge soft-deletes it.
      await runExclusive('customer-dedupe-auto-merge', async () => {
        const { runAutoMergeSweep, runRedPairAutoDismissSweep } = require('./customer-dedupe');
        if (mergeOn) {
          const result = await runAutoMergeSweep();
          logger.info(`[customer-dedupe] sweep merged=${result.merged.length} skipped=${result.skipped.length}`);
        }
        if (dismissRedOn) {
          const result = await runRedPairAutoDismissSweep();
          logger.info(`[customer-dedupe] red-pair auto-dismiss dismissed=${result.dismissed.length}${result.aborted ? ` aborted=${result.aborted}` : ''}`);
        }
      });
    } catch (err) {
      logger.error(`Customer dedupe sweep failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // WEEKLY VENDOR PRICE SCAN (gated: cronJobs AND priceScanWeekly)
  // Scans top-spend products for a cheaper competitor per-unit price and stages a
  // price-match draft for the SiteOne rep in /admin/price-match. Never auto-sends.
  // Monday 6:00am ET.
  // =========================================================================
  cron.schedule('0 6 * * 1', async () => {
    if (!isEnabled('priceScanWeekly')) return;
    logger.info('Running: Weekly vendor price scan');
    try {
      // runExclusive: live scrapes + a single draft insert — a deploy overlap must
      // not double-scan or stage duplicate drafts.
      await runExclusive('price-scan-weekly', async () => {
        const { runWeeklyScan } = require('./price-scan/weekly-scan');
        const result = await runWeeklyScan();
        logger.info(`[price-scan] cron run: ${JSON.stringify(result)}`);
      });
    } catch (err) {
      logger.error(`Weekly price scan failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // WEEKLY LAWN PRICING INVARIANT SWEEP (gated: cronJobs AND lawnPricingInvariantSweep)
  // Re-runs the pricing engine across the full track×size×tier grid against
  // LIVE DB config and raises/resolves one dashboard alert on ladder
  // violations or material-budget drift vs live inventory COGS. Read-only.
  // Monday 6:30am ET (after the 6:00am vendor price scan refreshes catalog prices).
  // =========================================================================
  cron.schedule('30 6 * * 1', async () => {
    if (!isEnabled('lawnPricingInvariantSweep')) return;
    logger.info('Running: Weekly lawn pricing invariant sweep');
    try {
      // runExclusive: the alert upsert is dedupe-keyed, but a deploy overlap
      // must not double-run the full engine grid.
      await runExclusive('lawn-pricing-invariant-sweep', async () => {
        const { runLawnPricingInvariantSweep } = require('./lawn-pricing-invariant-sweep');
        const result = await runLawnPricingInvariantSweep();
        logger.info(`[lawn-pricing-sweep] cron run: cells=${result.cellsChecked} violations=${result.violations} budget=${result.budgetCheck}`);
      });
    } catch (err) {
      logger.error(`Weekly lawn pricing invariant sweep failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // WEEKLY IRRIGATION RECOMMENDATION EMAIL (gated: cronJobs AND irrigationWeeklyEmail)
  // Monday 7:00am ET — emails lawn-care customers who entered weekly irrigation
  // inches in the portal a "cut back" / "add water" / "you're on track"
  // check-in based on last week's rainfall + ET₀ at their coordinates vs. the
  // seasonal target for their grass, plus the upcoming week's rain forecast.
  // Only rain-unknown weeks send nothing. The gate check lives INSIDE the
  // sweep so the off state still shadow-logs candidate counts (booking-abandon
  // pattern).
  // =========================================================================
  cron.schedule('0 7 * * 1', async () => {
    try {
      // runExclusive: customer-facing email sends — a deploy overlap must not
      // double-sweep (idempotency keys are the second line of defense).
      await runExclusive('irrigation-weekly-email', async () => {
        const { runWeeklyIrrigationEmailSweep } = require('./irrigation-weekly-email');
        const result = await runWeeklyIrrigationEmailSweep();
        logger.info(`[irrigation-weekly-email] cron run: ${JSON.stringify(result)}`);
      });
    } catch (err) {
      logger.error(`Weekly irrigation email sweep failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // WEEKLY TURF VARIANCE DIGEST (kill: TURF_VARIANCE_DIGEST_DISABLED=1)
  // Monday 7:05am ET — owner ACT email ONLY when the last 30 days of
  // estimate-actuals turf deltas drift past the alert threshold; a green
  // window sends nothing (exception-based). Reads the ledger the nightly
  // estimate-actuals reconcile maintains; sends to the internal ops inbox.
  // =========================================================================
  cron.schedule('5 7 * * 1', async () => {
    try {
      // runExclusive: a deploy-overlap tick must not double-send the email.
      await runExclusive('turf-variance-digest', async () => {
        const { runTurfVarianceDigest } = require('./turf-variance-digest');
        const result = await runTurfVarianceDigest();
        logger.info(`[turf-variance] cron run: ${JSON.stringify({ sent: result.sent || false, skipped: result.skipped || null, avg: result.avgDeltaPct ?? null, samples: result.samples ?? null })}`);
        // A swallowed failure must still read as a FAILED run in job_health
        // (codex #3230 P2, both rounds) — rethrow so runExclusive records it
        // and the outer handler logs it. Delivery-BLOCKING skips count as
        // failures (unconfigured mailer, non-internal recipient: drift was
        // found but the ACT email cannot leave); expected skips
        // (within_threshold / disabled / recent_send) stay healthy.
        if (result?.skipped === 'query_failed' || result?.error
            || result?.skipped === 'unconfigured' || result?.skipped === 'recipient') {
          throw new Error(`turf variance digest did not complete (${result.skipped || 'send_failed'})`);
        }
      });
    } catch (err) {
      logger.error(`Weekly turf variance digest failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // COMMS GUARDS — three daily exception emails (2026-08-05 weekly sweep).
  // Each is exception-based (a quiet day sends nothing), carries its own
  // env kill switch, and dedupes via ops_email_send_state. Cron minutes are
  // deliberately unused elsewhere in this file (#3208 pool-timeout outage:
  // never share a minute with other jobs).
  // =========================================================================

  // Reschedule/away texts whose visit never moved (kill:
  // RESCHEDULE_INTENT_WATCHER_DISABLED=1) — daily 6:53am ET.
  cron.schedule('30 53 6 * * *', async () => {
    try {
      const lockRes = await runExclusive('reschedule-intent-watcher', async () => {
        const { runRescheduleIntentWatcher } = require('./reschedule-intent-watcher');
        const result = await runRescheduleIntentWatcher();
        logger.info(`[reschedule-intent-watcher] cron run: ${JSON.stringify({ sent: result.sent || false, skipped: result.skipped || null, count: result.count || 0 })}`);
        // Delivery-BLOCKING skips count as failures; expected skips
        // (nothing_found / disabled / recent_send) stay healthy.
        if (result?.skipped === 'query_failed' || result?.error
            || result?.skipped === 'unconfigured' || result?.skipped === 'recipient') {
          throw new Error(`reschedule-intent watcher did not complete (${result.skipped || 'send_failed'})`);
        }
      });
      // A pool-exhausted tick returns {skipped} instead of throwing —
      // surface it so job_health records the missed daily run (codex r16).
      if (lockRes && lockRes.skipped && lockRes.reason !== 'lease_held') {
        // lease_held = another instance is running this watcher (deploy
        // overlap) — that IS the daily run, not a miss (codex r18).
        // job_health must record the missed daily run (codex r17) — the
        // skip path returns before runExclusive's own bookkeeping.
        const { recordJobStart, recordJobEnd } = require('../utils/cron-lock');
        const t0 = Date.now();
        await recordJobStart('reschedule-intent-watcher').catch(() => {});
        await recordJobEnd('reschedule-intent-watcher', t0, new Error(`tick skipped: ${lockRes.reason || 'no_connection'}`)).catch(() => {});
        throw new Error(`reschedule-intent watcher tick skipped: ${lockRes.reason || 'no_connection'}`);
      }
    } catch (err) {
      logger.error(`Reschedule-intent watcher failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // Quotes promised on calls with no estimate sent since (kill:
  // PROMISED_ESTIMATE_WATCHER_DISABLED=1) — daily 7:11am ET.
  cron.schedule('30 11 7 * * *', async () => {
    try {
      const lockRes = await runExclusive('promised-estimate-watcher', async () => {
        const { runPromisedEstimateWatcher } = require('./promised-estimate-watcher');
        const result = await runPromisedEstimateWatcher();
        logger.info(`[promised-estimate-watcher] cron run: ${JSON.stringify({ sent: result.sent || false, skipped: result.skipped || null, count: result.count || 0 })}`);
        if (result?.skipped === 'query_failed' || result?.error
            || result?.skipped === 'unconfigured' || result?.skipped === 'recipient') {
          throw new Error(`promised-estimate watcher did not complete (${result.skipped || 'send_failed'})`);
        }
      });
      // A pool-exhausted tick returns {skipped} instead of throwing —
      // surface it so job_health records the missed daily run (codex r16).
      if (lockRes && lockRes.skipped && lockRes.reason !== 'lease_held') {
        // lease_held = another instance is running this watcher (deploy
        // overlap) — that IS the daily run, not a miss (codex r18).
        // job_health must record the missed daily run (codex r17) — the
        // skip path returns before runExclusive's own bookkeeping.
        const { recordJobStart, recordJobEnd } = require('../utils/cron-lock');
        const t0 = Date.now();
        await recordJobStart('promised-estimate-watcher').catch(() => {});
        await recordJobEnd('promised-estimate-watcher', t0, new Error(`tick skipped: ${lockRes.reason || 'no_connection'}`)).catch(() => {});
        throw new Error(`promised-estimate watcher tick skipped: ${lockRes.reason || 'no_connection'}`);
      }
    } catch (err) {
      logger.error(`Promised-estimate watcher failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // Stripe webhook events the app failed to apply (ledger rows with error /
  // abandoned claims in the last 48h — the lookback deliberately exceeds
  // the daily interval + in-flight grace windows) plus Stripe-side delivery
  // failures reconciled against the local ledger
  // (kill: STRIPE_WEBHOOK_HEALTH_DISABLED=1) — daily 7:04am ET. Without
  // this, dead events sit silently until the 3:30am 90-day purge erases
  // them (2026-08-07 infra audit). A check that cannot complete must land
  // in job_health as failed, never swallowed — hence the throws below.
  cron.schedule('30 4 7 * * *', async () => {
    try {
      const lockRes = await runExclusive('stripe-webhook-health', async () => {
        const { runStripeWebhookHealthCheck } = require('./stripe-webhook-health');
        const result = await runStripeWebhookHealthCheck();
        logger.info(`[stripe-webhook-health] cron run: ${JSON.stringify({ sent: result.sent || false, skipped: result.skipped || null, count: result.count || 0, stripeSide: result.stripeFailureCount || 0 })}`);
        // Delivery-BLOCKING skips count as failures; expected skips
        // (nothing_found / disabled / recent_send) stay healthy. A failed
        // Stripe-side probe or ledger query fails the run even when the
        // alert email went out — the check did not fully complete.
        if (result?.skipped === 'query_failed' || result?.error
            || result?.skipped === 'unconfigured' || result?.skipped === 'recipient'
            || result?.skipped === 'stripe_check_failed'
            || result?.stripeCheckError || result?.ledgerCheckError) {
          const reason = result.skipped
            || (result.ledgerCheckError ? 'ledger_check_failed' : null)
            || (result.stripeCheckError ? 'stripe_check_failed' : null)
            || 'send_failed';
          throw new Error(`stripe-webhook-health check did not complete (${reason})`);
        }
      });
      // A pool-exhausted tick returns {skipped} instead of throwing —
      // surface it so job_health records the missed daily run (same
      // contract as the sibling watchers above).
      if (lockRes && lockRes.skipped && lockRes.reason !== 'lease_held') {
        // lease_held = another instance is running this check (deploy
        // overlap) — that IS the daily run, not a miss.
        const { recordJobStart, recordJobEnd } = require('../utils/cron-lock');
        const t0 = Date.now();
        await recordJobStart('stripe-webhook-health').catch(() => {});
        await recordJobEnd('stripe-webhook-health', t0, new Error(`tick skipped: ${lockRes.reason || 'no_connection'}`)).catch(() => {});
        throw new Error(`stripe-webhook-health tick skipped: ${lockRes.reason || 'no_connection'}`);
      }
    } catch (err) {
      logger.error(`Stripe webhook health check failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // Today's unworked callbacks / follow-ups / unanswered texts (kill:
  // UNWORKED_COMMS_WATCHER_DISABLED=1) — daily 6:17pm ET, after the 6:00pm
  // missed-appointment check and before the 6:40pm stale-visit sweep.
  cron.schedule('30 17 18 * * *', async () => {
    try {
      const lockRes = await runExclusive('unworked-comms-eod', async () => {
        const { runUnworkedCommsWatcher } = require('./unworked-comms-watcher');
        const result = await runUnworkedCommsWatcher();
        logger.info(`[unworked-comms] cron run: ${JSON.stringify({ sent: result.sent || false, skipped: result.skipped || null, total: result.total || 0 })}`);
        if (result?.skipped === 'query_failed' || result?.error
            || result?.skipped === 'unconfigured' || result?.skipped === 'recipient') {
          throw new Error(`unworked-comms watcher did not complete (${result.skipped || 'send_failed'})`);
        }
      });
      // A pool-exhausted tick returns {skipped} instead of throwing —
      // surface it so job_health records the missed daily run (codex r16).
      if (lockRes && lockRes.skipped && lockRes.reason !== 'lease_held') {
        // lease_held = another instance is running this watcher (deploy
        // overlap) — that IS the daily run, not a miss (codex r18).
        // job_health must record the missed daily run (codex r17) — the
        // skip path returns before runExclusive's own bookkeeping.
        const { recordJobStart, recordJobEnd } = require('../utils/cron-lock');
        const t0 = Date.now();
        await recordJobStart('unworked-comms-eod').catch(() => {});
        await recordJobEnd('unworked-comms-eod', t0, new Error(`tick skipped: ${lockRes.reason || 'no_connection'}`)).catch(() => {});
        throw new Error(`unworked-comms watcher tick skipped: ${lockRes.reason || 'no_connection'}`);
      }
    } catch (err) {
      logger.error(`Unworked-comms watcher failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // WEEKLY NEWSLETTER INACTIVITY SUNSET (gated: GATE_NEWSLETTER_SUNSET)
  // Monday 7:30am ET — flags subscribers with 90+ days of zero opens/clicks
  // across 6+ delivered campaigns, parks ONE win-back draft for the owner to
  // send, and suppresses (status='inactive') non-responders 30 days after the
  // win-back delivers. Never sends email itself. The gate check lives INSIDE
  // runNewsletterSunset, so the off state is a cheap no-op.
  // =========================================================================
  cron.schedule('30 7 * * 1', async () => {
    try {
      // runExclusive: read-then-act (flag writes + a single draft insert) —
      // a deploy overlap must not double-flag or park two drafts.
      await runExclusive('newsletter-sunset', async () => {
        const { runNewsletterSunset } = require('./newsletter-sunset');
        const result = await runNewsletterSunset();
        if (!result?.skipped) logger.info(`[newsletter-sunset] cron run: ${JSON.stringify(result)}`);
      });
    } catch (err) {
      logger.error(`Weekly newsletter sunset failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // WEEKLY BACKLINK PROFILE → ASTRO sameAs SYNC (gated: cronJobs AND backlinkProfileSync)
  // Opens a PR adding verifier-confirmed (status='live') directory/citation/social
  // profile URLs from seo_link_prospects to the marketing site's
  // entity-profiles.auto.json (Organization sameAs). Never auto-merges. Mon 9:00am ET.
  // =========================================================================
  cron.schedule('0 9 * * 1', async () => {
    if (!isEnabled('backlinkProfileSync')) return;
    logger.info('Running: Backlink profile → astro sameAs sync');
    try {
      // runExclusive: a single PR per run — a deploy overlap must not open duplicates.
      await runExclusive('backlink-profile-astro-sync', async () => {
        const { syncProfilesToAstro } = require('./backlink-profile-astro-sync');
        const result = await syncProfilesToAstro({ dryRun: process.env.BACKLINK_SYNC_DRY_RUN === 'true' });
        logger.info(`[backlink-sync] cron run: ${JSON.stringify(result)}`);
      });
    } catch (err) {
      logger.error(`Backlink profile sync failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // WEEKLY GEO-GRID MAP-PACK SCAN (gated: cronJobs AND geoGridTracking)
  // Sweeps an N×N grid of pins per office for the map-pack rank of core keywords.
  // PAY-PER-CALL DataForSEO — opt-in via GATE_GEO_GRID. Sunday 4:00am ET.
  // =========================================================================
  cron.schedule('0 4 * * 0', async () => {
    if (!isEnabled('geoGridTracking')) return;
    logger.info('Running: Weekly geo-grid map-pack scan');
    try {
      // runScan() self-serializes via runExclusive('geo-grid-scan') — covers the
      // cron, the manual /run trigger, and deploy overlaps in one place.
      const { runScan } = require('./seo/geo-grid-tracker');
      const result = await runScan();
      logger.info(`[geo-grid] cron run: ${JSON.stringify(result)}`);
    } catch (err) {
      logger.error(`Geo-grid scan failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // SEO COMMAND CENTER CRONS (gated behind GATE_SEO_INTELLIGENCE)
  // =========================================================================

  // DAILY 2AM — Rank tracking (priority 1 daily, all on Sunday)
  cron.schedule('0 2 * * *', async () => {
    if (!isEnabled('seoIntelligence')) return;
    logger.info('Running: SEO rank tracking');
    try {
      const RankTracker = require('./seo/rank-tracker');
      await RankTracker.trackRanks();
    } catch (err) { logger.error(`Rank tracking failed: ${err.message}`); }
  }, { timezone: 'America/New_York' });

  // DAILY 2:30AM — AI Overview check (top 20 keywords)
  cron.schedule('30 2 * * *', async () => {
    if (!isEnabled('seoIntelligence')) return;
    logger.info('Running: AI Overview tracking');
    try {
      const AIOverviewTracker = require('./seo/ai-overview-tracker');
      await AIOverviewTracker.trackDaily();
    } catch (err) { logger.error(`AI Overview tracking failed: ${err.message}`); }
  }, { timezone: 'America/New_York' });

  // DAILY 3:00AM — LLM mention probe (ChatGPT/Gemini/Claude/AI Overview)
  cron.schedule('0 3 * * *', async () => {
    if (!isEnabled('seoIntelligence')) return;
    logger.info('Running: LLM mention probe');
    try {
      const prober = require('./seo/llm-mention-prober');
      await prober.runDaily();
    } catch (err) { logger.error(`LLM mention probe failed: ${err.message}`); }
  }, { timezone: 'America/New_York' });

  // MONTHLY (1st, 4AM) — Competitor keyword gap mining. Pulls tracked
  // competitors' ranked keywords from DataForSEO Labs, diffs against our
  // rankings + live sitemap, enqueues blog gaps the GSC/AEO miners
  // structurally can't see (zero-footprint topics). ~$1.30/run.
  // Monthly matches the queue's 30-day row expiry — on the original
  // quarterly cadence, 96 of 157 mined rows expired unclaimed during the
  // 60-day dead window between shelf life and the next revival re-mine.
  // runExclusive: the Labs pulls cost real money — never double-run.
  cron.schedule('0 4 1 * *', async () => {
    if (!isEnabled('seoIntelligence')) return;
    logger.info('Running: Competitor keyword gap mining (monthly)');
    try {
      await runExclusive('competitor-gap-miner', async () => {
        const miner = require('./seo/competitor-gap-miner');
        await miner.mineAll();
      });
    } catch (err) { logger.error(`Competitor gap mining failed: ${err.message}`); }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // WEEKLY SUNDAY 4:30AM — Terminate stale outreach rows for soft-deleted
  // customers. The cron-side deleted_at filters only SKIP these rows, and
  // the terminal pre-passes only catch rows as they come due — anything
  // armed before a customer was archived (or before those guards shipped)
  // sits pending forever and would fire stale if the customer is restored.
  // =========================================================================
  cron.schedule('30 4 * * 0', async () => {
    logger.info('Running: deleted-customer outreach row cleanup');
    try {
      await runExclusive('deleted-customer-row-cleanup', async () => {
        const deletedCustomers = db('customers').select('id').whereNotNull('deleted_at');

        const reminders = await db('appointment_reminders')
          .where({ cancelled: false })
          .whereIn('customer_id', deletedCustomers.clone())
          .update({ cancelled: true, updated_at: new Date() });

        const reviews = await db('review_requests')
          .where({ status: 'pending' })
          .whereIn('customer_id', deletedCustomers.clone())
          .update({ status: 'suppressed' });

        const followups = await db('invoice_followup_sequences')
          .whereIn('status', ['active', 'autopay_hold'])
          .whereIn('customer_id', deletedCustomers.clone())
          .update({ status: 'paused', next_touch_at: null, updated_at: new Date() });

        if (reminders || reviews || followups) {
          logger.info(`[deleted-cleanup] Terminated stale rows for archived customers: ${reminders} reminder(s), ${reviews} review request(s), ${followups} invoice follow-up sequence(s)`);
        }
      });
    } catch (err) {
      logger.error(`Deleted-customer row cleanup failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // WEEKLY SUNDAY 3:30AM — Backlink scan
  cron.schedule('30 3 * * 0', async () => {
    if (!isEnabled('seoIntelligence')) return;
    logger.info('Running: Backlink scan');
    try {
      const BacklinkMonitor = require('./seo/backlink-monitor');
      await BacklinkMonitor.scan();
    } catch (err) { logger.error(`Backlink scan failed: ${err.message}`); }
  }, { timezone: 'America/New_York' });

  // DAILY 4:30AM — Link prospect verifier (live/follow reconcile + crawl fallback)
  cron.schedule('30 4 * * *', async () => {
    logger.info('Running: Link prospect verifier');
    try {
      const Verifier = require('./seo/link-prospect-verifier');
      await Verifier.run();
    } catch (err) { logger.error(`Link prospect verifier failed: ${err.message}`); }
  }, { timezone: 'America/New_York' });

  // DAILY 5:00AM — Link prospect indexer (linking-page index via DataForSEO + target-page via GSC)
  cron.schedule('0 5 * * *', async () => {
    if (!isEnabled('seoIntelligence')) return;
    logger.info('Running: Link prospect indexer');
    try {
      const Indexer = require('./seo/link-prospect-indexer');
      await Indexer.run();
    } catch (err) { logger.error(`Link prospect indexer failed: ${err.message}`); }
  }, { timezone: 'America/New_York' });

  // HOURLY :15 — release stale Hermes worker claims back to the prospect pool
  cron.schedule('15 * * * *', async () => {
    try {
      const Worker = require('./seo/link-prospect-worker');
      await Worker.sweepExpiredClaims();
    } catch (err) { logger.error(`Link prospect claim sweep failed: ${err.message}`); }
  }, { timezone: 'America/New_York' });

  // WEEKLY SUN 3:00AM — Signup-lane classifier: triage directory/citation prospects
  // (free / paid / account-gated / off-target) → automation_policy, so the runner
  // only ever auto-submits the free, automation-safe ones. Read-mostly.
  cron.schedule('0 3 * * 0', async () => {
    if (!isEnabled('signupRunner')) return;
    logger.info('Running: signup-lane classifier');
    try {
      const classifier = require('./seo/signup-classifier');
      const r = await classifier.run({ limit: 200 });
      logger.info(`[signup-classifier] classified=${r.classified} ${JSON.stringify(r.byPolicy)}`);
    } catch (err) { logger.error(`Signup classifier failed: ${err.message}`); }
  }, { timezone: 'America/New_York' });

  // DAILY 3:30AM — Citation submission runner: auto-submit allowlisted submit_free
  // listings (fail-closed on account/CAPTCHA/payment). No-op without an allowlist
  // (SIGNUP_RUNNER_ALLOWLIST) — supervised-first. Never pays (Phase 2).
  cron.schedule('30 3 * * *', async () => {
    if (!isEnabled('signupRunner')) return;
    logger.info('Running: citation submission runner');
    try {
      // runExclusive: this makes LIVE third-party submissions — a deploy overlap or a
      // second app instance firing the same cron would turn one supervised batchSize:5
      // run into 10+ real listings (worker.claim dedupes rows, not whole batches).
      await runExclusive('signup-runner', async () => {
        const r = require('./seo/signup-runner');
        const res = await r.run({ batchSize: 5 });
        logger.info(`[signup-runner] cron: ${JSON.stringify(res)}`);
      });
    } catch (err) { logger.error(`Citation runner failed: ${err.message}`); }
  }, { timezone: 'America/New_York' });

  // DAILY 2:00AM — Backlink outreach drafter: claim outreach prospects, draft 1:1
  // pitches via Claude, park as 'drafted' for the morning approval queue. NEVER
  // sends. Gated by outreachDrafter (default OFF in prod) — independent of the
  // send gate, so drafts can be reviewed before sends are armed.
  cron.schedule('0 2 * * *', async () => {
    if (!isEnabled('outreachDrafter')) return;
    logger.info('Running: Backlink outreach drafter');
    try {
      const drafter = require('./seo/backlink-outreach-drafter');
      const r = await drafter.run({ batchSize: 10 });
      logger.info(`[outreach-drafter] cron: claimed=${r.claimed} drafted=${r.drafted} skipped=${r.skipped} failed=${r.failed}`);
    } catch (err) { logger.error(`Backlink outreach drafter failed: ${err.message}`); }
  }, { timezone: 'America/New_York' });

  // WEEKLY MONDAY 4:00AM — Proactive local-opportunity prospector: discover local
  // sponsorship / charity-run / chamber / community-calendar / podcast link targets via
  // SERP and promote the scored, lane-routed rows onto the prospect board (outreach +
  // signup lanes). Gated localOpportunityProspector (default OFF in prod). Read-only
  // discovery + dedupe-guarded inserts; NEVER sends — the outreach drafter / citation
  // lanes act on the rows, still behind their own gates. runExclusive guards a deploy
  // overlap from double-spending the SERP/contact API budget (inserts dedupe anyway).
  cron.schedule('0 4 * * 1', async () => {
    if (!isEnabled('localOpportunityProspector')) return;
    logger.info('Running: local-opportunity prospector');
    try {
      await runExclusive('local-opportunity-prospector', async () => {
        const promoter = require('./seo/local-opportunity-promoter');
        const r = await promoter.run({});
        logger.info(`[local-opportunity] cron: discovered=${r.discovered} promoted=${r.promoted} dupes=${r.dupes} held=${r.heldBack} byLane=${JSON.stringify(r.byLane)}`);
      });
    } catch (err) { logger.error(`Local-opportunity prospector failed: ${err.message}`); }
  }, { timezone: 'America/New_York' });

  // WEEKLY MONDAY 1:30AM — Full site technical audit
  cron.schedule('30 1 * * 1', async () => {
    if (!isEnabled('seoIntelligence')) return;
    logger.info('Running: Site-wide technical audit');
    try {
      const SiteAuditor = require('./seo/site-auditor');
      await SiteAuditor.runSiteAudit();
    } catch (err) { logger.error(`Site audit failed: ${err.message}`); }
  }, { timezone: 'America/New_York' });

  // WEEKLY MONDAY 5:00AM — BI Briefing Agent (Monday morning SMS to Adam)
  cron.schedule('0 5 * * 1', async () => {
    logger.info('Running: Weekly BI Briefing Agent');
    try {
      const BIAgent = require('./bi-agent');
      await BIAgent.run();
    } catch (err) {
      logger.error(`BI Briefing Agent failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // WEEKLY MONDAY 5:30AM — Content decay check
  cron.schedule('30 5 * * 1', async () => {
    if (!isEnabled('seoIntelligence')) return;
    logger.info('Running: Content decay detection');
    try {
      const ContentDecay = require('./seo/content-decay');
      await ContentDecay.detect();
      const Cannibalization = require('./seo/cannibalization');
      await Cannibalization.detect();
    } catch (err) { logger.error(`Content decay/cannibalization failed: ${err.message}`); }
  }, { timezone: 'America/New_York' });

  // DAILY 7:15AM ET — Refresh customer-insight clusters before the opportunity
  // miner + runner so customer-question pages draw on current first-party data.
  // Reader against call_log / messages / google_reviews (consent + suppression
  // gated, PII-redacted); writes ONLY customer_insight_clusters aggregates —
  // never raw transcripts. Without this the clusters table goes stale (it was
  // empty in prod until the first manual run). Same gate as the engine.
  cron.schedule('15 7 * * *', async () => {
    if (!isEnabled('autonomousContentEngine')) return;
    logger.info('Running: Customer Insights Miner');
    try {
      const insightsMiner = require('./content/customer-insights-miner');
      const result = await insightsMiner.mineAll({ days: 120, persist: true });
      const persistedCount = Array.isArray(result?.persisted) ? result.persisted.length : (result?.persisted ?? '?');
      logger.info(`Customer insights mine: ${result?.cluster_count ?? '?'} clusters (${result?.qualifying_count ?? '?'} qualifying), ${persistedCount} persisted`);
    } catch (err) { logger.error(`Customer insights miner failed: ${err.message}`); }
  }, { timezone: 'America/New_York' });

  // DAILY 7:30AM ET — Mine fresh GSC opportunities before the 9AM runner.
  // Writes only opportunity_queue rows. The runner still chooses by score and
  // per-lane shadow/canary guards decide whether anything can publish.
  cron.schedule('30 7 * * *', async () => {
    if (!isEnabled('autonomousContentEngine')) return;
    logger.info('Running: Autonomous Content Opportunity Miner');
    // Queue janitors run BEFORE the mine (each fail-soft so a janitor error
    // never blocks mining):
    //   - expireStale: age out unclaimed pendings past expires_at. Ordering
    //     matters — the mine that follows immediately re-pends any signal
    //     that is still live (with a fresh expires_at), so 'expired' only
    //     sticks for signals that stopped being mined.
    //   - sweepExhaustedAttempts: pending rows over the lifetime claim
    //     budget become visible skipped/attempts_exhausted rows (claimNext
    //     already refuses them; without the sweep they'd sit as invisible
    //     zombies). skipped is sticky in the mine's upsert, so they stay
    //     swept until an operator requeues (which resets the counter).
    try {
      const queue = require('./content/opportunity-queue');
      await queue.expireStale();
      await queue.sweepExhaustedAttempts();
    } catch (err) { logger.warn(`Opportunity-queue janitor failed (mining continues): ${err.message}`); }
    try {
      await runAutonomousOpportunityMining();
    } catch (err) { logger.error(`Autonomous opportunity miner failed: ${err.message}`); }
  }, { timezone: 'America/New_York' });

  // DAILY 9AM ET — Autonomous Content Engine daily run (7 days/week).
  // Per v3.1 plan: ET-pinned, shadow mode by default until
  // SHADOW_MODE_<ACTION_TYPE>=false is set per action type. Action types
  // with AUTO_PUBLISH_<ACTION_TYPE>=true skip the human trust-build ramp.
  // Gated behind GATE_AUTONOMOUS_CONTENT so it stays inert in prod
  // until Adam explicitly enables it.
  cron.schedule('0 9 * * *', async () => {
    if (!isEnabled('autonomousContentEngine')) return;
    logger.info('Running: Autonomous Content Engine daily');
    try {
      const AutonomousRunner = require('./content/autonomous-runner');
      await AutonomousRunner.runDaily();
    } catch (err) { logger.error(`Autonomous content engine failed: ${err.message}`); }
  }, { timezone: 'America/New_York' });

  // DAILY 1PM ET — Autonomous Content Engine catch-up. A deploy restarting
  // the container mid-batch killed the 9am run in place on 2026-06-12 —
  // zero posts AND zero alerts, with claimable work still queued. The
  // catch-up re-runs the batch only when no blog post has started today
  // and claimable rows remain (runCatchUp checks both); the engine
  // advisory lock + per-day/week publish caps make a second pass safe.
  // Kill switch: AUTONOMOUS_CONTENT_CATCHUP=false.
  cron.schedule('0 13 * * *', async () => {
    if (!isEnabled('autonomousContentEngine')) return;
    logger.info('Running: Autonomous Content Engine catch-up');
    try {
      const AutonomousRunner = require('./content/autonomous-runner');
      await AutonomousRunner.runCatchUp();
    } catch (err) { logger.error(`Autonomous content engine catch-up failed: ${err.message}`); }
  }, { timezone: 'America/New_York' });

  // DAILY 8AM ET — Content-optimization impact tracker. Snapshots a baseline
  // for newly-live optimizations, then fills the 14d/21d diff-in-diff windows
  // and records control-adjusted verdicts. Read-only against gsc_pages; writes
  // only content_optimization_impact. Same gate as the engine.
  // EVERY 10 MIN — Owner email-approval poller (2026-07-28). Reads the
  // contact@ inbox (IMAP, read-only) for "approved"/"not approved" replies
  // to parked-run approval emails and executes the decision through the
  // same entrypoints as the operator script. Skips the connection entirely
  // when nothing is awaiting. Kill switch: unset GATE_CONTENT_EMAIL_APPROVALS.
  cron.schedule('*/10 * * * *', async () => {
    if (!isEnabled('contentEmailApprovals')) return;
    try {
      // runExclusive: a deploy-overlap second instance must not double-send
      // approval emails or double-process replies.
      await runExclusive('email-approval-poll', async () => {
        const emailApprovals = require('./content/email-approvals');
        const result = await emailApprovals.pollReplies();
        if (result?.decided) logger.info(`Email approvals: ${result.decided} decision(s) executed`);
      });
    } catch (err) { logger.error(`Email-approval poll failed: ${err.message}`); }
  }, { timezone: 'America/New_York' });

  cron.schedule('0 8 * * *', async () => {
    if (!isEnabled('autonomousContentEngine')) return;
    logger.info('Running: content-optimization impact tracker');
    try {
      // The MEASUREMENT pass and the REPORTING leg share one cross-instance
      // lease. Locking only the digest is not enough: checkPending stamps
      // checked_14d_at / checked_21d_at with the `now` it captured at entry,
      // so during a Railway deploy overlap the other instance can begin before
      // the digest's cutoff and commit after it, writing a timestamp BELOW
      // that cutoff. The rollup's query would miss the row (not yet committed)
      // and the next window's exclusive boundary would skip it forever. No
      // cutoff can fix that — a wall-clock stamp cannot express commit order —
      // so the two phases must not interleave across instances at all.
      // Overlapping ticks return { skipped: 'lease_held' } and self-heal
      // tomorrow; nesting is safe because runExclusive takes its own pooled
      // connection per lock key.
      await runExclusive('impact-tracker-daily', async () => {
        const ImpactTracker = require('./seo/impact-tracker');
        const live = await ImpactTracker.sweepNewlyLive({});
        const checked = await ImpactTracker.checkPending({});
        await ImpactTracker.checkAeoVisibility({});
        // Leg 4 — surface what the sweep just found (halted lanes, weekly
        // verdicts). Chained here rather than given its own cron so it always
        // describes POST-sweep state.
        //
        // Chaining alone is still not enough: sweepNewlyLive/checkPending
        // CATCH a failed query and resolve with { error } rather than
        // throwing, so a failed sweep looks identical to a quiet one from
        // here. Running the digest anyway would email and stamp a weekly
        // rollup built on PRE-sweep verdicts and then suppress the corrected
        // one for six days. (checkAeoVisibility is not gated on: it writes
        // only aeo_* columns, which no digest leg reads.)
        if (live?.error || checked?.error) {
          logger.warn(`[impact-digest] sweep incomplete — skipping digests this tick (${live?.error || checked?.error})`);
          return;
        }
        // The digest keeps its own lease (it is also reachable from the CLI
        // preview and any future ad-hoc run). runExclusive RETURNS
        // { skipped: true, reason } instead of throwing, so an unignored pool
        // exhaustion would let reporting never run while this outer job still
        // recorded success — the precise blindness this leg exists to remove.
        const digested = await require('./seo/impact-verdict-digest').sendImpactDigestsIfDue({});
        if (digested?.skipped === true) {
          throw new Error(`impact digest did not run (${digested.reason || 'lease'})`);
        }
      });
    } catch (err) { logger.error(`Impact tracker failed: ${err.message}`); }

    // Reversal leg — hand pages we confirmed we made WORSE back to the
    // existing refresh lane. Chained after the sweep so it reads the verdicts
    // checkPending just wrote, but in its OWN try: checkPending has no per-row
    // catch around measurement and persistence, so a single permanently
    // failing impact row rejects the block above every single day. Sharing one
    // try would let that one row starve the entire confirmed-regression
    // backlog indefinitely. Already-written verdicts stay actionable even when
    // the sweep that would have added more to them died.
    //
    // Outside the impact-tracker-daily lease on purpose, and safe there: this
    // leg has its own runExclusive, and unlike the rollup it scans on
    // `requeued_at IS NULL` rather than a time window — so a verdict written
    // by an overlapping instance after this scan is simply picked up tomorrow,
    // never skipped. Moving it inside the lease would restore the starvation
    // above without buying anything.
    try {
      const requeued = await require('./seo/regression-requeue').requeueRegressedPages({});
      // runExclusive RETURNS { skipped: true, reason } rather than throwing.
      // 'lease_held' is benign — another instance is doing the work. Anything
      // else (notably 'no_connection' under pool exhaustion) means the sweep
      // never ran, and must not read as a healthy night.
      if (requeued?.skipped === true && requeued.reason !== 'lease_held') {
        throw new Error(`regression re-queue did not run (${requeued.reason || 'unknown'})`);
      }
    } catch (err) { logger.error(`Regression re-queue failed: ${err.message}`); }
  }, { timezone: 'America/New_York' });

  // DAILY 8:10AM ET — Parked-content digest (owner-authorized lane
  // 2026-08-07). Emails contact@ an ACT: rollup of autonomous runs parked as
  // completed_pending_review — the non-approvable kinds the email-approval
  // poller never emails, which otherwise sit invisibly on the review queue.
  // Exception-based: sends only when NEW runs parked since the last SENT
  // digest; Sundays send a full digest whenever the parked set is non-empty;
  // an empty set never sends. Read-only over runs/opportunities — the only
  // write is its own ops_email_send_state watermark, advanced ONLY after a
  // confirmed send (fail-closed). runExclusive so a deploy-overlap tick
  // can't double-send. Kill switch: unset GATE_PARKED_RUN_DIGEST.
  cron.schedule('10 8 * * *', async () => {
    if (!isEnabled('parkedRunDigest')) return;
    try {
      await runExclusive('parked-run-digest', async () => {
        const parkedRunDigest = require('./content/parked-run-digest');
        const result = await parkedRunDigest.runParkedRunDigest();
        if (result?.sent) {
          logger.info(`Parked-run digest sent: ${result.total} parked (${result.newCount} new)`);
        }
        // Delivery-blocking failures must surface in job_health as FAILED —
        // a visibility lane that fails quietly is the bug this lane exists
        // to fix. Quiet skips (gate off / nothing new) stay successful.
        if (result?.sent === false) throw new Error(`parked-run digest send failed: ${result.error || 'unknown'}`);
        if (result?.skipped === 'query_failed' || result?.skipped === 'recipient') {
          throw new Error(`parked-run digest blocked: ${result.skipped}`);
        }
      });
    } catch (err) { logger.error(`Parked-run digest failed: ${err.message}`); }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 4AM — Newsletter event ingestion (P3a). Pulls every enabled
  // RSS source from event_sources, upserts into events_raw. Daily cadence
  // (vs weekly with the newsletter draft) so events added shortly before
  // a Tuesday issue still make it into the dashboard tiles.
  // =========================================================================
  cron.schedule('0 4 * * *', async () => {
    logger.info('Running: Newsletter event ingestion');
    try {
      const EventIngestion = require('./event-ingestion');
      await EventIngestion.ingestAllEnabledSources();
    } catch (err) {
      logger.error(`Event ingestion failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 3:45AM ET — Sweep payment_method_consents whose FK to
  // payment_methods never got backfilled. The webhook does the link in
  // real time, but a missed webhook past Stripe's 72h retry window
  // leaves the row orphaned. Nightly sweep tries to match by
  // stripe_payment_method_id and links any payment_methods row that
  // landed without firing the webhook hook.
  // =========================================================================
  cron.schedule('45 3 * * *', async () => {
    try {
      const { sweepOrphanConsents } = require('./payment-method-consents');
      const result = await sweepOrphanConsents({ olderThanHours: 24, staleAfterDays: 30 });
      if (result.linked > 0 || result.stale > 0) {
        logger.info(`[consents-sweep] ${result.total} orphan(s); linked ${result.linked}; ${result.stale} stale beyond 30d`);
      }
    } catch (err) {
      logger.error(`Consents sweep failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 4:20AM ET — Prune the inbound-webhook idempotency ledger. Twilio
  // never redelivers a webhook days later, so a 7-day horizon is ample; this
  // keeps inbound_webhook_events from growing unbounded.
  // =========================================================================
  cron.schedule('20 4 * * *', async () => {
    try {
      const { pruneInboundWebhookEvents } = require('./messaging/inbound-dedupe');
      const deleted = await pruneInboundWebhookEvents({ olderThanDays: 7 });
      if (deleted > 0) logger.info(`[inbound-dedupe] Pruned ${deleted} stale webhook dedupe row(s)`);
    } catch (err) {
      logger.error(`[inbound-dedupe] Prune cron failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 2:45AM ET — Voice-corpus miner (SMS brand-voice loop, Phase A).
  // Mines human-authored SMS replies (on a 7-day-delayed band so each
  // pair's outcome window has closed before the row freezes) + recent
  // consent-gated labeled call transcripts into voice_corpus_examples
  // (redacted). Overlapping 3-day bands + insert-ignore = idempotent, so
  // a missed night self-heals on the next run.
  // =========================================================================
  cron.schedule('45 2 * * *', async () => {
    if (!isEnabled('voiceCorpusMiner')) return;
    logger.info('Running: Voice-corpus miner');
    try {
      const { runExclusive } = require('../utils/cron-lock');
      const { mineVoiceCorpus } = require('./sms-voice-corpus-miner');
      await runExclusive('voice-corpus-miner', () => mineVoiceCorpus({ sinceDays: 3 }));
    } catch (err) {
      logger.error(`Voice-corpus miner failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 3:05AM ET — Call-research miner (voice-of-customer corpus).
  // Extracts verbatim (double-redacted) quote chunks from call transcripts
  // into call_research_chunks, tagged with the fixed research taxonomy.
  // Runs after the 2:40 knowledge sync + 2:45 voice-corpus miner; chunks
  // embed via the NEXT night's knowledge-index sync. Claims via
  // call_log.research_mined_at — a prompt-version bump re-mines the whole
  // corpus over successive nights; failed extractions retry nightly.
  // =========================================================================
  cron.schedule('5 3 * * *', async () => {
    if (!isEnabled('callResearchMiner')) return;
    logger.info('Running: Call-research miner');
    try {
      const { runExclusive } = require('../utils/cron-lock');
      const { mineCallResearch } = require('./call-research-miner');
      await runExclusive('call-research-miner', () => mineCallResearch({ limit: 150 }));
    } catch (err) {
      logger.error(`Call-research miner failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // HOURLY :40 — Call re-transcription backfill (voice-corpus training).
  // Upgrades consented legacy recordings to diarized transcripts (batch-
  // capped); the nightly miner then folds them into the voice corpus. One
  // attempt per call ever; no-ops once the backlog drains.
  // =========================================================================
  cron.schedule('40 * * * *', async () => {
    // Both gates: this job exists ONLY to feed the corpus miner — paying to
    // re-transcribe while the miner is dark would upgrade transcripts nobody
    // consumes.
    if (!isEnabled('callRetranscribeBackfill') || !isEnabled('voiceCorpusMiner')) return;
    try {
      const { runExclusive } = require('../utils/cron-lock');
      const { runRetranscriptionBackfill } = require('./call-retranscription-backfill');
      await runExclusive('call-retranscribe-backfill', () => runRetranscriptionBackfill());
    } catch (err) {
      logger.error(`Call re-transcription backfill failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 3:30AM ET — Voice-profile distiller (brand-voice loop, Loop 2).
  // Runs after the 2:45am corpus miner so each day's calls/texts feed the
  // voice profile the next morning (owner directive 2026-07-11: train on the
  // data as it happens, hands-off). Exception-based review: a GREEN profile
  // auto-applies (audit-logged); anything flagged parks + bells. At most one
  // DEEP call per day; idle days skip on no-new-corpus.
  // =========================================================================
  cron.schedule('30 3 * * *', async () => {
    if (!isEnabled('voiceProfileDistiller')) return;
    logger.info('Running: Voice-profile distiller');
    try {
      const { runExclusive } = require('../utils/cron-lock');
      const { distillVoiceProfile } = require('./voice-profile-distiller');
      const result = await runExclusive('voice-profile-distiller', () => distillVoiceProfile());
      if (result?.skipped) logger.info(`[voice-profile] run skipped: ${result.skipped}`);
      else if (result?.version) logger.info(`[voice-profile] run complete: v${result.version} pending review`);
    } catch (err) {
      logger.error(`Voice-profile distiller failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 3:55AM ET — Shadow judge (SMS brand-voice loop, Phase C). Pairs
  // each 24h-matured shadow draft with the human reply that actually went
  // out and scores it per intent class. LLM only when the human replied;
  // batch-capped; unjudged drafts retry next night (anti-join).
  // =========================================================================
  cron.schedule('55 3 * * *', async () => {
    if (!isEnabled('shadowJudge')) return;
    logger.info('Running: Shadow judge');
    try {
      const { runExclusive } = require('../utils/cron-lock');
      const { judgeShadowDrafts } = require('./sms-shadow-judge');
      await runExclusive('shadow-judge', () => judgeShadowDrafts());
    } catch (err) {
      logger.error(`Shadow judge failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 4:10AM ET — Recover claimed Agent Review decisions + expire stale
  // composer suggestions (brand-voice loop, Phase D). Recovery is NOT gated:
  // the /sms claim path parks ANY verified Agent Review draft (lead
  // workflows included) in status='scheduled' regardless of the suggest-mode
  // gate, and a post-claim crash must never strand those rows invisible.
  // Only the house-voice expiry (pending >48h → expired) is gated.
  // =========================================================================
  cron.schedule('10 4 * * *', async () => {
    logger.info('Running: SMS suggestion recovery + expiry sweep');
    try {
      const { runExclusive } = require('../utils/cron-lock');
      const { recoverSuggestionHoldingStates, expireStaleSuggestions } = require('./sms-suggest-mode');
      const { reconcileAutoSendClaims } = require('./sms-auto-send');
      await runExclusive('sms-suggest-expiry', async () => {
        await recoverSuggestionHoldingStates();
        if (isEnabled('smsSuggestMode')) await expireStaleSuggestions();
        // UNGATED like the suggestion recovery: an auto-send claim left in
        // 'sending' by a crash must be reconciled even if the gate was since
        // turned off (a turned-off gate just stops NEW claims).
        await reconcileAutoSendClaims();
      });
    } catch (err) {
      logger.error(`SMS suggestion recovery/expiry sweep failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });


  // =========================================================================
  // WEEKLY SUN 3:05AM ET — Sealed-eval freezer top-up (brand-voice loop
  // measurement). Pure selection, no LLM spend: freezes judged live drafts
  // (inbound + day-of facts_block + human reply) into sms_sealed_eval_items
  // until the pool reaches SEALED_EVAL_TARGET, so the locked exam keeps
  // coverage as intents shift. Idempotent (anti-join + unique source draft);
  // no-ops once full. Exam RUNS: manual endpoint, plus the gated nightly
  // auto-run sweep below (smsSealedExamAutoRun).
  // =========================================================================
  cron.schedule('5 3 * * 0', async () => {
    if (!isEnabled('smsSealedEval')) return;
    logger.info('Running: Sealed-eval freezer top-up');
    try {
      const { runExclusive } = require('../utils/cron-lock');
      const { sealEvalItems } = require('./sms-sealed-eval');
      await runExclusive('sms-sealed-eval-seal', () => sealEvalItems());
    } catch (err) {
      logger.error(`Sealed-eval freezer failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 5:10AM — Sealed-exam auto-run. Ensures the CURRENT drafter
  // PROMPT_VERSION has a completed exam on every leg (first baselines +
  // every prompt bump); cheap no-op between bumps. Runs after the nightly
  // judge (3:55) and Sunday freezer (3:05) so fresh items/judgments are in.
  // Doubly gated: smsSealedEval (harness live) AND smsSealedExamAutoRun
  // (spend opt-in, kill = unset GATE_SMS_SEALED_EXAM_AUTORUN).
  // =========================================================================
  cron.schedule('10 5 * * *', async () => {
    if (!isEnabled('smsSealedEval') || !isEnabled('smsSealedExamAutoRun')) return;
    logger.info('Running: Sealed-exam auto-run sweep');
    try {
      const { runExclusive } = require('../utils/cron-lock');
      const { runAutoExamSweep } = require('./sms-sealed-eval');
      await runExclusive('sms-sealed-eval-autorun', () => runAutoExamSweep());
    } catch (err) {
      logger.error(`Sealed-exam auto-run sweep failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // HOURLY :15 — Shadow backfill (brand-voice loop accelerator). Drafts
  // house-voice replies for HISTORICAL inbounds that already have a human
  // reply and judges them in the same pass — compresses months of
  // per-intent score accumulation into days. Self-terminating: once
  // history is exhausted every run is a single cheap no-op query. Batch
  // sizes env-tunable (SHADOW_BACKFILL_BATCH / _SINCE_DAYS / _JUDGE_BATCH).
  // =========================================================================
  cron.schedule('15 * * * *', async () => {
    if (!isEnabled('shadowBackfill')) return;
    logger.info('Running: Shadow backfill batch');
    try {
      const { runExclusive } = require('../utils/cron-lock');
      const { runShadowBackfill } = require('./sms-shadow-backfill');
      await runExclusive('shadow-backfill', () => runShadowBackfill());
    } catch (err) {
      logger.error(`Shadow backfill failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 4:20AM ET — Pathology classifier (brand-voice loop diagnostics).
  // Runs after the 3:55am judge: every new draft_unsafe judgment is
  // classified into a fixed (harness surface × failure mode) cell so the
  // top failure cause is standing data, not a hand-run readout. Batch-capped
  // FAST calls; idempotent anti-join.
  // =========================================================================
  cron.schedule('20 4 * * *', async () => {
    if (!isEnabled('smsPathologyLedger')) return;
    logger.info('Running: SMS pathology classifier');
    try {
      const { runExclusive } = require('../utils/cron-lock');
      const { classifyPathologies } = require('./sms-pathology-ledger');
      await runExclusive('sms-pathology-classify', () => classifyPathologies());
    } catch (err) {
      logger.error(`SMS pathology classifier failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // WEEKLY SUN 4:40AM ET — Pathology patch proposer. Cells with enough fresh
  // evidence get ONE parked harness-patch proposal card + bell (Agents →
  // Shadow Drafts). Recommendation only — a human ships any actual prompt
  // change as a PROMPT_VERSION bump. ≤PATHOLOGY_PROPOSAL_MAX_CELLS DEEP
  // calls per week.
  // =========================================================================
  cron.schedule('40 4 * * 0', async () => {
    if (!isEnabled('smsPathologyLedger')) return;
    logger.info('Running: SMS pathology patch proposer');
    try {
      const { runExclusive } = require('../utils/cron-lock');
      const { proposePatches } = require('./sms-pathology-ledger');
      await runExclusive('sms-pathology-propose', () => proposePatches());
    } catch (err) {
      logger.error(`SMS pathology proposer failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 3:30AM ET — Purge stripe_webhook_events older than 90 days.
  // Stripe's retry window is 72h max, so anything past 90d is just historical
  // noise; the table grows ~50–500 rows/day and never shrinks otherwise.
  // Keeps idempotency lookups fast and PG vacuum manageable. The retention
  // window is generous on purpose — operators can still grep for an event
  // ID weeks later without hitting a hole.
  // =========================================================================
  cron.schedule('30 3 * * *', async () => {
    try {
      const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      const db = require('../models/db');
      const purged = await db('stripe_webhook_events')
        .where('received_at', '<', cutoff)
        .del();
      if (purged > 0) {
        logger.info(`[stripe-webhook-purge] Removed ${purged} stripe_webhook_events row(s) older than 90 days`);
      }
    } catch (err) {
      logger.error(`Stripe webhook events purge failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 5AM — Newsletter event normalization (P3b leg 3). One hour
  // after ingestion so newly-pulled rows get Claude venue extraction +
  // Google geocoding in the same day. Capped at 50 rows per run so the
  // Claude API spend is bounded (~$1/day).
  // =========================================================================
  cron.schedule('0 5 * * *', async () => {
    logger.info('Running: Newsletter event normalization');
    try {
      const EventNormalizer = require('./event-normalizer');
      await EventNormalizer.normalizeBatch();
    } catch (err) {
      logger.error(`Event normalization failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 5:30AM — Newsletter event og:image backfill. Half an hour after
  // normalization so today's newly-normalized rows get probed same-day.
  // 25 rows/run, weekly retry backoff, SSRF-hardened transport shared with
  // event-reverify. Kill switch: NEWSLETTER_IMAGE_BACKFILL=false.
  // =========================================================================
  cron.schedule('30 5 * * *', async () => {
    logger.info('Running: Newsletter event image backfill');
    try {
      // runExclusive: deploy-overlap instances would each select the same
      // unstamped batch and double the outbound fetches.
      const EventImageBackfill = require('./event-image-backfill');
      await runExclusive('event-image-backfill', () => EventImageBackfill.backfillBatch());
    } catch (err) {
      logger.error(`Event image backfill failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY MIN — Newsletter scheduled sends (dispatches any whose scheduled_for
  // has passed). Intentionally high-frequency so "send at 8:00am" fires close
  // to the minute. Per-tick work is a single indexed query on newsletter_sends.
  // =========================================================================
  cron.schedule('* * * * *', async () => {
    try {
      const NewsletterSender = require('./newsletter-sender');
      await NewsletterSender.processScheduledSends();
    } catch (err) {
      logger.error(`Newsletter scheduler tick failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // TUESDAYS 7AM ET — Pest Insider monthly autopilot. Fires every Tuesday;
  // runPestInsiderAutopilot's first-Tuesday ET gate + per-month idempotency
  // keep it to one draft a month (node-cron's dom×dow semantics aren't
  // portable, so the gate lives in code). Drafts only — admin reviews and
  // sends manually, same contract as the weekly autopilot. runExclusive:
  // deploy-overlap ticks must not double-draft (the idempotency check is
  // read-then-act).
  // =========================================================================
  cron.schedule('0 7 * * 2', async () => {
    try {
      await runExclusive('pest-insider-autopilot', async () => {
        const { runPestInsiderAutopilot } = require('./pest-insider-autopilot');
        const result = await runPestInsiderAutopilot();
        logger.info(`[pest-insider-autopilot] ${result.skipped ? 'skipped' : 'drafted'}: ${result.reason || result.sendId}`);
      });
    } catch (err) {
      logger.error(`[pest-insider-autopilot] failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY MONDAY 7AM ET — Newsletter autopilot
  // Auto-drafts the weekly flagship digest from approved events. Never
  // auto-sends — creates a draft for admin review. Skips if fewer than 3
  // eligible events and notifies admin to approve more.
  // =========================================================================
  cron.schedule('0 7 * * 1', async () => {
    try {
      const { autoDraftFlagship } = require('./newsletter-autopilot');
      const result = await autoDraftFlagship();
      logger.info(`[newsletter-autopilot] ${result.skipped ? 'skipped' : 'drafted'}: ${result.reason || result.sendId}`);
    } catch (err) {
      logger.error(`[newsletter-autopilot] failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // MONDAY 2PM + TUESDAY 4:30AM ET — Missed-tick catch-up for the Monday-7AM
  // autopilot. The early-Tuesday recovery still leaves 90 minutes for proof
  // approval before the exact 6:00AM delivery target; it never auto-approves.
  // Re-run autoDraftFlagship ONLY for a week that was NEVER ATTEMPTED (no
  // calendar row, or status 'planned'). A deliberately-deleted draft (status
  // 'drafted' with a null send_id) is left alone so it can't silently reappear,
  // and drafted/scheduled/sent/skipped weeks are already handled. The autopilot's
  // own advisory lock + dedupe make a catch-up invocation safe if it races the
  // 7AM run.
  // A catch-up that hard-fails preflight persists a 'skipped' row, so the
  // following day's tick retires the week instead of re-running + re-notifying.
  // =========================================================================
  const runNewsletterAutopilotCatchup = async () => {
    try {
      const { getActiveNewsletterTuesday } = require('./event-freshness');
      const weekOf = getActiveNewsletterTuesday();
      const cal = await db('newsletter_calendar').where('week_of', weekOf).first();
      // Only catch up weeks that were never attempted — but a drafted week
      // may still be missing its owner proof (a transient SendGrid failure
      // releases the proof claim), and autoDraftFlagship is never reached
      // for those rows, so retry the idempotent proof send here.
      if (cal && cal.status !== 'planned') {
        if (cal.status === 'drafted' && cal.send_id) {
          try {
            const { sendNewsletterProof } = require('./newsletter-proof');
            await sendNewsletterProof(cal.send_id);
          } catch (e) {
            logger.warn(`[newsletter-autopilot-catchup] proof retry failed: ${e.message}`);
          }
        }
        return;
      }
      const { autoDraftFlagship } = require('./newsletter-autopilot');
      const result = await autoDraftFlagship();
      logger.info(`[newsletter-autopilot-catchup] ${result.skipped ? 'skipped' : 'drafted'}: ${result.reason || result.sendId}`);
    } catch (err) {
      logger.error(`[newsletter-autopilot-catchup] failed: ${err.message}`);
    }
  };
  cron.schedule('0 14 * * 1', runNewsletterAutopilotCatchup, { timezone: 'America/New_York' });
  cron.schedule('30 4 * * 2', runNewsletterAutopilotCatchup, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 6AM ET — Newsletter indexability decay: noindex stale event digests
  // Event digest archive pages older than 30 days add nothing to search —
  // stale "This Weekend in SWFL" content just dilutes the index. Flips
  // indexability from 'index' → 'noindex' so the Astro archive pages
  // set robots noindex and Google drops them from the SERPs.
  // =========================================================================
  cron.schedule('0 6 * * *', async () => {
    try {
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const count = await db('newsletter_sends')
        .where('newsletter_type', 'local-weekly-fresh-events')
        .where('status', 'sent')
        .where('sent_at', '<', cutoff)
        .where('indexability', 'index')
        .update({ indexability: 'noindex', updated_at: new Date() });
      if (count > 0) logger.info(`[newsletter-decay] Set ${count} stale digest(s) to noindex`);
    } catch (err) {
      logger.error(`[newsletter-decay] failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 6:15AM ET — Event auto-curation. Classifies never-examined pending
  // events with Claude and approves real consumer events for the digest, so
  // Monday's 7AM autopilot has an approved pool without a human working
  // the Event Inbox every week (the lane starved at 0 eligible for two weeks
  // when approval was manual-only). Runs after the 4AM ingest → 5AM
  // normalize → 5:30 expiry → 5:45 dedup chain so it judges clean, classified
  // rows. Rejections stay pending for human review — nothing is auto-rejected.
  // runExclusive: examined-marker writes are idempotent but the Claude calls
  // are not free; don't double-classify on deploy-overlap ticks.
  // Kill switch: EVENT_AUTO_CURATION=false.
  // =========================================================================
  cron.schedule('15 6 * * *', async () => {
    try {
      await runExclusive('event-auto-curation', async () => {
        const { runAutoCuration } = require('./event-curation');
        const result = await runAutoCuration();
        if (result.examined > 0 || result.approved > 0) {
          logger.info(`[event-curation] examined ${result.examined}, approved ${result.approved}`);
        }
      });
    } catch (err) {
      logger.error(`[event-curation] failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // WEEKLY MONDAY 3:20AM ET — Incident regression eval. Replays the incident
  // corpus (server/fixtures/incident-eval/) through the LIVE fact-check gate
  // and inbox classifier and notifies admin on regression. The jest tests for
  // these components mock the model, so prompt edits, MODEL_* env swaps, and
  // provider-side drift are invisible to CI — and both components degrade
  // silently (the gate fails open; a classifier drift just fires a different
  // auto-action). Each case is a real past incident; see the corpus README.
  // Read-only against business data: classification runs through the pure
  // classifyEmailContent path (no emails-row writes, no auto-actions).
  // runExclusive: ~10 LLM calls; don't double-spend on deploy-overlap ticks.
  // Kill switch: GATE_INCIDENT_EVAL=false.
  // =========================================================================
  cron.schedule('20 3 * * 1', async () => {
    if (!isEnabled('incidentRegressionEval')) return;
    logger.info('Running: incident regression eval');
    try {
      await runExclusive('incident-regression-eval', async () => {
        const { runIncidentEval } = require('./eval/incident-regression');
        const result = await runIncidentEval();
        logger.info(`Incident eval done: ${result.passed}/${result.total} passed, ${result.failed} failed, ${result.inconclusive} inconclusive`);
      });
    } catch (err) {
      logger.error(`Incident regression eval failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // WEEKLY MONDAY 3:40AM ET — Call extraction replay eval. Replays the
  // reviewed-call fixture (server/fixtures/call-extraction-eval/) through the
  // LIVE v2 extractor and notifies admin on repeated fixture/replay failure.
  // The fixture stores only call ids and expected routing/scheduling shape; the
  // replay reads production call_log rows but does not write business records.
  // runExclusive: live model calls; don't double-spend on deploy-overlap ticks.
  // Kill switch: GATE_CALL_REPLAY_EVAL=false.
  // =========================================================================
  cron.schedule('40 3 * * 1', async () => {
    if (!isEnabled('callReplayEval')) return;
    logger.info('Running: call extraction replay eval');
    try {
      await runExclusive('call-extraction-replay-eval', async () => {
        const { runCallExtractionReplayEval } = require('./eval/call-extraction-replay');
        const result = await runCallExtractionReplayEval();
        logger.info(`Call extraction replay eval done: status=${result.status}${result.flaky ? ' flaky=true' : ''} checked=${result.checked} replayErrors=${result.replayErrors} failedExpectations=${result.fixtureExpectations.failed || 0}`);
      });
    } catch (err) {
      logger.error(`Call extraction replay eval failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 5:30AM ET — Expire past events. classifyFreshness never emits an
  // 'expired' status and nothing else transitions an event out of its fresh
  // state once its date passes, so a one_time/annual event would keep its high
  // freshness_score forever. Mark anything whose effective date (end_at for
  // multi-day, else start_at) is before ET-today as expired so the terminal
  // rejects in isEligibleForFreshDigest + the editorial fetch filters reflect
  // reality and admin/ranking views aren't polluted by past events. Expire-only:
  // an event re-dated back into the future is revived by the ingestion merge
  // (clears freshness) + the normalizer recompute, NOT here — a date-based
  // reviver couldn't tell a system-expired row from an admin's manual 'expired'
  // curation, but ingestion seeing the date move past→future is unambiguous.
  // =========================================================================
  cron.schedule('30 5 * * *', async () => {
    try {
      const { parseETDateTime, etDateString } = require('../utils/datetime-et');
      const etMidnightToday = parseETDateTime(`${etDateString()}T00:00:00`);
      const count = await db('events_raw')
        .whereNot('freshness_status', 'expired')
        .whereRaw('COALESCE(end_at, start_at) < ?', [etMidnightToday])
        .update({ freshness_status: 'expired', freshness_score: 0, updated_at: new Date() });
      if (count > 0) logger.info(`[event-expiry] Marked ${count} past event(s) expired`);
    } catch (err) {
      logger.error(`[event-expiry] failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 5:45AM ET — Cross-source duplicate auto-merge. Ingest dedupes only on
  // (source_id, external_id), so the same real-world event pulled from two feeds
  // becomes two rows and could both reach a digest. Cluster upcoming events
  // (normalized title + ET day + city — conservative, near-zero false positives)
  // and collapse each cluster into one survivor (highest-priority source, then
  // most complete). Runs after the 5AM normalize + 5:30AM expire, before the
  // Monday-7AM autopilot, so the lineup it sees is already de-duplicated.
  // =========================================================================
  cron.schedule('45 5 * * *', async () => {
    try {
      const { autoMergeDuplicates } = require('./event-dedup');
      await autoMergeDuplicates();
    } catch (err) {
      logger.error(`[event-dedup] auto-merge run failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 3AM ET — Purge stale double-opt-in pending subscribers. A 'pending'
  // row whose confirmation link aged past the purge window (30d) never
  // confirmed; delete it so the table doesn't accrue dead rows and the email is
  // free for a fresh signup. (The link already stops confirming after 7d via
  // the lookupByToken TTL.)
  // =========================================================================
  cron.schedule('0 3 * * *', async () => {
    try {
      const { purgeStalePendingSubscribers } = require('./newsletter-subscribers');
      const removed = await purgeStalePendingSubscribers();
      if (removed > 0) logger.info(`[newsletter] Purged ${removed} stale pending subscriber(s)`);
    } catch (err) {
      logger.error(`[newsletter-pending-purge] failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY MIN — Automation runner. Fires the next step of any enrollment
  // whose next_send_at has passed. Indexed query on automation_enrollments.
  // =========================================================================
  cron.schedule('* * * * *', async () => {
    try {
      // Every-minute cadence + multi-second SendGrid sends = the next
      // tick (or an overlapping deploy instance) re-selects enrollments
      // whose cursor hasn't advanced yet — duplicate customer emails.
      await runExclusive('automation-runner', async () => {
        const AutomationRunner = require('./automation-runner');
        await AutomationRunner.processDueSteps();
      });
    } catch (err) {
      logger.error(`Automation runner tick failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // EVERY MIN — retry transactional emails that SendGrid accepted but the
  // receiving server rejected for provider reputation/content/IP reasons.
  // The retry service owns bounded backoff, suppression rechecks, exact-body
  // replay, and exhaustion alerts. Hard bounces never enter this queue.
  cron.schedule('* * * * *', async () => {
    try {
      await runExclusive('transactional-email-provider-retry', async () => {
        await require('./transactional-email-provider-retry').runDueRetries();
      });
    } catch (err) {
      logger.error(`[email-provider-retry] tick failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY MIN — Email template automation executor. Sends due delayed/retry
  // runs created by trigger-mapped email template automations.
  // =========================================================================
  cron.schedule('* * * * *', async () => {
    try {
      if (!isEnabled('emailTemplateAutomations')) return;
      const EmailTemplateAutomationExecutor = require('./email-template-automation-executor');
      await EmailTemplateAutomationExecutor.processDueRuns();
    } catch (err) {
      logger.error(`Email template automation tick failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 15 MIN — Appointment reminders (72h, 24h) from appointment_reminders table
  // =========================================================================
  cron.schedule('*/15 * * * *', async () => {
    try {
      await runExclusive('appointment-reminders', async () => {
        const reminders = require('./appointment-reminders');
        await reminders.checkAndSendReminders();
        // Settle stale cancellation-notice leases (GATE_CANCEL_NOTICE_HOOK;
        // no-op while the gate is off) — the durable half of the
        // shared-writer cancellation-notice hook in job-status.js.
        await reminders.sweepStaleCancellationClaims();
      });
    } catch (err) {
      logger.error(`Reminder check failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 10 MIN — Deliver queued new-recurring welcome texts. Booking paths
  // enqueue the welcome (sms_sequences, ~1h delay) so it never lands
  // back-to-back with the appointment confirmation; this tick sends the ones
  // whose delay has elapsed. runExclusive: overlapping deploy instances
  // would double-text the same queued row.
  // =========================================================================
  cron.schedule('*/10 * * * *', async () => {
    try {
      await runExclusive('new-recurring-welcome-queue', async () => {
        const { processDueWelcomes } = require('./new-recurring-welcome-sms');
        const result = await processDueWelcomes();
        if (result.sent > 0 || result.errors > 0) {
          logger.info(`New-recurring welcome queue: ${result.sent} sent, ${result.skipped} skipped, ${result.errors} errors`);
        }
      });
    } catch (err) {
      logger.error(`New-recurring welcome queue failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 15 MIN — Storm watch. Probes the NWS hourly forecast at the
  // CUSTOMER coordinates of each tech's upcoming stops and nudges the
  // tech (tech_notifications, same channel as geofence prompts) when
  // heavy rain crosses the threshold inside the look-ahead. Notify-only:
  // never reschedules, never texts customers. Internally gated to ET
  // service hours + one alert per job per day. runExclusive because
  // overlapping deploy instances would double-ping techs.
  // =========================================================================
  cron.schedule('*/15 * * * *', async () => {
    try {
      await runExclusive('storm-watch', async () => {
        const StormWatch = require('./storm-watch');
        await StormWatch.sweep();
      });
    } catch (err) {
      logger.error(`Storm watch sweep failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 2 MIN — Cloudflare Pages build status for open blog-publish PRs.
  // Updates astro_preview_url once the preview deploy succeeds, or flips
  // the post to build_failed if it blows up. runExclusive: this tick
  // contains the SCHEDULER-lane auto-merge (pollPost → mergeAstro for posts
  // claimed at publish_status='publishing'), and a merge plus its post-merge
  // chain must not double-run across overlapping deploy instances — the same
  // rule the autonomous-pr-poll tick below already follows. It also keeps
  // the per-poll merge cap meaningful (two concurrent ticks each merging
  // "one" PR is two merges).
  // =========================================================================
  cron.schedule('*/2 * * * *', async () => {
    try {
      await runExclusive('pages-poll', async () => {
        const PagesPoll = require('./content-astro/pages-poll');
        await PagesPoll.pollPending();
      });
    } catch (err) {
      logger.error(`Pages poll failed: ${err.message}`);
    }
  });

  // =========================================================================
  // EVERY 2 MIN — Autonomous blog PR lifecycle. Autonomous publishes have no
  // blog_posts row, so pages-poll never tracks their PRs; this reconciles
  // autonomous_runs parked at astro_pr_pending_merge with live GitHub state:
  // human merge → completes the run (IndexNow + internal-link planning),
  // close-unmerged → fails it, and — ONLY when AUTONOMOUS_BLOG_AUTO_MERGE is
  // set (default off) — merges green + Codex-clear PRs itself, capped per
  // tick. runExclusive: a merge and its post-merge chain must not double-run
  // across overlapping deploy instances.
  // =========================================================================
  cron.schedule('*/2 * * * *', async () => {
    try {
      await runExclusive('autonomous-pr-poll', async () => {
        const AutonomousPrPoller = require('./content/autonomous-pr-poller');
        // Janitor first: a crash mid named-competitor approval strands the
        // run at 'publishing_named_competitor' with no other reader — park
        // it (and its claimed opportunity) for human reconciliation before
        // polling. Fail-soft so a janitor error never blocks the poll.
        try {
          const AutonomousRunner = require('./content/autonomous-runner');
          await AutonomousRunner.recoverStuckNamedCompetitorPublishes();
        } catch (janitorErr) {
          logger.warn(`Named-competitor publish janitor failed (poll continues): ${janitorErr.message}`);
        }
        await AutonomousPrPoller.pollPending();
      });
    } catch (err) {
      logger.error(`Autonomous PR poll failed: ${err.message}`);
    }
  });

  // =========================================================================
  // DAILY 5:40AM ET — Post-publish visibility sweep. Re-runs the visibility
  // worker (live/canonical/noindex/sitemap/IndexNow/AI-readiness) for
  // content published in the last few days: blog_posts that recently went
  // live AND autonomous_runs publishes (which have no blog_posts row). The
  // one-shot check at live-flip can miss slow-propagating issues; this is
  // the bounded daily backstop. Off-peak, small batch; failures log inside
  // the sweep and never throw out of the cron.
  // =========================================================================
  cron.schedule('40 5 * * *', async () => {
    logger.info('Running: post-publish visibility sweep');
    try {
      await runExclusive('post-publish-visibility-sweep', async () => {
        const VisibilityWorker = require('./content/post-publish-visibility-worker');
        await VisibilityWorker.sweepRecentlyPublished();
        // Same daily cadence doubles as the alert dedupe: one summary text
        // for autonomous PRs parked unmerged past the threshold (Codex
        // block / red build / missing deploy — the 2-min poller retries
        // those forever and silently).
        await VisibilityWorker.alertStuckAutonomousPrs();
      });
    } catch (err) {
      logger.error(`Post-publish visibility sweep failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 10AM (weekdays) — 7-Day Late Payment SMS
  // Checks invoices 7+ days overdue, sends tiered reminder SMS
  // =========================================================================
  cron.schedule('0 10 * * 1-5', async () => {
    logger.info('Running: late payment check');
    try {
      await runExclusive('late-payment-check', async () => {
        const LatePaymentService = require('./late-payment-checker');
        const result = await LatePaymentService.checkAndNotify();
        logger.info(`Late payment check done: ${result.notified} reminder(s) sent, ${result.emailedFallback || 0} email-only (SMS undeliverable), ${result.skipped} skipped`);
      });
    } catch (err) {
      logger.error(`Late payment check failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 10:16AM (Tue–Fri) — Per-invoice follow-up sequences
  // Fires the next due touch for each unpaid invoice's automated chain.
  //
  // The 10am-ET jobs are STAGGERED (:00 late-payment, :03 review-followups,
  // :07 billing-retries, :12 renewal-reminders, :16 this, :20 seasonal,
  // :31 payer-statement dunning) —
  // until 2026-08-04 six of them fired at exactly 10:00, each runExclusive
  // holds a pool connection for its advisory lock for the whole run, and the
  // pileup exhausted the pool (this job failed 4 straight days; touches are
  // anchored to 10:00 so a staggered tick is still same-day). Keep any new
  // 10am job off :00.
  // =========================================================================
  cron.schedule('16 10 * * 2-5', async () => {
    logger.info('Running: invoice follow-up sequences');
    try {
      await runExclusive('invoice-followups', async () => {
        const InvoiceFollowUps = require('./invoice-followups');
        const result = await InvoiceFollowUps.runPending();
        logger.info(`Invoice follow-ups done: ${result.sent} sent, ${result.skipped} skipped`);
      });
    } catch (err) {
      logger.error(`Invoice follow-ups failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 10:42AM (Mon–Fri) — Collections SHADOW sweep (observation only).
  // Evaluates the voice contact policy for every open-balance customer,
  // upserts shadow collection_cases, and files admin proposal cards. It
  // NEVER dials, texts, or emails anyone — the sweep module imports no
  // messaging surface at all (pinned by tests). DARK unless
  // GATE_COLLECTIONS_SHADOW=true. 10:42 is an unoccupied fixed minute
  // (10am-hour stagger rule above: never :00) and sits inside the policy's
  // 9:00–18:00 ET Mon–Fri call window, so the quiet-window check reflects a
  // genuinely dialable moment instead of denying every case at dawn.
  // =========================================================================
  cron.schedule('42 10 * * 1-5', async () => {
    logger.info('Running: collections shadow sweep');
    try {
      await runExclusive('collections-shadow-sweep', async () => {
        const ShadowSweep = require('./collections/shadow-sweep');
        const result = await ShadowSweep.runShadowSweep();
        if (result.skipped) {
          logger.info(`Collections shadow sweep inert: ${result.reason}`);
        } else {
          logger.info(`Collections shadow sweep done: ${result.considered} considered, ${result.casesCreated} created, ${result.casesUpdated} updated, ${result.cardsFiled} cards`);
        }
      });
    } catch (err) {
      logger.error(`Collections shadow sweep failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 11:23AM (Mon–Fri) — Collections AUTO-DIAL sweep (PR C, the ruled
  // fully-automatic trigger). Promotes eligible shadow/proposed cases and
  // hands them to origination, which re-runs the full contact policy at
  // dial time. DARK unless GATE_VOICE_LATE_PAYMENT_AUTODIAL=true (which
  // itself requires the master + policy gates) — gate off means ZERO reads
  // (pinned). 11:23 is an unoccupied fixed minute inside the 9:00–18:00 ET
  // call window, ~40min after the 10:42 shadow sweep so freshly proposed
  // cases are dialable the same day. Bounded: at most
  // COLLECTIONS_AUTODIAL_MAX_PER_RUN (default 2) dial attempts per run —
  // pilot pace, never a volume dialer.
  // =========================================================================
  cron.schedule('23 11 * * 1-5', async () => {
    try {
      // Gate BEFORE the lock (codex gh-r1): runExclusive itself takes a DB
      // connection, an advisory lock, and a job_health write — a fully dark
      // tick must touch NOTHING. Master on + autodial off (the supervised
      // shakedown mode) runs ONLY the orphan-approval reclamation (codex
      // gh-r7: that mode is exactly the one that creates admin orphans, and
      // nothing else ever revisits 'approved' rows).
      const { isAutoDialEnabled, isVoiceLatePaymentEnabled } = require('./collections/outbound-voice/gates');
      if (!isVoiceLatePaymentEnabled()) return; // fully dark — zero touches
      await runExclusive('collections-dial-sweep', async () => {
        const DialSweep = require('./collections/outbound-voice/dial-sweep');
        // Master RE-CHECK inside the lock (codex gh-r13): the tick can wait
        // on runExclusive — an incident flip during that wait must mean
        // fully-dark zero-touches, not "autodial-dark maintenance".
        if (!isVoiceLatePaymentEnabled()) return;
        if (!isAutoDialEnabled()) {
          const reclaimed = await DialSweep.reclaimExpiredApprovals();
          if (reclaimed) logger.info(`Collections maintenance: reclaimed ${reclaimed} expired approval(s) (autodial dark)`);
          return;
        }
        const result = await DialSweep.runCollectionsDialSweep();
        if (result.skipped) return; // gate flipped mid-tick — stay silent
        logger.info(`Collections auto-dial sweep: ${result.candidates} candidates, ${result.promoted} promoted, ${result.dialed} dial attempts, ${result.refused} refusals, ${result.reclaimed} reclaimed`);
      });
    } catch (err) {
      logger.error(`Collections auto-dial sweep failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 3:37AM — Collections call retention sweep (PR B). Purges the
  // conversational CONTENT (transcripts, recordings) of collections_voice
  // calls older than COLLECTIONS_RETENTION_DAYS (default 90) — its own
  // shorter policy, never the inbound pipeline's. Deliberately UNGATED:
  // deletion is the conservative direction, and while the lane is dark there
  // are zero collections_voice rows so this is a provable no-op (pinned).
  // =========================================================================
  cron.schedule('37 3 * * *', async () => {
    try {
      await runExclusive('collections-retention-sweep', async () => {
        const Retention = require('./collections/outbound-voice/retention');
        const result = await Retention.runCollectionsRetentionSweep();
        if (result.considered) {
          logger.info(`Collections retention sweep: ${result.purged} purged, ${result.failed} deferred`);
        }
      });
    } catch (err) {
      logger.error(`Collections retention sweep failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 10:05AM — Pre-visit late-balance reminders (owner directive
  // 2026-07-17). One text+email per RECURRING visit landing in 3 days when
  // the customer has a late RECURRING balance (unpaid dues / overdue
  // recurring invoices) — never ahead of one-time visits, never for
  // one-time invoice debt. Runs every day (visits land on weekends too).
  // DARK unless PREVISIT_BALANCE_REMINDER=true AND the seeded-inactive
  // previsit_balance_reminder SMS template is activated by the owner.
  // =========================================================================
  // ==========================================================================
  // Pre-visit card/Auto Pay invitation BACKSTOP (owner directive 2026-08-06):
  // catches visits the booking-time card triggers missed (held call comms,
  // post-booking plan conversions). DARK unless GATE_PREVISIT_CARD_SWEEP=true
  // AND the secure-card lane's own two levers are lit; all send policy lives
  // in requestCardForAppointment.
  // ==========================================================================
  // 10:26 — an unoccupied minute (codex #3234 r1: 10:20 collides with the
  // Monday seasonal-reactivation job; both hold runExclusive pool
  // connections, recreating the 10am pileup the stagger exists to prevent).
  cron.schedule('26 10 * * *', async () => {
    logger.info('Running: pre-visit card/Auto Pay invitation backstop');
    try {
      await runExclusive('previsit-card-request-sweep', async () => {
        const PrevisitCardSweep = require('./previsit-card-request-sweep');
        const result = await PrevisitCardSweep.runSweep();
        if (result.skipped === true) {
          logger.info(`Pre-visit card invitations inert: ${result.reason}`);
        } else {
          logger.info(`Pre-visit card invitations done: ${result.sent} sent, ${result.autoSecured} auto-secured, ${result.skipped} skipped of ${result.considered} (attempts ${result.attempts})`);
        }
      });
    } catch (err) {
      logger.error(`Pre-visit card invitation sweep failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // HALF-HOURLY :19/:49, 5AM–7:49PM ET — Pre-visit pocket-reference briefs (owner GO
  // 2026-08-06): generate the visit brief for every one of TODAY's
  // scheduled visits. The 5:19 pass runs after overnight reschedules
  // settle and before route start. DARK unless GATE_PREVISIT_BRIEF=true —
  // the service guards the gate itself (single source of truth); checked
  // here too so the dark path never takes the runExclusive advisory lock.
  // :19/:49 are unoccupied minutes file-wide: the quarter-hours carry six
  // */15 runExclusive jobs (reminders, storm watch, content publishing,
  // review requests), every 5-multiple carries the */5 pack, and no
  // hourly or 5–19-hour job uses :19/:49 — the DB- and LLM-heavy
  // four-worker sweep must not queue time-sensitive sends behind its own
  // pooled connections.
  // =========================================================================
  // The 5:19 pass is the primary sweep; the later passes are the
  // idempotent backstop for visits BOOKED (or a gate FLIPPED) after it
  // ran — without them a same-day booking would never receive a brief.
  // The window runs through 19:49 because the dispatch grids book
  // half-hour slots through 19:30 (TimeGridDay). Near-free on stable
  // routes: an unchanged grounding hash skips both the LLM call and the
  // write, and the runExclusive lock is shared so overlapping ticks
  // can't double-run.
  cron.schedule('19,49 5-19 * * *', async () => {
    const PrevisitBrief = require('./previsit-brief');
    if (!PrevisitBrief.briefGateEnabled()) return;
    logger.info('Running: pre-visit brief sweep');
    try {
      await runExclusive('previsit-brief-sweep', async () => {
        const result = await PrevisitBrief.runSweep();
        if (result.skipped === true) {
          logger.info(`Pre-visit brief sweep inert: ${result.reason}`);
        } else {
          logger.info(`Pre-visit brief sweep done: ${result.generated} generated, ${result.unchanged} unchanged, ${result.skipped} skipped, ${result.failed} failed of ${result.considered}`);
        }
      });
    } catch (err) {
      logger.error(`Pre-visit brief sweep failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  cron.schedule('5 10 * * *', async () => {
    logger.info('Running: pre-visit balance reminders');
    try {
      await runExclusive('previsit-balance-reminder', async () => {
        const PrevisitBalanceReminder = require('./previsit-balance-reminder');
        const result = await PrevisitBalanceReminder.runSweep();
        if (result.skipped === true) {
          logger.info(`Pre-visit balance reminders inert: ${result.reason}`);
        } else {
          logger.info(`Pre-visit balance reminders done: ${result.sent} sent, ${result.skipped} skipped of ${result.considered}`);
        }
      });
    } catch (err) {
      logger.error(`Pre-visit balance reminders failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 10:31AM (Tue–Fri) — Payer statement dunning (Phase 2 — P4)
  // Fires the next due AP reminder for each unpaid NET-terms statement past its
  // due date. Gated behind GATE_PAYER_STATEMENTS (runPending no-ops when off).
  // Staggered 15m after the per-invoice sequences (now at :16 in the 10am
  // stagger plan) so the two dunning sweeps never contend for the pool.
  // Never contacts the homeowner — AP inbox only.
  // =========================================================================
  cron.schedule('31 10 * * 2-5', async () => {
    logger.info('Running: payer statement dunning');
    try {
      await runExclusive('payer-statement-followups', async () => {
        const StatementFollowups = require('./payer-statement-followups');
        const result = await StatementFollowups.runPending();
        logger.info(`Payer statement dunning done: ${result.sent} sent, ${result.skipped} skipped`);
      });
    } catch (err) {
      logger.error(`Payer statement dunning failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 5 MIN — Process scheduled SMS sends
  // =========================================================================
  cron.schedule('*/5 * * * *', async () => {
    try {
      const now = new Date();
      let scheduled = [];
      try {
        await recoverStaleScheduledSmsClaims(now);
        // Stranded-finalization recovery: a crash after a deferred
        // completion/invoice row settled 'sent' but before its
        // finalization hook ran leaves finalize_pending stamped (written
        // atomically with the settlement). Convert those to bounded
        // finalize_only rows — the executor re-runs ONLY the idempotent
        // state steps, never resending the SMS. The 5-minute age floor
        // keeps this from racing an in-flight first pass.
        try {
          const strandedFinalize = await db('sms_log')
            .where({ status: 'sent' })
            .whereRaw("metadata->>'finalize_pending' = 'true'")
            .where('updated_at', '<', new Date(now.getTime() - 5 * 60 * 1000))
            .update({
              status: 'scheduled',
              scheduled_for: now,
              updated_at: new Date(),
              metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('finalize_only', true, 'finalize_attempts', COALESCE((metadata->>'finalize_attempts')::int, 0) + 1)"),
            });
          if (strandedFinalize) {
            logger.warn(`[scheduled-sms] recovered ${strandedFinalize} stranded deferred-send finalization(s)`);
          }
        } catch (recErr) {
          logger.warn(`[scheduled-sms] stranded-finalization recovery failed: ${recErr.message}`);
        }
        // Terminal-hook twin of the recovery above: a blocked/failed row
        // whose onTerminal hook threw (or died mid-run) keeps its
        // terminal_pending stamp — re-run the idempotent handoff bounded
        // instead of losing the obligation with the terminal row.
        try {
          const { sweepPendingTerminalHooks } = require('./messaging/deferred-replay-registry');
          const term = await sweepPendingTerminalHooks({ now });
          if (term.candidates) {
            logger.warn(`[scheduled-sms] re-ran ${term.reran}/${term.candidates} pending terminal hook(s)`);
          }
        } catch (termErr) {
          logger.warn(`[scheduled-sms] pending terminal-hook sweep failed: ${termErr.message}`);
        }
        scheduled = await claimDueScheduledSms(now);
      } catch { return; /* scheduled_for column may not exist yet */ }

      for (const msg of scheduled) {
        // Decision linkage is read FRESH after each terminal update, not
        // from the claim snapshot: the cancel route can transfer parked
        // decision ids onto this row while the provider send is in flight,
        // and those must still be resolved/reopened here.
        const readFreshMeta = async () => {
          const fresh = await db('sms_log').where({ id: msg.id }).first('metadata');
          const raw = fresh?.metadata;
          if (typeof raw === 'string') {
            try { return JSON.parse(raw); } catch { return {}; }
          }
          return raw || {};
        };
        try {
          const claimMeta = typeof msg.metadata === 'string'
            ? (() => { try { return JSON.parse(msg.metadata); } catch { return {}; } })()
            : (msg.metadata || {});
          // finalize_only: a deferred-completion row whose SMS already
          // DELIVERED but whose post-delivery finalization (invoice flip,
          // review mark, receipt claim — all idempotent) failed on a
          // transient error. Re-run ONLY the finalization; never resend.
          // Bounded, then closed loudly — the SMS itself is long gone.
          if (claimMeta.finalize_only === true) {
            const completedAt = new Date();
            const finalizeAttempts = Number(claimMeta.finalize_attempts) || 1;
            const { finalizeDeferredReplay } = require('./messaging/deferred-replay-registry');
            // provider_message_id was stamped with the settlement (or
            // recovered from the provider log by the crash/stale paths):
            // finalizers that settle once-ever claims key on the accepted
            // SID, and retrying without it would release a claim for a
            // message Twilio already delivered.
            const fin = (await finalizeDeferredReplay(claimMeta.entry_point, claimMeta, { retry: true, customerId: msg.customer_id, providerMessageId: claimMeta.provider_message_id || null })) || { ok: true };
            if (fin.ok || finalizeAttempts >= SCHEDULED_SMS_MAX_ATTEMPTS) {
              // finalize_pending clears on BOTH outcomes or the stranded-
              // finalization sweep would convert this row forever.
              await db('sms_log').where({ id: msg.id, status: 'sending' }).update({
                status: 'sent',
                updated_at: completedAt,
                metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('finalize_pending', false)"),
              });
              if (!fin.ok) {
                logger.error(`[scheduled-sms] deferred-completion finalization EXHAUSTED for ${msg.id} (record ${claimMeta.service_record_id || 'unknown'}) — invoice/review state may need manual sync`);
              }
            } else {
              await db('sms_log').where({ id: msg.id, status: 'sending' }).update({
                status: 'scheduled',
                scheduled_for: new Date(Date.now() + 15 * 60 * 1000),
                updated_at: completedAt,
                metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('finalize_attempts', ?::int)", [finalizeAttempts + 1]),
              });
            }
            continue;
          }
          // Deferred estimate follow-up replay: overnight the recipient may
          // have accepted/declined the estimate, booked or paid through the
          // email leg, or replied — states the immediate sender suppresses
          // via safetyGate. Re-run that same gate before dispatching the
          // stale touch (the helper fails open on read errors).
          // Deferred-replay staleness recheck (messaging/deferred-replay-
          // registry.js): the world moves between a night enqueue and the
          // 8 AM dispatch — estimates get accepted, invoices paid, visits
          // cancelled, leads advance, contracts signed, sequences ended by
          // a reply. Each deferral entry point registers its own recheck;
          // a read failure is retryable-ineligible (fail closed on both
          // sides of the attempt cap — never send unverified state).
          {
            const { recheckDeferredReplay, runTerminalHookDurably, requiresTerminalHook } = require('./messaging/deferred-replay-registry');
            // Same enrichment the finalize call gets below: several
            // enqueue sites store the customer only on sms_log.customer_id
            // (not in metadata), and a recheck that keys on customer state
            // — the lead-menu intake status, quiet-hours prefs — would
            // silently pass as eligible without it.
            // to_phone rides along too: recipient-frozen rows (contact
            // fan-out) revalidate that the queued number still belongs to
            // an authorized recipient, and the row column is the only
            // durable home of that number.
            const recheckMeta = {
              ...claimMeta,
              customer_id: claimMeta.customer_id || msg.customer_id || null,
              to_phone: claimMeta.to_phone || msg.to_phone || null,
            };
            const recheck = await recheckDeferredReplay(claimMeta.entry_point, recheckMeta);
            if (recheck && recheck.eligible === false) {
              // A recheck that names its own retry time (a customer quiet
              // window with a known end) reschedules straight to it and
              // REFUNDS the claimed attempt — this is a scheduled wait,
              // not a failed try, and the bounded 15-minute ladder is
              // reserved for genuinely unverifiable state.
              const namedRetryAt = recheck.retryAt && !Number.isNaN(new Date(recheck.retryAt).getTime())
                ? new Date(recheck.retryAt)
                : null;
              if (recheck.retryable && namedRetryAt) {
                await db('sms_log').where({ id: msg.id, status: 'sending' }).update({
                  status: 'scheduled',
                  scheduled_for: namedRetryAt,
                  updated_at: new Date(),
                  metadata: db.raw(`
                    COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                      'scheduled_sms_attempts',
                      GREATEST(
                        CASE
                          WHEN COALESCE(metadata->>'scheduled_sms_attempts', '') ~ '^[0-9]+$'
                            THEN (metadata->>'scheduled_sms_attempts')::int - 1
                          ELSE 0
                        END,
                        0
                      )
                    )
                  `),
                });
                logger.info(`[scheduled-sms] deferred replay ${msg.id} (${claimMeta.entry_point}) waiting on ${recheck.reason} — rescheduled for ${namedRetryAt.toISOString()} (attempt refunded)`);
              } else if (recheck.retryable && (Number(claimMeta.scheduled_sms_attempts) || 1) < SCHEDULED_SMS_MAX_ATTEMPTS) {
                await db('sms_log').where({ id: msg.id, status: 'sending' }).update({
                  status: 'scheduled',
                  scheduled_for: new Date(Date.now() + 15 * 60 * 1000),
                  updated_at: new Date(),
                });
                logger.warn(`[scheduled-sms] deferred replay ${msg.id} (${claimMeta.entry_point}) state unverifiable — held for retry`);
              } else {
                // terminal_pending stamped ATOMICALLY with the flip (same
                // contract as finalize_pending): a crash or throwing hook
                // after this write must leave a durable obligation the
                // terminal-hook sweep can find.
                await db('sms_log').where({ id: msg.id, status: 'sending' }).update({
                  status: 'blocked',
                  updated_at: new Date(),
                  metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('blocked_reason', ?, 'terminal_pending', ?::boolean)", [`stale_replay:${recheck.reason || 'unknown'}`, requiresTerminalHook(claimMeta.entry_point)]),
                });
                logger.info(`[scheduled-sms] deferred replay ${msg.id} (${claimMeta.entry_point}) suppressed: ${recheck.reason || 'recheck-exhausted'}`);
                // A suppressed replay will never deliver — same obligation
                // handoff as a terminal provider block (claim releases,
                // fallback arms, status flips into the admin lane).
                // Durable: a throwing hook leaves terminal_pending stamped
                // for the bounded re-run sweep.
                await runTerminalHookDurably(msg.id, claimMeta.entry_point, recheckMeta);
              }
              continue;
            }
          }
          // replay_purpose: an enqueue whose message_type has no useful
          // purpose mapping (the Stripe billing-notice templates —
          // ach_retry_notice, bank_verification_failed, …) persists the
          // exact purpose its immediate send ran under, so the policy
          // re-check at dispatch matches the original consent/trust shape
          // instead of falling through to 'conversational'. Bounded to the
          // known purpose enum; every validator still re-runs at dispatch.
          const { MESSAGE_PURPOSES } = require('./messaging/policy');
          const purpose = (typeof claimMeta.replay_purpose === 'string'
            && MESSAGE_PURPOSES.includes(claimMeta.replay_purpose))
            ? claimMeta.replay_purpose
            : purposeForScheduledMessageType(msg.message_type, { hasCustomer: !!msg.customer_id });
          // A decision-linked scheduled reply must clear a fire-time
          // re-check: its anchoring inbound is still the newest on the
          // thread. (The former price-quote fire-time block is RETIRED —
          // owner ruling 2026-07-30, house_voice_v10: real account amounts
          // may be texted; the operator reviewed this exact body at
          // schedule time, the drafter's deterministic amount-source guard
          // ran at draft time, and Codex r7 flagged that keeping the old
          // blocker silently retired every reviewed amount-bearing send.)
          // Failure → block this queued row, retire the claimed decision,
          // reopen parked siblings — in ONE thread-locked transaction over
          // FRESHLY read metadata: the cancel route can transfer parked ids
          // onto this row after our claim, and those must reopen here, not
          // sit invisible until orphan recovery.
          if (claimMeta.agent_decision_id) {
            const suggest = require('./sms-suggest-mode');
            const anchorStale = await suggest.suggestionAnchorIsStale({ decisionId: claimMeta.agent_decision_id, excludeSmsLogId: msg.id });
            // Amount revalidation (Codex r9): the account can change between
            // review and fire (a portal payment sends no inbound SMS, so the
            // anchor check can't see it). Non-human-authored agent text
            // carrying numeric amounts must still match the CURRENT
            // authoritative billing values; unverifiable or mismatched →
            // block + retire, same path as a stale anchor. Fail CLOSED on
            // any error — an unknowable account state must not send figures.
            let amountsStale = false;
            if (!anchorStale && claimMeta.human_authored !== true && msg.customer_id) {
              const AMOUNT_FORMS_RE = /(?:\$|\bUSD\s?)\s?\d[\d,]*(?:\.\d{1,2})?|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:dollars|bucks|usd)\b/gi;
              const bodyAmounts = (String(msg.message_body || '').match(AMOUNT_FORMS_RE) || [])
                .map((a) => Math.round(Number(a.replace(/[^\d.]/g, '')) * 100));
              if (bodyAmounts.length) {
                try {
                  const ContextAggregator = require('./context-aggregator');
                  const customerRow = await db('customers').where({ id: msg.customer_id }).first();
                  const ctx = customerRow ? await ContextAggregator.getContextForCustomer(customerRow) : null;
                  const cents = (v) => Math.round(Number(v) * 100);
                  // CURRENT OBLIGATIONS ONLY (Codex r10): a paid balance
                  // moves the same figure into recent payments, so a union
                  // set would keep authorizing the stale "your balance is
                  // $X" claim. At fire time only what the customer still
                  // owes may validate an amount; a just-paid figure blocks.
                  // Payment ACKNOWLEDGEMENTS may cite payment-history
                  // amounts (Codex r11: "we received your $95 payment") —
                  // but only when the body actually reads as an ack, so a
                  // stale "your balance is $X" can never re-authorize via
                  // the payment row (r10).
                  // "payment" must appear NEAR the ack verb (Codex r12) — a
                  // generic "Thanks for reaching out — your balance is $X"
                  // must not unlock payment-history amounts.
                  const ackBody = /\b(?:received|processed|went through)\b[^.\n]{0,30}\bpayment\b|\bpayment\b[^.\n]{0,30}\b(?:received|processed|went through)\b|\bthank(?:s| you)\b[^.\n]{0,25}\bpayment\b/i.test(String(msg.message_body || ''));
                  // Monthly-membership dues are a CURRENT obligation, so they
                  // belong in this set on the same terms as the balance
                  // (codex #3141 r3). Without them a reviewed "$98.50/mo"
                  // reply that an operator scheduled instead of sending
                  // immediately was deterministically retired here as a stale
                  // amount, so the monthly lane could be drafted and approved
                  // but never actually sent. Shared definition with the
                  // drafter's draft-time guard — these two lists had already
                  // drifted once — and it re-reads the FRESH context above,
                  // so a lane that stopped collecting between review and fire
                  // publishes nothing and correctly blocks the send.
                  const authorized = new Set([
                    ctx?.billing?.outstandingBalance > 0 ? cents(ctx.billing.outstandingBalance) : null,
                    ctx?.billing?.openInvoice?.amountDue != null ? cents(ctx.billing.openInvoice.amountDue) : null,
                    ...ContextAggregator.authorizedDuesCents(ctx),
                    ...(ackBody ? (ctx?.billing?.recentPayments || []).map((p) => (p?.amount != null ? cents(p.amount) : null)) : []),
                  ].filter((v) => Number.isFinite(v)));
                  amountsStale = bodyAmounts.some((a) => !authorized.has(a));
                } catch (err) {
                  logger.warn(`[scheduler] amount revalidation failed for scheduled sms ${msg.id}: ${err.message}; blocking send`);
                  amountsStale = true;
                }
              }
            }
            if (anchorStale || amountsStale) {
              const blockedReason = anchorStale ? 'stale_agent_decision' : 'stale_amount_agent_decision';
              const threadKey = String(msg.to_phone || '').replace(/\D/g, '').slice(-10) || msg.customer_id || msg.id;
              // Everything under the lock, metadata read THROUGH the trx
              // AFTER acquiring it — the cancel route can transfer parked
              // ids onto this row right up until we hold the lock. strict
              // retirement: a failure rolls the whole cleanup back (row
              // stays 'sending' for the recovery rail) instead of
              // committing a blocked SMS whose decision is still claimed.
              await db.transaction(async (trx) => {
                await suggest.lockSuggestThread(trx, threadKey);
                const freshRow = await trx('sms_log').where({ id: msg.id }).first('metadata');
                let freshMeta = freshRow?.metadata;
                if (typeof freshMeta === 'string') {
                  try { freshMeta = JSON.parse(freshMeta); } catch { freshMeta = {}; }
                }
                freshMeta = freshMeta || {};
                await trx('sms_log').where({ id: msg.id, status: 'sending' }).update({
                  status: 'blocked',
                  updated_at: new Date(),
                  metadata: trx.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('blocked_reason', ?::text)", [blockedReason]),
                });
                await suggest.supersedeStaleDecision({
                  decisionId: freshMeta.agent_decision_id || claimMeta.agent_decision_id,
                  fromStatus: 'scheduled',
                  note: anchorStale
                    ? 'A newer customer message arrived before this scheduled reply fired — review the thread.'
                    : 'This scheduled reply quoted a price — house rule: no prices in SMS. Review the thread.',
                  dbi: trx,
                  strict: true,
                });
                // Reopen only siblings whose OWN anchor is still current —
                // a card parked before the newer inbound is just as stale
                // as the one we retired, and reopening it would resurface a
                // stale actionable card beside the fresh one.
                const parked = Array.isArray(freshMeta.parked_decision_ids) ? freshMeta.parked_decision_ids : [];
                for (const parkedId of parked) {
                  const parkedStale = await suggest.suggestionAnchorIsStale({ decisionId: parkedId, dbi: trx, excludeSmsLogId: msg.id });
                  if (parkedStale) {
                    await suggest.supersedeStaleDecision({
                      decisionId: parkedId,
                      fromStatus: 'scheduled',
                      note: 'A newer customer message arrived while this suggestion was parked — review the thread.',
                      dbi: trx,
                      strict: true,
                    });
                  } else {
                    await suggest.reopenScheduledSuggestions({
                      decisionIds: [parkedId],
                      reason: 'The scheduled reply ahead of this suggestion did not go out — review the thread.',
                      dbi: trx,
                    });
                  }
                }
              });
              logger.warn(`[scheduled-sms] ${msg.id} blocked (${blockedReason}): linked agent decision retired, parked suggestions rechecked`);
              continue;
            }
          }

          const toPhone = await resolveScheduledRecipient(msg, claimMeta);
          if (!toPhone) {
            // Refresh-required row whose current customer phone can't be
            // verified right now — retry on the bounded attempt rail rather
            // than sending to the frozen snapshot under customer trust.
            const completedAt = new Date();
            if ((Number(claimMeta.scheduled_sms_attempts) || 1) < SCHEDULED_SMS_MAX_ATTEMPTS) {
              await db('sms_log').where({ id: msg.id, status: 'sending' }).update({
                status: 'scheduled',
                scheduled_for: new Date(Date.now() + 15 * 60 * 1000),
                updated_at: completedAt,
                metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('recipient_refresh_failed_at', ?::timestamptz)", [completedAt]),
              });
              logger.warn(`[scheduled-sms] Could not verify current customer phone for ${msg.id}; retrying (attempt ${Number(claimMeta.scheduled_sms_attempts) || 1}/${SCHEDULED_SMS_MAX_ATTEMPTS})`);
            } else {
              // terminal_pending rides the flip atomically (finalize_pending
              // contract) so a crash/throwing hook can't lose the handoff.
              const { runTerminalHookDurably, requiresTerminalHook } = require('./messaging/deferred-replay-registry');
              await db('sms_log').where({ id: msg.id, status: 'sending' }).update({
                status: 'blocked',
                updated_at: completedAt,
                metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('terminal_pending', ?::boolean)", [requiresTerminalHook(claimMeta.entry_point)]),
              });
              logger.warn(`[scheduled-sms] Blocked scheduled SMS ${msg.id}: customer phone unverifiable after ${SCHEDULED_SMS_MAX_ATTEMPTS} attempts`);
              // Terminal for this row's obligation too — same registry
              // handoff as a terminal provider block (release once-ever
              // claims, arm fallbacks, flip state into the admin lane).
              await runTerminalHookDurably(msg.id, claimMeta.entry_point, claimMeta);
            }
            continue;
          }
          if (!(await scheduledDepositReceiptAllowed(msg))) {
            // The customer flipped to email while the text sat on this rail —
            // hand off to the email leg FIRST and only discard the queued
            // text once the receipt is actually carried (or the customer
            // opted out of receipts entirely). A deterministically
            // undeliverable email (opt-out / no address) means the queued
            // TEXT is the only receipt left — it proceeds, mirroring the
            // immediate path's undeliverable-email SMS fallback (codex P2 on
            // 6b73a479); the send pipeline re-checks every current opt-out.
            const fb = claimMeta.estimate_id
              ? await require('./estimate-deposits').sendDepositReceiptEmailFallback(claimMeta.estimate_id, { paymentIntentId: claimMeta.payment_intent_id || null })
              : { sent: false, reason: 'no_estimate_ref' };
            const fbOutcome = classifyDepositReplayFallback(fb);
            logger.info(`[scheduled-sms] Deposit receipt ${msg.id} channel-flip email handoff: ${fb.sent ? 'sent' : fb.reason} (${fbOutcome})`);
            if (fbOutcome === 'handled') {
              await db('sms_log').where({ id: msg.id, status: 'sending' }).update({
                status: 'blocked',
                updated_at: new Date(),
                metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('blocked_reason', 'receipt_channel_not_sms')"),
              });
              continue;
            }
            if (fbOutcome === 'retry') {
              const completedAt = new Date();
              if ((Number(claimMeta.scheduled_sms_attempts) || 1) < SCHEDULED_SMS_MAX_ATTEMPTS) {
                await db('sms_log').where({ id: msg.id, status: 'sending' }).update({
                  status: 'scheduled',
                  scheduled_for: new Date(Date.now() + 15 * 60 * 1000),
                  updated_at: completedAt,
                  metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('deposit_email_handoff_retry_at', ?::timestamptz)", [completedAt]),
                });
              } else {
                await db('sms_log').where({ id: msg.id, status: 'sending' }).update({ status: 'blocked', updated_at: completedAt });
                logger.warn(`[scheduled-sms] Deposit receipt ${msg.id} email handoff exhausted retries — blocked`);
              }
              continue;
            }
            // 'sms_fallback' — fall through to the normal replay send below.
          }
          const smsResult = await sendCustomerMessage({
            to: toPhone,
            body: msg.message_body,
            channel: 'sms',
            audience: msg.customer_id ? 'customer' : 'lead',
            purpose,
            customerId: msg.customer_id || undefined,
            identityTrustLevel: msg.customer_id ? 'phone_matches_customer' : 'phone_provided_unverified',
            entryPoint: 'scheduled_sms_cron',
            // Send-window operator provenance: only rows an operator
            // actually composed/scheduled keep the operator exemption — the
            // composer dispatches at the exact minute the operator picked,
            // and that intent is persisted at enqueue as admin attribution
            // or the human-authored flag. Automated requeues (deferred
            // voicemail text-back, quiet-hours-held prep texts, deposit
            // receipts) carry neither and stay behind the window, so a
            // queue that recovers late at night re-defers to 8:00 AM via
            // the retryable QUIET_HOURS_HOLD branch below instead of
            // texting after the cutoff.
            ...((msg.admin_user_id || claimMeta.human_authored === true) ? { operatorInitiated: true } : {}),
            // Entity linkage for policies with requireIds beyond customerId
            // (payment_link needs invoiceId): requeued rows persist the ids
            // in metadata and the replay forwards them, or the
            // require_input_ids validator would block a send the immediate
            // path already validated.
            ...(claimMeta.invoice_id ? { invoiceId: claimMeta.invoice_id } : {}),
            ...(claimMeta.estimate_id ? { estimateId: claimMeta.estimate_id } : {}),
            // Inbound-reply provenance survives the retry rail: a transient
            // provider failure on an immediate AI reply (Twilio 429/5xx)
            // re-queues here minutes later — still an answer to the
            // customer's own text, not ordinary automation, so the send
            // window must not reclassify it. Persisted at enqueue by the
            // inbound webhook's retry insert; automated rows never carry it.
            ...(claimMeta.conversational_context === true ? { conversationalContext: true } : {}),
            // Forward the consent basis the ORIGINAL enqueue ran under (e.g. a
            // deferred voicemail text-back persists transactional_allowed)
            // — without it an anonymous-lead transactional replay blocks as
            // NO_CONSENT_RECORD. Safe to forward blindly: the consent validator
            // only honors a consentBasis on transactional-grade policies for the
            // lead audience; marketing/retention purposes still require a real
            // stored consent record regardless of what a row's metadata claims.
            consentBasis: (claimMeta.consent_basis && typeof claimMeta.consent_basis.status === 'string')
              ? claimMeta.consent_basis
              : undefined,
            // NOTE: marketing/retention scheduled sends must arrive with a real
            // stored consent record — we no longer manufacture opted_in here.
            // Routes that queue marketing-grade types are responsible for
            // gating against `messaging_consent`.
            metadata: {
              original_message_type: msg.message_type || 'scheduled',
              scheduled_sms_log_id: msg.id,
              // resolve_from_by_customer: customer-linked requeues (deferred
              // completion/prep/follow-up texts) stamped a placeholder
              // from_phone at enqueue only because the column is NOT NULL —
              // suppress the override so twilio.js resolves the customer's
              // LOCATION number at send time, keeping the morning text on
              // the same line/thread the immediate path would have used.
              fromNumber: claimMeta.resolve_from_by_customer === true
                ? undefined
                : (msg.from_phone || undefined),
              adminUserId: msg.admin_user_id || undefined,
              // Forward the operator-authored provenance persisted by
              // /schedule-sms so a hand-composed scheduled message with an
              // intentional past-month reference clears the stale-month guard
              // at dispatch, same as the immediate manual send. Only the
              // explicit persisted flag exempts — automated scheduled rows
              // never carry it. See services/sms-guard.js.
              humanAuthored: claimMeta.human_authored === true,
              // Decision linkage rides into the provider-created sms_log row
              // so the nightly sweep can recover the claims if the process
              // dies between Twilio's accept and the resolution below.
              agentDecisionId: claimMeta.agent_decision_id || undefined,
              parkedDecisionIds: Array.isArray(claimMeta.parked_decision_ids) && claimMeta.parked_decision_ids.length
                ? claimMeta.parked_decision_ids
                : undefined,
            },
          });
          const completedAt = new Date();
          if (smsResult.sent) {
            // created_at is re-stamped to send time on purpose — comms
            // threads order by it, and a scheduled SMS composed days ago
            // must appear when it was DELIVERED. Preserve the original
            // queue moment in metadata so the audit trail isn't lost
            // (jsonb_build_object reads the pre-update column value).
            // finalize_pending is stamped ATOMICALLY with the sent
            // settlement for entry points that owe post-delivery
            // finalization — a crash between this update and the hook below
            // must leave durable evidence, which the executor's stranded-
            // finalization sweep converts to a finalize_only retry.
            const { requiresDurableFinalize, finalizeDeferredReplay: finalizeReplay } = require('./messaging/deferred-replay-registry');
            const owesFinalization = requiresDurableFinalize(claimMeta.entry_point);
            await db('sms_log').where({ id: msg.id, status: 'sending' }).update({
              status: 'sent',
              created_at: completedAt,
              updated_at: completedAt,
              // provider_message_id rides the durable stamp so a
              // finalize_only retry can re-run finalization with the REAL
              // accepted SID — the lead-menu finalizer reads a missing SID
              // as non-delivery and releases its once-ever claim, which
              // would re-arm a duplicate menu for an SMS Twilio accepted.
              metadata: owesFinalization
                ? db.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('queued_at', created_at, 'finalize_pending', true, 'provider_message_id', ?::text)", [smsResult.providerMessageId || null])
                : db.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('queued_at', created_at)"),
            });
            logger.info(`[scheduled-sms] Sent scheduled SMS ${msg.id}`);

            // Deferred-replay finalization (registry): the state
            // transitions the immediate path would have run inline —
            // invoice draft→sent, review delivered mark, lead lifecycle
            // stamps, once-ever claim settlement — deliberately AFTER the
            // provider accepted. Non-durable entries run best-effort;
            // durable entries (finalize_pending stamped with the
            // settlement above) convert failures into bounded
            // finalize_only retries that never resend.
            {
              const fin = await finalizeReplay(claimMeta.entry_point, { ...claimMeta, customer_id: msg.customer_id || claimMeta.customer_id || null }, { providerMessageId: smsResult.providerMessageId, customerId: msg.customer_id || null });
              if (fin && owesFinalization) {
                if (fin.ok) {
                  await db('sms_log').where({ id: msg.id }).update({
                    metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('finalize_pending', false)"),
                  }).catch((clearErr) => logger.warn(`[scheduled-sms] finalize_pending clear failed for ${msg.id}: ${clearErr.message}`));
                } else {
                  try {
                    await db('sms_log').where({ id: msg.id, status: 'sent' }).update({
                      status: 'scheduled',
                      scheduled_for: new Date(Date.now() + 15 * 60 * 1000),
                      updated_at: new Date(),
                      metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('finalize_only', true, 'finalize_attempts', 1, 'customer_id', ?::text)", [msg.customer_id || null]),
                    });
                    logger.warn(`[scheduled-sms] deferred-replay finalization incomplete for ${msg.id} — converted to finalize-only retry`);
                  } catch (convErr) {
                    logger.error(`[scheduled-sms] deferred-replay finalization failed AND retry conversion failed for ${msg.id}: ${convErr.message} — state may need manual sync`);
                  }
                }
              }
            }

            // A scheduled send composed from an Agent Review draft resolves
            // its decision now that the message actually left — schedule-sms
            // stashed the verified id on the row. Suggestions parked behind
            // the queued reply resolve as ignored (their drafts return to
            // the judge). Internal catches: a resolution failure must not
            // flip a SENT row to failed.
            const sentMeta = await readFreshMeta();
            if (sentMeta.agent_decision_id) {
              const { resolveSuggestionAfterSend } = require('./sms-suggest-mode');
              await resolveSuggestionAfterSend({
                decisionId: sentMeta.agent_decision_id,
                sentBody: msg.message_body,
                reviewedBy: msg.admin_user_id || 'Admin',
              });
            }
            if (Array.isArray(sentMeta.parked_decision_ids) && sentMeta.parked_decision_ids.length) {
              const { ignoreParkedSuggestions } = require('./sms-suggest-mode');
              await ignoreParkedSuggestions({
                decisionIds: sentMeta.parked_decision_ids,
                reviewedBy: msg.admin_user_id || 'Admin',
              });
            }
          } else if (smsResult.code === 'QUIET_HOURS_HOLD' && smsResult.nextAllowedAt) {
            // Send-window hold: a validator deferral, not a delivery
            // attempt — no provider send was tried. Handled BEFORE the
            // bounded-attempt branch and with the claimed attempt REFUNDED
            // (mirroring the receipt queue's markJobRetry), otherwise a
            // hold landing on the final allowed attempt would fall through
            // to the terminal 'blocked' branch and a run of overnight
            // cron passes could burn the whole ladder without ever
            // reaching Twilio. Reschedules at the window open.
            const holdRetryAt = new Date(smsResult.nextAllowedAt);
            await db('sms_log').where({ id: msg.id, status: 'sending' }).update({
              status: 'scheduled',
              scheduled_for: holdRetryAt,
              updated_at: completedAt,
              metadata: db.raw(`
                COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                  'quiet_hours_hold_at', ?::timestamptz,
                  'scheduled_sms_attempts',
                  GREATEST(
                    CASE
                      WHEN COALESCE(metadata->>'scheduled_sms_attempts', '') ~ '^[0-9]+$'
                        THEN (metadata->>'scheduled_sms_attempts')::int - 1
                      ELSE 0
                    END,
                    0
                  )
                )
              `, [completedAt]),
            });
            logger.info(`[scheduled-sms] ${msg.id} held outside the 8AM-8PM ET send window — rescheduled for ${holdRetryAt.toISOString()} (attempt refunded)`);
          } else if ((smsResult.retryable || smsResult.code === 'CONSENT_LOOKUP_FAILED')
                     && (Number(claimMeta.scheduled_sms_attempts) || 1) < SCHEDULED_SMS_MAX_ATTEMPTS) {
            // Transient provider failure (Twilio 429/5xx/timeout) or a DB
            // blip during the consent lookup (CONSENT_LOOKUP_FAILED carries
            // no retry metadata but is retry-advised by contract): re-queue
            // so the next cron tick retries it,
            // instead of marking it permanently blocked and dropping it
            // (RED audit R3). Bounded by SCHEDULED_SMS_MAX_ATTEMPTS via the
            // claim-time attempt counter. The message will still send, so
            // parked decisions stay parked — we do NOT reopen them here.
            const retryAt = smsResult.nextAllowedAt
              ? new Date(smsResult.nextAllowedAt)
              : new Date(Date.now() + 15 * 60 * 1000);
            await db('sms_log').where({ id: msg.id, status: 'sending' }).update({
              status: 'scheduled',
              scheduled_for: retryAt,
              updated_at: completedAt,
              metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('provider_retry_at', ?::timestamptz, 'provider_retry_code', ?)", [completedAt, smsResult.code || null]),
            });
            logger.warn(`[scheduled-sms] Retryable failure on ${msg.id} (${smsResult.code}); retry at ${retryAt.toISOString()} (attempt ${Number(claimMeta.scheduled_sms_attempts) || 1}/${SCHEDULED_SMS_MAX_ATTEMPTS})`);
          } else {
            // A deposit-receipt replay the customer's OWN choice suppressed
            // (texts toggle / STOP / email-only flipped while queued) hands
            // off to the deposit email leg BEFORE the row goes terminal — the
            // immediate path treats the same opt-outs as "the email carries
            // the receipt". PURPOSE_OPTED_OUT can also mean the
            // payment_receipt kill switch; the fallback re-checks it (and
            // email_enabled) itself. A TRANSIENT fallback failure (prefs
            // blip / provider error) reschedules the row on the bounded
            // attempt rail so the handoff reruns, instead of discarding the
            // only remaining receipt path (codex P2 on a3de55b9); a
            // deterministic email miss means nothing can deliver — the SMS
            // was the customer's own block — so the row goes terminal.
            let fbOutcome = null;
            if (String(msg.message_type || '').toLowerCase() === 'deposit_receipt'
                && claimMeta.estimate_id
                && ['PURPOSE_OPTED_OUT', 'CHANNEL_EMAIL_ONLY', 'SMS_OPTED_OUT', 'SUPPRESSED_OPT_OUT'].includes(smsResult.code)) {
              const fb = await require('./estimate-deposits').sendDepositReceiptEmailFallback(claimMeta.estimate_id, { paymentIntentId: claimMeta.payment_intent_id || null });
              fbOutcome = classifyDepositReplayFallback(fb);
              logger.info(`[scheduled-sms] Deposit receipt ${msg.id} email fallback: ${fb.sent ? 'sent' : fb.reason} (${fbOutcome})`);
            }
            if (fbOutcome === 'retry' && (Number(claimMeta.scheduled_sms_attempts) || 1) < SCHEDULED_SMS_MAX_ATTEMPTS) {
              await db('sms_log').where({ id: msg.id, status: 'sending' }).update({
                status: 'scheduled',
                scheduled_for: new Date(Date.now() + 15 * 60 * 1000),
                updated_at: completedAt,
                metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('deposit_email_handoff_retry_at', ?::timestamptz)", [completedAt]),
              });
              logger.warn(`[scheduled-sms] Deposit receipt ${msg.id} email handoff transient failure — rescheduled (attempt ${Number(claimMeta.scheduled_sms_attempts) || 1}/${SCHEDULED_SMS_MAX_ATTEMPTS})`);
            } else {
              // terminal_pending rides the flip atomically (finalize_pending
              // contract) so a crash/throwing hook can't lose the handoff.
              {
                const { runTerminalHookDurably, requiresTerminalHook } = require('./messaging/deferred-replay-registry');
                await db('sms_log').where({ id: msg.id, status: 'sending' }).update({
                  status: 'blocked',
                  updated_at: completedAt,
                  metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('terminal_pending', ?::boolean)", [requiresTerminalHook(claimMeta.entry_point)]),
                });
                logger.warn(`[scheduled-sms] Blocked/failed scheduled SMS ${msg.id}: ${smsResult.code || smsResult.reason || 'unknown'}`);
                // Terminal block on a deferred replay: the message provably
                // never delivered — hand the obligation off per the entry
                // point's registry hook (release once-ever claims, arm the
                // standalone review fallback, flip referral/report state into
                // the admin retry lane). Armed ONLY here, never on timers,
                // so fallbacks can't race a still-retryable replay.
                await runTerminalHookDurably(msg.id, claimMeta.entry_point, claimMeta);
              }
              // The customer was never answered — used + parked cards return.
              const blockedMeta = await readFreshMeta();
              await require('./sms-suggest-mode').reopenScheduledSuggestions({
                decisionIds: [blockedMeta.agent_decision_id, ...(Array.isArray(blockedMeta.parked_decision_ids) ? blockedMeta.parked_decision_ids : [])],
                reason: 'Scheduled send was blocked — suggestion reopened.',
              });
            }
          }
        } catch (err) {
          logger.error(`[scheduled-sms] Failed: ${err.message}`);
          try {
            // Ambiguous failure: Twilio may have ACCEPTED before the
            // exception (e.g. the queued-row update threw). A provider row
            // tagged with this row's id proves the send — settle as sent
            // and resolve the decisions; reopening here would resurface a
            // card on an answered thread and invite a duplicate reply.
            const providerRow = await db('sms_log')
              .where({ direction: 'outbound' })
              .whereIn('status', ['queued', 'sent', 'delivered'])
              .whereRaw("metadata->>'scheduled_sms_log_id' = ?", [String(msg.id)])
              .first('id', 'twilio_sid');
            const failedAt = new Date();
            // The provider log is best-effort (TwilioService.sendSMS
            // swallows its own insert failure), so its absence proves
            // nothing when the error itself carries the provider outcome:
            // sendCustomerMessage attaches the KNOWN outcome to an
            // audit-write throw precisely so send-once callers can tell an
            // accepted-but-unaudited send from a pre-accept failure.
            // sent:true = Twilio accepted — settle, never retry (a
            // duplicate customer text is the worse failure). sent:false or
            // no providerOutcome = genuinely pre-accept, retry below.
            if (providerRow || err?.providerOutcome?.sent === true) {
              // Same finalize_pending stamp as the normal settlement: a
              // deferred replay settled through THIS crash path also
              // delivered without its finalization running — the
              // stranded-finalization sweep picks the stamp up. (claimMeta
              // is scoped to the try above — re-parse from the row here.)
              const crashMeta = typeof msg.metadata === 'string'
                ? (() => { try { return JSON.parse(msg.metadata); } catch { return {}; } })()
                : (msg.metadata || {});
              const { requiresDurableFinalize: crashDurable } = require('./messaging/deferred-replay-registry');
              const crashOwesFinalization = crashDurable(crashMeta.entry_point);
              // Recover the accepted SID for the finalize_only retry
              // (provider log first, then the outcome the throw carried) —
              // same contract as the normal settlement's stamp.
              const crashProviderSid = providerRow?.twilio_sid || err?.providerOutcome?.providerMessageId || null;
              await db('sms_log').where({ id: msg.id, status: 'sending' }).update({
                status: 'sent',
                created_at: failedAt,
                updated_at: failedAt,
                metadata: crashOwesFinalization
                  ? db.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('queued_at', created_at, 'finalize_pending', true, 'provider_message_id', ?::text)", [crashProviderSid])
                  : db.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('queued_at', created_at)"),
              });
              const recoveredMeta = await readFreshMeta();
              const suggest = require('./sms-suggest-mode');
              if (recoveredMeta.agent_decision_id) {
                await suggest.resolveSuggestionAfterSend({
                  decisionId: recoveredMeta.agent_decision_id,
                  sentBody: msg.message_body,
                  reviewedBy: msg.admin_user_id || 'Admin',
                });
              }
              if (Array.isArray(recoveredMeta.parked_decision_ids) && recoveredMeta.parked_decision_ids.length) {
                await suggest.ignoreParkedSuggestions({
                  decisionIds: recoveredMeta.parked_decision_ids,
                  reviewedBy: msg.admin_user_id || 'Admin',
                });
              }
              logger.warn(`[scheduled-sms] Settled ${msg.id} as sent after post-accept error`);
            } else {
              // Pre-accept exception (no provider row proves a send): the
              // text never left, so retry on the bounded rail while
              // attempts remain; at exhaustion, run the registry terminal
              // hook so deferred obligations (review fallbacks, once-ever
              // claims, referral/report state) hand off instead of
              // silently dying with the row — parallel to the
              // provider-result terminal paths.
              const failedMeta = await readFreshMeta().catch(() => ({}));
              if ((Number(failedMeta.scheduled_sms_attempts) || 1) < SCHEDULED_SMS_MAX_ATTEMPTS) {
                await db('sms_log').where({ id: msg.id, status: 'sending' }).update({
                  status: 'scheduled',
                  scheduled_for: new Date(Date.now() + 15 * 60 * 1000),
                  updated_at: failedAt,
                });
                logger.warn(`[scheduled-sms] Pre-accept exception on ${msg.id} — rescheduled for retry`);
              } else {
                // terminal_pending rides the flip atomically (finalize_pending
                // contract) so a crash/throwing hook can't lose the handoff.
                const { runTerminalHookDurably, requiresTerminalHook } = require('./messaging/deferred-replay-registry');
                await db('sms_log').where({ id: msg.id, status: 'sending' }).update({
                  status: 'failed',
                  updated_at: failedAt,
                  metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('terminal_pending', ?::boolean)", [requiresTerminalHook(failedMeta.entry_point)]),
                });
                if (failedMeta.entry_point) {
                  await runTerminalHookDurably(msg.id, failedMeta.entry_point, failedMeta);
                }
                await require('./sms-suggest-mode').reopenScheduledSuggestions({
                  decisionIds: [failedMeta.agent_decision_id, ...(Array.isArray(failedMeta.parked_decision_ids) ? failedMeta.parked_decision_ids : [])],
                  reason: 'Scheduled send failed — suggestion reopened.',
                });
              }
            }
          } catch (recoverErr) {
            // Leave the row in 'sending' — recoverStaleScheduledSmsClaims
            // settles or retries it with the same provider-row proof.
            logger.error(`[scheduled-sms] Post-failure recovery errored for ${msg.id}: ${recoverErr.message}`);
          }
        }
      }

      // Fast holding-state recovery (30-min orphan window): an
      // immediate-send claim has no backing sms_log row, so a crash
      // mid-send would otherwise hide the composer card until the nightly
      // sweep. Guarded updates — racing the nightly run is harmless.
      await require('./sms-suggest-mode').recoverSuggestionHoldingStates().catch((recErr) => {
        logger.warn(`[sms-suggest] fast recovery failed: ${recErr.message}`);
      });
      // Same cadence for auto-send: a stranded 'sending' claim or manual-send
      // reservation would otherwise block auto-sends on the thread until the
      // daily sweep. Both are guarded + 30-min-windowed, so running every 5 min
      // is harmless.
      await require('./sms-auto-send').reconcileAutoSendClaims().catch((recErr) => {
        logger.warn(`[sms-auto-send] fast reconcile failed: ${recErr.message}`);
      });
    } catch (err) {
      logger.error(`Scheduled SMS processing failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 5 MIN — Retry queued service report v1 email deliveries
  // =========================================================================
  cron.schedule('*/5 * * * *', async () => {
    try {
      const { processDueServiceReportDeliveries } = require('./service-report/delivery-queue');
      const result = await processDueServiceReportDeliveries();
      if (result.claimed || result.sent || result.skipped || result.failed || result.requeued || result.recovered) {
        logger.info(`Service report deliveries: ${result.sent} sent, ${result.requeued} queued for retry, ${result.skipped} skipped, ${result.failed} failed, ${result.recovered} recovered`);
      }
    } catch (err) {
      logger.error(`Service report delivery cron failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 15 MIN — Re-run ACH processing acknowledgments whose one-shot
  // claim was released (held-SMS enqueue failure in the detached webhook
  // worker) or never taken (crash before the worker ran). The released
  // claim is the durable retry state — Stripe won't redeliver an acked
  // event, and in-process timers die with a restart. SMS-only by design;
  // the sweep function documents the bounds.
  // =========================================================================
  cron.schedule('*/15 * * * *', async () => {
    try {
      // Behind the send-window gate (codex r27): this recovery path exists
      // only because the gate's hold rails can release/lose the detached
      // worker's one-shot claim. With the gate dark it must stay inert —
      // otherwise deploying dark could text/email customers for any recent
      // processing invoice whose acknowledgment claim is null for an
      // unrelated pre-gate reason (e.g. the worker died after the webhook
      // acked). Not behavior-preserving = not a dark ship.
      if (!require('../config/feature-gates').isEnabled('smsSendWindow')) return;
      const { sweepUnacknowledgedAchProcessingAcks } = require('../routes/stripe-webhook');
      const result = await sweepUnacknowledgedAchProcessingAcks();
      if (result.candidates) {
        logger.info(`ACH acknowledgment sweep: ${result.candidates} unacknowledged processing invoice(s) re-attempted`);
      }
    } catch (err) {
      logger.error(`ACH acknowledgment sweep failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 4:40AM ET — Sync area rainfall (Open-Meteo) for Lawn Report V2 water
  // areas. Idempotent 7-day backfill upsert so the report's water bar /
  // 7-day chart have complete, current rainfall.
  // =========================================================================
  cron.schedule('40 4 * * *', async () => {
    try {
      const { runLawnAreaWeatherSync } = require('../scripts/sync-lawn-area-weather');
      const result = await runLawnAreaWeatherSync({ pastDays: 7 });
      logger.info(`Lawn area weather sync: ${JSON.stringify(result || {})}`);
    } catch (err) {
      logger.error(`Lawn area weather sync cron failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // PROPERTY ALERTS SWEEP (GATE_PROPERTY_ALERTS; off = shadow-log only)
  // Daily 10:05 AM ET — bell + native push advisories (rain/skip-irrigation,
  // clean-inspection reassurance). MUST stay mid-morning ET: notifyCustomer's
  // push path has no send-window fence of its own, so this schedule IS the
  // quiet-hours guarantee. Runs after the 4:40 weather sync so the rain
  // window reads today's refreshed observed data.
  // =========================================================================
  cron.schedule('5 10 * * *', async () => {
    try {
      // runExclusive: customer-facing bell/push sends — a deploy overlap
      // must not double-sweep (the ledger's unique dedupe key is the second
      // line of defense).
      await runExclusive('property-alerts-sweep', async () => {
        const { runPropertyAlertsSweep } = require('./property-alerts');
        const result = await runPropertyAlertsSweep();
        logger.info(`[property-alerts] cron run: ${JSON.stringify(result)}`);
      });
    } catch (err) {
      logger.error(`Property alerts sweep failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 5 MIN — Retry queued service report PDF renders
  // =========================================================================
  cron.schedule('*/5 * * * *', async () => {
    try {
      const { processDuePdfRenderJobs } = require('./service-report/pdf-queue');
      const result = await processDuePdfRenderJobs();
      if (result.claimed || result.succeeded || result.failed || result.requeued || result.deferred || result.recovered) {
        logger.info(`Service report PDF renders: ${result.succeeded} succeeded, ${result.requeued} queued for retry, ${result.deferred} deferred, ${result.failed} failed, ${result.recovered} recovered`);
      }
    } catch (err) {
      logger.error(`Service report PDF render cron failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 5 MIN — Render queued "Your Visit, in Motion" recap videos (PEST_RECAP)
  // =========================================================================
  cron.schedule('*/5 * * * *', async () => {
    if (process.env.PEST_RECAP !== 'true') return;
    try {
      const { processDueRecaps } = require('./service-report/recap-pipeline');
      const result = await processDueRecaps();
      if (result.claimed || result.ready || result.failed || result.requeued) {
        logger.info(`Visit recap renders: ${result.ready} ready, ${result.requeued} retry, ${result.failed} failed, ${result.skipped} skipped`);
      }
    } catch (err) {
      logger.error(`Visit recap render cron failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 2:45AM — Build anonymized service report neighborhood pressure rolls
  // =========================================================================
  cron.schedule('45 2 * * *', async () => {
    try {
      const { buildNeighborhoodPressureAggregates } = require('./service-report/neighborhood-pressure-aggregates');
      const result = await buildNeighborhoodPressureAggregates();
      if (result.inserted > 0) {
        logger.info(`[service-report-pressure] Built ${result.inserted} neighborhood aggregate row(s) for ${result.periodStart} to ${result.periodEnd}`);
      }
    } catch (err) {
      logger.error(`Service report neighborhood pressure aggregate failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 5 MINUTES — Send scheduled estimates whose time has arrived
  // =========================================================================
  cron.schedule('*/5 * * * *', async () => {
    try {
      const now = new Date();
      await recoverStaleScheduledEstimateClaims(now);
      const scheduled = await claimDueScheduledEstimates(now);

      if (scheduled.length === 0) return;

      const { sendEstimateNow } = require('../routes/admin-estimates');
      for (const est of scheduled) {
        try {
          const result = await sendEstimateNow(est, est.send_method || 'both', { callerPreClaimed: true });
          if (result.sent) {
            const suffix = result.partialFailure ? ` with channel issues (${result.failedChannels.join(', ')})` : '';
            logger.info(`Scheduled estimate ${est.id} sent${suffix}`);
          } else {
            logger.warn(`Scheduled estimate ${est.id} was not sent on any channel`);
            await markScheduledEstimateSendFailure(est, 'Estimate was not sent on any requested channel', { retry: false, now });
          }
        } catch (e) {
          logger.error(`Scheduled estimate ${est.id} failed: ${e.message}`);
          await markScheduledEstimateSendFailure(est, e.message, { retry: true, now });
        }
      }
      logger.info(`Scheduled estimates processed: ${scheduled.length}`);
    } catch (err) {
      logger.error(`Scheduled estimate cron failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 5 MINUTES — Auto-send generated lead-webhook estimates.
  // Explicit gates default OFF. When enabled, this rechecks eligibility after
  // the configured delay and then uses the same sendEstimateNow path as manual
  // and scheduled sends.
  // =========================================================================
  cron.schedule('*/5 * * * *', async () => {
    if (!isEnabled('leadEstimateAutomation') || !isEnabled('leadEstimateAutoSend')) return;
    try {
      const {
        leadEstimateAutoSendConfigFromEnv,
        processLeadEstimateAutoSendBatch,
      } = require('./lead-estimate-auto-send');
      const result = await processLeadEstimateAutoSendBatch({
        config: leadEstimateAutoSendConfigFromEnv(),
      });
      if (result.scanned || result.sent || result.blocked || result.failed || result.recovered || result.staleBlocked) {
        logger.info(`[lead-estimate-auto-send] scanned=${result.scanned} sent=${result.sent} blocked=${result.blocked} failed=${result.failed} skipped=${result.skipped} recovered=${result.recovered} staleBlocked=${result.staleBlocked}`);
      }
    } catch (err) {
      logger.error(`Lead estimate auto-send cron failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 5 MINUTES — Send scheduled invoices whose time has arrived
  // =========================================================================
  cron.schedule('*/5 * * * *', async () => {
    try {
      const InvoiceService = require('./invoice');
      const result = await InvoiceService.processScheduledSends();
      if (result.sent || result.failed) {
        logger.info(`Scheduled invoices: ${result.sent} sent, ${result.failed} failed`);
      }
    } catch (err) {
      logger.error(`Scheduled invoice cron failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 2 MINUTES — Email sync (Gmail → PostgreSQL)
  // =========================================================================
  cron.schedule('*/2 * * * *', async () => {
    try {
      const { syncEmails } = require('./email/email-sync');
      const result = await syncEmails();
      if (result.newEmails > 0) {
        logger.info(`[email-sync] Synced ${result.newEmails} new emails`);
      }
    } catch (err) {
      logger.error(`[email-sync] Cron failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 6:50 AM — Inbox hygiene: quarantine sweep + spam-folder rescue.
  // Runs before the 7:30 digest so the digest reports what actually happened.
  // =========================================================================
  cron.schedule('50 6 * * *', async () => {
    try {
      // runExclusive: overlapping Railway instances scanning the same Spam
      // ids would double-insert rescue/review notifications.
      await runExclusive('inbox-hygiene', async () => {
        // Independent jobs run isolated — a transient quarantine failure
        // must not cost the once-daily spam rescue or draft reconciliation.
        const hygiene = require('./email/inbox-hygiene');
        let swept = { trashed: 0, restored: 0 };
        let rescued = { rescued: 0, scanned: 0, customers: 0, unauthenticated: 0 };
        let drafts = { settled: 0, released: 0, redrafted: 0 };
        let staleBlocks = { reconciled: 0, failed: 0 };
        const failures = [];
        try { swept = await hygiene.sweepQuarantine(); }
        catch (e) { failures.push(`sweep: ${e.message}`); logger.error(`[inbox-hygiene] quarantine sweep failed: ${e.message}`); }
        try { rescued = await hygiene.rescueSpamFolder(); }
        catch (e) { failures.push(`rescue: ${e.message}`); logger.error(`[inbox-hygiene] spam rescue failed: ${e.message}`); }
        try { drafts = await hygiene.reconcilePendingDrafts(); }
        catch (e) { failures.push(`reconcile: ${e.message}`); logger.error(`[inbox-hygiene] draft reconcile failed: ${e.message}`); }
        // Auto-blocked senders who have since become customers/open leads:
        // unwind the block (and recover buried mail) without waiting for
        // their next inbound message to trip the isBlocked retry path.
        try { staleBlocks = await require('./email/spam-blocker').reconcileStaleAutoBlocks(); }
        catch (e) { failures.push(`stale-blocks: ${e.message}`); logger.error(`[inbox-hygiene] stale-block reconcile failed: ${e.message}`); }
        if (staleBlocks.failed) failures.push(`stale-blocks: ${staleBlocks.failed} row(s) still pending recovery`);
        logger.info(`[inbox-hygiene] daily sweep: ${swept.trashed} quarantined trashed (${swept.restored} restored), ${rescued.rescued}/${rescued.scanned} rescued from spam (${rescued.customers} customer, ${rescued.unauthenticated} unverified), draft claims: ${drafts.settled} settled/${drafts.released} released/${drafts.redrafted} redrafted, stale blocks: ${staleBlocks.reconciled} unwound/${staleBlocks.failed} pending`);
        // Isolation must not mask failure from job_health — all jobs ran,
        // but a failed step still marks this tick failed for ops visibility.
        if (failures.length) throw new Error(`inbox-hygiene partial failure: ${failures.join('; ')}`);
      });
    } catch (err) {
      logger.error(`[inbox-hygiene] Cron failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 7:30 AM — Morning email digest notification
  // =========================================================================
  cron.schedule('30 7 * * *', async () => {
    try {
      // Window opens at ET midnight yesterday. The previous computation
      // used setHours(0,0,0,0) in server-local time — Railway runs UTC, so
      // the "overnight" window opened at UTC midnight (= 7–8 PM ET two days
      // prior) and the 7:30 AM digest counted ~35 hours of email.
      const windowStart = parseETDateTime(`${etDateString(addETDays(new Date(), -1))}T00:00:00`);

      const emails = await db('emails').where('received_at', '>=', windowStart);
      const unread = await db('emails')
        .where({ is_read: false, is_archived: false })
        .count('* as c').first();

      const leads = emails.filter(e => e.auto_action && e.auto_action.includes('lead_created')).length;
      const invoices = emails.filter(e => e.classification === 'vendor_invoice').length;
      // Actual quarantine-lane outcomes only — a known-sender skip or a
      // failed quarantine left the message available and must not be
      // digested as handled.
      const spam = emails.filter(e => /^spam_(quarantined|trashing|trashed|blocked)/.test(e.auto_action || '')).length;
      const invoiceAmounts = emails
        .filter(e => e.classification === 'vendor_invoice' && e.extracted_data)
        .reduce((sum, e) => {
          const data = typeof e.extracted_data === 'string' ? JSON.parse(e.extracted_data) : e.extracted_data;
          return sum + (parseFloat(data.invoice_amount) || 0);
        }, 0);

      const parts = [`${parseInt(unread?.c || 0)} unread`];
      if (leads > 0) parts.push(`${leads} leads created`);
      // Only claim a dollar figure when extraction actually produced one —
      // "4 invoices ($0.00 logged)" was a fabricated total, not a real zero.
      if (invoices > 0) {
        parts.push(invoiceAmounts > 0
          ? `${invoices} invoice${invoices > 1 ? 's' : ''} ($${invoiceAmounts.toFixed(2)} logged)`
          : `${invoices} invoice${invoices > 1 ? 's' : ''} (amounts not extracted)`);
      }
      if (spam > 0) parts.push(`${spam} spam quarantined`);
      // Exception surface: quarantine attempts that FAILED left classified
      // spam sitting in the inbox — that's exactly what the digest exists
      // to flag.
      const quarantineIssues = emails.filter(e => ['spam_quarantine_failed', 'spam_quarantine_ambiguous'].includes(e.auto_action)).length;
      if (quarantineIssues > 0) parts.push(`${quarantineIssues} quarantine failure${quarantineIssues > 1 ? 's' : ''} (spam still in inbox)`);
      const unsubscribed = emails.filter(e => e.auto_action && e.auto_action.startsWith('newsletter_unsubscribed')).length;
      if (unsubscribed > 0) parts.push(`${unsubscribed} unsubscribed`);
      // Real Gmail draft ids only — 'pending' claims and reconciliation
      // sentinels (reconciled_replied / reconciled_existing_draft) are not
      // drafts this agent created.
      const drafted = emails.filter(e => e.draft_gmail_id
        && !['pending', 'reconciled_existing_draft', 'reconciled_replied'].includes(e.draft_gmail_id)).length;
      if (drafted > 0) parts.push(`${drafted} repl${drafted > 1 ? 'ies' : 'y'} drafted`);

      // Follow-up nudges: inbound conversation mail nobody has answered.
      // Failure here must not kill the digest \u2014 nudges degrade to absent.
      let nudgeLines = '';
      try {
        const { collectUnansweredNudges } = require('./email/inbox-hygiene');
        const nudges = await collectUnansweredNudges();
        if (nudges.length) {
          nudgeLines = ` Awaiting your reply: ${nudges
            .map((n) => `${n.from_name || n.from_address} ("${(n.subject || '(no subject)').slice(0, 40)}")`)
            .join('; ')}.`;
        }
      } catch (e) {
        logger.warn(`[email-digest] nudge collection failed: ${e.message}`);
      }

      // Through NotificationService (not a raw insert) so the admin bell
      // policy chokepoint covers the digest; notifyAdmin never throws.
      await require('./notification-service').notifyAdmin(
        'email_digest',
        'Morning Email Digest',
        `${emails.length} emails overnight. ${parts.join(', ')}.${nudgeLines} Check /admin/email for details.`,
        {
          icon: '\uD83D\uDCE7',
          link: '/admin/email',
          metadata: { severity: (parseInt(unread?.c || 0) > 10 || nudgeLines || quarantineIssues > 0) ? 'high' : 'low' },
        },
      );

      logger.info(`[email-digest] Morning digest: ${emails.length} emails, ${leads} leads, ${spam} spam`);
    } catch (err) {
      logger.error(`[email-digest] Cron failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 2 HOURS — Estimate follow-up SMS (unviewed, viewed-not-accepted, expiring)
  // =========================================================================
  cron.schedule('0 */2 * * *', async () => {
    try {
      // The 5-min engine tick shares this lock (codex 2736 r6), fires on
      // the same :00 boundary, and its dark-mode backlog drain can hold it
      // for minutes — a plain non-blocking skip would cost this job a whole
      // 2h tick and age estimates out of the legacy stages' bounded windows
      // (codex 2736 r11: sent_at 24–48h etc.). Retry the lease a few times;
      // sweep-style queries make a slightly-late run equivalent to an
      // on-time one, and the atomic claims keep a duplicate-adjacent run
      // safe. The ENGINE stays the only lane allowed to skip outright.
      const LEASE_RETRIES = 5;
      const LEASE_RETRY_MS = 60000;
      for (let attempt = 0; attempt <= LEASE_RETRIES; attempt++) {
        const result = await runExclusive('estimate-follow-up', async () => {
          const EstimateFollowUp = require('./estimate-follow-up');
          const res = await EstimateFollowUp.checkAll();
          if (res.sent > 0) logger.info(`Estimate follow-ups: ${res.sent} sent`);
          return res;
        });
        if (!result?.skipped) break;
        if (attempt < LEASE_RETRIES) {
          logger.info(`[est-followup] lease held (attempt ${attempt + 1}/${LEASE_RETRIES + 1}) — retrying in ${LEASE_RETRY_MS / 1000}s`);
          await new Promise((resolve) => setTimeout(resolve, LEASE_RETRY_MS));
        } else {
          logger.warn('[est-followup] lease still held after retries — skipping this 2h tick');
        }
      }
    } catch (err) {
      logger.error(`Estimate follow-up job failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 5 MIN — Estimate engagement engine (behavior-triggered follow-ups)
  //
  // Sweeps the time-based rules into the job queue, then processes due jobs
  // (view-event rules enqueue from the estimate view hook). 5-min cadence is
  // what makes the 15-minute return-visit trigger real. Dark behind
  // GATE_ESTIMATE_ENGAGEMENT_FOLLOWUP: off = jobs are consumed as 'shadow'
  // and would-sends logged, nothing customer-facing.
  // =========================================================================
  cron.schedule('*/5 * * * *', async () => {
    try {
      // SAME advisory lock as the legacy follow-up cron (codex 2736 r6):
      // both lanes read/bump the shared follow_up_count / last_follow_up_at
      // counters, so a same-minute overlap could let each pass a stale
      // spacing/cap check and double-touch the customer. One lock
      // serializes them; the engine just skips a 5-min tick when the 2h
      // job holds it.
      await runExclusive('estimate-follow-up', async () => {
        const EngagementEngine = require('./estimate-engagement-engine');
        await EngagementEngine.sweepTimeRules();
        await EngagementEngine.processDueJobs();
      });
    } catch (err) {
      logger.error(`[est-engage] cron failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 30 MIN — Abandoned-booking recovery (1h SMS + 24h email)
  //
  // Chases /book drop-offs captured as booking_intents. 30-min cadence keeps the
  // ~1h first-touch SMS responsive. Suppression is enforced in
  // the service + the messaging validator. Ships LIVE; kill switch is
  // GATE_BOOKING_ABANDON_RECOVERY=false (then it only shadow-logs counts).
  // =========================================================================
  cron.schedule('*/30 * * * *', async () => {
    try {
      await runExclusive('booking-abandon-recovery', async () => {
        const BookingAbandonRecovery = require('./booking-abandon-recovery');
        const result = await BookingAbandonRecovery.checkAbandoned();
        if (result.sent > 0) logger.info(`Booking recovery: ${result.sms} SMS + ${result.email} email sent`);
      });
    } catch (err) {
      logger.error(`Booking abandon recovery job failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 30 MIN — Click-followup action queue (clicked-but-didn't-book)
  //
  // Turns human short-link clicks on estimate/booking links (4h–72h old, not
  // converted, fully suppression-guarded) into PENDING message_drafts for
  // owner approval in /admin/drafts. DRAFTS ONLY — this job never sends;
  // the owner's approval in /admin/drafts is the only send path. Gated by
  // GATE_CLICK_FOLLOWUP (off → shadow-logs candidate counts, writes nothing).
  // =========================================================================
  cron.schedule('*/30 * * * *', async () => {
    try {
      await runExclusive('click-followup', async () => {
        const ClickFollowup = require('./click-followup');
        const result = await ClickFollowup.checkClicks();
        if (result.drafted > 0) logger.info(`Click-followup: ${result.drafted} draft(s) queued for review`);
      });
    } catch (err) {
      logger.error(`Click-followup job failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // Estimate extensions are manual-only. Do not auto-renew expired estimates
  // from cron; staff can extend deliberately through the admin estimate route.

  // =========================================================================
  // EVERY 15 MIN — Release expired slot reservations
  //
  // Reserve→accept holds set scheduled_services.reservation_expires_at to
  // NOW() + 15min. When a customer abandons before accepting (closes tab,
  // network drops, sits past the countdown) the row sticks around marked
  // as occupied for that (tech, date, window) tuple, blocking other
  // customers from picking the slot. Cadence matches the 15-min TTL so
  // worst-case stale-hold lifetime is ~30 min (TTL + cleanup interval).
  //
  // releaseExpiredReservations() is a narrow DELETE on rows where
  // reservation_expires_at < NOW() — see slot-reservation.js for the
  // index that keeps the scan cheap.
  // =========================================================================
  cron.schedule('*/15 * * * *', async () => {
    try {
      const { releaseExpiredReservations } = require('./slot-reservation');
      const result = await releaseExpiredReservations();
      if (result.released > 0) logger.info(`[slot-reservation] released ${result.released} expired reservation(s)`);
    } catch (err) {
      logger.error(`Slot reservation cleanup failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // HOURLY — Archive expired one-tap purchase drafts
  //
  // A one-tap init synthesizes a 24h draft estimate. The overlay's close
  // handler voids + archives it, but a crashed tab or closed laptop never
  // fires that — and the admin estimate pipeline lists every unarchived
  // draft. This sweep voids open purchases whose draft has expired and
  // archives the drafts so abandons age out within ~25h. Inert while
  // GATE_ONE_TAP_PURCHASE has never been on (no rows).
  // =========================================================================
  cron.schedule('40 * * * *', async () => {
    try {
      const { sweepStaleOneTapDrafts } = require('./one-tap-purchase');
      await sweepStaleOneTapDrafts();
    } catch (err) {
      logger.error(`One-tap stale-draft sweep failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // Estimate actuals reconcile — nightly, joins completed services back to
  // the accepted estimate that created them and writes the priced-vs-observed
  // ledger (estimate_actuals). Systematic-bias aggregates are read via
  // GET /api/admin/estimates/actuals-variance.
  // =========================================================================
  cron.schedule('37 2 * * *', async () => {
    try {
      const { runEstimateActualsReconcile } = require('./estimate-actuals');
      const result = await runEstimateActualsReconcile();
      if (result.written > 0) {
        logger.info(`[estimate-actuals] nightly reconcile wrote ${result.written} row(s)`);
      }
    } catch (err) {
      logger.error(`Estimate actuals reconcile cron failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // Dashboard alerts — every 5 minutes, detect transitions in operational
  // alerts and fan out Waves admin notifications.
  // See server/services/dashboard-alerts-cron.js for the diff logic.
  // =========================================================================
  cron.schedule('*/5 * * * *', async () => {
    try {
      const { runDashboardAlertsCheck } = require('./dashboard-alerts-cron');
      const result = await runDashboardAlertsCheck();
      if (result.fired > 0 || result.cleared > 0) {
        logger.info(`[dashboard-alerts] fired=${result.fired} cleared=${result.cleared} active=${result.current}`);
      }
    } catch (err) {
      logger.error(`Dashboard alerts cron failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // Property-lookup parser canary — nightly, one golden parcel per county
  // through the real by-parcel pipeline; alerts when a county PAO layout
  // change silently breaks the scrape-based parsers.
  // See server/services/property-lookup-canary.js.
  // =========================================================================
  cron.schedule('17 4 * * *', async () => {
    try {
      const { runPropertyLookupCanary } = require('./property-lookup-canary');
      const result = await runPropertyLookupCanary();
      if (result.failures?.length) {
        logger.warn(`[property-lookup-canary] ${result.failures.length} failing check(s)`);
      }
    } catch (err) {
      logger.error(`Property-lookup canary cron failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // WaveGuard lawn readiness — route-morning protocol preflight snapshot.
  // Stores the readiness ledger and opens an admin alert when appointments
  // are blocked by assignment, calibration, inventory, or property gates.
  // =========================================================================
  cron.schedule('30 5 * * *', async () => {
    try {
      const { runReadinessSnapshot } = require('./lawn-protocol-readiness-cron');
      const result = await runReadinessSnapshot({ days: 14, limit: 100, source: 'scheduled_daily' });
      if (!result.skipped) {
        logger.info(`[lawn-protocol-readiness] ready=${result.ready || 0} warning=${result.warning || 0} blocked=${result.blocked || 0} appointments=${result.appointmentCount || 0}`);
      }
    } catch (err) {
      logger.error(`Lawn protocol readiness snapshot failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // WaveGuard inventory forecast — proactive product shortage warning before
  // readiness starts blocking dispatch.
  // =========================================================================
  cron.schedule('45 5 * * *', async () => {
    try {
      const { runWaveGuardInventoryForecastCheck } = require('./waveguard-inventory-forecast');
      const result = await runWaveGuardInventoryForecastCheck({ days: 14, limit: 150, source: 'scheduled_daily' });
      if (!result.skipped) {
        logger.info(`[waveguard-inventory-forecast] ok=${result.ok || 0} warning=${result.warning || 0} short=${result.short || 0} unit_mismatch=${result.unit_mismatch || 0} not_tracked=${result.not_tracked || 0} products=${result.productCount || 0}`);
      }
    } catch (err) {
      logger.error(`WaveGuard inventory forecast check failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 8AM — Tax Deadline Alerting (SMS reminders for upcoming filings)
  // =========================================================================
  cron.schedule('0 8 * * *', async () => {
    logger.info('Running: tax deadline alert check');
    try {
      await runExclusive('tax-deadline-alerts', async () => {
      const now = new Date();
      const today = etDateString(now);
      const futureDate = etDateString(addETDays(now, 14));

      // Find filings due in the next 14 days that haven't been reminded yet
      const upcomingFilings = await db('tax_filing_calendar')
        .where('due_date', '>=', today)
        .where('due_date', '<=', futureDate)
        .whereNot('status', 'filed')
        .whereNot('status', 'paid')
        .where(function () {
          this.whereNull('reminder_sent_at')
            .orWhere('reminder_sent', false);
        })
        .orderBy('due_date');

      if (upcomingFilings.length === 0) {
        return;
      }

      // Build reminder message. due_date is a DATE column — pg hands it
      // back as midnight, so `new Date(f.due_date)` rendered in ET shows
      // the previous day. Anchor the calendar date at ET noon instead
      // (dateOnly + T12:00 pattern, same as admin-schedule.js) so both the
      // displayed date and the day-count math stay on the right ET day.
      const todayNoon = parseETDateTime(`${today}T12:00`);
      const lines = upcomingFilings.map(f => {
        const dueDate = parseETDateTime(`${dateOnlyString(f.due_date)}T12:00`);
        const daysUntil = Math.round((dueDate.getTime() - todayNoon.getTime()) / (24 * 60 * 60 * 1000));
        const amountStr = f.amount_due ? ` ($${parseFloat(f.amount_due).toLocaleString()})` : '';
        return `- ${f.title}${amountStr} — due ${dueDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })} (${daysUntil} day${daysUntil !== 1 ? 's' : ''})`;
      });

      const message = `Tax Deadline Alert:\n\n${lines.join('\n')}\n\nReview in the admin portal.`;

      // Send SMS to admin
      if (process.env.ADAM_PHONE) {
        await TwilioService.sendSMS(process.env.ADAM_PHONE, message, { messageType: 'internal_alert' });
        logger.info(`[tax-alerts] Sent ${upcomingFilings.length} deadline reminder(s) via SMS`);
      }

      // Mark reminders as sent
      const ids = upcomingFilings.map(f => f.id);
      await db('tax_filing_calendar')
        .whereIn('id', ids)
        .update({ reminder_sent: true, reminder_sent_at: new Date() });
      });
    } catch (err) {
      logger.error(`Tax deadline alert failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // SUNDAY 7AM — Weekly Tax Advisor report
  // =========================================================================
  cron.schedule('0 7 * * 0', async () => {
    try {
      const TaxAdvisor = require('./tax-advisor');
      const advisor = new TaxAdvisor();
      await advisor.generateWeeklyReport();
      logger.info('Tax Advisor weekly report generated');
    } catch (err) {
      logger.error(`Tax Advisor failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // Customer health scoring is consolidated into the single nightly Customer
  // Intelligence Pipeline (3AM ET): detect signals → score (customer-health.js,
  // the sole canonical engine) → enrich (upsell/next-action/LTV) → outreach.
  // The former 2AM (customer-health-v2 → unread customers.health_score) and
  // 2:15AM (standalone v3) jobs were removed to end the three-writer collision.

  // (Removed 2026-07-06) The 28th-of-month WaveGuard billing-reminder text is
  // retired — autopay customers already get the pre-charge notice, and the
  // extra monthly text was noise (owner call).

  // =========================================================================
  // EVERY 15 MIN — Process scheduled content (blog + social auto-publish).
  // runExclusive: the tick drives external side effects (publishToAll to
  // every social platform, Astro publish PRs), and while the row claims are
  // now compare-and-set, the stale-'publishing' sweeps at the top of
  // processScheduledPosts are only provably safe when no sibling tick can
  // have a publish in flight — the advisory lock guarantees that (deploy
  // overlap and slow prior ticks alike).
  // =========================================================================
  cron.schedule('*/15 * * * *', async () => {
    try {
      await runExclusive('content-scheduler-tick', async () => {
        const ContentScheduler = require('./content-scheduler');
        const result = await ContentScheduler.processScheduledPosts();
        if (result.blogCount > 0 || result.socialCount > 0) {
          logger.info(`Content scheduler: ${result.blogCount} blog(s), ${result.socialCount} social post(s) published`);
        }
        if (result.socialSkipped) {
          // social portion was skipped by feature flag — don't log noise
        }
        // Re-drive newsletter social shares stranded by a crash between
        // send-completion and the fire-and-forget share in sendCampaign.
        await ContentScheduler.retryStrandedNewsletterShares();
      });
    } catch (err) {
      logger.error(`Content scheduler failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 1:20AM ET — Content registry maintenance.
  // Syncs the registry from the pinned GitHub Astro source, then refreshes
  // live HTTP/sitemap status for published/reconciled rows.
  // =========================================================================
  cron.schedule('20 1 * * *', async () => {
    try {
      const result = await runContentRegistryMaintenance();
      logger.info(`[content-registry] maintenance complete: sync=${JSON.stringify(result.sync)} live=${JSON.stringify(result.live)}`);
    } catch (err) {
      logger.error(`[content-registry] maintenance failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 4 HOURS — Check RSS feed for new blog posts → auto-post to social
  // =========================================================================
  cron.schedule('0 */4 * * *', async () => {
    const { SOCIAL_FLAGS } = require('./social-media');
    if (!SOCIAL_FLAGS.automationEnabled || !SOCIAL_FLAGS.rssAutopublish) {
      return; // silently skip — flags not enabled
    }
    logger.info('Running: RSS social media check');
    try {
      const SocialMediaService = require('./social-media');
      const result = await SocialMediaService.checkAndPublish();
      logger.info(`RSS social media check done: ${result.processed} new post(s) published`);
    } catch (err) {
      logger.error(`RSS social media check failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 6:30 AM ET — Autonomous Social Content Studio
  // One post per day at a fixed, good-engagement time (avoids the off-hours
  // drift an hourly check + 24h interval produced). runAutonomous still enforces
  // the kill switch (SOCIAL_AUTONOMOUS_STUDIO_ENABLED), the distinct cron opt-in,
  // the DB-backed cadence guard, and a Postgres advisory lock — so duplicate
  // fires (restart/pod overlap, a recent manual force) are still deduped. The
  // cadence interval is < 24h (see SOCIAL_AUTONOMOUS_INTERVAL_HOURS default) so
  // this fixed daily tick always clears the guard instead of being skipped by
  // sub-minute drift.
  // =========================================================================
  cron.schedule('30 6 * * *', async () => {
    const SocialContentStudio = require('./social-content-studio');
    const flags = SocialContentStudio.AUTONOMOUS_FLAGS;
    // Requires BOTH the studio kill switch AND the distinct cron opt-in, so
    // enabling the Studio for manual admin use does not by itself start hourly
    // automatic publishing.
    if (!flags.enabled || !flags.cronEnabled) {
      return; // silently skip — studio off, or autonomous cron not opted in
    }
    try {
      const result = await SocialContentStudio.runAutonomous({ force: false });
      if (result?.skipped) {
        // result.reason can embed validateContent output, which may include a
        // full phone number or email — never log raw PII (AGENTS.md P1). Redact
        // phone/email-like substrings before logging the skip reason.
        const safeReason = String(result.reason || '')
          .replace(/\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/g, '[redacted-phone]')
          .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[redacted-email]');
        logger.info(`[social-studio] autonomous run skipped: ${safeReason}`);
      } else {
        logger.info(`[social-studio] autonomous run complete: status=${result?.run?.status || result?.status || 'done'}`);
      }
    } catch (err) {
      logger.error(`[social-studio] autonomous run failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 2 HOURS — Adjust ad budgets based on capacity
  // =========================================================================
  cron.schedule('0 */2 * * *', async () => {
    logger.info('Running: ad budget adjustment');
    try {
      const BudgetManager = require('./ads/budget-manager');
      await BudgetManager.adjustBudgets();
    } catch (err) {
      logger.error(`Ad budget adjustment failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // NIGHTLY 3AM — Customer Intelligence Pipeline
  // =========================================================================
  cron.schedule('0 3 * * *', async () => {
    logger.info('Running: customer intelligence pipeline');
    let step = 'step 1 (signal detection)';
    try {
      const SignalDetector = require('./customer-intelligence/signal-detector');
      const HealthScorer = require('./customer-intelligence/health-scorer');
      const RetentionEngine = require('./customer-intelligence/retention-engine');

      // Step 1: Detect signals. Isolated so a detection failure doesn't skip
      // tonight's scoring — this is now the only nightly health-score refresh,
      // and scoring folds whatever signals already exist.
      try {
        const signalResult = await SignalDetector.detectAllSignals();
        logger.info(`Signals: ${signalResult.newSignals} new from ${signalResult.customersScanned} customers`);
      } catch (err) {
        logger.error(`Signal detection failed (continuing to scoring): ${err.message}`);
      }

      // Step 2: Score health — single canonical engine (customer-health.js).
      // Runs after signal detection so tonight's fresh signals fold into the
      // score. Sole writer of overall_score / churn_risk / sub-scores.
      step = 'step 2 (health scoring)';
      const { scoreAllCustomers } = require('./customer-health');
      const healthResult = await scoreAllCustomers();
      logger.info(`Health: ${healthResult.scored} scored, ${healthResult.failed} failed`);

      // Step 2b: Enrich scored rows with upsell / next-action / LTV (no score
      // recompute — adds intelligence columns only).
      step = 'step 2b (intelligence enrichment)';
      const enrichResult = await HealthScorer.enrichAllCustomers();
      logger.info(`Enrichment: ${enrichResult.enriched} enriched, ${enrichResult.upsells} upsells`);

      // Step 3: Generate retention outreach for at-risk customers. high +
      // critical = the canonical engine's at-risk band (vocab:
      // low/moderate/high/critical). scored_at is a timestamp under the
      // canonical engine, so match on its date.
      step = 'step 3 (retention outreach)';
      const today = etDateString();
      // Real customers only: health scores cover leads too, and a never-
      // paying new_lead must not consume an outreach draft or fire a churn
      // alert (Copeman, 2026-07-11). Same predicate the engine itself guards
      // with — this just skips the pointless per-lead calls.
      const { CUSTOMER_STAGES } = require('./customer-stages');
      const atRisk = await db('customer_health_scores as chs')
        .join('customers as c', 'c.id', 'chs.customer_id')
        .whereRaw('chs.scored_at::date = ?', [today])
        .whereIn('chs.churn_risk', ['high', 'critical'])
        .whereIn('c.pipeline_stage', CUSTOMER_STAGES)
        .whereNull('c.deleted_at')
        .select('chs.customer_id');

      let outreachGenerated = 0;
      for (const c of atRisk) {
        const result = await RetentionEngine.generateRetentionOutreach(c.customer_id);
        if (result) outreachGenerated++;
      }

      logger.info(`Customer intelligence complete: ${outreachGenerated} outreach generated`);
    } catch (err) {
      logger.error(`Customer intelligence pipeline failed at ${step}: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // HOURLY — Verify CSR follow-up tasks
  // =========================================================================
  cron.schedule('30 * * * *', async () => {
    logger.info('Running: follow-up task verification');
    try {
      // runExclusive: verifyFollowUps expires past-deadline tasks — a
      // deploy-overlap tick racing itself can double-process the same rows.
      const verifyLock = await runExclusive('csr-follow-up-verify', async () => {
        const CSRCoach = require('./csr/csr-coach');
        await CSRCoach.verifyFollowUps();
        // Hourly: resolve actioned flags FIRST, then replay bells
        // (codex #3232 r21/r23).
        const riw = require('./reschedule-intent-watcher');
        await riw.resolveActionedFlags();
        await riw.replayPendingBells();
      });
      if (verifyLock && verifyLock.skipped && verifyLock.reason !== 'lease_held') {
        const { recordJobStart, recordJobEnd } = require('../utils/cron-lock');
        const t0 = Date.now();
        await recordJobStart('csr-follow-up-verify').catch(() => {});
        await recordJobEnd('csr-follow-up-verify', t0, new Error(`tick skipped: ${verifyLock.reason || 'no_connection'}`)).catch(() => {});
        throw new Error(`follow-up verification tick skipped: ${verifyLock.reason || 'no_connection'}`);
      }
    } catch (err) {
      logger.error(`Follow-up verification failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // FRIDAY 8AM — Weekly CSR team recommendation
  // =========================================================================
  cron.schedule('0 8 * * 5', async () => {
    logger.info('Running: weekly CSR recommendation');
    try {
      const CSRCoach = require('./csr/csr-coach');
      const rec = await CSRCoach.generateWeeklyTeamRecommendation();
      if (rec.recommendation && TwilioService && process.env.ADAM_PHONE) {
        await TwilioService.sendSMS(process.env.ADAM_PHONE,
          `📊 Weekly CSR Tip:\n\n${rec.recommendation}\n\n${rec.dataPoint}\n${rec.estimatedImpact}`,
          { messageType: 'internal_alert' }
        );
      }
    } catch (err) {
      logger.error(`Weekly CSR rec failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

// =========================================================================
  // DAILY 5AM — Auto-generate next blog post content
  // =========================================================================
  cron.schedule('0 5 * * *', async () => {
    logger.info('Running: blog post auto-generation');
    try {
      const BlogWriter = require('./content/blog-writer');
      const nextPost = await db('blog_posts')
        .where('status', 'queued')
        .whereNull('content')
        .orderBy('publish_date', 'asc')
        .first();

      if (nextPost) {
        await BlogWriter.generatePost(nextPost.id);
        logger.info(`Blog auto-generated: "${nextPost.title}"`);
      }
    } catch (err) {
      logger.error(`Blog auto-generation failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // WEEKLY SUNDAY 6AM — Full blog content audit
  // =========================================================================
  cron.schedule('0 6 * * 0', async () => {
    logger.info('Running: blog content audit');
    try {
      const BlogAuditor = require('./content/blog-auditor');
      const audit = await BlogAuditor.runFullAudit();
      await db('ai_audits').insert({
        audit_type: 'blog_content',
        audit_date: new Date(),
        report_data: JSON.stringify(audit),
        recommendation_count: audit.recommendations?.length || 0,
        critical_issues: audit.duplicates?.length || 0,
        status: 'completed',
      });
    } catch (err) {
      logger.error(`Blog audit failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // MONTHLY 1ST 6AM — Generate 20 new blog post ideas
  // =========================================================================
  cron.schedule('0 6 1 * *', async () => {
    logger.info('Running: blog idea generation');
    try {
      const BlogWriter = require('./content/blog-writer');
      const ideas = await BlogWriter.generateNewIdeas(20);
      logger.info(`Generated ${ideas.length} new blog post ideas`);
    } catch (err) {
      logger.error(`Blog idea generation failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 6AM — Google Ads sync (campaigns, performance, search terms)
  // =========================================================================
  cron.schedule('0 6 * * *', async () => {
    try {
      const googleAds = require('./ads/google-ads');
      if (!googleAds.isConfigured()) return;
      logger.info('Running: Google Ads daily sync');
      await googleAds.syncCampaigns();
      await googleAds.syncDailyPerformance(7);
      await googleAds.syncSearchTerms(30);
      logger.info('Google Ads daily sync complete');
    } catch (err) {
      logger.error(`Google Ads sync failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 6:15AM — Meta (Facebook/Instagram) Ads sync (campaigns + insights)
  // Pulls Meta ad spend/performance into the same ad_campaigns /
  // ad_performance_daily tables (platform='facebook'); the PPC dashboard then
  // shows Meta alongside Google. No-ops unless META_ADS_* creds are set.
  // =========================================================================
  cron.schedule('15 6 * * *', async () => {
    try {
      const metaAds = require('./ads/meta-ads');
      if (!metaAds.isConfigured()) return;
      logger.info('Running: Meta Ads daily sync');
      await metaAds.syncCampaigns();
      await metaAds.syncDailyPerformance(7);
      logger.info('Meta Ads daily sync complete');
    } catch (err) {
      logger.error(`Meta Ads sync failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 6:20AM — Google Ads call→campaign attribution bridge, THEN the
  // unclaimed→organic fallback, strictly in that order in one job.
  //
  // Step 1 (bridge): matches Google Ads call-reporting rows to CRM call_log
  // entries (≥70 confidence auto-match) and writes the campaign back onto
  // call_log + ad_service_attribution, so phone-call leads stop being
  // invisible to PPC ROI. No external upload (reads Google call reporting,
  // writes only our own DB); no-ops unless the Google Ads API is configured,
  // and idempotent (already-bridged calls are skipped).
  //
  // Step 2 (organic fallback): calls to the bridge-target number are held out
  // of organic attribution at call time so the bridge gets first claim; leads
  // the bridge never claims within BRIDGE_UNCLAIMED_ORGANIC_DAYS (default 7)
  // are declared organic via the normal recordCallPpcAttribution path
  // (idempotent, dedup by lead_id). Opt-out BRIDGE_UNCLAIMED_ORGANIC_DISABLED.
  //
  // Sequenced in ONE cron body under ONE runExclusive lease so the fallback
  // can never run while a bridge scan is mid-claim (separate crons 5 minutes
  // apart left a race: a slow bridge run past the gap would lose a
  // boundary-age paid call to an organic row it can't flip). The lock also
  // means a deploy-overlap instance skips the PAIR atomically — never the
  // fallback without the bridge. Runs before the 6:25 ad-cost allocation so
  // fresh attribution rows get ad_cost the same morning.
  // =========================================================================
  cron.schedule('20 6 * * *', async () => {
    try {
      await runExclusive('google-call-bridge-organic', async () => {
        // The bridge/organic pair gets its OWN catch (codex P2 r13): an
        // exception from applyBridge or the organic candidate query used to
        // jump straight to the cron's outer catch and skip the transfer
        // sweep below — a persistent bridge-specific failure must not
        // starve the retry lane for calls the bridge never scans. The
        // error is CAPTURED, not swallowed (codex P2 r15): rethrown after
        // the sweep so runExclusive's job-health record still counts the
        // failed tick — a swallowed throw cleared last_error/
        // consecutive_failures and made a persistent outage look healthy.
        let bridgePairError = null;
        // The organic pass degrades internally too (source-scan catch →
        // zeroed summary, per-lead catches → summary.failed) so it never
        // throws on its own — same shape as the transfer sweep's P2 (codex
        // P2 r29). Inspect the summary and surface degradation in the
        // job-health record; captured separately so it can never mask a
        // bridge error.
        let organicError = null;
        try {
          const googleAds = require('./ads/google-ads');
          // The fallback below may only run after a COMPLETE, HEALTHY bridge
          // pass — an organic row can never be flipped to paid later, so any
          // doubt about the day's claim means the fallback waits a day.
          let bridgeBlockedReason = null;
          // Leads tied to AMBIGUOUS bridge matches are excluded from the
          // organic fallback (scoped, see below). The day's fresh candidate
          // ids are tracked separately: only THEY may take the broad phone
          // exclusion arm — persisted indefinite holds ride the durable
          // sid/stamp arms alone (codex P1, ambiguity-record r2).
          let organicExclusions = { excludeCallSids: [], excludeCallIds: [] };
          let dayAmbiguousCallIds = [];
          if (googleAds.isConfigured()) {
            logger.info('Running: Google Ads call→campaign bridge');
            const callBridge = require('./ads/google-call-bridge');
            // limit 500 = the existing CRM-side cap in fetchCrmCalls(); keep the
            // Google scan symmetric (was 200) so the cron isn't the narrower side.
            // Both sides are bounded by design — warn if either hits the cap (older
            // calls would go unbridged and need pagination, a wider refactor that's
            // unwarranted today at ~0 Google-Ads-driven calls).
            const bridgeScanDays = 30;
            const r = await callBridge.applyBridge({ days: bridgeScanDays, limit: 500 });
            const capHit = (r.summary?.googleCalls || 0) >= 500 || (r.summary?.crmMainLineCalls || 0) >= 500;
            if (capHit) {
              logger.warn('[google-call-bridge cron] 30-day scan hit the 500-row cap — older calls may be unbridged; add pagination if call volume grows');
            }
            // Any write failure means a claim the bridge ATTEMPTED may not have
            // repointed the lead yet — the sweep must not take it organic today.
            const writeFailed = (r.skipped || []).some((m) => m?.skipReason === 'write_failed' || m?.skipReason === 'lead_retry_failed');
            // Ambiguity is uncertainty, not absence (codex P1 r14) — but
            // SCOPED, not global (pre-push P1 r18): an 'ambiguous' match
            // means the scan found strong but non-unique paid-call
            // evidence and deliberately left the CRM call unclaimed, and
            // sweeping ITS lead organic would irreversibly mislabel a
            // probably-paid lead — while blocking the WHOLE fallback on one
            // persistent ambiguity starved every unrelated organic lead.
            // PERSISTED ambiguity (owner ruling 2026-08-11, GH-r24 P1):
            // applyBridge itself records every scan's candidates AND
            // resolves open records on POSITIVE evidence, on every apply
            // path — manual admin applies included, since their 31–90-day
            // windows reach calls this 30-day cron never re-sees for
            // either purpose (codex P1s, ambiguity-record r2+r3 GH
            // rounds). The cron only feeds the sweep from ALL open
            // records; a failure throws to bridgePairError, which also
            // skips the organic sweep — never sweep with a partial
            // exclusion set.
            dayAmbiguousCallIds = r.ambiguousCandidateCallIds || [];
            if (r.scanFailed) bridgeBlockedReason = 'scan_failed';
            else if (capHit) bridgeBlockedReason = 'row_cap_hit';
            else if (writeFailed) bridgeBlockedReason = 'bridge_write_failed';
            logger.info(`[google-call-bridge cron] ${JSON.stringify({
              configured: r.configured,
              scanFailed: !!r.scanFailed,
              applied: r.appliedCount,
              skipped: r.skippedCount,
              googleCalls: r.summary?.googleCalls,
              crmMainLineCalls: r.summary?.crmMainLineCalls,
              ambiguous: r.summary?.ambiguous || 0,
            })}`);
          } else if (process.env.BRIDGE_UNCLAIMED_ALLOW_UNCONFIGURED !== 'true') {
            // Fail closed on an UNCONFIGURED Google Ads API: a missing/rotated
            // GOOGLE_ADS_* secret is indistinguishable from a genuine
            // organic-only install, and the organic write is irreversible. An
            // install that truly runs no Google Ads API (so no call could ever
            // be claimed) opts in with BRIDGE_UNCLAIMED_ALLOW_UNCONFIGURED=true.
            bridgeBlockedReason = 'google_ads_unconfigured';
          }

          // ALL OPEN persisted ambiguity holds, on EVERY sweep path — the
          // unconfigured-with-opt-in branch runs no scan, but records from
          // before a teardown must still hold their leads. A read failure
          // throws to bridgePairError, which also skips the sweep: never
          // sweep with a partial exclusion set. The phone arm gets the
          // DAY'S ids only (empty on scan-less paths).
          organicExclusions = {
            ...(await require('./ads/google-call-bridge').openAmbiguousCallExclusions()),
            excludePhoneCallIds: dayAmbiguousCallIds,
          };

          // AFTER the bridge has had the day's claim: unclaimed bridge-target
          // leads older than the window become organic. Any doubt about the
          // day's claim — outage, row cap, write failure, unconfigured API
          // without the explicit opt-in — blocks it; those leads simply age
          // one more day.
          if (bridgeBlockedReason) {
            logger.warn(`[bridge-unclaimed] skipped — bridge pass incomplete (${bridgeBlockedReason}); unclaimed leads age another day`);
          } else if (process.env.BRIDGE_UNCLAIMED_ORGANIC_DISABLED !== 'true') {
            const { attributeUnclaimedBridgeLeads } = require('./ads/call-attribution');
            const days = parseInt(process.env.BRIDGE_UNCLAIMED_ORGANIC_DAYS, 10) || 7;
            const s = await attributeUnclaimedBridgeLeads({ olderThanDays: days, ...organicExclusions });
            logger.info(`[bridge-unclaimed] candidates ${s.candidates}, recorded ${s.recorded}, skipped ${s.skipped}, failed ${s.failed || 0}`);
            if (s.scanFailed) organicError = new Error('[bridge-unclaimed] source scan failed');
            else if (s.failed > 0) organicError = new Error(`[bridge-unclaimed] ${s.failed} lead(s) failed`);
          }
        } catch (err) {
          bridgePairError = err;
        }

        // Retry lane for processor repoints blocked by a legacy
        // (NULL-provenance) row (codex P1, PR #3303 r12): dedicated/organic
        // calls have no rescan of their own, so a durable
        // metadata.attribution_transfer_pending marker defers the funnel
        // write until the operator resolves the blocking row; this drain
        // completes it against the live stamped lead. Self-guarded and
        // independent of the day's bridge health — it repairs calls the
        // bridge never scans, so a blocked bridge pass must not starve it.
        let sweepError = null;
        try {
          const { sweepPendingAttributionTransfers } = require('./ads/call-attribution');
          const s = await sweepPendingAttributionTransfers({ limit: 100 });
          // The sweep degrades internally (scan catch → zeroed summary,
          // per-row catches → summary.failed), so a stalled retry lane
          // never throws on its own (codex P2 r16) — inspect the summary
          // and surface degradation in the job-health record.
          if (s.scanFailed) sweepError = new Error('[attribution-transfer-sweep] scan failed');
          else if (s.failed > 0) sweepError = new Error(`[attribution-transfer-sweep] ${s.failed} transfer(s) failed`);
        } catch (err) {
          sweepError = err;
          logger.warn(`[attribution-transfer-sweep] failed: ${err.message}`);
        }

        // Both halves ran — now surface any failure so the outer catch
        // logs it and the lease records a failed tick (bridge error takes
        // precedence; a swallowed throw cleared last_error on outages).
        if (bridgePairError) throw bridgePairError;
        if (organicError) throw organicError;
        if (sweepError) throw sweepError;
      });
    } catch (err) {
      logger.error(`Google Ads call bridge / unclaimed-organic sweep failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 6:25AM — Ad cost allocation. Runs AFTER the Google (6am) + Meta
  // (6:15am) syncs land fresh spend, spreading each paid channel-month's spend
  // across that channel's leads into ad_service_attribution.ad_cost — the
  // denominator the /admin/ads CAC / ROAS / LTV:CAC views read. Recomputes the
  // trailing ~90 days (idempotent); free channels keep ad_cost null.
  // =========================================================================
  cron.schedule('25 6 * * *', async () => {
    try {
      const { allocateAdCosts } = require('./ad-cost-allocation');
      const sinceDate = etDateString(addETDays(new Date(), -90));
      const res = await allocateAdCosts(undefined, { sinceDate });
      logger.info(`Ad cost allocation complete — rows ${res.updatedRows}, channel-months ${res.monthsTouched}`);
    } catch (err) {
      logger.error(`Ad cost allocation failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 6:15AM ET — Ad-attribution completion sweep. Backstop for the
  // completion-time syncCustomerAdAttribution (its only live trigger is
  // job-costing at visit completion): a funnel row created AFTER the
  // customer's visits completed — late attribution insert or backfill — would
  // otherwise never advance to 'completed' and the customer stays invisible
  // to revenue attribution. Runs before the 6:40/6:45 Google/Meta conversion
  // uploads so freshly-advanced revenue ships the same morning. Idempotent
  // and default-ON (it repairs data the dashboards already read); opt-out via
  // AD_ATTRIBUTION_SWEEP_DISABLED=true.
  // =========================================================================
  cron.schedule('15 6 * * *', async () => {
    if (process.env.AD_ATTRIBUTION_SWEEP_DISABLED === 'true') return;
    logger.info('Running: ad-attribution completion sweep');
    try {
      await runExclusive('ad-attribution-sweep', async () => {
        const { sweepPendingAdAttribution } = require('./ad-attribution-sync');
        const r = await sweepPendingAdAttribution();
        logger.info(`[ad-attribution sweep] candidates ${r.candidates}, advanced ${r.advanced}, skipped ${r.skipped}`);
      });
    } catch (err) {
      logger.error(`Ad-attribution sweep failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 6:40AM — Google Ads offline conversion upload (Data Manager API)
  // Automates the EXISTING DataManager.uploadConversions (qualified leads +
  // completed-job revenue) — previously admin-trigger only. Opt-in via
  // GOOGLE_DATA_MANAGER_CRON_ENABLED so it never auto-fires on deploy; even
  // when on, the module still honours GOOGLE_DATA_MANAGER_ALLOW_UPLOADS /
  // _VALIDATE_ONLY (validate-only unless the account is explicitly live) and
  // de-dupes per transaction id, so a 7-day re-scan never double-reports.
  // =========================================================================
  cron.schedule('40 6 * * *', async () => {
    if (process.env.GOOGLE_DATA_MANAGER_CRON_ENABLED !== 'true') return;
    logger.info('Running: Google Ads offline conversion upload (Data Manager)');
    try {
      const DataManager = require('./ads/data-manager');
      // Reconcile prior runs' still-pending requests first, so failures/partials
      // get marked (and become retryable) instead of stuck pending forever.
      const reconciled = await DataManager.reconcilePendingRequests({ limit: 100 });
      if (reconciled.length) {
        logger.info(`[data-manager cron] reconciled ${reconciled.length} pending request(s)`);
      }
      // No cron-lock wrapper here — uploadConversions self-serializes with a
      // per-type advisory lock, so it's safe against overlapping cron ticks AND a
      // concurrent admin-triggered upload (the manual endpoint calls the same fn).
      // Per-type window: a lead can be marked qualified (is_qualified) well after
      // first contact WITHOUT setting converted_at, and qualified-lead candidates
      // are dated by COALESCE(converted_at, first_contact_at, created_at). Scan the
      // full ~90-day Google import window so a lead first contacted up to 90 days
      // ago but qualified only now is still uploaded (anything older is outside
      // Google's window anyway). Per-transaction dedupe makes the overlap a no-op.
      const PERIOD_DAYS = { qualified_lead: 90, completed_job_revenue: 30 };
      for (const conversionType of ['qualified_lead', 'completed_job_revenue']) {
        const r = await DataManager.uploadConversions({
          conversionType, periodDays: PERIOD_DAYS[conversionType], limit: 500, validateOnly: false,
        });
        logger.info(`[data-manager cron] ${conversionType}: ${JSON.stringify({
          skipped: r.skipped || false, configured: r.configured, validateOnly: r.validateOnly,
          candidates: r.candidates, sent: r.sent, accepted: r.accepted, pending: r.pending,
          requestId: r.requestId || null, error: r.error || null,
        })}`);
      }
    } catch (err) {
      logger.error(`Data Manager offline conversion upload failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 6:45AM — Meta Conversions API upload (Lead + Purchase)
  // Opt-in via META_CAPI_CRON_ENABLED. uploadConversions self-serializes (per
  // type) and honours META_CAPI_ALLOW_UPLOADS / _TEST_EVENT_CODE, so it sends
  // real events only when explicitly allowed; otherwise it dry-runs to Test
  // Events (or no-ops). De-duped per event_id.
  // =========================================================================
  cron.schedule('45 6 * * *', async () => {
    if (process.env.META_CAPI_CRON_ENABLED !== 'true') return;
    logger.info('Running: Meta Conversions API upload');
    try {
      const MetaCapi = require('./ads/meta-data-manager');
      for (const conversionType of ['qualified_lead', 'completed_job_revenue']) {
        const r = await MetaCapi.uploadConversions({
          conversionType, periodDays: 7, limit: 500, validateOnly: false,
        });
        logger.info(`[meta-capi cron] ${conversionType}: ${JSON.stringify({
          configured: r.configured, skipped: r.skipped || false, testMode: r.testMode,
          sent: r.sent, validated: r.validated, eventsReceived: r.eventsReceived,
          candidates: r.candidates, error: r.error || null,
        })}`);
      }
    } catch (err) {
      logger.error(`Meta Conversions API upload failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 7:10AM ET — Meta Custom Audiences sync (suppression + retargeting).
  // Opt-in via META_AUDIENCES_CRON_ENABLED; no-ops unless configured + uploads
  // allowed. Reuses the conversion path's PII hashing; ships dark.
  // =========================================================================
  cron.schedule('10 7 * * *', async () => {
    if (process.env.META_AUDIENCES_CRON_ENABLED !== 'true') return;
    logger.info('Running: Meta Custom Audiences sync');
    try {
      const MetaAudiences = require('./ads/meta-audiences');
      const r = await MetaAudiences.syncAll({ validateOnly: false });
      // syncAll catches per-audience errors and returns them in the result, so surface
      // any at error level — otherwise an expired token / rejected upload fails silently.
      for (const [audience, res] of Object.entries(r)) {
        if (res && res.error) logger.error(`[meta-audiences cron] ${audience} failed: ${res.error}`);
      }
      logger.info(`[meta-audiences cron] ${JSON.stringify(r)}`);
    } catch (err) {
      logger.error(`Meta Custom Audiences sync failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 7:20AM ET — Google Customer Match sync (suppression + retargeting).
  // Opt-in via GOOGLE_CUSTOMER_MATCH_CRON_ENABLED; no-ops unless configured +
  // uploads allowed. Reuses the Data Manager service account + audience defs.
  // =========================================================================
  cron.schedule('20 7 * * *', async () => {
    if (process.env.GOOGLE_CUSTOMER_MATCH_CRON_ENABLED !== 'true') return;
    logger.info('Running: Google Customer Match sync');
    try {
      const GoogleCustomerMatch = require('./ads/google-customer-match');
      const r = await GoogleCustomerMatch.syncAll({ validateOnly: false });
      for (const [audience, res] of Object.entries(r)) {
        if (res && res.error) logger.error(`[google-customer-match cron] ${audience} failed: ${res.error}`);
      }
      logger.info(`[google-customer-match cron] ${JSON.stringify(r)}`);
    } catch (err) {
      logger.error(`Google Customer Match sync failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 6AM — Sync Google Search Console data (hub + all spoke domains)
  //
  // syncAllDomains walks NETWORK_DOMAINS in order (hub first) and catches
  // per-domain errors, so one bad spoke property never blocks the rest.
  // A hub failure is critical (wavespestcontrol.com is the primary site) and
  // triggers the seo_sync_failed notification; spoke failures are logged.
  // =========================================================================
  cron.schedule('0 6 * * *', async () => {
    logger.info('Running: GSC data sync (all domains)');
    try {
      const SearchConsole = require('./seo/search-console-v2');
      const results = await SearchConsole.syncAllDomains(3);
      const failed = results.filter(r => !r.synced);
      logger.info(`GSC sync: ${results.length - failed.length}/${results.length} domains synced`);
      const hubFailure = failed.find(r => r.domain === 'wavespestcontrol.com');
      if (failed.length) {
        logger.error(`GSC sync failures: ${failed.map(r => `${r.domain} (${r.error || 'unknown'})`).join('; ')}`);
      }
      if (hubFailure) {
        const { triggerNotification } = require('./notification-triggers');
        await triggerNotification('seo_sync_failed', { source: 'GSC', reason: `hub sync failed: ${hubFailure.error || 'unknown'}` });
      }
    } catch (err) {
      logger.error(`GSC sync failed: ${err.message}`);
      try {
        const { triggerNotification } = require('./notification-triggers');
        await triggerNotification('seo_sync_failed', { source: 'GSC', reason: err.message });
      } catch { /* notify best-effort */ }
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 6AM ET — Converted-estimate archive sweep, THEN estimate expiration
  // (Estimates v2 spec §5). One job, hard-ordered: the sweep must stamp
  // archived_at on converted customers' open estimates BEFORE expiration
  // scans, or an overnight age-out flips them to expired first and the sweep
  // (sent/viewed-only) can never reclaim them. If the sweep fails, expiration
  // is skipped this run — a one-day expiration delay is harmless (7-day
  // threshold), misclassifying a converted customer's estimate is permanent.
  // See estimate-conversion-guard.js for why the sweep never auto-flips
  // status to accepted.
  // =========================================================================
  cron.schedule('0 6 * * *', async () => {
    logger.info('Running: converted-customer estimate archive sweep');
    try {
      const { archiveConvertedOpenEstimates } = require('./estimate-conversion-guard');
      await archiveConvertedOpenEstimates();
    } catch (err) {
      logger.error(`Converted-estimate archive sweep failed — skipping estimate expiration status flips this run: ${err.message}`);
      // Skipping expiration must NOT skip the terminal-deposit refund sweep
      // that runs inside it — that sweep is the only daily self-healing path
      // for stranded deposit refunds, and an archive-sweep bug must never
      // block customer money. Run it directly instead.
      try {
        const { sweepTerminalEstimateDeposits } = require('./estimate-deposits');
        await sweepTerminalEstimateDeposits();
      } catch (e) {
        logger.error(`Terminal-estimate deposit sweep failed: ${e.message}`);
      }
      return;
    }
    logger.info('Running: Estimate expiration sweep');
    try {
      const { runEstimateExpiration } = require('./estimate-expiration');
      await runEstimateExpiration();
    } catch (err) {
      logger.error(`Estimate expiration sweep failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 6:35AM ET — Lead staleness sweep
  // Flips `new` leads to unresponsive after LEAD_STALENESS_DAYS (default 21)
  // with no activity, no future follow-up, and no booked service, so funnel
  // metrics stop counting dead leads as open pipeline. Env 0/empty disables.
  // =========================================================================
  cron.schedule('35 6 * * *', async () => {
    logger.info('Running: Lead staleness sweep');
    try {
      const { runLeadStalenessSweep } = require('./lead-staleness');
      await runLeadStalenessSweep();
    } catch (err) {
      logger.error(`Lead staleness sweep failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 6:10AM ET — Document request lifecycle
  // Marks expired e-sign document requests and sends due reminders for
  // requests that were already delivered through email/SMS.
  // =========================================================================
  cron.schedule('10 6 * * *', async () => {
    logger.info('Running: document request lifecycle');
    // ORDER IS LOAD-BEARING: expiration FIRST (the termite sweeps key off
    // 'expired' stamps), then the termite superseded reconciliation (which
    // cancels stale-version and misissued requests), and REMINDERS LAST —
    // a reminder processed before the superseded pass would email/text the
    // customer a signing nudge for the very request that pass is about to
    // cancel, pointing them at obsolete or residential-only wording.
    const { expireDocumentRequests, processDueDocumentReminders } = require('./document-contract-delivery');
    let expiredCount = 0;
    try {
      const expired = await expireDocumentRequests();
      expiredCount = expired?.expired || 0;
    } catch (err) {
      logger.error(`Document request expiration failed: ${err.message}`);
    }
    // Termite program agreement reconciliation: re-prep any recently accepted
    // termite estimate whose agreement draft failed transiently at accept
    // time (idempotent per-property dedupe; no repeat bells for unresolved
    // figures). Acceptance already committed — prep must be retryable.
    try {
      // Advisory-locked: overlapping instances (deploy overlap, multiple
      // dynos) would double-run the unlocked read-before-act sweeps and
      // duplicate bells/drafts.
      const { runExclusive } = require('../utils/cron-lock');
      await runExclusive('termite-agreement-reconcile', async () => {
        // Reconciliation failures must not take the unrelated document
        // reminders down with them — the ORDERING is required (reminders
        // after reconciliation), the coupling isn't. A reminder skipped by
        // a transient reconcile error could hit its schedule's end and
        // become permanently unsendable.
        try {
          const { reconcileSupersededProgramAgreements, reconcileTermiteProgramAgreements } = require('./termite-program-agreement');
          // Version-upgrade retirements first (any estimate age, bells on for
          // parked re-preps), then the standard recent-accepts sweep.
          const superseded = await reconcileSupersededProgramAgreements();
          if (superseded.checked) {
            logger.info(`Termite agreement superseded-reprep: ${superseded.checked} checked, ${superseded.created} created, ${superseded.failed} failed`);
          }
          const recon = await reconcileTermiteProgramAgreements();
          if (recon.created || recon.failed) {
            logger.info(`Termite agreement reconciliation: ${recon.checked} checked, ${recon.created} created, ${recon.failed} failed`);
          }
        } catch (err) {
          logger.error(`Termite agreement reconciliation failed: ${err.message}`);
        }
        // Reminders run INSIDE the same exclusive section, strictly after
        // reconciliation: on a skipped tick (another dyno holds the lock)
        // a non-holder must not nudge customers to sign requests the
        // holder is mid-cancelling. Reminder sends are sweep-style, so a
        // skipped tick's reminders go out with the holder's run or the
        // next tick.
        try {
          const reminders = await processDueDocumentReminders();
          logger.info(`Document workflow done: ${expiredCount} expired, ${reminders?.sent || 0} reminder(s) sent, ${reminders?.failed || 0} failed`);
        } catch (err) {
          logger.error(`Document request reminders failed: ${err.message}`);
        }
      });
    } catch (err) {
      logger.error(`Document lifecycle exclusive section failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 6AM ET — Credential expiry check (credentials v1 §7)
  // Scans business_credentials for anything expiring within 60 days; fires a
  // `credential_expiring_soon` notification per credential (deduped 7d).
  // =========================================================================
  cron.schedule('5 6 * * *', async () => {
    logger.info('Running: Credential expiry check');
    try {
      const { runCredentialExpiryCheck } = require('./credential-expiry-checker');
      await runCredentialExpiryCheck();
    } catch (err) {
      logger.error(`Credential expiry check failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 6:15AM ET — Sunbiz annual-report reminder + late-fee sweep.
  // Florida LLC annual reports open Jan 1 and are due May 1; filing late adds
  // a non-waivable $400 statutory fee. January ticks ring the admin bell once
  // per year (notifications-metadata dedupe; daily rather than Jan-1-only so
  // a New Year's deploy gap can't swallow the reminder) and self-heal the
  // Tax → Filing Calendar row. Ticks after May 1 bump the still-unfiled
  // row's amount_due by the $400 fee so /admin/tax shows the real payable.
  // runExclusive: read-then-act against notifications — a deploy overlap
  // must not double-ring.
  // =========================================================================
  cron.schedule('15 6 * * *', async () => {
    logger.info('Running: Sunbiz annual-report reminder');
    try {
      await runExclusive('sunbiz-annual-report-reminder', async () => {
        const { runSunbizAnnualReportReminder } = require('./sunbiz-annual-report-reminder');
        await runSunbizAnnualReportReminder();
      });
    } catch (err) {
      logger.error(`Sunbiz annual-report reminder failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 6:30AM — Sync Google Business Profile performance metrics
  // =========================================================================
  cron.schedule('30 6 * * *', async () => {
    logger.info('Running: GBP performance sync');
    try {
      const GoogleBusiness = require('./google-business');
      await GoogleBusiness.syncPerformanceDaily(3);
    } catch (err) {
      logger.error(`GBP performance sync failed: ${err.message}`);
      try {
        const { triggerNotification } = require('./notification-triggers');
        await triggerNotification('seo_sync_failed', { source: 'GBP', reason: err.message });
      } catch { /* notify best-effort */ }
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // HOURLY — Sync Google review content from Places API
  // GBP performance sync (above) handles impressions / views, NOT review
  // text. Without this hourly sync, the google_reviews table only ever
  // contained the aggregate `_stats` rows seeded by syncAllReviews on
  // first run, so the Reviews tab kept saying "0 reviews" while the GBP
  // total counter climbed each time someone left feedback. The route
  // handler at POST /api/admin/reviews/sync still exists for manual
  // re-pulls — this just makes "Sync Reviews" no longer the only way
  // for reviews to appear in the portal.
  // =========================================================================
  cron.schedule('0 * * * *', async () => {
    logger.info('Running: Google review content sync');
    try {
      const GoogleBusiness = require('./google-business');
      const result = await GoogleBusiness.syncAllReviews();
      logger.info(`Review sync done: ${result.synced || 0} synced, ${result.new || 0} new`);
    } catch (err) {
      logger.error(`Review sync failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 8AM — AI Campaign Advisor (includes paid + organic)
  // =========================================================================
  cron.schedule('0 8 * * *', async () => {
    logger.info('Running: AI campaign advisor');
    try {
      const CampaignAdvisor = require('./ads/campaign-advisor');
      await CampaignAdvisor.generateDailyAdvice();
    } catch (err) {
      logger.error(`AI campaign advisor failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // WEEKLY MONDAY 7AM — SEO Advisor (deep GSC + GBP analysis)
  // =========================================================================
  cron.schedule('0 7 * * 1', async () => {
    logger.info('Running: Weekly SEO Advisor');
    try {
      const SEOAdvisor = require('./seo/seo-advisor');
      await SEOAdvisor.generateWeeklyReport();
    } catch (err) {
      logger.error(`SEO Advisor failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 7AM — Token / Credential Health Check + SMS alert on failures
  // =========================================================================
  cron.schedule('0 7 * * *', async () => {
    logger.info('Running: token credential health check');
    try {
      const tokenHealth = require('./token-health');
      const results = await tokenHealth.checkAll();
      const failures = results.filter(r => r.status === 'expired' || r.status === 'error');
      if (failures.length > 0) {
        const msg = `⚠️ Token Alert: ${failures.length} credential(s) need attention:\n` +
          failures.map(f => `- ${f.platform}: ${f.status} — ${f.lastError || 'check dashboard'}`).join('\n');
        await TwilioService.sendSMS(process.env.ADAM_PHONE || '+19415993489', msg, { messageType: 'internal_alert', skipLogo: true });
      }
      logger.info(`Token health check done: ${failures.length} failure(s) out of ${results.length}`);
    } catch (err) {
      logger.error(`Token health check failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 3:30AM — Auto-sync Knowledge Base from live data (products, protocols, pricing, COGS)
  // =========================================================================
  cron.schedule('30 3 * * *', async () => {
    logger.info('Running: Knowledge Base auto-sync');
    try {
      const KBService = require('./knowledge-base');
      const result = await KBService.autoSync();
      logger.info(`KB auto-sync done: ${result.created} created, ${result.updated} updated, ${result.skipped} unchanged`);
    } catch (err) {
      logger.error(`KB auto-sync failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // WEEKLY FRIDAY 7 AM — AI Knowledge Base Audit ("Question Your Assumptions")
  // Reviews stale and low-confidence entries via Claude, flags anything outdated.
  // =========================================================================
  cron.schedule('0 7 * * 5', async () => {
    logger.info('Running: Knowledge Base AI audit');
    try {
      const KBService = require('./knowledge-base');
      const result = await KBService.runAIAudit({ maxEntries: 15 });
      logger.info(`KB AI audit done: ${result.audited} reviewed, ${result.flagged} flagged`);

      // Admin notification summary if anything was flagged.
      if (result.flagged > 0) {
        try {
          const flaggedEntries = result.results
            .filter(r => r.status === 'flag' || r.status === 'update-needed')
            .map(r => ({ id: r.id, title: r.title, summary: r.summary, status: r.status }));
          const { triggerNotification } = require('./notification-triggers');
          await triggerNotification('kb_audit_flagged', {
            count: result.flagged,
            audited: result.audited,
            entries: flaggedEntries,
          });
        } catch (err) {
          logger.error(`KB AI audit notification failed: ${err.message}`);
        }
      }
    } catch (err) {
      logger.error(`KB AI audit failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 5 MIN — Process any pending call recordings
  // =========================================================================
  cron.schedule('*/5 * * * *', async () => {
    try {
      const processor = require('./call-recording-processor');
      if (processor.recoverMissingRecentRecordings) await processor.recoverMissingRecentRecordings();
      if (processor.processAllPending) await processor.processAllPending();
    } catch (e) { logger.error(`Recording batch process failed: ${e.message}`); }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // NIGHTLY 3:40 AM ET — Call-pipeline self-audit (zero-triage drift loop).
  // Samples ~25 recent calls, DEEP-tier re-read, drift metrics to
  // call_audit_findings; admin alert ONLY on threshold breach. Gated
  // GATE_CALL_SELF_AUDIT (checked inside the service). Silence = healthy.
  // =========================================================================
  cron.schedule('40 3 * * *', async () => {
    await runExclusive('call-self-audit', async () => {
      try {
        const { runSelfAudit } = require('./call-self-audit');
        const result = await runSelfAudit();
        if (!result.skipped) logger.info(`[self-audit] nightly run: ${JSON.stringify({ audited: result.audited, breaches: result.breaches })}`);
      } catch (e) { logger.error(`Call self-audit failed: ${e.message}`); }
    });
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 15 MIN — Send scheduled review request SMS
  // Picks up review requests whose scheduled_for has passed.
  // =========================================================================
  cron.schedule('*/15 * * * *', async () => {
    try {
      await runExclusive('review-requests-scheduled', async () => {
        const ReviewService = require('./review-request');
        const result = await ReviewService.processScheduled();
        if (result.sent > 0) logger.info(`Review requests processed: ${result.sent} sent`);
      });
    } catch (err) {
      logger.error(`Review request processing failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 10:03AM — Review follow-up reminders (Day 3 after initial request)
  // Lands the followup on the 3rd ET-calendar-day after the original review
  // SMS was sent. Eligibility logic is in processFollowups().
  // =========================================================================
  cron.schedule('3 10 * * *', async () => {
    logger.info('Running: review follow-up reminders');
    try {
      await runExclusive('review-followups', async () => {
        const ReviewService = require('./review-request');
        const result = await ReviewService.processFollowups();
        logger.info(`Review follow-ups done: ${result.sent} sent`);
      });
    } catch (err) {
      logger.error(`Review follow-up failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 30 MIN — Multi-touch review cadence driver (Day 0/3/4 SMS+email).
  // Advances operator-started review_sequences whose next_run_at has passed,
  // auto-stopping on review/opt-out. Dark behind GATE_REVIEW_SEQUENCES so a
  // preview/dev env with live creds can't text/email real customers.
  // Suppression and per-customer prefs still apply at the send site.
  // =========================================================================
  cron.schedule('*/30 * * * *', async () => {
    if (!isEnabled('reviewSequences')) return;
    try {
      await runExclusive('review-sequences', async () => {
        const ReviewService = require('./review-request');
        const result = await ReviewService.processReviewSequences();
        if (result.sent > 0 || result.completed > 0) {
          logger.info(`Review sequences: ${result.sent} sent, ${result.completed} completed, ${result.stopped} stopped`);
        }
      });
    } catch (err) {
      logger.error(`Review sequence processing failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 6:10AM — Agronomic Wiki refresh (stale pages + seasonal), weekly
  // cadence enforced by weeklyRefreshIfDue's "ran in the last 6 days" guard,
  // then the trusted wiki→KB sync chained after it (own weekly guard).
  // The former single Sunday-6AM fire time missed whole weeks whenever the
  // process wasn't up at that exact minute (update-log lint rows show 3 runs
  // in 3 months); a daily check self-heals after any missed fire.
  // =========================================================================
  cron.schedule('10 6 * * *', async () => {
    let refreshFailed = false;
    try {
      const wiki = require('./agronomic-wiki');
      // runExclusive: the 6-day update-log guard inside weeklyRefreshIfDue is
      // check-then-act, not atomic — during a rolling deploy two instances can
      // both pass it and double-run the refresh. Same hazard the digest leg
      // already locks against; a lease_held skip means another instance owns
      // this tick's whole chain, so bail out of legs 2-3 too.
      // weeklyRefreshIfDue swallows failures into { error } — rethrow inside
      // the lock so job_health records the failure instead of a false success.
      const result = await runExclusive('wiki-weekly-refresh', async () => {
        const r = await wiki.weeklyRefreshIfDue();
        if (r?.error) {
          throw Object.assign(new Error(`wiki refresh failed: ${r.error}`), { result: r });
        }
        return r;
      });
      if (result?.reason === 'lease_held' || result?.reason === 'no_connection') return;
      if (!result.skipped) {
        logger.info(`Agronomic wiki refresh done: ${result.refreshed} pages refreshed`);
      }
    } catch (err) {
      refreshFailed = true;
      logger.error(`Agronomic wiki refresh failed: ${err.message}`);
    }

    // Trusted wiki→Knowledge Base sync, CHAINED strictly after the refresh
    // (weekly cadence via syncToClaudeopediaIfDue's own guard; invoked daily
    // so an error day self-heals tomorrow). A fixed-offset cron could fire
    // mid-refresh and write its weekly marker before the freshly refreshed
    // rows exist — missing them until the guard expires. A FAILED refresh
    // skips the sync entirely: syncing now would stamp the weekly kb_sync
    // marker, and tomorrow's successful refresh retry would find its fresh
    // rows locked out of the KB by that marker. Refresh-skip days still
    // sync (the refresh is done for the week; the sync self-heals its own
    // misses). Only trusted pages (review_status auto/approved) cross —
    // the exception-based review gate controls what feeds agents.
    if (refreshFailed) {
      logger.warn('Wiki→KB sync skipped: wiki refresh failed — both retry tomorrow');
      return;
    }
    try {
      const KnowledgeBridge = require('./knowledge-bridge');
      // A sync that finished with per-entry errors must not record a healthy
      // job_health row — rethrow inside the lock (partial progress is already
      // persisted; the weekly marker semantics are unchanged by the throw).
      const result = await runExclusive('wiki-kb-sync', async () => {
        const r = await KnowledgeBridge.syncToClaudeopediaIfDue();
        if (r?.errors > 0) {
          throw Object.assign(new Error(`wiki→KB sync completed with ${r.errors} error(s): ${r.created} created, ${r.updated} updated`), { result: r });
        }
        return r;
      });
      if (!result.skipped) {
        logger.info(`Wiki→KB trusted sync done: ${result.created} created, ${result.updated} updated, ${result.errors} errors`);
      }
    } catch (err) {
      logger.error(`Wiki→KB sync failed: ${err.message}`);
    }

    // Yellow-digest email to the owner, CHAINED as leg 3 for the same reason
    // the sync is leg 2: a fixed-offset cron could fire mid-refresh, digest
    // the pre-refresh queue, and stamp its weekly marker — suppressing a
    // corrected digest for six days. Weekly cadence + the dark-ship gate live
    // inside sendYellowDigestIfDue; the failed-refresh early-return above
    // already keeps it off stale-state days. Runs even if the KB sync leg
    // errored — the digest reports review state, which the sync doesn't change.
    try {
      const YellowDigest = require('./wiki-yellow-digest');
      const result = await YellowDigest.sendYellowDigestIfDue();
      if (result.sent) {
        logger.info(`Wiki yellow digest sent: ${result.pendingCount} blocked, ${result.yellowCount} yellow`);
      }
    } catch (err) {
      logger.error(`Wiki yellow digest failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // HOURLY :40 — Treatment-outcome weather enrichment retry sweep. The
  // confirm-time enrichment (linkTreatmentOutcome → backfillOutcomeWeather)
  // is fire-and-forget and each service record links exactly once, so a
  // transient FAWN/update failure on the first attempt would otherwise leave
  // the outcome's weather columns null forever. The sweep re-runs the
  // backfill for same-day all-null rows; its same-day/≤6h freshness gates
  // fail closed, so late rows age out rather than getting wrong-day
  // conditions stamped. Hourly because the window is the treatment day
  // itself — a daily fire would miss most of it.
  // =========================================================================
  cron.schedule('40 * * * *', async () => {
    try {
      const wiki = require('./agronomic-wiki');
      // runExclusive: overlapping deploy instances must not double-fetch
      // FAWN; a sweep that itself errored must reach job_health, not log a
      // healthy run — rethrow inside the lock (same idiom as the wiki legs).
      const result = await runExclusive('wiki-weather-backfill-sweep', async () => {
        const r = await wiki.sweepMissingOutcomeWeather();
        if (r?.error) {
          throw Object.assign(new Error(`weather backfill sweep failed: ${r.error}`), { result: r });
        }
        return r;
      });
      if (result?.reason === 'lease_held' || result?.reason === 'no_connection') return;
      if (result?.enriched > 0) {
        logger.info(`Treatment-outcome weather sweep: ${result.enriched}/${result.checked} enriched`);
      }
    } catch (err) {
      logger.error(`Treatment-outcome weather sweep failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // Health scoring runs inside the 3AM Customer Intelligence Pipeline (above)
  // as its sole nightly invocation — the former standalone 2:15AM job was
  // removed so signals are detected before the score is computed.

  // =========================================================================
  // WEEKLY SUNDAY 4AM — Cleanup health history older than 365 days
  // =========================================================================
  cron.schedule('0 4 * * 0', async () => {
    logger.info('Running: health history cleanup');
    try {
      const cutoff = etDateString(addETDays(new Date(), -365));
      const deleted = await db('customer_health_history').where('scored_at', '<', cutoff).del();
      logger.info(`Health history cleanup: ${deleted} old records deleted`);
    } catch (err) {
      logger.error(`Health history cleanup failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // TIME TRACKING CRONS (daily summaries, weekly summaries, auto clock-out)
  // =========================================================================
  try {
    const { initTimeTrackingCrons } = require('./time-tracking-crons');
    initTimeTrackingCrons();
    logger.info('Time tracking crons initialized');
  } catch (err) {
    logger.error(`Time tracking crons failed to init: ${err.message}`);
  }

  // =========================================================================
  // EQUIPMENT MAINTENANCE CRONS (nightly checks, warranty alerts)
  // =========================================================================
  try {
    const { initEquipmentCrons } = require('./equipment-crons');
    initEquipmentCrons();
    logger.info('Equipment maintenance crons initialized');
  } catch (err) {
    logger.error(`Equipment crons failed to init: ${err.message}`);
  }

  // =========================================================================
  // STRIPE BILLING — Monthly autopay + payment retries
  //
  // Runs DAILY at 8 AM ET. processMonthlyBilling() walks every active
  // autopay customer and skips those whose billing_day !== today, so the
  // per-customer `billing_day` (1–28) the AutopayCard exposes actually
  // fires on the day the customer picked. Previously this cron ran only
  // on the 1st, which meant any customer with billing_day !== 1 was
  // never charged at all — silent revenue loss. The idempotency guard
  // (existingCharge query in billing-cron.js) keeps the daily cadence
  // safe against re-running on the same calendar day.
  // =========================================================================
  cron.schedule('0 8 * * *', async () => {
    logger.info('Running: monthly billing (Stripe)');
    try {
      // Belt over the idempotency keys: serializes the whole sweep so
      // overlapping deploy instances don't even race the per-customer
      // existingCharge check.
      await runExclusive('billing-monthly', async () => {
        const BillingCron = require('./billing-cron');
        const result = await BillingCron.processMonthlyBilling();
        logger.info(`Monthly billing done: ${result.charged} charged, ${result.failed} failed, ${result.skipped} skipped`);
      });
    } catch (err) {
      logger.error(`Monthly billing failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  cron.schedule('7 10 * * *', async () => {
    try {
      await runExclusive('billing-retries', async () => {
        const BillingCron = require('./billing-cron');
        const result = await BillingCron.processPaymentRetries();
        if (result.retried > 0) logger.info(`Payment retries: ${result.retried} retried, ${result.succeeded} succeeded`);
      });
    } catch (err) {
      logger.error(`Payment retry failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // Stranded prepay auto-charge recovery every 15 min (Codex #3492 r12):
  // an accept can crash between commit and its in-flow charge, and
  // same-day slots book with a two-hour lead — a job stranded just after
  // the daily 10:07 retry cron must not wait a full day for its charge or
  // pay link (a serviced-unpaid visit is the exact incident this lane
  // exists to prevent). Idempotent + advisory-locked inside the service;
  // no-op while the gate is off beyond draining committed jobs.
  cron.schedule('*/15 * * * *', async () => {
    try {
      await runExclusive('prepay-charge-recovery', async () => {
        await require('./recurring-card-on-file').sweepStrandedPrepayAutoCharges();
      });
    } catch (err) {
      logger.error(`Stranded prepay auto-charge sweep failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // Autopay pre-charge reminders — daily 9 AM, 3 days before scheduled charge
  cron.schedule('0 9 * * *', async () => {
    try {
      await runExclusive('autopay-pre-charge-reminders', async () => {
        const { sendPreChargeReminders } = require('./autopay-notifications');
        const r = await sendPreChargeReminders();
        if (r.sent > 0) logger.info(`Autopay reminders: ${r.sent} sent`);
      });
    } catch (err) {
      logger.error(`Autopay pre-charge reminder failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // Card-expiry warnings — Monday 9 AM, cards expiring within 60 days
  cron.schedule('0 9 * * 1', async () => {
    try {
      await runExclusive('card-expiry-warnings', async () => {
        const { sendCardExpiryWarnings } = require('./autopay-notifications');
        const r = await sendCardExpiryWarnings();
        if (r.sent > 0) logger.info(`Card-expiry warnings: ${r.sent} sent`);
      });
    } catch (err) {
      logger.error(`Card-expiry warnings failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // BOUNCIE MILEAGE CRONS (daily sync, monthly summary, trip re-matching)
  // =========================================================================
  try {
    const { initBouncieMileageCrons } = require('./bouncie-mileage-crons');
    initBouncieMileageCrons();
    logger.info('Bouncie mileage crons initialized');
  } catch (err) {
    logger.error(`Bouncie mileage crons failed to init: ${err.message}`);
  }

  // =========================================================================
  // DAILY 9AM — Payment expiry check (cards expiring this/next month)
  // =========================================================================
  cron.schedule('0 9 * * *', async () => {
    logger.info('Running: payment expiry check');
    try {
      await runExclusive('payment-expiry-check', async () => {
        const paymentExpiry = require('./workflows/payment-expiry');
        if (paymentExpiry.checkExpiringCards) {
          const result = await paymentExpiry.checkExpiringCards();
          logger.info(`Payment expiry check done: ${result.notified} notified, ${result.totalExpiring} expiring`);
        }
      });
    } catch (err) {
      logger.error(`Payment expiry check failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 6PM — Missed appointment check
  // =========================================================================
  cron.schedule('0 18 * * *', async () => {
    logger.info('Running: missed appointment check');
    try {
      // The reschedule_log dedupe below is check-then-insert — overlapping
      // deploy instances would both pass it and double-count a no-show.
      await runExclusive('missed-appointment-check', async () => {
      const missedAppointment = require('./workflows/missed-appointment');
      if (missedAppointment.onSkip) {
        // Find recent services that were scheduled but not completed.
        // In-progress statuses (en_route / on_site) are intentionally
        // excluded along with completed/cancelled/skipped/rescheduled —
        // a tech actively on the job is not a no-show. The range reaches
        // back to yesterday so evening windows that hadn't elapsed at
        // yesterday's 6 PM sweep — and genuinely closed as no-shows —
        // are picked up today instead of never counting.
        const today = etDateString();
        const yesterday = etDateString(addETDays(new Date(), -1));
        const candidates = await db('scheduled_services')
          .whereBetween('scheduled_date', [yesterday, today])
          .whereIn('status', ['pending', 'confirmed'])
          .select('id', 'scheduled_date', 'window_start', 'window_end');

        // Only flag services whose arrival window has already elapsed at
        // sweep time. Evening jobs (e.g. a 6–8 PM window that completes at
        // 6:30 PM) are still legitimately pending at the 6 PM sweep and
        // must not accrue customer_noshow rows in reschedule_log — two of
        // those in 90 days trigger a false "we've missed you" outreach
        // task (see workflows/missed-appointment.js onSkip).
        const { hour, minute } = etParts();
        const nowET = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
        const windowHasPassed = (svc) => {
          // Yesterday's windows have all elapsed by today's sweep.
          const svcDate = svc.scheduled_date instanceof Date
            ? svc.scheduled_date.toISOString().split('T')[0]
            : String(svc.scheduled_date).split('T')[0];
          if (svcDate < today) return true;
          // window_start/window_end are TIME columns ('HH:MM:SS' strings).
          const cutoff = svc.window_end || svc.window_start;
          if (!cutoff) return true; // no window recorded — legacy behavior
          return String(cutoff).slice(0, 5) <= nowET;
        };

        let flagged = 0;
        for (const svc of candidates) {
          if (!windowHasPassed(svc)) continue;
          // onSkip inserts a reschedule_log row unconditionally — with the
          // sweep spanning two days, a service yesterday's pass already
          // flagged must not be re-flagged toward the
          // 2-noshows-in-90-days outreach trigger. Occurrence-aware: a soft
          // Quick Move no-show recorded an EARLIER slot of this same row
          // (original_date + original_window = that missed slot) and must
          // not suppress flagging a genuine later miss — including a rebook
          // later the SAME day, which only the window distinguishes (codex
          // r2). NULL slot fields match legacy rows to keep their old
          // per-row dedup.
          const missedDateStr = svc.scheduled_date
            ? String(svc.scheduled_date instanceof Date ? svc.scheduled_date.toISOString() : svc.scheduled_date).slice(0, 10)
            : null;
          const missedWindowStr = svc.window_start ? `${svc.window_start}-${svc.window_end}` : null;
          const alreadyFlagged = await db('reschedule_log')
            .where({ scheduled_service_id: svc.id, reason_code: 'customer_noshow' })
            .where(function occurrenceMatch() {
              if (!missedDateStr) return; // no slot info — legacy per-row dedup
              this.whereNull('original_date').orWhere(function currentSlot() {
                this.where('original_date', missedDateStr);
                if (missedWindowStr) {
                  this.andWhere(function sameWindow() {
                    this.where('original_window', missedWindowStr).orWhereNull('original_window');
                  });
                }
              });
            })
            .first('id');
          if (alreadyFlagged) continue;
          try {
            await missedAppointment.onSkip(svc.id, 'no_show');
            flagged++;
          } catch (skipErr) {
            logger.error(`Missed appointment onSkip failed for ${svc.id}: ${skipErr.message}`);
          }
        }
        logger.info(`Missed appointment check done: ${candidates.length} candidate(s), ${flagged} flagged as no-show`);
      }
      });
    } catch (err) {
      logger.error(`Missed appointment check failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 6:40PM — Stale-visit sweep (past-dated open appointments)
  // =========================================================================
  // Runs after the 6PM missed-appointment check on purpose: that check only
  // covers a yesterday→today window of pending/confirmed rows, so anything
  // older accumulates silently (250 open past-dated rows in the July 2026
  // audit). Detection only — one deduped admin bell, never a row mutation.
  // Gated (GATE_STALE_VISIT_SWEEP) and cross-replica serialized inside the
  // sweep itself, like the WDO attention sweep.
  cron.schedule('40 18 * * *', async () => {
    logger.info('Running: stale-visit sweep');
    try {
      const { runStaleVisitSweep } = require('./stale-visit-sweep');
      const result = await runStaleVisitSweep();
      if (result?.rang) {
        logger.info(`Stale-visit sweep rang: ${result.items} open past-dated visit(s)`);
      }
    } catch (err) {
      logger.error(`Stale-visit sweep failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 10:12AM — Renewal reminders (termite bond ONLY — owner ruling
  // 2026-07-13: no-term services never get "renewal" language) + the
  // annual-prepay payment reminders/sweeps that ride the same run.
  // =========================================================================
  cron.schedule('12 10 * * *', async () => {
    logger.info('Running: renewal reminders');
    try {
      await runExclusive('renewal-reminders', async () => {
        const renewalReminder = require('./workflows/renewal-reminder');
        if (renewalReminder.checkAndSend) {
          const result = await renewalReminder.checkAndSend();
          logger.info(`Renewal reminders done: ${result.sent} sent`);
        }
      });
    } catch (err) {
      logger.error(`Renewal reminders failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // WEEKLY MONDAY 10AM — Seasonal reactivation campaign (drafts V1)
  // =========================================================================
  // NEVER sends. Writes message_drafts status='pending' rows for owner
  // approval when GATE_CAMPAIGN_DRAFTS is on; gate off = shadow-log candidate
  // counts only. Sending happens exclusively through the drafts approve route.
  cron.schedule('20 10 * * 1', async () => {
    logger.info('Running: seasonal reactivation campaign');
    try {
      await runExclusive('seasonal-reactivation', async () => {
        const seasonalReactivation = require('./workflows/seasonal-reactivation');
        if (seasonalReactivation.run) {
          const result = await seasonalReactivation.run();
          logger.info(`Seasonal reactivation done: ${result.candidates} candidate(s), ${result.drafted} draft(s), gate ${result.gate} (month ${result.month}, type: ${result.hookType})`);
        }
      });
    } catch (err) {
      logger.error(`Seasonal reactivation failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 9:30AM — Existing-customer upsell campaign drafts (V1)
  // =========================================================================
  // NEVER sends. Reads upsell_opportunities status='identified', applies the
  // guards (live customer, prefs, unified 30d cross-lane cooldown, prepay
  // notice suppression) and writes message_drafts status='pending' rows for
  // owner approval when GATE_CAMPAIGN_DRAFTS is on; gate off = shadow-log
  // candidate counts only. Sending happens exclusively through the drafts
  // approve route.
  cron.schedule('30 9 * * *', async () => {
    logger.info('Running: upsell campaign draft generator');
    try {
      await runExclusive('campaign-drafts-upsell', async () => {
        const campaignDrafts = require('./campaign-drafts');
        const result = await campaignDrafts.generateUpsellDrafts();
        logger.info(`Upsell campaign drafts done: ${result.candidates} candidate(s), ${result.drafted} draft(s), gate ${result.gate}`);
      });
    } catch (err) {
      logger.error(`Upsell campaign draft generator failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 11AM — Balance reminders (upcoming services with outstanding balance)
  // =========================================================================
  cron.schedule('0 11 * * *', async () => {
    logger.info('Running: balance reminders');
    try {
      await runExclusive('balance-reminders', async () => {
        const balanceReminder = require('./workflows/balance-reminder');
        if (balanceReminder.dailyCheck) {
          await balanceReminder.dailyCheck();
        }
        if (balanceReminder.latePaymentCheck) {
          await balanceReminder.latePaymentCheck();
        }
      });
    } catch (err) {
      logger.error(`Balance reminders failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // GA4 ANALYTICS CRONS (daily sync)
  // =========================================================================
  try {
    const { initGA4Crons } = require('./analytics/ga4-crons');
    initGA4Crons();
    logger.info('GA4 analytics crons initialized');
  } catch (err) {
    logger.error(`GA4 crons failed to init: ${err.message}`);
  }

  // DAILY 1AM — Terminal handoff tokens cleanup
  //
  // Rows expire after 60s of mint. The 1-hour post-expiry buffer is
  // intentional: if a tech reports "the charge didn't go through" within the
  // next hour, support can still inspect whether the token was minted /
  // validated / never used. Anything beyond 1h is forensics we'd read from
  // audit_log anyway.
  //
  // Multi-instance safety: DELETE is idempotent — concurrent runs on
  // Railway replicas just race and one wins. If we ever add a non-idempotent
  // daily job, introduce a cron_leases table with SELECT ... FOR UPDATE
  // SKIP LOCKED first. Don't copy this pattern blindly.
  cron.schedule('0 1 * * *', async () => {
    const started = Date.now();
    try {
      const deleted = await db('terminal_handoff_tokens')
        .where('expires_at', '<', db.raw("NOW() - INTERVAL '1 hour'"))
        .del();
      logger.info(`[terminal-cleanup] ok — deleted ${deleted} expired handoff token(s) in ${Date.now() - started}ms`);
    } catch (err) {
      logger.error(`[terminal-cleanup] failed after ${Date.now() - started}ms: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // EVERY 5 MIN — Orphaned-validated handoff sweeper
  //
  // Targets rows where /validate-handoff burned the jti but /payment-intent
  // was never called (tech's iOS app crashed post-validate, user backed out
  // of the charge screen, network dropped between apps, etc.). 15-minute
  // threshold is deliberately longer than a realistic Tap to Pay flow
  // (20-60s of tech-customer interaction + charge) but short enough that
  // these rows don't accumulate and silently chew the per-tech rate-limit
  // budget.
  //
  // The partial index terminal_handoff_tokens_orphaned_validated_idx covers
  // exactly this WHERE clause — it's a direct index scan, not a table scan.
  // Cheap enough to run every 5 minutes on Railway's shared Postgres.
  //
  // Note: the daily 1AM cleanup above catches these rows eventually (via
  // expires_at), but only after 1h of post-expiry buffer. The 5-min sweeper
  // is specifically for the rate-limit-budget case.
  cron.schedule('*/5 * * * *', async () => {
    const started = Date.now();
    try {
      const deleted = await db('terminal_handoff_tokens')
        .whereNotNull('used_at')
        .whereNull('stripe_payment_intent_id')
        .where('used_at', '<', db.raw("NOW() - INTERVAL '15 minutes'"))
        .del();
      if (deleted > 0) {
        logger.info(`[terminal-sweeper] ok — deleted ${deleted} orphaned-validated handoff(s) in ${Date.now() - started}ms`);
      }
    } catch (err) {
      logger.error(`[terminal-sweeper] failed after ${Date.now() - started}ms: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // EVERY 5 MIN — Tech-late detector (first dispatch alert generator)
  //
  // Reads scheduled_services for jobs whose ET promised arrival due
  // time (at least window_start + 2 hours, or later window_end) has
  // passed by ≥ 30 min while the tech hasn't moved to on_site /
  // completed / cancelled / skipped, and inserts a tech_late
  // dispatch_alert via
  // createAlert (which fans out the dispatch:alert socket broadcast
  // post-commit so the Action Queue right pane updates in real time).
  //
  // Idempotent: skips jobs that already have an unresolved tech_late
  // alert. After the dispatcher resolves a warn, the next tick fires
  // a fresh critical if the job is still late — natural escalation
  // without in-place row mutation.
  cron.schedule('*/5 * * * *', async () => {
    try {
      const { runTechLateCheck } = require('./tech-late-detector');
      await runTechLateCheck();
    } catch (err) {
      logger.error(`[tech-late-detector] tick failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // EVERY 5 MIN — Unassigned-overdue detector (second alert generator)
  //
  // Same shape as tech-late-detector but scopes to jobs with
  // technician_id IS NULL. Fires unassigned_overdue alerts when an
  // unassigned job's promised arrival due time (at least window_start
  // + 2 hours, or later window_end) has passed by ≥ 30 min and the
  // job is still pre-terminal. Severity bands: 30–59 → warn, ≥ 60 →
  // critical. Partial unique index closes the cross-process race
  // (migration 20260427000003).
  cron.schedule('*/5 * * * *', async () => {
    try {
      const { runUnassignedOverdueCheck } = require('./unassigned-overdue-detector');
      await runUnassignedOverdueCheck();
    } catch (err) {
      logger.error(`[unassigned-overdue-detector] tick failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // Call-ingest completeness watchdog — every 30 min, diff Twilio's own call
  // ledger against call_log and ring an admin bell for any answered inbound
  // call the pipeline never received (webhook outage / misrouted number).
  // Born from the 2026-07 reconciliation that found 391 Feb–Mar calls (and
  // 11 later stragglers, incl. real booked jobs) silently never ingested.
  // Dark behind GATE_CALL_INGEST_WATCHDOG; read-only against Twilio.
  // See server/services/call-ingest-watchdog.js.
  // =========================================================================
  cron.schedule('7,37 * * * *', async () => {
    try {
      const { runCallIngestWatchdog } = require('./call-ingest-watchdog');
      const result = await runCallIngestWatchdog();
      if (!result.skipped && (result.missed > 0 || result.alerted > 0)) {
        logger.warn(`[call-ingest-watchdog] scanned=${result.scanned} missed=${result.missed} alerted=${result.alerted}${result.aggregate ? ' (aggregate)' : ''}`);
      }
    } catch (err) {
      logger.error(`Call-ingest watchdog tick failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // Call booking-miss watchdog — every 30 min (offset from the ingest
  // watchdog), ring an admin bell for any call whose V2 extraction confirmed
  // a concrete appointment slot that never became a scheduled_services row
  // (outbound skip / v2 routing block / missing fields all park silently in
  // triage otherwise). Dark behind GATE_CALL_BOOKING_MISS_WATCHDOG.
  // See server/services/call-booking-miss-watchdog.js.
  // =========================================================================
  cron.schedule('22,52 * * * *', async () => {
    try {
      const { runCallBookingMissWatchdog } = require('./call-booking-miss-watchdog');
      const result = await runCallBookingMissWatchdog();
      if (!result.skipped && (result.misses > 0 || result.alerted > 0)) {
        logger.warn(`[call-booking-miss] scanned=${result.scanned} misses=${result.misses} alerted=${result.alerted}`);
      }
    } catch (err) {
      logger.error(`Call booking-miss watchdog tick failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 6:40 AM ET — Schedule-integrity watchdog. Pages three silent-loss
  // classes: past-dated visits stuck in on_site/en_route (performed but
  // never completed → no service record / invoice / report / SMS), upcoming
  // recurring series with no price on any row, and recurring-lawn customers
  // invisible to the Monday irrigation email. 6:40, NOT later (Codex #3209
  // post-merge P2): the Monday irrigation send fires at 7:00 ET, so a
  // lawn-email gap alert after that is unactionable for the very send it
  // warns about — this tick must precede it. Still before the day's route
  // starts, so a price gap rings first. Dark behind
  // GATE_SCHEDULE_INTEGRITY_WATCHDOG. See
  // server/services/schedule-integrity-watchdog.js.
  // =========================================================================
  cron.schedule('40 6 * * *', async () => {
    try {
      const { runScheduleIntegrityWatchdog } = require('./schedule-integrity-watchdog');
      const result = await runScheduleIntegrityWatchdog();
      if (!result.skipped && (result.stale > 0 || result.unpricedSeries > 0 || result.lawnEmailGaps > 0 || result.lawnGapCheckFailed)) {
        logger.warn(`[schedule-integrity] stale=${result.stale} unpricedSeries=${result.unpricedSeries} lawnEmailGaps=${result.lawnEmailGaps}${result.lawnGapCheckFailed ? ' LAWN-GAP-CHECK-FAILED' : ''} alerted=${result.alerted}`);
      }
    } catch (err) {
      logger.error(`Schedule-integrity watchdog tick failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // HOURLY :46 — Retroactive call_log→customer linking. Heals calls that
  // arrived before their customer record existed (unambiguous primary-phone
  // match only, same rule as webhook intake; idempotent). Dark behind
  // GATE_CALL_LOG_RELINK. See server/services/call-log-relink.js.
  // =========================================================================
  cron.schedule('46 * * * *', async () => {
    try {
      const { runCallLogRelink } = require('./call-log-relink');
      const result = await runCallLogRelink();
      if (!result.skipped && result.linked > 0) {
        logger.info(`[call-relink] scanned=${result.scanned} linked=${result.linked} ambiguousOrUnmatched=${result.ambiguousOrUnmatched}`);
      }
    } catch (err) {
      logger.error(`Call-log relink tick failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // NIGHTLY 3:20 AM — Triage dead-letter drain. Auto-resolves provably-moot
  // open triage cards and auto-dismisses aged informational flags so the
  // triage inbox stays an exception queue instead of a landfill (~1,800
  // open vs 32 resolved when built). Owed-work cards never touched. Dark
  // behind GATE_TRIAGE_AUTO_RESOLVE. See server/services/triage-auto-resolve.js.
  // =========================================================================
  cron.schedule('20 3 * * *', async () => {
    try {
      const { runTriageAutoResolve } = require('./triage-auto-resolve');
      const result = await runTriageAutoResolve();
      if (!result.skipped && result.applied > 0) {
        logger.info(`[triage-sweep] applied=${result.applied} deferred=${result.deferred} rules=${JSON.stringify(result.counts)}`);
      }
    } catch (err) {
      logger.error(`Triage auto-resolve tick failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  logger.info('Scheduled jobs initialized');
}

// Banking sync is a passive Stripe→DB mirror with no customer-facing side
// effects (webhooks already handle real-time updates; this is the catch-up
// safety net). It runs UNGATED so missed payout.* events still get backfilled
// even when GATE_CRON_JOBS is off — matching the behavior of the legacy
// 15-min setInterval that previously lived in server/index.js.
function initBankingSync() {
  cron.schedule('0 8,20 * * *', async () => {
    try {
      const StripeBanking = require('./stripe-banking');
      const result = await StripeBanking.syncPayouts(50);
      logger.info(`[stripe-banking] Scheduled sync: ${result.synced} payouts`);
    } catch (err) {
      logger.error(`[stripe-banking] Scheduled sync failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });
}

module.exports = {
  initScheduledJobs,
  initBankingSync,
  purposeForScheduledMessageType,
  resolveScheduledRecipient,
  scheduledDepositReceiptAllowed,
  classifyDepositReplayFallback,
  runContentRegistryMaintenance,
  runAutonomousOpportunityMining,
  parseListEnv,
  parsePositiveEnvInt,
  claimDueScheduledEstimates,
  recoverStaleScheduledEstimateClaims,
  markScheduledEstimateSendFailure,
};
