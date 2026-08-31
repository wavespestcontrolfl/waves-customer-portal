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
 *              invoice, invoiceDelivery, comms, followUp },
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
 * Known hazard, surfaced not hidden: requirements come from the LIVE catalog
 * (there is no frozen requirement snapshot — completion-tier-snapshot freezes
 * only tier/callback). Editing a catalog row's required_photo_count flips the
 * verdict on visits closed months ago. `requirements.asOf` says so.
 *
 * READ-ONLY. No writes, no Stripe, no notifications, no customer comms.
 */
const db = require('../models/db');
const logger = require('./logger');
const { resolveCloseoutRequirementsForJobs } = require('./service-closeout-requirements');
const { completionStatusForService } = require('./completion-attempts');
const {
  completionNewestLiveInvoiceLookup,
  completionTerminalInvoiceLookup,
  reconcileLiveVsRefunded,
} = require('./completion-invoice-candidate');
const {
  resolveBillingLane,
  predictCompletionBilling,
  monthlyDuesCollected,
} = require('./billing-lane');
const { isAlwaysFreeServiceType } = require('./no-cost-visit-types');
const { customerOnAutopay } = require('./autopay-eligibility');
const { typedFollowupObligationForCompletedSource } = require('./typed-followup-obligation');

const FACT_STATES = Object.freeze(['not_required', 'pending', 'done', 'failed', 'unknown']);
const FACT_NAMES = Object.freeze([
  'completion', 'application', 'photos', 'report', 'reportDelivery',
  'invoice', 'invoiceDelivery', 'comms', 'followUp',
]);

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
// Follow-up children in these statuses do not satisfy the obligation
// (lockstep with FOLLOWUP_CHILD_INACTIVE_STATUSES in typed-followup-obligation).
const FOLLOWUP_CHILD_INACTIVE_STATUSES = ['cancelled', 'skipped', 'no_show'];
// Invoice statuses that prove the customer was shown the bill even when the
// sent_at stamp predates the column.
const INVOICE_DELIVERED_STATUSES = new Set(['sent', 'viewed', 'overdue', 'paid', 'partially_paid']);
const INVOICE_SETTLED_STATUSES = new Set(['paid']);
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
async function loadCloseoutInputs(serviceId, { knex = db, now = new Date() } = {}) {
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
    customerProbe, recordProbe, attemptProbe, requirementsProbe, formsProbe, packetProbe, membersProbe,
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
      .first()),
    probe('service_completion_attempts', unavailable, () => completionStatusForService({ serviceId }, knex)),
    probe('services (closeout requirements)', unavailable, async () => {
      const map = await resolveCloseoutRequirementsForJobs([{
        id: serviceId,
        service_id: visit.service_id || null,
        service_type: visit.service_type || null,
      }], { knex, strict: true });
      return map.get(serviceId) || null;
    }),
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
  inputs.record = recordProbe.value || null;
  inputs.recordLookupFailed = Boolean(recordProbe.error);
  inputs.attempt = attemptProbe.value || null;
  inputs.requirements = requirementsProbe.value || null;
  inputs.completedFormCount = formsProbe.value ? toNumber(formsProbe.value.n) : (formsProbe.error ? null : 0);
  inputs.packets = Array.isArray(packetProbe.value) ? packetProbe.value : (packetProbe.error ? null : []);
  inputs.packetMemberIds = Array.isArray(membersProbe.value)
    ? membersProbe.value.map((r) => r.id)
    : (membersProbe.error ? null : []);
  const record = inputs.record;
  const recordId = record?.id || null;

  // Project/WDO link: projects.scheduled_service_id (or service_record_id) —
  // never a column on the visit. Newest wins if a visit was ever re-linked.
  const projectProbe = await probe('projects', unavailable, () => knex('projects')
    .where((qb) => {
      qb.where({ scheduled_service_id: serviceId });
      if (recordId) qb.orWhere({ service_record_id: recordId });
    })
    .orderBy('created_at', 'desc')
    .first());
  inputs.project = projectProbe.value || null;
  inputs.projectLookupFailed = Boolean(projectProbe.error);
  const projectId = inputs.project?.id || null;

  const [
    activeAppsProbe, retractedAppsProbe, photosProbe, deliveryProbe, liveInvoiceProbe, terminalInvoiceProbe,
    autopayProbe, followupProbe, childProbe,
  ] = await Promise.all([
    probe('property_application_history (active)', unavailable, () => (recordId
      ? knex('property_application_history').where({ service_record_id: recordId }).whereNull('retracted_at').count('* as n').first()
      : { n: 0 })),
    probe('property_application_history (retracted)', unavailable, () => (recordId
      ? knex('property_application_history').where({ service_record_id: recordId }).whereNotNull('retracted_at').count('* as n').first()
      : { n: 0 })),
    probe(projectId ? 'project_photos' : 'service_photos', unavailable, () => {
      // Project completions store their evidence on the project, not the
      // service record (routes/admin-projects.js counts project_photos).
      if (projectId) return knex('project_photos').where({ project_id: projectId }).count('* as n').first();
      return recordId
        ? knex('service_photos').where({ service_record_id: recordId }).count('* as n').first()
        : { n: 0 };
    }),
    probe('service_report_deliveries', unavailable, () => (recordId
      ? knex('service_report_deliveries').where({ service_record_id: recordId }).orderBy('created_at', 'desc').first()
      : null)),
    probe('invoices (live)', unavailable, () => completionNewestLiveInvoiceLookup(knex, {
      serviceRecordId: recordId, scheduledServiceId: serviceId,
    })),
    probe('invoices (refunded)', unavailable, () => completionTerminalInvoiceLookup(knex, {
      serviceRecordId: recordId, scheduledServiceId: serviceId,
    })),
    // failClosed makes a payment_methods lookup failure THROW (default
    // swallows it as "not on autopay") so the probe can record an outage.
    probe('autopay eligibility', unavailable, () => (inputs.customer
      ? customerOnAutopay(inputs.customer, { db: knex, now, failClosed: true })
      : null)),
    probe('typed follow-up obligation', unavailable, () => typedFollowupObligationForCompletedSource({
      scheduledService: visit, knex, strict: true,
    })),
    probe('scheduled_services (follow-up child)', unavailable, () => knex('scheduled_services')
      .where({ followup_source_service_id: serviceId })
      .whereNotIn('status', FOLLOWUP_CHILD_INACTIVE_STATUSES)
      .orderBy('scheduled_date', 'asc')
      .first('id', 'status', 'scheduled_date')),
  ]);

  inputs.activeApplicationCount = activeAppsProbe.value ? toNumber(activeAppsProbe.value.n) : null;
  inputs.retractedApplicationCount = retractedAppsProbe.value ? toNumber(retractedAppsProbe.value.n) : null;
  inputs.photoCount = photosProbe.value ? toNumber(photosProbe.value.n) : null;
  inputs.photoSource = projectId ? 'project_photos' : 'service_photos';
  inputs.delivery = deliveryProbe.value || null;
  inputs.deliveryLookupFailed = Boolean(deliveryProbe.error);
  inputs.liveInvoice = liveInvoiceProbe.value || null;
  inputs.liveInvoiceLookupFailed = Boolean(liveInvoiceProbe.error);
  inputs.terminalInvoice = terminalInvoiceProbe.value || null;
  inputs.terminalInvoiceLookupFailed = Boolean(terminalInvoiceProbe.error);
  inputs.autopayActive = autopayProbe.error ? null : Boolean(autopayProbe.value);
  inputs.followup = followupProbe.error ? undefined : (followupProbe.value || null);
  inputs.followupChild = childProbe.value || null;
  inputs.followupChildLookupFailed = Boolean(childProbe.error);

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
  const visitCompleted = Boolean(visit && COMPLETED_VISIT_STATUSES.has(String(visit.status || '').toLowerCase()));
  const visitInactive = Boolean(visit && INACTIVE_VISIT_STATUSES.has(String(visit.status || '').toLowerCase()));
  const isBackfill = notes.backfill === true;
  const recordIncomplete = record?.status === 'incomplete';
  const project = inputs.project || null;
  const projectBacked = Boolean(project) || record?.completion_source === 'project_completion' || inputs.projectLookupFailed === true;
  const frozenPosture = notes.typedReportDelivery ? String(notes.typedReportDelivery) : null;
  const posture = frozenPosture || 'auto_send';

  // ---- 1. completion --------------------------------------------------------
  let completion;
  const attemptState = inputs.attempt?.state || null;
  if (inputs.recordLookupFailed && !record) {
    completion = fact('unknown', 'service_records_lookup_failed', { visitStatus: visit?.status || null, attemptState });
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
  else if (!requirements.requiresApplicationLog) application = fact('not_required', 'catalog_no_application_log', { ruleSource: 'catalog', requirementsSource: requirements.source });
  else if (inputs.activeApplicationCount == null) application = fact('unknown', 'application_history_lookup_failed');
  else if (inputs.activeApplicationCount > 0) application = fact('done', 'active_application_rows', { activeCount: inputs.activeApplicationCount, retractedCount: inputs.retractedApplicationCount ?? 0 });
  else if (requirements.source === 'fallback_inference' && inputs.retractedApplicationCount === 0) application = fact('pending', 'no_application_rows', { activeCount: 0, retractedCount: 0, lowConfidence: true, requirementsSource: requirements.source });
  else if (inputs.retractedApplicationCount == null) application = fact('unknown', 'application_history_lookup_failed', { activeCount: 0, detail: 'retracted-row lookup unavailable; cannot tell empty from all-retracted' });
  else if (inputs.retractedApplicationCount > 0) application = fact('failed', 'all_application_rows_retracted', { activeCount: 0, retractedCount: inputs.retractedApplicationCount });
  else application = fact('pending', 'no_application_rows', { activeCount: 0, retractedCount: 0 });

  // ---- 3. photos ---------------------------------------------------------------
  let photos;
  const requiredPhotos = requirements ? toNumber(requirements.requiredPhotoCount) : null;
  if (!completed) photos = awaiting();
  else if (!requirements) photos = fact('unknown', 'requirements_unavailable');
  else if (!(requiredPhotos > 0)) photos = fact('not_required', 'catalog_zero_required_photos', { ruleSource: 'catalog', requirementsSource: requirements.source, actual: inputs.photoCount ?? null });
  else if (inputs.photoCount == null) photos = fact('unknown', 'service_photos_lookup_failed', { required: requiredPhotos });
  else if (inputs.photoCount >= requiredPhotos) photos = fact('done', 'photo_count_met', { required: requiredPhotos, actual: inputs.photoCount, source: inputs.photoSource || 'service_photos' });
  else photos = fact('pending', 'photo_count_short', { required: requiredPhotos, actual: inputs.photoCount, source: inputs.photoSource || 'service_photos' });

  // ---- 4. report (artifact exists / published) ---------------------------------
  let report;
  const reportPublishedAt = isoOrNull(record?.report_generated_at) || isoOrNull(notes.reportPublishedAt) || isoOrNull(notes.report_published_at);
  const hasReportToken = Boolean(record?.report_view_token);
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
  } else if (posture === 'disabled') report = fact('not_required', 'frozen_posture_disabled', { ruleSource: 'frozen_record', posture, audience: 'none' });
  else if (reportRequiredByCatalog === false) {
    report = (hasReportToken || reportPublishedAt)
      ? fact('done', 'published_despite_catalog_not_required', { publishedAt: reportPublishedAt, hasToken: hasReportToken, audience: posture === 'internal_only' ? 'internal' : 'customer', posture })
      : fact('not_required', 'catalog_no_service_report', { ruleSource: 'catalog', requirementsSource: requirements.source, posture });
  } else if (hasReportToken || reportPublishedAt) {
    report = fact('done', 'report_published', {
      publishedAt: reportPublishedAt, hasToken: hasReportToken, audience: posture === 'internal_only' ? 'internal' : 'customer', posture,
      formSubmitted: inputs.completedFormCount == null ? null : inputs.completedFormCount > 0,
    });
  } else if (!requirements) report = fact('unknown', 'requirements_unavailable', { posture });
  else if (inputs.completedFormCount > 0) report = fact('pending', 'form_submitted_not_published', { posture, formSubmitted: true });
  else if (isBackfill) report = fact('not_required', 'backfill_completion', { ruleSource: 'frozen_record', posture });
  else report = fact('pending', 'no_report_artifact', { posture, formSubmitted: inputs.completedFormCount == null ? null : false });

  // ---- 5. report delivery ---------------------------------------------------------
  let reportDelivery;
  const delivery = inputs.delivery || null;
  const notesEmailStatus = notes.serviceReportV1EmailStatus ? String(notes.serviceReportV1EmailStatus).toLowerCase() : null;
  const recapSentAt = isoOrNull(record?.recap_sms_sent_at);
  if (!completed) reportDelivery = awaiting();
  else if (projectBacked) {
    const ds = project ? String(project.delivery_status || 'not_sent').toLowerCase() : null;
    const evidence = { projectId: project?.id || null, deliveryStatus: ds, lastDeliveryAt: isoOrNull(project?.last_delivery_at), reportHoldStatus: project?.report_hold_status || null, source: 'projects.delivery_status' };
    if (report.state !== 'done') reportDelivery = fact(report.state === 'unknown' ? 'unknown' : 'pending', 'report_not_published', evidence);
    else if (ds === 'sent' || ds === 'legacy_sent') reportDelivery = fact('done', `project_delivery_${ds}`, evidence);
    else if (ds === 'failed') reportDelivery = fact('failed', 'project_delivery_failed', evidence);
    else if (ds === 'sending') reportDelivery = fact('pending', 'project_delivery_sending', evidence);
    else if (project?.report_hold_status) reportDelivery = fact('pending', 'project_report_on_hold', evidence);
    else reportDelivery = fact('pending', 'project_report_not_sent', evidence);
  } else if (report.state === 'not_required') reportDelivery = fact('not_required', report.reason, { ruleSource: report.ruleSource || 'frozen_record', posture });
  else if (posture === 'internal_only') reportDelivery = fact('not_required', 'frozen_posture_internal_only', { ruleSource: 'frozen_record', posture, audience: 'internal' });
  else if (report.state !== 'done') reportDelivery = fact(report.state === 'unknown' ? 'unknown' : 'pending', 'report_not_published', { posture });
  else if (delivery) {
    const status = String(delivery.status || '').toLowerCase();
    const evidence = {
      channel: delivery.channel || null, status, attempts: toNumber(delivery.attempts), maxAttempts: toNumber(delivery.max_attempts, 5),
      sentAt: isoOrNull(delivery.sent_at), failedAt: isoOrNull(delivery.failed_at), nextAttemptAt: isoOrNull(delivery.next_attempt_at),
      lastError: scrubErrorText(delivery.last_error),
    };
    if (DELIVERY_TERMINAL_OK.has(status)) reportDelivery = fact('done', 'delivery_sent', evidence);
    else if (status === 'failed') reportDelivery = fact('failed', 'delivery_exhausted', evidence);
    else if (DELIVERY_TERMINAL_SKIPPED.has(status)) reportDelivery = fact('not_required', `delivery_${status}`, { ruleSource: 'delivery_queue', ...evidence });
    else if (DELIVERY_IN_FLIGHT.has(status)) reportDelivery = fact('pending', `delivery_${status}`, evidence);
    else reportDelivery = fact('unknown', 'delivery_status_unrecognized', evidence);
  } else if (inputs.deliveryLookupFailed) reportDelivery = fact('unknown', 'service_report_deliveries_lookup_failed', { posture });
  else if (notesEmailStatus === 'disabled') reportDelivery = fact('not_required', 'report_email_kill_switch', { ruleSource: 'kill_switch', posture, notesStatus: notesEmailStatus });
  else if (notesEmailStatus === 'sent') reportDelivery = fact('done', 'delivery_sent_per_record_notes', { posture, sentAt: isoOrNull(notes.serviceReportV1EmailSentAt) });
  else if (notesEmailStatus === 'failed') reportDelivery = fact('failed', 'delivery_exhausted_per_record_notes', { posture, lastError: scrubErrorText(notes.serviceReportV1EmailError) });
  else if (notesEmailStatus === 'skipped') reportDelivery = fact('not_required', 'delivery_skipped', { ruleSource: 'delivery_queue', posture, lastError: scrubErrorText(notes.serviceReportV1EmailError) });
  else if (notesEmailStatus === 'queued' || notesEmailStatus === 'sending') reportDelivery = fact('pending', `delivery_${notesEmailStatus}`, { posture });
  else if (isBackfill) reportDelivery = fact('not_required', 'backfill_completion', { ruleSource: 'frozen_record', posture });
  else if (recapSentAt) reportDelivery = fact('done', 'recap_sms_delivered', { channel: 'sms', recapSentAt });
  else if (record?.report_template_version && record.report_template_version !== 'service_report_v1') {
    reportDelivery = fact('unknown', 'no_delivery_row_for_template', { posture, templateVersion: record.report_template_version });
  } else reportDelivery = fact('pending', 'not_enqueued', { posture });

  // ---- 6. invoice -----------------------------------------------------------------
  let invoice;
  const billingInputsFailed = [
    inputs.customer && inputs.autopayActive === null ? 'autopay' : null,
    inputs.duesLookupFailed === true ? 'monthly_dues' : null,
    inputs.payerBilled === null ? 'bill_to_payer' : null,
    inputs.annualCoverageLookupFailed === true ? 'annual_coverage' : null,
  ].filter(Boolean);
  const expectation = deriveBillingExpectation(inputs);
  const reconciled = reconcileLiveVsRefunded(inputs.liveInvoice, inputs.terminalInvoice, inputs.liveInvoice);
  const live = inputs.liveInvoice;
  if (!completed) invoice = awaiting({ expectation: expectation?.kind || null });
  else if (reconciled.terminal) {
    // ALWAYS parked while a refunded row exists beside a live one — even a
    // PAID live sibling (pre-push codex P0): a later refund.failed can
    // restore the refunded row to paid, leaving two paid invoices. Only a
    // human reconciles that; this service never declares it closed.
    invoice = fact('pending', 'parked_manual_refunded_invoice', {
      refundedInvoiceId: reconciled.terminal.id, liveBesideInvoiceId: reconciled.liveBeside?.id || null,
      liveBesideStatus: reconciled.liveBeside?.status || null, expectation: expectation?.kind || null,
    });
  } else if (live) {
    invoice = fact('done', INVOICE_SETTLED_STATUSES.has(String(live.status)) ? 'invoice_paid' : 'invoice_exists', {
      invoiceId: live.id, invoiceNumber: live.invoice_number || null, status: live.status || null,
      total: live.total != null ? Number(live.total) : null, payerBilled: Boolean(live.payer_id), expectation: expectation?.kind || null,
    });
    if (expectation && ['covered_membership', 'covered_annual', 'no_charge'].includes(expectation.kind) && !isBackfill) {
      contradictions.push({
        code: 'invoice_on_covered_visit',
        detail: `invoice ${live.id} exists but the lane predicts ${expectation.kind} (${expectation.why}); lane prediction only — an estimate-first invoice attached before completion can be legitimate`,
      });
    }
  } else if (inputs.liveInvoiceLookupFailed || inputs.terminalInvoiceLookupFailed) {
    invoice = fact('unknown', 'invoice_lookup_failed', { expectation: expectation?.kind || null });
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
    const status = String(live.status || '').toLowerCase();
    const sentAt = isoOrNull(live.sent_at);
    const smsSentAt = isoOrNull(live.sms_sent_at);
    const receiptSentAt = isoOrNull(live.receipt_sent_at);
    const evidence = { invoiceId: live.id, status, sentAt, smsSentAt, receiptSentAt };
    if (INVOICE_SETTLED_STATUSES.has(status)) invoiceDelivery = fact('done', receiptSentAt ? 'paid_receipt_sent' : 'paid', evidence);
    else if (live.payer_id) invoiceDelivery = fact(sentAt ? 'done' : 'pending', sentAt ? 'payer_invoice_sent' : 'payer_invoice_unsent', evidence);
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
  // completionSmsStatus vocabulary (admin-dispatch.js completion SMS block +
  // dispatch-completion-deferred.js): sending | sent | deferred | failed |
  // blocked (opt-out / no consent) | skipped_recap_sms_already_sent.
  else if (smsStatus === 'sent') comms = fact('done', 'completion_sms_sent', { completionSmsStatus: smsStatus, deliveredAt: isoOrNull(notes.completionSmsDeferredDeliveredAt) || isoOrNull(notes.sentSmsAt) });
  else if (smsStatus === 'skipped_recap_sms_already_sent' || recapSentAt) comms = fact('done', 'recap_sms_sent', { recapSentAt, completionSmsStatus: smsStatus });
  else if (smsStatus === 'deferred') comms = fact('pending', 'deferred_send_window', { completionSmsStatus: smsStatus });
  else if (smsStatus === 'sending') comms = fact('pending', 'completion_sms_sending', { completionSmsStatus: smsStatus });
  else if (smsStatus === 'failed') comms = fact('failed', 'completion_sms_failed', { completionSmsStatus: smsStatus });
  else if (smsStatus === 'blocked') comms = fact('not_required', 'completion_sms_blocked_consent', { ruleSource: 'consent', completionSmsStatus: smsStatus });
  else if (reportDelivery.state === 'done') comms = fact('done', projectBacked ? 'project_report_delivered' : 'report_email_delivered', { channel: projectBacked ? null : 'email' });
  else comms = fact('unknown', 'no_comms_marker_on_record', { completionSmsStatus: smsStatus, hint: 'legacy or recap-lane record without a completionSmsStatus stamp' });

  // ---- 9. follow-up -----------------------------------------------------------------------
  let followUp;
  const obligation = inputs.followup;
  if (!completed) followUp = awaiting();
  else if (obligation === undefined) followUp = fact('unknown', 'followup_obligation_lookup_failed');
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

  // ---- packet (grouped stop) ---------------------------------------------------------------
  let packet = null;
  if (visit?.visit_id) {
    const packets = Array.isArray(inputs.packets) ? inputs.packets : null;
    packet = {
      visitId: visit.visit_id,
      memberServiceIds: Array.isArray(inputs.packetMemberIds) ? inputs.packetMemberIds : null,
      activePacket: packets ? packets.some((p) => ACTIVE_PACKET_STATUSES.has(String(p.status))) : null,
      packetStatuses: packets ? packets.map((p) => String(p.status)) : null,
      note: 'facts above are resolved PER SERVICE (each member owns its own service_records row); the packet only says whether a grouped completion is still processing',
    };
  }

  return {
    facts: {
      completion, application, photos, report, reportDelivery, invoice, invoiceDelivery, comms, followUp,
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
function summarizeCloseout(facts) {
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
  return { open, failed, unknown, closedOut: open.length === 0 && unknown.length === 0 };
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
      completionSource: record.completion_source || null,
      backfill: parseJsonObjectSafe(record.structured_notes).backfill === true,
      posture: derived.posture,
    } : null,
    packet: derived.packet,
    requirements: requirements ? {
      ...requirements,
      // No frozen requirement snapshot exists — see header. A catalog edit
      // retroactively changes these for historical visits.
      asOf: 'current_catalog',
    } : null,
    billing: derived.billing,
    facts: derived.facts,
    summary: summarizeCloseout(derived.facts),
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
