/**
 * Billing Recovery workbench — /api/admin/billing-recovery
 *
 * Surfaces completed visits that were never invoiced (the silent leak: priced,
 * non-autopay, per-visit-billed customers whose completion missed the invoice
 * gate at admin-dispatch.js) and lets an operator either cut a draft invoice
 * ("bill it") or record the visit as an intentionally-free no-cost type.
 *
 * Hard rule (autopay double-bill guard): autopay visits hold NO per-visit price
 * and are billed separately by billing-cron off customers.monthly_rate. Putting
 * an invoice on an autopay-covered visit double-charges the customer. "Active
 * autopay" is the canonical customerOnAutopay() definition — a default Stripe
 * `payment_methods` row, NOT the (often null/stale) customers.autopay_payment_method_id
 * pointer. The leak query excludes those customers via a payment_methods EXISTS
 * check, AND POST /bill re-verifies with customerOnAutopay() before creating any
 * invoice. The client is never trusted.
 *
 * No-cost allowlist (Adam-locked 2026-06-19) — never surfaced as a leak:
 *   autopay-active · prepaid · is_callback (warranty/re-treat) · appointment
 *   (general_appointment "Waves Pest Control Appointment Service") · inspection
 *   (waived) · re-service · estimate visit · rodent trapping / in-window trap
 *   checks · follow-up re-visits.
 *
 * This route never auto-bills. Every invoice is an explicit operator click.
 */
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { adminAuthenticate, requireAdmin, requireTechOrAdmin } = require('../middleware/admin-auth');
const { autopayActivePredicate } = require('../services/autopay-eligibility');
const { listAtRiskMrrAccounts } = require('../services/mrr-breakdown');
const { shortenOrPassthrough, invoiceShortCodePrefix } = require('../services/short-url');
const { publicPortalUrl } = require('../utils/portal-url');
const {
  ALWAYS_FREE_SERVICE_TYPE_SQL_REGEX, CONSULTATION_SERVICE_TYPE_SQL_REGEX, isConsultationServiceType,
} = require('../services/no-cost-visit-types');
// GATE_STAMPED_ZERO_FREE (owner ruling 2026-09-28): read at call time through
// billing-lane's one resolver (lazy, so no require cycle).
const stampedZeroFreeLive = () => require('../services/billing-lane').stampedZeroFreeLive();
const {
  executeDashboardTool,
  INTERNAL_TEST_CUSTOMERS,
} = require('../services/intelligence-bar/dashboard-tools');

router.use(adminAuthenticate, requireAdmin);

// Reuse the SAME advisory lock the scheduled-service invoice-mint path uses
// (services/scheduled-invoice-mint) so a recovery Bill serializes not just
// against another recovery Bill/dismiss but against Charge-now / completion
// mints too. invoices.scheduled_service_id is NOT unique, so a private
// namespace would let a recovery Bill and a concurrent mint both create
// duplicate drafts. Imported, never re-declared (codex #3344 r8).
const { acquireScheduledInvoiceMintLock, assertScheduledInvoiceNotPacketOwned } = require('../services/scheduled-invoice-mint');
const {
  billVisit, dueDateFromVisit, siblingCoverageStatus, INVOICE_BACKED_DISPOSITIONS, deadInvoiceStatuses, claimDispositionSlot,
  loadBillingMode,
} = require('../services/billing-recovery-bill');

// Service-type patterns that are intentionally $0 and must never be flagged as a
// leak or auto-billed. Matched case-insensitively against scheduled_services.service_type.
// Always-free service types — excluded from the leak queue entirely and rejected
// on the write path. Shared with the completion auto-invoice gate (admin-dispatch)
// via no-cost-visit-types so the two paths can't drift: the SQL regex below is
// the word-boundary form of the same patterns isAlwaysFreeServiceType uses.

// Ambiguous types that CAN be paid (paid WDO/inspection, rodent trapping setup)
// OR free (waived inspection, in-window trap check). Surface these in needs-review
// for a human call rather than suppressing real paid-visit leaks.
const REVIEW_PATTERNS = ['%inspection%', '%trap%', '%rodent%'];

const matchesPatterns = (serviceType, patterns) => {
  const s = String(serviceType || '').toLowerCase();
  return patterns.some((p) => s.includes(p.replace(/%/g, '')));
};
const isReviewServiceType = (serviceType) => matchesPatterns(serviceType, REVIEW_PATTERNS);

// Packet invoices keep ownership after reversal; only ordinary void invoices
// may re-enter this legacy single-service mint queue.
// Aliases: `sr` = service_records, `ss` = scheduled_services.
const HAS_INVOICE_SQL = `(EXISTS (
  SELECT 1 FROM invoices i
  WHERE (i.service_record_id = sr.id OR i.scheduled_service_id = ss.id)
    AND COALESCE(i.status, '') <> 'void'
) OR EXISTS (
  SELECT 1 FROM visit_completion_packet_items pi
  JOIN visit_completion_packets p ON p.id = pi.packet_id
  WHERE p.visit_id = ss.visit_id AND pi.scheduled_service_id = ss.id
    AND pi.service_record_id = sr.id
))`;

const INTERNAL_NAME_SQL = "LOWER(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,''))";

function clampDays(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return 90;
  return Math.min(365, Math.max(1, n));
}

// Effective price mirrors the leak query + the bill route: row price →
// per-application fee (never monthly_rate; never for a consultation).
function effectivePrice(r) {
  const rowPrice = parseFloat(r.estimated_price || 0);
  if (rowPrice > 0) return rowPrice;
  return r.billing_mode === 'per_application' && !isConsultationServiceType(r.service_type)
    ? parseFloat(r.per_application_fee || 0) : 0;
}

// Shared base query for uninvoiced completed visits, with the full no-cost
// allowlist applied. Returns visits with an effective price: the row's
// estimated_price, or — when the billing_mode column exists (perAppAware) —
// the customer-level per_application_fee for per-application customers,
// whose follow-up rows seed estimated_price NULL by design (Codex round-12;
// same row-price → fee precedence as completion and the bill route, never
// monthly_rate). All req-derived values are bound, never interpolated.
function uninvoicedLeakQuery(days, { perAppAware = false, selfPayAware = false } = {}) {
  const autopay = autopayActivePredicate();
  // GATE_STAMPED_ZERO_FREE (owner ruling 2026-09-28): the NULLIF below turns
  // a STAMPED 0 into NULL so it falls to the per-application fee — exactly
  // the "$0 means charge nothing" violation the gate exists to close. Under
  // the gate, drop the NULLIF: a stamped 0 stays 0, so it fails the
  // `effectivePriceSql > 0` filter below and never surfaces as a leak or a
  // fee at all. A genuinely blank row (NULL) is unaffected either way —
  // COALESCE still falls to the fee.
  const effectivePriceSql = perAppAware
    ? (stampedZeroFreeLive()
      ? "COALESCE(ss.estimated_price, CASE WHEN c.billing_mode = 'per_application' THEN c.per_application_fee END, 0)"
      : "COALESCE(NULLIF(ss.estimated_price, 0), CASE WHEN c.billing_mode = 'per_application' THEN c.per_application_fee END, 0)")
    : 'COALESCE(ss.estimated_price, 0)';
  // Effective payer mirrors resolveForInvoice: a per-job self-pay pin blocks
  // inheriting the customer default, so a pinned visit on a default-payer
  // account is genuinely self-pay and must surface here (selfPayAware is
  // column-guarded by the caller for pre-migration environments).
  const effectivePayerSql = selfPayAware
    ? 'COALESCE(ss.payer_id, CASE WHEN COALESCE(ss.self_pay_override, false) THEN NULL ELSE c.payer_id END)'
    : 'COALESCE(ss.payer_id, c.payer_id)';
  const q = db({ ss: 'scheduled_services' })
    .join({ c: 'customers' }, 'c.id', 'ss.customer_id')
    .leftJoin({ sr: 'service_records' }, 'sr.scheduled_service_id', 'ss.id')
    .leftJoin({ d: 'visit_billing_dispositions' }, 'd.scheduled_service_id', 'ss.id')
    .leftJoin({ di: 'invoices' }, 'di.id', 'd.invoice_id')
    .whereRaw("ss.completed_at >= now() - (? * interval '1 day')", [days])
    .whereRaw(`${effectivePriceSql} > 0`)
    // Not already dispositioned — except a 'billed' / 'billed_elsewhere' row
    // whose invoice is gone (void / refunded / cancelled): that settles
    // nothing, so the visit comes back (billing-recovery-bill.js).
    .where(function notSettledByDisposition() {
      this.whereNull('d.id').orWhere(function staleInvoiceDisposition() {
        this.whereIn('d.disposition', INVOICE_BACKED_DISPOSITIONS)
          .where(function deadInvoice() { this.whereNull('di.id').orWhereIn('di.status', deadInvoiceStatuses()); });
      });
    })
    // Completed record only (excludes office-handoff 'incomplete'), PLUS the
    // status-only leak: a scheduled_services row flipped to 'completed' with
    // NO service_records row at all (historical PUT /status completions —
    // now refused with USE_COMPLETION_FLOW). Those are real finished work
    // with nothing minted; they surface as leak_kind
    // 'completed_no_service_record' and stay un-billable here until the
    // completion flow mints the record (the bill route 422s without one).
    .whereRaw("(sr.status = 'completed' OR (sr.id IS NULL AND ss.status = 'completed'))")
    .whereRaw(`NOT ${HAS_INVOICE_SQL}`)                  // no existing invoice
    .whereRaw('COALESCE(ss.is_callback, false) = false') // not a callback (free re-treat)
    .whereRaw('COALESCE(sr.is_callback, false) = false')
    .whereRaw(`COALESCE(ss.prepaid_amount, 0) < ${effectivePriceSql}`) // not FULLY prepaid (partial surfaces in needs-review)
    .whereRaw(`${effectivePayerSql} IS NULL`) // self-pay only (v1); payer-billed = payer AP flow
    .whereRaw("COALESCE(ss.service_type, '') !~* ?", [ALWAYS_FREE_SERVICE_TYPE_SQL_REGEX])
    // A consultation (Waves Assessment) never takes the per-application fee
    // (no-cost-visit-types), so one surfaces only on its OWN row price —
    // the same result as dropping the fee arm from the effective price.
    .whereRaw("NOT (COALESCE(ss.service_type, '') ~* ? AND COALESCE(ss.estimated_price, 0) <= 0)", [CONSULTATION_SERVICE_TYPE_SQL_REGEX]);
  // Conservative v1 scope (owner priority: never risk double-billing an autopay
  // customer). The completion predicate only treats autopay as covering NO-price
  // visits, so an autopay customer's one-off explicitly-priced visit is
  // technically billable — surfacing those is a deliberate follow-up, kept out of
  // v1 to avoid any double-bill exposure. EXCEPTION (Codex round-12, mirrors the
  // bill route's round-7 exemption): per-application customers are on autopay BY
  // DESIGN — the saved card is HOW per-visit charges collect and the monthly cron
  // skips them — so their leaked visits are exactly what this workbench recovers
  // and must surface in the UI, not just be billable by direct POST. The
  // explicit per_visit/one_time lanes (billing lane build, 2026-07-17) join the
  // exemption for the same reason: the cron skips them too (GUARD 3b), so an
  // active saved method never means monthly coverage and their uninvoiced
  // completions are genuine leaks this workbench must surface (Codex r7).
  if (perAppAware) {
    q.whereRaw(`(NOT ${autopay.sql} OR c.billing_mode IN ('per_application', 'per_visit', 'one_time'))`, [autopay.binding]);
  } else {
    q.whereRaw(`NOT ${autopay.sql}`, [autopay.binding]); // exclude active-autopay customers
  }
  if (INTERNAL_TEST_CUSTOMERS.length) {
    q.whereNotIn(db.raw(INTERNAL_NAME_SQL), INTERNAL_TEST_CUSTOMERS);
  }
  return q;
}

/**
 * GET /api/admin/billing-recovery/leaks?days=90
 * Completed-but-uninvoiced visits split into one-click-billable leaks
 * (monthly_rate = 0, per-visit billed) and needs-review (monthly_rate > 0,
 * verify they aren't billed via the monthly cadence).
 */
router.get('/leaks', async (req, res) => {
  try {
    const days = clampDays(req.query.days);
    // Column-guarded per-app awareness — pre-migration environments keep the
    // exact legacy query shape.
    let perAppAware = false;
    try {
      perAppAware = await db.schema.hasColumn('customers', 'billing_mode');
    } catch { /* keep legacy */ }
    let selfPayAware = false;
    try {
      selfPayAware = await db.schema.hasColumn('scheduled_services', 'self_pay_override');
    } catch { /* keep legacy */ }
    const rows = await uninvoicedLeakQuery(days, { perAppAware, selfPayAware })
      .select(
        'ss.id as scheduled_service_id',
        'sr.id as service_record_id',
        'ss.service_type',
        'ss.estimated_price',
        'ss.prepaid_amount',
        'ss.prepaid_method',
        'ss.annual_prepay_term_id',
        'ss.scheduled_date',
        'ss.completed_at',
        // Sibling first-application coverage (siblingCoverageStatus).
        'ss.source_estimate_id',
        'ss.first_application_invoice_id',
        'ss.primary_line_price',
        'c.id as customer_id',
        'c.first_name',
        'c.last_name',
        'c.monthly_rate',
        'c.waveguard_tier',
        ...(perAppAware ? ['c.billing_mode', 'c.per_application_fee'] : []),
        // A voided invoice puts its visit back in this queue (HAS_INVOICE_SQL
        // skips void), and the void often had a replacement elsewhere (another
        // row, a combined or prepay invoice). Name it so the operator checks.
        db.raw(`(SELECT i.invoice_number FROM invoices i
          WHERE (i.service_record_id = sr.id OR i.scheduled_service_id = ss.id) AND i.status = 'void'
          ORDER BY i.updated_at DESC NULLS LAST, i.created_at DESC LIMIT 1) AS voided_invoice_number`),
        // Set only on a visit back from a stale disposition (filter above).
        'd.disposition as stale_disposition',
        'di.invoice_number as stale_disposition_invoice_number',
        'di.status as stale_disposition_invoice_status',
      )
      .orderBy('ss.completed_at', 'desc');

    // A discounted annual-prepay slice is intentionally < the undiscounted
    // estimated_price, so a LIVE-covered annual visit passes the "not fully
    // prepaid" filter and would otherwise surface here as a recovery candidate —
    // a manual double-bill trap. Drop live-covered visits using the SAME gate the
    // completion path uses (fail-closed; a stale stamp is NOT treated as covered).
    const AnnualPrepayRenewals = require('../services/annual-prepay-renewals');
    const coveredFlags = await Promise.all(
      rows.map((r) => AnnualPrepayRenewals.annualPrepayCoversVisit(r)),
    );
    const prepayActiveRows = rows.filter((_, i) => !coveredFlags[i]);
    // A visit billed on its trip's combined first-application invoice has no
    // invoice of its own, so the leak query lists it — and Bill refuses it
    // (billing-recovery-bill.js siblingCoverageRefusal). Drop only a
    // DEFINITIVE 'covered' verdict. A needs-review one (combined invoice
    // voided or refunded) or a lookup error stays listed — the money may
    // still be owed, and hiding it could read as handled; Bill refuses those
    // with the reason. Leak rows exclude callbacks by construction.
    const siblingStatuses = await Promise.all(
      prepayActiveRows.map((r) => siblingCoverageStatus(r, db, { trustRowStamp: true })),
    );
    const activeRows = prepayActiveRows.filter((_, i) => siblingStatuses[i] !== 'covered');

    const shape = (r) => ({
      scheduled_service_id: r.scheduled_service_id,
      service_record_id: r.service_record_id,
      customer_id: r.customer_id,
      customer: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
      service_type: r.service_type,
      price: effectivePrice(r),
      prepaid: parseFloat(r.prepaid_amount || 0),
      completed_at: r.completed_at,
      monthly_rate: parseFloat(r.monthly_rate || 0),
      waveguard_tier: r.waveguard_tier || null,
      billing_mode: r.billing_mode || null,
      billable: !!r.service_record_id, // cannot invoice without a service record
      // 'completed_no_service_record' = status-only completion; the
      // completion flow must run before Bill works.
      leak_kind: r.service_record_id ? 'uninvoiced' : 'completed_no_service_record',
      // Dispatch-day deep link target for status-only rows (date-only string).
      scheduled_date: dueDateFromVisit({ service_date: r.scheduled_date }) || null,
      voided_invoice_number: r.voided_invoice_number || null,
      // A visit an operator marked billed elsewhere whose covering invoice
      // has since died (void / refunded / cancelled).
      billed_elsewhere_invoice_number: r.stale_disposition === 'billed_elsewhere' ? (r.stale_disposition_invoice_number || null) : null,
      billed_elsewhere_invoice_status: r.stale_disposition === 'billed_elsewhere' ? (r.stale_disposition_invoice_status || null) : null,
    });

    // Recurring (monthly_rate>0), partially-prepaid, ambiguous-type
    // (inspection/rodent — could be paid or free), or per-application
    // (autopay-active by design — a human confirms completion billing really
    // did miss it before re-billing) visits need a human eye before billing —
    // they aren't safe one-click leaks.
    const isReview = (r) => parseFloat(r.monthly_rate || 0) > 0
      || parseFloat(r.prepaid_amount || 0) > 0
      || r.billing_mode === 'per_application'
      || isReviewServiceType(r.service_type);
    const leaks = activeRows.filter((r) => !isReview(r)).map(shape);
    const needsReview = activeRows.filter(isReview).map(shape);
    const sum = (arr) => Math.round(arr.reduce((s, r) => s + r.price, 0) * 100) / 100;

    res.json({
      window_days: days,
      summary: {
        leak_visits: leaks.length,
        leak_customers: new Set(leaks.map((r) => r.customer_id)).size,
        leak_dollars: sum(leaks),
        review_visits: needsReview.length,
        review_dollars: sum(needsReview),
      },
      leaks,
      needs_review: needsReview,
    });
  } catch (err) {
    logger.error(`[billing-recovery] leaks query failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to load uninvoiced visits' });
  }
});

/**
 * GET /api/admin/billing-recovery/aging?min_amount=0
 * AR aging for invoiced-but-unpaid invoices. Reuses the dashboard
 * get_outstanding_balances tool (ET-anchored 30/60/90 buckets) — single
 * source of truth so the numbers reconcile with the dashboard.
 */
router.get('/aging', async (req, res) => {
  try {
    const minAmount = Math.max(0, parseFloat(req.query.min_amount) || 0);
    const aging = await executeDashboardTool('get_outstanding_balances', { min_amount: minAmount });
    // The tool catches its own errors and returns { error } rather than throwing —
    // don't pass that through as a successful 200 (the client would read $0 AR).
    if (aging && aging.error) {
      logger.error(`[billing-recovery] aging tool error: ${aging.error}`);
      return res.status(502).json({ error: 'Failed to load AR aging' });
    }
    res.json(aging);
  } catch (err) {
    logger.error(`[billing-recovery] aging query failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to load AR aging' });
  }
});

/**
 * GET /api/admin/billing-recovery/at-risk-mrr
 * The recurring accounts behind the dashboard's "MRR at risk" action item,
 * with per-account causes (service paused / autopay paused / overdue /
 * prepay invoice unpaid). Same shared definition as the MRR tile
 * (services/mrr-breakdown.js), so this list, the tile split, and the Action
 * Inbox count always agree.
 */
router.get('/at-risk-mrr', async (req, res) => {
  try {
    const accounts = await listAtRiskMrrAccounts();
    res.json({
      accounts,
      count: accounts.length,
      atRisk: accounts.reduce((s, a) => s + a.monthlyRate, 0),
    });
  } catch (err) {
    logger.error(`[billing-recovery] at-risk-mrr query failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to load at-risk MRR accounts' });
  }
});

/**
 * POST /api/admin/billing-recovery/:scheduledServiceId/bill
 * Cut a DRAFT invoice for an uninvoiced completed visit (does NOT send it —
 * the operator sends from the Invoices surface). Server re-verifies the visit
 * is genuinely billable (not autopay-covered, not already invoiced/dispositioned)
 * before creating anything, and serializes concurrent clicks per visit.
 */
router.post('/:scheduledServiceId/bill', requireAdmin, async (req, res) => {
  const { scheduledServiceId } = req.params;
  try {
    // Checks + locked mint live in services/billing-recovery-bill.js, shared
    // with the Intelligence Bar closeout repair's bill_visit step.
    const result = await billVisit(scheduledServiceId, { actorId: req.technicianId });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    const { invoice } = result;

    let payUrl = null;
    if (invoice.token) {
      payUrl = await shortenOrPassthrough(`${publicPortalUrl()}/pay/${invoice.token}`, {
        kind: 'invoice',
        entityType: 'invoices',
        entityId: invoice.id,
        customerId: invoice.customer_id,
        codePrefix: invoiceShortCodePrefix(invoice),
      });
    }

    logger.info(`[billing-recovery] billed visit ${scheduledServiceId} -> invoice ${invoice.id} by tech ${req.technicianId}`);
    res.json({ ok: true, invoice: { id: invoice.id, total: invoice.total, status: invoice.status }, payUrl });
  } catch (err) {
    logger.error(`[billing-recovery] bill failed for ${scheduledServiceId}: ${err.message}`);
    res.status(500).json({ error: 'Failed to create invoice' });
  }
});

/**
 * POST /api/admin/billing-recovery/:scheduledServiceId/dismiss
 * Record a visit as an intentionally-free no-cost type. Creates NO invoice —
 * only removes the visit from the leak queue and logs the reason.
 */
router.post('/:scheduledServiceId/dismiss', requireAdmin, async (req, res) => {
  const { scheduledServiceId } = req.params;
  const reason = String(req.body.reason || '').trim().slice(0, 300) || null;
  try {
    // Same per-visit advisory lock as POST /bill so a dismiss can't race a bill
    // (no invoice can be cut for a visit being dismissed, and vice versa). All
    // eligibility is re-validated INSIDE the lock so a stale UI / direct request
    // can't permanently exclude a future, uncompleted, or already-invoiced visit.
    await db.transaction(async (trx) => {
      await acquireScheduledInvoiceMintLock(trx, scheduledServiceId);

      const visit = await trx({ ss: 'scheduled_services' })
        .leftJoin({ sr: 'service_records' }, 'sr.scheduled_service_id', 'ss.id')
        .where('ss.id', scheduledServiceId)
        .select('ss.id as scheduled_service_id', 'ss.completed_at', 'sr.id as service_record_id')
        .first();
      if (!visit) { const e = new Error('Visit not found'); e.status = 404; throw e; }
      if (!visit.completed_at) { const e = new Error('Visit is not completed — nothing to dismiss.'); e.status = 422; throw e; }

      const invoiced = await trx('invoices')
        .where(function () {
          this.where('scheduled_service_id', scheduledServiceId);
          if (visit.service_record_id) this.orWhere('service_record_id', visit.service_record_id);
        })
        .whereNot('status', 'void')
        .first();
      if (invoiced) { const e = new Error('Visit is already invoiced — cannot mark it free.'); e.status = 409; throw e; }

      const handled = await claimDispositionSlot(trx, scheduledServiceId);
      if (handled) { const e = new Error(handled); e.status = 409; throw e; }

      await trx('visit_billing_dispositions').insert({
        scheduled_service_id: scheduledServiceId,
        service_record_id: visit.service_record_id || null,
        disposition: 'intentionally_free',
        reason, // operator note stored in the DB column (not logged)
        actor_user_id: req.technicianId,
      });
    });

    // Do NOT log the free-text reason — it can contain customer PII. Log IDs only.
    logger.info(`[billing-recovery] dismissed visit ${scheduledServiceId} as intentionally_free (reason ${reason ? 'provided' : 'none'}) by tech ${req.technicianId}`);

    // Re-sync the visit's financials so this no-cost decision zeroes any revenue
    // a priced completion already wrote to service_records — otherwise the
    // Dashboard + /admin/revenue keep counting it. Fire-and-forget (the
    // disposition is already committed); recomputeRevenue makes calculateJobCost
    // read the disposition we just stored and force revenue 0.
    try {
      const { calculateJobCost } = require('../services/job-costing');
      void calculateJobCost(scheduledServiceId, undefined, { recomputeRevenue: true })
        .catch((e) => logger.error(`[billing-recovery] financial resync failed for ${scheduledServiceId}: ${e.message}`));
    } catch (e) {
      logger.error(`[billing-recovery] job-costing require failed: ${e.message}`);
    }

    res.json({ ok: true });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    if (err && err.code === '23505') {
      return res.status(409).json({ error: 'Visit has already been handled.' });
    }
    logger.error(`[billing-recovery] dismiss failed for ${scheduledServiceId}: ${err.message}`);
    res.status(500).json({ error: 'Failed to record disposition' });
  }
});

/**
 * POST /api/admin/billing-recovery/:scheduledServiceId/billed-elsewhere
 * Body: { invoiceNumber, note? }
 * Record that another invoice already bills this visit (a plan prepay, a
 * combined multi-home invoice, a duplicate visit row's invoice). Creates NO
 * invoice and leaves revenue as recorded (job costing zeroes revenue only for
 * 'intentionally_free'). The visit leaves the queue while the covering invoice
 * is live and returns if that invoice is later voided, refunded or cancelled.
 */
const BILLED_ELSEWHERE_REFUSED_STATUSES = ['draft'];
router.post('/:scheduledServiceId/billed-elsewhere', requireAdmin, async (req, res) => {
  const { scheduledServiceId } = req.params;
  const invoiceNumber = String(req.body?.invoiceNumber || '').trim().slice(0, 60);
  const reason = String(req.body?.note || '').trim().slice(0, 300) || null;
  if (!invoiceNumber) return res.status(400).json({ error: 'invoiceNumber required' });
  const refuse = (status, message) => Object.assign(new Error(message), { status });
  try {
    const covering = await db.transaction(async (trx) => {
      // Same per-visit lock as Bill and Mark free; every check runs inside it.
      await acquireScheduledInvoiceMintLock(trx, scheduledServiceId);
      const visit = await trx({ ss: 'scheduled_services' })
        .join({ c: 'customers' }, 'c.id', 'ss.customer_id')
        .leftJoin({ sr: 'service_records' }, 'sr.scheduled_service_id', 'ss.id')
        .where('ss.id', scheduledServiceId)
        .first('ss.id', 'ss.completed_at', 'ss.customer_id', 'ss.estimated_price', 'ss.service_type',
          'c.account_id', 'sr.id as service_record_id', 'sr.status as service_record_status');
      if (!visit) throw refuse(404, 'Visit not found');
      if (!visit.completed_at) throw refuse(422, 'Visit is not completed — nothing to record.');
      // Only a finished closeout: a status-only visit still runs the
      // completion flow, and an unfinished attempt resumes its mint — either
      // could bill the visit again (InvoiceService.create refuses that too).
      if (visit.service_record_status !== 'completed') {
        throw refuse(422, 'Finish this visit\'s closeout first — it has no completed service record.');
      }
      const openAttempt = await trx('service_completion_attempts')
        .where({ service_id: scheduledServiceId })
        .whereIn('status', ['side_effects_pending', 'side_effects_running'])
        .first('id');
      if (openAttempt) throw refuse(409, 'This visit\'s closeout is still finishing. Resume it first.');
      // A saved visit closeout (combined visit) bills every member on one
      // invoice and owns this visit's billing, finished or not (409).
      await assertScheduledInvoiceNotPacketOwned(trx, scheduledServiceId);
      const own = await trx('invoices')
        .where(function ownInvoice() {
          this.where('scheduled_service_id', scheduledServiceId);
          if (visit.service_record_id) this.orWhere('service_record_id', visit.service_record_id);
        })
        .whereNot('status', 'void')
        .first('id');
      if (own) throw refuse(409, 'This visit has its own invoice already.');
      const found = await trx({ i: 'invoices' })
        .join({ c: 'customers' }, 'c.id', 'i.customer_id')
        .whereRaw('LOWER(i.invoice_number) = LOWER(?)', [invoiceNumber])
        .first('i.id', 'i.invoice_number', 'i.status', 'i.total', 'i.scheduled_service_id', 'i.service_record_id',
          'i.customer_id', 'c.account_id');
      if (!found) throw refuse(404, `Invoice ${invoiceNumber} was not found.`);
      // The same customer, or another profile of the same account (one
      // household billed across its properties).
      const sameOwner = String(found.customer_id) === String(visit.customer_id)
        || (found.account_id && visit.account_id && String(found.account_id) === String(visit.account_id));
      if (!sameOwner) throw refuse(409, `Invoice ${found.invoice_number} belongs to a different customer.`);
      if ([...deadInvoiceStatuses(), ...BILLED_ELSEWHERE_REFUSED_STATUSES].includes(String(found.status))) {
        throw refuse(409, `Invoice ${found.invoice_number} is ${found.status} — it cannot cover this visit.`);
      }
      // The covering invoice must plausibly pay for this visit. One smaller
      // than the visit, or one that already bills another visit (a duplicate
      // row's twin), more likely names the wrong row: a duplicate row or a
      // visit never performed is Mark free, so its revenue is not counted
      // twice. A note that explains the case still records it.
      if (!reason) {
        const billing = await loadBillingMode(visit.customer_id, trx);
        const price = effectivePrice({ ...visit, billing_mode: billing.mode, per_application_fee: billing.perApplicationFee });
        const total = Number(found.total) || 0;
        const concern = total + 0.005 < price
          ? `Invoice ${found.invoice_number} totals $${total.toFixed(2)}, less than this visit's $${price.toFixed(2)}.`
          : ((found.scheduled_service_id || found.service_record_id) ? `Invoice ${found.invoice_number} already bills another visit.` : null);
        if (concern) {
          throw refuse(409, `${concern} If this row is a duplicate or was never performed, use Mark free. Otherwise add a note that explains it.`);
        }
      }
      const handled = await claimDispositionSlot(trx, scheduledServiceId);
      if (handled) throw refuse(409, handled);
      await trx('visit_billing_dispositions').insert({
        scheduled_service_id: scheduledServiceId,
        service_record_id: visit.service_record_id || null,
        disposition: 'billed_elsewhere',
        invoice_id: found.id,
        reason, // operator note stored in the DB column (not logged)
        actor_user_id: req.technicianId,
      });
      return found;
    });
    logger.info(`[billing-recovery] visit ${scheduledServiceId} marked billed elsewhere on invoice ${covering.id} by tech ${req.technicianId}`);
    res.json({ ok: true, invoice: { id: covering.id, invoice_number: covering.invoice_number, status: covering.status } });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    if (err && err.code === '23505') return res.status(409).json({ error: 'Visit has already been handled.' });
    logger.error(`[billing-recovery] billed-elsewhere failed for ${scheduledServiceId}: ${err.message}`);
    res.status(500).json({ error: 'Failed to record the covering invoice' });
  }
});

module.exports = router;
