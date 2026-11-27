/**
 * Idempotent Subledger-to-GL Sync Bridge.
 *
 * Reads Waves' operational tables (invoices, payments, stripe_payouts, expenses,
 * finalized payroll_runs) for an Eastern-calendar date range and posts balanced
 * Journal Entries via posting-rules.js + ledger.postJournalEntry().
 *
 * Safe to re-run repeatedly: every entry uses a deterministic idempotency_key so
 * previously posted items skip cleanly.
 */

const db = require('../../models/db');
const { etDateString } = require('../../utils/datetime-et');
const { SYSTEM_CODES, ensureSystemAccounts, dollarsToCents } = require('./coa-seed');
const { assertValidDate, postJournalEntry } = require('./ledger');
const rules = require('./posting-rules');

function dateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date && !Number.isNaN(value.getTime())) return etDateString(value);
  return null;
}

function paymentAccountCodeForExpense(paymentMethod) {
  const m = String(paymentMethod || '').toLowerCase();
  if (m === 'card' || m === 'credit_card' || m === 'credit') return SYSTEM_CODES.CREDIT_CARD_PRIMARY;
  return SYSTEM_CODES.CHECKING_PRIMARY;
}

async function postOrPreview(entryInput, { dryRun, actorId, requestMeta, stats, bucket }) {
  if (dryRun) {
    stats[bucket].would_post += 1;
    return;
  }
  try {
    const res = await postJournalEntry(entryInput, { actorId, requestMeta });
    if (res.created) stats[bucket].posted += 1;
    else stats[bucket].skipped += 1;
  } catch (err) {
    stats[bucket].errors.push({ idempotencyKey: entryInput.idempotencyKey, message: err.message });
  }
}

async function syncInvoices(conn, from, to, ctx) {
  if (!(await conn.schema.hasTable('invoices'))) return;
  const rows = await conn('invoices as i')
    .leftJoin('customers as c', 'c.id', 'i.customer_id')
    .whereNotIn('i.status', ['draft', 'void', 'cancelled', 'canceled'])
    .whereNull('i.archived_at')
    .whereRaw('COALESCE(c.is_test_account, false) = false')
    .whereRaw(
      "COALESCE(i.service_date, DATE(i.sent_at AT TIME ZONE 'America/New_York'), DATE(i.created_at AT TIME ZONE 'America/New_York')) BETWEEN ?::date AND ?::date",
      [from, to],
    )
    .select(
      'i.id', 'i.invoice_number', 'i.customer_id', 'i.subtotal', 'i.discount_amount', 'i.tax_amount', 'i.total',
      'i.service_type', 'i.annual_prepay_covered_start', 'i.service_date', 'i.sent_at', 'i.created_at',
      'c.property_type',
    );

  for (const inv of rows) {
    const issueDate = dateOnly(inv.service_date) || dateOnly(inv.sent_at) || dateOnly(inv.created_at);
    const totalCents = dollarsToCents(inv.total);
    const taxCents = dollarsToCents(inv.tax_amount || 0) || 0;
    const netSubtotalCents = totalCents != null ? Math.max(0, totalCents - taxCents) : 0;
    if (!issueDate || netSubtotalCents + taxCents <= 0) continue;

    const entry = rules.buildInvoiceEntry({
      invoiceId: inv.id,
      invoiceNumber: inv.invoice_number,
      issueDate,
      subtotalCents: netSubtotalCents,
      taxCents,
      serviceLine: inv.service_type || 'pest',
      isCommercial: String(inv.property_type || '').toLowerCase() === 'commercial',
      isAnnualPrepay: Boolean(inv.annual_prepay_covered_start),
      customerId: inv.customer_id,
    });
    await postOrPreview(entry, { ...ctx, bucket: 'invoices' });
  }
}

async function syncPayments(conn, from, to, ctx) {
  if (!(await conn.schema.hasTable('payments'))) return;
  const rows = await conn('payments as p')
    .leftJoin('customers as c', 'c.id', 'p.customer_id')
    .whereIn('p.status', ['paid', 'refunded'])
    .whereRaw('COALESCE(c.is_test_account, false) = false')
    .whereRaw(
      "COALESCE(p.payment_date, DATE(p.created_at AT TIME ZONE 'America/New_York')) BETWEEN ?::date AND ?::date",
      [from, to],
    )
    .select(
      'p.id', 'p.customer_id', 'p.amount', 'p.payment_method',
      'p.stripe_payment_intent_id', 'p.payment_date', 'p.created_at', 'p.invoice_id',
    );

  for (const pay of rows) {
    const paymentDate = dateOnly(pay.payment_date) || dateOnly(pay.created_at);
    const grossCents = dollarsToCents(pay.amount);
    if (!paymentDate || !grossCents || grossCents <= 0) continue;

    const method = pay.stripe_payment_intent_id ? 'stripe' : (pay.payment_method || 'stripe');
    const entry = rules.buildPaymentEntry({
      paymentId: pay.id,
      paymentDate,
      grossCents,
      feeCents: 0,
      method,
      isDeposit: !pay.invoice_id,
      customerId: pay.customer_id,
      reference: pay.stripe_payment_intent_id || pay.id,
    });
    await postOrPreview(entry, { ...ctx, bucket: 'payments' });
  }
}

async function syncStripePayouts(conn, from, to, ctx) {
  if (!(await conn.schema.hasTable('stripe_payouts'))) return;
  const rows = await conn('stripe_payouts')
    .where({ status: 'paid' })
    .whereRaw("DATE(arrival_date AT TIME ZONE 'America/New_York') BETWEEN ?::date AND ?::date", [from, to])
    .select('id', 'stripe_payout_id', 'amount', 'arrival_date');

  for (const p of rows) {
    const arrivalDate = dateOnly(p.arrival_date);
    const amountCents = dollarsToCents(p.amount);
    if (!arrivalDate || !amountCents || amountCents <= 0) continue;

    const entry = rules.buildStripePayoutEntry({
      payoutId: p.id,
      arrivalDate,
      amountCents,
      reference: p.stripe_payout_id || p.id,
    });
    await postOrPreview(entry, { ...ctx, bucket: 'stripe_payouts' });
  }
}

async function syncExpenses(conn, from, to, ctx) {
  if (!(await conn.schema.hasTable('expenses'))) return;
  const glAccounts = await conn('gl_accounts')
    .whereNotNull('expense_category_id')
    .select('id', 'code', 'expense_category_id', 'schedule_c_line');
  const glByCatId = new Map(glAccounts.map((a) => [a.expense_category_id, a]));

  const rows = await conn('expenses as e')
    .leftJoin('expense_categories as c', 'c.id', 'e.category_id')
    .whereBetween('e.expense_date', [from, to])
    .whereRaw("COALESCE(c.name, '') <> 'Payroll (counted from pay runs)'")
    .whereRaw("COALESCE(c.irs_line, '') NOT IN ('13', '30')")
    .select(
      'e.id', 'e.category_id', 'e.description', 'e.amount', 'e.tax_deductible_amount',
      'e.expense_date', 'e.vendor_name', 'e.payment_method', 'e.scheduled_service_id',
    );

  for (const exp of rows) {
    const entryDate = dateOnly(exp.expense_date);
    const amountCents = dollarsToCents(exp.amount);
    if (!entryDate || !amountCents || amountCents <= 0) continue;

    const mapped = exp.category_id ? glByCatId.get(exp.category_id) : null;
    const dedCents = exp.tax_deductible_amount != null ? dollarsToCents(exp.tax_deductible_amount) : amountCents;
    const splits = [];

    if (mapped && mapped.schedule_c_line !== '24b' && dedCents != null && dedCents > 0 && dedCents < amountCents) {
      splits.push({ accountId: mapped.id, amountCents: dedCents, scheduledServiceId: exp.scheduled_service_id });
      splits.push({ accountCode: SYSTEM_CODES.OWNER_DRAWS, amountCents: amountCents - dedCents, memo: 'Personal share' });
    } else {
      splits.push({
        accountId: mapped ? mapped.id : null,
        accountCode: mapped ? null : SYSTEM_CODES.OPEX_UNCATEGORIZED,
        amountCents,
        scheduledServiceId: exp.scheduled_service_id,
      });
    }

    const entry = rules.buildExpenseEntry({
      sourceType: 'expense',
      sourceId: exp.id,
      entryDate,
      paymentAccountCode: paymentAccountCodeForExpense(exp.payment_method),
      splits,
      memo: [exp.vendor_name, exp.description].filter(Boolean).join(' — ').slice(0, 500) || 'Expense',
    });
    await postOrPreview(entry, { ...ctx, bucket: 'expenses' });
  }
}

function intCents(v) {
  return Math.trunc(Number(v) || 0);
}

function summarizePayrollChecks(checks) {
  const totals = {
    fieldGrossCents: 0,
    adminGrossCents: 0,
    fieldEmployerTaxCents: 0,
    adminEmployerTaxCents: 0,
    employeeTaxWithheldCents: 0,
    employeeSimpleDeferralCents: 0,
    employerSimpleCents: 0,
    employerHsaCents: 0,
    netPayCents: 0,
  };
  for (const c of checks) {
    const gross = intCents(c.gross_cents);
    const erTax = intCents(c.employer_social_security_cents) + intCents(c.employer_medicare_cents)
      + intCents(c.futa_cents) + intCents(c.fl_reemployment_cents);
    if (String(c.role || '').toLowerCase() === 'admin') {
      totals.adminGrossCents += gross;
      totals.adminEmployerTaxCents += erTax;
    } else {
      totals.fieldGrossCents += gross;
      totals.fieldEmployerTaxCents += erTax;
    }
    totals.employeeTaxWithheldCents += intCents(c.federal_income_tax_cents) + intCents(c.social_security_cents)
      + intCents(c.medicare_cents) + intCents(c.additional_medicare_cents);
    totals.employeeSimpleDeferralCents += intCents(c.simple_deferral_cents);
    totals.employerSimpleCents += intCents(c.simple_employer_cents);
    totals.employerHsaCents += intCents(c.hsa_employer_cents);
    totals.netPayCents += intCents(c.net_cents);
  }
  return totals;
}

async function syncPayrollRuns(conn, from, to, ctx) {
  if (!(await conn.schema.hasTable('payroll_runs')) || !(await conn.schema.hasTable('payroll_checks'))) return;
  const runs = await conn('payroll_runs')
    .where({ status: 'finalized' })
    .whereBetween('pay_date', [from, to])
    .select('id', 'week_start', 'pay_date');

  for (const run of runs) {
    const checks = await conn('payroll_checks as pc')
      .leftJoin('technicians as t', 't.id', 'pc.technician_id')
      .where('pc.run_id', run.id)
      .where('pc.status', 'finalized')
      .select('pc.*', 't.role');

    const totals = summarizePayrollChecks(checks);
    const totalDebits = totals.fieldGrossCents + totals.adminGrossCents + totals.employerSimpleCents + totals.employerHsaCents;
    if (totalDebits <= 0) continue;

    const entry = rules.buildPayrollRunEntry({
      runId: run.id,
      payDate: dateOnly(run.pay_date),
      weekLabel: `Week of ${dateOnly(run.week_start)}`,
      ...totals,
    });
    await postOrPreview(entry, { ...ctx, bucket: 'payroll_runs' });
  }
}

async function syncSubledgersToGl({ fromDate = null, toDate = null, dryRun = false, actorId = null, requestMeta = {}, conn = db } = {}) {
  const today = etDateString(new Date());
  const from = assertValidDate(fromDate || `${today.slice(0, 4)}-01-01`, 'fromDate');
  const to = assertValidDate(toDate || today, 'toDate');
  await ensureSystemAccounts(conn);

  const makeBucket = () => ({ posted: 0, skipped: 0, would_post: 0, errors: [] });
  const stats = {
    from,
    to,
    dry_run: Boolean(dryRun),
    invoices: makeBucket(),
    payments: makeBucket(),
    stripe_payouts: makeBucket(),
    expenses: makeBucket(),
    payroll_runs: makeBucket(),
  };

  const ctx = { dryRun: Boolean(dryRun), actorId, requestMeta, stats };
  await syncInvoices(conn, from, to, ctx);
  await syncPayments(conn, from, to, ctx);
  await syncStripePayouts(conn, from, to, ctx);
  await syncExpenses(conn, from, to, ctx);
  await syncPayrollRuns(conn, from, to, ctx);

  return stats;
}

module.exports = {
  syncSubledgersToGl,
};
