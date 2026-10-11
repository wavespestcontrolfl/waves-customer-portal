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

// A visit the technician has NOT started (job-status.js live vocabulary,
// minus the in-progress states). A NULL status counts too — see
// isLiveVisitStatus.
const OPEN_VISIT_STATUSES = ['pending', 'confirmed'];

// A visit whose technician ARRIVED and never closed it out (owner ruling
// 2026-10-04). The GPS arrival moves nearly every worked visit to on_site,
// so refusing on_site left the closeout with nothing to close: from the gate
// flip (2026-09-24) to 2026-10-04 it closed no visit at all. An arrived visit
// closes like an unstarted one once its day has passed; on its own day only
// money received closes it (see issuedCloseoutVisitRefusal). en_route is NOT
// here: nobody has reached the property, so the visit stays with its
// technician. The r9 P1 concern (#4127: a quiet closeout would complete a
// visit whose job timer is still running) is answered by its real condition
// instead of by the status: a visit with a RUNNING job timer stays open
// (visitJobTimerRunning) — this module never writes payroll time.
const ARRIVED_VISIT_STATUSES = ['on_site'];

// ONE null-tolerant predicate for "the technician has not started this
// visit" (Codex round 16 P2 #4131) — a NULL status is a live visit (the
// repository's live-visit convention; the picker links invoices to such
// legacy rows), so it must pass exactly like pending/confirmed everywhere
// this decision is made.
function isLiveVisitStatus(status) {
  return status == null || OPEN_VISIT_STATUSES.includes(String(status));
}

function isArrivedVisitStatus(status) {
  return status != null && ARRIVED_VISIT_STATUSES.includes(String(status));
}

function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  const m = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// The ET day the invoice's own row says it was settled (trigger 'paid':
// paid_at) or last delivered (any other trigger: the newest of sent_at /
// sms_sent_at / email_sent_at). Null when the row carries no such stamp — the
// caller then has only "now" to go on.
function invoiceIssuedDay(invoice, trigger) {
  if (!invoice) return null;
  const stamps = trigger === 'paid'
    ? [invoice.paid_at]
    : [invoice.sent_at, invoice.sms_sent_at, invoice.email_sent_at];
  const times = stamps.map((value) => (value ? new Date(value).getTime() : NaN)).filter(Number.isFinite);
  return times.length ? etDateString(new Date(Math.max(...times))) : null;
}

// invoiceIssuedDay plus the one stamp that lives on another row: a payer
// statement delivers its children as ONE document, so a child invoice
// carries no delivery stamp of its own — the statement's sent_at is its
// delivery proof (its paid_at is copied onto every child at settlement, so
// the 'paid' trigger needs nothing extra). Used by the resolver and by the
// completion's locked recheck, so both read the same proof.
async function issuedDayForInvoice(conn, invoice, trigger) {
  if (!invoice) return null;
  if (trigger === 'paid' || !invoice.payer_statement_id) return invoiceIssuedDay(invoice, trigger);
  const statement = await conn('payer_statements').where({ id: invoice.payer_statement_id }).first('sent_at');
  return invoiceIssuedDay({ ...invoice, sent_at: newestStamp(invoice.sent_at, statement?.sent_at) }, trigger);
}

function newestStamp(...values) {
  const times = values.map((value) => (value ? new Date(value).getTime() : NaN)).filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)) : null;
}

// THE status + day rule, shared by the unlocked resolver, the canonical
// completion's locked recheck and (as SQL prefilters) the retry sweeps, so
// they can never drift apart. Returns null when the visit may close, else
// the reason it stays open.
//  - ARRIVED (on_site): the technician was there. A past day closes on a
//    send or a payment; today closes only on money received (a send proves
//    nothing about today — the office picker sends pre-completion invoices
//    before the tech arrives, Codex P1 r7 #4131).
//  - UNSTARTED (pending / confirmed / NULL): nobody is known to have gone, so
//    the INVOICE must carry the proof: it was settled / delivered on a LATER
//    ET day than the visit (`issuedDay`, from the invoice's own stamps).
//    Settled or delivered on or before the visit day, it is a PREPAYMENT:
//    the day passing does not turn that into evidence the visit happened (it
//    may have been rained out and never moved), and closing it would take
//    the stop away from its technician (owner ruling 2026-10-04, replacing
//    the "payment closes any same-day visit" rule of #4127). Because the
//    proof is a durable stamp and not the clock at call time, a live
//    trigger, a redelivered webhook and a retry sweep days later all reach
//    the SAME verdict — there is no separate guard for unattended passes to
//    forget (pre-push audit: five findings on such guards). With no stamp on
//    the row the call time stands in, which is the live trigger's "past day".
//  - An ALLOWLIST (pre-push audit P1, slice 6): a missing trigger or one this
//    module has never heard of fails CLOSED on a same-day visit.
//  - Future or unparseable dates, en_route and every terminal status never
//    close.
function issuedCloseoutVisitRefusal(status, scheduledDate, { today = etDateString(), trigger = null, issuedDay = null } = {}) {
  const arrived = isArrivedVisitStatus(status);
  if (!arrived && !isLiveVisitStatus(status)) return `visit_${status}`;
  const day = dateOnly(scheduledDate);
  if (!day || day > today) return 'visit_in_future';
  if (day === today) return arrived && trigger === 'paid' ? null : 'visit_scheduled_today';
  if (arrived) return null;
  // Never later than the call: a stamp from the future proves nothing yet.
  const proofDay = issuedDay && issuedDay < today ? issuedDay : today;
  return day < proofDay ? null : 'visit_prepaid';
}

// A job timer still running on this visit means its technician is working
// it right now (GitHub r9 P1 #4127): the visit stays theirs, on any day and
// in any status. The timer ends on its own (the technician stops it, leaves
// the geofence, clocks out, or the 14-hour auto clock-out fires), and the
// next send / payment / sweep then finds the visit eligible. The closeout
// only READS time_entries; closing or re-timing an entry is payroll's.
async function visitJobTimerRunning(conn, visitId) {
  const running = await conn('time_entries')
    .where({ job_id: visitId, entry_type: 'job', status: 'active' })
    .first('id');
  return Boolean(running);
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
  // Status, day and the invoice's own proof decide together
  // (issuedCloseoutVisitRefusal): a NULL status is a live visit (Codex P2 r8
  // #4131), an arrived visit closes on a past day or on money received
  // today, and a visit nobody arrived at closes only on an invoice settled
  // or delivered after its day.
  let issuedDay;
  try {
    issuedDay = await issuedDayForInvoice(conn, invoice, trigger);
  } catch (err) {
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { linkedVisit: svc });
  }
  const refusedByState = issuedCloseoutVisitRefusal(svc.status, svc.scheduled_date, { today, trigger, issuedDay });
  if (refusedByState) return leaveOpen(refusedByState);
  // Every read from here on is against a visit already in hand: a failed
  // one is an outage of THIS visit's closeout, rethrown carrying the visit
  // (`linkedVisit`) so the caller audits it as a failure (code 'error') —
  // the row the retry sweeps look for. Without the visit the failure had
  // nothing to be audited against and no sweep could ever retry it
  // (pre-push audit P1; probeVisitRefusal already did this for its two reads).
  try {
    if (await visitJobTimerRunning(conn, svc.id)) return leaveOpen('visit_timer_running');
    if (svc.visit_id) {
      const { openMembers } = require('./visit-groups');
      if ((await openMembers(conn, svc.visit_id)).length >= 2) return leaveOpen('grouped_visit');
    }
    const refusal = await probeVisitRefusal(conn, svc);
    return refusal ? leaveOpen(refusal) : { svc, reason: null, visit: svc };
  } catch (err) {
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { linkedVisit: svc });
  }
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
// The rule's status + day admission, as SQL, for both sweeps: an unstarted
// visit on a past day; an arrived one on a past day, or today when the
// invoice / statement is SETTLED (`settledSql`, a boolean SQL expression —
// a send never closes a same-day visit) — or a visit already completed with
// THIS closeout's own attempt still parked.
function retryableVisitFilter(q, today, settledSql) {
  return q
    .where((open) => open
      .where((unstarted) => unstarted.where((live) => live.whereIn('s.status', OPEN_VISIT_STATUSES).orWhereNull('s.status')).where('s.scheduled_date', '<', today))
      .orWhere((arrived) => arrived.whereIn('s.status', ARRIVED_VISIT_STATUSES)
        .where((day) => day.where('s.scheduled_date', '<', today)
          .orWhere((sameDay) => sameDay.where('s.scheduled_date', '=', today).whereRaw(settledSql)))))
    .orWhere((done) => done.where('s.status', 'completed').whereRaw(OWN_PARKED_ATTEMPT_SQL));
}

// Which audited refusal a sweep may reconsider. The question is not "was
// that refusal temporary" — that needed a list of codes, and the list kept
// missing one (pre-push audit, five findings) — but "is it about the STATE
// the visit, its timer or the system was in". State changes, and the
// sweeps' candidate filters plus the closeout's own rule re-decide it on
// current state, so a stale verdict costs one re-read and can never close
// anything the rule does not admit:
//  - every `visit_*` reason of issuedCloseoutVisitRefusal and the resolver
//    (visit_in_future, visit_en_route, visit_scheduled_today, visit_prepaid,
//    visit_timer_running, and the historical visit_on_site that every
//    arrived visit got before 2026-10-04);
//  - a race under the completion's row lock (`issued_visit_*`);
//  - a failure: `error`, or any 5xx the completion RETURNED rather than
//    threw (a failed profile / prepay read answers 503 with its own code).
// NOT reconsidered — these are about what the visit IS, and stay until a
// person changes it: grouped_visit, packet_owned, project_backed,
// record_linked_only, invoice_void, and every 4xx verdict of the completion
// with another code.
function isTransientRefusal(meta) {
  const code = String(meta?.code || '');
  return code === 'error' || code.startsWith('visit_') || code.startsWith('issued_visit_') || Number(meta?.status) >= 500;
}

// The latest closeout audit row for this (visit, invoice): `trigger` narrows
// it to one trigger, null reads any. Returns { action, meta } or null; throws
// on a failed read (the caller skips the row and the next pass re-reads).
async function latestCloseoutAudit(conn, { visitId, invoiceId, trigger = null }) {
  const query = conn('audit_log')
    .where({ resource_type: 'scheduled_services', resource_id: visitId })
    .whereIn('action', CLOSEOUT_AUDIT_ACTIONS)
    .whereRaw("metadata->>'invoiceId' = ?", [String(invoiceId)]);
  if (trigger) query.whereRaw("metadata->>'trigger' = ?", [trigger]);
  const last = await query.orderBy('created_at', 'desc').first('action', 'metadata');
  if (!last) return null;
  let meta = last.metadata;
  if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = {}; } }
  return { action: last.action, meta: meta || {} };
}

const refusedForTheMoment = (last) => Boolean(last) && last.action === 'visit.completion_on_invoice_issued_refused' && isTransientRefusal(last.meta);

// The visit an Intelligence Bar send's card said would be closed (a visit id) or 'none', kept as an audit row on
// the INVOICE (no new column), written inside the send claim. The send's own closeout is handed the target
// directly; this row lets the retry sweep, which re-enters with no caller, enforce the same target. The row also
// records the newest delivery stamp the invoice had at claim time: a claim that delivered nothing leaves the stamps
// where they were, and the sweep then ignores that row (the pin belongs to the delivery that followed it).
const CLOSEOUT_PIN_ACTION = 'invoice.send_closeout_target_approved';
const newestDeliveryMs = (row) => {
  const stamps = [row?.sent_at, row?.sms_sent_at, row?.email_sent_at].filter(Boolean).map((v) => new Date(v).getTime());
  return stamps.length ? Math.max(...stamps) : null;
};
async function recordApprovedCloseoutTarget(invoiceId, approvedTarget, { conn = db, priorInvoice = null, actorTechnicianId = null } = {}) {
  const { recordAuditEvent } = require('./audit-log');
  await recordAuditEvent({
    actor_type: actorTechnicianId ? 'admin' : 'system',
    actor_id: actorTechnicianId,
    action: CLOSEOUT_PIN_ACTION,
    resource_type: 'invoices',
    resource_id: invoiceId,
    metadata: { invoiceId: String(invoiceId), approvedTarget, priorDeliveredAtMs: newestDeliveryMs(priorInvoice) },
    critical: true,
    trx: conn,
  });
}

// The pinned target for an invoice whose delivery followed the pin, or null. Throws on a failed read (the sweep
// skips the row and the next pass re-reads).
async function approvedCloseoutTargetFor(conn, invoiceId) {
  const last = await conn('audit_log').where({ resource_type: 'invoices', resource_id: invoiceId, action: CLOSEOUT_PIN_ACTION })
    .orderBy('created_at', 'desc').first('metadata');
  if (!last) return null;
  let meta = last.metadata;
  if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = {}; } }
  if (!meta?.approvedTarget) return null;
  const delivered = newestDeliveryMs(await conn('invoices').where({ id: invoiceId }).first('sent_at', 'sms_sent_at', 'email_sent_at'));
  const prior = meta.priorDeliveredAtMs;
  return delivered !== null && (prior === null || prior === undefined || delivered > prior) ? meta.approvedTarget : null;
}

// The sweeps' PREFILTER for the prepayment rule (issuedCloseoutVisitRefusal,
// `visit_prepaid`): a visit nobody arrived at whose invoice / statement was
// NOT settled or delivered on a later ET day than the visit. The closeout
// would refuse it by the same rule, from the invoice's own stamps, on its
// fresh read and again under the completion's lock — this only keeps the
// sweep from re-auditing that refusal every day. Correctness lives in the
// rule, not here.
function prepaidAndNobodyArrived(row) {
  return !isArrivedVisitStatus(row.visit_status) && !row.issued_after_service_day;
}

// `column` settled / delivered on a later ET day than the visit's day.
const settledAfterServiceDaySql = (column) => `((${column}) AT TIME ZONE 'America/New_York')::date > s.scheduled_date`;

// A statement the payer HAS but has not settled (NET terms: weeks, or never),
// and one that is settled.
const DELIVERED_STATEMENT_STATUSES = ['sent', 'viewed', 'processing'];

// The statement children's sweep: the same retry as retryIssuedInvoiceCloseouts,
// for invoices that are delivered and settled through their payer statement
// (the name predates GitHub r5 P1 #5886, when only SETTLED statements were
// swept; a delivered, unpaid statement's children had no retry for a `sent`
// closeout that failed or was refused while a timer ran). A child is retried
// when its closeout never ran — the statement's delivery or settlement is the
// only trigger it gets — or was refused for a state that has since changed.
// Trigger and proof come from the statement: 'paid' + paid_at when settled,
// else 'sent' + sent_at.
async function retrySettledStatementCloseouts({ conn = db, today = etDateString(), sinceDays = 7 } = {}) {
  if (!isEnabled('invoiceIssuedClosesVisit')) return { candidates: 0, retried: 0, closed: 0 };
  const since = new Date(Date.now() - sinceDays * 86400000);
  const STATEMENT_ISSUED_AT_SQL = "CASE WHEN ps.status = 'paid' THEN ps.paid_at ELSE ps.sent_at END";
  let rows = [];
  try {
    rows = await conn('payer_statements as ps')
      .join('invoices as i', 'i.payer_statement_id', 'ps.id')
      .join('scheduled_services as s', 's.id', 'i.scheduled_service_id')
      .where((issued) => issued
        .where((settled) => settled.where('ps.status', 'paid').where('ps.paid_at', '>=', since))
        .orWhere((delivered) => delivered.whereIn('ps.status', DELIVERED_STATEMENT_STATUSES).where('ps.sent_at', '>=', since)))
      .where((q) => retryableVisitFilter(q, today, "ps.status = 'paid'"))
      .orderBy(['ps.id', 'i.id'])
      .select('ps.id as statement_id', 'ps.status as statement_status', 'i.id as invoice_id', 's.id as visit_id', 's.status as visit_status',
        conn.raw(`${OWN_PARKED_ATTEMPT_SQL} as own_attempt_parked`), conn.raw(`${settledAfterServiceDaySql(STATEMENT_ISSUED_AT_SQL)} as issued_after_service_day`));
  } catch (err) {
    logger.error(`[invoice-issued-closeout] statement retry: candidate lookup failed: ${err.message}`);
    return { candidates: 0, retried: 0, closed: 0 };
  }
  let retried = 0;
  let closed = 0;
  for (const row of rows) {
    const trigger = row.statement_status === 'paid' ? 'paid' : 'sent';
    if (!row.own_attempt_parked) {
      if (prepaidAndNobodyArrived(row)) continue;
      let last;
      try {
        last = await latestCloseoutAudit(conn, { visitId: row.visit_id, invoiceId: row.invoice_id, trigger });
      } catch (err) {
        logger.error(`[invoice-issued-closeout] statement retry: audit lookup failed for invoice ${row.invoice_id}: ${err.message}`);
        continue;
      }
      // Never ran for THIS trigger, or refused for a state that changed; a
      // refusal about what the visit is is left alone.
      if (last && !refusedForTheMoment(last)) continue;
    }
    retried += 1;
    const out = await closeOutVisitForIssuedInvoice({ invoiceId: row.invoice_id, trigger, conn, today });
    if (out?.closed) closed += 1;
  }
  if (retried) logger.info(`[invoice-issued-closeout] statement retry: ${rows.length} open linked child(ren), ${retried} retried, ${closed} closed`);
  return { candidates: rows.length, retried, closed };
}

// Statuses of an invoice the customer HAS (delivered, not yet settled), and of
// one that is settled. A draft or scheduled invoice is neither.
const DELIVERED_INVOICE_STATUSES = ['sent', 'viewed', 'overdue'];
const SETTLED_INVOICE_STATUSES = ['paid', 'prepaid'];
// The SAME stamp invoiceIssuedDay reads, as SQL (pre-push audit P1): a
// settled invoice's paid_at; otherwise the NEWEST delivery stamp (Postgres
// GREATEST ignores NULLs). A settled row with no paid_at falls back to its
// newest delivery so it is still windowed.
const NEWEST_DELIVERY_SQL = 'GREATEST(i.sent_at, i.sms_sent_at, i.email_sent_at)';
const ISSUED_AT_SQL = `CASE WHEN i.status IN ('paid', 'prepaid') THEN COALESCE(i.paid_at, ${NEWEST_DELIVERY_SQL}) ELSE ${NEWEST_DELIVERY_SQL} END`;
const ISSUED_AFTER_SERVICE_DAY_SQL = settledAfterServiceDaySql(ISSUED_AT_SQL);

// THE durable retry for every invoice outside a statement (GitHub r1 P1 and
// r3 P1 ×2 #5886). Every rail — the Stripe webhook, cash / check / reconcile,
// the prepaid route, each send path — runs the closeout once, best-effort,
// after the delivery or the money commits. Whatever stops that one run (a
// transient failure, a process that died first, an audit row that could not
// be written, a job timer that was still running) has no reachable retry:
// nothing sends or settles that invoice a second time. So this sweep does not
// reconstruct what each rail did. It reads the durable state — a delivered or
// settled invoice still linked to an OPEN visit — and asks the closeout
// again, with the trigger the invoice's own state proves ('paid' when
// settled, else 'sent'). Runs daily (scheduler: invoice-issued-closeout-retry).
//
// Two tiers, by how much the state itself proves:
//  - ARRIVED (on_site): the technician was there and the invoice is out. That
//    is the whole rule, so the visit is retried whether or not a closeout ever
//    ran — never-ran, unaudited and refused-for-the-moment alike.
//  - UNSTARTED (pending / confirmed / NULL), past day: nobody is known to have
//    gone, so the invoice must carry the proof — delivered / settled on a
//    later ET day than the visit (prepaidAndNobodyArrived). A prepayment
//    whose day simply passed is left to a person. Past that guard it is
//    retried when its closeout never ran, or ran and was refused for the
//    moment.
// A visit already completed with this closeout's own attempt parked is
// resumed. A real refusal (grouped, packet-owned, project-backed, en_route)
// carries a non-transient audit row and is left alone.
async function retryIssuedInvoiceCloseouts({ conn = db, today = etDateString(), sinceDays = 7 } = {}) {
  const none = { candidates: 0, retried: 0, closed: 0 };
  if (!isEnabled('invoiceIssuedClosesVisit')) return none;
  let rows = [];
  try {
    rows = await conn('invoices as i')
      .join('scheduled_services as s', 's.id', 'i.scheduled_service_id')
      .whereNull('i.payer_statement_id')
      .whereIn('i.status', [...SETTLED_INVOICE_STATUSES, ...DELIVERED_INVOICE_STATUSES])
      .whereRaw(`${ISSUED_AT_SQL} >= ?`, [new Date(Date.now() - sinceDays * 86400000)])
      .where((q) => retryableVisitFilter(q, today, "i.status IN ('paid', 'prepaid')"))
      .orderBy('i.id')
      .select('i.id as invoice_id', 'i.status as invoice_status', 's.id as visit_id', 's.status as visit_status',
        conn.raw(`${OWN_PARKED_ATTEMPT_SQL} as own_attempt_parked`), conn.raw(`${ISSUED_AFTER_SERVICE_DAY_SQL} as issued_after_service_day`));
  } catch (err) {
    logger.error(`[invoice-issued-closeout] issued-invoice retry: candidate lookup failed: ${err.message}`);
    return none;
  }
  let retried = 0;
  let closed = 0;
  for (const row of rows) {
    if (!row.own_attempt_parked) {
      if (prepaidAndNobodyArrived(row)) continue;
      let last;
      try {
        last = await latestCloseoutAudit(conn, { visitId: row.visit_id, invoiceId: row.invoice_id });
      } catch (err) {
        logger.error(`[invoice-issued-closeout] issued-invoice retry: audit lookup failed for invoice ${row.invoice_id}: ${err.message}`);
        continue;
      }
      if (last && !refusedForTheMoment(last)) continue;
    }
    const trigger = SETTLED_INVOICE_STATUSES.includes(String(row.invoice_status)) ? 'paid' : 'sent';
    // A bar send's card named the visit this closeout may close (or none): the sweep keeps to it. The pin covers the
    // send's closeout only, so a settled invoice (trigger 'paid') is retried as the payment rails always do.
    let approvedTarget = null;
    if (trigger === 'sent') {
      try {
        approvedTarget = await approvedCloseoutTargetFor(conn, row.invoice_id);
      } catch (err) {
        logger.error(`[invoice-issued-closeout] issued-invoice retry: pin lookup failed for invoice ${row.invoice_id}: ${err.message}`);
        continue;
      }
    }
    retried += 1;
    const out = await closeOutVisitForIssuedInvoice({ invoiceId: row.invoice_id, trigger, conn, today, ...(approvedTarget ? { approvedTarget } : {}) });
    if (out?.closed) closed += 1;
  }
  if (retried) logger.info(`[invoice-issued-closeout] issued-invoice retry: ${rows.length} candidate(s), ${retried} retried, ${closed} closed`);
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
      // critical: the helper's default swallows a failed insert, which would
      // report a row that does not exist. The retry sweeps act on this row,
      // so its absence must be visible here (the catch below returns false).
      critical: true,
    });
    return true;
  } catch (auditErr) {
    logger.warn(`[invoice-issued-closeout] audit write failed for visit ${visitId}: ${auditErr.message}`);
    return false;
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
  const audited = await auditCloseoutOutcome(run, { closed: false, visitId, code: 'invoice_void' });
  return { closed: false, reason: 'invoice_void', visitId, audited };
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
    const audited = await auditCloseoutOutcome(run, { closed: false, visitId: resolved.visit.id, code: resolved.reason });
    return { closed: false, reason: resolved.reason, visitId: resolved.visit.id, audited };
  }
  // No linked visit: nothing to audit against, and nothing a sweep could close.
  return { closed: false, reason: resolved.reason, visitId: null };
}

// An approved target (the Intelligence Bar's send card: the visit id it said would be closed, or 'none'):
// the closeout runs only for that visit. A different live visit is left open and audited as a refusal that
// the retry sweeps do not reconsider (a person decides). A send with no approved target is unchanged.
async function refuseUnapprovedTarget(run) {
  if (!run.approvedTarget || run.svc.id === run.approvedTarget) return null;
  logger.warn(`[invoice-issued-closeout] ${run.label} → approved_target_mismatch: approved ${run.approvedTarget}, live visit ${run.svc.id}; left open`);
  const audited = await auditCloseoutOutcome(run, { closed: false, visitId: run.svc.id, code: 'approved_target_mismatch' });
  return { closed: false, reason: 'approved_target_mismatch', visitId: run.svc.id, approvedTarget: run.approvedTarget, audited };
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
  const audited = await auditCloseoutOutcome(run, { closed: outcome.closed, visitId: run.svc.id, resumed: run.resuming, status: outcome.status, code: outcome.code });
  return { closed: outcome.closed, reason: outcome.closed ? null : (outcome.code || `status_${outcome.status}`), visitId: run.svc.id, resumed: run.resuming, audited };
}

// The canonical completion's { status, body } read once, in one shape.
function completionOutcome(result) {
  const body = (result && result.body) || {};
  const status = (result && result.status) || null;
  return { closed: status === 200 && body.success === true, status, code: body.code || null, error: body.error || null };
}

const issuedCloseoutIdempotencyKey = (invoiceId) => `invoice-issued:${invoiceId}`;

// Read-only: the visit closeOutVisitForIssuedInvoice would complete (or finish
// resuming) for this invoice right now, or null — gate off, no linked visit, or
// any refusal. The same resolver and resume probe the closeout runs, writing
// no audit row, for the Intelligence Bar card to disclose the effect before it
// happens. A probe that cannot read throws; the caller treats that as unknown.
async function issuedCloseoutTarget(invoice, { trigger = 'paid', conn = db, today = etDateString() } = {}) {
  if (!isEnabled('invoiceIssuedClosesVisit')) return null;
  const resolved = await resolveVisitForIssuedInvoice(conn, invoice, { today, trigger });
  let visit = resolved.svc;
  let resuming = false;
  if (!visit && resolved.reason === 'visit_completed'
    && await resumableIssuedCloseoutAttempt(conn, { serviceId: resolved.visit.id, idempotencyKey: issuedCloseoutIdempotencyKey(invoice.id) })) {
    visit = resolved.visit;
    resuming = true;
  }
  return visit ? { visitId: visit.id, serviceType: visit.service_type || null, date: dateOnly(visit.scheduled_date), resuming } : null;
}

async function loadCloseoutInvoice(run) {
  run.invoice = await run.conn('invoices').where({ id: run.invoiceId }).first();
  if (!run.invoice) return false;
  run.label = `invoice ${run.invoice.invoice_number || run.invoice.id} ${run.trigger}`;
  run.idempotencyKey = issuedCloseoutIdempotencyKey(run.invoice.id);
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
  // `audited` (on EVERY outcome that has a linked visit — refusals, failures
  // and completions alike): the audit row exists. The retry sweeps act on
  // that row, so an outcome that is not closed and not audited has nothing
  // durable recording that a closeout may still be owed; a caller with a
  // redelivery mechanism (the Stripe webhook) must use it. False here too
  // when the failure came before any visit was in hand (pre-push audit P1).
  const audited = visitId
    ? await auditCloseoutOutcome(run, { closed: false, visitId, resumed: run.resuming, code: 'error', error: String(err.message || err).slice(0, 500) })
    : false;
  return { closed: false, reason: 'error', error: err.message, visitId, audited };
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
async function closeOutVisitForIssuedInvoice({ invoiceId, trigger, actorTechnicianId = null, actorRole = null, conn = db, today = etDateString(), approvedTarget = null } = {}) {
  if (!isEnabled('invoiceIssuedClosesVisit')) return { closed: false, reason: 'gate_off' };
  if (!invoiceId || !['sent', 'paid'].includes(trigger)) return { closed: false, reason: 'bad_input' };
  const run = { invoiceId, trigger, actorTechnicianId, actorRole, conn, today, approvedTarget: approvedTarget || null, invoice: null, linkedVisitId: null, svc: null, resuming: false, label: null, idempotencyKey: null };
  try {
    if (!(await loadCloseoutInvoice(run))) return { closed: false, reason: 'no_invoice' };
    const refused = (await refuseVoidedInvoice(run)) || (await resolveCloseoutTarget(run)) || (await refuseUnapprovedTarget(run));
    return refused || await runQuietCloseout(run);
  } catch (err) {
    return auditCloseoutFailure(run, err);
  }
}

module.exports = {
  issuedCloseoutOwnsRecord,
  closeOutVisitsForStatement,
  retrySettledStatementCloseouts,
  retryIssuedInvoiceCloseouts,
  visitJobTimerRunning,
  OPEN_VISIT_STATUSES,
  ARRIVED_VISIT_STATUSES,
  isLiveVisitStatus,
  isArrivedVisitStatus,
  issuedCloseoutVisitRefusal,
  invoiceIssuedDay,
  issuedDayForInvoice,
  resolveVisitForIssuedInvoice,
  resumableIssuedCloseoutAttempt,
  closeOutVisitForIssuedInvoice,
  issuedCloseoutTarget,
  recordApprovedCloseoutTarget,
};
