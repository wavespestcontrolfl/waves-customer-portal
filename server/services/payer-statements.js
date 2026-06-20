/**
 * Third-party Payer Phase 2 — statement accrual core (P1).
 *
 * A NET-terms payer invoice is held from individual AP delivery and ATTACHED to
 * the OPEN statement for its (payer, calendar-month period). The statement is the
 * unit of send/pay/AR/dunning; this module owns the open-statement get-or-create
 * and the rollup. Close / delivery / payment land in later phases.
 *
 * Design: docs/design/payer-net-statements-plan.md.
 */

const crypto = require('crypto');
const db = require('../models/db');
const { etMonthStart, etMonthEnd } = require('../utils/datetime-et');

function generateStatementToken() {
  return crypto.randomBytes(32).toString('hex');
}

// The ET calendar-month accrual period (offset 0 = this month, +1 = next, …).
function periodFor(date = new Date(), offset = 0) {
  return { period_start: etMonthStart(date, offset), period_end: etMonthEnd(date, offset) };
}

/**
 * Get (or create) the OPEN statement a NET-terms payer invoice should accrue to.
 *
 * MUST be called inside a transaction: the `pg_advisory_xact_lock` keyed on
 * (payer, period) is released at transaction end, serializing concurrent
 * accruals so two completing visits attach to ONE statement (the partial unique
 * index `(payer_id, period_start) WHERE status='open'` is the final backstop).
 *
 * Late invoices after month-end close: if a NON-open statement already exists for
 * a period, that month is closed — advance to the next period instead of opening
 * a second open row for a closed month (which would carry a stale window).
 */
async function getOrCreateOpenStatement({ payerId, termsSnapshot, database = db, date = new Date() }) {
  const pid = Number(payerId);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('getOrCreateOpenStatement: invalid payerId');

  for (let offset = 0; offset < 24; offset += 1) {
    const period_start = etMonthStart(date, offset);
    const period_end = etMonthEnd(date, offset);

    await database.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))', [
      'payer.statement.open',
      `${pid}|${period_start}`,
    ]);

    const open = await database('payer_statements')
      .where({ payer_id: pid, period_start, status: 'open' })
      .first();
    if (open) return open;

    // Any non-`open` statement for this period ⇒ month already closed; advance.
    const closed = await database('payer_statements')
      .where({ payer_id: pid, period_start })
      .whereNot('status', 'open')
      .first('id');
    if (closed) continue;

    try {
      const [row] = await database('payer_statements')
        .insert({
          payer_id: pid,
          period_start,
          period_end,
          status: 'open',
          terms_snapshot: termsSnapshot,
          token: generateStatementToken(),
        })
        .returning('*');
      return row;
    } catch (err) {
      // Lost the race to a concurrent accrual (the partial unique index
      // `(payer_id, period_start) WHERE status='open'` is the real guarantee
      // when there is no caller transaction to hold the advisory lock). The
      // winner's open statement now exists — re-select it.
      const raced = await database('payer_statements')
        .where({ payer_id: pid, period_start, status: 'open' })
        .first();
      if (raced) return raced;
      throw err;
    }
  }
  throw new Error('getOrCreateOpenStatement: no open period within horizon');
}

/**
 * Recompute an OPEN statement's rollup from its attached, non-void invoices.
 * No-op once the statement is frozen (finalized+) — a billed document never
 * mutates; corrections become a credit on the next statement. Call after an
 * accrued invoice is attached, edited, or voided.
 */
async function rollupStatement(statementId, database = db) {
  const stmt = await database('payer_statements').where({ id: statementId }).first('id', 'status');
  if (!stmt || stmt.status !== 'open') return;

  const agg = await database('invoices')
    .where({ payer_statement_id: statementId })
    .whereNot('status', 'void')
    .first(
      database.raw('COALESCE(SUM(subtotal), 0)::numeric AS subtotal'),
      database.raw('COALESCE(SUM(tax_amount), 0)::numeric AS tax_amount'),
      database.raw('COALESCE(SUM(total), 0)::numeric AS total'),
      database.raw('COUNT(*)::int AS invoice_count'),
    );

  await database('payer_statements')
    .where({ id: statementId, status: 'open' })
    .update({
      subtotal: agg?.subtotal || 0,
      tax_amount: agg?.tax_amount || 0,
      total: agg?.total || 0,
      invoice_count: agg?.invoice_count || 0,
      updated_at: database.fn.now(),
    });
}

module.exports = {
  getOrCreateOpenStatement,
  rollupStatement,
  periodFor,
  generateStatementToken,
};
