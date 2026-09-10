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
  // Only the ownership verdict itself is a refusal; a failed read inside the
  // check is an outage, rethrown so it lands in the caller's failure audit
  // (code 'error') instead of being misfiled as packet ownership (GitHub r6
  // P2 #4127). The visit is already in hand here, so the throw carries it
  // (`linkedVisit`) — the failure is audited against this visit.
  try {
    const { assertScheduledInvoiceNotPacketOwned } = require('./scheduled-invoice-mint');
    await assertScheduledInvoiceNotPacketOwned(conn, svc.id);
  } catch (err) {
    if (err?.code === 'VISIT_PACKET_OWNS_BILLING') return leaveOpen('packet_owned');
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { linkedVisit: svc });
  }
  // A project-backed visit (completion profile requiresProject /
  // projectBacked: special projects, rodent exclusion, …) completes ONLY
  // through its project's close route (completeProjectBackedService) — the
  // canonical completion refuses it outright (project_required_completion)
  // before the issued posture is even derived, and the project report's
  // send-with-invoice delivery is not the project's close. Excluded here
  // explicitly, with its own audited reason, rather than sending it into a
  // refusal it can never pass (GitHub r5 P2 #4127); the visit stays open
  // for the project close. Resolved STRICT: a failed table / identity probe
  // must surface as an error outcome (audited by the caller), never
  // synthesize the generic profile and let a project-backed visit through
  // the generic lane (GitHub r6 P2 #4127).
  const { resolveCompletionProfileForScheduledService } = require('./service-completion-profiles');
  let profile;
  try {
    profile = await resolveCompletionProfileForScheduledService(svc, conn, { strict: true });
  } catch (err) {
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { linkedVisit: svc });
  }
  if (profile?.requiresProject || profile?.projectBacked) return leaveOpen('project_backed');
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

// Durable provenance of a quiet closeout: the record it committed carries
// structured_notes.issuedInvoiceCloseout (frozen requestReview: false). The
// delivery / payment paths consult it before enrolling a review ask
// (pre-push P1 r7): a closeout that committed its record but failed in its
// post-commit work reports closed: false, and if the invoice is already
// paid by the time of the fresh linkage read, the at-delivery ask would
// otherwise enroll against the very record that promised never to send it.
async function issuedCloseoutOwnsRecord(serviceRecordId, conn = db) {
  if (!serviceRecordId) return false;
  const record = await conn('service_records').where({ id: serviceRecordId }).first('structured_notes');
  if (!record) return false;
  let notes = record.structured_notes;
  if (typeof notes === 'string') {
    try { notes = JSON.parse(notes); } catch { return false; }
  }
  return Boolean(notes && typeof notes === 'object' && notes.issuedInvoiceCloseout);
}

// Entry point for the send and record-payment paths. Best-effort by
// contract: the invoice was already delivered / the payment already
// recorded, so a refused or failed closeout is logged and reported, never
// thrown back into the send. `trigger` is 'sent' | 'paid'. `actorRole` is
// the AUTHENTICATED staff role behind actorTechnicianId (req.techRole —
// 'admin' | 'technician') and is used ONLY to record the true audit
// identity below; it is deliberately kept separate from the completion's
// authorization posture (see the `actor` object further down), which
// stays 'admin' regardless — the quiet backfill closeout runs the same
// way whichever staff role triggered it (GitHub r7 P2 #4127: technicians
// reach this through /api/admin/schedule/:id/prepaid).
async function closeOutVisitForIssuedInvoice({ invoiceId, trigger, actorTechnicianId = null, actorRole = null, conn = db, today = etDateString() } = {}) {
  if (!isEnabled('invoiceIssuedClosesVisit')) return { closed: false, reason: 'gate_off' };
  if (!invoiceId || !['sent', 'paid'].includes(trigger)) return { closed: false, reason: 'bad_input' };
  // One audit row per linked-visit outcome — completed, refused with the
  // reason, or FAILED (a thrown resumability lookup / completion, including
  // the supported post-commit failure whose visit may already be completed
  // and back-linked) — so rollout diagnostics tell an intentional no-op from
  // a failure (GitHub r5 P2 #4127). The operator behind the send / payment
  // is the actor; an automated trigger (scheduled sends, collections, the
  // Zelle reconciler) is the system — never the visit's technician. The
  // recorded actor_type follows the AUTHENTICATED staff role (GitHub r7
  // P2): a technician-triggered closeout (the prepaid route) is audited as
  // 'technician', never folded into 'admin' — callers that don't carry a
  // role (every admin-only route) keep the prior 'admin' default.
  // Declared outside the try so the catch still knows which linked visit
  // the failure belongs to.
  let invoice = null;
  let linkedVisitId = null;
  let resuming = false;
  const actorAuditType = actorTechnicianId ? (actorRole === 'technician' ? 'technician' : 'admin') : 'system';
  const audit = async ({ closed, visitId, resumed = false, status = null, code = null, error = null }) => {
    try {
      const { recordAuditEvent } = require('./audit-log');
      await recordAuditEvent({
        actor_type: actorAuditType,
        actor_id: actorTechnicianId || null,
        action: closed ? 'visit.completed_on_invoice_issued' : 'visit.completion_on_invoice_issued_refused',
        resource_type: 'scheduled_services',
        resource_id: visitId,
        metadata: { invoiceId: invoice?.id || invoiceId, trigger, resumed, status, code, ...(error ? { error } : {}) },
      });
    } catch (auditErr) {
      logger.warn(`[invoice-issued-closeout] audit write failed for visit ${visitId}: ${auditErr.message}`);
    }
  };
  try {
    invoice = await conn('invoices').where({ id: invoiceId }).first();
    if (!invoice) return { closed: false, reason: 'no_invoice' };
    const label = `invoice ${invoice.invoice_number || invoice.id} ${trigger}`;
    const idempotencyKey = `invoice-issued:${invoice.id}`;
    // A voided invoice closes nothing — UNLESS this closeout already
    // committed on it and still owes side effects (pre-push P1 r7): the
    // canonical completion lets that committed attempt resume past the void
    // (its posture is frozen, nothing can be minted), so the wrapper must
    // reach the resume too instead of stranding the tracker / snapshot work
    // behind 'no_invoice' on every later send or payment.
    if (String(invoice.status) === 'void') {
      const ownCommitted = invoice.scheduled_service_id
        && await resumableIssuedCloseoutAttempt(conn, { serviceId: invoice.scheduled_service_id, idempotencyKey });
      if (!ownCommitted) return { closed: false, reason: 'no_invoice' };
    }
    const resolved = await resolveVisitForIssuedInvoice(conn, invoice, { today });
    linkedVisitId = resolved.visit?.id || null;
    let svc = resolved.svc;
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
      //
      // techRole here is AUTHORIZATION POSTURE, not audit identity (GitHub
      // r7 P2 #4127): the quiet backfill closeout must run the same way
      // whichever staff role triggered it (a technician reaches this via
      // /api/admin/schedule/:id/prepaid), so it stays 'admin' regardless of
      // actorRole — the TRUE staff role is recorded separately, in this
      // helper's own audit() calls above (actor_type), never here.
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
    // A probe that threw after the linked visit row was in hand carries it.
    linkedVisitId = linkedVisitId || err?.linkedVisit?.id || null;
    logger.error(`[invoice-issued-closeout] failed for invoice ${invoiceId}${linkedVisitId ? ` (visit ${linkedVisitId})` : ''}: ${err.message}`);
    // A linked visit had resolved: its outcome is a failure, recorded like
    // any other — the completion may have committed and back-linked before
    // throwing (its attempt stays resumable; the next send / payment of
    // this invoice, or the resend-receipt route, retries it).
    if (linkedVisitId) {
      await audit({ closed: false, visitId: linkedVisitId, resumed: resuming, code: 'error', error: String(err.message || err).slice(0, 500) });
    }
    return { closed: false, reason: 'error', error: err.message, visitId: linkedVisitId };
  }
}

module.exports = {
  issuedCloseoutOwnsRecord,
  OPEN_VISIT_STATUSES,
  resolveVisitForIssuedInvoice,
  resumableIssuedCloseoutAttempt,
  closeOutVisitForIssuedInvoice,
};
