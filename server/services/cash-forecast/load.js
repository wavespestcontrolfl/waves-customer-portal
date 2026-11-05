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
const { resolveBillingLane, stampedZeroFreeLive } = require('../billing-lane');
const { ALWAYS_FREE_SERVICE_TYPE_SQL_REGEX, CONSULTATION_SERVICE_TYPE_SQL_REGEX } = require('../no-cost-visit-types');
const { DUES_COHORT_COLUMNS, applyDuesCohort, autopayGuard, laneGuard, monthlyDuesVerdict } = require('../monthly-dues-eligibility');
const InvoiceService = require('../invoice');
const { invoiceAmountDue } = require('../invoice-helpers');
const { etDateString } = require('../../utils/datetime-et');
const inputs = require('./inputs');
const { _private: engine } = require('./engine');

const COHORT_DAYS = 150;
const CASH_LANES = new Set(['per_visit', 'per_application', 'one_time']);
const CLOSED_VISIT_STATUSES = ['cancelled', 'completed', 'rescheduled', 'skipped', 'no_show'];
const DEAD_INVOICE_STATUSES = InvoiceService.CANCELLED_SERVICE_RESOLVED_STATUSES;
const OPEN_INVOICE_STATUSES = ['sent', 'viewed', 'overdue', 'processing'];
const ET_DAY = (col) => `to_char((${col}) AT TIME ZONE 'America/New_York', 'YYYY-MM-DD')`;
const DAY = (col) => `to_char(${col}, 'YYYY-MM-DD')`;
const usd = (n) => Number(n) || 0;
// Cash an invoice brought in: the amount paid when it is stored (partial payments), else for a paid
// invoice its total less the credit applied (a credit is not new money).
const PAID_CASH_SQL = `CASE WHEN COALESCE(i.amount_paid, 0) > 0 THEN i.amount_paid
  WHEN i.status = 'paid' THEN GREATEST(0, COALESCE(i.total, 0) - COALESCE(i.credit_applied, 0)) ELSE 0 END`;

// The billing pages' effective visit price (admin-billing-recovery.js): the row price, else the
// customer's per-application fee for a per-application customer. With GATE_STAMPED_ZERO_FREE on, a
// stamped $0 stays $0 (only a blank price falls to the fee).
function effectivePriceSql() {
  return stampedZeroFreeLive()
    ? "COALESCE(ss.estimated_price, CASE WHEN c.billing_mode = 'per_application' THEN c.per_application_fee END, 0)"
    : "COALESCE(NULLIF(ss.estimated_price, 0), CASE WHEN c.billing_mode = 'per_application' THEN c.per_application_fee END, 0)";
}

// A visit's cash value: cash lanes only (dues lane = dues; annual prepay = paid ahead), self-pay only
// (payer-billed is listed apart), no callbacks, no always-free types, no unpriced consultations,
// less what was prepaid.
function visitValue(row) {
  if (row.payer_billed || row.is_callback || row.free_type || row.unpriced_consultation) return 0;
  if (row.annual_prepay_term_id) return 0;
  if (!CASH_LANES.has(resolveBillingLane(row).mode)) return 0;
  return Math.max(0, usd(row.effective_price) - usd(row.prepaid_amount));
}

async function readVisits(database, { from, to }) {
  return database.raw(`
    SELECT ss.id, ss.status, ${DAY('ss.scheduled_date')} AS scheduled_day,
      CASE WHEN ss.completed_at IS NULL THEN NULL ELSE ${ET_DAY('ss.completed_at')} END AS completed_day,
      ss.prepaid_amount, ss.annual_prepay_term_id,
      ${effectivePriceSql()} AS effective_price,
      (COALESCE(ss.payer_id, CASE WHEN COALESCE(ss.self_pay_override, false) THEN NULL ELSE c.payer_id END) IS NOT NULL) AS payer_billed,
      (COALESCE(ss.is_callback, false) OR EXISTS (
        SELECT 1 FROM service_records sr WHERE sr.scheduled_service_id = ss.id AND COALESCE(sr.is_callback, false))) AS is_callback,
      (COALESCE(ss.service_type, '') ~* ?) AS free_type,
      EXISTS (SELECT 1 FROM invoices i LEFT JOIN service_records sr2 ON sr2.id = i.service_record_id
        WHERE COALESCE(i.scheduled_service_id, sr2.scheduled_service_id) = ss.id AND i.status <> ALL(?::text[])) AS has_invoice,
      (COALESCE(ss.service_type, '') ~* ? AND COALESCE(ss.estimated_price, 0) <= 0) AS unpriced_consultation,
      c.billing_mode, c.waveguard_tier, c.monthly_rate
    FROM scheduled_services ss
    JOIN customers c ON c.id = ss.customer_id
    WHERE ss.scheduled_date BETWEEN ?::date AND ?::date
      AND (ss.status = 'completed' OR ss.status <> ALL(?::text[]))`,
  [ALWAYS_FREE_SERVICE_TYPE_SQL_REGEX, DEAD_INVOICE_STATUSES, CONSULTATION_SERVICE_TYPE_SQL_REGEX, from, to, CLOSED_VISIT_STATUSES]).then((r) => r.rows);
}

// Invoices behind completed visits (linked by the visit or by its service record), live ones only.
async function readVisitPayments(database, visitIds) {
  if (!visitIds.length) return [];
  return database.raw(`
    SELECT COALESCE(i.scheduled_service_id, sr.scheduled_service_id) AS visit_id,
      CASE WHEN i.paid_at IS NULL THEN NULL ELSE ${ET_DAY('i.paid_at')} END AS paid_day,
      ${PAID_CASH_SQL} AS paid_amount
    FROM invoices i
    LEFT JOIN service_records sr ON sr.id = i.service_record_id
    WHERE COALESCE(i.scheduled_service_id, sr.scheduled_service_id) = ANY(?::uuid[])
      AND i.status <> ALL(?::text[])`,
  [visitIds, DEAD_INVOICE_STATUSES]).then((r) => r.rows);
}

// Sent self-pay invoices: the timing of money after an invoice goes out (open ones included, unpaid).
async function readSentInvoices(database, { from, to }) {
  return database.raw(`
    SELECT ${ET_DAY('i.sent_at')} AS sent_day, i.total, i.credit_applied, i.status,
      CASE WHEN i.paid_at IS NULL THEN NULL ELSE ${ET_DAY('i.paid_at')} END AS paid_day,
      ${PAID_CASH_SQL} AS paid_amount
    FROM invoices i
    WHERE i.sent_at IS NOT NULL AND i.payer_id IS NULL
      AND (i.sent_at AT TIME ZONE 'America/New_York')::date BETWEEN ?::date AND ?::date
      AND i.status <> ALL(?::text[]) AND i.status <> 'prepaid'`,
  [from, to, DEAD_INVOICE_STATUSES]).then((r) => r.rows);
}

async function readOpenInvoices(database) {
  return database.raw(`
    SELECT ${ET_DAY('COALESCE(i.sent_at, i.created_at)')} AS sent_day, i.status, i.total, i.credit_applied, i.amount_paid
    FROM invoices i
    WHERE i.status = ANY(?::text[]) AND i.paid_at IS NULL AND i.archived_at IS NULL AND i.payer_id IS NULL`,
  [OPEN_INVOICE_STATUSES]).then((r) => r.rows);
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

// A finalized check pays its net (and the employer's HSA money) on the pay date; the withheld and employer
// taxes and the savings leave later, on the payroll tax rows' due dates (readTaxRows).
async function readPayroll(database, { from, to }) {
  return database.raw(`
    SELECT ${DAY('pc.pay_date')} AS pay_day,
      (COALESCE(pc.net_cents, 0) + COALESCE(pc.hsa_employer_cents, 0)) AS cost_cents
    FROM payroll_checks pc JOIN payroll_runs pr ON pr.id = pc.run_id
    WHERE pc.pay_date BETWEEN ?::date AND ?::date AND pr.status = 'finalized' AND pr.voided_at IS NULL
      AND COALESCE(pc.status, '') <> 'void'`, [from, to]).then((r) => r.rows);
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

async function loadForecastInput({
  database = db,
  now = new Date(),
  readCashBalances = plaidSync.readCashBalances,
  readStripeBalance = StripeBanking.getBalance,
} = {}) {
  const today = etDateString(now);
  const weeks = engine.buildWeeks(today);
  const windowEnd = weeks[weeks.length - 1].end;
  const day = (offset) => engine.addDays(today, offset);
  const cohortFrom = day(-COHORT_DAYS);
  const yesterday = day(-1);
  // The engine's trailing window: the 8 complete weeks before this week's Monday.
  const trailingFrom = engine.addDays(weeks[0].start, -7 * engine.TRAILING_WEEKS);
  const trailingTo = engine.addDays(weeks[0].start, -1);
  const missing = [];

  const [cash, stripeBalance, payouts, settings, items] = await Promise.all([
    readCash(readCashBalances),
    readStripe(readStripeBalance),
    readInTransit(database),
    inputs.getSettings(database),
    inputs.listItems(database),
  ]);

  // Opening pool and the accounts it covers (decision 2 A: every checking account in the feed).
  const accounts = cash?.accounts || [];
  const cards = cash?.cards || [];
  const usdOnly = (a) => String(a.currency || 'USD').toUpperCase() === 'USD';
  const balanceOf = (a) => (Number.isFinite(a.available) ? a.available : Number.isFinite(a.current) ? a.current : null);
  const counted = accounts.filter((a) => usdOnly(a) && balanceOf(a) !== null);
  const bankUsd = counted.length ? counted.reduce((s, a) => s + balanceOf(a), 0) : null;
  const cardOwedUsd = cards.filter(usdOnly).reduce((s, c) => s + (Number.isFinite(c.current) ? c.current : 0), 0);
  for (const u of cash?.unavailable || []) missing.push({ kind: 'account_unavailable', institution: u.institution_name || null, reason: u.reason, mask: u.mask || null });
  if (!cash) missing.push({ kind: 'balance_unavailable' });
  if (cards.some((c) => usdOnly(c) && !Number.isFinite(c.current))) missing.push({ kind: 'card_balance_unavailable' });
  if (!stripeBalance.ok) missing.push({ kind: 'stripe_balance_unavailable' });
  // Dollar accounts only: a line in another currency must never be added to dollar spending.
  const poolAccounts = accounts.filter(usdOnly).map((a) => a.account_label).filter(Boolean);
  const feedCards = cards.filter(usdOnly).map((c) => c.account_label).filter(Boolean);

  const [visits, sent, open, drafts, dues, prepaySalesUsd3m, bankLines, offFeed, payroll, taxRows] = await Promise.all([
    readVisits(database, { from: cohortFrom, to: windowEnd }),
    readSentInvoices(database, { from: cohortFrom, to: yesterday }),
    readOpenInvoices(database),
    readDrafts(database),
    readDues(database, { today, to: windowEnd, now }),
    readPrepaySales(database, { from: day(-91), to: yesterday }),
    // 10 days either side so a transfer or card payment pair at the window's edge still matches.
    readBankLines(database, { labels: [...poolAccounts, ...feedCards], from: engine.addDays(trailingFrom, -10), to: engine.addDays(trailingTo, 10) }),
    readCardsOffFeed(database, { feedLabels: feedCards, since: day(-120) }),
    readPayroll(database, { from: today, to: windowEnd }),
    readTaxRows(database, { from: today, to: windowEnd }),
  ]);

  // Visits: the completed ones are the collection cohort; the open ones in the window are booked work.
  const completed = [];
  const booked = [];
  let payerBilled = { count: 0 };
  let trailingVisits = 0;
  let trailingWorkUsd = 0;
  for (const v of visits) {
    const value = visitValue(v);
    if (v.status === 'completed') {
      const doneDay = v.completed_day || v.scheduled_day;
      if (doneDay < cohortFrom || doneDay > yesterday) continue;
      if (doneDay >= trailingFrom && doneDay <= trailingTo) {
        trailingVisits += 1;
        trailingWorkUsd += value;
      }
      if (value > 0) completed.push({ id: v.id, day: doneDay, value });
    } else if (v.scheduled_day >= today && v.scheduled_day <= windowEnd) {
      if (v.payer_billed) payerBilled = { count: payerBilled.count + 1 };
      // A visit already invoiced brings its cash once, as its open invoice (or a draft, listed apart),
      // but it is still booked work when the expected line compares work to last year's pace.
      booked.push({ day: v.scheduled_day, value: v.has_invoice ? 0 : value, work: value });
    }
  }
  if (payerBilled.count) missing.push({ kind: 'payer_billed_visits', count: payerBilled.count });

  const pays = await readVisitPayments(database, completed.map((v) => v.id));
  const paidBy = new Map();
  for (const p of pays) {
    const list = paidBy.get(p.visit_id) || [];
    list.push(p);
    paidBy.set(p.visit_id, list);
  }
  let unbilled = { count: 0, usd: 0 };
  const gap = engine.dayDiff;
  const visitCohort = completed.map((v) => {
    const linked = paidBy.get(v.id) || [];
    if (!linked.length && gap(v.day, today) <= 90) unbilled = { count: unbilled.count + 1, usd: unbilled.usd + v.value };
    return {
      value: v.value,
      ageDays: gap(v.day, today),
      paid: linked.filter((p) => p.paid_day && usd(p.paid_amount) > 0).map((p) => ({ lagDays: Math.max(0, gap(v.day, p.paid_day)), amount: usd(p.paid_amount) })),
    };
  });
  if (unbilled.count) missing.push({ kind: 'completed_visits_not_billed', count: unbilled.count, usd: Math.round(unbilled.usd * 100) / 100 });

  const invoiceCohort = sent.map((i) => ({
    // what the customer had to pay when it went out (the canonical amount due, before any payment)
    value: invoiceAmountDue({ total: i.total, credit_applied: i.credit_applied }),
    ageDays: gap(i.sent_day, today),
    paid: i.paid_day && usd(i.paid_amount) > 0 ? [{ lagDays: Math.max(0, gap(i.sent_day, i.paid_day)), amount: usd(i.paid_amount) }] : [],
  }));
  const openInvoices = open.map((i) => ({ amountUsd: invoiceAmountDue(i), ageDays: Math.max(0, gap(i.sent_day, today)), processing: i.status === 'processing' }));
  if (Number(drafts.n) > 0) missing.push({ kind: 'draft_invoices', count: Number(drafts.n), usd: usd(drafts.total) });

  const taxOut = [];
  let taxNoAmount = 0;
  for (const t of taxRows) {
    if (t.amount_due === null || t.amount_due === undefined) { taxNoAmount += 1; continue; }
    taxOut.push({ dueDay: t.due_day, amountUsd: Math.max(0, usd(t.amount_due) - usd(t.amount_paid)) });
  }
  if (taxNoAmount) missing.push({ kind: 'tax_rows_without_amount', count: taxNoAmount });
  for (const c of offFeed) missing.push({ kind: 'card_not_in_feed', account: c.account_label, last_day: c.last_day, debits_30d_usd: usd(c.debits_30d) });

  return {
    today,
    opening: { bankUsd, cardOwedUsd, partial: !cash || (cash.unavailable || []).length > 0 || counted.length < accounts.length },
    stripe: { availableUsd: stripeBalance.availableUsd, pendingUsd: stripeBalance.pendingUsd, payouts },
    visitCohort,
    invoiceCohort,
    booked,
    openInvoices,
    dues,
    trailing: { visits: trailingVisits, workValueUsd: trailingWorkUsd, prepaySalesUsd3m },
    bankLines: bankLines.map((l) => ({ ...l, amount: usd(l.amount) })),
    poolAccounts,
    feedCards,
    payroll: payroll.map((p) => ({ payDay: p.pay_day, cashCostUsd: usd(p.cost_cents) / 100 })),
    taxRows: taxOut,
    items,
    settings,
    missing,
  };
}

module.exports = { loadForecastInput, _private: { visitValue, effectivePriceSql } };
