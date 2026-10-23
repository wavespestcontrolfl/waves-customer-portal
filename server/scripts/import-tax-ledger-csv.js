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
 * Idempotent: row_hash is unique, so a second run inserts nothing and creates
 * no duplicate expense. Hashes are looked up first; a row whose hash exists is
 * skipped entirely (no expense either).
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
const { categoryDeductibleAmount } = require('../services/expense-categorizer');
// The matcher's receipt-vs-posting window (a hand-entered expense dated a few
// days off the statement still holds the ledger's expense row) and its
// refund-aware gross reading (an expense a refund reduced is compared at the
// amount the bank debited, applied and released refunds included).
const { EXPENSE_DATE_WINDOW_DAYS, appliedRefundTotal, methodIncompatible } = require('../services/bank-import');

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
function parseLedgerCsv(text) {
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
    const lastTaxYear = new Date().getFullYear();
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
  return rows;
}

/**
 * Bank Import's row identity without the account label (bank-import.js
 * withRowHashes). A DATE column comes back from pg as a JS Date at LOCAL
 * midnight, so the calendar day is read from the local components, never
 * through a time-zone conversion (an ET conversion of a UTC-midnight Date
 * would give the day before).
 */
function ymdOf(v) {
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  return String(v || '').slice(0, 10);
}
function tupleKey(r) {
  return `${ymdOf(r.txn_date)}|${String(r.description || '').replace(/\s+/g, ' ').toUpperCase()}|${Number(r.amount).toFixed(2)}|${r.direction}`;
}

/**
 * The ledger's source is an account's last four digits (or "amex"); a portal
 * row's account is known when its label carries those digits (an upload
 * labelled by the owner) or its Plaid account mask equals them.
 */
const ACCOUNT_ALIASES = { amex: ['amex', 'american express', 'american-express', 'americanexpress'] };
function sameAccount(source, accountLabel, masks) {
  const code = String(source || '').trim().toLowerCase();
  const label = String(accountLabel || '').toLowerCase();
  if (!code || !label) return false;
  if ((ACCOUNT_ALIASES[code] || [code]).some(a => label.includes(a))) return true;
  const mask = masks.get(String(accountLabel));
  return !!mask && mask.toLowerCase() === code;
}
// A portal row's account: a Plaid row carries the account's stable id, so a
// renamed Plaid label (plaid_accounts is updated, old rows keep the old
// label) still resolves to its mask, and that mask is the answer either way
// (a stale label that happens to contain the digits never overrides it);
// rows without that identity go by their label.
function sameAccountRow(source, row, ids) {
  const code = String(source || '').trim().toLowerCase();
  const acct = row.plaid_account_id ? ids.accountsById.get(String(row.plaid_account_id)) : null;
  if (acct) {
    // a numeric source is the account's mask, nothing else; an alias (amex)
    // has no mask to compare and is read from the account's CURRENT label
    if (/^\d+$/.test(code)) return String(acct.mask || '').toLowerCase() === code;
    return sameAccount(source, acct.label, ids.masks) || sameAccount(source, row.account_label, ids.masks);
  }
  return sameAccount(source, row.account_label, ids.masks);
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
const PROCESSOR_FEE_RE = /stripe|processing fee|processor fee|merchant fee|card fee|payment fee|transaction fee/i;
// The note a parked business row carries: why it is not booked here.
function parkNote(line, category) {
  if (String(line) === '10' && PROCESSOR_FEE_RE.test(String(category || ''))) {
    return { note: 'processor fee: the P&L adds synced Stripe fees on its own; book it only if that Stripe transaction is not synced' };
  }
  return {};
}
function categoryNameForLine(line, category) {
  const key = String(line || '').trim().toLowerCase();
  if (!key) return null;
  if (key === '10' && PROCESSOR_FEE_RE.test(String(category || ''))) return null;
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
  const note = row.flag ? `${row.category} [${row.flag}]` : row.category;
  return {
    review: true,
    note,
    ledgerClass: row.class,
    ledgerCategory: row.category,
    flag: row.flag,
    schedCLine: row.sched_c_line,
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
  const out = { bank, expense: null, categoryName: null, unmatchedLine: null, ledgerClass: row.class };
  const base = { ledgerClass: row.class, ledgerCategory: row.category, flag: row.flag };

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
    const categoryName = categoryNameForLine(line, row.category);
    if (!categoryName) {
      bank.status = 'unmatched';
      bank.suggestion = reviewSuggestion(row, parkNote(line, row.category));
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

/** A business row whose category is missing from this database: park it for review, no expense. */
function parkForReview(mapped, row) {
  mapped.bank.status = 'unmatched';
  mapped.bank.match_method = null;
  mapped.bank.suggestion = reviewSuggestion(row, parkNote(row.sched_c_line, row.category));
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

function formatReport({ dryRun, file, read, inserted, duplicates, overlaps = 0, held = [], unsure = [], handExpenses = [], summary }) {
  const lines = [
    `${dryRun ? 'DRY RUN - nothing written. ' : ''}Ledger import report for ${path.basename(file)}`,
    `rows read:                 ${read}`,
    `${dryRun ? 'would insert:              ' : 'inserted:                  '}${inserted}`,
    `skipped as duplicate:      ${duplicates}`,
    `already in the portal:     ${overlaps} (left out: the same row, same account and text, already booked, linked or ignored there)`,
    `held, not imported:        ${held.length} (the same row still open in the portal, the same charge under other text, or an expense of the same amount within ${EXPENSE_DATE_WINDOW_DAYS} days; decide each in Bank Import)`,
    ...held.map(h => `  line ${h.line}  ${h.date}  ${h.description}  ${h.amount}  [${h.why}]  (portal: "${h.other}" in ${h.account})`),
    `check these:               ${unsure.length} (imported; a bank row of ANOTHER or an unknown account has the same day, amount and direction)`,
    ...unsure.map(u => `  line ${u.line}  ${u.date}  ${u.description}  ${u.amount}  (portal account: ${u.other})`),
    `hand-entered expenses:     ${handExpenses.length} in this range, not matched by guesswork; check each against the ledger once`,
    ...handExpenses.map(e => `  ${ymdOf(e.expense_date)}  ${(e.vendor_name || e.description || '').slice(0, 40)}  ${Number(e.amount).toFixed(2)}${e.gross != null && Number(e.gross) !== Number(e.amount) ? ` (gross ${Number(e.gross).toFixed(2)} before refunds)` : ''}`),
    `${dryRun ? 'expenses to create:' : 'expenses created:'}`.padEnd(27) + summary.expensesCreated,
    ...formatTable(summary.byStatus, 'by status'),
    ...formatTable(summary.expensesByCategory, `expenses ${dryRun ? 'to create' : 'created'} by category`),
    ...formatTable(summary.unmatchedByLine, 'left unmatched by Schedule C line (refund = a refund credit to apply in Bank Import)'),
    ...formatTable(summary.byYear, 'rows by tax year (one return year per file: a stray year is a typo to fix)'),
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

/**
 * Load a ledger CSV. `db` is a knex instance (or a stub with the same calls).
 * With dryRun it reads (existing hashes, categories) but writes nothing.
 * Returns { report, counts, summary }.
 */
// What the portal already holds for this file: the ledger rows loaded
// before (by row_hash), the bank rows from a feed or an upload in the file's
// date range, the hand-entered expenses in it, and the Plaid account masks.
async function loadPortalState(db, mapped, rows, skipExisting) {
  // the rows an earlier run loaded, with their state: a row whose expense was
  // deleted since (the FK is null, or the matcher reopened it) is not done
  const existing = new Map();
  for (const part of chunk(mapped.map(m => m.bank.row_hash), HASH_LOOKUP_CHUNK)) {
    const found = await db('bank_transactions').whereIn('row_hash', part).select('id', 'row_hash', 'status', 'matched_expense_id', 'matched_payout_id', 'suggestion', 'description');
    found.forEach(f => existing.set(f.row_hash, f));
  }
  const dates = rows.map(r => r.date).sort();
  const range = [dates[0], dates[dates.length - 1]];
  const existingBank = rows.length ? await db('bank_transactions').whereBetween('txn_date', range).whereNot('source', SOURCE_TAG)
    .select('id', 'status', 'account_label', 'plaid_account_id', 'matched_expense_id', 'matched_payout_id', 'txn_date', 'description', 'amount', 'direction', 'suggestion') : [];
  // the rows earlier ledger runs loaded in this range: a row whose text was
  // corrected since has a new hash, and must still find its old self (same
  // account, day, amount and direction) instead of loading twice. They sit
  // in the overlap pools only; the refusal above counts other sources.
  const priorLedgerRows = rows.length ? await db('bank_transactions').whereBetween('txn_date', range).where({ source: SOURCE_TAG })
    .select('id', 'status', 'account_label', 'plaid_account_id', 'matched_expense_id', 'matched_payout_id', 'txn_date', 'description', 'amount', 'direction', 'suggestion') : [];
  // expenses this importer made on an earlier run are the ledger's own, not
  // "already there from elsewhere": they are linked from a ledger bank row
  // the file's range widened by the matcher window: a receipt dated days
  // before the first posting (or after the last) can still be a ledger row,
  // and an expense an earlier ledger run made just outside the range must
  // still read as the ledger's own
  const handRange = [shiftDays(range[0], -EXPENSE_DATE_WINDOW_DAYS), shiftDays(range[1], EXPENSE_DATE_WINDOW_DAYS)];
  const ledgerMade = new Set(rows.length ? (await db('bank_transactions').where({ source: SOURCE_TAG }).whereBetween('txn_date', handRange).whereNotNull('matched_expense_id')
    .select('matched_expense_id')).map(r => r.matched_expense_id) : []);
  // Expenses linked to a bank row are covered through that row when it
  // overlaps a ledger row; the bank posting can sit a day or more after the
  // ledger's charge date, so they stay in the amount pool too (one-for-one
  // with their row). The rest are hand-entered: never matched by payee
  // guesswork (text varies); a ledger expense of the same gross amount
  // within the window is held for the owner, and the report lists them all
  // to check once.
  const inRange = rows.length ? (await db('expenses').whereBetween('expense_date', handRange)
    .select('id', 'expense_date', 'amount', 'vendor_name', 'description', 'payment_method')).filter(e => !ledgerMade.has(e.id)) : [];
  // the bank rows these expenses are linked to, whatever their posting date:
  // they carry the expense's account identity
  const linkedRows = inRange.length ? await db('bank_transactions').whereIn('matched_expense_id', inRange.map(e => e.id)).whereNot('source', SOURCE_TAG)
    .select('id', 'status', 'account_label', 'plaid_account_id', 'matched_expense_id', 'txn_date', 'description', 'amount', 'direction') : [];
  const linkedExpenseIds = new Set(linkedRows.map(f => f.matched_expense_id));
  const handExpenses = inRange.filter(e => !linkedExpenseIds.has(e.id));
  const coveredExpenses = inRange.filter(e => linkedExpenseIds.has(e.id));
  // compared at the gross amount (one small query per expense: a one-off run
  // over a handful of rows)
  for (const e of inRange) e.gross = Number((Number(e.amount) + await appliedRefundTotal(e.id, db)).toFixed(2));
  if ((existingBank.length || handExpenses.length) && !skipExisting) {
    throw fail(`the portal already holds ${existingBank.length} bank row(s) from a feed or upload between ${range[0]} and ${range[1]} and ${handExpenses.length} hand-entered expense(s) within ${EXPENSE_DATE_WINDOW_DAYS} days of that range; rerun with --skip-existing to leave out the ledger rows the portal already answers (a row still open there is held and listed; hand-entered expenses are listed for you to check)`);
  }
  const plaidAccounts = await db('plaid_accounts').select('account_id', 'account_label', 'mask');
  const masks = new Map(plaidAccounts.map(a => [String(a.account_label), String(a.mask || '')]));
  const accountsById = new Map(plaidAccounts.filter(a => a.account_id).map(a => [String(a.account_id), { mask: String(a.mask || ''), label: String(a.account_label || '') }]));
  const categories = await db('expense_categories').select('id', 'name');
  // the expenses the overlapping portal rows are booked under: their category
  // is compared with the ledger's (a different business category is a
  // conflict for the owner, not an answer)
  const bookedIds = [...new Set([...existingBank, ...priorLedgerRows, ...existing.values()].map(f => f.matched_expense_id).filter(Boolean))];
  const bookedExpenses = new Map(bookedIds.length ? (await db('expenses').whereIn('id', bookedIds).select('id', 'category_id')).map(e => [e.id, e]) : []);
  const categoryNames = new Map(categories.map(c => [c.id, c.name]));
  return { existing, existingBank, priorLedgerRows, handExpenses, coveredExpenses, linkedRows, masks, accountsById, bookedExpenses, categoryNames, categoryIds: new Map(categories.map(c => [c.name, c.id])) };
}

// Pools of the portal's rows, consumed one-for-one as ledger rows match them.
function buildPools({ existingBank, priorLedgerRows = [], handExpenses, coveredExpenses = [], linkedRows = [], masks = new Map(), accountsById = new Map() }) {
  const ids = { masks, accountsById };
  const pooled = [...existingBank, ...priorLedgerRows];
  const bankLeft = new Map();
  pooled.forEach(f => { const k = tupleKey(f); if (!bankLeft.has(k)) bankLeft.set(k, []); bankLeft.get(k).push(f); });
  // A feed writes its own text for a transaction ("Wawa" against the
  // statement's "DEBIT CARD PURCHASE - WAWA 5519 ..."), so a same-account
  // row of the same day, amount and direction with DIFFERENT text is the
  // same charge until the owner says otherwise: the ledger row is HELD (not
  // imported, listed with both texts), never booked on top of it.
  const looseKey = f => `${ymdOf(f.txn_date)}|${Number(f.amount).toFixed(2)}|${f.direction}`;
  const looseLeft = new Map();
  pooled.forEach(f => { const k = looseKey(f); if (!looseLeft.has(k)) looseLeft.set(k, []); looseLeft.get(k).push(f); });
  const dropLoose = (row) => {
    const list = looseLeft.get(looseKey(row)) || [];
    const j = list.indexOf(row);
    if (j !== -1) list.splice(j, 1);
  };
  // A hand-entered expense of the same amount within the matcher's
  // receipt-vs-posting window may be this very charge entered by hand (a
  // receipt dated the purchase, the statement dated the posting): the ledger
  // expense row is HELD (listed with the expense), one-for-one, nearest date
  // first, never booked on top of it. No payee guessing. The amount compared
  // is the GROSS one: a refund applied later reduced the expense, the bank
  // row still shows what was paid.
  // An expense linked to a bank row and that row are ONE transaction: taking
  // either removes the other from its pool (one-for-one across both pools).
  // linkedRows carries every linked row (any posting date, for the account
  // identity); only the rows in the file's range sit in the pools above.
  const rowsOfExpense = new Map();
  linkedRows.forEach(f => { if (!rowsOfExpense.has(f.matched_expense_id)) rowsOfExpense.set(f.matched_expense_id, []); rowsOfExpense.get(f.matched_expense_id).push(f); });
  const pooledById = new Map(pooled.map(f => [f.id, f]));
  // a row settled by its hash is accounted for: out of both pools by id
  const dropById = (id) => { const f = pooledById.get(id); if (f) { dropExact(f); dropLoose(f); } };
  const handByAmount = new Map();
  [...handExpenses, ...coveredExpenses].forEach(e => { const k = Number(e.gross != null ? e.gross : e.amount).toFixed(2); if (!handByAmount.has(k)) handByAmount.set(k, []); handByAmount.get(k).push(e); });
  const dropExact = (row) => {
    const list = bankLeft.get(tupleKey(row)) || [];
    const j = list.indexOf(row);
    if (j !== -1) list.splice(j, 1);
  };
  const dropExpense = (id) => {
    if (!id) return;
    for (const list of handByAmount.values()) {
      const j = list.findIndex(e => e.id === id);
      if (j !== -1) { list.splice(j, 1); return; }
    }
  };
  // A linked expense carries its bank row's account: it is the same
  // transaction only for a ledger row of that account (a $100 purchase on
  // one card never holds a distinct $100 purchase on another). A
  // hand-entered expense has no account identity and is compared on amount
  // and date alone.
  const sameAccountAsLinked = (e, source) => {
    const linked = rowsOfExpense.get(e.id);
    return !linked || linked.some(f => sameAccountRow(source, f, ids));
  };
  // The matcher's own plausibility rule: an expense paid by ach, check or
  // cash is not a card charge, a cash one is not a bank debit.
  const takeHand = (date, amount, source, accountType) => {
    const list = handByAmount.get(Number(amount).toFixed(2)) || [];
    let best = -1;
    list.forEach((e, j) => {
      if (!sameAccountAsLinked(e, source)) return;
      if (methodIncompatible(accountType, e.payment_method)) return;
      const gap = Math.abs(dayNumber(ymdOf(e.expense_date)) - dayNumber(date));
      if (gap > EXPENSE_DATE_WINDOW_DAYS) return;
      if (best === -1 || gap < Math.abs(dayNumber(ymdOf(list[best].expense_date)) - dayNumber(date))) best = j;
    });
    if (best === -1) return null;
    const [e] = list.splice(best, 1);
    (rowsOfExpense.get(e.id) || []).forEach(f => { const pooled = pooledById.get(f.id); if (pooled) { dropExact(pooled); dropLoose(pooled); } });
    return { expense: e, days: dayNumber(ymdOf(e.expense_date)) - dayNumber(date), covered: rowsOfExpense.has(e.id) };
  };
  return { bankLeft, looseKey, looseLeft, dropLoose, dropExact, dropById, dropExpense, takeHand };
}

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

// A portal row that answers nothing yet: still open, or a link whose expense
// or payout was deleted since (the FK is null; bank-import's
// resetDanglingLinks reopens such rows on its next pass).
const LINKED_TO_EXPENSE = new Set(['matched_expense', 'created_expense']);
function expenseGone(row) {
  return (LINKED_TO_EXPENSE.has(row.status) && !row.matched_expense_id) || row.status === 'unmatched';
}
function openOrDangling(row) {
  if (row.status === 'unmatched') return 'the same row is open in the portal, not booked';
  if (LINKED_TO_EXPENSE.has(row.status) && !row.matched_expense_id) return 'the same row is in the portal but its expense was deleted (the next matching pass reopens it)';
  if (row.status === 'matched_payout' && !row.matched_payout_id) return 'the same row is in the portal but its payout link is gone (the next matching pass reopens it)';
  return null;
}
// The portal ignored the row; the ledger says business (booked or parked
// for a line with no category here), or says refund credit (unless the
// refund was RELEASED: releasedRefundOf means it is accounted for).
function ignoredConflict(row, m) {
  if (row.status !== 'ignored') return null;
  if (m.expense || m.businessParked) return 'the portal ignored this row but the ledger says it is business (unignore and decide it)';
  if (m.unmatchedLine === 'refund' && !(row.suggestion && row.suggestion.releasedRefundOf)) {
    return 'the portal ignored this refund credit without applying it (unignore it and apply it to the original expense in Bank Import)';
  }
  return null;
}
// The portal's reading of a credit against the ledger's: linked to a Stripe
// payout while the ledger says merchant refund (the expense it would reduce
// stays at its gross amount), or applied as a refund while the ledger says
// it was not one (the expense it reduced is understated).
function creditConflict(row, m) {
  if (row.status === 'matched_payout' && row.matched_payout_id && m.unmatchedLine === 'refund') {
    return 'the portal linked this credit to a payout but the ledger says it is a refund credit (check which is right)';
  }
  if (row.status === 'refund_applied' && m.unmatchedLine !== 'refund') {
    return 'the portal applied this credit as a refund to an expense but the ledger does not call it a refund (check which is right)';
  }
  return null;
}
// The portal booked an expense; the ledger says non-business, or business
// under another category, or business on a line with no category here.
function bookedConflict(row, m, portal) {
  if (!LINKED_TO_EXPENSE.has(row.status) || !row.matched_expense_id) return null;
  if (m.bank.status === 'ignored') return 'the portal booked this row as an expense but the ledger does not (check which is right; the expense may need deleting)';
  if (m.businessParked) return `the portal booked this row as an expense; the ledger's line ${m.unmatchedLine} has no category here (check the category)`;
  if (!m.expense || !portal) return null;
  const booked = portal.bookedExpenses.get(row.matched_expense_id);
  const ledgerCategoryId = portal.categoryIds.get(m.categoryName);
  if (booked && ledgerCategoryId && booked.category_id && booked.category_id !== ledgerCategoryId) {
    return `the portal booked this row under ${portal.categoryNames.get(booked.category_id) || 'another category'}, the ledger says ${m.categoryName} (check which is right)`;
  }
  return null;
}
// Why an exact overlap is held rather than counted as answered (null = answered).
function openReason(row, m, portal) {
  return openOrDangling(row) || ignoredConflict(row, m) || creditConflict(row, m) || bookedConflict(row, m, portal);
}
// A row an earlier run loaded (same hash): done, unless the expense that run
// made is gone, or the ledger's classification changed since (class,
// category or line are not in the hash) and the stored state disagrees.
function reloadReason(prior, m, portal) {
  if (m.expense && expenseGone(prior)) return 'loaded by an earlier run but its expense was deleted since';
  return ignoredConflict(prior, m) || creditConflict(prior, m) || bookedConflict(prior, m, portal);
}

// Which ledger rows load, and which the portal already answers for.
function reconcileRows(mapped, rows, portal) {
  const { existing, masks, accountsById, categoryIds } = portal;
  const ids = { masks, accountsById };
  const pools = buildPools(portal);
  const fresh = [];
  const unsure = [];
  const held = [];
  let duplicates = 0;
  let overlaps = 0;
  // Pass 1: exact matches (same text) reserve their portal rows first, so a
  // looser match (same account, day and amount, other text) earlier in the
  // file cannot take the row an exact match later in the file is for.
  // An exact overlap the portal has already answered (booked, linked or
  // ignored) is left out. One still OPEN in the portal is HELD and listed:
  // the ledger's reading is not written onto the portal's row (no claims),
  // and counting it as present would hide that nothing books it yet.
  const settled = new Set();
  const note = (i, other, account, why) => ({ line: rows[i].line, description: rows[i].description, amount: rows[i].amount, date: rows[i].date, other, account, why });
  const reading = (m, i) => `the ledger says ${rows[i].class}${m.categoryName ? ` (${m.categoryName})` : ''}`;
  mapped.forEach((m, i) => {
    const prior = existing.get(m.bank.row_hash);
    if (prior) {
      settled.add(i);
      pools.dropById(prior.id);
      const why = reloadReason(prior, m, portal);
      if (why) held.push(note(i, prior.description || rows[i].description, 'this ledger (loaded before)', `${why}; ${reading(m, i)} (decide it in Bank Import)`));
      else duplicates += 1;
      return;
    }
    const pool = pools.bankLeft.get(tupleKey(m.bank)) || [];
    const same = pool.findIndex(f => sameAccountRow(rows[i].source, f, ids));
    if (same === -1) return;
    const [used] = pool.splice(same, 1);
    pools.dropLoose(used);
    pools.dropExpense(used.matched_expense_id);
    settled.add(i);
    const why = openReason(used, m, portal);
    if (why) held.push(note(i, used.description, used.account_label || '(no label)', `${why}; ${reading(m, i)}`));
    else overlaps += 1;
  });
  // Pass 2: everything else, in file order: a hold wins over an "imported,
  // check it" note, which is only given for a row that does load.
  mapped.forEach((m, i) => {
    if (settled.has(i)) return;
    if (m.expense) {
      const hand = pools.takeHand(rows[i].date, m.bank.amount, rows[i].source, m.bank.account_type);
      if (hand) {
        const gross = hand.expense.gross != null && Number(hand.expense.gross) !== Number(hand.expense.amount) ? ` (${Number(hand.expense.amount).toFixed(2)} after refunds)` : '';
        const kind = hand.covered ? 'an expense linked to a bank row' : 'a hand-entered expense';
        held.push(note(i, hand.expense.vendor_name || hand.expense.description || '(no text)', kind, `${kind} of the same amount${gross}, dated ${describeGap(hand.days)}; ${reading(m, i)}`));
        return;
      }
    }
    const loose = pools.looseLeft.get(pools.looseKey(m.bank)) || [];
    const sameLoose = loose.findIndex(f => sameAccountRow(rows[i].source, f, ids));
    if (sameLoose !== -1) {
      const [used] = loose.splice(sameLoose, 1);
      pools.dropExact(used);
      pools.dropExpense(used.matched_expense_id);
      held.push(note(i, used.description, used.account_label || '(no label)', `the same charge under other text; ${reading(m, i)}`));
      return;
    }
    const pool = pools.bankLeft.get(tupleKey(m.bank)) || [];
    if (pool.length) unsure.push({ ...note(i, pool[0].account_label || '(no label)', null), rowHash: m.bank.row_hash });
    if (m.expense && !categoryIds.has(m.categoryName)) parkForReview(m, rows[i]);
    fresh.push(m);
  });
  return { fresh, duplicates, overlaps, held, unsure };
}

// Writes the fresh rows: non-expense rows in bulk (row_hash conflicts
// ignored, only the rows that landed count), expense rows one transaction
// each (expense + bank row), so a failure leaves no orphan expense.
async function writeRows(db, fresh, categoryIds) {
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
      await db.transaction(async trx => {
        const [exp] = await trx('expenses')
          .insert({ ...m.expense, category_id: categoryIds.get(m.categoryName) })
          .returning('id');
        const expenseId = exp && typeof exp === 'object' ? exp.id : exp;
        const res = await trx('bank_transactions')
          .insert({ ...m.bank, matched_expense_id: expenseId, matched_at: new Date() })
          .onConflict('row_hash')
          .ignore()
          .returning('id');
        if (!res.length) throw new DuplicateRace('row_hash already present');
      });
      inserted += 1;
    } catch (err) {
      if (err instanceof DuplicateRace) { duplicates += 1; m.skipped = true; continue; }
      throw err;
    }
  }
  return { inserted, duplicates };
}

/**
 * Load a ledger CSV. `db` is a knex instance (or a stub with the same calls).
 * With dryRun it reads (what the portal holds, categories) but writes nothing.
 * Returns { report, counts, summary }.
 */
async function run({ file, dryRun = false, skipExisting = false, db, log = () => {} } = {}) {
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
  const portal = await loadPortalState(db, mapped, rows, skipExisting);
  const r = reconcileRows(mapped, rows, portal);
  const written = dryRun ? { inserted: r.fresh.length, duplicates: 0 } : await writeRows(db, r.fresh, portal.categoryIds);
  // Rows lost to an insert-time conflict are not in the report's tallies,
  // and an "imported, check it" note is only for a row that did land.
  const landed = dryRun ? r.fresh : r.fresh.filter(m => !m.skipped);
  const landedHashes = new Set(landed.map(m => m.bank.row_hash));
  const unsure = r.unsure.filter(u => landedHashes.has(u.rowHash));
  const summary = summarize(landed);
  const duplicates = r.duplicates + written.duplicates;
  const counts = { read: rows.length, inserted: written.inserted, duplicates, overlaps: r.overlaps, held: r.held.length, unsure: unsure.length, handExpenses: portal.handExpenses.length };
  const report = formatReport({ dryRun, file, read: rows.length, inserted: written.inserted, duplicates, overlaps: r.overlaps, held: r.held, unsure, handExpenses: portal.handExpenses, summary });
  log(report);
  return { report, counts, summary };
}

function parseArgs(argv) {
  const args = { file: null, dryRun: false, skipExisting: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--skip-existing') args.skipExisting = true;
    else if (a === '--file') {
      args.file = argv[i + 1];
      i += 1;
    } else if (a.startsWith('--file=')) args.file = a.slice('--file='.length);
    else throw fail(`unknown argument: ${a}`);
  }
  if (!args.file) throw fail('missing --file (usage: node server/scripts/import-tax-ledger-csv.js --file /path/ledger.csv [--dry-run] [--skip-existing])');
  return args;
}

async function main() {
  let db = null;
  try {
    const args = parseArgs(process.argv.slice(2));
    db = require('../models/db'); // lazy: tests import this file without a database
    const { report } = await run({ file: args.file, dryRun: args.dryRun, skipExisting: args.skipExisting, db });
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
  tupleKey,
  sameAccount,
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
