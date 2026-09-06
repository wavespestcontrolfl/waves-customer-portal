/**
 * Schedule-integrity watchdog.
 *
 * Why this exists: on 2026-08-04 a Tree & Shrub recurring series was found
 * live with NO price on any row (parent or children) and its first visit
 * stuck in on_site since 7/21 — never completed, never billed, invisible to
 * every dashboard metric (completion never fired, so no service_records row,
 * no invoice, no report, no post-service SMS). A prod sweep found 89
 * past-dated visits parked in on_site/en_route the same way. Nothing in the
 * portal surfaces either state; both classes silently cost money.
 *
 * Exception classes, one pager:
 *  1. STALE IN-PROGRESS — a visit whose scheduled_date is before today (ET)
 *     still sitting in on_site/en_route. The tech went out; the completion
 *     never happened in the system.
 *  2. UNPRICED RECURRING SERIES — an upcoming recurring visit (within
 *     UPCOMING_WINDOW_DAYS) where neither the row nor its recurring parent
 *     carries a price (estimated_price / primary_line_price). Children
 *     legitimately ride with NULL price and inherit from their parent at
 *     invoice time, so only a series with no price ANYWHERE pages. One bell
 *     per series (root id), not per visit.
 *  3. LAWN-EMAIL AUDIENCE GAP — a customer with live recurring-lawn
 *     evidence who cannot receive the Monday irrigation email (no email /
 *     no coordinates / lead-stage / inactive). The email's audience is
 *     computed at send time via the same predicate this check reuses, so
 *     adds and drops are automatic — only prerequisite failures page.
 *  4. ACCEPTED PLAN GAPS — missing recurrence, applications or matching
 *     cadence/property evidence, starting from the accepted estimate.
 *  5. PREPAY COVERAGE GAPS — annual stamps the completion validator cannot
 *     verify, or an unstamped child present during a recorded series payment.
 *
 * Alerting mirrors call-booking-miss-watchdog: one bell per subject, deduped
 * forever via the notifications metadata dedupeKey, with a per-run cap so
 * the first enable over the existing backlog rings loudly but readably —
 * dedupe keys make the remainder ring on subsequent ticks. Dark by default
 * behind GATE_SCHEDULE_INTEGRITY_WATCHDOG. Read-only against
 * scheduled_services; writes nothing but admin notifications.
 */

const db = require('../models/db');
const { createHash } = require('node:crypto');
const logger = require('./logger');
const NotificationService = require('./notification-service');
const { etDateString } = require('../utils/datetime-et');

// Upcoming look-ahead for the unpriced-series class. Two weeks: far enough
// out that Adam can price the series before the visit day, small enough that
// long-tail future visits (a bimonthly series stretches 10 months out)
// don't page months early.
const UPCOMING_WINDOW_DAYS = 14;
// A first enable scans the whole backlog (89 stale visits on 2026-08-04);
// cap the bells per run so it drains over ticks instead of flooding.
const MAX_ALERTS_PER_RUN = 10;

const STALE_STATUSES = ['on_site', 'en_route'];

function toMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// A row is priced if it carries either price field itself.
function rowHasPrice(row) {
  return toMoney(row?.estimated_price) != null || toMoney(row?.primary_line_price) != null;
}

// Stale = past its ET service date and still in an in-progress status.
// scheduled_date is a DATE column rendered via to_char in SQL — no JS Date
// round-trip across the UTC boundary (pg's default parser lands DATE at
// machine-local midnight, which is the PREVIOUS ET day on a UTC host).
function isStaleInProgress(row, todayET) {
  if (!row || !STALE_STATUSES.includes(row.status)) return false;
  const d = String(row.service_date || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && d < todayET;
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

function hasOutOfBandPrepaidStamp(row) {
  return toMoney(row?.prepaid_amount) != null
    && row?.prepaid_method !== ANNUAL_PREPAY_METHOD;
}

function hasAnnualPrepaidStamp(row) {
  return toMoney(row?.prepaid_amount) != null
    && row?.prepaid_method === ANNUAL_PREPAY_METHOD;
}

function hasMissingManualSeriesStamp(row) {
  // Extensions made AFTER the payment are not assumed covered. The manual
  // series writer only allocates over the visits present when it runs.
  return !!row?.recurring_parent_id && row.is_recurring === true
    && row.parent_series_payment_evidence === true
    && Number(row.parent_prepaid_amount) > 0
    && row.parent_prepaid_method !== ANNUAL_PREPAY_METHOD
    && !(Number(row.prepaid_amount) > 0)
    && row.parent_prepaid_at != null && row.created_at != null
    && new Date(row.created_at).getTime() <= new Date(row.parent_prepaid_at).getTime();
}

function isUnpricedSeriesVisit(row) {
  if (!row) return false;
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

// Forever-dedupe on the notifications metadata dedupeKey — same contract as
// call-ingest-watchdog / call-booking-miss-watchdog.
async function alreadyAlerted(dedupeKey) {
  const existing = await db('notifications')
    .where({ recipient_type: 'admin' })
    .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey])
    .first();
  return !!existing;
}

async function runScheduleIntegrityWatchdog({ now = new Date() } = {}) {
  const { isEnabled } = require('../config/feature-gates');
  if (!isEnabled('scheduleIntegrityWatchdog')) {
    return { skipped: true, reason: 'gated_off' };
  }
  // alreadyAlerted() is a read-then-notify with no unique constraint —
  // serialize ticks so deploy overlap can't double-ring.
  const { runExclusive } = require('../utils/cron-lock');
  return runExclusive('schedule-integrity-watchdog', () => runInner({ now }));
}

async function runInner({ now = new Date() } = {}) {
  const todayET = etDateString(now);

  // Class 1 — stale in-progress visits. The status filter narrows to the
  // two in-progress states; the ET date guard re-checks in JS so a row
  // scheduled today never pages mid-visit.
  const staleRows = await db('scheduled_services')
    .whereIn('status', STALE_STATUSES)
    .where('scheduled_date', '<', todayET)
    .select(
      'id', 'customer_id', 'status', 'service_type',
      db.raw("to_char(scheduled_date, 'YYYY-MM-DD') as service_date"),
    )
    .orderBy('scheduled_date', 'asc');
  const stale = staleRows.filter((r) => isStaleInProgress(r, todayET));

  // Class 2 — unpriced recurring series with a visit inside the window.
  // Exclude every status that will never bill (rescheduled rows are
  // phantom/non-working appointments; skipped and no_show never complete) —
  // only pending/confirmed/en_route/on_site visits are headed for an invoice.
  const horizon = new Date(now.getTime() + UPCOMING_WINDOW_DAYS * 24 * 3600 * 1000);
  const upcomingRows = await db('scheduled_services as ss')
    .leftJoin('scheduled_services as parent', 'parent.id', 'ss.recurring_parent_id')
    .leftJoin('annual_prepay_terms as prepay_term', 'prepay_term.id', 'ss.annual_prepay_term_id')
    .leftJoin('invoices as prepay_invoice', 'prepay_invoice.id', 'prepay_term.prepay_invoice_id')
    .whereNotIn('ss.status', ['cancelled', 'completed', 'rescheduled', 'skipped', 'no_show'])
    .where('ss.scheduled_date', '>=', todayET)
    .where('ss.scheduled_date', '<=', etDateString(horizon))
    .where(function whereRecurring() {
      this.where('ss.is_recurring', true).orWhereNotNull('ss.recurring_parent_id')
        .orWhere('ss.prepaid_method', ANNUAL_PREPAY_METHOD);
    })
    .select(
      'ss.id', 'ss.customer_id', 'ss.status', 'ss.service_type', 'ss.is_recurring',
      'ss.estimated_price', 'ss.primary_line_price', 'ss.prepaid_amount',
      'ss.prepaid_method', 'ss.annual_prepay_term_id', 'ss.recurring_parent_id',
      'ss.created_at', 'ss.updated_at',
      'parent.estimated_price as parent_estimated_price',
      'parent.primary_line_price as parent_primary_line_price',
      'parent.prepaid_amount as parent_prepaid_amount',
      'parent.prepaid_method as parent_prepaid_method',
      'parent.prepaid_at as parent_prepaid_at',
      'parent.updated_at as parent_updated_at',
      // Fingerprints only: coverage authority remains annualPrepayCoversVisit.
      // Include funding revisions so a repaired term can alert again after
      // a later refund/void even when best-effort visit cleanup did not run.
      db.raw(`jsonb_build_array(prepay_term.id, prepay_term.customer_id, prepay_term.status,
        prepay_term.coverage_service_type, prepay_term.renewal_decision,
        prepay_term.updated_at) as prepay_term_evidence`),
      db.raw(`jsonb_build_array(prepay_invoice.id, prepay_invoice.status,
        prepay_invoice.paid_at, prepay_invoice.updated_at) as prepay_invoice_evidence`),
      db.raw(`(SELECT jsonb_agg(jsonb_build_array(p.id, p.status, p.refund_status,
          p.updated_at) ORDER BY p.id)
        FROM payments p
        WHERE (p.stripe_payment_intent_id IS NOT NULL
          AND p.stripe_payment_intent_id = prepay_invoice.stripe_payment_intent_id)
          OR (p.stripe_charge_id IS NOT NULL AND p.stripe_charge_id = prepay_invoice.stripe_charge_id)
      ) as prepay_payment_evidence`),
      // Parent-only payment is a legitimate single-visit action. A sibling
      // sharing the writer's exact prepaid_at stamp establishes series scope.
      db.raw(`EXISTS (SELECT 1 FROM scheduled_services paid_sibling
        WHERE paid_sibling.recurring_parent_id = parent.id
          AND paid_sibling.customer_id = ss.customer_id
          AND paid_sibling.prepaid_at = parent.prepaid_at
          AND paid_sibling.prepaid_method IS NOT DISTINCT FROM parent.prepaid_method
          AND paid_sibling.prepaid_amount > 0) as parent_series_payment_evidence`),
      db.raw("to_char(ss.scheduled_date, 'YYYY-MM-DD') as service_date"),
    )
    .orderBy('ss.scheduled_date', 'asc');
  const unpricedByRoot = new Map();
  const prepayGaps = [];
  // Same validator the completion-billing gate uses (fail-closed): an
  // annual-prepay stamp suppresses only when its linked term is live,
  // customer-matched, and coverage-service-matched. Lazy require mirrors the
  // feature-gates pattern and keeps module load light.
  const { annualPrepayCoversVisit } = require('./annual-prepay-renewals');
  for (const row of upcomingRows) {
    const annualStamp = row.prepaid_method === ANNUAL_PREPAY_METHOD;
    const annualCovered = annualStamp && await annualPrepayCoversVisit(row, db);
    if (annualStamp && !annualCovered) prepayGaps.push({ row, issue: 'annual_coverage_unverified' });
    if (hasMissingManualSeriesStamp(row)) prepayGaps.push({ row, issue: 'manual_series_stamp_missing' });
    if (!isUnpricedSeriesVisit(row)) continue;
    if (annualCovered) continue;
    const root = seriesRootId(row);
    if (!unpricedByRoot.has(root)) unpricedByRoot.set(root, row);
  }

  let alerted = 0;
  const capped = () => {
    if (alerted < MAX_ALERTS_PER_RUN) return false;
    logger.warn(`[schedule-integrity] per-run alert cap hit (${MAX_ALERTS_PER_RUN}); the rest ring next tick`);
    return true;
  };
  const ring = async (dedupeKey, title, body, metadata, { link = '/admin/dispatch' } = {}) => {
    if (await alreadyAlerted(dedupeKey)) return false;
    // bell: true — under GATE_ADMIN_BELL_POLICY the 'alert' category is
    // silenced-by-default (OVERRIDABLE_CATEGORIES), so without the explicit
    // site-level tag these money-loss pages would return a suppressed
    // sentinel instead of ringing.
    const created = await NotificationService.notifyAdmin('alert', title, body, {
      link,
      bell: true,
      metadata: { dedupeKey, ...metadata },
    });
    // NotificationService.create swallows insert errors into a null result;
    // this job's ONLY output is the bell, so a lost bell must fail the run
    // loudly instead of logging success. Internal-test suppression
    // ({ suppressed: true }) is a deliberate success-without-a-row.
    if (!created || (created.id == null && !created.suppressed)) {
      throw new Error(`[schedule-integrity] notification insert failed for ${dedupeKey} — pager output lost`);
    }
    alerted += 1;
    return true;
  };

  // Unpriced series ring FIRST: they are same-day money loss (a visit can
  // complete and invoice at $0 today), while the stale backlog is historic
  // and safely drains across ticks. On first enable the 89-row stale backlog
  // would otherwise consume the whole per-run cap for days and starve these.
  const alerts = Array.from(unpricedByRoot, ([root, v]) => {
    const d = v.service_date;
    return [
      `unpriced-series:${root}`,
      `Recurring ${v.service_type || 'service'} has no price — next visit ${d}`,
      `The recurring ${v.service_type || 'service'} series has no price on any row (parent or child). ` +
      `Its next visit is ${d}; it will complete and invoice at $0 unless the series is priced first.`,
      { scheduled_service_id: v.id, series_root_id: root, customer_id: v.customer_id || null, next_visit_date: d },
    ];
  });

  alerts.push(...prepayGaps.map(({ row, issue }) => {
    const evidenceKey = createHash('sha256').update(JSON.stringify([
      row.updated_at, row.service_type, row.prepaid_amount, row.prepaid_method, row.annual_prepay_term_id,
      row.parent_prepaid_amount, row.parent_prepaid_method, row.parent_prepaid_at, row.parent_updated_at,
      row.prepay_term_evidence, row.prepay_invoice_evidence, row.prepay_payment_evidence,
    ])).digest('hex').slice(0, 20);
    return [
      `prepay-coverage:${row.id}:${issue}:${evidenceKey}`,
      `Prepaid coverage needs review before ${row.service_date}`,
      issue === 'annual_coverage_unverified'
        ? 'This visit carries an annual-prepay stamp that the completion coverage check cannot validate. Reconcile the payment, term and covered service before billing; a stamp alone does not prove payment.'
        : 'This recurring child existed when its parent and siblings received the same manual series-payment stamp, but has no payment allocation. Reconcile the recorded payment and intended covered visits before billing.',
      { scheduled_service_id: row.id, customer_id: row.customer_id, issue },
    ];
  }));

  let acceptedGaps = [];
  let acceptedScheduleCheckFailed = false;
  try {
    acceptedGaps = await require('./recurring-schedule-audit').findAcceptedRecurringScheduleGaps({ now });
  } catch (err) {
    acceptedScheduleCheckFailed = true;
    logger.error(`[schedule-integrity] accepted-plan check failed: ${err.message}`);
  }
  alerts.push(...acceptedGaps.map((gap) => [
      `accepted-schedule:${gap.estimateId}:${gap.serviceFamily}:${gap.evidenceKey}`,
      'Accepted recurring plan needs schedule review',
      `The accepted ${gap.serviceFamily.replace(/_/g, ' ')} plan calls for ${gap.pattern.replace(/_/g, ' ')} service (${gap.expectedVisits} applications). ` +
        `The linked schedule has ${gap.recordedVisits} working/completed applications. Review: ${gap.issues.map((issue) => issue.replace(/_/g, ' ')).join('; ')}. ` +
        'Check any later amendment or cancellation before changing appointments or prices.',
      { estimate_id: gap.estimateId, customer_id: gap.customerId, issues: gap.issues,
        expected_pattern: gap.pattern, expected_visits: gap.expectedVisits, appointment_ids: gap.appointmentIds },
      { link: `/admin/customers?customerId=${encodeURIComponent(gap.customerId)}` },
  ]));

  // Class 3 — recurring-lawn customers invisible to the Monday irrigation
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
      // (codex #3341 r3 P2): alreadyAlerted has no expiry, so a customer
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

  alerts.push(...stale.map((v) => {
    const d = v.service_date;
    return [
      `stale-visit:${v.id}`,
      `Visit stuck ${v.status} since ${d} — never completed`,
      `${v.service_type || 'A visit'} on ${d} is still "${v.status}". If it was performed, complete it so the ` +
      'service record, invoice, and report fire; if it never happened, cancel it from admin dispatch ' +
      '(admin path — not the customer app).',
      { scheduled_service_id: v.id, customer_id: v.customer_id || null, stale_status: v.status, service_date: d },
    ];
  }));

  for (const alert of alerts) {
    if (capped()) break;
    await ring(...alert);
  }

  return {
    skipped: false,
    todayET,
    stale: stale.length,
    unpricedSeries: unpricedByRoot.size,
    lawnEmailGaps: lawnGaps.length,
    lawnGapCheckFailed,
    acceptedScheduleGaps: acceptedGaps.length,
    acceptedScheduleCheckFailed,
    prepayCoverageGaps: prepayGaps.length,
    alerted,
  };
}

module.exports = {
  hasMissingManualSeriesStamp,
  runScheduleIntegrityWatchdog,
  runInner,
  rowHasPrice,
  isStaleInProgress,
  isUnpricedSeriesVisit,
  hasOutOfBandPrepaidStamp,
  hasAnnualPrepaidStamp,
  seriesRootId,
  UPCOMING_WINDOW_DAYS,
  MAX_ALERTS_PER_RUN,
  STALE_STATUSES,
};
