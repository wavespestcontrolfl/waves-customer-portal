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
// Auto-links require EXACT cent equality; the tolerance only widens the
// candidate list shown to the operator (a near-miss is a lead, not a match).
const CANDIDATE_AMOUNT_TOLERANCE = 0.01;

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

// numeric(12,2) ceiling — a row beyond it would blow up the BULK insert and
// roll back every valid row, so it must be rejected at parse time.
const MAX_AMOUNT = 9999999999.99;

function isRealCalendarDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate(); // day 0 of next month = last day of m
}

// Accepts MM/DD/YYYY, MM/DD/YY, YYYY-MM-DD → 'YYYY-MM-DD' (calendar day,
// no timezone math — statements carry dates, not instants). Shape alone is
// not enough: 02/31/2026 or 2026-99-01 would pass regex and then abort the
// whole bulk insert at the DB, so the calendar is checked too.
function parseDateCell(raw) {
  const s = String(raw || '').trim();
  let y; let mo; let d;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) { [, y, mo, d] = m; } else {
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
    if (!m) return null;
    y = m[3].length === 2 ? `20${m[3]}` : m[3];
    mo = m[1];
    d = m[2];
  }
  if (!isRealCalendarDate(Number(y), Number(mo), Number(d))) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
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
    if (amount > MAX_AMOUNT) { skipped.push({ line, reason: 'amount exceeds storable range' }); return; }
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

// Amount+date alone is weak evidence for expense links — a coincidental
// same-price purchase in the window would silently hide a real missing
// expense. Auto-linking additionally requires a shared significant word
// between the bank description and the expense's vendor/description.
const STOPWORDS = new Set(['the', 'and', 'inc', 'llc', 'corp', 'card', 'debit', 'purchase', 'payment', 'online']);
function significantTokens(text) {
  return new Set(String(text || '').toUpperCase().split(/[^A-Z0-9]+/)
    .filter(t => t.length >= 4 && !STOPWORDS.has(t.toLowerCase())));
}
function vendorEvidence(bankDescription, expense) {
  const bankTokens = significantTokens(bankDescription);
  for (const t of significantTokens(`${expense.vendor_name || ''} ${expense.description || ''}`)) {
    if (bankTokens.has(t)) return true;
  }
  return false;
}

function centsEqual(a, b) {
  return Math.abs(Number(a) - Number(b)) < 0.005;
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

// The migration's partial unique indexes are the real double-claim guard;
// a concurrent pass that loses the race surfaces here as a unique
// violation, which just means "someone else claimed it" — skip, don't fail.
function isUniqueViolation(err) {
  return err && err.code === '23505';
}

// A deleted expense/payout SET-NULLs the FK but leaves the status behind —
// without this, ledgerCoverage (and the UI) would keep counting a row whose
// ledger side no longer exists. Deterministic self-heal at the top of every
// matching pass.
async function resetDanglingLinks() {
  const healedExpense = await db('bank_transactions')
    .whereIn('status', ['matched_expense', 'created_expense'])
    .whereNull('matched_expense_id')
    .update({ status: 'unmatched', match_method: null, matched_at: null, updated_at: new Date() });
  const healedPayout = await db('bank_transactions')
    .where({ status: 'matched_payout' })
    .whereNull('matched_payout_id')
    .update({ status: 'unmatched', match_method: null, matched_at: null, updated_at: new Date() });
  return healedExpense + healedPayout;
}

/**
 * Deterministic matching over currently-unmatched rows.
 *  - credits → stripe_payouts by exact cent equality within an arrival-date
 *    window, single unclaimed candidate only.
 *  - debits → expenses by exact cent equality within a date window PLUS
 *    shared vendor evidence, single unclaimed candidate only. Near-miss or
 *    evidence-less candidates park for the operator.
 * Serial and idempotent: re-running never relinks or double-claims (CAS on
 * status + DB-level partial unique indexes on the matched FKs).
 */
async function runDeterministicMatching() {
  const healed = await resetDanglingLinks();
  const unmatched = await db('bank_transactions')
    .where({ status: 'unmatched' })
    .orderBy('txn_date', 'asc')
    .select('id', 'txn_date', 'description', 'amount', 'direction', 'suggestion');
  const summary = { scanned: unmatched.length, payoutsLinked: 0, expensesLinked: 0, transferFlagged: 0, ambiguous: 0, healed };

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
        // Only money that actually REACHED the bank can explain a bank
        // credit — pending/in-transit/canceled/failed payouts are excluded.
        .where('status', 'paid')
        .whereBetween('arrival_date', [
          new Date(`${addDays(row.txn_date, -PAYOUT_DATE_WINDOW_DAYS)}T00:00:00Z`),
          new Date(`${addDays(row.txn_date, PAYOUT_DATE_WINDOW_DAYS + 1)}T00:00:00Z`),
        ])
        .whereRaw('abs(amount - ?) <= ?', [row.amount, CANDIDATE_AMOUNT_TOLERANCE])
        .whereNotExists(function claimed() {
          this.select(1).from('bank_transactions as bt').whereRaw('bt.matched_payout_id = stripe_payouts.id');
        })
        .select('id', 'amount')
        .limit(2);
      const exact = candidates.filter(c => centsEqual(c.amount, row.amount));
      if (candidates.length === 1 && exact.length === 1) {
        try {
          const changed = await db('bank_transactions')
            .where({ id: row.id, status: 'unmatched' })
            .update({ status: 'matched_payout', matched_payout_id: exact[0].id, match_method: 'payout_amount_date', matched_at: new Date(), updated_at: new Date() });
          if (changed) summary.payoutsLinked++;
        } catch (err) {
          if (!isUniqueViolation(err)) throw err; // lost the claim race — skip
        }
      } else if (candidates.length > 1) {
        summary.ambiguous++;
      }
      continue;
    }

    const candidates = await db('expenses')
      .whereBetween('expense_date', [addDays(row.txn_date, -EXPENSE_DATE_WINDOW_DAYS), addDays(row.txn_date, EXPENSE_DATE_WINDOW_DAYS)])
      .whereRaw('abs(amount - ?) <= ?', [row.amount, CANDIDATE_AMOUNT_TOLERANCE])
      .whereNotExists(function claimed() {
        this.select(1).from('bank_transactions as bt').whereRaw('bt.matched_expense_id = expenses.id');
      })
      // UNBOUNDED on purpose: uniqueness must be judged over the COMPLETE
      // candidate set — a cap could hide a second strong candidate and fake
      // "exactly one". The ±5-day amount-filtered window keeps this small;
      // only the operator-facing suggestion list below is bounded.
      .select('id', 'amount', 'description', 'vendor_name', 'expense_date');
    // Auto-link needs exact cents + vendor evidence + a single such candidate.
    const strong = candidates.filter(c => centsEqual(c.amount, row.amount) && vendorEvidence(row.description, c));
    if (strong.length === 1) {
      try {
        const changed = await db('bank_transactions')
          .where({ id: row.id, status: 'unmatched' })
          .update({ status: 'matched_expense', matched_expense_id: strong[0].id, match_method: 'expense_amount_date_vendor', matched_at: new Date(), updated_at: new Date() });
        if (changed) summary.expensesLinked++;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err; // lost the claim race — skip
      }
    } else if (candidates.length > 0) {
      summary.ambiguous++;
      await db('bank_transactions').where({ id: row.id, status: 'unmatched' }).update({
        suggestion: { ...(row.suggestion || {}), candidates: candidates.slice(0, 6).map(c => ({ id: c.id, description: c.description, vendor_name: c.vendor_name, expense_date: c.expense_date })) },
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
 * Covered is derived from the SURVIVING FK, not status alone — a deleted
 * expense SET-NULLs the link and must stop counting immediately, even
 * before the next matching pass heals the stale status.
 */
async function ledgerCoverage(year) {
  const rows = await db('bank_transactions')
    .where('direction', 'debit')
    .whereNot('status', 'ignored')
    .whereRaw('extract(year from txn_date) = ?', [Number(year)])
    .select(
      db.raw("to_char(txn_date, 'YYYY-MM') as month"),
      db.raw('sum(amount) as total'),
      db.raw("sum(amount) filter (where status in ('matched_expense','created_expense') and matched_expense_id is not null) as covered"),
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
  vendorEvidence,
  significantTokens,
};
