#!/usr/bin/env node
/**
 * import-tax-ledger-csv.js — one-off loader for the owner's classified tax
 * ledger CSVs (2024 / 2025 books built outside the portal).
 *
 * Loads each CSV row into the bank-import staging table (bank_transactions)
 * and, for business outflows, creates the matching `expenses` row so the
 * history lives in the portal. Run ONCE per file, from a shell:
 *
 *   node server/scripts/import-tax-ledger-csv.js --file /path/ledger-2025.csv --dry-run
 *   node server/scripts/import-tax-ledger-csv.js --file /path/ledger-2025.csv
 *
 * It fills a date range the portal has nothing for, and never reconciles the
 * ledger against other rows by guesswork:
 *  - a bank row from a feed or an upload in the file's date range refuses the
 *    run (those rows are classified in Bank Import, with the ledger rules);
 *  - a rerun of the same file loads nothing twice (row_hash is unique): an
 *    unchanged row is a duplicate; a row the file now reads differently, or
 *    whose expense was deleted since, is HELD and listed, never rewritten;
 *  - one file loads one tax year (a file with two years is refused): a
 *    loaded row of that year that is no longer in the file (a corrected
 *    date, text or amount, or a dropped row) refuses the run, because a
 *    loaded row is corrected in Bank Import, not by re-import;
 *  - a ledger expense row with an expense already in the portal (entered by
 *    hand, or from a feed) of the same gross amount within the matcher's
 *    window is loaded as an open review row with no expense: the owner links
 *    it to that expense in Bank Import, or creates the expense there. Every
 *    such portal expense is listed to check once.
 *
 * CSV header (exact):
 *   source,date,description,amount,direction,class,category,sched_c_line,flag,processor_match,bank_category
 *
 * For prod data:
 *   railway run -s Postgres -- bash -c '
 *     DATABASE_URL=$DATABASE_PUBLIC_URL \
 *       node server/scripts/import-tax-ledger-csv.js --file /path/ledger.csv --dry-run
 *   '
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
// Shared with every other expense writer: the calendar-date check and the
// tax period (year + quarter) come from utils/tax-period, the partial-
// deduction policy from services/expense-categorizer, so a correction there
// reaches ledger imports too.
const { taxPeriodFor } = require('../utils/tax-period');
// the year ceiling is the business's calendar (Eastern), not the server's
const { etParts } = require('../utils/datetime-et');
const { categoryDeductibleAmount } = require('../services/expense-categorizer');
// The matcher's receipt-vs-posting window (a hand-entered expense dated a few
// days off the statement still holds the ledger's expense row) and its
// refund-aware gross reading (an expense a refund reduced is compared at the
// amount the bank debited, applied and released refunds included).
const { EXPENSE_DATE_WINDOW_DAYS, LEDGER_NAMED_SOURCES, LEDGER_LOCK_KEY, appliedRefundTotal, methodIncompatible, withinCandidateTolerance } = require('../services/bank-import');

const HEADER = ['source', 'date', 'description', 'amount', 'direction', 'class', 'category', 'sched_c_line', 'flag', 'processor_match', 'bank_category'];
const CLASSES = ['expense', 'vehicle', 'interest', 'personal', 'transfer', 'income_proc', 'receipt_unmatched', 'review', 'reward', 'refund', 'asset', 'unknown'];
const BUSINESS_CLASSES = new Set(['expense', 'vehicle', 'interest']);
const IGNORED_CLASSES = new Set(['personal', 'transfer', 'income_proc', 'reward', 'asset']);
const MONEY_IN_CLASSES = new Set(['refund', 'income_proc', 'receipt_unmatched']);
// A refund credit (class refund, or money IN on a business class) is left
// OPEN: the Bank Import refund flow applies it to the original expense, which
// is what reduces the expense the P&L reads. Ignoring it would leave the
// expense at its gross amount.
const REFUND_REASON = 'refund credit from the ledger: apply it to the original expense in Bank Import (it reduces that expense)';
const CARD_SOURCES = new Set(['9731', '6646', '8804', 'amex']);
// The ledger's source column is one of the business's accounts: a card above
// or a checking account's last four. Anything else ("amexx") is a typo that
// would load as an unknown bank account the portal cannot match, so the file
// fails before any write.
const BANK_SOURCES = new Set(['3098', '3965']);
const KNOWN_SOURCES = new Set([...CARD_SOURCES, ...BANK_SOURCES]);
const MAX_AMOUNT = 9999999999.99; // numeric(12,2)
// The ledgers this loader is for: the first business year on. A transposed
// year ("2052-03-14") would book an expense in a tax year no report shows.
const FIRST_TAX_YEAR = 2024;
const SOURCE_TAG = 'ledger-csv';
const MATCH_METHOD = 'ledger-import';
const INSERT_CHUNK = 500;
const HASH_LOOKUP_CHUNK = 1000;

// Schedule C line -> expense_categories.name (looked up by name at run time:
// ids differ per database). 27a is split by categoryNameForLine.
const LINE_TO_CATEGORY = {
  8: 'Advertising & Marketing',
  9: 'Vehicle Expenses',
  10: 'Commissions & Fees',
  11: 'Contract Labor',
  15: 'Insurance',
  17: 'Legal & Professional',
  18: 'Office Expenses',
  21: 'Repairs & Maintenance',
  22: 'Supplies',
  23: 'Taxes & Licenses',
  25: 'Utilities',
  30: 'Home Office',
  '16a': 'Interest',
  // 16b (other interest) has no category of its own: the seeded Interest
  // category carries irs_line 16a and the tax summaries report the
  // category's line, so a 16b row is parked for review instead of being
  // presented as 16a.
  '24b': 'Meals & Entertainment',
};
// A class with a business meaning but a blank sched_c_line falls back to the
// line that class always lands on.
const CLASS_DEFAULT_LINE = { vehicle: '9', interest: '16a' };

function fail(message) {
  const e = new Error(message);
  e.userFacing = true;
  return e;
}

function toCents(n) {
  return Math.round(Number(n) * 100);
}

function fmtMoney(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

// A money cell: an optional $, digits with no grouping or correctly grouped
// thousands commas, at most two decimals. "12,34" or "1,2,3" is a malformed
// row (a comma that is not a thousands separator), never 1234; a third
// decimal is malformed too, not something to round away.
const AMOUNT_RE = /^\$?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/;
function parseAmountCell(raw) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!AMOUNT_RE.test(text)) return null;
  const n = Number(text.replace(/[$,]/g, ''));
  if (!Number.isFinite(n) || n <= 0 || n > MAX_AMOUNT) return null;
  return n;
}

/**
 * Parse ledger CSV text into validated row objects. Throws a one-line error
 * (userFacing) on a bad header or any bad row: the owner fixes the file and
 * reruns, nothing is half-loaded.
 */
function parseLedgerCsv(text, { now = new Date() } = {}) {
  const lastTaxYear = etParts(now).year;
  let records;
  try {
    records = parse(String(text), { columns: false, skip_empty_lines: true, trim: true, bom: true, relax_column_count: true });
  } catch (err) {
    throw fail(`CSV parse failed: ${err.message}`);
  }
  if (!records.length) throw fail('CSV is empty (no header row)');
  const header = records[0].map(h => String(h).replace(/^﻿/, '').trim());
  const unknown = header.filter(h => !HEADER.includes(h));
  if (unknown.length) throw fail(`unknown column(s) in header: ${unknown.join(', ')}`);
  if (header.length !== HEADER.length || header.some((h, i) => h !== HEADER[i])) {
    throw fail(`header must be exactly: ${HEADER.join(',')}`);
  }
  if (records.length === 1) throw fail('CSV has a header but no rows: nothing to import');
  const rows = [];
  records.slice(1).forEach((rec, i) => {
    const line = i + 2;
    if (rec.length !== HEADER.length) throw fail(`line ${line}: expected ${HEADER.length} columns, found ${rec.length}`);
    const r = {};
    HEADER.forEach((h, k) => { r[h] = String(rec[k] === undefined ? '' : rec[k]).trim(); });
    if (!r.source) throw fail(`line ${line}: missing source`);
    const period = taxPeriodFor(r.date);
    if (!period || Number(period.tax_year) < FIRST_TAX_YEAR || Number(period.tax_year) > lastTaxYear) {
      throw fail(`line ${line}: date must be a real YYYY-MM-DD date in ${FIRST_TAX_YEAR}-${lastTaxYear} (got "${r.date}")`);
    }
    r.period = period;
    if (!r.description) throw fail(`line ${line}: missing description`);
    for (const h of HEADER) {
      if (String(r[h]).includes('\u0000')) throw fail(`line ${line}: ${h} contains a NUL byte`);
    }
    // the source is part of the row identity (hash, ordinal): one spelling,
    // so "AMEX" and "amex" are the same account on a reimport
    r.source = r.source.toLowerCase();
    if (!KNOWN_SOURCES.has(r.source)) throw fail(`line ${line}: source must be one of ${[...KNOWN_SOURCES].join(', ')} (got "${r.source}")`);
    const amount = parseAmountCell(r.amount);
    if (amount === null) throw fail(`line ${line}: amount must be a positive decimal (got "${r.amount}")`);
    r.amount = amount;
    r.direction = r.direction.toLowerCase();
    if (r.direction !== 'in' && r.direction !== 'out') throw fail(`line ${line}: direction must be in or out (got "${r.direction}")`);
    r.class = r.class.toLowerCase();
    if (!CLASSES.includes(r.class)) throw fail(`line ${line}: unknown class "${r.class}"`);
    r.sched_c_line = r.sched_c_line.toLowerCase();
    r.line = line;
    rows.push(r);
  });
  // one file loads one tax year (the rerun rule is per year): a stray year
  // is a typo to fix, never half of a mixed load
  const years = [...new Set(rows.map(r => String(r.period.tax_year)))].sort();
  if (years.length > 1) {
    const count = y => rows.filter(r => String(r.period.tax_year) === y).length;
    const minority = years.slice().sort((a, b) => count(a) - count(b))[0];
    const stray = rows.filter(r => String(r.period.tax_year) === minority).slice(0, 3).map(r => `line ${r.line} (${r.date})`).join(', ');
    throw fail(`the file has rows from tax years ${years.join(', ')}: one file loads one year; fix the stray date(s), e.g. ${stray}`);
  }
  return rows;
}

/**
 * The calendar day of a portal DATE value. A DATE column comes back from pg
 * as a JS Date at LOCAL midnight, so the day is read from the local
 * components, never through a time-zone conversion (an ET conversion of a
 * UTC-midnight Date would give the day before).
 */
function ymdOf(v) {
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  return String(v || '').slice(0, 10);
}

/** sha256 over the ledger identity tuple plus the in-file ordinal. */
function rowHash(source, date, description, amount, direction, ordinal) {
  const tuple = `ledger|${source}|${date}|${description}|${Number(amount).toFixed(2)}|${direction}|${ordinal}`;
  return crypto.createHash('sha256').update(tuple).digest('hex');
}

/**
 * expense_categories.name for a Schedule C line, or null when none applies.
 * 27a (other expenses) is split by the ledger's own category text: software
 * and subscriptions, or dues and education; any other 27a item (bank fees,
 * uniforms, postage ...) is parked for review rather than relabelled.
 */
const SOFTWARE_27A = /software|subscription|saas|\bapp\b|hosting|domain|cloud|\bai\b|api|website|web ?site|email|phone service|technology|plugin|license key/i;
// A processor fee on line 10 is not booked: the P&L adds every synced Stripe
// fee on its own (pnl-report) and a manual expense for it would count it
// twice. Such a row is parked with that note; other line 10 items book.
// Only a STRIPE processing FEE is parked: the P&L adds every synced Stripe
// fee on its own (pnl-report), so a manual expense for one would count it
// twice. A purchase that merely mentions Stripe (a Stripe-processed vendor
// charge, a subscription) is not in that total and books as the expense it
// is; so does any other processor's fee (the Square years), a bank's
// merchant fee or a generic "processing fee". The processor_match column
// (the row matched a processor record, Square or Stripe) is part of the
// reading a rerun compares, not a reason to park.
const STRIPE_RE = /\bstripe\b/i;
const FEE_RE = /\bfees?\b|processing|commission/i;
const PROCESSOR_NOTE = 'Stripe fee: the P&L adds synced Stripe fees on its own; book it only if that Stripe transaction is not synced';
function processorMarked(row) {
  return /^(y|yes|true|1)$/i.test(String(row.processor_match || '').trim());
}
function processorFee(row, line) {
  const text = `${row.description || ''} ${row.category || ''}`;
  return STRIPE_RE.test(text) && (String(line) === '10' || FEE_RE.test(text));
}
// The note a parked business row carries: why it is not booked here. Bank
// Import shows it under the row and on its Create expense button, so the
// category the importer refused is never picked unknowingly.
function parkNote(row, line) {
  if (processorFee(row, line)) return { note: PROCESSOR_NOTE };
  return { note: `no category in the portal for line ${line || '(none)'}; the ledger says ${row.class}: "${row.category}". Pick the category knowingly, or leave it for the return` };
}
function categoryNameForLine(line, category) {
  const key = String(line || '').trim().toLowerCase();
  if (!key) return null;
  if (key === '27a') {
    const text = String(category || '');
    if (/dues|education|training|association|membership/i.test(text)) return 'Training & Education';
    return SOFTWARE_27A.test(text) ? 'Software & Technology' : null;
  }
  return Object.prototype.hasOwnProperty.call(LINE_TO_CATEGORY, key) ? LINE_TO_CATEGORY[key] : null;
}

/** Ordinal of each row among identical (source,date,description,amount,direction) rows. */
function withOrdinals(rows) {
  const seen = new Map();
  return rows.map(r => {
    const key = [r.source, r.date, r.description, Number(r.amount).toFixed(2), r.direction].join('|');
    const n = seen.get(key) || 0;
    seen.set(key, n + 1);
    return n;
  });
}

function deductibleFor(categoryName, amount) {
  const partial = categoryDeductibleAmount(categoryName, amount);
  return partial === null ? amount : partial;
}

function reviewSuggestion(row, extra) {
  const note = `the ledger says ${row.class}: "${row.category}"${row.flag ? ` [${row.flag}]` : ''}`;
  return {
    review: true,
    note,
    ledgerClass: row.class,
    ledgerCategory: row.category,
    flag: row.flag,
    schedCLine: row.sched_c_line,
    processorMatch: processorMarked(row),
    ...extra,
  };
}

/**
 * Map one parsed ledger row to { bank, expense, categoryName, unmatchedLine }.
 * `bank` is the bank_transactions insert (matched_expense_id is filled in by
 * run once the expense exists); `expense` is the expenses draft (category_id
 * is resolved by run) or null.
 */
function mapRow(row, ordinal, basename) {
  const bank = {
    account_label: `ledger-${row.source}`,
    account_type: CARD_SOURCES.has(row.source.toLowerCase()) ? 'card' : 'bank',
    txn_date: row.date,
    description: row.description.slice(0, 500),
    amount: row.amount,
    direction: row.direction === 'out' ? 'debit' : 'credit',
    source: SOURCE_TAG,
    source_file: basename,
    row_hash: rowHash(row.source, row.date, row.description, row.amount, row.direction, ordinal),
    status: 'unmatched',
    match_method: null,
    suggestion: null,
  };
  const out = { bank, expense: null, categoryName: null, unmatchedLine: null, ledgerClass: row.class, ledgerRow: row };
  // the ledger's reading travels with every row (class, category, line and
  // the processor mark are not in the hash: a rerun compares them to what
  // was loaded)
  const base = { ledgerClass: row.class, ledgerCategory: row.category, flag: row.flag, schedCLine: row.sched_c_line, processorMatch: processorMarked(row) };

  const refundCredit = (row.class === 'refund' || BUSINESS_CLASSES.has(row.class)) && row.direction === 'in';
  // a refund, a processor deposit or a receipt is money IN by definition:
  // the same class on money OUT (a processor fee, a mislabelled row) is
  // parked for ordinary review, never ignored out of the books and never
  // offered as a refund credit (Bank Import's refund flow takes credits only)
  if (MONEY_IN_CLASSES.has(row.class) && row.direction === 'out') {
    bank.status = 'unmatched';
    bank.suggestion = reviewSuggestion(row, { note: `${row.class} class on money out: check the ledger row` });
    out.unmatchedLine = row.sched_c_line || '(none)';
    return out;
  }
  if (refundCredit) {
    bank.status = 'unmatched';
    bank.suggestion = { refundCredit: true, reason: REFUND_REASON, ...base, schedCLine: row.sched_c_line };
    out.unmatchedLine = 'refund';
    return out;
  }

  if (BUSINESS_CLASSES.has(row.class)) {
    const line = row.sched_c_line || CLASS_DEFAULT_LINE[row.class] || '';
    const categoryName = processorFee(row, line) ? null : categoryNameForLine(line, row.category);
    if (!categoryName) {
      bank.status = 'unmatched';
      bank.suggestion = reviewSuggestion(row, { manualLink: true, ...parkNote(row, line) });
      out.unmatchedLine = row.sched_c_line || '(none)';
      out.businessParked = true; // business by the ledger, no category to book it under here
      return out;
    }
    const period = row.period || taxPeriodFor(row.date);
    out.categoryName = categoryName;
    out.expense = {
      description: row.category.slice(0, 300) || row.description.slice(0, 300),
      amount: row.amount,
      tax_deductible_amount: deductibleFor(categoryName, row.amount),
      expense_date: period.date,
      vendor_name: row.description.slice(0, 200),
      payment_method: bank.account_type === 'card' ? 'card' : 'ach',
      tax_year: period.tax_year,
      quarter: period.quarter,
      notes: `imported from ledger CSV ${basename} (class ${row.class}, flag ${row.flag || 'none'})`,
    };
    // 'created_expense' is the status the bank-import create-expense route
    // uses for "a row with an expense made from it"; the table CHECK has no
    // plain 'matched'.
    bank.status = 'created_expense';
    bank.match_method = MATCH_METHOD;
    bank.suggestion = { ...base, schedCLine: row.sched_c_line };
    return out;
  }

  return mapNonBusinessRow(row, out, base);
}

// personal / transfer / processor payout / reward / asset are ignored with
// the reason; receipt_unmatched, review and unknown stay open for review.
function mapNonBusinessRow(row, out, base) {
  const { bank } = out;
  if (IGNORED_CLASSES.has(row.class)) {
    const reason = row.class === 'asset'
      ? 'asset per the ledger (asset: depreciated on Form 4562)'
      : `${row.class} per the ledger`;
    bank.status = 'ignored';
    bank.suggestion = { ignore: true, reason, ...base };
    return out;
  }
  bank.status = 'unmatched';
  bank.suggestion = reviewSuggestion(row, {});
  out.unmatchedLine = row.sched_c_line || '(none)';
  return out;
}

/** A business row that is not booked here (its category is missing from this database, or an expense may already exist): an open review row, no expense. */
function parkForReview(mapped, row, extra = parkNote(row, row.sched_c_line)) {
  mapped.bank.status = 'unmatched';
  mapped.bank.match_method = null;
  // every parked row is the owner's to decide: the matcher offers its
  // candidates and never links one by itself (manualLink)
  mapped.bank.suggestion = reviewSuggestion(row, { manualLink: true, ...extra });
  mapped.expense = null;
  mapped.unmatchedLine = row.sched_c_line || '(none)';
  mapped.businessParked = true;
  return mapped;
}

function bump(map, key, cents) {
  const cur = map[key] || { count: 0, cents: 0 };
  cur.count += 1;
  cur.cents += cents;
  map[key] = cur;
}

/** Totals for a list of mapped rows (output of mapRow). */
function summarize(mappedRows) {
  const s = {
    rows: mappedRows.length,
    byStatus: {},
    byYear: {},
    expensesByCategory: {},
    unmatchedByLine: {},
    expensesCreated: 0,
    totals: { debitCents: 0, creditCents: 0, expenseCents: 0 },
  };
  for (const m of mappedRows) {
    const cents = toCents(m.bank.amount);
    bump(s.byStatus, m.bank.status, cents);
    bump(s.byYear, String(m.bank.txn_date).slice(0, 4), cents);
    if (m.bank.direction === 'debit') s.totals.debitCents += cents; else s.totals.creditCents += cents;
    if (m.expense) {
      s.expensesCreated += 1;
      s.totals.expenseCents += cents;
      bump(s.expensesByCategory, m.categoryName, cents);
    }
    if (m.bank.status === 'unmatched') bump(s.unmatchedByLine, m.unmatchedLine || '(none)', cents);
  }
  return s;
}

function formatTable(map, title) {
  const keys = Object.keys(map).sort();
  if (!keys.length) return [`${title}: none`];
  return [`${title}:`, ...keys.map(k => `  ${k.padEnd(28)} ${String(map[k].count).padStart(5)}  ${fmtMoney(map[k].cents).padStart(14)}`)];
}

function grossNote(e) {
  return e.gross != null && Number(e.gross) !== Number(e.amount) ? ` (gross ${Number(e.gross).toFixed(2)} before refunds)` : '';
}

function formatReport({ dryRun, file, read, inserted, duplicates, held = [], parked = [], kept = [], portalExpenses = [], summary }) {
  const lines = [
    `${dryRun ? 'DRY RUN - nothing written. ' : ''}Ledger import report for ${path.basename(file)}`,
    `rows read:                 ${read}`,
    `${dryRun ? 'would insert:              ' : 'inserted:                  '}${inserted}`,
    `skipped as duplicate:      ${duplicates} (loaded by an earlier run, unchanged)`,
    `held in the portal:        ${held.length} (loaded before; the file now reads it differently, or its expense is gone: each row now carries the note in Bank Import, decide it there)`,
    ...held.map(h => `  line ${h.line}  ${h.date}  ${h.description}  ${h.amount}  [${h.why}]`),
    `parked for review:         ${parked.length} (loaded as open rows, no expense: an expense of the same amount within ${EXPENSE_DATE_WINDOW_DAYS} days is already in the portal; link or create it in Bank Import)`,
    ...parked.map(h => `  line ${h.line}  ${h.date}  ${h.description}  ${h.amount}  [${h.why}]`),
    `bookings kept:             ${kept.length} (an expense of the same amount was entered while a run booked these; the booking stands because its expense was edited or refunded since, or the check still waits for a real run: compare the two on the Expenses tab)`,
    ...kept.map(h => `  line ${h.line}  ${h.date}  ${h.description}  ${h.amount}  [${h.why}]`),
    `expenses in the portal:    ${portalExpenses.length} entered by hand or from a feed within ${EXPENSE_DATE_WINDOW_DAYS} days of this file's dates (never matched by guesswork: a ledger expense row of the same amount nearby is parked above; check each once)`,
    ...portalExpenses.map(e => `  ${ymdOf(e.expense_date)}  ${(e.vendor_name || e.description || '').slice(0, 40)}  ${Number(e.amount).toFixed(2)}${grossNote(e)}${e.claimedByRow ? ' (linked to a feed or upload row)' : ''}`),
    `${dryRun ? 'expenses to create:' : 'expenses created:'}`.padEnd(27) + summary.expensesCreated,
    ...formatTable(summary.byStatus, 'by status'),
    ...formatTable(summary.expensesByCategory, `expenses ${dryRun ? 'to create' : 'created'} by category`),
    ...formatTable(summary.unmatchedByLine, 'left unmatched by Schedule C line (refund = a refund credit to apply in Bank Import)'),
    ...formatTable(summary.byYear, 'rows by tax year'),
    `total outflow (debit):     ${fmtMoney(summary.totals.debitCents)}`,
    `total inflow (credit):     ${fmtMoney(summary.totals.creditCents)}`,
    `total expense amount:      ${fmtMoney(summary.totals.expenseCents)}`,
  ];
  return lines.join('\n');
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

class DuplicateRace extends Error {}

/** Days since the epoch for a YYYY-MM-DD string (calendar arithmetic only). */
function dayNumber(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}
function shiftDays(ymd, days) {
  return new Date((dayNumber(ymd) + days) * 86400000).toISOString().slice(0, 10);
}
function describeGap(days) {
  if (!days) return 'the same day';
  return `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ${days < 0 ? 'earlier' : 'later'}`;
}
// The first few portal rows named in a refusal (the message is one line).
function sampleRows(rows, whereOf) {
  return rows.slice(0, 3).map(r => `${ymdOf(r.txn_date)} "${String(r.description || '').slice(0, 30)}" ${Number(r.amount).toFixed(2)} ${r.direction} (${whereOf(r) || 'no label'})`).join('; ');
}

/**
 * What the portal already holds for this file, and the two conditions a run
 * refuses on. The loader fills a range the portal has nothing for: it never
 * reconciles the ledger against a feed, an upload or an earlier run's rows
 * by guesswork (same account, nearby date, similar text).
 *  - A bank row from a feed or an upload in the file's date range refuses
 *    the run: the ledger's rows would double it. Those rows are classified
 *    in Bank Import, with the ledger rules.
 *  - One file loads a tax year. A row an earlier run loaded for that year
 *    that is not in this file (a corrected date, text or amount, or a
 *    dropped row) refuses the run: a loaded row is corrected in Bank Import,
 *    never by re-import, which would load it twice. The file's name does
 *    not matter (two years may come from files of one name).
 *  - The expenses in the range the portal holds from elsewhere (entered by
 *    hand, or from a feed row outside the range) are read for the hold in
 *    reconcileRows and listed; the ones ledger runs made are the ledger's own.
 */
// A connected Plaid feed that will deliver rows inside this file's days is
// the same double as the rows above, only later (a feed's rows cannot be
// deduped against the ledger's): refused while an enabled account for one
// of the file's sources (its last four, or a named source's institution)
// starts on or before the file's last day. plaid-sync refuses the mirror
// case when a feed is set up over loaded ledger rows.
async function feedsInsideFile(db, rows, range) {
  const sources = new Set(rows.map(r => String(r.source).trim().toLowerCase()));
  const accounts = await db('plaid_accounts').where({ enabled: true }).whereNotNull('sync_from')
    .select('id', 'plaid_item_id', 'account_label', 'mask', 'sync_from');
  if (!accounts.length) return [];
  const items = new Map((await db('plaid_items').whereIn('id', [...new Set(accounts.map(a => a.plaid_item_id))]).whereNot('status', 'removed')
    .select('id', 'institution_name', 'status')).map(i => [i.id, i]));
  return accounts.filter(a => {
    const item = items.get(a.plaid_item_id);
    if (!item) return false;
    const named = LEDGER_NAMED_SOURCES.filter(n => n.institution.test(String(item.institution_name || ''))).map(n => n.label.replace(/^ledger-/, ''));
    const covers = sources.has(String(a.mask || '').trim().toLowerCase()) || named.some(s => sources.has(s));
    return covers && ymdOf(a.sync_from) <= range[1];
  }).map(a => ({ ...a, institution_name: items.get(a.plaid_item_id).institution_name }));
}

async function loadPortalState(db, mapped, rows) {
  const existing = new Map();
  for (const part of chunk(mapped.map(m => m.bank.row_hash), HASH_LOOKUP_CHUNK)) {
    const found = await db('bank_transactions').whereIn('row_hash', part).select('id', 'row_hash', 'status', 'matched_expense_id', 'matched_payout_id', 'suggestion');
    found.forEach(f => existing.set(f.row_hash, f));
  }
  const dates = rows.map(r => r.date).sort();
  const range = [dates[0], dates[dates.length - 1]];
  const otherRows = await db('bank_transactions').whereBetween('txn_date', range).whereNot('source', SOURCE_TAG)
    .select('id', 'account_label', 'txn_date', 'description', 'amount', 'direction');
  if (otherRows.length) {
    throw fail(`the portal already holds ${otherRows.length} bank row(s) from a feed or an upload between ${range[0]} and ${range[1]}; this loader is for a range the portal has nothing for (the ledger's rows would double them): classify those rows in Bank Import instead. First: ${sampleRows(otherRows, r => r.account_label)}`);
  }
  const feeds = await feedsInsideFile(db, rows, range);
  if (feeds.length) {
    throw fail(`a connected bank feed starts inside this file's days and will deliver these rows itself: ${feeds.map(f => `${f.account_label} (${f.institution_name || 'feed'}${f.mask ? ` …${f.mask}` : ''}, from ${ymdOf(f.sync_from)})`).join('; ')}. Stop that feed, or start it after ${range[1]}, before loading this file`);
  }
  const fileHashes = new Set(mapped.map(m => m.bank.row_hash));
  const fileYears = [...new Set(rows.map(r => String(r.period.tax_year)))].sort();
  const ledgerRows = await db('bank_transactions').where({ source: SOURCE_TAG })
    .select('id', 'row_hash', 'source_file', 'txn_date', 'description', 'amount', 'direction', 'matched_expense_id');
  const notInFile = ledgerRows.filter(r => !fileHashes.has(r.row_hash) && fileYears.includes(ymdOf(r.txn_date).slice(0, 4)));
  if (notInFile.length) {
    throw fail(`${notInFile.length} row(s) an earlier run loaded for tax year ${fileYears.join(', ')} are not in this file (one file loads a year: a corrected date, text or amount, or a dropped row); a loaded row is corrected in Bank Import, not by re-import: put it back in the file as loaded, or decide it there. First: ${sampleRows(notInFile, r => r.source_file)}`);
  }
  // every expense a ledger run made is the ledger's own (a ledger row that
  // could be in question was refused above)
  const ledgerMade = new Set(ledgerRows.map(r => r.matched_expense_id).filter(Boolean));
  // the matcher's receipt-vs-posting window on both sides of the range: a
  // receipt dated days before the first posting can still be a ledger row
  const handRange = [shiftDays(range[0], -EXPENSE_DATE_WINDOW_DAYS), shiftDays(range[1], EXPENSE_DATE_WINDOW_DAYS)];
  const portalExpenses = (await db('expenses').whereBetween('expense_date', handRange)
    .select('id', 'expense_date', 'amount', 'vendor_name', 'description', 'payment_method')).filter(e => !ledgerMade.has(e.id));
  // compared at the gross amount (one small query per expense: a one-off run over a handful of rows)
  for (const e of portalExpenses) e.gross = Number((Number(e.amount) + await appliedRefundTotal(e.id, db)).toFixed(2));
  const claimedBy = await claimsOf(db, portalExpenses);
  for (const e of portalExpenses) e.claimedByRow = claimedBy.has(e.id);
  const categories = await db('expense_categories').select('id', 'name');
  return { existing, portalExpenses, claimedBy, ledgerMade, categoryIds: new Map(categories.map(c => [c.name, c.id])) };
}

// The bank row (a feed or an upload, any posting date) an expense is already
// linked to: such an expense cannot be linked again (one bank row per
// expense), so a ledger row near it is that charge already in the portal.
async function claimsOf(dbOrTrx, expenses) {
  if (!expenses.length) return new Map();
  const rows = await dbOrTrx('bank_transactions').whereIn('matched_expense_id', expenses.map(e => e.id)).whereNot('source', SOURCE_TAG)
    .select('id', 'matched_expense_id', 'account_label', 'txn_date');
  return new Map(rows.map(r => [r.matched_expense_id, r]));
}

// A portal row that no longer has the expense the earlier run made: the FK
// went null (ON DELETE SET NULL; bank-import's resetDanglingLinks reopens it
// on its next pass), or the row is open without one (parked, or reopened).
const LINKED_TO_EXPENSE = new Set(['matched_expense', 'created_expense']);
function expenseGone(row) {
  return (LINKED_TO_EXPENSE.has(row.status) && !row.matched_expense_id) || row.status === 'unmatched';
}
// The ledger's reading of a row: what the hash leaves out (class, category,
// line, flag and the processor mark can change in the file without changing
// the row's identity).
function readingOf(sug) {
  const s = sug || {};
  return [s.ledgerClass, s.ledgerCategory, s.schedCLine, s.flag, s.processorMatch ? 'processor' : ''].map(v => String(v || '').trim().toLowerCase()).join('|');
}
// what a held row stores after the rerun: the file's reading (so the next
// rerun compares equal and does not hold it again); the booking never follows
function readingKeys(sug) {
  const s = sug || {};
  return { ledgerClass: s.ledgerClass, ledgerCategory: s.ledgerCategory, schedCLine: s.schedCLine, flag: s.flag, processorMatch: !!s.processorMatch };
}
function describeReading(sug) {
  const s = sug || {};
  return `${s.ledgerClass || 'unknown'}${s.ledgerCategory ? ` (${s.ledgerCategory}${s.schedCLine ? `, line ${s.schedCLine}` : ''})` : ''}`;
}
// A row an earlier run loaded (same hash) is done, unless the file now reads
// it differently, or the expense that run made is gone. Neither is rewritten
// by a re-import: the row is held, listed, and NOTED on the stored row (a
// review note Bank Import shows under it, with the action), so the owner
// decides it there, where every later decision on it (an ignore, a link, a
// refund) already stands and is not second-guessed here.
// The way out of a conflict, by the row's state in the portal: Bank Import
// has no unlink for a row whose expense was CREATED from it (the expense is
// deleted on the Expenses tab, which reopens the row), an unlink for a
// linked one, an unignore for an ignored one.
function wayOut(prior) {
  if (prior.status === 'created_expense' && prior.matched_expense_id) return ' and booked as an expense: delete that expense on the Expenses tab (this row reopens), then decide it here';
  if (prior.status === 'matched_expense' && prior.matched_expense_id) return ' and linked to an expense: unlink it here, then decide it';
  if (prior.status === 'ignored') return ' and ignored: unignore it here if the file is right, then decide it';
  return ': decide it here';
}
function reloadReason(prior, m) {
  const was = describeReading(prior.suggestion);
  const now = describeReading(m.bank.suggestion);
  if (readingOf(prior.suggestion) !== readingOf(m.bank.suggestion)) {
    return {
      why: `loaded by an earlier run as ${was}; the file now reads it differently (change it in Bank Import, not by re-import)`,
      portalNote: `the ledger file now reads this row as ${now}; it was loaded as ${was}${wayOut(prior)}`,
      conflict: true,
    };
  }
  if (m.expense && expenseGone(prior)) {
    const open = prior.status === 'unmatched';
    // an open row that already says why it is parked (a nearby expense, a
    // missing category, an earlier conflict) keeps that note: the reason
    // still holds, and this run found nothing new to say
    const keepsNote = open && !!(prior.suggestion && prior.suggestion.note);
    return {
      why: open ? 'loaded by an earlier run and open in the portal without its expense' : 'loaded by an earlier run but its expense was deleted since',
      portalNote: keepsNote ? null : `loaded from the ledger as ${now}${open ? ' and still open without its expense' : ', but its expense was deleted since'}: create the expense here, or ignore the row`,
      conflict: false,
    };
  }
  return null;
}

// Every portal expense of the same gross amount (the matcher's one-cent
// tolerance: a near-miss is a candidate there too) within the matcher's
// window (a receipt dated the purchase, the statement dated the posting)
// whose payment method can be this account: any of them may be this very
// charge, entered before the ledger was loaded. The ledger row is loaded as
// an open review row with no expense, naming them all. There is no
// one-for-one assignment and no nearest-first pick (two rows of one amount
// near two receipts are both parked): the owner links or creates each in
// Bank Import.
const grossOf = e => (e.gross != null ? Number(e.gross) : Number(e.amount));
function nearbyExpenses(portalExpenses, row, bank) {
  const day = dayNumber(row.date);
  return portalExpenses.filter(e => withinCandidateTolerance(grossOf(e), bank.amount)
    && Math.abs(dayNumber(ymdOf(e.expense_date)) - day) <= EXPENSE_DATE_WINDOW_DAYS
    && !methodIncompatible(bank.account_type, e.payment_method));
}
// The park for a row that may already be an expense in the portal: an open
// review row with no expense, carrying the candidates in the shape Bank
// Import's Link selector reads (the matcher's own), the ledger's category
// for Create expense, and manualLink. Used at reconcile time and again at
// write time (the recheck inside the row's transaction).
// the candidates endpoint's order (newest first, then id), so the stored
// first page and the pages the UI loads after it are one list
const candidateOrder = (a, b) => ymdOf(b.expense_date).localeCompare(ymdOf(a.expense_date)) || String(a.id).localeCompare(String(b.id));
function splitNearby(nearby, claimedBy) {
  return {
    near: nearby.filter(e => !claimedBy.has(e.id)),
    covered: nearby.filter(e => claimedBy.has(e.id)).map(e => ({ ...e, claimedBy: claimedBy.get(e.id) })),
  };
}
// A ledger row near an expense that a feed or upload row already holds: that
// charge is in the portal through that row, so this one is parked with no
// candidates (the link could never succeed) and the owner ignores it, or
// creates the expense if it is a different purchase.
// The ledger's resolved category, carried on a parked row so Create expense
// in Bank Import books it under the right line (and deducts the right
// share) without a second pick; nothing when the portal lacks the category.
function ledgerCategory(m, categoryIds) {
  const categoryId = categoryIds.get(m.categoryName) || null;
  return categoryId ? { categoryId, categoryName: m.categoryName, categorySource: 'ledger' } : {};
}
function parkCovered(m, covered, categoryIds) {
  const row = m.ledgerRow;
  const first = [...covered].sort(candidateOrder)[0];
  const why = `already booked in the portal: ${covered.length === 1 ? 'an expense' : `${covered.length} expenses`} of the same amount linked to a feed or upload row (${first.claimedBy.account_label || 'no label'}, posted ${ymdOf(first.claimedBy.txn_date)})`;
  parkForReview(m, row, { note: `${why}: ignore this row if it is the same charge, or create the expense here if it is a different purchase`, manualLink: true, ...ledgerCategory(m, categoryIds) });
  return why;
}
function parkNear(m, nearUnsorted, categoryIds) {
  const row = m.ledgerRow;
  const near = [...nearUnsorted].sort(candidateOrder);
  const why = describeNearby(near, row.date, m.bank.amount);
  const category = ledgerCategory(m, categoryIds);
  parkForReview(m, row, {
    note: `${why}: link this row to that expense in Bank Import, or create the expense there if it is a different purchase${category.categoryId ? '' : `; no category in the portal for line ${row.sched_c_line || '(none)'}`}`,
    candidates: near.slice(0, 20).map(e => ({ id: e.id, amount: grossOf(e), description: e.description, vendor_name: e.vendor_name, expense_date: ymdOf(e.expense_date) })),
    candidatesTotal: near.length,
    // the link is the owner's call: the matcher offers candidates on this
    // row and never claims one by itself
    manualLink: true,
    ...category,
  });
  return why;
}
function describeNearby(near, date, amount) {
  const cents = v => Math.round(Number(v) * 100);
  const exact = near.every(e => cents(grossOf(e)) === cents(amount));
  const one = e => {
    const offBy = cents(grossOf(e)) !== cents(amount) ? ` (${grossOf(e).toFixed(2)})` : '';
    const afterRefunds = e.gross != null && Number(e.gross) !== Number(e.amount) ? ` (${Number(e.amount).toFixed(2)} after refunds)` : '';
    return `"${(e.vendor_name || e.description || '(no text)').slice(0, 40)}" dated ${describeGap(dayNumber(ymdOf(e.expense_date)) - dayNumber(date))}${offBy}${afterRefunds}`;
  };
  const more = near.length > 3 ? ` and ${near.length - 3} more` : '';
  return `${near.length === 1 ? 'an expense' : `${near.length} expenses`} of the same amount${exact ? '' : ' within one cent'} already in the portal: ${near.slice(0, 3).map(one).join(', ')}${more}`;
}

// Which ledger rows load: every row but one loaded before (a duplicate, or
// held when its reading or its expense changed). An expense row the portal
// may already hold as an expense is loaded parked (an open review row, no
// expense): left out, it could never be decided anywhere, and every rerun
// would leave it out again. A business row whose category is missing from
// this database is parked the same way.
function reconcileRows(mapped, rows, portal) {
  const { existing, portalExpenses, claimedBy, categoryIds } = portal;
  const fresh = [];
  const held = [];
  const parked = [];
  let duplicates = 0;
  const note = (i, why) => ({ line: rows[i].line, description: rows[i].description, amount: Number(rows[i].amount).toFixed(2), date: rows[i].date, why });
  const reading = (m, i) => `the ledger says ${rows[i].class}${m.categoryName ? ` (${m.categoryName})` : ''}`;
  mapped.forEach((m, i) => {
    const prior = existing.get(m.bank.row_hash);
    if (prior) {
      const reason = reloadReason(prior, m);
      if (reason) held.push({ ...note(i, `${reason.why}; ${reading(m, i)}`), rowId: prior.id, status: prior.status, portalNote: reason.portalNote, conflict: reason.conflict, loadedAs: describeReading(prior.suggestion), fileSays: describeReading(m.bank.suggestion), reading: readingKeys(m.bank.suggestion), category: m.expense ? ledgerCategory(m, categoryIds) : {}, refund: !!(m.bank.suggestion && m.bank.suggestion.refundCredit) });
      else duplicates += 1;
      return;
    }
    if (m.expense) {
      const { near, covered } = splitNearby(nearbyExpenses(portalExpenses, rows[i], m.bank), claimedBy);
      if (covered.length) parked.push({ ...note(i, `${parkCovered(m, covered, categoryIds)}; ${reading(m, i)}`), rowHash: m.bank.row_hash });
      else if (near.length) parked.push({ ...note(i, `${parkNear(m, near, categoryIds)}; ${reading(m, i)}`), rowHash: m.bank.row_hash });
      else if (!categoryIds.has(m.categoryName)) parkForReview(m, rows[i]);
    }
    fresh.push(m);
  });
  return { fresh, duplicates, held, parked };
}

// A held row gets its note on the stored row: review + note (Bank Import
// shows them under the row and on its Create expense button) and the
// conflict itself, with the same atomic jsonb merge the matcher uses
// (bank-import suggestionMerge): a concurrent writer can only append.
// The category default follows the file too: a ledger default an earlier
// run stored (categorySource 'ledger') goes, and the corrected reading's
// category comes in when the file now books it; a model's or a rule's
// category is not the ledger's and stays.
async function noteHeldRows(db, held) {
  for (const h of held) {
    // the note only where this run has something new to say (an open row
    // keeps its own, see reloadReason); the conflict record only for a
    // reading that changed
    const patch = { ...h.reading, ...h.category, review: true };
    if (h.portalNote) patch.note = h.portalNote;
    if (h.conflict) patch.ledgerConflict = { at: new Date().toISOString(), loadedAs: h.loadedAs, fileSays: h.fileSays, line: h.line };
    // The refund flag Bank Import's refund flow keys on follows the file's
    // reading of an OPEN row: now a refund credit, the flag and its reason
    // are set; no longer one, both go (a transfer flag's own reason stays:
    // only a row that carried the refund flag loses a reason). A row the
    // owner settled since keeps what the decision left.
    const open = h.status === 'unmatched';
    if (open && h.refund) Object.assign(patch, { refundCredit: true, reason: REFUND_REASON });
    let stored = "(case when suggestion ->> 'categorySource' = 'ledger' then coalesce(suggestion, '{}'::jsonb) - 'categoryId' - 'categoryName' - 'irsLine' - 'categorySource' else coalesce(suggestion, '{}'::jsonb) end)";
    if (open && !h.refund) stored = `(case when jsonb_exists(suggestion, 'refundCredit') then ${stored} - 'refundCredit' - 'reason' else ${stored} end)`;
    await db('bank_transactions').where({ id: h.rowId })
      .update({
        suggestion: db.raw(`${stored} || ?::jsonb`, [JSON.stringify(patch)]),
        updated_at: new Date(),
      });
  }
}

// The nearby check again, on a fresh read: an expense entered by hand (or
// by any other writer) after the snapshot must park this row, not be
// doubled by it. Expenses the ledger made (an earlier run, or this run so
// far) are the ledger's own and never count.
async function nearbyAtWrite(dbOrTrx, m, portal, createdIds) {
  const date = m.ledgerRow.date;
  const rows = await dbOrTrx('expenses').whereBetween('expense_date', [shiftDays(date, -EXPENSE_DATE_WINDOW_DAYS), shiftDays(date, EXPENSE_DATE_WINDOW_DAYS)])
    .select('id', 'expense_date', 'amount', 'vendor_name', 'description', 'payment_method');
  const others = rows.filter(e => !portal.ledgerMade.has(e.id) && !createdIds.has(e.id));
  for (const e of others) e.gross = Number((Number(e.amount) + await appliedRefundTotal(e.id, dbOrTrx)).toFixed(2));
  const nearby = nearbyExpenses(others, m.ledgerRow, m.bank);
  return splitNearby(nearby, await claimsOf(dbOrTrx, nearby));
}
// The park a recheck chose, and its report line.
function parkAtWrite(m, found, portal, when) {
  const why = found.covered.length ? parkCovered(m, found.covered, portal.categoryIds) : parkNear(m, found.near, portal.categoryIds);
  const row = m.ledgerRow;
  return { line: row.line, description: row.description, amount: Number(row.amount).toFixed(2), date: row.date, why: `${why} (${when}); the ledger says ${row.class}${m.categoryName ? ` (${m.categoryName})` : ''}`, rowHash: m.bank.row_hash };
}

// The check once more after the commit, on a fresh snapshot (the matcher's
// post-claim verify): READ COMMITTED does not lock what is not there yet,
// so an expense another writer committed between the recheck and the
// insert shows up only now. Found, the just-made expense is deleted and the
// row parked, in one transaction. An expense that commits after this verify
// is a later expense, the line the matcher draws too.
// The booking commits with suggestion.ledgerVerifyPending (the matcher's
// verifyPending), cleared only once this check has run: a run that dies
// between the two leaves the marker, and the next run finishes the check
// before it judges the row (finishPendingVerifies), so an expense that
// landed in that gap still parks the row instead of staying doubled.
// Returns the park's report line, or null when the expense stands.
// The marker carries a snapshot of the expense as written: a later check
// compares the expense against THAT, never against the file it is run
// from (the owner may have corrected both the expense and the file).
const VERIFY_MARKER = 'ledgerVerifyPending';
function expenseToWrite(m, portal) {
  return { ...m.expense, category_id: portal.categoryIds.get(m.categoryName) || null };
}
async function verifyAfterCommit(db, m, portal, expenseId, createdIds, when, wrote) {
  createdIds.add(expenseId); // the ledger's own from here on: never a candidate for its own row
  const after = await nearbyAtWrite(db, m, portal, createdIds);
  if (!after.near.length && !after.covered.length) {
    await db('bank_transactions').where({ row_hash: m.bank.row_hash, matched_expense_id: expenseId, status: 'created_expense' })
      .update({ suggestion: db.raw(`suggestion - '${VERIFY_MARKER}'`), updated_at: new Date() });
    return null;
  }
  // the park is worked out on a copy: the row is reshaped only once the
  // booking is actually reverted, so a booking that stands still reports
  // as the expense it is
  const probe = { ...m, bank: { ...m.bank, suggestion: m.bank.suggestion ? { ...m.bank.suggestion } : null }, expense: m.expense ? { ...m.expense } : null };
  const line = parkAtWrite(probe, after, portal, when);
  // The revert is conditional, under the expense's row lock, on (1) the
  // bank row still being this booking of that expense (a writer that
  // changed the row meanwhile, an unlink or a decision, keeps its state and
  // the expense stands for it) and (2) the expense being exactly what the
  // ledger wrote, with no refund applied to it or released from it: an
  // expense the owner edited or refunded since (a run that died before its
  // check can leave that gap open for days) is never deleted by a check;
  // the booking is kept and the row says so, for the owner to compare.
  const outcome = await db.transaction(async trx => {
    const bankRow = await trx('bank_transactions').where({ row_hash: m.bank.row_hash, matched_expense_id: expenseId, status: 'created_expense' }).forUpdate().first('id');
    if (!bankRow) return 'row-changed';
    const exp = await trx('expenses').where({ id: expenseId }).forUpdate().first('*');
    if (!exp) return 'row-changed';
    if (expenseEdited(exp, wrote) || (await appliedRefundTotal(expenseId, trx)) > 0) return 'expense-changed';
    const n = await trx('bank_transactions').where({ id: bankRow.id, matched_expense_id: expenseId, status: 'created_expense' })
      .update({ status: 'unmatched', matched_expense_id: null, match_method: null, matched_at: null, suggestion: probe.bank.suggestion, updated_at: new Date() });
    if (Number(n) !== 1) return 'row-changed';
    await trx('expenses').where({ id: expenseId }).delete();
    return 'reverted';
  });
  if (outcome === 'row-changed') return null;
  if (outcome === 'expense-changed') {
    const kept = `${line.why} — this booking was kept: its expense was edited or refunded since, compare the two on the Expenses tab`;
    await db('bank_transactions').where({ row_hash: m.bank.row_hash, matched_expense_id: expenseId })
      .update({ suggestion: db.raw(`(coalesce(suggestion, '{}'::jsonb) - '${VERIFY_MARKER}') || ?::jsonb`, [JSON.stringify({ review: true, note: kept })]), updated_at: new Date() });
    return { ...line, why: kept, kept: true };
  }
  Object.assign(m, probe); // reverted: the row is the park now (open, no expense), for the report
  createdIds.delete(expenseId);
  return line;
}
// The expense against what the ledger wrote, every column of the row: a
// column the ledger set must still hold its value, and any other column
// must still be empty (a receipt, a job, a technician or a customer attached
// since is an edit, and so is a column this script does not know). Anything
// unexpected keeps the expense: a check never deletes what it cannot vouch for.
const EXPENSE_KEYS_NOT_COMPARED = new Set(['id', 'created_at', 'updated_at']);
function expenseEdited(exp, want) {
  const money = (v) => Number(Number(v || 0).toFixed(2));
  const text = (v) => String(v === null || v === undefined ? '' : v);
  const same = (k, a, b) => {
    if (k === 'amount' || k === 'tax_deductible_amount') return money(a) === money(b);
    if (k === 'expense_date') return ymdOf(a) === ymdOf(b);
    return text(a) === text(b);
  };
  const empty = (v) => v === null || v === undefined || v === false || v === '';
  for (const k of Object.keys(exp)) {
    if (EXPENSE_KEYS_NOT_COMPARED.has(k)) continue;
    if (k in want) { if (!same(k, exp[k], want[k])) return true; } else if (!empty(exp[k])) return true;
  }
  return false;
}

// Bookings a run before this one made but never verified (their marker is
// still set: that run ended between the commit and the check) are checked
// now, before this file is judged against them. The outcome updates the
// snapshot this run reads. A dry run only lists them.
async function finishPendingVerifies(db, mapped, portal, dryRun) {
  const lines = [];
  const kept = [];
  for (const m of mapped) {
    const prior = portal.existing.get(m.bank.row_hash);
    const marker = prior && prior.suggestion ? prior.suggestion[VERIFY_MARKER] : null;
    if (!marker) continue;
    const pending = prior.status === 'created_expense' && !!prior.matched_expense_id;
    if (dryRun) {
      if (pending) kept.push({ line: m.ledgerRow.line, description: m.ledgerRow.description, amount: Number(m.ledgerRow.amount).toFixed(2), date: m.ledgerRow.date, why: 'booked by an earlier run that ended before its check; the next run (not a dry run) checks it', rowHash: m.bank.row_hash });
      continue;
    }
    if (!pending) {
      // nothing left to verify (the owner unlinked or decided the row since): the marker goes
      await db('bank_transactions').where({ id: prior.id }).update({ suggestion: db.raw(`suggestion - '${VERIFY_MARKER}'`), updated_at: new Date() });
      delete prior.suggestion[VERIFY_MARKER];
      continue;
    }
    // the snapshot the marker carries is the baseline; a marker without one
    // (never written by this script) only checks a row the file still
    // reads as it was loaded, and otherwise leaves the booking to the hold
    const baseline = marker && typeof marker === 'object' && marker.expense ? marker.expense : null;
    if (!baseline && readingOf(prior.suggestion) !== readingOf(m.bank.suggestion)) {
      await db('bank_transactions').where({ id: prior.id }).update({ suggestion: db.raw(`suggestion - '${VERIFY_MARKER}'`), updated_at: new Date() });
      delete prior.suggestion[VERIFY_MARKER];
      continue;
    }
    const line = await verifyAfterCommit(db, m, portal, prior.matched_expense_id, new Set(), 'entered while an earlier run wrote it; that run ended before its check', baseline || expenseToWrite(m, portal));
    if (line && !line.kept) {
      lines.push(line);
      Object.assign(prior, { status: 'unmatched', matched_expense_id: null, suggestion: m.bank.suggestion });
    } else {
      // kept (its expense edited or refunded since) or clean: the booking
      // stands; reconcileRows still judges the row's reading against the file
      if (line) { kept.push(line); prior.suggestion = { ...prior.suggestion, review: true, note: line.why }; }
      delete prior.suggestion[VERIFY_MARKER];
    }
  }
  return { parked: lines, kept };
}

// One expense row: the recheck, then the expense and the bank row (with the
// verify marker) in one transaction (a failure leaves no orphan expense),
// then verifyAfterCommit. Returns the park's report line, or null when the
// expense stands.
async function writeExpenseRow(db, m, portal, createdIds) {
  let parkedAtWrite = null;
  let expenseId = null;
  const wrote = expenseToWrite(m, portal);
  await db.transaction(async trx => {
    const found = await nearbyAtWrite(trx, m, portal, createdIds);
    if (found.near.length || found.covered.length) {
      parkedAtWrite = parkAtWrite(m, found, portal, 'entered after this run started');
      const res = await trx('bank_transactions').insert({ ...m.bank }).onConflict('row_hash').ignore().returning('id');
      if (!res.length) throw new DuplicateRace('row_hash already present');
      return;
    }
    const [exp] = await trx('expenses')
      .insert({ ...m.expense, category_id: portal.categoryIds.get(m.categoryName) })
      .returning('id');
    expenseId = exp && typeof exp === 'object' ? exp.id : exp;
    const res = await trx('bank_transactions')
      .insert({ ...m.bank, suggestion: { ...(m.bank.suggestion || {}), [VERIFY_MARKER]: { at: new Date().toISOString(), expense: wrote } }, matched_expense_id: expenseId, matched_at: new Date() })
      .onConflict('row_hash')
      .ignore()
      .returning('id');
    if (!res.length) throw new DuplicateRace('row_hash already present');
  });
  if (parkedAtWrite) return parkedAtWrite;
  return verifyAfterCommit(db, m, portal, expenseId, createdIds, 'entered while this run wrote it', wrote);
}

// Writes the fresh rows: non-expense rows in bulk (row_hash conflicts
// ignored, only the rows that landed count), expense rows one at a time
// (writeExpenseRow). A park is reported only once its row has landed.
async function writeRows(db, fresh, portal) {
  const createdIds = new Set();
  const parked = [];
  const kept = [];
  let inserted = 0;
  let duplicates = 0;
  for (const part of chunk(fresh.filter(m => !m.expense), INSERT_CHUNK)) {
    const res = await db('bank_transactions')
      .insert(part.map(m => m.bank))
      .onConflict('row_hash')
      .ignore()
      .returning(['id', 'row_hash']);
    const landedHashes = new Set(res.map(r => (r && typeof r === 'object' ? r.row_hash : null)).filter(Boolean));
    for (const m of part) {
      if (landedHashes.has(m.bank.row_hash)) inserted += 1;
      else { duplicates += 1; m.skipped = true; }
    }
  }
  for (const m of fresh.filter(x => x.expense)) {
    try {
      const line = await writeExpenseRow(db, m, portal, createdIds);
      inserted += 1;
      if (line) (line.kept ? kept : parked).push(line);
    } catch (err) {
      if (err instanceof DuplicateRace) { duplicates += 1; m.skipped = true; continue; }
      throw err;
    }
  }
  return { inserted, duplicates, parked, kept };
}

/**
 * Load a ledger CSV. `db` is a knex instance (or a stub with the same calls).
 * With dryRun it reads (what the portal holds, categories) but writes nothing.
 * Returns { report, counts, summary }.
 */
// The whole run, validation and every write, happens under one session-level
// advisory lock on a dedicated connection (the transactions below use the
// pool as before). The CSV upload and the Plaid feed setup take the same key
// (bank-import LEDGER_LOCK_KEY) around their own overlap checks and writes:
// neither can judge a portal this run has not finished writing, and this
// run cannot judge a portal a statement or a feed is still landing in.
async function withLedgerLock(db, fn) {
  const conn = await db.client.acquireConnection();
  try {
    await db.raw('select pg_advisory_lock(hashtext(?))', [LEDGER_LOCK_KEY]).connection(conn);
    return await fn();
  } finally {
    try { await db.raw('select pg_advisory_unlock(hashtext(?))', [LEDGER_LOCK_KEY]).connection(conn); } finally { await db.client.releaseConnection(conn); }
  }
}

async function run({ file, dryRun = false, db, log = () => {} } = {}) {
  if (!file) throw fail('missing --file');
  if (!db) throw fail('run() needs a db');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw fail(`cannot read file: ${err.message}`);
  }
  const basename = path.basename(file);
  const rows = parseLedgerCsv(text);
  const ordinals = withOrdinals(rows);
  const mapped = rows.map((r, i) => mapRow(r, ordinals[i], basename));
  const { portal, r, written, finished } = await withLedgerLock(db, async () => {
    const state = await loadPortalState(db, mapped, rows);
    const done = await finishPendingVerifies(db, mapped, state, dryRun);
    const rec = reconcileRows(mapped, rows, state);
    const out = dryRun ? { inserted: rec.fresh.length, duplicates: 0, parked: [], kept: [] } : await writeRows(db, rec.fresh, state);
    if (!dryRun) await noteHeldRows(db, rec.held);
    return { portal: state, r: rec, written: out, finished: done };
  });
  // Rows lost to an insert-time conflict are not in the report's tallies.
  const landed = dryRun ? r.fresh : r.fresh.filter(m => !m.skipped);
  const landedHashes = new Set(landed.map(m => m.bank.row_hash));
  const parked = [...finished.parked, ...r.parked.filter(p => landedHashes.has(p.rowHash)), ...written.parked];
  const kept = [...finished.kept, ...written.kept];
  const summary = summarize(landed);
  const duplicates = r.duplicates + written.duplicates;
  const counts = { read: rows.length, inserted: written.inserted, duplicates, held: r.held.length, parked: parked.length, kept: kept.length, portalExpenses: portal.portalExpenses.length };
  const report = formatReport({ dryRun, file, read: rows.length, inserted: written.inserted, duplicates, held: r.held, parked, kept, portalExpenses: portal.portalExpenses, summary });
  log(report);
  return { report, counts, summary };
}

function parseArgs(argv) {
  const args = { file: null, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--file') {
      args.file = argv[i + 1];
      i += 1;
    } else if (a.startsWith('--file=')) args.file = a.slice('--file='.length);
    else throw fail(`unknown argument: ${a}`);
  }
  if (!args.file) throw fail('missing --file (usage: node server/scripts/import-tax-ledger-csv.js --file /path/ledger.csv [--dry-run])');
  return args;
}

async function main() {
  let db = null;
  try {
    const args = parseArgs(process.argv.slice(2));
    db = require('../models/db'); // lazy: tests import this file without a database
    const { report } = await run({ file: args.file, dryRun: args.dryRun, db });
    console.log(report);
  } catch (err) {
    console.error(`error: ${String(err.message || err).split('\n')[0]}`);
    process.exitCode = 1;
  } finally {
    if (db && typeof db.destroy === 'function') await db.destroy();
  }
}

module.exports = {
  HEADER,
  parseLedgerCsv,
  mapRow,
  categoryNameForLine,
  rowHash,
  summarize,
  withOrdinals,
  formatReport,
  parseArgs,
  run,
};

if (require.main === module) {
  main();
}
