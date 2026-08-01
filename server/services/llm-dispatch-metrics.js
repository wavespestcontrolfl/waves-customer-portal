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

// route-signature -> TEXT_POLICIES key. Matched structurally (not by object
// identity) so the lookup is stable regardless of which module instance the
// caller's policy object came from.
let policyNamesBySig = null;
function routeSig(policy) {
  const leg = (r) => (r && r.provider && r.model ? `${r.provider}:${r.model}` : '-');
  return `${leg(policy.primary)}|${leg(policy.fallback)}`;
}
function policyLabel(policy) {
  if (!policy) return 'unknown';
  if (!policyNamesBySig) {
    policyNamesBySig = new Map();
    const MODELS = require('../config/models');
    for (const [name, obj] of Object.entries(MODELS.TEXT_POLICIES || {})) {
      const sig = routeSig(obj);
      if (!policyNamesBySig.has(sig)) policyNamesBySig.set(sig, name);
    }
  }
  const named = policy.primary ? policyNamesBySig.get(routeSig(policy)) : null;
  if (named) return named;
  // Ad-hoc { primary, fallback } pairs (call extraction, research miner):
  // label by the primary route so their traffic still aggregates.
  const p = policy.primary || policy;
  return p && p.provider && p.model ? `${p.provider}/${p.model}` : 'unknown';
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
  if (!isEnabled()) return { skipped: 'gate_off' };
  const db = require('../models/db');
  const { etDateString, addETDays } = require('../utils/datetime-et');

  const yesterday = etDayWindow(1);
  const weekBefore = etDayWindow(8);
  const [yesterdayStats, priorWeekStats] = await Promise.all([
    loadStats(db, yesterday.start, yesterday.end),
    loadStats(db, weekBefore.start, yesterday.start),
  ]);

  const exceptions = detectExceptions(yesterdayStats, priorWeekStats);
  let emailed = false;
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
    emailed = !!sent.ok;
    if (!sent.ok) logger.error(`[llm-dispatch-metrics] digest email failed: ${sent.error}`);
  }

  const cutoff = etDayWindow(RETENTION_DAYS).start;
  const pruned = await db('llm_dispatch_log').where('created_at', '<', cutoff).del();

  logger.info(`[llm-dispatch-metrics] digest: ${exceptions.length} exception(s), emailed=${emailed}, pruned=${pruned}`);
  return { exceptions, emailed, pruned };
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
