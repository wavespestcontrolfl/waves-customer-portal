/**
 * Estimate engagement engine (PR 2 of the engagement-drip lane).
 *
 * Turns estimate page-visit SESSIONS (estimate-engagement-sessions.js) into
 * follow-up emails, keyed to behavior instead of the clock:
 *   - view-event rules (return_visit_hot / multi_view_high_intent /
 *     dark_then_return) enqueue a durable job when a qualifying session
 *     boundary lands, due after the rule's fire delay;
 *   - time-sweep rules (delivery_unopened_24h / viewed_gone_quiet_72h /
 *     expiring_engaged / expiring_never_viewed) enqueue due-now jobs from a
 *     bounded window scan.
 * A 5-minute cron processes due jobs, RE-VALIDATING everything at send
 * time. Every timing knob lives in estimate_followup_rules.params (merged
 * over the code defaults below) so cadence tunes without a deploy.
 *
 * Sends claim through the estimate_followup_sends ledger (#2729): the
 * archive-gated INSERT ... SELECT in estimate-follow-up.js is the atomic
 * claim, one send per (estimate, rule), released on send failure. The
 * shared helpers are imported via that module's _private surface — one
 * implementation of send/claim/gate mechanics across the whole lane.
 *
 * V1 CATEGORY SCOPE (owner 2026-07-14): pest + lawn only. Estimates whose
 * service lines resolve to anything else (termite, commercial, mosquito,
 * unknown, ...) are skipped — per-rule params.eligibleCategories widens
 * this later without a deploy.
 *
 * Dark ship: GATE_ESTIMATE_ENGAGEMENT_FOLLOWUP off = shadow mode — jobs
 * are scheduled and consumed (marked 'shadow') and the would-send is
 * logged, so volume can be judged with zero risk of a post-flip backlog
 * burst. Email-only: the estimate follow-up SMS lane is owner-paused.
 */

const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');
const { sessionsForEstimate } = require('./estimate-engagement-sessions');
const { inferEstimateServiceLines } = require('./estimate-service-lines');
const { customerConvertedSince } = require('./estimate-conversion-guard');
// Shared lane mechanics from the stage engine (see module doc above).
const followupShared = require('./estimate-follow-up')._private;

const ACTIVE_STATUSES = ['sent', 'viewed'];
const TERMINAL_STATUSES = new Set(['declined', 'accepted', 'expired', 'void']);

// Engine-wide guardrails. Env-overridable; the per-rule knobs live in the
// rules table. maxSendsPerEstimate counts EVERY estimate_followup_sends row
// (payment_step_abandoned included) — the cap protects the customer's
// inbox, not one rule's budget.
const ENGINE_LIMITS = {
  maxSendsPerEstimate: parseInt(process.env.ESTIMATE_ENGAGEMENT_MAX_SENDS, 10) || 4,
  minSpacingHours: parseFloat(process.env.ESTIMATE_ENGAGEMENT_MIN_SPACING_HOURS) || 12,
  // "They're on the page right now" — defer, don't send mid-read.
  activeViewHoldMinutes: 10,
  maxSendAttempts: 5,
  retryDelayMinutes: 30,
  deferDelayMinutes: 15,
  jobBatchSize: 50,
};

// Code defaults per rule — the DB row's params override key-by-key, so an
// admin edit can never leave a rule missing a knob.
const DEFAULT_RULE_PARAMS = {
  delivery_unopened_24h: { minAgeHours: 24, maxAgeHours: 48, eligibleCategories: ['pest', 'lawn'] },
  return_visit_hot: {
    minReturnGapMinutes: 15,
    maxSinceFirstSessionHours: 48,
    fireDelayMinutes: 15,
    spacingExempt: true,
    eligibleCategories: ['pest', 'lawn'],
  },
  multi_view_high_intent: { minSessions: 3, windowHours: 72, fireDelayMinutes: 15, eligibleCategories: ['pest', 'lawn'] },
  dark_then_return: { minDarkDays: 3, fireDelayMinutes: 15, eligibleCategories: ['pest', 'lawn'] },
  viewed_gone_quiet_72h: { minQuietHours: 72, maxQuietHours: 96, eligibleCategories: ['pest', 'lawn'] },
  expiring_engaged: { expiresWithinDays: 2, eligibleCategories: ['pest', 'lawn'] },
  expiring_never_viewed: { expiresWithinDays: 2, eligibleCategories: ['pest', 'lawn'] },
};

function parseParams(row) {
  let stored = {};
  try {
    stored = typeof row.params === 'string' ? JSON.parse(row.params) : (row.params || {});
  } catch {
    stored = {};
  }
  return { ...(DEFAULT_RULE_PARAMS[row.rule_key] || {}), ...stored };
}

async function loadRules(triggerType = null) {
  const q = db('estimate_followup_rules').where({ enabled: true });
  if (triggerType) q.where({ trigger_type: triggerType });
  const rows = await q.orderBy('priority', 'asc');
  return rows.map((row) => ({ ...row, params: parseParams(row) }));
}

// V1 category filter: EVERY resolved service line must be in the rule's
// eligibleCategories. 'unknown' (no resolvable lines) and any commercial_*
// or out-of-scope key fails — shadow-visible in job outcome_reason, never
// generic copy to a category without a truth-scoped pack.
function categoryEligible(est, rule) {
  const allowed = new Set(rule.params.eligibleCategories || []);
  if (!allowed.size) return false;
  let lines = [];
  try {
    lines = inferEstimateServiceLines(est) || [];
  } catch {
    return false;
  }
  if (!lines.length) return false;
  return lines.every((line) => allowed.has(line.key));
}

// Idempotent enqueue: the partial unique index (one pending job per
// estimate+rule) absorbs duplicate triggers; a rule already SENT for this
// estimate never re-enqueues; neither does one whose job already reached a
// TERMINAL state (done/shadow/skipped/failed) — one job lifecycle per
// (estimate, rule), so shadow mode consumes candidates exactly once
// (codex 2736 r1: without this, every sweep tick re-shadowed the same
// candidate, inflating volume counts and letting a shadow-consumed
// candidate send after a mid-window gate flip).
async function enqueueJob(estimateId, rule, dueAt, trigger) {
  const alreadySent = await db('estimate_followup_sends')
    .where({ estimate_id: estimateId, rule_key: rule.rule_key })
    .first('id');
  if (alreadySent) return false;
  const priorJob = await db('estimate_followup_jobs')
    .where({ estimate_id: estimateId, rule_key: rule.rule_key })
    .whereNot({ status: 'pending' })
    .first('id');
  if (priorJob) return false;
  const rows = await db('estimate_followup_jobs')
    .insert({
      estimate_id: estimateId,
      rule_key: rule.rule_key,
      due_at: dueAt,
      trigger: JSON.stringify(trigger || {}),
    })
    .onConflict(db.raw("(estimate_id, rule_key) WHERE status = 'pending'"))
    .ignore()
    .returning('id');
  return Array.isArray(rows) && rows.length === 1;
}

// ── View hook ────────────────────────────────────────────────────────────
// Called fire-and-forget from estimate-public's view-tracking sites, AFTER
// the estimate_views insert. Guaranteed non-throwing; must never slow the
// public estimate page.
async function onEstimateViewed(estimate, nowDate = new Date()) {
  try {
    if (!estimate || !ACTIVE_STATUSES.includes(estimate.status) || estimate.archived_at) return;
    if (!estimate.customer_email) return;
    const rules = await loadRules('view_event');
    if (!rules.length) return;
    const sessions = await sessionsForEstimate(estimate.id);
    if (!sessions.length) return;
    const now = nowDate.getTime();
    const latest = sessions[sessions.length - 1];
    const prev = sessions[sessions.length - 2] || null;

    for (const rule of rules) {
      const p = rule.params;
      let matches = false;
      if (rule.rule_key === 'return_visit_hot') {
        // Exactly the SECOND visit, soon after the first: a later return
        // is dark_then_return's job (the 48h ceiling keeps them disjoint).
        matches = sessions.length === 2
          && prev
          && latest.startedAt - prev.endedAt >= p.minReturnGapMinutes * 60000
          && latest.startedAt - sessions[0].startedAt <= p.maxSinceFirstSessionHours * 3600000;
      } else if (rule.rule_key === 'multi_view_high_intent') {
        const windowStart = now - p.windowHours * 3600000;
        matches = sessions.filter((s) => s.startedAt.getTime() >= windowStart).length >= p.minSessions;
      } else if (rule.rule_key === 'dark_then_return') {
        matches = !!prev && latest.startedAt - prev.endedAt >= p.minDarkDays * 86400000;
      }
      if (!matches) continue;
      const dueAt = new Date(now + (p.fireDelayMinutes || 15) * 60000);
      const queued = await enqueueJob(estimate.id, rule, dueAt, {
        sessions: sessions.length,
        latest_session_start: latest.startedAt.toISOString(),
      });
      if (queued) {
        logger.info(`[est-engage] queued ${rule.rule_key} for estimate ${estimate.id} (due ${dueAt.toISOString()})`);
      }
    }
  } catch (err) {
    logger.warn(`[est-engage] view hook failed for estimate ${estimate?.id}: ${err.message}`);
  }
}

// ── Time sweeps ──────────────────────────────────────────────────────────
// Bounded-window scans; each candidate becomes a due-now job so ALL
// validation and shadow accounting flows through one place (the processor).
async function sweepTimeRules(now = new Date()) {
  const nowMs = now.getTime();
  const rules = await loadRules('time_sweep');
  let queued = 0;
  for (const rule of rules) {
    const p = rule.params;
    try {
      let q = db('estimates')
        .whereNull('archived_at')
        .whereNotNull('customer_email')
        .whereNotExists(function excludeSent() {
          this.select(db.raw('1'))
            .from('estimate_followup_sends')
            .whereRaw('estimate_followup_sends.estimate_id = estimates.id')
            .where('estimate_followup_sends.rule_key', rule.rule_key);
        })
        .select('estimates.id');
      if (rule.rule_key === 'delivery_unopened_24h') {
        q = q.where({ status: 'sent' })
          .whereNull('viewed_at')
          .where('sent_at', '<', new Date(nowMs - p.minAgeHours * 3600000))
          .where('sent_at', '>', new Date(nowMs - p.maxAgeHours * 3600000));
      } else if (rule.rule_key === 'viewed_gone_quiet_72h') {
        q = q.where({ status: 'viewed' })
          .whereNotNull('last_viewed_at')
          .where('last_viewed_at', '<', new Date(nowMs - p.minQuietHours * 3600000))
          .where('last_viewed_at', '>', new Date(nowMs - p.maxQuietHours * 3600000));
      } else if (rule.rule_key === 'expiring_engaged') {
        q = q.whereIn('status', ACTIVE_STATUSES)
          .whereNotNull('viewed_at')
          .whereNotNull('expires_at')
          .where('expires_at', '>', now)
          .where('expires_at', '<', new Date(nowMs + p.expiresWithinDays * 86400000));
      } else if (rule.rule_key === 'expiring_never_viewed') {
        q = q.whereIn('status', ACTIVE_STATUSES)
          .whereNull('viewed_at')
          .whereNotNull('expires_at')
          .where('expires_at', '>', now)
          .where('expires_at', '<', new Date(nowMs + p.expiresWithinDays * 86400000));
      } else {
        continue; // unknown sweep rule — nothing to scan
      }
      const candidates = await q;
      for (const row of candidates) {
        if (await enqueueJob(row.id, rule, now, { sweep: rule.rule_key })) queued++;
      }
    } catch (err) {
      logger.error(`[est-engage] sweep ${rule.rule_key} failed: ${err.message}`);
    }
  }
  if (queued > 0) logger.info(`[est-engage] sweep queued ${queued} job(s)`);
  return queued;
}

// ── Job processor ────────────────────────────────────────────────────────

// Time-sweep predicates re-checked at PROCESS time (codex 2736 r1): a job
// queued in-window can go stale before it fires — the customer opens the
// "unopened" estimate, returns to the "gone quiet" one, or the expiry date
// moves. Judge the CURRENT row; a stale job skips instead of sending copy
// that's no longer true. View-event rules need no re-check here — their
// trigger is a historical fact (the return visit happened) and the generic
// gates cover everything current. Only the wrong-copy bound is enforced
// (e.g. gone-quiet's min bound, not its sweep-window max — a late-processed
// job's copy is still true).
function rulePredicateStillHolds(est, rule, nowMs) {
  const p = rule.params;
  if (rule.trigger_type !== 'time_sweep') return true;
  if (rule.rule_key === 'delivery_unopened_24h') {
    return est.status === 'sent' && !est.viewed_at;
  }
  if (rule.rule_key === 'viewed_gone_quiet_72h') {
    const lastView = est.last_viewed_at ? new Date(est.last_viewed_at).getTime() : 0;
    return !!lastView && nowMs - lastView >= p.minQuietHours * 3600000;
  }
  if (rule.rule_key === 'expiring_engaged' || rule.rule_key === 'expiring_never_viewed') {
    const expires = est.expires_at ? new Date(est.expires_at).getTime() : 0;
    if (!expires || expires <= nowMs || expires >= nowMs + p.expiresWithinDays * 86400000) return false;
    return rule.rule_key === 'expiring_engaged' ? !!est.viewed_at : !est.viewed_at;
  }
  return true;
}

async function markJob(jobId, status, reason, extra = {}) {
  await db('estimate_followup_jobs')
    .where({ id: jobId })
    .update({ status, outcome_reason: reason || null, updated_at: db.fn.now(), ...extra });
}

async function deferJob(jobId, dueAt, { countAttempt = false } = {}) {
  await db('estimate_followup_jobs')
    .where({ id: jobId })
    .update({
      due_at: dueAt,
      updated_at: db.fn.now(),
      ...(countAttempt ? { attempts: db.raw('attempts + 1') } : {}),
    });
}

async function processDueJobs(now = new Date()) {
  const nowMs = now.getTime();
  const jobs = await db('estimate_followup_jobs')
    .where({ status: 'pending' })
    .where('due_at', '<=', now)
    .orderBy('due_at', 'asc')
    .limit(ENGINE_LIMITS.jobBatchSize)
    .select('*');
  if (!jobs.length) return { sent: 0, shadow: 0 };

  const rules = await loadRules();
  const rulesByKey = new Map(rules.map((r) => [r.rule_key, r]));
  let sent = 0;
  let shadow = 0;

  for (const job of jobs) {
    let claimed = false;
    try {
      const rule = rulesByKey.get(job.rule_key);
      if (!rule) {
        await markJob(job.id, 'skipped', 'rule-disabled');
        continue;
      }
      // Re-read the estimate fresh — everything below judges CURRENT state,
      // not what was true at enqueue time.
      const est = await db('estimates').where({ id: job.estimate_id }).first();
      if (!est || est.archived_at || !ACTIVE_STATUSES.includes(est.status) || TERMINAL_STATUSES.has(est.status)) {
        await markJob(job.id, 'skipped', 'estimate-inactive');
        continue;
      }
      if (!est.customer_email) {
        await markJob(job.id, 'skipped', 'no-email');
        continue;
      }
      if (!categoryEligible(est, rule)) {
        await markJob(job.id, 'skipped', 'category-ineligible');
        continue;
      }
      if (!rulePredicateStillHolds(est, rule, nowMs)) {
        await markJob(job.id, 'skipped', 'stale-condition');
        continue;
      }
      // Mid-read hold: they're literally on the page — try again shortly.
      const lastView = est.last_viewed_at ? new Date(est.last_viewed_at).getTime() : 0;
      if (lastView && nowMs - lastView < ENGINE_LIMITS.activeViewHoldMinutes * 60000) {
        await deferJob(job.id, new Date(nowMs + ENGINE_LIMITS.deferDelayMinutes * 60000));
        continue;
      }
      const conv = await customerConvertedSince(est);
      if (conv.converted) {
        await markJob(job.id, 'skipped', `converted:${conv.reason}`);
        continue;
      }
      if (await followupShared.hasRepliedRecently(est)) {
        await markJob(job.id, 'skipped', 'customer-replied');
        continue;
      }
      // Inbox guardrails: hard cap across the whole ledger; spacing between
      // engagement emails (hot rules exempt by param).
      const ledger = await db('estimate_followup_sends')
        .where({ estimate_id: est.id })
        .orderBy('sent_at', 'desc')
        .select('rule_key', 'sent_at');
      if (ledger.length >= ENGINE_LIMITS.maxSendsPerEstimate) {
        await markJob(job.id, 'skipped', 'max-sends-cap');
        continue;
      }
      const lastSendMs = ledger.length ? new Date(ledger[0].sent_at).getTime() : 0;
      const spacingMs = ENGINE_LIMITS.minSpacingHours * 3600000;
      if (lastSendMs && !rule.params.spacingExempt && nowMs - lastSendMs < spacingMs) {
        await deferJob(job.id, new Date(lastSendMs + spacingMs));
        continue;
      }
      // Portal-wide email opt-out — same gate the stage engine applies.
      // Fails CLOSED (unreadable prefs = defer, email is the only leg).
      if (est.customer_id) {
        try {
          const prefs = await db('notification_prefs')
            .where({ customer_id: est.customer_id })
            .first('email_enabled');
          if (prefs?.email_enabled === false) {
            await markJob(job.id, 'skipped', 'email-prefs-off');
            continue;
          }
        } catch {
          await deferJob(job.id, new Date(nowMs + ENGINE_LIMITS.retryDelayMinutes * 60000), { countAttempt: true });
          continue;
        }
      }
      if (!isEnabled('estimateEngagementFollowup')) {
        logger.info(`[est-engage] shadow: would send ${rule.rule_key} for estimate ${est.id}`);
        await markJob(job.id, 'shadow', 'gate-off');
        shadow++;
        continue;
      }
      if (!(await followupShared.claimFollowupSend(est.id, rule.rule_key, rule.template_key, {
        job_id: job.id,
        trigger: job.trigger,
      }))) {
        await markJob(job.id, 'skipped', 'lost-claim');
        continue;
      }
      claimed = true;
      const firstName = (est.customer_name || '').split(' ')[0] || 'there';
      const { emailUrl } = await followupShared.mintStageLinks(est, `estimate_engage_${rule.rule_key}`);
      const ok = await followupShared.sendDualChannel(est, {
        email: {
          templateKey: rule.template_key,
          stage: `engage_${rule.rule_key}`,
          payload: followupShared.estimateEmailPayload(est, firstName, emailUrl),
        },
      });
      if (ok) {
        await db('estimates')
          .where({ id: est.id })
          .update({
            follow_up_count: db.raw('COALESCE(follow_up_count, 0) + 1'),
            last_follow_up_at: db.fn.now(),
          });
        await markJob(job.id, 'done', null);
        sent++;
        claimed = false;
      } else {
        await followupShared.releaseFollowupSend(est.id, rule.rule_key);
        claimed = false;
        if ((job.attempts || 0) + 1 >= ENGINE_LIMITS.maxSendAttempts) {
          await markJob(job.id, 'failed', 'send-failed', { attempts: db.raw('attempts + 1') });
        } else {
          await deferJob(job.id, new Date(nowMs + ENGINE_LIMITS.retryDelayMinutes * 60000), { countAttempt: true });
        }
      }
    } catch (err) {
      logger.error(`[est-engage] job ${job.id} (${job.rule_key}) failed: ${err.message}`);
      if (claimed) {
        try {
          await followupShared.releaseFollowupSend(job.estimate_id, job.rule_key);
        } catch (releaseErr) {
          logger.error(`[est-engage] claim release failed for job ${job.id}: ${releaseErr.message}`);
        }
      }
      // Poison-job guard (codex 2736 r1): an unexpected error must not leave
      // the row pending with an elapsed due_at — it would head the
      // due_at-ordered batch every tick and eventually starve valid jobs.
      // Count the attempt and defer; give up after the bounded retries.
      try {
        if ((job.attempts || 0) + 1 >= ENGINE_LIMITS.maxSendAttempts) {
          await markJob(job.id, 'failed', `error:${err.message}`.slice(0, 128), { attempts: db.raw('attempts + 1') });
        } else {
          await deferJob(job.id, new Date(nowMs + ENGINE_LIMITS.retryDelayMinutes * 60000), { countAttempt: true });
        }
      } catch (markErr) {
        logger.error(`[est-engage] poison-guard update failed for job ${job.id}: ${markErr.message}`);
      }
    }
  }
  if (sent > 0 || shadow > 0) {
    logger.info(`[est-engage] processed: ${sent} sent, ${shadow} shadow`);
  }
  return { sent, shadow };
}

module.exports = {
  onEstimateViewed,
  sweepTimeRules,
  processDueJobs,
};
module.exports._private = {
  loadRules,
  categoryEligible,
  enqueueJob,
  parseParams,
  rulePredicateStillHolds,
  ENGINE_LIMITS,
  DEFAULT_RULE_PARAMS,
};
