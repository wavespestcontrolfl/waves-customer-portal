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
const logger = require('./logger');
const { etMonthStart, etMonthEnd, etDateString, addETDays } = require('../utils/datetime-et');
const { dateOnlyString } = require('../utils/date-only');

// NET term → days the statement is due after its close date.
const STATEMENT_TERM_DAYS = { net15: 15, net30: 30 };

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
 *
 * MUST run inside the caller's transaction (create/edit/void all pass their trx):
 * it takes `SELECT … FOR UPDATE` on the statement row BEFORE reading the invoice
 * aggregate, so concurrent rollups serialize on the row. Without the lock, a void
 * could read a snapshot that excludes a concurrent edit, block on the final
 * UPDATE, then overwrite the edit's freshly-computed total once that lock frees.
 * (Re-locking a row the same transaction already holds is a no-op.)
 */
async function rollupStatement(statementId, database = db) {
  const stmt = await database('payer_statements').where({ id: statementId }).forUpdate().first('id', 'status');
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

/**
 * P2 — Finalize (close) an OPEN statement: freeze totals + the payer bill-to
 * snapshot + the due date, and flip `open → finalized`. After this, the statement
 * is a billed document; getOrCreateOpenStatement opens the NEXT period for any
 * late visit. Idempotent — a non-open statement is returned unchanged.
 *
 * MUST run inside a transaction. Takes the SAME per-(payer, period) advisory lock
 * as accrual FIRST (so a concurrent visit either attaches before we freeze, or
 * finds the statement non-open and advances), then row-locks the statement
 * (`FOR UPDATE`) before freezing — no stale total, no invoice landing after close.
 */
async function finalizeStatement(statementId, { database = db, date = new Date() } = {}) {
  const head = await database('payer_statements')
    .where({ id: statementId })
    .first('id', 'payer_id', 'period_start', 'status');
  if (!head) throw new Error('finalizeStatement: statement not found');
  if (head.status !== 'open') {
    return database('payer_statements').where({ id: statementId }).first();
  }

  // Advisory lock first (matches getOrCreateOpenStatement's order), then row lock.
  // The key MUST be byte-identical to accrual's `${pid}|${etMonthStart()}` —
  // `period_start` comes back from a DATE column as a JS Date, so normalize it to
  // the same 'YYYY-MM-DD' string accrual locks on. Interpolating the raw Date
  // (`Fri May 01 2026 …`) would key a DIFFERENT lock and silently defeat the
  // serialization, letting a late invoice attach after the freeze.
  const periodKey = dateOnlyString(head.period_start);
  await database.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))', [
    'payer.statement.open',
    `${Number(head.payer_id)}|${periodKey}`,
  ]);
  const stmt = await database('payer_statements').where({ id: statementId }).forUpdate().first();
  if (!stmt || stmt.status !== 'open') {
    // Raced a concurrent finalize — return the now-frozen row.
    return database('payer_statements').where({ id: statementId }).first();
  }

  // Final rollup from attached non-void invoices while still open.
  await rollupStatement(statementId, database);
  const fresh = await database('payer_statements').where({ id: statementId }).first();

  // Freeze the payer bill-to from the CURRENT live payer (mirrors
  // invoices.payer_snapshot). Never block the close on a payer read — fall back
  // to the statement's existing snapshot.
  let snapshot = fresh.payer_snapshot || null;
  try {
    const PayerService = require('./payer');
    const payer = await PayerService.getPayer(fresh.payer_id, database);
    if (payer) snapshot = PayerService.payerSnapshot(payer);
  } catch (err) {
    logger.warn(`[payer-statements] finalize: payer snapshot refresh failed for statement ${statementId}: ${err.message}`);
  }

  const termDays = STATEMENT_TERM_DAYS[fresh.terms_snapshot] || 30;
  const dueDate = etDateString(addETDays(date, termDays)); // statement-dated NET (ET)

  const patch = {
    status: 'finalized',
    finalized_at: database.fn.now(),
    due_date: dueDate,
    updated_at: database.fn.now(),
  };
  if (snapshot) patch.payer_snapshot = JSON.stringify(snapshot);

  const [updated] = await database('payer_statements')
    .where({ id: statementId, status: 'open' })
    .update(patch)
    .returning('*');
  return updated;
}

/**
 * The attached, non-void invoices for a statement — one row per billed visit,
 * with the homeowner (service address) for the consolidated PDF / email.
 * Ordered by service date so the statement reads as a chronological ledger.
 */
async function loadStatementLines(statementId, database = db) {
  return database('invoices as i')
    .leftJoin('customers as c', 'c.id', 'i.customer_id')
    .where('i.payer_statement_id', statementId)
    .whereNot('i.status', 'void')
    .orderBy([{ column: 'i.service_date', order: 'asc' }, { column: 'i.id', order: 'asc' }])
    .select(
      'i.invoice_number',
      'i.service_date',
      'i.service_type',
      'i.subtotal',
      'i.tax_amount',
      'i.total',
      database.raw(
        "COALESCE(NULLIF(TRIM(CONCAT(COALESCE(c.first_name,''),' ',COALESCE(c.last_name,''))),''), c.company_name) AS customer_name",
      ),
      database.raw("COALESCE(c.address_line1, '') AS service_address"),
    );
}

module.exports = {
  getOrCreateOpenStatement,
  rollupStatement,
  finalizeStatement,
  loadStatementLines,
  periodFor,
  generateStatementToken,
  STATEMENT_TERM_DAYS,
};
