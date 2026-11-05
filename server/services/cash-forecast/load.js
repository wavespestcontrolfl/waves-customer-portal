/**
 * Read-only loader for the 13-week cash forecast (engine.js computes; this file only reads).
 *
 * Every date is an ET calendar day bound from the app clock, never SQL current_date (the database
 * session is not Eastern). Plaid reads are the free /accounts/get (plaid-sync readCashBalances) and
 * Stripe's balance read; nothing here writes, texts or charges.
 */
const db = require('../../models/db');
const logger = require('../logger');
const plaidSync = require('../plaid-sync');
const StripeBanking = require('../stripe-banking');
const { resolveBillingLane, predictCompletionBilling, monthlyDuesCollected } = require('../billing-lane');
const AnnualPrepay = require('../annual-prepay-renewals');
const { applyOpenSelfPayPredicates, rowIsSelfPayDue } = require('../open-balance');
const { autopayActivePredicate } = require('../autopay-eligibility');
const { DUES_COHORT_COLUMNS, applyDuesCohort, autopayGuard, laneGuard, monthlyDuesVerdict } = require('../monthly-dues-eligibility');
const InvoiceService = require('../invoice');
const { invoiceAmountDue } = require('../invoice-helpers');
const { etDateString } = require('../../utils/datetime-et');
const inputs = require('./inputs');
const { _private: engine } = require('./engine');

const COHORT_DAYS = 150;
const CLOSED_VISIT_STATUSES = ['cancelled', 'completed', 'rescheduled', 'skipped', 'no_show'];
const DEAD_INVOICE_STATUSES = InvoiceService.CANCELLED_SERVICE_RESOLVED_STATUSES;
const ET_DAY = (col) => `to_char((${col}) AT TIME ZONE 'America/New_York', 'YYYY-MM-DD')`;
const DAY = (col) => `to_char(${col}, 'YYYY-MM-DD')`;
const usd = (n) => Number(n) || 0;
// Cash an invoice brought in: the amount paid when it is stored (partial payments), else for a paid
// invoice its total less the credit applied (a credit is not new money).
const PAID_CASH_SQL = `CASE WHEN COALESCE(i.amount_paid, 0) > 0 THEN i.amount_paid
  WHEN i.status = 'paid' THEN GREATEST(0, COALESCE(i.total, 0) - COALESCE(i.credit_applied, 0)) ELSE 0 END`;

// What completing the visit bills the homeowner: billing-lane predictCompletionBilling, the completion
// path's own rules (the lane, Auto Pay, the dues, an annual prepay, the per-application fee, callbacks,
// free and consultation types, a prepayment). An invoice or a card charge counts; a covered, payer-billed,
// prepaid or free visit brings nothing. The prediction takes two answers from the database, read by
// valueVisits: the annual-prepay verdict and whether the visit's month of dues is already paid for.
const CASH_KINDS = new Set(['invoice', 'auto_charge']);
function predictedCash(row, { annualCoverage = null, duesCollected = false } = {}) {
  // Completion skips the invoice for a visit an annual prepay covers, in every lane
  // (complete-scheduled-service.js annualPrepayCovered); the prediction covers a stamped visit only in
  // the annual lane, so a covered verdict decides here first.
  if (annualCoverage === true) return 0;
  const prediction = predictCompletionBilling({
    lane: resolveBillingLane(row).mode,
    billingMode: row.billing_mode || null,
    autopayActive: row.autopay_active === true,
    estimatedPrice: row.estimated_price != null ? Number(row.estimated_price) : null,
    primaryLinePrice: row.primary_line_price,
    monthlyRate: row.monthly_rate,
    perApplicationFee: row.per_application_fee,
    isRecurring: row.is_recurring === true,
    isCallback: row.is_callback === true,
    serviceType: row.service_type,
    payerBilled: row.payer_billed === true,
    prepaidAmount: row.prepaid_amount,
    prepaidMethod: row.prepaid_method || null,
    annualCoverageValidated: annualCoverage,
    duesCollectedThisMonth: duesCollected,
  });
  return CASH_KINDS.has(prediction.kind) ? usd(prediction.amount) : 0;
}

// The annual-prepay verdict, read as the schedule board reads it (annual-prepay-renewals
// annualCoverageVerdictForPrediction): a stamped visit is checked against its prepay year, and so is a
// visit of a customer with an after-visit prepay year (one query finds those customers). Every other visit
// has no verdict (null) and is never read. The checks run eight at a time on the full visit rows (the
// check reads the hold stamp from the row). A visit whose check fails (a stamp with no prepay year reads
// as unverifiable) keeps no verdict, as on the board; one log line counts them.
const ANNUAL_CHECKS_AT_ONCE = 8;
async function annualVerdicts(database, rows) {
  const verdicts = new Map();
  let deferred;
  let full;
  try {
    deferred = await AnnualPrepay.deferredPrepayHoldCustomerIds(database, rows.map((r) => r.customer_id));
    const ids = rows
      .filter((r) => r.prepaid_method === AnnualPrepay.ANNUAL_PREPAY_PREPAID_METHOD || deferred.has(String(r.customer_id)))
      .map((r) => r.id);
    full = ids.length ? await database('scheduled_services').whereIn('id', ids) : [];
  } catch (err) {
    logger.warn(`[cash-forecast] annual prepay coverage reads failed: ${err.message}`);
    return verdicts;
  }
  const failed = [];
  const check = async (visit) => {
    try {
      verdicts.set(String(visit.id), await AnnualPrepay.annualCoverageVerdictForPrediction(visit, database, { deferredCustomerIds: deferred }));
    } catch (err) {
      failed.push(err.message);
    }
  };
  for (let n = 0; n < full.length; n += ANNUAL_CHECKS_AT_ONCE) {
    await Promise.all(full.slice(n, n + ANNUAL_CHECKS_AT_ONCE).map(check));
  }
  if (failed.length) logger.warn(`[cash-forecast] annual prepay coverage unreadable for ${failed.length} visit(s); first: ${failed[0]}`);
  return verdicts;
}

// Has the member's month of dues been paid for, leaving out the visit's own invoice? (billing-lane
// monthlyDuesCollected, completion's own check.) A failed read counts the month as paid, so the forecast
// never counts money it cannot place.
async function duesPaid(database, row) {
  try {
    return await monthlyDuesCollected(database, row.customer_id, new Date(`${row.scheduled_day}T12:00:00Z`), {
      excludeScheduledServiceId: row.id,
    });
  } catch (err) {
    logger.warn(`[cash-forecast] dues read failed for visit ${row.id}: ${err.message}`);
    return true;
  }
}

// Each visit's value, by id. Completion bills a member's dues once per ET month: one dues invoice covers
// the month's other visits. So when the prediction turns on the month's dues, the database answers for
// that month; in a month it has no answer for, the first such visit (by date) bills and the rest are
// covered.
async function valueVisits(database, rows) {
  const annual = await annualVerdicts(database, rows);
  const values = new Map();
  const billedMonths = new Set();
  const byDay = [...rows].sort((a, b) => a.scheduled_day.localeCompare(b.scheduled_day));
  for (const row of byDay) {
    const annualCoverage = annual.has(String(row.id)) ? annual.get(String(row.id)) : null;
    const billed = predictedCash(row, { annualCoverage });
    const duesDecide = billed > 0 && predictedCash(row, { annualCoverage, duesCollected: true }) !== billed;
    const month = `${row.customer_id}|${row.scheduled_day.slice(0, 7)}`;
    const paid = duesDecide && (billedMonths.has(month) || await duesPaid(database, row));
    if (duesDecide && !paid) billedMonths.add(month);
    values.set(String(row.id), paid ? 0 : billed);
  }
  return values;
}

async function readVisits(database, { from, to, now }) {
  const autopay = autopayActivePredicate(now);
  return database.raw(`
    SELECT ss.id, ss.customer_id, ss.status, ${DAY('ss.scheduled_date')} AS scheduled_day,
      CASE WHEN ss.completed_at IS NULL THEN NULL ELSE ${ET_DAY('ss.completed_at')} END AS completed_day,
      ss.prepaid_amount, ss.prepaid_method, ss.estimated_price, ss.primary_line_price, ss.service_type,
      COALESCE(ss.is_recurring, false) AS is_recurring,
      ${autopay.sql} AS autopay_active,
      (COALESCE(ss.payer_id, CASE WHEN COALESCE(ss.self_pay_override, false) THEN NULL ELSE c.payer_id END) IS NOT NULL) AS payer_billed,
      (COALESCE(ss.is_callback, false) OR EXISTS (
        SELECT 1 FROM service_records sr WHERE sr.scheduled_service_id = ss.id AND COALESCE(sr.is_callback, false))) AS is_callback,
      -- its own live invoice, or a combined first-application invoice that covers it (the stamp
      -- estimate-converter's stampCombinedFirstApplicationInvoiceCoverage writes on every member)
      (EXISTS (SELECT 1 FROM invoices i LEFT JOIN service_records sr2 ON sr2.id = i.service_record_id
          WHERE COALESCE(i.scheduled_service_id, sr2.scheduled_service_id) = ss.id AND i.status <> ALL(?::text[]))
        OR EXISTS (SELECT 1 FROM invoices fi WHERE fi.id = ss.first_application_invoice_id AND fi.status <> ALL(?::text[]))) AS has_invoice,
      c.billing_mode, c.waveguard_tier, c.monthly_rate, c.per_application_fee
    FROM scheduled_services ss
    JOIN customers c ON c.id = ss.customer_id
    WHERE ss.scheduled_date BETWEEN ?::date AND ?::date
      AND (ss.status = 'completed' OR ss.status <> ALL(?::text[]))`,
  [autopay.binding, DEAD_INVOICE_STATUSES, DEAD_INVOICE_STATUSES, from, to, CLOSED_VISIT_STATUSES]).then((r) => r.rows);
}

// Invoices behind completed visits (linked by the visit or by its service record), live ones only:
// the amount settled and the day it was paid in full (part payments come from readPartPayments).
async function readVisitInvoices(database, visitIds) {
  if (!visitIds.length) return [];
  return database.raw(`
    SELECT i.id, COALESCE(i.scheduled_service_id, sr.scheduled_service_id) AS visit_id,
      CASE WHEN i.paid_at IS NULL THEN NULL ELSE ${ET_DAY('i.paid_at')} END AS paid_day,
      ${PAID_CASH_SQL} AS settled
    FROM invoices i
    LEFT JOIN service_records sr ON sr.id = i.service_record_id
    WHERE COALESCE(i.scheduled_service_id, sr.scheduled_service_id) = ANY(?::uuid[])
      AND i.status <> ALL(?::text[])`,
  [visitIds, DEAD_INVOICE_STATUSES]).then((r) => r.rows);
}

// The homeowner's sent invoices: the timing of money after an invoice goes out (open ones included,
// unpaid). Never one a payer or a payer statement owns, or one withdrawn when its Bill-To moved to a
// payer (open-balance.js applyOpenSelfPayPredicates' ownership rules).
async function readSentInvoices(database, { from, to }) {
  return database.raw(`
    SELECT i.id, ${ET_DAY('i.sent_at')} AS sent_day, i.total, i.credit_applied, i.status,
      CASE WHEN i.paid_at IS NULL THEN NULL ELSE ${ET_DAY('i.paid_at')} END AS paid_day,
      ${PAID_CASH_SQL} AS settled
    FROM invoices i
    WHERE i.sent_at IS NOT NULL AND i.payer_id IS NULL AND i.payer_statement_id IS NULL
      AND COALESCE(i.scheduled_send_error, '') NOT LIKE 'payer_billed:%'
      AND (i.sent_at AT TIME ZONE 'America/New_York')::date BETWEEN ?::date AND ?::date
      AND i.status <> ALL(?::text[]) AND i.status <> 'prepaid'`,
  [from, to, DEAD_INVOICE_STATUSES]).then((r) => r.rows);
}

// Part payments recorded before an invoice is paid in full (invoice-manual-payment.js writes a dated
// payments row and raises amount_paid, not paid_at): each counts on its own date.
async function readPartPayments(database, invoiceIds) {
  if (!invoiceIds.length) return [];
  return database.raw(`
    SELECT p.metadata->>'invoice_id' AS invoice_id, ${DAY('p.payment_date')} AS paid_day,
      GREATEST(0, COALESCE(p.amount, 0) - COALESCE(p.refund_amount, 0)) AS amount
    FROM payments p
    WHERE p.status = 'paid' AND p.metadata->>'partial_payment' = 'true' AND p.metadata->>'invoice_id' = ANY(?::text[])`,
  [invoiceIds.map(String)]).then((r) => r.rows);
}

// Cash events for one invoice: its part payments on their dates, and the rest on the day it was paid in
// full. Nothing is counted twice: the final event is what the part payments did not already cover.
function payEvents(inv, partsByInvoice) {
  const parts = partsByInvoice.get(String(inv.id)) || [];
  const partSum = parts.reduce((s, p) => s + usd(p.amount), 0);
  const final = inv.paid_day ? [{ day: inv.paid_day, amount: Math.max(0, usd(inv.settled) - partSum) }] : [];
  return [...parts.map((p) => ({ day: p.paid_day, amount: usd(p.amount) })), ...final].filter((e) => e.amount > 0);
}

function groupBy(rows, key) {
  const out = new Map();
  for (const r of rows) out.set(String(r[key]), [...(out.get(String(r[key])) || []), r]);
  return out;
}

// Open self-pay invoices, by the shared definition (open-balance.js): presented, not payer-owned, not on
// a statement, not withdrawn to a payer, something still owed, and the live payer re-check per row
// (rowIsSelfPayDue, fail-closed: a row it cannot resolve is left out); archived ones are left out too.
async function readOpenInvoices(database) {
  const rows = await applyOpenSelfPayPredicates(database('invoices'))
    .whereNull('invoices.paid_at')
    .whereNull('invoices.archived_at')
    .select(
      database.raw(`${ET_DAY('COALESCE(invoices.sent_at, invoices.created_at)')} AS sent_day`),
      'invoices.customer_id', 'invoices.scheduled_service_id', 'invoices.invoice_number',
      'invoices.status', 'invoices.total', 'invoices.credit_applied', 'invoices.amount_paid',
    );
  const due = await Promise.all(rows.map((r) => rowIsSelfPayDue(r.customer_id, r, { database })));
  return rows.filter((_, n) => due[n]);
}

async function readDrafts(database) {
  const r = await database.raw(`
    SELECT count(*)::int AS n, COALESCE(sum(i.total), 0) AS total FROM invoices i
    WHERE i.status = 'draft' AND i.archived_at IS NULL AND i.payer_id IS NULL`);
  return r.rows[0] || { n: 0, total: 0 };
}

// The 8 AM dues run's own cohort and verdict (monthly-dues-eligibility.js), so the forecast counts the
// dues that run would charge. The cheap guards first; the full verdict only for the few left.
async function readDues(database, { today, to, now }) {
  const rows = await applyDuesCohort(database('customers')).select(DUES_COHORT_COLUMNS);
  const members = rows.filter((c) => !autopayGuard(c, now) && !laneGuard(c));
  const out = [];
  for (const c of members) {
    const verdict = await monthlyDuesVerdict(database, c.id, { now });
    if (!verdict.eligible) continue;
    const day = Math.max(1, Number(c.billing_day) || 1);
    const [y, mo] = today.split('-').map(Number);
    for (let m = 0; m < 5; m += 1) {
      const ym = new Date(Date.UTC(y, mo - 1 + m, 1)).toISOString().slice(0, 7);
      const last = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
      if (day > last) continue; // the run bills on that day of the month only (billing-helpers isBillingDayMatch)
      const due = `${ym}-${String(day).padStart(2, '0')}`;
      if (due > today && due <= to) out.push({ day: due, amountUsd: usd(c.monthly_rate) });
    }
  }
  return out;
}

async function readPrepaySales(database, { from, to }) {
  const r = await database.raw(`
    SELECT COALESCE(sum(${PAID_CASH_SQL}), 0) AS usd FROM invoices i
    WHERE i.status = 'paid' AND EXISTS (SELECT 1 FROM annual_prepay_terms t WHERE t.prepay_invoice_id = i.id)
      AND (i.paid_at AT TIME ZONE 'America/New_York')::date BETWEEN ?::date AND ?::date`, [from, to]);
  return usd(r.rows[0]?.usd);
}

async function readBankLines(database, { labels, from, to }) {
  if (!labels.length) return [];
  return database.raw(`
    SELECT bt.id, ${DAY('bt.txn_date')} AS day, bt.account_label AS account, bt.direction, bt.amount, bt.description,
      ec.name AS category,
      (bt.matched_payroll_check_id IS NOT NULL OR bt.matched_tax_filing_id IS NOT NULL) AS modeled
    FROM bank_transactions bt
    LEFT JOIN expenses x ON x.id = bt.matched_expense_id
    LEFT JOIN expense_categories ec ON ec.id = x.category_id
    WHERE bt.source = 'plaid' AND bt.account_label = ANY(?::text[]) AND bt.txn_date BETWEEN ?::date AND ?::date`,
  [labels, from, to]).then((r) => r.rows);
}

// Cards that reach the portal only by statement upload: their last row and that month's charges.
async function readCardsOffFeed(database, { feedLabels, since }) {
  return database.raw(`
    WITH last AS (
      SELECT account_label, max(txn_date) AS last_day FROM bank_transactions
      WHERE account_type = 'card' AND source <> 'plaid' AND txn_date >= ?::date AND account_label <> ALL(?::text[])
      GROUP BY 1)
    SELECT l.account_label, ${DAY('l.last_day')} AS last_day,
      COALESCE(sum(bt.amount) FILTER (WHERE bt.direction = 'debit' AND bt.txn_date > l.last_day - 30), 0) AS debits_30d
    FROM last l JOIN bank_transactions bt ON bt.account_label = l.account_label AND bt.source <> 'plaid'
    GROUP BY 1, 2 ORDER BY 1`, [since, feedLabels]).then((r) => r.rows);
}

// Finalized checks from 35 days back to the window's end. A check in the window pays its net (and the
// employer's HSA money) on the pay date; the withheld and employer taxes and the savings leave later, on
// the payroll tax rows' due dates (readTaxRows). Each employee paid in those 35 days is also projected
// weekly after their last check (projectPayroll), at full cost: no deposit rows exist for those yet.
async function readPayroll(database, { from, to }) {
  return database.raw(`
    SELECT pc.technician_id, ${DAY('pc.pay_date')} AS pay_day,
      (COALESCE(pc.net_cents, 0) + COALESCE(pc.hsa_employer_cents, 0)) AS net_cents,
      (pc.gross_cents + COALESCE(pc.employer_social_security_cents, 0) + COALESCE(pc.employer_medicare_cents, 0)
        + COALESCE(pc.futa_cents, 0) + COALESCE(pc.fl_reemployment_cents, 0) + COALESCE(pc.simple_employer_cents, 0)
        + COALESCE(pc.hsa_employer_cents, 0)) AS full_cents
    FROM payroll_checks pc JOIN payroll_runs pr ON pr.id = pc.run_id
    WHERE pc.pay_date BETWEEN ?::date AND ?::date AND pr.status = 'finalized' AND pr.voided_at IS NULL
      AND COALESCE(pc.status, '') <> 'void'
    ORDER BY pc.pay_date`, [from, to]).then((r) => r.rows);
}

// Weekly pay after each employee's last finalized check, at the average full cost of their last 4 checks.
function projectPayroll(rows, { today, to }) {
  const byEmployee = new Map();
  for (const r of rows) {
    const key = r.technician_id || 'unknown';
    const list = byEmployee.get(key) || [];
    list.push(r);
    byEmployee.set(key, list);
  }
  const out = [];
  for (const list of byEmployee.values()) {
    const last = list[list.length - 1];
    const recent = list.slice(-4);
    const avgUsd = recent.reduce((s, r) => s + usd(r.full_cents), 0) / recent.length / 100;
    for (let d = engine.addDays(last.pay_day, 7); d <= to; d = engine.addDays(d, 7)) {
      if (d >= today) out.push({ payDay: d, cashCostUsd: Math.round(avgUsd * 100) / 100 });
    }
  }
  return out;
}

// Tax payments due in the window, payroll deposits included (payroll-tax-calendar.js: the monthly 941
// deposit, SIMPLE savings, the quarterly RT-6, the employer 2%). The quarterly Form 941 is a return that
// the monthly deposits already paid, so it is left out.
async function readTaxRows(database, { from, to }) {
  return database.raw(`
    SELECT ${DAY('due_date')} AS due_day, filing_type, amount_due, amount_paid FROM tax_filing_calendar
    WHERE due_date BETWEEN ?::date AND ?::date AND COALESCE(status, '') NOT IN ('paid', 'filed')
      AND filing_type <> 'payroll_941'`, [from, to]).then((r) => r.rows);
}

async function readCash(readCashBalances) {
  try {
    return await readCashBalances();
  } catch (err) {
    logger.warn(`[cash-forecast] cash read failed: ${err.message}`);
    return null;
  }
}

async function readStripe(readBalance) {
  try {
    const b = await readBalance();
    return { availableUsd: usd(b?.total_available), pendingUsd: usd(b?.total_pending), ok: true };
  } catch (err) {
    logger.warn(`[cash-forecast] Stripe balance read failed: ${err.message}`);
    return { availableUsd: 0, pendingUsd: 0, ok: false };
  }
}

async function readInTransit(database) {
  const rows = await database('stripe_payouts').whereIn('status', ['pending', 'in_transit']).select('amount', 'currency', 'arrival_date');
  // arrival_date is a midnight-UTC day marker: its UTC day is the day (never an ET conversion).
  return rows
    .filter((r) => String(r.currency || 'usd').toLowerCase() === 'usd' && r.arrival_date)
    .map((r) => ({ amountUsd: usd(r.amount), arrivalDay: new Date(r.arrival_date).toISOString().slice(0, 10) }));
}

// Every day the reads are bound to, from the app clock in ET (the engine's own windows).
function windowFor(now) {
  const today = etDateString(now);
  const weeks = engine.buildWeeks(today);
  return {
    today,
    windowEnd: weeks[weeks.length - 1].end,
    cohortFrom: engine.addDays(today, -COHORT_DAYS),
    yesterday: engine.addDays(today, -1),
    // the 8 complete weeks before this week's Monday
    trailingFrom: engine.addDays(weeks[0].start, -7 * engine.TRAILING_WEEKS),
    trailingTo: engine.addDays(weeks[0].start, -1),
  };
}

const usdOnly = (a) => String(a.currency || 'USD').toUpperCase() === 'USD';
const balanceOf = (a) => [a.available, a.current].find(Number.isFinite);

// The opening pool (decision 2 A: every dollar checking account in the feed) and what it leaves out.
// Dollar accounts only: a line in another currency must never be added to dollar spending.
function poolFrom(cash) {
  const read = { accounts: [], cards: [], unavailable: [], ...cash };
  const counted = read.accounts.filter((a) => usdOnly(a) && balanceOf(a) !== undefined);
  const cards = read.cards.filter(usdOnly);
  return {
    opening: {
      bankUsd: counted.length ? counted.reduce((s, a) => s + balanceOf(a), 0) : null,
      // a card in credit owes nothing; its credit is never cash for another card or the pool
      cardOwedUsd: cards.reduce((s, c) => s + Math.max(0, Number.isFinite(c.current) ? c.current : 0), 0),
      partial: !cash || read.unavailable.length > 0 || counted.length < read.accounts.length,
    },
    poolAccounts: read.accounts.filter(usdOnly).map((a) => a.account_label).filter(Boolean),
    feedCards: cards.map((c) => c.account_label).filter(Boolean),
    facts: [
      ...read.unavailable.map((u) => ({ kind: 'account_unavailable', institution: u.institution_name || null, reason: u.reason, mask: u.mask || null })),
      ...(cash ? [] : [{ kind: 'balance_unavailable' }]),
      ...(cards.some((c) => !Number.isFinite(c.current)) ? [{ kind: 'card_balance_unavailable' }] : []),
    ],
  };
}

// Completed visits in the cohort window are the collection cohort; open visits in the forecast window
// are booked work. A visit already invoiced brings its cash once, as its invoice (or a draft, listed
// apart), but it is still booked work when the expected line compares work to last year's pace.
function splitVisits(visits, d, values) {
  const rows = visits.map((v) => ({ ...v, value: values.get(String(v.id)), doneDay: v.completed_day || v.scheduled_day }));
  const completed = rows.filter((v) => v.status === 'completed' && v.doneDay >= d.cohortFrom && v.doneDay <= d.yesterday);
  const trailing = completed.filter((v) => v.doneDay >= d.trailingFrom && v.doneDay <= d.trailingTo);
  const open = rows.filter((v) => v.status !== 'completed' && v.scheduled_day >= d.today && v.scheduled_day <= d.windowEnd);
  return {
    cohort: completed.filter((v) => v.value > 0).map((v) => ({ id: v.id, day: v.doneDay, value: v.value, invoiced: !!v.has_invoice })),
    booked: open.map((v) => ({ day: v.scheduled_day, value: v.has_invoice ? 0 : v.value, work: v.value })),
    payerBilled: open.filter((v) => v.payer_billed).length,
    trailingVisits: trailing.length,
    trailingWorkUsd: trailing.reduce((s, v) => s + v.value, 0),
  };
}

// The cohort with each visit's cash by days after the visit (its invoices' payment events); visits with
// no invoice at all in the last 90 days are listed as not billed. A combined invoice's cash sits on its
// anchor visit; the curve is total cash over total value, so where that cash sits barely changes it, and
// a covered visit is billed.
function cohortFrom(cohort, invoices, partsByInvoice, today) {
  const gap = engine.dayDiff;
  const byVisit = groupBy(invoices, 'visit_id');
  const paidLines = (v) => (byVisit.get(String(v.id)) || [])
    .flatMap((inv) => payEvents(inv, partsByInvoice))
    .map((e) => ({ lagDays: Math.max(0, gap(v.day, e.day)), amount: e.amount }));
  const unbilled = cohort.filter((v) => !v.invoiced && !byVisit.has(String(v.id)) && gap(v.day, today) <= 90);
  return {
    visitCohort: cohort.map((v) => ({ value: v.value, ageDays: gap(v.day, today), paid: paidLines(v) })),
    unbilled: { count: unbilled.length, usd: Math.round(unbilled.reduce((s2, v) => s2 + v.value, 0) * 100) / 100 },
  };
}

// What the loader knows the forecast cannot see. Each entry shows only when it applies.
function loaderFacts({ pool, visits, unbilled, drafts, taxRows, offFeed, stripeOk }) {
  const noAmount = taxRows.filter((t) => t.amount_due === null || t.amount_due === undefined).length;
  return [
    ...pool.facts,
    ...offFeed.map((c) => ({ kind: 'card_not_in_feed', account: c.account_label, last_day: c.last_day, debits_30d_usd: usd(c.debits_30d) })),
    ...[
      { when: !stripeOk, fact: { kind: 'stripe_balance_unavailable' } },
      { when: visits.payerBilled > 0, fact: { kind: 'payer_billed_visits', count: visits.payerBilled } },
      { when: unbilled.count > 0, fact: { kind: 'completed_visits_not_billed', ...unbilled } },
      { when: Number(drafts.n) > 0, fact: { kind: 'draft_invoices', count: Number(drafts.n), usd: usd(drafts.total) } },
      { when: noAmount > 0, fact: { kind: 'tax_rows_without_amount', count: noAmount } },
    ].filter((f) => f.when).map((f) => f.fact),
  ];
}

async function loadForecastInput({
  database = db,
  now = new Date(),
  readCashBalances = plaidSync.readCashBalances,
  readStripeBalance = StripeBanking.getBalance,
} = {}) {
  const d = windowFor(now);
  const [cash, stripeBalance, payouts, settings, items] = await Promise.all([
    readCash(readCashBalances),
    readStripe(readStripeBalance),
    readInTransit(database),
    inputs.getSettings(database),
    inputs.listItems(database),
  ]);
  const pool = poolFrom(cash);
  const [visitRows, sent, open, drafts, dues, prepaySalesUsd3m, bankLines, offFeed, payroll, taxRows] = await Promise.all([
    readVisits(database, { from: d.cohortFrom, to: d.windowEnd, now }),
    readSentInvoices(database, { from: d.cohortFrom, to: d.yesterday }),
    readOpenInvoices(database),
    readDrafts(database),
    readDues(database, { today: d.today, to: d.windowEnd, now }),
    readPrepaySales(database, { from: engine.addDays(d.today, -91), to: d.yesterday }),
    // 10 days either side so a transfer or card payment pair at the window's edge still matches.
    readBankLines(database, { labels: [...pool.poolAccounts, ...pool.feedCards], from: engine.addDays(d.trailingFrom, -10), to: engine.addDays(d.trailingTo, 10) }),
    readCardsOffFeed(database, { feedLabels: pool.feedCards, since: engine.addDays(d.today, -120) }),
    readPayroll(database, { from: engine.addDays(d.today, -35), to: d.windowEnd }),
    // unpaid rows already past due stay owed (the tax page keeps them): they count today
    readTaxRows(database, { from: engine.addDays(d.today, -400), to: d.windowEnd }),
  ]);
  const visits = splitVisits(visitRows, d, await valueVisits(database, visitRows));
  const visitInvoices = await readVisitInvoices(database, visits.cohort.map((v) => v.id));
  const parts = groupBy(await readPartPayments(database, [...visitInvoices, ...sent].map((i) => i.id)), 'invoice_id');
  const { visitCohort, unbilled } = cohortFrom(visits.cohort, visitInvoices, parts, d.today);
  const gap = engine.dayDiff;
  return {
    today: d.today,
    opening: pool.opening,
    stripe: { availableUsd: stripeBalance.availableUsd, pendingUsd: stripeBalance.pendingUsd, payouts },
    visitCohort,
    invoiceCohort: sent.map((i) => ({
      // what the customer had to pay when it went out: the canonical amount due before any payment,
      // since the curve measures the payments against it
      value: invoiceAmountDue({ total: i.total, credit_applied: i.credit_applied, amount_paid: 0 }),
      ageDays: gap(i.sent_day, d.today),
      paid: payEvents(i, parts).map((e) => ({ lagDays: Math.max(0, gap(i.sent_day, e.day)), amount: e.amount })),
    })),
    booked: visits.booked,
    openInvoices: open.map((i) => ({ amountUsd: invoiceAmountDue(i), ageDays: Math.max(0, gap(i.sent_day, d.today)) })),
    dues,
    trailing: { visits: visits.trailingVisits, workValueUsd: visits.trailingWorkUsd, prepaySalesUsd3m },
    bankLines: bankLines.map((l) => ({ ...l, amount: usd(l.amount) })),
    poolAccounts: pool.poolAccounts,
    feedCards: pool.feedCards,
    payroll: [
      ...payroll.filter((p) => p.pay_day >= d.today).map((p) => ({ payDay: p.pay_day, cashCostUsd: usd(p.net_cents) / 100 })),
      ...projectPayroll(payroll, { today: d.today, to: d.windowEnd }),
    ],
    taxRows: taxRows.filter((t) => t.amount_due !== null && t.amount_due !== undefined)
      .map((t) => ({ dueDay: t.due_day < d.today ? d.today : t.due_day, amountUsd: Math.max(0, usd(t.amount_due) - usd(t.amount_paid)) })),
    items,
    settings,
    missing: loaderFacts({ pool, visits, unbilled, drafts, taxRows, offFeed, stripeOk: stripeBalance.ok }),
  };
}

module.exports = { loadForecastInput, _private: { predictedCash, valueVisits, projectPayroll, payEvents } };
