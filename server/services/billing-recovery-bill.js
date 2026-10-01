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
const { refuseCoveredMemberMintInTrx } = require('./estimate-first-application-invoice');
const { etDateString } = require('../utils/datetime-et');
const { hasAuthoritativeZeroPrice } = require('./billing-lane');
// GATE_STAMPED_ZERO_FREE (owner ruling 2026-09-28): read at call time through
// billing-lane's one resolver (lazy, so no require cycle).
const stampedZeroFreeLive = () => require('./billing-lane').stampedZeroFreeLive();

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

// Stage 1 — the visit + its completion record + the customer's billing
// facts. serviceRecordId pins the completion record the caller already
// resolved (the IB repair passes closeout-status's canonical record); the
// Bill button keeps its legacy join.
async function loadBillableVisit(scheduledServiceId, serviceRecordId, database) {
  const query = database({ ss: 'scheduled_services' })
    .join({ c: 'customers' }, 'c.id', 'ss.customer_id')
    // The completion record must belong to the visit's own customer — a
    // record linked to the visit but owned by another customer never bills
    // (createFromService mints for the RECORD's customer).
    .leftJoin({ sr: 'service_records' }, function joinOwnRecord() {
      this.on('sr.scheduled_service_id', '=', 'ss.id').andOn('sr.customer_id', '=', 'ss.customer_id');
    })
    .where('ss.id', scheduledServiceId);
  if (serviceRecordId) query.where('sr.id', serviceRecordId);
  return query
    .select(
      'ss.id as scheduled_service_id',
      // annualPrepayCoversVisit's termite-grace check reads the visit's own
      // id and its plan links (recurring parent, source estimate, property).
      'ss.id',
      'ss.recurring_parent_id',
      'ss.source_estimate_id',
      'ss.property_id',
      // Sibling first-application coverage (siblingCoverageStatus).
      'ss.first_application_invoice_id',
      'ss.primary_line_price',
      'sr.id as service_record_id',
      'ss.service_type',
      'ss.estimated_price',
      'ss.prepaid_amount',
      'ss.prepaid_method',
      'ss.annual_prepay_term_id',
      'ss.scheduled_date',
      'ss.status as ss_status',
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
}

// Per-application pricing lives at the CUSTOMER level when the visit row
// carries no price (follow-up rows seed estimated_price NULL by design), so
// probe mode + fee once up front: the autopay guard and the price fallback
// both key off it. Column-probed BEFORE the read: inside the mint
// transaction a failing query would abort the whole transaction, so a
// pre-migration schema must never be discovered by an error.
async function loadBillingMode(customerId, database) {
  let hasModeColumns = false;
  try {
    hasModeColumns = await database.schema.hasColumn('customers', 'billing_mode')
      && await database.schema.hasColumn('customers', 'per_application_fee');
  } catch { /* keep legacy */ }
  if (!hasModeColumns) return { mode: null, perApplicationFee: 0 };
  try {
    const modeRow = await database('customers').where({ id: customerId }).first('billing_mode', 'per_application_fee');
    return { mode: modeRow?.billing_mode || null, perApplicationFee: parseFloat(modeRow?.per_application_fee || 0) };
  } catch {
    return { mode: null, perApplicationFee: 0 };
  }
}

// Stage 2 — who pays and whether the visit is already covered. Coverage
// lookups FAIL CLOSED: an unreadable autopay method or prepay term is a
// refusal, never "not covered" (a read error must not mint a duplicate).
async function coverageRefusal(visit, billingMode, database) {
  // Conservative v1 double-bill guard (owner priority): reject active-autopay
  // customers outright. The completion predicate only treats autopay as covering
  // NO-price visits, so an autopay one-off priced visit is technically billable —
  // recovering those is a deliberate follow-up; v1 stays conservative. Keyed on
  // the canonical customerOnAutopay() (default payment_methods row, ET pause,
  // ACH-not-active → card-only). Never trust the client.
  let onAutopay;
  try {
    onAutopay = await customerOnAutopay({
      id: visit.customer_id,
      autopay_enabled: visit.autopay_enabled,
      autopay_paused_until: visit.autopay_paused_until,
      ach_status: visit.ach_status,
    }, { db: database, failClosed: true });
  } catch {
    return refuse(503, 'Autopay status could not be verified — try again.');
  }
  // Per-application customers are on autopay BY DESIGN — the saved card
  // is HOW each visit charge collects, and the monthly cron skips them
  // (GUARD 3b), so "autopay = monthly-covered" is exactly wrong for
  // them: a per-app visit that completion failed to invoice/charge is
  // THE case this workbench exists to recover (Codex round-7). The
  // explicit per_visit/one_time lanes get the same exemption — the cron
  // skips them too, and their uninvoiced completions are real leaks
  // (Codex billing-lane r7). annual_prepay stays blocked (uncovered
  // visits belong to the renewal flow, covered ones to prepaid stamps).
  if (onAutopay && !['per_application', 'per_visit', 'one_time'].includes(billingMode)) {
    return refuse(409, 'Customer is on active autopay — billing-cron charges monthly_rate; invoicing would double-charge.');
  }
  // v1 is self-pay only — a payer-billed visit is owed by the payer's AP inbox,
  // not the homeowner, and must be cut through the payer invoice path. Payer
  // ownership comes from the canonical resolver InvoiceService.create uses
  // (per-job payer, self-pay pin, account default, ACTIVE payers only), never a
  // parallel classifier; an unreadable answer refuses.
  let payerId;
  try {
    ({ payerId } = await require('./payer').resolveForInvoice({
      database, customerId: visit.customer_id, scheduledServiceId: visit.scheduled_service_id, throwOnError: true,
    }));
  } catch {
    return refuse(503, 'Payer could not be verified — try again.');
  }
  if (payerId) return refuse(409, 'Visit is billed to a third-party payer — handle via the payer AP flow.');
  if (visit.ss_callback || visit.sr_callback) return refuse(409, 'Visit is flagged as a callback / re-treat (no-cost).');
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
  let covered;
  try {
    covered = await AnnualPrepayRenewals.annualPrepayCoversVisit(visit, database, { throwOnError: true });
  } catch {
    return refuse(503, 'Annual-prepay coverage could not be verified — try again.');
  }
  if (covered) return refuse(409, 'Visit is covered by an active annual prepay — already paid; do not bill manually.');
  return siblingCoverageRefusal(visit, database);
}

// Sibling first-application coverage (#5237 follow-up): a visit billed on
// its trip's combined first-application invoice has no invoice on its own
// row, so it reaches Billing Recovery as an "uninvoiced" completion, and Bill
// would mint a second charge for an application that invoice already bills.
// The same composition Charge Now's resolver runs
// (resolveScheduledServiceCharge, admin-schedule.js): the shape gate
// (isSiblingCoverageEligibleVisit), a priced visit only as a stamped covered
// member (isPricedCoveredMemberVisit), that member's own refunded invoice
// first (pricedCoveredMemberOwnRefundHold, as completion does), then the
// shared verdict (siblingInvoiceCoverageVerdict, which also carries the
// REFUSE AFTER A VOID ruling). Returns 'none' | 'covered' | 'needs_review'
// | 'error'.
// `trustRowStamp` (the read-only leaks list only): a priced row whose own
// read carries a NULL stamp is not a member — no extra query per row. The
// Bill write never passes it: a NULL can be stale, so it is re-read.
async function siblingCoverageStatus(visit, database, { trustRowStamp = false } = {}) {
  const {
    hasAuthoritativeZeroPrice, isSiblingCoverageEligibleVisit, siblingInvoiceCoverageVerdict,
  } = require('./billing-lane');
  const isCallback = !!(visit.ss_callback || visit.sr_callback);
  if (!isSiblingCoverageEligibleVisit({
    sourceEstimateId: visit.source_estimate_id, hasOwnPrice: false, isCallback, serviceType: visit.service_type,
  })) return 'none';
  const hasOwnPrice = (visit.estimated_price != null && Number(visit.estimated_price) > 0)
    || hasAuthoritativeZeroPrice(visit.estimated_price, visit.primary_line_price ?? null);
  const svc = {
    id: visit.scheduled_service_id,
    customer_id: visit.customer_id,
    source_estimate_id: visit.source_estimate_id,
    scheduled_date: visit.scheduled_date,
    first_application_invoice_id: visit.first_application_invoice_id,
    estimated_price: visit.estimated_price,
    primary_line_price: visit.primary_line_price ?? null,
    is_callback: isCallback,
    service_type: visit.service_type,
  };
  if (hasOwnPrice && trustRowStamp && visit.first_application_invoice_id === null) return 'none';
  const firstApp = require('./estimate-first-application-invoice');
  try {
    // isPricedCoveredMemberVisit already reads true on its own read error
    // (fail closed); inside the try so any other failure is 'error' too.
    const isPricedCoveredMember = hasOwnPrice ? await firstApp.isPricedCoveredMemberVisit(svc, database) : false;
    if (!isSiblingCoverageEligibleVisit({
      sourceEstimateId: visit.source_estimate_id, hasOwnPrice, isCallback, serviceType: visit.service_type, isPricedCoveredMember,
    })) return 'none';
    if (isPricedCoveredMember && await firstApp.pricedCoveredMemberOwnRefundHold(svc, database)) return 'needs_review';
    return (await siblingInvoiceCoverageVerdict(svc, database)).status;
  } catch {
    return 'error';
  }
}

async function siblingCoverageRefusal(visit, database) {
  const status = await siblingCoverageStatus(visit, database);
  if (status === 'covered') {
    return refuse(409, 'This visit is billed on the combined trip invoice — do not bill it separately.');
  }
  if (status === 'needs_review') {
    return refuse(409, 'This visit\'s combined-trip invoice needs manual review before billing — handle it from Customer 360.');
  }
  if (status === 'error') {
    return refuse(503, 'Could not confirm whether this visit\'s combined-trip invoice already covers it — try again.');
  }
  return null;
}

// Stage 3 — the amount. Mirror completion billing's per-application
// precedence (row price → customers.per_application_fee, NEVER monthly_rate).
function priceRefusalOrAmount(visit, billing) {
  const AnnualPrepayRenewals = require('./annual-prepay-renewals');
  // Past the coverage gate: a lingering annual_prepay_invoice stamp is STALE
  // (term voided/refunded) — its amount is NOT real coverage, so ignore it and
  // bill normally rather than block as "fully/partially prepaid" with refunded
  // money (mirror the completion fallback). Other methods keep their real amount.
  const prepaid = visit.prepaid_method === AnnualPrepayRenewals.ANNUAL_PREPAY_PREPAID_METHOD
    ? 0
    : parseFloat(visit.prepaid_amount || 0);
  const rowPrice = parseFloat(visit.estimated_price || 0);
  // GATE_STAMPED_ZERO_FREE (owner ruling 2026-09-28): a stamped 0 (as
  // opposed to a genuinely blank row) is this visit's own price, never the
  // per-application fee — same predicate the completion resolver uses.
  // Guarded explicitly by the live gate (not just the predicate's own
  // internal check) because this call site never consulted the predicate
  // at all before, so it must stay byte-identical while the gate is off.
  const stampedZero = stampedZeroFreeLive() && hasAuthoritativeZeroPrice(visit.estimated_price, null);
  const price = rowPrice > 0 ? rowPrice : (stampedZero ? 0 : (billing.mode === 'per_application' ? billing.perApplicationFee : 0));
  if (!(price > 0)) return refuse(422, 'Visit has no price to invoice.');
  if (prepaid >= price) return refuse(409, 'Visit is already fully prepaid.');
  // Partial prepay needs the prepaid credit applied (completion does this via
  // a local helper not reused here) — route to the manual invoice flow.
  if (prepaid > 0) return refuse(409, `Visit has a partial prepayment ($${prepaid.toFixed(2)}) — bill it manually so the prepaid credit is applied.`);
  return { ok: true, price, rowPrice };
}

// requireCompletedVisit (IB closeout repair): the scheduled visit itself must
// still be completed — a completed record left behind on a cancelled or
// rescheduled visit is a contradiction for a person, not a bill.
async function assessVisitBillable(scheduledServiceId, { serviceRecordId = null, requireCompletedVisit = false, database = db } = {}) {
  const visit = await loadBillableVisit(scheduledServiceId, serviceRecordId, database);
  if (!visit) return refuse(404, 'Visit not found');
  if (requireCompletedVisit && visit.ss_status !== 'completed') {
    return refuse(409, `The visit is ${visit.ss_status || 'not completed'} — its completion record contradicts it; resolve that first.`);
  }
  if (!visit.service_record_id) return refuse(422, 'Visit has no completion record — cannot invoice');
  // Office-handoff visits write service_records.status='incomplete' and the
  // completion flow intentionally skips invoicing — never bill those here.
  if (visit.sr_status !== 'completed') return refuse(422, 'Visit completion record is incomplete (office-handoff) — cannot invoice.');
  const billing = await loadBillingMode(visit.customer_id, database);
  const refusal = await coverageRefusal(visit, billing.mode, database);
  if (refusal) return refusal;
  const priced = priceRefusalOrAmount(visit, billing);
  if (!priced.ok) return priced;
  return { ok: true, visit, price: priced.price, rowPrice: priced.rowPrice, dueDate: dueDateFromVisit(visit) || null };
}

const cents = (n) => Math.round(Number(n) * 100);

// A one-time card-on-file hold still open on this visit (held / charging /
// charge_review). Completion resolves it (chargeCardHoldOnCompletion) when it
// mints; the Bill action does not, so such visits are not billed here.
async function liveCardHoldForVisit(scheduledServiceId, database = db) {
  const hold = await database('estimate_card_holds')
    .where({ scheduled_service_id: scheduledServiceId })
    .whereIn('status', ['held', 'charging', 'charge_review'])
    .first('id', 'status');
  return hold || null;
}

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

function conflict409(message) {
  const e = new Error(message);
  e.status = 409;
  return e;
}

// In-lock checks before the mint. The lock must be on the visit's CURRENT
// owner (a merge that committed between the owner read and the lock leaves
// the old row locked); an open card hold and a reprice since the approval
// refuse.
async function preMintRefusal({ owner, visit, price, scheduledServiceId, expectedPrice, refuseLiveCardHold, trx }) {
  if (owner?.customer_id && String(owner.customer_id) !== String(visit.customer_id)) {
    return 'The visit changed customers while billing — try again.';
  }
  if (refuseLiveCardHold && await liveCardHoldForVisit(scheduledServiceId, trx)) {
    return 'A card hold is still open on this visit — completion captures or releases it; bill it from Billing Recovery after resolving the hold.';
  }
  if (expectedPrice !== null && cents(price) !== cents(expectedPrice)) {
    return `The visit's price changed since it was approved ($${Number(expectedPrice).toFixed(2)} → $${price.toFixed(2)}).`;
  }
  return null;
}

async function alreadyHandledRefusal(trx, visit, scheduledServiceId) {
  const existingInvoice = await trx('invoices')
    .where(function () {
      this.where('service_record_id', visit.service_record_id).orWhere('scheduled_service_id', scheduledServiceId);
    })
    .whereNot('status', 'void')
    .first();
  if (existingInvoice) return 'An invoice already exists for this visit.';
  const existingDisposition = await trx('visit_billing_dispositions')
    .where('scheduled_service_id', scheduledServiceId)
    .first();
  if (existingDisposition) return 'Visit has already been handled.';
  return null;
}

// After the mint: the invoice must be the approved one. createFromService
// mints for the completion record's current owner and re-resolves Bill-To,
// so a merge/repoint or a payer assigned after the assessment refuses; the
// approved total and its subtotal / discount / tax split must match.
function postMintRefusal(created, visit, { expectedTotal, expectedBreakdown }) {
  if (String(created.customer_id || '') !== String(visit.customer_id || '')) {
    return 'The visit changed customers while billing — reload it and bill it from Billing Recovery.';
  }
  if (created.payer_id) return 'The visit became third-party billed while billing — handle it via the payer AP flow.';
  if (expectedBreakdown && (cents(created.subtotal) !== cents(expectedBreakdown.subtotal)
    || cents(created.discount_amount || 0) !== cents(expectedBreakdown.discount || 0)
    || cents(created.tax_amount || 0) !== cents(expectedBreakdown.tax || 0))) {
    return 'The invoice line items, discounts or tax changed since they were approved.';
  }
  if (expectedTotal !== null && cents(created.total) !== cents(expectedTotal)) {
    return `The invoice total changed since it was approved ($${Number(expectedTotal).toFixed(2)} → $${Number(created.total).toFixed(2)}).`;
  }
  return null;
}

// expectedPrice: the amount an approval showed (IB closeout repair). The
// assessment runs under the mint lock, so a reprice between the approval
// and this write refuses instead of minting a different figure.
// refuseDepositCredit: the approval did not cover consuming deposit money
// (the IB repair leaves deposit-bearing visits manual) — createFromService
// refuses on its locked deposit read if any unapplied deposit would roll
// onto this invoice.
// requireCompletedVisit / refuseLiveCardHold: the IB repair's approval
// covers neither a contradicted visit nor an open card hold — both are
// re-checked under the lock.
// expectedTotal / expectedBreakdown: the exact invoice total and its
// subtotal / discount / tax split an approval showed (from previewBillVisit)
// — the minted invoice must carry the same figures or the whole mint rolls
// back.
async function billVisit(scheduledServiceId, {
  actorId = null, expectedPrice = null, expectedTotal = null, expectedBreakdown = null, refuseDepositCredit = false, serviceRecordId = null,
  requireCompletedVisit = false, refuseLiveCardHold = false, database = db,
} = {}) {
  try {
    // Serialize concurrent bills on the same visit, assess inside the lock,
    // then create the invoice + disposition. Prevents duplicate draft invoices.
    const { invoice, price, dueDate } = await database.transaction(async (trx) => {
      await acquireScheduledInvoiceMintLock(trx, scheduledServiceId);
      // Customer row lock BEFORE the coverage assessment: Auto Pay enrollment
      // (autopay-enrollment enrollConsentedMethod) locks this row first, so
      // an enrollment can't land between the assessment reading the customer
      // as uncovered and the mint. Same order the mint itself uses (mint
      // advisory → customer → visit), so no new lock cycle.
      const owner = await trx('scheduled_services').where({ id: scheduledServiceId }).first('customer_id');
      if (owner?.customer_id) await trx('customers').where({ id: owner.customer_id }).forUpdate().first('id');
      const assessed = await assessVisitBillable(scheduledServiceId, { serviceRecordId, requireCompletedVisit, database: trx });
      if (!assessed.ok) {
        const e = new Error(assessed.error);
        e.refusal = assessed;
        throw e;
      }
      const { visit, price, rowPrice } = assessed;
      const preRefusal = await preMintRefusal({ owner, visit, price, scheduledServiceId, expectedPrice, refuseLiveCardHold, trx });
      if (preRefusal) throw conflict409(preRefusal);

      const handled = await alreadyHandledRefusal(trx, visit, scheduledServiceId);
      if (handled) throw conflict409(handled);

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
        refuseDepositCredit,
        // A stamp that lands after the assessment above is refused under
        // the visit row lock (#5237's completion guard): the stamper locks
        // the same row, so either this sees it or it sees this invoice.
        recheckInTrx: (conn) => refuseCoveredMemberMintInTrx(conn, scheduledServiceId),
      });

      const postRefusal = postMintRefusal(created, visit, { expectedTotal, expectedBreakdown });
      if (postRefusal) throw conflict409(postRefusal);

      await trx('visit_billing_dispositions').insert({
        scheduled_service_id: scheduledServiceId,
        service_record_id: visit.service_record_id,
        disposition: 'billed',
        invoice_id: created.id,
        actor_user_id: actorId,
      });

      return { invoice: created, price, dueDate: dueDateFromVisit(visit) || null };
    });
    return { ok: true, invoice, price, dueDate };
  } catch (err) {
    if (err && err.refusal) return err.refusal;
    if (err && err.status === 409) return refuse(409, err.message);
    if (err && err.code === '23505') return refuse(409, 'Visit has already been handled.');
    throw err;
  }
}

const PREVIEW_ROLLBACK = Symbol('bill-visit-preview');

// The exact invoice the Bill action would create, without keeping it: the
// REAL billVisit (same locks, replayed line items, discounts, tax, retention
// reservation) runs inside an outer transaction that is always rolled back.
// Every write on this path is on the transaction (invoice, disposition, the
// discount audit savepoint, the retention-slot reservation — built to revert
// with a rolled-back mint), and invoice numbers are read from the table, not
// a sequence, so nothing survives. Same options as billVisit.
async function previewBillVisit(scheduledServiceId, options = {}) {
  let result = null;
  try {
    await db.transaction(async (trx) => {
      result = await billVisit(scheduledServiceId, { ...options, database: trx });
      throw PREVIEW_ROLLBACK;
    });
  } catch (err) {
    if (err !== PREVIEW_ROLLBACK) throw err;
  }
  if (!result?.ok) return result || refuse(500, 'Invoice preview failed');
  const inv = result.invoice;
  const money = (v) => Number(Number(v || 0).toFixed(2));
  return {
    ok: true,
    total: money(inv.total),
    subtotal: money(inv.subtotal),
    discountAmount: money(inv.discount_amount),
    taxAmount: money(inv.tax_amount),
    // The service-date due date the mint was given (dueDateFromVisit) — not
    // re-read off the row, where a DATE column may come back as a JS Date.
    dueDate: result.dueDate,
  };
}

module.exports = {
  assessVisitBillable, billVisit, previewBillVisit, pendingDepositForVisit, liveCardHoldForVisit, dueDateFromVisit, siblingCoverageStatus,
};
