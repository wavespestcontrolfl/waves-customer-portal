/**
 * The estimate that belongs to one Waves Assessment visit, as a read-only
 * summary for the Fast Complete sheet (GATE_ASSESSMENT_FAST_COMPLETE, owner
 * 2026-10-09: "estimate should be setting the price and we should pull from
 * this"). The sheet points to the estimate and links to it; it never stores,
 * types or restates a price, so there is no second copy to drift.
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
 * Which of them is the live price is not decided here either:
 *  - isEstimateCustomerViewable (routes/estimate-public.js), the customer
 *    page's own rule: not archived, not held off the customer surface, not
 *    expired or send-failed, and not past expires_at (the daily sweep flips
 *    the status later; the date decides now);
 *  - an estimate that has not gone out (UNSENT_STATUSES) is live for staff
 *    when it would be viewable once sent, judged by that same rule;
 *  - a declined estimate renders for the customer but is not a price.
 * Exactly one live candidate is shown. None is "none" (or "retired" when only
 * dead ones exist); more than one has no canonical pick, so it is "ambiguous"
 * and the sheet shows nothing rather than guess.
 *
 * "Sent" is a real handoff (call-commitments HANDOFF_COLS / latestHandoffAt: a
 * delivery that reached the customer, or their own acceptance), never the
 * sent_at column, which a suppressed send stamps while nothing goes out.
 *
 * NO AMOUNT is returned. The stored monthly / annual / one-time totals are
 * accounting figures (a per-application plan is stored annualized; a one-time
 * total can be an alternative under show_one_time_option), and no single
 * function states an estimate's price to a person: the admin list prints the
 * monthly figure, the residential email says "priced per application", the
 * customer page builds it from its own lines. A wrong price here is worse than
 * none, so the sheet says whether the estimate went out and links to it.
 *
 * Read-only. The estimate token is never returned: the link is the staff
 * estimate page, not the customer's bearer link.
 */
const db = require('../models/db');
const logger = require('./logger');

// Not delivered: a draft, a scheduled send, and a send that failed.
const UNSENT_STATUSES = ['draft', 'scheduled', 'send_failed'];
const COLUMNS = [
  'archived_at', 'created_at', 'expires_at', 'viewed_at', 'estimate_slug', 'estimate_data',
];

function isLive(row, now = new Date()) {
  const status = String(row.status || '');
  if (status === 'declined') return false;
  const { isEstimateCustomerViewable } = require('../routes/estimate-public');
  return isEstimateCustomerViewable(UNSENT_STATUSES.includes(status) ? { ...row, status: 'sent' } : row, now);
}
const iso = (value) => (value ? new Date(value).toISOString() : null);

function summaryOf(row) {
  const { latestHandoffAt } = require('./call-commitments');
  return {
    id: row.id,
    slug: row.estimate_slug || null,
    status: String(row.status || ''),
    // The last real handoff; null when nothing reached the customer.
    sentAt: iso(latestHandoffAt(row)),
    createdAt: iso(row.created_at),
  };
}

// Why a dead estimate is dead, in one word for the sheet.
function retiredStatusOf(row, now) {
  if (row.archived_at) return 'archived';
  const status = String(row.status || '');
  if (status === 'declined' || status === 'expired') return status;
  return row.expires_at && new Date(row.expires_at) < now ? 'expired' : 'withdrawn';
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
    const { HANDOFF_COLS } = require('./call-commitments');
    const rows = await conn('estimates').whereIn('id', ids).where({ customer_id: visit.customer_id })
      .select([...HANDOFF_COLS(conn), ...COLUMNS]);
    const live = rows.filter((row) => isLive(row, now));
    if (live.length > 1) return { state: 'ambiguous' };
    if (live.length === 1) return { state: 'found', estimate: summaryOf(live[0]) };
    if (!rows.length) return { state: 'none' };
    // Only dead estimates: say the newest one's status, never its price.
    const newest = [...rows].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    return { state: 'retired', status: retiredStatusOf(newest, now) };
  } catch (err) {
    logger.warn(`[assessment-estimate-summary] read failed for visit ${visit.id}: ${err.message}`);
    return { state: 'unavailable' };
  }
}

module.exports = { assessmentEstimateSummary, isLive };
