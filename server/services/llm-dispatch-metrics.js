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
 * Silence is load-bearing here, so recorder health is proven rather than
 * assumed. An hourly cron writes a heartbeat row through the same insert path
 * real recording uses; the digest then asks whether heartbeats exist for the
 * day it is summarizing. Three things make that necessary:
 *   - insert failures are swallowed at debug level by design (metrics must
 *     never cascade into the LLM call they observe), so a dead write path is
 *     otherwise invisible;
 *   - traffic volume cannot stand in for health — the SMS canary uses bare
 *     `dispatch` (writes no row) and every other instrumented job is
 *     candidate-driven, so a quiet ET day legitimately records nothing;
 *   - a probe at digest time would only prove the recorder works at 6:25am,
 *     so a write path broken all day but recovered overnight would pass while
 *     the entire lost day reported clean.
 * And because a dead database takes out the digest's own reads, DB failures
 * are caught and emailed over SMTP rather than throwing silently.
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
// finite backlog; eval harnesses replay a fixed fixture weekly) — expected
// inactivity, so they are excluded from gone-silent detection. Their
// failure/fallback exceptions still report. Convention: episodic lanes tag
// one of these suffixes on their policy name.
const EPISODIC_LANE_RE = /:(?:sealed|backfill|replay)$/;

// Synthetic policy used only by the write-path probe; inserted and deleted
// within probeRecorder, and excluded from stats so a failed cleanup can never
// masquerade as a real policy in the digest.
const HEARTBEAT_POLICY = '__heartbeat__';

// The hourly cron gives ~24 heartbeats a day. Absence signals (gone_silent)
// are only trustworthy on a day that was covered nearly end to end: a day the
// gate was off for part of, or that a deploy interrupted, produces a handful
// of heartbeats, and "policy X recorded nothing" during a partial window says
// nothing about whether X stopped running.
const MIN_DAY_COVERAGE = 20;

// Ambient replay context. Eval harnesses replay fixed fixtures through the
// SAME live service functions real traffic uses (call extraction, email
// classification, fact-check), often many layers below where the harness can
// pass an option — so replay traffic would otherwise be recorded under the
// live policy label, diluting its fallback/failure rates and keeping a dead
// live lane looking active. AsyncLocalStorage (not a module flag) so a replay
// running concurrently with live traffic cannot mislabel the live calls.
const { AsyncLocalStorage } = require('async_hooks');
const replayContext = new AsyncLocalStorage();

/**
 * Run `fn` with every LLM dispatch inside it recorded under a replay lane.
 * Harnesses wrap their whole run; nested live-service calls inherit it.
 */
function runAsReplay(fn, lane = 'replay') {
  return replayContext.run(String(lane), fn);
}

// Explicit workload names on the policy itself (smsShadow:<p>:sealed) win —
// they are more specific than the ambient lane.
function applyReplayLane(label) {
  const lane = replayContext.getStore();
  if (!lane || EPISODIC_LANE_RE.test(label)) return label;
  return `${label}:${lane}`;
}

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
function buildRow(policy, result) {
  const failures = Array.isArray(result?.failures) ? result.failures : [];
  return {
    policy: applyReplayLane(policyLabel(policy)).slice(0, 120),
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
}

// The single write path. The heartbeat probe goes through it too, so the
// probe genuinely exercises what real recording does rather than a lookalike.
function insertRow(row) {
  return require('../models/db')('llm_dispatch_log').insert(row);
}

function recordDispatch(policy, result) {
  if (!isEnabled()) return;
  try {
    void insertRow(buildRow(policy, result)).catch((err) => {
      logger.debug(`[llm-dispatch-metrics] insert failed: ${err.message}`);
    });
  } catch (err) {
    logger.debug(`[llm-dispatch-metrics] record skipped: ${err.message}`);
  }
}

/**
 * Prove the recorder can actually write, by writing. Business volume can NOT
 * stand in for this: the 6-hourly SMS canary uses bare `dispatch` (no row),
 * and every other instrumented job is candidate-driven, so a genuinely quiet
 * ET day legitimately records zero rows. Inferring breakage from an empty day
 * would email a recorder-failure alarm every quiet weekend.
 *
 * Resolves on success; rejects with the underlying error when the write path
 * is broken — which is the only sound basis for a not_recording exception.
 */
/**
 * Write one heartbeat row through the SAME insert path recordDispatch uses.
 * Called hourly by the scheduler while the gate is on, and deliberately NOT
 * deleted: the rows are the durable evidence that the recorder was alive
 * DURING a given ET day. A digest-time probe could only prove the recorder
 * works at 6:25am — a write path that was broken all day but recovered
 * overnight would pass it, and the whole lost day would report as a healthy
 * quiet day. Heartbeats are excluded from policy stats and pruned by
 * retention like any other row.
 *
 * Throws on failure so the cron logs it (this is not the hot path).
 */
async function recordHeartbeat() {
  if (!isEnabled()) return { skipped: 'gate_off' };
  await insertRow(buildRow({ name: HEARTBEAT_POLICY }, { ok: true }));
  return { ok: true };
}

/**
 * Render and send the exception email. Shared by the normal path and the
 * DB-failure path, which must be able to alert over SMTP precisely when the
 * database it reports on is unreadable.
 */
function emailExceptions(day, exceptions) {
  const items = exceptions
    .map((e) => `<li style="margin:0 0 10px 0;"><strong>${e.policy}</strong> — ${e.detail}</li>`)
    .join('');
  return require('./email').send({
    to: DIGEST_TO,
    subject: `LLM dispatch exceptions — ${day}`,
    heading: 'AI dispatch exceptions',
    body: `${exceptions.length === 1 ? 'One exception' : `${exceptions.length} exceptions`} on ${day}:<ul style="padding-left:20px;margin:12px 0;">${items}</ul>Normal traffic is never reported — this email only sends when something degraded, or when nothing was recorded at all.`,
  });
}

/**
 * Send an alert and NEVER let its own failure be silent. `email.send` resolves
 * `{ ok: false }` instead of rejecting, so a bare `.catch()` would miss an
 * undelivered alert entirely — the precise way this feature could lose the
 * message it exists to deliver. Used by the paths that cannot throw onward.
 */
async function emailAlert(day, exceptions) {
  try {
    const sent = await emailExceptions(day, exceptions);
    if (!sent?.ok) {
      logger.error(`[llm-dispatch-metrics] ALERT UNDELIVERED (${sent?.error || 'unknown email error'}): ${exceptions.map((e) => e.detail).join(' | ')}`);
      return { ok: false };
    }
    return { ok: true };
  } catch (err) {
    logger.error(`[llm-dispatch-metrics] ALERT UNDELIVERED (${err.message}): ${exceptions.map((e) => e.detail).join(' | ')}`);
    return { ok: false };
  }
}

/**
 * Alert that the recorder could not even be reached — used when the cron lock
 * cannot acquire a DB connection, so runLlmDispatchDigest never runs at all.
 * Deliberately touches NO database.
 */
async function alertRecorderUnreachable(reason) {
  if (!isEnabled()) return { skipped: 'gate_off' };
  const { etDateString, addETDays } = require('../utils/datetime-et');
  const day = etDateString(addETDays(new Date(), -1));
  return emailAlert(day, [{
    policy: '(recorder)',
    kind: 'not_recording',
    detail: `the digest could not run at all — the database was unreachable (${reason}). Recording status for ${day} is UNKNOWN; treat this as an outage, not a quiet day.`,
  }]);
}

/**
 * How many DISTINCT HOURS of a window the recorder proved itself in.
 *
 * Counting rows would overstate coverage: the heartbeat cron runs without the
 * exclusive lock (a duplicate heartbeat is harmless, a skipped one is not), so
 * multiple replicas — or old and new instances overlapping at :50 during a
 * deploy — each insert a row for the same hour. Two replicas covering only the
 * morning would reach 20 rows and make a half-dead day look fully covered.
 * Hour buckets are the honest unit. (ET offsets are whole hours, so bucketing
 * in the session's UTC does not change the count over an ET-day window.)
 */
async function countHeartbeats(db, start, end) {
  const row = await db('llm_dispatch_log')
    .where('created_at', '>=', start)
    .andWhere('created_at', '<', end)
    .andWhere('policy', HEARTBEAT_POLICY)
    .count({ n: db.raw("DISTINCT date_trunc('hour', created_at)") })
    .first();
  return Number(row?.n || 0);
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
function detectExceptions(yesterdayStats, priorWeekStats, probeError = null, absenceJudgeable = true) {
  const exceptions = [];

  // Recording health FIRST — without it, "no email" is ambiguous between
  // "nothing was wrong" and "nothing was recorded at all". recordDispatch
  // swallows insert failures at debug level (deliberate: metrics must never
  // cascade into the LLM call it observes), so a dead write path is otherwise
  // invisible. `probeError` comes from actually attempting a write (see
  // probeRecorder) — NOT from an empty day, which is a legitimate quiet-day
  // state, not evidence of breakage.
  if (probeError) {
    exceptions.push({
      policy: '(recorder)',
      kind: 'not_recording',
      detail: `the dispatch recorder could not write to llm_dispatch_log (${probeError}). Nothing is being recorded, so a silent digest cannot be read as "healthy" until this clears.`,
    });
  }

  // Per-policy findings below come from rows that DO exist, so they are real
  // regardless of the probe — a transient probe failure must never suppress a
  // genuine provider incident that was already recorded.
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
  // gone-silent is the ONE check a broken recorder fully explains: it fires on
  // the ABSENCE of rows, which is exactly what a dead write path produces. So
  // it — and only it — is skipped when the recorder was down, or every
  // prior-week policy would report a duplicate symptom of that root cause.
  // It is likewise skipped when the day has no heartbeat coverage at all
  // (first deploy / gate previously off), where absence proves nothing.
  const yesterdayByPolicy = new Map(yesterdayStats.map((s) => [s.policy, s]));
  for (const w of (probeError || !absenceJudgeable) ? [] : priorWeekStats) {
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
    .whereNot('policy', HEARTBEAT_POLICY)
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

  const { etDateString, addETDays } = require('../utils/datetime-et');
  const day = etDateString(addETDays(new Date(), -1));

  // EVERY table read/write below can throw — a missing table or a dead DB
  // takes out the retention DELETE and the stats SELECTs before any analysis
  // runs. The alert must not depend on the thing it is alerting about, so a
  // DB failure is caught here and emailed over SMTP, then rethrown so
  // cron-lock job health records the failed run too. Without this, the single
  // worst case (table gone) produced silence — the exact failure this whole
  // lane exists to eliminate.
  let pruned = 0;
  let yesterdayStats;
  let priorWeekStats;
  let heartbeats = 0;
  let priorHeartbeats = 0;
  try {
    // Retention pruning runs regardless of the gate: turning the kill switch
    // off must stop recording and emailing, not leave accumulated rows parked
    // forever past the promised 30-day window (codex r2 P2). On an empty
    // table this is a cheap indexed no-op DELETE.
    const cutoff = etDayWindow(RETENTION_DAYS).start;
    pruned = await db('llm_dispatch_log').where('created_at', '<', cutoff).del();

    if (!isEnabled()) return { skipped: 'gate_off', pruned };

    const yesterday = etDayWindow(1);
    const weekBefore = etDayWindow(8);
    [yesterdayStats, priorWeekStats, heartbeats, priorHeartbeats] = await Promise.all([
      loadStats(db, yesterday.start, yesterday.end),
      loadStats(db, weekBefore.start, yesterday.start),
      countHeartbeats(db, yesterday.start, yesterday.end),
      countHeartbeats(db, weekBefore.start, yesterday.start),
    ]);
  } catch (err) {
    const reason = err.message || String(err);
    logger.error(`[llm-dispatch-metrics] digest could not read llm_dispatch_log: ${reason}`);
    // The kill switch is absolute: while the gate is unset this feature sends
    // NOTHING, including its own failure alerts. The prune above runs before
    // the gate check, so without this guard a dark deployment would still
    // email on a DB outage.
    if (isEnabled()) {
      await emailAlert(day, [{
        policy: '(recorder)',
        kind: 'not_recording',
        detail: `the digest could not read llm_dispatch_log (${reason}). Recording status for ${day} is UNKNOWN — treat this as an outage until it clears, not as a quiet day.`,
      }]);
    }
    throw err;
  }

  // Recorder health is judged from the DAY BEING SUMMARIZED, via heartbeats
  // written hourly during it — not from a probe at digest time, which an
  // overnight recovery would pass while the lost day reported clean.
  //
  // But a day with no heartbeats is only an OUTAGE if coverage was actually
  // running: on first deploy, or after the gate was off, recordHeartbeat
  // no-opped and the day is simply unjudgeable. priorHeartbeats > 0 is the
  // evidence that coverage existed.
  // Deliberately phrased as UNKNOWN rather than "the recorder broke": a day
  // with no heartbeats is equally consistent with the gate having been turned
  // off for it, and distinguishing the two would need persisted gate history
  // for a state only the operator can cause and would recognise. Reporting
  // the fact ("nothing was recorded, so this day cannot be read as healthy")
  // is true either way, which is what the digest owes the reader.
  const recorderError = (heartbeats === 0 && priorHeartbeats > 0)
    ? `no heartbeat rows were recorded during ${day}, though the recorder was writing earlier in the week — either it failed or the feature was disabled for that day. Recording status for ${day} is UNKNOWN; it cannot be read as a healthy quiet day.`
    : null;
  if (heartbeats > 0 && heartbeats < MIN_DAY_COVERAGE) {
    logger.info(`[llm-dispatch-metrics] partial heartbeat coverage for ${day} (${heartbeats}/~24) — absence signals not judged`);
  } else if (heartbeats === 0 && priorHeartbeats === 0) {
    logger.info(`[llm-dispatch-metrics] no heartbeat coverage for ${day} yet — absence signals not judged`);
  }

  // Absence checks need a day covered nearly end to end. On a partial day
  // (gate toggled, deploy gap) "policy X recorded nothing" is uninformative,
  // and with zero heartbeats it is meaningless.
  const exceptions = detectExceptions(
    yesterdayStats, priorWeekStats, recorderError, heartbeats >= MIN_DAY_COVERAGE,
  );
  let sendError = null;
  if (exceptions.length) {
    const sent = await emailExceptions(day, exceptions);
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
  recordHeartbeat,
  runLlmDispatchDigest,
  alertRecorderUnreachable,
  detectExceptions,
  policyLabel,
  runAsReplay,
  HEARTBEAT_POLICY,
  FALLBACK_RATE_THRESHOLD,
  FALLBACK_MIN_VOLUME,
  SILENT_MIN_WEEKLY,
};
