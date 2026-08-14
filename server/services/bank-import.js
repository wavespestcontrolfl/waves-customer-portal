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
const logger = require('./logger');

const PAYOUT_DATE_WINDOW_DAYS = 3;  // Stripe arrival vs bank posting drift
const EXPENSE_DATE_WINDOW_DAYS = 5; // receipt date vs card posting drift
const REFUND_LOOKBACK_DAYS = 90;    // refunds lag their purchase by weeks
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
  // y < 1: PostgreSQL has no year zero — '0000-01-01' would pass shape
  // checks here and then abort the whole bulk-insert transaction at the DB
  // instead of landing in the skipped list like every other bad row.
  if (y < 1 || m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate(); // day 0 of next month = last day of m
}

// Accepts MM/DD/YYYY, MM/DD/YY, YYYY-MM-DD → 'YYYY-MM-DD' (calendar day,
// no timezone math — statements carry dates, not instants). Shape alone is
// not enough: 02/31/2026 or 2026-99-01 would pass regex and then abort the
// whole bulk insert at the DB, so the calendar is checked too.
function parseDateCell(raw) {
  const s = String(raw || '').trim();
  let y; let mo; let d;
  // Anchored to the END of the cell (an optional ISO time part is the only
  // allowed suffix): an unanchored prefix match silently imported
  // '2026-04-150' or '2026-04-15junk' as 2026-04-15 instead of skipping
  // the row with a reason like every other malformed cell.
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/);
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
    // PostgreSQL rejects NUL bytes in varchar — one corrupted cell would
    // abort the whole bulk-insert transaction instead of landing here.
    if (description.includes('\u0000')) { skipped.push({ line, reason: 'description contains a NUL byte' }); return; }

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

// Canonical row identity: label is canonicalized INSIDE the hash so
// "Capone-Checking" vs "capone-checking" can't duplicate a whole statement.
// The ordinal distinguishes genuinely identical rows (see withRowHashes and
// the force-duplicates path in the upload route).
function hashRow(accountLabel, r, ordinal) {
  const label = String(accountLabel).trim().toUpperCase();
  const desc = String(r.description).replace(/\s+/g, ' ').toUpperCase();
  const tuple = `${label}|${r.txn_date}|${desc}|${Number(r.amount).toFixed(2)}|${r.direction}`;
  return crypto.createHash('sha256').update(`${tuple}|${ordinal}`).digest('hex');
}

/**
 * Stable per-row identity for dedupe across overlapping uploads. Identical
 * tuples within one file get an occurrence ordinal, so two real $58.12
 * fill-ups on the same day survive while the same statement uploaded twice
 * collapses to nothing. The ordinal is per-FILE — a distinct identical
 * transaction arriving in a SEPARATE file is indistinguishable from a
 * re-upload, so it dedupes by default and the upload route surfaces it with
 * an explicit force-duplicates import path (ordinal continues past the
 * stored copies there).
 */
function withRowHashes(accountLabel, rows) {
  const seen = new Map();
  return rows.map(r => {
    const tuple_key = `${r.txn_date}|${String(r.description).replace(/\s+/g, ' ').toUpperCase()}|${Number(r.amount).toFixed(2)}|${r.direction}`;
    const ordinal = seen.get(tuple_key) || 0;
    seen.set(tuple_key, ordinal + 1);
    return { ...r, tuple_key, ordinal, row_hash: hashRow(accountLabel, r, ordinal) };
  });
}

// Amount+date alone is weak evidence for expense links — a coincidental
// same-price purchase in the window would silently hide a real missing
// expense. Auto-linking additionally requires a shared significant word
// between the bank description and the expense's VENDOR IDENTITY
// (vendor_name only — a free-form description that merely mentions the same
// city is coincidence, not identity). Pure numbers (store #s, card last-4s)
// and local geography are excluded for the same reason. An expense with no
// vendor_name can never auto-link; it parks for the operator instead.
const STOPWORDS = new Set(['the', 'and', 'inc', 'llc', 'corp', 'card', 'debit', 'purchase', 'payment', 'online',
  // SWFL geography that appears in half the card descriptions
  'florida', 'bradenton', 'sarasota', 'venice', 'parrish', 'palmetto', 'nokomis', 'osprey', 'ellenton', 'port', 'north', 'lakewood', 'ranch']);
function significantTokens(text) {
  return new Set(String(text || '').toUpperCase().split(/[^A-Z0-9]+/)
    .filter(t => t.length >= 4 && !/^\d+$/.test(t) && !STOPWORDS.has(t.toLowerCase())));
}
function vendorEvidence(bankDescription, expense) {
  const bankTokens = significantTokens(bankDescription);
  for (const t of significantTokens(expense.vendor_name || '')) {
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

// node-pg returns DATE columns as local-midnight Date objects — calendar
// arithmetic on the raw value shifts a day depending on server zone.
// Delegates to pnl-report's dateCellStr: ONE conversion implementation
// (a parallel copy here had already diverged on null handling), so any
// future timezone/parser fix lands everywhere at once.
const { dateCellStr } = require('./pnl-report');
function toDateStr(v) {
  return dateCellStr(v);
}

// A payout a human already reconciled may carry a DIFFERENT banked amount
// than Stripe's expected amount (discrepant confirmed reconciliation).
// Matching must compare against the money that actually hit the bank, or a
// coincidental same-expected-amount credit could hide behind it.
async function effectivePayoutAmount(candidate, dbOrTrx = db) {
  if (!candidate.reconciled) return Number(candidate.amount);
  const latest = await dbOrTrx('bank_reconciliation')
    .where('payout_id', candidate.id)
    .where('status', 'confirmed')
    .orderBy('reconciled_at', 'desc')
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .first('actual_amount');
  return latest && latest.actual_amount != null ? Number(latest.actual_amount) : Number(candidate.amount);
}

// Server-side plausibility for MANUAL links — the same amount tolerance and
// date windows the deterministic matcher uses. The UI only offers parked
// candidates (which already satisfied these), so any request outside them
// is stale or crafted and would corrupt coverage/reconciliation.
// cent-space comparison — float subtraction can't represent 0.01 exactly
function withinCandidateTolerance(a, b) {
  return Math.abs(Math.round(Number(a) * 100) - Math.round(Number(b) * 100)) <= Math.round(CANDIDATE_AMOUNT_TOLERANCE * 100);
}
function isPlausibleExpenseLink(row, expense) {
  const txnDate = toDateStr(row.txn_date);
  const expDate = toDateStr(expense.expense_date);
  return withinCandidateTolerance(expense.amount, row.amount)
    && expDate >= addDays(txnDate, -EXPENSE_DATE_WINDOW_DAYS)
    && expDate <= addDays(txnDate, EXPENSE_DATE_WINDOW_DAYS);
}
function isPlausiblePayoutLink(row, payout) {
  const txnDate = toDateStr(row.txn_date);
  const arrival = toDateStr(payout.arrival_date);
  return withinCandidateTolerance(payout.amount, row.amount)
    && arrival >= addDays(txnDate, -PAYOUT_DATE_WINDOW_DAYS)
    && arrival <= addDays(txnDate, PAYOUT_DATE_WINDOW_DAYS);
}
// Refunds already applied to an expense (the association lives in the
// refund credits' suggestion JSON — there is no FK). The expense's CURRENT
// amount plus this sum is the GROSS its original statement debit carries,
// which matters when the refund was applied BEFORE that debit was imported:
// the reduced net amount would otherwise never match the full-price debit.
async function appliedRefundTotal(expenseId, dbOrTrx = db) {
  const r = await dbOrTrx('bank_transactions')
    .where({ status: 'refund_applied' })
    .whereRaw("suggestion->>'refundAppliedTo' = ?", [String(expenseId)])
    .first(dbOrTrx.raw("coalesce(sum((suggestion->>'refundAmount')::numeric), 0) as total"));
  return Number(r && r.total) || 0;
}

// The FULL plausible refund-candidate list for one credit row. The matcher
// parks a bounded display slice of this; the on-demand route serves the
// whole set so a high-frequency vendor's off-slice original stays
// selectable through the UI. Likeliest-first, deterministic: nearest
// covering amount, then the most recent purchase, then id.
async function refundCandidatesForRow(row, dbOrTrx = db) {
  const txnDate = toDateStr(row.txn_date);
  // lookback floored at the credit's tax year: apply-refund refuses to
  // reduce a prior-year expense (rewriting filed books — the recovery is
  // current-year income), so offering one would be a guaranteed 409
  const lookbackStart = addDays(txnDate, -REFUND_LOOKBACK_DAYS);
  const yearStart = `${txnDate.slice(0, 4)}-01-01`;
  const originals = await dbOrTrx('expenses')
    .whereBetween('expense_date', [lookbackStart > yearStart ? lookbackStart : yearStart, txnDate])
    .where('amount', '>=', row.amount)
    .select('id', 'amount', 'description', 'vendor_name', 'expense_date', 'payment_method');
  const list = originals.filter(c => vendorEvidence(row.description, c) && !methodIncompatible(row.account_type, c.payment_method));
  list.sort((a, b) => (Number(a.amount) - Number(b.amount))
    || String(toDateStr(b.expense_date)).localeCompare(String(toDateStr(a.expense_date)))
    || String(a.id).localeCompare(String(b.id)));
  return list;
}

// The COMPLETE expense-candidate survey for one bank row — net and gross
// identities, unbounded (uniqueness must be judged over the full set). Used
// by the matcher, its in-transaction recheck and post-claim verify, the
// crash-recovery sweep for verifyPending claims, and the on-demand
// candidate route.
async function surveyExpenseCandidatesForRow(row, rejected, dbOrTrx = db) {
  const txnDate = toDateStr(row.txn_date);
  let expenseQuery = dbOrTrx('expenses')
    .whereBetween('expense_date', [addDays(txnDate, -EXPENSE_DATE_WINDOW_DAYS), addDays(txnDate, EXPENSE_DATE_WINDOW_DAYS)])
    .whereRaw('abs(amount - ?) <= ?', [row.amount, CANDIDATE_AMOUNT_TOLERANCE])
    // claims by OTHER rows only — excluding our own row's (nonexistent
    // pre-claim) claim keeps this survey valid for the post-claim
    // plurality verify below
    .whereNotExists(function claimed() {
      this.select(1).from('bank_transactions as bt').whereRaw('bt.matched_expense_id = expenses.id').whereRaw('bt.id <> ?', [row.id]);
    })
    // A refund-REDUCED expense is never a net candidate: its remaining
    // net amount belongs to the original gross debit, and letting a
    // coincidental same-net debit consume it would strand that debit
    // unexplained. Refunded expenses match ONLY through the gross path.
    .whereNotExists(function refunded() {
      this.select(1).from('bank_transactions as rbt')
        .whereRaw("rbt.status = 'refund_applied'")
        .whereRaw("rbt.suggestion->>'refundAppliedTo' = expenses.id::text");
    })
    // UNBOUNDED on purpose: uniqueness must be judged over the COMPLETE
    // candidate set — a cap could hide a second strong candidate and fake
    // "exactly one". The ±5-day amount-filtered window keeps this small;
    // only the operator-facing suggestion list below is bounded.
    .select('id', 'amount', 'description', 'vendor_name', 'expense_date', 'payment_method');
  if (rejected.expenseIds.length) expenseQuery = expenseQuery.whereNotIn('id', rejected.expenseIds);
  const found = await expenseQuery;
  // GROSS-amount candidates: an applied refund already REDUCED the ledger
  // expense, so a later-imported full-price debit no longer matches its
  // net amount and the row would stay unexplained (or bait a duplicate
  // create). The refund credit's suggestion carries the association —
  // join it back and match against amount + applied refunds. Coverage is
  // already refund-aware: covered caps at the CURRENT amount and the
  // refund credit nets the difference in the purchase month.
  let grossQuery = dbOrTrx('expenses as e')
    .join('bank_transactions as rbt', function refundLink() {
      this.on(db.raw("rbt.status = 'refund_applied'"))
        .andOn(db.raw("rbt.suggestion->>'refundAppliedTo' = e.id::text"));
    })
    .whereBetween('e.expense_date', [addDays(txnDate, -EXPENSE_DATE_WINDOW_DAYS), addDays(txnDate, EXPENSE_DATE_WINDOW_DAYS)])
    .whereNotExists(function claimed() {
      this.select(1).from('bank_transactions as bt').whereRaw('bt.matched_expense_id = e.id').whereRaw('bt.id <> ?', [row.id]);
    })
    .groupBy('e.id', 'e.amount', 'e.description', 'e.vendor_name', 'e.expense_date', 'e.payment_method')
    .havingRaw("abs(e.amount + sum((rbt.suggestion->>'refundAmount')::numeric) - ?) <= ?", [row.amount, CANDIDATE_AMOUNT_TOLERANCE])
    .select('e.id', 'e.amount', 'e.description', 'e.vendor_name', 'e.expense_date', 'e.payment_method',
      db.raw("e.amount + sum((rbt.suggestion->>'refundAmount')::numeric) as gross_amount"));
  if (rejected.expenseIds.length) grossQuery = grossQuery.whereNotIn('e.id', rejected.expenseIds);
  const netIds = new Set(found.map(c => c.id));
  for (const g of await grossQuery) {
    // a net match wins over its own gross reading — uniqueness is judged
    // over expense IDENTITIES, never the same expense twice
    if (!netIds.has(g.id)) found.push({ ...g, gross_amount: Number(g.gross_amount) });
  }
  return found;
}

// The COMPLETE payout-candidate survey for one bank row — amount-aware
// against the effective banked amount, excluding only OTHER rows' claims.
// Used by the matcher, its post-claim ambiguity verify, and the
// crash-recovery sweep for verifyPending payout claims.
async function surveyPayoutCandidatesForRow(row, rejected, dbOrTrx = db) {
  const txnDate = toDateStr(row.txn_date);
  let payoutQuery = dbOrTrx('stripe_payouts')
    // Only money that actually REACHED the bank can explain a bank
    // credit — pending/in-transit/canceled/failed payouts are excluded.
    .where('status', 'paid')
    // [D-3, D+3] inclusive: lower bound inclusive, upper bound strictly
    // below the D+4 midnight so the window matches its documentation.
    .where('arrival_date', '>=', new Date(`${addDays(txnDate, -PAYOUT_DATE_WINDOW_DAYS)}T00:00:00Z`))
    .andWhere('arrival_date', '<', new Date(`${addDays(txnDate, PAYOUT_DATE_WINDOW_DAYS + 1)}T00:00:00Z`))
    // Amount-aware against the EFFECTIVE banked amount (a reconciled
    // payout's latest confirmed actual_amount, else its expected
    // amount — same ordering as effectivePayoutAmount; keep in sync).
    // A bare expected-amount filter would drop the real candidate,
    // and NO filter meant the fetch cap could truncate the window
    // BEFORE amount filtering and miss the matching payout entirely.
    .joinRaw(`left join lateral (
        select actual_amount from bank_reconciliation br
        where br.payout_id = stripe_payouts.id and br.status = 'confirmed'
        order by br.reconciled_at desc, br.created_at desc, br.id desc
        limit 1
      ) latest on true`)
    // the confirmed actual applies only while the payout is CURRENTLY
    // reconciled (effectivePayoutAmount's exact semantics): after a
    // rejection/unlink the stale confirmed amount would bait an
    // exact-match claim the echo immediately reverts — an endless
    // claim/revert loop on the same credit
    .whereRaw('abs((case when stripe_payouts.reconciled then coalesce(latest.actual_amount, stripe_payouts.amount) else stripe_payouts.amount end) - ?) <= ?', [row.amount, CANDIDATE_AMOUNT_TOLERANCE])
    .whereNotExists(function claimed() {
      this.select(1).from('bank_transactions as bt').whereRaw('bt.matched_payout_id = stripe_payouts.id').whereRaw('bt.id <> ?', [row.id]);
    })
    .select('id', 'amount', 'arrival_date', 'reconciled', 'bank_last_four',
      db.raw('(case when stripe_payouts.reconciled then coalesce(latest.actual_amount, stripe_payouts.amount) else stripe_payouts.amount end) as effective_amount'))
    // 50 + 1 overflow sentinel over the now amount-filtered set, far
    // above any real same-amount count: a 51st row means uniqueness
    // would be a guess, so the row parks its candidates instead of
    // auto-linking — and still leaves the fresh pool (a bare
    // `continue` kept re-selecting it, starving newer imports while
    // offering the operator nothing).
    .limit(51);
  if (rejected.payoutIds.length) payoutQuery = payoutQuery.whereNotIn('id', rejected.payoutIds);
  const fetched = await payoutQuery;
  const bankingRejected = new Set(rejected.bankingPayoutIds);
  const found = fetched
    .map(c => ({ ...c, effective_amount: Number(c.effective_amount) }))
    .filter(c => withinCandidateTolerance(c.effective_amount, row.amount))
    // a Banking-derived rejection excludes the payout only while it
    // stands: once a corrected 'confirmed' reconciliation flips the
    // payout back to reconciled, it is eligible again
    .filter(c => !(bankingRejected.has(c.id) && !c.reconciled));
  return { candidates: found, overflow: fetched.length > 50 };
}

// Crash-recovery sweep for the post-claim plurality verify: a claim commits
// with suggestion.verifyPending, and a process exit before the verify would
// otherwise leave a possibly-ambiguous link nothing ever revisits. Bounded
// like the echo retries; the normal path clears the marker inline, so this
// sweep only ever sees crash leftovers.
async function verifyPendingExpenseClaims() {
  const fetched = await db('bank_transactions')
    .where({ status: 'matched_expense' })
    .whereRaw("suggestion->>'verifyPending' = 'true'")
    .orderBy('updated_at', 'asc')
    .orderBy('id', 'asc')
    .limit(26) // 25 + sentinel: leftovers beyond the batch feed morePending
    .select('id', 'txn_date', 'description', 'amount', 'direction', 'account_type', 'account_label', 'suggestion', 'matched_expense_id');
  const more = fetched.length > 25;
  const rows = fetched.slice(0, 25);
  let cleared = 0;
  let reverted = 0;
  for (const row of rows) {
    const rejected = rejectedTargets(row.suggestion);
    const candidates = await surveyExpenseCandidatesForRow(row, rejected);
    if (candidates.length === 1 && candidates[0].id === row.matched_expense_id) {
      const done = await db('bank_transactions')
        .where({ id: row.id, status: 'matched_expense', matched_expense_id: row.matched_expense_id })
        .update({ suggestion: db.raw("suggestion - 'verifyPending'"), updated_at: new Date() });
      if (done) cleared++;
    } else {
      const changed = await db('bank_transactions')
        .where({ id: row.id, status: 'matched_expense', matched_expense_id: row.matched_expense_id })
        .update({
          status: 'unmatched',
          matched_expense_id: null,
          match_method: null,
          matched_at: null,
          suggestion: suggestionMerge({
            autoRevert: { at: new Date().toISOString(), expenseId: row.matched_expense_id, reason: 'a concurrently added expense made the match ambiguous' },
          }, ['verifyPending']),
          updated_at: new Date(),
        });
      if (changed) reverted++;
    }
  }
  return { cleared, reverted, more };
}

// Crash-recovery sweep for PAYOUT claims (mirror of the expense sweep): a
// payout claim commits with verifyPending + reconcilePending; a crash
// before the post-claim ambiguity verify must not let the echo retries
// confirm a possibly-ambiguous payout — the retry query skips verifyPending
// rows, and this sweep (run first) finishes the verification: unique →
// clear the marker so the echo may proceed; plural/overflow → atomic
// rollback with the reconciliation reversal, same shape as the inline path.
async function verifyPendingPayoutClaims() {
  const fetched = await db('bank_transactions')
    .where({ status: 'matched_payout' })
    .whereRaw("suggestion->>'verifyPending' = 'true'")
    .orderBy('updated_at', 'asc')
    .orderBy('id', 'asc')
    .limit(26) // 25 + sentinel: leftovers beyond the batch feed morePending
    .select('id', 'txn_date', 'description', 'amount', 'direction', 'account_type', 'account_label', 'suggestion', 'matched_payout_id');
  let more = fetched.length > 25;
  const rows = fetched.slice(0, 25);
  let cleared = 0;
  let reverted = 0;
  for (const row of rows) {
    const rejected = rejectedTargets(row.suggestion);
    const { candidates, overflow } = await surveyPayoutCandidatesForRow(row, rejected);
    // exact cents required, not just tolerance: a one-cent drift between
    // claim and verify would otherwise clear the marker and let the echo
    // confirm a discrepant automatic link (the matcher's exact-cent policy)
    if (!overflow && candidates.length === 1 && candidates[0].id === row.matched_payout_id
      && centsEqual(candidates[0].effective_amount, row.amount)) {
      const done = await db('bank_transactions')
        .where({ id: row.id, status: 'matched_payout', matched_payout_id: row.matched_payout_id })
        .update({ suggestion: db.raw("suggestion - 'verifyPending'"), updated_at: new Date() });
      if (done) cleared++;
      continue;
    }
    try {
      await db.transaction(async (trx) => {
        const sp = await trx('stripe_payouts').where('id', row.matched_payout_id).forUpdate().first('reconciled', 'reconciled_by');
        const undone = await trx('bank_transactions')
          .where({ id: row.id, status: 'matched_payout', matched_payout_id: row.matched_payout_id })
          .update({
            status: 'unmatched',
            matched_payout_id: null,
            match_method: null,
            matched_at: null,
            suggestion: suggestionMerge({
              autoRevert: { at: new Date().toISOString(), payoutId: row.matched_payout_id, reason: 'a concurrently arrived payout made the match ambiguous' },
            }, ['reconcilePending', 'verifyPending']),
            updated_at: new Date(),
          });
        if (!undone) return;
        reverted++;
        if (sp && sp.reconciled && sp.reconciled_by === `bank-import:${row.id}`) {
          const { reconcilePayout } = require('./stripe-banking');
          await reconcilePayout(row.matched_payout_id, Number(row.amount), `Ambiguity rollback for bank import row ${row.id}`, `bank-import:${row.id}`, 'rejected', { trx });
        }
      });
    } catch (err) {
      logger.warn(`[bank-import] payout verify rollback for row ${row.id} failed — link kept: ${err.message}`);
      // an unfinished verification IS remaining work — without this a
      // swallowed rollback failure read as "matching complete" while the
      // unverified claim sat excluded from the echo batch indefinitely
      more = true;
      // rotation: the failed row goes to the back of the bounded batch
      await db('bank_transactions')
        .where({ id: row.id, status: 'matched_payout', matched_payout_id: row.matched_payout_id })
        .update({ updated_at: new Date() });
    }
  }
  return { cleared, reverted, more };
}

// Server-side plausibility for a refund target — the SAME rules the matcher
// uses to park refundCandidates, so any valid original purchase is
// applicable even when it fell outside the bounded parked slice (a fuel or
// supply vendor can have more same-window purchases than the list shows).
// The original must predate the credit within the lookback, cover the
// refund, share vendor evidence, and be method-compatible with the account.
function isPlausibleRefundTarget(row, expense) {
  const txnDate = toDateStr(row.txn_date);
  const expDate = toDateStr(expense.expense_date);
  return expDate >= addDays(txnDate, -REFUND_LOOKBACK_DAYS)
    && expDate <= txnDate
    && Number(expense.amount) >= Number(row.amount)
    && vendorEvidence(row.description, expense)
    && !methodIncompatible(row.account_type, expense.payment_method);
}

// Atomic suggestion patch: merge PATCH keys into the CURRENT jsonb value
// (optionally subtracting keys first) so concurrent suggestion writers —
// the matcher, /suggest's AI categorizer, unlink — can only append to each
// other, never erase each other via a stale-snapshot rebuild.
function suggestionMerge(patch, removeKeys = []) {
  let expr = "coalesce(suggestion, '{}'::jsonb)";
  for (const k of removeKeys) expr += ` - '${String(k).replace(/'/g, "''")}'`;
  return db.raw(`${expr} || ?::jsonb`, [JSON.stringify(patch)]);
}

// The migration's partial unique indexes are the real double-claim guard;
// a concurrent pass that loses the race surfaces here as a unique
// violation, which just means "someone else claimed it" — skip, don't fail.
function isUniqueViolation(err) {
  return err && err.code === '23505';
}

// The reconciliation echo can fail AFTER the row is linked (the link is
// real; the echo is the ledger mirror). Those rows carry
// suggestion.reconcilePending and are retried at the top of every matching
// pass — scoped to the flag so a reconciliation a HUMAN later rejected is
// never re-confirmed by the sweep.
// Durable sync for the OTHER direction: a payout link whose reconciliation
// disappeared AFTER the echo (a human rejected it on the Banking page, or a
// lost marker). Pending-flagged rows are the retry sweep's job; this heals
// the rows with NO marker: a human rejection reverts the claim (their
// ruling outranks the link), anything else gets its pending marker restored
// so the normal retry path repairs it.
async function healUnreconciledLinks() {
  const rows = await db('bank_transactions as bt')
    .join('stripe_payouts as sp', 'sp.id', 'bt.matched_payout_id')
    .where('bt.status', 'matched_payout')
    .where('sp.reconciled', false)
    .whereRaw("coalesce(bt.suggestion->>'reconcilePending','') <> 'true'")
    .select('bt.id as id', 'bt.amount as amount', 'bt.matched_payout_id as matched_payout_id', 'bt.suggestion as suggestion');
  let reverted = 0;
  let remarked = 0;
  for (const row of rows) {
    // Per-row transaction with the payout LOCKED and its state re-read —
    // the outer scan is only a hint. A human who confirms the payout after
    // the scan can't be raced into a wrongful revert + permanent exclusion.
    // (Same payout-then-bank-row lock order as every other writer.)
    await db.transaction(async (trx) => {
      const sp = await trx('stripe_payouts').where('id', row.matched_payout_id).forUpdate().first('reconciled');
      if (!sp || sp.reconciled) return; // state changed since the scan — nothing to heal
      const latest = await trx('bank_reconciliation')
        .where('payout_id', row.matched_payout_id)
        .orderBy('reconciled_at', 'desc')
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc') // deterministic final tie-breaker
        .first('status', 'reconciled_by');
      if (latest && latest.status === 'rejected' && !String(latest.reconciled_by || '').startsWith('bank-import')) {
        const { reconcilePending, ...rest } = row.suggestion || {};
        const changed = await trx('bank_transactions')
          .where({ id: row.id, status: 'matched_payout', matched_payout_id: row.matched_payout_id })
          .update({
            status: 'unmatched',
            matched_payout_id: null,
            match_method: null,
            matched_at: null,
            suggestion: suggestionMerge({
              bankingRejectedPayoutIds: [...new Set([...(rest.bankingRejectedPayoutIds || []), row.matched_payout_id])],
              autoRevert: { at: new Date().toISOString(), payoutId: row.matched_payout_id, reason: 'reconciliation rejected by a human on the Banking page' },
            }, ['reconcilePending']),
            updated_at: new Date(),
          });
        if (changed) reverted++;
      } else if (latest && latest.status === 'draft' && !String(latest.reconciled_by || '').startsWith('bank-import')) {
        // a human DRAFT is deliberation in progress — automation neither
        // re-confirms over it nor reverts; leave the row alone this pass
      } else {
        const changed = await trx('bank_transactions')
          .where({ id: row.id, status: 'matched_payout', matched_payout_id: row.matched_payout_id })
          .update({ suggestion: suggestionMerge({ reconcilePending: true }), updated_at: new Date() });
        if (changed) remarked++;
      }
    });
  }

  // The INVERSE gap: a payout that IS reconciled, but a later human
  // reconciliation carries a different actual amount than the linked bank
  // credit — the stale link would block the correct deposit forever. Revert
  // under the payout lock after re-reading state; the human's
  // reconciliation itself is never touched.
  const linkedReconciled = await db('bank_transactions as bt')
    .join('stripe_payouts as sp', 'sp.id', 'bt.matched_payout_id')
    .where('bt.status', 'matched_payout')
    .where('sp.reconciled', true)
    // pending-flagged rows belong to the echo/retry path, whose guard
    // revalidation handles this same case
    .whereRaw("coalesce(bt.suggestion->>'reconcilePending','') <> 'true'")
    .select('bt.id as id', 'bt.amount as amount', 'bt.txn_date as txn_date', 'bt.matched_payout_id as matched_payout_id',
      'sp.amount as payout_amount', 'sp.status as payout_status', 'sp.arrival_date as arrival_date');
  // ONE batched lookup for every linked payout's latest confirmed actual
  // amount. This scan covers every reconciled link ever made (~one payout a
  // business day), and the per-row effectivePayoutAmount() loop it replaces
  // ran a serial query per link on EVERY upload/matching request — after a
  // few years that was thousands of round trips before matching began. The
  // scan itself stays two fixed queries regardless of history size; only
  // actual mismatches (rare anomalies) pay a per-row transaction.
  // Same latest-confirmed ordering as effectivePayoutAmount — keep in sync.
  const confirmedAmounts = new Map();
  const linkedIds = [...new Set(linkedReconciled.map(r => r.matched_payout_id))];
  if (linkedIds.length) {
    const latestRows = await db('bank_reconciliation')
      .select(db.raw('distinct on (payout_id) payout_id, actual_amount'))
      .whereIn('payout_id', linkedIds)
      .where('status', 'confirmed')
      .orderBy('payout_id')
      .orderBy('reconciled_at', 'desc')
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc');
    for (const r of latestRows) {
      if (!confirmedAmounts.has(r.payout_id) && r.actual_amount != null) confirmedAmounts.set(r.payout_id, Number(r.actual_amount));
    }
  }
  let amountReverts = 0;
  // eligibility over the FULL predicate — status must still be paid and the
  // arrival must still explain the credit, not just the amount: a
  // payout.failed/payout.updated webhook after a successful echo rewrites
  // status/arrival_date while leaving reconciled=true, and an
  // amount-unchanged failed payout would otherwise keep hiding this credit.
  const linkStillEligible = (row2, effectiveAmount) => row2.payout_status === 'paid'
    && isPlausiblePayoutLink({ txn_date: row2.txn_date, amount: row2.amount }, { amount: effectiveAmount, arrival_date: row2.arrival_date });
  for (const row of linkedReconciled) {
    const effective = confirmedAmounts.has(row.matched_payout_id)
      ? confirmedAmounts.get(row.matched_payout_id)
      : Number(row.payout_amount); // reconciled but no confirmed row — same fallback as effectivePayoutAmount
    if (linkStillEligible(row, effective)) continue;
    await db.transaction(async (trx) => {
      const sp = await trx('stripe_payouts').where('id', row.matched_payout_id).forUpdate().first('id', 'amount', 'status', 'arrival_date', 'reconciled', 'reconciled_by');
      if (!sp || !sp.reconciled) return; // state changed since the scan
      const lockedEffective = await effectivePayoutAmount(sp, trx);
      if (linkStillEligible({ ...row, payout_status: sp.status, arrival_date: sp.arrival_date }, lockedEffective)) return;
      const changed = await trx('bank_transactions')
        .where({ id: row.id, status: 'matched_payout', matched_payout_id: row.matched_payout_id })
        .update({
          status: 'unmatched',
          matched_payout_id: null,
          match_method: null,
          matched_at: null,
          suggestion: suggestionMerge({
            autoRevert: { at: new Date().toISOString(), payoutId: row.matched_payout_id, reason: 'the reconciled payout no longer explains this credit (status/amount/arrival changed)' },
          }, ['reconcilePending']),
          updated_at: new Date(),
        });
      if (!changed) return;
      amountReverts++;
      // A reconciliation THIS row authored must not outlive its link —
      // Banking would keep presenting a confirmed reconciliation from a
      // now-unmatched row. Reverse it in the SAME locked transaction (the
      // unlink route's shape); a human-authored reconciliation is never
      // touched from here.
      if (sp.reconciled_by === `bank-import:${row.id}`) {
        const { reconcilePayout } = require('./stripe-banking');
        await reconcilePayout(row.matched_payout_id, Number(row.amount), `Eligibility revert for bank import row ${row.id}`, `bank-import:${row.id}`, 'rejected', { trx });
      }
    });
  }
  // PENDING-flagged links are normally the retry path's revalidation job,
  // but the page-load endpoints run this healer WITHOUT the retries — a
  // pending link whose payout a webhook made ineligible must not keep
  // reporting as matched until someone uploads or clicks Run matching.
  // Reverts only: an eligible pending row is left for the echo retries,
  // and a RECONCILED pending row belongs to the echo guard's own
  // revalidation. The pending backlog is naturally small (echo failures).
  const pendingLinks = await db('bank_transactions as bt')
    .join('stripe_payouts as sp', 'sp.id', 'bt.matched_payout_id')
    .where('bt.status', 'matched_payout')
    .whereRaw("bt.suggestion->>'reconcilePending' = 'true'")
    .select('bt.id as id', 'bt.amount as amount', 'bt.txn_date as txn_date', 'bt.matched_payout_id as matched_payout_id',
      'sp.amount as payout_amount', 'sp.status as payout_status', 'sp.arrival_date as arrival_date', 'sp.reconciled as payout_reconciled');
  let pendingReverts = 0;
  for (const row of pendingLinks) {
    // an UNRECONCILED pending row that is still eligible by its expected
    // amount is the echo retries' normal work — skip without a lock. A
    // RECONCILED pending row (echo committed, crash before the flag
    // cleared) always takes the locked path: its effective amount is the
    // confirmed actual, which only the lock can read consistently.
    if (!row.payout_reconciled && linkStillEligible(row, Number(row.payout_amount))) continue;
    await db.transaction(async (trx) => {
      const sp = await trx('stripe_payouts').where('id', row.matched_payout_id).forUpdate().first('id', 'amount', 'status', 'arrival_date', 'reconciled', 'reconciled_by');
      if (!sp) return; // payout gone — FK SET NULL + the dangling heal own this
      const lockedEffective = await effectivePayoutAmount(sp, trx);
      if (linkStillEligible({ ...row, payout_status: sp.status, arrival_date: sp.arrival_date }, lockedEffective)) return;
      const changed = await trx('bank_transactions')
        .where({ id: row.id, status: 'matched_payout', matched_payout_id: row.matched_payout_id })
        .update({
          status: 'unmatched',
          matched_payout_id: null,
          match_method: null,
          matched_at: null,
          suggestion: suggestionMerge({
            autoRevert: { at: new Date().toISOString(), payoutId: row.matched_payout_id, reason: 'the payout is no longer eligible (status/amount/arrival changed after matching)' },
          }, ['reconcilePending', 'verifyPending']),
          updated_at: new Date(),
        });
      if (!changed) return;
      pendingReverts++;
      // a reconciliation THIS row authored is reversed with its link
      // (human-authored ones are never touched from here)
      if (sp.reconciled && sp.reconciled_by === `bank-import:${row.id}`) {
        const { reconcilePayout } = require('./stripe-banking');
        await reconcilePayout(row.matched_payout_id, Number(row.amount), `Eligibility revert for bank import row ${row.id}`, `bank-import:${row.id}`, 'rejected', { trx });
      }
    });
  }
  return { reverted: reverted + amountReverts + pendingReverts, remarked };
}

// A refund_applied credit whose target expense was DELETED must leave that
// state — its netting would keep skewing coverage while the adjustment it
// represents no longer exists. (The link lives in suggestion JSON, so the
// FK SET NULL self-heal can't see it.) ONE anti-join query finds the
// orphans — refund history grows forever, and a serial per-row expense
// lookup would pile round trips onto every matching pass; only actual
// orphans (rare — a deliberate Expenses-tab delete) pay a revert write.
async function healOrphanRefunds() {
  const orphans = await db('bank_transactions as bt')
    .leftJoin('expenses as e', db.raw("e.id::text = bt.suggestion->>'refundAppliedTo'"))
    .where('bt.status', 'refund_applied')
    .whereRaw("bt.suggestion->>'refundAppliedTo' is not null")
    .whereNull('e.id')
    .select('bt.id as id', db.raw("bt.suggestion->>'refundAppliedTo' as target"));
  let reverted = 0;
  for (const row of orphans) {
    const changed = await db('bank_transactions')
      .where({ id: row.id, status: 'refund_applied' })
      .update({
        status: 'unmatched',
        match_method: null,
        matched_at: null,
        suggestion: suggestionMerge({
          autoRevert: { at: new Date().toISOString(), expenseId: row.target, reason: 'the refunded expense was deleted' },
        }, ['refundAppliedTo', 'refundAmount', 'refundRestore']),
        updated_at: new Date(),
      });
    if (changed) reverted++;
  }
  return reverted;
}

async function retryPendingReconciliations() {
  const healLinks = await healUnreconciledLinks();
  const orphanRefunds = await healOrphanRefunds();
  const editedLinks = await healEditedExpenseLinks();
  const claimVerify = await verifyPendingExpenseClaims();
  // BEFORE the echo retries below — an unverified payout claim must be
  // verified (or rolled back) before anything confirms its reconciliation
  const payoutVerify = await verifyPendingPayoutClaims();
  // BOUNDED batch + sentinel: during a reconciliation outage a large
  // backfill can leave hundreds of pending echoes, and retrying them all
  // serially would starve the (separately bounded) unmatched-row scan on
  // every request. Oldest-updated first; a failed retry bumps updated_at so
  // one broken payout rotates to the back instead of hogging every batch.
  const PENDING_RETRY_LIMIT = 25;
  const pendingFetch = await db('bank_transactions')
    .where({ status: 'matched_payout' })
    .whereNotNull('matched_payout_id')
    .whereRaw("suggestion->>'reconcilePending' = 'true'")
    // never echo a claim whose ambiguity verification hasn't finished —
    // the verify sweep above owns those rows (belt for the >25 overflow)
    .whereRaw("coalesce(suggestion->>'verifyPending', '') <> 'true'")
    .orderBy('updated_at', 'asc')
    .orderBy('id', 'asc') // deterministic tie-breaker
    .limit(PENDING_RETRY_LIMIT + 1)
    .select('id', 'amount', 'matched_payout_id', 'suggestion');
  const pending = pendingFetch.slice(0, PENDING_RETRY_LIMIT);
  let retried = 0;
  let humanRejected = 0;
  // rows whose retry left the pending flag IN PLACE (a failure, an active
  // human draft, or a transient precondition skip) are unfinished work just
  // like the rows beyond the sentinel — both must feed morePending, or the
  // caller reports "done" while linked payouts stay unreconciled until some
  // future pass happens to run.
  let unresolved = 0;
  for (const row of pending) {
    const payout = await db('stripe_payouts').where({ id: row.matched_payout_id }).first('id', 'reconciled');
    if (payout) {
      try {
        // The shared helper handles the whole outcome ladder — INCLUDING an
        // already-reconciled payout: its guard skip revalidates the
        // confirmed amount and reverts the link if a human reconciled a
        // DIFFERENT banked amount while our echo was pending. Never clear
        // the flag for a reconciled payout without that check.
        const result = await echoPayoutReconciliation(row.id, row.matched_payout_id, Number(row.amount), `Auto-matched to bank import row ${row.id} (retry)`);
        if (!(result && result.skipped)) retried++;
        else if (result.reason === 'human_rejected') humanRejected++;
        else if (result.reason === 'human_draft' || result.reason === 'precondition') unresolved++;
      } catch (err) {
        logger.warn(`[bank-import] reconciliation retry for payout ${payout.id} failed again: ${err.message}`);
        unresolved++;
        // rotation: the failed row goes to the back of the bounded batch
        // order so it can't monopolize every subsequent pass
        await db('bank_transactions')
          .where({ id: row.id, status: 'matched_payout', matched_payout_id: row.matched_payout_id })
          .update({ updated_at: new Date() });
      }
    } else {
      // payout deleted — nothing to echo; clear the flag, scoped to the
      // exact link processed so a re-matched row's newer flag survives
      await db('bank_transactions')
        .where({ id: row.id, status: 'matched_payout', matched_payout_id: row.matched_payout_id })
        .update({ suggestion: db.raw("suggestion - 'reconcilePending'"), updated_at: new Date() });
    }
  }

  // (Reversals need no sweep: the unlink route runs its unlink CAS inside
  // the reversal's own transaction, so a failed reversal rolls the unlink
  // back — there is never a committed unlink awaiting reversal.)
  // unfinished work of EVERY kind feeds the caller's more-signal: retry
  // backlog, unresolved retries, and verification sweeps that hit their cap
  const morePending = pendingFetch.length > PENDING_RETRY_LIMIT || unresolved > 0 || claimVerify.more || payoutVerify.more;
  return { pending: pending.length, morePending, retried, humanRejected, linksReverted: healLinks.reverted, linksRemarked: healLinks.remarked, orphanRefundsReverted: orphanRefunds, expenseLinksReverted: editedLinks, claimVerifyReverted: claimVerify.reverted, payoutVerifyReverted: payoutVerify.reverted };
}

// An operator EDIT to a linked expense (amount/date via the Expenses or
// job-expenses routes) can silently invalidate a SURVIVING link: the FK
// stays, ledgerCoverage keeps counting least(bt.amount, e.amount), and the
// partial unique index blocks the RIGHT expense from ever claiming the row.
// ONE SQL pass returns only the violations — links whose expense no longer
// matches at net OR gross (applied refunds legitimately reduce the net) or
// fell out of the ±window — and reverts them. created_expense rows are
// exempt by the status filter: that expense's identity IS this debit (it
// was created from it), an amount edit there is a correction the coverage
// cap already reflects, and unlinking would bait a duplicate create.
async function healEditedExpenseLinks() {
  // ONE narrow-column scan (the same accepted shape as the reconciled-
  // payout scan: fixed query count per pass regardless of history size).
  // The violation logic runs in JS because vendorEvidence is token logic
  // SQL can't express: EVERY link must stay inside the amount (net or
  // gross — applied refunds legitimately reduce the net) and date window;
  // AUTO links must additionally keep the vendor evidence and method
  // compatibility that justified them. Manual links keep the operator's
  // ruling on vendor/method — they may know the books are mislabeled,
  // same as the parking rule.
  const links = await db('bank_transactions as bt')
    .join('expenses as e', 'e.id', 'bt.matched_expense_id')
    .joinRaw(`left join lateral (
        select coalesce(sum((rbt.suggestion->>'refundAmount')::numeric), 0) as rsum
        from bank_transactions rbt
        where rbt.status = 'refund_applied'
          and rbt.suggestion->>'refundAppliedTo' = e.id::text
      ) rs on true`)
    .where('bt.status', 'matched_expense')
    .select('bt.id as id', 'bt.amount as bt_amount', 'bt.txn_date as txn_date', 'bt.description as description',
      'bt.account_type as account_type', 'bt.match_method as match_method', 'bt.matched_expense_id as expense_id',
      'e.amount as e_amount', 'e.expense_date as e_date', 'e.vendor_name as vendor_name', 'e.payment_method as payment_method',
      db.raw('rs.rsum as rsum'));
  const linkOk = (link, exp, rsum) => {
    const txn = toDateStr(link.txn_date);
    const expDate = toDateStr(exp.expense_date);
    const windowOk = expDate >= addDays(txn, -EXPENSE_DATE_WINDOW_DAYS) && expDate <= addDays(txn, EXPENSE_DATE_WINDOW_DAYS);
    const auto = link.match_method === 'expense_amount_date_vendor';
    // AUTO links must hold the matcher's exact-cent policy (a one-cent
    // edit voids the automatic justification); MANUAL links keep the
    // operator's one-cent tolerance, the same window link-expense accepts.
    const amountMatches = auto ? centsEqual : withinCandidateTolerance;
    const amountOk = amountMatches(exp.amount, link.bt_amount)
      || amountMatches(Number(exp.amount) + Number(rsum || 0), link.bt_amount);
    const autoOk = !auto || (vendorEvidence(link.description, exp)
      && !methodIncompatible(link.account_type, exp.payment_method));
    return windowOk && amountOk && autoOk;
  };
  let reverted = 0;
  for (const link of links) {
    if (linkOk(link, { amount: link.e_amount, expense_date: link.e_date, vendor_name: link.vendor_name, payment_method: link.payment_method }, link.rsum)) continue;
    // The scan is only a HINT — the revert decision is re-made with the
    // expense row LOCKED and its current values (including the applied-
    // refund total) re-read in the same transaction as the unlink, the
    // pattern every other writer uses: an operator correcting the expense
    // between the scan and this point must not lose a now-valid link.
    await db.transaction(async (trx) => {
      const fresh = await trx('expenses').where({ id: link.expense_id }).forUpdate()
        .first('id', 'amount', 'expense_date', 'vendor_name', 'payment_method');
      if (fresh) {
        const lockedRsum = await appliedRefundTotal(fresh.id, trx);
        if (linkOk(link, fresh, lockedRsum)) return; // corrected mid-scan — the link is valid again
      }
      const changed = await trx('bank_transactions')
        .where({ id: link.id, status: 'matched_expense', matched_expense_id: link.expense_id })
        .update({
          status: 'unmatched',
          matched_expense_id: null,
          match_method: null,
          matched_at: null,
          suggestion: suggestionMerge({
            autoRevert: { at: new Date().toISOString(), expenseId: link.expense_id, reason: 'the linked expense was edited and no longer matches this bank row (amount/date/vendor/method)' },
          }),
          updated_at: new Date(),
        });
      if (changed) reverted++;
    });
  }
  return reverted;
}

// A deleted expense/payout SET-NULLs the FK but leaves the status behind —
// without this, ledgerCoverage (and the UI) would keep counting a row whose
// ledger side no longer exists. Deterministic self-heal at the top of every
// matching pass.
async function resetDanglingLinks() {
  // claim-generation markers are stripped WITH the heal: a claim whose
  // ledger side was deleted mid-verification would otherwise leave
  // verifyPending/reconcilePending behind, and the operator's NEXT manual
  // link would inherit them — the sweeps could then revert that new link
  // as if it were the abandoned automatic claim.
  const dropMarkers = db.raw("coalesce(suggestion, '{}'::jsonb) - 'reconcilePending' - 'verifyPending'");
  const healedExpense = await db('bank_transactions')
    .whereIn('status', ['matched_expense', 'created_expense'])
    .whereNull('matched_expense_id')
    .update({ status: 'unmatched', match_method: null, matched_at: null, suggestion: dropMarkers, updated_at: new Date() });
  const healedPayout = await db('bank_transactions')
    .where({ status: 'matched_payout' })
    .whereNull('matched_payout_id')
    .update({ status: 'unmatched', match_method: null, matched_at: null, suggestion: dropMarkers, updated_at: new Date() });
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
// The ledger echo for a payout link, shared by the automatic matcher and
// the manual link-payout route: reconcile through the EXISTING stripe-banking
// mechanism under the unreconciled guard + still-linked precondition, then
// clear the row's pending flag scoped to this exact link. Throws on failure —
// callers leave the persisted reconcilePending flag in place so the sweep
// retries.
async function echoPayoutReconciliation(rowId, payoutId, amount, note) {
  const { reconcilePayout } = require('./stripe-banking');
  const result = await reconcilePayout(payoutId, Number(amount), note, `bank-import:${rowId}`, 'confirmed', {
    onlyIfUnreconciled: true,
    precondition: async (trx) => {
      const linked = await trx('bank_transactions')
        .where({ id: rowId, status: 'matched_payout', matched_payout_id: payoutId })
        .forUpdate().first('id', 'txn_date');
      if (!linked) return false;
      // Payout ELIGIBILITY re-read under the payout lock reconcilePayout is
      // already holding: a payout webhook can rewrite status/amount/arrival
      // between the unlocked candidate read and this echo, and confirming a
      // reconciliation for a payout that no longer explains the credit
      // would falsify the ledger mirror. A failure here surfaces as a
      // precondition skip; the re-check transaction below decides whether
      // the link itself must be reverted.
      const sp = await trx('stripe_payouts').where('id', payoutId).first('id', 'status', 'amount', 'arrival_date', 'reconciled');
      if (!sp || sp.status !== 'paid') return false;
      const effective = await effectivePayoutAmount(sp, trx);
      return isPlausiblePayoutLink({ txn_date: linked.txn_date, amount }, { amount: effective, arrival_date: sp.arrival_date });
    },
  });
  // A skip for human_rejected/guard demands a REVERT decision — but the
  // reconcile transaction's payout lock is already released, so the state
  // that justified the skip can change again. Re-check and act in ONE
  // transaction that locks the payout first (same pattern as
  // healUnreconciledLinks): a human confirming or correcting the payout
  // mid-decision can never lose a valid link to a stale revert.
  //  - human rejection still stands → revert + exclude the payout for this row
  //  - payout reconciled with a non-matching banked amount → revert (stale link)
  //  - otherwise resolved benignly → clear the pending flag
  // An active human DRAFT pauses everything: the link stays, the pending
  // flag stays (the sweep retries after the draft resolves), and nothing is
  // written over the deliberation.
  if (result && result.skipped && result.reason === 'human_draft') {
    return result;
  }
  if (result && result.skipped && (result.reason === 'human_rejected' || result.reason === 'guard' || result.reason === 'precondition')) {
    let outcome = null;
    await db.transaction(async (trx) => {
      const sp = await trx('stripe_payouts').where('id', payoutId).forUpdate().first('id', 'status', 'amount', 'arrival_date', 'reconciled');
      if (!sp) return; // payout gone — FK SET NULL + self-heal own this case
      const latest = await trx('bank_reconciliation')
        .where('payout_id', payoutId)
        .orderBy('reconciled_at', 'desc')
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .first('status', 'reconciled_by');
      const humanRejected = latest && latest.status === 'rejected' && !String(latest.reconciled_by || '').startsWith('bank-import');
      if (humanRejected) {
        const cur = await trx('bank_transactions')
          .where({ id: rowId, status: 'matched_payout', matched_payout_id: payoutId })
          .first('suggestion');
        if (!cur) return;
        const rest = cur.suggestion || {};
        const changed = await trx('bank_transactions')
          .where({ id: rowId, status: 'matched_payout', matched_payout_id: payoutId })
          .update({
            status: 'unmatched',
            matched_payout_id: null,
            match_method: null,
            matched_at: null,
            suggestion: suggestionMerge({
              bankingRejectedPayoutIds: [...new Set([...(rest.bankingRejectedPayoutIds || []), payoutId])],
              autoRevert: { at: new Date().toISOString(), payoutId, reason: 'reconciliation rejected by a human on the Banking page' },
            }, ['reconcilePending']),
            updated_at: new Date(),
          });
        if (changed) outcome = 'human_reverted';
        return;
      }
      const reconciledEffective = sp.reconciled ? await effectivePayoutAmount(sp, trx) : null;
      if (sp.reconciled && !withinCandidateTolerance(reconciledEffective, amount)) {
        const changed = await trx('bank_transactions')
          .where({ id: rowId, status: 'matched_payout', matched_payout_id: payoutId })
          .update({
            status: 'unmatched',
            matched_payout_id: null,
            match_method: null,
            matched_at: null,
            suggestion: suggestionMerge({
              autoRevert: { at: new Date().toISOString(), payoutId, reason: 'payout was reconciled with a different banked amount after matching' },
            }, ['reconcilePending']),
            updated_at: new Date(),
          });
        if (changed) outcome = 'amount_reverted';
        return;
      }
      const cur = await trx('bank_transactions')
        .where({ id: rowId, status: 'matched_payout', matched_payout_id: payoutId })
        .first('id', 'txn_date');
      if (!cur) {
        // the row is no longer linked — keep the caller's original skip
        // semantics (a concurrent unlink/re-match owns the row now)
        outcome = 'skip_stands';
        return;
      }
      if (sp.reconciled) {
        // Amount matches, but a webhook can rewrite status/arrival while
        // reconciled stays true (the same gap the reconciled-link healer
        // closes) — the FULL predicate is judged here too, under the same
        // lock, so an ineligible payout never keeps the link with its
        // pending flag cleared.
        if (!(sp.status === 'paid'
          && isPlausiblePayoutLink({ txn_date: cur.txn_date, amount }, { amount: reconciledEffective, arrival_date: sp.arrival_date }))) {
          const changed = await trx('bank_transactions')
            .where({ id: rowId, status: 'matched_payout', matched_payout_id: payoutId })
            .update({
              status: 'unmatched',
              matched_payout_id: null,
              match_method: null,
              matched_at: null,
              suggestion: suggestionMerge({
                autoRevert: { at: new Date().toISOString(), payoutId, reason: 'the payout is no longer eligible (status/amount/arrival changed after matching)' },
              }, ['reconcilePending']),
              updated_at: new Date(),
            });
          if (changed) outcome = 'ineligible_reverted';
          return;
        }
      }
      // ELIGIBILITY revert for a still-unreconciled payout: a webhook
      // rewrote its status/amount/arrival and it no longer explains the
      // credit — the link must not survive on a payout the echo can never
      // legitimately confirm.
      if (!sp.reconciled) {
        const effective = await effectivePayoutAmount(sp, trx);
        const eligible = sp.status === 'paid'
          && isPlausiblePayoutLink({ txn_date: cur.txn_date, amount }, { amount: effective, arrival_date: sp.arrival_date });
        if (!eligible) {
          const changed = await trx('bank_transactions')
            .where({ id: rowId, status: 'matched_payout', matched_payout_id: payoutId })
            .update({
              status: 'unmatched',
              matched_payout_id: null,
              match_method: null,
              matched_at: null,
              suggestion: suggestionMerge({
                autoRevert: { at: new Date().toISOString(), payoutId, reason: 'the payout is no longer eligible (status/amount/arrival changed after matching)' },
              }, ['reconcilePending']),
              updated_at: new Date(),
            });
          if (changed) outcome = 'ineligible_reverted';
          return;
        }
        if (result.reason === 'precondition') {
          // transient precondition skip: the row is linked and the payout
          // is eligible again, but NOTHING was echoed — keep the pending
          // flag so the sweep retries, and hand the caller the skip as-is
          outcome = 'skip_stands';
          return;
        }
      }
      // benign: amount still matches (or nothing reconciled after all) —
      // resolve the pending flag inside the same locked transaction
      await trx('bank_transactions')
        .where({ id: rowId, status: 'matched_payout', matched_payout_id: payoutId })
        .update({ suggestion: db.raw("suggestion - 'reconcilePending'"), updated_at: new Date() });
      outcome = 'cleared';
    });
    if (outcome === 'human_reverted') return { ...result, reason: 'human_rejected' };
    if (outcome === 'amount_reverted') return { ...result, amountMismatchReverted: true, reason: 'guard' };
    if (outcome === 'ineligible_reverted') return { ...result, ineligibleReverted: true, reason: 'guard' };
    if (outcome === 'skip_stands') return result;
    // re-check found the skip resolved benignly — report it as such so
    // callers don't act on a stale reason
    return { ...result, reason: 'resolved' };
  }
  // Any other guard skip resolves the intent too — either the payout is
  // already reconciled with a still-matching amount (nothing to echo) or
  // the row is no longer linked (nothing to clear; the scoped CAS below
  // no-ops). jsonb key-subtraction removes ONLY the flag, and the CAS
  // scopes it to THIS link — if an unlink + re-match to a different payout
  // landed since, the newer link keeps its own pending flag and the sweep
  // still retries it.
  await db('bank_transactions')
    .where({ id: rowId, status: 'matched_payout', matched_payout_id: payoutId })
    .update({ suggestion: db.raw("suggestion - 'reconcilePending'"), updated_at: new Date() });
  return result;
}

// Rejected-target ruling for a row: every id the operator has ever unlinked
// from it (cumulative arrays; the single lastUnlink id folds in for rows
// written before the arrays existed). bankingPayoutIds are DERIVED
// rejections (a human rejected the payout's reconciliation on the Banking
// page, so the link was auto-reverted) — they exclude the payout only while
// that rejection stands; a later corrected 'confirmed' reconciliation makes
// the payout eligible again, unlike an explicit Tax unlink.
function rejectedTargets(suggestion) {
  const last = suggestion?.lastUnlink || {};
  const expenseIds = new Set(suggestion?.rejectedExpenseIds || []);
  const payoutIds = new Set(suggestion?.rejectedPayoutIds || []);
  if (last.expenseId) expenseIds.add(last.expenseId);
  if (last.payoutId) payoutIds.add(last.payoutId);
  return { expenseIds: [...expenseIds], payoutIds: [...payoutIds], bankingPayoutIds: [...new Set(suggestion?.bankingRejectedPayoutIds || [])] };
}

// Provenance for a payout auto-link: amount+date alone is not identity — a
// same-amount unrelated deposit (owner transfer, check) could consume the
// payout and hide the real deposit. Evidence = the statement description
// looks like a Stripe deposit, or the imported account's label carries the
// payout's destination last-4. Without it, the match PARKS for the operator.
// The one description shape that identifies Stripe money — shared by the
// payout-evidence check and the transfer-heuristic exemption in the
// matching loop, so the two can never disagree about what "looks like
// Stripe" means. A COMPLETE token only: a substring test made a merchant
// like PINSTRIPES count as payout provenance, which could auto-confirm an
// unrelated same-amount credit against a real payout.
function stripeShapedDescription(description) {
  return /\bstripe\b/i.test(String(description || ''));
}

function payoutProvenance(row, payout) {
  if (stripeShapedDescription(row.description)) return true;
  const last4 = String(payout.bank_last_four || '').trim();
  return !!(last4 && String(row.account_label || '').includes(last4));
}

// A card-statement debit cannot be an expense the books already know was
// paid by ACH, check, or cash — such an "exact" match is a coincidence and
// auto-linking it would hide the real card purchase from review. Bank-side
// (checking) rows book more widely — outflow is legitimately ach, check, or
// card (debit-card-on-checking) — but never CASH: cash spend cannot be a
// bank transaction either, and a coincidental same-vendor cash expense
// would consume the debit and hide the real one from review + coverage.
// Unknown methods stay eligible (they park for the operator when not unique).
function methodIncompatible(accountType, paymentMethod) {
  const method = String(paymentMethod || '').toLowerCase();
  if (accountType === 'card') return ['ach', 'check', 'cash'].includes(method);
  if (accountType === 'bank') return method === 'cash';
  return false;
}

async function runDeterministicMatching({ limit } = {}) {
  const healed = await resetDanglingLinks();
  const reconciliation = await retryPendingReconciliations();
  const bounded = Number.isFinite(limit) && limit > 0;
  const baseSelect = () => db('bank_transactions')
    .where({ status: 'unmatched' })
    .orderBy('txn_date', 'asc')
    .select('id', 'txn_date', 'description', 'amount', 'direction', 'account_type', 'account_label', 'suggestion');
  // Rows the matcher already examined (transfer-flagged, parked candidates)
  // stay unmatched by design — a bounded oldest-first scan would let them
  // fill the window forever and starve newer imports. Bounded passes take
  // NEVER-EXAMINED rows first, then spend any leftover budget re-scanning
  // examined rows (oldest first) so a new expense can still resolve them.
  // jsonb_exists_any = the function form of the ?| any-key operator —
  // knex.raw treats bare ? (and ??) as binding placeholders and would eat
  // the operator, silently binding the LIMIT value into it.
  const EXAMINED_SQL = "jsonb_exists_any(suggestion, array['ignore','candidates','payoutCandidates','refundCandidates','noMatch'])";
  // A processed row that produced NOTHING (no candidates at all, or a
  // credit the matcher never matches) must still leave the fresh pool, or a
  // bounded pass would rescan the same oldest rows forever while
  // moreRemaining stays true. noMatch only demotes it to the examined pool
  // — leftover budget still rescans it, so a later expense can resolve it.
  const markScanned = async (row) => {
    if (row.suggestion && row.suggestion.noMatch) {
      // Already demoted: in bounded mode, BUMP updated_at anyway — the
      // examined pool is served oldest-updated first, so this rescan sends
      // the row to the back of the rotation instead of it hogging the
      // leftover budget forever while newer examined rows never get a turn.
      if (bounded) {
        await db('bank_transactions')
          .where({ id: row.id, status: 'unmatched' })
          .update({ updated_at: new Date() });
      }
      return;
    }
    // Candidate keys are SUBTRACTED here: reaching markScanned means the
    // rescan found nothing, so any previously parked candidates are stale
    // (deleted, claimed elsewhere, or out of window) — leaving them would
    // keep the UI offering targets that can only 404/409.
    await db('bank_transactions')
      .where({ id: row.id, status: 'unmatched' })
      .update({
        suggestion: suggestionMerge({ noMatch: true }, ['candidates', 'candidatesTotal', 'payoutCandidates', 'payoutCandidatesTotal', 'refundCandidates', 'refundCandidatesTotal']),
        updated_at: new Date(),
      });
  };
  let unmatched;
  let moreRemaining = false;
  if (!bounded) {
    unmatched = await baseSelect();
  } else {
    // limit+1 sentinels answer "is there more?" without count queries. A
    // huge backfill would otherwise run thousands of serial per-row queries
    // inside one request — callers surface moreRemaining instead.
    const fresh = await baseSelect()
      .whereRaw(`(suggestion is null or not ${EXAMINED_SQL})`)
      .limit(limit + 1);
    const moreFresh = fresh.length > limit;
    unmatched = fresh.slice(0, limit);
    let moreExamined = false;
    if (!moreFresh) {
      // Even with NO leftover capacity (fresh pool exactly == limit), the
      // examined pool must still be probed — otherwise moreRemaining lies
      // "done" while parked/noMatch rows still await a rescan.
      const fill = Math.max(0, limit - unmatched.length);
      // ROTATION: the examined pool is served oldest-UPDATED first, and
      // every rescan (re-park, transfer re-check, or the markScanned bump)
      // touches updated_at — round-robin, so no examined row is starved
      // out of the leftover budget by an older sibling.
      const examined = await db('bank_transactions')
        .where({ status: 'unmatched' })
        .whereRaw(`suggestion is not null and ${EXAMINED_SQL}`)
        .orderBy('updated_at', 'asc')
        .limit(fill + 1)
        .select('id', 'txn_date', 'description', 'amount', 'direction', 'account_type', 'account_label', 'suggestion');
      moreExamined = examined.length > fill;
      unmatched = unmatched.concat(examined.slice(0, fill));
    }
    moreRemaining = moreFresh || moreExamined;
  }
  // pending echoes beyond the retry batch are unfinished work too — the
  // caller's "more rows pending" surface must not read as done
  moreRemaining = moreRemaining || reconciliation.morePending;
  const summary = { scanned: unmatched.length, moreRemaining, payoutsLinked: 0, expensesLinked: 0, transferFlagged: 0, ambiguous: 0, healed, reconcileRetried: reconciliation.retried, reconcilePending: reconciliation.pending, linksReverted: reconciliation.linksReverted, linksRemarked: reconciliation.linksRemarked, orphanRefundsReverted: reconciliation.orphanRefundsReverted, expenseLinksReverted: reconciliation.expenseLinksReverted, claimVerifyReverted: reconciliation.claimVerifyReverted, payoutVerifyReverted: reconciliation.payoutVerifyReverted };

  for (const row of unmatched) {
    const txnDate = toDateStr(row.txn_date);
    // An operator's explicit unlink is a ruling: the automatic pass never
    // re-proposes ANY previously rejected target — including earlier
    // rejections, not just the latest. (Manual re-link stays possible.)
    const rejected = rejectedTargets(row.suggestion);
    // Refund-candidate discovery for CREDITS — used by the refund/payout
    // branches below AND by the transfer branch (a vendor refund whose
    // descriptor contains a transfer word must keep the human refund
    // action; automatic links stay suppressed for transfer-shaped rows).
    const refundCandidateList = () => refundCandidatesForRow(row);
    const refundPatch = (list) => ({
      refundCandidates: list.slice(0, 20).map(c => ({ id: c.id, amount: Number(c.amount), vendor_name: c.vendor_name, description: c.description, expense_date: toDateStr(c.expense_date) })),
      refundCandidatesTotal: list.length,
    });
    // Parked DEBIT candidates — deterministic display order (newest first,
    // then id), amounts included (gross reading for refund-reduced ones).
    const expenseCandidatePatch = (list) => {
      const parked = [...list].sort((a, b) => String(toDateStr(b.expense_date)).localeCompare(String(toDateStr(a.expense_date)))
        || String(a.id).localeCompare(String(b.id)));
      return {
        candidates: parked.slice(0, 20).map(c => ({ id: c.id, amount: c.gross_amount != null ? Number(c.gross_amount) : Number(c.amount), description: c.description, vendor_name: c.vendor_name, expense_date: toDateStr(c.expense_date) })),
        candidatesTotal: list.length,
      };
    };
    // A bank-account credit with a Stripe-shaped description is PAYOUT
    // territory even when it also carries a transfer word (Capital One
    // renders payouts as e.g. "STRIPE TRANSFER ST-…") — payoutProvenance
    // treats that exact shape as payout EVIDENCE, so suppressing it here
    // would contradict the payout branch and leave a legitimate deposit
    // with only an Ignore action. Debits and card-account credits keep the
    // suppression: Stripe money never moves through those rows, so
    // "STRIPE" + transfer words there still reads as an internal move.
    const stripeBankCredit = row.direction === 'credit' && row.account_type === 'bank' && stripeShapedDescription(row.description);
    const transfer = stripeBankCredit ? null : transferSuggestion(row.description);
    if (transfer) {
      // The flag is only ever a SUGGESTION, so the human actions ride
      // along with it: CREDITS park refund candidates, DEBITS park expense
      // candidates for manual linking — a legit vendor whose descriptor
      // trips the heuristic (AUTOPAY, ONLINE PYMT) must not leave the
      // operator choosing between a duplicate create and Ignore. Automatic
      // matching stays suppressed for transfer-shaped rows either way.
      const refunds = row.direction === 'credit' ? await refundCandidateList() : [];
      const debitCands = row.direction === 'debit' ? await surveyExpenseCandidatesForRow(row, rejected) : [];
      const actionPatch = refunds.length ? refundPatch(refunds) : (debitCands.length ? expenseCandidatePatch(debitCands) : {});
      const hasActions = refunds.length > 0 || debitCands.length > 0;
      const staleActionKeys = row.direction === 'credit'
        ? ['refundCandidates', 'refundCandidatesTotal']
        : ['candidates', 'candidatesTotal'];
      if (!row.suggestion || !row.suggestion.ignore) {
        // merged, not replaced — suggestion also carries durable identity
        // records (forceToken/forcedFor, lastUnlink) that must survive
        await db('bank_transactions').where({ id: row.id, status: 'unmatched' }).update({
          suggestion: suggestionMerge({ ...transfer, ...actionPatch }, hasActions ? ['noMatch'] : []),
          updated_at: new Date(),
        });
        summary.transferFlagged++;
      } else if (hasActions
        || (row.direction === 'credit' && row.suggestion.refundCandidates)
        || (row.direction === 'debit' && row.suggestion.candidates)) {
        // already flagged — REFRESH the action list on every rescan
        // (targets appear and disappear; a stale list can only 404/409)
        // and rotate via updated_at like every other examined row
        await db('bank_transactions').where({ id: row.id, status: 'unmatched' }).update({
          suggestion: suggestionMerge(actionPatch, hasActions ? ['noMatch'] : staleActionKeys),
          updated_at: new Date(),
        });
      } else if (bounded) {
        // nothing to park and nothing stale to clear — plain rotation bump
        await db('bank_transactions').where({ id: row.id, status: 'unmatched' }).update({ updated_at: new Date() });
      }
      continue; // transfer-looking rows never auto-match anything
    }

    if (row.direction === 'credit') {
      // Merchant-refund review path: park candidate ORIGINAL expenses
      // (wide lookback — refunds lag purchases by weeks; vendor evidence +
      // amount ≥ the credit + account-compatible method) for the operator's
      // apply-refund action. NEVER auto-applied: reducing a ledger expense
      // is always a human call. Card credits are refund territory outright;
      // bank credits reach here only AFTER payout matching comes up empty
      // (a debit-card purchase refunded into checking).
      // Stripe pays out to the BANK account only — card credits skip payout
      // matching entirely. (refundCandidateList/refundPatch are hoisted
      // above the transfer branch — it parks refund candidates too.)
      if (row.account_type !== 'bank') {
        const refunds = await refundCandidateList();
        if (refunds.length) {
          summary.ambiguous++;
          await db('bank_transactions').where({ id: row.id, status: 'unmatched' }).update({
            suggestion: suggestionMerge(refundPatch(refunds), ['payoutCandidates', 'payoutCandidatesTotal', 'noMatch']),
            updated_at: new Date(),
          });
        } else {
          await markScanned(row);
        }
        continue;
      }
      // The COMPLETE payout survey — reused for the post-claim ambiguity
      // verify below and the crash-recovery sweep.
      const surveyPayoutCandidates = () => surveyPayoutCandidatesForRow(row, rejected);
      const { candidates, overflow: surveyOverflow } = await surveyPayoutCandidates();
      const exact = candidates.filter(c => centsEqual(c.effective_amount, row.amount));
      if (!surveyOverflow && candidates.length === 1 && exact.length === 1 && payoutProvenance(row, exact[0])) {
        try {
          // Reconciliation intent is persisted ATOMICALLY with the claim —
          // ALWAYS, not conditioned on a pre-read of `reconciled` (that read
          // is unlocked and can go stale mid-flight): a crash anywhere
          // before the echo resolves still leaves a retryable marker for
          // the sweep — never a linked-but-unreconciled payout that nothing
          // ever revisits. The guarded helper resolves the CURRENT state:
          // already reconciled → skip + clear; unreconciled → echo + clear.
          const changed = await db('bank_transactions')
            .where({ id: row.id, status: 'unmatched' })
            .update({
              status: 'matched_payout',
              matched_payout_id: exact[0].id,
              match_method: 'payout_amount_date',
              matched_at: new Date(),
              updated_at: new Date(),
              // verifyPending rides too (mirror of the expense claim): a
              // crash before the post-claim verify must leave a marker the
              // sweep can finish, and the echo retries SKIP verifyPending
              // rows so an unverified claim is never confirmed first
              suggestion: suggestionMerge({ reconcilePending: true, verifyPending: true }),
            });
          if (changed) {
            // POST-CLAIM ambiguity verify (mirror of the expense path): a
            // delayed payout webhook can insert another paid, same-amount
            // payout in the window between the survey and the claim. This
            // fresh survey (own claim excluded from the claimed-filter)
            // reverts the claim BEFORE any reconciliation echo when the set
            // turned plural; payouts arriving after this point are LATER
            // arrivals and never retro-invalidate a link.
            const after = await surveyPayoutCandidates();
            // exact cents required on the survivor too — a one-cent drift
            // between survey and verify must park, not confirm
            if (!after.overflow && after.candidates.length === 1 && after.candidates[0].id === exact[0].id
              && centsEqual(after.candidates[0].effective_amount, row.amount)) {
              await db('bank_transactions')
                .where({ id: row.id, status: 'matched_payout', matched_payout_id: exact[0].id })
                .update({ suggestion: db.raw("suggestion - 'verifyPending'"), updated_at: new Date() });
            } else {
              // Atomic rollback, SAME shape as the unlink route: payout
              // locked FIRST, the CAS unlink inside, and — when a
              // concurrent pending-retry already confirmed our echo between
              // the claim and this verify — the reconciliation reversal in
              // the same transaction. Without this, the unlink could
              // succeed while Banking permanently reported the payout
              // reconciled by a row that is no longer linked.
              let rolledBack = false;
              try {
                await db.transaction(async (trx) => {
                  const sp = await trx('stripe_payouts').where('id', exact[0].id).forUpdate().first('reconciled', 'reconciled_by');
                  const undone = await trx('bank_transactions')
                    .where({ id: row.id, status: 'matched_payout', matched_payout_id: exact[0].id })
                    .update({
                      status: 'unmatched',
                      matched_payout_id: null,
                      match_method: null,
                      matched_at: null,
                      suggestion: suggestionMerge({
                        autoRevert: { at: new Date().toISOString(), payoutId: exact[0].id, reason: 'a concurrently arrived payout made the match ambiguous' },
                      }, ['reconcilePending', 'verifyPending']),
                      updated_at: new Date(),
                    });
                  // CAS no-op = someone else already changed the row —
                  // their write owns the outcome
                  if (!undone) return;
                  rolledBack = true;
                  if (sp && sp.reconciled && sp.reconciled_by === `bank-import:${row.id}`) {
                    const { reconcilePayout } = require('./stripe-banking');
                    await reconcilePayout(exact[0].id, Number(row.amount), `Ambiguity rollback for bank import row ${row.id}`, `bank-import:${row.id}`, 'rejected', { trx });
                  }
                });
              } catch (rollbackErr) {
                // the transaction rolled everything back together — the
                // claim stands (rare; a later pass re-verifies via the
                // pending-retry path)
                logger.warn(`[bank-import] ambiguity rollback for row ${row.id} failed — link kept: ${rollbackErr.message}`);
              }
              if (rolledBack) summary.ambiguous++;
              continue; // never echo a reverted (or foreign-owned) claim
            }
            summary.payoutsLinked++;
            // Extend the EXISTING reconciliation mechanism (bank_reconciliation
            // + stripe_payouts.reconciled via stripe-banking) rather than
            // keeping a parallel Tax-only status — /admin/banking must see the
            // same truth. Failure here never un-links the row: the link is
            // real, reconciliation is the ledger echo, and the flag retries.
            try {
              // guarded + preconditioned inside the helper: a human who
              // reconciled since the candidate read, or an admin unlink
              // during this await, makes the echo skip — never clobber.
              // A human-REJECTED reconciliation reverts the link entirely.
              const echo = await echoPayoutReconciliation(row.id, exact[0].id, row.amount, `Auto-matched to bank import row ${row.id}`);
              if (echo && echo.skipped && echo.reason === 'human_rejected') {
                summary.payoutsLinked--;
                summary.humanRejected = (summary.humanRejected || 0) + 1;
              } else if (echo && echo.amountMismatchReverted) {
                summary.payoutsLinked--;
                summary.amountMismatchReverted = (summary.amountMismatchReverted || 0) + 1;
              } else if (echo && echo.ineligibleReverted) {
                summary.payoutsLinked--;
                summary.payoutIneligibleReverted = (summary.payoutIneligibleReverted || 0) + 1;
              }
            } catch (reconErr) {
              // flag already persisted with the claim — the sweep retries
              logger.warn(`[bank-import] payout ${exact[0].id} linked but reconciliation write failed (sweep will retry): ${reconErr.message}`);
            }
          }
        } catch (err) {
          if (!isUniqueViolation(err)) throw err; // lost the claim race — skip
        }
      } else if (candidates.length > 0) {
        // Ambiguous (or near-miss-only) payout credits park their candidates
        // so the operator has a manual link path — without this the credit
        // is permanently unmatched even when the right payout is obvious.
        // Likeliest-first, deterministic (nearest arrival to the posting
        // date, then id) and bounded at 20 with the honest total — the
        // link-payout route validates by the matcher's plausibility RULES,
        // not slice membership, so an off-slice payout stays linkable.
        // Refund candidates park ALONGSIDE when both are plausible: an
        // unrelated same-amount payout in the window must not hide the
        // legitimate refund action (the UI offers the union) — otherwise
        // the operator could only reach the refund by linking and unlinking
        // a known-wrong payout. Stale refund keys are subtracted only when
        // no refund target survives the rescan.
        summary.ambiguous++;
        const refunds = await refundCandidateList();
        const arrivalDistance = (c) => Math.abs(new Date(`${toDateStr(c.arrival_date)}T00:00:00Z`) - new Date(`${txnDate}T00:00:00Z`));
        const parkedPayouts = [...candidates].sort((a, b) => (arrivalDistance(a) - arrivalDistance(b)) || String(a.id).localeCompare(String(b.id)));
        await db('bank_transactions').where({ id: row.id, status: 'unmatched' }).update({
          suggestion: suggestionMerge({
            payoutCandidates: parkedPayouts.slice(0, 20).map(c => ({ id: c.id, amount: c.effective_amount, arrival_date: toDateStr(c.arrival_date) })),
            payoutCandidatesTotal: candidates.length,
            ...(refunds.length ? refundPatch(refunds) : {}),
          }, refunds.length ? ['noMatch'] : ['refundCandidates', 'refundCandidatesTotal', 'noMatch']),
          updated_at: new Date(),
        });
      } else if (candidates.length === 0) {
        // No payout explains this bank credit — it can still be a merchant
        // refund into checking (debit-card purchase refunded). Without this
        // path the operator's only actions were Ignore or a wrong payout
        // link, leaving the original expense overstated.
        const refunds = await refundCandidateList();
        if (refunds.length) {
          summary.ambiguous++;
          await db('bank_transactions').where({ id: row.id, status: 'unmatched' }).update({
            suggestion: suggestionMerge(refundPatch(refunds), ['payoutCandidates', 'payoutCandidatesTotal', 'noMatch']),
            updated_at: new Date(),
          });
        } else {
          await markScanned(row); // nothing to propose — leave the fresh pool
        }
      }
      continue;
    }

    // The COMPLETE candidate survey — net and gross identities. Reused
    // inside the claim transaction (uniqueness re-judged atomically with
    // the claim), the post-claim verify, and the crash-recovery sweep.
    const surveyExpenseCandidates = (dbOrTrx = db) => surveyExpenseCandidatesForRow(row, rejected, dbOrTrx);
    const candidates = await surveyExpenseCandidates(db);
    // The amount a candidate matches AT: its gross when refunds already
    // reduced it, its current amount otherwise.
    const matchAmount = (c) => (c.gross_amount != null ? Number(c.gross_amount) : Number(c.amount));
    // Auto-link needs exact cents + vendor evidence + a compatible payment
    // method + a UNIQUE candidate set: one strong candidate among other
    // same-amount-window expenses still parks — the hands-off rule is that
    // any plurality goes to the operator, evidence or not. Incompatible-
    // method expenses PARK too — the operator may know the books are
    // mislabeled.
    const strong = candidates.filter(c => centsEqual(matchAmount(c), row.amount) && vendorEvidence(row.description, c) && !methodIncompatible(row.account_type, c.payment_method));
    if (candidates.length === 1 && strong.length === 1) {
      let claimedExpense = false;
      try {
        // Claim with the candidate expense LOCKED and every matching
        // predicate revalidated against its CURRENT values — the earlier
        // candidate read was unlocked, and a concurrent expense edit
        // (amount, date, vendor, method) must not produce a link that no
        // longer satisfies the policy. A changed expense simply skips;
        // the next pass re-evaluates it.
        await db.transaction(async (trx) => {
          const fresh = await trx('expenses').where({ id: strong[0].id }).forUpdate()
            .first('id', 'amount', 'description', 'vendor_name', 'expense_date', 'payment_method');
          if (!fresh) return;
          // Uniqueness re-judged ATOMICALLY with the claim: an expense
          // inserted between the unlocked survey and this lock can make the
          // set plural, and the plurality rule says park, not link. The
          // next pass re-parks the row with the fuller candidate list.
          const recheck = await surveyExpenseCandidates(trx);
          if (!(recheck.length === 1 && recheck[0].id === fresh.id)) return;
          const freshDate = toDateStr(fresh.expense_date);
          // a gross candidate revalidates at amount + CURRENT applied
          // refunds (re-summed under the lock — an undo since the read
          // changes the gross and must void the match)
          const freshMatchAmount = strong[0].gross_amount != null
            ? Number(fresh.amount) + await appliedRefundTotal(fresh.id, trx)
            : Number(fresh.amount);
          const stillValid = centsEqual(freshMatchAmount, row.amount)
            && vendorEvidence(row.description, fresh)
            && !methodIncompatible(row.account_type, fresh.payment_method)
            && freshDate >= addDays(txnDate, -EXPENSE_DATE_WINDOW_DAYS)
            && freshDate <= addDays(txnDate, EXPENSE_DATE_WINDOW_DAYS);
          if (!stillValid) return;
          const changed = await trx('bank_transactions')
            .where({ id: row.id, status: 'unmatched' })
            .update({
              status: 'matched_expense',
              matched_expense_id: strong[0].id,
              match_method: 'expense_amount_date_vendor',
              matched_at: new Date(),
              updated_at: new Date(),
              // durable verification marker, persisted ATOMICALLY with the
              // claim (the reconcilePending pattern): a crash between this
              // commit and the post-claim verify below must leave a marker
              // the verifyPendingExpenseClaims sweep can finish — never a
              // possibly-ambiguous link nothing ever revisits
              suggestion: suggestionMerge({ verifyPending: true }),
            });
          if (changed) claimedExpense = true;
        });
        if (claimedExpense) {
          // POST-CLAIM plurality verify: READ COMMITTED lets an expense
          // whose insert COMMITS during the claim transaction slip past the
          // locked recheck (a phantom — only the chosen expense row was
          // locked). This fresh-snapshot survey sees every insert that
          // committed before this statement; plural → revert the claim and
          // let the next pass park the row with the full list. An insert
          // committing after this point is simply a LATER expense — it
          // never retro-invalidates a link (same line the edited-expense
          // healer draws).
          const after = await surveyExpenseCandidates(db);
          if (after.length === 1 && after[0].id === strong[0].id) {
            await db('bank_transactions')
              .where({ id: row.id, status: 'matched_expense', matched_expense_id: strong[0].id })
              .update({ suggestion: db.raw("suggestion - 'verifyPending'"), updated_at: new Date() });
            summary.expensesLinked++;
          } else {
            const undone = await db('bank_transactions')
              .where({ id: row.id, status: 'matched_expense', matched_expense_id: strong[0].id })
              .update({
                status: 'unmatched',
                matched_expense_id: null,
                match_method: null,
                matched_at: null,
                suggestion: suggestionMerge({
                  autoRevert: { at: new Date().toISOString(), expenseId: strong[0].id, reason: 'a concurrently added expense made the match ambiguous' },
                }, ['verifyPending']),
                updated_at: new Date(),
              });
            // CAS no-op = someone else already changed the row (unlink or
            // re-match) — their write owns the outcome, count nothing
            if (undone) summary.ambiguous++;
          }
        }
      } catch (err) {
        if (!isUniqueViolation(err)) throw err; // lost the claim race — skip
      }
    } else if (candidates.length > 0) {
      summary.ambiguous++;
      // noMatch subtracted whenever candidates park (here and in the credit
      // branches): a row that was noMatch and later gained candidates would
      // otherwise take markScanned's early bump-only branch forever, and
      // stale candidate lists would never be cleaned up once the targets
      // disappeared. The two states are mutually exclusive by construction.
      // deterministic display order (newest first, then id) — an unordered
      // slice made the visible subset arbitrary run-to-run
      const parkedCandidates = [...candidates].sort((a, b) => String(toDateStr(b.expense_date)).localeCompare(String(toDateStr(a.expense_date)))
        || String(a.id).localeCompare(String(b.id)));
      await db('bank_transactions').where({ id: row.id, status: 'unmatched' }).update({
        suggestion: suggestionMerge({
          // amount included (the GROSS reading for refund-reduced
          // candidates — that is the figure the statement debit carries):
          // same-vendor same-day near-misses inside the one-cent tolerance
          // are otherwise indistinguishable in the picker, and manually
          // linking the wrong one consumes the wrong ledger expense
          candidates: parkedCandidates.slice(0, 20).map(c => ({ id: c.id, amount: c.gross_amount != null ? Number(c.gross_amount) : Number(c.amount), description: c.description, vendor_name: c.vendor_name, expense_date: toDateStr(c.expense_date) })),
          candidatesTotal: candidates.length,
        }, ['noMatch']),
        updated_at: new Date(),
      });
    } else {
      await markScanned(row); // nothing to propose — leave the fresh pool
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
  // Refund-aware: an applied refund credit NETS against the month's outflow,
  // and a debit's covered value is capped at the CURRENT linked expense
  // amount (apply-refund reduces it after linking) — otherwise a $58 debit
  // linked to a now-$38 expense would still report $58 covered.
  // Refund rows join the DEBIT that claims their target expense (at most
  // one — matched_expense_id is partially unique): the refund then nets
  // against total in the PURCHASE's month, matching where the LEAST cap
  // reduces covered — a July purchase refunded in August stays 100%-covered
  // in July instead of skewing two months. A refund against a MANUAL
  // expense (no claiming debit) doesn't net at all — otherwise total would
  // shrink without touching covered and coverage could exceed 100%.
  const rows = await db('bank_transactions as bt')
    .leftJoin('expenses as e', 'e.id', 'bt.matched_expense_id')
    .leftJoin('bank_transactions as bt2', function refundTargetDebit() {
      this.on(db.raw("bt.status = 'refund_applied'"))
        .andOn(db.raw('bt2.matched_expense_id is not null'))
        .andOn(db.raw("bt2.matched_expense_id::text = bt.suggestion->>'refundAppliedTo'"));
    })
    .whereNot('bt.status', 'ignored')
    .whereRaw('extract(year from coalesce(bt2.txn_date, bt.txn_date)) = ?', [Number(year)])
    .where(function scope() {
      this.where('bt.direction', 'debit').orWhere('bt.status', 'refund_applied');
    })
    .select(
      db.raw("to_char(coalesce(bt2.txn_date, bt.txn_date), 'YYYY-MM') as month"),
      db.raw(`sum(case
        when bt.direction = 'debit' then bt.amount
        when bt2.id is not null then -bt.amount
        else 0 end) as total`),
      db.raw("sum(case when bt.direction = 'debit' and bt.status in ('matched_expense','created_expense') and bt.matched_expense_id is not null then least(bt.amount, greatest(coalesce(e.amount, 0), 0)) else 0 end) as covered"),
    )
    .groupByRaw("to_char(coalesce(bt2.txn_date, bt.txn_date), 'YYYY-MM')")
    .orderBy('month');
  return rows.map(r => {
    const total = Number(r.total) || 0;
    const covered = Number(r.covered) || 0;
    // honest bounds even under edge orderings: never negative unexplained,
    // never >100%
    return {
      month: r.month,
      total,
      covered,
      unexplained: Math.max(0, Math.round((total - covered) * 100) / 100),
      pct: total > 0 ? Math.min(100, Math.round((covered / total) * 100)) : null,
    };
  });
}

module.exports = {
  parseStatementCsv,
  withRowHashes,
  hashRow,
  transferSuggestion,
  runDeterministicMatching,
  echoPayoutReconciliation,
  isPlausibleExpenseLink,
  isPlausiblePayoutLink,
  isPlausibleRefundTarget,
  appliedRefundTotal,
  refundCandidatesForRow,
  surveyExpenseCandidatesForRow,
  surveyPayoutCandidatesForRow,
  rejectedTargets,
  resetDanglingLinks,
  healEditedExpenseLinks,
  healUnreconciledLinks,
  healOrphanRefunds,
  methodIncompatible,
  effectivePayoutAmount,
  suggestionMerge,
  ledgerCoverage,
  // exported for tests
  parseAmount,
  parseDateCell,
  addDays,
  toDateStr,
  vendorEvidence,
  significantTokens,
};
