/**
 * Read-side loader for service_activity_scores → the customer-facing
 * ActivityCard payload on typed specialty reports.
 *
 * The persisted typedReportSnapshot already carries the visit's own score and
 * trend wording (resolved at completion time — never recomputed); this loader
 * only adds the cross-visit history series for the chart, keyed
 * (customer_id, indicator_key) up to and including this visit's date.
 */

const db = require('../../models/db');
const { scoreLevelWord } = require('./activity-indicators');

const HISTORY_LIMIT = 8;

// Cumulative knockdown-progress summary (TYPED_PROGRESS_SUMMARY, dark).
// Multi-visit knockdown protocols' story is baseline → today, not just
// visit-over-visit: the ActivityCard trend sentence compares only to the
// LAST visit, so a bed bug program that went 5 → 3 → 1 never states its
// cumulative win. Scoped to the knockdown families (bed bug + the shared
// roach indicator) and rendered ONLY when today improved on the recorded
// baseline — flat/worse visits keep the existing trend wording, and the
// summary states factual numbers only (no cleared/eliminated claims;
// banned-copy rules stay owned by the typed report's own wording).
const PROGRESS_SUMMARY_INDICATORS = new Set(['bed_bug_activity', 'roach_activity']);

function buildActivityProgress({ indicatorKey, history = [], currentScore = null } = {}) {
  if (process.env.TYPED_PROGRESS_SUMMARY !== 'true') return null;
  if (!PROGRESS_SUMMARY_INDICATORS.has(indicatorKey)) return null;
  if (!Array.isArray(history) || history.length < 2) return null;
  const baseline = history[0];
  if (!baseline || baseline.isCurrent || !Number.isFinite(Number(baseline.score))) return null;
  if (!Number.isFinite(Number(currentScore))) return null;
  if (Number(currentScore) >= Number(baseline.score)) return null;
  return {
    baselineScore: Number(baseline.score),
    baselineLevelWord: baseline.levelWord || scoreLevelWord(Number(baseline.score)),
    baselineDate: baseline.serviceDate || null,
    currentScore: Number(currentScore),
    visits: history.length,
  };
}

// pg DATE columns hydrate as Date objects, which JSON-serialize as full ISO
// timestamps — the client chart parses `${serviceDate}T12:00:00` and would
// drop every point. Always hand the client a bare YYYY-MM-DD string.
function toDateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const str = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(str) ? str.slice(0, 10) : str;
}

async function loadActivityCustomerView(knex = db, { snapshot = null, service = {} } = {}) {
  const activity = snapshot?.activity;
  if (!activity || activity.score == null || !activity.indicatorKey) return null;

  let history = [];
  try {
    const rows = await knex('service_activity_scores')
      .where({
        customer_id: service.customer_id,
        indicator_key: activity.indicatorKey,
      })
      .modify((query) => {
        if (service.service_date) query.where('service_date', '<=', service.service_date);
      })
      .orderBy('service_date', 'desc')
      .orderBy('created_at', 'desc')
      .limit(HISTORY_LIMIT + 8)
      .select('service_record_id', 'service_date', 'score');
    // The date bound alone leaks same-day sibling visits: viewing the earlier
    // report after a later same-day visit completes would chart the later
    // score. Trim at this report's own row whenever it's stored (every typed
    // completion stores one); the legacy no-row fallback keeps the date bound.
    const currentIdx = rows.findIndex((row) => row.service_record_id === service.id);
    const bounded = (currentIdx >= 0 ? rows.slice(currentIdx) : rows).slice(0, HISTORY_LIMIT);
    history = bounded
      .reverse()
      .map((row) => ({
        serviceRecordId: row.service_record_id,
        serviceDate: toDateOnly(row.service_date),
        score: Number(row.score),
        levelWord: scoreLevelWord(Number(row.score)),
        isCurrent: row.service_record_id === service.id,
      }));
  } catch {
    history = [];
  }

  // The chart needs the current visit even if the table is missing/empty
  // (e.g. legacy snapshot without a stored row).
  if (!history.some((point) => point.isCurrent)) {
    history.push({
      serviceRecordId: service.id,
      serviceDate: toDateOnly(service.service_date),
      score: activity.score,
      levelWord: activity.levelWord || scoreLevelWord(activity.score),
      isCurrent: true,
    });
  }

  return {
    indicatorKey: activity.indicatorKey,
    label: activity.label,
    score: activity.score,
    maxScore: 5,
    levelWord: activity.levelWord || scoreLevelWord(activity.score),
    source: activity.source || null,
    trend: activity.trend || null,
    trendWord: activity.trendWord || null,
    isBaseline: history.filter((point) => !point.isCurrent).length === 0,
    history,
    progress: buildActivityProgress({
      indicatorKey: activity.indicatorKey,
      history,
      currentScore: activity.score,
    }),
  };
}

function parseMaybeJson(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return null; }
  }
  return value && typeof value === 'object' ? value : null;
}

/**
 * The headline a CUSTOMER may see for a prior visit on this indicator's
 * trend line. The score row alone doesn't say which snapshot produced it —
 * a bait check riding a quarterly pest visit stores its headline in
 * companionReportSnapshots, not the top-level typedReportSnapshot — so
 * match by indicatorKey. Visibility mirrors the shipped boundaries exactly:
 * the primary artifact is suppressed when structured_notes.typedReportDelivery
 * is set and not auto_send (reports-public.suppressedTypedReport — legacy
 * rows without a mode were sent); companions froze their own delivery at
 * completion and customers only ever receive auto_send entries
 * (buildReportV1Data's companion filter). A suppressed visit's headline is
 * customer copy that was never sent — withhold it; the level-word fallback
 * matches what the gauge history already exposes for that visit.
 */
function visibleHeadlineForIndicator(row, indicatorKey) {
  const data = parseMaybeJson(row.service_data);
  if (!data) return null;

  const primary = data.typedReportSnapshot;
  if (primary?.activity?.indicatorKey === indicatorKey) {
    const mode = parseMaybeJson(row.structured_notes)?.typedReportDelivery || null;
    const headline = primary?.todaysResult?.headline;
    if (headline && !(mode && mode !== 'auto_send')) return String(headline);
  }

  const companions = Array.isArray(data.companionReportSnapshots)
    ? data.companionReportSnapshots
    : [];
  for (const companion of companions) {
    if (companion?.activity?.indicatorKey !== indicatorKey) continue;
    const headline = companion?.todaysResult?.headline;
    if (headline && companion.delivery === 'auto_send') return String(headline);
  }
  return null;
}

/**
 * D2 — cross-visit timeline for typed trend programs (trap checks, bait
 * stations, roach knockdowns…). Reuses the activity view's already-bounded
 * history series (same customer+indicator scoping, same same-day-sibling
 * trim) and enriches each prior visit with that visit's own frozen
 * Today's Result headline from the matching customer-visible snapshot.
 * Returns null when there is nothing to narrate (fewer than 2 visits — a
 * one-visit timeline is noise) so one-shot types and first visits render
 * no timeline.
 */
async function buildTypedVisitTimeline(knex = db, { activityView = null, snapshot = null, service = {} } = {}) {
  const history = Array.isArray(activityView?.history) ? activityView.history : [];
  if (history.length < 2) return null;

  const priorIds = history
    .filter((point) => !point.isCurrent && point.serviceRecordId)
    .map((point) => point.serviceRecordId);
  const headlines = new Map();
  if (priorIds.length) {
    try {
      const rows = await knex('service_records')
        .whereIn('id', priorIds)
        .select('id', 'service_data', 'structured_notes');
      for (const row of rows) {
        const headline = visibleHeadlineForIndicator(row, activityView.indicatorKey);
        if (headline) headlines.set(row.id, headline);
      }
    } catch {
      // Missing headlines degrade to the level word below — never fatal.
    }
  }

  const fallbackFor = (point) => (point.levelWord
    ? `${activityView.label}: ${point.levelWord}`
    : null);
  const visits = history.map((point) => ({
    serviceRecordId: point.serviceRecordId,
    serviceDate: point.serviceDate,
    headline: (point.isCurrent
      ? snapshot?.todaysResult?.headline
      : headlines.get(point.serviceRecordId)) || fallbackFor(point),
    levelWord: point.levelWord || null,
    isCurrent: point.isCurrent === true,
  }));

  return {
    indicatorKey: activityView.indicatorKey,
    label: activityView.label,
    visits,
  };
}

module.exports = {
  loadActivityCustomerView,
  buildTypedVisitTimeline,
  buildActivityProgress,
  HISTORY_LIMIT,
};
