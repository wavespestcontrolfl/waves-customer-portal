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
  };
}

/**
 * D2 — cross-visit timeline for typed trend programs (trap checks, bait
 * stations, roach knockdowns…). Reuses the activity view's already-bounded
 * history series (same customer+indicator scoping, same same-day-sibling
 * trim) and enriches each prior visit with that visit's own frozen
 * Today's Result headline from its typedReportSnapshot. Returns null when
 * there is nothing to narrate (fewer than 2 visits — a one-visit timeline
 * is noise) so one-shot types and first visits render no timeline.
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
        .select('id', 'service_data');
      for (const row of rows) {
        let data = row.service_data;
        if (typeof data === 'string') {
          try { data = JSON.parse(data); } catch { data = null; }
        }
        const headline = data?.typedReportSnapshot?.todaysResult?.headline;
        if (headline) headlines.set(row.id, String(headline));
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

module.exports = { loadActivityCustomerView, buildTypedVisitTimeline, HISTORY_LIMIT };
