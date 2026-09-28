/**
 * Billing Recovery "Bill" — cut a DRAFT invoice for an uninvoiced completed
 * visit (never sends it; the operator sends from the Invoices surface).
 *
 * One implementation for both callers: POST /api/admin/billing-recovery/
 * :scheduledServiceId/bill and the Intelligence Bar closeout repair's
 * bill_visit step.
 *
 *   assessVisitBillable — read-only: re-verifies the visit is genuinely
 *                         billable (not autopay-covered, payer-billed,
 *                         callback, always-free, prepaid, unpriced) and
 *                         returns the amount the draft would carry.
 *   billVisit           — serialize per visit on the scheduled invoice mint
 *                         lock, run the assessment INSIDE the lock (and, for
 *                         an approved amount, refuse if the price moved),
 *                         then create the invoice + 'billed' disposition in
 *                         one transaction.
 *
 * Refusals come back as { ok: false, status, error } — never thrown — so the
 * route maps them to HTTP and the IB plan lists them as manual items.
 */
const db = require('../models/db');
const InvoiceService = require('./invoice');
const { customerOnAutopay } = require('./autopay-eligibility');
const { isAlwaysFreeServiceType } = require('./no-cost-visit-types');
const { acquireScheduledInvoiceMintLock } = require('./scheduled-invoice-mint');
const { etDateString } = require('../utils/datetime-et');

// Match the completion path's due date (the service date), so a recovered
// 60/90-day-old visit ages correctly instead of resetting to today+30. A
// date-only string is used as-is; a timestamp is normalized to its ET date.
function dueDateFromVisit(v) {
  const raw = v.service_date || v.completed_at;
  if (!raw) return undefined;
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  return etDateString(new Date(raw));
}

const refuse = (status, error) => ({ ok: false, status, error });

async function assessVisitBillable(scheduledServiceId, { database = db } = {}) {
  // Same effective-payer resolution as the leak list: a per-job self-pay pin
  // means the visit bills the customer directly, so the payer-billed reject
  // below must not fire off the ignored account default. Column-guarded.
  let billSelfPayAware = false;
  try {
    billSelfPayAware = await database.schema.hasColumn('scheduled_services', 'self_pay_override');
  } catch { /* keep legacy */ }
  const visit = await database({ ss: 'scheduled_services' })
    .join({ c: 'customers' }, 'c.id', 'ss.customer_id')
    .leftJoin({ sr: 'service_records' }, 'sr.scheduled_service_id', 'ss.id')
    .where('ss.id', scheduledServiceId)
    .select(
      'ss.id as scheduled_service_id',
      'sr.id as service_record_id',
      'ss.service_type',
      'ss.estimated_price',
      'ss.prepaid_amount',
      'ss.prepaid_method',
      'ss.annual_prepay_term_id',
      'ss.scheduled_date',
      database.raw(billSelfPayAware
        ? 'COALESCE(ss.payer_id, CASE WHEN COALESCE(ss.self_pay_override, false) THEN NULL ELSE c.payer_id END) as payer_id'
        : 'COALESCE(ss.payer_id, c.payer_id) as payer_id'),
      database.raw('COALESCE(ss.is_callback, false) as ss_callback'),
      database.raw('COALESCE(sr.is_callback, false) as sr_callback'),
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

  if (!visit) return refuse(404, 'Visit not found');
  if (!visit.service_record_id) {
    return refuse(422, 'Visit has no completion record — cannot invoice');
  }
  // Office-handoff visits write service_records.status='incomplete' and the
  // completion flow intentionally skips invoicing — never bill those here.
  if (visit.sr_status !== 'completed') {
    return refuse(422, 'Visit completion record is incomplete (office-handoff) — cannot invoice.');
  }

  // Per-application pricing lives at the CUSTOMER level when the visit row
  // carries no price (follow-up rows seed estimated_price NULL by design),
  // so probe mode + fee once up front: the autopay guard below and the
  // price fallback both key off it, and the fallback must apply whether or
  // not the customer's autopay is currently healthy (a per-app visit whose
  // saved method died still needs a recoverable price). Column-guarded —
  // pre-migration environments keep exact legacy behavior.
  let recoveryBillingMode = null;
  let recoveryPerApplicationFee = 0;
  try {
    const modeRow = await database('customers')
      .where({ id: visit.customer_id })
      .first('billing_mode', 'per_application_fee');
    recoveryBillingMode = modeRow?.billing_mode || null;
    recoveryPerApplicationFee = parseFloat(modeRow?.per_application_fee || 0);
  } catch { /* billing_mode column absent — keep legacy behavior */ }

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
    // Per-application customers are on autopay BY DESIGN — the saved card
    // is HOW each visit charge collects, and the monthly cron skips them
    // (GUARD 3b), so "autopay = monthly-covered" is exactly wrong for
    // them: a per-app visit that completion failed to invoice/charge is
    // THE case this workbench exists to recover (Codex round-7). The
    // explicit per_visit/one_time lanes get the same exemption — the cron
    // skips them too, and their uninvoiced completions are real leaks
    // (Codex billing-lane r7). annual_prepay stays blocked (uncovered
    // visits belong to the renewal flow, covered ones to prepaid stamps).
    if (!['per_application', 'per_visit', 'one_time'].includes(recoveryBillingMode)) {
      return refuse(409, 'Customer is on active autopay — billing-cron charges monthly_rate; invoicing would double-charge.');
    }
  }
  // v1 is self-pay only — a payer-billed visit is owed by the payer's AP inbox,
  // not the homeowner, and must be cut through the payer invoice path.
  if (visit.payer_id) {
    return refuse(409, 'Visit is billed to a third-party payer — handle via the payer AP flow.');
  }
  if (visit.ss_callback || visit.sr_callback) {
    return refuse(409, 'Visit is flagged as a callback / re-treat (no-cost).');
  }
  // Always-free check for the write path — a stale/direct request must not
  // bill an always-free type.
  if (isAlwaysFreeServiceType(visit.service_type)) {
    return refuse(409, 'Visit type is always no-cost (appointment / estimate / re-service / follow-up) — not billable here.');
  }
  // A LIVE annual-prepay-covered visit is fully covered by the term. Its stamp is
  // a DISCOUNTED slice < the undiscounted estimated_price, so without this guard it
  // would fall into the "partial prepay → bill manually" 409 below and get
  // double-billed. Fail-closed: a stale/refunded stamp is NOT covered and still bills.
  const AnnualPrepayRenewals = require('./annual-prepay-renewals');
  if (await AnnualPrepayRenewals.annualPrepayCoversVisit(visit)) {
    return refuse(409, 'Visit is covered by an active annual prepay — already paid; do not bill manually.');
  }
  // Past the coverage gate: a lingering annual_prepay_invoice stamp is STALE
  // (term voided/refunded) — its amount is NOT real coverage, so ignore it and
  // bill normally rather than block as "fully/partially prepaid" with refunded
  // money (mirror the completion fallback). Other methods keep their real amount.
  const prepaid = visit.prepaid_method === AnnualPrepayRenewals.ANNUAL_PREPAY_PREPAID_METHOD
    ? 0
    : parseFloat(visit.prepaid_amount || 0);
  // Mirror completion billing's per-application precedence (row price →
  // customers.per_application_fee, NEVER monthly_rate): a leaked per-app
  // visit whose amount lives at the customer level must be recoverable
  // here, not bounce as "no price" (Codex round-11).
  const rowPrice = parseFloat(visit.estimated_price || 0);
  const price = rowPrice > 0
    ? rowPrice
    : (recoveryBillingMode === 'per_application' ? recoveryPerApplicationFee : 0);
  if (!(price > 0)) {
    return refuse(422, 'Visit has no price to invoice.');
  }
  if (prepaid >= price) {
    return refuse(409, 'Visit is already fully prepaid.');
  }
  if (prepaid > 0) {
    // Partial prepay needs the prepaid credit applied (completion does this via
    // a local helper not reused here) — route to the manual invoice flow.
    return refuse(409, `Visit has a partial prepayment ($${prepaid.toFixed(2)}) — bill it manually so the prepaid credit is applied.`);
  }
  return { ok: true, visit, price, rowPrice };
}

const cents = (n) => Math.round(Number(n) * 100);

// Unapplied deposit money createFromService would roll onto this visit's
// invoice (scheduled_services.source_estimate_id → estimate_deposits), in
// dollars; 0 when the visit has no source estimate or nothing is open.
async function pendingDepositForVisit(scheduledServiceId, database = db) {
  const ss = await database('scheduled_services').where({ id: scheduledServiceId }).first('source_estimate_id');
  if (!ss?.source_estimate_id) return 0;
  const { pendingDepositCredit } = require('./estimate-deposits');
  const credit = await pendingDepositCredit(ss.source_estimate_id, database);
  return credit ? Number(credit.amount) || 0 : 0;
}

// expectedPrice: the amount an approval showed (IB closeout repair). The
// assessment runs under the mint lock, so a reprice between the approval
// and this write refuses instead of minting a different figure.
// refuseDepositCredit: the approval did not cover consuming deposit money
// (the IB repair leaves deposit-bearing visits manual) — refuse under the
// lock if any unapplied deposit would roll onto this invoice.
async function billVisit(scheduledServiceId, {
  actorId = null, expectedPrice = null, refuseDepositCredit = false, database = db,
} = {}) {
  try {
    // Serialize concurrent bills on the same visit, assess inside the lock,
    // then create the invoice + disposition. Prevents duplicate draft invoices.
    const { invoice, price } = await database.transaction(async (trx) => {
      await acquireScheduledInvoiceMintLock(trx, scheduledServiceId);
      const assessed = await assessVisitBillable(scheduledServiceId, { database: trx });
      if (!assessed.ok) {
        const e = new Error(assessed.error);
        e.refusal = assessed;
        throw e;
      }
      const { visit, price, rowPrice } = assessed;
      if (refuseDepositCredit && (await pendingDepositForVisit(scheduledServiceId, trx)) > 0) {
        const e = new Error('An estimate deposit credit would apply to this invoice — bill it from Billing Recovery.');
        e.status = 409;
        throw e;
      }
      if (expectedPrice !== null && cents(price) !== cents(expectedPrice)) {
        const e = new Error(`The visit's price changed since it was approved ($${Number(expectedPrice).toFixed(2)} → $${price.toFixed(2)}).`);
        e.status = 409;
        throw e;
      }

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
      // THIS transaction is threaded through (codex #3344 r6 P1): we hold
      // the schedule.invoice.mint advisory lock above, and an un-threaded
      // createFromService would open a SEPARATE connection and request the
      // same lock — a self-deadlock that blocked /bill until timeout.
      // Same-session re-acquisition is a no-op, the replay mint runs under
      // a savepoint on this trx, and invoice⇄disposition now commit
      // atomically as a bonus.
      const created = await InvoiceService.createFromService(visit.service_record_id, {
        database: trx,
        amount: price,
        description: visit.service_type,
        // No taxRate override: an explicit rate (even 0) pre-empts
        // TaxCalculator in InvoiceService.create (tax_exemptions,
        // service_taxability, county tax_rates) and mis-billed `business`
        // property_type at 0%. Leave the key ABSENT so the replay mint
        // resolves tax the same way a fresh invoice does.
        useScheduledReplay: true,
        // The row price this amount derived from — lets the locked replay
        // rebuild 409 instead of silently minting a since-repriced visit at
        // the stale figure (codex #3344 r2). Unpriced rows (per-app fee
        // lane) have no basis to drift.
        scheduledPriceBasis: rowPrice > 0 ? visit.estimated_price : undefined,
        dueDate: dueDateFromVisit(visit), // age from the service date, not today+30
      });

      await trx('visit_billing_dispositions').insert({
        scheduled_service_id: scheduledServiceId,
        service_record_id: visit.service_record_id,
        disposition: 'billed',
        invoice_id: created.id,
        actor_user_id: actorId,
      });

      return { invoice: created, price };
    });
    return { ok: true, invoice, price };
  } catch (err) {
    if (err && err.refusal) return err.refusal;
    if (err && err.status === 409) return refuse(409, err.message);
    if (err && err.code === '23505') return refuse(409, 'Visit has already been handled.');
    throw err;
  }
}

module.exports = { assessVisitBillable, billVisit, pendingDepositForVisit, dueDateFromVisit };
