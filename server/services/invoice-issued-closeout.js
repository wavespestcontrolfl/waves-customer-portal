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

// ONE null-tolerant predicate for "is this visit still live/open" (Codex
// round 16 P2 #4131) — a NULL status is a live visit (the repository's live-
// visit convention; the picker links invoices to such legacy rows), so it
// must pass exactly like pending/confirmed everywhere this decision is made:
// the resolver below, and the locked closeout recheck in
// complete-scheduled-service.js (which re-derives the SAME verdict on the
// FOR UPDATE row and used to accept only the string statuses, throwing
// issued_visit_in_progress on a legacy NULL-status visit the resolver had
// just admitted). The settled-statement sweep's SQL expresses the same
// OPEN_VISIT_STATUSES + null tolerance directly in its WHERE clause (a JS
// predicate can't run inside the query) — same source array, so all three
// can never drift apart.
function isLiveVisitStatus(status) {
  return status == null || OPEN_VISIT_STATUSES.includes(String(status));
}

function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  const m = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// The visit this invoice names — directly (scheduled_service_id, the only
// link the Invoices page writes at creation) or through its service record
// (service_record_id → service_records.scheduled_service_id). A record-only
// link means a completion already ran for that visit and the canonical
// completion refuses a second one (service_already_completed), so there is
// nothing to close — but the visit IS linked, so it is resolved and handed
// back for the refusal audit (GitHub r11 P2 #4127). An unattached office
// invoice is never paired by inference (owner ruling 2026-09-07).
async function linkedVisitForInvoice(conn, invoice) {
  if (invoice.scheduled_service_id) {
    const svc = await conn('scheduled_services').where({ id: invoice.scheduled_service_id }).first();
    return svc ? { svc } : { reason: 'no_visit' };
  }
  if (!invoice.service_record_id) return { reason: 'not_linked' };
  const record = await conn('service_records').where({ id: invoice.service_record_id }).first('scheduled_service_id');
  const visit = record?.scheduled_service_id
    ? await conn('scheduled_services').where({ id: record.scheduled_service_id }).first()
    : null;
  return { reason: 'record_linked_only', ...(visit ? { visit } : {}) };
}

// The two refusals that need a read beyond the visit row. Only the verdict
// itself is a refusal; a failed read inside either probe is an outage,
// rethrown carrying the visit (`linkedVisit`) so it lands in the caller's
// failure audit (code 'error') against this visit instead of being misfiled
// as a refusal (GitHub r6 P2 #4127).
//  - Packet ownership: a saved grouped closeout owns the visit's billing.
//  - Project-backed profile (requiresProject / projectBacked: special
//    projects, rodent exclusion, …): completes ONLY through the project's
//    close route; the canonical completion refuses it outright, so it is
//    excluded here with its own audited reason (GitHub r5 P2 #4127).
//    Resolved STRICT — an unverifiable profile must surface as an error, never
//    synthesize the generic profile and let a project-backed visit through.
async function probeVisitRefusal(conn, svc) {
  try {
    const { assertScheduledInvoiceNotPacketOwned } = require('./scheduled-invoice-mint');
    await assertScheduledInvoiceNotPacketOwned(conn, svc.id);
  } catch (err) {
    if (err?.code === 'VISIT_PACKET_OWNS_BILLING') return 'packet_owned';
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { linkedVisit: svc });
  }
  let profile;
  try {
    const { resolveCompletionProfileForScheduledService } = require('./service-completion-profiles');
    profile = await resolveCompletionProfileForScheduledService(svc, conn, { strict: true });
  } catch (err) {
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { linkedVisit: svc });
  }
  return (profile?.requiresProject || profile?.projectBacked) ? 'project_backed' : null;
}

// The visit this invoice bills, or null with the reason it was left alone.
// Every "no" keeps the visit open: a future date, a visit already closed, a
// grouped stop (the whole visit closes together), or a visit whose billing a
// saved grouped closeout owns. Once the linked visit row is in hand, every
// refusal carries it as `visit` so the caller can audit the refusal — and
// resume its OWN partially committed closeout on a completed one (see
// resumableIssuedCloseoutAttempt), never anyone else's.
async function resolveVisitForIssuedInvoice(conn, invoice, { today = etDateString(), trigger = null } = {}) {
  if (!invoice) return { svc: null, reason: 'no_invoice' };
  const linked = await linkedVisitForInvoice(conn, invoice);
  if (!linked.svc) return { svc: null, reason: linked.reason, ...(linked.visit ? { visit: linked.visit } : {}) };
  const { svc } = linked;
  const leaveOpen = (reason) => ({ svc: null, reason, visit: svc });
  // A NULL status is a live visit (the repository's live-visit convention;
  // the picker links invoices to such legacy rows — Codex P2 r8 #4131), so it
  // closes out like pending/confirmed instead of being refused as visit_null.
  if (!isLiveVisitStatus(svc.status)) return leaveOpen(`visit_${svc.status}`);
  const day = dateOnly(svc.scheduled_date);
  if (!day || day > today) return leaveOpen('visit_in_future');
  // A SEND proves nothing about a visit scheduled for today: the office
  // invoice picker links pre-completion invoices to open visits and sends
  // them immediately, so a same-day send would create the service record
  // and complete the visit before the tech arrives (Codex P1 r7 #4131).
  // Only a visit whose day has passed closes out on a send; money received
  // (trigger 'paid') still closes a same-day visit, as #4127 intended.
  if (day === today && trigger === 'sent') return leaveOpen('visit_scheduled_today');
  if (svc.visit_id) {
    const { openMembers } = require('./visit-groups');
    if ((await openMembers(conn, svc.visit_id)).length >= 2) return leaveOpen('grouped_visit');
  }
  const refusal = await probeVisitRefusal(conn, svc);
  return refusal ? leaveOpen(refusal) : { svc, reason: null, visit: svc };
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
    // Every LINKED child — directly or through its service record — so a
    // record-only link reaches the resolver and is audited (GitHub r12 P2 #4127).
    invoiceIds = (await conn('invoices').where({ payer_statement_id: statementId })
      .where((q) => q.whereNotNull('scheduled_service_id').orWhereNotNull('service_record_id'))
      .select('id')).map((r) => r.id);
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
// This closeout's own completion attempt for the child invoice, committed but
// not finished (the canonical completion parks it under invoice-issued:<id>).
const OWN_PARKED_ATTEMPT_SQL = "EXISTS (SELECT 1 FROM service_completion_attempts a WHERE a.service_id = s.id AND a.idempotency_key = 'invoice-issued:' || i.id::text AND a.status NOT IN ('succeeded', 'failed'))";

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
// tracker / snapshot work owed; pre-push P1 r10). An OPEN visit is retried
// only when its latest paid-trigger closeout audit is missing or an error: a
// child refused for a real reason (grouped, packet-owned, project-backed,
// moved) carries a non-error refusal row and is left alone — the sweep never
// re-audits an intentional no-op. An owned parked attempt outranks that
// filter (pre-push P1 r10 ×2): a settlement that ran while the delivery
// closeout was still running audited `visit_completed`, and if that worker
// then died the parked attempt is the truth, not the audit row. System
// actor: nobody is behind a retry.
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
        .where((open) => open.where((live) => live.whereIn('s.status', OPEN_VISIT_STATUSES).orWhereNull('s.status')).where('s.scheduled_date', '<=', today))
        .orWhere((done) => done.where('s.status', 'completed').whereRaw(OWN_PARKED_ATTEMPT_SQL)))
      .orderBy(['ps.id', 'i.id'])
      .select('ps.id as statement_id', 'i.id as invoice_id', 's.id as visit_id', conn.raw(`${OWN_PARKED_ATTEMPT_SQL} as own_attempt_parked`));
  } catch (err) {
    logger.error(`[invoice-issued-closeout] settled-statement retry: candidate lookup failed: ${err.message}`);
    return { candidates: 0, retried: 0, closed: 0 };
  }
  let retried = 0;
  let closed = 0;
  for (const row of rows) {
    let last = null;
    if (!row.own_attempt_parked) try {
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

// One audit row per linked-visit outcome — completed, refused with the
// reason, or FAILED (a thrown resumability lookup / completion, including the
// supported post-commit failure whose visit may already be completed and
// back-linked) — so rollout diagnostics tell an intentional no-op from a
// failure (GitHub r5 P2 #4127). The operator behind the send / payment is
// the actor; an automated trigger (scheduled sends, collections, the Zelle
// reconciler) is the system — never the visit's technician. The recorded
// actor_type follows the AUTHENTICATED staff role (GitHub r7 P2): a
// technician-triggered closeout (the prepaid route) is audited as
// 'technician', never folded into 'admin' — callers that don't carry a role
// (every admin-only route) keep the prior 'admin' default.
async function auditCloseoutOutcome(run, { closed, visitId, resumed = false, status = null, code = null, error = null }) {
  const actorType = run.actorTechnicianId ? (run.actorRole === 'technician' ? 'technician' : 'admin') : 'system';
  try {
    const { recordAuditEvent } = require('./audit-log');
    await recordAuditEvent({
      actor_type: actorType,
      actor_id: run.actorTechnicianId || null,
      action: closed ? 'visit.completed_on_invoice_issued' : 'visit.completion_on_invoice_issued_refused',
      resource_type: 'scheduled_services',
      resource_id: visitId,
      metadata: { invoiceId: run.invoice?.id || run.invoiceId, trigger: run.trigger, resumed, status, code, ...(error ? { error } : {}) },
    });
  } catch (auditErr) {
    logger.warn(`[invoice-issued-closeout] audit write failed for visit ${visitId}: ${auditErr.message}`);
  }
}

// Phase 1 — a voided invoice closes nothing, UNLESS this closeout already
// committed on it and still owes side effects (pre-push P1 r7): the canonical
// completion lets that committed attempt resume past the void (its posture is
// frozen, nothing can be minted), so the wrapper must reach the resume too
// instead of stranding the tracker / snapshot work behind 'no_invoice' on
// every later send or payment. A linked visit left open by the void is
// audited like every other refusal (GitHub r7 P2 #4127). Returns the refusal
// result, or null to continue.
async function refuseVoidedInvoice(run) {
  const { invoice, conn } = run;
  if (String(invoice.status) !== 'void') return null;
  if (invoice.scheduled_service_id
    && await resumableIssuedCloseoutAttempt(conn, { serviceId: invoice.scheduled_service_id, idempotencyKey: run.idempotencyKey })) return null;
  // The linkage is resolved the same way as for a live invoice — a record-only
  // link names a visit too, and its void refusal is audited against it
  // (GitHub r12 P2 #4127). A direct link whose visit row is gone still
  // audits against the id the invoice carries.
  const linked = await linkedVisitForInvoice(conn, invoice);
  const visitId = linked.svc?.id || linked.visit?.id || invoice.scheduled_service_id || null;
  if (!visitId) return { closed: false, reason: 'no_invoice' };
  run.linkedVisitId = visitId;
  logger.info(`[invoice-issued-closeout] ${run.label} → visit ${visitId} left open (invoice_void)`);
  await auditCloseoutOutcome(run, { closed: false, visitId, code: 'invoice_void' });
  return { closed: false, reason: 'invoice_void', visitId };
}

// Phase 2 — which visit, if any: the linked open visit, or this closeout's
// OWN resumable attempt on a completed one. A linked visit left open on
// purpose (already closed, future, grouped, packet-owned, record-linked) is
// recorded like a refused completion (GitHub r1 P2); an invoice with no visit
// link has nothing to audit against — the send / payment itself is logged.
// Sets run.svc / run.resuming and returns null to continue, else the refusal.
async function resolveCloseoutTarget(run) {
  const resolved = await resolveVisitForIssuedInvoice(run.conn, run.invoice, { today: run.today, trigger: run.trigger });
  run.linkedVisitId = resolved.visit?.id || null;
  if (resolved.svc) {
    run.svc = resolved.svc;
    return null;
  }
  if (resolved.reason === 'visit_completed'
    && await resumableIssuedCloseoutAttempt(run.conn, { serviceId: resolved.visit.id, idempotencyKey: run.idempotencyKey })) {
    run.svc = resolved.visit;
    run.resuming = true;
    return null;
  }
  if (resolved.visit) {
    logger.info(`[invoice-issued-closeout] ${run.label} → visit ${resolved.visit.id} left open (${resolved.reason})`);
    await auditCloseoutOutcome(run, { closed: false, visitId: resolved.visit.id, code: resolved.reason });
  }
  return { closed: false, reason: resolved.reason, visitId: resolved.visit?.id || null };
}

// Phase 3 — the canonical completion in its quiet backfill posture: no
// completion SMS, no report, no review ask, no charge; the linked invoice is
// reused, none minted.
//
// The actor is the operator, or nobody: an automated trigger must not be
// written up (job_status_history, tracker audit, activity_log) as the visit's
// technician closing it out (GitHub r2 P2) — the service record takes its
// technician from the visit regardless. techRole here is AUTHORIZATION
// POSTURE, not audit identity (GitHub r7 P2 #4127): the quiet backfill
// closeout must run the same way whichever staff role triggered it (a
// technician reaches this via /api/admin/schedule/:id/prepaid), so it stays
// 'admin' regardless of actorRole — the TRUE staff role is recorded in
// auditCloseoutOutcome (actor_type), never here.
async function runQuietCloseout(run) {
  const { completeScheduledService } = require('./complete-scheduled-service');
  const result = await completeScheduledService({
    serviceId: run.svc.id,
    body: {
      visitOutcome: 'completed',
      backfill: true,
      sendCompletionSms: false,
      requestReview: false,
      invoiceAlreadySent: true,
      idempotencyKey: run.idempotencyKey,
    },
    actor: { techRole: 'admin', technicianId: run.actorTechnicianId || null, technician: null },
    idempotencyKey: run.idempotencyKey,
    issuedInvoiceCloseout: { invoiceId: run.invoice.id, trigger: run.trigger },
  });
  const outcome = completionOutcome(result);
  const line = `[invoice-issued-closeout] ${run.label} → visit ${run.svc.id} ${outcome.closed ? `completed${run.resuming ? ' (resumed)' : ''}` : `NOT completed (${outcome.status} ${outcome.code || outcome.error || ''})`}`;
  if (outcome.closed) logger.info(line); else logger.warn(line);
  await auditCloseoutOutcome(run, { closed: outcome.closed, visitId: run.svc.id, resumed: run.resuming, status: outcome.status, code: outcome.code });
  return { closed: outcome.closed, reason: outcome.closed ? null : (outcome.code || `status_${outcome.status}`), visitId: run.svc.id, resumed: run.resuming };
}

// The canonical completion's { status, body } read once, in one shape.
function completionOutcome(result) {
  const body = (result && result.body) || {};
  const status = (result && result.status) || null;
  return { closed: status === 200 && body.success === true, status, code: body.code || null, error: body.error || null };
}

async function loadCloseoutInvoice(run) {
  run.invoice = await run.conn('invoices').where({ id: run.invoiceId }).first();
  if (!run.invoice) return false;
  run.label = `invoice ${run.invoice.invoice_number || run.invoice.id} ${run.trigger}`;
  run.idempotencyKey = `invoice-issued:${run.invoice.id}`;
  return true;
}

// A throw anywhere after the linked visit row is in hand (a probe carries it
// as `linkedVisit`) is audited as that visit's failed outcome — the completion
// may have committed and back-linked before throwing; its attempt stays
// resumable and the next send / payment of this invoice, the resend-receipt
// route, or the settled-statement sweep retries it.
async function auditCloseoutFailure(run, err) {
  const visitId = run.linkedVisitId || (err && err.linkedVisit && err.linkedVisit.id) || null;
  logger.error(`[invoice-issued-closeout] failed for invoice ${run.invoiceId}${visitId ? ` (visit ${visitId})` : ''}: ${err.message}`);
  if (visitId) {
    await auditCloseoutOutcome(run, { closed: false, visitId, resumed: run.resuming, code: 'error', error: String(err.message || err).slice(0, 500) });
  }
  return { closed: false, reason: 'error', error: err.message, visitId };
}

// Entry point for the send and record-payment paths. Best-effort by
// contract: the invoice was already delivered / the payment already
// recorded, so a refused or failed closeout is logged and reported, never
// thrown back into the send. `trigger` is 'sent' | 'paid'. `actorRole` is
// the AUTHENTICATED staff role behind actorTechnicianId (req.techRole —
// 'admin' | 'technician'), used ONLY for the audit identity — see
// auditCloseoutOutcome and runQuietCloseout. Three bounded phases share one
// `run` context (GitHub r11 P2 #4127): void refusal → target resolution →
// the quiet canonical completion.
async function closeOutVisitForIssuedInvoice({ invoiceId, trigger, actorTechnicianId = null, actorRole = null, conn = db, today = etDateString() } = {}) {
  if (!isEnabled('invoiceIssuedClosesVisit')) return { closed: false, reason: 'gate_off' };
  if (!invoiceId || !['sent', 'paid'].includes(trigger)) return { closed: false, reason: 'bad_input' };
  const run = { invoiceId, trigger, actorTechnicianId, actorRole, conn, today, invoice: null, linkedVisitId: null, svc: null, resuming: false, label: null, idempotencyKey: null };
  try {
    if (!(await loadCloseoutInvoice(run))) return { closed: false, reason: 'no_invoice' };
    const refused = (await refuseVoidedInvoice(run)) || (await resolveCloseoutTarget(run));
    return refused || await runQuietCloseout(run);
  } catch (err) {
    return auditCloseoutFailure(run, err);
  }
}

module.exports = {
  issuedCloseoutOwnsRecord,
  closeOutVisitsForStatement,
  retrySettledStatementCloseouts,
  OPEN_VISIT_STATUSES,
  isLiveVisitStatus,
  resolveVisitForIssuedInvoice,
  resumableIssuedCloseoutAttempt,
  closeOutVisitForIssuedInvoice,
};
