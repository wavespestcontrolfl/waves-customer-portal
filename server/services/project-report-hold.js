/**
 * WDO report hold: "your report is sent once payment is received".
 * Gate: GATE_WDO_REPORT_HOLD (wdoReportHoldLive) governs CREATING holds in
 * send-with-invoice. Releases always run.
 *
 * A held WDO report is parked on the projects row (report_hold_* columns,
 * migration 20260715000010): held -> releasing -> released. This sweep is the
 * single automatic release path:
 *
 *   1. Recover stale 'releasing' claims (a crashed release) back to 'held'.
 *   2. Find held projects whose linked invoice is SETTLED: 'paid', or
 *      credit-covered 'prepaid'. An ACH 'processing' invoice does not
 *      release, and neither does a part payment. Then deliver each through
 *      releaseHeldProjectReport (routes/admin-projects.js). That function
 *      owns the WDO send steps: signature checks, FDACS PDF, filing archive,
 *      customer email, realtor copies and text.
 *
 * The 60-second interval is the whole mechanism: every settlement path ends
 * in invoices.status, so no payment path needs to nudge it.
 *
 * A release that fails raises ONE admin bell (the first failure), then
 * retries with backoff. The attention sweep carries the stuck-hold reminder.
 */

const db = require('../models/db');
const { invoiceDepositCreditCents } = require('./invoice-helpers');
const logger = require('./logger');

const STALE_RELEASING_MINUTES = 10;
const SETTLED_INVOICE_STATUSES = ['paid', 'prepaid'];
const BELL_CATEGORY = 'wdo_report_hold';

// Failed release deliveries retry on the sweep with exponential backoff,
// capped at 6h. No terminal cap: a held report is a paid-for legal document,
// so it keeps retrying (visibly: last_error shows in the drawer) until it
// delivers or the office sends it with Send report.
function reportHoldBackoffMinutes(attempts) {
  return Math.min(360, 5 * Math.pow(2, Math.max(0, attempts - 1)));
}

const bellKey = (projectId) => `wdo-report-hold-release:${projectId}`;

async function recoverStaleReleasingClaims() {
  return db('projects')
    .where({ report_hold_status: 'releasing' })
    .where('report_hold_locked_at', '<', db.raw(`now() - interval '${STALE_RELEASING_MINUTES} minutes'`))
    // The shared delivery lease too: a release still renewing it (updated_at) is alive, so recovery leaves it alone.
    .where('updated_at', '<', db.raw(`now() - interval '${STALE_RELEASING_MINUTES} minutes'`))
    .update({
      report_hold_status: 'held',
      report_hold_locked_at: null,
      report_hold_next_attempt_at: db.fn.now(),
      // A release that never finished is a failed attempt: it counts toward the stuck-hold bucket and the drawer
      // shows why, so a report that crashes every time cannot retry unseen for ever.
      report_hold_attempts: db.raw('coalesce(report_hold_attempts, 0) + 1'),
      report_hold_last_error: 'The last automatic send did not finish. It retries by itself.',
      // The release took the shared send claim; a crashed release must give it back.
      delivery_status: db.raw("CASE WHEN delivery_status = 'sending' THEN 'failed' ELSE delivery_status END"),
      delivery_claim_token: null,
      updated_at: db.fn.now(),
    })
    .catch((err) => {
      // Pre-migration environments have no hold columns: the sweep is a no-op.
      if (!/column .*report_hold/i.test(err.message)) {
        logger.warn(`[report-hold] stale-claim recovery failed: ${err.message}`);
      }
      return 0;
    });
}

async function findDueHeldProjectIds(limit) {
  try {
    const rows = await db('projects as p')
      .join('invoices as i', 'p.invoice_id', 'i.id')
      .where('p.report_hold_status', 'held')
      .whereIn('i.status', SETTLED_INVOICE_STATUSES)
      .where(function dueNow() {
        this.whereNull('p.report_hold_next_attempt_at')
          .orWhere('p.report_hold_next_attempt_at', '<=', db.fn.now());
      })
      .orderBy('p.report_hold_at', 'asc')
      .limit(limit)
      .select('p.id');
    return rows.map((r) => r.id);
  } catch (err) {
    if (!/column .*report_hold|relation .*invoices/i.test(err.message)) {
      logger.warn(`[report-hold] due-scan failed: ${err.message}`);
    }
    return [];
  }
}

async function sweepHeldReportReleases({ limit = 5 } = {}) {
  const recovered = await recoverStaleReleasingClaims();
  const dueIds = await findDueHeldProjectIds(limit);

  let released = 0;
  let deferred = 0;
  for (const projectId of dueIds) {
    try {
      // Lazy require breaks the require cycle (admin-projects requires many
      // services at load; nothing may require this sweep from that graph).
      const { releaseHeldProjectReport } = require('../routes/admin-projects');
      const result = await releaseHeldProjectReport(projectId, { source: 'payment_sweep' });
      if (result?.released) released += 1;
      else deferred += 1;
    } catch (err) {
      deferred += 1;
      logger.error(`[report-hold] release failed for project ${projectId}: ${err.message}`);
    }
  }

  if (recovered || dueIds.length) {
    logger.info(`[report-hold] sweep: ${dueIds.length} due, ${released} released, ${deferred} deferred, ${recovered} stale claim(s) recovered`);
  }
  return { recovered, due: dueIds.length, released, deferred };
}

// A report is held (or being released) when its hold is live. ONE predicate: the sweep, the release, the
// closeout and the manual sends all read it.
const isReportHeld = (row) => ['held', 'releasing'].includes(String(row?.report_hold_status || ''));

// A report link is out of bounds for a hold when it may be in a customer's hands: sent through the portal, sent
// another way, a migrated historical delivery, shown on the portal, viewed, or ANY report token on the row (a closeout
// mints one that staff can copy and share, and nothing records that). A hold never replaces or clears a link: it
// refuses, fail closed, and the normal send keeps the link. A held report has no token; the release mints it.
// ONE predicate, in two forms (this one for rows already read, and the SQL twin the arming write carries), used by the
// drawer offer, the request refusal, the arming check and the stamp.
// (A held send writes delivery_status for its INVOICE, so only the migrated 'legacy_sent' marks a report.)
const REPORT_UNSHARED_SQL = "report_token IS NULL AND sent_at IS NULL AND sent_outside_portal_at IS NULL AND status IS DISTINCT FROM 'sent' AND report_viewed_at IS NULL AND portal_visible IS NOT TRUE AND delivery_status IS DISTINCT FROM 'legacy_sent'";
function reportLinkShared(project) {
  return Boolean(project.report_token || project.sent_at || project.sent_outside_portal_at || project.report_viewed_at || project.status === 'sent'
    || project.portal_visible === true || project.delivery_status === 'legacy_sent');
}

// Money on the invoice, of any kind, refuses a hold (409 hold_payment_started; the normal send is still available):
// a payment intent, a payments row (the ledger names the invoice under invoice_id, waves_invoice_id or a dispute's
// dispute_invoice_id), a charge attempt, a paid or recorded payment, credit or an estimate deposit already applied, or a status that says money moved. The invoice row
// is read whole, so a column this database lacks reads as absent.
const PAYMENT_STATUSES = ['processing', 'paid', 'prepaid', 'partial', 'partially_paid', 'refunded', 'disputed'];
async function assertNoPaymentStarted(invoice, database = db) {
  const id = String(invoice.id);
  const started = invoice.stripe_payment_intent_id || invoice.paid_at || invoice.payment_recorded_at
    || Number(invoice.amount_paid) > 0 || Number(invoice.credit_applied) > 0 || invoiceDepositCreditCents(invoice) > 0 || PAYMENT_STATUSES.includes(String(invoice.status || '').toLowerCase())
    || await database('payments')
      .whereRaw("(metadata->>'invoice_id' = ? OR metadata->>'waves_invoice_id' = ? OR metadata->>'dispute_invoice_id' = ?)", [id, id, id])
      .first('id')
    || await database('stripe_invoice_charge_attempts').where({ invoice_id: invoice.id }).first('id');
  if (started) {
    throw Object.assign(new Error('A payment was already started on this invoice, so the report cannot wait for it. Use the normal send.'), {
      holdRefusal: { status: 409, code: 'hold_payment_started' },
    });
  }
}

// Any account credit balance refuses a hold: the hold path never applies credit (credit could settle the invoice before
// the report is held). Fails closed: a balance that cannot be read counts as credit.
async function customerHasCredit(customerId, database = db) {
  try {
    const balance = await require('./customer-credit').getBalance(customerId, database);
    return balance === null || balance > 0;
  } catch {
    return true;
  }
}

// ONE bell for an invoice email whose outcome is unknown (an error after the provider may have taken it). The hold stays
// armed; staff check whether the customer got the invoice. One open row per project (dedupe key).
async function raiseInvoiceEmailUncertainBell({ project, customer, reason }) {
  try {
    const { raiseAdminAlert } = require('./admin-alert-compose');
    const { fitAction } = require('./admin-alert-names');
    const name = [customer?.first_name, customer?.last_name].filter(Boolean).join(' ').trim() || 'this customer';
    await raiseAdminAlert(BELL_CATEGORY, {
      area: 'Customers',
      action: fitAction('Customers', name, [
        (n) => `check ${n} got the WDO invoice`,
        (n) => `check ${n} got the invoice`,
      ]),
      why: 'The invoice email may not have arrived, and the report waits for payment.',
      severity: 'needs-you',
      link: `/admin/projects?projectId=${encodeURIComponent(project.id)}`,
      subject: { type: 'customer', id: String(project.customer_id || project.id) },
      doneWhen: 'report_sent',
      who: 'person',
    }, {
      bell: true,
      dedupeKey: invoiceEmailBellKey(project.id),
      detail: `The invoice email for this held WDO report ended with an error that may have come after the provider took it: ${String(reason || '').slice(0, 300)}. The report hold stays. Check that the customer got the invoice, and resend it if not.`,
      metadata: { projectId: String(project.id) },
    });
  } catch (err) {
    logger.error(`[report-hold] invoice-email bell not raised for ${project?.id}: ${err.message}`);
  }
}

// ONE bell for a failed release, on the first failure only: the dedupe key keeps
// one open row per project, and later retries never raise it again.
async function raiseReleaseFailedBell({ project, customer, reason }) {
  try {
    const { raiseAdminAlert } = require('./admin-alert-compose');
    const { fitAction } = require('./admin-alert-names');
    const name = [customer?.first_name, customer?.last_name].filter(Boolean).join(' ').trim() || 'this customer';
    const rung = await raiseAdminAlert(BELL_CATEGORY, {
      area: 'Customers',
      action: fitAction('Customers', name, [
        (n) => `send ${n} the paid WDO report`,
        (n) => `send ${n} the WDO report`,
        (n) => `send ${n} the report`,
      ]),
      // The reason (free text) goes in the detail; a copy rule would refuse some of it here.
      why: 'The invoice is paid but the held report did not send.',
      severity: 'needs-you',
      link: `/admin/projects?projectId=${encodeURIComponent(project.id)}`,
      subject: { type: 'customer', id: String(project.customer_id || project.id) },
      doneWhen: 'report_sent',
      who: 'person',
    }, {
      bell: true,
      dedupeKey: bellKey(project.id),
      detail: `The invoice for this WDO inspection is paid and the report is held. The automatic release failed: ${String(reason || '').slice(0, 500)}. It retries by itself with a growing wait. Open the project and press Send report to send it now.`,
      metadata: { projectId: String(project.id) },
    });
    // Recorded = a new row, or the open row this project's key already has (deduped). A muted or failed insert is not.
    return Boolean(rung && (rung.id || rung.deduped));
  } catch (err) {
    logger.error(`[report-hold] release-failed bell not raised for ${project?.id}: ${err.message}`);
    return false;
  }
}

// The uncertain-invoice-email bell's key: one per project.
function invoiceEmailBellKey(projectId) {
  return `wdo-report-hold-invoice-email:${projectId}`;
}

// The report went out: close both of this project's hold bells (a failed release, an invoice email of unknown
// outcome: once the report is sent nobody needs to check the invoice email any more). Best-effort.
async function closeReleaseFailedBell(projectId) {
  try {
    const episodes = require('./admin-alert-episodes');
    await episodes.closeAdminAlertKeys(db, [bellKey(projectId), invoiceEmailBellKey(projectId)], 'wdo_report_released', {
      resolution: 'The WDO report was sent.',
    });
  } catch (err) {
    logger.warn(`[report-hold] release-failed bell not closed for ${projectId}: ${err.message}`);
  }
}

// After a held invoice resend whose email was accepted: the "check the customer got the invoice" bell is answered.
async function closeInvoiceEmailBell(projectId) {
  try {
    await require('./admin-alert-episodes').closeAdminAlertKeys(db, [invoiceEmailBellKey(projectId)], 'wdo_invoice_email_delivered', {
      resolution: 'The invoice email was delivered.',
    });
  } catch (err) {
    logger.warn(`[report-hold] invoice email bell not closed for ${projectId}: ${err.message}`);
  }
}

// Read (and optionally FOR UPDATE lock) any project rows bound to an invoice.
// Always called AFTER locking `invoices`, preserving the canonical lock order
// (customers -> invoices -> projects) shared with armReportHold & release.
async function findWdoReportHoldStateForInvoice(conn, invoiceId, { lock = false } = {}) {
  const empty = { projects: [], releasing: null, released: null, held: [] };
  if (!invoiceId || !conn) return empty;
  try {
    const query = conn('projects').where({ invoice_id: invoiceId });
    if (lock && typeof query.forUpdate === 'function') query.forUpdate();
    const rows = await query.select(
      'id', 'status', 'project_type', 'report_hold_status',
      'report_hold_released_at', 'sent_at', 'sent_outside_portal_at',
    );
    const projects = Array.isArray(rows) ? rows : [];
    return {
      projects,
      releasing: projects.find((p) => p.report_hold_status === 'releasing') || null,
      released: projects.find((p) => p.report_hold_status === 'released' || p.report_hold_released_at != null) || null,
      held: projects.filter((p) => p.report_hold_status === 'held'),
    };
  } catch (err) {
    if (/column .*report_hold|relation .*projects/i.test(err.message)) return empty;
    throw err;
  }
}

// Refuse reversing a payment/prepaid settlement once the held WDO report is
// releasing or was already legally released and sent.
async function assertNoReleasedWdoReportHoldForInvoice(conn, invoiceId, { lock = false, action = 'undo', when = true } = {}) {
  if (!when) return null;
  const state = await findWdoReportHoldStateForInvoice(conn, invoiceId, { lock });
  if (state.releasing) {
    const err = new Error(
      action === 'reverse_prepaid'
        ? 'This invoice\'s held WDO report is being sent right now — wait a moment and refresh before reversing credit.'
        : 'The WDO report held for this invoice is being sent right now, so this payment cannot be undone here.',
    );
    err.statusCode = 409;
    err.isOperational = true;
    err.code = 'wdo_report_releasing';
    throw err;
  }
  if (state.released) {
    const err = new Error(
      action === 'reverse_prepaid'
        ? 'The WDO report held for this invoice was already released and sent, so its prepaid credit cannot be reversed here.'
        : 'The WDO report held for this invoice was already released and sent, so this payment cannot be undone here.',
    );
    err.statusCode = 409;
    err.isOperational = true;
    err.code = 'wdo_report_released';
    throw err;
  }
  return state;
}

async function closeClearedHoldBells(projectIds) {
  for (const projectId of projectIds || []) {
    await closeReleaseFailedBell(projectId);
  }
}

// Inside voidInvoice's transaction (after locking `invoices`):
// - Refuse while a held WDO report is actively releasing.
// - Refuse voiding a settled/prepaid WDO invoice whose held report was already released.
// - Reconcile any unpaid/unreleased 'held' project so it is not left stranded
//   silently pointing at a void invoice: open projects clear the hold and unlink
//   the void invoice; closed projects stamp an explicit error so the drawer
//   banner turns red and the attention sweep surfaces it immediately.
async function reconcileWdoReportHoldOnInvoiceVoid(trx, invoice, { priorStatus = null, priorPaidAt = null, priorPrepaidAt = null } = {}) {
  if (!invoice?.id) return { clearedProjectIds: [] };
  const state = await findWdoReportHoldStateForInvoice(trx, invoice.id, { lock: true });
  if (state.releasing) {
    const err = new Error('Cannot void this invoice — its held WDO report is being sent right now; wait a moment and retry');
    err.code = 'WDO_REPORT_RELEASE_IN_PROGRESS';
    err.statusCode = 409;
    throw err;
  }
  const wasSettled = ['paid', 'prepaid'].includes(String(priorStatus || '').toLowerCase()) || Boolean(priorPaidAt || priorPrepaidAt);
  if (wasSettled && state.released) {
    const err = new Error('Cannot void this prepaid invoice — its held WDO report was already released and sent');
    err.code = 'WDO_REPORT_ALREADY_RELEASED';
    err.statusCode = 409;
    throw err;
  }
  const nowValue = trx.fn?.now ? trx.fn.now() : new Date();
  const clearedProjectIds = [];
  for (const project of state.held) {
    const isClosed = project.status === 'closed';
    await trx('projects').where({ id: project.id, report_hold_status: 'held' }).update(
      isClosed
        ? {
          report_hold_next_attempt_at: null,
          report_hold_last_error: 'The linked invoice was voided; the report will not release automatically. Press Send report now to deliver it.',
          updated_at: nowValue,
        }
        : {
          report_hold_status: null,
          report_hold_at: null,
          report_hold_locked_at: null,
          report_hold_next_attempt_at: null,
          report_hold_attempts: 0,
          report_hold_last_error: null,
          report_token: null,
          invoice_id: null,
          updated_at: nowValue,
        },
    );
    if (!isClosed) clearedProjectIds.push(project.id);
    await require('./audit-log').recordAuditEvent({
      actor_type: 'system',
      action: isClosed ? 'wdo.report_hold_flagged_on_invoice_void' : 'wdo.report_hold_cleared_on_invoice_void',
      resource_type: 'project',
      resource_id: project.id,
      metadata: { invoiceId: String(invoice.id), projectStatus: project.status || null },
      critical: true,
      trx,
    });
  }
  return { clearedProjectIds };
}

// Whether a customer-facing service record belongs to a WDO project whose
// report payment hold is still active (held or releasing). Checks the live
// projects row so legacy records closed while held stay gated until released,
// and records immediately unlock once payment releases the report. Zero DB
// queries for non-WDO / non-project service records.
async function isServiceRecordProjectReportHeld(structuredNotes, database = db, { serviceRecordId = null } = {}) {
  const notes = structuredNotes && typeof structuredNotes === 'object' ? structuredNotes : {};
  const isWdoProject = notes.projectType === 'wdo_inspection' || notes.reportHeld === true;
  const projectId = notes.projectId || null;
  if (isWdoProject && projectId) {
    try {
      const row = await database('projects').where({ id: projectId }).first('report_hold_status');
      if (row && 'report_hold_status' in row) return isReportHeld(row);
      return notes.reportHeld === true;
    } catch (err) {
      if (!/column .*report_hold|relation .*projects/i.test(err.message)) {
        logger.warn(`[report-hold] service-record hold lookup failed for project ${projectId}: ${err.message}`);
        return notes.reportHeld === true || !(notes.portalAttached && notes.projectReport?.url);
      }
      return notes.reportHeld === true;
    }
  }
  if (serviceRecordId) {
    try {
      const linked = await database('projects').where({ service_record_id: serviceRecordId }).first('id', 'report_hold_status');
      if (linked && 'report_hold_status' in linked) return isReportHeld(linked);
    } catch (err) {
      if (!/column .*report_hold|relation .*projects|column .*service_record_id/i.test(err.message)) {
        logger.warn(`[report-hold] service-record link hold lookup failed for service record ${serviceRecordId}: ${err.message}`);
        return true;
      }
    }
  }
  return notes.reportHeld === true;
}

module.exports = {
  closeInvoiceEmailBell,
  sweepHeldReportReleases,
  isReportHeld,
  REPORT_UNSHARED_SQL,
  reportLinkShared,
  assertNoPaymentStarted,
  customerHasCredit,
  raiseReleaseFailedBell,
  raiseInvoiceEmailUncertainBell,
  closeReleaseFailedBell,
  reportHoldBackoffMinutes,
  findWdoReportHoldStateForInvoice,
  assertNoReleasedWdoReportHoldForInvoice,
  reconcileWdoReportHoldOnInvoiceVoid,
  closeClearedHoldBells,
  isServiceRecordProjectReportHeld,
  _internals: { recoverStaleReleasingClaims, findDueHeldProjectIds, STALE_RELEASING_MINUTES, bellKey },
};
