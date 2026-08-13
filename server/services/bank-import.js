/**
 * Bank Import — CSV statement parsing, row identity, and deterministic
 * matching against the money the system already knows about.
 *
 * Feeds the bank_transactions STAGING table only (see the migration header):
 * nothing here writes to `expenses` — expense creation stays an explicit
 * route action so the ledger the P&L reads never grows from a parse.
 *
 * Matching policy (hands-off rule): only exact, single-candidate matches
 * auto-link, with match_method recorded as the audit trail. Anything fuzzy —
 * several candidates, amount-only-close, transfer-looking descriptions —
 * parks as a suggestion for the operator.
 */

const crypto = require('crypto');
const { parse } = require('csv-parse/sync');
const db = require('../models/db');

const PAYOUT_DATE_WINDOW_DAYS = 3;  // Stripe arrival vs bank posting drift
const EXPENSE_DATE_WINDOW_DAYS = 5; // receipt date vs card posting drift
const AMOUNT_TOLERANCE = 0.01;

// Descriptions that mean "money moving between Adam's own accounts" — a
// checking-side card payment plus the card's individual purchases would
// double-count if the payment row became an expense. Heuristic, so it only
// ever SUGGESTS ignore; the operator confirms.
const TRANSFER_RE = /\b(transfer|crcardpmt|cr card pmt|cardmember|autopay|capital one.{0,20}pymt|payment thank you|online pymt|withdrawal to sav|deposit from sav)\b/i;

function normalizeHeader(h) {
  return String(h || '').replace(/^﻿/, '').trim().toLowerCase();
}

function parseAmount(raw) {
  if (raw === null || raw === undefined) return null;
  const cleaned = String(raw).replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  if (cleaned === '' || cleaned === '-') return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

// Accepts MM/DD/YYYY, MM/DD/YY, YYYY-MM-DD → 'YYYY-MM-DD' (calendar day,
// no timezone math — statements carry dates, not instants).
function parseDateCell(raw) {
  const s = String(raw || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  return null;
}

function pick(row, names) {
  for (const n of names) {
    if (row[n] !== undefined && String(row[n]).trim() !== '') return row[n];
  }
  return undefined;
}

/**
 * Parse a statement CSV into normalized rows. Handles Capital One's credit
 * card export (Debit/Credit columns), Capital One's checking export
 * (Transaction Amount + Transaction Type), and a generic fallback (signed
 * Amount column). Returns { rows, skipped } — a bad row is skipped with a
 * reason, never a throw, so one mangled line doesn't kill the upload.
 */
function parseStatementCsv(csvText) {
  let records;
  try {
    records = parse(csvText, { columns: (headers) => headers.map(normalizeHeader), skip_empty_lines: true, trim: true, bom: true, relax_column_count: true });
  } catch (err) {
    const e = new Error(`CSV parse failed: ${err.message}`);
    e.status = 400;
    throw e;
  }
  const rows = [];
  const skipped = [];
  records.forEach((rec, i) => {
    const line = i + 2; // 1-based + header row
    const date = parseDateCell(pick(rec, ['transaction date', 'date', 'posted date']));
    const description = String(pick(rec, ['description', 'transaction description', 'payee', 'memo']) || '').trim().slice(0, 500);
    if (!date) { skipped.push({ line, reason: 'unparseable date' }); return; }
    if (!description) { skipped.push({ line, reason: 'missing description' }); return; }

    let amount = null;
    let direction = null;
    const debitCell = parseAmount(rec.debit);
    const creditCell = parseAmount(rec.credit);
    if (debitCell !== null || creditCell !== null) {
      // Card format: exactly one of Debit/Credit is populated per row.
      if (debitCell !== null && creditCell !== null) { skipped.push({ line, reason: 'both debit and credit populated' }); return; }
      amount = debitCell !== null ? debitCell : creditCell;
      direction = debitCell !== null ? 'debit' : 'credit';
      if (amount < 0) { amount = Math.abs(amount); direction = direction === 'debit' ? 'credit' : 'debit'; }
    } else {
      const amtCell = parseAmount(pick(rec, ['transaction amount', 'amount']));
      if (amtCell === null) { skipped.push({ line, reason: 'unparseable amount' }); return; }
      const typeCell = String(pick(rec, ['transaction type', 'type']) || '').trim().toLowerCase();
      if (typeCell === 'debit' || typeCell === 'credit') {
        direction = typeCell;
        amount = Math.abs(amtCell);
      } else {
        // Generic signed amount: negative = outflow.
        direction = amtCell < 0 ? 'debit' : 'credit';
        amount = Math.abs(amtCell);
      }
    }
    if (amount === 0) { skipped.push({ line, reason: 'zero amount' }); return; }
    rows.push({ txn_date: date, description, amount, direction });
  });
  return { rows, skipped };
}

/**
 * Stable per-row identity for dedupe across overlapping uploads. Identical
 * tuples within one file get an occurrence ordinal, so two real $58.12
 * fill-ups on the same day survive while the same statement uploaded twice
 * collapses to nothing.
 */
function withRowHashes(accountLabel, rows) {
  const seen = new Map();
  return rows.map(r => {
    const desc = r.description.replace(/\s+/g, ' ').toUpperCase();
    const tuple = `${accountLabel}|${r.txn_date}|${desc}|${r.amount.toFixed(2)}|${r.direction}`;
    const ordinal = seen.get(tuple) || 0;
    seen.set(tuple, ordinal + 1);
    const row_hash = crypto.createHash('sha256').update(`${tuple}|${ordinal}`).digest('hex');
    return { ...r, row_hash };
  });
}

function transferSuggestion(description) {
  const m = TRANSFER_RE.exec(description);
  if (!m) return null;
  return { ignore: true, reason: `looks like an internal transfer/card payment ("${m[0].trim()}") — counting it would double the card's own purchases` };
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Deterministic matching over currently-unmatched rows.
 *  - credits → stripe_payouts by exact amount within an arrival-date window,
 *    single unclaimed candidate only (a payout links to at most one bank row).
 *  - debits → expenses by exact amount within a date window, single unclaimed
 *    candidate only. Multiple candidates park with the candidate list.
 * Serial and idempotent: re-running never relinks or double-claims.
 */
async function runDeterministicMatching() {
  const unmatched = await db('bank_transactions')
    .where({ status: 'unmatched' })
    .orderBy('txn_date', 'asc')
    .select('id', 'txn_date', 'description', 'amount', 'direction', 'suggestion');
  const summary = { scanned: unmatched.length, payoutsLinked: 0, expensesLinked: 0, transferFlagged: 0, ambiguous: 0 };

  for (const row of unmatched) {
    const transfer = transferSuggestion(row.description);
    if (transfer) {
      if (!row.suggestion || !row.suggestion.ignore) {
        await db('bank_transactions').where({ id: row.id, status: 'unmatched' }).update({ suggestion: transfer, updated_at: new Date() });
        summary.transferFlagged++;
      }
      continue; // transfer-looking rows never auto-match anything
    }

    if (row.direction === 'credit') {
      const candidates = await db('stripe_payouts')
        .whereBetween('arrival_date', [
          new Date(`${addDays(row.txn_date, -PAYOUT_DATE_WINDOW_DAYS)}T00:00:00Z`),
          new Date(`${addDays(row.txn_date, PAYOUT_DATE_WINDOW_DAYS + 1)}T00:00:00Z`),
        ])
        .whereRaw('abs(amount - ?) <= ?', [row.amount, AMOUNT_TOLERANCE])
        .whereNotExists(function claimed() {
          this.select(1).from('bank_transactions as bt').whereRaw('bt.matched_payout_id = stripe_payouts.id');
        })
        .select('id')
        .limit(2);
      if (candidates.length === 1) {
        const changed = await db('bank_transactions')
          .where({ id: row.id, status: 'unmatched' })
          .update({ status: 'matched_payout', matched_payout_id: candidates[0].id, match_method: 'payout_amount_date', matched_at: new Date(), updated_at: new Date() });
        if (changed) summary.payoutsLinked++;
      } else if (candidates.length > 1) {
        summary.ambiguous++;
      }
      continue;
    }

    const candidates = await db('expenses')
      .whereBetween('expense_date', [addDays(row.txn_date, -EXPENSE_DATE_WINDOW_DAYS), addDays(row.txn_date, EXPENSE_DATE_WINDOW_DAYS)])
      .whereRaw('abs(amount - ?) <= ?', [row.amount, AMOUNT_TOLERANCE])
      .whereNotExists(function claimed() {
        this.select(1).from('bank_transactions as bt').whereRaw('bt.matched_expense_id = expenses.id');
      })
      .select('id', 'description', 'vendor_name', 'expense_date')
      .limit(6);
    if (candidates.length === 1) {
      const changed = await db('bank_transactions')
        .where({ id: row.id, status: 'unmatched' })
        .update({ status: 'matched_expense', matched_expense_id: candidates[0].id, match_method: 'expense_amount_date', matched_at: new Date(), updated_at: new Date() });
      if (changed) summary.expensesLinked++;
    } else if (candidates.length > 1) {
      summary.ambiguous++;
      await db('bank_transactions').where({ id: row.id, status: 'unmatched' }).update({
        suggestion: { candidates: candidates.map(c => ({ id: c.id, description: c.description, vendor_name: c.vendor_name, expense_date: c.expense_date })) },
        updated_at: new Date(),
      });
    }
  }
  return summary;
}

/**
 * Monthly ledger coverage for a year: of the bank outflow that plausibly
 * belongs in the books (debits minus operator-ignored rows), how much is
 * represented by a linked or created expense? The honest Schedule C signal.
 */
async function ledgerCoverage(year) {
  const rows = await db('bank_transactions')
    .where('direction', 'debit')
    .whereNot('status', 'ignored')
    .whereRaw('extract(year from txn_date) = ?', [Number(year)])
    .select(
      db.raw("to_char(txn_date, 'YYYY-MM') as month"),
      db.raw('sum(amount) as total'),
      db.raw("sum(amount) filter (where status in ('matched_expense','created_expense')) as covered"),
    )
    .groupByRaw("to_char(txn_date, 'YYYY-MM')")
    .orderBy('month');
  return rows.map(r => {
    const total = Number(r.total) || 0;
    const covered = Number(r.covered) || 0;
    return { month: r.month, total, covered, unexplained: Math.round((total - covered) * 100) / 100, pct: total > 0 ? Math.round((covered / total) * 100) : null };
  });
}

module.exports = {
  parseStatementCsv,
  withRowHashes,
  transferSuggestion,
  runDeterministicMatching,
  ledgerCoverage,
  // exported for tests
  parseAmount,
  parseDateCell,
  addDays,
};
