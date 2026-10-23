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

const HEADER = ['source', 'date', 'description', 'amount', 'direction', 'class', 'category', 'sched_c_line', 'flag', 'processor_match', 'bank_category'];
const CLASSES = ['expense', 'vehicle', 'interest', 'personal', 'transfer', 'income_proc', 'receipt_unmatched', 'review', 'reward', 'refund', 'asset', 'unknown'];
const BUSINESS_CLASSES = new Set(['expense', 'vehicle', 'interest']);
const IGNORED_CLASSES = new Set(['personal', 'transfer', 'income_proc', 'reward', 'asset']);
// A refund credit (class refund, or money IN on a business class) is left
// OPEN: the Bank Import refund flow applies it to the original expense, which
// is what reduces the expense the P&L reads. Ignoring it would leave the
// expense at its gross amount.
const REFUND_REASON = 'refund credit from the ledger: apply it to the original expense in Bank Import (it reduces that expense)';
const CARD_SOURCES = new Set(['9731', '6646', '8804', 'amex']);
const MAX_AMOUNT = 9999999999.99; // numeric(12,2)
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

function parseAmountCell(raw) {
  const cleaned = String(raw === undefined || raw === null ? '' : raw).replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Math.round(Number(cleaned) * 100) / 100;
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
  const rows = [];
  records.slice(1).forEach((rec, i) => {
    const line = i + 2;
    if (rec.length !== HEADER.length) throw fail(`line ${line}: expected ${HEADER.length} columns, found ${rec.length}`);
    const r = {};
    HEADER.forEach((h, k) => { r[h] = String(rec[k] === undefined ? '' : rec[k]).trim(); });
    if (!r.source) throw fail(`line ${line}: missing source`);
    const period = taxPeriodFor(r.date);
    if (!period || Number(period.tax_year) < 2000) throw fail(`line ${line}: date must be a real YYYY-MM-DD date from 2000 on (got "${r.date}")`);
    r.period = period;
    if (!r.description) throw fail(`line ${line}: missing description`);
    if (r.description.includes('\u0000')) throw fail(`line ${line}: description contains a NUL byte`);
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
function sameAccount(source, accountLabel, masks) {
  const code = String(source || '').trim().toLowerCase();
  const label = String(accountLabel || '').toLowerCase();
  if (!code || !label) return false;
  if (label.includes(code)) return true;
  const mask = masks.get(String(accountLabel));
  return !!mask && mask.toLowerCase() === code;
}

function expenseKey(date, amount) {
  return `${ymdOf(date)}|${Number(amount).toFixed(2)}`;
}
// Words that say nothing about the payee: bank framing, legal suffixes,
// card and payment words. The anchor word of a vendor is its first word
// that is not one of these.
const GENERIC_VENDOR_WORDS = new Set(['THE', 'AND', 'INC', 'LLC', 'LTD', 'CORP', 'COM', 'WWW', 'NET', 'ORG', 'CARD', 'DEBIT', 'CREDIT', 'PURCHASE',
  'PAYMENT', 'PMT', 'ONLINE', 'STORE', 'POS', 'ACH', 'CHECK', 'CHK', 'RECURRING', 'AUTOPAY', 'MOBILE', 'DIGITAL', 'ZELLE', 'MONEY', 'SENT', 'RECEIVED',
  'FROM', 'TO', 'FOR', 'WITH', 'INTL', 'USA', 'US', 'FL', 'BRADENTON', 'SARASOTA', 'VENICE', 'TAMPA', 'PARRISH', 'ORLANDO']);
const vendorWords = v => String(v || '').toUpperCase().replace(/[^A-Z ]+/g, ' ').split(/\s+/).filter(w => w.length >= 3 && !GENERIC_VENDOR_WORDS.has(w));
/**
 * Same payee, strictly enough for an automatic link: the two word lists are
 * equal, or the shorter one (at least two words) runs inside the longer one
 * in order. One shared word is not enough ("ACME SUPPLY" is not
 * "ACME ROOFING"; a lone "ACME" links to nothing but "ACME").
 */
function vendorsAgree(a, b) {
  const wa = vendorWords(a); const wb = vendorWords(b);
  if (!wa.length || !wb.length) return false;
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  if (short.length === long.length) return short.every((w, i) => w === long[i]);
  if (short.length < 2) return false;
  for (let i = 0; i + short.length <= long.length; i += 1) {
    if (short.every((w, j) => w === long[i + j])) return true;
  }
  return false;
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

  const refundCredit = row.class === 'refund' || (BUSINESS_CLASSES.has(row.class) && row.direction === 'in');
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
      bank.suggestion = reviewSuggestion(row, {});
      out.unmatchedLine = row.sched_c_line || '(none)';
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

  if (IGNORED_CLASSES.has(row.class)) {
    const reason = row.class === 'asset'
      ? 'asset per the ledger (asset: depreciated on Form 4562)'
      : `${row.class} per the ledger`;
    bank.status = 'ignored';
    bank.suggestion = { ignore: true, reason, ...base };
    return out;
  }

  // receipt_unmatched, review, unknown
  bank.status = 'unmatched';
  bank.suggestion = reviewSuggestion(row, {});
  out.unmatchedLine = row.sched_c_line || '(none)';
  return out;
}

/** A business row whose category is missing from this database: park it for review, no expense. */
function parkForReview(mapped, row) {
  mapped.bank.status = 'unmatched';
  mapped.bank.match_method = null;
  mapped.bank.suggestion = reviewSuggestion(row, {});
  mapped.expense = null;
  mapped.unmatchedLine = row.sched_c_line || '(none)';
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
    expensesByCategory: {},
    unmatchedByLine: {},
    expensesCreated: 0,
    totals: { debitCents: 0, creditCents: 0, expenseCents: 0 },
  };
  for (const m of mappedRows) {
    const cents = toCents(m.bank.amount);
    bump(s.byStatus, m.bank.status, cents);
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

function formatReport({ dryRun, file, read, inserted, duplicates, overlaps = 0, held = [], unsure = [], summary }) {
  const lines = [
    `${dryRun ? 'DRY RUN - nothing written. ' : ''}Ledger import report for ${path.basename(file)}`,
    `rows read:                 ${read}`,
    `${dryRun ? 'would insert:              ' : 'inserted:                  '}${inserted}`,
    `skipped as duplicate:      ${duplicates}`,
    `already in the portal:     ${overlaps} (left out: a bank row of the same account, day, amount and direction, or an expense of the same day, amount and payee)`,
    `held, not imported:        ${held.length} (a bank row of the SAME account has the same day, amount and direction under different text; decide it in Bank Import)`,
    ...held.slice(0, 50).map(h => `  line ${h.line}  ${h.date}  ${h.description}  ${h.amount}  (portal: "${h.other}" in ${h.account})`),
    `check these:               ${unsure.length} (imported; a bank row of ANOTHER or an unknown account has the same day, amount and direction)`,
    ...unsure.slice(0, 50).map(u => `  line ${u.line}  ${u.date}  ${u.description}  ${u.amount}  (portal account: ${u.other})`),
    `${dryRun ? 'expenses to create:' : 'expenses created:'}`.padEnd(27) + summary.expensesCreated,
    ...formatTable(summary.byStatus, 'by status'),
    ...formatTable(summary.expensesByCategory, `expenses ${dryRun ? 'to create' : 'created'} by category`),
    ...formatTable(summary.unmatchedByLine, 'left unmatched by Schedule C line (refund = a refund credit to apply in Bank Import)'),
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

  // Existing hashes: one lookup (chunked only to stay under the bind limit).
  const existing = new Set();
  for (const part of chunk(mapped.map(m => m.bank.row_hash), HASH_LOOKUP_CHUNK)) {
    const found = await db('bank_transactions').whereIn('row_hash', part).select('row_hash');
    found.forEach(f => existing.add(f.row_hash));
  }
  // The ledger is the book of record for a year the portal did not cover.
  // When the portal already holds rows for this date range from a bank feed
  // or an upload, or expenses, the import stops and says so; with
  // --skip-existing it leaves out every ledger row that matches one of them
  // (same day, amount and direction, in the SAME account for a bank row;
  // same day, amount and payee words for an expense), one-for-one, and lists
  // a match whose account it cannot tell as imported-but-check. Nothing is
  // claimed, linked or merged: a charge is never booked twice, and the
  // decision on an ambiguous one is the owner's, in Bank Import.
  const dates = rows.map(r => r.date).sort();
  const range = [dates[0], dates[dates.length - 1]];
  const existingBank = rows.length ? await db('bank_transactions').whereBetween('txn_date', range).whereNot('source', SOURCE_TAG)
    .select('id', 'status', 'account_label', 'matched_expense_id', 'txn_date', 'description', 'amount', 'direction') : [];
  // expenses this importer made on an earlier run are the ledger's own, not
  // "already there from elsewhere": they are linked from a ledger bank row
  const ledgerMade = new Set(rows.length ? (await db('bank_transactions').where({ source: SOURCE_TAG }).whereBetween('txn_date', range).whereNotNull('matched_expense_id')
    .select('matched_expense_id')).map(r => r.matched_expense_id) : []);
  const existingExpenses = rows.length ? (await db('expenses').whereBetween('expense_date', range)
    .select('id', 'expense_date', 'amount', 'vendor_name', 'description')).filter(e => !ledgerMade.has(e.id)) : [];
  if ((existingBank.length || existingExpenses.length) && !skipExisting) {
    throw fail(`the portal already holds ${existingBank.length} bank row(s) from a feed or upload and ${existingExpenses.length} expense(s) between ${range[0]} and ${range[1]}; rerun with --skip-existing to leave out the ledger rows that match them (same day, amount, direction and account; same day, amount and payee for an expense)`);
  }
  const masks = new Map((await db('plaid_accounts').select('account_label', 'mask')).map(a => [String(a.account_label), String(a.mask || '')]));
  const bankLeft = new Map();
  existingBank.forEach(f => { const k = tupleKey(f); if (!bankLeft.has(k)) bankLeft.set(k, []); bankLeft.get(k).push(f); });
  // A feed writes its own text for a transaction ("Wawa" against the
  // statement's "DEBIT CARD PURCHASE - WAWA 5519 ..."), so a same-account
  // row of the same day, amount and direction with DIFFERENT text is the
  // same charge until the owner says otherwise: the ledger row is HELD (not
  // imported, listed with both texts), never booked on top of it.
  const looseKey = f => `${ymdOf(f.txn_date)}|${Number(f.amount).toFixed(2)}|${f.direction}`;
  const looseLeft = new Map();
  existingBank.forEach(f => { const k = looseKey(f); if (!looseLeft.has(k)) looseLeft.set(k, []); looseLeft.get(k).push(f); });
  const dropLoose = (row) => {
    const list = looseLeft.get(looseKey(row)) || [];
    const j = list.indexOf(row);
    if (j !== -1) list.splice(j, 1);
  };
  const expenseLeft = new Map();
  existingExpenses.forEach(e => { const k = expenseKey(e.expense_date, e.amount); if (!expenseLeft.has(k)) expenseLeft.set(k, []); expenseLeft.get(k).push(e); });
  // an expense linked to a bank row carries that row's account: it can only
  // match a ledger row of the same account (an unlinked, hand-entered
  // expense has no account and matches on day, amount and payee alone)
  const bankByExpense = new Map(existingBank.filter(f => f.matched_expense_id).map(f => [f.matched_expense_id, f]));
  const accountFits = (source, e) => !bankByExpense.has(e.id) || sameAccount(source, bankByExpense.get(e.id).account_label, masks);
  // A bank row and the expense it is linked to are ONE transaction: using
  // either takes the other out of its pool, so a second identical ledger
  // row is not skipped twice for one charge.
  const dropExpense = (id) => {
    for (const [k, list] of expenseLeft) {
      const j = list.findIndex(e => e.id === id);
      if (j !== -1) { list.splice(j, 1); if (!list.length) expenseLeft.delete(k); return; }
    }
  };
  const dropBankLinkedTo = (expenseId) => {
    for (const [k, list] of bankLeft) {
      const j = list.findIndex(f => f.matched_expense_id === expenseId);
      if (j !== -1) { list.splice(j, 1); if (!list.length) bankLeft.delete(k); return; }
    }
  };

  const categories = await db('expense_categories').select('id', 'name');
  const categoryIds = new Map(categories.map(c => [c.name, c.id]));

  const fresh = [];
  let duplicates = 0;
  let overlaps = 0;
  const unsure = [];
  const held = [];
  // Pass 1: exact matches (same text) reserve their portal rows first, so a
  // looser match (same account, day and amount, other text) earlier in the
  // file cannot take the row an exact match later in the file is for.
  const exactUsed = new Set();
  mapped.forEach((m, i) => {
    if (existing.has(m.bank.row_hash)) { duplicates += 1; exactUsed.add(i); return; }
    const pool = bankLeft.get(tupleKey(m.bank)) || [];
    const same = pool.findIndex(f => sameAccount(rows[i].source, f.account_label, masks));
    if (same !== -1) {
      const [used] = pool.splice(same, 1);
      dropLoose(used);
      if (used.matched_expense_id) dropExpense(used.matched_expense_id);
      overlaps += 1;
      exactUsed.add(i);
    }
  });
  // Pass 2: everything else, in file order.
  mapped.forEach((m, i) => {
    if (exactUsed.has(i)) return;
    const pool = bankLeft.get(tupleKey(m.bank)) || [];
    if (pool.length) unsure.push({ line: rows[i].line, description: rows[i].description, amount: rows[i].amount, date: rows[i].date, other: pool[0].account_label || '(no label)' });
    const loose = looseLeft.get(looseKey(m.bank)) || [];
    const sameLoose = loose.findIndex(f => sameAccount(rows[i].source, f.account_label, masks));
    if (sameLoose !== -1) {
      const [used] = loose.splice(sameLoose, 1);
      const exact = bankLeft.get(tupleKey(used)) || [];
      const j = exact.indexOf(used);
      if (j !== -1) exact.splice(j, 1);
      if (used.matched_expense_id) dropExpense(used.matched_expense_id);
      held.push({ line: rows[i].line, description: rows[i].description, amount: rows[i].amount, date: rows[i].date, other: used.description, account: used.account_label || '(no label)' });
      return;
    }
    if (m.expense) {
      const pool2 = expenseLeft.get(expenseKey(rows[i].date, m.bank.amount)) || [];
      const idx = pool2.findIndex(e => accountFits(rows[i].source, e) && vendorsAgree(e.vendor_name || e.description, m.bank.description));
      if (idx !== -1) {
        const [used] = pool2.splice(idx, 1);
        dropBankLinkedTo(used.id);
        overlaps += 1;
        return;
      }
    }
    if (m.expense && !categoryIds.has(m.categoryName)) parkForReview(m, rows[i]);
    fresh.push(m);
  });

  const withExpense = fresh.filter(m => m.expense);
  const plain = fresh.filter(m => !m.expense);
  let inserted = 0;

  if (!dryRun) {
    // Non-expense rows: bulk insert; row_hash conflicts are ignored. The
    // rows that landed come back by hash, so a row another writer inserted
    // after the existence lookup is marked skipped and stays out of the
    // report's tallies, like a raced expense row.
    for (const part of chunk(plain, INSERT_CHUNK)) {
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
    // Expense rows: expense + bank row in one transaction each, so a failure
    // leaves no orphan expense.
    for (const m of withExpense) {
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
  }
  if (dryRun) inserted = fresh.length;

  const landed = dryRun ? fresh : fresh.filter(m => !m.skipped);
  // Rows lost to an insert-time conflict are not in the report's tallies.
  const summary = summarize(landed);
  const counts = { read: rows.length, inserted, duplicates, overlaps, held: held.length, unsure: unsure.length };
  const report = formatReport({ dryRun, file, read: rows.length, inserted, duplicates, overlaps, held, unsure, summary });
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
  vendorsAgree,
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
