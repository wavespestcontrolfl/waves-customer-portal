/**
 * Event-source health: yield tracking + escalation.
 *
 * Two silent failure modes starved the newsletter event pipeline for
 * weeks without a single alert:
 *
 *   1. Zero-yield "success" — a feed fetches and parses fine but
 *      produces 0 events run after run (selector rot, bot wall, empty
 *      feed). last_pull_status stayed 'success' with 0
 *      consecutive_failures, so the health UI showed a green fleet
 *      over an empty funnel (15 of 25 sources had never produced a
 *      single event).
 *
 *   2. Hard failures climbing unbounded — consecutive_failures reached
 *      47 (~7 weeks of daily 403s/timeouts/DNS errors) with nothing
 *      escalating past a dashboard badge nobody was watching.
 *
 * ingestSource calls yieldTrackingUpdateFor() on every successful pull;
 * after each full ingestion run, checkAndNotifySourceHealth() raises
 * ONE admin notification when any source hits an alert point — listing
 * the full unhealthy roster for context. Alert points are the first
 * threshold crossing plus a weekly re-ping while still broken, so the
 * daily cron neither spams nor goes quiet on a long-broken source. The
 * autopilot's weekly skip report re-surfaces the same roster.
 */

const db = require('../models/db');
const logger = require('./logger');

// 3 consecutive failed pulls ≈ 3 days broken — early enough to repair a
// source before it can starve a Thursday digest.
const FAILURE_ALERT_THRESHOLD = 3;
// 7 consecutive empty-but-successful pulls ≈ a week without a single
// event. Real feeds have quiet days; a quiet WEEK is selector rot or a
// bot wall.
const ZERO_YIELD_ALERT_THRESHOLD = 7;
// Re-ping cadence while a source stays past its threshold.
const REPING_EVERY_RUNS = 7;

/**
 * Success-path bookkeeping for ingestSource — the yield-tracking
 * columns to update alongside last_pull_status='success'. Hard
 * failures don't touch these (consecutive_failures owns that signal).
 */
function yieldTrackingUpdateFor(yieldCount) {
  const n = Number(yieldCount) || 0;
  return {
    last_yield_count: n,
    consecutive_zero_yields: n > 0 ? 0 : db.raw('consecutive_zero_yields + 1'),
    ...(n > 0 ? { last_nonzero_yield_at: db.fn.now() } : {}),
  };
}

// A counter is "at an alert point" on the run it first crosses its
// threshold, then every REPING_EVERY_RUNS runs after — so an operator
// gets one alert per breakage plus a weekly reminder while it's still
// broken, and sources already past threshold when this ships still
// alert within a week.
function atAlertPoint(count, threshold) {
  return count >= threshold && (count - threshold) % REPING_EVERY_RUNS === 0;
}

/**
 * Pure classification over event_sources rows.
 * Zero-yield only counts sources that are otherwise succeeding —
 * a hard-failing source is already reported by the failing bucket.
 */
function classifyUnhealthySources(rows, {
  failureThreshold = FAILURE_ALERT_THRESHOLD,
  zeroYieldThreshold = ZERO_YIELD_ALERT_THRESHOLD,
} = {}) {
  const enabled = (rows || []).filter((r) => r && r.enabled !== false);
  const failing = enabled.filter(
    (r) => Number(r.consecutive_failures || 0) >= failureThreshold,
  );
  const zeroYield = enabled.filter(
    (r) => Number(r.consecutive_failures || 0) === 0
      && Number(r.consecutive_zero_yields || 0) >= zeroYieldThreshold,
  );
  const alerting = [
    ...failing.filter((r) => atAlertPoint(Number(r.consecutive_failures || 0), failureThreshold)),
    ...zeroYield.filter((r) => atAlertPoint(Number(r.consecutive_zero_yields || 0), zeroYieldThreshold)),
  ];
  return { failing, zeroYield, alerting };
}

function formatSourceHealthLines({ failing, zeroYield }) {
  const lines = [];
  for (const s of failing) {
    const err = s.last_error ? ` (${String(s.last_error).split('\n')[0].slice(0, 80)})` : '';
    lines.push(`- ${s.name}: ${s.consecutive_failures} consecutive failed pulls${err}`);
  }
  for (const s of zeroYield) {
    lines.push(`- ${s.name}: pulls succeed but 0 events for ${s.consecutive_zero_yields} runs`);
  }
  return lines;
}

/**
 * Post-run escalation. Called by ingestAllEnabledSources after every
 * full pull; sends one event_sources_unhealthy notification when any
 * source is at an alert point this run.
 */
async function checkAndNotifySourceHealth() {
  const rows = await db('event_sources').where({ enabled: true });
  const classified = classifyUnhealthySources(rows);
  const { failing, zeroYield, alerting } = classified;
  if (!alerting.length) return { ...classified, notified: false };

  try {
    // Lazy require — same pattern as the autopilot; keeps this module
    // loadable in tests without the notification service chain.
    const { triggerNotification } = require('./notification-triggers');
    await triggerNotification('event_sources_unhealthy', {
      alertingNames: alerting.map((s) => s.name),
      failingCount: failing.length,
      zeroYieldCount: zeroYield.length,
      summary: formatSourceHealthLines(classified).join('\n'),
    });
  } catch (e) {
    logger.warn(`[event-source-health] notification failed: ${e.message}`);
  }
  return { ...classified, notified: true };
}

module.exports = {
  FAILURE_ALERT_THRESHOLD,
  ZERO_YIELD_ALERT_THRESHOLD,
  REPING_EVERY_RUNS,
  yieldTrackingUpdateFor,
  classifyUnhealthySources,
  formatSourceHealthLines,
  checkAndNotifySourceHealth,
};
