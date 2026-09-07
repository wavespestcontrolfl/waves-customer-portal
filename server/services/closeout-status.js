/**
 * Closeout status — ONE read-only answer to "is this completed visit actually
 * closed out?", returned as TEN SEPARATE facts, never one boolean.
 *
 * Why this exists: the pieces have always been there — the catalog
 * requirement resolver (service-closeout-requirements.js), the completion
 * claim table (completion-attempts.js), the invoice-candidate lookups
 * (completion-invoice-candidate.js), the report delivery queue
 * (service-report/delivery-queue.js), the frozen follow-up verdict
 * (typed-followup-obligation.js) — but nothing composed them. The only
 * consumer that joined any of them was the command-center attention feed,
 * which is scoped to today's jobs, truncates at 50, and swallows every lookup
 * error into "missing". Three different code paths write service_records
 * (admin-dispatch /complete, project-completion, pest-recap) with divergent
 * side-effect bookkeeping, so each downstream surface re-derived its own
 * partial notion of "done".
 *
 * Contract:
 *   getCloseoutStatus(serviceId) -> {
 *     serviceId, asOf, visit, record, packet, requirements, billing,
 *     facts: { completion, application, photos, report, reportDelivery,
 *              invoice, invoiceDelivery, comms, followUp, license },
 *     contradictions: [...], unavailable: [...]
 *   }
 *
 *   Every fact is { state, reason, ...evidence } with state in FACT_STATES:
 *     not_required — a rule says this artifact is legitimately absent
 *                    (reason names the rule and `ruleSource` names where it
 *                    lives: catalog / frozen_record / lane / visit_flag)
 *     pending      — required and not yet satisfied (may be in flight)
 *     done         — satisfied, with the evidence that proves it
 *     failed       — the system tried and gave up (terminal failure)
 *     unknown      — the lookup itself was unavailable; NEVER rendered as
 *                    "missing" (the command-center `.catch(() => [])` bug)
 *
 * Rules this module deliberately reuses instead of re-deriving:
 *   - completion state:   completionStatusForService (claim precedence)
 *   - "no invoice needed": predictCompletionBilling with the same inputs the
 *                          appointment card assembles (admin-schedule.js) —
 *                          lane, autopay, visit-month dues, validated annual
 *                          coverage. Callback / always-free types never bill.
 *   - invoice reuse/park:  completionNewestLiveInvoiceLookup +
 *                          completionTerminalInvoiceLookup + reconcile — a
 *                          refunded row beside a live row is PARKED (manual),
 *                          never "invoiced".
 *   - delivery posture:    the FROZEN structured_notes.typedReportDelivery
 *                          (internal_only mints a staff token but never
 *                          delivers; disabled mints nothing). Absent = auto_send.
 *   - follow-up:           typedFollowupObligationForCompletedSource (frozen
 *                          verdict; live profile never retro-invents one).
 *
 * Requirements are FROZEN-FIRST: a completion writes the resolved catalog
 * requirements into structured_notes.closeoutRequirements
 * (service-closeout-requirements.js), and this reader replays that snapshot
 * — later catalog edits/renames cannot flip a frozen visit's verdict, and a
 * frozen verdict never depends on catalog availability. Records completed
 * before the freeze shipped (and not backfilled) still read the LIVE
 * catalog; `requirements.asOf` distinguishes the two
 * ('frozen_at_completion' vs 'current_catalog').
 *
 * READ-ONLY. No writes, no Stripe, no notifications, no customer comms.
 */
const db = require('../models/db');
const logger = require('./logger');
const { resolveCloseoutRequirementsForJobs, frozenCloseoutRequirements } = require('./service-closeout-requirements');
const { completionStatusForService } = require('./completion-attempts');
const {
  completionNewestLiveInvoiceLookup,
  completionTerminalInvoiceLookup,
  reconcileLiveVsRefunded,
  splitTerminalCompletionInvoice,
} = require('./completion-invoice-candidate');
const {
  resolveBillingLane,
  predictCompletionBilling,
  monthlyDuesCollected,
} = require('./billing-lane');
const { isAlwaysFreeServiceType } = require('./no-cost-visit-types');
const { customerOnAutopay } = require('./autopay-eligibility');
const { typedFollowupObligationForCompletedSource, FOLLOWUP_CHILD_INACTIVE_STATUSES } = require('./typed-followup-obligation');

const FACT_STATES = Object.freeze(['not_required', 'pending', 'done', 'failed', 'unknown']);
const FACT_NAMES = Object.freeze([
  'completion', 'application', 'photos', 'report', 'reportDelivery',
  'invoice', 'invoiceDelivery', 'comms', 'followUp', 'license',
]);
// Frozen structured_notes.visitOutcome values that mean NOTHING was applied
// (admin-dispatch.js visitPerformed): no bill, no application log owed.
const NON_PERFORMED_OUTCOMES = new Set(['inspection_only', 'customer_declined']);

// Visit statuses that mean "the tech reported it done" (job-status.js is the
// sole writer; 'incomplete' is a service_records status, not a visit status).
const COMPLETED_VISIT_STATUSES = new Set(['completed']);
// 'rescheduled' rows are phantoms — the visit moved to a new row (the
// schedule feed drops them the same way).
const INACTIVE_VISIT_STATUSES = new Set(['cancelled', 'canceled', 'skipped', 'no_show', 'rescheduled']);
// projects.delivery_status (migration 20260511000001): not_sent | sending |
// sent | failed | legacy_sent. Project/WDO reports live on projects.report_token,
// NOT service_records.report_view_token (project-completion.js nulls it), and
// the project links to the visit through projects.scheduled_service_id /
// projects.service_record_id — scheduled_services carries no project_id.
// Follow-up children that do not satisfy the obligation come from the
// canonical helper (typed-followup-obligation.js) — the same list its partial
// unique index enforces; never a local copy.
// Invoice statuses that prove the customer was shown the bill even when the
// sent_at stamp predates the column.
const INVOICE_DELIVERED_STATUSES = new Set(['sent', 'viewed', 'overdue', 'paid', 'prepaid', 'partially_paid']);
// 'prepaid' = settled from account credit / prepayment; invoice.js refuses to
// send one, so no delivery is owed (pre-push codex r4).
const INVOICE_SETTLED_STATUSES = new Set(['paid', 'prepaid']);
// Paid-receipt enqueue grace (owner ruling 2026-09-03, #3776 follow-up):
// a paid invoice with no receipt job younger than this reads as
// pending_enqueue, not as an operator gap.
const RECEIPT_ENQUEUE_GRACE_MS = 5 * 60 * 1000;
// Report delivery queue statuses (service_report_deliveries.status).
const DELIVERY_TERMINAL_OK = new Set(['sent']);
const DELIVERY_TERMINAL_SKIPPED = new Set(['skipped', 'cancelled', 'canceled']);
const DELIVERY_IN_FLIGHT = new Set(['queued', 'sending']);
const ACTIVE_PACKET_STATUSES = new Set(['accepted', 'processing']);

// Provider / DB error text can embed a recipient email, a token, or bound
// values. Scrub before it leaves the service — an IB tool may echo it.
function scrubErrorText(value) {
  if (value == null) return null;
  return String(value)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b[a-f0-9]{24,}\b/gi, '[token]')
    .replace(/\b\d{7,}\b/g, '[digits]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200) || null;
}

// service_report_deliveries.status 'skipped' is overloaded (delivery-queue.js
// markDeliverySkipped ← email-delivery.js): a suppression match is policy, a
// missing recipient is a real gap, an ineligible record is undecidable. The
// skip reason text is the only discriminator persisted.
function classifyDeliverySkip(reasonText) {
  const t = String(reasonText || '').toLowerCase();
  if (!t) return { state: 'unknown', reason: 'delivery_skipped_unclassified' };
  if (t.startsWith('suppressed') || t.includes('email suppressed')) return { state: 'not_required', reason: 'delivery_skipped_suppressed', ruleSource: 'email_suppression' };
  if (t.includes('no service report recipient email') || t.includes('no email on file') || t.includes('recipient')) return { state: 'failed', reason: 'delivery_skipped_no_recipient' };
  if (t.includes('not a completed service report') || t.includes('unsupported service report') || t.includes('table unavailable')) return { state: 'unknown', reason: 'delivery_skipped_ineligible' };
  return { state: 'unknown', reason: 'delivery_skipped_unclassified' };
}

// receipt_delivery_jobs channel legs: sms_result { sent, reason } and
// email_result { ok, error }. Policy skips are the customer's/owner's own
// choice; no-phone / no-email are gaps; 'already-sent' means another path
// delivered it.
const RECEIPT_SMS_POLICY = new Set(['payer_billed', 'channel_email_only', 'receipt_texts_opted_out', 'sms_suppressed']);
const RECEIPT_EMAIL_POLICY = new Set(['receipt_opted_out', 'email_opted_out']);
function classifyReceiptLegs(smsResult, emailResult) {
  const sms = parseJsonObjectSafe(smsResult);
  const email = parseJsonObjectSafe(emailResult);
  const smsKind = !Object.keys(sms).length ? 'absent'
    : sms.sent === true || sms.reason === 'already-sent' ? 'delivered'
      : sms.reason === 'no-phone' ? 'gap'
        : RECEIPT_SMS_POLICY.has(String(sms.reason || '')) ? 'policy' : 'other';
  const emailKind = !Object.keys(email).length ? 'absent'
    : email.ok === true ? 'delivered'
      : email.error === 'No receipt recipient email' ? 'gap'
        : RECEIPT_EMAIL_POLICY.has(String(email.error || '')) ? 'policy' : 'other';
  const kinds = [smsKind, emailKind];
  return {
    delivered: kinds.includes('delivered'),
    gap: kinds.includes('gap'),
    policy: kinds.includes('policy') && !kinds.includes('other'),
    detail: { sms: smsKind, email: emailKind },
  };
}

// FDACS applicator categories: the catalog stores CODES (license_category
// 'GHP' / 'L&O'), technicians.license_categories is free-form text. Both
// sides canonicalize through this map before comparison.
const LICENSE_CATEGORY_ALIASES = {
  ghp: 'ghp', generalhouseholdpest: 'ghp', generalhouseholdpestcontrol: 'ghp', householdpest: 'ghp',
  lo: 'lo', lawnornamental: 'lo', lawnandornamental: 'lo', lawnornamentalpest: 'lo',
  termite: 'termite', wdo: 'termite', termiteandotherwdo: 'termite', termiteotherwdo: 'termite', termiteandotherwooddestroyingorganisms: 'termite',
};
function canonicalLicenseCategory(value) {
  const key = String(value || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '').replace(/^lawnand/, 'lawn').replace(/^lawnornamental$/, 'lawnornamental');
  if (!key) return null;
  return LICENSE_CATEGORY_ALIASES[key] || LICENSE_CATEGORY_ALIASES[key.replace(/and/g, '')] || key;
}

function fact(state, reason, extra = {}) {
  if (!FACT_STATES.includes(state)) throw new Error(`closeout-status: bad fact state ${state}`);
  return { state, reason, ...extra };
}

function parseJsonObjectSafe(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isoOrNull(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Wrap one lookup so a failure becomes { error } instead of a thrown or a
// silently-empty result. `unavailable` collects the labels for the caller.
async function probe(label, unavailable, fn) {
  try {
    return { value: await fn() };
  } catch (err) {
    unavailable.push({ lookup: label, error: scrubErrorText(err?.message || err) });
    return { value: undefined, error: err };
  }
}

// ---------------------------------------------------------------------------
// Loader — every DB read for one service, each individually fallible.
// ---------------------------------------------------------------------------
function visitSummaryDeliveryFact(effects) {
  const delivered = effects.find((effect) => effect.status === 'sent');
  if (delivered) return fact('done', 'visit_summary_delivered', { channel: delivered.effect_type,
    sentAt: isoOrNull(delivered.sent_at), source: 'visit_effects' });
  if (effects.some((effect) => effect.status === 'unknown_delivery')) return fact('unknown', 'visit_summary_delivery_unknown');
  if (effects.length === 2 && effects.every((effect) => effect.status === 'suppressed')) {
    return fact('not_required', 'visit_summary_suppressed', { ruleSource: 'visit_effects' });
  }
  return fact('pending', 'visit_summary_delivery_pending');
}

async function loadCloseoutInputs(serviceId, { knex = db, now = new Date(), _restarts = 0 } = {}) {
  const unavailable = [];
  const inputs = { serviceId, now, unavailable };

  const visitProbe = await probe('scheduled_services', unavailable, () => knex('scheduled_services')
    .where({ id: serviceId })
    .first());
  const visit = visitProbe.value || null;
  inputs.visit = visit;
  inputs.visitLookupFailed = Boolean(visitProbe.error);
  if (!visit) return inputs;

  const customerId = visit.customer_id || null;

  const [
    customerProbe, recordProbe, attemptProbe, formsProbe, packetProbe, membersProbe,
  ] = await Promise.all([
    probe('customers', unavailable, () => (customerId
      ? knex('customers').where({ id: customerId }).first(
        'id', 'billing_mode', 'waveguard_tier', 'monthly_rate', 'per_application_fee',
        'autopay_enabled', 'autopay_paused_until', 'autopay_payment_method_id', 'ach_status', 'payer_id',
      )
      : null)),
    probe('service_records', unavailable, () => knex('service_records')
      .where({ scheduled_service_id: serviceId })
      .orderBy('created_at', 'desc')
      .select()),
    probe('service_completion_attempts', unavailable, () => completionStatusForService({ serviceId }, knex)),
    probe('job_form_submissions', unavailable, () => knex('job_form_submissions')
      .where({ scheduled_service_id: serviceId })
      .whereNotNull('completed_at')
      .count('* as n')
      .first()),
    probe('visit_completion_packets', unavailable, () => (visit.visit_id
      ? knex('visit_completion_packets').where({ visit_id: visit.visit_id }).select('id', 'status', 'created_at')
      : [])),
    probe('service_visits members', unavailable, () => (visit.visit_id
      ? knex('scheduled_services').where({ visit_id: visit.visit_id }).select('id')
      : [])),
  ]);

  inputs.customer = customerProbe.value || null;
  inputs.customerLookupFailed = Boolean(customerProbe.error);
  inputs.attempt = attemptProbe.value || null;
  inputs.attemptLookupFailed = Boolean(attemptProbe.error);
  // scheduled_service_id is NOT unique on service_records (completion,
  // project, and recap rails can each leave a row). Evidence aggregates
  // across all of them; the PRIMARY record is the attempt's committed one
  // when known, else the newest.
  const records = Array.isArray(recordProbe.value) ? recordProbe.value : [];
  inputs.records = recordProbe.error ? null : records;
  inputs.record = (inputs.attempt?.serviceRecordId && records.find((r) => r.id === inputs.attempt.serviceRecordId)) || records[0] || null;
  inputs.recordLookupFailed = Boolean(recordProbe.error);
  // FROZEN-FIRST requirements (sequenced after the record probe on purpose):
  // a record carrying structured_notes.closeoutRequirements replays the
  // verdict in force at completion — no `services` probe at all, so a frozen
  // visit's status depends on neither later catalog edits/renames nor
  // catalog availability. Pre-freeze records keep the live-catalog read,
  // labeled by requirements.asOf.
  const frozenRequirements = frozenCloseoutRequirements(inputs.record ? inputs.record.structured_notes : null);
  if (frozenRequirements) {
    inputs.requirements = frozenRequirements;
  } else {
    const requirementsProbe = await probe('services (closeout requirements)', unavailable, async () => {
      const map = await resolveCloseoutRequirementsForJobs([{
        id: serviceId,
        service_id: visit.service_id || null,
        service_type: visit.service_type || null,
      }], { knex, strict: true });
      return map.get(serviceId) || null;
    });
    inputs.requirements = requirementsProbe.value || null;
  }
  inputs.completedFormCount = formsProbe.value ? toNumber(formsProbe.value.n) : (formsProbe.error ? null : 0);
  inputs.packets = Array.isArray(packetProbe.value) ? packetProbe.value : (packetProbe.error ? null : []);
  inputs.packetMemberIds = Array.isArray(membersProbe.value)
    ? membersProbe.value.map((r) => r.id)
    : (membersProbe.error ? null : []);
  const record = inputs.record;
  const recordId = record?.id || null;
  const recordIds = (inputs.records || []).map((r) => r.id).filter(Boolean);
  let packetInvoiceId = null;
  if (visit.visit_id && recordId) {
    const linked = await probe('visit packet invoice identity', unavailable, () => knex('visit_completion_packet_items as i')
      .join('visit_completion_packets as p', 'p.id', 'i.packet_id')
      .join('invoices as invoice', 'invoice.id', 'i.invoice_id')
      .where({ 'i.scheduled_service_id': serviceId, 'i.service_record_id': recordId,
        'p.visit_id': visit.visit_id, 'invoice.customer_id': visit.customer_id })
      .whereRaw('invoice.visit_completion_packet_id = p.id')
      .first('i.invoice_id'));
    packetInvoiceId = linked.value?.invoice_id || null;
    inputs.packetInvoiceLookupFailed = Boolean(linked.error);
    const summary = await probe('visit summary delivery', unavailable, () => knex('visit_completion_packet_items as i')
      .join('visit_completion_packets as p', 'p.id', 'i.packet_id')
      .join('service_visits as v', 'v.id', 'p.visit_id')
      .join('visit_effects as e', 'e.visit_id', 'v.id')
      .where({ 'i.scheduled_service_id': serviceId, 'i.service_record_id': recordId, 'i.status': 'done', 'v.id': visit.visit_id })
      .whereIn('p.status', ['processing', 'done']).whereIn('v.status', ['closing', 'closed'])
      .whereNotNull('v.summary_token_issued_at').whereNull('v.summary_token_revoked_at')
      .whereIn('e.effect_type', ['completion_sms', 'completion_email'])
      .select('e.effect_type', 'e.status', 'e.sent_at'));
    inputs.visitSummaryEffects = summary.value || [];
    inputs.visitSummaryLookupFailed = Boolean(summary.error);
  }

  // Project/WDO link: projects.scheduled_service_id (or service_record_id) —
  // never a column on the visit. Newest wins if a visit was ever re-linked.
  const projectProbe = await probe('projects', unavailable, () => knex('projects')
    .where((qb) => {
      qb.where({ scheduled_service_id: serviceId });
      // Legacy record-only links can point at ANY of the visit's records.
      if (recordIds.length) qb.orWhereIn('service_record_id', recordIds);
    })
    .orderBy('created_at', 'desc')
    .first());
  inputs.project = projectProbe.value || null;
  inputs.projectLookupFailed = Boolean(projectProbe.error);
  const projectId = inputs.project?.id || null;

  // License identity — resolveProjectApplicator precedence: an EXPLICIT
  // findings.applicator_fdacs_id is authoritative (the person who signed);
  // created_by_tech_id fills blanks; the scheduled assignee only applies to
  // non-project visits.
  const projectFindings = inputs.project ? parseJsonObjectSafe(inputs.project.findings) : {};
  const findingsApplicatorId = projectFindings.applicator_fdacs_id ? String(projectFindings.applicator_fdacs_id).trim() : null;
  let technicianProbe = { value: null };
  if (findingsApplicatorId) {
    inputs.applicatorFindingsId = findingsApplicatorId;
    inputs.licenseTechSource = 'project_findings_applicator';
    technicianProbe = await probe('technicians (by applicator id)', unavailable, () => knex('technicians')
      .where({ fl_applicator_license: findingsApplicatorId })
      .first('id', 'fl_applicator_license', 'license_expiry', 'license_categories'));
  } else {
    const licenseTechId = inputs.project?.created_by_tech_id || visit.technician_id || null;
    inputs.licenseTechSource = inputs.project?.created_by_tech_id ? 'project_applicator' : 'scheduled_technician';
    technicianProbe = await probe('technicians', unavailable, () => (licenseTechId
      ? knex('technicians').where({ id: licenseTechId }).first('id', 'fl_applicator_license', 'license_expiry', 'license_categories')
      : null));
  }
  inputs.technician = technicianProbe.value || null;
  inputs.technicianLookupFailed = Boolean(technicianProbe.error);

  const [
    activeAppsProbe, retractedAppsProbe, photosProbe, deliveryProbe, liveInvoiceProbe, terminalInvoiceProbe,
    autopayProbe, followupProbe, childProbe, dispositionProbe,
  ] = await Promise.all([
    probe('property_application_history (active)', unavailable, () => (recordIds.length
      ? knex('property_application_history').whereIn('service_record_id', recordIds).whereNull('retracted_at').count('* as n').first()
      : { n: 0 })),
    probe('property_application_history (retracted)', unavailable, () => (recordIds.length
      ? knex('property_application_history').whereIn('service_record_id', recordIds).whereNotNull('retracted_at').count('* as n').first()
      : { n: 0 })),
    probe(projectId ? 'project_photos' : 'service_photos', unavailable, () => {
      // Project completions store their evidence on the project, not the
      // service record (routes/admin-projects.js counts project_photos).
      // Follow-up uploads never satisfy the SOURCE visit's evidence.
      if (projectId) return knex('project_photos').where({ project_id: projectId, visit: 'primary' }).count('* as n').first();
      return recordIds.length
        ? knex('service_photos').whereIn('service_record_id', recordIds).count('* as n').first()
        : { n: 0 };
    }),
    probe('service_report_deliveries', unavailable, async () => {
      if (!recordIds.length) return [];
      const rows = await knex('service_report_deliveries').whereIn('service_record_id', recordIds).orderBy('created_at', 'desc').select();
      return Array.isArray(rows) ? rows : [];
    }),
    probe('invoices (live)', unavailable, () => completionNewestLiveInvoiceLookup(knex, {
      serviceRecordId: recordId, scheduledServiceId: serviceId, invoiceId: packetInvoiceId,
    })),
    probe('invoices (refunded)', unavailable, () => completionTerminalInvoiceLookup(knex, {
      serviceRecordId: recordId, scheduledServiceId: serviceId, invoiceId: packetInvoiceId,
    })),
    // failClosed makes a payment_methods lookup failure THROW (default
    // swallows it as "not on autopay") so the probe can record an outage.
    probe('autopay eligibility', unavailable, () => (inputs.customer
      ? customerOnAutopay(inputs.customer, { db: knex, now, failClosed: true })
      : null)),
    probe('typed follow-up obligation', unavailable, () => typedFollowupObligationForCompletedSource({
      scheduledService: visit, knex, strict: true, recordId,
    })),
    probe('scheduled_services (follow-up child)', unavailable, () => knex('scheduled_services')
      .where({ followup_source_service_id: serviceId })
      .whereNotIn('status', FOLLOWUP_CHILD_INACTIVE_STATUSES)
      .orderBy('scheduled_date', 'asc')
      .first('id', 'status', 'scheduled_date')),
    // Human billing ruling from the Billing Recovery workbench — durable,
    // one row per visit ('billed' | 'intentionally_free').
    probe('visit_billing_dispositions', unavailable, () => knex('visit_billing_dispositions')
      .where({ scheduled_service_id: serviceId })
      .first('id', 'disposition', 'reason', 'invoice_id', 'created_at')),
  ]);

  inputs.activeApplicationCount = activeAppsProbe.value ? toNumber(activeAppsProbe.value.n) : null;
  inputs.retractedApplicationCount = retractedAppsProbe.value ? toNumber(retractedAppsProbe.value.n) : null;
  inputs.photoCount = photosProbe.value ? toNumber(photosProbe.value.n) : null;
  inputs.photoSource = projectId ? 'project_photos' : 'service_photos';
  inputs.deliveries = deliveryProbe.error ? null : (deliveryProbe.value || []);
  inputs.deliveryLookupFailed = Boolean(deliveryProbe.error);
  inputs.liveInvoice = liveInvoiceProbe.value || null;
  inputs.liveInvoiceLookupFailed = Boolean(liveInvoiceProbe.error || inputs.packetInvoiceLookupFailed);
  inputs.terminalInvoice = terminalInvoiceProbe.value || null;
  inputs.terminalInvoiceLookupFailed = Boolean(terminalInvoiceProbe.error || inputs.packetInvoiceLookupFailed);
  // Same fallback /complete uses when the visit carries no invoice of its
  // own: the accepted estimate's first-application invoice may hang off a
  // SIBLING visit (same estimate + date).
  if (!inputs.liveInvoice && !inputs.terminalInvoice && !liveInvoiceProbe.error && !terminalInvoiceProbe.error && visit.source_estimate_id) {
    const siblingProbe = await probe('invoices (sibling first-application)', unavailable, () => {
      const { findFirstApplicationInvoiceForEstimateService } = require('./estimate-first-application-invoice');
      return findFirstApplicationInvoiceForEstimateService(visit, knex);
    });
    inputs.siblingInvoice = siblingProbe.value || null;
    inputs.siblingInvoiceLookupFailed = Boolean(siblingProbe.error);
  }

  // Paid-receipt delivery is a queue (receipt_delivery_jobs); the invoice's
  // receipt_sent_at is stamped only on confirmed delivery. Keyed on the
  // EFFECTIVE invoice — the visit's own live row, else the live sibling.
  const siblingLive = inputs.siblingInvoice?.invoice && !splitTerminalCompletionInvoice(inputs.siblingInvoice.invoice).terminal
    ? splitTerminalCompletionInvoice(inputs.siblingInvoice.invoice).existing : null;
  const effectiveInvoice = inputs.liveInvoice || siblingLive || null;
  if (effectiveInvoice?.id && INVOICE_SETTLED_STATUSES.has(String(effectiveInvoice.status)) && !effectiveInvoice.receipt_sent_at) {
    const receiptProbe = await probe('receipt_delivery_jobs', unavailable, () => knex('receipt_delivery_jobs')
      .where({ invoice_id: effectiveInvoice.id })
      .orderBy('created_at', 'desc')
      .first('id', 'status', 'attempts', 'max_attempts', 'last_error', 'next_attempt_at', 'sms_result', 'email_result'));
    inputs.receiptJob = receiptProbe.value || null;
    inputs.receiptJobLookupFailed = Boolean(receiptProbe.error);
  }
  inputs.autopayActive = autopayProbe.error ? null : Boolean(autopayProbe.value);
  inputs.followup = followupProbe.error ? undefined : (followupProbe.value || null);
  inputs.followupChild = childProbe.value || null;
  inputs.followupChildLookupFailed = Boolean(childProbe.error);
  inputs.disposition = dispositionProbe.value || null;
  inputs.dispositionLookupFailed = Boolean(dispositionProbe.error);

  // The reads above are not one snapshot: a completion can commit between
  // the first visit read and the record probes. Re-read the visit row and,
  // when the status moved, RESTART the whole load so every dependent probe
  // (follow-up obligation, requirements, billing inputs) sees the new row —
  // swapping just the visit would mix two generations. Bounded: a visit
  // still moving after two restarts is surfaced via visitReRead, not looped.
  const reReadProbe = await probe('scheduled_services (re-read)', unavailable, () => knex('scheduled_services')
    .where({ id: serviceId })
    .first());
  if (reReadProbe.value && String(reReadProbe.value.status || '') !== String(visit.status || '')) {
    const marker = { from: visit.status || null, to: reReadProbe.value.status || null };
    if (_restarts < 2) {
      const fresh = await loadCloseoutInputs(serviceId, { knex, now, _restarts: _restarts + 1 });
      fresh.visitReRead = fresh.visitReRead || marker;
      return fresh;
    }
    inputs.visit = reReadProbe.value;
    inputs.visitReRead = marker;
  }



  // Billing prediction inputs — same shape the appointment card assembles
  // (routes/admin-schedule.js), so "no invoice needed" here agrees with the
  // sheet the tech saw at the doorstep.
  const lane = inputs.customer ? resolveBillingLane(inputs.customer) : null;
  inputs.lane = lane;
  let duesCollected = false;
  if (lane?.mode === 'monthly_membership' && inputs.autopayActive === false && customerId) {
    const visitDay = visit.scheduled_date ? new Date(`${String(visit.scheduled_date).slice(0, 10)}T12:00:00Z`) : now;
    const duesProbe = await probe('monthly dues collected', unavailable, () => monthlyDuesCollected(knex, customerId, visitDay));
    duesCollected = duesProbe.error ? false : Boolean(duesProbe.value);
    inputs.duesLookupFailed = Boolean(duesProbe.error);
  }
  inputs.duesCollectedThisMonth = duesCollected;
  let annualCoverageValidated = null;
  if (visit.prepaid_method === 'annual_prepay_invoice') {
    const coverageProbe = await probe('annual prepay coverage', unavailable, () => {
      const AnnualPrepayRenewals = require('./annual-prepay-renewals');
      return AnnualPrepayRenewals.annualPrepayCoversVisit(visit, knex, { throwOnError: true });
    });
    annualCoverageValidated = coverageProbe.error ? null : coverageProbe.value;
    inputs.annualCoverageLookupFailed = Boolean(coverageProbe.error);
  }
  inputs.annualCoverageValidated = annualCoverageValidated;
  let completionAutopayChargeEnabled = false;
  try {
    completionAutopayChargeEnabled = require('../config/feature-gates').gates.completionAutopayCharge === true;
  } catch { /* gate module unavailable in some test harnesses */ }
  inputs.completionAutopayChargeEnabled = completionAutopayChargeEnabled;

  // Effective bill-to payer — same COALESCE the schedule feed uses
  // (routes/admin-schedule.js effectiveBillToSql): a visit-level payer wins,
  // a self-pay override blanks the account payer, and only an ACTIVE payer
  // counts. Payer-billed visits owe an AP invoice even when dues would
  // otherwise cover them.
  const effectivePayerId = visit.payer_id
    || (visit.self_pay_override === true ? null : (inputs.customer?.payer_id || null));
  let payerBilled = false;
  if (effectivePayerId) {
    const payerProbe = await probe('payers', unavailable, () => knex('payers')
      .where({ id: effectivePayerId, active: true })
      .first('id'));
    payerBilled = payerProbe.error ? null : Boolean(payerProbe.value);
  }
  inputs.payerBilled = payerBilled;

  return inputs;
}

// ---------------------------------------------------------------------------
// Pure derivation — no I/O. Everything below is unit-testable with a hand-built
// inputs object.
// ---------------------------------------------------------------------------
function deriveBillingExpectation(inputs) {
  const { visit, customer, lane } = inputs;
  if (!visit) return null;
  if (visit.is_callback === true) return { kind: 'no_charge', why: 'callback', ruleSource: 'visit_flag' };
  if (isAlwaysFreeServiceType(visit.service_type)) return { kind: 'no_charge', why: 'always_free_service_type', ruleSource: 'visit_flag' };
  if (!customer || !lane) return null;
  const prediction = predictCompletionBilling({
    lane: lane.mode,
    billingMode: customer.billing_mode || null,
    autopayActive: inputs.autopayActive === true,
    estimatedPrice: visit.estimated_price != null ? Number(visit.estimated_price) : null,
    monthlyRate: customer.monthly_rate,
    perApplicationFee: customer.per_application_fee,
    isRecurring: visit.is_recurring === true,
    isCallback: visit.is_callback === true,
    serviceType: visit.service_type,
    payerBilled: inputs.payerBilled === true,
    prepaidAmount: visit.prepaid_amount,
    prepaidMethod: visit.prepaid_method || null,
    annualCoverageValidated: inputs.annualCoverageValidated,
    duesCollectedThisMonth: inputs.duesCollectedThisMonth === true,
    completionAutopayChargeEnabled: inputs.completionAutopayChargeEnabled === true,
  });
  return { ...prediction, why: prediction.kind, ruleSource: 'lane', laneSource: lane.source };
}

function deriveCloseoutFacts(inputs) {
  const now = inputs.now instanceof Date ? inputs.now : new Date();
  const contradictions = [];
  const visit = inputs.visit || null;
  const record = inputs.record || null;
  const notes = parseJsonObjectSafe(record?.structured_notes);
  const fieldFlags = parseJsonObjectSafe(record?.field_flags);
  const requirements = inputs.requirements || null;
  // Requirement-driven facts name where the rule lives: 'frozen_record' when
  // it replays the completion-time snapshot, 'catalog' when the live catalog
  // still decides (pre-freeze records). Reasons stay stable either way.
  const requirementsRuleSource = requirements?.frozen ? 'frozen_record' : 'catalog';
  // A backfilled snapshot's own source is the generic backfill marker; the
  // ORIGINAL verdict provenance rides in catalogSource (GH codex r2 P2) —
  // low-confidence classification must see through the wrapper.
  const underlyingRequirementsSource = requirements
    ? (requirements.catalogSource || requirements.source)
    : null;
  const visitCompleted = Boolean(visit && COMPLETED_VISIT_STATUSES.has(String(visit.status || '').toLowerCase()));
  const visitInactive = Boolean(visit && INACTIVE_VISIT_STATUSES.has(String(visit.status || '').toLowerCase()));
  const isBackfill = notes.backfill === true;
  const recordIncomplete = record?.status === 'incomplete';
  const visitOutcome = notes.visitOutcome ? String(notes.visitOutcome).toLowerCase() : null;
  const visitPerformed = !(visitOutcome && NON_PERFORMED_OUTCOMES.has(visitOutcome));
  const project = inputs.project || null;
  const projectBacked = Boolean(project) || record?.completion_source === 'project_completion' || inputs.projectLookupFailed === true;
  const frozenPosture = notes.typedReportDelivery ? String(notes.typedReportDelivery) : null;
  const posture = frozenPosture || 'auto_send';

  // ---- 1. completion --------------------------------------------------------
  let completion;
  const attemptState = inputs.attempt?.state || null;
  if (inputs.recordLookupFailed && !record) {
    completion = fact('unknown', 'service_records_lookup_failed', { visitStatus: visit?.status || null, attemptState });
  } else if (inputs.attemptLookupFailed) {
    // A record is committed evidence, but whether its side effects finished
    // lives in the attempt row — unreadable ⇒ unknown, even with a record.
    completion = fact('unknown', 'completion_attempts_lookup_failed', { visitStatus: visit?.status || null, recordId: record?.id || null });
  } else if (record && (attemptState === 'running' || attemptState === 'resumable')) {
    // Post-commit attempt: the record exists but side effects are still
    // pending/retryable (completion-attempts.js) — not closed out.
    completion = fact('pending', `completion_side_effects_${attemptState}`, { recordId: record.id, attemptState, visitStatus: visit?.status || null });
  } else if (record && !visitCompleted) {
    contradictions.push({
      code: 'record_without_completed_visit',
      detail: `service_records ${record.id} exists but scheduled_services.status is '${visit?.status}'`,
    });
    completion = fact('done', 'record_exists_visit_status_mismatch', {
      recordId: record.id, recordStatus: record.status || null, visitStatus: visit?.status || null,
      completionSource: record.completion_source || null, completedAt: isoOrNull(visit?.completed_at), attemptState, backfill: isBackfill,
    });
  } else if (record) {
    completion = fact(record.status === 'incomplete' ? 'pending' : 'done',
      record.status === 'incomplete' ? 'record_marked_incomplete' : 'record_exists', {
        recordId: record.id, recordStatus: record.status || null,
        completionSource: record.completion_source || null, completedAt: isoOrNull(visit?.completed_at),
        attemptState, backfill: isBackfill, recapLane: fieldFlags.recap === true,
      });
  } else if (visitInactive && !record) {
    // Inactive visit with no record owes nothing — even past a terminal
    // failed attempt (the replacement row owns the work after a reschedule).
    completion = fact('not_required', `visit_${String(visit.status).toLowerCase()}`, { ruleSource: 'visit_flag', visitStatus: visit.status, attemptState });
  } else if (attemptState === 'running' || attemptState === 'resumable') {
    completion = fact('pending', `completion_${attemptState}`, { attemptState });
  } else if (attemptState === 'failed') {
    completion = fact('failed', 'completion_attempt_failed', { attemptState, error: scrubErrorText(inputs.attempt?.error) });
  } else if (visitCompleted) {
    contradictions.push({
      code: 'completed_visit_without_record',
      detail: 'scheduled_services.status is completed but no service_records row references it',
    });
    completion = fact('pending', 'completed_visit_without_record', { attemptState, visitStatus: visit.status });
  } else if (visitInactive) {
    completion = fact('not_required', `visit_${String(visit.status).toLowerCase()}`, { ruleSource: 'visit_flag', visitStatus: visit.status });
  } else {
    completion = fact('pending', 'visit_not_completed', { visitStatus: visit?.status || null, attemptState });
  }
  const completed = completion.state === 'done';

  // Downstream facts before completion are all "waiting on completion" —
  // except for an inactive visit, where nothing is owed.
  const awaiting = (extra = {}) => {
    // A completion OUTAGE (record/attempt lookup failed) is unknown all the
    // way down — never a list of apparent compliance gaps.
    if (completion.state === 'unknown') return fact('unknown', 'completion_unknown', { completionReason: completion.reason, ...extra });
    if (visitInactive && !record) return fact('not_required', `visit_${String(visit.status).toLowerCase()}`, { ruleSource: 'visit_flag', ...extra });
    // A record the tech marked incomplete owes nothing downstream — the
    // visit gets rescheduled and the next completion carries the artifacts.
    if (recordIncomplete) return fact('not_required', 'record_marked_incomplete', { ruleSource: 'frozen_record', ...extra });
    return fact('pending', 'awaiting_completion', extra);
  };

  // ---- 2. application record -----------------------------------------------
  let application;
  if (!completed) application = awaiting();
  else if (!requirements) application = fact('unknown', 'requirements_unavailable');
  else if (!requirements.requiresApplicationLog) application = fact('not_required', 'catalog_no_application_log', { ruleSource: requirementsRuleSource, requirementsSource: requirements.source });
  else if (!visitPerformed) {
    if ((inputs.activeApplicationCount ?? 0) > 0) {
      // Products were logged on a visit whose frozen outcome says nothing
      // was applied — surface the ledger, block the rollup (GH r5).
      application = fact('done', 'applications_despite_non_performed_outcome', { activeCount: inputs.activeApplicationCount, visitOutcome });
      contradictions.push({ code: 'applications_on_non_performed_visit', detail: `${inputs.activeApplicationCount} active application row(s) but frozen visitOutcome is '${visitOutcome}'` });
    } else {
      application = fact('not_required', `visit_outcome_${visitOutcome}`, { ruleSource: 'frozen_record', visitOutcome });
    }
  }
  else if (inputs.activeApplicationCount == null) application = fact('unknown', 'application_history_lookup_failed');
  else if (inputs.activeApplicationCount > 0) application = fact('done', 'active_application_rows', { activeCount: inputs.activeApplicationCount, retractedCount: inputs.retractedApplicationCount ?? 0 });
  else if (underlyingRequirementsSource === 'fallback_inference' && inputs.retractedApplicationCount === 0) application = fact('pending', 'no_application_rows', { activeCount: 0, retractedCount: 0, lowConfidence: true, requirementsSource: underlyingRequirementsSource });
  else if (inputs.retractedApplicationCount == null) application = fact('unknown', 'application_history_lookup_failed', { activeCount: 0, detail: 'retracted-row lookup unavailable; cannot tell empty from all-retracted' });
  else if (inputs.retractedApplicationCount > 0) application = fact('failed', 'all_application_rows_retracted', { activeCount: 0, retractedCount: inputs.retractedApplicationCount });
  else application = fact('pending', 'no_application_rows', { activeCount: 0, retractedCount: 0 });

  // ---- 3. photos ---------------------------------------------------------------
  let photos;
  const requiredPhotos = requirements ? toNumber(requirements.requiredPhotoCount) : null;
  if (!completed) photos = awaiting();
  else if (!requirements) photos = fact('unknown', 'requirements_unavailable');
  else if (!(requiredPhotos > 0)) photos = fact('not_required', 'catalog_zero_required_photos', { ruleSource: requirementsRuleSource, requirementsSource: requirements.source, actual: inputs.photoCount ?? null });
  else if (inputs.projectLookupFailed) photos = fact('unknown', 'projects_lookup_failed_photo_source_undecidable', { required: requiredPhotos });
  else if (inputs.photoCount == null) photos = fact('unknown', `${inputs.photoSource || 'service_photos'}_lookup_failed`, { required: requiredPhotos });
  else if (inputs.photoCount >= requiredPhotos) photos = fact('done', 'photo_count_met', { required: requiredPhotos, actual: inputs.photoCount, source: inputs.photoSource || 'service_photos' });
  else photos = fact('pending', 'photo_count_short', { required: requiredPhotos, actual: inputs.photoCount, source: inputs.photoSource || 'service_photos' });

  // ---- 4. report (artifact exists / published) ---------------------------------
  let report;
  const tokenRecord = (inputs.records || []).find((r) => r.report_view_token || r.report_generated_at) || record;
  // The artifact and its frozen posture must come from the SAME record — a
  // sibling row's typedReportDelivery must not relabel another row's report.
  const tokenNotes = tokenRecord === record ? notes : parseJsonObjectSafe(tokenRecord?.structured_notes);
  const reportPosture = tokenNotes.typedReportDelivery ? String(tokenNotes.typedReportDelivery) : posture;
  const reportPublishedAt = isoOrNull(tokenRecord?.report_generated_at) || isoOrNull(tokenNotes.reportPublishedAt) || isoOrNull(tokenNotes.report_published_at);
  const hasReportToken = Boolean(tokenRecord?.report_view_token);
  const reportRequiredByCatalog = requirements ? requirements.requiresServiceReport !== false : null;
  if (!completed) report = awaiting();
  else if (projectBacked) {
    if (project?.report_token) {
      report = fact('done', 'project_report_published', {
        projectId: project.id, projectStatus: project.status || null, hasToken: true,
        audience: project.portal_visible === false ? 'token_only' : 'customer', source: 'projects.report_token',
      });
    } else if (inputs.projectLookupFailed) {
      report = fact('unknown', 'projects_lookup_failed');
    } else if (project) {
      report = fact('pending', project.status === 'closed' ? 'project_closed_without_report' : 'project_report_not_published', {
        projectId: project.id, projectStatus: project.status || null, source: 'projects.report_token',
      });
    } else {
      report = fact('pending', 'project_completion_without_project_row', { completionSource: record?.completion_source || null });
    }
  } else if (reportPosture === 'disabled') report = fact('not_required', 'frozen_posture_disabled', { ruleSource: 'frozen_record', posture: reportPosture, audience: 'none' });
  else if (reportRequiredByCatalog === false) {
    report = (hasReportToken || reportPublishedAt)
      ? fact('done', 'published_despite_catalog_not_required', { publishedAt: reportPublishedAt, hasToken: hasReportToken, audience: reportPosture === 'internal_only' ? 'internal' : 'customer', posture })
      : fact('not_required', 'catalog_no_service_report', { ruleSource: requirementsRuleSource, requirementsSource: requirements.source, posture });
  } else if (hasReportToken || reportPublishedAt) {
    report = fact('done', 'report_published', {
      publishedAt: reportPublishedAt, hasToken: hasReportToken, audience: reportPosture === 'internal_only' ? 'internal' : 'customer', posture,
      formSubmitted: inputs.completedFormCount == null ? null : inputs.completedFormCount > 0,
    });
  } else if (!requirements) report = fact('unknown', 'requirements_unavailable', { posture: reportPosture });
  else if (inputs.completedFormCount > 0) report = fact('pending', 'form_submitted_not_published', { posture: reportPosture, formSubmitted: true });
  else if (isBackfill) report = fact('not_required', 'backfill_completion', { ruleSource: 'frozen_record', posture });
  else report = fact('pending', 'no_report_artifact', { posture: reportPosture, formSubmitted: inputs.completedFormCount == null ? null : false });

  // ---- 5. report delivery ---------------------------------------------------------
  let reportDelivery;
  // Delivery evidence must belong to the SAME record as the report artifact
  // — an older sibling report's sent row must not deliver a newer one.
  const deliveryRows = Array.isArray(inputs.deliveries)
    ? inputs.deliveries.filter((r) => !tokenRecord?.id || r.service_record_id === tokenRecord.id)
    : (inputs.delivery ? [inputs.delivery] : []);
  const delivery = deliveryRows.find((r) => String(r.status) === 'sent') || deliveryRows[0] || null;
  // The delivery worker mirrors status onto the record OWNING the delivery —
  // read the mirror from the same record as the artifact (GH r5).
  const notesEmailStatus = tokenNotes.serviceReportV1EmailStatus ? String(tokenNotes.serviceReportV1EmailStatus).toLowerCase() : null;
  const recapSentAt = isoOrNull(record?.recap_sms_sent_at);
  // recap_sms_sent_at is an at-most-once CLAIM stamped before the provider
  // call (pest-recap clears it on a failed send) - a fresh claim is a send
  // in flight, not delivery evidence.
  const recapClaimAt = record?.recap_sms_sent_at ? new Date(record.recap_sms_sent_at) : null;
  const recapClaimSettled = recapClaimAt && (now.getTime() - recapClaimAt.getTime()) > 10 * 60 * 1000;
  const recapClaimFresh = recapClaimAt && !recapClaimSettled;
  if (!completed) reportDelivery = awaiting();
  else if (projectBacked) {
    const ds = project ? String(project.delivery_status || 'not_sent').toLowerCase() : null;
    const hold = project?.report_hold_status ? String(project.report_hold_status).toLowerCase() : null;
    const channels = parseJsonObjectSafe(project?.delivery_channels);
    const channelOk = Object.fromEntries(Object.entries(channels).map(([k, v]) => [k, v?.ok === true]));
    // Only CUSTOMER report channels count (never a payer/AP leg), and a WDO
    // report is email-only — the FDACS PDF rides the email
    // (routes/admin-projects.js `delivered = isWdo ? email.ok : any`).
    const isWdo = String(project?.project_type || '') === 'wdo_inspection';
    const anyChannelOk = isWdo ? channelOk.email === true : (channelOk.email === true || channelOk.sms === true);
    const evidence = {
      projectId: project?.id || null, deliveryStatus: ds, lastDeliveryAt: isoOrNull(project?.last_delivery_at),
      reportHoldStatus: hold, channelOk, source: 'projects.delivery_status',
    };
    if (report.state !== 'done') reportDelivery = fact(report.state === 'unknown' ? 'unknown' : 'pending', 'report_not_published', evidence);
    // Payment hold FIRST: the combined payer-invoice send stamps
    // delivery_status 'sent' while the report itself is still held.
    else if (hold === 'held' || hold === 'releasing') reportDelivery = fact('pending', 'project_report_on_hold', evidence);
    else if (ds === 'sent' || ds === 'legacy_sent') reportDelivery = fact('done', `project_delivery_${ds}`, evidence);
    // 'partial' = at least one channel reached the customer (done) OR the
    // required channel failed (WDO email-only) — the channel ledger decides.
    else if (ds === 'partial') reportDelivery = anyChannelOk
      ? fact('done', 'project_delivery_partial', evidence)
      : fact('failed', 'project_delivery_partial_no_channel', evidence);
    else if (ds === 'failed') reportDelivery = fact('failed', 'project_delivery_failed', evidence);
    else if (ds === 'sending') reportDelivery = fact('pending', 'project_delivery_sending', evidence);
    else reportDelivery = fact('pending', 'project_report_not_sent', evidence);
  } else if (report.state === 'not_required') reportDelivery = fact('not_required', report.reason, { ruleSource: report.ruleSource || 'frozen_record', posture });
  else if (reportPosture === 'internal_only') reportDelivery = fact('not_required', 'frozen_posture_internal_only', { ruleSource: 'frozen_record', posture: reportPosture, audience: 'internal' });
  else if (report.state !== 'done') reportDelivery = fact(report.state === 'unknown' ? 'unknown' : 'pending', 'report_not_published', { posture: reportPosture });
  else if (inputs.visitSummaryLookupFailed) reportDelivery = fact('unknown', 'visit_summary_lookup_failed');
  else if (inputs.visitSummaryEffects?.length) reportDelivery = visitSummaryDeliveryFact(inputs.visitSummaryEffects);
  else if (delivery) {
    const status = String(delivery.status || '').toLowerCase();
    const evidence = {
      channel: delivery.channel || null, status, attempts: toNumber(delivery.attempts), maxAttempts: toNumber(delivery.max_attempts, 5),
      sentAt: isoOrNull(delivery.sent_at), failedAt: isoOrNull(delivery.failed_at), nextAttemptAt: isoOrNull(delivery.next_attempt_at),
      lastError: scrubErrorText(delivery.last_error),
    };
    if (DELIVERY_TERMINAL_OK.has(status)) reportDelivery = fact('done', 'delivery_sent', evidence);
    else if (status === 'failed') reportDelivery = fact('failed', 'delivery_exhausted', evidence);
    else if (status === 'skipped') {
      const skip = classifyDeliverySkip(delivery.last_error);
      reportDelivery = fact(skip.state, skip.reason, { ...(skip.ruleSource ? { ruleSource: skip.ruleSource } : {}), ...evidence });
    } else if (DELIVERY_TERMINAL_SKIPPED.has(status)) reportDelivery = fact('not_required', `delivery_${status}`, { ruleSource: 'delivery_queue', ...evidence });
    else if (DELIVERY_IN_FLIGHT.has(status)) reportDelivery = fact('pending', `delivery_${status}`, evidence);
    else reportDelivery = fact('unknown', 'delivery_status_unrecognized', evidence);
  } else if (inputs.deliveryLookupFailed) reportDelivery = fact('unknown', 'service_report_deliveries_lookup_failed', { posture: reportPosture });
  else if (notesEmailStatus === 'disabled') reportDelivery = fact('not_required', 'report_email_kill_switch', { ruleSource: 'kill_switch', posture: reportPosture, notesStatus: notesEmailStatus });
  else if (notesEmailStatus === 'sent') reportDelivery = fact('done', 'delivery_sent_per_record_notes', { posture: reportPosture, sentAt: isoOrNull(tokenNotes.serviceReportV1EmailSentAt) });
  else if (notesEmailStatus === 'failed') reportDelivery = fact('failed', 'delivery_exhausted_per_record_notes', { posture: reportPosture, lastError: scrubErrorText(tokenNotes.serviceReportV1EmailError) });
  else if (notesEmailStatus === 'skipped') {
    const skip = classifyDeliverySkip(tokenNotes.serviceReportV1EmailError);
    reportDelivery = fact(skip.state, skip.reason, { ...(skip.ruleSource ? { ruleSource: skip.ruleSource } : {}), posture: reportPosture, lastError: scrubErrorText(tokenNotes.serviceReportV1EmailError) });
  }
  else if (notesEmailStatus === 'queued' || notesEmailStatus === 'sending') reportDelivery = fact('pending', `delivery_${notesEmailStatus}`, { posture: reportPosture });
  else if (isBackfill) reportDelivery = fact('not_required', 'backfill_completion', { ruleSource: 'frozen_record', posture });
  else if (recapClaimFresh) reportDelivery = fact('pending', 'recap_sms_in_flight', { channel: 'sms', recapSentAt });
  else if (recapSentAt && recapClaimSettled) reportDelivery = fact('unknown', 'recap_claim_unverified', { channel: 'sms', recapSentAt });
  else if (record?.report_template_version && record.report_template_version !== 'service_report_v1') {
    reportDelivery = fact('unknown', 'no_delivery_row_for_template', { posture: reportPosture, templateVersion: record.report_template_version });
  } else reportDelivery = fact('pending', 'not_enqueued', { posture: reportPosture });

  // ---- 6. invoice -----------------------------------------------------------------
  let invoice;
  const billingInputsFailed = [
    inputs.customerLookupFailed ? 'customer' : null,
    inputs.customer && inputs.autopayActive === null ? 'autopay' : null,
    inputs.duesLookupFailed === true ? 'monthly_dues' : null,
    inputs.payerBilled === null ? 'bill_to_payer' : null,
    inputs.annualCoverageLookupFailed === true ? 'annual_coverage' : null,
  ].filter(Boolean);
  const expectation = deriveBillingExpectation(inputs);
  const reconciled = reconcileLiveVsRefunded(inputs.liveInvoice, inputs.terminalInvoice, inputs.liveInvoice);
  const live = inputs.liveInvoice;
  if (!completed) invoice = awaiting({ expectation: expectation?.kind || null });
  else if (inputs.liveInvoiceLookupFailed || inputs.terminalInvoiceLookupFailed) {
    // Both probes must succeed before ANY verdict — a live row with an
    // unread refunded sibling would otherwise read done when it must park.
    invoice = fact('unknown', 'invoice_lookup_failed', {
      failed: [inputs.liveInvoiceLookupFailed ? 'live' : null, inputs.terminalInvoiceLookupFailed ? 'refunded' : null].filter(Boolean),
      expectation: expectation?.kind || null,
    });
  } else if (reconciled.terminal) {
    // ALWAYS parked while a refunded row exists beside a live one — even a
    // PAID live sibling (pre-push codex P0): a later refund.failed can
    // restore the refunded row to paid, leaving two paid invoices. Only a
    // human reconciles that; this service never declares it closed.
    invoice = fact('pending', 'parked_manual_refunded_invoice', {
      refundedInvoiceId: reconciled.terminal.id, liveBesideInvoiceId: reconciled.liveBeside?.id || null,
      liveBesideStatus: reconciled.liveBeside?.status || null, expectation: expectation?.kind || null,
    });
  } else if (live && billingInputsFailed.length) {
    // The row is evidence, but whether it SHOULD exist (covered / payer
    // billed) is undecidable while a billing input is unreadable.
    invoice = fact('unknown', 'billing_inputs_unavailable', {
      failed: billingInputsFailed, invoiceId: live.id, invoiceNumber: live.invoice_number || null, status: live.status || null,
      total: live.total != null ? Number(live.total) : null,
    });
  } else if (!live && inputs.siblingInvoiceLookupFailed) {
    invoice = fact('unknown', 'invoice_lookup_failed', { failed: ['sibling_first_application'], expectation: expectation?.kind || null });
  } else if (!live && inputs.siblingInvoice?.invoice && splitTerminalCompletionInvoice(inputs.siblingInvoice.invoice).terminal) {
    const t = splitTerminalCompletionInvoice(inputs.siblingInvoice.invoice).terminal;
    invoice = fact('pending', 'parked_manual_refunded_invoice', {
      refundedInvoiceId: t.id, liveBesideInvoiceId: inputs.siblingInvoice.liveBeside?.id || null,
      liveBesideStatus: inputs.siblingInvoice.liveBeside?.status || null, source: 'sibling_first_application', expectation: expectation?.kind || null,
    });
  } else if (!live && !inputs.siblingInvoice?.invoice && inputs.siblingInvoice?.canceledSetupFee) {
    // Canceled ACCEPTANCE invoice that carried the one-time setup fee beside
    // the visit charge (/complete parks the manual path so the office bills
    // BOTH by hand) — never not_required, whatever the lane says now.
    const c = inputs.siblingInvoice.canceledSetupFee;
    invoice = fact('pending', 'parked_manual_canceled_setup_fee', {
      canceledInvoiceId: c.id, canceledInvoiceNumber: c.invoice_number || null, canceledStatus: c.status || null,
      includedSetupFee: true, source: 'sibling_first_application', expectation: expectation?.kind || null,
    });
  } else if (!live && inputs.siblingInvoice?.invoice && splitTerminalCompletionInvoice(inputs.siblingInvoice.invoice).existing) {
    const sib = inputs.siblingInvoice.invoice;
    if (billingInputsFailed.length) {
      // Same outage guard as the own-visit live branch (GH r4).
      invoice = fact('unknown', 'billing_inputs_unavailable', {
        failed: billingInputsFailed, invoiceId: sib.id, invoiceNumber: sib.invoice_number || null, status: sib.status || null, source: 'sibling_first_application',
      });
    } else {
      invoice = fact('done', INVOICE_SETTLED_STATUSES.has(String(sib.status)) ? 'invoice_paid' : 'invoice_exists', {
        invoiceId: sib.id, invoiceNumber: sib.invoice_number || null, status: sib.status || null,
        total: sib.total != null ? Number(sib.total) : null, source: 'sibling_first_application', expectation: expectation?.kind || null,
      });
      if (!visitPerformed) {
        contradictions.push({ code: 'invoice_on_non_performed_visit', detail: `sibling invoice ${sib.id} exists but frozen visitOutcome is '${visitOutcome}' (nothing performed)` });
      }
    }
  } else if (live) {
    invoice = fact('done', INVOICE_SETTLED_STATUSES.has(String(live.status)) ? 'invoice_paid' : 'invoice_exists', {
      invoiceId: live.id, invoiceNumber: live.invoice_number || null, status: live.status || null,
      total: live.total != null ? Number(live.total) : null, payerBilled: Boolean(live.payer_id), expectation: expectation?.kind || null,
    });
    if (!visitPerformed) {
      // A bill exists for a visit whose frozen outcome says nothing was
      // performed — a blocking exception, never quietly done (codex GH r4).
      contradictions.push({ code: 'invoice_on_non_performed_visit', detail: `invoice ${live.id} exists but frozen visitOutcome is '${visitOutcome}' (nothing performed)` });
    }
    if (expectation && ['covered_membership', 'covered_annual', 'no_charge'].includes(expectation.kind) && !isBackfill) {
      contradictions.push({
        code: 'invoice_on_covered_visit',
        detail: `invoice ${live.id} exists but the lane predicts ${expectation.kind} (${expectation.why}); lane prediction only — an estimate-first invoice attached before completion can be legitimate`,
      });
    }
  } else if (inputs.dispositionLookupFailed) {
    invoice = fact('unknown', 'billing_disposition_lookup_failed', { expectation: expectation?.kind || null });
  } else if (inputs.disposition?.disposition === 'intentionally_free') {
    // A human ruled this visit free in the Billing Recovery workbench —
    // that durable disposition outranks any live prediction or frozen mint.
    invoice = fact('not_required', 'disposition_intentionally_free', {
      ruleSource: 'billing_disposition', dispositionId: inputs.disposition.id, decidedAt: isoOrNull(inputs.disposition.created_at),
      dispositionReason: inputs.disposition.reason ? String(inputs.disposition.reason).slice(0, 120) : null,
    });
  } else if (!visitPerformed) {
    invoice = fact('not_required', `visit_outcome_${visitOutcome}`, { ruleSource: 'frozen_record', visitOutcome });
  } else if (notes.backfillMintRequired === true) {
    // The completion FROZE a required-mint posture (+ amount) on the record
    // because billing fields are mutable — a later lane change must not
    // read an owed invoice as not_required (pre-push codex r5).
    const cents = notes.backfillMintAmountCents;
    invoice = fact('pending', 'frozen_required_mint_not_minted', {
      ruleSource: 'frozen_record', amount: Number.isInteger(cents) && cents > 0 ? cents / 100 : null,
      livePrediction: expectation?.kind || null,
    });
  } else if (billingInputsFailed.length) {
    // Any billing input that could not be read (autopay, visit-month dues,
    // bill-to payer, annual coverage) would otherwise be coerced to a
    // negative answer and predict "invoice missing" or "covered" — an
    // outage must read unknown, never a verdict.
    invoice = fact('unknown', 'billing_inputs_unavailable', { failed: billingInputsFailed, prepaidMethod: visit?.prepaid_method || null });
  } else if (isBackfill) invoice = fact('not_required', 'backfill_completion', { ruleSource: 'frozen_record', expectation: expectation?.kind || null });
  else if (!expectation) invoice = fact('unknown', 'billing_expectation_unavailable');
  else if (['no_charge', 'covered_membership', 'covered_annual', 'prepaid'].includes(expectation.kind)) {
    invoice = fact('not_required', `lane_${expectation.kind}`, { ruleSource: expectation.ruleSource, why: expectation.why, laneSource: expectation.laneSource || null });
  } else {
    // payer / invoice / auto_charge: something should have been minted.
    invoice = fact('pending', `expected_${expectation.kind}_not_minted`, { expectation: expectation.kind, amount: expectation.amount ?? null });
  }

  // ---- 7. invoice delivery ------------------------------------------------------------
  let invoiceDelivery;
  const smsStatus = notes.completionSmsStatus ? String(notes.completionSmsStatus) : null;
  if (!completed) invoiceDelivery = awaiting();
  else if (invoice.state !== 'done') {
    invoiceDelivery = invoice.state === 'not_required'
      ? fact('not_required', invoice.reason, { ruleSource: invoice.ruleSource || 'lane' })
      : fact(invoice.state === 'unknown' ? 'unknown' : 'pending', invoice.state === 'unknown' ? 'invoice_unknown' : 'no_invoice_yet');
  } else {
    const inv = live || inputs.siblingInvoice?.invoice;
    const status = String(inv.status || '').toLowerCase();
    const sentAt = isoOrNull(inv.sent_at);
    const smsSentAt = isoOrNull(inv.sms_sent_at);
    const receiptSentAt = isoOrNull(inv.receipt_sent_at);
    // email_sent_at is stamped by invoice-email.js on provider acceptance,
    // BEFORE the dispatch-side markDeliverySent (which can fail after the
    // send) — durable delivery evidence for a payer invoice (#3776 r4 P2).
    const emailSentAt = isoOrNull(inv.email_sent_at);
    const paidAt = isoOrNull(inv.paid_at);
    const evidence = { invoiceId: inv.id, status, sentAt, smsSentAt, emailSentAt, receiptSentAt, paidAt, ...(live ? {} : { source: 'sibling_first_application' }) };
    // A child invoice accrued to a NET payer's monthly statement is never
    // sent (or receipted) individually — admin-invoices refuses the
    // individual send for rows with payer_statement_id; the statement owns
    // delivery in EVERY status, prepaid and paid-after-settlement included
    // (#3776 r2 P2), so this outranks the status branches below.
    if (inv.payer_statement_id) invoiceDelivery = fact('not_required', 'statement_accrued', { ruleSource: 'payer_statement', ...evidence, payerStatementId: inv.payer_statement_id });
    else if (status === 'prepaid') invoiceDelivery = fact('done', 'prepaid', evidence);
    else if (INVOICE_SETTLED_STATUSES.has(status)) {
      // Paid ≠ receipted: receipt_sent_at is stamped only on confirmed
      // delivery; the queue row says where an unstamped receipt stands.
      const job = inputs.receiptJob || null;
      const jobStatus = job ? String(job.status || '').toLowerCase() : null;
      if (receiptSentAt) invoiceDelivery = fact('done', 'paid_receipt_sent', evidence);
      else if (inputs.receiptJobLookupFailed) invoiceDelivery = fact('unknown', 'receipt_job_lookup_failed', evidence);
      else if (jobStatus === 'completed') {
        // 'completed' also covers non-retryable skips — the channel results
        // decide (receipt-delivery-queue.js expectedEmailSkip /
        // actionableSmsFailure vocabulary).
        const legs = classifyReceiptLegs(job.sms_result, job.email_result);
        if (legs.delivered) invoiceDelivery = fact('done', 'paid_receipt_delivered', { ...evidence, receiptJobId: job.id, legs: legs.detail });
        else if (legs.gap) invoiceDelivery = fact('failed', 'receipt_no_recipient', { ...evidence, receiptJobId: job.id, legs: legs.detail });
        else if (legs.policy) invoiceDelivery = fact('not_required', 'receipt_opted_out', { ruleSource: 'consent', ...evidence, receiptJobId: job.id, legs: legs.detail });
        else invoiceDelivery = fact('unknown', 'receipt_job_result_unclassified', { ...evidence, receiptJobId: job.id, legs: legs.detail });
      }
      else if (jobStatus === 'failed') invoiceDelivery = fact('failed', 'receipt_delivery_exhausted', { ...evidence, receiptJobId: job.id, attempts: toNumber(job.attempts), lastError: scrubErrorText(job.last_error) });
      else if (jobStatus) invoiceDelivery = fact('pending', `receipt_${jobStatus}`, { ...evidence, receiptJobId: job.id, nextAttemptAt: isoOrNull(job.next_attempt_at) });
      // The Stripe success handler stamps paid_at before it enqueues the
      // receipt job (several awaited side effects later) — a read inside
      // that window is not an operator gap (#3776 r1 P2). Older, no
      // paid_at to age against, or a FUTURE paid_at (clock skew / bad data
      // must not suppress a real gap) is a genuinely never-enqueued receipt.
      else if (paidAt && (() => { const age = now.getTime() - new Date(paidAt).getTime(); return age >= 0 && age < RECEIPT_ENQUEUE_GRACE_MS; })()) invoiceDelivery = fact('pending', 'paid_receipt_pending_enqueue', evidence);
      else invoiceDelivery = fact('pending', 'paid_receipt_not_sent', evidence);
    }
    else if (inv.payer_id) invoiceDelivery = fact((sentAt || emailSentAt) ? 'done' : 'pending', (sentAt || emailSentAt) ? 'payer_invoice_sent' : 'payer_invoice_unsent', evidence);
    else if (sentAt || smsSentAt || INVOICE_DELIVERED_STATUSES.has(status)) invoiceDelivery = fact('done', 'invoice_delivered', evidence);
    else if (smsStatus === 'deferred') invoiceDelivery = fact('pending', 'deferred_send_window', { ...evidence, completionSmsStatus: smsStatus });
    else if (smsStatus === 'failed') invoiceDelivery = fact('failed', 'completion_sms_failed', { ...evidence, completionSmsStatus: smsStatus });
    else invoiceDelivery = fact('pending', 'invoice_draft_unsent', evidence);
  }

  // ---- 8. customer comms -------------------------------------------------------------
  let comms;
  if (!completed) comms = awaiting();
  else if (isBackfill) comms = fact('not_required', 'backfill_completion', { ruleSource: 'frozen_record' });
  else if (posture !== 'auto_send') comms = fact('not_required', `frozen_posture_${posture}`, { ruleSource: 'frozen_record', posture });
  else if (inputs.visitSummaryLookupFailed) comms = fact('unknown', 'visit_summary_lookup_failed');
  else if (inputs.visitSummaryEffects?.length) comms = visitSummaryDeliveryFact(inputs.visitSummaryEffects);
  // completionSmsStatus vocabulary (admin-dispatch.js completion SMS block +
  // dispatch-completion-deferred.js): sending | sent | deferred | failed |
  // blocked (opt-out / no consent) | skipped_recap_sms_already_sent.
  else if (smsStatus === 'sent') comms = fact('done', 'completion_sms_sent', { completionSmsStatus: smsStatus, deliveredAt: isoOrNull(notes.completionSmsDeferredDeliveredAt) || isoOrNull(notes.sentSmsAt) });
  else if (smsStatus === 'skipped_recap_sms_already_sent') comms = fact('done', 'recap_sms_sent', { recapSentAt, completionSmsStatus: smsStatus });
  else if (recapClaimFresh) comms = fact('pending', 'recap_sms_in_flight', { recapSentAt });
  // An aged claim alone is NOT delivery evidence: it is stamped before the
  // provider call, and a crash between stamp and send leaves it set forever.
  else if (recapSentAt && recapClaimSettled) comms = fact('unknown', 'recap_claim_unverified', { recapSentAt });
  else if (smsStatus === 'deferred') comms = fact('pending', 'deferred_send_window', { completionSmsStatus: smsStatus });
  else if (smsStatus === 'sending') comms = fact('pending', 'completion_sms_sending', { completionSmsStatus: smsStatus });
  else if (smsStatus === 'failed') comms = fact('failed', 'completion_sms_failed', { completionSmsStatus: smsStatus });
  else if (smsStatus === 'blocked') comms = fact('not_required', 'completion_sms_blocked_consent', { ruleSource: 'consent', completionSmsStatus: smsStatus });
  else if (reportDelivery.state === 'done') comms = fact('done', projectBacked ? 'project_report_delivered' : 'report_email_delivered', { channel: projectBacked ? null : 'email' });
  // Explicit catalog rule: this service owes no customer notice (evidence
  // above still wins when it exists).
  else if (requirements && requirements.requiresCustomerNotice === false) comms = fact('not_required', 'catalog_no_customer_notice', { ruleSource: requirementsRuleSource, requirementsSource: requirements.source, completionSmsStatus: smsStatus });
  else comms = fact('unknown', 'no_comms_marker_on_record', { completionSmsStatus: smsStatus, hint: 'legacy or recap-lane record without a completionSmsStatus stamp' });
  if (requirements && completed) {
    // The catalog's requiresCustomerNotice is satisfied by the completion
    // comms above (post-application notice = the completion SMS / report
    // email). Surface the requirement on the fact rather than a tenth one.
    comms.customerNoticeRequired = requirements.requiresCustomerNotice === true;
  }

  // ---- 9. follow-up -----------------------------------------------------------------------
  let followUp;
  const obligation = inputs.followup;
  if (!completed) followUp = awaiting();
  else if (obligation === undefined) followUp = fact('unknown', 'followup_obligation_lookup_failed');
  else if (obligation?.indeterminate) followUp = fact('unknown', `followup_${obligation.reason || 'indeterminate'}`, { serviceRecordId: obligation.serviceRecordId || null });
  else if (!obligation || !obligation.suggestion) followUp = fact('not_required', 'no_typed_followup_obligation', { ruleSource: 'frozen_record' });
  else if (obligation.suggestion.required !== true) followUp = fact('not_required', 'typed_verdict_not_required', { ruleSource: obligation.frozen ? 'frozen_record' : 'derived_snapshot', frozen: obligation.frozen === true });
  else if (inputs.followupChild) {
    followUp = fact('done', 'followup_child_scheduled', {
      childServiceId: inputs.followupChild.id, childStatus: inputs.followupChild.status,
      childScheduledDate: inputs.followupChild.scheduled_date ? String(inputs.followupChild.scheduled_date).slice(0, 10) : null,
      frozen: obligation.frozen === true,
    });
  } else if (inputs.followupChildLookupFailed) followUp = fact('unknown', 'followup_child_lookup_failed', { required: true });
  else {
    followUp = fact('pending', 'followup_required_not_booked', {
      windowDays: obligation.suggestion.days ?? null,
      verdictReason: obligation.suggestion.reason || null, frozen: obligation.frozen === true,
    });
  }

  // ---- 10. technician license -----------------------------------------------------------
  let license;
  const tech = inputs.technician || null;
  if (!completed) license = awaiting();
  else if (!requirements) license = fact('unknown', 'requirements_unavailable');
  else if (requirements.requiresLicense !== true) license = fact('not_required', 'catalog_no_license_required', { ruleSource: requirementsRuleSource, requirementsSource: requirements.source });
  else if (inputs.technicianLookupFailed) license = fact('unknown', 'technicians_lookup_failed', { requiredCategory: requirements.licenseCategory || null });
  else if (!tech && inputs.applicatorFindingsId) {
    // The signer's FDACS id exists only in findings JSON — with a required
    // category the verdict is unverifiable from here, never a green.
    license = requirements.licenseCategory
      ? fact('unknown', 'applicator_category_unverifiable', { applicatorFdacsId: inputs.applicatorFindingsId, requiredCategory: requirements.licenseCategory, source: 'project_findings' })
      : fact('done', 'project_applicator_on_findings', { applicatorFdacsId: inputs.applicatorFindingsId, expiryUnrecorded: true, source: 'project_findings' });
  } else if (!tech) license = fact('pending', 'no_technician_on_visit', { requiredCategory: requirements.licenseCategory || null });
  else {
    let cats = tech.license_categories;
    if (typeof cats === 'string') { try { cats = JSON.parse(cats); } catch { cats = null; } }
    const categories = Array.isArray(cats) ? cats.map(canonicalLicenseCategory).filter(Boolean) : [];
    const required = canonicalLicenseCategory(requirements.licenseCategory);
    // Judge expiry at the day the work was RECORDED (service_records.service_date);
    // the scheduled day is only a fallback for records without one.
    const visitDay = (record?.service_date ? String(record.service_date).slice(0, 10) : null)
      || (visit.scheduled_date ? String(visit.scheduled_date).slice(0, 10) : null);
    const expiry = tech.license_expiry ? String(tech.license_expiry).slice(0, 10) : null;
    const evidence = {
      technicianId: tech.id, hasLicense: Boolean(tech.fl_applicator_license), licenseExpiry: expiry, requiredCategory: required,
      categories, judgedAt: visitDay, asOf: 'current_technician_row', identity: inputs.licenseTechSource || 'scheduled_technician',
    };
    if (!tech.fl_applicator_license) license = fact('pending', 'technician_license_missing', evidence);
    // A missing expiry is ACTIVE by design - the certificate applicator
    // picker treats a blank license_expiry as active until the owner records
    // one (seed 20260703000004); surfaced, not failed.
    else if (!expiry) license = fact('done', 'technician_licensed', { ...evidence, expiryUnrecorded: true });
    else if (expiry && visitDay && expiry < visitDay) license = fact('failed', 'technician_license_expired_at_visit', evidence);
    else if (required && categories.length && !categories.includes(required)) license = fact('failed', 'technician_license_category_mismatch', evidence);
    else if (required && !categories.length) license = fact('unknown', 'technician_license_categories_unrecorded', evidence);
    else license = fact('done', 'technician_licensed', evidence);
  }

  // ---- packet (grouped stop) ---------------------------------------------------------------
  let packet = null;
  if (visit?.visit_id) {
    const packets = Array.isArray(inputs.packets) ? inputs.packets : null;
    packet = {
      visitId: visit.visit_id,
      memberServiceIds: Array.isArray(inputs.packetMemberIds) ? inputs.packetMemberIds : null,
      activePacket: packets ? packets.some((p) => ACTIVE_PACKET_STATUSES.has(String(p.status))) : null,
      packetStatuses: packets ? packets.map((p) => String(p.status)) : null,
      note: 'Treatment facts belong to each service record; invoice ownership and summary delivery recognize the saved packet.',
    };
  }

  return {
    facts: {
      completion, application, photos, report, reportDelivery, invoice, invoiceDelivery, comms, followUp, license,
    },
    contradictions,
    packet,
    posture,
    billing: {
      lane: inputs.lane?.mode || null,
      laneSource: inputs.lane?.source || null,
      autopayActive: inputs.autopayActive,
      duesCollectedThisMonth: inputs.duesCollectedThisMonth === true,
      annualCoverageValidated: inputs.annualCoverageValidated ?? null,
      expectation: expectation ? { kind: expectation.kind, amount: expectation.amount ?? null, why: expectation.why } : null,
    },
    asOf: now.toISOString(),
  };
}

// Compact roll-up for list views: which facts are open (pending/failed) and
// which lookups were unavailable. Callers that need a single "attention"
// signal read `open.length > 0 || unknown.length > 0` — the two are kept
// apart on purpose so an outage never renders as a compliance gap.
function summarizeCloseout(facts, contradictions = [], unevaluated = []) {
  const open = [];
  const failed = [];
  const unknown = [];
  for (const name of FACT_NAMES) {
    const f = facts[name];
    if (!f) continue;
    if (f.state === 'pending') open.push(name);
    else if (f.state === 'failed') { open.push(name); failed.push(name); }
    else if (f.state === 'unknown') unknown.push(name);
  }
  const contradictionCodes = (contradictions || []).map((c) => c.code);
  // A contradiction (record without completed visit, invoice on a covered
  // visit, …) is an exception in its own right — never hidden by a rollup.
  const unevaluatedList = Array.isArray(unevaluated) ? unevaluated.filter(Boolean) : [];
  return {
    open, failed, unknown, contradictions: contradictionCodes, unevaluated: unevaluatedList,
    // A required item with no evidence store (requiresCustomerSignature)
    // is an unknown closeout condition, never an all-green.
    closedOut: open.length === 0 && unknown.length === 0 && contradictionCodes.length === 0 && unevaluatedList.length === 0,
  };
}

async function getCloseoutStatus(serviceId, { knex = db, now = new Date() } = {}) {
  if (!serviceId) throw new Error('getCloseoutStatus: serviceId is required');
  const inputs = await loadCloseoutInputs(serviceId, { knex, now });
  if (!inputs.visit) {
    return {
      serviceId,
      found: false,
      lookupFailed: inputs.visitLookupFailed === true,
      unavailable: inputs.unavailable,
      asOf: now.toISOString(),
    };
  }
  const derived = deriveCloseoutFacts(inputs);
  const { visit, record, requirements } = inputs;
  // Only a visit that actually owes closeout evidence (completion done) can
  // be blocked by an unevaluable requirement; cancelled/skipped/rescheduled
  // visits owe nothing.
  const unevaluated = requirements?.requiresCustomerSignature === true && derived.facts.completion.state === 'done'
    ? ['requiresCustomerSignature'] : [];
  if (inputs.unavailable.length) {
    logger.info(`[closeout-status] ${serviceId}: ${inputs.unavailable.length} lookup(s) unavailable: ${inputs.unavailable.map((u) => u.lookup).join(', ')}`);
  }
  return {
    serviceId,
    found: true,
    asOf: derived.asOf,
    visit: {
      status: visit.status || null,
      scheduledDate: visit.scheduled_date ? String(visit.scheduled_date).slice(0, 10) : null,
      completedAt: isoOrNull(visit.completed_at),
      customerId: visit.customer_id || null,
      propertyId: visit.property_id || null,
      technicianId: visit.technician_id || null,
      catalogServiceId: visit.service_id || null,
      serviceType: visit.service_type || null,
      isCallback: visit.is_callback === true,
      isRecurring: visit.is_recurring === true,
      projectId: inputs.project?.id || null,
      visitGroupId: visit.visit_id || null,
    },
    record: record ? {
      id: record.id,
      status: record.status || null,
      visitOutcome: parseJsonObjectSafe(record.structured_notes).visitOutcome || null,
      completionSource: record.completion_source || null,
      backfill: parseJsonObjectSafe(record.structured_notes).backfill === true,
      posture: derived.posture,
    } : null,
    packet: derived.packet,
    visitReRead: inputs.visitReRead || null,
    requirements: requirements ? {
      ...requirements,
      // 'frozen_at_completion' replays the snapshot the completion wrote;
      // 'frozen_by_backfill' replays migration 20260831000080's honest
      // guess (today's catalog stamped onto pre-freeze history — GH codex
      // r1 P2: a backfill must not present as a completion-time
      // observation); 'current_catalog' is the unfrozen fallback, where a
      // catalog edit still retroactively changes these for historical
      // visits.
      asOf: requirements.frozen
        ? (requirements.source === 'backfilled_from_live_catalog' ? 'frozen_by_backfill' : 'frozen_at_completion')
        : 'current_catalog',
      ...(requirements.frozen ? { frozenAt: requirements.frozenAt || null } : {}),
      // requiresCustomerSignature has NO evidence store in the schema (the
      // only "signature" columns are the tree/shrub review hash and the
      // weekly time-summary sign-off), so it cannot be evaluated here and is
      // listed rather than silently dropped. requiresCustomerNotice rides on
      // facts.comms.customerNoticeRequired.
      unevaluated,
    } : null,
    billing: derived.billing,
    facts: derived.facts,
    summary: summarizeCloseout(derived.facts, derived.contradictions, unevaluated),
    contradictions: derived.contradictions,
    unavailable: inputs.unavailable,
  };
}

module.exports = {
  getCloseoutStatus,
  loadCloseoutInputs,
  deriveCloseoutFacts,
  deriveBillingExpectation,
  summarizeCloseout,
  FACT_STATES,
  FACT_NAMES,
};
