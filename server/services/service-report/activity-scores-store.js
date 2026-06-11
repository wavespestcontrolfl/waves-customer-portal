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

module.exports = { loadActivityCustomerView, HISTORY_LIMIT };
