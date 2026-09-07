// Invoice issued ⇒ visit completed (owner ruling 2026-09-07). When an
// invoice tied to a visit is SENT to the customer or PAID by hand, the visit
// it bills happened — mark it completed without a service report, a
// completion text, a review ask, a charge, or a second invoice. The invoice
// is the customer-facing artifact. Dark by default: GATE_INVOICE_ISSUED_CLOSES_VISIT.
//
// The closeout itself is the canonical completion path in quiet (backfill)
// posture, so the service record, tracker state, tier snapshot, and the
// linked invoice's reuse all come from ONE mechanism — nothing is
// reimplemented here. This module only decides WHICH visit (the one the
// invoice is explicitly linked to — never inferred) and asks for the closeout.
const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');
const { etDateString } = require('../utils/datetime-et');

// A visit that can still be closed out (job-status.js live vocabulary).
const OPEN_VISIT_STATUSES = ['pending', 'confirmed', 'en_route', 'on_site'];

function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  const m = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// The visit this invoice bills, or null with the reason it was left alone.
// LINKED invoices only (owner ruling 2026-09-07): the invoice names its
// visit through scheduled_service_id. An unattached office invoice is never
// paired by inference here — the Invoices page links at creation instead.
// A record-only link (service_record_id, no visit id) is left alone too: a
// service record means a completion already ran for that visit, and the
// canonical completion refuses a second one (service_already_completed) —
// there is nothing for this lane to do there (pre-push P1). Every "no" keeps the visit
// open: a future date, a visit already closed, a grouped stop (the whole
// visit closes together), or a visit whose billing a saved grouped
// closeout owns. Once the linked visit row is in hand, every refusal
// carries it as `visit` so the caller can audit the refusal — and resume
// its OWN partially committed closeout on a completed one (see
// resumableIssuedCloseoutAttempt), never anyone else's.
async function resolveVisitForIssuedInvoice(conn, invoice, { today = etDateString() } = {}) {
  if (!invoice) return { svc: null, reason: 'no_invoice' };
  if (!invoice.scheduled_service_id) {
    return { svc: null, reason: invoice.service_record_id ? 'record_linked_only' : 'not_linked' };
  }
  const svc = await conn('scheduled_services').where({ id: invoice.scheduled_service_id }).first();
  if (!svc) return { svc: null, reason: 'no_visit' };
  const leaveOpen = (reason) => ({ svc: null, reason, visit: svc });
  if (!OPEN_VISIT_STATUSES.includes(String(svc.status))) return leaveOpen(`visit_${svc.status}`);
  const day = dateOnly(svc.scheduled_date);
  if (!day || day > today) return leaveOpen('visit_in_future');
  if (svc.visit_id) {
    const { openMembers } = require('./visit-groups');
    const members = await openMembers(conn, svc.visit_id);
    if (members.length >= 2) return leaveOpen('grouped_visit');
  }
  try {
    const { assertScheduledInvoiceNotPacketOwned } = require('./scheduled-invoice-mint');
    await assertScheduledInvoiceNotPacketOwned(conn, svc.id);
  } catch {
    return leaveOpen('packet_owned');
  }
  return { svc, reason: null, visit: svc };
}

// The canonical completion commits status='completed' before its post-commit
// work (invoice back-link, tracker, tier snapshot) and parks a crashed run as
// a resumable attempt keyed by idempotency key. A later send/payment of the
// same invoice must reach that resume instead of reading "already completed"
// (pre-push P1) — but only for THIS closeout's own attempt, never a panel's.
async function resumableIssuedCloseoutAttempt(conn, { serviceId, idempotencyKey }) {
  const CompletionAttempts = require('./completion-attempts');
  const attempt = await conn('service_completion_attempts')
    .where({ service_id: serviceId, idempotency_key: idempotencyKey })
    .orderBy('updated_at', 'desc')
    .first('id', 'status');
  if (!attempt || attempt.status === 'succeeded' || attempt.status === 'failed') return false;
  const state = await CompletionAttempts.completionStatusForService({ serviceId, idempotencyKey }, conn);
  return state.state === 'resumable';
}

// Entry point for the send and record-payment paths. Best-effort by
// contract: the invoice was already delivered / the payment already
// recorded, so a refused or failed closeout is logged and reported, never
// thrown back into the send. `trigger` is 'sent' | 'paid'.
async function closeOutVisitForIssuedInvoice({ invoiceId, trigger, actorTechnicianId = null, conn = db, today = etDateString() } = {}) {
  if (!isEnabled('invoiceIssuedClosesVisit')) return { closed: false, reason: 'gate_off' };
  if (!invoiceId || !['sent', 'paid'].includes(trigger)) return { closed: false, reason: 'bad_input' };
  try {
    const invoice = await conn('invoices').where({ id: invoiceId }).first();
    if (!invoice || String(invoice.status) === 'void') return { closed: false, reason: 'no_invoice' };
    const label = `invoice ${invoice.invoice_number || invoice.id} ${trigger}`;
    const idempotencyKey = `invoice-issued:${invoice.id}`;
    // One audit row per linked-visit outcome — completed, or refused with
    // the reason — so rollout diagnostics tell an intentional no-op from a
    // failure. The operator behind the send / payment is the actor; an
    // automated trigger (scheduled sends, collections, the Zelle
    // reconciler) is the system — never the visit's technician.
    const audit = async ({ closed, visitId, resumed = false, status = null, code = null }) => {
      try {
        const { recordAuditEvent } = require('./audit-log');
        await recordAuditEvent({
          actor_type: actorTechnicianId ? 'admin' : 'system',
          actor_id: actorTechnicianId || null,
          action: closed ? 'visit.completed_on_invoice_issued' : 'visit.completion_on_invoice_issued_refused',
          resource_type: 'scheduled_services',
          resource_id: visitId,
          metadata: { invoiceId: invoice.id, trigger, resumed, status, code },
        });
      } catch (auditErr) {
        logger.warn(`[invoice-issued-closeout] audit write failed for visit ${visitId}: ${auditErr.message}`);
      }
    };
    const resolved = await resolveVisitForIssuedInvoice(conn, invoice, { today });
    let svc = resolved.svc;
    let resuming = false;
    if (!svc) {
      const own = resolved.reason === 'visit_completed'
        && await resumableIssuedCloseoutAttempt(conn, { serviceId: resolved.visit.id, idempotencyKey });
      if (!own) {
        if (resolved.visit) {
          // A linked visit left open on purpose (already closed, future,
          // grouped, packet-owned) is recorded like a refused completion
          // (GitHub r1 P2). An invoice with no visit link has nothing to
          // audit against — the send / payment itself is already logged.
          logger.info(`[invoice-issued-closeout] ${label} → visit ${resolved.visit.id} left open (${resolved.reason})`);
          await audit({ closed: false, visitId: resolved.visit.id, code: resolved.reason });
        }
        return { closed: false, reason: resolved.reason, visitId: resolved.visit?.id || null };
      }
      svc = resolved.visit;
      resuming = true;
    }
    const { completeScheduledService } = require('./complete-scheduled-service');
    const result = await completeScheduledService({
      serviceId: svc.id,
      // Quiet posture by contract (backfill): no completion SMS, no report,
      // no review ask, no charge; the linked invoice is reused, none minted.
      body: {
        visitOutcome: 'completed',
        backfill: true,
        sendCompletionSms: false,
        requestReview: false,
        invoiceAlreadySent: true,
        idempotencyKey,
      },
      // The operator, or nobody: an automated trigger must not be written
      // up (job_status_history, tracker audit, activity_log) as the visit's
      // technician closing it out (GitHub r2 P2) — the service record takes
      // its technician from the visit regardless.
      actor: { techRole: 'admin', technicianId: actorTechnicianId || null, technician: null },
      idempotencyKey,
      issuedInvoiceCloseout: { invoiceId: invoice.id, trigger },
    });
    const closed = result?.status === 200 && result?.body?.success === true;
    const line = `[invoice-issued-closeout] ${label} → visit ${svc.id} ${closed ? `completed${resuming ? ' (resumed)' : ''}` : `NOT completed (${result?.status} ${result?.body?.code || result?.body?.error || ''})`}`;
    if (closed) logger.info(line); else logger.warn(line);
    await audit({ closed, visitId: svc.id, resumed: resuming, status: result?.status || null, code: result?.body?.code || null });
    return { closed, reason: closed ? null : (result?.body?.code || `status_${result?.status}`), visitId: svc.id, resumed: resuming };
  } catch (err) {
    logger.error(`[invoice-issued-closeout] failed for invoice ${invoiceId}: ${err.message}`);
    return { closed: false, reason: 'error', error: err.message };
  }
}

module.exports = {
  OPEN_VISIT_STATUSES,
  resolveVisitForIssuedInvoice,
  resumableIssuedCloseoutAttempt,
  closeOutVisitForIssuedInvoice,
};
