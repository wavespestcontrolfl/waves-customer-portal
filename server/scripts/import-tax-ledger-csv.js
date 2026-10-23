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

const HEADER = ['source', 'date', 'description', 'amount', 'direction', 'class', 'category', 'sched_c_line', 'flag', 'processor_match', 'bank_category'];
const CLASSES = ['expense', 'vehicle', 'interest', 'personal', 'transfer', 'income_proc', 'receipt_unmatched', 'review', 'reward', 'refund', 'asset', 'unknown'];
const BUSINESS_CLASSES = new Set(['expense', 'vehicle', 'interest']);
const IGNORED_CLASSES = new Set(['personal', 'transfer', 'income_proc', 'reward', 'refund', 'asset']);
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
  '27a': 'Software & Technology',
  30: 'Home Office',
  '16a': 'Interest',
  '16b': 'Interest',
  '24b': 'Meals & Entertainment',
};
// Same policy as services/expense-categorizer CATEGORY_DEDUCTIBLE_PCT (not
// required here: that module pulls in the db and LLM clients at load time).
const CATEGORY_DEDUCTIBLE_PCT = { 'Meals & Entertainment': 50 };

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

function realDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
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
    if (!realDate(r.date)) throw fail(`line ${line}: date must be a real YYYY-MM-DD date (got "${r.date}")`);
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

/** sha256 over the ledger identity tuple plus the in-file ordinal. */
function rowHash(source, date, description, amount, direction, ordinal) {
  const tuple = `ledger|${source}|${date}|${description}|${Number(amount).toFixed(2)}|${direction}|${ordinal}`;
  return crypto.createHash('sha256').update(tuple).digest('hex');
}

/** expense_categories.name for a Schedule C line, or null when none applies. */
function categoryNameForLine(line, category) {
  const key = String(line || '').trim().toLowerCase();
  if (!key) return null;
  if (key === '27a' && /dues|education/i.test(String(category || ''))) return 'Training & Education';
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

function quarterOf(date) {
  return `Q${Math.ceil(Number(date.slice(5, 7)) / 3)}`;
}

function deductibleFor(categoryName, amount) {
  const pct = CATEGORY_DEDUCTIBLE_PCT[categoryName];
  if (pct === undefined) return amount;
  return Math.round(toCents(amount) * pct / 100) / 100;
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

  if (BUSINESS_CLASSES.has(row.class)) {
    if (row.direction === 'in') {
      bank.status = 'ignored';
      bank.suggestion = { ignore: true, reason: 'refund credit from the ledger (already netted in the books)', ...base };
      return out;
    }
    const line = row.sched_c_line || CLASS_DEFAULT_LINE[row.class] || '';
    const categoryName = categoryNameForLine(line, row.category);
    if (!categoryName) {
      bank.status = 'unmatched';
      bank.suggestion = reviewSuggestion(row, {});
      out.unmatchedLine = row.sched_c_line || '(none)';
      return out;
    }
    const expDate = row.date;
    out.categoryName = categoryName;
    out.expense = {
      description: row.category.slice(0, 300) || row.description.slice(0, 300),
      amount: row.amount,
      tax_deductible_amount: deductibleFor(categoryName, row.amount),
      expense_date: expDate,
      vendor_name: row.description.slice(0, 200),
      payment_method: bank.account_type === 'card' ? 'card' : 'ach',
      tax_year: expDate.slice(0, 4),
      quarter: quarterOf(expDate),
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

function formatReport({ dryRun, file, read, inserted, duplicates, summary }) {
  const lines = [
    `${dryRun ? 'DRY RUN - nothing written. ' : ''}Ledger import report for ${path.basename(file)}`,
    `rows read:                 ${read}`,
    `${dryRun ? 'would insert:              ' : 'inserted:                  '}${inserted}`,
    `skipped as duplicate:      ${duplicates}`,
    `${dryRun ? 'expenses to create:' : 'expenses created:'}`.padEnd(27) + summary.expensesCreated,
    ...formatTable(summary.byStatus, 'by status'),
    ...formatTable(summary.expensesByCategory, `expenses ${dryRun ? 'to create' : 'created'} by category`),
    ...formatTable(summary.unmatchedByLine, 'left unmatched by Schedule C line'),
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

  // Existing hashes: one lookup (chunked only to stay under the bind limit).
  const existing = new Set();
  for (const part of chunk(mapped.map(m => m.bank.row_hash), HASH_LOOKUP_CHUNK)) {
    const found = await db('bank_transactions').whereIn('row_hash', part).select('row_hash');
    found.forEach(f => existing.add(f.row_hash));
  }

  const categories = await db('expense_categories').select('id', 'name');
  const categoryIds = new Map(categories.map(c => [c.name, c.id]));

  const fresh = [];
  let duplicates = 0;
  mapped.forEach((m, i) => {
    if (existing.has(m.bank.row_hash)) { duplicates += 1; return; }
    if (m.expense && !categoryIds.has(m.categoryName)) parkForReview(m, rows[i]);
    fresh.push(m);
  });

  const withExpense = fresh.filter(m => m.expense);
  const plain = fresh.filter(m => !m.expense);
  let inserted = 0;

  if (dryRun) {
    inserted = fresh.length;
  } else {
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

  const landed = dryRun ? fresh : fresh.filter(m => !m.skipped);
  // Rows lost to an insert-time conflict are not in the report's tallies.
  const summary = summarize(landed);
  const counts = { read: rows.length, inserted, duplicates };
  const report = formatReport({ dryRun, file, read: rows.length, inserted, duplicates, summary });
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
