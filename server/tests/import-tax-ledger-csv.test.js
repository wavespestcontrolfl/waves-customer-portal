const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  HEADER, parseLedgerCsv, mapRow, categoryNameForLine, rowHash, summarize, withOrdinals, parseArgs, run,
} = require('../scripts/import-tax-ledger-csv');

const HEADER_LINE = HEADER.join(',');

function csv(...lines) {
  return [HEADER_LINE, ...lines].join('\n') + '\n';
}

// source,date,description,amount,direction,class,category,sched_c_line,flag,processor_match,bank_category
function row(over = {}) {
  const base = {
    source: '3098', date: '2025-03-14', description: 'ACME SUPPLY 4471', amount: '12.50', direction: 'out',
    class: 'expense', category: 'Supplies (chemicals, equipment, hardware)', sched_c_line: '22', flag: '', processor_match: '', bank_category: '',
  };
  const r = { ...base, ...over };
  return HEADER.map(h => (/[",]/.test(r[h]) ? `"${r[h]}"` : r[h])).join(',');
}

function parsedRow(over = {}) {
  return parseLedgerCsv(csv(row(over)))[0];
}

const toCentsOf = v => Math.round(Math.abs(parseFloat(v)) * 100);

describe('parseLedgerCsv header validation', () => {
  test('accepts the exact header and a BOM', () => {
    expect(parseLedgerCsv(`﻿${csv(row())}`)).toHaveLength(1);
  });

  test('rejects an unknown column', () => {
    expect(() => parseLedgerCsv(`${HEADER_LINE},extra\n`)).toThrow(/unknown column.*extra/);
  });

  test('rejects a missing or reordered column', () => {
    expect(() => parseLedgerCsv(`${HEADER.slice(0, -1).join(',')}\n`)).toThrow(/header must be exactly/);
    const swapped = [HEADER[1], HEADER[0], ...HEADER.slice(2)].join(',');
    expect(() => parseLedgerCsv(`${swapped}\n`)).toThrow(/header must be exactly/);
  });

  test('rejects an empty file', () => {
    expect(() => parseLedgerCsv('')).toThrow(/empty/);
  });

  test.each([
    [{ date: '2025-02-31' }, /date/],
    [{ amount: '-4.00' }, /amount/],
    [{ amount: 'abc' }, /amount/],
    [{ direction: 'sideways' }, /direction/],
    [{ class: 'mystery' }, /unknown class/],
    [{ description: '' }, /description/],
  ])('rejects a bad row %j with a line number', (over, re) => {
    expect(() => parseLedgerCsv(csv(row(over)))).toThrow(/^line 2: /);
    expect(() => parseLedgerCsv(csv(row(over)))).toThrow(re);
  });

  test('parses amount with $ and commas, trims, and keeps quoted commas', () => {
    const [r] = parseLedgerCsv(csv(row({ amount: '$1,234.5', description: 'ACME, INC 9' })));
    expect(r.amount).toBe(1234.5);
    expect(r.description).toBe('ACME, INC 9');
  });
});

describe('parseArgs', () => {
  test('requires --file and rejects unknown flags', () => {
    expect(() => parseArgs([])).toThrow(/missing --file/);
    expect(() => parseArgs(['--file', 'a.csv', '--bogus'])).toThrow(/unknown argument/);
    expect(parseArgs(['--file=a.csv', '--dry-run'])).toEqual({ file: 'a.csv', dryRun: true });
  });
});

describe('direction, account and field mapping', () => {
  test('out is debit, in is credit', () => {
    expect(mapRow(parsedRow({ direction: 'out' }), 0, 'l.csv').bank.direction).toBe('debit');
    expect(mapRow(parsedRow({ direction: 'in', class: 'income_proc' }), 0, 'l.csv').bank.direction).toBe('credit');
  });

  test('card sources map to card, others to bank, label is ledger-<source>', () => {
    for (const source of ['9731', '6646', '8804', 'amex']) {
      const { bank } = mapRow(parsedRow({ source }), 0, 'l.csv');
      expect(bank.account_type).toBe('card');
      expect(bank.account_label).toBe(`ledger-${source}`);
    }
    expect(mapRow(parsedRow({ source: '3098' }), 0, 'l.csv').bank.account_type).toBe('bank');
    expect(mapRow(parsedRow({ source: '3965' }), 0, 'l.csv').bank.account_type).toBe('bank');
  });

  test('bank row carries source, file basename, date, amount and truncated description', () => {
    const long = 'X'.repeat(600);
    const { bank } = mapRow(parsedRow({ description: long }), 0, 'ledger-2025.csv');
    expect(bank).toMatchObject({ source: 'ledger-csv', source_file: 'ledger-2025.csv', txn_date: '2025-03-14', amount: 12.5 });
    expect(bank.description).toHaveLength(500);
  });
});

describe('row hashing', () => {
  test('matches the documented sha256 tuple', () => {
    const expected = crypto.createHash('sha256').update('ledger|3098|2025-03-14|ACME SUPPLY 4471|12.50|out|0').digest('hex');
    expect(rowHash('3098', '2025-03-14', 'ACME SUPPLY 4471', 12.5, 'out', 0)).toBe(expected);
  });

  test('identical rows in one file get ordinals 0,1,2 and distinct hashes', () => {
    const rows = parseLedgerCsv(csv(
      row({ description: 'CORNER FUEL 12', amount: '4.00' }),
      row({ description: 'CORNER FUEL 12', amount: '4.00' }),
      row({ description: 'CORNER FUEL 12', amount: '4.00' }),
      row({ description: 'CORNER FUEL 12', amount: '5.00' }),
    ));
    expect(withOrdinals(rows)).toEqual([0, 1, 2, 0]);
    const hashes = rows.map((r, i) => mapRow(r, withOrdinals(rows)[i], 'l.csv').bank.row_hash);
    expect(new Set(hashes).size).toBe(4);
  });

  test('same tuple but different source or direction is a different row', () => {
    const rows = parseLedgerCsv(csv(
      row({ source: '3098' }), row({ source: '3965' }), row({ direction: 'in', class: 'refund' }),
    ));
    expect(withOrdinals(rows)).toEqual([0, 0, 0]);
  });
});

describe('class to status table', () => {
  const map = over => mapRow(parsedRow(over), 0, 'l.csv');

  test.each([['expense', '22'], ['vehicle', '9'], ['interest', '16a']])('%s out becomes a created expense', (cls, line) => {
    const m = map({ class: cls, sched_c_line: line, flag: 'F1' });
    expect(m.bank.status).toBe('created_expense');
    expect(m.bank.match_method).toBe('ledger-import');
    expect(m.expense).toMatchObject({ amount: 12.5, tax_deductible_amount: 12.5, expense_date: '2025-03-14', vendor_name: 'ACME SUPPLY 4471', payment_method: 'ach', tax_year: '2025', quarter: 'Q1' });
    expect(m.expense.notes).toBe(`imported from ledger CSV l.csv (class ${cls}, flag F1)`);
    expect(m.bank.suggestion).toEqual({ ledgerClass: cls, ledgerCategory: 'Supplies (chemicals, equipment, hardware)', flag: 'F1', schedCLine: line });
  });

  test('card account expense books as card, quarter follows the month', () => {
    const m = map({ source: 'amex', date: '2025-11-02' });
    expect(m.expense.payment_method).toBe('card');
    expect(m.expense.quarter).toBe('Q4');
  });

  test.each(['expense', 'vehicle', 'interest'])('%s in is an OPEN refund credit with no expense: Bank Import applies it to the original expense', cls => {
    const m = map({ class: cls, direction: 'in' });
    expect(m.bank.status).toBe('unmatched');
    expect(m.expense).toBeNull();
    expect(m.bank.status).toBe('unmatched');
    expect(m.unmatchedLine).toBe('refund');
    expect(m.bank.suggestion).toMatchObject({ refundCredit: true, reason: expect.stringMatching(/apply it to the original expense in Bank Import/), ledgerClass: cls });
    expect(m.bank.suggestion.ignore).toBeUndefined();
  });

  test('refund is an open refund credit, not ignored', () => {
    const m = mapRow(parsedRow({ direction: 'in', class: 'refund', sched_c_line: '' }), 0, 'l.csv');
    expect(m.bank.status).toBe('unmatched');
    expect(m.expense).toBeNull();
    expect(m.bank.suggestion).toMatchObject({ refundCredit: true, ledgerClass: 'refund' });
  });

  test.each(['personal', 'transfer', 'income_proc', 'reward'])('%s is ignored', cls => {
    const m = map({ class: cls, description: 'Zelle money sent to TEST HELPER', sched_c_line: '' });
    expect(m.bank.status).toBe('ignored');
    expect(m.expense).toBeNull();
    expect(m.bank.suggestion).toMatchObject({ ignore: true, reason: `${cls} per the ledger`, ledgerClass: cls });
  });

  test('asset is ignored with the Form 4562 note', () => {
    const m = map({ class: 'asset', sched_c_line: '' });
    expect(m.bank.status).toBe('ignored');
    expect(m.bank.suggestion.reason).toMatch(/asset.*depreciated on Form 4562/);
  });

  test.each(['receipt_unmatched', 'review', 'unknown'])('%s stays unmatched with a review note and no expense', cls => {
    const m = map({ class: cls, flag: 'CHECK', sched_c_line: '22' });
    expect(m.bank.status).toBe('unmatched');
    expect(m.expense).toBeNull();
    expect(m.bank.suggestion).toMatchObject({ review: true, note: 'Supplies (chemicals, equipment, hardware) [CHECK]', schedCLine: '22', flag: 'CHECK' });
    expect(m.unmatchedLine).toBe('22');
  });

  test('business row with a line that has no category (24a, 13) stays unmatched', () => {
    for (const line of ['24a', '13']) {
      const m = map({ sched_c_line: line, category: 'Travel' });
      expect(m.bank.status).toBe('unmatched');
      expect(m.expense).toBeNull();
      expect(m.bank.suggestion.review).toBe(true);
      expect(m.unmatchedLine).toBe(line);
    }
  });

  test('meals are deducted at 50 percent, matching the portal policy', () => {
    const m = map({ sched_c_line: '24b', amount: '41.25', category: 'Meals' });
    expect(m.expense.tax_deductible_amount).toBe(20.63);
    expect(m.expense.amount).toBe(41.25);
  });

  test('description and vendor are capped', () => {
    const m = map({ category: 'C'.repeat(400), description: 'D'.repeat(400) });
    expect(m.expense.description).toHaveLength(300);
    expect(m.expense.vendor_name).toHaveLength(200);
  });
});

describe('categoryNameForLine', () => {
  test.each([
    ['8', 'Advertising & Marketing'], ['9', 'Vehicle Expenses'], ['10', 'Commissions & Fees'], ['11', 'Contract Labor'],
    ['15', 'Insurance'], ['17', 'Legal & Professional'], ['18', 'Office Expenses'], ['21', 'Repairs & Maintenance'],
    ['22', 'Supplies'], ['23', 'Taxes & Licenses'], ['25', 'Utilities'], ['30', 'Home Office'],
    ['16a', 'Interest'], ['16b', null], ['24b', 'Meals & Entertainment'],
  ])('line %s -> %s', (line, name) => {
    expect(categoryNameForLine(line, 'anything')).toBe(name);
  });

  test('27a splits on Dues or education', () => {
    expect(categoryNameForLine('27a', 'Software subscriptions')).toBe('Software & Technology');
    expect(categoryNameForLine('27a', 'Dues & memberships')).toBe('Training & Education');
    expect(categoryNameForLine('27a', 'Continuing education')).toBe('Training & Education');
    expect(categoryNameForLine('27a', 'CONTINUING EDUCATION')).toBe('Training & Education');
  });

  test('no category for 24a, 13, 27b, blank or unknown', () => {
    for (const line of ['24a', '13', '27b', '', undefined, 'zz']) {
      expect(categoryNameForLine(line, 'x')).toBeNull();
    }
  });
});

describe('summarize', () => {
  test('tallies status, categories, unmatched lines and totals in cents', () => {
    const rows = parseLedgerCsv(csv(
      row({ amount: '10.10' }),
      row({ amount: '0.20', description: 'ACME SUPPLY 2' }),
      row({ sched_c_line: '24a', amount: '5.00' }),
      row({ class: 'income_proc', direction: 'in', amount: '100.00', sched_c_line: '' }),
    ));
    const ord = withOrdinals(rows);
    const s = summarize(rows.map((r, i) => mapRow(r, ord[i], 'l.csv')));
    expect(s.rows).toBe(4);
    expect(s.expensesCreated).toBe(2);
    expect(s.byStatus.created_expense.count).toBe(2);
    expect(s.expensesByCategory.Supplies).toEqual({ count: 2, cents: 1030 });
    expect(s.unmatchedByLine['24a']).toEqual({ count: 1, cents: 500 });
    expect(s.totals).toEqual({ debitCents: 1530, creditCents: 10000, expenseCents: 1030 });
  });
});

// ---- run() against an in-memory fake knex ----

function makeFakeDb({ categories } = {}) {
  const tables = {
    bank_transactions: [],
    expenses: [],
    expense_categories: categories || [
      'Advertising & Marketing', 'Vehicle Expenses', 'Insurance', 'Supplies', 'Software & Technology',
      'Training & Education', 'Interest', 'Meals & Entertainment',
    ].map((name, i) => ({ id: `cat-${i}`, name })),
  };
  let seq = 0;
  const log = { transactions: 0, rollbacks: 0, writes: 0 };

  function builderFor(store, table) {
    const state = { filter: null, pending: null, ignoreConflict: false, wantReturn: false };
    const b = {
      whereIn(col, vals) { state.filter = { col, vals: new Set(vals) }; return b; },
      select() { return b; },
      insert(rows) { state.pending = Array.isArray(rows) ? rows : [rows]; return b; },
      onConflict() { return b; },
      ignore() { state.ignoreConflict = true; return b; },
      returning() { state.wantReturn = true; return b; },
      then(resolve, reject) {
        return Promise.resolve().then(() => {
          if (state.pending) {
            log.writes += 1;
            const inserted = [];
            for (const r of state.pending) {
              if (table === 'bank_transactions' && store[table].some(x => x.row_hash === r.row_hash)) {
                if (state.ignoreConflict) continue;
                throw new Error('unique violation on row_hash');
              }
              const withId = { ...r, id: `id-${(seq += 1)}` };
              store[table].push(withId);
              inserted.push({ id: withId.id, row_hash: withId.row_hash });
            }
            return state.wantReturn ? inserted : undefined;
          }
          let out = store[table];
          if (state.filter) out = out.filter(r => state.filter.vals.has(r[state.filter.col]));
          return out;
        }).then(resolve, reject);
      },
    };
    return b;
  }

  const db = table => builderFor(tables, table);
  db.transaction = async fn => {
    log.transactions += 1;
    const staged = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.slice()]));
    const trx = table => builderFor(staged, table);
    try {
      const out = await fn(trx);
      Object.keys(tables).forEach(k => { tables[k] = staged[k]; });
      return out;
    } catch (err) {
      log.rollbacks += 1;
      throw err;
    }
  };
  db.tables = () => tables;
  db.log = log;
  return db;
}

describe('run', () => {
  let dir;
  let file;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
    file = path.join(dir, 'ledger-2025.csv');
    fs.writeFileSync(file, csv(
      row({ description: 'ACME SUPPLY 4471', amount: '12.50' }),
      row({ description: 'CORNER FUEL 12', amount: '4.00', class: 'vehicle', sched_c_line: '9', category: 'Vehicle fuel' }),
      row({ description: 'CORNER FUEL 12', amount: '4.00', class: 'vehicle', sched_c_line: '9', category: 'Vehicle fuel' }),
      row({ description: 'Zelle money sent to TEST HELPER', amount: '300.00', class: 'personal', sched_c_line: '', category: 'Personal' }),
      row({ description: 'MYSTERY CHARGE 77', amount: '19.99', class: 'review', category: 'Unknown merchant', flag: 'NOREC', sched_c_line: '22' }),
      row({ description: 'AIRLINE 0001', amount: '210.00', sched_c_line: '24a', category: 'Travel' }),
      row({ description: 'PROCESSOR DEPOSIT', amount: '500.00', direction: 'in', class: 'income_proc', sched_c_line: '', category: 'Income' }),
      row({ description: 'TRADE SCHOOL DUES', amount: '80.00', source: 'amex', sched_c_line: '27a', category: 'Dues & education' }),
    ));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('dry run reads but writes nothing and says DRY RUN', async () => {
    const db = makeFakeDb();
    const { report, counts } = await run({ file, dryRun: true, db });
    expect(report).toMatch(/^DRY RUN/);
    expect(counts).toEqual({ read: 8, inserted: 8, duplicates: 0 });
    expect(db.tables().bank_transactions).toHaveLength(0);
    expect(db.tables().expenses).toHaveLength(0);
    expect(db.log.writes).toBe(0);
    expect(db.log.transactions).toBe(0);
  });

  test('real run inserts bank rows and expenses, linked and categorized', async () => {
    const db = makeFakeDb();
    const { report, counts } = await run({ file, db });
    expect(report).not.toMatch(/DRY RUN/);
    expect(counts).toEqual({ read: 8, inserted: 8, duplicates: 0 });

    const { bank_transactions: bank, expenses } = db.tables();
    expect(bank).toHaveLength(8);
    expect(expenses).toHaveLength(4); // supplies, two fuel, dues
    expect(db.log.transactions).toBe(4);

    const byStatus = s => bank.filter(b => b.status === s).length;
    expect(byStatus('created_expense')).toBe(4);
    expect(byStatus('ignored')).toBe(2);
    expect(byStatus('unmatched')).toBe(2); // review row + 24a row

    // every created_expense row points at a real expense; no expense is orphaned
    const linked = bank.filter(b => b.matched_expense_id).map(b => b.matched_expense_id).sort();
    expect(linked).toEqual(expenses.map(e => e.id).sort());

    const dues = expenses.find(e => e.vendor_name === 'TRADE SCHOOL DUES');
    expect(dues.category_id).toBe('cat-5'); // Training & Education
    expect(dues.payment_method).toBe('card');
    expect(expenses.filter(e => e.category_id === 'cat-1')).toHaveLength(2); // two identical fuel rows both loaded

    expect(report).toMatch(/left unmatched by Schedule C line/);
    expect(report).toMatch(/24a/);
  });

  test('second run inserts nothing and creates no duplicate expense', async () => {
    const db = makeFakeDb();
    await run({ file, db });
    const before = { bank: db.tables().bank_transactions.length, exp: db.tables().expenses.length };
    const second = await run({ file, db });
    expect(second.counts).toEqual({ read: 8, inserted: 0, duplicates: 8 });
    expect(db.tables().bank_transactions).toHaveLength(before.bank);
    expect(db.tables().expenses).toHaveLength(before.exp);
  });

  test('a business row whose category is missing from the database is parked, not expensed', async () => {
    const db = makeFakeDb({ categories: [{ id: 'cat-x', name: 'Insurance' }] });
    const { summary } = await run({ file, db });
    expect(db.tables().expenses).toHaveLength(0);
    expect(summary.expensesCreated).toBe(0);
    expect(db.tables().bank_transactions.filter(b => b.status === 'unmatched')).toHaveLength(6);
  });

  test('a non-expense row another writer inserted after the lookup is skipped and left out of the report totals', async () => {
    const db = makeFakeDb();
    const realDb = db;
    const rows = parseLedgerCsv(fs.readFileSync(file, 'utf8'));
    // a row that makes no expense (its class is ignored), pre-inserted as if by a concurrent import
    const idx = rows.findIndex(r => !mapRow(r).expense);
    const target = rows[idx];
    const hash = rowHash(target.source, target.date, target.description, target.amount, target.direction, 0);
    realDb.tables().bank_transactions.push({ id: 'pre', row_hash: hash, status: 'ignored', amount: target.amount, direction: target.direction });
    const blind = table => {
      if (table !== 'bank_transactions') return realDb(table);
      const real = realDb(table);
      const blindLookup = { select: () => Promise.resolve([]) };
      return { ...real, insert: (...a) => real.insert(...a), whereIn: () => blindLookup };
    };
    blind.transaction = realDb.transaction;
    const { counts, summary } = await run({ file, db: blind });
    expect(counts).toEqual({ read: 8, inserted: 7, duplicates: 1 });
    // the summary covers the seven rows that landed, not the raced one
    expect(summary.rows).toBe(7);
    const clean = await run({ file, db: makeFakeDb() });
    expect(summary.totals.debitCents + summary.totals.creditCents).toBe(clean.summary.totals.debitCents + clean.summary.totals.creditCents - toCentsOf(target.amount));
  });

  test('a lost insert race rolls the expense back and counts a duplicate', async () => {
    const db = makeFakeDb();
    const realDb = db;
    const first = parseLedgerCsv(fs.readFileSync(file, 'utf8'))[0];
    const hash = rowHash(first.source, first.date, first.description, first.amount, first.direction, 0);
    realDb.tables().bank_transactions.push({ id: 'pre', row_hash: hash });
    const blind = table => {
      if (table !== 'bank_transactions') return realDb(table);
      const real = realDb(table);
      // the existence lookup sees nothing, as if the other writer committed after it
      const blindLookup = { select: () => Promise.resolve([]) };
      return { ...real, insert: (...a) => real.insert(...a), whereIn: () => blindLookup };
    };
    blind.transaction = realDb.transaction;
    const { counts } = await run({ file, db: blind });
    expect(counts.duplicates).toBe(1);
    expect(counts.inserted).toBe(7);
    expect(realDb.log.rollbacks).toBe(1);
    expect(realDb.tables().expenses).toHaveLength(3); // the raced row left no orphan expense
  });

  test('missing file and bad header fail with one-line errors', async () => {
    const db = makeFakeDb();
    await expect(run({ file: path.join(dir, 'nope.csv'), db })).rejects.toThrow(/cannot read file/);
    const bad = path.join(dir, 'bad.csv');
    fs.writeFileSync(bad, 'a,b,c\n1,2,3\n');
    await expect(run({ file: bad, db })).rejects.toThrow(/unknown column/);
    await expect(run({ db })).rejects.toThrow(/missing --file/);
  });
});
