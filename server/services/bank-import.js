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
    const latest = await db('bank_reconciliation')
      .where('payout_id', row.matched_payout_id)
      .orderBy('reconciled_at', 'desc')
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc') // deterministic final tie-breaker
      .first('status', 'reconciled_by');
    if (latest && latest.status === 'rejected' && !String(latest.reconciled_by || '').startsWith('bank-import')) {
      const { reconcilePending, ...rest } = row.suggestion || {};
      const changed = await db('bank_transactions')
        .where({ id: row.id, status: 'matched_payout', matched_payout_id: row.matched_payout_id })
        .update({
          status: 'unmatched',
          matched_payout_id: null,
          match_method: null,
          matched_at: null,
          suggestion: {
            ...rest,
            rejectedPayoutIds: [...new Set([...(rest.rejectedPayoutIds || []), row.matched_payout_id])],
            autoRevert: { at: new Date().toISOString(), payoutId: row.matched_payout_id, reason: 'reconciliation rejected by a human on the Banking page' },
          },
          updated_at: new Date(),
        });
      if (changed) reverted++;
    } else {
      const changed = await db('bank_transactions')
        .where({ id: row.id, status: 'matched_payout', matched_payout_id: row.matched_payout_id })
        .update({ suggestion: { ...(row.suggestion || {}), reconcilePending: true }, updated_at: new Date() });
      if (changed) remarked++;
    }
  }
  return { reverted, remarked };
}

async function retryPendingReconciliations() {
  const healLinks = await healUnreconciledLinks();
  const pending = await db('bank_transactions')
    .where({ status: 'matched_payout' })
    .whereNotNull('matched_payout_id')
    .whereRaw("suggestion->>'reconcilePending' = 'true'")
    .select('id', 'amount', 'matched_payout_id', 'suggestion');
  let retried = 0;
  let humanRejected = 0;
  for (const row of pending) {
    const payout = await db('stripe_payouts').where({ id: row.matched_payout_id }).first('id', 'reconciled');
    if (payout && !payout.reconciled) {
      try {
        // The shared helper handles the whole outcome ladder: echo when
        // unreconciled, atomic skip when someone else reconciled or the
        // link changed, and a full claim REVERT when a human rejected this
        // payout's reconciliation (their ruling outranks the link). It also
        // clears the pending flag scoped to this exact link.
        const result = await echoPayoutReconciliation(row.id, row.matched_payout_id, Number(row.amount), `Auto-matched to bank import row ${row.id} (retry)`);
        if (!(result && result.skipped)) retried++;
        else if (result.reason === 'human_rejected') humanRejected++;
      } catch (err) {
        logger.warn(`[bank-import] reconciliation retry for payout ${payout.id} failed again: ${err.message}`);
      }
    } else {
      // payout reconciled meanwhile (intent satisfied) or deleted (nothing
      // to echo) — clear the flag, scoped to the exact link processed so a
      // re-matched row's newer flag survives
      await db('bank_transactions')
        .where({ id: row.id, status: 'matched_payout', matched_payout_id: row.matched_payout_id })
        .update({ suggestion: db.raw("suggestion - 'reconcilePending'"), updated_at: new Date() });
    }
  }

  // (Reversals need no sweep: the unlink route runs its unlink CAS inside
  // the reversal's own transaction, so a failed reversal rolls the unlink
  // back — there is never a committed unlink awaiting reversal.)
  return { pending: pending.length, retried, humanRejected, linksReverted: healLinks.reverted, linksRemarked: healLinks.remarked };
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
  // A human's explicit REJECTION of this payout's reconciliation outranks
  // the link itself: leaving the row matched would have Tax claiming a
  // payout Banking keeps rejected, with no pending state to repair it.
  // Revert the claim, remember the payout as rejected for this row (the
  // matcher's exclusion list), and let the operator decide.
  if (result && result.skipped && result.reason === 'human_rejected') {
    const cur = await db('bank_transactions')
      .where({ id: rowId, status: 'matched_payout', matched_payout_id: payoutId })
      .first('suggestion');
    if (cur) {
      const { reconcilePending, ...rest } = cur.suggestion || {};
      await db('bank_transactions')
        .where({ id: rowId, status: 'matched_payout', matched_payout_id: payoutId })
        .update({
          status: 'unmatched',
          matched_payout_id: null,
          match_method: null,
          matched_at: null,
          suggestion: {
            ...rest,
            rejectedPayoutIds: [...new Set([...(rest.rejectedPayoutIds || []), payoutId])],
            autoRevert: { at: new Date().toISOString(), payoutId, reason: 'reconciliation rejected by a human on the Banking page' },
          },
          updated_at: new Date(),
        });
    }
    return result;
  }
  // Any other guard skip resolves the intent too — either the payout is
  // already reconciled (nothing to echo) or the row is no longer linked
  // (nothing to clear; the scoped CAS below no-ops). jsonb key-subtraction
  // removes ONLY the flag, and the CAS scopes it to THIS link — if an
  // unlink + re-match to a different payout landed since, the newer link
  // keeps its own pending flag and the sweep still retries it.
  await db('bank_transactions')
    .where({ id: rowId, status: 'matched_payout', matched_payout_id: payoutId })
    .update({ suggestion: db.raw("suggestion - 'reconcilePending'"), updated_at: new Date() });
  return result;
}

// Rejected-target ruling for a row: every id the operator has ever unlinked
// from it (cumulative arrays; the single lastUnlink id folds in for rows
// written before the arrays existed).
function rejectedTargets(suggestion) {
  const last = suggestion?.lastUnlink || {};
  const expenseIds = new Set(suggestion?.rejectedExpenseIds || []);
  const payoutIds = new Set(suggestion?.rejectedPayoutIds || []);
  if (last.expenseId) expenseIds.add(last.expenseId);
  if (last.payoutId) payoutIds.add(last.payoutId);
  return { expenseIds: [...expenseIds], payoutIds: [...payoutIds] };
}

// A card-statement debit cannot be an expense the books already know was
// paid by ACH, check, or cash — such an "exact" match is a coincidence and
// auto-linking it would hide the real card purchase from review. Unknown
// methods stay eligible (they park for the operator when not unique).
// Bank-side debits are NOT restricted: checking outflow legitimately books
// as ach, check, or card (debit-card-on-checking).
function methodIncompatible(accountType, paymentMethod) {
  return accountType === 'card' && ['ach', 'check', 'cash'].includes(String(paymentMethod || '').toLowerCase());
}

async function runDeterministicMatching({ limit } = {}) {
  const healed = await resetDanglingLinks();
  const reconciliation = await retryPendingReconciliations();
  const bounded = Number.isFinite(limit) && limit > 0;
  const baseSelect = () => db('bank_transactions')
    .where({ status: 'unmatched' })
    .orderBy('txn_date', 'asc')
    .select('id', 'txn_date', 'description', 'amount', 'direction', 'account_type', 'suggestion');
  // Rows the matcher already examined (transfer-flagged, parked candidates)
  // stay unmatched by design — a bounded oldest-first scan would let them
  // fill the window forever and starve newer imports. Bounded passes take
  // NEVER-EXAMINED rows first, then spend any leftover budget re-scanning
  // examined rows (oldest first) so a new expense can still resolve them.
  // jsonb_exists_any = the function form of the ?| any-key operator —
  // knex.raw treats bare ? (and ??) as binding placeholders and would eat
  // the operator, silently binding the LIMIT value into it.
  const EXAMINED_SQL = "jsonb_exists_any(suggestion, array['ignore','candidates','payoutCandidates','noMatch'])";
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
    await db('bank_transactions')
      .where({ id: row.id, status: 'unmatched' })
      .update({ suggestion: { ...(row.suggestion || {}), noMatch: true }, updated_at: new Date() });
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
    if (!moreFresh && unmatched.length < limit) {
      const fill = limit - unmatched.length;
      // ROTATION: the examined pool is served oldest-UPDATED first, and
      // every rescan (re-park, transfer re-check, or the markScanned bump)
      // touches updated_at — round-robin, so no examined row is starved
      // out of the leftover budget by an older sibling.
      const examined = await db('bank_transactions')
        .where({ status: 'unmatched' })
        .whereRaw(`suggestion is not null and ${EXAMINED_SQL}`)
        .orderBy('updated_at', 'asc')
        .limit(fill + 1)
        .select('id', 'txn_date', 'description', 'amount', 'direction', 'account_type', 'suggestion');
      moreExamined = examined.length > fill;
      unmatched = unmatched.concat(examined.slice(0, fill));
    }
    moreRemaining = moreFresh || moreExamined;
  }
  const summary = { scanned: unmatched.length, moreRemaining, payoutsLinked: 0, expensesLinked: 0, transferFlagged: 0, ambiguous: 0, healed, reconcileRetried: reconciliation.retried, reconcilePending: reconciliation.pending, linksReverted: reconciliation.linksReverted, linksRemarked: reconciliation.linksRemarked };

  for (const row of unmatched) {
    const txnDate = toDateStr(row.txn_date);
    // An operator's explicit unlink is a ruling: the automatic pass never
    // re-proposes ANY previously rejected target — including earlier
    // rejections, not just the latest. (Manual re-link stays possible.)
    const rejected = rejectedTargets(row.suggestion);
    const transfer = transferSuggestion(row.description);
    if (transfer) {
      if (!row.suggestion || !row.suggestion.ignore) {
        // merged, not replaced — suggestion also carries durable identity
        // records (forceToken/forcedFor, lastUnlink) that must survive
        await db('bank_transactions').where({ id: row.id, status: 'unmatched' }).update({ suggestion: { ...(row.suggestion || {}), ...transfer }, updated_at: new Date() });
        summary.transferFlagged++;
      } else if (bounded) {
        // rotation bump — an already-flagged row rescanned by a bounded
        // pass goes to the back of the examined queue (see markScanned)
        await db('bank_transactions').where({ id: row.id, status: 'unmatched' }).update({ updated_at: new Date() });
      }
      continue; // transfer-looking rows never auto-match anything
    }

    if (row.direction === 'credit') {
      // Stripe pays out to the BANK account only — a credit on a card
      // statement is a merchant refund or payment credit, never a payout,
      // and auto-linking one would hide it from review.
      if (row.account_type !== 'bank') { await markScanned(row); continue; }
      let payoutQuery = db('stripe_payouts')
        // Only money that actually REACHED the bank can explain a bank
        // credit — pending/in-transit/canceled/failed payouts are excluded.
        .where('status', 'paid')
        // [D-3, D+3] inclusive: lower bound inclusive, upper bound strictly
        // below the D+4 midnight so the window matches its documentation.
        .where('arrival_date', '>=', new Date(`${addDays(txnDate, -PAYOUT_DATE_WINDOW_DAYS)}T00:00:00Z`))
        .andWhere('arrival_date', '<', new Date(`${addDays(txnDate, PAYOUT_DATE_WINDOW_DAYS + 1)}T00:00:00Z`))
        .whereRaw('abs(amount - ?) <= ?', [row.amount, CANDIDATE_AMOUNT_TOLERANCE])
        .whereNotExists(function claimed() {
          this.select(1).from('bank_transactions as bt').whereRaw('bt.matched_payout_id = stripe_payouts.id');
        })
        .select('id', 'amount', 'arrival_date')
        // 8 is a parking cap, not a uniqueness cap: auto-link still demands
        // candidates.length === 1, so a cap-hidden extra can only PREVENT a
        // link, never fake "exactly one".
        .limit(8);
      if (rejected.payoutIds.length) payoutQuery = payoutQuery.whereNotIn('id', rejected.payoutIds);
      const candidates = await payoutQuery;
      const exact = candidates.filter(c => centsEqual(c.amount, row.amount));
      if (candidates.length === 1 && exact.length === 1) {
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
              suggestion: { ...(row.suggestion || {}), reconcilePending: true },
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
        summary.ambiguous++;
        await db('bank_transactions').where({ id: row.id, status: 'unmatched' }).update({
          suggestion: {
            ...(row.suggestion || {}),
            payoutCandidates: candidates.map(c => ({ id: c.id, amount: Number(c.amount), arrival_date: toDateStr(c.arrival_date) })),
            payoutCandidatesTotal: candidates.length,
          },
          updated_at: new Date(),
        });
      } else if (candidates.length === 0) {
        await markScanned(row); // nothing to propose — leave the fresh pool
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
    // Auto-link needs exact cents + vendor evidence + a compatible payment
    // method + a UNIQUE candidate set: one strong candidate among other
    // same-amount-window expenses still parks — the hands-off rule is that
    // any plurality goes to the operator, evidence or not. Incompatible-
    // method expenses PARK too — the operator may know the books are
    // mislabeled.
    const strong = candidates.filter(c => centsEqual(c.amount, row.amount) && vendorEvidence(row.description, c) && !methodIncompatible(row.account_type, c.payment_method));
    if (candidates.length === 1 && strong.length === 1) {
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
        suggestion: {
          ...(row.suggestion || {}),
          candidates: candidates.slice(0, 20).map(c => ({ id: c.id, description: c.description, vendor_name: c.vendor_name, expense_date: toDateStr(c.expense_date) })),
          candidatesTotal: candidates.length,
        },
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
  hashRow,
  transferSuggestion,
  runDeterministicMatching,
  echoPayoutReconciliation,
  isPlausibleExpenseLink,
  isPlausiblePayoutLink,
  ledgerCoverage,
  // exported for tests
  parseAmount,
  parseDateCell,
  addDays,
  toDateStr,
  vendorEvidence,
  significantTokens,
};
