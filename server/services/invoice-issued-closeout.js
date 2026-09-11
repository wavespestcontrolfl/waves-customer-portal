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

// A visit that can still be closed out by the OFFICE (job-status.js live
// vocabulary, minus the in-progress states): a visit whose technician is
// en route or on site has a running job timer and a completion of its own
// coming — a quiet backfill closeout would complete it while its
// time_entries stay open, inflating time-on-site and job cost (GitHub r9
// P1 #4127). Those stay open for the technician; the invoice's delivery is
// recorded either way.
const OPEN_VISIT_STATUSES = ['pending', 'confirmed'];

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

// Payer-statement surfaces (GitHub r9 P1 #4127): a NET-terms statement
// delivers and settles its accrued child invoices as one document, so the
// individual-send hooks never see them. Statement delivery (markStatementSent)
// and settlement (the reconcile route and the Stripe webhook, AFTER their
// money transaction commits — the closeout takes its own row locks) run the
// closeout for every linked child. Best-effort, sequential, never throws.
async function closeOutVisitsForStatement(statementId, { trigger, actorTechnicianId = null, actorRole = null, conn = db } = {}) {
  let invoiceIds = [];
  try {
    invoiceIds = (await conn('invoices').where({ payer_statement_id: statementId }).whereNotNull('scheduled_service_id').select('id')).map((r) => r.id);
  } catch (err) {
    logger.error(`[invoice-issued-closeout] statement ${statementId}: child invoice lookup failed — no closeouts run: ${err.message}`);
    return { attempted: 0, closed: 0, failed: [] };
  }
  let closed = 0;
  const failed = [];
  for (const invoiceId of invoiceIds) {
    const out = await closeOutVisitForIssuedInvoice({ invoiceId, trigger, actorTechnicianId, actorRole, conn });
    if (out?.closed) closed += 1;
    else if (out?.reason === 'error') failed.push(invoiceId);
  }
  if (failed.length) {
    // A settled statement has no later send or payment to retry through
    // (GitHub r10 P2 #4127) — the failure is recorded on each child's
    // audit row and picked up by retrySettledStatementCloseouts.
    logger.warn(`[invoice-issued-closeout] statement ${statementId} ${trigger}: ${failed.length} child closeout(s) failed — ${failed.join(', ')}; the daily settled-statement sweep retries them`);
  }
  return { attempted: invoiceIds.length, closed, failed };
}

const CLOSEOUT_AUDIT_ACTIONS = ['visit.completed_on_invoice_issued', 'visit.completion_on_invoice_issued_refused'];

// The durable retry for settlement closeouts (GitHub r10 P2 #4127). A
// statement settled with no prior delivery closeout (a finalized statement
// paid by check, say) runs its child closeouts exactly once, after the money
// transaction commits — and a child that failed there with a transient error,
// or never ran because the process died between the commit and the closeout,
// has no reachable retry: the statement is `paid`, so the reconcile route,
// the statement send and the webhook all refuse a second pass. The audit row
// every closeout writes is the persisted record of that failure; this sweep
// (the daily payer-statement scheduler tick) re-runs the closeout for each
// linked child of a recently settled statement whose visit is still open and
// not in the future — or already COMPLETED with this closeout's own attempt
// still parked (the canonical completion commits status='completed' before
// its post-commit work; a crash there leaves the attempt resumable and the
// tracker / snapshot work owed; pre-push P1 r10) — AND whose latest
// paid-trigger closeout audit is missing or an error. A child refused for a
// real reason (grouped, packet-owned, project-backed, moved) carries a
// non-error refusal row and is left alone — the sweep never re-audits an
// intentional no-op. System actor: nobody is behind a retry.
async function retrySettledStatementCloseouts({ conn = db, today = etDateString(), sinceDays = 7 } = {}) {
  if (!isEnabled('invoiceIssuedClosesVisit')) return { candidates: 0, retried: 0, closed: 0 };
  let rows = [];
  try {
    rows = await conn('payer_statements as ps')
      .join('invoices as i', 'i.payer_statement_id', 'ps.id')
      .join('scheduled_services as s', 's.id', 'i.scheduled_service_id')
      .where('ps.status', 'paid')
      .where('ps.paid_at', '>=', new Date(Date.now() - sinceDays * 86400000))
      .where((q) => q
        .where((open) => open.whereIn('s.status', OPEN_VISIT_STATUSES).where('s.scheduled_date', '<=', today))
        .orWhere((done) => done.where('s.status', 'completed').whereExists(function ownParkedAttempt() {
          this.select(1).from('service_completion_attempts as a')
            .whereRaw('a.service_id = s.id')
            .whereRaw("a.idempotency_key = 'invoice-issued:' || i.id::text")
            .whereNotIn('a.status', ['succeeded', 'failed']);
        })))
      .orderBy(['ps.id', 'i.id'])
      .select('ps.id as statement_id', 'i.id as invoice_id', 's.id as visit_id');
  } catch (err) {
    logger.error(`[invoice-issued-closeout] settled-statement retry: candidate lookup failed: ${err.message}`);
    return { candidates: 0, retried: 0, closed: 0 };
  }
  let retried = 0;
  let closed = 0;
  for (const row of rows) {
    let last;
    try {
      last = await conn('audit_log')
        .where({ resource_type: 'scheduled_services', resource_id: row.visit_id })
        .whereIn('action', CLOSEOUT_AUDIT_ACTIONS)
        .whereRaw("metadata->>'invoiceId' = ?", [String(row.invoice_id)])
        .whereRaw("metadata->>'trigger' = 'paid'")
        .orderBy('created_at', 'desc')
        .first('action', 'metadata');
    } catch (err) {
      logger.error(`[invoice-issued-closeout] settled-statement retry: audit lookup failed for invoice ${row.invoice_id}: ${err.message}`);
      continue;
    }
    if (last) {
      let meta = last.metadata;
      if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = {}; } }
      if (last.action !== 'visit.completion_on_invoice_issued_refused' || meta?.code !== 'error') continue;
    }
    retried += 1;
    const out = await closeOutVisitForIssuedInvoice({ invoiceId: row.invoice_id, trigger: 'paid', conn, today });
    if (out?.closed) closed += 1;
  }
  if (retried) logger.info(`[invoice-issued-closeout] settled-statement retry: ${rows.length} open linked child(ren), ${retried} retried, ${closed} closed`);
  return { candidates: rows.length, retried, closed };
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
      if (!ownCommitted) {
        // A linked visit left open by the void is audited like every other
        // refusal (GitHub r7 P2 #4127) — the invoice still names the visit,
        // so the refusal row explains why it stayed open after the delivery.
        if (invoice.scheduled_service_id) {
          linkedVisitId = invoice.scheduled_service_id;
          logger.info(`[invoice-issued-closeout] ${label} → visit ${linkedVisitId} left open (invoice_void)`);
          await audit({ closed: false, visitId: linkedVisitId, code: 'invoice_void' });
          return { closed: false, reason: 'invoice_void', visitId: linkedVisitId };
        }
        return { closed: false, reason: 'no_invoice' };
      }
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
  closeOutVisitsForStatement,
  retrySettledStatementCloseouts,
  OPEN_VISIT_STATUSES,
  resolveVisitForIssuedInvoice,
  resumableIssuedCloseoutAttempt,
  closeOutVisitForIssuedInvoice,
};
