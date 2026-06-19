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
const InvoiceService = require('../services/invoice');
const { customerOnAutopay } = require('../services/autopay-eligibility');
const { shortenOrPassthrough, invoiceShortCodePrefix } = require('../services/short-url');
const { publicPortalUrl } = require('../utils/portal-url');
const { etDateString } = require('../utils/datetime-et');
const {
  executeDashboardTool,
  INTERNAL_TEST_CUSTOMERS,
} = require('../services/intelligence-bar/dashboard-tools');

router.use(adminAuthenticate, requireTechOrAdmin);

// Reuse the SAME advisory-lock key the scheduled-service invoice-mint path uses
// (admin-schedule.js: 'schedule.invoice.mint') so a recovery Bill serializes not
// just against another recovery Bill/dismiss but against Charge-now / completion
// mints too. invoices.scheduled_service_id is NOT unique, so a private namespace
// would let a recovery Bill and a concurrent mint both create duplicate drafts.
const SCHEDULED_SERVICE_INVOICE_MINT_LOCK = 'schedule.invoice.mint';

// Service-type patterns that are intentionally $0 and must never be flagged as a
// leak or auto-billed. Matched case-insensitively against scheduled_services.service_type.
// Always-free service types — excluded from the leak queue entirely and rejected
// on the write path. These are never billable.
const ALWAYS_FREE_PATTERNS = [
  '%appointment%',  // general_appointment ("Waves Pest Control Appointment Service")
  '%estimate%',     // estimate visits
  '%re-service%', '%reservice%', '%re service%', // free re-services
  '%follow-up%', '%followup%', '%follow up%', '%re-visit%', '%revisit%', // follow-up re-visits
];

// Ambiguous types that CAN be paid (paid WDO/inspection, rodent trapping setup)
// OR free (waived inspection, in-window trap check). Surface these in needs-review
// for a human call rather than suppressing real paid-visit leaks.
const REVIEW_PATTERNS = ['%inspection%', '%trap%', '%rodent%'];

const matchesPatterns = (serviceType, patterns) => {
  const s = String(serviceType || '').toLowerCase();
  return patterns.some((p) => s.includes(p.replace(/%/g, '')));
};
// Always-free check for the write path (POST /bill) — a stale/direct request
// must not bill an always-free type.
const isNoCostServiceType = (serviceType) => matchesPatterns(serviceType, ALWAYS_FREE_PATTERNS);
const isReviewServiceType = (serviceType) => matchesPatterns(serviceType, REVIEW_PATTERNS);

// SQL fragment: TRUE when a non-void invoice already exists for the visit.
// Aliases: `sr` = service_records, `ss` = scheduled_services.
const HAS_INVOICE_SQL = `EXISTS (
  SELECT 1 FROM invoices i
  WHERE (i.service_record_id = sr.id OR i.scheduled_service_id = ss.id)
    AND COALESCE(i.status, '') <> 'void'
)`;

const INTERNAL_NAME_SQL = "LOWER(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,''))";

// Active-autopay predicate mirroring customerOnAutopay(): keyed on the canonical
// default Stripe payment_methods row (not the customers pointer), with the ET
// pause check and ACH-not-active → card-only fallback. The single `?` binds
// today's ET date. Returns { sql, binding } so callers can NOT() it.
function autopayActivePredicate() {
  const sql = `(
    c.autopay_enabled IS NOT FALSE
    AND NOT (c.autopay_paused_until IS NOT NULL AND c.autopay_paused_until >= ?::date)
    AND EXISTS (
      SELECT 1 FROM payment_methods pm
      WHERE pm.customer_id = c.id
        AND pm.processor = 'stripe'
        AND pm.is_default = true
        AND pm.autopay_enabled = true
        AND pm.stripe_payment_method_id IS NOT NULL
        AND (
          c.ach_status IS NULL OR c.ach_status = '' OR c.ach_status = 'active'
          OR pm.method_type = 'card'
        )
    )
  )`;
  return { sql, binding: etDateString() };
}

function clampDays(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return 90;
  return Math.min(365, Math.max(1, n));
}

// Match the completion path's due date (the service date), so a recovered
// 60/90-day-old visit ages correctly instead of resetting to today+30. A
// date-only string is used as-is; a timestamp is normalized to its ET date.
function dueDateFromVisit(v) {
  const raw = v.service_date || v.completed_at;
  if (!raw) return undefined;
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  return etDateString(new Date(raw));
}

// Shared base query for uninvoiced completed visits, with the full no-cost
// allowlist applied. Returns priced visits only (estimated_price > 0). All
// req-derived values are bound, never interpolated.
function uninvoicedLeakQuery(days) {
  const autopay = autopayActivePredicate();
  const q = db({ ss: 'scheduled_services' })
    .join({ c: 'customers' }, 'c.id', 'ss.customer_id')
    .leftJoin({ sr: 'service_records' }, 'sr.scheduled_service_id', 'ss.id')
    .leftJoin({ d: 'visit_billing_dispositions' }, 'd.scheduled_service_id', 'ss.id')
    .whereRaw("ss.completed_at >= now() - (? * interval '1 day')", [days])
    .whereRaw('COALESCE(ss.estimated_price, 0) > 0')
    .whereNull('d.id')                                   // not already dispositioned
    .whereRaw("sr.status = 'completed'")                 // completed record only (excludes office-handoff 'incomplete' + missing)
    .whereRaw(`NOT ${HAS_INVOICE_SQL}`)                  // no existing invoice
    .whereRaw('COALESCE(ss.is_callback, false) = false') // not a callback (free re-treat)
    .whereRaw('COALESCE(sr.is_callback, false) = false')
    .whereRaw('COALESCE(ss.prepaid_amount, 0) < ss.estimated_price') // not FULLY prepaid (partial surfaces in needs-review)
    .whereRaw('COALESCE(ss.payer_id, c.payer_id) IS NULL') // self-pay only (v1); payer-billed = payer AP flow
    // Conservative v1 scope (owner priority: never risk double-billing an autopay
    // customer). The completion predicate only treats autopay as covering NO-price
    // visits, so an autopay customer's one-off explicitly-priced visit is
    // technically billable — surfacing those is a deliberate follow-up, kept out of
    // v1 to avoid any double-bill exposure.
    .whereRaw(`NOT ${autopay.sql}`, [autopay.binding])   // exclude active-autopay customers
    .whereRaw(
      `COALESCE(ss.service_type, '') NOT ILIKE ALL (ARRAY[${ALWAYS_FREE_PATTERNS.map(() => '?').join(',')}]::text[])`,
      ALWAYS_FREE_PATTERNS,
    );
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
    const rows = await uninvoicedLeakQuery(days)
      .select(
        'ss.id as scheduled_service_id',
        'sr.id as service_record_id',
        'ss.service_type',
        'ss.estimated_price',
        'ss.prepaid_amount',
        'ss.completed_at',
        'c.id as customer_id',
        'c.first_name',
        'c.last_name',
        'c.monthly_rate',
        'c.waveguard_tier',
      )
      .orderBy('ss.completed_at', 'desc');

    const shape = (r) => ({
      scheduled_service_id: r.scheduled_service_id,
      service_record_id: r.service_record_id,
      customer_id: r.customer_id,
      customer: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
      service_type: r.service_type,
      price: parseFloat(r.estimated_price || 0),
      prepaid: parseFloat(r.prepaid_amount || 0),
      completed_at: r.completed_at,
      monthly_rate: parseFloat(r.monthly_rate || 0),
      waveguard_tier: r.waveguard_tier || null,
      billable: !!r.service_record_id, // cannot invoice without a service record
    });

    // Recurring (monthly_rate>0), partially-prepaid, or ambiguous-type
    // (inspection/rodent — could be paid or free) visits need a human eye before
    // billing — they aren't safe one-click leaks.
    const isReview = (r) => parseFloat(r.monthly_rate || 0) > 0
      || parseFloat(r.prepaid_amount || 0) > 0
      || isReviewServiceType(r.service_type);
    const leaks = rows.filter((r) => !isReview(r)).map(shape);
    const needsReview = rows.filter(isReview).map(shape);
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
 * POST /api/admin/billing-recovery/:scheduledServiceId/bill
 * Cut a DRAFT invoice for an uninvoiced completed visit (does NOT send it —
 * the operator sends from the Invoices surface). Server re-verifies the visit
 * is genuinely billable (not autopay-covered, not already invoiced/dispositioned)
 * before creating anything, and serializes concurrent clicks per visit.
 */
router.post('/:scheduledServiceId/bill', requireAdmin, async (req, res) => {
  const { scheduledServiceId } = req.params;
  try {
    const visit = await db({ ss: 'scheduled_services' })
      .join({ c: 'customers' }, 'c.id', 'ss.customer_id')
      .leftJoin({ sr: 'service_records' }, 'sr.scheduled_service_id', 'ss.id')
      .where('ss.id', scheduledServiceId)
      .select(
        'ss.id as scheduled_service_id',
        'sr.id as service_record_id',
        'ss.service_type',
        'ss.estimated_price',
        'ss.prepaid_amount',
        db.raw('COALESCE(ss.payer_id, c.payer_id) as payer_id'),
        db.raw('COALESCE(ss.is_callback, false) as ss_callback'),
        db.raw('COALESCE(sr.is_callback, false) as sr_callback'),
        'sr.status as sr_status',
        'sr.service_date',
        'ss.completed_at',
        'c.id as customer_id',
        'c.monthly_rate',
        'c.property_type',
        'c.autopay_enabled',
        'c.autopay_paused_until',
        'c.ach_status',
      )
      .first();

    if (!visit) return res.status(404).json({ error: 'Visit not found' });
    if (!visit.service_record_id) {
      return res.status(422).json({ error: 'Visit has no completion record — cannot invoice' });
    }
    // Office-handoff visits write service_records.status='incomplete' and the
    // completion flow intentionally skips invoicing — never bill those here.
    if (visit.sr_status !== 'completed') {
      return res.status(422).json({ error: 'Visit completion record is incomplete (office-handoff) — cannot invoice.' });
    }

    // Conservative v1 double-bill guard (owner priority): reject active-autopay
    // customers outright. The completion predicate only treats autopay as covering
    // NO-price visits, so an autopay one-off priced visit is technically billable —
    // recovering those is a deliberate follow-up; v1 stays conservative. Keyed on
    // the canonical customerOnAutopay() (default payment_methods row, ET pause,
    // ACH-not-active → card-only). Never trust the client.
    const onAutopay = await customerOnAutopay({
      id: visit.customer_id,
      autopay_enabled: visit.autopay_enabled,
      autopay_paused_until: visit.autopay_paused_until,
      ach_status: visit.ach_status,
    });
    if (onAutopay) {
      return res.status(409).json({ error: 'Customer is on active autopay — billing-cron charges monthly_rate; invoicing would double-charge.' });
    }
    // v1 is self-pay only — a payer-billed visit is owed by the payer's AP inbox,
    // not the homeowner, and must be cut through the payer invoice path.
    if (visit.payer_id) {
      return res.status(409).json({ error: 'Visit is billed to a third-party payer — handle via the payer AP flow.' });
    }
    if (visit.ss_callback || visit.sr_callback) {
      return res.status(409).json({ error: 'Visit is flagged as a callback / re-treat (no-cost).' });
    }
    if (isNoCostServiceType(visit.service_type)) {
      return res.status(409).json({ error: 'Visit type is always no-cost (appointment / estimate / re-service / follow-up) — not billable here.' });
    }
    const prepaid = parseFloat(visit.prepaid_amount || 0);
    const price = parseFloat(visit.estimated_price || 0);
    if (!(price > 0)) {
      return res.status(422).json({ error: 'Visit has no price to invoice.' });
    }
    if (prepaid >= price) {
      return res.status(409).json({ error: 'Visit is already fully prepaid.' });
    }
    if (prepaid > 0) {
      // Partial prepay needs the prepaid credit applied (completion does this via
      // a local helper not reused here) — route to the manual invoice flow.
      return res.status(409).json({ error: `Visit has a partial prepayment ($${prepaid.toFixed(2)}) — bill it manually so the prepaid credit is applied.` });
    }

    // Serialize concurrent bills on the same visit, recheck inside the lock,
    // then create the invoice + disposition. Prevents duplicate draft invoices.
    const invoice = await db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', [SCHEDULED_SERVICE_INVOICE_MINT_LOCK, scheduledServiceId]);

      const existingInvoice = await trx('invoices')
        .where(function () {
          this.where('service_record_id', visit.service_record_id).orWhere('scheduled_service_id', scheduledServiceId);
        })
        .whereNot('status', 'void')
        .first();
      if (existingInvoice) {
        const e = new Error('An invoice already exists for this visit.');
        e.status = 409;
        throw e;
      }

      const existingDisposition = await trx('visit_billing_dispositions')
        .where('scheduled_service_id', scheduledServiceId)
        .first();
      if (existingDisposition) {
        const e = new Error('Visit has already been handled.');
        e.status = 409;
        throw e;
      }

      // Canonical completion path (replays scheduled-service line items + discounts).
      // NOTE: createFromService writes via the global db connection and takes no
      // trx, so the draft invoice commits independently of this transaction —
      // true invoice⇄disposition atomicity would require threading a trx through
      // the shared InvoiceService (used by the completion path), which is out of
      // scope here. The advisory lock + the existing-invoice/disposition rechecks
      // above prevent the dangerous outcomes (double invoice, double disposition).
      // Residual failure mode is benign: if the disposition insert below throws,
      // the draft invoice is orphaned (recoverable/voidable) and the existing-
      // invoice recheck excludes the visit from future leaks on retry — never a
      // double-charge.
      const created = await InvoiceService.createFromService(visit.service_record_id, {
        amount: parseFloat(visit.estimated_price),
        description: visit.service_type,
        taxRate: visit.property_type === 'commercial' ? 0.07 : 0,
        useScheduledReplay: true,
        dueDate: dueDateFromVisit(visit), // age from the service date, not today+30
      });

      await trx('visit_billing_dispositions').insert({
        scheduled_service_id: scheduledServiceId,
        service_record_id: visit.service_record_id,
        disposition: 'billed',
        invoice_id: created.id,
        actor_user_id: req.technicianId,
      });

      return created;
    });

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
    if (err && err.status === 409) return res.status(409).json({ error: err.message });
    if (err && err.code === '23505') return res.status(409).json({ error: 'Visit has already been handled.' });
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
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', [SCHEDULED_SERVICE_INVOICE_MINT_LOCK, scheduledServiceId]);

      const visit = await trx({ ss: 'scheduled_services' })
        .leftJoin({ sr: 'service_records' }, 'sr.scheduled_service_id', 'ss.id')
        .where('ss.id', scheduledServiceId)
        .select('ss.id as scheduled_service_id', 'ss.completed_at', 'sr.id as service_record_id')
        .first();
      if (!visit) { const e = new Error('Visit not found'); e.status = 404; throw e; }
      if (!visit.completed_at) { const e = new Error('Visit is not completed — nothing to dismiss.'); e.status = 422; throw e; }

      const invoiced = await trx('invoices')
        .where(function () {
          this.where('service_record_id', visit.service_record_id).orWhere('scheduled_service_id', scheduledServiceId);
        })
        .whereNot('status', 'void')
        .first();
      if (invoiced) { const e = new Error('Visit is already invoiced — cannot mark it free.'); e.status = 409; throw e; }

      const existing = await trx('visit_billing_dispositions')
        .where('scheduled_service_id', scheduledServiceId)
        .first();
      if (existing) { const e = new Error('Visit has already been handled.'); e.status = 409; throw e; }

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

module.exports = router;
