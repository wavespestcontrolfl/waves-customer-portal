/**
 * Pay after the first visit — annual prepay (GATE_PAF_PREPAY, owner rulings
 * 2026-09-30 / 2026-10-01).
 *
 * The accept saves the card, mints the year invoice (left as an unsent draft)
 * and a payment_pending term, and stamps the durable charge job
 * (estimates.estimate_data.prepayAutoChargeJob) as 'awaiting_first_visit'
 * instead of 'pending'. Until the first visit is performed,
 * annual-prepay-renewals.js pafDeferredPrepayCoversVisit holds the plan's
 * visits so none is billed per application.
 *
 * This pass, run at the start of every stranded-prepay sweep (every 15
 * minutes), moves each awaiting job on:
 *   - the year invoice was voided / cancelled / refunded, or the term was
 *     cancelled, before any visit → 'cancelled_before_visit' (nothing charged);
 *   - a visit of the plan was PERFORMED (completed, with a completed service
 *     record whose outcome is not inspection_only / customer_declined /
 *     incomplete), or the invoice already settled → released to 'pending'
 *     with an epoch created_at, and the invoice comes due today. The sweep
 *     that runs right after charges the bound method under the acknowledged
 *     cents (or less, owner R1) through its existing claim / fence / fallback;
 *   - no performed visit 14 days after the accept (owner R8) → one office
 *     alert; it closes itself on release or cancel.
 *
 * Every transition is a compare-and-swap on the job's status, so concurrent
 * sweeps release a job once. It runs whether or not the gate is still on: an
 * accept already deferred must still be collected.
 */

const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');

const AWAITING = 'awaiting_first_visit';
const STALE_DAYS = 14;
const NOT_PERFORMED_OUTCOMES = ['inspection_only', 'customer_declined', 'incomplete'];
const DEAD_INVOICE_STATUSES = ['void', 'voided', 'canceled', 'cancelled', 'refunded'];

const staleAlertKey = (estimateId) => `paf-prepay-no-first-visit:${estimateId}`;

function parseData(raw) {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return raw && typeof raw === 'object' ? raw : null;
}

// Merge `patch` into the job only while it is still awaiting (CAS). Returns
// true when this caller made the transition.
async function casAwaiting(estimateId, patch) {
  const rows = await db('estimates')
    .where({ id: estimateId })
    .whereRaw("estimate_data -> 'prepayAutoChargeJob' ->> 'status' = ?", [AWAITING])
    .update({
      estimate_data: db.raw(
        "jsonb_set(estimate_data, '{prepayAutoChargeJob}', (estimate_data -> 'prepayAutoChargeJob') || ?::jsonb)",
        [JSON.stringify(patch)],
      ),
    });
  return rows === 1;
}

// The first performed visit of the accepted plan: a visit (or a child of a
// series parent) carrying this estimate as its source.
async function firstPerformedVisit(estimateId, customerId) {
  return db('scheduled_services as s')
    .leftJoin('scheduled_services as p', 'p.id', 's.recurring_parent_id')
    .join('service_records as r', 'r.scheduled_service_id', 's.id')
    .where('s.customer_id', customerId)
    .where((q) => q.where('s.source_estimate_id', estimateId).orWhere('p.source_estimate_id', estimateId))
    .where('s.status', 'completed')
    .where('r.status', 'completed')
    .whereRaw("COALESCE(r.structured_notes ->> 'visitOutcome', '') <> ALL(?::text[])", [NOT_PERFORMED_OUTCOMES])
    .orderBy('s.scheduled_date', 'asc')
    .first('s.id');
}

async function closeStaleAlert(estimateId, resolution) {
  try {
    await require('./admin-alert-episodes').closeAdminAlertKeys(db, [staleAlertKey(estimateId)], 'resolved', { resolution });
  } catch (err) {
    logger.warn(`[paf-prepay] stale alert close failed for estimate ${estimateId}: ${err.message}`);
  }
}

async function raiseStaleAlert(estimateId, invoiceId) {
  const { raiseAdminAlert } = require('./admin-alert-compose');
  await raiseAdminAlert('billing', {
    area: 'Billing',
    action: 'Check an annual prepay with no first visit',
    why: `Approved ${STALE_DAYS}+ days ago; the card is charged only after the first visit, and none was performed.`,
    severity: 'needs-you',
    link: `/admin/invoices?invoice=${invoiceId}`,
    subject: { type: 'estimate', id: String(estimateId) },
    doneWhen: 'first_visit_performed',
    who: 'person',
  }, { dedupeKey: staleAlertKey(estimateId) });
}

async function releaseOne(row, now) {
  const job = parseData(row.estimate_data)?.prepayAutoChargeJob;
  if (!job || job.status !== AWAITING || !job.invoice_id) return null;
  const invoice = await db('invoices').where({ id: job.invoice_id }).first('id', 'status', 'customer_id');
  const invStatus = String(invoice?.status || '').toLowerCase();
  const term = invoice
    ? await db('annual_prepay_terms').where({ prepay_invoice_id: invoice.id }).first('status')
    : null;
  if (!invoice || DEAD_INVOICE_STATUSES.includes(invStatus) || String(term?.status || '') === 'cancelled') {
    const reason = !invoice ? 'invoice_missing' : (DEAD_INVOICE_STATUSES.includes(invStatus) ? `invoice_${invStatus}` : 'term_cancelled');
    if (await casAwaiting(row.id, { status: 'cancelled_before_visit', reason, resolved_at: now.toISOString(), resolved_by: 'paf_release' })) {
      await closeStaleAlert(row.id, 'The plan was cancelled before the first visit; nothing was charged.');
      return 'cancelled';
    }
    return null;
  }
  const settled = ['paid', 'prepaid', 'processing'].includes(invStatus);
  const visit = settled ? null : await firstPerformedVisit(row.id, invoice.customer_id);
  if (settled || visit) {
    const released = await casAwaiting(row.id, {
      // created_at stays the accept time, so the sweep's 15-minute age
      // filter takes the job on this same pass.
      status: 'pending',
      released_at: now.toISOString(),
      released_for_visit_id: visit?.id || null,
    });
    if (!released) return null;
    if (!settled) {
      // The invoice comes due when the charge runs, so a declined charge's
      // pay link and follow-ups age from after the visit, not from the accept.
      try {
        await db('invoices').where({ id: invoice.id }).where('status', 'draft').update({ due_date: etDateString(now) });
      } catch (err) {
        logger.warn(`[paf-prepay] due date update failed for invoice ${invoice.id}: ${err.message}`);
      }
    }
    await closeStaleAlert(row.id, 'The first visit was performed; the annual prepay charge ran.');
    return 'released';
  }
  const since = new Date(job.authorized_at || job.created_at || 0);
  if (!job.stale_alerted_at && now - since >= STALE_DAYS * 24 * 60 * 60 * 1000) {
    // Raise first (deduped by key), then stamp: a failed raise is retried on
    // the next pass instead of being marked as sent.
    await raiseStaleAlert(row.id, invoice.id);
    if (await casAwaiting(row.id, { stale_alerted_at: now.toISOString() })) return 'stale_alerted';
  }
  return null;
}

// Every awaiting job is visited on each pass, page by page (keyset on id):
// jobs that stay waiting (no visit yet) never crowd a newer performed one out.
async function releaseDeferredPrepayCharges({ pageSize = 200, now = new Date() } = {}) {
  const summary = { scanned: 0, released: 0, cancelled: 0, staleAlerted: 0 };
  let afterId = null;
  for (;;) {
    let rows = [];
    try {
      rows = await db('estimates')
        .where({ status: 'accepted' })
        .whereRaw("(estimate_data)::jsonb -> 'prepayAutoChargeJob' ->> 'status' = ?", [AWAITING])
        .modify((q) => { if (afterId) q.where('id', '>', afterId); })
        .orderBy('id', 'asc')
        .limit(pageSize)
        .select('id', 'estimate_data');
    } catch (err) {
      logger.warn(`[paf-prepay] awaiting-job scan failed: ${err.message}`);
      return summary;
    }
    summary.scanned += rows.length;
    for (const row of rows) {
      try {
        const outcome = await releaseOne(row, now);
        if (outcome === 'released') summary.released += 1;
        else if (outcome === 'cancelled') summary.cancelled += 1;
        else if (outcome === 'stale_alerted') summary.staleAlerted += 1;
      } catch (err) {
        logger.warn(`[paf-prepay] release check failed for estimate ${row.id}: ${err.message}`);
      }
    }
    if (rows.length < pageSize) return summary;
    afterId = rows[rows.length - 1].id;
  }
}

module.exports = {
  AWAITING,
  STALE_DAYS,
  releaseDeferredPrepayCharges,
  staleAlertKey,
};
