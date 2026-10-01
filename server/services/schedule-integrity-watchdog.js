/**
 * Schedule-integrity watchdog.
 *
 * Why this exists: on 2026-08-04 a Tree & Shrub recurring series was found
 * live with NO price on any row (parent or children) and its first visit
 * stuck in on_site since 7/21 — never completed, never billed, invisible to
 * every dashboard metric (completion never fired, so no service_records row,
 * no invoice, no report, no post-service SMS). A prod sweep also found 89
 * past-dated visits parked in on_site/en_route the same way — that stale
 * in-progress class shipped here first and was removed 2026-09-28 (see
 * below). Nothing in the portal surfaces an unpriced series; it silently
 * costs money.
 *
 * Exception classes, one pager:
 *  1. UNPRICED RECURRING SERIES — an upcoming recurring visit (within
 *     UPCOMING_WINDOW_DAYS) where neither the row nor its recurring parent
 *     carries a price (estimated_price / primary_line_price). Children
 *     legitimately ride with NULL price and inherit from their parent at
 *     invoice time, so only a series with no price ANYWHERE pages. One bell
 *     per series (root id), not per visit. A visit covered by a live combined
 *     first-application invoice never pages — judged by billing-lane's
 *     siblingInvoiceCoverageVerdict, the one determination billing itself uses
 *     (it follows a voided combined invoice to its live replacement).
 *  2. LAWN-EMAIL AUDIENCE GAP — a customer with live recurring-lawn
 *     evidence who cannot receive the Monday irrigation email (no email /
 *     no coordinates / lead-stage / inactive). The email's audience is
 *     computed at send time via the same predicate this check reuses, so
 *     adds and drops are automatic — only prerequisite failures page.
 *  3. PREPAY COVERAGE GAPS — annual stamps the completion validator cannot
 *     verify, missing or conflicting stamps on linked paid terms, or a missing
 *     or replaced manual series allocation. Includes overdue live visits.
 *  4. CHURNED CUSTOMER WITH LIVE WORK — a customer whose live pipeline_stage is
 *     'churned' (not soft-deleted) who still has a live upcoming visit or an
 *     invoice that never reached the customer (draft / scheduled). Catches a
 *     churn done outside the app's cancel path (a direct database edit skips
 *     its steps, leaving open visits on the books and a draft unvoided). One
 *     bell per customer; it clears once the work is cancelled or voided.
 *
 * Accepted-plan gaps also start from the accepted estimate, covering missing
 * recurrence, applications, and matching cadence/property evidence.
 *
 * A fourth pass, the combined-booking check (combined-booking-check.js), runs
 * at the end of each tick: multi-service accepts get their time/technician,
 * per-visit prices and first-day invoice verified and one short admin note.
 *
 * The STALE IN-PROGRESS class (a visit whose scheduled_date was before today
 * ET still sitting in on_site/en_route) was removed 2026-09-28: the 7 PM ET
 * tech text about today's still-open visits (server/services/tech-open-visit-nudge.js)
 * reaches the person who can actually act on it same-day, superseding the
 * ~70/week admin-only bell nobody was acting on.
 *
 * Alerting mirrors call-booking-miss-watchdog: one bell per subject, deduped
 * forever via the notifications metadata dedupeKey, with a per-run cap so
 * the first enable over the existing backlog rings loudly but readably —
 * dedupe keys make the remainder ring on subsequent ticks. Dark by default
 * behind GATE_SCHEDULE_INTEGRITY_WATCHDOG. Read-only against
 * scheduled_services; writes nothing but admin notifications.
 *
 * ALERT EPISODES (ALERT_EPISODES, live unless killed — see feature-gates):
 * every bell here now clears itself when its problem is fixed and rings again
 * when the problem comes back. Each run computes each class's COMPLETE live
 * key set (independent of the per-run cap), raises every live finding through
 * raiseAdminAlertWithReopen (below; a standing row is a silent dedupe, an
 * auto-cleared one is reopened and re-rings), and closes every open bell of
 * the class whose key is absent (closeAdminAlertKeys — read rows too, so a
 * person's read never blocks a comeback). The helpers are local to this
 * module (first-application-sibling-split.js keeps its own copy of the same
 * pattern; neither is a shared service until a second caller needs one). The
 * cap counts only rows
 * newly created or re-rung. A stale-scan race — the problem reappearing right
 * after this run's scan — heals on the next run through the same reopen.
 * Prepay-coverage reviews are the exception to "absent = close": a visit that
 * COMPLETED (or was rescheduled) with the gap still there — re-judged by the
 * scan's own predicates — stays open for a person, because completion is
 * exactly when the prepay billing mistake happens. An unpriced series whose
 * visit completed unpriced and uninvoiced likewise stays open; that visit's
 * episode start is the run's pre-scan time, persisted on the bell as
 * metadata.episode_started_at, so a completion racing the bell insert holds.
 */

const db = require('../models/db');
const { createHash } = require('node:crypto');
const logger = require('./logger');
const NotificationService = require('./notification-service');
const alertEpisodes = require('./admin-alert-episodes');
const { etDateString } = require('../utils/datetime-et');

// Upcoming look-ahead for the unpriced-series class. Two weeks: far enough
// out that Adam can price the series before the visit day, small enough that
// long-tail future visits (a bimonthly series stretches 10 months out)
// don't page months early.
const UPCOMING_WINDOW_DAYS = 14;
// A first enable can scan a real backlog across the remaining classes; cap
// the bells per run so it drains over ticks instead of flooding.
const MAX_ALERTS_PER_RUN = 10;

// The bell classes, by dedupeKey prefix. Only the watchdog raises under
// these prefixes, so an open row under one is this module's to close.
const UNPRICED_PREFIX = 'unpriced-series:';
const LAWN_GAP_PREFIX = 'lawn-email-gap:';
const PREPAY_PREFIX = 'prepay-coverage:';
const ACCEPTED_PREFIX = 'accepted-schedule:';
const CHURNED_PREFIX = 'churned-live-work:';
// Invoice statuses that have not reached the customer (the status column has no
// CHECK; 'send_failed' is an estimate status, never an invoice one).
const UNSENT_INVOICE_STATUSES = ['draft', 'scheduled'];
// A prepay-coverage visit in these statuses stays open for a person even with
// the gap gone from the scan: a completed visit is where the billing mistake
// happens, and a rescheduled one moved its coverage question elsewhere.
const PREPAY_HOLD_OPEN_STATUSES = ['completed', 'rescheduled'];
// A visit that never ran: its coverage review is moot.
const NEVER_RAN_STATUSES = ['cancelled', 'canceled', 'skipped', 'no_show'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// A row is priced if it carries either price field itself.
function rowHasPrice(row) {
  return toMoney(row?.estimated_price) != null || toMoney(row?.primary_line_price) != null;
}

// An upcoming visit pages when nothing that will actually bill it carries a
// price. Recurring children (is_recurring=true under a parent) inherit the
// parent's price at invoice time, so a priced parent suppresses. A
// booster/add-on child (is_recurring=false with a recurring_parent_id) bills
// as its own one-off visit and does NOT inherit — it is judged on its own
// price only. The query LEFT JOINs the parent and rides its price fields
// along as parent_estimated_price / parent_primary_line_price.
//
// PREPAID visits never page — but only through the SAME coverage rules the
// completion-billing gate applies (admin-dispatch), so the watchdog can't
// suppress a page on a visit that completion would still bill (or bill at
// $0). Two coverage paths, mirroring that gate exactly:
//  - An OUT-OF-BAND stamp (prepaid_method other than the annual-prepay
//    method: cash/check/Zelle, fanned by prepaid-series.js) with a positive
//    amount suppresses here (pure check below).
//  - An ANNUAL-PREPAY stamp is only trusted after annualPrepayCoversVisit
//    validates the linked term (fail-closed; stale stamps left by
//    refund/void cleanup must not suppress) — async, applied in runInner.
// A parent's stamp NEVER covers a child: completion billing does not
// inherit prepaid_amount, so a child seeded after a parent-only prepay is a
// real $0-completion risk and must page. Rows with no stamp at all page
// even when the customer holds a prepay term — an unstamped visit under a
// term is exactly the inconsistency (double-bill at completion) worth a
// bell.
const ANNUAL_PREPAY_METHOD = 'annual_prepay_invoice';

// The annual writer's live-status rule: NULL is live, these are not. Shared
// by the coverage candidate scan and the inferred family-payment groups.
const LIVE_STATUS_EXCLUSIONS = ['cancelled', 'canceled', 'completed', 'rescheduled', 'skipped', 'no_show'];

function hasOutOfBandPrepaidStamp(row) {
  return toMoney(row?.prepaid_amount) != null
    && row?.prepaid_method !== ANNUAL_PREPAY_METHOD;
}

function hasAnnualPrepaidStamp(row) {
  return toMoney(row?.prepaid_amount) != null
    && row?.prepaid_method === ANNUAL_PREPAY_METHOD;
}

function manualSeriesStampIssue(row) {
  // Explicit allocation audits cover even a one-visit series. Historical rows
  // without audits still require two matching survivors to prove series scope.
  // Inferred groups: [paid_at, method, members, live_members]; allocation
  // audits: [paid_at, method, audit_id, amount].
  const inferred = row?.manual_series_payment_evidence || [];
  const allocations = row?.manual_series_allocation_evidence || [];
  if (!inferred.length && !allocations.length) return null;
  if (!(Number(row?.prepaid_amount) > 0)) return 'manual_series_stamp_missing';
  // A different payment cannot silently replace the original allocation.
  const stampedAt = new Date(row.prepaid_at).getTime();
  const matchesStamp = (paidAt, method) => method === row.prepaid_method
    && new Date(paidAt).getTime() === stampedAt;
  const allocationsMatch = allocations.every(([paidAt, method, , amount]) => matchesStamp(paidAt, method)
    && (amount == null || Number(amount) === Number(row.prepaid_amount)));
  // A family payment whose stamped members are all terminal has closed its
  // books: a live row carrying a later explicit series stamp was amended, not
  // silently replaced (Codex #4030 r7 P2). A group with a live member still
  // holds that payment on a sibling sharing this row's coverage, so this
  // row's different stamp must be reconciled against it.
  const inferredMatch = inferred
    .filter(([, , , liveMembers]) => liveMembers == null || Number(liveMembers) > 0)
    .every(([paidAt, method]) => matchesStamp(paidAt, method));
  return allocationsMatch && inferredMatch ? null : 'manual_series_stamp_conflict';
}

// A live invoice on this visit (direct or via its service record) that bills
// its BASE application: billing's own evidence rule for a visit's own
// invoices (invoiceBillsBaseApplication, a positive base line; completion and
// the first-application split judge a visit's own invoices the same way).
// Several invoices can share one visit, so an unrelated repair or add-on
// invoice never counts, and neither does a $0 or credited base line.
async function ownInvoiceBillsBaseApplication(row) {
  const { anyInvoiceLinkedToVisit, CANCELLED_SERVICE_RESOLVED_STATUSES } = require('./invoice');
  const { invoiceBillsBaseApplication } = require('./estimate-first-application-invoice');
  const own = await anyInvoiceLinkedToVisit(db, row.id)
    .whereNotIn('status', CANCELLED_SERVICE_RESOLVED_STATUSES).select('id', 'line_items');
  return own.some((inv) => invoiceBillsBaseApplication(inv));
}

// A visit priced by a combined first-application invoice (a new customer's
// same-trip second service; estimate-converter.js stamps the anchor and every
// covered sibling) is covered by that invoice, not by its own row. Which
// invoice governs is billing's call, not the stamp's: when the stamped invoice
// went terminal but a live replacement sits on its anchor, billing treats the
// sibling as covered. So this asks billing-lane's canonical verdict — only for
// a visit that reached this check unpriced with a source estimate (a handful).
// Only 'covered' suppresses; 'needs_review', 'none' and 'error' keep paging
// (fail toward the alert). The ANCHOR is the other half: it carries the
// combined invoice (or its live replacement) on its own row — billing reuses
// that invoice at completion, and its sibling verdict reads 'none' for it —
// so a stamped visit whose own live invoice bills its base application is
// billed. An unrelated invoice on it (the combined one voided) keeps paging.
async function coveredByFirstApplicationInvoice(row) {
  if (row?.first_application_invoice_id && await ownInvoiceBillsBaseApplication(row)) return true;
  if (!row?.source_estimate_id) return false;
  const { siblingInvoiceCoverageVerdict } = require('./billing-lane');
  const verdict = await siblingInvoiceCoverageVerdict({
    id: row.id,
    customer_id: row.customer_id,
    source_estimate_id: row.source_estimate_id,
    scheduled_date: row.service_date,
    first_application_invoice_id: row.first_application_invoice_id,
  }, db);
  return verdict?.status === 'covered';
}

function isUnpricedSeriesVisit(row) {
  // Preserve the original pricing query's status eligibility; the broader
  // coverage scan also handles legacy null-status visits.
  if (row?.status == null) return false;
  if (rowHasPrice(row)) return false;
  if (hasOutOfBandPrepaidStamp(row)) return false;
  const inheritsFromParent = !!row.recurring_parent_id && row.is_recurring !== false;
  if (!inheritsFromParent) return true;
  return toMoney(row.parent_estimated_price) == null && toMoney(row.parent_primary_line_price) == null;
}

// One subject per series: recurring children collapse onto their parent; a
// booster/add-on child bills alone and is its own subject.
function seriesRootId(row) {
  if (row?.recurring_parent_id && row?.is_recurring !== false) return row.recurring_parent_id;
  return row?.id;
}

async function runScheduleIntegrityWatchdog({ now = new Date() } = {}) {
  const { isEnabled } = require('../config/feature-gates');
  if (!isEnabled('scheduleIntegrityWatchdog')) {
    return { skipped: true, reason: 'gated_off' };
  }
  // notifyAdmin's dedupe takes its own per-key advisory lock, but a run's
  // classification pass (which rows are unpriced/etc.) is not itself locked
  // — serialize ticks so deploy overlap can't build two different alert sets
  // from an overlapping read.
  const { runExclusive } = require('../utils/cron-lock');
  return runExclusive('schedule-integrity-watchdog', () => runInner({ now }));
}

// The coverage scan's shared FROM/joins/select: the main scan adds its own
// live-status, look-ahead and recurring filters; the unpriced close pass's
// completed-visit check adds its own. One definition, so both judge a visit
// on exactly the same columns (price, parent price, first-application invoice,
// prepay evidence).
function coverageScanQuery() {
  return db('scheduled_services as ss')
    .leftJoin('scheduled_services as parent', 'parent.id', 'ss.recurring_parent_id')
    .leftJoin('annual_prepay_terms as prepay_term', 'prepay_term.id', 'ss.annual_prepay_term_id')
    .leftJoin('invoices as prepay_invoice', 'prepay_invoice.id', 'prepay_term.prepay_invoice_id')
    .select(
      'ss.id', 'ss.customer_id', 'ss.status', 'ss.service_type', 'ss.is_recurring',
      'ss.estimated_price', 'ss.primary_line_price', 'ss.prepaid_amount',
      'ss.prepaid_method', 'ss.annual_prepay_term_id', 'ss.recurring_parent_id',
      'ss.created_at', 'ss.prepaid_at', 'ss.first_application_invoice_id', 'ss.source_estimate_id',
      db.raw('ss.xmin::text as row_revision'),
      'parent.estimated_price as parent_estimated_price',
      'parent.primary_line_price as parent_primary_line_price',
      // Fingerprints only: coverage authority remains annualPrepayCoversVisit.
      // Include funding revisions so a repaired term can alert again after
      // a later refund/void even when best-effort visit cleanup did not run.
      db.raw(`jsonb_build_array(prepay_term.id, prepay_term.customer_id, prepay_term.status,
        prepay_term.coverage_service_type, prepay_term.renewal_decision,
        prepay_term.xmin::text) as prepay_term_evidence`),
      db.raw(`jsonb_build_array(prepay_invoice.id, prepay_invoice.status,
        prepay_invoice.paid_at, prepay_invoice.xmin::text) as prepay_invoice_evidence`),
      db.raw(`(SELECT jsonb_agg(jsonb_build_array(p.id, p.status, p.refund_status,
          p.xmin::text) ORDER BY p.id)
        FROM payments p
        WHERE (p.stripe_payment_intent_id IS NOT NULL
          AND p.stripe_payment_intent_id = prepay_invoice.stripe_payment_intent_id)
          OR (p.stripe_charge_id IS NOT NULL AND p.stripe_charge_id = prepay_invoice.stripe_charge_id)
      ) as prepay_payment_evidence`),
      db.raw(`(SELECT jsonb_agg(jsonb_build_array(allocation.metadata->>'prepaid_at',
          allocation.metadata->>'prepaid_method', allocation.id, allocation.metadata->>'prepaid_amount')
          ORDER BY allocation.id)
        FROM audit_log allocation
        WHERE allocation.resource_type = 'scheduled_service' AND allocation.resource_id = ss.id
          AND allocation.action = 'prepaid_series.allocated'
          AND allocation.metadata->>'customer_id' = ss.customer_id::text
          AND NOT EXISTS (SELECT 1 FROM audit_log cleared
            WHERE cleared.resource_type = 'prepaid_series_allocation'
              AND cleared.resource_id = allocation.id AND cleared.action = 'prepaid_series.cleared')
      ) as manual_series_allocation_evidence`),
      // Two matching payment stamps prove series scope even if the ROOT's
      // stamp was cleared. Keep every evidentiary tuple version in the key:
      // clearing/restoring a paid sibling must reopen an unchanged gap.
      // live_members counts the group's still-live stamped rows (same
      // predicate as whereLive) so manualSeriesStampIssue can tell a
      // closed-books payment from one a live sibling still carries.
      db.raw(`(SELECT jsonb_agg(jsonb_build_array(g.prepaid_at, g.prepaid_method, g.members, g.live_members)
          ORDER BY g.prepaid_at, g.prepaid_method)
        FROM (SELECT paid.prepaid_at, paid.prepaid_method,
            jsonb_agg(jsonb_build_array(paid.id, paid.xmin::text) ORDER BY paid.id) AS members,
            count(*) FILTER (WHERE paid.status IS NULL
              OR paid.status NOT IN (${LIVE_STATUS_EXCLUSIONS.map(() => '?').join(', ')})) AS live_members
          FROM scheduled_services paid
          WHERE (paid.recurring_parent_id = coalesce(ss.recurring_parent_id, ss.id)
            OR paid.id = coalesce(ss.recurring_parent_id, ss.id))
            AND paid.customer_id = ss.customer_id
            AND paid.prepaid_at >= ss.created_at
            AND paid.prepaid_amount > 0
            AND paid.prepaid_method IS DISTINCT FROM 'annual_prepay_invoice'
          GROUP BY paid.prepaid_at, paid.prepaid_method HAVING count(*) >= 2
        ) g) as manual_series_payment_evidence`, LIVE_STATUS_EXCLUSIONS),
      db.raw("to_char(ss.scheduled_date, 'YYYY-MM-DD') as service_date"),
    );
}

// The paid annual terms linked from these rows (id -> term), for the coverage
// judgement below. Same validator surface the completion-billing gate uses.
async function loadPaidTerms(rows) {
  const { coveredTermsAsOf } = require('./annual-prepay-renewals');
  const linkedTermIds = [...new Set(rows.map((row) => row.annual_prepay_term_id).filter(Boolean))];
  const paidTerms = linkedTermIds.length ? await coveredTermsAsOf(db, null).whereIn('t.id', linkedTermIds)
    .select('t.id', 't.customer_id', 't.coverage_service_type') : [];
  return new Map(paidTerms.map((term) => [term.id, term]));
}

// One visit's prepay-coverage judgement: the issues it has right now, and
// whether a validated annual stamp covers it. Same validator the completion-billing gate uses
// (fail-closed): an annual-prepay stamp suppresses only when its linked term
// is live, customer-matched, and coverage-service-matched. Lazy require
// mirrors the feature-gates pattern and keeps module load light.
async function judgePrepayGaps(row, paidTermById) {
  const { annualPrepayCoversVisit, serviceMatchesCoverage } = require('./annual-prepay-renewals');
  const annualStamp = row.prepaid_method === ANNUAL_PREPAY_METHOD;
  const annualCovered = annualStamp && await annualPrepayCoversVisit(row, db);
  const term = paidTermById.get(row.annual_prepay_term_id);
  const linkedCoverage = term && term.customer_id === row.customer_id
    && (!term.coverage_service_type || serviceMatchesCoverage(row, term.coverage_service_type));
  // A manual override of a linked paid annual term conflicts with that
  // allocation authority, even when positive. In particular a partial
  // cash/check stamp cannot hide already-paid coverage before completion.
  const annualCoverageGap = annualStamp ? !annualCovered : linkedCoverage;
  const issues = [];
  if (annualCoverageGap) issues.push('annual_coverage_unverified');
  const manualIssue = manualSeriesStampIssue(row);
  if (manualIssue) issues.push(manualIssue);
  return { annualCovered, issues };
}

// Class 5: a customer churned OUTSIDE the app's cancel steps (the owner's
// scope, 2026-09-29 alert follow-ups decision 1) whose leftover work those
// steps would still clean up. The cancel processor mints
// customers.churn_episode_id on every whole-account churn and every
// reactivation path clears it, so a churned row without one was churned some
// other way: a stage flip, a direct database write, or a processor churn from
// before the stamp shipped. A stamped row went through the cancel steps, and
// what they leave (paid visits kept to term_end, visits parked for review, a
// refund owed) is deliberate, never residue. For the unstamped, the steps'
// own work list:
//   - a live visit the sweep would pull: live by the churn guard's
//     tracker-aware rule (whereVisitRowLive), except one an end-at-term lapse
//     keeps (keptLapseVisitIds);
//   - a series anchor still marked recurring_ongoing;
//   - a paid prepay term still covering that nobody decided (coveredTermsAsOf
//     with a term_end floor, as findActivePrepayTerm reads it). A decided
//     lapse, 'cancelled' with renewal_decision 'cancel', is the renewal
//     machinery's own outcome;
//   - a payment_pending prepay term whose invoice is still payable and not
//     yet collected (findPendingPrepayInvoice's rule);
//   - an invoice the cancel would void that never reached the customer: draft
//     or scheduled, not archived, no delivery stamp, not parked on invoice.js's
//     BILLING_EMAIL_PENDING_AFTER_CHANNEL_ACCEPTED marker, and linked by
//     invoice.js's visit link (scheduled_service_id, or a service record of
//     the visit) to a visit the sweep would pull or one already cancelled. An
//     invoice for finished work is an earned receivable, not this page's.
// Set-based: one query, an EXISTS per leg, the counts as correlated
// subselects. The live pipeline_stage is the churn marker; a merge
// soft-deletes, so deleted_at must be null. Known limit: a stamp that a
// promotion out of churned never cleared (self-booking-plan-sync's tier
// alignment) hides a later out-of-band churn of that row.
const CHANNEL_ACCEPTED_MARKER = 'BILLING_EMAIL_PENDING_AFTER_CHANNEL_ACCEPTED';

// The visits an end-at-term lapse keeps, by the cancel's own identity: the
// term's canonical covered rows (coverageRowsForTerm, the set
// liveCoveredKeepIds hands the sweep as keepVisitIds), not a rescheduled
// rebook, dated through term_end (keepThrough). This is the impact preview's
// `kept` rule. A linked row outside that set (another family, one past the
// sold count) is pulled, so it still pages. Only paid lapses of unstamped
// churned customers.
async function keptLapseVisitIds(todayET) {
  const renewals = require('./annual-prepay-renewals');
  const { coverageRowsForTerm, dateOnly } = renewals._private;
  const terms = await renewals.coveredTermsAsOf(db, null)
    .join('customers as c', 'c.id', 't.customer_id')
    .where('c.pipeline_stage', 'churned').whereNull('c.deleted_at').whereNull('c.churn_episode_id')
    .where({ 't.status': 'cancelled', 't.renewal_decision': 'cancel', 't.cancel_disposition': 'end_at_term' })
    .where('t.term_end', '>=', todayET)
    .select('t.*');
  const kept = [];
  for (const term of terms) {
    const keepThrough = dateOnly(term.term_end);
    for (const row of await coverageRowsForTerm(term)) {
      if (row.status !== 'rescheduled' && dateOnly(row.scheduled_date) <= keepThrough) kept.push(row.id);
    }
  }
  return kept;
}

async function findChurnedLiveWork(todayET) {
  const { whereVisitRowLive } = require('./customer-lifecycle-guard');
  const renewals = require('./annual-prepay-renewals');
  const collected = renewals._private.PREPAY_INVOICE_COLLECTED_STATUSES;
  const { INVOICE_CANCELLED_STATUSES } = require('./annual-prepay-invoice-statuses');
  const cancelled = [...INVOICE_CANCELLED_STATUSES];
  const kept = await keptLapseVisitIds(todayET);
  // A visit the cancel's sweep would pull. whereVisitRowLive's columns are
  // unqualified, so they bind to the innermost visit alias.
  const sweepWouldPull = (alias) => function pulled() {
    this.where(function liveRow() { whereVisitRowLive(this, todayET); }).whereNotIn(`${alias}.id`, kept);
  };
  const legs = {
    live_visits: () => db('scheduled_services as sv').whereRaw('sv.customer_id = c.id').where(sweepWouldPull('sv')),
    ongoing_series: () => db('scheduled_services as so').whereRaw('so.customer_id = c.id').where('so.recurring_ongoing', true),
    // 'cancelled' is covered only as a decided lapse (coveredTermsAsOf's
    // lapsedRenewalStillInTerm arm), so this drops exactly those.
    prepay_terms: () => renewals.coveredTermsAsOf(db, null).whereRaw('t.customer_id = c.id').where('t.term_end', '>=', todayET)
      .whereNot('t.status', 'cancelled'),
    // Still payable AND not yet collected: a collected invoice whose term has
    // not advanced yet is paid coverage (the prepay_terms leg), never an
    // unpaid invoice. The exact, NULL-safe complement of
    // wherePrepayInvoiceCollected (status IN collected OR paid_at set), so a
    // status-less unpaid invoice still counts.
    pending_prepay_invoices: () => db('annual_prepay_terms as pt').join('invoices as pi', 'pi.id', 'pt.prepay_invoice_id')
      .whereRaw('pt.customer_id = c.id').where('pt.status', 'payment_pending')
      .whereRaw(`lower(COALESCE(pi.status, '')) NOT IN (${cancelled.map(() => '?').join(', ')})`, cancelled)
      .whereRaw(`COALESCE(pi.status, '') NOT IN (${collected.map(() => '?').join(', ')})`, collected)
      .whereNull('pi.paid_at'),
    // The customer's own: a third-party payer's invoice (payer_id), one
    // accrued on a payer's NET statement (payer_statement_id, never sent on
    // its own) or one withdrawn to the payer (invoice-helpers.js's
    // payer_billed: stamp) is the payer's receivable, never the churned
    // customer's to void.
    unsent_invoices: () => db('invoices as inv').whereRaw('inv.customer_id = c.id').whereNull('inv.archived_at')
      .whereIn('inv.status', UNSENT_INVOICE_STATUSES)
      .whereNull('inv.payer_id').whereNull('inv.payer_statement_id')
      .whereNull('inv.sent_at').whereNull('inv.sms_sent_at').whereNull('inv.email_sent_at').whereNull('inv.viewed_at')
      .whereRaw("COALESCE(inv.scheduled_send_error, '') NOT LIKE ?", [`${CHANNEL_ACCEPTED_MARKER}%`])
      .whereRaw("COALESCE(inv.scheduled_send_error, '') NOT LIKE 'payer\\_billed:%'")
      .whereExists(function forWorkTheCancelUndoes() {
        this.select(db.raw('1')).from('scheduled_services as lv')
          .where(function linkedVisit() {
            this.whereRaw('lv.id = inv.scheduled_service_id')
              .orWhereRaw('lv.id = (SELECT sr.scheduled_service_id FROM service_records sr WHERE sr.id = inv.service_record_id)');
          })
          .where(function pulledOrCancelled() { this.whereIn('lv.status', ['cancelled', 'canceled']).orWhere(sweepWouldPull('lv')); });
      }),
  };
  const names = Object.keys(legs);
  return db('customers as c')
    .where('c.pipeline_stage', 'churned')
    .whereNull('c.deleted_at')
    .whereNull('c.churn_episode_id')
    .where(function anyLiveWork() {
      names.forEach((name, i) => this[i ? 'orWhereExists' : 'whereExists'](legs[name]().select(db.raw('1'))));
    })
    .select('c.id', ...names.map((name) => legs[name]().select(db.raw('count(*)::int')).as(name)))
    .orderBy('c.id');
}

// What each count names in the bell, most pressing first.
const LIVE_WORK_WORDS = [
  ['live_visits', 'live visit'],
  ['ongoing_series', 'ongoing series'],
  ['prepay_terms', 'active prepay term'],
  ['pending_prepay_invoices', 'unpaid prepay invoice'],
  ['unsent_invoices', 'unsent invoice'],
];

// The class's alerts, or a failed flag when the check threw (an unknown live
// set: the close pass then leaves the class's standing bells alone). The bell
// is one per customer; its text follows the work that is left through a quiet
// refresh that never re-rings it.
async function churnedLiveWorkAlerts(todayET) {
  try {
    const rows = await findChurnedLiveWork(todayET);
    const alerts = rows.map((r) => {
      const counts = Object.fromEntries(LIVE_WORK_WORDS.map(([name]) => [name, Number(r[name]) || 0]));
      const parts = LIVE_WORK_WORDS.filter(([name]) => counts[name] > 0)
        .map(([name, word]) => `${counts[name]} ${word}${counts[name] === 1 ? '' : (word.endsWith('series') ? '' : 's')}`);
      return [
        `${CHURNED_PREFIX}${r.id}`,
        'Churned customer still has live work',
        `Still on the books for a churned customer: ${parts.join(', ')}. Cancel or void it through the app ("Cancel plan…" and the invoice tools).`,
        { customer_id: r.id, ...counts },
        { link: `/admin/customers?customerId=${encodeURIComponent(r.id)}`, refreshOnDedupe: true, ringOnRefresh: () => false },
      ];
    });
    return { alerts, failed: false };
  } catch (err) {
    logger.error(`[schedule-integrity] churned-customer live-work check failed: ${err.message}`);
    return { alerts: [], failed: true };
  }
}

async function runInner({ now = new Date() } = {}) {
  const todayET = etDateString(now);

  // Coverage can still be lost on an overdue visit that staff complete later.
  // Match the annual writer's null-or-live status predicate. The existing
  // unpriced-series class keeps its upcoming-only window below.
  const horizon = new Date(now.getTime() + UPCOMING_WINDOW_DAYS * 24 * 3600 * 1000);
  const coverageCandidates = await coverageScanQuery()
    .where(function whereLive() {
      this.whereNull('ss.status').orWhereNotIn('ss.status', LIVE_STATUS_EXCLUSIONS);
    })
    .where('ss.scheduled_date', '<=', etDateString(horizon))
    .where(function whereRecurring() {
      this.where('ss.is_recurring', true).orWhereNotNull('ss.recurring_parent_id')
        .orWhere('ss.prepaid_method', ANNUAL_PREPAY_METHOD).orWhereNotNull('ss.annual_prepay_term_id')
        .orWhereExists(function hasFamily() {
          this.select(db.raw('1')).from('scheduled_services as child')
            .whereRaw('child.recurring_parent_id = ss.id AND child.customer_id = ss.customer_id');
        }).orWhereExists(function hasAllocation() {
          this.select(db.raw('1')).from('audit_log as allocation')
            .where({ 'allocation.action': 'prepaid_series.allocated', 'allocation.resource_type': 'scheduled_service' })
            .whereRaw('allocation.resource_id = ss.id');
        });
    })
    // Preserve near-term coverage alert priority while adding past backlog.
    .orderByRaw('ss.scheduled_date >= ? DESC', [todayET])
    .orderBy('ss.scheduled_date', 'asc');
  const unpricedByRoot = new Map();
  const overdueUnpricedByRoot = new Map();
  const prepayGaps = [];
  const paidTermById = await loadPaidTerms(coverageCandidates);
  // Lazy require, like isEnabled above; read at call time so the env is a live kill switch.
  const episodes = require('../config/feature-gates').alertEpisodesLive();
  for (const row of coverageCandidates) {
    const { annualCovered, issues } = await judgePrepayGaps(row, paidTermById);
    for (const issue of issues) prepayGaps.push({ row, issue });
    if (!isUnpricedSeriesVisit(row)) continue;
    if (annualCovered) continue;
    // Under episodes an authoritative $0 is a price here too, upcoming or
    // overdue: the same rule the completed-visit watch applies.
    if (episodes && authoritativeZeroPrice(row)) continue;
    // Only under episodes: the suppression is safe because a void of that
    // invoice makes the series live again and it re-rings. Killed = the
    // pre-episode paging, with no coverage lookup at all.
    if (episodes && await coveredByFirstApplicationInvoice(row)) continue;
    const root = seriesRootId(row);
    // An OVERDUE unpriced visit never pages a new bell (the class is
    // upcoming-only), but it is still an unpriced series: unpricedSeriesAlerts
    // keeps its bell live.
    if (row.service_date < todayET) {
      if (!overdueUnpricedByRoot.has(String(root))) overdueUnpricedByRoot.set(String(root), row);
      continue;
    }
    if (!unpricedByRoot.has(String(root))) unpricedByRoot.set(String(root), row);
  }

  // Under episodes: every unpriced-series bell (its watch start) and the
  // series still unpriced by a visit that completed since its bell first rang.
  const bellSince = episodes ? await unpricedSeriesBells() : new Map();
  const completedUnpricedByRoot = episodes ? await completedUnpricedSince(bellSince) : new Map();
  // Unpriced series ring FIRST: they are same-day money loss (a visit can
  // complete and invoice at $0 today).
  const alerts = unpricedSeriesAlerts({ upcomingByRoot: unpricedByRoot, overdueByRoot: episodes ? overdueUnpricedByRoot : new Map(),
    completedByRoot: completedUnpricedByRoot, bellSince, episodes, now });

  // Class 2 — recurring-lawn customers invisible to the Monday irrigation
  // email (owner directive 2026-08-05: check daily). The email's audience is
  // computed at send time, so there is no enrollment list to reconcile — the
  // only drift class is a customer WITH recurring-lawn evidence failing a
  // prerequisite (unusable email / bad coordinates / lead-stage / inactive
  // with live future evidence). Reuses the sender's own predicate AND its
  // validators (findLawnEmailAudienceGaps) so check and send can't diverge;
  // the module returns ONLY pageable gaps — opt-outs and legitimately
  // churned customers never reach here. A failed check is REPORTED in the
  // result, never silently zero.
  let lawnGaps = [];
  let lawnGapCheckFailed = false;
  try {
    const { findLawnEmailAudienceGaps, findUnstampedRecurringLawnMembers } = require('./irrigation-weekly-email');
    lawnGaps = await findLawnEmailAudienceGaps({ now });
    // Membership-evidence leg (owner ruling 2026-08-10): members whose lawn
    // visits were never stamped recurring fail the shared evidence predicate,
    // so the leg above is structurally blind to them — this one pages them.
    lawnGaps = lawnGaps.concat(await findUnstampedRecurringLawnMembers({ now }));
  } catch (e) {
    lawnGapCheckFailed = true;
    logger.error(`[schedule-integrity] lawn-email audience-gap check failed: ${e.message}`);
  }
  alerts.push(...lawnGaps.map((g) => {
    if (g.kind === 'unstamped_member') {
      // Stamping alone only helps if the sender's other prerequisites hold —
      // the leg validates them too (codex #3341 r1 P2), so one card lists
      // everything standing between this customer and Monday.
      const extras = g.fixable.filter((f) => f !== 'no_recurring_marked_lawn_visit');
      // Dedupe keyed to the OFFENDING BOOKING, not just customer+fixables
      // (codex #3341 r3 P2): the forever-dedupe has no expiry, so a customer
      // fixed once and regressed later — new one-time booking after the
      // stamped series was cancelled — must mint a NEW key and page again.
      return [
        `lawn-email-gap:${g.customerId}:${[...g.fixable].sort().join('+')}${g.triggerVisitId ? `:${g.triggerVisitId}` : ''}`,
        `${g.name || 'A recurring member'}'s lawn visits aren't stamped as a recurring series`,
        `${g.name || 'This customer'} was enrolled as a recurring member and has lawn service on the ` +
        'books, but no visit is stamped as part of a recurring series (and no cadence shows yet), so ' +
        'the Monday irrigation email can never select them. Book or re-stamp their next lawn visit as ' +
        'part of the recurring series' +
        (extras.length
          ? ` — and also fix: ${extras.join(', ')} — then they are included automatically next Monday.`
          : ' and they are included automatically next Monday.'),
        { customer_id: g.customerId, fixable: g.fixable },
        { link: `/admin/customers?customerId=${encodeURIComponent(g.customerId)}` },
      ];
    }
    return [
      `lawn-email-gap:${g.customerId}:${[...g.fixable].sort().join('+')}`,
      `${g.name || 'A recurring-lawn customer'} is missing from the Monday watering email`,
      `${g.name || 'This customer'} has live recurring lawn service but cannot receive the Monday ` +
      `irrigation email: ${g.fixable.join(', ')}. Fix the listed field(s) on their customer record ` +
      'and they are included automatically next Monday — the audience is computed at send time.',
      { customer_id: g.customerId, fixable: g.fixable },
      // The fields to fix live on the customer record, not dispatch — and an
      // active trailing-evidence gap may have no dispatch row at all (Codex
      // #3209 post-merge P3). Query-param form, NOT /admin/customers/<id>:
      // the SPA registers no path route for a bare id — CustomersPageV2
      // opens Customer 360 from the customerId query param (Codex #3215).
      { link: `/admin/customers?customerId=${encodeURIComponent(g.customerId)}` },
    ];
  }));

  // Preserve the morning lawn-email class before adding coverage-review volume.
  alerts.push(...prepayGaps.map(({ row, issue }) => {
    const evidenceKey = createHash('sha256').update(JSON.stringify([
      row.row_revision, row.service_type, row.prepaid_amount, row.prepaid_method, row.prepaid_at, row.annual_prepay_term_id,
      row.manual_series_payment_evidence, row.manual_series_allocation_evidence,
      row.prepay_term_evidence, row.prepay_invoice_evidence, row.prepay_payment_evidence,
    ])).digest('hex').slice(0, 20);
    return [
      `prepay-coverage:${row.id}:${issue}:${evidenceKey}`,
      `Prepaid coverage needs review for ${row.service_date}`,
      {
        annual_coverage_unverified: 'This visit has an unverifiable annual-prepay stamp, or is linked to valid paid coverage with a missing or conflicting stamp. Reconcile the payment, term and intended allocation before billing; a stamp alone does not prove payment.',
        manual_series_stamp_missing: 'A recorded manual series allocation or matching family payment stamps indicate coverage for this visit, but it has no payment allocation. Reconcile the recorded payment and intended covered visits before billing.',
        manual_series_stamp_conflict: 'This visit has a different payment stamp from a manual payment recorded across its recurring family. Reconcile the payments and the original allocation before billing.',
      }[issue],
      { scheduled_service_id: row.id, customer_id: row.customer_id, issue },
    ];
  }));

  // Morning lawn-email gaps must page before any historical acceptance backlog.
  let acceptedGaps = [];
  let acceptedScheduleCheckFailed = false;
  try {
    acceptedGaps = await require('./recurring-schedule-audit').findAcceptedRecurringScheduleGaps({ now });
  } catch (err) {
    acceptedScheduleCheckFailed = true;
    logger.error(`[schedule-integrity] accepted-plan check failed: ${err.message}`);
  }
  alerts.push(...acceptedGaps.map((gap) => [
      // Stable per estimate+family — NOT the evidenceKey (that hashes every
      // family row's row_revision/scheduled_date and churns on every
      // routine edit, which minted a fresh row daily for the same standing
      // gap). evidenceKey now rides as dedupeVersion below: a real evidence
      // change re-surfaces this ONE row unread instead of adding a second.
      `accepted-schedule:${gap.estimateId}:${gap.serviceFamily}`,
      'Accepted recurring plan needs schedule review',
      `The accepted ${gap.serviceFamily.replace(/_/g, ' ')} plan calls for ${gap.pattern.replace(/_/g, ' ')} service (${gap.expectedVisits} applications). ` +
        `The linked schedule has ${gap.recordedVisits} working/completed applications. Review: ${gap.issues.map((issue) => issue.replace(/_/g, ' ')).join('; ')}. ` +
        'Check any later amendment or cancellation before changing appointments or prices.',
      { estimate_id: gap.estimateId, customer_id: gap.customerId, issues: gap.issues,
        expected_pattern: gap.pattern, expected_visits: gap.expectedVisits, appointment_ids: gap.appointmentIds },
      { link: `/admin/customers?customerId=${encodeURIComponent(gap.customerId)}`, refreshOnDedupe: true, dedupeVersion: gap.evidenceKey },
  ]));

  // Last: a churned customer's leftover work never starves the money pages
  // above under the per-run cap.
  const churned = await churnedLiveWorkAlerts(todayET);
  alerts.push(...churned.alerts);

  const delivered = await deliverAlerts({
    alerts, episodes, now, horizonDay: etDateString(horizon), lawnGapCheckFailed, acceptedScheduleCheckFailed,
    churnedWorkCheckFailed: churned.failed,
  });

  // Combined-booking check (owner request 2026-09-29): a multi-service accept's
  // time/tech, per-visit prices and first-day invoice, one concise admin note
  // per estimate. Runs here, after the accepted-plan alerts above, because
  // whether the visits exist at all is that alert's finding: the check asks the
  // same classifier and leaves the schedule shape to it. Its own failure never
  // stops the watchdog's other output.
  let combinedBooking = null;
  let combinedBookingCheckFailed = false;
  try {
    // It rings within what is left of this run's shared budget
    // (docs/admin-notifications.md: non-customer rows ring at most 10 a day).
    combinedBooking = await require('./combined-booking-check').runCombinedBookingCheck({
      now, ringBudget: Math.max(0, MAX_ALERTS_PER_RUN - (delivered.alerted || 0)),
    });
  } catch (err) {
    combinedBookingCheckFailed = true;
    logger.error(`[schedule-integrity] combined-booking check failed: ${err.message}`);
  }

  return {
    skipped: false,
    todayET,
    unpricedSeries: unpricedByRoot.size,
    lawnEmailGaps: lawnGaps.length,
    lawnGapCheckFailed,
    prepayCoverageGaps: prepayGaps.length,

    acceptedScheduleGaps: acceptedGaps.length,
    acceptedScheduleCheckFailed,
    churnedLiveWork: churned.alerts.length,
    churnedWorkCheckFailed: churned.failed,
    combinedBooking,
    combinedBookingCheckFailed,
    // alerted, plus closed / closePassFailed under episodes.
    ...delivered,
  };
}

// Delivers one run's findings: rings them in order, capped at
// MAX_ALERTS_PER_RUN real rings, and — under episodes — closes every
// standing bell the findings no longer name (closeResolvedAlerts).
async function deliverAlerts({ alerts, episodes, now, horizonDay, lawnGapCheckFailed, acceptedScheduleCheckFailed, churnedWorkCheckFailed }) {
  let alerted = 0;
  const capped = () => {
    if (alerted < MAX_ALERTS_PER_RUN) return false;
    logger.warn(`[schedule-integrity] per-run alert cap hit (${MAX_ALERTS_PER_RUN}); the rest ring next tick`);
    return true;
  };
  const ring = async (dedupeKey, title, body, metadata, { link = '/admin/dispatch', refreshOnDedupe, ringOnRefresh, dedupeVersion } = {}) => {
    // bell: true — under GATE_ADMIN_BELL_POLICY the 'alert' category is
    // silenced-by-default (OVERRIDABLE_CATEGORIES), so without the explicit
    // site-level tag these money-loss pages would return a suppressed
    // sentinel instead of ringing.
    // Forever-dedupe (or refreshed-on-change with dedupeVersion) now runs
    // through notifyAdmin's own advisory-locked dedupe — passing dedupeKey
    // here instead of a local read-then-insert (the old alreadyAlerted())
    // that raced across overlapping ticks and could double-ring.
    const alertOpts = {
      link,
      bell: true,
      dedupeKey,
      ...(refreshOnDedupe ? { refreshOnDedupe: true } : {}),
      ...(ringOnRefresh ? { ringOnRefresh } : {}),
      ...(dedupeVersion !== undefined ? { dedupeVersion } : {}),
      metadata: { dedupeKey, ...metadata },
    };
    // Episodes: the reopen wrapper (an auto-cleared row rings again; a
    // standing one is a silent dedupe). Killed: exactly the pre-episode call.
    const created = episodes
      ? await alertEpisodes.raiseAdminAlertWithReopen('alert', title, body, alertOpts)
      : await NotificationService.notifyAdmin('alert', title, body, alertOpts);
    // NotificationService.create swallows insert errors into a null result;
    // this job's ONLY output is the bell, so a lost bell must fail the run
    // loudly instead of logging success. Internal-test suppression
    // ({ suppressed: true }) is a deliberate success-without-a-row.
    if (!created || (created.id == null && !created.suppressed)) {
      throw new Error(`[schedule-integrity] notification insert failed for ${dedupeKey} — pager output lost`);
    }
    // A deduped result (the standing row already exists and either matched
    // or was just refreshed) is not a NEW alert for this run's count. Under
    // episodes the cap counts REAL rings: a row created or re-rung (a reopen,
    // or a refresh that rang) — never a silent dedupe onto a standing row.
    // A suppressed alert (an internal test customer) made no bell in either
    // mode, so it never takes a cap slot from a real one.
    if (created.suppressed || (episodes ? !created.rang : created.deduped)) return false;
    alerted += 1;
    return true;
  };

  // Live keys per class, from the COMPLETE findings — computed before the
  // loop so the per-run cap (which only limits new rings) never changes
  // what the close pass judges.
  const liveKeys = new Set(alerts.map((alert) => alert[0]));
  // Keys this run actually delivered (created, re-rung, or standing): a
  // finding the cap held back has no bell yet.
  const deliveredKeys = new Set();
  for (const alert of alerts) {
    if (capped()) break;
    await ring(...alert);
    deliveredKeys.add(alert[0]);
  }
  if (!episodes) return { alerted };
  // A class whose check failed has an unknown live set: closing on it would
  // clear every standing bell of the class.
  const skipPrefixes = [];
  if (lawnGapCheckFailed) skipPrefixes.push(LAWN_GAP_PREFIX);
  if (acceptedScheduleCheckFailed) skipPrefixes.push(ACCEPTED_PREFIX);
  if (churnedWorkCheckFailed) skipPrefixes.push(CHURNED_PREFIX);
  try {
    return { alerted, closed: await closeResolvedAlerts({ now, liveKeys, deliveredKeys, horizonDay, skipPrefixes }), closePassFailed: false };
  } catch (err) {
    logger.error(`[schedule-integrity] alert close pass failed: ${err.message}`);
    return { alerted, closed: 0, closePassFailed: true };
  }
}

// Every unpriced-series bell, open or auto-cleared: series root -> the start
// of the bell's watch, the earliest of its created_at and its
// episode_started_at (the pre-scan time of the run that first raised it, so a
// completion racing the first insert still counts). Every raise onto an
// existing bell writes this start back (unpricedSeriesAlerts), so it never moves
// forward.
async function unpricedSeriesBells() {
  const bells = await db('notifications').where({ recipient_type: 'admin' })
    .whereRaw("starts_with(metadata->>'dedupeKey', ?)", [UNPRICED_PREFIX])
    .select(db.raw("metadata->>'dedupeKey' as dedupe_key"), 'created_at', db.raw("metadata->>'episode_started_at' as episode_started_at"));
  const since = new Map();
  for (const bell of bells) {
    const root = String(bell.dedupe_key).slice(UNPRICED_PREFIX.length);
    const stamps = [bell.created_at, bell.episode_started_at].map((v) => (v ? new Date(v).getTime() : NaN)).filter(Number.isFinite);
    if (!UUID_RE.test(root) || !stamps.length) continue;
    since.set(root, Math.min(since.get(root) ?? Infinity, ...stamps));
  }
  return since;
}

// Of these series (root -> bell start), the ones with a visit that completed
// (its own completed_at; a backfilled completion without one never counts)
// at or after the bell's start while still unpriced by its own row: the scan's
// own rule (isUnpricedSeriesVisit, annual-prepay coverage validated the same
// way), with an authoritative $0 (authoritativeZeroPrice) counting as a price. Whether such a visit was
// then billed right (a combined first-visit invoice, an invoice by hand) is a
// person's call, never this job's. Root -> the latest such visit. Read-only.
async function completedUnpricedSince(sinceByRoot) {
  const found = new Map();
  if (!sinceByRoot.size) return found;
  const roots = [...sinceByRoot.keys()];
  const completed = await coverageScanQuery()
    .where('ss.status', 'completed')
    .where(function inRoots() { this.whereIn('ss.id', roots).orWhereIn('ss.recurring_parent_id', roots); })
    // A real completion time only: a backfilled completion keeps completed_at
    // NULL, and updated_at moves on any later edit, so it would make an old
    // completion look new.
    .whereNotNull('ss.completed_at')
    .where('ss.completed_at', '>=', new Date(Math.min(...sinceByRoot.values())))
    .select('ss.completed_at as completed_time');
  const { annualPrepayCoversVisit } = require('./annual-prepay-renewals');
  const at = (row) => new Date(row.completed_time).getTime();
  for (const row of completed) {
    const root = String(seriesRootId(row));
    if (!sinceByRoot.has(root) || !(at(row) >= sinceByRoot.get(root))) continue;
    if (found.has(root) && at(found.get(root)) >= at(row)) continue;
    if (!isUnpricedSeriesVisit(row) || authoritativeZeroPrice(row)) continue;
    if (row.prepaid_method === ANNUAL_PREPAY_METHOD && await annualPrepayCoversVisit(row, db)) continue;
    found.set(root, row);
  }
  return found;
}

// Under episodes an authoritative $0 is a price: billing-lane's
// hasAuthoritativeZeroPrice (GATE_STAMPED_ZERO_FREE) on the visit's own stamp,
// or, for a child that inherits its parent's price (isUnpricedSeriesVisit's
// own rule), on the parent's.
function authoritativeZeroPrice(row) {
  const { hasAuthoritativeZeroPrice } = require('./billing-lane');
  if (hasAuthoritativeZeroPrice(row.estimated_price, row.primary_line_price)) return true;
  const inheritsFromParent = !!row.recurring_parent_id && row.is_recurring !== false;
  return inheritsFromParent && hasAuthoritativeZeroPrice(row.parent_estimated_price, row.parent_primary_line_price);
}

// The one alert for each unpriced series, from everything this run knows
// about it. A series pages a NEW bell only for an upcoming visit (the class is
// upcoming-only). Under episodes a held series (a visit past due, or one that
// completed unpriced since its bell first rang) is live too, so the close pass
// keeps its bell and a bell auto-cleared meanwhile reopens and rings; it only
// keeps or reopens a bell it already has, never starts one, so nothing new
// rings on deploy. The copy leads with the most urgent fact (a visit that
// completed without a price, then one past due, then the next visit) and names
// the others, so a quiet refresh never swaps a completed visit's warning for a
// forward-looking one; an upcoming-only series keeps its original copy.
// Most urgent first, so the per-run cap spends itself where money is already
// at stake.
// A held series' copy and state, most urgent first.
const HELD_SERIES = {
  completed: { word: 'completed', state: 'completed_unpriced', action: 'Price the series or bill that visit by hand.' },
  overdue: { word: 'past due', state: 'overdue_unpriced', action: 'Price the series before it closes at $0.' },
};

function unpricedSeriesAlerts({ upcomingByRoot, overdueByRoot, completedByRoot, bellSince, episodes, now }) {
  // Killed, overdue and completed are empty: exactly the pre-episode alerts.
  const roots = [...upcomingByRoot.keys()];
  for (const root of [...completedByRoot.keys(), ...overdueByRoot.keys()]) {
    if (bellSince.has(root) && !roots.includes(root)) roots.push(root);
  }
  const urgency = (root) => (completedByRoot.has(root) ? 0 : overdueByRoot.has(root) ? 1 : 2);
  roots.sort((a, b) => urgency(a) - urgency(b));
  // Under episodes a standing bell's text follows the series through a quiet
  // refresh that never re-rings it, so a person's read stands; a reopen still
  // rings (raiseAdminAlertWithReopen).
  const quiet = episodes ? { refreshOnDedupe: true, ringOnRefresh: () => false } : {};
  return roots.map((root) => {
    const up = upcomingByRoot.get(root);
    const done = completedByRoot.get(root);
    const late = overdueByRoot.get(root);
    const held = done ? HELD_SERIES.completed : late ? HELD_SERIES.overdue : null;
    const lead = done || late || up;
    const type = lead.service_type || 'service';
    const facts = [done && `the ${done.service_date} visit completed without a price`,
      late && `the ${late.service_date} visit is past due`, up && `next visit ${up.service_date}`].filter(Boolean).join('; ');
    const [title, body] = held
      ? [`Recurring ${type} has no price — ${lead.service_date} visit ${held.word}`, `${facts[0].toUpperCase()}${facts.slice(1)}. ${held.action}`]
      : [`Recurring ${type} has no price — next visit ${up.service_date}`,
        `The recurring ${type} series has no price on any row (parent or child). ` +
        `Its next visit is ${up.service_date}; it will complete and invoice at $0 unless the series is priced first.`];
    return [
      `${UNPRICED_PREFIX}${root}`,
      title,
      body,
      { scheduled_service_id: lead.id, series_root_id: root, customer_id: lead.customer_id || null,
        ...(up ? { next_visit_date: up.service_date } : {}),
        // Under episodes only: the watch's start and the held state. The start
        // is the bell's own when it has one (every raise writes it back, so it
        // never moves forward: a reopen cannot drop a visit that completed
        // between the first scan and the first insert), else this run's time,
        // taken BEFORE the scan read.
        ...(episodes ? {
          episode_started_at: new Date(Math.min(bellSince.get(root) ?? Infinity, now.getTime())).toISOString(),
          ...(held ? { held: held.state, visit_date: lead.service_date } : {}),
        } : {}) },
      quiet,
    ];
  });
}

// Prepay: key = prepay-coverage:<visit>:<issue>:<evidence hash>.
const prepayVisitOf = (key) => key.split(':')[1];
// The visit and the issue: the evidence hash is what a replacement changes.
const prepaySubjectOf = (key) => key.split(':').slice(1, 3).join(':');

// Why an absent prepay key's bell closes, or null to leave it up.
function prepayCloseReason(key, { statusById, dayById, replacedSubjects, undeliveredSubjects, horizonDay }) {
  const id = prepayVisitOf(key);
  if (!statusById.has(id)) return 'visit did not run';
  const status = statusById.get(id);
  // Completion is when the prepay billing mistake happens, and the scan
  // drops completed visits: a completed or rescheduled visit's review is a
  // person's to clear, never this pass's, gap or not.
  if (PREPAY_HOLD_OPEN_STATUSES.includes(status)) return null;
  if (NEVER_RAN_STATUSES.includes(status)) return 'visit did not run';
  // The SAME issue still has a live key: superseded by a new evidence key
  // rather than resolved — closed only once every live key for that visit
  // and issue was delivered this run. One the cap held back has no bell
  // yet, so the old warning stays until it does. Matched per issue: a visit
  // can carry several prepay issues at once, and delivering one must not
  // clear another's old warning.
  const subject = prepaySubjectOf(key);
  if (replacedSubjects.has(subject)) return undeliveredSubjects.has(subject) ? null : 'superseded';
  // Out of the scan by date, not fixed: it re-rings once back in the window.
  if (horizonDay && dayById.get(id) > horizonDay) return 'moved past the look-ahead window';
  return 'gap resolved';
}

async function closePrepayAlerts({ absentOf, close, liveKeys, deliveredKeys, horizonDay }) {
  const prepayAbsent = await absentOf(PREPAY_PREFIX);
  if (!prepayAbsent.length) return 0;
  const visitIds = [...new Set(prepayAbsent.map(prepayVisitOf).filter((id) => UUID_RE.test(id || '')))];
  const statusRows = visitIds.length
    ? await db('scheduled_services').whereIn('id', visitIds)
      .select('id', 'status', db.raw("to_char(scheduled_date, 'YYYY-MM-DD') as service_date")) : [];
  const livePrepay = [...liveKeys].filter((k) => k.startsWith(PREPAY_PREFIX));
  const context = {
    statusById: new Map(statusRows.map((r) => [String(r.id), r.status])),
    dayById: new Map(statusRows.map((r) => [String(r.id), r.service_date])),
    replacedSubjects: new Set(livePrepay.map(prepaySubjectOf)),
    undeliveredSubjects: new Set(livePrepay.filter((k) => !deliveredKeys.has(k)).map(prepaySubjectOf)),
    horizonDay,
  };
  const byReason = {};
  for (const key of prepayAbsent) {
    const reason = prepayCloseReason(key, context);
    if (reason) (byReason[reason] ||= []).push(key);
  }
  let closed = 0;
  for (const [reason, keys] of Object.entries(byReason)) closed += await close(keys, reason);
  return closed;
}

// Lawn-email gap: key = lawn-email-gap:<customer>:<fixable>[:<visit>]. A changed
// fixable set or trigger visit mints a NEW key, so an absent key whose customer
// still has a live one was superseded — closed only once that customer's live
// keys were all delivered this run; a replacement the cap held back has no
// bell yet, and the old one stays. No live key for the customer: gap resolved.
const lawnCustomerOf = (key) => key.split(':')[1];
async function closeLawnAlerts({ absentOf, close, liveKeys, deliveredKeys }) {
  const absent = await absentOf(LAWN_GAP_PREFIX);
  const liveCustomers = new Set([...liveKeys].filter((k) => k.startsWith(LAWN_GAP_PREFIX)).map(lawnCustomerOf));
  const undelivered = new Set([...liveKeys]
    .filter((k) => k.startsWith(LAWN_GAP_PREFIX) && !deliveredKeys.has(k)).map(lawnCustomerOf));
  const superseded = [];
  const resolved = [];
  for (const key of absent) {
    const customer = lawnCustomerOf(key);
    if (!liveCustomers.has(customer)) resolved.push(key);
    else if (!undelivered.has(customer)) superseded.push(key);
  }
  return (await close(superseded, 'superseded')) + (await close(resolved, 'gap resolved'));
}

// Episodes close pass: per class, open bells (by prefix) minus the live keys
// are the absent ones — their problem is fixed (or, for prepay, the visit is
// moot). Read-only against scheduled_services: it reads a visit's status and
// writes nothing but admin notifications. A problem that returns after this
// scan is re-raised, and re-rung, by the next run.
async function closeResolvedAlerts({ now, liveKeys, deliveredKeys, horizonDay, skipPrefixes }) {
  const absentOf = async (prefix) => {
    if (skipPrefixes.includes(prefix)) return [];
    return (await alertEpisodes.openAdminAlertKeys(db, prefix)).filter((key) => !liveKeys.has(key));
  };
  const close = async (keys, reason) => (keys.length
    ? Number(await alertEpisodes.closeAdminAlertKeys(db, keys, reason, { now, resolution: reason.charAt(0).toUpperCase() + reason.slice(1) })) || 0
    : 0);
  let closed = 0;

  // Priced, done, cancelled, or moved past the look-ahead window: a visit
  // that comes back into the window unpriced re-rings. A series still
  // unpriced by an overdue or completed visit is live (unpricedSeriesAlerts),
  // so it is never absent here.
  closed += await close(await absentOf(UNPRICED_PREFIX), 'no longer unpriced in the look-ahead window');
  closed += await closeLawnAlerts({ absentOf, close, liveKeys, deliveredKeys });
  closed += await close(await absentOf(ACCEPTED_PREFIX), 'gap resolved');
  closed += await closePrepayAlerts({ absentOf, close, liveKeys, deliveredKeys, horizonDay });
  // Cleaned up, or the customer came back (reactivated / merged away).
  closed += await close(await absentOf(CHURNED_PREFIX), 'no live work left');
  return closed;
}

module.exports = {
  manualSeriesStampIssue,
  runScheduleIntegrityWatchdog,
  runInner,
  rowHasPrice,
  isUnpricedSeriesVisit,
  hasOutOfBandPrepaidStamp,
  hasAnnualPrepaidStamp,
  seriesRootId,
  _unpricedSeriesBells: unpricedSeriesBells,
  _completedUnpricedSince: completedUnpricedSince,
  _unpricedSeriesAlerts: unpricedSeriesAlerts,
  _closeResolvedAlerts: closeResolvedAlerts,
  _findChurnedLiveWork: findChurnedLiveWork,
  UPCOMING_WINDOW_DAYS,
  MAX_ALERTS_PER_RUN,
};
