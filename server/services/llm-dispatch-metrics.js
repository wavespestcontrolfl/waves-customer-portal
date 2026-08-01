/**
 * LLM dispatch observability — passive scorekeeping for the cross-provider
 * dispatcher plus a daily exception digest.
 *
 * Why: dispatchWithFallback fails QUIETLY by design — a dead primary route
 * degrades to the fallback provider, and a dead chain degrades to each
 * caller's safe-copy path, so provider trouble only surfaces as scattered
 * log lines under live traffic (#2814 ran 7 days unnoticed this way). The
 * sms-draft-canary actively probes two SMS routes; this module covers the
 * rest passively: every real dispatch chain writes one row to
 * llm_dispatch_log, and a daily cron emails ONLY exceptions to the company
 * inbox. Green days send nothing (hands-off + exception-based).
 *
 * Dark until GATE_LLM_DISPATCH_METRICS=true. Kill switch: unset — recording
 * and the digest both no-op instantly; existing rows just age out.
 */

const logger = require('./logger');

const DIGEST_TO = 'contact@wavespestcontrol.com';
const RETENTION_DAYS = 30;

// Exception thresholds. Volumes are per ET day per policy.
const FALLBACK_RATE_THRESHOLD = 0.2; // fallback on >=20% of a policy's calls
const FALLBACK_MIN_VOLUME = 5;       // ...but only with enough calls to mean it
const SILENT_MIN_WEEKLY = 10;        // policy had >=10 calls in prior 7 days...
                                     // ...and ZERO yesterday => "gone silent"

// Episodic one-shot workloads (sealed exams burst >=10 items then
// intentionally no-op until the prompt/profile changes; backfill drains a
// finite backlog) — expected inactivity, so they are excluded from
// gone-silent detection. Their failure/fallback exceptions still report.
// Convention: episodic lanes tag one of these suffixes on their policy name.
const EPISODIC_LANE_RE = /:(?:sealed|backfill)$/;

// Named TEXT_POLICIES entries carry their registry key as `name` (set in
// config/models.js). Route-signature matching is NOT safe here: with current
// env defaults customerCopy/visionAnalysis and highStakes/deepAnalysis
// resolve to identical route pairs, which would merge their stats and mask a
// gone-silent policy behind its twin's traffic.
function policyLabel(policy) {
  if (!policy) return 'unknown';
  if (typeof policy.name === 'string' && policy.name) return policy.name;
  // Anonymous { primary, fallback } pairs: label by the FULL route pair —
  // primary-only labels merged distinct lanes sharing a primary (codex r2).
  // Every in-repo ad-hoc policy now carries `name`; this is the safety net
  // for future unnamed ones.
  const leg = (r) => (r && r.provider && r.model ? `${r.provider}/${r.model}` : null);
  const primary = leg(policy.primary || policy);
  if (!primary) return 'unknown';
  const fallback = leg(policy.fallback);
  return fallback ? `${primary}→${fallback}` : primary;
}

function isEnabled() {
  return require('../config/feature-gates').isEnabled('llmDispatchMetrics');
}

/**
 * Record one completed dispatch chain. Fire-and-forget from the dispatcher's
 * hot path: never throws, never blocks, logs at debug on insert failure so a
 * DB blip can't cascade into the LLM call it was only supposed to observe.
 */
function recordDispatch(policy, result) {
  if (!isEnabled()) return;
  try {
    const db = require('../models/db');
    const failures = Array.isArray(result?.failures) ? result.failures : [];
    const row = {
      policy: policyLabel(policy).slice(0, 120),
      ok: !!result?.ok,
      provider: result?.ok ? result.provider || null : null,
      model: result?.ok ? result.model || null : null,
      fallback_used: !!result?.fallbackUsed,
      failure_reasons: failures.length
        ? JSON.stringify(failures.map((f) => ({
          provider: f.provider,
          model: f.model,
          // Reasons are short codes or validator messages — cap length so a
          // pathological error string can't bloat the row.
          reason: String(f.reason || '').slice(0, 300),
        })))
        : null,
    };
    void db('llm_dispatch_log').insert(row).catch((err) => {
      logger.debug(`[llm-dispatch-metrics] insert failed: ${err.message}`);
    });
  } catch (err) {
    logger.debug(`[llm-dispatch-metrics] record skipped: ${err.message}`);
  }
}

/** [startOfDay, startOfNextDay) as real Dates for the ET day N days ago. */
function etDayWindow(daysAgo) {
  const { parseETDateTime, etDateString, addETDays } = require('../utils/datetime-et');
  const start = parseETDateTime(`${etDateString(addETDays(new Date(), -daysAgo))}T00:00`);
  const end = parseETDateTime(`${etDateString(addETDays(new Date(), -(daysAgo - 1)))}T00:00`);
  return { start, end };
}

/**
 * Compute yesterday's exceptions. Exported for tests; takes rows already
 * aggregated per policy: { policy, total, fallbacks, failed } plus the
 * prior-7-day totals { policy, total }.
 */
function detectExceptions(yesterdayStats, priorWeekStats) {
  const exceptions = [];
  for (const s of yesterdayStats) {
    if (s.failed > 0) {
      exceptions.push({
        policy: s.policy,
        kind: 'all_providers_failed',
        detail: `${s.failed} of ${s.total} calls failed on BOTH providers (callers fell back to safe copy or errored)`,
      });
    }
    if (s.total >= FALLBACK_MIN_VOLUME && s.fallbacks / s.total >= FALLBACK_RATE_THRESHOLD) {
      exceptions.push({
        policy: s.policy,
        kind: 'fallback_rate',
        detail: `fallback provider answered ${s.fallbacks} of ${s.total} calls (${Math.round((s.fallbacks / s.total) * 100)}%) — primary route is degraded`,
      });
    }
  }
  const yesterdayByPolicy = new Map(yesterdayStats.map((s) => [s.policy, s]));
  for (const w of priorWeekStats) {
    if (EPISODIC_LANE_RE.test(w.policy)) continue; // one-shot lanes go quiet by design
    if (w.total >= SILENT_MIN_WEEKLY && !yesterdayByPolicy.has(w.policy)) {
      exceptions.push({
        policy: w.policy,
        kind: 'gone_silent',
        detail: `averaged ${Math.round(w.total / 7)} calls/day over the prior week but made ZERO calls yesterday — the feature may have stopped running`,
      });
    }
  }
  return exceptions;
}

async function loadStats(db, start, end) {
  const rows = await db('llm_dispatch_log')
    .where('created_at', '>=', start)
    .andWhere('created_at', '<', end)
    .groupBy('policy')
    .select('policy')
    .count({ total: '*' })
    .sum({ fallbacks: db.raw('CASE WHEN fallback_used THEN 1 ELSE 0 END') })
    .sum({ failed: db.raw('CASE WHEN ok THEN 0 ELSE 1 END') });
  return rows.map((r) => ({
    policy: r.policy,
    total: Number(r.total),
    fallbacks: Number(r.fallbacks || 0),
    failed: Number(r.failed || 0),
  }));
}

/**
 * Daily digest tick. Aggregates yesterday's ET day, emails the company inbox
 * ONLY when exceptions exist, then prunes rows past retention.
 */
async function runLlmDispatchDigest() {
  const db = require('../models/db');

  // Retention pruning runs regardless of the gate: turning the kill switch
  // off must stop recording and emailing, not leave accumulated rows parked
  // forever past the promised 30-day window (codex r2 P2). On an empty
  // table this is a cheap indexed no-op DELETE.
  const cutoff = etDayWindow(RETENTION_DAYS).start;
  const pruned = await db('llm_dispatch_log').where('created_at', '<', cutoff).del();

  if (!isEnabled()) return { skipped: 'gate_off', pruned };
  const { etDateString, addETDays } = require('../utils/datetime-et');

  const yesterday = etDayWindow(1);
  const weekBefore = etDayWindow(8);
  const [yesterdayStats, priorWeekStats] = await Promise.all([
    loadStats(db, yesterday.start, yesterday.end),
    loadStats(db, weekBefore.start, yesterday.start),
  ]);

  const exceptions = detectExceptions(yesterdayStats, priorWeekStats);
  let sendError = null;
  if (exceptions.length) {
    const day = etDateString(addETDays(new Date(), -1));
    const items = exceptions
      .map((e) => `<li style="margin:0 0 10px 0;"><strong>${e.policy}</strong> — ${e.detail}</li>`)
      .join('');
    const email = require('./email');
    const sent = await email.send({
      to: DIGEST_TO,
      subject: `LLM dispatch exceptions — ${day}`,
      heading: 'AI provider exceptions',
      body: `The AI dispatcher hit ${exceptions.length === 1 ? 'an exception' : `${exceptions.length} exceptions`} yesterday (${day}):<ul style="padding-left:20px;margin:12px 0;">${items}</ul>Normal traffic is not reported — this email only sends when something degraded.`,
    });
    if (!sent.ok) sendError = sent.error || 'unknown email error';
  }

  // An undeliverable exception email must FAIL the job (retention pruning
  // already ran above, independently) — otherwise runExclusive records a
  // healthy run, tomorrow's tick moves to a new window, and the alert is
  // silently lost. The throw lands in the scheduler's catch -> logger.error
  // -> Sentry, and cron-lock job health shows the miss.
  if (sendError) {
    throw new Error(`digest email failed with ${exceptions.length} undelivered exception(s): ${sendError}`);
  }

  logger.info(`[llm-dispatch-metrics] digest: ${exceptions.length} exception(s), emailed=${exceptions.length > 0}, pruned=${pruned}`);
  return { exceptions, emailed: exceptions.length > 0, pruned };
}

module.exports = {
  recordDispatch,
  runLlmDispatchDigest,
  detectExceptions,
  policyLabel,
  FALLBACK_RATE_THRESHOLD,
  FALLBACK_MIN_VOLUME,
  SILENT_MIN_WEEKLY,
};
