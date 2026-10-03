/**
 * The standard wording a typed visit's customer report keeps when nothing
 * was found (GATE_STANDARD_WORDING_PREVIEW; owner mockup approval
 * 2026-10-03). The office Complete Service form greys out Generate AI report
 * for such a record (client typedZeroStateRefusesBody) and shows these
 * sentences instead, so the person sees exactly what the customer will read
 * before sending.
 *
 * The wording is the report's own (activity-indicators.js
 * buildTypedReportSnapshot, todaysResult), built as /complete builds it
 * (complete-scheduled-service.js): the visit's own form (its completion
 * profile), the score the completion keeps (derived from the findings, or the
 * technician's own where they set it), and the visit number and trend from
 * the customer's earlier scores on the same indicator up to the day the
 * completion is dated. A primary cockroach report's work comes from the
 * submitted products, as /complete derives it (pre-push P1 on the first
 * push: "We placed targeted bait today." is product-derived).
 * Whether the report keeps its standard wording is the report's own verdict:
 * a write-up offered to it is refused. Read-only.
 */

const ActivityIndicators = require('./activity-indicators');
const { detectServiceLine } = require('./service-line-configs');
const { canonicalProductId } = require('./report-identity-snapshot');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The most product rows a preview reads (a visit uses a handful).
const MAX_PRODUCTS = 200;

// A write-up the report is offered: present in what it builds only when the
// report would use one, which is not the standard wording.
const OFFERED_WRITEUP = 'A technician write-up that standard wording never shows.';

// The score the completion keeps for these values: derived from the findings,
// else the technician's own (a whole number 0 to 5).
function scoreFor(type, values, techScore) {
  const indicator = ActivityIndicators.getActivityIndicator(type);
  if (!indicator) return { indicator: null, score: null };
  if (indicator.derive) {
    const derived = ActivityIndicators.deriveActivityScore(type, values);
    return { indicator, score: derived ? derived.score : null };
  }
  const own = Number.isInteger(techScore) && techScore >= 0 && techScore <= 5 ? techScore : null;
  return { indicator, score: own };
}

// The visit number and the activity (with its trend) from the customer's
// earlier scores on the indicator up to the day the completion is dated, as
// /complete reads them.
async function activityFor(knex, svc, serviceDate, indicator, score) {
  if (!indicator || score == null) return { visitSequence: 1, activity: null };
  const scope = { customer_id: svc.customer_id, indicator_key: indicator.indicatorKey };
  const prior = await knex('service_activity_scores')
    .where(scope)
    .where('service_date', '<=', serviceDate)
    .orderBy('service_date', 'desc')
    .orderBy('created_at', 'desc')
    .first('score');
  const [count] = await knex('service_activity_scores')
    .where(scope)
    .where('service_date', '<=', serviceDate)
    .count('* as count');
  const priorScore = prior ? Number(prior.score) : null;
  return {
    visitSequence: Number(count?.count || 0) + 1,
    activity: {
      indicatorKey: indicator.indicatorKey,
      label: indicator.label,
      score,
      trend: ActivityIndicators.trendDirection(score, priorScore),
      trendWord: ActivityIndicators.trendWordForScores(score, priorScore),
    },
  };
}

// A primary cockroach report's work, from the submitted product rows (each
// product's id, method and area) and the catalog as it stands: /complete's
// own derivation (complete-scheduled-service.js
// deriveCockroachWorkFromSubmittedProducts), never the form's chips. No
// derived work, no work_completed.
async function withDerivedWork(knex, { type, values, products, svc }) {
  if (type !== 'cockroach') return values;
  const { deriveCockroachWorkFromSubmittedProducts } = require('../complete-scheduled-service');
  const rows = (Array.isArray(products) ? products : [])
    .slice(0, MAX_PRODUCTS)
    .filter((row) => row && typeof row === 'object' && !Array.isArray(row));
  const ids = [...new Set(rows.map((row) => canonicalProductId(row.productId)).filter((id) => UUID_RE.test(id)))];
  const catalog = ids.length ? await knex('products_catalog').whereIn('id', ids).select('*') : [];
  const work = deriveCockroachWorkFromSubmittedProducts({
    products: rows,
    catalogRowsById: new Map(catalog.map((row) => [canonicalProductId(row.id), row])),
    serviceLine: detectServiceLine(svc.service_type),
  });
  const next = { ...values };
  if (work.length) next.work_completed = work.join(', ');
  else delete next.work_completed;
  return next;
}

/**
 * The standard wording ({ headline, body }) the visit's report keeps for
 * these values, or null when the report would use a write-up (or the visit
 * has no typed form). serviceDate is the day the completion is dated: today
 * (Eastern), or the scheduled day for a backdated closeout; products are the
 * form's product rows as the completion would submit them.
 */
async function standardWordingPreview(knex, {
  svc, serviceDate, profile, values: formValues, techScore = null, products = [],
}) {
  const type = profile?.findingsType;
  if (!type || !serviceDate || !formValues || typeof formValues !== 'object' || Array.isArray(formValues)) return null;
  const values = await withDerivedWork(knex, { type, values: formValues, products, svc });
  const { indicator, score } = scoreFor(type, values, techScore);
  const { visitSequence, activity } = await activityFor(knex, svc, serviceDate, indicator, score);
  const todaysResult = ActivityIndicators.buildTypedReportSnapshot({
    projectType: type,
    values,
    serviceKey: profile.serviceKey || null,
    serviceLabel: profile.serviceName || svc.service_type || null,
    visitSequence,
    activity,
    technicianReportBody: OFFERED_WRITEUP,
  })?.todaysResult;
  if (!todaysResult) return null;
  const headline = String(todaysResult.headline || '');
  const body = String(todaysResult.body || '');
  if (`${headline} ${body}`.includes(OFFERED_WRITEUP)) return null;
  return { headline, body };
}

module.exports = { standardWordingPreview, OFFERED_WRITEUP };
