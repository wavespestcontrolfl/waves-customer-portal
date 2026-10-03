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
const UNFINISHED_COMPLETION_STATUSES = ['pending', 'side_effects_pending', 'side_effects_running'];
const JOB = "estimate_data -> 'prepayAutoChargeJob'";

const staleAlertKey = (estimateId) => `paf-prepay-no-first-visit:${estimateId}`;
// A returned bank payment on the pay link reopens the year: each such round
// raises under its own key so the comeback rings again.
const chargeAlertKey = (estimateId, round = 0) => `paf-prepay-charge-failed:${estimateId}${round ? `:${round}` : ''}`;
const unbilledAlertKey = (estimateId) => `paf-prepay-cancelled-after-visit:${estimateId}`;

function parseData(raw) {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return raw && typeof raw === 'object' ? raw : null;
}

// Merge `patch` into the job; `guard` adds the compare-and-swap conditions.
// Returns true when this caller's write landed.
async function patchJob(estimateId, patch, guard = (q) => q, conn = db) {
  const rows = await guard(conn('estimates').where({ id: estimateId })).update({
    estimate_data: conn.raw(
      "jsonb_set(estimate_data, '{prepayAutoChargeJob}', (estimate_data -> 'prepayAutoChargeJob') || ?::jsonb)",
      [JSON.stringify(patch)],
    ),
  });
  return rows === 1;
}
const whileAwaiting = (q) => q.whereRaw(`${JOB} ->> 'status' = ?`, [AWAITING]);
const whileUnset = (key) => (q) => q.whereRaw(`${JOB} ->> '${key}' IS NULL`);

// The first performed visit the year HELD: completion stamped it with the
// term at closeout (paf_held_term_id, owner ruling 2026-10-02). A visit
// outside the year's coverage billed on its own, was never stamped, and never
// stands in for the first visit of the year.
async function firstPerformedVisit(estimateId, customerId, termId) {
  if (!termId) return null;
  const candidates = await performedVisitCandidates(estimateId, customerId);
  return candidates.find((v) => String(v.paf_held_term_id || '') === String(termId)) || null;
}

async function performedVisitCandidates(estimateId, customerId) {
  return db('scheduled_services as s')
    .leftJoin('scheduled_services as p', 'p.id', 's.recurring_parent_id')
    .join('service_records as r', 'r.scheduled_service_id', 's.id')
    .where('s.customer_id', customerId)
    .where((q) => q.where('s.source_estimate_id', estimateId).orWhere('p.source_estimate_id', estimateId))
    .where('s.status', 'completed')
    .where('r.status', 'completed')
    // The visit's CURRENT closeout only: a fresh closeout writes a new record,
    // so a visit reopened and closed again (inspection only, declined) is
    // judged by that, never an older performed record (pre-push audit P0).
    .whereRaw(`r.id = (
      SELECT r2.id FROM service_records r2
      WHERE r2.scheduled_service_id = s.id
      ORDER BY r2.created_at DESC, r2.id DESC LIMIT 1
    )`)
    .whereRaw("COALESCE(r.structured_notes ->> 'visitOutcome', '') <> ALL(?::text[])", [NOT_PERFORMED_OUTCOMES])
    // A quiet backfill closeout (backdated, every charge and send suppressed)
    // never releases a charge (waves-billing: backfill suppresses every money
    // path); the office bills that work itself.
    .whereRaw("COALESCE(r.structured_notes ->> 'backfill', '') <> 'true'")
    // Completion's own billing must have finished first: a completion still
    // resuming its side effects decides the visit's bill from the deferred
    // hold, which a release (then an active term) would pull out from under it.
    // An attempt abandoned past the stale window (a crash) no longer hides its
    // visit: the same window planHasUnfinishedCompletion uses, so a held visit
    // a crashed closeout already stamped still releases the year or reaches
    // the office (pre-push audit P1).
    .whereNotExists(function unfinishedCompletion() {
      this.select(db.raw('1')).from('service_completion_attempts as a')
        .whereRaw('a.service_id = s.id')
        .whereIn('a.status', UNFINISHED_COMPLETION_STATUSES)
        .where('a.updated_at', '>=', new Date(Date.now() - require('./completion-attempts').STALE_SIDE_EFFECTS_MS));
    })
    .orderBy('s.scheduled_date', 'asc')
    .select('s.*');
}

// An attempt untouched past the completion-attempt stale window was abandoned
// (a crash before it committed or finished): it never blocks the release
// forever (GitHub Codex #5567 r15). A resumed one stamps its visit, and the
// stamp or the activated-year check keeps it covered either way.
async function planHasUnfinishedCompletion(estimateId, customerId) {
  const staleCutoff = new Date(Date.now() - require('./completion-attempts').STALE_SIDE_EFFECTS_MS);
  const row = await db('service_completion_attempts as a')
    .join('scheduled_services as s', 's.id', 'a.service_id')
    .leftJoin('scheduled_services as p', 'p.id', 's.recurring_parent_id')
    .where('s.customer_id', customerId)
    .where((q) => q.where('s.source_estimate_id', estimateId).orWhere('p.source_estimate_id', estimateId))
    .whereIn('a.status', UNFINISHED_COMPLETION_STATUSES)
    .where('a.updated_at', '>=', staleCutoff)
    .first('a.id');
  return !!row;
}

// The released visit still stands as performed: completed, and its CURRENT
// closeout record is a performed, non-backfill one (pre-push audit P0). The
// sweep re-checks this before charging a job released earlier.
async function visitStillPerformed(visitId, heldTermId = null) {
  if (!visitId) return false;
  const visit = await db('scheduled_services').where({ id: visitId }).first('status', 'paf_held_term_id');
  if (String(visit?.status || '') !== 'completed') return false;
  // …and still held by this year: a re-closeout paid another way, payer-billed
  // or outside the coverage cleared the stamp (pre-push audit P0).
  if (heldTermId != null && String(visit.paf_held_term_id || '') !== String(heldTermId)) return false;
  const record = await db('service_records').where({ scheduled_service_id: visitId })
    .orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }]).first('status', 'structured_notes');
  if (!record || String(record.status || '') !== 'completed') return false;
  const notes = parseData(record.structured_notes) || {};
  return !NOT_PERFORMED_OUTCOMES.includes(String(notes.visitOutcome || '')) && String(notes.backfill || '') !== 'true';
}

// The released / failed-charge visit, if it is still work the dead year held:
// performed by its current closeout and still stamped with that year's term.
// Any other performed visit the year still holds counts too: after a decline
// later visits stay held, so the released one being paid another way does not
// mean no work is owed (pre-push audit P1).
async function stillHeldVisit(estimateId, invoiceId, visitId) {
  const term = await db('annual_prepay_terms')
    .where(invoiceId ? { prepay_invoice_id: invoiceId } : { source_estimate_id: estimateId }).first('id', 'customer_id')
    || await db('annual_prepay_terms').where({ source_estimate_id: estimateId }).first('id', 'customer_id');
  if (!term) return null;
  if (visitId && await visitStillPerformed(visitId, term.id)) return visitId;
  return (await firstPerformedVisit(estimateId, term.customer_id, term.id))?.id || null;
}

// A term that still carries paid coverage by the canonical rules (a paid year
// cancelled to end at term rides out its window; a refund or void does not).
async function termStillCovered(termId, conn = db) {
  if (!termId) return false;
  return !!(await require('./annual-prepay-renewals').coveredTermsAsOf(conn).where('t.id', termId).first('t.id'));
}

async function releaseOne(row, now) {
  const job = parseData(row.estimate_data)?.prepayAutoChargeJob;
  if (!job || job.status !== AWAITING || !job.invoice_id) return null;
  const invoice = await db('invoices').where({ id: job.invoice_id }).first('id', 'status', 'customer_id', 'payment_method');
  const invStatus = String(invoice?.status || '').toLowerCase();
  const term = invoice
    ? await db('annual_prepay_terms').where({ prepay_invoice_id: invoice.id }).first('id', 'status')
    : null;
  // A cancelled term is dead unless it still carries paid coverage by the
  // canonical rules (coveredTermsAsOf: a decided end-at-term lapse riding out
  // a paid window). A void / full refund cancellation is dead (GitHub Codex
  // #5656 r1).
  const dead = !invoice || DEAD_INVOICE_STATUSES.includes(invStatus)
    || (String(term?.status || '') === 'cancelled' && !(await termStillCovered(term.id)));
  // Settled before any visit = paid, or a BANK debit already initiated. A card
  // intent parked 'processing' is incomplete (the sweep treats it so): it
  // never releases the job before the first visit.
  const settled = !dead && (['paid', 'prepaid'].includes(invStatus)
    || (invStatus === 'processing' && String(invoice.payment_method || '') === 'us_bank_account'));
  if (dead) {
    // The year is dead, so nothing is held any more: a performed visit the
    // year HELD is work done while it was pending, for the office to bill. A
    // callback, a visit past the sold count or a price-drifted visit was
    // never held — it billed on its own (Codex r8).
    // A deleted invoice row also clears the term's prepay_invoice_id (FK), so
    // the term is found by its estimate then (GitHub Codex #5567 r9).
    // A closeout still finishing may already have held its visit: wait for it
    // before the terminal classification (pre-push audit P1).
    const deadCustomerForWait = invoice?.customer_id
      || (await db('annual_prepay_terms').where({ source_estimate_id: row.id }).first('customer_id'))?.customer_id || null;
    if (deadCustomerForWait && await planHasUnfinishedCompletion(row.id, deadCustomerForWait)) return null;
    let visit = null;
    const deadTerm = await db('annual_prepay_terms')
      .where(invoice ? { prepay_invoice_id: invoice.id } : { source_estimate_id: row.id }).first('*');
    const deadCustomerId = invoice?.customer_id || deadTerm?.customer_id || null;
    if (deadTerm && deadCustomerId) {
      // Only work the year HELD (stamped at closeout): a visit billed on its
      // own, or paid another way, was never stamped (GitHub Codex #5567 r10).
      visit = await firstPerformedVisit(row.id, deadCustomerId, deadTerm.id);
    }
    const reason = !invoice ? 'invoice_missing' : (DEAD_INVOICE_STATUSES.includes(invStatus) ? `invoice_${invStatus}` : 'term_cancelled');
    const moved = await patchJob(row.id, {
      // Work already done was held, not billed: it must reach the office.
      status: visit ? 'cancelled_after_visit' : 'cancelled_before_visit',
      reason,
      ...(visit ? { performed_visit_id: visit.id, customer_id: deadCustomerId } : {}),
      resolved_at: now.toISOString(),
      resolved_by: 'paf_release',
    }, whileAwaiting);
    return moved ? 'cancelled' : null;
  }
  const visit = await firstPerformedVisit(row.id, invoice.customer_id, term?.id);
  // Never release while ANY visit of the plan is still finishing its
  // completion (pre-push audit P0): that visit decided its bill from the hold,
  // and the charge and activation this release leads to would end the hold
  // under it, so a resumed completion could bill beside the paid year. The
  // next pass releases once every completion has finished.
  if (visit && !settled && await planHasUnfinishedCompletion(row.id, invoice.customer_id)) return null;
  if (settled || visit) {
    // Due date first, so the transition stays retryable until it lands: a
    // declined charge's pay link and follow-ups then age from after the
    // visit, never from the accept. A failure throws and leaves the job
    // awaiting for the next pass.
    // Under the invoice's row lock, re-read: a year voided or cancelled since
    // the reads above must take the cancel branch on the next pass (so held
    // work reaches the office), never be released into a charge that skips.
    return db.transaction(async (trx) => {
      const locked = await trx('invoices').where({ id: invoice.id }).forUpdate().first('status', 'payment_method');
      const lockedTerm = await trx('annual_prepay_terms').where({ prepay_invoice_id: invoice.id }).first('id', 'status');
      const lockedStatus = String(locked?.status || '').toLowerCase();
      if (!locked || DEAD_INVOICE_STATUSES.includes(lockedStatus)
        || (String(lockedTerm?.status || '') === 'cancelled' && !(await termStillCovered(lockedTerm.id, trx)))) return null;
      // Settlement as the LOCKED row shows it: a bank debit returned since
      // the first read is no longer settled, and then only a performed visit
      // may release the charge.
      const lockedSettled = ['paid', 'prepaid'].includes(lockedStatus)
        || (lockedStatus === 'processing' && String(locked.payment_method || '') === 'us_bank_account');
      if (!lockedSettled && !visit) return null;
      if (!lockedSettled && lockedStatus === 'draft') {
        await trx('invoices').where({ id: invoice.id }).update({ due_date: etDateString(now) });
      }
      const released = await patchJob(row.id, {
        // created_at stays the accept time, so the sweep's 15-minute age
        // filter takes the job on this same pass.
        status: 'pending',
        released_at: now.toISOString(),
        released_for_visit_id: visit?.id || null,
        // The sweep's payer checks (in-lock self-pay guard, re-route) judge the
        // visit that actually released the charge: a visit-specific payer on
        // it routes the year to that payer, never the homeowner's card.
        ...(visit ? { payer_scope_scheduled_service_id: visit.id } : {}),
      }, whileAwaiting, trx);
      return released ? 'released' : null;
    });
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
    const invoice = await db('invoices').where({ id: job.invoice_id }).first('status', 'payment_method');
    const invStatus = String(invoice?.status || '').toLowerCase();
    // Tender-aware (the sweep's own classifier): only paid / prepaid or an
    // initiated BANK debit is settled. A card intent parked 'processing' is
    // unfinished — leave the alert as it is until reconciliation decides.
    const outcome = invoice ? require('./recurring-card-on-file').classifySavedMethodChargeInvoice(invoice) : 'unexpected';
    const round = Number(job.charge_alert_round) || 0;
    const dead = !invoice || DEAD_INVOICE_STATUSES.includes(invStatus);
    if (dead) {
      // The year died unpaid after its charge failed: the first visit (and any
      // visit held since) was never billed. Close the collection alert and
      // hand the work to the unbilled-visits alert, like a cancel after the
      // visit.
      await close(chargeAlertKey(estimateId, round), 'The annual prepay invoice was closed unpaid.');
      // The customer comes from the held visit when the invoice row is gone,
      // so the office alert links to the customer (GitHub Codex #5567 r16).
      // Only a visit still performed and still stamped by this year is work to
      // bill: one re-closed paid another way, payer-billed or outside the
      // coverage is not (GitHub Codex #5567 r18).
      const heldVisitId = await stillHeldVisit(estimateId, job.invoice_id, job.performed_visit_id || job.released_for_visit_id || null);
      const heldCustomerId = job.customer_id
        || (heldVisitId ? (await db('scheduled_services').where({ id: heldVisitId }).first('customer_id'))?.customer_id : null)
        || null;
      await patchJob(estimateId, {
        charge_alert_closed_at: nowIso,
        status: heldVisitId ? 'cancelled_after_visit' : 'cancelled_before_visit',
        reason: `invoice_${invStatus || 'missing'}_after_failed_charge`,
        performed_visit_id: heldVisitId,
        ...(heldCustomerId ? { customer_id: heldCustomerId } : {}),
      }, (q) => q.whereRaw(`${JOB} ->> 'status' = 'delivered_fallback'`));
    } else if (outcome === 'paid') {
      // Closed whether or not the raised stamp landed: a raise that persisted
      // just before a failed stamp must not stay open. Closing a key with no
      // alert is a no-op.
      await close(chargeAlertKey(estimateId, round), 'The annual prepay invoice settled or was closed.');
      await patchJob(estimateId, { charge_alert_closed_at: nowIso });
    } else if (outcome === 'bank_processing') {
      // A bank payment is under way: close the alert (whether or not its
      // raised stamp landed) and start a new round once per processing
      // episode; keep watching — a returned debit reopens the invoice and the
      // new round's alert rings.
      await close(chargeAlertKey(estimateId, round), 'A bank payment for the annual prepay is processing.');
      if (job.charge_alert_processing_round !== round) {
        await patchJob(estimateId, { charge_alert_raised_at: null, charge_alert_round: round + 1, charge_alert_processing_round: round + 1 });
      }
    } else if (outcome === 'unexpected' && !job.charge_alert_raised_at) {
      // Still owed (a card intent parked 'processing' is left alone until
      // reconciliation decides).
      await raise({
        action: 'Collect an annual prepay that failed after visit 1',
        why: 'The card charge after the first visit failed; the pay link went out and later visits are held, not billed.',
        link: `/admin/invoices?invoice=${job.invoice_id}`,
        subject: { type: 'invoice', id: String(job.invoice_id) },
        doneWhen: 'invoice_paid',
      }, chargeAlertKey(estimateId, round));
      await patchJob(estimateId, { charge_alert_raised_at: nowIso, charge_alert_processing_round: null }, whileUnset('charge_alert_raised_at'));
    }
  }

  // A released year the sweep resolved 'skipped' (handed to a payer, or found
  // voided before it charged) still had its first visit held unbilled. If the
  // year then dies unpaid, that work goes to the unbilled-visits alert below;
  // once it is paid, the check is done.
  // Same for a released year whose bank debit was initiated ('processing'):
  // a debit that returns, then a voided year, must still hand the held visit
  // to the office (pre-push audit P1).
  const releasedHolders = ['skipped', 'processing'];
  if (releasedHolders.includes(job.status) && job.released_for_visit_id && !job.unbilled_check_done_at) {
    const invoice = await db('invoices').where({ id: job.invoice_id }).first('status');
    const invStatus = String(invoice?.status || '').toLowerCase();
    if (!invoice || DEAD_INVOICE_STATUSES.includes(invStatus)) {
      const releasedHeldId = await stillHeldVisit(estimateId, job.invoice_id, job.released_for_visit_id);
      const releasedCustomerId = job.customer_id
        || (await db('scheduled_services').where({ id: job.released_for_visit_id }).first('customer_id'))?.customer_id || null;
      await patchJob(estimateId, {
        status: releasedHeldId ? 'cancelled_after_visit' : 'cancelled_before_visit',
        reason: `invoice_${invStatus || 'missing'}_after_release`,
        performed_visit_id: releasedHeldId,
        ...(releasedCustomerId ? { customer_id: releasedCustomerId } : {}),
      }, (q) => q.whereRaw(`${JOB} ->> 'status' = ?`, [job.status]));
      return;
    }
    if (['paid', 'prepaid'].includes(invStatus)) {
      await patchJob(estimateId, { unbilled_check_done_at: nowIso });
    }
  }

  // The first visit was done, then the year was voided or cancelled before it
  // was charged: that visit was held, not billed.
  if (job.status === 'cancelled_after_visit' && !job.unbilled_alert_raised_at) {
    await raise({
      action: 'Bill visits done before the prepay was cancelled',
      why: 'The annual prepay was cancelled before it was paid; visits done while it was pending were not billed.',
      link: job.customer_id ? `/admin/customers?customerId=${job.customer_id}` : `/admin/invoices?invoice=${job.invoice_id}`,
      subject: job.performed_visit_id
        ? { type: 'visit', id: String(job.performed_visit_id) }
        : { type: 'estimate', id: String(estimateId) },
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
          OR (${JOB} ->> 'status' IN ('skipped', 'processing') AND ${JOB} ->> 'released_for_visit_id' IS NOT NULL
              AND ${JOB} ->> 'unbilled_check_done_at' IS NULL)
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

// A deferred job resolved 'processing' is an initiated bank debit. When the
// bank returns it, the payment-failed webhook reopens the invoice but nothing
// touches the job, which would otherwise keep the plan's visits held forever.
// Re-arm it to 'pending' with charge_returned: the sweep then skips any
// re-debit (no automatic retry, owner R2) and goes straight to the pay link,
// and the R2 alert follows from 'delivered_fallback'.
async function rearmReturnedDebits({ pageSize = 200 } = {}) {
  let afterId = null;
  let rearmed = 0;
  for (;;) {
    let rows = [];
    try {
      rows = await db('estimates')
        .whereRaw(`(${JOB} ->> 'deferred_to_first_visit') = 'true'`)
        .whereRaw(`(${JOB} ->> 'status') = 'processing'`)
        .modify((q) => { if (afterId) q.where('id', '>', afterId); })
        .orderBy('id', 'asc')
        .limit(pageSize)
        .select('id', 'estimate_data');
    } catch (err) {
      logger.warn(`[paf-prepay] processing-job scan failed: ${err.message}`);
      return rearmed;
    }
    for (const row of rows) {
      try {
        const job = parseData(row.estimate_data)?.prepayAutoChargeJob;
        const invoice = job?.invoice_id ? await db('invoices').where({ id: job.invoice_id }).first('status', 'payment_method') : null;
        const invStatus = String(invoice?.status || '').toLowerCase();
        // Still processing, settled, or dead: nothing to re-arm.
        if (!invoice || ['processing', 'paid', 'prepaid'].includes(invStatus) || DEAD_INVOICE_STATUSES.includes(invStatus)) continue;
        const moved = await patchJob(row.id, { status: 'pending', charge_returned: true, claim_token: null, claimed_at: null },
          (q) => q.whereRaw(`${JOB} ->> 'status' = 'processing'`));
        if (moved) rearmed += 1;
      } catch (err) {
        logger.warn(`[paf-prepay] returned-debit check failed for estimate ${row.id} (retried next pass): ${err.message}`);
      }
    }
    if (rows.length < pageSize) return rearmed;
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
  summary.rearmed = await rearmReturnedDebits();
  summary.alertsChecked = await reconcileAlerts();
  return summary;
}

// The first-visit completion text (owner ruling 2026-10-03, neutral wording):
// this visit is the FIRST performed visit held by a year that is still unpaid.
// Completion stamped it (paf_held_term_id) just before the text; any earlier
// performed visit stamped by the same year already had its first visit.
async function isFirstHeldVisitOfUnpaidYear(svc, conn = db) {
  if (!svc?.paf_held_term_id || !svc.customer_id) return false;
  const term = await conn('annual_prepay_terms').where({ id: svc.paf_held_term_id }).first('id', 'status', 'source_estimate_id');
  if (!term || String(term.status || '') !== 'payment_pending' || !term.source_estimate_id) return false;
  // The payment must still be waiting for the visit: a year settled, or with
  // its ACH payment started, before the first visit keeps the regular text
  // even while the term reads payment_pending (GitHub Codex #5640 r13).
  const estimate = await conn('estimates').where({ id: term.source_estimate_id }).first('estimate_data');
  const job = parseData(estimate?.estimate_data)?.prepayAutoChargeJob;
  if (!job || job.deferred_to_first_visit !== true || ![AWAITING, 'pending'].includes(String(job.status || ''))) return false;
  const invoice = job.invoice_id ? await conn('invoices').where({ id: job.invoice_id }).first('status') : null;
  const invStatus = String(invoice?.status || '');
  if (!invoice || ['processing', 'paid', 'prepaid'].includes(invStatus) || DEAD_INVOICE_STATUSES.includes(invStatus)) return false;
  // A visit that already claimed the text keeps it on a retry, even when
  // another held visit finished in between (GitHub Codex #5640 r13).
  if (String(job.first_visit_text_visit_id || '') === String(svc.id)) return true;
  const others = (await performedVisitCandidates(term.source_estimate_id, svc.customer_id))
    .filter((v) => String(v.id) !== String(svc.id) && String(v.paf_held_term_id || '') === String(term.id));
  if (others.length) return false;
  // Two held visits closing at once both see no other performed visit; one
  // atomic claim on the year's job picks exactly one (a retry of the same
  // visit keeps it). GitHub Codex #5640 r12.
  const claimed = await conn('estimates')
    .where({ id: term.source_estimate_id })
    .whereRaw(`${JOB} ->> 'deferred_to_first_visit' = 'true'`)
    .whereRaw(`coalesce(${JOB} ->> 'first_visit_text_visit_id', ?) = ?`, [String(svc.id), String(svc.id)])
    .update({
      estimate_data: conn.raw(
        "jsonb_set(estimate_data, '{prepayAutoChargeJob}', (estimate_data -> 'prepayAutoChargeJob') || ?::jsonb)",
        [JSON.stringify({ first_visit_text_visit_id: String(svc.id) })],
      ),
    });
  return claimed === 1;
}

module.exports = {
  isFirstHeldVisitOfUnpaidYear,
  AWAITING,
  planHasUnfinishedCompletion,
  termStillCovered,
  visitStillPerformed,
  STALE_DAYS,
  releaseDeferredPrepayCharges,
  reconcileAlerts,
  staleAlertKey,
  chargeAlertKey,
  unbilledAlertKey,
};
