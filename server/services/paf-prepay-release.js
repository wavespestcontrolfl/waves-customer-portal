/**
 * Pay after the first visit — annual prepay (GATE_PAF_PREPAY, owner rulings
 * 2026-09-30 / 2026-10-01).
 *
 * The accept saves the card, mints the year invoice (left as an unsent draft)
 * and a payment_pending term, and stamps the durable charge job
 * (estimates.estimate_data.prepayAutoChargeJob) as 'awaiting_first_visit'
 * instead of 'pending'. Until the year is paid,
 * annual-prepay-renewals.js pafDeferredPrepayCoversVisit holds the plan's
 * visits so none is billed per application.
 *
 * Two passes run at the start of every stranded-prepay sweep (every 15
 * minutes), whether or not the gate is still on — an accept already deferred
 * must still be collected:
 *
 * 1. Release: each awaiting job moves on, by compare-and-swap on its status:
 *    - a visit of the plan was PERFORMED (completed, with a completed service
 *      record whose outcome is not inspection_only / customer_declined /
 *      incomplete), or the invoice already settled → the invoice comes due
 *      today, then the job is released to 'pending' and the sweep that runs
 *      right after charges the bound method for the acknowledged total or
 *      less (owner R1);
 *    - the year invoice was voided / cancelled / refunded, or the term was
 *      cancelled → 'cancelled_before_visit' (nothing charged), or
 *      'cancelled_after_visit' when a visit was already performed (that work
 *      was held, not billed, so the office is told to bill it);
 *    - no performed visit 14 days after the accept (owner R8) → the no-visit
 *      alert is reserved on the job.
 *
 * 2. Alerts: every office alert is reconciled from the job's state, with its
 *    own stamps, never fired once and forgotten — a failed raise or close is
 *    simply done again on the next pass:
 *    - no first visit (R8): raised while the job still waits, closed once it
 *      does not;
 *    - charge failed after the first visit (R2): raised while the delivered
 *      year invoice is still unpaid, closed once it settles or dies;
 *    - visit done but the year cancelled before it was charged: raised once.
 */

const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');

const AWAITING = 'awaiting_first_visit';
const STALE_DAYS = 14;
const NOT_PERFORMED_OUTCOMES = ['inspection_only', 'customer_declined', 'incomplete'];
const DEAD_INVOICE_STATUSES = ['void', 'voided', 'canceled', 'cancelled', 'refunded'];
const SETTLED_INVOICE_STATUSES = ['paid', 'prepaid', 'processing'];
const JOB = "estimate_data -> 'prepayAutoChargeJob'";

const staleAlertKey = (estimateId) => `paf-prepay-no-first-visit:${estimateId}`;
const chargeAlertKey = (estimateId) => `paf-prepay-charge-failed:${estimateId}`;
const unbilledAlertKey = (estimateId) => `paf-prepay-cancelled-after-visit:${estimateId}`;

function parseData(raw) {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return raw && typeof raw === 'object' ? raw : null;
}

// Merge `patch` into the job; `guard` adds the compare-and-swap conditions.
// Returns true when this caller's write landed.
async function patchJob(estimateId, patch, guard = (q) => q) {
  const rows = await guard(db('estimates').where({ id: estimateId })).update({
    estimate_data: db.raw(
      "jsonb_set(estimate_data, '{prepayAutoChargeJob}', (estimate_data -> 'prepayAutoChargeJob') || ?::jsonb)",
      [JSON.stringify(patch)],
    ),
  });
  return rows === 1;
}
const whileAwaiting = (q) => q.whereRaw(`${JOB} ->> 'status' = ?`, [AWAITING]);
const whileUnset = (key) => (q) => q.whereRaw(`${JOB} ->> '${key}' IS NULL`);

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

async function releaseOne(row, now) {
  const job = parseData(row.estimate_data)?.prepayAutoChargeJob;
  if (!job || job.status !== AWAITING || !job.invoice_id) return null;
  const invoice = await db('invoices').where({ id: job.invoice_id }).first('id', 'status', 'customer_id');
  const invStatus = String(invoice?.status || '').toLowerCase();
  const term = invoice
    ? await db('annual_prepay_terms').where({ prepay_invoice_id: invoice.id }).first('status')
    : null;
  const dead = !invoice || DEAD_INVOICE_STATUSES.includes(invStatus) || String(term?.status || '') === 'cancelled';
  const settled = !dead && SETTLED_INVOICE_STATUSES.includes(invStatus);
  const visit = invoice && !settled ? await firstPerformedVisit(row.id, invoice.customer_id) : null;

  if (dead) {
    const reason = !invoice ? 'invoice_missing' : (DEAD_INVOICE_STATUSES.includes(invStatus) ? `invoice_${invStatus}` : 'term_cancelled');
    const moved = await patchJob(row.id, {
      // Work already done was held, not billed: it must reach the office.
      status: visit ? 'cancelled_after_visit' : 'cancelled_before_visit',
      reason,
      ...(visit ? { performed_visit_id: visit.id, customer_id: invoice.customer_id } : {}),
      resolved_at: now.toISOString(),
      resolved_by: 'paf_release',
    }, whileAwaiting);
    return moved ? 'cancelled' : null;
  }
  if (settled || visit) {
    // Due date first, so the transition stays retryable until it lands: a
    // declined charge's pay link and follow-ups then age from after the
    // visit, never from the accept. A failure throws and leaves the job
    // awaiting for the next pass.
    if (!settled) {
      await db('invoices').where({ id: invoice.id }).where('status', 'draft').update({ due_date: etDateString(now) });
    }
    const released = await patchJob(row.id, {
      // created_at stays the accept time, so the sweep's 15-minute age
      // filter takes the job on this same pass.
      status: 'pending',
      released_at: now.toISOString(),
      released_for_visit_id: visit?.id || null,
    }, whileAwaiting);
    return released ? 'released' : null;
  }
  const since = new Date(job.authorized_at || job.created_at || 0);
  if (!job.stale_alert_reserved_at && now - since >= STALE_DAYS * 24 * 60 * 60 * 1000) {
    // Reserved atomically while still awaiting: a release racing this pass
    // either lands first (no reservation) or leaves a reservation the alert
    // pass will close.
    const reserved = await patchJob(row.id, { stale_alert_reserved_at: now.toISOString() },
      (q) => whileUnset('stale_alert_reserved_at')(whileAwaiting(q)));
    return reserved ? 'stale_reserved' : null;
  }
  return null;
}

async function raise(spec, dedupeKey) {
  const { raiseAdminAlert } = require('./admin-alert-compose');
  const result = await raiseAdminAlert('billing', { area: 'Billing', severity: 'needs-you', who: 'person', ...spec }, { dedupeKey });
  // notifyAdmin reports a failed write as null rather than throwing: only a
  // persisted row (or the office's own preference turning the bell off) may
  // be stamped as raised; anything else is retried next pass.
  if (!result || !(result.id || result.suppressed)) throw new Error(`alert ${dedupeKey} was not persisted`);
}

async function close(key, resolution) {
  await require('./admin-alert-episodes').closeAdminAlertKeys(db, [key], 'resolved', { resolution });
}

// Bring one job's office alerts in line with its state. Every step stamps
// only after the external call succeeded, so a failure is redone next pass.
async function reconcileJobAlerts(estimateId) {
  const row = await db('estimates').where({ id: estimateId }).first('estimate_data');
  const job = parseData(row?.estimate_data)?.prepayAutoChargeJob;
  if (!job || job.deferred_to_first_visit !== true) return;
  const nowIso = new Date().toISOString();

  // R8: no first visit.
  if (job.stale_alert_reserved_at && !job.stale_alert_closed_at) {
    if (job.status === AWAITING) {
      if (!job.stale_alert_raised_at) {
        await raise({
          action: 'Check an annual prepay with no first visit',
          why: `Approved ${STALE_DAYS}+ days ago; the card is charged only after the first visit, and none was performed.`,
          link: `/admin/invoices?invoice=${job.invoice_id}`,
          subject: { type: 'estimate', id: String(estimateId) },
          doneWhen: 'first_visit_performed',
        }, staleAlertKey(estimateId));
        await patchJob(estimateId, { stale_alert_raised_at: nowIso }, whileUnset('stale_alert_raised_at'));
      }
    } else {
      await close(staleAlertKey(estimateId), 'The annual prepay no longer waits for a first visit.');
      await patchJob(estimateId, { stale_alert_closed_at: nowIso });
    }
  }

  // R2: the charge after the first visit failed and the pay link went out.
  if (job.status === 'delivered_fallback' && !job.charge_alert_closed_at) {
    const invoice = await db('invoices').where({ id: job.invoice_id }).first('status');
    const invStatus = String(invoice?.status || '').toLowerCase();
    const stillOwed = !!invoice && !SETTLED_INVOICE_STATUSES.includes(invStatus) && !DEAD_INVOICE_STATUSES.includes(invStatus);
    if (stillOwed && !job.charge_alert_raised_at) {
      await raise({
        action: 'Collect an annual prepay that failed after visit 1',
        why: 'The card charge after the first visit failed; the pay link went out and later visits are held, not billed.',
        link: `/admin/invoices?invoice=${job.invoice_id}`,
        subject: { type: 'invoice', id: String(job.invoice_id) },
        doneWhen: 'invoice_paid',
      }, chargeAlertKey(estimateId));
      await patchJob(estimateId, { charge_alert_raised_at: nowIso }, whileUnset('charge_alert_raised_at'));
    } else if (!stillOwed) {
      if (job.charge_alert_raised_at) await close(chargeAlertKey(estimateId), 'The annual prepay invoice settled or was closed.');
      await patchJob(estimateId, { charge_alert_closed_at: nowIso });
    }
  }

  // The first visit was done, then the year was voided or cancelled before it
  // was charged: that visit was held, not billed.
  if (job.status === 'cancelled_after_visit' && !job.unbilled_alert_raised_at) {
    await raise({
      action: 'Bill a visit done before the prepay was cancelled',
      why: 'The first visit was done, then the annual prepay was cancelled before it was charged; that visit is unbilled.',
      link: job.customer_id ? `/admin/customers?customerId=${job.customer_id}` : `/admin/invoices?invoice=${job.invoice_id}`,
      subject: { type: 'visit', id: String(job.performed_visit_id) },
      doneWhen: 'visit_billed',
    }, unbilledAlertKey(estimateId));
    await patchJob(estimateId, { unbilled_alert_raised_at: nowIso }, whileUnset('unbilled_alert_raised_at'));
  }
}

// Jobs with alert work outstanding, page by page (keyset on id).
async function reconcileAlerts({ pageSize = 200 } = {}) {
  let afterId = null;
  let checked = 0;
  for (;;) {
    let rows = [];
    try {
      rows = await db('estimates')
        .whereRaw(`(${JOB} ->> 'deferred_to_first_visit') = 'true'`)
        .whereRaw(`(
          (${JOB} ->> 'stale_alert_reserved_at' IS NOT NULL AND ${JOB} ->> 'stale_alert_closed_at' IS NULL)
          OR (${JOB} ->> 'status' = 'delivered_fallback' AND ${JOB} ->> 'charge_alert_closed_at' IS NULL)
          OR (${JOB} ->> 'status' = 'cancelled_after_visit' AND ${JOB} ->> 'unbilled_alert_raised_at' IS NULL)
        )`)
        .modify((q) => { if (afterId) q.where('id', '>', afterId); })
        .orderBy('id', 'asc')
        .limit(pageSize)
        .select('id');
    } catch (err) {
      logger.warn(`[paf-prepay] alert scan failed: ${err.message}`);
      return checked;
    }
    for (const row of rows) {
      try {
        await reconcileJobAlerts(row.id);
        checked += 1;
      } catch (err) {
        logger.warn(`[paf-prepay] alert reconcile failed for estimate ${row.id} (retried next pass): ${err.message}`);
      }
    }
    if (rows.length < pageSize) return checked;
    afterId = rows[rows.length - 1].id;
  }
}

// Every awaiting job is visited on each pass, page by page (keyset on id):
// jobs that stay waiting (no visit yet) never crowd a newer performed one out.
async function releaseDeferredPrepayCharges({ pageSize = 200, now = new Date() } = {}) {
  const summary = { scanned: 0, released: 0, cancelled: 0, staleReserved: 0, alertsChecked: 0 };
  let afterId = null;
  for (;;) {
    let rows = [];
    try {
      rows = await db('estimates')
        .where({ status: 'accepted' })
        .whereRaw(`(${JOB} ->> 'status') = ?`, [AWAITING])
        .modify((q) => { if (afterId) q.where('id', '>', afterId); })
        .orderBy('id', 'asc')
        .limit(pageSize)
        .select('id', 'estimate_data');
    } catch (err) {
      logger.warn(`[paf-prepay] awaiting-job scan failed: ${err.message}`);
      break;
    }
    summary.scanned += rows.length;
    for (const row of rows) {
      try {
        const outcome = await releaseOne(row, now);
        if (outcome === 'released') summary.released += 1;
        else if (outcome === 'cancelled') summary.cancelled += 1;
        else if (outcome === 'stale_reserved') summary.staleReserved += 1;
      } catch (err) {
        logger.warn(`[paf-prepay] release check failed for estimate ${row.id} (retried next pass): ${err.message}`);
      }
    }
    if (rows.length < pageSize) break;
    afterId = rows[rows.length - 1].id;
  }
  summary.alertsChecked = await reconcileAlerts();
  return summary;
}

module.exports = {
  AWAITING,
  STALE_DAYS,
  releaseDeferredPrepayCharges,
  reconcileAlerts,
  staleAlertKey,
  chargeAlertKey,
  unbilledAlertKey,
};
