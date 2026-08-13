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
// arithmetic on the raw value shifts a day depending on server zone (same
// trap and fix as pnl-report's dateCellStr). Strings pass through by prefix.
function toDateStr(v) {
  if (typeof v === 'string') return v.slice(0, 10);
  const d = new Date(v);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
    .select('bt.id as id', 'bt.amount as amount', 'bt.matched_payout_id as matched_payout_id', 'sp.amount as payout_amount');
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
  for (const row of linkedReconciled) {
    const effective = confirmedAmounts.has(row.matched_payout_id)
      ? confirmedAmounts.get(row.matched_payout_id)
      : Number(row.payout_amount); // reconciled but no confirmed row — same fallback as effectivePayoutAmount
    if (withinCandidateTolerance(effective, row.amount)) continue;
    await db.transaction(async (trx) => {
      const sp = await trx('stripe_payouts').where('id', row.matched_payout_id).forUpdate().first('id', 'amount', 'reconciled');
      if (!sp || !sp.reconciled) return; // state changed since the scan
      const lockedEffective = await effectivePayoutAmount(sp, trx);
      if (withinCandidateTolerance(lockedEffective, row.amount)) return;
      const changed = await trx('bank_transactions')
        .where({ id: row.id, status: 'matched_payout', matched_payout_id: row.matched_payout_id })
        .update({
          status: 'unmatched',
          matched_payout_id: null,
          match_method: null,
          matched_at: null,
          suggestion: suggestionMerge({
            autoRevert: { at: new Date().toISOString(), payoutId: row.matched_payout_id, reason: 'a later human reconciliation recorded a different banked amount' },
          }, ['reconcilePending']),
          updated_at: new Date(),
        });
      if (changed) amountReverts++;
    });
  }
  return { reverted: reverted + amountReverts, remarked };
}

// A refund_applied credit whose target expense was DELETED must leave that
// state — its netting would keep skewing coverage while the adjustment it
// represents no longer exists. (The link lives in suggestion JSON, so the
// FK SET NULL self-heal can't see it.)
async function healOrphanRefunds() {
  const rows = await db('bank_transactions')
    .where({ status: 'refund_applied' })
    .select('id', 'suggestion');
  let reverted = 0;
  for (const row of rows) {
    const target = row.suggestion?.refundAppliedTo;
    if (!target) continue;
    const expense = await db('expenses').where({ id: target }).first('id');
    if (expense) continue;
    const changed = await db('bank_transactions')
      .where({ id: row.id, status: 'refund_applied' })
      .update({
        status: 'unmatched',
        match_method: null,
        matched_at: null,
        suggestion: suggestionMerge({
          autoRevert: { at: new Date().toISOString(), expenseId: target, reason: 'the refunded expense was deleted' },
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
  const pending = await db('bank_transactions')
    .where({ status: 'matched_payout' })
    .whereNotNull('matched_payout_id')
    .whereRaw("suggestion->>'reconcilePending' = 'true'")
    .select('id', 'amount', 'matched_payout_id', 'suggestion');
  let retried = 0;
  let humanRejected = 0;
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
      } catch (err) {
        logger.warn(`[bank-import] reconciliation retry for payout ${payout.id} failed again: ${err.message}`);
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
  return { pending: pending.length, retried, humanRejected, linksReverted: healLinks.reverted, linksRemarked: healLinks.remarked, orphanRefundsReverted: orphanRefunds };
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
    precondition: (trx) => trx('bank_transactions')
      .where({ id: rowId, status: 'matched_payout', matched_payout_id: payoutId })
      .forUpdate().first('id').then(Boolean),
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
  if (result && result.skipped && (result.reason === 'human_rejected' || result.reason === 'guard')) {
    let outcome = null;
    await db.transaction(async (trx) => {
      const sp = await trx('stripe_payouts').where('id', payoutId).forUpdate().first('id', 'amount', 'reconciled');
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
      if (sp.reconciled) {
        const effective = await effectivePayoutAmount(sp, trx);
        if (!withinCandidateTolerance(effective, amount)) {
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
// Stripe" means.
function stripeShapedDescription(description) {
  return /stripe/i.test(String(description || ''));
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
  const summary = { scanned: unmatched.length, moreRemaining, payoutsLinked: 0, expensesLinked: 0, transferFlagged: 0, ambiguous: 0, healed, reconcileRetried: reconciliation.retried, reconcilePending: reconciliation.pending, linksReverted: reconciliation.linksReverted, linksRemarked: reconciliation.linksRemarked, orphanRefundsReverted: reconciliation.orphanRefundsReverted };

  for (const row of unmatched) {
    const txnDate = toDateStr(row.txn_date);
    // An operator's explicit unlink is a ruling: the automatic pass never
    // re-proposes ANY previously rejected target — including earlier
    // rejections, not just the latest. (Manual re-link stays possible.)
    const rejected = rejectedTargets(row.suggestion);
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
      if (!row.suggestion || !row.suggestion.ignore) {
        // merged, not replaced — suggestion also carries durable identity
        // records (forceToken/forcedFor, lastUnlink) that must survive
        await db('bank_transactions').where({ id: row.id, status: 'unmatched' }).update({ suggestion: suggestionMerge(transfer), updated_at: new Date() });
        summary.transferFlagged++;
      } else if (bounded) {
        // rotation bump — an already-flagged row rescanned by a bounded
        // pass goes to the back of the examined queue (see markScanned)
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
      const parkRefundCandidates = async () => {
        const originals = await db('expenses')
          .whereBetween('expense_date', [addDays(txnDate, -REFUND_LOOKBACK_DAYS), txnDate])
          .where('amount', '>=', row.amount)
          .select('id', 'amount', 'description', 'vendor_name', 'expense_date', 'payment_method');
        const refundCandidates = originals.filter(c => vendorEvidence(row.description, c) && !methodIncompatible(row.account_type, c.payment_method));
        if (!refundCandidates.length) return false;
        // Likeliest-first, deterministic: nearest covering amount, then the
        // most recent purchase, then id — so the real original sits inside
        // the bounded visible slice even for a high-frequency vendor. The
        // apply route validates by the same plausibility RULES, not by
        // membership in this display slice, so an off-slice original is
        // still applicable.
        refundCandidates.sort((a, b) => (Number(a.amount) - Number(b.amount))
          || String(toDateStr(b.expense_date)).localeCompare(String(toDateStr(a.expense_date)))
          || String(a.id).localeCompare(String(b.id)));
        summary.ambiguous++;
        // stale payout keys subtracted: whichever list is present is the
        // row's ONE review action, and the UI dispatches on that
        await db('bank_transactions').where({ id: row.id, status: 'unmatched' }).update({
          suggestion: suggestionMerge({
            refundCandidates: refundCandidates.slice(0, 20).map(c => ({ id: c.id, amount: Number(c.amount), vendor_name: c.vendor_name, description: c.description, expense_date: toDateStr(c.expense_date) })),
            refundCandidatesTotal: refundCandidates.length,
          }, ['payoutCandidates', 'payoutCandidatesTotal']),
          updated_at: new Date(),
        });
        return true;
      };
      // Stripe pays out to the BANK account only — card credits skip payout
      // matching entirely.
      if (row.account_type !== 'bank') {
        if (!(await parkRefundCandidates())) await markScanned(row);
        continue;
      }
      let payoutQuery = db('stripe_payouts')
        // Only money that actually REACHED the bank can explain a bank
        // credit — pending/in-transit/canceled/failed payouts are excluded.
        .where('status', 'paid')
        // [D-3, D+3] inclusive: lower bound inclusive, upper bound strictly
        // below the D+4 midnight so the window matches its documentation.
        .where('arrival_date', '>=', new Date(`${addDays(txnDate, -PAYOUT_DATE_WINDOW_DAYS)}T00:00:00Z`))
        .andWhere('arrival_date', '<', new Date(`${addDays(txnDate, PAYOUT_DATE_WINDOW_DAYS + 1)}T00:00:00Z`))
        // NO amount filter in SQL: a reconciled payout's true banked amount
        // is its confirmed actual_amount, which SQL can't see here — an
        // expected-amount filter could drop the real candidate and make a
        // different payout look uniquely matchable. Amounts are compared in
        // JS over the whole (naturally small) date window.
        .whereNotExists(function claimed() {
          this.select(1).from('bank_transactions as bt').whereRaw('bt.matched_payout_id = stripe_payouts.id');
        })
        .select('id', 'amount', 'arrival_date', 'reconciled', 'bank_last_four')
        .limit(50); // safety net far above any real 7-day payout count
      if (rejected.payoutIds.length) payoutQuery = payoutQuery.whereNotIn('id', rejected.payoutIds);
      const fetched = await payoutQuery;
      // reconciled candidates compare against their confirmed ACTUAL amount
      const withEffective = [];
      for (const c of fetched) withEffective.push({ ...c, effective_amount: await effectivePayoutAmount(c) });
      const bankingRejected = new Set(rejected.bankingPayoutIds);
      const candidates = withEffective
        .filter(c => withinCandidateTolerance(c.effective_amount, row.amount))
        // a Banking-derived rejection excludes the payout only while it
        // stands: once a corrected 'confirmed' reconciliation flips the
        // payout back to reconciled, it is eligible again
        .filter(c => !(bankingRejected.has(c.id) && !c.reconciled));
      const exact = candidates.filter(c => centsEqual(c.effective_amount, row.amount));
      if (fetched.length === 50) {
        // cap hit = the window wasn't fully surveyed; uniqueness would be a
        // guess — park by treating the set as plural
        summary.ambiguous++;
        continue;
      }
      if (candidates.length === 1 && exact.length === 1 && payoutProvenance(row, exact[0])) {
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
              suggestion: suggestionMerge({ reconcilePending: true }),
            });
          if (changed) {
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
        // Stale refund keys subtracted for the same reason as the inverse.
        summary.ambiguous++;
        await db('bank_transactions').where({ id: row.id, status: 'unmatched' }).update({
          suggestion: suggestionMerge({
            payoutCandidates: candidates.slice(0, 8).map(c => ({ id: c.id, amount: c.effective_amount, arrival_date: toDateStr(c.arrival_date) })),
            payoutCandidatesTotal: candidates.length,
          }, ['refundCandidates', 'refundCandidatesTotal']),
          updated_at: new Date(),
        });
      } else if (candidates.length === 0) {
        // No payout explains this bank credit — it can still be a merchant
        // refund into checking (debit-card purchase refunded). Without this
        // path the operator's only actions were Ignore or a wrong payout
        // link, leaving the original expense overstated.
        if (!(await parkRefundCandidates())) await markScanned(row); // nothing to propose — leave the fresh pool
      }
      continue;
    }

    let expenseQuery = db('expenses')
      .whereBetween('expense_date', [addDays(txnDate, -EXPENSE_DATE_WINDOW_DAYS), addDays(txnDate, EXPENSE_DATE_WINDOW_DAYS)])
      .whereRaw('abs(amount - ?) <= ?', [row.amount, CANDIDATE_AMOUNT_TOLERANCE])
      .whereNotExists(function claimed() {
        this.select(1).from('bank_transactions as bt').whereRaw('bt.matched_expense_id = expenses.id');
      })
      // UNBOUNDED on purpose: uniqueness must be judged over the COMPLETE
      // candidate set — a cap could hide a second strong candidate and fake
      // "exactly one". The ±5-day amount-filtered window keeps this small;
      // only the operator-facing suggestion list below is bounded.
      .select('id', 'amount', 'description', 'vendor_name', 'expense_date', 'payment_method');
    if (rejected.expenseIds.length) expenseQuery = expenseQuery.whereNotIn('id', rejected.expenseIds);
    const candidates = await expenseQuery;
    // GROSS-amount candidates: an applied refund already REDUCED the ledger
    // expense, so a later-imported full-price debit no longer matches its
    // net amount and the row would stay unexplained (or bait a duplicate
    // create). The refund credit's suggestion carries the association —
    // join it back and match against amount + applied refunds. Coverage is
    // already refund-aware: covered caps at the CURRENT amount and the
    // refund credit nets the difference in the purchase month.
    let grossQuery = db('expenses as e')
      .join('bank_transactions as rbt', function refundLink() {
        this.on(db.raw("rbt.status = 'refund_applied'"))
          .andOn(db.raw("rbt.suggestion->>'refundAppliedTo' = e.id::text"));
      })
      .whereBetween('e.expense_date', [addDays(txnDate, -EXPENSE_DATE_WINDOW_DAYS), addDays(txnDate, EXPENSE_DATE_WINDOW_DAYS)])
      .whereNotExists(function claimed() {
        this.select(1).from('bank_transactions as bt').whereRaw('bt.matched_expense_id = e.id');
      })
      .groupBy('e.id', 'e.amount', 'e.description', 'e.vendor_name', 'e.expense_date', 'e.payment_method')
      .havingRaw("abs(e.amount + sum((rbt.suggestion->>'refundAmount')::numeric) - ?) <= ?", [row.amount, CANDIDATE_AMOUNT_TOLERANCE])
      .select('e.id', 'e.amount', 'e.description', 'e.vendor_name', 'e.expense_date', 'e.payment_method',
        db.raw("e.amount + sum((rbt.suggestion->>'refundAmount')::numeric) as gross_amount"));
    if (rejected.expenseIds.length) grossQuery = grossQuery.whereNotIn('e.id', rejected.expenseIds);
    const netIds = new Set(candidates.map(c => c.id));
    for (const g of await grossQuery) {
      // a net match wins over its own gross reading — uniqueness is judged
      // over expense IDENTITIES, never the same expense twice
      if (!netIds.has(g.id)) candidates.push({ ...g, gross_amount: Number(g.gross_amount) });
    }
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
            .update({ status: 'matched_expense', matched_expense_id: strong[0].id, match_method: 'expense_amount_date_vendor', matched_at: new Date(), updated_at: new Date() });
          if (changed) summary.expensesLinked++;
        });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err; // lost the claim race — skip
      }
    } else if (candidates.length > 0) {
      summary.ambiguous++;
      await db('bank_transactions').where({ id: row.id, status: 'unmatched' }).update({
        suggestion: suggestionMerge({
          candidates: candidates.slice(0, 20).map(c => ({ id: c.id, description: c.description, vendor_name: c.vendor_name, expense_date: toDateStr(c.expense_date) })),
          candidatesTotal: candidates.length,
        }),
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
