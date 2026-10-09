/**
 * The estimate that belongs to one Waves Assessment visit, as a read-only
 * summary for the Fast Complete sheet (GATE_ASSESSMENT_FAST_COMPLETE, owner
 * 2026-10-09: "estimate should be setting the price and we should pull from
 * this"). The sheet shows the estimate's own figure and links to it; it never
 * stores or types a price, so there is no second copy to drift.
 *
 * Which estimate: only relations the code already keeps, no matching rule of
 * its own.
 *  - the estimate's booking link, estimate_data.scheduled_service_id, written
 *    by estimator-engine/booking-predraft.js when the call booked this visit
 *    (it covers a draft that has not been sent);
 *  - the visit's own source_estimate_id (a visit booked from an estimate);
 *  - the estimate the estimate-sent sweep pairs with this visit
 *    (assessment-estimate-closeout.js estimateForAssessment: the sent estimate
 *    that speaks for the assessment, including its legacy pairing).
 * An estimate that is archived, declined or expired is not the live price.
 * Exactly one live candidate is shown. None is "none" (or "retired" when only
 * dead ones exist); more than one has no canonical pick, so it is "ambiguous"
 * and the sheet shows nothing rather than guess.
 *
 * Read-only. The estimate token is never returned: the link is the staff
 * estimate page, not the customer's bearer link.
 */
const db = require('../models/db');
const logger = require('./logger');

const DEAD_STATUSES = ['declined', 'expired'];
const SENT_STATUSES = ['sent', 'viewed', 'accepted'];
const COLUMNS = [
  'id', 'status', 'archived_at', 'sent_at', 'created_at', 'estimate_slug',
  'monthly_total', 'annual_total', 'onetime_total', 'service_interest',
];

const isLive = (row) => !row.archived_at && !DEAD_STATUSES.includes(String(row.status || ''));
const money = (value) => (value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));
const iso = (value) => (value ? new Date(value).toISOString() : null);

function summaryOf(row) {
  const status = String(row.status || '');
  return {
    id: row.id,
    slug: row.estimate_slug || null,
    status,
    // A date is shown only for an estimate that went out.
    sentAt: SENT_STATUSES.includes(status) ? iso(row.sent_at) : null,
    createdAt: iso(row.created_at),
    monthlyTotal: money(row.monthly_total),
    annualTotal: money(row.annual_total),
    onetimeTotal: money(row.onetime_total),
  };
}

async function candidateIds(conn, visit, now) {
  const ids = new Set();
  if (visit.source_estimate_id) ids.add(String(visit.source_estimate_id));
  const linked = await conn('estimates')
    .where({ customer_id: visit.customer_id })
    .whereRaw("estimate_data ->> 'scheduled_service_id' = ?", [String(visit.id)])
    .select('id');
  linked.forEach((row) => ids.add(String(row.id)));
  const { estimateForAssessment } = require('./assessment-estimate-closeout');
  const paired = await estimateForAssessment(conn, visit, { now });
  if (paired) ids.add(String(paired.id));
  return [...ids];
}

async function assessmentEstimateSummary(visit, { conn = db, now = new Date() } = {}) {
  if (!visit || !visit.customer_id) return { state: 'none' };
  try {
    const ids = await candidateIds(conn, visit, now);
    if (!ids.length) return { state: 'none' };
    // customer_id keeps a stray link from showing another customer's quote.
    const rows = await conn('estimates').whereIn('id', ids).where({ customer_id: visit.customer_id }).select(COLUMNS);
    const live = rows.filter(isLive);
    if (live.length > 1) return { state: 'ambiguous' };
    if (live.length === 1) return { state: 'found', estimate: summaryOf(live[0]) };
    if (!rows.length) return { state: 'none' };
    // Only dead estimates: say the newest one's status, never its price.
    const newest = [...rows].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    return { state: 'retired', status: newest.archived_at ? 'archived' : String(newest.status || '') };
  } catch (err) {
    logger.warn(`[assessment-estimate-summary] read failed for visit ${visit.id}: ${err.message}`);
    return { state: 'unavailable' };
  }
}

module.exports = { assessmentEstimateSummary, isLive };
